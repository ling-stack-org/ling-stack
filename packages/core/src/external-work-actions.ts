import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";
import type { ApprovalRequest } from "./approval-types.js";
import type {
  ExternalWorkAction,
  ExternalWorkActionCancelRequest,
  ExternalWorkActionPayload,
  ExternalWorkActionProposeRequest,
  ExternalWorkActionTarget,
  ExternalWorkActionView,
  ExternalWorkRecord,
} from "./external-work-types.js";
import type { RunArtifact, RunStore } from "./run-types.js";

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

function normalizeArtifactPath(path: string): string {
  return path.split(/[/\\]+/).join("/");
}
