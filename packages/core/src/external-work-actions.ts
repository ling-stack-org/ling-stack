import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";
import type { ApprovalRequest } from "./approval-types.js";
import { redactSecrets } from "./redaction.js";
import { DEFAULT_WORKSPACE_ID } from "./workspace-types.js";
import { normalizeGitHubExternalWorkItem } from "./external-work.js";
import type {
  ExternalWorkAction,
  ExternalWorkActionCancelRequest,
  ExternalWorkActionPayload,
  ExternalWorkActionProposeRequest,
  ExternalWorkActionTarget,
  ExternalWorkActionView,
  ExternalWorkItem,
  ExternalWorkRecord,
} from "./external-work-types.js";
import type { RunArtifact, RunStore } from "./run-types.js";

type FetchLike = (input: string, init?: {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

interface GitHubActionResult {
  readonly request: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly statusText: string;
    readonly body?: unknown;
    readonly resultUrl?: string;
  };
  readonly resultUrl?: string;
}

export interface GitHubExternalActionAdapter {
  getPullRequest(input: GitHubSubjectInput): Promise<ExternalWorkItem | undefined>;
  getIssue(input: GitHubSubjectInput): Promise<ExternalWorkItem | undefined>;
  createIssueComment(input: GitHubCreateIssueCommentInput): Promise<GitHubActionResult>;
  addIssueLabels(input: GitHubAddIssueLabelsInput): Promise<GitHubActionResult>;
}

export interface GitHubSubjectInput {
  readonly repository: string;
  readonly number: number;
  readonly token?: string;
}

export interface GitHubCreateIssueCommentInput extends GitHubSubjectInput {
  readonly body: string;
}

export interface GitHubAddIssueLabelsInput extends GitHubSubjectInput {
  readonly labels: readonly string[];
}

export interface GitHubExternalActionAdapterOptions {
  readonly fetch?: FetchLike;
  readonly apiBaseUrl?: string;
}

export interface ExternalWorkActionProposalResult {
  readonly action: ExternalWorkAction;
  readonly approval?: ApprovalRequest;
  readonly artifacts: readonly RunArtifact[];
  readonly duplicate: boolean;
}

export interface ExternalWorkActionCancelResult {
  readonly action: ExternalWorkAction;
  readonly approval?: ApprovalRequest;
  readonly artifacts: readonly RunArtifact[];
}

export interface ExternalWorkActionExecutionResult {
  readonly action: ExternalWorkAction;
  readonly approval?: ApprovalRequest;
  readonly artifacts: readonly RunArtifact[];
}

const EXTERNAL_ACTION_LEASE_TTL_MS = 5 * 60 * 1000;

export function createGitHubExternalActionAdapter(options: GitHubExternalActionAdapterOptions = {}): GitHubExternalActionAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error("A fetch implementation is required for GitHub external action execution.");
  }
  const apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");

  return {
    async getPullRequest(input: GitHubSubjectInput): Promise<ExternalWorkItem | undefined> {
      const value = await githubJson(fetchImpl, `${apiBaseUrl}${githubRepoPath(input.repository)}/pulls/${input.number}`, input.token);
      if (value === undefined) {
        return undefined;
      }
      return normalizeGitHubExternalWorkItem({
        eventType: "pull_request.opened",
        payload: { repository: githubRepositoryPayload(input.repository), pull_request: value },
        repositoryFullName: input.repository,
        payloadRef: `github:action-revalidate:pull_request:${input.repository}#${input.number}`,
      });
    },
    async getIssue(input: GitHubSubjectInput): Promise<ExternalWorkItem | undefined> {
      const value = await githubJson(fetchImpl, `${apiBaseUrl}${githubRepoPath(input.repository)}/issues/${input.number}`, input.token);
      if (value === undefined || (isRecord(value) && isRecord(value.pull_request))) {
        return undefined;
      }
      return normalizeGitHubExternalWorkItem({
        eventType: "issue.opened",
        payload: { repository: githubRepositoryPayload(input.repository), issue: value },
        repositoryFullName: input.repository,
        payloadRef: `github:action-revalidate:issue:${input.repository}#${input.number}`,
      });
    },
    async createIssueComment(input: GitHubCreateIssueCommentInput): Promise<GitHubActionResult> {
      return await githubMutation(fetchImpl, {
        method: "POST",
        url: `${apiBaseUrl}${githubRepoPath(input.repository)}/issues/${input.number}/comments`,
        path: `${githubRepoPath(input.repository)}/issues/${input.number}/comments`,
        token: input.token,
        body: { body: input.body },
      });
    },
    async addIssueLabels(input: GitHubAddIssueLabelsInput): Promise<GitHubActionResult> {
      return await githubMutation(fetchImpl, {
        method: "POST",
        url: `${apiBaseUrl}${githubRepoPath(input.repository)}/issues/${input.number}/labels`,
        path: `${githubRepoPath(input.repository)}/issues/${input.number}/labels`,
        token: input.token,
        body: { labels: input.labels },
      });
    },
  };
}

