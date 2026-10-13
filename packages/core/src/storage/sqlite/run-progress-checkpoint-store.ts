import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CommitExistingRunContinuationInput } from "../../harness/continuations.js";
import { captureRunProgressCheckpointLineage, assertRunProgressPayloadSecretFree, isRunProgressRecord,
  runProgressHashJson } from "../../run-progress-checkpoint-lineage.js";
import { RUN_PROGRESS_MAX_PAYLOAD_BYTES, RUN_PROGRESS_MODEL_VIEW_CONTENT_TYPE, RunProgressCheckpointError,
  type CommitRunProgressCheckpointInput, type CommitRunProgressCheckpointResult, type ReadRunProgressCheckpointForRecoveryInput,
  type ReadRunProgressCheckpointForRecoveryResult, type RunProgressCheckpoint, type RunProgressCheckpointHead,
  type RunProgressCheckpointLineage, type RunProgressCheckpointWitness } from "../../run-progress-checkpoint-types.js";
import type { RunSession, RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import type { SqliteArtifactStore } from "./artifact-store.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { runExecutionOwnerParameters, runExecutionOwnerSql } from "./run-execution-admission.js";
import { readRunProgressEvents, runHasOrdinaryProgress, validateRunProgressEffects,
  validateRunProgressRecoveryBookkeeping } from "./run-progress-checkpoint-effects.js";
import type { SqliteStoreContext } from "./store-context.js";
import { hasCommittedRunCompactionReceipt } from "./run-compaction-checkpoint-store.js";

interface Payload { readonly schemaVersion: 1; readonly boundary: "run-progress-model-view"; readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1; readonly sourceEventSeq: number; readonly predecessorId: string | null;
  readonly lineage: RunProgressCheckpointLineage; readonly modelView: readonly unknown[]; readonly completedToolCallIds: readonly string[] }
const owner = `${runExecutionOwnerSql} AND EXISTS (
  SELECT 1 FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id
  JOIN work_unit_attempts a ON a.id=u.active_attempt_id
  WHERE r.id=? AND r.status='running' AND u.status='running' AND u.ended_at IS NULL AND a.status='started'
) AND (SELECT COALESCE(MAX(seq),0) FROM run_events WHERE run_id=?)=?`;

/** Ordinary progress authority, separate from compaction and Runner session state. */
export class SqliteRunProgressCheckpointStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: RunStore,
    private readonly artifacts: SqliteArtifactStore) {}

  commitRunProgressCheckpoint(raw: CommitRunProgressCheckpointInput): CommitRunProgressCheckpointResult {
    let input: CommitRunProgressCheckpointInput;
    try { input = plainInput(raw); assertRunProgressPayloadSecretFree(input.modelView); }
    catch (error) { return blocked(error); }
    // Never roll back another caller's transaction after a nested BEGIN failure.
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const { run, lineage, completedToolCallIds } = readSqliteWithinTransaction(this.context.database, () => {
        const run = this.requireRun(input.runId), lineage = this.currentLineage(run, input.expectedLineage);
        this.assertLiveOwner(run, input.sourceFence, input.sourceEventSeq);
        const events = readRunProgressEvents(this.ports, run.id);
        return { run, lineage, completedToolCallIds: validateRunProgressEffects(this.ports, run, events, input.modelView, input.sourceFence, this.context.database) };
      });
      const head = this.head(run.id);
      const existing = this.context.database.prepare(`SELECT * FROM run_progress_checkpoints
        WHERE run_id=? AND source_attempt_id=? AND source_event_seq=?`).get(run.id, input.sourceFence.attemptId, input.sourceEventSeq);
      const predecessorId = existing ? rowRecord(existing).predecessorId : head.checkpointId;
      const payload: Payload = { schemaVersion: 1, boundary: "run-progress-model-view", runId: run.id,
        sourceFence: input.sourceFence, sourceEventSeq: input.sourceEventSeq, predecessorId, lineage,
        modelView: input.modelView, completedToolCallIds };
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > RUN_PROGRESS_MAX_PAYLOAD_BYTES) throw failure("checkpoint.snapshot_unavailable");
      const digest = runProgressHashJson(payload);
      const artifactId = input.artifactId ?? `artifact_${run.id}_progress_${input.sourceFence.attemptId}_${input.sourceEventSeq}`;
      if (existing) {
        const checkpoint = rowRecord(existing);
        if (head.checkpointId !== checkpoint.id || head.revision !== input.expectedHead.revision + 1
          || checkpoint.predecessorId !== input.expectedHead.checkpointId || checkpoint.modelViewArtifactId !== artifactId
          || checkpoint.modelViewSha256 !== digest || !sameFence(checkpoint.sourceFence, input.sourceFence)
          || !isDeepStrictEqual(checkpoint.lineage, lineage) || !isDeepStrictEqual(this.payload(checkpoint), payload)) throw failure("checkpoint.head_conflict");
        this.context.database.exec("COMMIT;");
        return { kind: "committed", checkpoint, headRevision: head.revision, replayed: true };
      }
      if (!isDeepStrictEqual(head, input.expectedHead)) throw failure("checkpoint.head_conflict");
      if (head.checkpointId) {
        const predecessor = this.checkpoint(head.checkpointId);
        const previous = this.payload(predecessor);
        if (predecessor.runId !== run.id || !isDeepStrictEqual(input.modelView.slice(0, previous.modelView.length), previous.modelView)
          || input.sourceEventSeq <= predecessor.sourceEventSeq) throw failure("checkpoint.lineage_mismatch");
        if (predecessor.sourceFence.attemptId !== input.sourceFence.attemptId) {
          this.assertSuccessorPredecessor(run, input, predecessor, head);
        }
      } else if (input.recoveryPredecessor) throw failure("checkpoint.lineage_mismatch");
      const priorArtifact = this.artifacts.getArtifact(artifactId);
      if (priorArtifact) {
        if (priorArtifact.runId !== run.id || priorArtifact.type !== "json" || priorArtifact.contentType !== RUN_PROGRESS_MODEL_VIEW_CONTENT_TYPE
          || priorArtifact.path !== `${run.id}/progress/${artifactId}.json` || priorArtifact.contentSha256 !== digest
          || !isDeepStrictEqual(priorArtifact.sealedPayload, payload)) throw failure("checkpoint.lineage_mismatch");
      } else {
        this.artifacts.createArtifactWithinTransaction({ id: artifactId, runId: run.id, type: "json",
          path: `${run.id}/progress/${artifactId}.json`, contentType: RUN_PROGRESS_MODEL_VIEW_CONTENT_TYPE,
          sealedPayload: payload, contentSha256: digest, sizeBytes: Buffer.byteLength(JSON.stringify(payload)), createdAt: input.now });
      }
      const id = `progress_checkpoint_${randomUUID()}`;
      const inserted = this.context.database.prepare(`INSERT INTO run_progress_checkpoints
        (id,schema_version,kind,run_id,work_unit_id,workspace_id,source_attempt_id,source_runtime_instance_id,source_fencing_token,
          source_event_seq,predecessor_id,model_view_artifact_id,model_view_sha256,lineage_json,committed_at)
        SELECT ?,1,'noncompacted_model_view',?,?,?,?,?,?,?,?,?,?,?,? WHERE ${owner}`)
        .run(id, run.id, input.sourceFence.workUnitId, lineage.workspaceId, input.sourceFence.attemptId,
          input.sourceFence.runtimeInstanceId, input.sourceFence.fencingToken, input.sourceEventSeq, predecessorId, artifactId,
          digest, JSON.stringify(lineage), input.now, ...this.ownerParams(input));
      if (Number(inserted.changes) !== 1) throw failure("checkpoint.lineage_mismatch");
      // Recheck actual local sources after transaction-owned inserts as well.
      readSqliteWithinTransaction(this.context.database, () => this.currentLineage(this.requireRun(run.id), input.expectedLineage));
      const advanced = head.checkpointId === null
        ? this.context.database.prepare(`INSERT INTO run_progress_checkpoint_heads (run_id,checkpoint_id,revision)
            SELECT ?,?,1 WHERE ${owner}`).run(run.id, id, ...this.ownerParams(input))
        : this.context.database.prepare(`UPDATE run_progress_checkpoint_heads SET checkpoint_id=?,revision=revision+1
            WHERE run_id=? AND checkpoint_id=? AND revision=? AND ${owner}`)
          .run(id, run.id, head.checkpointId, head.revision, ...this.ownerParams(input));
      if (Number(advanced.changes) !== 1) throw failure("checkpoint.head_conflict");
      const checkpoint = this.checkpoint(id);
      this.context.database.exec("COMMIT;");
      return { kind: "committed", checkpoint, headRevision: head.revision + 1, replayed: false };
    } catch (error) { rollbackOwnedSqliteTransaction(this.context.database); return blocked(error); }
  }

  readRunProgressCheckpointForRecovery(input: ReadRunProgressCheckpointForRecoveryInput): ReadRunProgressCheckpointForRecoveryResult {
    return readSqliteSnapshot(this.context.database, () => {
      try { return this.readWithinTransaction(plainInput(input)); } catch (error) { return blocked(error); }
    });
  }

  /** Caller owns activation's BEGIN IMMEDIATE. Missing guard cannot bypass source progress. */
  validateActivationWithinTransaction(input: CommitExistingRunContinuationInput, continuationId?: string,
    targetFence?: RuntimeAttemptFenceV1): void {
    return readSqliteWithinTransaction(this.context.database, () => this.validateActivation(input, continuationId, targetFence));
  }

  private validateActivation(input: CommitExistingRunContinuationInput, continuationId?: string,
    targetFence?: RuntimeAttemptFenceV1): void {
    if (input.preparation.origin !== "daemon_recovery") return;
    const events = readRunProgressEvents(this.ports, input.preparation.runId);
    if (!runHasOrdinaryProgress(events)) return;
    const run = this.requireRun(input.preparation.runId);
    if (continuationId && targetFence) this.assertContinuationBinding(run, input.preparation.sourceFence,
      continuationId, targetFence, ["prepared", "claimed", "running"]);
    // Compacted progress is governed by the existing genuine committed-compaction contract.
    if (hasCommittedRunCompactionReceipt(this.context, this.ports, run,
      input.preparation.sourceFence, input.preparation, targetFence)) return;
    const guard = input.recoveryProgressCheckpointGuard;
    if (!guard || !sameFence(guard.sourceFence, input.preparation.sourceFence)) throw failure("checkpoint.missing");
    const result = this.readWithinTransaction({ runId: input.preparation.runId, sourceFence: input.preparation.sourceFence,
      expectedLineage: guard.lineage, ...(continuationId && targetFence ? { continuationBinding: { continuationId, targetFence } } : {}) });
    if (result.kind !== "verified" || !isDeepStrictEqual(result.witness, guard)) {
      throw failure(result.kind === "blocked" ? result.code : "checkpoint.lineage_mismatch");
    }
  }

  private readWithinTransaction(input: ReadRunProgressCheckpointForRecoveryInput): ReadRunProgressCheckpointForRecoveryResult {
    const run = this.requireRun(input.runId), events = readRunProgressEvents(this.ports, input.runId);
    this.currentLineage(run, input.expectedLineage);
    const source = this.ports.getWorkUnitAttempt(input.sourceFence.attemptId), unit = this.ports.getWorkUnit(input.sourceFence.workUnitId);
    if (!source || !unit || !sameFence(toRuntimeAttemptFence(source), input.sourceFence) || unit.linkedRunId !== run.id
      || run.workUnitId !== unit.id || !["queued", "running"].includes(run.status) || run.endedAt) throw failure("checkpoint.lineage_mismatch");
    if (input.continuationBinding) {
      this.assertContinuationBinding(run, input.sourceFence, input.continuationBinding.continuationId,
        input.continuationBinding.targetFence, ["prepared", "claimed", "running"]);
    } else if (unit.activeAttemptId !== source.id || !["queued", "running", "stale"].includes(unit.status)
      || !["created", "started", "lost"].includes(source.status) || source.abortRequestedAt) throw failure("checkpoint.lineage_mismatch");
    const head = this.head(run.id);
    if (!head.checkpointId) return runHasOrdinaryProgress(events) ? blocked(failure("checkpoint.missing")) : { kind: "not_needed" };
    const checkpoint = this.checkpoint(head.checkpointId);
    if (checkpoint.runId !== run.id || !sameFence(checkpoint.sourceFence, input.sourceFence)
      || !isDeepStrictEqual(checkpoint.lineage, input.expectedLineage)) throw failure("checkpoint.lineage_mismatch");
    const after = events.filter(event => event.seq > checkpoint.sourceEventSeq);
    if (input.continuationBinding) {
      validateRunProgressRecoveryBookkeeping(run, after, input.continuationBinding.targetFence.attemptId);
    } else if (unit.activeAttemptId !== source.id || !["stale", "running"].includes(unit.status)
      || !["lost", "started"].includes(source.status) || after.length) throw failure("checkpoint.source_watermark_changed");
    const payload = this.payload(checkpoint);
    if (!events.some(event => event.seq === checkpoint.sourceEventSeq)) throw failure("checkpoint.source_watermark_changed");
    const ids = validateRunProgressEffects(this.ports, run, events.slice(0, checkpoint.sourceEventSeq), payload.modelView, checkpoint.sourceFence, this.context.database);
    if (!isDeepStrictEqual(ids, payload.completedToolCallIds)) throw failure("checkpoint.snapshot_unavailable");
    return { kind: "verified", checkpoint, modelView: payload.modelView, witness: witness(checkpoint, head.revision) };
  }

  private assertSuccessorPredecessor(run: RunSession, input: CommitRunProgressCheckpointInput,
    predecessor: RunProgressCheckpoint, head: RunProgressCheckpointHead): void {
    if (!input.recoveryPredecessor || !isDeepStrictEqual(input.recoveryPredecessor, witness(predecessor, head.revision))) throw failure("checkpoint.lineage_mismatch");
    const rows = this.context.database.prepare(`SELECT id FROM runner_continuations WHERE run_id=?
      AND source_attempt_id=? AND target_attempt_id=? AND origin='daemon_recovery' AND state='running'`)
      .all(run.id, predecessor.sourceFence.attemptId, input.sourceFence.attemptId);
    if (rows.length !== 1) throw failure("checkpoint.lineage_mismatch");
    this.assertContinuationBinding(run, predecessor.sourceFence, String(rows[0].id), input.sourceFence, ["running"]);
  }

  private assertContinuationBinding(run: RunSession, sourceFence: RuntimeAttemptFenceV1, id: string,
    targetFence: RuntimeAttemptFenceV1, states: readonly string[]): void {
    const continuation = this.ports.getRunnerContinuation(id), target = this.ports.getWorkUnitAttempt(targetFence.attemptId);
    const unit = this.ports.getWorkUnit(targetFence.workUnitId);
    if (!continuation || !target || !unit || continuation.origin !== "daemon_recovery" || continuation.runId !== run.id
      || continuation.workUnitId !== sourceFence.workUnitId || continuation.sourceAttemptId !== sourceFence.attemptId
      || continuation.targetAttemptId !== target.id || continuation.contextViewId !== run.contextViewId
      || !states.includes(continuation.state) || unit.activeAttemptId !== target.id || unit.linkedRunId !== run.id
      || !sameFence(toRuntimeAttemptFence(target), targetFence) || target.endedAt || target.abortRequestedAt
      || !["created", "started"].includes(target.status) || !["queued", "claimed", "running"].includes(unit.status)) throw failure("checkpoint.lineage_mismatch");
  }

  private currentLineage(run: RunSession, expected: RunProgressCheckpointLineage): RunProgressCheckpointLineage {
    const current = captureRunProgressCheckpointLineage(this.ports, run).lineage;
    if (current.workspaceProvenanceWatermark !== expected.workspaceProvenanceWatermark) throw failure("checkpoint.source_watermark_changed");
    if (current.policySourcesFingerprint !== expected.policySourcesFingerprint || current.policySnapshotFingerprint !== expected.policySnapshotFingerprint) throw failure("checkpoint.permission_drift");
    if (!isDeepStrictEqual(current, expected)) throw failure("checkpoint.lineage_mismatch");
    return current;
  }
  private assertLiveOwner(run: RunSession, fence: RuntimeAttemptFenceV1, seq: number): void {
    if (!this.context.database.prepare(`SELECT 1 WHERE ${owner}`).get(...this.ownerParams({ runId: run.id, sourceFence: fence, sourceEventSeq: seq }))) {
      throw failure("checkpoint.lineage_mismatch");
    }
  }
  private ownerParams(input: Pick<CommitRunProgressCheckpointInput, "runId" | "sourceFence" | "sourceEventSeq">): readonly (string | number)[] {
    return [...runExecutionOwnerParameters(input.runId, input.sourceFence, false), input.runId, input.runId, input.sourceEventSeq];
  }
  private head(runId: string): RunProgressCheckpointHead {
    const row = this.context.database.prepare("SELECT checkpoint_id,revision FROM run_progress_checkpoint_heads WHERE run_id=?").get(runId);
    if (row && (typeof row.checkpoint_id !== "string" || !row.checkpoint_id || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1)) throw failure("checkpoint.lineage_mismatch");
    return row ? { checkpointId: String(row.checkpoint_id), revision: Number(row.revision) } : { checkpointId: null, revision: 0 };
  }
  private checkpoint(id: string): RunProgressCheckpoint {
    const row = this.context.database.prepare("SELECT * FROM run_progress_checkpoints WHERE id=?").get(id);
    if (!row) throw failure("checkpoint.missing");
    return rowRecord(row);
  }
  private payload(checkpoint: RunProgressCheckpoint): Payload {
    const artifact = this.artifacts.getArtifact(checkpoint.modelViewArtifactId);
    if (!artifact || artifact.runId !== checkpoint.runId || artifact.type !== "json" || artifact.contentType !== RUN_PROGRESS_MODEL_VIEW_CONTENT_TYPE
      || artifact.path !== `${checkpoint.runId}/progress/${artifact.id}.json` || artifact.contentSha256 !== checkpoint.modelViewSha256
      || artifact.sealedPayload === undefined || runProgressHashJson(artifact.sealedPayload) !== checkpoint.modelViewSha256) throw failure("checkpoint.snapshot_unavailable");
    const value = plainInput(artifact.sealedPayload) as Payload;
    if (Object.keys(value).sort().join(",") !== ["schemaVersion", "boundary", "runId", "sourceFence", "sourceEventSeq", "predecessorId", "lineage", "modelView", "completedToolCallIds"].sort().join(",")
      || value.schemaVersion !== 1 || value.boundary !== "run-progress-model-view" || value.runId !== checkpoint.runId
      || !sameFence(value.sourceFence, checkpoint.sourceFence) || value.sourceEventSeq !== checkpoint.sourceEventSeq
      || value.predecessorId !== checkpoint.predecessorId || !isDeepStrictEqual(value.lineage, checkpoint.lineage)
      || !Array.isArray(value.modelView) || !Array.isArray(value.completedToolCallIds)
      || value.completedToolCallIds.some(id => typeof id !== "string" || !id)
      || new Set(value.completedToolCallIds).size !== value.completedToolCallIds.length) throw failure("checkpoint.snapshot_unavailable");
    assertRunProgressPayloadSecretFree(value);
    return value;
  }
  private requireRun(id: string): RunSession { const run = this.ports.getRun(id); if (!run) throw failure("checkpoint.lineage_mismatch"); return run; }
}

