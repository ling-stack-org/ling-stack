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
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import {
  previewArtifactIdsForApproval,
  resultArtifactIdsForApproval,
} from "./action-artifacts.js";
import {
  artifactIdsForToolCall,
  classifyApprovalAction,
  classifyToolAction,
} from "./action-classifier.js";
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
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const approvals = store.listApprovalRequests({
    runId: options.runId,
    status: approvalStatus,
    limit: options.threadId ? 500 : limit,
  });
  const approvalActions = approvals
    .map((approval) => approvalToExecutionAction(store, approval))
    .filter((action) => !options.threadId || action.threadId === options.threadId)
    .filter((action) => !options.actionType || action.actionType === options.actionType);
  const nonApprovalActions = options.status && approvalStatus
    ? []
    : listNonApprovalToolActions(store, options, limit, approvalActions);
  return [...approvalActions, ...nonApprovalActions]
    .filter((action) => !options.status || action.status === options.status)
    .filter((action) => !options.actionType || action.actionType === options.actionType)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

function approvalToExecutionAction(store: RunStore, approval: ApprovalRequest): ExecutionAction {
  const run = approval.runId ? store.getRun(approval.runId) : undefined;
  const classified = classifyApprovalAction(approval, run);
  return {
    id: `approval:${approval.id}`,
    workspaceId: DEFAULT_WORKSPACE_ID,
    threadId: run?.threadId,
    runId: approval.runId,
    workUnitId: run?.workUnitId,
    approvalId: approval.id,
    toolCallId: approval.toolCallId,
    actionType: classified.actionType,
    risk: classified.risk,
    status: executionActionStatusFromApproval(approval.status),
    title: classified.title,
    summary: classified.summary,
    targetRefs: mergeTargetRefs(buildApprovalTargetRefs(approval, run), classified.targetRefs),
    previewArtifactIds: previewArtifactIdsForApproval(store, approval),
    resultArtifactIds: resultArtifactIdsForApproval(store, approval),
    scopes: classified.scopes,
    scopeSummary: classified.scopeSummary,
    policySnapshot: readRunPolicySnapshot(run),
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt,
    completedAt: approval.resolvedAt,
  };
}

function listNonApprovalToolActions(
  store: RunStore,
  options: ListExecutionActionsOptions,
  limit: number,
  approvalActions: readonly ExecutionAction[],
): ExecutionAction[] {
  const runs = collectRunsForActionReadModel(store, options, limit);
  const approvalToolCallIds = new Set(approvalActions.map((action) => action.toolCallId).filter((id): id is string => Boolean(id)));
  return runs.flatMap((run) => deriveToolActionsForRun(store, run, approvalToolCallIds));
}

function collectRunsForActionReadModel(store: RunStore, options: ListExecutionActionsOptions, limit: number): RunSession[] {
  if (options.runId) {
    const run = store.getRun(options.runId);
    return run ? [run] : [];
  }
  if (options.threadId) {
    return store
      .listRuns({ limit: 500 })
      .filter((run) => run.threadId === options.threadId);
  }
  return store.listRuns({ limit });
}

function deriveToolActionsForRun(
  store: RunStore,
  run: RunSession,
  approvalToolCallIds: ReadonlySet<string>,
): ExecutionAction[] {
  const events = store.listEvents(run.id, { limit: 1000 });
  const starts = new Map<string, RunEventEnvelope>();
  const ends = new Map<string, RunEventEnvelope>();
  for (const event of events) {
    const toolCallId = readToolCallId(event);
    if (!toolCallId) {
      continue;
    }
    if (event.type === "tool_start") {
      starts.set(toolCallId, event);
    } else if (event.type === "tool_end") {
      ends.set(toolCallId, event);
    }
  }

  const toolCallIds = new Set([...starts.keys(), ...ends.keys()]);
  const actions: ExecutionAction[] = [];
  for (const toolCallId of toolCallIds) {
    if (approvalToolCallIds.has(toolCallId)) {
      continue;
    }
    const start = starts.get(toolCallId);
    const end = ends.get(toolCallId);
    const source = start ?? end;
    if (!source) {
      continue;
    }
    const toolName = readToolName(source);
    if (!toolName) {
      continue;
    }
    const classified = classifyToolAction({
      run,
      toolName,
      toolCallId,
      args: readToolArgs(start),
      isError: readToolEndIsError(end),
    });
    actions.push({
      id: `tool:${run.id}:${toolCallId}`,
      workspaceId: DEFAULT_WORKSPACE_ID,
      threadId: run.threadId,
      runId: run.id,
      workUnitId: run.workUnitId,
      toolCallId,
      actionType: classified.actionType,
      risk: classified.risk,
      status: end ? readToolEndIsError(end) ? "failed" : "succeeded" : "executing",
      title: classified.title,
      summary: classified.summary,
      targetRefs: classified.targetRefs,
      previewArtifactIds: [],
      resultArtifactIds: artifactIdsForToolCall(events, toolCallId),
      scopes: classified.scopes,
      scopeSummary: classified.scopeSummary,
      policySnapshot: readRunPolicySnapshot(run),
      createdAt: start?.ts ?? end?.ts ?? run.createdAt,
      executedAt: start?.ts,
      completedAt: end?.ts,
    });
  }
  return actions;
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

function readToolCallId(event: RunEventEnvelope): string | undefined {
  return isRecord(event.data) && typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
}

function readToolName(event: RunEventEnvelope): string | undefined {
  return isRecord(event.data) && typeof event.data.toolName === "string" ? event.data.toolName : undefined;
}

function readToolArgs(event: RunEventEnvelope | undefined): unknown {
  return event && isRecord(event.data) ? event.data.args : undefined;
}

function readToolEndIsError(event: RunEventEnvelope | undefined): boolean {
  return Boolean(event && isRecord(event.data) && event.data.isError === true);
}

function mergeTargetRefs(left: readonly ExecutionActionTargetRef[], right: readonly ExecutionActionTargetRef[]): ExecutionActionTargetRef[] {
  const seen = new Set<string>();
  const refs: ExecutionActionTargetRef[] = [];
  for (const ref of [...left, ...right]) {
    const key = `${ref.type}:${ref.id ?? ""}:${ref.path ?? ""}:${ref.label ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push(ref);
  }
  return refs;
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
