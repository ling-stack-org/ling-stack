import type {
  RunEventEnvelope,
  RunnerFallbackReason,
  RunSession,
  RunStatus,
  RunStore,
  WorkUnit,
  WorkUnitAttempt,
  WorkUnitStatus,
} from "@ling-stack/core";

export type StaleRunnerCompletionReportedStatus = "succeeded" | "failed" | "cancelled";

export type StaleRunnerCompletionReason =
  | "terminal_state_changed"
  | "attempt_not_current"
  | "run_cancelled"
  | "work_unit_cancelled"
  | "work_unit_stale";

export interface StaleRunnerCompletionIgnoredPayload {
  readonly runId: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly reportedStatus: StaleRunnerCompletionReportedStatus;
  readonly currentRunStatus: RunStatus;
  readonly currentWorkUnitStatus?: WorkUnitStatus;
  readonly reason: StaleRunnerCompletionReason;
  readonly runnerId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly fallbackReason?: RunnerFallbackReason;
  readonly reportedAt: string;
}

export function auditIgnoredRunnerCompletion(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly workUnit?: WorkUnit;
  readonly attempt?: WorkUnitAttempt;
  readonly reportedStatus: StaleRunnerCompletionReportedStatus;
  readonly reason?: StaleRunnerCompletionReason;
  readonly now?: string;
}): RunEventEnvelope | undefined {
  const currentRun = input.store.getRun(input.run.id) ?? input.run;
  const currentWorkUnit = input.workUnit ? input.store.getWorkUnit(input.workUnit.id) ?? input.workUnit : undefined;
  const currentAttempt = input.attempt ? input.store.getWorkUnitAttempt(input.attempt.id) ?? input.attempt : undefined;
  const reportedAt = input.now ?? new Date().toISOString();
  const payload: StaleRunnerCompletionIgnoredPayload = removeUndefined({
    runId: currentRun.id,
    workUnitId: currentWorkUnit?.id ?? input.workUnit?.id,
    attemptId: currentAttempt?.id ?? input.attempt?.id,
    reportedStatus: input.reportedStatus,
    currentRunStatus: currentRun.status,
    currentWorkUnitStatus: currentWorkUnit?.status,
    reason: input.reason ?? inferIgnoredCompletionReason(currentRun, currentWorkUnit, currentAttempt),
    runnerId: currentAttempt?.runnerId ?? currentWorkUnit?.runnerId,
    requestedRunnerId: currentAttempt?.requestedRunnerId ?? currentWorkUnit?.requestedRunnerId,
    effectiveRunnerId: currentAttempt?.effectiveRunnerId ?? currentWorkUnit?.effectiveRunnerId,
    fallbackReason: currentAttempt?.fallbackReason ?? currentWorkUnit?.fallbackReason,
    reportedAt,
  });

  if (hasMatchingIgnoredCompletionEvent(input.store, currentRun.id, payload)) {
    return undefined;
  }

  try {
    const envelope = input.store.appendEvent(currentRun.id, "stale_runner_completion_ignored", payload);
    if (payload.workUnitId) {
      appendRuntimeIgnoredCompletionEvent(input.store, payload.workUnitId, payload, envelope);
    }
    return envelope;
  } catch {
    return undefined;
  }
}

function inferIgnoredCompletionReason(
  run: RunSession,
  workUnit: WorkUnit | undefined,
  attempt: WorkUnitAttempt | undefined,
): StaleRunnerCompletionReason {
  if (workUnit?.activeAttemptId && attempt?.id && workUnit.activeAttemptId !== attempt.id) {
    return "attempt_not_current";
  }
  if (run.status === "cancelled") {
    return "run_cancelled";
  }
  if (workUnit?.status === "cancelled" || workUnit?.status === "cancelling") {
    return "work_unit_cancelled";
  }
  if (workUnit?.status === "stale") {
    return "work_unit_stale";
  }
  return "terminal_state_changed";
}

function appendRuntimeIgnoredCompletionEvent(
  store: RunStore,
  workUnitId: string,
  payload: StaleRunnerCompletionIgnoredPayload,
  envelope: RunEventEnvelope,
): void {
  try {
    store.appendRuntimeEvent({
      workUnitId,
      attemptId: payload.attemptId,
      type: "stale_runner_completion_ignored",
      actor: "runner",
      ts: envelope.ts,
      data: {
        ...payload,
        runEventId: envelope.id,
        runEventSeq: envelope.seq,
      },
    });
  } catch {
    // Runtime events are a diagnostic projection; the run event is authoritative.
  }
}

function hasMatchingIgnoredCompletionEvent(
  store: RunStore,
  runId: string,
  payload: StaleRunnerCompletionIgnoredPayload,
): boolean {
  return store
    .listEvents(runId, { limit: 1000 })
    .some((event) => event.type === "stale_runner_completion_ignored" && isSameIgnoredCompletion(event.data, payload));
}

function isSameIgnoredCompletion(data: unknown, payload: StaleRunnerCompletionIgnoredPayload): boolean {
  if (!isRecord(data)) {
    return false;
  }
  return (
    data.runId === payload.runId &&
    data.workUnitId === payload.workUnitId &&
    data.attemptId === payload.attemptId &&
    data.reportedStatus === payload.reportedStatus &&
    data.currentRunStatus === payload.currentRunStatus &&
    data.currentWorkUnitStatus === payload.currentWorkUnitStatus
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
