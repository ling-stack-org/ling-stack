import type {
  AppendRuntimeDiagnosticEventInput,
  MediaJobExecutionHandle,
  RunStore,
  WorkUnit,
  WorkUnitAttempt,
} from "@ling-stack/core";
import { markWorkUnitStale } from "../../runtime/work-units.js";

const activeStatuses = new Set<WorkUnit["status"]>([
  "claimed",
  "running",
]);

export function recoverPendingConversationMediaWorkUnits(store: RunStore, now: string): number {
  const pendingMediaJobIds = new Set([
    ...store.listMediaJobs({ status: "queued", limit: 500 }),
    ...store.listMediaJobs({ status: "running", limit: 500 }),
  ].map((job) => job.id));
  let recovered = 0;

  for (const workUnit of store.listWorkUnits({ kind: "media_job", limit: 500 })) {
    if (!isConversationMediaChild(workUnit) || !pendingMediaJobIds.has(workUnit.linkedMediaJobId!)) continue;
    const next = requeueConversationMediaChild(store, workUnit, now, false);
    if (next?.status !== "queued") continue;
    clearExecutionHandleRuntimeBinding(store, workUnit.linkedMediaJobId!, now);
    if (workUnit.status !== "queued") recovered += 1;
  }

  return recovered;
}

export function prepareConversationMediaWorkUnitForExplicitRetry(
  store: RunStore,
  mediaJobId: string,
  now: string,
): WorkUnit | undefined {
  const child = findConversationMediaChild(store, mediaJobId);
  if (!child) return undefined;
  const next = requeueConversationMediaChild(store, child, now, true);
  if (next?.status === "queued") {
    clearExecutionHandleRuntimeBinding(store, mediaJobId, now);
  }
  return next;
}

export function synchronizeConversationMediaWorkUnitTerminal(
  store: RunStore,
  mediaJobId: string,
  status: "failed" | "cancelled",
  now: string,
): WorkUnit | undefined {
  let current = findConversationMediaChild(store, mediaJobId);
  if (!current || isTerminalStatus(current.status)) return current;

  const attempt = current.activeAttemptId
    ? store.getWorkUnitAttempt(current.activeAttemptId)
    : undefined;
  if (status === "failed" && current.status === "cancelling") {
    current = markWorkUnitStale(store, current, now, "media-job-terminal-sync");
  }

  const transition = status === "failed"
    ? store.transitionWorkUnitStatus({
        workUnitId: current.id,
        expectedStatus: current.status,
        event: current.status === "stale" ? "reconcile_failed" : "runner_failed",
        actor: "system",
        reason: "media_job_terminal_sync",
        now,
        endedAt: now,
        errorCode: "media_job_execution_failed",
        errorMessage: "媒体任务已经失败。",
      })
    : transitionConversationMediaChildCancelled(store, current, now);
  if (!transition.ok) return store.getWorkUnit(current.id) ?? current;

  if (attempt && attempt.status !== "lost") {
    store.updateWorkUnitAttemptStatus({
      attemptId: attempt.id,
      workUnitId: attempt.workUnitId,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      status,
      now,
      endedAt: now,
      errorCode: status === "failed" ? "media_job_execution_failed" : "cancelled",
      errorMessage: status === "failed" ? "媒体任务已经失败。" : "媒体任务已取消。",
    });
    store.releaseRuntimeSemaphoreSlotsForAttempt(
      {
        workUnitId: attempt.workUnitId,
        attemptId: attempt.id,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
      },
      now,
      `media-job-${status}`,
    );
  }
  const runtimeEvent: Pick<AppendRuntimeDiagnosticEventInput, "type" | "actor" | "ts" | "data"> = {
    // The Attempt was already transitioned above. This is reconciliation evidence,
    // not a second canonical terminal transition under a stale lease fence.
    type: "stale_runner_completion_ignored",
    actor: "system" as const,
    ts: now,
    data: { reason: "media_job_terminal_sync", fromStatus: transition.from, toStatus: transition.to },
  };
  if (attempt) {
    store.appendRuntimeDiagnosticEvent({
      ...runtimeEvent,
      workUnitId: current.id,
      attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
    });
  } else {
    store.appendRuntimeEvent({ ...runtimeEvent, workUnitId: current.id });
  }
  return store.getWorkUnit(current.id) ?? current;
}

export function findConversationMediaWorkUnit(store: RunStore, mediaJobId: string): WorkUnit | undefined {
  return findConversationMediaChild(store, mediaJobId);
}

