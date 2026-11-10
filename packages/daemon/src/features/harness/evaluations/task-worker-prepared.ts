import type { RunEvaluationTaskV1, RunEvaluationV1 } from "@ling-stack/contracts";
import type { RunEvaluationTaskAdmission, RunEvaluationTaskClaim, RunEvaluationTaskFence,
  RunEvaluationTaskMutationResult, RunEvaluationTaskSettlement } from "@ling-stack/core";
import { copyImmutableTaskData, prepareRunEvaluationTaskRequest,
  type RunEvaluationTaskArtifactInputs, type RunEvaluationTaskExecutionInput } from "./task-worker-input.js";
import type { ProcessNextRunEvaluationTaskOptions, RunEvaluationTaskProcessResult } from "./task-worker.js";

export const RUN_EVALUATION_QA_DEFERRED_REASONS = ["qa_lane_busy", "qa_lane_quarantined",
  "qa_batch_budget_exhausted", "qa_window_budget_exhausted"] as const;
export type RunEvaluationTaskDeferredReason = (typeof RUN_EVALUATION_QA_DEFERRED_REASONS)[number];
type HostAdmission = { readonly ok: true; readonly value: RunEvaluationTaskAdmission; readonly replayed: boolean }
  | { readonly ok: false; readonly code: string };
type HostSettlement = { readonly ok: true; readonly value: RunEvaluationTaskSettlement; readonly replayed: boolean }
  | { readonly ok: false; readonly code: string };
/** Focused Host lifecycle seam. No producer DTO, mutation Store or credential reaches the executor. */
export interface RunEvaluationTaskHostExecution {
  readonly requestDigest: string;
  readonly executionScopeDigest: string;
  admit(fence: RunEvaluationTaskFence): HostAdmission;
  execute(input: RunEvaluationTaskExecutionInput): unknown | Promise<unknown>;
  complete(fence: RunEvaluationTaskFence, result: unknown): HostSettlement;
  markUnknown(fence: RunEvaluationTaskFence): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim>;
  /** Called only once this invocation's preparation/executor callback has actually settled. */
  onDrained(): void | Promise<void>;
}
export interface RunEvaluationTaskHostAdapter {
  reconcile(now: string): void;
  /** Optional narrow pre-LIMIT queue projection; must return metadata only, never sealed evidence. */
  selectCandidate?(now: string): RunEvaluationTaskV1 | undefined;
  acceptsTask(task: RunEvaluationTaskV1): boolean;
  prepare(input: {
    readonly claim: RunEvaluationTaskClaim;
    readonly evaluation: RunEvaluationV1;
    readonly artifacts: RunEvaluationTaskArtifactInputs;
    readonly signal: AbortSignal;
  }): RunEvaluationTaskHostExecution | Promise<RunEvaluationTaskHostExecution>;
}

