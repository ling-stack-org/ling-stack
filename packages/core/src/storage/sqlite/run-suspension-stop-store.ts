import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { delegationDigest, delegationFence, delegationId, delegationJson, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import type { DelegationCompletionStepReadV1 } from "../../delegation-completion-evidence.js";
import type { HostAttemptCompletionRecord } from "../../host-attempt-completion-types.js";
import { captureRunProgressCheckpointLineage, type RunProgressLineageStore } from "../../run-progress-checkpoint-lineage.js";
import type { ReadRunCompactionSuspensionWitnessResult, RunSuspensionRecord } from "../../run-suspension-types.js";
import { RunProgressCheckpointError } from "../../run-progress-checkpoint-types.js";
import type { RunSuspensionDescendantProofV1, RunSuspensionDescendantV1, RunSuspensionStopBeginV1,
  RunSuspensionStopInput, RunSuspensionStopRecord, RunSuspensionStoppedV1, RunSuspensionStopSourceV1 } from "../../run-suspension-stop-types.js";
import type { CreateRunArtifactInput, RunArtifact, RunSession, RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import type { SqliteDelegationLifecycleStore } from "./delegation-lifecycle-store.js";
import type { SqliteRunSuspensionStore } from "./run-suspension-store.js";
import type { SqliteRuntimeWorkUnitStore } from "./runtime-work-unit-store.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody, syncHarnessArtifactOwnerPins } from "./harness-artifact-recovery-pins.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { hostAttemptReadScopeForSource } from "./host-attempt-read-scope.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { assertNoPendingRunTerminalIntent } from "./run-terminal-intent-store.js";
import { readRunSuspensionStopRecord, runSuspensionStopArtifacts, stopFail as fail } from "./run-suspension-stop-records.js";
import { neverDispatchedDescendantDigest } from "./run-suspension-queued-proof.js";
import type { SqliteStoreContext } from "./store-context.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { verifyRunCompactionSuspensionWitness } from "./run-compaction-suspension-witness.js";
import { verifyRunFinalSettlement } from "./run-final-settlement-store.js";
import type { ReadRunFinalSettlementResult } from "../../run-final-settlement-types.js";
import { readRootSuspensionActivationRecord } from "./run-suspension-activation-records.js";
import { readRootSuspensionStartRecord } from "./run-suspension-start-records.js";
import { readDelegatedSuspensionActivationRecord, readDelegatedSuspensionStartRecord } from "./run-suspension-delegated-records.js";
import { readRunProgressEvents, validateRunProgressRecoveryBookkeeping } from "./run-progress-checkpoint-effects.js";

type Ports = RunProgressLineageStore & Pick<RunStore, "getRun" | "getWorkUnitAttempt" | "getHostAttemptCompletion"
  | "getDelegationCompletionEvidence" | "readRunProgressCheckpointForRecovery" | "getChannelWorkflowStep" | "getChannelWorkflow"
  | "transitionWorkUnitStatus" | "updateWorkUnitAttemptStatus" | "appendTerminalRuntimeAudit"
  | "releaseResourceLeasesForAttempt" | "releaseRuntimeSemaphoreSlotsForAttempt"
  | "listEvents" | "listHarnessToolExecutions" | "listHostCommandWriteBlockers" | "listApprovalRequests"> & Pick<SqliteRunSuspensionStore, "getRunSuspension">
  & Pick<SqliteRuntimeWorkUnitStore, "findWorkUnitAttemptTerminalAudit">
  & Pick<SqliteDelegationLifecycleStore, "requestDelegatedChildInterruptWithinTransaction" | "commitDelegatedChildInterruptedWithinTransaction"> & {
    readonly createArtifactWithinTransaction: (input: CreateRunArtifactInput) => RunArtifact;
  };
const same = isDeepStrictEqual;
const terminal = (status: string): boolean => ["succeeded", "failed", "cancelled"].includes(status);

/** Host-only, exact-source physical closure. Neither method terminalizes a logical Run or activates recovery. */
export class SqliteRunSuspensionStopStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  beginRunSuspensionStop(raw: RunSuspensionStopInput): RunSuspensionStopRecord {
    const input = this.input(raw);
    return this.write(() => {
      const prior = this.read(() => this.getRunSuspensionStop(input.suspensionId));
      if (prior) {
        if (!same(prior.begin.sourceFence, input.sourceFence) || input.now < prior.begin.begunAt) fail("source_stale");
        this.read(() => this.assertCurrent(prior, input.now, prior.state));
        return prior;
      }
      const facts = this.read(() => {
        const saved = this.sealed(input.suspensionId, input.sourceFence, input.now);
        const { run, unit, attempt } = this.owner(saved);
        if (unit.status !== "running" || unit.endedAt || attempt.status !== "started" || attempt.endedAt || attempt.abortRequestedAt) fail("source_stale");
        this.assertFrozen(saved);
        if (saved.seal!.witness.kind === "ordinary") {
          const verified = this.ports.readRunProgressCheckpointForRecovery({ runId: run.id, sourceFence: input.sourceFence,
            expectedLineage: saved.request.lineage });
          if (verified.kind !== "verified" || !same(verified.witness, saved.seal!.witness.checkpoint)
            || verified.checkpoint.modelViewArtifactId !== saved.seal!.modelViewArtifactId) fail("snapshot_unverified");
        }
        return { saved, run, unit, descendants: this.inventory(run.id).nodes };
      });
      let source: RunSuspensionStopSourceV1 = { kind: "root" };
      if (facts.unit.ownerType === "delegation_step") {
        const edge = this.read(() => this.delegatedEdge(facts.run.id));
        const parent = this.ports.getRun(edge.step.parentRunId), parentUnit = parent?.workUnitId ? this.ports.getWorkUnit(parent.workUnitId) : undefined;
        const parentAttempt = parentUnit?.activeAttemptId ? this.ports.getWorkUnitAttempt(parentUnit.activeAttemptId) : undefined;
        if (!parent || !parentAttempt || parent.status !== "running" || parentUnit?.status !== "running"
          || parentAttempt.status !== "started" || parentAttempt.endedAt || parentAttempt.abortRequestedAt) fail("parent_stale");
        const parentFence = toRuntimeAttemptFence(parentAttempt), callId = `suspension_stop_${randomUUID()}`;
        const interrupted = this.ports.requestDelegatedChildInterruptWithinTransaction({ reservationId: edge.reservation!.id, parentFence, callId, now: input.now });
        if (interrupted.replayed || !same(interrupted.sourceFence, input.sourceFence)) fail("interrupt_conflict");
        const message = this.context.database.prepare("SELECT id,body_artifact_id,digest FROM delegation_messages WHERE idempotency_key=?")
          .get(`delegation-interrupt:${parentFence.attemptId}:${callId}`);
        if (!message) fail("interrupt_missing");
        source = { kind: "delegated", reservationId: edge.reservation!.id, stepId: edge.step.id, parentRunId: parent.id,
          parentFence, lineageDigest: edgeDigest(edge), interruptMessageId: String(message.id), interruptArtifactId: String(message.body_artifact_id),
          interruptDigest: String(message.digest) };
      } else if (facts.run.parentRunId) fail("lineage_invalid");
      const begin: RunSuspensionStopBeginV1 = { schemaVersion: 1, kind: "run.suspension_stop_begin.v1", suspensionId: input.suspensionId,
        runId: facts.run.id, sourceFence: input.sourceFence, sealDigest: facts.saved.sealDigest!, modelAdmissionDigest: this.modelAdmissions(facts.run.id),
        canonicalEventDigest: this.canonicalEvents(facts.run.id), source, descendants: facts.descendants, begunAt: input.now };
      const artifact = this.create(begin.runId, begin, "begin", input.now);
      this.context.database.prepare(`INSERT INTO run_suspension_stops
        (suspension_id,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,begin_artifact_id,begin_digest,state,begun_at)
        VALUES (?,?,?,?,?,?,?,?,'stopping',?)`).run(begin.suspensionId, begin.runId, input.sourceFence.workUnitId, input.sourceFence.attemptId,
          input.sourceFence.runtimeInstanceId, input.sourceFence.fencingToken, artifact.id, artifact.contentSha256!, input.now);
      const result: RunSuspensionStopRecord = { suspensionId: begin.suspensionId, state: "stopping", beginArtifactId: artifact.id,
        beginDigest: artifact.contentSha256!, begin };
      this.pins(result, input.now);
      this.read(() => { this.assertCurrent(result, input.now, "stopping"); this.assertInventory(result); });
      return this.read(() => this.getRunSuspensionStop(begin.suspensionId))!;
    });
  }

  commitRunSuspensionStopped(raw: RunSuspensionStopInput): RunSuspensionStopRecord {
    const input = this.input(raw);
    return this.write(() => {
      const record = this.read(() => this.getRunSuspensionStop(input.suspensionId));
      if (!record) fail("missing");
      if (!same(record.begin.sourceFence, input.sourceFence) || input.now < record.begin.begunAt) fail("source_stale");
      const proofs = this.read(() => {
        this.assertCurrent(record, input.now, record.state);
        const completion = this.completion(record, input.now);
        const descendants = this.descendantProofs(record, input.now);
        if (record.receipt && (!same(record.receipt.descendants, descendants) || record.receipt.completionDigest !== delegationDigest(completion))) fail("receipt_changed");
        return { completion, descendants };
      });
      if (record.state === "stopped") return record;
      const { source, sourceFence: fence } = record.begin;
      let stopped: RunSuspensionStopRecord | undefined;
      const publishReceipt = (): void => {
        if (stopped) fail("receipt_conflict");
        const attempt = this.ports.getWorkUnitAttempt(fence.attemptId), audit = attempt ? this.ports.findWorkUnitAttemptTerminalAudit(attempt) : undefined;
        if (!audit) fail("audit_missing");
        const receipt: RunSuspensionStoppedV1 = { schemaVersion: 1, kind: "run.suspension_stopped.v1", suspensionId: record.suspensionId,
          runId: record.begin.runId, sourceFence: fence, beginDigest: record.beginDigest, sealDigest: record.begin.sealDigest,
          completionDigest: delegationDigest(proofs.completion), drainedAt: proofs.completion.drainedAt!, audit: { seq: audit.seq, digest: delegationDigest(audit) },
          descendants: proofs.descendants, stoppedAt: input.now };
        const artifact = this.create(receipt.runId, receipt, "receipt", input.now);
        const changed = this.context.database.prepare(`UPDATE run_suspension_stops SET state='stopped',receipt_artifact_id=?,receipt_digest=?,stopped_at=?
          WHERE suspension_id=? AND state='stopping' AND attempt_id=? AND fencing_token=?`).run(artifact.id, artifact.contentSha256!, input.now,
            record.suspensionId, fence.attemptId, fence.fencingToken);
        if (changed.changes !== 1) fail("receipt_cas_failed");
        stopped = { ...record, state: "stopped", receiptArtifactId: artifact.id, receiptDigest: artifact.contentSha256!, receipt };
        this.pins(stopped, input.now);
      };
      if (source.kind === "delegated") {
        this.ports.commitDelegatedChildInterruptedWithinTransaction({ reservationId: source.reservationId, sourceFence: fence, now: input.now }, publishReceipt);
      } else {
        const unit = this.ports.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "runner_lost", actor: "system",
          reason: "Host-sealed graceful suspension", idempotencyKey: `${record.suspensionId}:physical-stop`, now: input.now,
          errorCode: "runtime_graceful_suspend", errorMessage: "Host-sealed graceful suspension; logical Run remains open." });
        const attempt = this.ports.updateWorkUnitAttemptStatus({ ...fence, status: "lost", now: input.now, endedAt: input.now,
          errorCode: "runtime_graceful_suspend", errorMessage: "Host-sealed graceful suspension; original physical lifetime drained." });
        if (!unit.ok || !attempt) fail("source_cas_failed");
        this.ports.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: "lost", transitionedAt: input.now },
          type: "work_unit_stale", actor: "system", data: { kind: "run_suspension_stopped_v1", suspensionId: record.suspensionId,
            beginDigest: record.beginDigest, sealDigest: record.begin.sealDigest } });
        publishReceipt();
      }
      if (!stopped) fail("receipt_missing");
      const committed = stopped;
      this.read(() => {
        this.assertCurrent(committed, input.now, "stopped");
        if (!same(this.descendantProofs(committed, input.now), committed.receipt!.descendants)
          || delegationDigest(this.completion(committed, input.now)) !== committed.receipt!.completionDigest) fail("receipt_changed");
      });
      this.ports.releaseResourceLeasesForAttempt(fence, input.now, "run-suspension-stopped");
      this.ports.releaseRuntimeSemaphoreSlotsForAttempt(fence, input.now, "run-suspension-stopped");
      this.assertNoActiveResources(fence);
      return this.read(() => this.getRunSuspensionStop(record.suspensionId))!;
    });
  }

  getRunSuspensionStop(id: string): RunSuspensionStopRecord | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      const record = readRunSuspensionStopRecord(this.context.database, id);
      if (record) this.sealed(record.suspensionId, record.begin.sourceFence, record.receipt?.stoppedAt ?? record.begin.begunAt);
      return record;
    });
  }

  /** Constructor-private read observation for preflight. Unlike the public live
   * reader, this requires the exact current stopped source and original drain
   * receipt. It neither changes custody nor issues a start/dispatch capability. */
  readStoppedCompactionSuspensionRecovery(raw: RunSuspensionStopInput): ReadRunCompactionSuspensionWitnessResult {
    const input = this.input(raw);
    return readSqliteSnapshot(this.context.database, () => {
      try {
        this.assertStoppedWithinTransaction(input);
        const saved = this.sealed(input.suspensionId, input.sourceFence, input.now);
        if (saved.seal!.witness.kind !== "compaction") return { kind: "not_compacted" };
        return verifyRunCompactionSuspensionWitness(this.context, this.ports,
          { runId: saved.request.runId, sourceFence: input.sourceFence, expectedLineage: saved.request.lineage }, saved.seal!.witness);
      } catch (error) {
        return { kind: "blocked", code: error instanceof RunProgressCheckpointError ? error.code : "checkpoint.effect_unknown" };
      }
    });
  }

  /** Original stopped-source observation, including its exact immutable184/186 target.
   * This never grants admission, ACKs an SDK, or accepts a caller-selected handoff. */
  readStoppedFinalSettlementRecovery(raw: RunSuspensionStopInput): ReadRunFinalSettlementResult {
    const input = this.input(raw);
    return readSqliteSnapshot(this.context.database, () => {
      try {
        const saved = this.sealed(input.suspensionId, input.sourceFence, input.now);
        if (saved.seal!.witness.kind !== "settlement") return { kind: "not_settled" };
        const witness = saved.seal!.witness;
        const stopped = this.getRunSuspensionStop(input.suspensionId);
        if (!stopped?.receipt || stopped.state !== "stopped" || !same(stopped.begin.sourceFence, input.sourceFence)
          || stopped.begin.sealDigest !== saved.sealDigest) fail("not_stopped");
        const run = this.ports.getRun(saved.request.runId), unit = this.ports.getWorkUnit(input.sourceFence.workUnitId);
        if (!run || !unit || run.status !== "running" || run.endedAt || unit.linkedRunId !== run.id) fail("source_stale");
        let tail: ReturnType<typeof readRunProgressEvents> = [];
        if (unit.activeAttemptId === input.sourceFence.attemptId) this.assertStoppedWithinTransaction(input);
        else {
          const root = readRootSuspensionActivationRecord(this.context.database, input.suspensionId);
          const child = readDelegatedSuspensionActivationRecord(this.context.database, input.suspensionId);
          if (Boolean(root) === Boolean(child)) fail("source_stale");
          const activation = (root ?? child)!.activation;
          const target = this.ports.getWorkUnitAttempt(activation.targetFence.attemptId);
          if (activation.runId !== run.id || !same(activation.sourceFence, input.sourceFence) || unit.activeAttemptId !== activation.targetFence.attemptId
            || !target || !same(toRuntimeAttemptFence(target), activation.targetFence) || !["created", "started"].includes(target.status)
            || target.abortRequestedAt || target.endedAt || !["queued", "claimed", "running"].includes(unit.status) || unit.endedAt) fail("source_stale");
          const start = root ? readRootSuspensionStartRecord(this.context.database, input.suspensionId)
            : readDelegatedSuspensionStartRecord(this.context.database, input.suspensionId);
          if (target.status === "started" && !start) fail("source_stale");
          this.assertAudit(stopped);
          if (delegationDigest(this.completion(stopped, input.now)) !== stopped.receipt.completionDigest) fail("receipt_changed");
          this.assertNoActiveResources(input.sourceFence);
          tail = readRunProgressEvents(this.ports, run.id).filter(event => event.seq > witness.settlement.boundaryEventSeq);
          if (tail.length && !start) fail("watermark_changed");
          validateRunProgressRecoveryBookkeeping(run, tail, target.id);
          for (const proof of stopped.receipt.descendants) if (proof.kind === "stopped") {
            const descendant = readRunSuspensionStopRecord(this.context.database, proof.suspensionId);
            if (!descendant?.receipt || descendant.begin.runId !== proof.runId || descendant.receiptArtifactId !== proof.receiptArtifactId
              || descendant.receiptDigest !== proof.receiptDigest) fail("descendant_evidence_invalid");
          }
        }
        return verifyRunFinalSettlement(this.context, this.ports, witness, input.now, tail);
      } catch (error) { return { kind: "blocked", code: error instanceof RunProgressCheckpointError ? error.code : "checkpoint.effect_unknown" }; }
    });
  }

  /** Only the original constructor's activation coordinator may consume this current physical-stop proof. */
  assertStoppedWithinTransaction(input: RunSuspensionStopInput): RunSuspensionStopRecord {
    if (!this.context.database.isTransaction) fail("transaction_missing");
    return this.read(() => {
      const record = this.getRunSuspensionStop(input.suspensionId);
      if (!record?.receipt || record.state !== "stopped" || !same(record.begin.sourceFence, input.sourceFence)) fail("not_stopped");
      this.assertCurrent(record, input.now, "stopped");
      if (!same(this.descendantProofs(record, input.now), record.receipt.descendants)
        || delegationDigest(this.completion(record, input.now)) !== record.receipt.completionDigest) fail("receipt_changed");
      this.assertNoActiveResources(input.sourceFence);
      return record;
    });
  }

  private input(raw: RunSuspensionStopInput): RunSuspensionStopInput {
    const input = delegationRecord(raw, ["suspensionId", "sourceFence", "now"]);
    return { suspensionId: delegationId(input.suspensionId), sourceFence: delegationFence(input.sourceFence), now: delegationTimestamp(input.now) };
  }
  private sealed(id: string, fence: RuntimeAttemptFenceV1, now: string): RunSuspensionRecord {
    const record = this.ports.getRunSuspension(id);
    if (!record?.seal || !record.sealDigest || record.state !== "sealed") fail("not_sealed");
    if (!same(record.request.sourceFence, fence) || now < record.seal.sealedAt) fail("source_stale");
    return record;
  }
  private owner(saved: RunSuspensionRecord) {
    const fence = saved.request.sourceFence, run = this.ports.getRun(saved.request.runId), unit = this.ports.getWorkUnit(fence.workUnitId),
      attempt = this.ports.getWorkUnitAttempt(fence.attemptId);
    if (!run || !unit || !attempt || run.status !== "running" || run.endedAt || run.workUnitId !== unit.id || unit.linkedRunId !== run.id
      || unit.activeAttemptId !== attempt.id || !same(toRuntimeAttemptFence(attempt), fence)) fail("source_stale");
    return { run, unit, attempt };
  }
  private assertFrozen(saved: RunSuspensionRecord): void {
    const { run } = this.owner(saved), seal = saved.seal!;
    assertNoPendingRunTerminalIntent(this.context, run.id);
    if (contextDigest(run) !== saved.request.contextDigest || this.selectionDigest(run) !== saved.request.selectionDigest) fail("context_changed");
    if (!same(captureRunProgressCheckpointLineage(this.ports, run).lineage, saved.request.lineage)) fail("lineage_changed");
    if (seal.witness.kind === "settlement") {
      if (verifyRunFinalSettlement(this.context, this.ports, seal.witness, new Date().toISOString()).modelViewArtifactId !== seal.modelViewArtifactId) fail("snapshot_unverified");
      return;
    }
    if (seal.witness.kind === "compaction") {
      const verified = verifyRunCompactionSuspensionWitness(this.context, this.ports, { runId: run.id,
        sourceFence: saved.request.sourceFence, expectedLineage: saved.request.lineage }, seal.witness);
      if (verified.modelViewArtifactId !== seal.modelViewArtifactId) fail("snapshot_unverified");
      if (this.context.database.prepare("SELECT 1 FROM delegation_budget_charges WHERE run_id=? AND created_at>? LIMIT 1").get(run.id, seal.sealedAt)) fail("post_seal_dispatch");
      return;
    }
    const witness = seal.witness.checkpoint;
    const head = this.context.database.prepare("SELECT checkpoint_id,revision FROM run_progress_checkpoint_heads WHERE run_id=?").get(run.id);
    const checkpoint = this.context.database.prepare("SELECT * FROM run_progress_checkpoints WHERE id=?").get(witness.checkpointId);
    const tail = this.context.database.prepare("SELECT COALESCE(MAX(seq),0) seq FROM run_events WHERE run_id=?").get(run.id);
    if (!head || head.checkpoint_id !== witness.checkpointId || head.revision !== witness.headRevision || tail?.seq !== witness.sourceEventSeq
      || !checkpoint || checkpoint.run_id !== run.id || checkpoint.work_unit_id !== witness.sourceFence.workUnitId
      || checkpoint.source_attempt_id !== witness.sourceFence.attemptId || checkpoint.source_runtime_instance_id !== witness.sourceFence.runtimeInstanceId
      || checkpoint.source_fencing_token !== witness.sourceFence.fencingToken || checkpoint.source_event_seq !== witness.sourceEventSeq
      || checkpoint.model_view_artifact_id !== seal.modelViewArtifactId || checkpoint.model_view_sha256 !== witness.modelViewSha256
      || !same(JSON.parse(String(checkpoint.lineage_json)), witness.lineage)) fail("watermark_changed");
    if (readHarnessRetainedBody(this.context.database, seal.modelViewArtifactId).contentSha256 !== witness.modelViewSha256) fail("snapshot_unverified");
    if (this.context.database.prepare("SELECT 1 FROM delegation_budget_charges WHERE run_id=? AND created_at>? LIMIT 1").get(run.id, seal.sealedAt)) fail("post_seal_dispatch");
  }
  private assertCurrent(record: RunSuspensionStopRecord, now: string, state: "stopping" | "stopped"): void {
    const saved = this.sealed(record.suspensionId, record.begin.sourceFence, now);
    if (saved.sealDigest !== record.begin.sealDigest) fail("seal_changed");
    this.assertFrozen(saved);
    const { run, unit, attempt } = this.owner(saved), source = record.begin.source;
    if (this.modelAdmissions(run.id) !== record.begin.modelAdmissionDigest) fail("post_seal_dispatch");
    if (this.canonicalEvents(run.id) !== record.begin.canonicalEventDigest) fail("watermark_changed");
    if (source.kind === "root") {
      if (run.parentRunId || unit.ownerType === "delegation_step" || attempt.abortRequestedAt || unit.endedAt) fail("source_stale");
      if (state === "stopping" ? unit.status !== "running" || attempt.status !== "started" || attempt.endedAt
        : unit.status !== "stale" || attempt.status !== "lost" || attempt.errorCode !== "runtime_graceful_suspend" || attempt.endedAt !== record.receipt?.stoppedAt) fail("source_stale");
    } else {
      const edge = this.delegatedEdge(run.id);
      if (unit.ownerType !== "delegation_step" || source.stepId !== edge.step.id || source.reservationId !== edge.reservation?.id
        || source.parentRunId !== run.parentRunId || source.lineageDigest !== edgeDigest(edge) || edge.reservation?.state !== "reserved"
        || attempt.abortRequestedAt !== record.begin.begunAt) fail("lineage_changed");
      if (state === "stopping" ? unit.status !== "cancelling" || attempt.status !== "cancelling" || attempt.endedAt || edge.step.state !== "interrupting"
        : unit.status !== "cancelled" || attempt.status !== "cancelled" || attempt.errorCode !== "delegation_interrupted"
          || attempt.endedAt !== record.receipt?.stoppedAt || unit.endedAt !== record.receipt?.stoppedAt || edge.step.state !== "interrupted") fail("source_stale");
      this.assertInterrupt(record);
    }
    if (record.receipt) this.assertAudit(record);
  }
  private assertInterrupt(record: RunSuspensionStopRecord): void {
    const source = record.begin.source;
    if (source.kind !== "delegated") return;
    const db = this.context.database, message = db.prepare("SELECT * FROM delegation_messages WHERE id=?").get(source.interruptMessageId);
    if (!message || message.delegation_step_id !== source.stepId || message.kind !== "control" || message.direction !== "parent_to_child"
      || message.body_artifact_id !== source.interruptArtifactId || message.digest !== source.interruptDigest || message.created_at !== record.begin.begunAt) fail("interrupt_changed");
    const retained = readHarnessRetainedBody(db, source.interruptArtifactId), artifact = db.prepare("SELECT * FROM artifacts WHERE id=?").get(source.interruptArtifactId);
    if (retained.bytes > 65_536 || retained.contentSha256 !== source.interruptDigest || artifact?.run_id !== source.parentRunId
      || artifact.type !== "json" || artifact.path !== "sqlite:delegation-control" || artifact.content_type !== "application/json") fail("interrupt_changed");
    const payload = delegationRecord(JSON.parse(String(artifact.sealed_payload_json)), ["schemaVersion", "kind", "parentFence", "sourceFence", "callId", "requestedAt"]);
    if (payload.schemaVersion !== 1 || payload.kind !== "delegation.interrupt.v1" || !same(delegationFence(payload.parentFence), source.parentFence)
      || !same(delegationFence(payload.sourceFence), record.begin.sourceFence) || payload.requestedAt !== record.begin.begunAt
      || message.idempotency_key !== `delegation-interrupt:${source.parentFence.attemptId}:${delegationId(payload.callId)}`) fail("interrupt_changed");
    const duplicates = db.prepare(`SELECT m.id FROM delegation_messages m JOIN artifacts a ON a.id=m.body_artifact_id
      WHERE m.delegation_step_id=? AND m.direction='parent_to_child' AND m.kind='control'
      AND json_extract(a.sealed_payload_json,'$.kind')='delegation.interrupt.v1'
      AND json_extract(a.sealed_payload_json,'$.sourceFence.attemptId')=? LIMIT 2`).all(source.stepId, record.begin.sourceFence.attemptId);
    if (duplicates.length !== 1 || duplicates[0]!.id !== source.interruptMessageId) fail("interrupt_changed");
  }
  private assertAudit(record: RunSuspensionStopRecord): void {
    const attempt = this.ports.getWorkUnitAttempt(record.begin.sourceFence.attemptId), audit = attempt ? this.ports.findWorkUnitAttemptTerminalAudit(attempt) : undefined;
    if (!audit || audit.seq !== record.receipt!.audit.seq || delegationDigest(audit) !== record.receipt!.audit.digest
      || audit.ts !== record.receipt!.stoppedAt || !same({ workUnitId: audit.workUnitId, attemptId: audit.attemptId,
        runtimeInstanceId: audit.runtimeInstanceId, fencingToken: audit.fencingToken }, record.begin.sourceFence)) fail("audit_changed");
    const expected = record.begin.source.kind === "root"
      ? { kind: "run_suspension_stopped_v1", suspensionId: record.suspensionId, beginDigest: record.beginDigest, sealDigest: record.begin.sealDigest }
      : { kind: "delegation_interrupted", stepId: record.begin.source.stepId };
    if (audit.type !== (record.begin.source.kind === "root" ? "work_unit_stale" : "work_unit_cancelled") || !same(audit.data, expected)) fail("audit_changed");
  }
  private completion(record: RunSuspensionStopRecord, now: string): HostAttemptCompletionRecord {
    const { runId, sourceFence } = record.begin, source = { runId, ...sourceFence }, completion = this.ports.getHostAttemptCompletion(source);
    if (!completion?.drainedAt || !completion.effectCoverage || !same(completion.source, source) || completion.registeredAt > record.begin.begunAt
      || completion.drainedAt > now || completion.registeredAt > completion.drainedAt) fail("host_not_drained");
    assertUserInputDurableQuiescence(this.context.database, runId, sourceFence, Date.parse(now), hostAttemptReadScopeForSource(this.context.database, source));
    if (this.context.database.prepare(`SELECT 1 FROM user_input_requests WHERE (source_run_id=? OR source_attempt_id=?)
      AND (status='pending' OR wait_status IN ('waiting','resuming','blocked') OR EXISTS (SELECT 1 FROM user_input_answers a
        JOIN user_input_deliveries d ON d.answer_id=a.answer_id WHERE a.request_id=user_input_requests.request_id
        AND d.status IN ('pending','claimed','failed'))) LIMIT 1`).get(runId, sourceFence.attemptId)
      || this.context.database.prepare("SELECT 1 FROM approval_requests WHERE run_id=? AND status='pending' LIMIT 1").get(runId)) fail("question_pending");
    if (this.context.database.prepare("SELECT 1 FROM delegation_budget_charges WHERE run_id=? AND state NOT IN ('measured','cancelled_before_dispatch') LIMIT 1").get(runId)) fail("usage_unverified");
    return completion;
  }
  private inventory(runId: string) {
    const evidence = this.ports.getDelegationCompletionEvidence({ rootRunIds: [runId] });
    if (evidence.issues.length) fail("descendant_evidence_invalid");
    const rows = this.context.database.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION
      SELECT r.id FROM run_sessions r JOIN tree p ON r.parent_run_id=p.id LIMIT 4098) SELECT id FROM tree ORDER BY id`).all(runId);
    if (rows.length > 4097) fail("descendant_limit");
    const actual = rows.map(row => String(row.id)).filter(id => id !== runId);
    const nodes: RunSuspensionDescendantV1[] = evidence.steps.map(read => {
      if (!read.childRun || !read.workUnit || !read.reservation || !read.parentRun || read.childRun.id === runId) fail("descendant_lineage_invalid");
      return { runId: read.childRun.id, parentRunId: read.parentRun.id, workUnitId: read.workUnit.id, stepId: read.step.id,
        reservationId: read.reservation.id, lineageDigest: edgeDigest(read), ...(read.attempt ? { sourceFence: read.attempt.sourceFence }
          : { neverDispatchedDigest: neverDispatchedDescendantDigest(this.context.database, read) }) };
    }).sort((a, b) => a.runId.localeCompare(b.runId));
    if (!same(nodes.map(node => node.runId), actual)) fail("descendant_lineage_invalid");
    return { nodes, evidence };
  }
  private assertInventory(record: RunSuspensionStopRecord) {
    const inventory = this.inventory(record.begin.runId);
    if (!same(inventory.nodes, record.begin.descendants)) fail("descendant_inventory_changed");
    return inventory;
  }
  private descendantProofs(record: RunSuspensionStopRecord, now: string): readonly RunSuspensionDescendantProofV1[] {
    const { evidence } = this.assertInventory(record);
    return [...evidence.steps].sort((a, b) => a.childRun!.id.localeCompare(b.childRun!.id)).map(read => {
      if (terminal(read.step.state)) {
        if (![read.childRun?.endedAt, read.workUnit?.endedAt, read.attempt?.endedAt, read.step.completedAt, read.hostCompletion?.drainedAt]
          .every(at => typeof at === "string" && delegationTimestamp(at) <= now)) fail("descendant_terminal_invalid");
        return { runId: read.childRun!.id, kind: "terminal", evidenceDigest: terminalDescendantDigest(read) };
      }
      if (!read.attempt) return { runId: read.childRun!.id, kind: "never_dispatched",
        evidenceDigest: neverDispatchedDescendantDigest(this.context.database, read) };
      const row = this.context.database.prepare("SELECT suspension_id FROM run_suspension_stops WHERE attempt_id=? AND state='stopped'").get(read.attempt.sourceFence.attemptId);
      const stopped = row ? this.getRunSuspensionStop(String(row.suspension_id)) : undefined;
      if (!stopped?.receipt || stopped.begin.runId !== read.childRun!.id || !same(stopped.begin.sourceFence, read.attempt.sourceFence)) fail("descendant_not_stopped");
      this.assertCurrent(stopped, now, "stopped");
      if (delegationDigest(this.completion(stopped, now)) !== stopped.receipt.completionDigest) fail("descendant_effects_changed");
      return { runId: read.childRun!.id, kind: "stopped", suspensionId: stopped.suspensionId,
        receiptArtifactId: stopped.receiptArtifactId!, receiptDigest: stopped.receiptDigest! };
    });
  }
  private delegatedEdge(runId: string): DelegationCompletionStepReadV1 {
    const run = this.ports.getRun(runId);
    if (!run?.parentRunId) fail("lineage_invalid");
    const evidence = this.ports.getDelegationCompletionEvidence({ rootRunIds: [run.parentRunId] });
    if (evidence.issues.length) fail("lineage_invalid");
    const rows = evidence.steps.filter(read => read.childRun?.id === runId);
    if (rows.length !== 1 || !rows[0]!.reservation) fail("lineage_invalid");
    return rows[0]!;
  }
  private modelAdmissions(runId: string): string {
    return delegationDigest(this.context.database.prepare(`SELECT id,root_run_id,reservation_id,run_id,attempt_id,invocation_id,request_digest,
      reserved_tokens,reserved_cost_micros,price_artifact_id,price_digest,created_at FROM delegation_budget_charges WHERE run_id=? ORDER BY id`).all(runId));
  }
  private canonicalEvents(runId: string): string {
    const hash = createHash("sha256");
    for (const row of this.context.database.prepare("SELECT seq,ts,type,data_json FROM run_events WHERE run_id=? ORDER BY seq").iterate(runId)) {
      const body = JSON.stringify([row.seq, row.ts, row.type, row.data_json]);
      hash.update(`${Buffer.byteLength(body)}:`).update(body);
    }
    return hash.digest("hex");
  }
  private selectionDigest(run: RunSession): string {
    if (!run.workflowStepId) return delegationDigest(null);
    const step = this.ports.getChannelWorkflowStep(run.workflowStepId), workflow = step ? this.ports.getChannelWorkflow(step.workflowId) : undefined;
    if (!step || !workflow || workflow.channelId !== run.channelId || step.channelId !== run.channelId || !["ready", "running"].includes(workflow.status)
      || !["queued", "claimed", "running"].includes(step.status)) fail("selection_changed");
    return delegationDigest({ workflow: { id: workflow.id, workspaceId: workflow.workspaceId, channelId: workflow.channelId,
      title: workflow.title, objective: workflow.objective, createdAt: workflow.createdAt, createdBy: workflow.createdBy,
      sourceHandoffId: workflow.sourceHandoffId, metadata: workflow.metadata }, step: { id: step.id, workflowId: step.workflowId,
      position: step.position, title: step.title, prompt: step.prompt, toParticipantId: step.toParticipantId, participantAuthority: step.participantAuthority } });
  }
  private create(runId: string, payload: RunSuspensionStopBeginV1 | RunSuspensionStoppedV1, kind: "begin" | "receipt", now: string): RunArtifact {
    const json = delegationJson(payload);
    if (Buffer.byteLength(json) > 1_048_576) fail("artifact_budget");
    return this.ports.createArtifactWithinTransaction({ runId, type: "json", path: `sqlite:run-suspension-stop-${kind}`,
      contentType: `application/vnd.ling.run-suspension-stop-${kind}+json`, sealedPayload: JSON.parse(json), contentSha256: delegationDigest(payload),
      sizeBytes: Buffer.byteLength(json), createdAt: now });
  }
  private pins(record: RunSuspensionStopRecord, now: string): void {
    const artifactIds = runSuspensionStopArtifacts(this.context.database, record);
    for (const [kind, reason] of [["run_suspension_stop", "recovery"], ["run_suspension_stop_audit", "audit_hold"]] as const) {
      syncHarnessArtifactOwnerPins(this.context.database, { holder: harnessArtifactOwnerHolder(kind, record.suspensionId), artifactIds, keep: true, reason, now });
    }
  }
  private assertNoActiveResources(fence: RuntimeAttemptFenceV1): void {
    for (const table of ["resource_leases", "runtime_semaphore_slots"]) if (this.context.database.prepare(`SELECT 1 FROM ${table}
      WHERE work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=? AND status='active' LIMIT 1`)
      .get(fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken)) fail("resources_retained");
  }
  private read<T>(body: () => T): T { return readSqliteWithinTransaction(this.context.database, body); }
  private write<T>(body: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = body(); if (!this.context.database.isTransaction) fail("transaction_lost"); this.context.database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); throw error; }
  }
}

function edgeDigest(read: DelegationCompletionStepReadV1): string {
  const { state, revision, updatedAt, completedAt, failureCode, ...step } = read.step;
  const reservation = read.reservation!;
  return delegationDigest({ step, reservation: { id: reservation.id, rootRunId: reservation.rootRunId, delegationStepId: reservation.delegationStepId,
    parentReservationId: reservation.parentReservationId, childRunId: reservation.childRunId, requestDigest: reservation.requestDigest,
    tokenReserved: reservation.tokenReserved, costReservedMicros: reservation.costReservedMicros, deadlineAt: reservation.deadlineAt,
    idempotencyKey: reservation.idempotencyKey, createdAt: reservation.createdAt } });
}
function terminalDescendantDigest(read: DelegationCompletionStepReadV1): string {
  // The independent completion reader verifies the full lineage on every read.
  // Ancestor physical status may legitimately change during leaf-first closure;
  // bind its exact identities/fence, not its transient liveness fingerprint.
  const { parentRun, parentAttempt, parentDelegationStep, parentReservation, ...facts } = read;
  return delegationDigest({ ...facts, parentLineage: { runId: parentRun?.id, sourceFence: parentAttempt?.sourceFence,
    delegationStepId: parentDelegationStep?.id, reservationId: parentReservation?.id } });
}
// Same frozen context fields as S1. Status/timestamps changed by physical closure are deliberately excluded.
function contextDigest(run: RunSession): string {
  return delegationDigest({ id: run.id, cwd: run.cwd, taskId: run.taskId, channelId: run.channelId, teammateId: run.teammateId,
    workflowStepId: run.workflowStepId, selectedSkillId: run.selectedSkillId, providerPresetId: run.providerPresetId,
    providerName: run.providerName, providerModel: run.providerModel, taskSnapshot: run.taskSnapshot,
    providerSnapshot: run.providerSnapshot, requestSnapshot: run.requestSnapshot, threadId: run.threadId,
    workUnitId: run.workUnitId, parentRunId: run.parentRunId, interventionId: run.interventionId, continuationReason: run.continuationReason,
    contextViewId: run.contextViewId, contextViewCreatedAt: run.contextViewCreatedAt, createdAt: run.createdAt });
}