export function proposeExternalWorkAction(input: {
  readonly store: RunStore;
  readonly request: ExternalWorkActionProposeRequest;
  readonly now: string;
}): ExternalWorkActionProposalResult {
  const externalWork = requireExternalWork(input.store, input.request.externalWorkId);
  const target = buildExternalWorkActionTarget(externalWork);
  const payload = normalizeExternalWorkActionPayload(input.request.payload);
  if (input.request.actionKind !== payload.type) {
    throw new Error(`actionKind must match payload.type: ${payload.type}`);
  }
  const approvalRequirement = input.request.approvalRequirement ?? "standard";
  const idempotencyKey = createExternalWorkActionIdempotencyKey(externalWork, payload, target);
  const existing = input.store.getExternalWorkActionByIdempotency(externalWork.sourceKind, idempotencyKey);
  if (existing) {
    return {
      action: existing,
      approval: existing.approvalId ? input.store.getApprovalRequest(existing.approvalId) : undefined,
      artifacts: artifactsForAction(input.store, existing),
      duplicate: true,
    };
  }

  const action = input.store.createExternalWorkAction({
    channelId: externalWork.channelId,
    externalWorkId: externalWork.id,
    sourceKind: externalWork.sourceKind,
    actionKind: input.request.actionKind,
    status: "proposed",
    idempotencyKey,
    target,
    payload,
    approvalRequirement,
  }, input.now);
  const artifacts = createProposedActionArtifacts(input.store, externalWork, action, input.now);
  const withArtifacts = input.store.updateExternalWorkAction(action.id, {
    artifactIds: artifacts.map((artifact) => artifact.id),
  }, input.now) ?? action;
  const approval = input.store.createApprovalRequest({
    externalWorkActionId: withArtifacts.id,
    channelId: withArtifacts.channelId,
    actionType: "external_send",
    risk: approvalRequirement === "strict" ? "high" : "medium",
    title: externalWorkActionTitle(withArtifacts),
    description: externalWorkActionDescription(externalWork, withArtifacts),
    payload: {
      type: "external_action",
      sourceKind: withArtifacts.sourceKind,
      actionKind: withArtifacts.actionKind,
      target: withArtifacts.target,
      preview: externalWorkActionPreview(withArtifacts),
    },
    expiresAt: input.request.expiresAt,
  }, input.now);
  const waiting = input.store.updateExternalWorkAction(withArtifacts.id, {
    approvalId: approval.id,
    status: "waiting_for_approval",
  }, input.now) ?? withArtifacts;
  return {
    action: waiting,
    approval,
    artifacts,
    duplicate: false,
  };
}

