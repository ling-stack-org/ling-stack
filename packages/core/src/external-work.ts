import { parseDocument } from "yaml";
import type {
  ExternalSourceKind,
  ExternalWorkItem,
  ExternalWorkRepositoryRef,
  ExternalWorkflowActionsConfig,
  ExternalWorkflowAgentConfig,
  ExternalWorkflowConfig,
  ExternalWorkflowDefinition,
  ExternalWorkflowSchedulerConfig,
  ExternalWorkflowSourceConfig,
  ExternalWorkspaceConfig,
  ExternalWorkspaceHooks,
  ExternalWorkspaceMode,
} from "./external-work-types.js";

const DEFAULT_ACTIVE_STATES = ["open", "opened", "todo", "in progress"] as const;
const DEFAULT_TERMINAL_STATES = ["closed", "cancelled", "canceled", "duplicate", "done"] as const;

export class ExternalWorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalWorkflowValidationError";
  }
}

export function parseExternalWorkflowMarkdown(markdown: string): ExternalWorkflowDefinition {
  const { frontMatter, body } = splitMarkdownFrontMatter(markdown);
  const rawConfig = parseWorkflowFrontMatter(frontMatter);
  const promptTemplate = body.trim();
  if (!promptTemplate) {
    throw new ExternalWorkflowValidationError("WORKFLOW.md prompt body is required.");
  }
  return {
    config: normalizeExternalWorkflowConfig(rawConfig),
    promptTemplate,
  };
}

