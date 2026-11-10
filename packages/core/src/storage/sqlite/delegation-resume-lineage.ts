import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual as same } from "node:util";
import { delegationDigest, delegationFence, delegationId, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { isNativeCompletionSource, readNativeAttemptEffectStatus } from "./host-attempt-native-coverage.js";
import { readTrackedToolCoverage } from "./host-attempt-tracked-coverage.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";

/** Historical ACK, not live admission or a capability to dispatch again. */
export function hasDelegationRunnerStart(database: DatabaseSync, runId: string, fence: RuntimeAttemptFenceV1): boolean {
  const owner = database.prepare(`SELECT s.id AS step_id,b.id AS reservation_id,a.created_at,a.started_at,a.ended_at
    FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
    JOIN delegation_steps s ON s.id=u.owner_id AND u.owner_type='delegation_step' AND s.child_run_id=r.id
      AND s.parent_run_id=r.parent_run_id
    JOIN delegation_budget_reservations b ON b.delegation_step_id=s.id AND b.child_run_id=r.id AND b.root_run_id=s.root_run_id
    JOIN work_unit_attempts a ON a.work_unit_id=u.id WHERE r.id=? AND u.id=? AND a.id=?
      AND a.runtime_instance_id=? AND a.fencing_token=?`)
    .get(runId, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
  if (!owner?.started_at) return false;
  const rows = database.prepare(`SELECT ts,data_json FROM runtime_events WHERE work_unit_id=? AND attempt_id=?
    AND runtime_instance_id=? AND fencing_token=? AND type='work_unit_started' AND actor='system'
    AND json_extract(data_json,'$.kind')='delegation_runner_start' LIMIT 2`)
    .all(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
  if (rows.length !== 1 || typeof rows[0]!.data_json !== "string") return false;
  const data = delegationRecord(JSON.parse(rows[0]!.data_json as string), ["kind", "reservationId", "stepId", "observationDigest"]);
  const at = delegationTimestamp(rows[0]!.ts);
  delegationTimestamp(owner.created_at); delegationTimestamp(owner.started_at);
  if (owner.ended_at !== null) delegationTimestamp(owner.ended_at);
  return data.kind === "delegation_runner_start" && data.reservationId === owner.reservation_id && data.stepId === owner.step_id
    && typeof data.observationDigest === "string" && /^[a-f0-9]{64}$/u.test(data.observationDigest)
    && String(owner.created_at) <= at && String(owner.started_at) <= at && (owner.ended_at === null || at <= String(owner.ended_at));
}

/**
 * Read an explicit ordinary resume edge from its original immutable control.
 * No call-id convention or mutable status alone qualifies the edge. Revalidate
 * the stopped predecessor's original Host/effect/answer facts even after the
 * successor has ended or been replaced. This never grants a new dispatch.
 */
export function readDelegationResumePredecessor(database: DatabaseSync, runId: string, target: RuntimeAttemptFenceV1): RuntimeAttemptFenceV1 | undefined {
  const rows = database.prepare(`SELECT m.*,a.run_id,a.path,a.type,a.content_type,a.sealed_payload_json,a.content_sha256
    FROM delegation_messages m JOIN artifacts a ON a.id=m.body_artifact_id
    JOIN delegation_steps s ON s.id=m.delegation_step_id AND s.child_run_id=?
    WHERE m.direction='parent_to_child' AND m.kind='control'
      AND json_extract(a.sealed_payload_json,'$.kind')='delegation.resume.v1'
      AND json_extract(a.sealed_payload_json,'$.targetFence.attemptId')=? LIMIT 2`).all(runId, target.attemptId);
  if (rows.length !== 1) return undefined;
  const row = rows[0]!;
  if (typeof row.sealed_payload_json !== "string" || row.path !== "sqlite:delegation-control"
    || row.type !== "json" || row.content_type !== "application/json") return undefined;
  const value = delegationRecord(JSON.parse(row.sealed_payload_json), ["schemaVersion", "kind", "parentFence",
    "expectedStepRevision", "callId", "sourceFence", "targetFence", "requestedAt"]);
  const source = delegationFence(value.sourceFence), parent = delegationFence(value.parentFence), requestedAt = delegationTimestamp(value.requestedAt);
  const callId = delegationId(value.callId), retained = readHarnessRetainedBody(database, String(row.body_artifact_id));
  if (value.schemaVersion !== 1 || value.kind !== "delegation.resume.v1" || !same(delegationFence(value.targetFence), target)
    || source.workUnitId !== target.workUnitId || source.attemptId === target.attemptId || source.fencingToken === target.fencingToken
    || !Number.isSafeInteger(value.expectedStepRevision) || Number(value.expectedStepRevision) < 0
    || requestedAt !== row.created_at || row.idempotency_key !== `delegation-resume:${parent.attemptId}:${callId}`
    || retained.bytes > 65_536 || retained.contentSha256 !== row.digest || row.content_sha256 !== row.digest
    || delegationDigest(value) !== row.digest) return undefined;
  const owner = database.prepare(`SELECT s.id AS step_id,s.parent_run_id,t.created_at,p.ended_at,p.abort_requested_at,
      c.registered_at,c.drained_at,c.effect_coverage,c.tracked_tool_calls_json,c.native_effect_inventory_json
    FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
    JOIN delegation_steps s ON s.id=u.owner_id AND u.owner_type='delegation_step' AND s.child_run_id=r.id AND s.parent_run_id=r.parent_run_id
    JOIN delegation_budget_reservations b ON b.delegation_step_id=s.id AND b.child_run_id=r.id AND b.root_run_id=s.root_run_id
    JOIN work_unit_attempts p ON p.work_unit_id=u.id JOIN work_unit_attempts t ON t.work_unit_id=u.id
    JOIN host_attempt_completions c ON c.run_id=r.id AND c.work_unit_id=u.id AND c.attempt_id=p.id
      AND c.runtime_instance_id=p.runtime_instance_id AND c.fencing_token=p.fencing_token
    WHERE r.id=? AND u.id=? AND p.id=? AND p.runtime_instance_id=? AND p.fencing_token=?
      AND t.id=? AND t.runtime_instance_id=? AND t.fencing_token=? AND t.attempt_number=p.attempt_number+1
      AND t.runner_id=p.runner_id AND p.status='cancelled' AND p.error_code='delegation_interrupted'
      AND p.abort_requested_at IS NOT NULL AND p.ended_at IS NOT NULL`)
    .get(runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken,
      target.attemptId, target.runtimeInstanceId, target.fencingToken);
  if (!owner || owner.step_id !== row.delegation_step_id || owner.parent_run_id !== row.run_id || owner.created_at !== requestedAt
    || !owner.drained_at || !owner.registered_at || String(owner.registered_at) > String(owner.drained_at)
    || String(owner.abort_requested_at) > String(owner.ended_at) || String(owner.drained_at) > String(owner.ended_at)
    || String(owner.ended_at) > requestedAt || !hasDelegationRunnerStart(database, runId, source)) return undefined;
  for (const at of [owner.registered_at, owner.drained_at, owner.abort_requested_at, owner.ended_at]) delegationTimestamp(at);
  if (!database.prepare(`SELECT 1 FROM run_sessions r JOIN work_unit_attempts a ON a.work_unit_id=r.work_unit_id
    WHERE r.id=? AND a.id=? AND a.work_unit_id=? AND a.runtime_instance_id=? AND a.fencing_token=?`)
    .get(owner.parent_run_id!, parent.attemptId, parent.workUnitId, parent.runtimeInstanceId, parent.fencingToken)) return undefined;
  if (!database.prepare(`SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason='recovery' AND released_at IS NULL`)
    .get(row.body_artifact_id!, harnessArtifactOwnerHolder("delegation_step", String(owner.step_id)))) return undefined;
  for (const table of ["resource_leases", "runtime_semaphore_slots"]) {
    if (database.prepare(`SELECT 1 FROM ${table} WHERE work_unit_id=? AND attempt_id=? AND status='active' LIMIT 1`)
      .get(source.workUnitId, source.attemptId)) return undefined;
  }
  if (database.prepare(`SELECT 1 FROM delegation_budget_charges WHERE run_id=? AND attempt_id=?
    AND state NOT IN ('measured','cancelled_before_dispatch') LIMIT 1`).get(runId, source.attemptId)) return undefined;
  if (!hasStoppedControl(database, source, String(owner.step_id), String(owner.parent_run_id), String(owner.ended_at), requestedAt)) return undefined;
  const hostSource = { runId, ...source };
  const covered = isNativeCompletionSource(database, hostSource)
    ? readNativeAttemptEffectStatus(database, hostSource, owner.native_effect_inventory_json, "exact_attempt") === "settled"
    : owner.effect_coverage === "pi_no_tools_v1"
      || readTrackedToolCoverage(database, hostSource, owner.tracked_tool_calls_json, requestedAt, "exact_attempt");
  if (!covered) return undefined;
  assertUserInputDurableQuiescence(database, runId, source, Date.parse(requestedAt), "exact_attempt");
  return source;
}

function hasStoppedControl(database: DatabaseSync, source: RuntimeAttemptFenceV1, stepId: string,
  parentRunId: string, endedAt: string, requestedAt: string): boolean {
  const rows = database.prepare(`SELECT m.*,a.run_id,a.path,a.type,a.content_type,a.sealed_payload_json,a.content_sha256
    FROM delegation_messages m JOIN artifacts a ON a.id=m.body_artifact_id WHERE m.delegation_step_id=?
      AND m.direction='parent_to_child' AND m.kind='control'
      AND json_extract(a.sealed_payload_json,'$.kind')='delegation.interrupt.v1'
      AND json_extract(a.sealed_payload_json,'$.sourceFence.attemptId')=? LIMIT 2`).all(stepId, source.attemptId);
  if (rows.length !== 1) return false;
  const row = rows[0]!;
  if (row.run_id !== parentRunId || row.path !== "sqlite:delegation-control" || row.type !== "json"
    || row.content_type !== "application/json" || typeof row.sealed_payload_json !== "string") return false;
  const value = delegationRecord(JSON.parse(row.sealed_payload_json), ["schemaVersion", "kind", "parentFence", "sourceFence", "callId", "requestedAt"]);
  const parent = delegationFence(value.parentFence), callId = delegationId(value.callId), at = delegationTimestamp(value.requestedAt);
  if (value.schemaVersion !== 1 || value.kind !== "delegation.interrupt.v1" || !same(delegationFence(value.sourceFence), source)
    || at !== row.created_at || at > endedAt || endedAt > requestedAt || row.idempotency_key !== `delegation-interrupt:${parent.attemptId}:${callId}`
    || row.content_sha256 !== row.digest || delegationDigest(value) !== row.digest
    || readHarnessRetainedBody(database, String(row.body_artifact_id)).contentSha256 !== row.digest) return false;
  if (!database.prepare(`SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason='recovery' AND released_at IS NULL`)
    .get(row.body_artifact_id!, harnessArtifactOwnerHolder("delegation_step", stepId))) return false;
  if (!database.prepare(`SELECT 1 FROM run_sessions r JOIN work_unit_attempts a ON a.work_unit_id=r.work_unit_id
    WHERE r.id=? AND a.id=? AND a.work_unit_id=? AND a.runtime_instance_id=? AND a.fencing_token=?`)
    .get(parentRunId, parent.attemptId, parent.workUnitId, parent.runtimeInstanceId, parent.fencingToken)) return false;
  const audit = database.prepare(`SELECT ts,data_json FROM runtime_events WHERE work_unit_id=? AND attempt_id=?
    AND runtime_instance_id=? AND fencing_token=? AND type='work_unit_cancelled' AND actor='system'
    AND json_extract(data_json,'$.kind')='delegation_interrupted' LIMIT 2`)
    .all(source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken);
  return audit.length === 1 && audit[0]!.ts === endedAt && typeof audit[0]!.data_json === "string"
    && same(JSON.parse(audit[0]!.data_json as string), { kind: "delegation_interrupted", stepId });
}