export async function executeExternalWorkAction(input: {
  readonly store: RunStore;
  readonly actionId: string;
  readonly githubToken?: string;
  readonly fetch?: FetchLike;
  readonly apiBaseUrl?: string;
  readonly now?: string;
}): Promise<ExternalWorkActionExecutionResult> {
  const now = input.now ?? new Date().toISOString();
  let action = input.store.getExternalWorkAction(input.actionId);
  if (!action) {
    throw new Error(`External work action not found: ${input.actionId}`);
  }
  const externalWork = requireExternalWork(input.store, action.externalWorkId);
  let approval = requireExecutableApproval(input.store, action, now);
  if (approval) {
    const synced = syncExternalWorkActionForApproval(input.store, approval, now);
    action = synced ?? action;
    approval = input.store.getApprovalRequest(approval.id) ?? approval;
  }
  assertExecutableAction(action, approval);

  const leaseOwnerId = `external_work_action:${action.id}`;
  const subjectLease = input.store.acquireResourceLease({
    workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "external_subject",
    resourceKey: externalWork.item.id,
    ownerType: "system",
    ownerId: leaseOwnerId,
    acquiredAt: now,
    expiresAt: addMilliseconds(now, EXTERNAL_ACTION_LEASE_TTL_MS),
  });
  if (!subjectLease) {
    const blocker = input.store.getBlockingResourceLease("external_subject", externalWork.item.id);
    throw new Error(blocker ? `External subject is locked by ${blocker.ownerType}:${blocker.ownerId}` : `External subject is locked: ${externalWork.item.id}`);
  }

  try {
    const attempt = action.executionAttemptCount + 1;
    const adapter = createGitHubExternalActionAdapter({ fetch: input.fetch, apiBaseUrl: input.apiBaseUrl });
    const current = action.target.subjectKind === "github_pull_request"
      ? await adapter.getPullRequest({ repository: action.target.repository, number: action.target.number, token: input.githubToken })
      : await adapter.getIssue({ repository: action.target.repository, number: action.target.number, token: input.githubToken });
    if (!current) {
      const staleReason = "GitHub subject no longer exists or no longer matches the target kind.";
      const artifact = createActionStaleArtifact(input.store, action, undefined, staleReason, now, attempt);
      const stale = input.store.updateExternalWorkAction(action.id, {
        status: "stale_target",
        artifactIds: [...action.artifactIds, artifact.id],
        executionAttemptCount: attempt,
        lastAttemptAt: now,
        lastErrorCode: "stale_target",
        lastErrorMessage: staleReason,
      }, now);
      if (!stale) {
        throw new Error(`Failed to update stale external work action: ${action.id}`);
      }
      return { action: stale, ...(approval ? { approval } : {}), artifacts: artifactsForAction(input.store, stale) };
    }
    const staleReason = staleTargetReason(action, current);
    if (staleReason) {
      const artifact = createActionStaleArtifact(input.store, action, current, staleReason, now, attempt);
      const stale = input.store.updateExternalWorkAction(action.id, {
        status: "stale_target",
        artifactIds: [...action.artifactIds, artifact.id],
        executionAttemptCount: attempt,
        lastAttemptAt: now,
        lastErrorCode: "stale_target",
        lastErrorMessage: staleReason,
      }, now);
      if (!stale) {
        throw new Error(`Failed to update stale external work action: ${action.id}`);
      }
      return { action: stale, ...(approval ? { approval } : {}), artifacts: artifactsForAction(input.store, stale) };
    }

    if (action.payload.type === "github_label" && labelsAlreadyPresent(current, action.payload.labels)) {
      const artifact = createActionNoopArtifact(input.store, action, current, now, attempt);
      const succeeded = input.store.updateExternalWorkAction(action.id, {
        status: "succeeded",
        artifactIds: [...action.artifactIds, artifact.id],
        executionAttemptCount: attempt,
        lastAttemptAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        executedAt: now,
      }, now);
      if (!succeeded) {
        throw new Error(`Failed to update external work action: ${action.id}`);
      }
      return { action: succeeded, ...(approval ? { approval } : {}), artifacts: artifactsForAction(input.store, succeeded) };
    }

    const executing = input.store.updateExternalWorkAction(action.id, {
      status: "executing",
      executionAttemptCount: attempt,
      lastAttemptAt: now,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    }, now);
    if (!executing) {
      throw new Error(`Failed to mark external work action as executing: ${action.id}`);
    }
    const result = action.payload.type === "github_comment"
      ? await adapter.createIssueComment({
        repository: action.target.repository,
        number: action.target.number,
        body: action.payload.body,
        token: input.githubToken,
      })
      : await adapter.addIssueLabels({
        repository: action.target.repository,
        number: action.target.number,
        labels: action.payload.labels,
        token: input.githubToken,
      });
    const artifact = createActionExecutionArtifact(input.store, action, result, input.githubToken, now, attempt);
    const succeeded = input.store.updateExternalWorkAction(action.id, {
      status: "succeeded",
      artifactIds: [...executing.artifactIds, artifact.id],
      lastErrorCode: null,
      lastErrorMessage: null,
      executedAt: now,
    }, now);
    if (!succeeded) {
      throw new Error(`Failed to mark external work action as succeeded: ${action.id}`);
    }
    return { action: succeeded, ...(approval ? { approval } : {}), artifacts: artifactsForAction(input.store, succeeded) };
  } catch (error) {
    const latest = input.store.getExternalWorkAction(action.id) ?? action;
    const failedAttempt = Math.max(latest.executionAttemptCount, action.executionAttemptCount + 1);
    const artifact = createActionFailureArtifact(input.store, latest, error, input.githubToken, now, failedAttempt);
    const failed = input.store.updateExternalWorkAction(action.id, {
      status: "failed",
      artifactIds: [...latest.artifactIds, artifact.id],
      executionAttemptCount: failedAttempt,
      lastAttemptAt: latest.lastAttemptAt ?? now,
      lastErrorCode: error instanceof GitHubExternalActionError ? error.code : "external_action_failed",
      lastErrorMessage: error instanceof Error ? error.message : String(error),
    }, now);
    if (!failed) {
      throw new Error(`Failed to mark external work action as failed: ${action.id}`);
    }
    return { action: failed, ...(approval ? { approval } : {}), artifacts: artifactsForAction(input.store, failed) };
  } finally {
    input.store.releaseResourceLeasesForOwner(subjectLease.ownerType, subjectLease.ownerId, new Date().toISOString());
  }
}

