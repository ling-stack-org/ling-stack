import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual as same } from "node:util";
import { delegationDigest, delegationFence, delegationId, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import { RunSuspensionActivationError, type RootRunSuspensionActivationRecord, type RootRunSuspensionActivationV1 } from "../../run-suspension-activation-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { readRunSuspensionStopRecord, stopDigest } from "./run-suspension-stop-records.js";
import { runSuspensionWitnessArtifactIds } from "./run-suspension-dependencies.js";
import { parseRunSuspensionWitness, suspensionWitnessModelDigest, suspensionWitnessIdentity } from "./run-suspension-witness.js";

export function activationFail(code: string): never { throw new RunSuspensionActivationError(code); }

export function readRootSuspensionActivationRecord(database: DatabaseSync, suspensionId: string): RootRunSuspensionActivationRecord | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='run_suspension_root_activations' AND type='table'").get()) {
    if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=198").get()) activationFail("schema_missing");
    return undefined;
  }
  const row = database.prepare("SELECT * FROM run_suspension_root_activations WHERE suspension_id=?").get(delegationId(suspensionId));
  if (!row) return undefined;
  const body = readHarnessRetainedBody(database, String(row.artifact_id));
  const artifact = database.prepare("SELECT * FROM artifacts WHERE id=?").get(row.artifact_id!);
  if (body.bytes > 1_048_576 || body.contentSha256 !== row.digest || !artifact || artifact.run_id !== row.run_id || artifact.type !== "json"
    || artifact.path !== "sqlite:run-suspension-root-activation" || artifact.content_type !== "application/vnd.ling.run-suspension-root-activation+json"
    || typeof artifact.sealed_payload_json !== "string") activationFail("artifact_invalid");
  const value = delegationRecord(JSON.parse(artifact.sealed_payload_json as string), ["schemaVersion", "kind", "id", "suspensionId", "runId",
    "sourceFence", "targetFence", "stoppedReceiptArtifactId", "stoppedReceiptDigest", "replayArtifactId", "replayDigest", "modelViewArtifactId",
    "continuationId", "inputDigest", "rootBudgetDigest", "activatedAt"]);
  for (const key of ["id", "suspensionId", "runId", "stoppedReceiptArtifactId", "replayArtifactId", "modelViewArtifactId", "continuationId"]) delegationId(value[key]);
  for (const key of ["stoppedReceiptDigest", "replayDigest", "inputDigest", "rootBudgetDigest"]) stopDigest(value[key]);
  const source = delegationFence(value.sourceFence), target = delegationFence(value.targetFence);
  if (value.schemaVersion !== 1 || value.kind !== "run.suspension_root_activation.v1" || value.id !== row.id || value.suspensionId !== suspensionId
    || value.runId !== row.run_id || source.attemptId !== row.source_attempt_id || target.attemptId !== row.target_attempt_id
    || source.workUnitId !== target.workUnitId || source.attemptId === target.attemptId || source.runtimeInstanceId === target.runtimeInstanceId
    || value.continuationId !== row.continuation_id || delegationTimestamp(value.activatedAt) !== row.activated_at
    || delegationDigest(value) !== row.digest) activationFail("artifact_invalid");
  const stop = readRunSuspensionStopRecord(database, suspensionId);
  if (!stop?.receipt || stop.begin.source.kind !== "root" || stop.begin.runId !== value.runId || !same(stop.begin.sourceFence, source)
    || stop.receiptArtifactId !== value.stoppedReceiptArtifactId || stop.receiptDigest !== value.stoppedReceiptDigest
    || stop.receipt.stoppedAt > String(value.activatedAt)) activationFail("stopped_proof_changed");
  const owner = database.prepare(`SELECT a.runtime_instance_id,a.fencing_token,a.work_unit_id,a.attempt_number,a.runner_id,
    p.runtime_instance_id AS source_runtime,p.fencing_token AS source_token,p.attempt_number AS source_number,
    p.status AS source_status,p.error_code AS source_error,p.ended_at AS source_ended,p.abort_requested_at AS source_abort,p.runner_id AS source_runner,
    c.run_id,c.work_unit_id AS continuation_unit,c.source_attempt_id,c.target_attempt_id,c.origin,c.strategy,c.context_snapshot_artifact_id
    FROM work_unit_attempts a JOIN runner_continuations c ON c.target_attempt_id=a.id
    JOIN work_unit_attempts p ON p.id=c.source_attempt_id AND p.work_unit_id=a.work_unit_id WHERE a.id=? AND c.id=?`)
    .get(target.attemptId, value.continuationId as string);
  if (!owner || owner.run_id !== value.runId || owner.continuation_unit !== target.workUnitId || owner.work_unit_id !== target.workUnitId
    || owner.source_attempt_id !== source.attemptId || owner.origin !== "daemon_recovery" || owner.strategy !== "deterministic_replay"
    || owner.runtime_instance_id !== target.runtimeInstanceId || owner.fencing_token !== target.fencingToken
    || owner.context_snapshot_artifact_id !== value.replayArtifactId || owner.source_runtime !== source.runtimeInstanceId
    || owner.source_token !== source.fencingToken || typeof owner.source_number !== "number" || owner.attempt_number !== owner.source_number + 1
    || owner.source_status !== "lost" || owner.source_error !== "runtime_graceful_suspend" || owner.source_ended !== stop.receipt.stoppedAt
    || owner.source_abort !== null || owner.runner_id !== owner.source_runner) activationFail("successor_changed");
  const saved = database.prepare("SELECT seal_artifact_id,seal_digest FROM run_suspensions WHERE id=? AND state='sealed'").get(suspensionId);
  if (!saved || saved.seal_digest !== stop.begin.sealDigest
    || readHarnessRetainedBody(database, String(saved.seal_artifact_id)).contentSha256 !== saved.seal_digest) activationFail("seal_changed");
  const seal = JSON.parse(String(database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id=?").get(saved.seal_artifact_id!)?.sealed_payload_json));
  const witness = parseRunSuspensionWitness(seal.witness);
  if (!same(suspensionWitnessIdentity(witness).sourceFence, source) || seal.modelViewArtifactId !== value.modelViewArtifactId
    || readHarnessRetainedBody(database, String(value.modelViewArtifactId)).contentSha256 !== suspensionWitnessModelDigest(witness)
    || witness.kind === "compaction" && witness.checkpoint.summaryArtifactId !== value.modelViewArtifactId) activationFail("seal_changed");
  for (const artifactId of [String(row.artifact_id), String(value.replayArtifactId), String(value.modelViewArtifactId), String(value.stoppedReceiptArtifactId),
    ...runSuspensionWitnessArtifactIds({ database }, witness)]) {
    for (const [kind, reason] of [["run_suspension_activation", "recovery"], ["run_suspension_activation_audit", "audit_hold"]] as const) {
      if (!database.prepare("SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason=? AND released_at IS NULL")
        .get(artifactId, harnessArtifactOwnerHolder(kind, String(row.id)), reason)) activationFail("pin_missing");
    }
  }
  if (readHarnessRetainedBody(database, String(value.replayArtifactId)).contentSha256 !== value.replayDigest) activationFail("replay_changed");
  return { artifactId: String(row.artifact_id), digest: String(row.digest), activation: value as unknown as RootRunSuspensionActivationV1 };
}

/** Historical reading qualification only. Never grants admission, dispatch or a current execution owner. */
export function hasRootSuspensionTargetLineage(database: DatabaseSync, source: { readonly runId: string } & RuntimeAttemptFenceV1,
  suspensionId?: string): boolean {
  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='run_suspension_root_activations' AND type='table'").get()) return false;
    const row = database.prepare("SELECT suspension_id FROM run_suspension_root_activations WHERE run_id=? AND target_attempt_id=?").get(source.runId, source.attemptId);
    const record = row ? readRootSuspensionActivationRecord(database, String(row.suspension_id)) : undefined;
    if (!record || !same(record.activation.targetFence, { workUnitId: source.workUnitId, attemptId: source.attemptId,
      runtimeInstanceId: source.runtimeInstanceId, fencingToken: source.fencingToken })) return false;
    // A later graceful restart must consume each earlier latch through its
    // original immutable edge, not merely share the same logical Run id.
    if (suspensionId !== undefined) {
      let cursor = record, found = false;
      const visited = new Set<string>();
      for (let depth = 0; depth < 128; depth++) {
        if (visited.has(cursor.activation.id)) return false;
        visited.add(cursor.activation.id);
        if (cursor.activation.suspensionId === suspensionId) { found = true; break; }
        const previous = database.prepare("SELECT suspension_id FROM run_suspension_root_activations WHERE run_id=? AND target_attempt_id=?")
          .get(source.runId, cursor.activation.sourceFence.attemptId);
        const parent = previous ? readRootSuspensionActivationRecord(database, String(previous.suspension_id)) : undefined;
        if (!parent || !same(parent.activation.targetFence, cursor.activation.sourceFence)
          || parent.activation.activatedAt > cursor.activation.activatedAt) return false;
        cursor = parent;
      }
      if (!found) return false;
    }
    return Boolean(database.prepare(`SELECT 1 FROM work_units u JOIN run_sessions r ON r.work_unit_id=u.id AND r.id=u.linked_run_id
      JOIN work_unit_attempts a ON a.work_unit_id=u.id WHERE r.id=? AND r.parent_run_id IS NULL AND u.id=?
        AND a.id=? AND a.runtime_instance_id=? AND a.fencing_token=?`)
      .get(source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken));
  } catch { return false; }
}

/** Live admission requires immutable lineage AND the exact current nonterminal owner. */
export function hasRootSuspensionActivatedTarget(database: DatabaseSync, source: { readonly runId: string } & RuntimeAttemptFenceV1,
  suspensionId?: string): boolean {
  return hasRootSuspensionTargetLineage(database, source, suspensionId) && Boolean(database.prepare(`SELECT 1
    FROM work_units u JOIN run_sessions r ON r.work_unit_id=u.id AND r.id=u.linked_run_id
    JOIN work_unit_attempts a ON a.id=u.active_attempt_id AND a.work_unit_id=u.id WHERE r.id=? AND r.parent_run_id IS NULL
      AND r.status='running' AND r.ended_at IS NULL AND u.id=? AND u.status IN ('queued','claimed','running') AND u.ended_at IS NULL
      AND a.id=? AND a.runtime_instance_id=? AND a.fencing_token=? AND a.status IN ('created','started')
      AND a.ended_at IS NULL AND a.abort_requested_at IS NULL`)
    .get(source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken));
}
