import type { DatabaseSync } from "node:sqlite";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { readTrackedToolCoverage } from "./host-attempt-tracked-coverage.js";
import { readHostOperationBlockers } from "./host-operation-journal-store.js";
import { isNativeCompletionSource, readNativeAttemptEffectStatus } from "./host-attempt-native-coverage.js";
import { hostAttemptReadScopeForSource } from "./host-attempt-read-scope.js";
import { hasDelegationStoppedHandoff } from "./delegation-stopped-handoff.js";
import { hasPendingRunSuspension } from "./run-suspension-store.js";
import { hasRunSuspensionStoppedHandoff } from "./run-suspension-stopped-handoff.js";

/** A durable veto, not evidence of local callback drain or permission to resume. */
export function withCancelledAttemptResourceVeto(database: DatabaseSync, fence: RuntimeAttemptFenceV1,
  releasedAt: string, release: () => number): number {
  return withResourceReleaseTransaction(database, () =>
    mayReleaseCancelledAttemptResources(database, fence, releasedAt) ? release() : 0);
}

export function expireRuntimeResourcesWithCancellationVeto(database: DatabaseSync,
  table: "resource_leases" | "runtime_semaphore_slots", now: string): number {
  if (table !== "resource_leases" && table !== "runtime_semaphore_slots") throw new TypeError("Invalid runtime resource table");
  return withResourceReleaseTransaction(database, () => {
    const expired = database.prepare(`SELECT id,work_unit_id,attempt_id,runtime_instance_id,fencing_token FROM ${table}
      WHERE status='active' AND expires_at<=? ORDER BY id`).all(now);
    const expire = database.prepare(`UPDATE ${table} SET status='expired',released_at=?,
      release_reason=COALESCE(release_reason,'expired') WHERE id=? AND status='active' AND expires_at<=?`);
    let count = 0;
    for (const row of expired) {
      if (row.attempt_id !== null) {
        if (typeof row.work_unit_id !== "string" || typeof row.attempt_id !== "string"
          || typeof row.runtime_instance_id !== "string" || typeof row.fencing_token !== "string") continue;
        if (!mayReleaseCancelledAttemptResources(database, { workUnitId: row.work_unit_id, attemptId: row.attempt_id,
          runtimeInstanceId: row.runtime_instance_id, fencingToken: row.fencing_token }, now)) continue;
      }
      count += Number(expire.run(now, row.id!, now).changes);
    }
    return count;
  });
}

function withResourceReleaseTransaction(database: DatabaseSync, release: () => number): number {
  database.exec("SAVEPOINT cancelled_attempt_resource_release");
  try {
    const result = release();
    database.exec("RELEASE cancelled_attempt_resource_release");
    return result;
  } catch (error) {
    database.exec("ROLLBACK TO cancelled_attempt_resource_release");
    database.exec("RELEASE cancelled_attempt_resource_release");
    throw error;
  }
}