export function cancelExternalWorkAction(input: {
  readonly store: RunStore;
  readonly actionId: string;
  readonly request?: ExternalWorkActionCancelRequest;
  readonly now: string;
}): ExternalWorkActionCancelResult {
  const action = input.store.getExternalWorkAction(input.actionId);
  if (!action) {
    throw new Error(`External work action not found: ${input.actionId}`);
  }
  if (!["proposed", "waiting_for_approval", "approved"].includes(action.status)) {
    throw new Error(`External work action cannot be cancelled from status: ${action.status}`);
  }
  let approval = action.approvalId ? input.store.getApprovalRequest(action.approvalId) : undefined;
  if (approval?.status === "pending") {
    approval = input.store.denyApprovalRequest(approval.id, {
      reason: input.request?.reason ?? "External work action cancelled.",
      resolvedBy: "local-user",
    }, input.now) ?? approval;
  }
  const artifact = createActionCancelArtifact(input.store, action, input.request?.reason, input.now);
  const cancelled = input.store.updateExternalWorkAction(action.id, {
    status: "cancelled",
    artifactIds: [...action.artifactIds, artifact.id],
  }, input.now);
  if (!cancelled) {
    throw new Error(`Failed to cancel external work action: ${action.id}`);
  }
  return {
    action: cancelled,
    approval,
    artifacts: artifactsForAction(input.store, cancelled),
  };
}

export function buildExternalWorkActionView(store: RunStore, action: ExternalWorkAction): ExternalWorkActionView {
  const externalWork = store.getExternalWorkRecord(action.externalWorkId);
  const approval = action.approvalId ? store.getApprovalRequest(action.approvalId) : undefined;
  return {
    action,
    ...(externalWork ? { externalWork } : {}),
    ...(approval ? { approval } : {}),
    artifacts: artifactsForAction(store, action),
  };
}

export function syncExternalWorkActionForApproval(store: RunStore, approval: ApprovalRequest, now: string): ExternalWorkAction | undefined {
  if (!approval.externalWorkActionId) {
    return undefined;
  }
  const action = store.getExternalWorkAction(approval.externalWorkActionId);
  if (!action || action.status === "cancelled" || action.status === "succeeded" || action.status === "failed" || action.status === "stale_target") {
    return action;
  }
  if (approval.status === "approved") {
    return store.updateExternalWorkAction(action.id, { status: "approved" }, now);
  }
  if (approval.status === "denied") {
    return store.updateExternalWorkAction(action.id, { status: "denied" }, now);
  }
  if (approval.status === "expired") {
    return store.updateExternalWorkAction(action.id, { status: "expired" }, now);
  }
  return action;
}

