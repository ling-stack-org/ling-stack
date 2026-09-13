import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  LING_AGENT_ID,
  approvalActionTypes,
  type ApprovalStoreFacet,
  type ApprovalRequest,
  type ApprovalStatus,
  type ExecutionAction,
  type ExecutionActionType,
  type ExecutionActionSourceRef,
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
import { deriveExecutionActionToolEvidence } from "./execution-action-tool-evidence.js";
import {
  deriveHarnessToolExecutionActionProjection,
  listHarnessToolExecutionsForProjection,
} from "./harness-tool-execution-projection.js";
import { deriveHostOpenReceipt, type HostOpenEvidenceStore } from "./host-open-evidence.js";

export interface ListExecutionActionsOptions {
  readonly runId?: string;
  readonly threadId?: string;
  readonly status?: ExecutionActionStatus;
  readonly actionType?: ExecutionActionType;
  readonly limit?: number;
  /**
   * Read the complete durable action history for a specific Run.
   * Canonical evidence projections use this; interactive lists stay bounded.
   */
  readonly complete?: boolean;
}

type ExecutionActionStore = ApprovalStoreFacet & RunExecutionStoreFacet & HostOpenEvidenceStore;

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
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const approvals = store.listApprovalRequests({
    runId: options.runId,
    ...(options.complete ? { complete: true } : { limit: options.threadId ? 500 : limit }),
  });
  const approvalActions = approvals
    .map((approval) => approvalToExecutionAction(store, approval))
    .filter((action) => !options.threadId || action.threadId === options.threadId);
  const toolActions = listToolActions(store, options, limit);
  const runtimeDiagnosticActions = listRuntimeDiagnosticActions(store, options, limit);
  const actions = [...mergeApprovalToolLifecycles(store, approvalActions, toolActions), ...runtimeDiagnosticActions];
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
  return withExecutionActionLineage(store, {
    id: `approval:${approval.id}`,
    revision: approvalRevision(approval),
    workspaceId: DEFAULT_WORKSPACE_ID,
    threadId: run?.threadId,
    runId: approval.runId,
    attemptId,
    workUnitId: run?.workUnitId,
    participantId: run?.teammateId ?? LING_AGENT_ID,
    workflowStepId: approval.workflowStepId ?? run?.workflowStepId,
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
    updatedAt: approval.resolvedAt ?? approval.createdAt,
    resolvedAt: approval.resolvedAt,
    completedAt: approval.status === "approved" || approval.status === "pending" ? undefined : approval.resolvedAt,
    sourceRefs: [],
  });
}

function listToolActions(
  store: ExecutionActionStore,
  options: ListExecutionActionsOptions,
  limit: number,
): ExecutionAction[] {
  const runs = collectRunsForActionReadModel(store, options, limit);
  return runs.flatMap((run) => deriveToolActionsForRun(store, run));
}

