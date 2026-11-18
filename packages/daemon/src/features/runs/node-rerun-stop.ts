import { isDeepStrictEqual } from "node:util";
import type { NodeRerunPreparedTargetV1 } from "@ling-stack/contracts";
import type { RunStore, RunEventEnvelope } from "@ling-stack/core";
import type { RuntimeHostCapacityAdmission } from "../../runtime/run-queue.js";
import { ensureRunCancelled } from "./cancellation.js";

export type NodeRerunStopFinalization =
  | { readonly status: "cancelled" }
  | { readonly status: "awaiting_recovery"; readonly reason: "completion_unavailable" | "lifecycle_changed" | "capacity_release_pending" };

export interface FinalizeNodeRerunStopInput {
  readonly store: RunStore;
  readonly target: NodeRerunPreparedTargetV1;
  readonly capacity: RuntimeHostCapacityAdmission;
  readonly capacityReference?: { readonly intentId: string; readonly dispatchToken: string };
  readonly now?: string;
  readonly streamEnvelope?: (envelope: RunEventEnvelope) => void;
}

/**
 * Complete the dispatched-target stop only after the original Host lifetime has
 * produced independently readable drain and effect-coverage facts. This path is
 * safe to retry after a daemon restart; it never reconstructs or replays the
 * prepared Runner input.
 */
export function finalizeDispatchedNodeRerunTargetStop(input: FinalizeNodeRerunStopInput): NodeRerunStopFinalization {
  const now = input.now ?? new Date().toISOString();
  const source = { runId: input.target.runId, ...input.target.fence };
  const completion = input.store.getHostAttemptCompletion(source);
  if (!completion?.drainedAt || !completion.effectCoverage || !isDeepStrictEqual(completion.source, source)) {
    return { status: "awaiting_recovery", reason: "completion_unavailable" };
  }

  const current = input.store.getRun(input.target.runId);
  const unit = current?.workUnitId ? input.store.getWorkUnit(current.workUnitId) : undefined;
  const attempt = unit?.activeAttemptId ? input.store.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
  if (!current || !unit || !attempt || current.workUnitId !== input.target.fence.workUnitId
    || unit.id !== input.target.fence.workUnitId || attempt.id !== input.target.fence.attemptId
    || !isDeepStrictEqual({ runId: current.id, workUnitId: unit.id, attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken }, source)) {
    return { status: "awaiting_recovery", reason: "lifecycle_changed" };
  }

  const observed = input.capacity.getAttemptReference({ workspaceId: input.target.workspaceId, source });
  if (input.capacityReference && observed
    && (observed.reference.intentId !== input.capacityReference.intentId
      || observed.reference.dispatchToken !== input.capacityReference.dispatchToken)) {
    return { status: "awaiting_recovery", reason: "lifecycle_changed" };
  }
  if (!observed && current.status !== "cancelled") {
    return { status: "awaiting_recovery", reason: "lifecycle_changed" };
  }

  if (current.status !== "cancelled") {
    if (current.status !== "queued" && current.status !== "running" && current.status !== "waiting_for_approval"
      || unit.status !== "cancelling" || attempt.status !== "cancelling" || !attempt.abortRequestedAt
      || unit.ownerType !== "node_rerun_intent" || unit.ownerId !== input.target.recordId) {
      return { status: "awaiting_recovery", reason: "lifecycle_changed" };
    }
    ensureRunCancelled({
      store: input.store,
      runId: current.id,
      taskId: current.taskId,
      startedAt: current.startedAt,
      reason: "node_rerun_target_cancelled_after_host_drain",
      active: false,
      expectedRunId: current.id,
      expectedAttemptId: input.target.fence.attemptId,
      allowNodeRerun: true,
      streamEnvelope: input.streamEnvelope,
      now: () => now,
    });
  } else if (unit.status !== "cancelled" || attempt.status !== "cancelled") {
    return { status: "awaiting_recovery", reason: "lifecycle_changed" };
  }

  const released = observed
    ? input.capacity.releaseStopped({ workspaceId: input.target.workspaceId, source,
      intentId: observed.reference.intentId, now })
    : true;
  return released ? { status: "cancelled" } : { status: "awaiting_recovery", reason: "capacity_release_pending" };
}