function requireExternalWork(store: RunStore, externalWorkId: string): ExternalWorkRecord {
  const externalWork = store.getExternalWorkRecord(externalWorkId);
  if (!externalWork) {
    throw new Error(`External work item not found: ${externalWorkId}`);
  }
  if (externalWork.sourceKind !== "github") {
    throw new Error(`Unsupported external work source for actions: ${externalWork.sourceKind}`);
  }
  if (externalWork.workItemKind !== "github_pull_request" && externalWork.workItemKind !== "github_issue") {
    throw new Error(`Unsupported external work item kind for actions: ${externalWork.workItemKind}`);
  }
  return externalWork;
}

function requireExecutableApproval(store: RunStore, action: ExternalWorkAction, now: string): ApprovalRequest | undefined {
  if (!action.approvalId) {
    return undefined;
  }
  const approval = store.getApprovalRequest(action.approvalId);
  if (!approval) {
    throw new Error(`External work action approval not found: ${action.approvalId}`);
  }
  if (approval.externalWorkActionId !== action.id) {
    throw new Error(`Approval request does not belong to external work action: ${action.id}`);
  }
  if (approval.status === "pending" && approval.expiresAt && approval.expiresAt <= now) {
    const expired = store.expireApprovalRequest(approval.id, { reason: "External action approval expired before execution." }, now);
    if (expired) {
      syncExternalWorkActionForApproval(store, expired, now);
      return expired;
    }
  }
  return approval;
}

function assertExecutableAction(action: ExternalWorkAction, approval: ApprovalRequest | undefined): void {
  if (["cancelled", "denied", "expired", "stale_target", "succeeded", "failed", "executing"].includes(action.status)) {
    throw new Error(`External work action cannot execute from status: ${action.status}`);
  }
  if (!approval) {
    throw new Error("External work action approval is required before execution.");
  }
  if (approval.status !== "approved" || action.status !== "approved") {
    throw new Error(`External work action is not approved: action=${action.status}, approval=${approval.status}`);
  }
}

function buildExternalWorkActionTarget(externalWork: ExternalWorkRecord): ExternalWorkActionTarget {
  const item = externalWork.item;
  const repository = item.repository?.fullName;
  if (!repository) {
    throw new Error("External work item repository is required for GitHub actions.");
  }
  const number = readSubjectNumber(externalWork);
  return {
    sourceKind: item.sourceKind,
    repository,
    subjectKind: externalWork.workItemKind as "github_pull_request" | "github_issue",
    number,
    url: item.url,
    expectedState: item.state,
    expectedHeadSha: item.headSha,
    expectedUpdatedAt: item.updatedAt,
    expectedLabels: item.labels,
  };
}

function normalizeExternalWorkActionPayload(payload: ExternalWorkActionPayload): ExternalWorkActionPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("payload must be an object.");
  }
  if (payload.type === "github_comment") {
    const body = payload.body.trim();
    if (!body) {
      throw new Error("github_comment payload body is required.");
    }
    return { type: "github_comment", body };
  }
  if (payload.type === "github_label") {
    const labels = uniqueStrings(payload.labels.map((label) => label.trim()).filter(Boolean));
    if (labels.length === 0) {
      throw new Error("github_label payload labels are required.");
    }
    if (labels.length > 20) {
      throw new Error("github_label payload supports at most 20 labels.");
    }
    return { type: "github_label", labels };
  }
  throw new Error(`Unsupported external work action payload type: ${(payload as { readonly type?: string }).type ?? ""}`);
}

function createExternalWorkActionIdempotencyKey(
  externalWork: ExternalWorkRecord,
  payload: ExternalWorkActionPayload,
  target: ExternalWorkActionTarget,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ externalWorkId: externalWork.id, payload, target }))
    .digest("hex")
    .slice(0, 24);
  return [externalWork.sourceKind, payload.type, externalWork.id, hash].join(":");
}

