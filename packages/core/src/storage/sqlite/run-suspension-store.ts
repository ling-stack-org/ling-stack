import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQLOutputValue } from "node:sqlite";
import { delegationDigest, delegationFence, delegationId, delegationInteger, delegationJson, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import { captureRunProgressCheckpointLineage, type RunProgressLineageStore } from "../../run-progress-checkpoint-lineage.js";
import { RUN_PROGRESS_MAX_PAYLOAD_BYTES, type RunProgressCheckpointLineage } from "../../run-progress-checkpoint-types.js";
import { RunSuspensionError, type RequestRunSuspensionInput, type RunSuspensionCause, type RunSuspensionErrorCode,
  type RunSuspensionWitness, type RunSuspensionRecord, type RunSuspensionRequestV1,
  type RunSuspensionSealV1, type SealRunSuspensionInput } from "../../run-suspension-types.js";
import type { CreateRunArtifactInput, RunArtifact, RunSession, RunStore } from "../../run-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody, syncHarnessArtifactOwnerPins } from "./harness-artifact-recovery-pins.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import { assertNoPendingRunTerminalIntent } from "./run-terminal-intent-store.js";
import { hasRootSuspensionActivatedTarget } from "./run-suspension-activation-records.js";
import { hasDelegatedSuspensionActivatedTarget, hasDelegatedSuspensionStartedLineage } from "./run-suspension-delegated-records.js";
import { hasDelegationStoppedHandoff } from "./delegation-stopped-handoff.js";
import { readRunSuspensionStopRecord } from "./run-suspension-stop-records.js";
import type { SqliteStoreContext } from "./store-context.js";
import { verifyRunCompactionSuspensionWitness } from "./run-compaction-suspension-witness.js";
import { runSuspensionWitnessArtifactIds } from "./run-suspension-dependencies.js";
import { verifyRunFinalSettlement } from "./run-final-settlement-store.js";
import { parseRunSuspensionWitness as witness, suspensionWitnessBoundary, suspensionWitnessModelDigest, suspensionWitnessIdentity } from "./run-suspension-witness.js";

type Ports = RunProgressLineageStore & Pick<RunStore, "getRun" | "getWorkUnitAttempt" | "getArtifact"
  | "readRunProgressCheckpointForRecovery" | "getChannelWorkflowStep" | "getChannelWorkflow"
  | "listEvents" | "listHarnessToolExecutions" | "listHostCommandWriteBlockers" | "listApprovalRequests"> & {
  readonly createArtifactWithinTransaction: (input: CreateRunArtifactInput) => RunArtifact;
};
type Row = Record<string, SQLOutputValue>;
const REQUEST_CONTENT_TYPE = "application/vnd.ling.run-suspension-request+json";
const SEAL_CONTENT_TYPE = "application/vnd.ling.run-suspension-seal+json";
const causes: readonly RunSuspensionCause[] = ["daemon_restart", "desktop_quit", "process_signal"];
const lineageKeys = ["workspaceId", "contextViewId", "contextViewCreatedAt", "providerPresetId", "providerName", "providerModel",
  "providerConfigurationFingerprint", "preparedExecutionFingerprint", "acceptedInstructionsFingerprint", "policySnapshotFingerprint",
  "policySourcesFingerprint", "workspaceProvenanceWatermark"];
function fail(code: RunSuspensionErrorCode): never { throw new RunSuspensionError(code); }
function digest(value: unknown): string { const text = delegationId(value); if (!/^[a-f0-9]{64}$/u.test(text)) fail("suspension.invalid_input"); return text; }
function lineage(raw: unknown): RunProgressCheckpointLineage {
  const row = delegationRecord(raw, lineageKeys);
  for (const key of lineageKeys) if (key !== "providerPresetId" || row[key] !== undefined) delegationId(row[key]);
  return { ...row } as unknown as RunProgressCheckpointLineage;
}

/** Admission veto only; its presence never proves a stopped process or an installable recovery view. */
export function hasPendingRunSuspension(context: SqliteStoreContext, input: { readonly runId: string } & RuntimeAttemptFenceV1): boolean {
  if (!hasSchema(context)) return false;
  return Boolean(context.database.prepare(`SELECT 1 FROM run_suspensions WHERE run_id=? AND work_unit_id=? AND attempt_id=?
    AND runtime_instance_id=? AND fencing_token=? AND state IN ('requested','sealed')`).get(input.runId,
      input.workUnitId, input.attemptId, input.runtimeInstanceId, input.fencingToken));
}

/** Original latches admit only the exact live owner with verified immutable successor lineage. */
export function assertNoRunSuspensionAdmission(context: SqliteStoreContext, runId: string): void {
  assertSuspensionAdmission(context, runId);
}

/** Explicit ordinary resume only: stopped/ACKed self may traverse its old latch.
 * Ancestors still need their exact live owner; this cannot admit tools or an
 * automatic recovery scan of a manually interrupted child. */
export function assertRunSuspensionResumeAdmission(context: SqliteStoreContext,
  source: { readonly runId: string } & RuntimeAttemptFenceV1, now: string): void {
  if (!hasSchema(context)) return;
  const owner = context.database.prepare(`SELECT 1 FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
    JOIN work_unit_attempts a ON a.id=u.active_attempt_id AND a.work_unit_id=u.id
    JOIN delegation_steps s ON s.id=u.owner_id AND u.owner_type='delegation_step' AND s.child_run_id=r.id AND s.parent_run_id=r.parent_run_id
    WHERE r.id=? AND r.status='running' AND r.ended_at IS NULL AND u.id=? AND u.status='cancelled' AND s.state='interrupted'
      AND a.id=? AND a.runtime_instance_id=? AND a.fencing_token=? AND a.status='cancelled'
      AND a.error_code='delegation_interrupted' AND a.abort_requested_at IS NOT NULL AND a.ended_at IS NOT NULL`)
    .get(source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken);
  const { runId: _runId, ...fence } = source;
  if (!owner || !hasDelegationStoppedHandoff(context.database, fence, now)) fail("suspension.admission_closed");
  assertSuspensionAdmission(context, source.runId, source);
}

function assertSuspensionAdmission(context: SqliteStoreContext, runId: string,
  stoppedResume?: { readonly runId: string } & RuntimeAttemptFenceV1): void {
  if (!hasSchema(context)) return;
  const rows = context.database.prepare(`WITH RECURSIVE ancestors(id,parent_run_id,depth) AS (
    SELECT id,parent_run_id,0 FROM run_sessions WHERE id=? UNION ALL
    SELECT r.id,r.parent_run_id,a.depth+1 FROM run_sessions r JOIN ancestors a ON r.id=a.parent_run_id WHERE a.depth<128
  ) SELECT a.depth,a.id AS run_id,s.id,u.id AS work_unit_id,u.active_attempt_id,p.runtime_instance_id,p.fencing_token
    FROM ancestors a LEFT JOIN run_suspensions s ON s.run_id=a.id AND s.state IN ('requested','sealed')
    LEFT JOIN run_sessions r ON r.id=a.id LEFT JOIN work_units u ON u.id=r.work_unit_id
    LEFT JOIN work_unit_attempts p ON p.id=u.active_attempt_id`).all(delegationId(runId));
  if (rows.some(row => {
    if (row.depth === 128) return true;
    if (row.id === null) return false;
    if (!row.active_attempt_id) return true;
    const source = { runId: String(row.run_id), workUnitId: String(row.work_unit_id), attemptId: String(row.active_attempt_id),
      runtimeInstanceId: String(row.runtime_instance_id), fencingToken: String(row.fencing_token) };
    const explicitStoppedSelf = stoppedResume && isDeepStrictEqual(source, stoppedResume)
      && hasDelegatedSuspensionStartedLineage(context.database, source, String(row.id));
    return !explicitStoppedSelf && !hasRootSuspensionActivatedTarget(context.database, source, String(row.id))
      && !hasDelegatedSuspensionActivatedTarget(context.database, source, String(row.id));
  })) fail("suspension.admission_closed");
}
function hasSchema(context: SqliteStoreContext): boolean {
  if (context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_suspensions'").get()) return true;
  if (context.database.prepare("SELECT 1 FROM schema_migrations WHERE version=182").get()) fail("suspension.schema_missing");
  return false;
}

/** Constructor-private Host writer. Request/seal deliberately cannot terminalize, stop, settle or resume. */
export class SqliteRunSuspensionStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  requestRunSuspension(raw: RequestRunSuspensionInput): RunSuspensionRecord {
    const input = delegationRecord(raw, ["runId", "sourceFence", "cause", "expectedLineage", "now"]);
    const runId = delegationId(input.runId), sourceFence = delegationFence(input.sourceFence), now = delegationTimestamp(input.now);
    const expectedLineage = lineage(input.expectedLineage);
    if (!causes.includes(input.cause as RunSuspensionCause)) fail("suspension.invalid_input");
    return this.write(() => {
      const facts = readSqliteWithinTransaction(this.context.database, () => this.current(runId, sourceFence, now));
      if (!isDeepStrictEqual(facts.lineage, expectedLineage)) fail("suspension.lineage_changed");
      const old = readSqliteWithinTransaction(this.context.database, () => this.getRunSuspensionForAttempt(sourceFence.attemptId));
      if (old) {
        if (old.request.runId !== runId || !isDeepStrictEqual(old.request.sourceFence, sourceFence)
          || old.request.cause !== input.cause) fail("suspension.request_conflict");
        if (now < old.request.requestedAt) fail("suspension.source_stale");
        this.assertFrozen(old.request, facts);
        return old;
      }
      const request: RunSuspensionRequestV1 = { schemaVersion: 1, kind: "run.suspension_request.v1", runId, sourceFence,
        cause: input.cause as RunSuspensionCause, contextDigest: facts.contextDigest, selectionDigest: facts.selectionDigest,
        lineage: facts.lineage, requestedEventSeq: this.eventSeq(runId), requestedAt: now };
      const artifact = this.createArtifact(runId, request, REQUEST_CONTENT_TYPE, "request", now);
      const id = `run_suspension_${randomUUID()}`;
      this.assertFrozen(request, readSqliteWithinTransaction(this.context.database, () => this.current(runId, sourceFence, now)));
      this.context.database.prepare(`INSERT INTO run_suspensions
        (id,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,request_artifact_id,request_digest,requested_event_seq,state,requested_at)
        VALUES (?,?,?,?,?,?,?,?,?,'requested',?)`).run(id, runId, sourceFence.workUnitId, sourceFence.attemptId,
          sourceFence.runtimeInstanceId, sourceFence.fencingToken, artifact.id, artifact.contentSha256!, request.requestedEventSeq, now);
      this.pins(id, [artifact.id], now);
      return readSqliteWithinTransaction(this.context.database, () => this.getRunSuspension(id))!;
    });
  }

  sealRunSuspension(raw: SealRunSuspensionInput): RunSuspensionRecord {
    const input = delegationRecord(raw, ["suspensionId", "sourceFence", "witness", "now"]);
    const id = delegationId(input.suspensionId), sourceFence = delegationFence(input.sourceFence), now = delegationTimestamp(input.now);
    const expected = witness(input.witness);
    return this.write(() => {
      const stored = readSqliteWithinTransaction(this.context.database, () => this.getRunSuspension(id));
      if (!stored) fail("suspension.missing");
      const { request } = stored;
      if (!isDeepStrictEqual(request.sourceFence, sourceFence) || now < request.requestedAt) fail("suspension.source_stale");
      const verified = readSqliteWithinTransaction(this.context.database, () => {
        this.assertFrozen(request, this.current(request.runId, sourceFence, now));
        const modelViewArtifactId = this.verifyWitness(request.runId, expected);
        if (!isDeepStrictEqual(suspensionWitnessIdentity(expected).sourceFence, sourceFence)
          || !isDeepStrictEqual(suspensionWitnessIdentity(expected).lineage, request.lineage)) fail("suspension.witness_mismatch");
        if (this.eventSeq(request.runId) !== suspensionWitnessBoundary(expected)
          || suspensionWitnessBoundary(expected) < request.requestedEventSeq) fail("suspension.watermark_changed");
        const body = readHarnessRetainedBody(this.context.database, modelViewArtifactId);
        if (body.bytes > RUN_PROGRESS_MAX_PAYLOAD_BYTES || body.contentSha256 !== suspensionWitnessModelDigest(expected)) fail("suspension.artifact_invalid");
        return { modelViewArtifactId };
      });
      if (stored.seal) {
        if (!isDeepStrictEqual(stored.seal.witness, expected)
          || stored.seal.modelViewArtifactId !== verified.modelViewArtifactId) fail("suspension.request_conflict");
        return stored;
      }
      const seal: RunSuspensionSealV1 = { schemaVersion: 1, kind: "run.suspension_seal.v1", suspensionId: id,
        runId: request.runId, sourceFence, requestDigest: stored.requestDigest, witness: expected,
        modelViewArtifactId: verified.modelViewArtifactId, sealedAt: now };
      const artifact = this.createArtifact(request.runId, seal, SEAL_CONTENT_TYPE, "seal", now);
      // Artifact creation cannot smuggle a newer canonical boundary or replace
      // permissions/context into the same commit through a mutable port.
      readSqliteWithinTransaction(this.context.database, () => {
        this.assertFrozen(request, this.current(request.runId, sourceFence, now));
        if (this.eventSeq(request.runId) !== suspensionWitnessBoundary(expected)) fail("suspension.watermark_changed");
        if (this.verifyWitness(request.runId, expected) !== seal.modelViewArtifactId) fail("suspension.witness_mismatch");
      });
      const changed = this.context.database.prepare(`UPDATE run_suspensions SET state='sealed',seal_artifact_id=?,seal_digest=?,sealed_at=?
        WHERE id=? AND state='requested' AND attempt_id=? AND fencing_token=?`).run(artifact.id, artifact.contentSha256!, now,
          id, sourceFence.attemptId, sourceFence.fencingToken);
      if (changed.changes !== 1) fail("suspension.commit_failed");
      this.pins(id, [stored.requestArtifactId, artifact.id, seal.modelViewArtifactId, ...runSuspensionWitnessArtifactIds(this.context, expected)], now);
      return readSqliteWithinTransaction(this.context.database, () => this.getRunSuspension(id))!;
    });
  }

  getRunSuspensionForAttempt(attemptId: string): RunSuspensionRecord | undefined {
    const id = delegationId(attemptId);
    return readSqliteSnapshot(this.context.database, () => {
      const row = this.context.database.prepare("SELECT * FROM run_suspensions WHERE attempt_id=?").get(id);
      return row ? this.read(row) : undefined;
    });
  }
  getRunSuspension(id: string): RunSuspensionRecord | undefined {
    const identity = delegationId(id);
    return readSqliteSnapshot(this.context.database, () => {
      const row = this.context.database.prepare("SELECT * FROM run_suspensions WHERE id=?").get(identity);
      return row ? this.read(row) : undefined;
    });
  }

  /** Constructor-private ACK proof: the source is historical, but all frozen inputs remain current. */
  assertRootStartProofWithinTransaction(id: string, targetFence: RuntimeAttemptFenceV1, continuationId: string): RunSuspensionRecord {
    if (!this.context.database.isTransaction) fail("suspension.commit_failed");
    const saved = this.getRunSuspension(id), stopped = readRunSuspensionStopRecord(this.context.database, id);
    const run = saved && this.ports.getRun(saved.request.runId), unit = run && this.ports.getWorkUnit(targetFence.workUnitId);
    if (!saved?.seal || !stopped?.receipt || !run || run.parentRunId || run.status !== "running" || run.endedAt
      || run.workUnitId !== targetFence.workUnitId || !unit || unit.linkedRunId !== run.id || unit.activeAttemptId !== targetFence.attemptId
      || unit.status !== "claimed" || unit.endedAt) fail("suspension.source_stale");
    assertNoPendingRunTerminalIntent(this.context, run.id);
    this.assertFrozen(saved.request, { run, lineage: captureRunProgressCheckpointLineage(this.ports, run).lineage,
      contextDigest: contextDigest(run), selectionDigest: this.selectionDigest(run) });
    if (this.verifyWitness(run.id, saved.seal.witness, { continuationBinding: { continuationId, targetFence } })
      !== saved.seal.modelViewArtifactId) fail("suspension.witness_mismatch");
    const canonical = createHash("sha256");
    for (const row of this.context.database.prepare("SELECT seq,ts,type,data_json FROM run_events WHERE run_id=? ORDER BY seq").iterate(run.id)) {
      const body = JSON.stringify([row.seq, row.ts, row.type, row.data_json]);
      canonical.update(`${Buffer.byteLength(body)}:`).update(body);
    }
    if (canonical.digest("hex") !== stopped.begin.canonicalEventDigest || delegationDigest(this.context.database.prepare(`SELECT
      id,root_run_id,reservation_id,run_id,attempt_id,invocation_id,request_digest,reserved_tokens,reserved_cost_micros,
      price_artifact_id,price_digest,created_at FROM delegation_budget_charges WHERE run_id=? ORDER BY id`).all(run.id))
      !== stopped.begin.modelAdmissionDigest) fail("suspension.watermark_changed");
    return saved;
  }

  /** Recheck the original child seal and exact successor view at activation and physical SDK ACK. */
  assertDelegatedStartProofWithinTransaction(id: string, targetFence: RuntimeAttemptFenceV1, reservationId: string): RunSuspensionRecord {
    if (!this.context.database.isTransaction) fail("suspension.commit_failed");
    const saved = this.getRunSuspension(id), stopped = readRunSuspensionStopRecord(this.context.database, id);
    const run = saved && this.ports.getRun(saved.request.runId), unit = run && this.ports.getWorkUnit(targetFence.workUnitId);
    if (!saved?.seal || !stopped?.receipt || stopped.begin.source.kind !== "delegated" || stopped.begin.source.reservationId !== reservationId
      || !run?.parentRunId || !unit || run.status !== "running" || run.endedAt || run.workUnitId !== unit.id || unit.linkedRunId !== run.id
      || unit.activeAttemptId !== targetFence.attemptId || unit.status !== "claimed" || unit.endedAt) fail("suspension.source_stale");
    assertNoPendingRunTerminalIntent(this.context, run.id);
    this.assertFrozen(saved.request, { run, lineage: captureRunProgressCheckpointLineage(this.ports, run).lineage,
      contextDigest: contextDigest(run), selectionDigest: this.selectionDigest(run) });
    if (this.verifyWitness(run.id, saved.seal.witness, { delegationBinding: { reservationId, targetFence } })
      !== saved.seal.modelViewArtifactId) fail("suspension.witness_mismatch");
    const canonical = createHash("sha256");
    for (const row of this.context.database.prepare("SELECT seq,ts,type,data_json FROM run_events WHERE run_id=? ORDER BY seq").iterate(run.id)) {
      const body = JSON.stringify([row.seq, row.ts, row.type, row.data_json]); canonical.update(`${Buffer.byteLength(body)}:`).update(body);
    }
    if (canonical.digest("hex") !== stopped.begin.canonicalEventDigest || delegationDigest(this.context.database.prepare(`SELECT
      id,root_run_id,reservation_id,run_id,attempt_id,invocation_id,request_digest,reserved_tokens,reserved_cost_micros,
      price_artifact_id,price_digest,created_at FROM delegation_budget_charges WHERE run_id=? ORDER BY id`).all(run.id))
      !== stopped.begin.modelAdmissionDigest) fail("suspension.watermark_changed");
    return saved;
  }

  private read(row: Row): RunSuspensionRecord {
    const requestRaw = this.body(String(row.request_artifact_id), String(row.run_id), String(row.request_digest), REQUEST_CONTENT_TYPE, "request");
    const value = delegationRecord(requestRaw, ["schemaVersion", "kind", "runId", "sourceFence", "cause", "contextDigest", "selectionDigest", "lineage", "requestedEventSeq", "requestedAt"]);
    const sourceFence = delegationFence(value.sourceFence);
    if (value.schemaVersion !== 1 || value.kind !== "run.suspension_request.v1" || value.runId !== row.run_id
      || sourceFence.workUnitId !== row.work_unit_id || sourceFence.attemptId !== row.attempt_id
      || sourceFence.runtimeInstanceId !== row.runtime_instance_id || sourceFence.fencingToken !== row.fencing_token
      || !causes.includes(value.cause as RunSuspensionCause) || value.requestedEventSeq !== row.requested_event_seq
      || delegationInteger(value.requestedEventSeq) < 0 || delegationTimestamp(value.requestedAt) !== row.requested_at) fail("suspension.artifact_invalid");
    digest(value.contextDigest); digest(value.selectionDigest); lineage(value.lineage);
    const request = requestRaw as RunSuspensionRequestV1;
    let seal: RunSuspensionSealV1 | undefined;
    if (row.state === "sealed") {
      const raw = this.body(String(row.seal_artifact_id), request.runId, String(row.seal_digest), SEAL_CONTENT_TYPE, "seal");
      const item = delegationRecord(raw, ["schemaVersion", "kind", "suspensionId", "runId", "sourceFence", "requestDigest", "witness", "modelViewArtifactId", "sealedAt"]);
      const savedWitness = witness(item.witness);
      if (item.schemaVersion !== 1 || item.kind !== "run.suspension_seal.v1" || item.suspensionId !== row.id
        || item.runId !== request.runId || !isDeepStrictEqual(delegationFence(item.sourceFence), request.sourceFence)
        || item.requestDigest !== row.request_digest || delegationTimestamp(item.sealedAt) !== row.sealed_at
        || String(row.sealed_at) < request.requestedAt || !isDeepStrictEqual(suspensionWitnessIdentity(savedWitness).lineage, request.lineage)
        || !isDeepStrictEqual(suspensionWitnessIdentity(savedWitness).sourceFence, request.sourceFence)) fail("suspension.artifact_invalid");
      const artifactId = delegationId(item.modelViewArtifactId), retained = readHarnessRetainedBody(this.context.database, artifactId);
      if (retained.bytes > RUN_PROGRESS_MAX_PAYLOAD_BYTES || retained.contentSha256 !== suspensionWitnessModelDigest(savedWitness)
        || savedWitness.kind === "compaction" && artifactId !== savedWitness.checkpoint.summaryArtifactId
        || this.ports.getArtifact(artifactId)?.runId !== request.runId) fail("suspension.artifact_invalid");
      seal = raw as RunSuspensionSealV1;
    } else if (row.state !== "requested" || row.seal_artifact_id !== null || row.seal_digest !== null || row.sealed_at !== null) fail("suspension.artifact_invalid");
    const artifactIds = [String(row.request_artifact_id), ...(seal ? [String(row.seal_artifact_id), seal.modelViewArtifactId,
      ...runSuspensionWitnessArtifactIds(this.context, seal.witness)] : [])];
    for (const artifactId of artifactIds) for (const [kind, reason] of [["run_suspension", "recovery"], ["run_suspension_audit", "audit_hold"]] as const) {
      if (!this.context.database.prepare("SELECT 1 FROM harness_artifact_pins WHERE artifact_id=? AND holder=? AND reason=? AND released_at IS NULL")
        .get(artifactId, harnessArtifactOwnerHolder(kind, String(row.id)), reason)) fail("suspension.pin_missing");
    }
    return { id: String(row.id), state: row.state as "requested" | "sealed", requestArtifactId: String(row.request_artifact_id),
      requestDigest: String(row.request_digest), request, ...(seal ? { sealArtifactId: String(row.seal_artifact_id), sealDigest: String(row.seal_digest), seal } : {}) };
  }

  private current(runId: string, sourceFence: RuntimeAttemptFenceV1, now: string) {
    const run = this.ports.getRun(runId), unit = this.ports.getWorkUnit(sourceFence.workUnitId), attempt = this.ports.getWorkUnitAttempt(sourceFence.attemptId);
    if (!run || !unit || !attempt || !isCurrentRunExecutionOwner(this.context, runId, sourceFence, false)
      || run.status !== "running" || run.endedAt || unit.status !== "running" || unit.endedAt
      || attempt.status !== "started" || attempt.endedAt || attempt.abortRequestedAt
      || run.createdAt > now || attempt.createdAt > now) fail("suspension.source_stale");
    try { assertNoPendingRunTerminalIntent(this.context, runId); } catch { fail("suspension.terminal_intent"); }
    let captured;
    try { captured = captureRunProgressCheckpointLineage(this.ports, run); } catch { fail("suspension.lineage_changed"); }
    return { run, lineage: captured.lineage, contextDigest: contextDigest(run), selectionDigest: this.selectionDigest(run) };
  }
  private verifyWitness(runId: string, expected: RunSuspensionWitness,
    binding: Pick<Parameters<RunStore["readRunProgressCheckpointForRecovery"]>[0], "continuationBinding" | "delegationBinding"> = {}): string {
    if (expected.kind === "settlement") {
      const verified = verifyRunFinalSettlement(this.context, this.ports, expected, new Date().toISOString());
      if (this.ports.getRun(runId)?.id !== runId || verified.witness.settlement.modelViewArtifactId !== verified.modelViewArtifactId) fail("suspension.witness_mismatch");
      return verified.modelViewArtifactId;
    }
    if (expected.kind === "compaction") return verifyRunCompactionSuspensionWitness(this.context, this.ports,
      { runId, sourceFence: expected.checkpoint.sourceFence, expectedLineage: expected.checkpoint.lineage }, expected).modelViewArtifactId;
    const result = this.ports.readRunProgressCheckpointForRecovery({ runId, sourceFence: expected.checkpoint.sourceFence,
      expectedLineage: expected.checkpoint.lineage, ...binding });
    if (result.kind !== "verified") fail("suspension.snapshot_unverified");
    if (!isDeepStrictEqual(result.witness, expected.checkpoint)) fail("suspension.witness_mismatch");
    return result.checkpoint.modelViewArtifactId;
  }
  private assertFrozen(request: RunSuspensionRequestV1, actual: ReturnType<SqliteRunSuspensionStore["current"]>): void {
    if (request.contextDigest !== actual.contextDigest) fail("suspension.context_changed");
    if (request.selectionDigest !== actual.selectionDigest) fail("suspension.selection_changed");
    if (!isDeepStrictEqual(request.lineage, actual.lineage)) fail("suspension.lineage_changed");
  }
  private selectionDigest(run: RunSession): string {
    if (!run.workflowStepId) return delegationDigest(null);
    const step = this.ports.getChannelWorkflowStep(run.workflowStepId), workflow = step ? this.ports.getChannelWorkflow(step.workflowId) : undefined;
    if (!step || !workflow || workflow.channelId !== run.channelId || step.channelId !== run.channelId
      || !["ready", "running"].includes(workflow.status) || !["queued", "claimed", "running"].includes(step.status)) fail("suspension.selection_changed");
    return delegationDigest({ workflow: { id: workflow.id, workspaceId: workflow.workspaceId, channelId: workflow.channelId,
      title: workflow.title, objective: workflow.objective, createdAt: workflow.createdAt, createdBy: workflow.createdBy,
      sourceHandoffId: workflow.sourceHandoffId, metadata: workflow.metadata }, step: { id: step.id, workflowId: step.workflowId,
      position: step.position, title: step.title, prompt: step.prompt, toParticipantId: step.toParticipantId, participantAuthority: step.participantAuthority } });
  }
  private eventSeq(runId: string): number {
    const seq = this.context.database.prepare("SELECT COALESCE(MAX(seq),0) seq FROM run_events WHERE run_id=?").get(runId)?.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) fail("suspension.watermark_changed");
    return seq;
  }
  private createArtifact(runId: string, payload: RunSuspensionRequestV1 | RunSuspensionSealV1, contentType: string, kind: string, now: string): RunArtifact {
    const body = delegationJson(payload);
    if (Buffer.byteLength(body) > 65_536) fail("suspension.artifact_invalid");
    return this.ports.createArtifactWithinTransaction({ runId, type: "json", path: `sqlite:run-suspension-${kind}`,
      contentType, sealedPayload: JSON.parse(body), contentSha256: delegationDigest(payload), sizeBytes: Buffer.byteLength(body), createdAt: now });
  }
  private body(artifactId: string, runId: string, expectedDigest: string, contentType: string, kind: string): unknown {
    const retained = readHarnessRetainedBody(this.context.database, artifactId), artifact = this.ports.getArtifact(artifactId);
    if (retained.bytes > 65_536 || retained.contentSha256 !== expectedDigest || !artifact || artifact.runId !== runId
      || artifact.type !== "json" || artifact.contentType !== contentType || artifact.path !== `sqlite:run-suspension-${kind}`
      || !artifact.sealedPayload || delegationDigest(artifact.sealedPayload) !== expectedDigest) fail("suspension.artifact_invalid");
    return artifact.sealedPayload;
  }
  private pins(id: string, artifactIds: readonly string[], now: string): void {
    for (const [kind, reason] of [["run_suspension", "recovery"], ["run_suspension_audit", "audit_hold"]] as const) {
      syncHarnessArtifactOwnerPins(this.context.database, { holder: harnessArtifactOwnerHolder(kind, id), artifactIds, keep: true, reason, now });
    }
  }
  private write<T>(body: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = body(); if (!this.context.database.isTransaction) fail("suspension.commit_failed"); this.context.database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); throw error; }
  }
}

function contextDigest(run: RunSession): string {
  return delegationDigest({ id: run.id, cwd: run.cwd, taskId: run.taskId, channelId: run.channelId, teammateId: run.teammateId,
    workflowStepId: run.workflowStepId, selectedSkillId: run.selectedSkillId, providerPresetId: run.providerPresetId,
    providerName: run.providerName, providerModel: run.providerModel, taskSnapshot: run.taskSnapshot,
    providerSnapshot: run.providerSnapshot, requestSnapshot: run.requestSnapshot, threadId: run.threadId,
    workUnitId: run.workUnitId, parentRunId: run.parentRunId, interventionId: run.interventionId, continuationReason: run.continuationReason,
    contextViewId: run.contextViewId, contextViewCreatedAt: run.contextViewCreatedAt, createdAt: run.createdAt });
}