export function bindMediaExecutionHandleToRuntime(
  store: RunStore,
  handle: MediaJobExecutionHandle,
  runtime: { readonly workUnit: WorkUnit; readonly attempt: WorkUnitAttempt },
  now: string,
): MediaJobExecutionHandle {
  if (handle.workUnitId === runtime.workUnit.id && handle.attemptId === runtime.attempt.id) return handle;
  return store.upsertMediaJobExecutionHandle({
    mediaJobId: handle.mediaJobId,
    adapterKind: handle.adapterKind,
    externalOperationId: handle.externalOperationId,
    recovery: handle.recovery,
    nextPollAt: handle.nextPollAt ?? null,
    pollAttempts: handle.pollAttempts,
    workUnitId: runtime.workUnit.id,
    attemptId: runtime.attempt.id,
  }, now);
}

function requeueConversationMediaChild(
  store: RunStore,
  workUnit: WorkUnit,
  now: string,
  allowTerminalRetry: boolean,
): WorkUnit | undefined {
  let current = store.getWorkUnit(workUnit.id) ?? workUnit;
  if (activeStatuses.has(current.status)) {
    current = markWorkUnitStale(store, current, now, "media-runtime-startup-recovery");
  }
  const retryable = current.status === "stale" || (
    allowTerminalRetry && (current.status === "failed" || current.status === "cancelled")
  );
  if (!retryable) return current;

  const transition = store.transitionWorkUnitStatus({
    workUnitId: current.id,
    expectedStatus: current.status,
    event: "retry",
    actor: allowTerminalRetry ? "local-user" : "system",
    reason: allowTerminalRetry ? "media_job_explicit_retry" : "media_runtime_startup_recovery",
    now,
    activeAttemptId: null,
    endedAt: null,
    errorCode: null,
    errorMessage: null,
  });
  if (!transition.ok) return store.getWorkUnit(current.id) ?? current;
  store.appendRuntimeEvent({
    workUnitId: current.id,
    type: "work_unit_queued",
    actor: allowTerminalRetry ? "local-user" : "system",
    ts: now,
    data: { reason: allowTerminalRetry ? "media_job_explicit_retry" : "media_runtime_startup_recovery" },
  });
  return store.getWorkUnit(current.id) ?? current;
}

function findConversationMediaChild(store: RunStore, mediaJobId: string): WorkUnit | undefined {
  return store.listWorkUnits({ kind: "media_job", linkedMediaJobId: mediaJobId, limit: 100 })
    .find(isConversationMediaChild);
}

function isConversationMediaChild(workUnit: WorkUnit): boolean {
  const request = isRecord(workUnit.request) ? workUnit.request : {};
  return workUnit.ownerType === "conversation_run" &&
    Boolean(workUnit.linkedRunId && workUnit.linkedMediaJobId) &&
    request.source === "conversation_media_tool";
}

function transitionConversationMediaChildCancelled(store: RunStore, workUnit: WorkUnit, now: string) {
  if (workUnit.status === "stale") {
    return store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: "stale",
      event: "reconcile_cancelled",
      actor: "system",
      reason: "media_job_terminal_sync",
      now,
      endedAt: now,
      errorCode: "cancelled",
      errorMessage: "媒体任务已取消。",
    });
  }
  if (workUnit.status !== "cancelling") {
    const cancelling = store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: workUnit.status,
      event: "cancel",
      actor: "system",
      reason: "media_job_terminal_sync",
      now,
    });
    if (!cancelling.ok) return cancelling;
  }
  return store.transitionWorkUnitStatus({
    workUnitId: workUnit.id,
    expectedStatus: "cancelling",
    event: "runner_cancelled",
    actor: "system",
    reason: "media_job_terminal_sync",
    now,
    endedAt: now,
    errorCode: "cancelled",
    errorMessage: "媒体任务已取消。",
  });
}

function isTerminalStatus(status: WorkUnit["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function clearExecutionHandleRuntimeBinding(store: RunStore, mediaJobId: string, now: string): void {
  const handle = store.getMediaJobExecutionHandle(mediaJobId);
  if (!handle || (!handle.workUnitId && !handle.attemptId)) return;
  store.upsertMediaJobExecutionHandle({
    mediaJobId: handle.mediaJobId,
    adapterKind: handle.adapterKind,
    externalOperationId: handle.externalOperationId,
    recovery: handle.recovery,
    nextPollAt: handle.nextPollAt ?? null,
    pollAttempts: handle.pollAttempts,
    workUnitId: null,
    attemptId: null,
  }, now);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