function createProposedActionArtifacts(
  store: RunStore,
  externalWork: ExternalWorkRecord,
  action: ExternalWorkAction,
  createdAt: string,
): RunArtifact[] {
  const artifactDir = resolvePath(store.paths.artifactsDir, "external-work", externalWork.id, "actions", action.id);
  mkdirSync(artifactDir, { recursive: true });
  const targetJson = `${JSON.stringify(action.target, null, 2)}\n`;
  const payloadJson = `${JSON.stringify(action.payload, null, 2)}\n`;
  const previewMarkdown = `${externalWorkActionPreview(action).trim()}\n`;
  const targetPath = resolvePath(artifactDir, "target.json");
  const payloadPath = resolvePath(artifactDir, "payload.json");
  const previewPath = resolvePath(artifactDir, "approval-preview.md");
  writeFileSync(targetPath, targetJson, "utf8");
  writeFileSync(payloadPath, payloadJson, "utf8");
  writeFileSync(previewPath, previewMarkdown, "utf8");
  return [
    store.createArtifact({
      externalWorkId: externalWork.id,
      type: "json",
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, targetPath)),
      title: "External action target snapshot",
      contentType: "application/json; charset=utf-8",
      sizeBytes: Buffer.byteLength(targetJson, "utf8"),
      createdAt,
    }),
    store.createArtifact({
      externalWorkId: externalWork.id,
      type: "json",
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, payloadPath)),
      title: "External action proposed payload",
      contentType: "application/json; charset=utf-8",
      sizeBytes: Buffer.byteLength(payloadJson, "utf8"),
      createdAt,
    }),
    store.createArtifact({
      externalWorkId: externalWork.id,
      type: "markdown",
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, previewPath)),
      title: "External action approval preview",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: Buffer.byteLength(previewMarkdown, "utf8"),
      createdAt,
    }),
  ];
}

function createActionCancelArtifact(store: RunStore, action: ExternalWorkAction, reason: string | undefined, createdAt: string): RunArtifact {
  const artifactDir = resolvePath(store.paths.artifactsDir, "external-work", action.externalWorkId, "actions", action.id);
  mkdirSync(artifactDir, { recursive: true });
  const content = `${JSON.stringify({ actionId: action.id, previousStatus: action.status, reason: reason ?? null, cancelledAt: createdAt }, null, 2)}\n`;
  const artifactPath = resolvePath(artifactDir, "cancelled.json");
  writeFileSync(artifactPath, content, "utf8");
  return store.createArtifact({
    externalWorkId: action.externalWorkId,
    type: "json",
    path: normalizeArtifactPath(relative(store.paths.artifactsDir, artifactPath)),
    title: "External action cancellation",
    contentType: "application/json; charset=utf-8",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    createdAt,
  });
}

function createActionStaleArtifact(
  store: RunStore,
  action: ExternalWorkAction,
  current: ExternalWorkItem | undefined,
  reason: string,
  createdAt: string,
  attempt: number,
): RunArtifact {
  return createActionJsonArtifact(store, action, `stale-target-${attempt}.json`, "External action stale target", {
    actionId: action.id,
    attempt,
    staleAt: createdAt,
    reason,
    target: action.target,
    current: current ?? null,
  }, createdAt);
}

function createActionNoopArtifact(
  store: RunStore,
  action: ExternalWorkAction,
  current: ExternalWorkItem,
  createdAt: string,
  attempt: number,
): RunArtifact {
  return createActionJsonArtifact(store, action, `execution-noop-${attempt}.json`, "External action already satisfied", {
    actionId: action.id,
    attempt,
    executedAt: createdAt,
    result: "already_satisfied",
    target: action.target,
    currentLabels: current.labels,
  }, createdAt);
}

function createActionExecutionArtifact(
  store: RunStore,
  action: ExternalWorkAction,
  result: GitHubActionResult,
  token: string | undefined,
  createdAt: string,
  attempt: number,
): RunArtifact {
  return createActionJsonArtifact(store, action, `execution-result-${attempt}.json`, "External action execution result", redactSecrets({
    actionId: action.id,
    attempt,
    executedAt: createdAt,
    result,
  }, [token]), createdAt);
}