function mayReleaseCancelledAttemptResources(database: DatabaseSync, fence: RuntimeAttemptFenceV1, releasedAt: string): boolean {
  const owner = database.prepare(`SELECT attempt.status AS attempt_status, attempt.error_code AS attempt_error_code, unit.status AS unit_status,
    run.id AS run_id,run.status AS run_status FROM work_unit_attempts AS attempt JOIN work_units AS unit ON unit.id=attempt.work_unit_id
    LEFT JOIN run_sessions AS run ON run.id=unit.linked_run_id
    WHERE attempt.id=? AND attempt.work_unit_id=? AND attempt.runtime_instance_id=? AND attempt.fencing_token=?`)
    .get(fence.attemptId, fence.workUnitId, fence.runtimeInstanceId, fence.fencingToken);
  if (!owner) return false;
  const suspensionStopped = hasRunSuspensionStoppedHandoff(database, fence, releasedAt);
  // A graceful request is an admission latch, never a legacy no-lifetime
  // exception. Expiry/restart cannot release it before exact stopped provenance.
  if (typeof owner.run_id === "string" && hasPendingRunSuspension({ database }, { runId: owner.run_id, ...fence })
    && !suspensionStopped) return false;
  const scope = typeof owner.run_id === "string"
    ? hostAttemptReadScopeForSource(database, { runId: owner.run_id, ...fence }) : "whole_run";
  // A registered original lifetime is an independent veto, including terminal
  // callbacks outside Broker enforcement and expiry after a Daemon restart.
  const completion = database.prepare(`SELECT run_id,drained_at,effect_coverage,tracked_tool_calls_json,native_effect_inventory_json FROM host_attempt_completions
    WHERE work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=?`)
    .get(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
  if (typeof owner.run_id === "string" && isNativeCompletionSource(database, { runId: owner.run_id, ...fence })) {
    const source = { runId: owner.run_id, ...fence };
    if (!completion?.drained_at || readNativeAttemptEffectStatus(database, source, completion.native_effect_inventory_json, scope) !== "settled") return false;
  }
  const approvedApprovalHandoff = completion && owner.run_status === "waiting_for_approval"
    && owner.unit_status === "waiting_for_approval"
    && (owner.attempt_status === "waiting_for_approval"
      || owner.attempt_status === "lost" && owner.attempt_error_code === "runtime_suspend")
    && database.prepare(`SELECT 1 FROM approval_checkpoints AS checkpoint JOIN approval_requests AS approval
      ON approval.id=checkpoint.approval_id AND approval.run_id=checkpoint.run_id
      WHERE checkpoint.run_id=? AND checkpoint.status='approved' AND approval.status='approved'
        AND json_extract(checkpoint.resume_basis_json,'$.workUnitId')=?
        AND (json_extract(checkpoint.resume_basis_json,'$.priorAttemptId')=?
          OR json_extract(checkpoint.runner_resume_handle_json,'$.attemptId')=?) LIMIT 1`)
      .get(completion.run_id!, fence.workUnitId, fence.attemptId, fence.attemptId);
  if (completion && completion.drained_at === null && !approvedApprovalHandoff) return false;
  if (completion) {
    const suspendedApproval = owner.attempt_status === "lost" && owner.attempt_error_code === "runtime_suspend"
      && owner.run_status === "waiting_for_approval" && owner.unit_status === "waiting_for_approval"
      && database.prepare(`SELECT 1 FROM approval_checkpoints AS checkpoint JOIN approval_requests AS approval
        ON approval.id=checkpoint.approval_id AND approval.status=checkpoint.status
        WHERE checkpoint.run_id=? AND checkpoint.status IN ('pending','approved')
          AND (json_extract(checkpoint.resume_basis_json,'$.priorAttemptId')=?
            OR json_extract(checkpoint.runner_resume_handle_json,'$.attemptId')=?) LIMIT 1`)
        .get(completion.run_id!, fence.attemptId, fence.attemptId);
    // HostOperationSource structurally extends the Attempt fence with runId.
    // Keep delegationFence() strict and project the exact security boundary
    // before asking the stopped-handoff verifier to validate it.
    const handoffFence = Object.freeze({ workUnitId: fence.workUnitId, attemptId: fence.attemptId,
      runtimeInstanceId: fence.runtimeInstanceId, fencingToken: fence.fencingToken });
    const delegationStopped = scope === "exact_attempt" && hasDelegationStoppedHandoff(database, handoffFence, releasedAt);
    if (!approvedApprovalHandoff && !suspendedApproval && !delegationStopped && !suspensionStopped
      && !["succeeded", "failed", "cancelled"].includes(String(owner.run_status))) return false;
    // Ordinary completion keeps the existing execution-policy semantics, but a
    // positively recorded unknown/pending Host effect vetoes every release path.
    if (readHostOperationBlockers(database, { runId: String(completion.run_id), ...fence }, releasedAt, scope).length) return false;
  }
  if (owner.attempt_status !== "cancelled" && owner.unit_status !== "cancelling" && owner.unit_status !== "cancelled"
    && owner.run_status !== "cancelled") return true;
  // A drained local callback group alone says nothing about off/shadow effects.
  // Legacy records without a registered lifetime keep their existing vetoes.
  if (completion && completion.effect_coverage !== "pi_no_tools_v1"
    && readNativeAttemptEffectStatus(database, { runId: String(completion.run_id), ...fence }, completion.native_effect_inventory_json, scope) !== "settled"
    && !readTrackedToolCoverage(database, { runId: String(completion.run_id), ...fence }, completion.tracked_tool_calls_json, releasedAt, scope)) return false;
  // Verify historical source facts under the same transaction as the release.
  const runs = database.prepare("SELECT id FROM run_sessions WHERE work_unit_id=? ORDER BY id").all(fence.workUnitId);
  try {
    for (const run of runs) assertUserInputDurableQuiescence(database, String(run.id), fence, Date.parse(releasedAt), scope);
    return true;
  } catch (error) {
    if (error instanceof UserInputStoreError && error.code === "not_quiescent") return false;
    throw error;
  }
}
