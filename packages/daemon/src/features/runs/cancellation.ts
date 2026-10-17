import {
  getRunSummaryPath,
  type RunEventEnvelope,
  type RunStatus,
  type RunStore,
  toRuntimeAttemptFence,
  UserInputStoreError,
} from "@ling-stack/core";
import type { RunCancelResponse } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import { transitionWorkUnitCancelled } from "../../runtime/work-units.js";
import { writeTerminalSummary } from "./terminal.js";
import { syncLingThreadForRunEvent, syncLingThreadForTerminalRun } from "./threads.js";
import { assertNoUnsafeRequiredPause } from "./user-input-cancellation-guard.js";
import { withCancellationFence } from "../../runtime/cancellation-fence.js";

export function ensureRunCancelled(input: {
  readonly store: RunStore;
  readonly runId: string;
  readonly taskId: string;
  readonly startedAt?: string;
  readonly reason: string;
  readonly active: boolean;
  readonly expectedAttemptId?: string | null;
  readonly expectedRunId?: string | null;
  readonly streamEnvelope?: (envelope: RunEventEnvelope) => void;
  readonly now?: () => string;
}): { readonly event?: RunEventEnvelope; readonly inputWait?: RunCancelResponse["inputWait"] } {
  const current = input.store.getRun(input.runId);
  if (!current || current.status === "cancelled") {
    return {};
  }
  if (current.status === "yielded") {
    if (!current.threadId) throw new HttpError(409, "run_wait_not_cancellable", "Waiting work has no owning thread.");
    try {
      const result = input.store.cancelUserInputWait({ threadId: current.threadId, sourceRunId: current.id },
        input.now?.() ?? new Date().toISOString());
      return { inputWait: { requestId: result.request.requestId, requestVersion: result.request.requestVersion,
        waitRevision: result.wait.revision, workUnitId: result.request.source.fence.workUnitId,
        turnId: result.request.source.turnId, status: "cancelled" } };
    } catch (error) {
      if (error instanceof UserInputStoreError) {
        throw new HttpError(409, "run_wait_not_cancellable", "Waiting work can no longer be cancelled through this source Run.");
      }
      throw error;
    }
  }
  if (isTerminalRunStatus(current.status)) {
    return {};
  }

  const events: RunEventEnvelope[] = [];
  const result = withCancellationFence<{ readonly event?: RunEventEnvelope }>(input.store, {
    runId: input.runId, expectedAttemptId: input.expectedAttemptId, expectedRunId: input.expectedRunId,
  }, ({ run }) => {
    if (!run || isTerminalRunStatus(run.status)) return {};
    if (run.status === "yielded") throw new HttpError(409, "stale_cancellation", "Execution entered a safe wait; read its current cancellation state.");
    return cancelCurrentRun({ ...input, streamEnvelope: event => events.push(event) }, run);
  });
  if (result.event) {
    const cancelled = input.store.getRun(input.runId)!;
    writeTerminalSummary(getRunSummaryPath(input.store.paths, input.runId), {
      runId: input.runId, status: "cancelled", taskId: cancelled.taskId, eventCount: result.event.seq,
      startedAt: cancelled.startedAt, endedAt: cancelled.endedAt!, errorMessage: null,
    });
    for (const event of events) input.streamEnvelope?.(event);
  }
  return result;
}

function cancelCurrentRun(input: Parameters<typeof ensureRunCancelled>[0], current: NonNullable<ReturnType<RunStore["getRun"]>>)
  : { readonly event: RunEventEnvelope } {

  // A pending required pause has not yet established physical safety. A
  // generic cancellation would otherwise release its retained attempt leases
  // and publish a terminal summary while the Host still has unknown effects.
  assertNoUnsafeRequiredPause(input.store, current);

  const endedAt = input.now?.() ?? new Date().toISOString();
  for (const approval of input.store.listApprovalRequests({ runId: input.runId, status: "pending", limit: 500 })) {
    const cancelled = input.store.cancelApprovalRequest(
      approval.id,
      { reason: `Run cancelled: ${input.reason}`, resolvedBy: "local-user" },
      endedAt,
    );
    if (!cancelled) {
      continue;
    }
    const approvalEvent = input.store.appendEvent(input.runId, "approval_cancelled", {
      approvalId: cancelled.id,
      status: cancelled.status,
      resolvedBy: cancelled.resolvedBy,
      decisionReason: cancelled.decisionReason,
    }, endedAt);
    input.streamEnvelope?.(approvalEvent);
    syncLingThreadForRunEvent(input.store, current, "approval_cancelled", approvalEvent);
  }
  const event = input.store.appendEvent(input.runId, "run_cancelled", {
    reason: input.reason,
    active: input.active,
  }, endedAt);
  input.streamEnvelope?.(event);
  syncLingThreadForRunEvent(input.store, current, "run_cancelled", event);
  const summaryPath = getRunSummaryPath(input.store.paths, input.runId);
  const transitioned = input.store.transitionRunStatus({
    runId: input.runId,
    expectedStatus: current.status,
    event: "cancel",
    actor: "local-user",
    reason: input.reason,
    now: endedAt,
    endedAt,
    summaryPath,
    errorMessage: null,
  });
  if (!transitioned.ok) throw new HttpError(409, "stale_cancellation", "The Run changed before cancellation.");
  syncLingThreadForTerminalRun(input.store, input.runId, endedAt);
  const task = input.store.getTask(current.taskId);
  if (task && (!task.currentRunId || task.currentRunId === current.id)
    && task.status !== "done" && task.status !== "cancelled") {
    input.store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: task.status,
      event: "cancel",
      actor: "local-user",
      reason: input.reason,
      now: endedAt,
      currentRunId: input.runId,
    });
  }
  if (current.workUnitId) {
    const workUnit = input.store.getWorkUnit(current.workUnitId);
    const attemptId = workUnit?.activeAttemptId;
    if (attemptId) {
      const attempt = input.store.getWorkUnitAttempt(attemptId);
      if (attempt) {
        input.store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), endedAt, "cancelled");
        input.store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), endedAt, "cancelled");
      }
      transitionWorkUnitCancelled(input.store, current.workUnitId, attemptId, input.reason, endedAt);
    }
  }
  return { event };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