function createActionFailureArtifact(
  store: RunStore,
  action: ExternalWorkAction,
  error: unknown,
  token: string | undefined,
  createdAt: string,
  attempt: number,
): RunArtifact {
  return createActionJsonArtifact(store, action, `execution-failed-${attempt}.json`, "External action execution failure", redactSecrets({
    actionId: action.id,
    attempt,
    failedAt: createdAt,
    error: error instanceof GitHubExternalActionError
      ? {
        code: error.code,
        message: error.message,
        status: error.status,
        evidence: error.evidence,
      }
      : {
        code: "external_action_failed",
        message: error instanceof Error ? error.message : String(error),
      },
  }, [token]), createdAt);
}

function createActionJsonArtifact(
  store: RunStore,
  action: ExternalWorkAction,
  fileName: string,
  title: string,
  value: unknown,
  createdAt: string,
): RunArtifact {
  const artifactDir = resolvePath(store.paths.artifactsDir, "external-work", action.externalWorkId, "actions", action.id);
  mkdirSync(artifactDir, { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const artifactPath = resolvePath(artifactDir, fileName);
  writeFileSync(artifactPath, content, "utf8");
  return store.createArtifact({
    externalWorkId: action.externalWorkId,
    type: "json",
    path: normalizeArtifactPath(relative(store.paths.artifactsDir, artifactPath)),
    title,
    contentType: "application/json; charset=utf-8",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    createdAt,
  });
}

function artifactsForAction(store: RunStore, action: ExternalWorkAction): RunArtifact[] {
  return action.artifactIds
    .map((artifactId) => store.getArtifact(artifactId))
    .filter((artifact): artifact is RunArtifact => artifact !== undefined);
}

function externalWorkActionTitle(action: ExternalWorkAction): string {
  return action.actionKind === "github_comment"
    ? `Approve GitHub comment for ${action.target.repository}#${action.target.number}`
    : `Approve GitHub labels for ${action.target.repository}#${action.target.number}`;
}

function externalWorkActionDescription(externalWork: ExternalWorkRecord, action: ExternalWorkAction): string {
  return `External work ${externalWork.identifier} proposed ${action.actionKind}; execution requires explicit approval and a separate execute command.`;
}

function externalWorkActionPreview(action: ExternalWorkAction): string {
  if (action.payload.type === "github_comment") {
    return [
      `# ${externalWorkActionTitle(action)}`,
      "",
      `Target: ${action.target.repository}#${action.target.number}`,
      "",
      action.payload.body,
    ].join("\n");
  }
  return [
    `# ${externalWorkActionTitle(action)}`,
    "",
    `Target: ${action.target.repository}#${action.target.number}`,
    "",
    `Labels: ${action.payload.labels.join(", ")}`,
  ].join("\n");
}

function readSubjectNumber(externalWork: ExternalWorkRecord): number {
  const match = /#(\d+)$/.exec(externalWork.identifier);
  if (!match) {
    throw new Error(`External work identifier does not include a GitHub number: ${externalWork.identifier}`);
  }
  return Number.parseInt(match[1], 10);
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function staleTargetReason(action: ExternalWorkAction, current: ExternalWorkItem): string | undefined {
  if (current.repository?.fullName !== action.target.repository) {
    return `GitHub repository changed from ${action.target.repository} to ${current.repository?.fullName ?? "unknown"}.`;
  }
  const currentNumber = readIdentifierNumber(current.identifier);
  if (currentNumber !== action.target.number) {
    return `GitHub subject number changed from ${action.target.number} to ${currentNumber ?? "unknown"}.`;
  }
  if (current.state.toLowerCase() !== action.target.expectedState.toLowerCase()) {
    return `GitHub subject state changed from ${action.target.expectedState} to ${current.state}.`;
  }
  if (action.target.subjectKind === "github_pull_request" && action.target.expectedHeadSha && current.headSha !== action.target.expectedHeadSha) {
    return `GitHub pull request head SHA changed from ${action.target.expectedHeadSha} to ${current.headSha ?? "unknown"}.`;
  }
  if (action.target.subjectKind === "github_issue" && action.target.expectedUpdatedAt && current.updatedAt !== action.target.expectedUpdatedAt) {
    return `GitHub issue updatedAt changed from ${action.target.expectedUpdatedAt} to ${current.updatedAt ?? "unknown"}.`;
  }
  return undefined;
}

function labelsAlreadyPresent(current: ExternalWorkItem, labels: readonly string[]): boolean {
  const existing = new Set(current.labels.map((label) => label.toLowerCase()));
  return labels.every((label) => existing.has(label.toLowerCase()));
}

function readIdentifierNumber(identifier: string): number | undefined {
  const match = /#(\d+)$/.exec(identifier);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

async function githubJson(fetchImpl: FetchLike, url: string, token: string | undefined): Promise<unknown | undefined> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: githubHeaders(token),
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw await GitHubExternalActionError.fromResponse("github_revalidation_failed", "GitHub revalidation request failed", response, {
      method: "GET",
      path: new URL(url).pathname,
      headers: githubHeaders(token),
    });
  }
  return await response.json();
}

async function githubMutation(fetchImpl: FetchLike, input: {
  readonly method: "POST";
  readonly url: string;
  readonly path: string;
  readonly token: string | undefined;
  readonly body: unknown;
}): Promise<GitHubActionResult> {
  const headers = githubHeaders(input.token);
  const response = await fetchImpl(input.url, {
    method: input.method,
    headers,
    body: JSON.stringify(input.body),
  });
  const body = await readGitHubResponseBody(response);
  const evidence: GitHubActionResult = {
    request: {
      method: input.method,
      path: input.path,
      headers,
      body: input.body,
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      ...(body.value !== undefined ? { body: body.value } : {}),
      ...(body.resultUrl ? { resultUrl: body.resultUrl } : {}),
    },
    ...(body.resultUrl ? { resultUrl: body.resultUrl } : {}),
  };
  if (!response.ok) {
    throw new GitHubExternalActionError(githubErrorCode(response.status), `GitHub mutation request failed: ${response.status} ${response.statusText}`, response.status, evidence);
  }
  return evidence;
}

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "ling-stack-external-work",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function githubRepoPath(repository: string): string {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) {
    throw new Error(`Invalid GitHub repository full name: ${repository}`);
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function githubRepositoryPayload(fullName: string): Record<string, unknown> {
  const [owner, name] = fullName.split("/");
  return {
    name,
    full_name: fullName,
    default_branch: "main",
    owner: { login: owner },
  };
}

async function readGitHubResponseBody(response: { text(): Promise<string> }): Promise<{ readonly value?: unknown; readonly resultUrl?: string }> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    const value = JSON.parse(text) as unknown;
    return {
      value,
      resultUrl: readResultUrl(value),
    };
  } catch {
    return { value: text.slice(0, 2_000) };
  }
}

function readResultUrl(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.html_url === "string") {
    return value.html_url;
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => isRecord(item) && typeof item.url === "string");
    return isRecord(first) && typeof first.url === "string" ? first.url : undefined;
  }
  return undefined;
}

