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

export function ensureRunCancelled(input: {
  readonly store: RunStore;
  readonly runId: string;
  readonly taskId: string;
  readonly startedAt?: string;
  readonly reason: string;
  readonly active: boolean;
  readonly streamEnvelope?: (envelope: RunEventEnvelope) => void;
}): { readonly event?: RunEventEnvelope; readonly inputWait?: RunCancelResponse["inputWait"] } {
  const current = input.store.getRun(input.runId);
  if (!current || current.status === "cancelled") {
    return {};
  }
  if (current.status === "yielded") {
    if (!current.threadId) throw new HttpError(409, "run_wait_not_cancellable", "Waiting work has no owning thread.");
    try {
      const result = input.store.cancelUserInputWait({ threadId: current.threadId, sourceRunId: current.id }, new Date().toISOString());
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

  const endedAt = new Date().toISOString();
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
    });
    input.streamEnvelope?.(approvalEvent);
    syncLingThreadForRunEvent(input.store, current, "approval_cancelled", approvalEvent);
  }
  const event = input.store.appendEvent(input.runId, "run_cancelled", {
    reason: input.reason,
    active: input.active,
  });
  input.streamEnvelope?.(event);
  syncLingThreadForRunEvent(input.store, current, "run_cancelled", event);
  const summaryPath = writeTerminalSummary(getRunSummaryPath(input.store.paths, input.runId), {
    runId: input.runId,
    status: "cancelled",
    taskId: input.taskId,
    eventCount: event.seq,
    startedAt: input.startedAt,
    endedAt,
    errorMessage: null,
  });
  input.store.transitionRunStatus({
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
  syncLingThreadForTerminalRun(input.store, input.runId, endedAt);
  const task = input.store.getTask(input.taskId);
  if (task && task.status !== "done" && task.status !== "cancelled") {
    input.store.transitionTaskStatus({
      taskId: input.taskId,
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
    const attemptId = workUnit?.activeAttemptId ?? input.store.listWorkUnitAttempts(current.workUnitId).at(-1)?.id;
    if (attemptId) {
      const attempt = input.store.getWorkUnitAttempt(attemptId);
      if (attempt) {
        input.store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), endedAt, "cancelled");
        input.store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), endedAt, "cancelled");
      }
      transitionWorkUnitCancelled(input.store, current.workUnitId, attemptId, input.reason);
    }
  }
  return { event };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
