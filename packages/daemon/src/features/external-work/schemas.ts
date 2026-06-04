import {
  readOnlyRunTools,
  type ExternalWorkActionExecuteRequest,
  type ExternalWorkActionCancelRequest,
  type ExternalSourceKind,
  type ExternalWorkActionKind,
  type ExternalWorkActionProposeRequest,
  type ExternalWorkActionStatus,
  type ExternalWorkCiTriageStatus,
  type ExternalWorkCiTriageRequest,
  type ExternalWorkCiTriageRunRequest,
  type ExternalWorkGitHubBackgroundStartRequest,
  type ExternalWorkSecretConfigureRequest,
  type ExternalWorkSecretDeleteRequest,
  type ExternalWorkItemKind,
  type ExternalWorkPollRequest,
  type ExternalWorkReconcileRequest,
  type ExternalWorkSchedulerStatus,
  type ExternalWorkWorkflowConfigureRequest,
  type RunTool,
} from "@ling-stack/core";
import {
  isRecord,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalObject,
  readOptionalString,
  readOptionalStringArray,
  readString,
  readStringAllowEmpty,
} from "../../shared/validation.js";

export const externalWorkActionKinds = ["github_comment", "github_label", "github_pr_review"] as const satisfies readonly ExternalWorkActionKind[];
const externalSourceKinds = ["github", "linear"] as const satisfies readonly ExternalSourceKind[];
const externalWorkItemKinds = ["github_pull_request", "github_issue", "linear_issue"] as const satisfies readonly ExternalWorkItemKind[];
const externalWorkActionStatuses = [
  "proposed",
  "waiting_for_approval",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "cancelled",
  "denied",
  "expired",
  "stale_target",
] as const satisfies readonly ExternalWorkActionStatus[];
const externalWorkSchedulerStatuses = [
  "discovered",
  "claimed",
  "workspace_preparing",
  "ready",
  "blocked",
  "retry_wait",
  "terminal",
] as const satisfies readonly ExternalWorkSchedulerStatus[];
const externalWorkCiTriageStatuses = [
  "triaged",
  "task_created",
  "run_requested",
  "blocked",
  "stale",
  "failed",
] as const satisfies readonly ExternalWorkCiTriageStatus[];

export interface ExternalGitHubImportRequest {
  readonly channelId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly workflowMarkdown?: string;
  readonly workflowPath?: string;
}

export interface ExternalLinearImportRequest {
  readonly channelId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly workflowMarkdown?: string;
  readonly workflowPath?: string;
}

export function readOptionalExternalSourceKindQuery(url: URL): ExternalSourceKind | undefined {
  const value = url.searchParams.get("sourceKind");
  if (value === null) {
    return undefined;
  }
  if (!externalSourceKinds.includes(value as ExternalSourceKind)) {
    throw new Error(`sourceKind must be one of: ${externalSourceKinds.join(", ")}`);
  }
  return value as ExternalSourceKind;
}

export function readOptionalExternalWorkItemKindQuery(url: URL): ExternalWorkItemKind | undefined {
  const value = url.searchParams.get("workItemKind");
  if (value === null) {
    return undefined;
  }
  if (!externalWorkItemKinds.includes(value as ExternalWorkItemKind)) {
    throw new Error(`workItemKind must be one of: ${externalWorkItemKinds.join(", ")}`);
  }
  return value as ExternalWorkItemKind;
}

export function readOptionalExternalWorkSchedulerStatusQuery(url: URL): ExternalWorkSchedulerStatus | undefined {
  const value = url.searchParams.get("schedulerStatus") ?? url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!externalWorkSchedulerStatuses.includes(value as ExternalWorkSchedulerStatus)) {
    throw new Error(`schedulerStatus must be one of: ${externalWorkSchedulerStatuses.join(", ")}`);
  }
  return value as ExternalWorkSchedulerStatus;
}

export function readOptionalExternalWorkActionKindQuery(url: URL): ExternalWorkActionKind | undefined {
  const value = url.searchParams.get("actionKind");
  if (value === null) {
    return undefined;
  }
  if (!externalWorkActionKinds.includes(value as ExternalWorkActionKind)) {
    throw new Error(`actionKind must be one of: ${externalWorkActionKinds.join(", ")}`);
  }
  return value as ExternalWorkActionKind;
}

export function readOptionalExternalWorkActionStatusQuery(url: URL): ExternalWorkActionStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!externalWorkActionStatuses.includes(value as ExternalWorkActionStatus)) {
    throw new Error(`status must be one of: ${externalWorkActionStatuses.join(", ")}`);
  }
  return value as ExternalWorkActionStatus;
}

export function readOptionalExternalWorkCiTriageStatusQuery(url: URL): ExternalWorkCiTriageStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!externalWorkCiTriageStatuses.includes(value as ExternalWorkCiTriageStatus)) {
    throw new Error(`status must be one of: ${externalWorkCiTriageStatuses.join(", ")}`);
  }
  return value as ExternalWorkCiTriageStatus;
}