function githubErrorCode(status: number): string {
  if (status === 403) {
    return "github_permission_or_rate_limited";
  }
  if (status === 404) {
    return "github_target_not_found";
  }
  if (status === 422) {
    return "github_validation_failed";
  }
  if (status >= 500) {
    return "github_unavailable";
  }
  return "github_mutation_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addMilliseconds(value: string, milliseconds: number): string {
  const parsed = Date.parse(value);
  return new Date((Number.isFinite(parsed) ? parsed : Date.now()) + milliseconds).toISOString();
}

class GitHubExternalActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | undefined,
    readonly evidence: unknown,
  ) {
    super(message);
    this.name = "GitHubExternalActionError";
  }

  static async fromResponse(
    code: string,
    message: string,
    response: { readonly status: number; readonly statusText: string; text(): Promise<string> },
    request: GitHubActionResult["request"],
  ): Promise<GitHubExternalActionError> {
    const body = await readGitHubResponseBody(response);
    return new GitHubExternalActionError(code, `${message}: ${response.status} ${response.statusText}`, response.status, {
      request,
      response: {
        status: response.status,
        statusText: response.statusText,
        ...(body.value !== undefined ? { body: body.value } : {}),
      },
    });
  }
}

function normalizeArtifactPath(path: string): string {
  return path.split(/[/\\]+/).join("/");
}