function rowRecord(row: Record<string, unknown>): RunProgressCheckpoint {
  const lineage: unknown = JSON.parse(String(row.lineage_json));
  if (row.schema_version !== 1 || row.kind !== "noncompacted_model_view" || !isRunProgressRecord(lineage)
    || lineage.workspaceId !== row.workspace_id || !Number.isSafeInteger(row.source_event_seq) || Number(row.source_event_seq) < 1) throw failure("checkpoint.lineage_mismatch");
  return { id: String(row.id), schemaVersion: 1, kind: "noncompacted_model_view", runId: String(row.run_id),
    sourceFence: { workUnitId: String(row.work_unit_id), attemptId: String(row.source_attempt_id),
      runtimeInstanceId: String(row.source_runtime_instance_id), fencingToken: String(row.source_fencing_token) },
    sourceEventSeq: Number(row.source_event_seq), predecessorId: row.predecessor_id === null ? null : String(row.predecessor_id),
    modelViewArtifactId: String(row.model_view_artifact_id), modelViewSha256: String(row.model_view_sha256),
    lineage: lineage as unknown as RunProgressCheckpointLineage, committedAt: String(row.committed_at) };
}
function witness(checkpoint: RunProgressCheckpoint, headRevision: number): RunProgressCheckpointWitness {
  return { checkpointId: checkpoint.id, headRevision, modelViewSha256: checkpoint.modelViewSha256, sourceEventSeq: checkpoint.sourceEventSeq,
    sourceFence: checkpoint.sourceFence, lineage: checkpoint.lineage };
}
function sameFence(left: RuntimeAttemptFenceV1, right: RuntimeAttemptFenceV1): boolean {
  return left.workUnitId === right.workUnitId && left.attemptId === right.attemptId
    && left.runtimeInstanceId === right.runtimeInstanceId && left.fencingToken === right.fencingToken;
}
function failure(code: ConstructorParameters<typeof RunProgressCheckpointError>[0]): RunProgressCheckpointError { return new RunProgressCheckpointError(code); }
function blocked(error: unknown): { readonly kind: "blocked"; readonly code: RunProgressCheckpointError["code"] } {
  return { kind: "blocked", code: error instanceof RunProgressCheckpointError ? error.code : "checkpoint.commit_failed" };
}
/** Refuse getters/toJSON, cycles and non-JSON data before entering authority transactions. */
function plainInput<T>(value: T): T {
  const seen = new Set<object>(); let nodes = 0, bytes = 0;
  const addBytes = (text: string): void => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > RUN_PROGRESS_MAX_PAYLOAD_BYTES) throw failure("checkpoint.snapshot_unavailable");
  };
  const read = (item: unknown, depth: number): unknown => {
    if (++nodes > 40_000 || depth > 64) throw failure("checkpoint.snapshot_unavailable");
    if (typeof item === "string") { addBytes(item); return item; }
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || seen.has(item)) throw failure("checkpoint.snapshot_unavailable");
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw failure("checkpoint.snapshot_unavailable");
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string") || "toJSON" in descriptors) throw failure("checkpoint.snapshot_unavailable");
    try {
      if (array) {
        const length: unknown = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || Number(length) > 40_000 || Object.keys(descriptors).length !== Number(length) + 1) throw failure("checkpoint.snapshot_unavailable");
        return Array.from({ length: Number(length) }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw failure("checkpoint.snapshot_unavailable");
          return read(descriptor.value, depth + 1);
        });
      }
      const result: Record<string, unknown> = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!("value" in descriptor) || !descriptor.enumerable || key === "__proto__") throw failure("checkpoint.snapshot_unavailable");
        addBytes(key);
        // Optional input fields follow ordinary JSON omission; arrays must remain dense.
        if (descriptor.value !== undefined) Object.defineProperty(result, key, { value: read(descriptor.value, depth + 1), enumerable: true });
      }
      return result;
    } finally { seen.delete(item); }
  };
  const cloned = read(value, 0);
  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") > RUN_PROGRESS_MAX_PAYLOAD_BYTES) throw failure("checkpoint.snapshot_unavailable");
  return cloned as T;
}
