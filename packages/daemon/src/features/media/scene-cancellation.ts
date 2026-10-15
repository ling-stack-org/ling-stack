import { toRuntimeAttemptFence, type MediaJob, type MediaStoreFacet, type RuntimeSupervisorStoreFacet,
  type UpdateMediaJobStatusInput } from "@ling-stack/core";
import { MediaLocalExecutionAdmissionError, type MediaLocalExecutionHandle,
  type MediaLocalExecutionRegistry } from "../../runtime/media-local-executions.js";
import { transitionWorkUnitCancelled } from "../../runtime/work-units.js";

const activeStatuses = ["queued", "running", "waiting_for_approval"] as const;
type CancellationStore = MediaStoreFacet & RuntimeSupervisorStoreFacet;

/** The SQL UPDATE, not a preceding read or an old owner snapshot, selects the winner. */
export function updateActiveMediaJobStatus(
  store: MediaStoreFacet, mediaJobId: string, input: UpdateMediaJobStatusInput, now: string,
): MediaJob {
  const updated = store.updateMediaJobStatus(mediaJobId, { ...input, expectedStatuses: activeStatuses }, now);
  if (updated) return updated;
  const current = store.getMediaJob(mediaJobId);
  throw new MediaLocalExecutionAdmissionError(current?.status === "cancelled" ? "media_job_cancelled" : "media_job_terminal",
    "Media terminal status already won; the previous owner cannot replace it.");
}

/** Native EOF receipts remain admissible; only business writes and new requests close. */
export function assertMediaJobBusinessActive(store: MediaStoreFacet, mediaJobId: string): void {
  const job = store.getMediaJob(mediaJobId);
  if (!job || !activeStatuses.some(status => status === job.status)) {
    throw new MediaLocalExecutionAdmissionError(job?.status === "cancelled" ? "media_job_cancelled" : "media_job_terminal",
      "Media business completion is no longer active.");
  }
}

/**
 * Idempotent local reconciliation only. No remote cancel, new Attempt, new
 * generation, artifact deletion or transport replay is permitted here.
 */
export function settleLocallyCancelledMediaJob(input: {
  readonly store: CancellationStore;
  readonly registry: MediaLocalExecutionRegistry;
  readonly cwd: string;
  readonly mediaJobId: string;
  /** Only the original entered owner supplies this, after its await/receipt tail returns. */
  readonly localExecution?: MediaLocalExecutionHandle;
}): MediaJob | undefined {
  const job = input.store.getMediaJob(input.mediaJobId);
  if (job?.status !== "cancelled") return undefined;
  if (input.localExecution) input.registry.assertCompletionAllowed(input.localExecution);
  const draining = input.registry.cancelJob({ cwd: input.cwd, mediaJobId: job.id, execution: input.localExecution });
  const settleChild = !draining || Boolean(input.localExecution);
  const handle = input.store.getMediaJobExecutionHandle(job.id);
  if (handle) {
    input.store.upsertMediaJobExecutionHandle({ ...handle, nextPollAt: null,
      recovery: handle.externalOperationId.startsWith("ling-pending:")
        ? { ...handle.recovery, ...(settleChild ? { phase: "submission_outcome_unknown" } : {}),
            submissionOutcome: "unknown", localCancellation: true }
        : { ...handle.recovery, localCancellation: true },
    }, new Date().toISOString());
  }
  // Closing the child before real EOF would reject the original Core ACK/fact
  // writer. The same entered owner, not a timer or UI status, performs phase 2.
  if (!settleChild) return input.store.getMediaJob(job.id);
  const captured = input.localExecution ? input.registry.getBoundAttempt(input.localExecution) : undefined;
  for (const unit of input.store.listWorkUnits({ kind: "media_job", linkedMediaJobId: job.id, limit: 500 })) {
    const reason = "媒体任务已在本地取消；远端结果可能仍然未知。";
    if (captured && unit.id !== captured.workUnitId) continue;
    if (!unit.activeAttemptId && !captured) {
      if (["succeeded", "failed", "cancelled"].includes(unit.status)) continue;
      const now = new Date().toISOString();
      const cancelling = input.store.transitionWorkUnitStatus({ workUnitId: unit.id, expectedStatus: unit.status,
        event: unit.status === "stale" ? "reconcile_cancelled" : "cancel", actor: "local-user", reason, now });
      if (cancelling.ok && cancelling.to === "cancelling") input.store.transitionWorkUnitStatus({ workUnitId: unit.id,
        expectedStatus: "cancelling", event: "runner_cancelled", actor: "system", reason, now, endedAt: now });
      continue;
    }
    const attempt = input.store.getWorkUnitAttempt(captured?.attemptId ?? unit.activeAttemptId!);
    if (!attempt || attempt.workUnitId !== unit.id) continue;
    if (captured && (attempt.runtimeInstanceId !== captured.runtimeInstanceId || attempt.fencingToken !== captured.fencingToken)) continue;
    if (unit.activeAttemptId === attempt.id) transitionWorkUnitCancelled(input.store, unit.id, attempt.id, reason);
    // Exact immutable fence only; this tail must not release a successor's slot.
    const fence = toRuntimeAttemptFence(attempt), now = new Date().toISOString();
    input.store.releaseRuntimeSemaphoreSlotsForAttempt(fence, now, "media-job-locally-cancelled");
    input.store.releaseResourceLeasesForAttempt(fence, now, "media-job-locally-cancelled");
  }
  return input.store.getMediaJob(job.id);
}

export function cancelledMediaJobResult(job: MediaJob, explicitRetry = false) {
  return explicitRetry
    ? { statusCode: 409, body: { error: "media_job_cancelled_new_run_required",
        message: "该任务已取消，远端状态可能未知。请创建新的场景运行，不会重新提交原任务。", mediaJob: job } }
    : { statusCode: 200, body: { mediaJob: job, artifacts: [] } };
}