/** Preserve foundation claims/fences while preparing a private request before any durable admission. */
export async function processPreparedRunEvaluationTaskClaim(input: {
  readonly options: ProcessNextRunEvaluationTaskOptions;
  readonly adapter: RunEvaluationTaskHostAdapter;
  readonly claim: RunEvaluationTaskClaim;
  readonly clock: () => string;
  readonly executionTimeoutMs: number;
}): Promise<RunEvaluationTaskProcessResult> {
  const { options, adapter, clock } = input;
  let current = input.claim;
  let prepared: RunEvaluationTaskHostExecution | undefined;
  let uncertain = false;
  let admissionMayHaveHappened = false;
  let unknownCommitted = false;
  let settling = false;
  let unknownCommitError: unknown;
  const controller = new AbortController();
  const disposition = (value: RunEvaluationTaskProcessResult["disposition"], reason?: RunEvaluationTaskDeferredReason): RunEvaluationTaskProcessResult =>
    ({ disposition: value, taskId: current.task.id, ...(reason === undefined ? {} : { reason }) });
  const fence = (): RunEvaluationTaskFence => ({ taskId: current.task.id, attemptId: current.attempt.id,
    expectedTaskRevision: current.task.revision, expectedAttemptRevision: current.attempt.revision,
    claimOwner: current.attempt.claimOwner, claimToken: current.attempt.claimToken, now: clock() });
  const finishBeforeDispatch = (cancelled: boolean): RunEvaluationTaskProcessResult => {
    const result = options.store.finishRunEvaluationTaskBeforeDispatch({ ...fence(),
      nextState: cancelled ? "cancelled" : "failed",
      failureCode: cancelled ? "evaluation.cancelled_before_dispatch" : "evaluation.task_invalid" });
    return disposition(result.ok ? cancelled ? "cancelled" : "failed" : "claim_lost");
  };
  const markUnknown = (): boolean => {
    if (unknownCommitted) return true;
    if (!prepared) return false;
    const result = prepared.markUnknown(fence());
    if (result.ok) { current = result.value; unknownCommitted = true; }
    return unknownCommitted;
  };
  const stop = (): void => {
    uncertain = true;
    if (admissionMayHaveHappened && !settling) {
      try { markUnknown(); } catch (error) { unknownCommitError = error; }
    }
    controller.abort();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(stop, input.executionTimeoutMs);
  try {
    if (options.signal?.aborted) stop();
    if (uncertain) return finishBeforeDispatch(true);
    const claim = copyImmutableTaskData(current);
    const evaluation = copyImmutableTaskData(options.store.getRunEvaluation(claim.task.evaluationId));
    const request = prepareRunEvaluationTaskRequest(claim, evaluation);
    if (!evaluation) throw new Error("evaluation_task_worker_source_invalid");
    if (uncertain || options.signal?.aborted) return finishBeforeDispatch(true);
    prepared = await adapter.prepare(Object.freeze({ claim, evaluation, artifacts: request.artifacts, signal: controller.signal }));
    if (uncertain || controller.signal.aborted || options.signal?.aborted) return finishBeforeDispatch(true);
    for (const digest of [prepared.requestDigest, prepared.executionScopeDigest]) {
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error("evaluation_task_worker_scope_invalid");
    }
    const admissionFence = fence();
    if (uncertain || controller.signal.aborted || options.signal?.aborted) return finishBeforeDispatch(true);
    admissionMayHaveHappened = true;
    const admission = prepared.admit(admissionFence);
    if (!admission.ok) {
      admissionMayHaveHappened = false;
      if (uncertain || controller.signal.aborted || options.signal?.aborted) return finishBeforeDispatch(true);
      if (RUN_EVALUATION_QA_DEFERRED_REASONS.includes(admission.code as RunEvaluationTaskDeferredReason)) {
        // Keep this unadmitted claim until its lease expires. No immediate pending/retry loop.
        return disposition("deferred", admission.code as RunEvaluationTaskDeferredReason);
      }
      return finishBeforeDispatch(false);
    }
    current = admission.value;
    if (!admission.value.mayDispatch) return disposition("claim_lost");
    if (uncertain || controller.signal.aborted || options.signal?.aborted) {
      markUnknown(); return disposition(unknownCommitted ? "unknown" : "claim_lost");
    }
    const executionInput = Object.freeze({ ...copyImmutableTaskData({ task: current.task, attempt: current.attempt }),
      artifacts: request.artifacts, requestDigest: prepared.requestDigest,
      executionScopeDigest: prepared.executionScopeDigest, signal: controller.signal });
    if (uncertain || controller.signal.aborted || options.signal?.aborted) {
      markUnknown(); return disposition(unknownCommitted ? "unknown" : "claim_lost");
    }
    const result = await prepared.execute(executionInput);
    if (uncertain || controller.signal.aborted || options.signal?.aborted) {
      markUnknown(); return disposition(unknownCommitted ? "unknown" : "claim_lost");
    }
    const completionFence = fence();
    if (uncertain || controller.signal.aborted || options.signal?.aborted) {
      markUnknown(); return disposition(unknownCommitted ? "unknown" : "claim_lost");
    }
    // No await inside this exact synchronous atomic settlement. A successful factual commit wins
    // a transaction-internal cancel; never attempt a nested unknown transaction from its callback.
    settling = true;
    let completed: ReturnType<RunEvaluationTaskHostExecution["complete"]>;
    try { completed = prepared.complete(completionFence, result); }
    finally { settling = false; }
    if (completed.ok) { current = completed.value; return disposition("completed"); }
    markUnknown(); return disposition(unknownCommitted ? "unknown" : "claim_lost");
  } catch {
    if (!admissionMayHaveHappened) return finishBeforeDispatch(uncertain || controller.signal.aborted || options.signal?.aborted === true);
    markUnknown(); return disposition(unknownCommitted ? "unknown" : "claim_lost");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", stop);
    await prepared?.onDrained();
    if (unknownCommitError !== undefined && !unknownCommitted) throw unknownCommitError;
  }
}