function listRuntimeDiagnosticActions(
  store: ExecutionActionStore,
  options: ListExecutionActionsOptions,
  limit: number,
): ExecutionAction[] {
  const runs = collectRunsForActionReadModel(store, options, limit);
  return runs.flatMap((run) => listAllRunEvents(store, run.id)
    .filter((event) => event.type === "loop_detected")
    .flatMap((event) => {
      if (!isRecord(event.data)
        || event.data.code !== "execution_loop_detected"
        || typeof event.data.attemptId !== "string"
        || typeof event.data.loopKind !== "string"
        || typeof event.data.repeatedCount !== "number"
        || typeof event.data.noProgressActionCount !== "number"
        || typeof event.data.fingerprint !== "string") return [];
      return [withExecutionActionLineage(store, {
        id: `runtime-diagnostic:${run.id}:${event.data.attemptId}:${event.id}`,
        revision: event.seq,
        sourceEventSequence: event.seq,
        workspaceId: DEFAULT_WORKSPACE_ID,
        threadId: run.threadId,
        runId: run.id,
        attemptId: event.data.attemptId,
        workUnitId: run.workUnitId,
        participantId: run.teammateId ?? LING_AGENT_ID,
        workflowStepId: run.workflowStepId,
        actionType: "runtime_diagnostic",
        risk: "low",
        status: "failed",
        title: "Repeated execution stopped",
        summary: typeof event.data.message === "string" ? event.data.message : "Execution stopped after repeated activity produced no new evidence.",
        targetRefs: [
          { type: "run", id: run.id },
          ...(run.workUnitId ? [{ type: "work_unit" as const, id: run.workUnitId }] : []),
          ...(run.workflowStepId ? [{ type: "workflow_step" as const, id: run.workflowStepId }] : []),
        ],
        previewArtifactIds: [],
        resultArtifactIds: [],
        runtimeDiagnostic: {
          code: "execution_loop_detected",
          loopKind: event.data.loopKind as NonNullable<ExecutionAction["runtimeDiagnostic"]>["loopKind"],
          repeatedCount: event.data.repeatedCount,
          noProgressActionCount: event.data.noProgressActionCount,
          ...(typeof event.data.cycleLength === "number" ? { cycleLength: event.data.cycleLength } : {}),
          fingerprint: event.data.fingerprint,
          retryable: false,
        },
        createdAt: event.ts,
        updatedAt: event.ts,
        completedAt: event.ts,
        sourceRefs: [{ kind: "run_event", id: event.id, label: event.type }],
      })];
    }));
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
  const harnessExecutions = listHarnessToolExecutionsForProjection(store, run.id);
  const runAttemptId = readRunAttemptId(events);
  const starts = new Map<string, RunEventEnvelope>();
  const ends = new Map<string, RunEventEnvelope>();
  for (const event of events) {
    const toolCallId = readToolCallId(event);
    if (!toolCallId) {
      continue;
    }
    if (event.type === "tool_start") {
      setFirstToolEvent(starts, toolCallId, event);
    } else if (event.type === "tool_end") {
      setFirstToolEvent(ends, toolCallId, event);
    }
  }

  const toolCallIds = new Set([
    ...starts.keys(),
    ...ends.keys(),
    ...harnessExecutions.map((execution) => execution.toolCallId),
  ]);
  const actions: ExecutionAction[] = [];
  for (const toolCallId of toolCallIds) {
    const start = starts.get(toolCallId);
    const endCandidate = ends.get(toolCallId);
    // A terminal event that precedes the accepted start is stale evidence. It
    // remains available to diagnostics, but cannot close the logical action.
    const end = start
      ? firstToolEndAfterStart(events, toolCallId, start.seq)
      : endCandidate;
    const source = start ?? end;
    const eventAttemptId = readToolAttemptId(events, toolCallId) ?? runAttemptId;
    const harnessProjection = deriveHarnessToolExecutionActionProjection({
      store,
      runId: run.id,
      toolCallId,
      attemptId: eventAttemptId,
    });
    const toolName = (source ? readToolName(source) : undefined) ?? harnessProjection?.execution.toolName;
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
    const toolEvidence = deriveExecutionActionToolEvidence({ events, toolName, toolCallId, cwd: run.cwd, start, end });
    const hostOpenReceipt = toolName === "host_open_local_target" ? deriveHostOpenReceipt({ store, run, start, end }) : undefined;
    // A queued request or "opened" text is not a completed Host launch.
    const hostOpenStatus = toolName === "host_open_local_target" && end ? (hostOpenReceipt ? "succeeded" : "failed") : undefined;
    const lifecycleSourceRefs = sourceRefsForToolLifecycle(events, toolCallId, start, end);
    const lifecycleDiagnostics = diagnosticsForToolLifecycle(events, toolCallId, start, end);
    const commandStatus = executionActionStatusFromCommandEvidence(commandEvidence);
    const latestToolEvent = findLatestAcceptedToolEvent(events, toolCallId, start, end);
    // A terminal Host receipt is pinned to the accepted start/end identity.
    // Diagnostic updates after that fence cannot reassign its historical owner.
    const attemptId = harnessProjection?.execution.attemptId ?? hostOpenReceipt?.attemptId ?? eventAttemptId;
    actions.push(withExecutionActionLineage(store, {
      id: `tool:${run.id}:${toolCallId}`,
      revision: (latestToolEvent?.seq ?? 0) + (harnessProjection?.execution.revision ?? 0),
      ...(source ? { sourceEventSequence: source.seq } : {}),
      workspaceId: DEFAULT_WORKSPACE_ID,
      threadId: run.threadId,
      runId: run.id,
      attemptId,
      workUnitId: run.workUnitId,
      participantId: run.teammateId ?? LING_AGENT_ID,
      workflowStepId: run.workflowStepId ?? classified.targetRefs.find((ref) => ref.type === "workflow_step")?.id,
      approvalId: harnessProjection?.execution.approvalId,
      toolCallId,
      actionType: classified.actionType,
      risk: classified.risk,
      status: harnessProjection?.status ?? hostOpenStatus ?? commandStatus ?? fallbackToolActionStatus(run, end),
      title: classified.title,
      summary: harnessProjection?.summary ?? classified.summary,
      targetRefs: classified.targetRefs,
      previewArtifactIds: [],
      resultArtifactIds: uniqueIds([
        ...artifactIdsForToolCall(events, toolCallId),
        ...(harnessProjection?.resultArtifactIds ?? []),
      ]),
      scopes: classified.scopes,
      scopeSummary: classified.scopeSummary,
      policySnapshot: readRunPolicySnapshot(run),
      commandEvidence,
      toolEvidence,
      ...(hostOpenReceipt ? { hostOpenReceipt } : {}),
      createdAt: [start?.ts, end?.ts, harnessProjection?.execution.createdAt, run.createdAt]
        .filter((value): value is string => Boolean(value)).sort()[0]!,
      updatedAt: latestTimestamp(
        latestToolEvent?.ts,
        start?.ts,
        end?.ts,
        harnessProjection?.execution.updatedAt,
        run.updatedAt,
      ),
      executedAt: harnessProjection?.execution.executionStartedAt ?? start?.ts,
      completedAt: harnessProjection?.execution.executionFinishedAt ?? end?.ts,
      // Keep every accepted lifecycle event reachable from the action. The
      // first durable tool_end is the terminal fence; later updates/duplicate
      // ends are stale diagnostics and must not become evidence for this row.
      sourceRefs: [...lifecycleSourceRefs, ...(harnessProjection?.sourceRefs ?? [])],
      ...(lifecycleDiagnostics.length > 0 ? { diagnostics: lifecycleDiagnostics } : {}),
    }));
  }
  return actions;
}

