import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { delegationDigest, delegationFence, delegationId, delegationInteger, delegationJson, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import type { ClaimedDelegatedChild, DelegationPreparedExecution, DelegationRunnerStartObservation, ResumeDelegatedChildInput } from "../../harness/delegation-lifecycle-types.js";
import type { DelegationBudgetReservation, DelegationRootBudgetRecord } from "../../harness/delegation-write-types.js";
import type { ActivateDelegatedRunSuspensionInput, ActivateDelegatedRunSuspensionResult, DelegatedRunSuspensionActivationRecord,
  DelegatedRunSuspensionActivationV1, DelegatedRunSuspensionStartRecord, DelegatedRunSuspensionStartV1 } from "../../run-suspension-delegated-types.js";
import type { RunSuspensionRecord } from "../../run-suspension-types.js";
import type { RunSuspensionStopInput, RunSuspensionStopRecord } from "../../run-suspension-stop-types.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import type { CreateRunArtifactInput, RunArtifact, RunStore } from "../../run-types.js";
import { harnessArtifactOwnerHolder, syncHarnessArtifactOwnerPins } from "./harness-artifact-recovery-pins.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { assertNoPendingRunTerminalIntent } from "./run-terminal-intent-store.js";
import { readRunSuspensionStopRecord, stopDigest } from "./run-suspension-stop-records.js";
import { delegatedSuspensionFail as fail, readDelegatedSuspensionActivationRecord, readDelegatedSuspensionStartRecord,
  readDelegatedSuspensionParentStart } from "./run-suspension-delegated-records.js";
import type { SqliteStoreContext } from "./store-context.js";
import { runSuspensionWitnessArtifactIds } from "./run-suspension-dependencies.js";

type Ports = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "appendRuntimeEvent"> & {
  readonly getRunSuspension: (id: string) => RunSuspensionRecord | undefined;
  readonly assertStoppedWithinTransaction: (input: RunSuspensionStopInput) => RunSuspensionStopRecord;
  readonly readRuntimeWithinTransaction: (id: string) => import("../../harness/delegation-lifecycle-types.js").DelegationChildRuntime;
  readonly getPreparation: (id: string) => DelegationPreparedExecution | undefined;
  readonly assertRecoveryAuthority: (input: { readonly runId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly now: string }) => DelegationRootBudgetRecord;
  readonly assertStartAuthority: (input: { readonly runId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly now: string }) => DelegationRootBudgetRecord;
  readonly resumeWithinTransaction: (input: ResumeDelegatedChildInput, onTarget: (child: ClaimedDelegatedChild) => void) => ClaimedDelegatedChild;
  readonly assertStartProof: (id: string, targetFence: RuntimeAttemptFenceV1, reservationId: string) => RunSuspensionRecord;
  readonly getReservation: (id: string) => DelegationBudgetReservation | undefined;
  readonly createArtifactWithinTransaction: (input: CreateRunArtifactInput) => RunArtifact;
};

/** Private source-bound186 activation. There is no Runner or public resume bypass here. */
export class SqliteRunSuspensionDelegatedStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  activateDelegatedRunSuspension(raw: ActivateDelegatedRunSuspensionInput): ActivateDelegatedRunSuspensionResult {
    const value = delegationRecord(raw, ["suspensionId", "sourceFence", "expectedReceiptDigest", "parentFence", "expectedStepRevision", "runtimeInstanceId", "now"]);
    const input: ActivateDelegatedRunSuspensionInput = { suspensionId: delegationId(value.suspensionId), sourceFence: delegationFence(value.sourceFence),
      expectedReceiptDigest: stopDigest(value.expectedReceiptDigest), parentFence: delegationFence(value.parentFence),
      expectedStepRevision: delegationInteger(value.expectedStepRevision), runtimeInstanceId: delegationId(value.runtimeInstanceId), now: delegationTimestamp(value.now) };
    const { now, ...identity } = input, inputDigest = delegationDigest(identity);
    return this.write(() => {
      const prior = this.readOwned(() => readDelegatedSuspensionActivationRecord(this.context.database, input.suspensionId));
      if (prior) {
        if (prior.activation.inputDigest !== inputDigest) fail("idempotency_conflict");
        return { kind: "already_activated", record: prior };
      }
      const { stopped, source, saved, runtime, parent, root, preparation } = this.readOwned(() => {
        const stopped = this.ports.assertStoppedWithinTransaction(input), source = stopped.begin.source;
        const saved = this.ports.getRunSuspension(input.suspensionId);
        if (source.kind !== "delegated" || !saved?.seal || !stopped.receipt || stopped.receiptDigest !== input.expectedReceiptDigest
          || input.runtimeInstanceId === input.sourceFence.runtimeInstanceId || now < stopped.receipt.stoppedAt) fail("source_unverified");
        const runtime = this.ports.readRuntimeWithinTransaction(source.reservationId);
        if (!runtime.attempt || runtime.run.id !== stopped.begin.runId || runtime.step.id !== source.stepId
          || runtime.step.parentRunId !== source.parentRunId || runtime.run.parentRunId !== source.parentRunId
          || runtime.reservation.id !== source.reservationId || runtime.reservation.state !== "reserved"
          || runtime.step.state !== "interrupted" || runtime.step.revision !== input.expectedStepRevision
          || !same(toRuntimeAttemptFence(runtime.attempt), input.sourceFence)) fail("source_unverified");
        assertNoPendingRunTerminalIntent(this.context, runtime.run.id);
        const parent = this.parent(runtime.step.parentRunId, input.parentFence, source.parentFence, now);
        const root = this.ports.assertRecoveryAuthority({ runId: runtime.run.id, sourceFence: input.sourceFence, now });
        const preparation = this.ports.getPreparation(source.reservationId);
        if (!preparation) fail("preparation_missing");
        return { stopped, source, saved, runtime, parent, root, preparation };
      });
      let record: DelegatedRunSuspensionActivationRecord | undefined;
      const child = this.ports.resumeWithinTransaction({ reservationId: source.reservationId, expectedStepRevision: input.expectedStepRevision,
        parentFence: input.parentFence, runtimeInstanceId: input.runtimeInstanceId, callId: `suspension-${input.suspensionId}`, now }, target => {
        if (target.replayed || target.attempt.attemptNumber !== runtime.attempt!.attemptNumber + 1
          || target.workUnit.id !== runtime.workUnit.id || target.run.id !== runtime.run.id) fail("target_conflict");
        const activation: DelegatedRunSuspensionActivationV1 = { schemaVersion: 1, kind: "run.suspension_delegated_activation.v1",
          id: `delegated_suspension_activation_${randomUUID()}`, suspensionId: input.suspensionId, runId: runtime.run.id,
          rootRunId: runtime.step.rootRunId, parentRunId: runtime.step.parentRunId, stepId: runtime.step.id, reservationId: runtime.reservation.id,
          sourceFence: input.sourceFence, targetFence: toRuntimeAttemptFence(target.attempt), parentFence: input.parentFence,
          parentStartArtifactId: parent.artifactId, parentStartDigest: parent.digest, stoppedReceiptArtifactId: stopped.receiptArtifactId!,
          stoppedReceiptDigest: stopped.receiptDigest!, modelViewArtifactId: saved.seal!.modelViewArtifactId,
          preparationArtifactId: preparation.artifactId, preparationDigest: preparation.digest, inputDigest,
          rootBudgetDigest: delegationDigest(root), reservationDigest: delegationDigest(runtime.reservation), activatedAt: now };
        const artifact = this.artifact(runtime.run.id, activation, "activation", now);
        this.context.database.prepare(`INSERT INTO run_suspension_delegated_activations
          (id,suspension_id,run_id,root_run_id,parent_run_id,step_id,reservation_id,source_attempt_id,target_attempt_id,parent_attempt_id,artifact_id,digest,activated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(activation.id, input.suspensionId, runtime.run.id, runtime.step.rootRunId,
            runtime.step.parentRunId, runtime.step.id, runtime.reservation.id, input.sourceFence.attemptId,
            target.attempt.id, input.parentFence.attemptId, artifact.id, artifact.contentSha256!, now);
        this.pins("activation", activation.id, [artifact.id, stopped.receiptArtifactId!, stopped.beginArtifactId, saved.requestArtifactId,
          saved.sealArtifactId!, saved.seal!.modelViewArtifactId, preparation.artifactId, parent.artifactId,
          ...runSuspensionWitnessArtifactIds(this.context, saved.seal!.witness),
          root.authorityArtifactId, ...(root.priceArtifactId ? [root.priceArtifactId] : [])], now);
        record = this.readOwned(() => readDelegatedSuspensionActivationRecord(this.context.database, input.suspensionId));
        if (!record) fail("commit_changed");
      });
      if (!record || child.replayed || !same(child.reservation, runtime.reservation)
        || !this.readOwned(() => same(this.ports.getRun(runtime.run.id), runtime.run))) fail("commit_changed");
      this.ports.appendRuntimeEvent({ ...record.activation.targetFence, type: "work_unit_queued", actor: "system", ts: now,
        data: { kind: "run_suspension_delegated_activation_v1", activationId: record.activation.id, suspensionId: input.suspensionId,
          sourceAttemptId: input.sourceFence.attemptId } });
      this.readOwned(() => this.ports.assertStartProof(input.suspensionId, record!.activation.targetFence, runtime.reservation.id));
      return { kind: "activated", record, child };
    });
  }

  getDelegatedRunSuspensionActivation(query: string | { readonly runId: string; readonly targetAttemptId: string }): DelegatedRunSuspensionActivationRecord | undefined {
    return this.read(query, "run_suspension_delegated_activations", id => readDelegatedSuspensionActivationRecord(this.context.database, id));
  }
  getDelegatedRunSuspensionStart(query: string | { readonly runId: string; readonly targetAttemptId: string }): DelegatedRunSuspensionStartRecord | undefined {
    return this.read(query, "run_suspension_delegated_starts", id => readDelegatedSuspensionStartRecord(this.context.database, id));
  }

  /** Called only after lifecycle has read its original nominal SDK observation, in that same transaction. */
  commitStartWithinTransaction(input: { readonly runtime: ClaimedDelegatedChild; readonly preparation: DelegationPreparedExecution;
    readonly observation: DelegationRunnerStartObservation; readonly now: string }): void {
    if (!this.context.database.isTransaction) fail("transaction_missing");
    const { runtime, preparation, observation, now } = input, fence = toRuntimeAttemptFence(runtime.attempt);
    const record = this.readOwned(() => {
      const row = this.context.database.prepare("SELECT suspension_id FROM run_suspension_delegated_activations WHERE run_id=? AND target_attempt_id=?")
        .get(runtime.run.id, runtime.attempt.id);
      if (!row) return undefined;
      const record = readDelegatedSuspensionActivationRecord(this.context.database, String(row.suspension_id));
      if (!record || !same(record.activation.targetFence, fence) || record.activation.reservationId !== runtime.reservation.id
        || record.activation.preparationArtifactId !== preparation.artifactId || record.activation.preparationDigest !== preparation.digest
        || !same(observation.sourceFence, fence) || observation.childRunId !== runtime.run.id || observation.observedAt < record.activation.activatedAt) fail("target_conflict");
      if (readDelegatedSuspensionStartRecord(this.context.database, record.activation.suspensionId)) fail("already_started");
      const stopped = readRunSuspensionStopRecord(this.context.database, record.activation.suspensionId);
      if (stopped?.begin.source.kind !== "delegated") fail("source_unverified");
      this.parent(runtime.step.parentRunId, record.activation.parentFence, stopped.begin.source.parentFence, now);
      const root = this.ports.assertStartAuthority({ runId: runtime.run.id, sourceFence: fence, now });
      if (delegationDigest(root) !== record.activation.rootBudgetDigest
        || delegationDigest(this.ports.getReservation(runtime.reservation.id)) !== record.activation.reservationDigest) fail("budget_changed");
      this.ports.assertStartProof(record.activation.suspensionId, fence, runtime.reservation.id);
      return record;
    });
    if (!record) return;
    const start: DelegatedRunSuspensionStartV1 = { schemaVersion: 1, kind: "run.suspension_delegated_start.v1",
      id: `delegated_suspension_start_${randomUUID()}`, suspensionId: record.activation.suspensionId,
      activationArtifactId: record.artifactId, activationDigest: record.digest, observation, acknowledgedAt: now };
    const artifact = this.artifact(runtime.run.id, start, "start", now);
    this.context.database.prepare(`INSERT INTO run_suspension_delegated_starts
      (id,suspension_id,activation_id,run_id,target_attempt_id,observation_id,artifact_id,digest,acknowledged_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(start.id, start.suspensionId, record.activation.id, runtime.run.id, runtime.attempt.id, observation.observationId, artifact.id, artifact.contentSha256!, now);
    this.pins("start", start.id, [artifact.id, record.artifactId, record.activation.modelViewArtifactId,
      record.activation.preparationArtifactId, record.activation.parentStartArtifactId, record.activation.stoppedReceiptArtifactId], now);
    if (!this.readOwned(() => readDelegatedSuspensionStartRecord(this.context.database, start.suspensionId))) fail("commit_changed");
  }

  private parent(runId: string, fence: RuntimeAttemptFenceV1, sourceFence: RuntimeAttemptFenceV1, now: string) {
    assertNoPendingRunTerminalIntent(this.context, runId);
    const run = this.ports.getRun(runId), unit = this.ports.getWorkUnit(fence.workUnitId), attempt = this.ports.getWorkUnitAttempt(fence.attemptId);
    const start = readDelegatedSuspensionParentStart(this.context.database, runId, fence);
    if (!run || !unit || run.status !== "running" || run.endedAt || run.workUnitId !== unit.id || unit.linkedRunId !== runId
      || unit.status !== "running" || unit.endedAt || unit.activeAttemptId !== attempt?.id || !attempt || attempt.status !== "started"
      || attempt.endedAt || attempt.abortRequestedAt || !same(toRuntimeAttemptFence(attempt), fence) || !start
      || !same(start.sourceFence, sourceFence) || start.acknowledgedAt > now) fail("parent_not_started");
    return start;
  }
  private artifact(runId: string, payload: DelegatedRunSuspensionActivationV1 | DelegatedRunSuspensionStartV1, suffix: string, now: string) {
    const json = delegationJson(payload);
    return this.ports.createArtifactWithinTransaction({ runId, type: "json", path: `sqlite:run-suspension-delegated-${suffix}`,
      contentType: `application/vnd.ling.run-suspension-delegated-${suffix}+json`, sealedPayload: JSON.parse(json),
      contentSha256: delegationDigest(payload), sizeBytes: Buffer.byteLength(json), createdAt: now });
  }
  private pins(kind: string, id: string, artifactIds: readonly string[], now: string): void {
    for (const [suffix, reason] of [["", "recovery"], ["_audit", "audit_hold"]] as const) syncHarnessArtifactOwnerPins(this.context.database,
      { holder: harnessArtifactOwnerHolder(`run_suspension_delegated_${kind}${suffix}`, id), artifactIds: [...new Set(artifactIds)], keep: true, reason, now });
  }
  private read<T>(query: string | { readonly runId: string; readonly targetAttemptId: string }, table: string, read: (id: string) => T): T | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      if (typeof query === "string") return read(delegationId(query));
      const value = delegationRecord(query, ["runId", "targetAttemptId"]);
      const row = this.context.database.prepare(`SELECT suspension_id FROM ${table} WHERE run_id=? AND target_attempt_id=?`)
        .get(delegationId(value.runId), delegationId(value.targetAttemptId));
      return row ? read(String(row.suspension_id)) : undefined;
    });
  }
  private write<T>(body: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = body(); if (!this.context.database.isTransaction) fail("transaction_lost"); this.context.database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); throw error; }
  }
  private readOwned<T>(body: () => T): T { return readSqliteWithinTransaction(this.context.database, body); }
}
