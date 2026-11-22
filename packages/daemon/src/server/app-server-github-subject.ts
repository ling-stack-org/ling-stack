import { createHash } from "node:crypto";
import type { LingAppServerGitHubSubject, LingAppServerGitHubSubjectParams } from "@ling-stack/contracts";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { isRecord } from "../shared/validation.js";
import { githubRepositoryPattern } from "./app-server-github-sources.js";

export function parseGitHubSubjectParams(value: unknown): LingAppServerGitHubSubjectParams {
  if (!isRecord(value) || typeof value.repository !== "string" || !githubRepositoryPattern.test(value.repository)
    || value.kind !== "issue" && value.kind !== "pull_request" || typeof value.number !== "number"
    || !Number.isSafeInteger(value.number) || value.number < 1) {
    throw new HttpError(400, "invalid_params", "Supply a GitHub repository, subject kind and positive object number.");
  }
  return { repository: value.repository.toLowerCase(), kind: value.kind, number: value.number };
}

export function gitHubWorkItemTargetKey(subject: LingAppServerGitHubSubject): string {
  return `github_${digest([subject.githubInstanceId, subject.repositoryId, subject.kind, subject.number])}`;
}

export function gitHubReadClient(context: DaemonContext, cwd: string, repository: string) {
  const source = context.config.appServerGitHubSources.find(item => item.workspaceRoot === cwd && item.repository === repository);
  if (!source) throw new HttpError(403, "github_subject_unavailable", "The GitHub repository is unavailable in this workspace.");
  const secret = source.secretRef ? context.secretResolver.resolve(source.secretRef, "github_token") : undefined;
  if (source.secretRef && (!secret || !secret.value)) {
    throw new HttpError(403, "github_subject_unavailable", "The GitHub repository is unavailable in this workspace.");
  }
  const fetcher = context.externalWorkFetch ?? globalThis.fetch;
  return {
    source,
    async get(path: string): Promise<Record<string, unknown>> {
      let response: Response;
      try {
        response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "ling-stack-app-server",
            ...(secret?.value ? { Authorization: `Bearer ${secret.value}` } : {}) },
          redirect: "error", signal: AbortSignal.timeout(8000),
        });
      } catch {
        throw new HttpError(502, "github_observation_unavailable", "GitHub could not confirm the requested object.");
      }
      if (!response.ok) {
        throw new HttpError(response.status === 404 || response.status === 403 ? 404 : 502,
          "github_observation_unavailable", "GitHub could not confirm the requested object.");
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (!isRecord(body)) throw new HttpError(502, "github_observation_invalid", "GitHub returned an invalid record.");
      return body;
    },
  };
}

export type GitHubReadClient = ReturnType<typeof gitHubReadClient>;

export async function readAppServerGitHubSubject(client: GitHubReadClient, params: LingAppServerGitHubSubjectParams): Promise<LingAppServerGitHubSubject> {
  const path = params.kind === "issue" ? "/issues/" : "/pulls/";
  const [repo, item] = await Promise.all([client.get(""), client.get(path + params.number)]);
  if (String(repo.id) !== client.source.repositoryId || typeof repo.full_name !== "string"
    || repo.full_name.toLowerCase() !== client.source.repository || item.number !== params.number
    || typeof item.title !== "string" || !item.title.trim() || item.state !== "open" && item.state !== "closed"
    || params.kind === "issue" && item.pull_request) {
    throw new HttpError(404, "github_subject_unavailable", "The GitHub object did not match the registered subject.");
  }
  const base = isRecord(item.base) ? item.base : undefined;
  const head = isRecord(item.head) ? item.head : undefined;
  const baseSha = commitSha(base?.sha);
  const headSha = commitSha(head?.sha);
  const baseRef = typeof base?.ref === "string" ? base.ref : undefined;
  if (params.kind === "pull_request" && (!baseSha || !headSha || !baseRef || !isRecord(base?.repo)
    || String(base.repo.id) !== client.source.repositoryId)) {
    throw new HttpError(502, "github_observation_invalid", "GitHub did not confirm the pull request's head and base.");
  }
  const mergeSha = commitSha(item.merge_commit_sha);
  const merged = params.kind === "pull_request" ? item.merged === true : undefined;
  const facts = {
    githubInstanceId: "github.com" as const, repositoryId: client.source.repositoryId, repository: client.source.repository,
    kind: params.kind, number: params.number, title: item.title, state: item.state, baseRef, baseSha, headSha, mergeSha, merged,
  } satisfies Omit<LingAppServerGitHubSubject, "sourceRevision">;
  return { ...facts, sourceRevision: digest([facts, item.updated_at]) };
}

export function commitSha(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) ? value : undefined;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