export function readExternalWorkSecretConfigureRequest(body: unknown): ExternalWorkSecretConfigureRequest {
  if (!isRecord(body)) {
    throw new Error("external work secret setup request must be a JSON object");
  }
  const value = body;
  const channelId = readStringAllowEmpty(value, "channelId").trim();
  if (!channelId) {
    throw new Error("channelId is required.");
  }
  return {
    channelId,
    workflowPath: readOptionalString(value, "workflowPath"),
    token: readStringAllowEmpty(value, "token"),
    secretRef: readOptionalString(value, "secretRef"),
    updateWorkflow: readOptionalBoolean(value, "updateWorkflow"),
  };
}

export function readExternalWorkSecretDeleteRequest(body: unknown): ExternalWorkSecretDeleteRequest {
  if (!isRecord(body)) {
    throw new Error("external work secret delete request must be a JSON object");
  }
  const value = body;
  const channelId = readStringAllowEmpty(value, "channelId").trim();
  if (!channelId) {
    throw new Error("channelId is required.");
  }
  return {
    channelId,
    workflowPath: readOptionalString(value, "workflowPath"),
    secretRef: readOptionalString(value, "secretRef"),
  };
}

export function readExternalWorkWorkflowConfigureRequest(body: unknown): ExternalWorkWorkflowConfigureRequest {
  if (!isRecord(body)) {
    throw new Error("external work workflow setup request must be a JSON object");
  }
  const value = body;
  const channelId = readStringAllowEmpty(value, "channelId").trim();
  if (!channelId) {
    throw new Error("channelId is required.");
  }
  const sourceKind = readExternalSourceKind(value, "sourceKind");
  const rawRepository = readOptionalString(value, "repository");
  const repository = rawRepository !== undefined ? normalizeGitHubRepositoryInput(rawRepository) : undefined;
  const projectSlug = readOptionalString(value, "projectSlug")?.trim();
  if (sourceKind === "github") {
    if (!repository) {
      throw new Error("repository is required for GitHub external work and must use owner/repo or GitHub URL format.");
    }
  } else if (!projectSlug) {
    throw new Error("projectSlug is required for Linear external work.");
  } else if (!/^[A-Za-z0-9_.-]+$/.test(projectSlug)) {
    throw new Error("projectSlug may only contain letters, numbers, dots, underscores, and dashes.");
  }
  return {
    channelId,
    workflowPath: readOptionalString(value, "workflowPath"),
    sourceKind,
    ...(repository ? { repository } : {}),
    ...(projectSlug ? { projectSlug } : {}),
  };
}

export function readExternalWorkActionProposeRequest(value: unknown): ExternalWorkActionProposeRequest {
  if (!isRecord(value)) {
    throw new Error("external work action proposal must be a JSON object");
  }
  const externalWorkId = readString(value, "externalWorkId");
  const actionKind = readString(value, "actionKind") as ExternalWorkActionKind;
  if (!externalWorkActionKinds.includes(actionKind)) {
    throw new Error(`actionKind must be one of: ${externalWorkActionKinds.join(", ")}`);
  }
  const payload = readOptionalObject(value, "payload");
  if (!payload) {
    throw new Error("payload must be an object");
  }
  const payloadType = readString(payload, "type");
  const approvalRequirement = readOptionalString(value, "approvalRequirement");
  if (approvalRequirement !== undefined && approvalRequirement !== "standard" && approvalRequirement !== "strict") {
    throw new Error("approvalRequirement must be standard or strict");
  }
  const parsedPayload = payloadType === "github_comment"
    ? { type: "github_comment" as const, body: readString(payload, "body") }
    : payloadType === "github_label"
      ? { type: "github_label" as const, labels: readOptionalStringArray(payload, "labels") ?? [] }
      : payloadType === "github_pr_review"
        ? readGitHubPrReviewPayload(payload)
        : undefined;
  if (!parsedPayload) {
    throw new Error("payload.type must be github_comment, github_label, or github_pr_review");
  }
  return {
    externalWorkId,
    actionKind,
    payload: parsedPayload,
    approvalRequirement,
    expiresAt: readOptionalString(value, "expiresAt"),
  };
}

export function readExternalWorkActionCancelRequest(value: unknown): ExternalWorkActionCancelRequest | undefined {
  return isRecord(value) ? { reason: readOptionalString(value, "reason") } : undefined;
}

export function parseExternalWorkActionExecuteRequest(value: unknown): ExternalWorkActionExecuteRequest {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  return {
    workflowPath: readOptionalString(value, "workflowPath"),
  };
}

export function parseExternalGitHubBackgroundStartRequest(value: unknown): ExternalWorkGitHubBackgroundStartRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  const limit = readOptionalNumber(value, "limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  return {
    channelId: readString(value, "channelId"),
    workflowPath: readOptionalString(value, "workflowPath"),
    limit,
    executeHooks: readOptionalBoolean(value, "executeHooks"),
    runImmediately: readOptionalBoolean(value, "runImmediately"),
  };
}

