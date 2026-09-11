import type {
  ExecutionAction,
  ExecutionActionStatus,
  RunArtifact,
  RunEventEnvelope,
  RunIntervention,
  RunInterventionStatus,
  RunSession,
  RunStatus,
} from "./run-types.js";
import type { RuntimeEvent } from "./runtime-supervisor-types.js";
import type { StateTransitionEvent } from "./channel-runtime-types.js";
import type {
  LingTrace,
  LingTraceRefs,
  LingTraceSpan,
  LingTraceStatus,
  ProjectLingTraceInput,
  ProjectLingTraceResult,
} from "./runtime-trace-types.js";

export function projectLingTrace(input: ProjectLingTraceInput): ProjectLingTraceResult {
  const traceId = createLingTraceId(input.subjectKind, input.subjectId);
  const runParentSpanIds = new Map<string, string>();
  const workUnitParentSpanIds = new Map<string, string>();
  const toolCallIdsFromEvents = new Set<string>();
  const spans: LingTraceSpan[] = [];

  for (const run of [...input.runs].sort(compareRuns)) {
    const spanId = createLingTraceSpanId(traceId, "agent_run", run.id);
    runParentSpanIds.set(run.id, spanId);
    if (run.workUnitId) {
      workUnitParentSpanIds.set(run.workUnitId, spanId);
    }
    spans.push({
      id: spanId,
      traceId,
      kind: "agent_run",
      title: `Run ${run.id}`,
      startedAt: run.startedAt ?? run.createdAt,
      endedAt: run.endedAt,
      status: run.status,
      refs: {
        threadId: run.threadId,
        runId: run.id,
        workUnitId: run.workUnitId,
        workflowStepId: run.workflowStepId,
        interventionId: run.interventionId,
      },
      redactedAttributes: stripUndefined({
        taskId: run.taskId,
        channelId: run.channelId,
        teammateId: run.teammateId,
        providerName: run.providerName,
        providerModel: run.providerModel,
        selectedSkillId: run.selectedSkillId,
        providerPresetId: run.providerPresetId,
        parentRunId: run.parentRunId,
        continuationReason: run.continuationReason,
      }),
    });

    const toolSpans = buildToolCallSpans({
      traceId,
      run,
      events: input.eventsByRunId[run.id] ?? [],
      parentSpanId: spanId,
      toolCallIdsFromEvents,
    });
    spans.push(...toolSpans);
  }

  for (const action of input.executionActions ?? []) {
    const parentSpanId = action.runId ? runParentSpanIds.get(action.runId) : undefined;
    const duplicateToolSpan = action.toolCallId ? toolCallIdsFromEvents.has(action.toolCallId) : false;
    if (duplicateToolSpan) {
      continue;
    }
    spans.push(executionActionToSpan(traceId, action, parentSpanId));
  }

  for (const approval of input.approvals ?? []) {
    spans.push(approvalToSpan(traceId, approval, approval.runId ? runParentSpanIds.get(approval.runId) : undefined));
  }

  for (const artifact of input.artifacts ?? []) {
    spans.push(artifactToSpan(traceId, artifact, artifact.runId ? runParentSpanIds.get(artifact.runId) : undefined));
  }

  for (const transition of input.transitions ?? []) {
    spans.push(stateTransitionToSpan(traceId, transition, parentSpanForTransition(transition, runParentSpanIds, workUnitParentSpanIds)));
  }

  for (const events of Object.values(input.runtimeEventsByWorkUnitId ?? {})) {
    for (const event of events) {
      spans.push(runtimeEventToSpan(traceId, event, workUnitParentSpanIds.get(event.workUnitId)));
    }
  }

  for (const intervention of input.interventions ?? []) {
    spans.push(runInterventionToSpan(traceId, intervention, runParentSpanIds.get(intervention.sourceRunId)));
  }

  const sortedSpans = uniqueSpans(spans).sort(compareSpans);
  const trace = buildTrace(input, traceId, sortedSpans);
  return { trace, spans: sortedSpans };
}

export function createLingTraceId(subjectKind: string, subjectId: string): string {
  return `trace_${safeIdFragment(subjectKind)}_${safeIdFragment(subjectId)}`;
}