function mergeApprovalToolLifecycles(
  store: ExecutionActionStore,
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
    return failClosedUnverifiedMutation(withExecutionActionLineage(store, {
      ...approvalAction,
      ...(executionStarted && toolAction.attemptId ? { attemptId: toolAction.attemptId } : {}),
      ...(toolAction.sourceEventSequence !== undefined
        ? { sourceEventSequence: toolAction.sourceEventSequence }
        : {}),
      status: executionStarted ? toolAction.status : approvalAction.status,
      targetRefs: mergeTargetRefs(approvalAction.targetRefs, toolAction.targetRefs),
      previewArtifactIds: uniqueIds([...approvalAction.previewArtifactIds, ...toolAction.previewArtifactIds]),
      resultArtifactIds: uniqueIds([...approvalAction.resultArtifactIds, ...toolAction.resultArtifactIds]),
      ...(toolAction.commandEvidence ? { commandEvidence: toolAction.commandEvidence } : {}),
      ...(toolAction.toolEvidence ? { toolEvidence: toolAction.toolEvidence } : {}),
      ...(toolAction.hostOpenReceipt ? { hostOpenReceipt: toolAction.hostOpenReceipt } : {}),
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
      // Approval state and tool events advance in different revision domains.
      // Addition preserves a monotonic logical action revision without letting
      // a timestamp-based approval revision hide later tool updates.
      revision: approvalAction.revision + toolAction.revision,
      sourceRefs: [...approvalAction.sourceRefs, ...toolAction.sourceRefs],
      diagnostics: [...(approvalAction.diagnostics ?? []), ...(toolAction.diagnostics ?? [])],
    } satisfies ExecutionAction));
  });
  return [
    ...mergedApprovals.map(failClosedUnverifiedMutation),
    ...toolActions
      .filter((action) => {
        const correlationKey = executionActionToolCorrelationKey(action);
        return !correlationKey || !approvalToolCorrelationKeys.has(correlationKey);
      })
      .map(failClosedUnverifiedMutation),
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

function withExecutionActionLineage(store: ExecutionActionStore, action: ExecutionAction): ExecutionAction {
  const refs: ExecutionActionSourceRef[] = [
    { kind: "execution_action", id: action.id },
  ];
  if (action.runId) refs.push({ kind: "run", id: action.runId });
  if (action.workUnitId) refs.push({ kind: "work_unit", id: action.workUnitId });
  if (action.attemptId) refs.push({ kind: "attempt", id: action.attemptId });
  if (action.participantId) refs.push({ kind: "participant", id: action.participantId });
  if (action.workflowStepId) refs.push({ kind: "workflow_step", id: action.workflowStepId });
  if (action.approvalId) refs.push({ kind: "approval", id: action.approvalId });
  if (action.toolCallId) refs.push({ kind: "tool_call", id: action.toolCallId });
  for (const artifactId of [...action.previewArtifactIds, ...action.resultArtifactIds]) {
    if (artifactId.trim()) refs.push({ kind: "artifact", id: artifactId });
  }
  for (const target of action.targetRefs) {
    const id = target.path ?? target.id ?? target.label;
    if (!id || target.type === "run" || target.type === "work_unit" || target.type === "workflow_step") {
      continue;
    }
    refs.push({
      kind: target.type,
      id,
      ...(target.label ? { label: target.label } : {}),
      ...(target.path ? { path: target.path } : {}),
    });
  }
  // `sourceRefs` may contain accepted run-event ids or upstream approval
  // records. Keep them after stable derived refs so existing consumers retain
  // their deterministic prefix, while the full evidence lineage remains
  // inspectable from the same action.
  refs.push(...action.sourceRefs);
  refs.push(...conversationItemAnchorRefs(store, action));
  return { ...action, sourceRefs: uniqueExecutionActionSourceRefs(refs) };
}

interface ConversationAnchorStore {
  readonly getLingTurnForRun?: (runId: string) => {
    readonly id: string;
    readonly threadId: string;
    readonly sourceItemId?: string;
  } | undefined;
  readonly getConversationItem?: (itemId: string) => ConversationAnchorItem | undefined;
  readonly listConversationItemsForTurn?: (options: { readonly turnId: string }) => readonly ConversationAnchorItem[];
  readonly getChannelWorkflowStep?: (workflowStepId: string) => {
    readonly metadata?: { readonly sourceMessageId?: string };
    readonly workflowId?: string;
  } | undefined;
  readonly getChannelWorkflow?: (workflowId: string) => {
    readonly metadata?: { readonly sourceMessageId?: string };
  } | undefined;
}

interface ConversationAnchorItem {
  readonly id: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly kind: string;
  readonly sequence: number;
  readonly domainRefs?: readonly { readonly type: string; readonly id: string }[];
}

/**
 * Resolve the owning ConversationItem without manufacturing one in the read
 * model. The optional structural methods keep narrow unit-test stores useful;
 * a real SQLite RunStore implements all three methods.
 */
function conversationItemAnchorRefs(
  store: ExecutionActionStore,
  action: ExecutionAction,
): ExecutionActionSourceRef[] {
  if (!action.runId || !action.threadId) return [];
  const anchorStore = store as ExecutionActionStore & ConversationAnchorStore;
  const turn = anchorStore.getLingTurnForRun?.(action.runId);
  if (!turn || turn.threadId !== action.threadId) return [];

  // Workflow-step runs intentionally live in their own LingThread, while the
  // user-visible channel message lives in the channel root thread. The
  // workflow/step metadata carries that root message id; use it as the
  // authoritative cross-thread anchor for action evidence. This also repairs
  // already-persisted runs whose child turn was created without sourceItemId.
  const workflowStep = action.workflowStepId
    ? anchorStore.getChannelWorkflowStep?.(action.workflowStepId)
    : undefined;
  const sourceItemId = turn.sourceItemId ??
    workflowStep?.metadata?.sourceMessageId ??
    (workflowStep?.workflowId ? anchorStore.getChannelWorkflow?.(workflowStep.workflowId)?.metadata?.sourceMessageId : undefined);
  if (sourceItemId) {
    const source = anchorStore.getConversationItem?.(sourceItemId);
    if (source && Number.isSafeInteger(source.sequence) && source.sequence >= 0) {
      return [{
        kind: "conversation_item",
        id: source.id,
        label: `sequence:${source.sequence}`,
      }];
    }
  }

  const candidates: ConversationAnchorItem[] = [];
  if (turn.sourceItemId) {
    const source = anchorStore.getConversationItem?.(turn.sourceItemId);
    if (source) candidates.push(source);
  }
  if (anchorStore.listConversationItemsForTurn) {
    candidates.push(...anchorStore.listConversationItemsForTurn({ turnId: turn.id }));
  }
  const item = candidates.find((candidate) =>
    candidate.threadId === action.threadId &&
    candidate.turnId === turn.id &&
    candidate.domainRefs?.some((ref) => ref.type === "run" && ref.id === action.runId),
  ) ?? candidates.find((candidate) =>
    candidate.threadId === action.threadId && candidate.turnId === turn.id,
  );
  if (!item || !Number.isSafeInteger(item.sequence) || item.sequence < 0) return [];
  return [{
    kind: "conversation_item",
    id: item.id,
    label: `sequence:${item.sequence}`,
  }];
}

function uniqueExecutionActionSourceRefs(refs: readonly ExecutionActionSourceRef[]): ExecutionActionSourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function approvalRevision(approval: ApprovalRequest): number {
  const timestamp = Date.parse(approval.resolvedAt ?? approval.createdAt);
  const safeTimestamp = Number.isFinite(timestamp) ? Math.max(0, timestamp) : 0;
  const statusRank: Record<ApprovalStatus, number> = {
    pending: 0,
    approved: 1,
    denied: 2,
    expired: 3,
    cancelled: 4,
  };
  return (safeTimestamp * 8) + statusRank[approval.status];
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

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
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
    .map((action) => `${action.id}:${action.revision}:${action.updatedAt ?? action.completedAt ?? action.createdAt}`)
    .sort()
    .join("|");
}

function findLatestAcceptedToolEvent(
  events: readonly RunEventEnvelope[],
  toolCallId: string,
  startEvent: RunEventEnvelope | undefined,
  terminalEvent: RunEventEnvelope | undefined,
): RunEventEnvelope | undefined {
  return events.reduce<RunEventEnvelope | undefined>((latest, event) => {
    if (
      readToolCallId(event) !== toolCallId ||
      (startEvent && event.seq < startEvent.seq) ||
      (terminalEvent && event.seq > terminalEvent.seq)
    ) {
      return latest;
    }
    return !latest || event.seq > latest.seq ? event : latest;
  }, undefined);
}

/**
 * Return the durable lifecycle events accepted by one logical tool action.
 * Events are ordered by their persisted sequence rather than transport order.
 * Once the first tool_end is seen, later updates and duplicate terminal events
 * are intentionally excluded so replay/reconnect cannot reopen a terminal row.
 */
function sourceRefsForToolLifecycle(
  events: readonly RunEventEnvelope[],
  toolCallId: string,
  startEvent: RunEventEnvelope | undefined,
  terminalEvent: RunEventEnvelope | undefined,
): ExecutionActionSourceRef[] {
  const firstStartSeq = startEvent?.seq ?? Number.NEGATIVE_INFINITY;
  const firstTerminalSeq = terminalEvent?.seq ?? Number.POSITIVE_INFINITY;
  const accepted = events
    .filter((event) => {
      if (readToolCallId(event) !== toolCallId) return false;
      if (event.type !== "tool_start" && event.type !== "tool_update" && event.type !== "tool_end") return false;
      // Only the selected lifecycle boundary is accepted into lineage. A
      // duplicate start/end is still retained by diagnostics, but must not
      // make an action appear to have two accepted owners after replay.
      if (event.type === "tool_start" && event.id !== startEvent?.id) return false;
      if (event.type === "tool_end" && event.id !== terminalEvent?.id) return false;
      return event.seq >= firstStartSeq && event.seq <= firstTerminalSeq;
    })
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  let terminalIncluded = false;
  const refs: ExecutionActionSourceRef[] = [];
  for (const event of accepted) {
    if (event.type === "tool_end") {
      if (terminalIncluded) continue;
      terminalIncluded = true;
    }
    refs.push({ kind: "run_event", id: event.id, label: event.type });
  }
  return refs;
}

function firstToolEndAfterStart(
  events: readonly RunEventEnvelope[],
  toolCallId: string,
  startSeq: number,
): RunEventEnvelope | undefined {
  return events.reduce<RunEventEnvelope | undefined>((first, event) => {
    if (event.type !== "tool_end" || readToolCallId(event) !== toolCallId || event.seq < startSeq) {
      return first;
    }
    return !first || event.seq < first.seq || (event.seq === first.seq && event.id.localeCompare(first.id) < 0)
      ? event
      : first;
  }, undefined);
}

/** Keep rejected lifecycle events auditable without allowing them to mutate state. */
function diagnosticsForToolLifecycle(
  events: readonly RunEventEnvelope[],
  toolCallId: string,
  start: RunEventEnvelope | undefined,
  terminalEvent: RunEventEnvelope | undefined,
): Array<{ readonly code: "late_event" | "stale_event" | "source_conflict"; readonly message: string; readonly sourceRefs: ExecutionActionSourceRef[] }> {
  const firstStartSeq = start?.seq ?? Number.NEGATIVE_INFINITY;
  const firstTerminalSeq = terminalEvent?.seq ?? Number.POSITIVE_INFINITY;
  const lifecycle = events
    .filter((event) =>
      readToolCallId(event) === toolCallId &&
      (event.type === "tool_start" || event.type === "tool_update" || event.type === "tool_end"),
    )
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const diagnostics: Array<{ readonly code: "late_event" | "stale_event" | "source_conflict"; readonly message: string; readonly sourceRefs: ExecutionActionSourceRef[] }> = [];
  let terminalSeen = false;
  for (const event of lifecycle) {
    const eventRef = { kind: "run_event", id: event.id, label: event.type };
    if (event.type === "tool_start") {
      if (start && event.id !== start.id) {
        diagnostics.push({ code: event.seq < firstStartSeq ? "stale_event" : "source_conflict", message: "Duplicate tool_start was not selected for this action.", sourceRefs: [eventRef] });
      }
      continue;
    }
    if (event.type === "tool_update") {
      if (event.seq < firstStartSeq) {
        diagnostics.push({ code: "stale_event", message: "tool_update arrived before the accepted tool_start.", sourceRefs: [eventRef] });
      } else if (event.seq > firstTerminalSeq || terminalSeen) {
        diagnostics.push({ code: "late_event", message: "tool_update arrived after the terminal tool_end.", sourceRefs: [eventRef] });
      }
      continue;
    }
    if (event.seq < firstStartSeq) {
      diagnostics.push({ code: "stale_event", message: "tool_end arrived before the accepted tool_start.", sourceRefs: [eventRef] });
    } else if (event.id !== terminalEvent?.id || terminalSeen) {
      diagnostics.push({ code: event.seq === firstTerminalSeq ? "source_conflict" : "late_event", message: "A duplicate or late tool_end was not selected for this action.", sourceRefs: [eventRef] });
    }
    if (event.id === terminalEvent?.id && event.seq === firstTerminalSeq) terminalSeen = true;
  }
  return diagnostics;
}

function setFirstToolEvent(
  eventsByToolCallId: Map<string, RunEventEnvelope>,
  toolCallId: string,
  event: RunEventEnvelope,
): void {
  const current = eventsByToolCallId.get(toolCallId);
  // Persisted sequence is the primary order.  A malformed/replayed store may
  // still expose two lifecycle events with the same sequence; use the stable
  // event id as a deterministic tie-breaker instead of arrival order.
  if (!current || event.seq < current.seq || (event.seq === current.seq && event.id.localeCompare(current.id) < 0)) {
    eventsByToolCallId.set(toolCallId, event);
  }
}

function readRunPolicySnapshot(run: RunSession | undefined): unknown | undefined {
  if (!run || !isRecord(run.requestSnapshot)) {
    return undefined;
  }
  return run.requestSnapshot.effectivePolicySnapshot;
}

function buildApprovalTargetRefs(approval: ApprovalRequest, run: RunSession | undefined): ExecutionActionTargetRef[] {
  const refs: ExecutionActionTargetRef[] = [];
  if (approval.runId) refs.push({ type: "run", id: approval.runId });
  if (run?.workUnitId) refs.push({ type: "work_unit", id: run.workUnitId });
  if (approval.taskId) refs.push({ type: "task", id: approval.taskId });
  if (approval.channelId) refs.push({ type: "channel", id: approval.channelId });
  if (approval.mediaJobId) refs.push({ type: "media_job", id: approval.mediaJobId });
  if (approval.externalWorkActionId) refs.push({ type: "external_work_action", id: approval.externalWorkActionId });
  if (approval.workflowStepId) refs.push({ type: "workflow_step", id: approval.workflowStepId });
  if (approval.payload.type === "workflow_step") refs.push({ type: "workflow", id: approval.payload.workflowId });
  if (approval.payload.type === "file_write" || approval.payload.type === "file_edit") {
    const paths = approval.payload.touchedPaths && approval.payload.touchedPaths.length > 0
      ? approval.payload.touchedPaths
      : [approval.payload.path];
    for (const path of paths) {
      if (path.trim() && path !== "<unknown>") refs.push({ type: "file", path, label: path });
    }
  }
  if (approval.payload.type === "bash") refs.push({ type: "command", label: truncateLabel(approval.payload.command) });
  if (approval.payload.type === "mcp_tool_call") refs.push({ type: "mcp_tool", label: approval.payload.toolName });
  return refs;
}

function mergeTargetRefs(
  left: readonly ExecutionActionTargetRef[],
  right: readonly ExecutionActionTargetRef[],
): ExecutionActionTargetRef[] {
  const seen = new Set<string>();
  const refs: ExecutionActionTargetRef[] = [];
  for (const ref of [...left, ...right]) {
    const key = `${ref.type}:${ref.id ?? ""}:${ref.path ?? ""}:${ref.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function executionActionStatusFromApproval(status: ApprovalStatus): ExecutionActionStatus {
  return status === "pending" ? "waiting_for_approval" : status;
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

function readOptionalExecutionActionTypeQuery(url: URL): ExecutionActionType | undefined {
  const value = url.searchParams.get("actionType");
  if (value === null) {
    return undefined;
  }
  const supportedActionTypes = new Set<string>([...approvalActionTypes, "runtime_diagnostic"]);
  if (!supportedActionTypes.has(value)) {
    throw new Error(`actionType must be one of: ${[...approvalActionTypes, "runtime_diagnostic"].join(", ")}`);
  }
  return value as ExecutionActionType;
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
