import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual as same } from "node:util";
import { delegationDigest, delegationFence, delegationId, delegationPreparedExecutionDigest,
  delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import type { DelegationRunnerStartObservation } from "../../harness/delegation-lifecycle-types.js";
import { RunDelegatedSuspensionError, type DelegatedRunSuspensionActivationRecord,
  type DelegatedRunSuspensionActivationV1, type DelegatedRunSuspensionStartRecord,
  type DelegatedRunSuspensionStartV1 } from "../../run-suspension-delegated-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody } from "./harness-artifact-recovery-pins.js";
import { readRootSuspensionActivationRecord } from "./run-suspension-activation-records.js";
import { readRootSuspensionStartRecord } from "./run-suspension-start-records.js";
import { readRunSuspensionStopRecord, stopDigest } from "./run-suspension-stop-records.js";
import { mapRuntimeEvent } from "./runtime-work-mappers.js";
import { hasDelegationRunnerStart, readDelegationResumePredecessor } from "./delegation-resume-lineage.js";
import { runSuspensionWitnessArtifactIds } from "./run-suspension-dependencies.js";
import { parseRunSuspensionWitness, suspensionWitnessModelDigest, suspensionWitnessIdentity } from "./run-suspension-witness.js";

export function delegatedSuspensionFail(code: string): never { throw new RunDelegatedSuspensionError(code); }
function fail(code: string): never { return delegatedSuspensionFail(code); }
const activationTable = "run_suspension_delegated_activations";
const startTable = "run_suspension_delegated_starts";
const maximumDepth = 128;
type ReadScope = { readonly visiting: Set<string>; depth: number };
const scope = (): ReadScope => ({ visiting: new Set(), depth: 0 });

export interface DelegatedSuspensionParentStart {
  readonly artifactId: string;
  readonly digest: string;
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly targetFence: RuntimeAttemptFenceV1;
  readonly acknowledgedAt: string;
}

function hasTable(database: DatabaseSync, table: string): boolean {
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return true;
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=186").get()) fail("schema_missing");
  return false;
}
function within<T>(read: ReadScope, key: string, body: () => T): T {
  const activation = key.startsWith("activation:");
  if (activation && read.depth >= maximumDepth || read.visiting.has(key)) fail("lineage_cycle");
  if (activation) read.depth++;
  read.visiting.add(key);
  try { return body(); }
  finally { read.visiting.delete(key); if (activation) read.depth--; }
}
function pins(database: DatabaseSync, owner: string, id: string, artifactIds: readonly string[]): void {
  for (const artifactId of new Set(artifactIds)) {
    for (const [kind, reason] of [[owner, "recovery"], [`${owner}_audit`, "audit_hold"]] as const) {
      if (!database.prepare("SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason=? AND released_at IS NULL")
        .get(artifactId, harnessArtifactOwnerHolder(kind, id), reason)) fail("pin_missing");
    }
  }
}
function body(database: DatabaseSync, artifactId: string, runId: string, digest: string, kind: "activation" | "start"): Record<string, unknown> {
  const retained = readHarnessRetainedBody(database, artifactId);
  const artifact = database.prepare("SELECT * FROM artifacts WHERE id=?").get(artifactId);
  if (retained.bytes > 1_048_576 || retained.contentSha256 !== digest || !artifact || artifact.run_id !== runId
    || artifact.type !== "json" || artifact.path !== `sqlite:run-suspension-delegated-${kind}`
    || artifact.content_type !== `application/vnd.ling.run-suspension-delegated-${kind}+json`
    || typeof artifact.sealed_payload_json !== "string") fail("artifact_invalid");
  const value: unknown = JSON.parse(artifact.sealed_payload_json as string);
  if (delegationDigest(value) !== digest || !value || typeof value !== "object" || Array.isArray(value)) fail("artifact_invalid");
  return value as Record<string, unknown>;
}

/** Immutable audit lookup; current pointer/status never qualifies historical ownership. */
export function readDelegatedSuspensionActivationRecord(database: DatabaseSync, suspensionId: string): DelegatedRunSuspensionActivationRecord | undefined {
  return readActivation(database, delegationId(suspensionId), scope());
}
function readActivation(database: DatabaseSync, suspensionId: string, read: ReadScope): DelegatedRunSuspensionActivationRecord | undefined {
  if (!hasTable(database, activationTable)) return undefined;
  const row = database.prepare(`SELECT * FROM ${activationTable} WHERE suspension_id=?`).get(suspensionId);
  if (!row) return undefined;
  return within(read, `activation:${suspensionId}`, () => {
    const value = delegationRecord(body(database, String(row.artifact_id), String(row.run_id), String(row.digest), "activation"),
      ["schemaVersion", "kind", "id", "suspensionId", "runId", "rootRunId", "parentRunId", "stepId", "reservationId",
        "sourceFence", "targetFence", "parentFence", "parentStartArtifactId", "parentStartDigest", "stoppedReceiptArtifactId",
        "stoppedReceiptDigest", "modelViewArtifactId", "preparationArtifactId", "preparationDigest", "inputDigest",
        "rootBudgetDigest", "reservationDigest", "activatedAt"]);
    for (const key of ["id", "suspensionId", "runId", "rootRunId", "parentRunId", "stepId", "reservationId", "parentStartArtifactId",
      "stoppedReceiptArtifactId", "modelViewArtifactId", "preparationArtifactId"]) delegationId(value[key]);
    for (const key of ["parentStartDigest", "stoppedReceiptDigest", "preparationDigest", "inputDigest", "rootBudgetDigest", "reservationDigest"]) stopDigest(value[key]);
    const source = delegationFence(value.sourceFence), target = delegationFence(value.targetFence), parent = delegationFence(value.parentFence);
    const activatedAt = delegationTimestamp(value.activatedAt);
    if (value.schemaVersion !== 1 || value.kind !== "run.suspension_delegated_activation.v1" || value.id !== row.id
      || value.suspensionId !== suspensionId || value.runId !== row.run_id || value.rootRunId !== row.root_run_id
      || value.parentRunId !== row.parent_run_id || value.stepId !== row.step_id || value.reservationId !== row.reservation_id
      || source.attemptId !== row.source_attempt_id || target.attemptId !== row.target_attempt_id || parent.attemptId !== row.parent_attempt_id
      || value.runId === value.parentRunId || value.runId === value.rootRunId || source.workUnitId !== target.workUnitId
      || source.attemptId === target.attemptId || source.runtimeInstanceId === target.runtimeInstanceId
      || source.fencingToken === target.fencingToken || activatedAt !== row.activated_at) fail("artifact_invalid");
    const stopped = readRunSuspensionStopRecord(database, suspensionId);
    const stopSource = stopped?.begin.source;
    if (!stopped?.receipt || stopSource?.kind !== "delegated" || stopped.begin.runId !== value.runId
      || !same(stopped.begin.sourceFence, source) || stopped.receiptArtifactId !== value.stoppedReceiptArtifactId
      || stopped.receiptDigest !== value.stoppedReceiptDigest || stopped.receipt.stoppedAt > activatedAt
      || stopSource.reservationId !== value.reservationId || stopSource.stepId !== value.stepId
      || stopSource.parentRunId !== value.parentRunId) fail("stopped_proof_changed");
    const message = database.prepare("SELECT * FROM delegation_messages WHERE id=?").get(stopSource.interruptMessageId);
    const interrupt = database.prepare("SELECT * FROM artifacts WHERE id=?").get(stopSource.interruptArtifactId);
    if (!message || message.delegation_step_id !== value.stepId || message.direction !== "parent_to_child" || message.kind !== "control"
      || message.body_artifact_id !== stopSource.interruptArtifactId || message.digest !== stopSource.interruptDigest
      || !interrupt || interrupt.run_id !== value.parentRunId || typeof interrupt.sealed_payload_json !== "string"
      || readHarnessRetainedBody(database, stopSource.interruptArtifactId).contentSha256 !== stopSource.interruptDigest) fail("stopped_proof_changed");
    const control = delegationRecord(JSON.parse(interrupt.sealed_payload_json as string), ["schemaVersion", "kind", "parentFence", "sourceFence", "callId", "requestedAt"]);
    delegationId(control.callId);
    if (control.schemaVersion !== 1 || control.kind !== "delegation.interrupt.v1" || !same(delegationFence(control.sourceFence), source)
      || !same(delegationFence(control.parentFence), stopSource.parentFence) || delegationTimestamp(control.requestedAt) !== message.created_at
      || String(control.requestedAt) > stopped.begin.begunAt) fail("stopped_proof_changed");
    const audits = database.prepare(`SELECT * FROM runtime_events WHERE work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=?
      AND type IN ('work_unit_succeeded','work_unit_failed','work_unit_cancelled','work_unit_stale') LIMIT 2`)
      .all(source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken);
    if (audits.length !== 1) fail("stopped_proof_changed");
    const audit = mapRuntimeEvent(audits[0]!);
    if (audit.type !== "work_unit_cancelled" || audit.ts !== stopped.receipt.stoppedAt || audit.seq !== stopped.receipt.audit.seq
      || delegationDigest(audit) !== stopped.receipt.audit.digest || !same(audit.data, { kind: "delegation_interrupted", stepId: stopSource.stepId })) fail("stopped_proof_changed");
    const owner = database.prepare(`SELECT a.work_unit_id,a.runtime_instance_id,a.fencing_token,a.attempt_number,a.runner_id,a.created_at,
      p.runtime_instance_id AS source_runtime,p.fencing_token AS source_token,p.attempt_number AS source_number,p.runner_id AS source_runner,
      p.status AS source_status,p.error_code AS source_error,p.ended_at AS source_ended,p.abort_requested_at AS source_abort,
      r.parent_run_id,s.root_run_id,s.parent_run_id AS step_parent,s.child_run_id,b.root_run_id AS reservation_root,b.child_run_id AS reservation_child
      FROM work_unit_attempts a JOIN work_unit_attempts p ON p.id=? AND p.work_unit_id=a.work_unit_id
      JOIN work_units u ON u.id=a.work_unit_id JOIN run_sessions r ON r.id=u.linked_run_id AND r.work_unit_id=u.id
      JOIN delegation_steps s ON s.id=? AND s.child_run_id=r.id AND u.owner_type='delegation_step' AND u.owner_id=s.id
      JOIN delegation_budget_reservations b ON b.id=? AND b.delegation_step_id=s.id
      WHERE a.id=? AND r.id=?`).get(source.attemptId, String(value.stepId), String(value.reservationId), target.attemptId, String(value.runId));
    if (!owner || owner.work_unit_id !== target.workUnitId || owner.runtime_instance_id !== target.runtimeInstanceId
      || owner.fencing_token !== target.fencingToken || owner.source_runtime !== source.runtimeInstanceId || owner.source_token !== source.fencingToken
      || typeof owner.source_number !== "number" || owner.attempt_number !== owner.source_number + 1 || owner.runner_id !== owner.source_runner
      || owner.source_status !== "cancelled" || owner.source_error !== "delegation_interrupted" || !owner.source_abort
      || owner.source_ended !== stopped.receipt.stoppedAt || owner.created_at !== activatedAt || owner.created_at < owner.source_ended
      || owner.parent_run_id !== value.parentRunId || owner.step_parent !== value.parentRunId || owner.child_run_id !== value.runId
      || owner.root_run_id !== value.rootRunId || owner.reservation_root !== value.rootRunId || owner.reservation_child !== value.runId) fail("successor_changed");
    const parentStart = readParentStart(database, String(value.parentRunId), parent, read);
    if (!parentStart || parentStart.artifactId !== value.parentStartArtifactId || parentStart.digest !== value.parentStartDigest
      || !same(parentStart.sourceFence, stopSource.parentFence) || parentStart.acknowledgedAt > activatedAt) fail("parent_start_changed");
    const suspension = database.prepare("SELECT seal_artifact_id,seal_digest FROM run_suspensions WHERE id=? AND state='sealed'").get(suspensionId);
    if (!suspension || suspension.seal_digest !== stopped.begin.sealDigest) fail("seal_changed");
    const retainedSeal = readHarnessRetainedBody(database, String(suspension.seal_artifact_id));
    const seal = JSON.parse(String(database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id=?").get(suspension.seal_artifact_id!)?.sealed_payload_json)) as {
      modelViewArtifactId?: unknown; witness?: unknown;
    };
    const witness = parseRunSuspensionWitness(seal.witness);
    if (retainedSeal.contentSha256 !== suspension.seal_digest || seal.modelViewArtifactId !== value.modelViewArtifactId
      || !same(suspensionWitnessIdentity(witness).sourceFence, source)
      || witness.kind === "compaction" && witness.checkpoint.summaryArtifactId !== value.modelViewArtifactId
      || readHarnessRetainedBody(database, String(value.modelViewArtifactId)).contentSha256 !== suspensionWitnessModelDigest(witness)) fail("seal_changed");
    for (const id of runSuspensionWitnessArtifactIds({ database }, witness)) {
      readHarnessRetainedBody(database, id);
      for (const [kind, reason] of [["run_suspension", "recovery"], ["run_suspension_audit", "audit_hold"]] as const)
        if (!database.prepare("SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason=? AND released_at IS NULL")
          .get(id, harnessArtifactOwnerHolder(kind, suspensionId), reason)) fail("seal_changed");
    }
    const preparation = database.prepare("SELECT * FROM artifacts WHERE id=?").get(String(value.preparationArtifactId));
    const retainedPreparation = readHarnessRetainedBody(database, String(value.preparationArtifactId));
    if (!preparation || preparation.run_id !== value.runId || preparation.type !== "json" || preparation.path !== "sqlite:delegation-execution"
      || typeof preparation.sealed_payload_json !== "string" || retainedPreparation.contentSha256 !== value.preparationDigest) fail("preparation_changed");
    const prepared = JSON.parse(preparation.sealed_payload_json as string) as Record<string, unknown>;
    const preparedFence = delegationFence(prepared.sourceFence);
    const original = database.prepare("SELECT attempt_number,work_unit_id,runtime_instance_id,fencing_token FROM work_unit_attempts WHERE id=?").get(preparedFence.attemptId);
    if (delegationPreparedExecutionDigest(prepared) !== value.preparationDigest || prepared.schemaVersion !== 1 || prepared.kind !== "delegation.execution.v1"
      || prepared.childRunId !== value.runId || prepared.parentRunId !== value.parentRunId || prepared.rootRunId !== value.rootRunId
      || prepared.stepId !== value.stepId || prepared.reservationId !== value.reservationId || prepared.runnerId !== owner.runner_id
      || !original || original.attempt_number !== 1 || original.work_unit_id !== source.workUnitId || preparedFence.workUnitId !== source.workUnitId
      || original.runtime_instance_id !== preparedFence.runtimeInstanceId || original.fencing_token !== preparedFence.fencingToken) fail("preparation_changed");
    pins(database, "run_suspension_delegated_activation", String(row.id), [String(row.artifact_id), String(value.stoppedReceiptArtifactId),
      String(value.modelViewArtifactId), String(value.preparationArtifactId), String(value.parentStartArtifactId),
      ...runSuspensionWitnessArtifactIds({ database }, witness)]);
    return { artifactId: String(row.artifact_id), digest: String(row.digest), activation: value as unknown as DelegatedRunSuspensionActivationV1 };
  });
}

function observation(raw: unknown): DelegationRunnerStartObservation {
  const value = delegationRecord(raw, ["childRunId", "sourceFence", "runnerId", "observationId", "observedAt"]);
  return { childRunId: delegationId(value.childRunId), sourceFence: delegationFence(value.sourceFence), runnerId: delegationId(value.runnerId),
    observationId: delegationId(value.observationId), observedAt: delegationTimestamp(value.observedAt) };
}
/** Durable physical ACK audit only, never a redispatch/claim capability. */
export function readDelegatedSuspensionStartRecord(database: DatabaseSync, suspensionId: string): DelegatedRunSuspensionStartRecord | undefined {
  return readStart(database, delegationId(suspensionId), scope())?.record;
}
function readStart(database: DatabaseSync, suspensionId: string, read: ReadScope): {
  readonly record: DelegatedRunSuspensionStartRecord; readonly activation: DelegatedRunSuspensionActivationRecord;
} | undefined {
  if (!hasTable(database, startTable)) return undefined;
  const row = database.prepare(`SELECT * FROM ${startTable} WHERE suspension_id=?`).get(suspensionId);
  if (!row) return undefined;
  return within(read, `start:${suspensionId}`, () => {
    const value = delegationRecord(body(database, String(row.artifact_id), String(row.run_id), String(row.digest), "start"),
      ["schemaVersion", "kind", "id", "suspensionId", "activationArtifactId", "activationDigest", "observation", "acknowledgedAt"]);
    for (const key of ["id", "suspensionId", "activationArtifactId"]) delegationId(value[key]);
    stopDigest(value.activationDigest);
    const accepted = observation(value.observation), activation = readActivation(database, suspensionId, read);
    const acknowledgedAt = delegationTimestamp(value.acknowledgedAt);
    if (value.schemaVersion !== 1 || value.kind !== "run.suspension_delegated_start.v1" || value.id !== row.id || value.suspensionId !== suspensionId
      || accepted.childRunId !== row.run_id || accepted.sourceFence.attemptId !== row.target_attempt_id || accepted.observationId !== row.observation_id
      || acknowledgedAt !== row.acknowledged_at || accepted.observedAt > acknowledgedAt || !activation || activation.activation.id !== row.activation_id
      || activation.artifactId !== value.activationArtifactId || activation.digest !== value.activationDigest
      || activation.activation.runId !== accepted.childRunId || !same(activation.activation.targetFence, accepted.sourceFence)
      || activation.activation.activatedAt > accepted.observedAt) fail("activation_changed");
    const target = database.prepare("SELECT runner_id,effective_runner_id FROM work_unit_attempts WHERE id=?").get(accepted.sourceFence.attemptId);
    if (!target || accepted.runnerId !== (target.effective_runner_id ?? target.runner_id)) fail("observation_invalid");
    pins(database, "run_suspension_delegated_start", String(row.id), [String(row.artifact_id), String(value.activationArtifactId),
      activation.activation.modelViewArtifactId, activation.activation.preparationArtifactId, activation.activation.parentStartArtifactId]);
    return { record: { artifactId: String(row.artifact_id), digest: String(row.digest), start: value as unknown as DelegatedRunSuspensionStartV1 }, activation };
  });
}

export function readDelegatedSuspensionParentStart(database: DatabaseSync, parentRunId: string,
  parentFence: RuntimeAttemptFenceV1): DelegatedSuspensionParentStart | undefined {
  return readParentStart(database, delegationId(parentRunId), delegationFence(parentFence), scope());
}
function readParentStart(database: DatabaseSync, runId: string, fence: RuntimeAttemptFenceV1, read: ReadScope): DelegatedSuspensionParentStart | undefined {
  const parent = database.prepare("SELECT parent_run_id FROM run_sessions WHERE id=?").get(runId);
  if (!parent) return undefined;
  if (parent.parent_run_id === null) {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_suspension_root_activations'").get()) return undefined;
    const row = database.prepare("SELECT suspension_id FROM run_suspension_root_activations WHERE run_id=? AND target_attempt_id=?").get(runId, fence.attemptId);
    const started = row ? readRootSuspensionStartRecord(database, String(row.suspension_id)) : undefined;
    const activated = row ? readRootSuspensionActivationRecord(database, String(row.suspension_id)) : undefined;
    if (!started || !activated || !same(activated.activation.targetFence, fence)) return undefined;
    return { artifactId: started.artifactId, digest: started.digest, runId, sourceFence: activated.activation.sourceFence,
      targetFence: activated.activation.targetFence, acknowledgedAt: started.start.acknowledgedAt };
  }
  if (!hasTable(database, activationTable)) return undefined;
  const row = database.prepare(`SELECT suspension_id FROM ${activationTable} WHERE run_id=? AND target_attempt_id=?`).get(runId, fence.attemptId);
  const accepted = row ? readStart(database, String(row.suspension_id), read) : undefined;
  const started = accepted?.record, activated = accepted?.activation;
  if (!started || !activated || !same(activated.activation.targetFence, fence)) return undefined;
  return { artifactId: started.artifactId, digest: started.digest, runId, sourceFence: activated.activation.sourceFence,
    targetFence: activated.activation.targetFence, acknowledgedAt: started.start.acknowledgedAt };
}

/** Immutable source-to-target qualification remains usable after stop, terminal or replacement. */
export function hasDelegatedSuspensionTargetLineage(database: DatabaseSync, source: { readonly runId: string } & RuntimeAttemptFenceV1,
  suspensionId?: string): boolean {
  return hasTargetLineage(database, source, suspensionId, false);
}
/** Historical qualification also requires each successor's actual SDK ACK. */
export function hasDelegatedSuspensionStartedLineage(database: DatabaseSync, source: { readonly runId: string } & RuntimeAttemptFenceV1,
  suspensionId?: string): boolean {
  return hasTargetLineage(database, source, suspensionId, true);
}
function hasTargetLineage(database: DatabaseSync, source: { readonly runId: string } & RuntimeAttemptFenceV1,
  suspensionId: string | undefined, started: boolean): boolean {
  try {
    if (!hasTable(database, activationTable)) return false;
    const value = delegationRecord(source, ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]);
    const runId = delegationId(value.runId);
    let fence = delegationFence({ workUnitId: value.workUnitId, attemptId: value.attemptId,
      runtimeInstanceId: value.runtimeInstanceId, fencingToken: value.fencingToken });
    const required = suspensionId === undefined ? undefined : delegationId(suspensionId), visited = new Set<string>();
    let before: string | undefined;
    for (let depth = 0; depth < maximumDepth; depth++) {
      if (visited.has(fence.attemptId)) return false;
      visited.add(fence.attemptId);
      const row = database.prepare(`SELECT suspension_id FROM ${activationTable} WHERE run_id=? AND target_attempt_id=?`).get(runId, fence.attemptId);
      if (row) {
        const record = readDelegatedSuspensionActivationRecord(database, String(row.suspension_id));
        if (!record || !same(record.activation.targetFence, fence) || before !== undefined && record.activation.activatedAt > before
          || started && !readDelegatedSuspensionStartRecord(database, String(row.suspension_id))) return false;
        if (required === undefined || record.activation.suspensionId === required) return true;
        before = record.activation.activatedAt;
        fence = record.activation.sourceFence;
      } else {
        if (started && !hasDelegationRunnerStart(database, runId, fence)) return false;
        const previous = readDelegationResumePredecessor(database, runId, fence);
        if (!previous) return false;
        fence = previous;
      }
    }
    return false;
  } catch { return false; }
}
/** Live source selection is separate from immutable historical read qualification. */
export function hasDelegatedSuspensionActivatedTarget(database: DatabaseSync, source: { readonly runId: string } & RuntimeAttemptFenceV1,
  suspensionId?: string): boolean {
  return hasDelegatedSuspensionTargetLineage(database, source, suspensionId) && Boolean(database.prepare(`SELECT 1
    FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
    JOIN work_unit_attempts a ON a.id=u.active_attempt_id AND a.work_unit_id=u.id WHERE r.id=? AND r.parent_run_id IS NOT NULL
      AND r.status='running' AND r.ended_at IS NULL AND u.id=? AND u.status IN ('queued','claimed','running') AND u.ended_at IS NULL
      AND a.id=? AND a.runtime_instance_id=? AND a.fencing_token=? AND a.status IN ('created','started')
      AND a.ended_at IS NULL AND a.abort_requested_at IS NULL`)
    .get(source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken));
}

/** A pending186 target cannot be started or replaced by a generic writer. */
export function delegatedSuspensionStartAllowsAttempt(database: DatabaseSync, attemptId: string): boolean {
  if (!hasTable(database, activationTable)) return true;
  const row = database.prepare(`SELECT suspension_id FROM ${activationTable} WHERE target_attempt_id=?`).get(delegationId(attemptId));
  return !row || Boolean(readDelegatedSuspensionStartRecord(database, String(row.suspension_id)));
}
export function assertDelegatedSuspensionStartAdmission(database: DatabaseSync, runId: string): void {
  assertStartAdmission(database, runId, false);
}
/** Static created-child claim/dispatch checks its ancestors; actual effects also check itself. */
export function assertDelegatedSuspensionParentStartAdmission(database: DatabaseSync, runId: string): void {
  assertStartAdmission(database, runId, true);
}
function assertStartAdmission(database: DatabaseSync, runId: string, skipSelf: boolean): void {
  if (!hasTable(database, activationTable)) return;
  const visited = new Set<string>();
  let current: string | null = delegationId(runId);
  for (let depth = 0; current !== null; depth++) {
    if (depth >= maximumDepth || visited.has(current)) fail("admission_closed");
    visited.add(current);
    const run: Record<string, SQLOutputValue> | undefined = database.prepare(`SELECT r.id,r.parent_run_id,u.active_attempt_id FROM run_sessions r
      LEFT JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id WHERE r.id=?`).get(current);
    if (!run) fail("admission_closed");
    if (!(skipSelf && depth === 0) && database.prepare(`SELECT 1 FROM ${activationTable} WHERE run_id=? LIMIT 1`).get(current)) {
      const attempt = database.prepare("SELECT work_unit_id,runtime_instance_id,fencing_token FROM work_unit_attempts WHERE id=?")
        .get(run.active_attempt_id ?? null);
      if (!attempt || !hasDelegatedSuspensionStartedLineage(database, { runId: current, workUnitId: String(attempt.work_unit_id),
        attemptId: String(run.active_attempt_id), runtimeInstanceId: String(attempt.runtime_instance_id),
        fencingToken: String(attempt.fencing_token) })) fail("admission_closed");
    }
    current = run.parent_run_id === null ? null : delegationId(run.parent_run_id);
  }
}