export function updateExternalWorkflowSecretRef(markdown: string, secretRef: string): string {
  const { frontMatter, body } = splitMarkdownFrontMatter(markdown);
  if (!frontMatter.trim()) {
    throw new ExternalWorkflowValidationError("WORKFLOW.md front matter is required to update source.secretRef.");
  }
  const document = parseDocument(frontMatter);
  if (document.errors.length > 0) {
    throw new ExternalWorkflowValidationError(`WORKFLOW.md front matter parse error: ${document.errors[0].message}`);
  }
  const value = document.toJSON();
  if (!isRecord(value)) {
    throw new ExternalWorkflowValidationError("WORKFLOW.md front matter must be an object.");
  }
  const source = readOptionalRecord(value.source, "source");
  if (!source) {
    throw new ExternalWorkflowValidationError("WORKFLOW.md source.kind is required.");
  }
  document.setIn(["source", "secretRef"], secretRef);
  return `---\n${document.toString().trimEnd()}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

export function renderExternalWorkflowPrompt(template: string, input: { readonly item: ExternalWorkItem }): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, expression: string) => {
    const path = expression.trim();
    if (!path.startsWith("item.")) {
      throw new ExternalWorkflowValidationError(`Unknown workflow prompt variable: ${path}`);
    }
    const value = readDotPath(input, path);
    if (value === undefined || value === null) {
      throw new ExternalWorkflowValidationError(`Unknown workflow prompt variable: ${path}`);
    }
    return formatPromptValue(value);
  });
}

export function normalizeGitHubExternalWorkItem(input: {
  readonly eventType: string;
  readonly payload: unknown;
  readonly repositoryFullName?: string;
  readonly payloadRef?: string;
}): ExternalWorkItem {
  const payload = readRecord(input.payload, "GitHub payload");
  if (input.eventType.startsWith("pull_request.")) {
    return normalizeGitHubPullRequest(payload, input);
  }
  if (input.eventType.startsWith("issue.")) {
    return normalizeGitHubIssue(payload, input);
  }
  throw new ExternalWorkflowValidationError(`Unsupported GitHub event type: ${input.eventType}`);
}

export function normalizeLinearExternalWorkItem(input: {
  readonly eventType: string;
  readonly payload: unknown;
  readonly projectSlug?: string;
  readonly payloadRef?: string;
}): ExternalWorkItem {
  const payload = readRecord(input.payload, "Linear payload");
  if (!input.eventType.startsWith("issue.")) {
    throw new ExternalWorkflowValidationError(`Unsupported Linear event type: ${input.eventType}`);
  }
  return normalizeLinearIssue(payload, input);
}

function splitMarkdownFrontMatter(markdown: string): { readonly frontMatter: string; readonly body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontMatter: "", body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    throw new ExternalWorkflowValidationError("WORKFLOW.md front matter is not closed.");
  }
  const afterMarker = normalized.startsWith("\n", end + 4) ? end + 5 : end + 4;
  return {
    frontMatter: normalized.slice(4, end),
    body: normalized.slice(afterMarker),
  };
}

function parseWorkflowFrontMatter(frontMatter: string): Record<string, unknown> {
  if (!frontMatter.trim()) {
    return {};
  }
  const document = parseDocument(frontMatter);
  if (document.errors.length > 0) {
    throw new ExternalWorkflowValidationError(`WORKFLOW.md front matter parse error: ${document.errors[0].message}`);
  }
  const value = document.toJSON();
  if (!isRecord(value)) {
    throw new ExternalWorkflowValidationError("WORKFLOW.md front matter must be an object.");
  }
  return value;
}

function normalizeExternalWorkflowConfig(raw: Record<string, unknown>): ExternalWorkflowConfig {
  const source = normalizeSourceConfig(readOptionalRecord(raw.source, "source"));
  return {
    source,
    scheduler: normalizeSchedulerConfig(readOptionalRecord(raw.scheduler, "scheduler")),
    workspace: normalizeWorkspaceConfig(readOptionalRecord(raw.workspace, "workspace")),
    hooks: normalizeHooksConfig(readOptionalRecord(raw.hooks, "hooks")),
    agent: normalizeAgentConfig(readOptionalRecord(raw.agent, "agent")),
    actions: normalizeActionsConfig(readOptionalRecord(raw.actions, "actions")),
  };
}

function normalizeSourceConfig(raw: Record<string, unknown> | undefined): ExternalWorkflowSourceConfig {
  if (!raw) {
    throw new ExternalWorkflowValidationError("WORKFLOW.md source.kind is required.");
  }
  const kind = readRequiredString(raw.kind, "source.kind") as ExternalSourceKind;
  if (kind !== "github" && kind !== "linear") {
    throw new ExternalWorkflowValidationError(`Unsupported external source kind: ${kind}`);
  }
  const repository = kind === "github" ? readRequiredString(raw.repository, "source.repository") : readOptionalString(raw.repository, "source.repository");
  const projectSlug = kind === "linear" ? readRequiredString(raw.projectSlug, "source.projectSlug") : readOptionalString(raw.projectSlug, "source.projectSlug");
  return {
    kind,
    repository,
    projectSlug,
    events: readOptionalStringArray(raw.events, "source.events"),
    activeStates: readOptionalStringArray(raw.activeStates, "source.activeStates", DEFAULT_ACTIVE_STATES),
    terminalStates: readOptionalStringArray(raw.terminalStates, "source.terminalStates", DEFAULT_TERMINAL_STATES),
    secretRef: readOptionalString(raw.secretRef, "source.secretRef"),
  };
}

function normalizeSchedulerConfig(raw: Record<string, unknown> | undefined): ExternalWorkflowSchedulerConfig {
  return {
    pollIntervalMs: readOptionalPositiveInteger(raw?.pollIntervalMs, "scheduler.pollIntervalMs", 30000),
    maxConcurrentWorkItems: readOptionalPositiveInteger(raw?.maxConcurrentWorkItems, "scheduler.maxConcurrentWorkItems", 4),
    maxConcurrentByKind: readOptionalPositiveIntegerMap(raw?.maxConcurrentByKind, "scheduler.maxConcurrentByKind"),
    maxRetryBackoffMs: readOptionalPositiveInteger(raw?.maxRetryBackoffMs, "scheduler.maxRetryBackoffMs", 300000),
    staleRunTimeoutMs: readOptionalPositiveIntegerOrUndefined(raw?.staleRunTimeoutMs, "scheduler.staleRunTimeoutMs"),
    reconcileOnStartup: readOptionalBoolean(raw?.reconcileOnStartup, "scheduler.reconcileOnStartup", true),
  };
}

function normalizeWorkspaceConfig(raw: Record<string, unknown> | undefined): ExternalWorkspaceConfig {
  const mode = (readOptionalString(raw?.mode, "workspace.mode") ?? "per_subject") as ExternalWorkspaceMode;
  if (mode !== "per_subject" && mode !== "per_attempt") {
    throw new ExternalWorkflowValidationError(`Unsupported workspace.mode: ${mode}`);
  }
  return {
    root: readOptionalString(raw?.root, "workspace.root"),
    mode,
    cleanupTerminalWorkItems: readOptionalBoolean(raw?.cleanupTerminalWorkItems, "workspace.cleanupTerminalWorkItems", false),
  };
}

function normalizeHooksConfig(raw: Record<string, unknown> | undefined): ExternalWorkspaceHooks {
  return {
    afterCreate: readOptionalString(raw?.afterCreate, "hooks.afterCreate"),
    beforeRun: readOptionalString(raw?.beforeRun, "hooks.beforeRun"),
    afterRun: readOptionalString(raw?.afterRun, "hooks.afterRun"),
    beforeRemove: readOptionalString(raw?.beforeRemove, "hooks.beforeRemove"),
    timeoutMs: readOptionalPositiveInteger(raw?.timeoutMs, "hooks.timeoutMs", 60000),
  };
}

function normalizeAgentConfig(raw: Record<string, unknown> | undefined): ExternalWorkflowAgentConfig {
  return {
    teammateId: readOptionalString(raw?.teammateId, "agent.teammateId"),
    requestedSkillId: readOptionalString(raw?.requestedSkillId, "agent.requestedSkillId"),
    maxTurns: readOptionalPositiveInteger(raw?.maxTurns, "agent.maxTurns", 20),
  };
}

function normalizeActionsConfig(raw: Record<string, unknown> | undefined): ExternalWorkflowActionsConfig {
  const approval = readOptionalString(raw?.defaultExternalMutationApproval, "actions.defaultExternalMutationApproval") ?? "strict";
  if (approval !== "standard" && approval !== "strict") {
    throw new ExternalWorkflowValidationError(`Unsupported actions.defaultExternalMutationApproval: ${approval}`);
  }
  return {
    defaultExternalMutationApproval: approval,
  };
}

function normalizeGitHubPullRequest(
  payload: Record<string, unknown>,
  input: { readonly eventType: string; readonly repositoryFullName?: string; readonly payloadRef?: string },
): ExternalWorkItem {
  const pullRequest = readRecord(payload.pull_request ?? payload, "GitHub pull_request");
  const repository = normalizeGitHubRepository(payload.repository, input.repositoryFullName);
  const number = readRequiredNumber(pullRequest.number, "pull_request.number");
  const title = readRequiredString(pullRequest.title, "pull_request.title");
  const state = readOptionalString(pullRequest.state, "pull_request.state") ?? "open";
  const updatedAt = readOptionalString(pullRequest.updated_at, "pull_request.updated_at");
  const head = readOptionalRecord(pullRequest.head, "pull_request.head");
  const base = readOptionalRecord(pullRequest.base, "pull_request.base");
  const headSha = readOptionalString(head?.sha, "pull_request.head.sha");
  const baseSha = readOptionalString(base?.sha, "pull_request.base.sha");
  const headRef = readOptionalString(head?.ref, "pull_request.head.ref");
  const identifier = `${repository.fullName}#${number}`;
  const idempotencyKey = [
    "github:pull_request",
    repository.fullName,
    String(number),
    headSha ?? "no-head-sha",
    updatedAt ?? state,
  ].join(":");
  return {
    id: `github:pull_request:${identifier}`,
    sourceKind: "github",
    kind: "github_pull_request",
    identifier,
    title,
    description: readOptionalString(pullRequest.body, "pull_request.body"),
    url: readOptionalString(pullRequest.html_url, "pull_request.html_url"),
    state,
    labels: normalizeGitHubLabels(pullRequest.labels),
    repository,
    branchName: headRef,
    baseSha,
    headSha,
    updatedAt,
    payloadRef: input.payloadRef ?? `${input.eventType}:${identifier}`,
    idempotencyKey,
  };
}

