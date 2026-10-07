import type { RunSession, RunStore, RuntimeAttemptFenceV1 } from "@ling-stack/core";
import { toRuntimeAttemptFence } from "@ling-stack/core";
import { HttpError } from "../../errors.js";

type OwnershipStore = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt">;

/** Identity only: permits reconciliation of this attempt's Host-owned terminal state, never new execution. */
export function hasCurrentRunCallbackIdentity(store: OwnershipStore, source: RunSession, fence: RuntimeAttemptFenceV1): boolean {
  const run = store.getRun(source.id);
  const unit = store.getWorkUnit(fence.workUnitId);
  const attempt = store.getWorkUnitAttempt(fence.attemptId);
  return Boolean(run && unit && attempt && source.workUnitId === fence.workUnitId
    && run.workUnitId === fence.workUnitId && run.cwd === source.cwd && run.taskId === source.taskId
    && unit.linkedRunId === run.id && unit.activeAttemptId === attempt.id
    && attempt.workUnitId === unit.id && attempt.runtimeInstanceId === fence.runtimeInstanceId
    && attempt.fencingToken === fence.fencingToken);
}

/** Verify a captured caller identity; never rebind a Runner callback to the latest Attempt. */
export function isCurrentRunCallbackOwner(store: OwnershipStore, source: RunSession, fence: RuntimeAttemptFenceV1 | undefined): boolean {
  if (!fence || fence.workUnitId !== source.workUnitId) return false;
  const run = store.getRun(source.id);
  const unit = store.getWorkUnit(fence.workUnitId);
  const attempt = store.getWorkUnitAttempt(fence.attemptId);
  return Boolean(run && unit && attempt
    && run.workUnitId === fence.workUnitId && run.cwd === source.cwd && run.taskId === source.taskId
    && ["queued", "running", "waiting_for_approval"].includes(run.status)
    && unit.linkedRunId === run.id && unit.activeAttemptId === attempt.id
    && ["queued", "claimed", "running", "waiting_for_approval"].includes(unit.status)
    && attempt.workUnitId === unit.id && attempt.runtimeInstanceId === fence.runtimeInstanceId
    && attempt.fencingToken === fence.fencingToken && !attempt.endedAt && !attempt.abortRequestedAt
    && ["created", "started", "waiting_for_approval"].includes(attempt.status));
}

export function assertCurrentRunCallbackOwner(store: OwnershipStore, source: RunSession, fence: RuntimeAttemptFenceV1): void {
  if (!isCurrentRunCallbackOwner(store, source, fence)) {
    throw new HttpError(409, "tool_materialization_denied", "The source execution no longer owns this tool hydration request.");
  }
}

/** Host-initiated POST only. Runner callbacks must use the fence captured at dispatch. */
export function captureToolLoadRequestFence(store: OwnershipStore, source: RunSession): RuntimeAttemptFenceV1 {
  const unit = source.workUnitId ? store.getWorkUnit(source.workUnitId) : undefined;
  const attempt = unit?.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
  if (!attempt) throw new HttpError(409, "tool_materialization_denied", "Tool loading requires a current execution owner. Use the catalog endpoint to inspect tools.");
  const fence = Object.freeze(toRuntimeAttemptFence(attempt));
  assertCurrentRunCallbackOwner(store, source, fence);
  return fence;
}
