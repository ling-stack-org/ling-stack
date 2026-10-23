import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { delegationDigest, delegationFence, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { readRunSuspensionStopRecord } from "./run-suspension-stop-records.js";
import { mapRuntimeEvent } from "./runtime-work-mappers.js";
import { isNativeCompletionSource, readNativeAttemptEffectStatus } from "./host-attempt-native-coverage.js";
import { readTrackedToolCoverage } from "./host-attempt-tracked-coverage.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { hasDelegationStoppedHandoff } from "./delegation-stopped-handoff.js";
import { readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";

/** Resource-release exception only. A valid receipt cannot activate a new Attempt. */
export function hasRunSuspensionStoppedHandoff(database: DatabaseSync, rawFence: RuntimeAttemptFenceV1, rawAt: string): boolean {
  try {
    const fence = delegationFence(rawFence), at = delegationTimestamp(rawAt);
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='run_suspension_stops' AND type='table'").get()) return false;
    const saved = database.prepare("SELECT suspension_id FROM run_suspension_stops WHERE attempt_id=? AND state='stopped'").get(fence.attemptId);
    const record = saved ? readRunSuspensionStopRecord(database, String(saved.suspension_id)) : undefined;
    if (!record?.receipt || !isDeepStrictEqual(record.begin.sourceFence, fence)
      || record.receipt.stoppedAt > at) return false;
    if (record.begin.source.kind === "delegated") {
      const source = record.begin.source;
      const message = database.prepare("SELECT * FROM delegation_messages WHERE id=?").get(source.interruptMessageId);
      if (!message || message.delegation_step_id !== source.stepId || message.body_artifact_id !== source.interruptArtifactId
        || message.digest !== source.interruptDigest || message.direction !== "parent_to_child" || message.kind !== "control"
        || readHarnessRetainedBody(database, source.interruptArtifactId).contentSha256 !== source.interruptDigest) return false;
      const rows = database.prepare(`SELECT * FROM runtime_events WHERE work_unit_id=? AND attempt_id=? AND runtime_instance_id=?
        AND fencing_token=? AND type IN ('work_unit_succeeded','work_unit_failed','work_unit_cancelled','work_unit_stale') LIMIT 2`)
        .all(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
      if (rows.length !== 1) return false;
      const audit = mapRuntimeEvent(rows[0]!);
      return audit.type === "work_unit_cancelled" && audit.ts === record.receipt.stoppedAt && audit.seq === record.receipt.audit.seq
        && delegationDigest(audit) === record.receipt.audit.digest && isDeepStrictEqual(audit.data, { kind: "delegation_interrupted", stepId: source.stepId })
        && hasDelegationStoppedHandoff(database, fence, at);
    }
    const owner = database.prepare(`SELECT a.status AS attempt_status,a.error_code,a.ended_at,a.abort_requested_at,
      u.status AS unit_status,r.status AS run_status,r.ended_at AS run_ended_at,r.parent_run_id,c.*
      FROM work_unit_attempts a JOIN work_units u ON u.id=a.work_unit_id AND u.active_attempt_id=a.id
      JOIN run_sessions r ON r.id=u.linked_run_id AND r.work_unit_id=u.id
      JOIN host_attempt_completions c ON c.run_id=r.id AND c.work_unit_id=u.id AND c.attempt_id=a.id
        AND c.runtime_instance_id=a.runtime_instance_id AND c.fencing_token=a.fencing_token
      WHERE a.id=? AND a.work_unit_id=? AND a.runtime_instance_id=? AND a.fencing_token=? AND r.id=?`)
      .get(fence.attemptId, fence.workUnitId, fence.runtimeInstanceId, fence.fencingToken, record.begin.runId);
    if (!owner || owner.attempt_status !== "lost" || owner.error_code !== "runtime_graceful_suspend" || owner.ended_at !== record.receipt.stoppedAt
      || owner.abort_requested_at !== null || owner.unit_status !== "stale" || owner.run_status !== "running" || owner.run_ended_at !== null
      || owner.parent_run_id !== null || owner.drained_at !== record.receipt.drainedAt || typeof owner.registered_at !== "string"
      || owner.registered_at > record.begin.begunAt || String(owner.drained_at) > record.receipt.stoppedAt) return false;
    const audits = database.prepare(`SELECT * FROM runtime_events WHERE work_unit_id=? AND attempt_id=? AND runtime_instance_id=?
      AND fencing_token=? AND type IN ('work_unit_succeeded','work_unit_failed','work_unit_cancelled','work_unit_stale') LIMIT 2`)
      .all(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
    if (audits.length !== 1) return false;
    const audit = mapRuntimeEvent(audits[0]!);
    if (audit.type !== "work_unit_stale" || audit.ts !== record.receipt.stoppedAt || audit.seq !== record.receipt.audit.seq
      || delegationDigest(audit) !== record.receipt.audit.digest || !isDeepStrictEqual(audit.data,
        { kind: "run_suspension_stopped_v1", suspensionId: record.suspensionId, beginDigest: record.beginDigest, sealDigest: record.begin.sealDigest })) return false;
    const source = { runId: record.begin.runId, ...fence }, native = isNativeCompletionSource(database, source);
    if (native ? readNativeAttemptEffectStatus(database, source, owner.native_effect_inventory_json) !== "settled"
      : owner.effect_coverage !== "pi_no_tools_v1" && !readTrackedToolCoverage(database, source, owner.tracked_tool_calls_json, at)) return false;
    assertUserInputDurableQuiescence(database, source.runId, fence, Date.parse(at));
    return true;
  } catch { return false; }
}