function normalizeGitHubIssue(
  payload: Record<string, unknown>,
  input: { readonly eventType: string; readonly repositoryFullName?: string; readonly payloadRef?: string },
): ExternalWorkItem {
  const issue = readRecord(payload.issue ?? payload, "GitHub issue");
  if (isRecord(issue.pull_request)) {
    throw new ExternalWorkflowValidationError("GitHub pull request issue payload is not a standalone issue.");
  }
  const repository = normalizeGitHubRepository(payload.repository, input.repositoryFullName);
  const number = readRequiredNumber(issue.number, "issue.number");
  const title = readRequiredString(issue.title, "issue.title");
  const state = readOptionalString(issue.state, "issue.state") ?? "open";
  const updatedAt = readOptionalString(issue.updated_at, "issue.updated_at");
  const identifier = `${repository.fullName}#${number}`;
  const idempotencyKey = [
    "github:issue",
    repository.fullName,
    String(number),
    updatedAt ?? state,
  ].join(":");
  return {
    id: `github:issue:${identifier}`,
    sourceKind: "github",
    kind: "github_issue",
    identifier,
    title,
    description: readOptionalString(issue.body, "issue.body"),
    url: readOptionalString(issue.html_url, "issue.html_url"),
    state,
    labels: normalizeGitHubLabels(issue.labels),
    repository,
    updatedAt,
    payloadRef: input.payloadRef ?? `${input.eventType}:${identifier}`,
    idempotencyKey,
  };
}

