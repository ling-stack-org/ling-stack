import { trimBoundaryCharacters } from "./string-boundaries.js";
import { ExternalWorkflowValidationError, normalizeGitHubExternalWorkItem, normalizeLinearExternalWorkItem } from "./external-work.js";
import type {
  ExternalSourceKind, ExternalSourceTarget, ExternalWorkFetchLike as FetchLike,
  ExternalWorkGetItemInput, ExternalWorkItem, ExternalWorkLoadCandidatesInput, ExternalWorkSourceAdapter,
} from "./external-work-types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface GitHubExternalWorkAdapterOptions {
  readonly fetch?: FetchLike;
  readonly apiBaseUrl?: string;
}

export interface LinearExternalWorkAdapterOptions {
  readonly fetch?: FetchLike;
  readonly apiBaseUrl?: string;
}

export function createGitHubExternalWorkAdapter(options: GitHubExternalWorkAdapterOptions = {}): ExternalWorkSourceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error("A fetch implementation is required for GitHub external work polling.");
  }
  const apiBaseUrl = trimBoundaryCharacters(options.apiBaseUrl ?? "https://api.github.com", "/", "end");

  return {
    id: "github-readonly",
    kind: "github",
    async loadCandidates(input: ExternalWorkLoadCandidatesInput): Promise<readonly ExternalWorkItem[]> {
      const limit = clampLimit(input.limit);
      const targetId = adapterTargetId(input, "github");
      const repository = parseRepositoryFullName(targetId);
      const candidates: ExternalWorkItem[] = [];
      const repositoryPayload = githubRepositoryPayload(targetId, repository);
      if (shouldLoadGitHubKind(input.events, "pull_request")) {
        const pulls = await githubJsonArray(fetchImpl, `${apiBaseUrl}/repos/${targetId}/pulls?state=open&per_page=${limit}`, input.token);
        for (const pullRequest of pulls) {
          candidates.push(normalizeGitHubExternalWorkItem({
            eventType: pickGitHubEvent(input.events, "pull_request", "pull_request.opened"),
            payload: { repository: repositoryPayload, pull_request: pullRequest },
            repositoryFullName: targetId,
            payloadRef: `github:poll:pull_request:${targetId}#${readGitHubNumber(pullRequest)}`,
          }));
        }
      }
      if (shouldLoadGitHubKind(input.events, "issue")) {
        const issues = await githubJsonArray(fetchImpl, `${apiBaseUrl}/repos/${targetId}/issues?state=open&per_page=${limit}`, input.token);
        for (const issue of issues) {
          if (isRecord(issue) && isRecord(issue.pull_request)) {
            continue;
          }
          candidates.push(normalizeGitHubExternalWorkItem({
            eventType: pickGitHubEvent(input.events, "issue", "issue.opened"),
            payload: { repository: repositoryPayload, issue },
            repositoryFullName: targetId,
            payloadRef: `github:poll:issue:${targetId}#${readGitHubNumber(issue)}`,
          }));
        }
      }
      return candidates.slice(0, limit);
    },
    async getWorkItem(input: ExternalWorkGetItemInput): Promise<ExternalWorkItem | undefined> {
      const targetId = adapterTargetId(input, "github");
      if (input.kind !== "github_pull_request" && input.kind !== "github_issue") return undefined;
      const repository = parseRepositoryFullName(targetId);
      const repositoryPayload = githubRepositoryPayload(targetId, repository);
      if (input.kind === "github_pull_request") {
        const pullRequest = await githubJson(fetchImpl, `${apiBaseUrl}/repos/${targetId}/pulls/${input.number}`, input.token);
        return normalizeGitHubExternalWorkItem({
          eventType: "pull_request.opened",
          payload: { repository: repositoryPayload, pull_request: pullRequest },
          repositoryFullName: targetId,
          payloadRef: `github:reconcile:pull_request:${targetId}#${input.number}`,
        });
      }
      const issue = await githubJson(fetchImpl, `${apiBaseUrl}/repos/${targetId}/issues/${input.number}`, input.token);
      if (isRecord(issue) && isRecord(issue.pull_request)) {
        return undefined;
      }
      return normalizeGitHubExternalWorkItem({
        eventType: "issue.opened",
        payload: { repository: repositoryPayload, issue },
        repositoryFullName: targetId,
        payloadRef: `github:reconcile:issue:${targetId}#${input.number}`,
      });
    },
  };
}

export function createLinearExternalWorkAdapter(options: LinearExternalWorkAdapterOptions = {}): ExternalWorkSourceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error("A fetch implementation is required for Linear external work polling.");
  }
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.linear.app/graphql";

  return {
    id: "linear-readonly",
    kind: "linear",
    async loadCandidates(input: ExternalWorkLoadCandidatesInput): Promise<readonly ExternalWorkItem[]> {
      const limit = clampLimit(input.limit);
      const projectSlug = adapterTargetId(input, "linear");
      const value = await linearGraphQL(fetchImpl, apiBaseUrl, input.token, LINEAR_ISSUES_QUERY, { first: limit });
      const issues = readLinearIssueNodes(value);
      return issues
        .filter((issue) => matchesLinearProject(issue, projectSlug))
        .map((issue) => normalizeLinearExternalWorkItem({
          eventType: pickLinearEvent(input.events, "issue.created"),
          payload: issue,
          projectSlug,
          payloadRef: `linear:poll:issue:${projectSlug}:${readLinearIdentifier(issue)}`,
        }))
        .slice(0, limit);
    },
    async getWorkItem(): Promise<ExternalWorkItem | undefined> {
      return undefined;
    },
  };
}

