import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  approvalActionTypes,
  type ApprovalStoreFacet,
  type ApprovalActionType,
  type ApprovalRequest,
  type ApprovalStatus,
  type ExecutionAction,
  type ExecutionActionStatus,
  type ExecutionActionTargetRef,
  type RunEventEnvelope,
  type RunExecutionStoreFacet,
  type RunSession,
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
import {
  deriveExecutionActionCommandEvidence,
  executionActionStatusFromCommandEvidence,
} from "./execution-action-command-evidence.js";

export interface ListExecutionActionsOptions {
  readonly runId?: string;
  readonly threadId?: string;
  readonly status?: ExecutionActionStatus;
  readonly actionType?: ApprovalActionType;
  readonly limit?: number;
  /**
   * Read the complete durable action history for a specific Run.
   * Canonical evidence projections use this; interactive lists stay bounded.
   */
  readonly complete?: boolean;
}

type ExecutionActionStore = ApprovalStoreFacet & RunExecutionStoreFacet;

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
    const actions = listExecutionActions(store, {
      runId: url.searchParams.get("runId") ?? undefined,
      threadId: url.searchParams.get("threadId") ?? undefined,
      status: readOptionalExecutionActionStatusQuery(url),
      actionType: readOptionalExecutionActionTypeQuery(url),
      limit: readOptionalIntegerQuery(url, "limit", 1),
    });
    writeJson(response, 200, {
      cwd,
      actions,
      revision: executionActionsRevision(actions),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function listExecutionActions(store: ExecutionActionStore, options: ListExecutionActionsOptions = {}): ExecutionAction[] {
  const approvalStatus = options.status ? approvalStatusFromExecutionActionStatus(options.status) : undefined;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const approvals = store.listApprovalRequests({
    runId: options.runId,
    status: approvalStatus,
    ...(options.complete ? { complete: true } : { limit: options.threadId ? 500 : limit }),
  });
  const approvalActions = approvals
    .map((approval) => approvalToExecutionAction(store, approval))
    .filter((action) => !options.threadId || action.threadId === options.threadId)
    .filter((action) => !options.actionType || action.actionType === options.actionType);
  const toolActions = listToolActions(store, options, limit);
  const actions = mergeApprovalToolLifecycles(approvalActions, toolActions);
  const ordered = actions
    .filter((action) => !options.status || action.status === options.status)
    .filter((action) => !options.actionType || action.actionType === options.actionType)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return options.complete ? ordered : ordered.slice(0, limit);
}

/** Read all durable actions for one logical Run for canonical evidence paths. */
export function listAllExecutionActionsForRun(
  store: ExecutionActionStore,
  runId: string,
): ExecutionAction[] {
  return listExecutionActions(store, { runId, complete: true });
}

function approvalToExecutionAction(store: ExecutionActionStore, approval: ApprovalRequest): ExecutionAction {
  const run = approval.runId ? store.getRun(approval.runId) : undefined;
  const attemptId = approval.runId
    ? readRunAttemptId(listAllRunEvents(store, approval.runId))
    : undefined;
  const classified = classifyApprovalAction(approval, run);
  return {
    id: `approval:${approval.id}`,
    workspaceId: DEFAULT_WORKSPACE_ID,
    threadId: run?.threadId,
    runId: approval.runId,
    attemptId,
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
    completedAt: approval.status === "approved" ? undefined : approval.resolvedAt,
  };
}

function listToolActions(
  store: ExecutionActionStore,
  options: ListExecutionActionsOptions,
  limit: number,
): ExecutionAction[] {
  const runs = collectRunsForActionReadModel(store, options, limit);
  return runs.flatMap((run) => deriveToolActionsForRun(store, run));
}

function collectRunsForActionReadModel(store: ExecutionActionStore, options: ListExecutionActionsOptions, limit: number): RunSession[] {
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
  store: ExecutionActionStore,
  run: RunSession,
): ExecutionAction[] {
  const events = listAllRunEvents(store, run.id);
  const runAttemptId = readRunAttemptId(events);
  const starts = new Map<string, RunEventEnvelope>();
  const ends = new Map<string, RunEventEnvelope>();
  for (const event of events) {
    const toolCallId = readToolCallId(event);
    if (!toolCallId) {
      continue;
    }
    if (event.type === "tool_start") {
      setLatestToolEvent(starts, toolCallId, event);
    } else if (event.type === "tool_end") {
      setLatestToolEvent(ends, toolCallId, event);
    }
  }

  const toolCallIds = new Set([...starts.keys(), ...ends.keys()]);
  const actions: ExecutionAction[] = [];
  for (const toolCallId of toolCallIds) {
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
      result: readToolResult(end),
      isError: readToolEndIsError(end),
    });
    const commandEvidence = toolName === "bash"
      ? deriveExecutionActionCommandEvidence({ events, toolCallId, start, end })
      : undefined;
    const commandStatus = executionActionStatusFromCommandEvidence(commandEvidence);
    const latestToolEvent = findLatestToolEvent(events, toolCallId);
    const attemptId = readToolAttemptId(events, toolCallId) ?? runAttemptId;
    actions.push({
      id: `tool:${run.id}:${toolCallId}`,
      workspaceId: DEFAULT_WORKSPACE_ID,
      threadId: run.threadId,
      runId: run.id,
      attemptId,
      workUnitId: run.workUnitId,
      toolCallId,
      actionType: classified.actionType,
      risk: classified.risk,
      status: commandStatus ?? fallbackToolActionStatus(run, end),
      title: classified.title,
      summary: classified.summary,
      targetRefs: classified.targetRefs,
      previewArtifactIds: [],
      resultArtifactIds: artifactIdsForToolCall(events, toolCallId),
      scopes: classified.scopes,
      scopeSummary: classified.scopeSummary,
      policySnapshot: readRunPolicySnapshot(run),
      commandEvidence,
      createdAt: start?.ts ?? end?.ts ?? run.createdAt,
      updatedAt: latestToolEvent?.ts ?? start?.ts ?? end?.ts ?? run.updatedAt,
      executedAt: start?.ts,
      completedAt: end?.ts,
    });
  }
  return actions;
}