function normalizeLinearIssue(
  payload: Record<string, unknown>,
  input: { readonly eventType: string; readonly projectSlug?: string; readonly payloadRef?: string },
): ExternalWorkItem {
  const issue = readRecord(payload.issue ?? payload.data ?? payload, "Linear issue");
  const identifier = readRequiredString(issue.identifier, "issue.identifier");
  const title = readRequiredString(issue.title, "issue.title");
  const state = normalizeLinearState(issue.state);
  const updatedAt = readOptionalString(issue.updatedAt, "issue.updatedAt") ?? readOptionalString(issue.updated_at, "issue.updated_at");
  const project = readOptionalRecord(issue.project, "issue.project");
  const projectSlug = readOptionalString(project?.slug, "issue.project.slug") ?? input.projectSlug;
  const linearId = readOptionalString(issue.id, "issue.id") ?? identifier;
  const idempotencyKey = [
    "linear:issue",
    projectSlug ?? "no-project",
    identifier,
    updatedAt ?? state,
  ].join(":");
  return {
    id: `linear:issue:${linearId}`,
    sourceKind: "linear",
    kind: "linear_issue",
    identifier,
    title,
    description: readOptionalString(issue.description, "issue.description"),
    url: readOptionalString(issue.url, "issue.url"),
    state,
    priority: readOptionalNumber(issue.priority, "issue.priority"),
    labels: normalizeLinearLabels(issue.labels),
    branchName: readOptionalString(issue.branchName, "issue.branchName") ?? readOptionalString(issue.branch_name, "issue.branch_name"),
    updatedAt,
    payloadRef: input.payloadRef ?? `${input.eventType}:${identifier}`,
    idempotencyKey,
  };
}

