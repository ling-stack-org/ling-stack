import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  approvalActionTypes,
  type ApprovalActionType,
  type ApprovalRequest,
  type ApprovalStatus,
  type ExecutionAction,
  type ExecutionActionStatus,
  type ExecutionActionTargetRef,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import { expireStalePendingApprovals } from "./approvals.js";

export interface ListExecutionActionsOptions {
  readonly runId?: string;
  readonly threadId?: string;
  readonly status?: ExecutionActionStatus;
  readonly actionType?: ApprovalActionType;
  readonly limit?: number;
}

export function handleExecutionActionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /execution-actions` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    expireStalePendingApprovals(store, {
      runId: url.searchParams.get("runId") ?? undefined,
    });
    writeJson(response, 200, {
      cwd,
      actions: listExecutionActions(store, {
        runId: url.searchParams.get("runId") ?? undefined,
        threadId: url.searchParams.get("threadId") ?? undefined,
        status: readOptionalExecutionActionStatusQuery(url),
        actionType: readOptionalExecutionActionTypeQuery(url),
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function listExecutionActions(store: RunStore, options: ListExecutionActionsOptions = {}): ExecutionAction[] {
  const approvalStatus = options.status ? approvalStatusFromExecutionActionStatus(options.status) : undefined;
  if (options.status && !approvalStatus) {
    return [];
  }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const approvals = store.listApprovalRequests({
    runId: options.runId,
    status: approvalStatus,
    limit: options.threadId ? 500 : limit,
  });
  const actions = approvals
    .map((approval) => approvalToExecutionAction(store, approval))
    .filter((action) => !options.threadId || action.threadId === options.threadId)
    .filter((action) => !options.actionType || action.actionType === options.actionType);
  return actions.slice(0, limit);
}

function approvalToExecutionAction(store: RunStore, approval: ApprovalRequest): ExecutionAction {
  const run = approval.runId ? store.getRun(approval.runId) : undefined;
  return {
    id: `approval:${approval.id}`,
    workspaceId: DEFAULT_WORKSPACE_ID,
    threadId: run?.threadId,
    runId: approval.runId,
    workUnitId: run?.workUnitId,
    approvalId: approval.id,
    toolCallId: approval.toolCallId,
    actionType: approval.actionType,
    risk: approval.risk,
    status: executionActionStatusFromApproval(approval.status),
    title: approval.title,
    summary: approval.description,
    targetRefs: buildApprovalTargetRefs(approval, run),
    previewArtifactIds: [],
    resultArtifactIds: [],
    policySnapshot: readRunPolicySnapshot(run),
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt,
    completedAt: approval.resolvedAt,
  };
}

function buildApprovalTargetRefs(approval: ApprovalRequest, run: RunSession | undefined): ExecutionActionTargetRef[] {
  const refs: ExecutionActionTargetRef[] = [];
  if (approval.runId) {
    refs.push({ type: "run", id: approval.runId });
  }
  if (run?.workUnitId) {
    refs.push({ type: "work_unit", id: run.workUnitId });
  }
  if (approval.taskId) {
    refs.push({ type: "task", id: approval.taskId });
  }
  if (approval.channelId) {
    refs.push({ type: "channel", id: approval.channelId });
  }
  if (approval.mediaJobId) {
    refs.push({ type: "media_job", id: approval.mediaJobId });
  }
  if (approval.externalWorkActionId) {
    refs.push({ type: "external_work_action", id: approval.externalWorkActionId });
  }
  if (approval.workflowStepId) {
    refs.push({ type: "workflow_step", id: approval.workflowStepId });
  }
  if (approval.payload.type === "workflow_step") {
    refs.push({ type: "workflow", id: approval.payload.workflowId });
  }
  if ((approval.payload.type === "file_write" || approval.payload.type === "file_edit") && approval.payload.path) {
    refs.push({ type: "file", path: approval.payload.path, label: approval.payload.path });
  }
  if (approval.payload.type === "bash") {
    refs.push({ type: "command", label: truncateLabel(approval.payload.command) });
  }
  if (approval.payload.type === "mcp_tool_call") {
    refs.push({ type: "mcp_tool", label: approval.payload.toolName });
  }
  return refs;
}

function readRunPolicySnapshot(run: RunSession | undefined): unknown | undefined {
  if (!run || !isRecord(run.requestSnapshot)) {
    return undefined;
  }
  return run.requestSnapshot.effectivePolicySnapshot;
}

function executionActionStatusFromApproval(status: ApprovalStatus): ExecutionActionStatus {
  if (status === "pending") {
    return "waiting_for_approval";
  }
  return status;
}

function approvalStatusFromExecutionActionStatus(status: ExecutionActionStatus): ApprovalStatus | undefined {
  if (status === "waiting_for_approval") {
    return "pending";
  }
  if (status === "approved" || status === "denied" || status === "expired" || status === "cancelled") {
    return status;
  }
  return undefined;
}

function readOptionalExecutionActionStatusQuery(url: URL): ExecutionActionStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!isExecutionActionStatus(value)) {
    throw new Error("status must be one of: proposed, waiting_for_approval, approved, denied, expired, cancelled, executing, succeeded, failed");
  }
  return value;
}

function readOptionalExecutionActionTypeQuery(url: URL): ApprovalActionType | undefined {
  const value = url.searchParams.get("actionType");
  if (value === null) {
    return undefined;
  }
  if (!approvalActionTypes.includes(value as ApprovalActionType)) {
    throw new Error(`actionType must be one of: ${approvalActionTypes.join(", ")}`);
  }
  return value as ApprovalActionType;
}

function isExecutionActionStatus(value: string): value is ExecutionActionStatus {
  return (
    value === "proposed" ||
    value === "waiting_for_approval" ||
    value === "approved" ||
    value === "denied" ||
    value === "expired" ||
    value === "cancelled" ||
    value === "executing" ||
    value === "succeeded" ||
    value === "failed"
  );
}

function truncateLabel(value: string, limit = 120): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}