export function createLingTraceSpanId(traceId: string, kind: string, sourceId: string): string {
  return `span_${safeIdFragment(traceId)}_${safeIdFragment(kind)}_${safeIdFragment(sourceId)}`;
}

function buildToolCallSpans(input: {
  readonly traceId: string;
  readonly run: RunSession;
  readonly events: readonly RunEventEnvelope[];
  readonly parentSpanId: string;
  readonly toolCallIdsFromEvents: Set<string>;
}): LingTraceSpan[] {
  const starts = new Map<string, RunEventEnvelope>();
  const ends = new Map<string, RunEventEnvelope>();
  for (const event of input.events) {
    const toolCallId = readStringAttribute(event.data, "toolCallId");
    if (!toolCallId) {
      continue;
    }
    input.toolCallIdsFromEvents.add(toolCallId);
    if (event.type === "tool_start") {
      starts.set(toolCallId, event);
    } else if (event.type === "tool_end") {
      ends.set(toolCallId, event);
    }
  }

  const spans: LingTraceSpan[] = [];
  for (const toolCallId of new Set([...starts.keys(), ...ends.keys()])) {
    const start = starts.get(toolCallId);
    const end = ends.get(toolCallId);
    const source = start ?? end;
    if (!source) {
      continue;
    }
    const toolName = readStringAttribute(source.data, "toolName") ?? "tool";
    const isError = readBooleanAttribute(end?.data, "isError") === true;
    spans.push({
      id: createLingTraceSpanId(input.traceId, "tool_call", `${input.run.id}_${toolCallId}`),
      traceId: input.traceId,
      parentSpanId: input.parentSpanId,
      kind: "tool_call",
      title: `${toolName} tool`,
      startedAt: start?.ts ?? end?.ts ?? input.run.createdAt,
      endedAt: end?.ts,
      status: end ? isError ? "failed" : "succeeded" : "running",
      refs: {
        threadId: input.run.threadId,
        runId: input.run.id,
        workUnitId: input.run.workUnitId,
        workflowStepId: input.run.workflowStepId,
        toolCallId,
      },
      redactedAttributes: stripUndefined({
        toolName,
        startSeq: start?.seq,
        endSeq: end?.seq,
        isError: end ? isError : undefined,
      }),
    });
  }
  return spans;
}

function executionActionToSpan(traceId: string, action: ExecutionAction, parentSpanId: string | undefined): LingTraceSpan {
  const kind = action.actionType === "external_send" || action.actionType === "deploy" ? "external_action" : "tool_call";
  return {
    id: createLingTraceSpanId(traceId, kind, action.id),
    traceId,
    parentSpanId,
    kind,
    title: action.title,
    startedAt: action.executedAt ?? action.createdAt,
    endedAt: action.completedAt ?? action.resolvedAt,
    status: statusFromExecutionAction(action.status),
    refs: {
      threadId: action.threadId,
      runId: action.runId,
      workUnitId: action.workUnitId,
      approvalId: action.approvalId,
      executionActionId: action.id,
      toolCallId: action.toolCallId,
    },
    redactedAttributes: stripUndefined({
      actionType: action.actionType,
      risk: action.risk,
      status: action.status,
      scopes: action.scopes,
      previewArtifactCount: action.previewArtifactIds.length,
      resultArtifactCount: action.resultArtifactIds.length,
    }),
  };
}

function approvalToSpan(traceId: string, approval: import("./approval-types.js").ApprovalRequest, parentSpanId: string | undefined): LingTraceSpan {
  return {
    id: createLingTraceSpanId(traceId, "approval", approval.id),
    traceId,
    parentSpanId,
    kind: "approval",
    title: approval.title,
    startedAt: approval.createdAt,
    endedAt: approval.resolvedAt,
    status: approval.status === "pending" ? "waiting_for_approval"
      : approval.status === "approved" ? "succeeded"
        : approval.status === "cancelled" ? "cancelled" : "failed",
    refs: {
      runId: approval.runId,
      workflowStepId: approval.workflowStepId,
      approvalId: approval.id,
      toolCallId: approval.toolCallId,
    },
    redactedAttributes: stripUndefined({
      actionType: approval.actionType,
      risk: approval.risk,
      status: approval.status,
      decisionKind: approval.decisionKind,
      resolvedBy: approval.resolvedBy,
    }),
  };
}