const LINEAR_ISSUES_QUERY = `
query LingStackExternalWorkIssues($first: Int!) {
  issues(first: $first) {
    nodes {
      id
      identifier
      title
      description
      url
      priority
      branchName
      updatedAt
      state {
        name
        type
      }
      labels {
        nodes {
          name
        }
      }
      project {
        name
        slug
      }
      team {
        key
        name
      }
    }
  }
}
`;

async function linearGraphQL(
  fetchImpl: FetchLike,
  url: string,
  token: string | undefined,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "ling-stack-external-work",
      ...(token ? { Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    throw new Error(`Linear read-only request failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 300)}` : ""}`);
  }
  const value = await response.json();
  if (isRecord(value) && Array.isArray(value.errors) && value.errors.length > 0) {
    throw new Error(`Linear read-only request failed: ${JSON.stringify(value.errors).slice(0, 300)}`);
  }
  return value;
}

function readLinearIssueNodes(value: unknown): readonly Record<string, unknown>[] {
  const root = readRecord(value, "Linear response");
  const data = readRecord(root.data, "Linear response data");
  const issues = readRecord(data.issues, "Linear issues");
  if (!Array.isArray(issues.nodes)) {
    throw new Error("Linear issues response must include nodes.");
  }
  return issues.nodes.map((node, index) => readRecord(node, `Linear issue node ${index}`));
}

function matchesLinearProject(issue: Record<string, unknown>, projectSlug: string): boolean {
  const project = isRecord(issue.project) ? issue.project : undefined;
  const slug = typeof project?.slug === "string" ? project.slug : undefined;
  const name = typeof project?.name === "string" ? project.name : undefined;
  return !projectSlug || slug === projectSlug || name === projectSlug;
}

function readLinearIdentifier(issue: Record<string, unknown>): string {
  const identifier = issue.identifier;
  if (typeof identifier !== "string" || !identifier.trim()) {
    throw new Error("Linear issue identifier is required.");
  }
  return identifier.trim();
}

function pickLinearEvent(events: readonly string[], fallback: string): string {
  return events.find((event) => event === "issue" || event.startsWith("issue.")) ?? fallback;
}

async function githubJsonArray(fetchImpl: FetchLike, url: string, token: string | undefined): Promise<readonly unknown[]> {
  const value = await githubJson(fetchImpl, url, token);
  if (!Array.isArray(value)) {
    throw new Error(`GitHub response must be an array: ${url}`);
  }
  return value;
}

async function githubJson(fetchImpl: FetchLike, url: string, token: string | undefined): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ling-stack-external-work",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    throw new Error(`GitHub read-only request failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 300)}` : ""}`);
  }
  return await response.json();
}

function shouldLoadGitHubKind(events: readonly string[], kind: "pull_request" | "issue"): boolean {
  return events.length === 0 || events.some((event) => event === `${kind}.*` || event === kind || event.startsWith(`${kind}.`));
}

function pickGitHubEvent(events: readonly string[], kind: "pull_request" | "issue", fallback: string): string {
  return events.find((event) => event === kind || event.startsWith(`${kind}.`)) ?? fallback;
}

function parseRepositoryFullName(fullName: string): { readonly owner: string; readonly name: string } {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) {
    throw new ExternalWorkflowValidationError(`Invalid GitHub repository full name: ${fullName}`);
  }
  return { owner, name };
}

function githubRepositoryPayload(fullName: string, repository: { readonly owner: string; readonly name: string }): Record<string, unknown> {
  return {
    name: repository.name,
    full_name: fullName,
    default_branch: "main",
    owner: { login: repository.owner },
  };
}

function readGitHubNumber(value: unknown): number {
  if (!isRecord(value) || typeof value.number !== "number") {
    throw new Error("GitHub candidate number is required.");
  }
  return value.number;
}

function clampLimit(value: number | undefined): number {
  return Math.min(Math.max(value ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function adapterTargetId(input: { readonly target?: ExternalSourceTarget; readonly repository?: string }, kind: ExternalSourceKind): string {
  if (input.target && input.target.kind !== kind) {
    throw new ExternalWorkflowValidationError(`Unsupported external source kind: ${input.target.kind}`);
  }
  const id = input.target?.id ?? input.repository;
  if (!id) {
    throw new ExternalWorkflowValidationError(`WORKFLOW.md source.${kind === "github" ? "repository" : "projectSlug"} is required.`);
  }
  return id;
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