function normalizeLinearState(raw: unknown): string {
  if (isRecord(raw)) {
    return readOptionalString(raw.name, "issue.state.name") ?? readOptionalString(raw.type, "issue.state.type") ?? "open";
  }
  return readOptionalString(raw, "issue.state") ?? "open";
}

function normalizeLinearLabels(raw: unknown): string[] {
  const values = isRecord(raw) && Array.isArray(raw.nodes) ? raw.nodes : Array.isArray(raw) ? raw : [];
  return values
    .map((label) => {
      if (typeof label === "string") {
        return label;
      }
      if (isRecord(label)) {
        return readOptionalString(label.name, "label.name") ?? "";
      }
      return "";
    })
    .map((label) => label.trim())
    .filter(Boolean);
}

function normalizeGitHubRepository(raw: unknown, fallbackFullName: string | undefined): ExternalWorkRepositoryRef {
  const repository = isRecord(raw) ? raw : undefined;
  const fullName = readOptionalString(repository?.full_name, "repository.full_name") ?? fallbackFullName;
  if (!fullName) {
    throw new ExternalWorkflowValidationError("GitHub repository full name is required.");
  }
  const [fallbackOwner, fallbackName] = splitRepositoryFullName(fullName);
  const ownerRecord = readOptionalRecord(repository?.owner, "repository.owner");
  return {
    owner: readOptionalString(ownerRecord?.login, "repository.owner.login") ?? fallbackOwner,
    name: readOptionalString(repository?.name, "repository.name") ?? fallbackName,
    fullName,
    defaultBranch: readOptionalString(repository?.default_branch, "repository.default_branch") ?? "main",
  };
}

function normalizeGitHubLabels(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((label) => {
      if (typeof label === "string") {
        return label.trim().toLowerCase();
      }
      if (isRecord(label) && typeof label.name === "string") {
        return label.name.trim().toLowerCase();
      }
      return "";
    })
    .filter(Boolean);
}

function splitRepositoryFullName(fullName: string): readonly [string, string] {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) {
    throw new ExternalWorkflowValidationError(`Invalid GitHub repository full name: ${fullName}`);
  }
  return [owner, name];
}

function readDotPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[part];
  }, root);
}

function formatPromptValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => formatPromptValue(item)).join(", ");
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ExternalWorkflowValidationError(`${name} must be an object.`);
  }
  return value;
}

function readOptionalRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return readRecord(value, name);
}

function readRequiredString(value: unknown, name: string): string {
  const stringValue = readOptionalString(value, name);
  if (!stringValue) {
    throw new ExternalWorkflowValidationError(`${name} is required.`);
  }
  return stringValue;
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ExternalWorkflowValidationError(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readRequiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ExternalWorkflowValidationError(`${name} must be a number.`);
  }
  return value;
}

function readOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return readRequiredNumber(value, name);
}

function readOptionalStringArray(value: unknown, name: string, defaultValue: readonly string[] = []): readonly string[] {
  if (value === undefined || value === null) {
    return [...defaultValue];
  }
  if (!Array.isArray(value)) {
    throw new ExternalWorkflowValidationError(`${name} must be a string array.`);
  }
  return value.map((item, index) => readRequiredString(item, `${name}[${index}]`));
}

function readOptionalPositiveInteger(value: unknown, name: string, defaultValue: number): number {
  return readOptionalPositiveIntegerOrUndefined(value, name) ?? defaultValue;
}

function readOptionalPositiveIntegerOrUndefined(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new ExternalWorkflowValidationError(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function readOptionalPositiveIntegerMap(value: unknown, name: string): Readonly<Record<string, number>> {
  if (value === undefined || value === null) {
    return {};
  }
  const record = readRecord(value, name);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = readOptionalPositiveInteger(entry, `${name}.${key}`, 1);
  }
  return result;
}

function readOptionalBoolean(value: unknown, name: string, defaultValue: boolean): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new ExternalWorkflowValidationError(`${name} must be a boolean.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
