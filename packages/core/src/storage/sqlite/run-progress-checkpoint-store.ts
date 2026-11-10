import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRunEventData } from "@ling-stack/contracts";
import type { CommitExistingRunContinuationInput } from "../../harness/continuations.js";
import { delegationDigest } from "../../harness/delegation-write-validation.js";
import { captureRunProgressCheckpointLineage, assertRunProgressPayloadSecretFree, isRunProgressRecord,
  runProgressHashJson } from "../../run-progress-checkpoint-lineage.js";
import { RUN_PROGRESS_MAX_PAYLOAD_BYTES, RUN_PROGRESS_MODEL_VIEW_CONTENT_TYPE, RunProgressCheckpointError,
  type CommitRunProgressCheckpointInput, type CommitRunProgressCheckpointResult, type ReadRunProgressCheckpointForRecoveryInput,
  type ReadRunProgressCheckpointForRecoveryResult, type RunProgressCheckpoint, type RunProgressCheckpointHead,
  type RunProgressCheckpointLineage, type RunProgressCheckpointWitness, type DelegationInstructionModelMessage,
  type ListPendingDelegationInstructionsInput } from "../../run-progress-checkpoint-types.js";
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
import { hasDelegationStoppedHandoff } from "./delegation-stopped-handoff.js";

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
    try {
      input = plainInput(raw);
      assertRunProgressPayloadSecretFree(input.modelView);
      this.validateInstructionIds(input);
    }
    catch (error) { return blocked(error); }
    // Never roll back another caller's transaction after a nested BEGIN failure.
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const { run, lineage } = readSqliteWithinTransaction(this.context.database, () => {
        const run = this.requireRun(input.runId), lineage = this.currentLineage(run, input.expectedLineage);
        return { run, lineage };
      });
      const instructionIds = input.delegationInstructionIds ?? [];
      if (instructionIds.length) {
        const replay = this.replayInstructionCheckpoint(input, run, lineage, instructionIds);
        if (replay) {
          this.context.database.exec("COMMIT;");
          return replay;
        }
      }
      const { completedToolCallIds, modelView, delegationInstructions } =
        readSqliteWithinTransaction(this.context.database, () => {
        this.assertLiveOwner(run, input.sourceFence, input.sourceEventSeq);
        const events = readRunProgressEvents(this.ports, run.id);
        const existingView = this.verifyInstructionView(run.id, input.modelView);
        const instructions = instructionIds.length ? this.readNewInstructions(run.id, input, instructionIds) : [];
        const nextView = instructions.length ? [...input.modelView, ...instructions] : input.modelView;
        assertRunProgressPayloadSecretFree(nextView);
        return { modelView: nextView, delegationInstructions: instructions,
          completedToolCallIds: validateRunProgressEffects(this.ports, run, events, existingView,
            input.sourceFence, this.context.database, { allowClosedFailedBash: true }) };
      });
      const head = this.head(run.id);
      const checkpointSourceEventSeq = input.sourceEventSeq + (delegationInstructions.length ? 1 : 0);
      const existing = this.context.database.prepare(`SELECT * FROM run_progress_checkpoints
        WHERE run_id=? AND source_attempt_id=? AND source_event_seq=?`).get(run.id, input.sourceFence.attemptId, checkpointSourceEventSeq);
      const predecessorId = existing ? rowRecord(existing).predecessorId : head.checkpointId;
      const payload: Payload = { schemaVersion: 1, boundary: "run-progress-model-view", runId: run.id,
        sourceFence: input.sourceFence, sourceEventSeq: checkpointSourceEventSeq, predecessorId, lineage,
        modelView, completedToolCallIds };
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > RUN_PROGRESS_MAX_PAYLOAD_BYTES) throw failure("checkpoint.snapshot_unavailable");
      const digest = runProgressHashJson(payload);
      const artifactId = input.artifactId ?? `artifact_${run.id}_progress_${input.sourceFence.attemptId}_${checkpointSourceEventSeq}`;
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
        if (predecessor.runId !== run.id || !isDeepStrictEqual(modelView.slice(0, previous.modelView.length), previous.modelView)
          || checkpointSourceEventSeq <= predecessor.sourceEventSeq) throw failure("checkpoint.lineage_mismatch");
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
          input.sourceFence.runtimeInstanceId, input.sourceFence.fencingToken, checkpointSourceEventSeq, predecessorId, artifactId,
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
      if (delegationInstructions.length) {
        const eventId = `evt_delegation_instruction_${randomUUID()}`;
        const data = { schemaVersion: 1 as const, attemptId: input.sourceFence.attemptId,
          messageIds: instructionIds, modelViewSha256: digest };
        if (!isRunEventData("delegation_instruction_checkpointed", data)) throw failure("checkpoint.commit_failed");
        this.context.database.prepare("INSERT INTO run_events(id,run_id,seq,ts,type,data_json) VALUES(?,?,?,?,?,?)")
          .run(eventId, run.id, checkpointSourceEventSeq, input.now, "delegation_instruction_checkpointed", JSON.stringify(data));
        for (const [offset, message] of delegationInstructions.entries()) {
          const index = modelView.length - delegationInstructions.length + offset + 1;
          this.context.database.prepare(`INSERT INTO delegation_instruction_receipts
            (message_id,run_id,checkpoint_id,event_id,model_view_index,message_digest,committed_at)
            VALUES(?,?,?,?,?,?,?)`).run(message.delegationInstruction.messageId, run.id, id, eventId, index,
              message.delegationInstruction.digest, input.now);
        }
      }
      this.context.database.exec("COMMIT;");
      return { kind: "committed", checkpoint, headRevision: head.revision + 1, replayed: false,
        ...(delegationInstructions.length ? { delegationInstructions } : {}) };
    } catch (error) { rollbackOwnedSqliteTransaction(this.context.database); return blocked(error); }
  }

  listPendingDelegationInstructionIds(raw: ListPendingDelegationInstructionsInput): readonly string[] {
    const input = plainInput(raw);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 32
      || !sameFence(input.sourceFence, input.delegationBinding.targetFence)) {
      throw failure("checkpoint.lineage_mismatch");
    }
    return readSqliteSnapshot(this.context.database, () => {
      this.assertDelegationInstructionTarget(input.runId, input.sourceFence, input.delegationBinding.reservationId);
      return this.context.database.prepare(`SELECT m.id FROM delegation_messages m
        JOIN delegation_budget_reservations r ON r.delegation_step_id=m.delegation_step_id
        LEFT JOIN delegation_instruction_receipts receipt ON receipt.message_id=m.id
        WHERE r.id=? AND r.child_run_id=? AND m.direction='parent_to_child' AND m.kind='instruction'
          AND receipt.message_id IS NULL ORDER BY m.created_at,m.id LIMIT ?`)
        .all(input.delegationBinding.reservationId, input.runId, input.limit)
        .map(row => String(row.id));
    });
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

  /** Exact A-to-B capacity handoff after ordinary progress is reverified in the activation transaction. */
  releaseSourceResourcesWithinTransaction(input: CommitExistingRunContinuationInput): boolean {
    if (input.preparation.origin !== "daemon_recovery" || !input.recoveryProgressCheckpointGuard
      || input.preparation.targetAttempt.runtimeInstanceId === input.preparation.sourceFence.runtimeInstanceId) return false;
    const verified = readSqliteWithinTransaction(this.context.database, () => {
      this.validateActivation(input);
      const source = input.preparation.sourceFence;
      const owner = this.context.database.prepare(`SELECT attempt.status AS attempt_status,unit.status AS unit_status,
        unit.active_attempt_id,run.status AS run_status FROM work_unit_attempts AS attempt
        JOIN work_units AS unit ON unit.id=attempt.work_unit_id
        JOIN run_sessions AS run ON run.id=unit.linked_run_id
        WHERE run.id=? AND run.work_unit_id=unit.id AND attempt.id=? AND attempt.work_unit_id=?
          AND attempt.runtime_instance_id=? AND attempt.fencing_token=?`)
        .get(input.preparation.runId, source.attemptId, source.workUnitId, source.runtimeInstanceId, source.fencingToken);
      if (!owner || owner.attempt_status !== "lost" || owner.unit_status !== "stale"
        || owner.active_attempt_id !== source.attemptId || !["queued", "running"].includes(String(owner.run_status))) return false;
      return true;
    });
    if (!verified) return false;
    const source = input.preparation.sourceFence;
    for (const table of ["resource_leases", "runtime_semaphore_slots"] as const) {
      this.context.database.prepare(`UPDATE ${table} SET status='released',released_at=?,release_reason=?
        WHERE status='active' AND work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=?`)
        .run(input.now, `run-progress-checkpoint-handoff:${input.preparation.idempotencyKey}`,
          source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken);
    }
    return true;
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
    if (input.continuationBinding && input.delegationBinding) throw failure("checkpoint.lineage_mismatch");
    const run = this.requireRun(input.runId), events = readRunProgressEvents(this.ports, input.runId);
    this.currentLineage(run, input.expectedLineage);
    const source = this.ports.getWorkUnitAttempt(input.sourceFence.attemptId), unit = this.ports.getWorkUnit(input.sourceFence.workUnitId);
    if (!source || !unit || !sameFence(toRuntimeAttemptFence(source), input.sourceFence) || unit.linkedRunId !== run.id
      || run.workUnitId !== unit.id || !["queued", "running"].includes(run.status) || run.endedAt) throw failure("checkpoint.lineage_mismatch");
    if (input.delegationBinding) {
      if (!hasDelegationStoppedHandoff(this.context.database, input.sourceFence, new Date().toISOString(), input.delegationBinding)) {
        throw failure("checkpoint.lineage_mismatch");
      }
    } else if (input.continuationBinding) {
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
    if (input.continuationBinding || input.delegationBinding) {
      validateRunProgressRecoveryBookkeeping(run, after, (input.continuationBinding ?? input.delegationBinding)!.targetFence.attemptId);
    } else if (unit.activeAttemptId !== source.id || !["stale", "running"].includes(unit.status)
      || !["lost", "started"].includes(source.status) || after.length) throw failure("checkpoint.source_watermark_changed");
    const payload = this.payload(checkpoint);
    if (!events.some(event => event.seq === checkpoint.sourceEventSeq)) throw failure("checkpoint.source_watermark_changed");
    const ordinaryView = this.verifyInstructionView(run.id, payload.modelView);
    const ids = validateRunProgressEffects(this.ports, run, events.slice(0, checkpoint.sourceEventSeq),
      ordinaryView, checkpoint.sourceFence, this.context.database, { allowClosedFailedBash: true });
    if (!isDeepStrictEqual(ids, payload.completedToolCallIds)) throw failure("checkpoint.snapshot_unavailable");
    return { kind: "verified", checkpoint, modelView: payload.modelView, witness: witness(checkpoint, head.revision) };
  }

  private assertSuccessorPredecessor(run: RunSession, input: CommitRunProgressCheckpointInput,
    predecessor: RunProgressCheckpoint, head: RunProgressCheckpointHead): void {
    if (!input.recoveryPredecessor || !isDeepStrictEqual(input.recoveryPredecessor, witness(predecessor, head.revision))) throw failure("checkpoint.lineage_mismatch");
    if (input.delegationBinding) {
      if (!sameFence(input.delegationBinding.targetFence, input.sourceFence)
        || !hasDelegationStoppedHandoff(this.context.database, predecessor.sourceFence, input.now, input.delegationBinding)) {
        throw failure("checkpoint.lineage_mismatch");
      }
      return;
    }
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

  private validateInstructionIds(input: CommitRunProgressCheckpointInput): void {
    const ids = input.delegationInstructionIds;
    if (ids === undefined) return;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 32 || !input.delegationBinding
      || !sameFence(input.sourceFence, input.delegationBinding.targetFence)
      || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,240}$/u.test(id))
      || new Set(ids).size !== ids.length) throw failure("checkpoint.lineage_mismatch");
  }

  private assertDelegationInstructionTarget(runId: string, fence: RuntimeAttemptFenceV1, reservationId: string): void {
    if (!this.context.database.prepare(`SELECT 1 WHERE ${runExecutionOwnerSql}`)
      .get(...runExecutionOwnerParameters(runId, fence, false))) throw failure("checkpoint.lineage_mismatch");
    const row = this.context.database.prepare(`SELECT 1 FROM delegation_budget_reservations r
      JOIN delegation_steps s ON s.id=r.delegation_step_id AND s.root_run_id=r.root_run_id
      JOIN run_sessions child ON child.id=r.child_run_id AND child.parent_run_id=s.parent_run_id
      JOIN work_units unit ON unit.id=child.work_unit_id AND unit.linked_run_id=child.id
      JOIN work_unit_attempts attempt ON attempt.id=unit.active_attempt_id AND attempt.work_unit_id=unit.id
      WHERE r.id=? AND child.id=? AND r.state='reserved' AND s.child_run_id=child.id
        AND s.state IN ('running','waiting','resuming') AND unit.id=? AND attempt.id=?
        AND attempt.runtime_instance_id=? AND attempt.fencing_token=?`)
      .get(reservationId, runId, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
    if (!row) throw failure("checkpoint.lineage_mismatch");
  }

  private readNewInstructions(runId: string, input: CommitRunProgressCheckpointInput,
    ids: readonly string[]): readonly DelegationInstructionModelMessage[] {
    const binding = input.delegationBinding!;
    this.assertDelegationInstructionTarget(runId, input.sourceFence, binding.reservationId);
    const pending = this.context.database.prepare(`SELECT m.id FROM delegation_messages m
      JOIN delegation_budget_reservations r ON r.delegation_step_id=m.delegation_step_id
      LEFT JOIN delegation_instruction_receipts receipt ON receipt.message_id=m.id
      WHERE r.id=? AND r.child_run_id=? AND m.direction='parent_to_child' AND m.kind='instruction'
        AND receipt.message_id IS NULL ORDER BY m.created_at,m.id LIMIT ?`)
      .all(binding.reservationId, runId, ids.length).map(row => String(row.id));
    if (!isDeepStrictEqual(pending, ids)) throw failure("checkpoint.head_conflict");
    return ids.map(id => this.readInstructionMessage(runId, id, binding.reservationId));
  }

  private readInstructionMessage(runId: string, id: string, reservationId?: string): DelegationInstructionModelMessage {
    const row = this.context.database.prepare(`SELECT m.*,s.parent_run_id,r.id AS reservation_id,r.child_run_id
      FROM delegation_messages m JOIN delegation_steps s ON s.id=m.delegation_step_id
      JOIN delegation_budget_reservations r ON r.delegation_step_id=s.id
      WHERE m.id=?`).get(id);
    if (!row || row.schema_version !== 1 || row.direction !== "parent_to_child" || row.kind !== "instruction"
      || row.child_run_id !== runId || reservationId !== undefined && row.reservation_id !== reservationId
      || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.digest)) {
      throw failure("checkpoint.lineage_mismatch");
    }
    const artifact = this.artifacts.getArtifact(String(row.body_artifact_id));
    if (!artifact || artifact.runId !== row.parent_run_id || artifact.type !== "json"
      || artifact.path !== "sqlite:delegation-instruction" || artifact.contentType !== "application/json"
      || artifact.contentSha256 !== row.digest || artifact.sealedPayload === undefined) {
      throw failure("checkpoint.snapshot_unavailable");
    }
    const payload = plainInput(artifact.sealedPayload);
    if (!isRunProgressRecord(payload) || Object.keys(payload).sort().join(",") !==
      ["schemaVersion", "kind", "parentFence", "text"].sort().join(",")
      || payload.schemaVersion !== 1 || payload.kind !== "delegation.instruction.v1"
      || typeof payload.text !== "string" || !payload.text.trim() || !isRunProgressRecord(payload.parentFence)
      || delegationDigest(payload) !== row.digest) throw failure("checkpoint.snapshot_unavailable");
    const timestamp = Date.parse(String(row.created_at));
    if (!Number.isFinite(timestamp)) throw failure("checkpoint.snapshot_unavailable");
    return { role: "user", content: payload.text, timestamp,
      delegationInstruction: { messageId: id, digest: String(row.digest) } };
  }

  private verifyInstructionView(runId: string, view: readonly unknown[]): readonly unknown[] {
    const ordinary: unknown[] = [], seen = new Set<string>();
    for (const [index, value] of view.entries()) {
      if (!isRunProgressRecord(value) || !Object.prototype.hasOwnProperty.call(value, "delegationInstruction")) {
        ordinary.push(value);
        continue;
      }
      const identity = value.delegationInstruction;
      if (!isRunProgressRecord(identity) || Object.keys(value).sort().join(",") !==
        ["role", "content", "timestamp", "delegationInstruction"].sort().join(",")
        || Object.keys(identity).sort().join(",") !== ["messageId", "digest"].sort().join(",")
        || value.role !== "user" || typeof value.content !== "string" || typeof value.timestamp !== "number"
        || !Number.isFinite(value.timestamp) || typeof identity.messageId !== "string"
        || typeof identity.digest !== "string" || seen.has(identity.messageId)) {
        throw failure("checkpoint.snapshot_unavailable");
      }
      const receipt = this.context.database.prepare(`SELECT receipt.*,event.type,event.data_json,
        checkpoint.model_view_sha256 FROM delegation_instruction_receipts receipt
        JOIN run_events event ON event.id=receipt.event_id AND event.run_id=receipt.run_id
        JOIN run_progress_checkpoints checkpoint ON checkpoint.id=receipt.checkpoint_id AND checkpoint.run_id=receipt.run_id
        WHERE receipt.message_id=?`).get(identity.messageId);
      if (!receipt || receipt.run_id !== runId || receipt.model_view_index !== index + 1
        || receipt.message_digest !== identity.digest || receipt.type !== "delegation_instruction_checkpointed") {
        throw failure("checkpoint.snapshot_unavailable");
      }
      const data: unknown = JSON.parse(String(receipt.data_json));
      if (!isRunEventData("delegation_instruction_checkpointed", data)
        || data.modelViewSha256 !== receipt.model_view_sha256 || !data.messageIds.includes(identity.messageId)) {
        throw failure("checkpoint.snapshot_unavailable");
      }
      const expected = this.readInstructionMessage(runId, identity.messageId);
      if (!isDeepStrictEqual(value, expected)) throw failure("checkpoint.snapshot_unavailable");
      seen.add(identity.messageId);
    }
    return ordinary;
  }

  private replayInstructionCheckpoint(input: CommitRunProgressCheckpointInput, run: RunSession,
    lineage: RunProgressCheckpointLineage, ids: readonly string[]): CommitRunProgressCheckpointResult | undefined {
    const placeholders = ids.map(() => "?").join(",");
    const receipts = this.context.database.prepare(`SELECT * FROM delegation_instruction_receipts
      WHERE message_id IN (${placeholders}) ORDER BY model_view_index`).all(...ids);
    if (receipts.length === 0) return undefined;
    if (receipts.length !== ids.length) throw failure("checkpoint.head_conflict");
    const checkpointIds = new Set(receipts.map(row => String(row.checkpoint_id)));
    const eventIds = new Set(receipts.map(row => String(row.event_id)));
    if (checkpointIds.size !== 1 || eventIds.size !== 1
      || !isDeepStrictEqual(receipts.map(row => String(row.message_id)), ids)) throw failure("checkpoint.head_conflict");
    const checkpoint = this.checkpoint(String(receipts[0].checkpoint_id)), head = this.head(run.id);
    if (checkpoint.runId !== run.id || !sameFence(checkpoint.sourceFence, input.sourceFence)
      || checkpoint.sourceEventSeq !== input.sourceEventSeq + 1 || checkpoint.predecessorId !== input.expectedHead.checkpointId
      || head.checkpointId !== checkpoint.id || head.revision !== input.expectedHead.revision + 1
      || !isDeepStrictEqual(checkpoint.lineage, lineage)) throw failure("checkpoint.head_conflict");
    const messages = ids.map(id => this.readInstructionMessage(run.id, id, input.delegationBinding!.reservationId));
    const payload = this.payload(checkpoint);
    if (!isDeepStrictEqual(payload.modelView, [...input.modelView, ...messages])) throw failure("checkpoint.head_conflict");
    return { kind: "committed", checkpoint, headRevision: head.revision, replayed: true,
      delegationInstructions: messages };
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
    this.verifyInstructionView(checkpoint.runId, value.modelView);
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