function mergeApprovalToolLifecycles(
  approvalActions: readonly ExecutionAction[],
  toolActions: readonly ExecutionAction[],
): ExecutionAction[] {
  const toolActionsByCorrelationKey = new Map<string, ExecutionAction>();
  for (const toolAction of toolActions) {
    const correlationKey = executionActionToolCorrelationKey(toolAction);
    if (correlationKey) {
      toolActionsByCorrelationKey.set(correlationKey, toolAction);
    }
  }
  const approvalToolCorrelationKeys = new Set<string>();
  const mergedApprovals = approvalActions.map((approvalAction) => {
    const correlationKey = executionActionToolCorrelationKey(approvalAction);
    if (!correlationKey) return approvalAction;
    approvalToolCorrelationKeys.add(correlationKey);
    const toolAction = toolActionsByCorrelationKey.get(correlationKey);
    if (!toolAction) return approvalAction;
    const executionStarted = approvalAction.status === "approved";
    return {
      ...approvalAction,
      ...(executionStarted && toolAction.attemptId
        ? { attemptId: toolAction.attemptId }
        : {}),
      status: executionStarted ? toolAction.status : approvalAction.status,
      targetRefs: mergeTargetRefs(approvalAction.targetRefs, toolAction.targetRefs),
      ...(toolAction.commandEvidence ? { commandEvidence: toolAction.commandEvidence } : {}),
      createdAt: earliestTimestamp(approvalAction.createdAt, toolAction.createdAt),
      updatedAt: latestTimestamp(
        approvalAction.updatedAt,
        approvalAction.resolvedAt,
        toolAction.updatedAt,
        toolAction.executedAt,
        toolAction.completedAt,
      ),
      ...(executionStarted && toolAction.executedAt ? { executedAt: toolAction.executedAt } : {}),
      completedAt: executionStarted ? toolAction.completedAt : approvalAction.completedAt,
    } satisfies ExecutionAction;
  });
  return [
    ...mergedApprovals.map(failClosedUnverifiedMutation),
    ...toolActions.filter((action) => {
      const correlationKey = executionActionToolCorrelationKey(action);
      return !correlationKey || !approvalToolCorrelationKeys.has(correlationKey);
    }).map(failClosedUnverifiedMutation),
  ];
}

function failClosedUnverifiedMutation(action: ExecutionAction): ExecutionAction {
  if ((action.actionType !== "write" && action.actionType !== "edit") || action.status !== "succeeded") {
    return action;
  }
  const hasFileTarget = action.targetRefs.some((ref) =>
    ref.type === "file" && typeof ref.path === "string" && ref.path.trim().length > 0);
  return action.executedAt && hasFileTarget ? action : { ...action, status: "failed" };
}