function artifactToSpan(traceId: string, artifact: RunArtifact, parentSpanId: string | undefined): LingTraceSpan {
  return {
    id: createLingTraceSpanId(traceId, "artifact", artifact.id),
    traceId,
    parentSpanId,
    kind: "artifact",
    title: artifact.title ?? artifact.path.split("/").at(-1) ?? artifact.id,
    startedAt: artifact.createdAt,
    endedAt: artifact.createdAt,
    status: "succeeded",
    refs: {
      runId: artifact.runId,
      artifactId: artifact.id,
    },
    redactedAttributes: stripUndefined({
      type: artifact.type,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      hasPath: true,
    }),
  };
}

function stateTransitionToSpan(
  traceId: string,
  transition: StateTransitionEvent,
  parentSpanId: string | undefined,
): LingTraceSpan {
  return {
    id: createLingTraceSpanId(traceId, "state_transition", transition.id),
    traceId,
    parentSpanId,
    kind: "state_transition",
    title: `${transition.entityType} ${transition.fromStatus} -> ${transition.toStatus}`,
    startedAt: transition.createdAt,
    endedAt: transition.createdAt,
    status: "succeeded",
    refs: {
      runId: transition.entityType === "run" ? transition.entityId : undefined,
      workUnitId: transition.entityType === "work_unit" ? transition.entityId : undefined,
      approvalId: transition.entityType === "approval" ? transition.entityId : undefined,
      stateTransitionId: transition.id,
    },
    redactedAttributes: stripUndefined({
      entityType: transition.entityType,
      event: transition.event,
      actor: transition.actor,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      hasReason: Boolean(transition.reason),
    }),
  };
}

function runtimeEventToSpan(traceId: string, event: RuntimeEvent, parentSpanId: string | undefined): LingTraceSpan {
  return {
    id: createLingTraceSpanId(traceId, "runtime_event", `${event.workUnitId}_${event.seq}`),
    traceId,
    parentSpanId,
    kind: "runtime_event",
    title: event.type,
    startedAt: event.ts,
    endedAt: event.ts,
    status: statusFromRuntimeEvent(event.type),
    refs: {
      workUnitId: event.workUnitId,
      attemptId: event.attemptId,
      runtimeEventId: `${event.workUnitId}:${event.seq}`,
    },
    redactedAttributes: stripUndefined({
      seq: event.seq,
      type: event.type,
      actor: event.actor,
    }),
  };
}

function runInterventionToSpan(traceId: string, intervention: RunIntervention, parentSpanId: string | undefined): LingTraceSpan {
  return {
    id: createLingTraceSpanId(traceId, "handoff", intervention.id),
    traceId,
    parentSpanId,
    kind: "handoff",
    title: intervention.mode === "interrupt_redirect" ? "Interrupt and redirect" : "Queued follow-up",
    startedAt: intervention.startedAt ?? intervention.createdAt,
    endedAt: intervention.completedAt,
    status: statusFromRunIntervention(intervention.status),
    refs: {
      runId: intervention.sourceRunId,
      workUnitId: intervention.sourceWorkUnitId,
      attemptId: intervention.sourceAttemptId,
      interventionId: intervention.id,
    },
    redactedAttributes: stripUndefined({
      mode: intervention.mode,
      status: intervention.status,
      requestedBy: intervention.requestedBy,
      continuationRunId: intervention.continuationRunId,
      continuationWorkUnitId: intervention.continuationWorkUnitId,
      hasFailureReason: Boolean(intervention.failureReason),
    }),
  };
}

