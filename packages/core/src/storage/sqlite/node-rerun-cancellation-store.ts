import { isDeepStrictEqual } from "node:util";
import type { NodeRerunPreparedTargetV1, NodeRerunTargetCancellationV1 } from "@ling-stack/contracts";
import type { CancelPreparedNodeRerunTargetInput, CancelPreparedNodeRerunTargetResult,
  RequestDispatchedNodeRerunTargetStopInput, RequestDispatchedNodeRerunTargetStopResult } from "../../node-rerun-store-types.js";
import type { RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence } from "../../runtime-supervisor-types.js";
import type { SqliteRuntimeWorkUnitStore } from "./runtime-work-unit-store.js";
import type { SqliteRuntimeHostCapacityStore } from "./runtime-host-capacity-store.js";
import type { SqliteStoreContext } from "./store-context.js";
import { isCanonicalTimestamp } from "./node-rerun-approval-authority.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";
import { hasNeverStartedNodeRerunTarget } from "./node-rerun-prestart.js";
import { nodeRerunCancellationAuditData, readNodeRerunCancellationEvidence } from "./node-rerun-cancellation-evidence.js";

type Ports = Pick<RunStore, "getNodeRerunTarget" | "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "getTask"
  | "withCancellationFence" | "transitionRunStatus" | "transitionTaskStatus" | "listRuntimeEvents">;