export function parseExternalGitHubImportRequest(value: unknown): ExternalGitHubImportRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  if (value.payload === undefined) {
    throw new Error("payload is required");
  }
  return {
    channelId: readString(value, "channelId"),
    eventType: readString(value, "eventType"),
    payload: value.payload,
    workflowMarkdown: readOptionalString(value, "workflowMarkdown"),
    workflowPath: readOptionalString(value, "workflowPath"),
  };
}

export function parseExternalLinearImportRequest(value: unknown): ExternalLinearImportRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  if (value.payload === undefined) {
    throw new Error("payload is required");
  }
  return {
    channelId: readString(value, "channelId"),
    eventType: readString(value, "eventType"),
    payload: value.payload,
    workflowMarkdown: readOptionalString(value, "workflowMarkdown"),
    workflowPath: readOptionalString(value, "workflowPath"),
  };
}

export function parseExternalGitHubPollRequest(value: unknown): ExternalWorkPollRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  const limit = readOptionalNumber(value, "limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  return {
    channelId: readString(value, "channelId"),
    workflowPath: readOptionalString(value, "workflowPath"),
    limit,
    executeHooks: readOptionalBoolean(value, "executeHooks"),
  };
}

export function parseExternalLinearPollRequest(value: unknown): ExternalWorkPollRequest {
  return parseExternalGitHubPollRequest(value);
}

export function parseExternalGitHubCiTriageRequest(value: unknown): ExternalWorkCiTriageRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  const limit = readOptionalNumber(value, "limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 25)) {
    throw new Error("limit must be an integer between 1 and 25");
  }
  return {
    externalWorkId: readString(value, "externalWorkId"),
    workflowPath: readOptionalString(value, "workflowPath"),
    limit,
    createTask: readOptionalBoolean(value, "createTask"),
    startRun: readOptionalBoolean(value, "startRun"),
  };
}

export function parseExternalWorkCiTriageRunRequest(value: unknown): ExternalWorkCiTriageRunRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  return {
    providerPresetId: readString(value, "providerPresetId"),
    skipProviderPreflight: readOptionalBoolean(value, "skipProviderPreflight"),
    idempotencyKey: readOptionalString(value, "idempotencyKey"),
    tools: readOptionalRunTools(value, "tools"),
    thinkingLevel: readOptionalThinkingLevel(value, "thinkingLevel"),
    systemPrompt: readOptionalString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    agentDir: readOptionalString(value, "agentDir"),
  };
}

export function parseExternalWorkReconcileRequest(value: unknown): ExternalWorkReconcileRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  return {
    channelId: readOptionalString(value, "channelId"),
    workflowPath: readOptionalString(value, "workflowPath"),
  };
}

function readOptionalRunTools(record: Record<string, unknown>, key: string): RunTool[] | undefined {
  return readOptionalStringArray(record, key, [...readOnlyRunTools, "bash", "edit", "write"] as const);
}

function readOptionalThinkingLevel(record: Record<string, unknown>, key: string): ExternalWorkCiTriageRunRequest["thinkingLevel"] {
  return readOptionalStringArray({ [key]: record[key] === undefined ? undefined : [record[key]] }, key, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ])?.[0];
}

function readExternalSourceKind(record: Record<string, unknown>, key: string): ExternalSourceKind {
  const value = readStringAllowEmpty(record, key).trim();
  if (!externalSourceKinds.includes(value as ExternalSourceKind)) {
    throw new Error(`${key} must be one of: ${externalSourceKinds.join(", ")}`);
  }
  return value as ExternalSourceKind;
}

function normalizeGitHubRepositoryInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return undefined;
    }
    if (url.hostname !== "github.com") {
      return undefined;
    }
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    candidate = owner && repo ? `${owner}/${repo}` : "";
  } else if (candidate.startsWith("git@github.com:")) {
    candidate = candidate.slice("git@github.com:".length);
  } else if (candidate.startsWith("github.com/")) {
    candidate = candidate.slice("github.com/".length);
  }

  candidate = candidate.replace(/\.git$/i, "").replace(/\/+$/g, "");
  const [owner, repo, ...extra] = candidate.split("/");
  if (!owner || !repo || extra.length > 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return undefined;
  }
  return `${owner}/${repo}`;
}

function readGitHubPrReviewPayload(payload: Record<string, unknown>): {
  readonly type: "github_pr_review";
  readonly event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  readonly body: string;
} {
  const event = readString(payload, "event");
  if (event !== "COMMENT" && event !== "APPROVE" && event !== "REQUEST_CHANGES") {
    throw new Error("payload.event must be COMMENT, APPROVE, or REQUEST_CHANGES");
  }
  return {
    type: "github_pr_review",
    event,
    body: readString(payload, "body"),
  };
}