function buildTrace(input: ProjectLingTraceInput, traceId: string, spans: readonly LingTraceSpan[]): LingTrace {
  const startedAt = input.createdAt ?? spans.at(0)?.startedAt ?? input.generatedAt ?? new Date(0).toISOString();
  const latestEndedAt = latestDefined([
    input.updatedAt,
    ...input.runs.map((run) => run.endedAt),
    ...spans.map((span) => span.endedAt),
  ]);
  const status = input.status ?? deriveTraceStatus(input.runs, spans);
  return {
    id: traceId,
    workspaceId: input.workspaceId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    title: input.title ?? `${input.subjectKind} ${input.subjectId}`,
    startedAt,
    endedAt: isTerminalTraceStatus(status) ? latestEndedAt : undefined,
    status,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

function deriveTraceStatus(runs: readonly RunSession[], spans: readonly LingTraceSpan[]): Exclude<LingTraceStatus, "skipped"> {
  if (runs.some((run) => run.status === "failed") || spans.some((span) => span.status === "failed")) {
    return "failed";
  }
  if (runs.some((run) => run.status === "cancelled")) {
    return "cancelled";
  }
  // Historical progress spans do not keep a physically yielded execution alive.
  if (runs.some((run) => run.status === "yielded")
    && !runs.some((run) => run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval")) {
    return spans.some((span) => span.status === "waiting_for_input") ? "waiting_for_input" : "yielded";
  }
  if (runs.some((run) => run.status === "waiting_for_approval") || spans.some((span) => span.status === "waiting_for_approval")) {
    return "waiting_for_approval";
  }
  if (runs.some((run) => run.status === "running") || spans.some((span) => span.status === "running")) {
    return "running";
  }
  if (runs.some((run) => run.status === "queued") || spans.some((span) => span.status === "queued")) {
    return "queued";
  }
  if (spans.some((span) => span.status === "waiting_for_input")) {
    return "waiting_for_input";
  }
  if (runs.some((run) => run.status === "yielded")) {
    return "yielded";
  }
  return "succeeded";
}

function isTerminalTraceStatus(status: LingTraceStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "skipped";
}

function statusFromExecutionAction(status: ExecutionActionStatus): LingTraceStatus {
  if (status === "proposed" || status === "waiting_for_approval") {
    return "waiting_for_approval";
  }
  if (status === "approved" || status === "executing") {
    return "running";
  }
  if (status === "denied" || status === "expired" || status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return "succeeded";
}

function statusFromRunIntervention(status: RunInterventionStatus): LingTraceStatus {
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "started") {
    return "succeeded";
  }
  return "running";
}

function statusFromRuntimeEvent(type: RuntimeEvent["type"]): LingTraceStatus {
  if (type === "work_unit_waiting_for_input") {
    return "waiting_for_input";
  }
  if (type === "work_unit_failed" || type === "diagnostic_stuck_detected") {
    return "failed";
  }
  if (type === "work_unit_cancelled" || type === "stale_runner_completion_ignored") {
    return "cancelled";
  }
  if (type === "work_unit_succeeded" || type === "artifact_created" || type === "tool_namespace_materialized") {
    return "succeeded";
  }
  if (type === "work_unit_queued" || type === "work_unit_created") {
    return "queued";
  }
  if (type === "work_unit_approval_requested") {
    return "waiting_for_approval";
  }
  if (type === "tool_hydration_rejected") {
    return "skipped";
  }
  return "running";
}

function parentSpanForTransition(
  transition: StateTransitionEvent,
  runParentSpanIds: ReadonlyMap<string, string>,
  workUnitParentSpanIds: ReadonlyMap<string, string>,
): string | undefined {
  if (transition.entityType === "run") {
    return runParentSpanIds.get(transition.entityId);
  }
  if (transition.entityType === "work_unit") {
    return workUnitParentSpanIds.get(transition.entityId);
  }
  return undefined;
}

function compareRuns(left: RunSession, right: RunSession): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareSpans(left: LingTraceSpan, right: LingTraceSpan): number {
  return (
    left.startedAt.localeCompare(right.startedAt) ||
    (left.endedAt ?? "").localeCompare(right.endedAt ?? "") ||
    left.kind.localeCompare(right.kind) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
}

function uniqueSpans(spans: readonly LingTraceSpan[]): LingTraceSpan[] {
  const seen = new Set<string>();
  const result: LingTraceSpan[] = [];
  for (const span of spans) {
    if (seen.has(span.id)) {
      continue;
    }
    seen.add(span.id);
    result.push(span);
  }
  return result;
}

function latestDefined(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function safeIdFragment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

function readStringAttribute(data: unknown, key: string): string | undefined {
  return isRecord(data) && typeof data[key] === "string" ? data[key] : undefined;
}

function readBooleanAttribute(data: unknown, key: string): boolean | undefined {
  return isRecord(data) && typeof data[key] === "boolean" ? data[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUndefined(attributes: Record<string, unknown | undefined>): Readonly<Record<string, unknown>> | undefined {
  const entries = Object.entries(attributes).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