/** Cancels only a prepared, never-dispatched target and atomically releases its source reservation. */
export class SqliteNodeRerunCancellationStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports,
    private readonly units: SqliteRuntimeWorkUnitStore,
    private readonly hostCapacity: (workspaceId: string) => Pick<SqliteRuntimeHostCapacityStore,
      "getAttemptIntent" | "getNodeRerunUndispatchedCapacity" | "prepareNodeRerunNoDispatchReleaseWithinTransaction">) {}

  /** Persist the exact-fence cancelling boundary after a rerun gate is consumed.
   * This does not terminalize the Run or release Host capacity; the captured
   * Runner must drain and complete the normal terminal path first. */
  requestDispatchedNodeRerunTargetStop(input: RequestDispatchedNodeRerunTargetStopInput): RequestDispatchedNodeRerunTargetStopResult {
    if (!isCanonicalTimestamp(input.now)) throw new TypeError("node_rerun_stop.invalid_timestamp");
    const initial = this.ports.getNodeRerunTarget(input.recordId);
    if (!initial) return { status: "blocked", code: "node_rerun_target_not_found" };
    if (!isDeepStrictEqual(initial.fence, input.sourceFence) || input.now < initial.preparedAt)
      return { status: "blocked", code: "node_rerun_target_changed" };
    try {
      return this.ports.withCancellationFence({ runId: initial.runId, workUnitId: initial.fence.workUnitId,
        expectedRunId: initial.runId, expectedAttemptId: initial.fence.attemptId },
        () => this.requestStopWithinTransaction(input)) as RequestDispatchedNodeRerunTargetStopResult;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "stale_cancellation")
        return { status: "blocked", code: "node_rerun_target_changed" };
      throw error;
    }
  }

  cancelPreparedNodeRerunTarget(input: CancelPreparedNodeRerunTargetInput): CancelPreparedNodeRerunTargetResult {
    if (!isCanonicalTimestamp(input.now)) throw new TypeError("node_rerun_cancellation.invalid_timestamp");
    const initial = this.ports.getNodeRerunTarget(input.recordId);
    if (!initial) return { status: "blocked", code: "node_rerun_target_not_found" };
    if (!isDeepStrictEqual(initial.fence, input.sourceFence) || input.now < initial.preparedAt)
      return { status: "blocked", code: "node_rerun_target_changed" };
    try {
      return this.ports.withCancellationFence({ runId: initial.runId, workUnitId: initial.fence.workUnitId,
        expectedRunId: initial.runId, expectedAttemptId: initial.fence.attemptId }, () => this.cancelWithinTransaction(input)) as CancelPreparedNodeRerunTargetResult;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "stale_cancellation")
        return { status: "blocked", code: "node_rerun_target_changed" };
      throw error;
    }
  }

  private requestStopWithinTransaction(input: RequestDispatchedNodeRerunTargetStopInput): RequestDispatchedNodeRerunTargetStopResult {
    const captured = readSqliteWithinTransaction(this.context.database, () => {
      const target = this.ports.getNodeRerunTarget(input.recordId);
      if (!target || !isDeepStrictEqual(target.fence, input.sourceFence)) return undefined;
      const source = { runId: target.runId, ...target.fence };
      const capacity = this.hostCapacity(target.workspaceId).getAttemptIntent(source);
      if (!capacity?.dispatchedAt || capacity.revokedAt || !capacity.reservation) return undefined;
      const run = this.ports.getRun(target.runId), unit = this.ports.getWorkUnit(target.fence.workUnitId),
        attempt = this.ports.getWorkUnitAttempt(target.fence.attemptId);
      if (!run || !unit || !attempt || run.workUnitId !== unit.id || unit.linkedRunId !== run.id
        || unit.ownerType !== "node_rerun_intent" || unit.ownerId !== input.recordId
        || unit.activeAttemptId !== attempt.id || attempt.workUnitId !== unit.id
        || !isDeepStrictEqual({ runId: run.id, ...toRuntimeAttemptFence(attempt) }, source)
        || [run.status, unit.status, attempt.status].some(status => ["succeeded", "failed", "cancelled", "lost"].includes(status)))
        return { target, run, unit, attempt, duplicate: false as const, invalid: "changed" as const };
      if (unit.status === "cancelling" && attempt.status === "cancelling" && attempt.abortRequestedAt)
        return { target, run, unit, attempt, duplicate: true as const, invalid: undefined };
      if (!(run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval")
        || !(unit.status === "claimed" || unit.status === "running" || unit.status === "waiting_for_approval" || unit.status === "waiting_for_input")
        || !(attempt.status === "created" || attempt.status === "started" || attempt.status === "waiting_for_approval"))
        return { target, run, unit, attempt, duplicate: false as const, invalid: "unconfirmed" as const };
      return { target, run, unit, attempt, duplicate: false as const, invalid: undefined };
    });
    if (!captured) return { status: "blocked", code: "node_rerun_target_not_dispatched" };
    if (captured.invalid === "changed") return { status: "blocked", code: "node_rerun_target_changed" };
    if (captured.invalid === "unconfirmed") return { status: "blocked", code: "node_rerun_target_stop_unconfirmed" };
    if (captured.duplicate) return { status: "duplicate" };
    const { target } = captured;
    const cancelling = this.units.transitionWorkUnitStatus({ ...target.fence, expectedStatus: captured.unit.status,
      event: "cancel", actor: "local-user", reason: "node_rerun_target_cancel_requested", now: input.now });
    if (!cancelling.ok) return { status: "blocked", code: "node_rerun_target_changed" };
    const stopped = this.units.updateWorkUnitAttemptStatus({ ...target.fence, status: "cancelling", now: input.now,
      abortRequestedAt: input.now, errorCode: "node_rerun_cancel_requested", errorMessage: "Node rerun target cancellation requested." });
    if (!stopped) throw new Error("node_rerun_stop.attempt_cas_failed");
    this.units.appendRuntimeEvent({ ...target.fence, type: "work_unit_cancelling", actor: "local-user", ts: input.now,
      data: { reason: "node_rerun_target_cancel_requested", recordId: input.recordId } });
    return { status: "requested" };
  }

  private cancelWithinTransaction(input: CancelPreparedNodeRerunTargetInput): CancelPreparedNodeRerunTargetResult {
    const db = this.context.database;
    const captured = readSqliteWithinTransaction(db, () => {
      const target = this.ports.getNodeRerunTarget(input.recordId);
      if (!target || !isDeepStrictEqual(target.fence, input.sourceFence)) return undefined;
      const old = this.readCancellation(target);
      if (old) return { target, old };
      const capacity = this.hostCapacity(target.workspaceId).getNodeRerunUndispatchedCapacity(target.recordId, input.now);
      if (capacity === false || !hasNeverStartedNodeRerunTarget(this.context, this.ports, target, undefined, capacity?.intent.intentId)) return undefined;
      const local = readSqliteWithinTransaction(db, () => input.observeLocalExecution(structuredClone(target)));
      if (local !== "absent") return undefined;
      return { target, capacity };
    });
    if (!captured) return { status: "blocked", code: "node_rerun_target_stop_unconfirmed" };
    if (captured.old) return { status: "duplicate", cancellation: captured.old };
    const { target } = captured, fence = target.fence, now = input.now;
    const cancellation: NodeRerunTargetCancellationV1 = { schemaVersion: 1, kind: "node_rerun_target_cancellation",
      recordId: target.recordId, generationId: target.generationId, runId: target.runId, fence,
      releasedAt: now, stopEvidence: "never_dispatched", executionAuthorized: false };
    const run = this.ports.transitionRunStatus({ runId: target.runId, expectedStatus: "queued", event: "cancel",
      actor: "local-user", reason: "node_rerun_target_cancelled_before_dispatch", endedAt: now, now });
    const task = this.ports.transitionTaskStatus({ taskId: target.taskId, expectedStatus: "todo", event: "cancel",
      actor: "local-user", reason: "node_rerun_target_cancelled_before_dispatch", now });
    const cancelling = this.units.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "cancel",
      actor: "local-user", now });
    const unit = cancelling.ok && this.units.transitionWorkUnitStatus({ ...fence, expectedStatus: "cancelling",
      event: "runner_cancelled", actor: "system", endedAt: now, now });
    const attempt = unit && unit.ok && this.units.updateWorkUnitAttemptStatus({ ...fence, status: "cancelled", endedAt: now, now });
    if (!run.ok || !task.ok || !unit || !unit.ok || !attempt) throw new Error("node_rerun_cancellation.transition_failed");
    this.units.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: "cancelled", transitionedAt: now },
      type: "work_unit_cancelled", actor: "system", data: nodeRerunCancellationAuditData(cancellation) });
    const released = db.prepare(`UPDATE node_rerun_targets SET released_at=? WHERE intent_id=? AND run_id=?
      AND work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=? AND released_at IS NULL`)
      .run(now, target.recordId, target.runId, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
    if (captured.capacity?.reservation) {
      const release = this.hostCapacity(target.workspaceId).prepareNodeRerunNoDispatchReleaseWithinTransaction({
        intentId: captured.capacity.intent.intentId, now });
      if (release.status === "changed") throw new Error("node_rerun_cancellation.capacity_release_unverified");
    }
    const receipt = readSqliteWithinTransaction(db, () => {
      const current = this.ports.getNodeRerunTarget(target.recordId);
      if (!current || !isDeepStrictEqual(current, target)) throw new Error("node_rerun_cancellation.binding_changed");
      return this.readCancellation(current);
    });
    if (released.changes !== 1 || !receipt || !isDeepStrictEqual(receipt, cancellation))
      throw new Error("node_rerun_cancellation.release_receipt_missing");
    return { status: "cancelled", cancellation: receipt };
  }

  private readCancellation(target: NodeRerunPreparedTargetV1): NodeRerunTargetCancellationV1 | undefined {
    const released = this.context.database.prepare("SELECT released_at FROM node_rerun_targets WHERE intent_id=?").get(target.recordId);
    if (released?.released_at === null) return undefined;
    const capacity = this.hostCapacity(target.workspaceId).getNodeRerunUndispatchedCapacity(target.recordId);
    if (capacity === false) throw new Error("node_rerun_cancellation.receipt_corrupt");
    return readNodeRerunCancellationEvidence(this.context, this.ports, target, capacity?.intent.intentId);
  }
}