function executionActionToolCorrelationKey(action: ExecutionAction): string | undefined {
  return action.runId && action.toolCallId
    ? JSON.stringify([action.runId, action.toolCallId])
    : undefined;
}

function earliestTimestamp(left: string, right: string): string {
  return left < right ? left : right;
}

function latestTimestamp(...values: readonly (string | undefined)[]): string | undefined {
  return values.reduce<string | undefined>((latest, value) => {
    if (!value) return latest;
    return !latest || value > latest ? value : latest;
  }, undefined);
}

function listAllRunEvents(store: ExecutionActionStore, runId: string): RunEventEnvelope[] {
  const events: RunEventEnvelope[] = [];
  let afterSeq = 0;
  while (true) {
    const page = store.listEvents(runId, { afterSeq, limit: 1000 });
    events.push(...page);
    const latestSeq = page.at(-1)?.seq;
    if (page.length < 1000 || latestSeq === undefined || latestSeq <= afterSeq) {
      return events;
    }
    afterSeq = latestSeq;
  }
}

function fallbackToolActionStatus(
  run: RunSession,
  end: RunEventEnvelope | undefined,
): ExecutionAction["status"] {
  if (end) {
    return readToolEndIsError(end) ? "failed" : "succeeded";
  }
  if (run.status === "cancelled") {
    return "cancelled";
  }
  if (run.status === "failed") {
    return "failed";
  }
  return "executing";
}

function executionActionsRevision(actions: readonly ExecutionAction[]): string {
  return actions
    .map((action) => `${action.id}:${action.commandEvidence?.latestEventSeq ?? 0}:${action.updatedAt ?? action.completedAt ?? action.createdAt}`)
    .sort()
    .join("|");
}

function findLatestToolEvent(
  events: readonly RunEventEnvelope[],
  toolCallId: string,
): RunEventEnvelope | undefined {
  return events.reduce<RunEventEnvelope | undefined>((latest, event) => {
    if (readToolCallId(event) !== toolCallId) {
      return latest;
    }
    return !latest || event.seq > latest.seq ? event : latest;
  }, undefined);
}

function setLatestToolEvent(
  eventsByToolCallId: Map<string, RunEventEnvelope>,
  toolCallId: string,
  event: RunEventEnvelope,
): void {
  const current = eventsByToolCallId.get(toolCallId);
  if (!current || event.seq > current.seq) {
    eventsByToolCallId.set(toolCallId, event);
  }
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
  if (approval.payload.type === "file_write" || approval.payload.type === "file_edit") {
    const paths = approval.payload.touchedPaths && approval.payload.touchedPaths.length > 0
      ? approval.payload.touchedPaths
      : [approval.payload.path];
    for (const path of paths) {
      if (path.trim() && path !== "<unknown>") {
        refs.push({ type: "file", path, label: path });
      }
    }
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

function readToolAttemptId(events: readonly RunEventEnvelope[], toolCallId: string): string | undefined {
  for (const event of [...events].sort((left, right) => right.seq - left.seq)) {
    if (readToolCallId(event) !== toolCallId || !isRecord(event.data)) {
      continue;
    }
    if (typeof event.data.attemptId === "string" && event.data.attemptId.trim()) {
      return event.data.attemptId;
    }
  }
  return undefined;
}

function readRunAttemptId(events: readonly RunEventEnvelope[]): string | undefined {
  const created = events
    .filter((event) => event.type === "run_created" && isRecord(event.data))
    .sort((left, right) => right.seq - left.seq)[0];
  if (!created || !isRecord(created.data)) {
    return undefined;
  }
  return typeof created.data.attemptId === "string" && created.data.attemptId.trim()
    ? created.data.attemptId
    : undefined;
}

function readToolName(event: RunEventEnvelope): string | undefined {
  return isRecord(event.data) && typeof event.data.toolName === "string" ? event.data.toolName : undefined;
}

function readToolArgs(event: RunEventEnvelope | undefined): unknown {
  return event && isRecord(event.data) ? event.data.args : undefined;
}

function readToolResult(event: RunEventEnvelope | undefined): unknown {
  return event && isRecord(event.data) ? event.data.result : undefined;
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
