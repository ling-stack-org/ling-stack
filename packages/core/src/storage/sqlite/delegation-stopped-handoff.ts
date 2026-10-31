import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { delegationFence, delegationJson, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import { readTrackedToolCoverage } from "./host-attempt-tracked-coverage.js";
import { isNativeCompletionSource, readNativeAttemptEffectStatus } from "./host-attempt-native-coverage.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { UserInputStoreError } from "../../user-input-store-types.js";

/**
 * A resource-release veto exception only, never authority to run/resume/finish a
 * logical child. It requires the original closed Host lifetime plus independently
 * reverified effect journals. The Run deliberately stays open during interruption.
 * The caller owns the transaction; no UI/model stop flag participates.
 */
export function hasDelegationStoppedHandoff(database: DatabaseSync, rawFence: RuntimeAttemptFenceV1, rawAt: string,
  successor?: { readonly reservationId: string; readonly targetFence: RuntimeAttemptFenceV1 }): boolean {
  const fence = delegationFence(rawFence), at = delegationTimestamp(rawAt);
  const target = successor ? delegationFence(successor.targetFence) : undefined;
  const owner = database.prepare(`SELECT r.id AS run_id,r.status AS run_status,r.ended_at AS run_ended_at,
    u.status AS unit_status,a.status AS attempt_status,s.id AS step_id,s.parent_run_id,s.state AS step_state,
    c.drained_at,c.effect_coverage,c.tracked_tool_calls_json,c.native_effect_inventory_json
    FROM work_unit_attempts a JOIN work_units u ON u.id=a.work_unit_id
    JOIN run_sessions r ON r.id=u.linked_run_id AND r.work_unit_id=u.id
    JOIN delegation_budget_reservations b ON b.child_run_id=r.id AND b.state='reserved'
    JOIN delegation_steps s ON s.id=b.delegation_step_id AND s.child_run_id=r.id
      AND s.root_run_id=b.root_run_id AND s.parent_run_id=r.parent_run_id
    JOIN host_attempt_completions c ON c.run_id=r.id AND c.work_unit_id=u.id AND c.attempt_id=a.id
      AND c.runtime_instance_id=a.runtime_instance_id AND c.fencing_token=a.fencing_token
    WHERE a.id=? AND a.work_unit_id=? AND a.runtime_instance_id=? AND a.fencing_token=?
      AND u.owner_type='delegation_step' AND u.owner_id=s.id AND ${target ? `b.id=?
      AND s.state IN ('resuming','running') AND a.status='cancelled' AND a.error_code='delegation_interrupted'
      AND a.abort_requested_at IS NOT NULL AND a.ended_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM work_unit_attempts t WHERE t.id=u.active_attempt_id
        AND t.id=? AND t.work_unit_id=? AND t.runtime_instance_id=? AND t.fencing_token=?
        AND t.work_unit_id=a.work_unit_id AND t.attempt_number=a.attempt_number+1
        AND t.ended_at IS NULL AND t.abort_requested_at IS NULL AND t.created_at>=a.ended_at
        AND c.drained_at<=t.created_at
        AND ((t.status='created' AND u.status='claimed' AND s.state='resuming')
          OR (t.status='started' AND u.status='running' AND s.state='running')))
      AND NOT EXISTS (SELECT 1 FROM resource_leases WHERE attempt_id=a.id AND status='active')
      AND NOT EXISTS (SELECT 1 FROM runtime_semaphore_slots WHERE attempt_id=a.id AND status='active')`
      : "u.active_attempt_id=a.id"}`)
    .get(fence.attemptId, fence.workUnitId, fence.runtimeInstanceId, fence.fencingToken,
      ...(target ? [successor!.reservationId, target.attemptId, target.workUnitId, target.runtimeInstanceId, target.fencingToken] : []));
  if (!owner || owner.run_status !== "running" || owner.run_ended_at !== null
    || !(target ? ["resuming", "running"] : ["interrupting", "interrupted", "resuming"]).includes(String(owner.step_state))
    || !(target ? ["claimed", "running"] : ["cancelling", "cancelled", "queued", "claimed"]).includes(String(owner.unit_status))
    || !["cancelling", "cancelled"].includes(String(owner.attempt_status))
    || typeof owner.run_id !== "string" || typeof owner.drained_at !== "string") return false;
  const source = { runId: owner.run_id, ...fence };
  const drainedAt = delegationTimestamp(owner.drained_at, "delegation.persisted_fact_invalid");
  if (drainedAt > at) return false;
  const requests = database.prepare(`SELECT a.run_id,a.sealed_payload_json,a.content_sha256,m.digest FROM delegation_messages m
    JOIN artifacts a ON a.id=m.body_artifact_id WHERE m.delegation_step_id=? AND m.direction='parent_to_child' AND m.kind='control'
      AND json_extract(a.sealed_payload_json,'$.kind')='delegation.interrupt.v1'
      AND json_extract(a.sealed_payload_json,'$.sourceFence.attemptId')=? LIMIT 2`).all(owner.step_id!, fence.attemptId);
  if (requests.length !== 1 || typeof requests[0]!.sealed_payload_json !== "string" || requests[0]!.run_id !== owner.parent_run_id) return false;
  const request = requests[0]!;
  const json = request.sealed_payload_json as string;
  const hash = createHash("sha256").update(json, "utf8").digest("hex");
  if (hash !== request.content_sha256 || hash !== request.digest) return false;
  const payload = delegationRecord(JSON.parse(json), ["schemaVersion", "kind", "parentFence", "sourceFence", "callId", "requestedAt"], "delegation.persisted_fact_invalid");
  if (payload.schemaVersion !== 1 || delegationJson(delegationFence(payload.sourceFence)) !== delegationJson(fence)
    || delegationTimestamp(payload.requestedAt, "delegation.persisted_fact_invalid") > at) return false;
  const parentFence = delegationFence(payload.parentFence);
  if (!database.prepare(`SELECT 1 FROM run_sessions r JOIN work_unit_attempts a ON a.work_unit_id=r.work_unit_id
    WHERE r.id=? AND a.id=? AND a.work_unit_id=? AND a.runtime_instance_id=? AND a.fencing_token=?`)
    .get(owner.parent_run_id!, parentFence.attemptId, parentFence.workUnitId, parentFence.runtimeInstanceId, parentFence.fencingToken)) return false;
  const native = isNativeCompletionSource(database, source);
  const covered = native ? readNativeAttemptEffectStatus(database, source, owner.native_effect_inventory_json, "exact_attempt") === "settled"
    : owner.effect_coverage === "pi_no_tools_v1" || readTrackedToolCoverage(database, source, owner.tracked_tool_calls_json, at, "exact_attempt");
  if (!covered) return false;
  try { assertUserInputDurableQuiescence(database, source.runId, fence, Date.parse(at), "exact_attempt"); return true; }
  catch (error) { if (error instanceof UserInputStoreError && error.code === "not_quiescent") return false; throw error; }
}
