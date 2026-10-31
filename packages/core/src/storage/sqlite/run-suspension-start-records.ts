import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual as same } from "node:util";
import { delegationDigest, delegationFence, delegationId, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import { RunSuspensionStartError, type RootRunSuspensionStartObservationV1, type RootRunSuspensionStartRecord,
  type RootRunSuspensionStartV1 } from "../../run-suspension-start-types.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { readRootSuspensionActivationRecord } from "./run-suspension-activation-records.js";
import { stopDigest } from "./run-suspension-stop-records.js";

export function startFail(code: string): never { throw new RunSuspensionStartError(code); }

export function rootSuspensionStartObservation(raw: unknown): RootRunSuspensionStartObservationV1 {
  const value = delegationRecord(raw, ["schemaVersion", "kind", "activationId", "runId", "targetFence", "continuationId", "taskId",
    "preparedInputFingerprint", "runnerId", "observationId", "observedAt"]);
  if (value.schemaVersion !== 1 || value.kind !== "run.suspension_start_observation.v1") startFail("observation_invalid");
  return { schemaVersion: 1, kind: "run.suspension_start_observation.v1", activationId: delegationId(value.activationId),
    runId: delegationId(value.runId), targetFence: delegationFence(value.targetFence), continuationId: delegationId(value.continuationId),
    taskId: delegationId(value.taskId), preparedInputFingerprint: stopDigest(value.preparedInputFingerprint), runnerId: delegationId(value.runnerId),
    observationId: delegationId(value.observationId), observedAt: delegationTimestamp(value.observedAt) };
}

/** Audit only. A stored ACK never recreates a dispatch capability after a crash. */
export function readRootSuspensionStartRecord(database: DatabaseSync, suspensionId: string): RootRunSuspensionStartRecord | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='run_suspension_root_starts' AND type='table'").get()) {
    if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=199").get()) startFail("schema_missing");
    return undefined;
  }
  const row = database.prepare("SELECT * FROM run_suspension_root_starts WHERE suspension_id=?").get(delegationId(suspensionId));
  if (!row) return undefined;
  const retained = readHarnessRetainedBody(database, String(row.artifact_id));
  const artifact = database.prepare("SELECT * FROM artifacts WHERE id=?").get(row.artifact_id!);
  if (retained.bytes > 65_536 || retained.contentSha256 !== row.digest || !artifact || artifact.run_id !== row.run_id || artifact.type !== "json"
    || artifact.path !== "sqlite:run-suspension-root-start" || artifact.content_type !== "application/vnd.ling.run-suspension-root-start+json"
    || typeof artifact.sealed_payload_json !== "string") startFail("artifact_invalid");
  const value = delegationRecord(JSON.parse(artifact.sealed_payload_json as string), ["schemaVersion", "kind", "id", "suspensionId",
    "activationArtifactId", "activationDigest", "observation", "inputDigest", "rootBudgetDigest", "acknowledgedAt"]);
  const observation = rootSuspensionStartObservation(value.observation);
  for (const key of ["id", "suspensionId", "activationArtifactId"]) delegationId(value[key]);
  for (const key of ["activationDigest", "inputDigest", "rootBudgetDigest"]) stopDigest(value[key]);
  const activation = readRootSuspensionActivationRecord(database, suspensionId);
  if (value.schemaVersion !== 1 || value.kind !== "run.suspension_root_start.v1" || value.id !== row.id || value.suspensionId !== suspensionId
    || observation.activationId !== row.activation_id || observation.runId !== row.run_id || observation.targetFence.attemptId !== row.target_attempt_id
    || observation.continuationId !== row.continuation_id || observation.observationId !== row.observation_id
    || delegationTimestamp(value.acknowledgedAt) !== row.acknowledged_at || observation.observedAt > String(value.acknowledgedAt)
    || delegationDigest(value) !== row.digest || !activation || activation.activation.id !== row.activation_id
    || activation.artifactId !== value.activationArtifactId || activation.digest !== value.activationDigest
    || activation.activation.runId !== observation.runId || activation.activation.continuationId !== observation.continuationId
    || !same(activation.activation.targetFence, observation.targetFence) || activation.activation.activatedAt > observation.observedAt
    || activation.activation.rootBudgetDigest !== value.rootBudgetDigest) startFail("activation_changed");
  for (const artifactId of [String(row.artifact_id), String(value.activationArtifactId), activation.activation.replayArtifactId,
    activation.activation.modelViewArtifactId, activation.activation.stoppedReceiptArtifactId]) {
    for (const [kind, reason] of [["run_suspension_start", "recovery"], ["run_suspension_start_audit", "audit_hold"]] as const) {
      if (!database.prepare("SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason=? AND released_at IS NULL")
        .get(artifactId, harnessArtifactOwnerHolder(kind, String(row.id)), reason)) startFail("pin_missing");
    }
  }
  return { artifactId: String(row.artifact_id), digest: String(row.digest), start: value as unknown as RootRunSuspensionStartV1 };
}

/** Non-184 Attempts retain their existing start contract; 184 targets require their original immutable199 ACK. */
export function rootSuspensionStartAllowsAttempt(database: DatabaseSync, attemptId: string): boolean {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='run_suspension_root_activations' AND type='table'").get()) return true;
  const row = database.prepare("SELECT suspension_id FROM run_suspension_root_activations WHERE target_attempt_id=?").get(attemptId);
  if (!row) return true;
  return Boolean(readRootSuspensionStartRecord(database, String(row.suspension_id)));
}

/** New child effects need an actually ACKed recovery ancestor, not a caller-set started flag. */
export function assertRootSuspensionStartAdmission(database: DatabaseSync, runId: string): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='run_suspension_root_activations' AND type='table'").get()) return;
  const ancestors = database.prepare(`WITH RECURSIVE a(id,parent_run_id,depth) AS (
    SELECT id,parent_run_id,0 FROM run_sessions WHERE id=? UNION ALL
    SELECT r.id,r.parent_run_id,a.depth+1 FROM run_sessions r JOIN a ON r.id=a.parent_run_id WHERE a.depth<128
  ) SELECT a.depth,a.id,u.active_attempt_id FROM a JOIN run_sessions r ON r.id=a.id
    LEFT JOIN work_units u ON u.id=r.work_unit_id`).all(delegationId(runId));
  for (const row of ancestors) {
    if (row.depth === 128) startFail("admission_closed");
    if (!database.prepare("SELECT 1 FROM run_suspension_root_activations WHERE run_id=? LIMIT 1").get(row.id!)) continue;
    const activation = database.prepare("SELECT suspension_id FROM run_suspension_root_activations WHERE run_id=? AND target_attempt_id=?")
      .get(row.id!, row.active_attempt_id ?? null);
    if (!activation || !readRootSuspensionStartRecord(database, String(activation.suspension_id))) startFail("admission_closed");
  }
}
