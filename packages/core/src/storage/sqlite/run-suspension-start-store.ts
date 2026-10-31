import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { delegationDigest, delegationFence, delegationId, delegationInteger, delegationJson, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import type { DelegationRootBudgetRecord } from "../../harness/delegation-write-types.js";
import type { RunnerContinuationMutationResult, StartRunnerContinuationInput } from "../../harness/continuations.js";
import { readRunProgressFrozenExecution } from "../../run-progress-checkpoint-lineage.js";
import type { RootRunSuspensionActivationRecord } from "../../run-suspension-activation-types.js";
import type { AcknowledgeRootRunSuspensionStartInput, AcknowledgeRootRunSuspensionStartResult, RootRunSuspensionStartObservationV1,
  RootRunSuspensionStartRecord, RootRunSuspensionStartV1 } from "../../run-suspension-start-types.js";
import type { CreateRunArtifactInput, RunArtifact, RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { harnessArtifactOwnerHolder, syncHarnessArtifactOwnerPins } from "./harness-artifact-recovery-pins.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { rootSuspensionStartObservation, readRootSuspensionStartRecord, startFail as fail } from "./run-suspension-start-records.js";
import type { SqliteStoreContext } from "./store-context.js";

type Ports = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "getRunnerContinuation" | "getTask"
  | "transitionTaskStatus" | "transitionWorkUnitStatus" | "appendRuntimeEvent"> & {
  readonly readObservation: (reference: unknown) => RootRunSuspensionStartObservationV1;
  readonly assertActivationWithinTransaction: (id: string, targetFence: RuntimeAttemptFenceV1, now: string) => RootRunSuspensionActivationRecord;
  readonly assertAuthorityWithinTransaction: (input: { readonly runId: string; readonly sourceFence: RuntimeAttemptFenceV1;
    readonly runnerId: string; readonly now: string }) => DelegationRootBudgetRecord | undefined;
  readonly startWithinTransaction: (input: StartRunnerContinuationInput) => RunnerContinuationMutationResult;
  readonly createArtifactWithinTransaction: (input: CreateRunArtifactInput) => RunArtifact;
};

/** The SDK prepared callback is the only fresh ACK issuer. Stored185 replay is audit, never dispatch. */
export class SqliteRunSuspensionStartStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  acknowledgeRootRunSuspensionStart(raw: AcknowledgeRootRunSuspensionStartInput): AcknowledgeRootRunSuspensionStartResult {
    const value = delegationRecord(raw, ["suspensionId", "targetFence", "claimOwner", "claimToken", "expectedRevision", "observationRef", "now"]);
    const input = { suspensionId: delegationId(value.suspensionId), targetFence: delegationFence(value.targetFence), claimOwner: delegationId(value.claimOwner),
      claimToken: delegationId(value.claimToken), expectedRevision: delegationInteger(value.expectedRevision), now: delegationTimestamp(value.now) };
    return this.write(() => {
      const observation = readSqliteWithinTransaction(this.context.database,
        () => rootSuspensionStartObservation(this.ports.readObservation(value.observationRef)));
      const { now, ...identity } = input, inputDigest = delegationDigest({ ...identity, observation });
      const old = readSqliteWithinTransaction(this.context.database, () => readRootSuspensionStartRecord(this.context.database, input.suspensionId));
      if (old) {
        if (old.start.inputDigest !== inputDigest) fail("idempotency_conflict");
        return { kind: "already_started", record: old };
      }
      const facts = readSqliteWithinTransaction(this.context.database, () => {
        const record = this.ports.assertActivationWithinTransaction(input.suspensionId, input.targetFence, now), activation = record.activation;
        const run = this.ports.getRun(activation.runId), unit = this.ports.getWorkUnit(input.targetFence.workUnitId);
        const attempt = this.ports.getWorkUnitAttempt(input.targetFence.attemptId), continuation = this.ports.getRunnerContinuation(activation.continuationId);
        if (!run || run.parentRunId || run.status !== "running" || run.endedAt || run.workUnitId !== input.targetFence.workUnitId
          || !unit || unit.linkedRunId !== run.id || unit.activeAttemptId !== input.targetFence.attemptId || unit.status !== "claimed" || unit.endedAt
          || !attempt || attempt.status !== "created" || attempt.endedAt || attempt.abortRequestedAt || !same(toRuntimeAttemptFence(attempt), input.targetFence)
          || !continuation || continuation.state !== "claimed" || continuation.revision !== input.expectedRevision
          || continuation.claimOwner !== input.claimOwner || continuation.claimToken !== input.claimToken || !continuation.claimExpiresAt
          || continuation.claimExpiresAt <= now || continuation.claimExpiresAt <= observation.observedAt || continuation.updatedAt > observation.observedAt
          || continuation.runId !== run.id || continuation.targetAttemptId !== attempt.id || continuation.workUnitId !== unit.id) fail("target_unverified");
        const execution = readRunProgressFrozenExecution(run), prepared = execution.preparedInput as Record<string, unknown>;
        if (observation.activationId !== activation.id || observation.runId !== run.id || !same(observation.targetFence, input.targetFence)
          || observation.continuationId !== continuation.id || observation.taskId !== run.taskId || observation.preparedInputFingerprint !== prepared.fingerprint
          || observation.runnerId !== attempt.runnerId || observation.runnerId !== continuation.runnerId
          || observation.observedAt < activation.activatedAt || observation.observedAt > now || attempt.createdAt > observation.observedAt) fail("observation_mismatch");
        const budget = this.ports.assertAuthorityWithinTransaction({ runId: run.id, sourceFence: input.targetFence, runnerId: observation.runnerId, now });
        if (delegationDigest(budget ?? null) !== activation.rootBudgetDigest) fail("budget_changed");
        const task = this.ports.getTask(run.taskId);
        if (task && (task.currentRunId !== run.id || !["claimed", "running"].includes(task.status))) fail("task_changed");
        return { record, activation, run, unit, attempt, continuation, budget, task };
      });
      const id = `root_suspension_start_${randomUUID()}`, start: RootRunSuspensionStartV1 = {
        schemaVersion: 1, kind: "run.suspension_root_start.v1", id, suspensionId: input.suspensionId,
        activationArtifactId: facts.record.artifactId, activationDigest: facts.record.digest, observation, inputDigest,
        rootBudgetDigest: facts.activation.rootBudgetDigest, acknowledgedAt: now };
      const body = delegationJson(start), artifact = this.ports.createArtifactWithinTransaction({ runId: facts.run.id, type: "json",
        path: "sqlite:run-suspension-root-start", contentType: "application/vnd.ling.run-suspension-root-start+json",
        sealedPayload: JSON.parse(body), contentSha256: delegationDigest(start), sizeBytes: Buffer.byteLength(body), createdAt: now });
      readSqliteWithinTransaction(this.context.database, () => {
        if (!same(this.ports.assertActivationWithinTransaction(input.suspensionId, input.targetFence, now), facts.record)
          || !same(rootSuspensionStartObservation(this.ports.readObservation(value.observationRef)), observation)
          || !same(this.ports.assertAuthorityWithinTransaction({ runId: facts.run.id, sourceFence: input.targetFence,
            runnerId: observation.runnerId, now }), facts.budget)) fail("commit_changed");
      });
      this.context.database.prepare(`INSERT INTO run_suspension_root_starts
        (id,suspension_id,activation_id,run_id,target_attempt_id,continuation_id,observation_id,artifact_id,digest,acknowledged_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, input.suspensionId, facts.activation.id, facts.run.id, input.targetFence.attemptId,
          observation.continuationId, observation.observationId, artifact.id, artifact.contentSha256!, now);
      const artifactIds = [artifact.id, facts.record.artifactId, facts.activation.replayArtifactId,
        facts.activation.modelViewArtifactId, facts.activation.stoppedReceiptArtifactId,
        ...(facts.budget ? [facts.budget.authorityArtifactId, ...(facts.budget.priceArtifactId ? [facts.budget.priceArtifactId] : [])] : [])];
      for (const [kind, reason] of [["run_suspension_start", "recovery"], ["run_suspension_start_audit", "audit_hold"]] as const) {
        syncHarnessArtifactOwnerPins(this.context.database, { holder: harnessArtifactOwnerHolder(kind, id), artifactIds, keep: true, reason, now });
      }
      const started = this.ports.startWithinTransaction({ continuationId: facts.continuation.id, expectedRevision: input.expectedRevision,
        claimOwner: input.claimOwner, claimToken: input.claimToken, targetFence: input.targetFence, now });
      if (!started.ok || started.replayed || started.value.state !== "running") fail("continuation_start_failed");
      const unitResult = this.ports.transitionWorkUnitStatus({ ...input.targetFence, expectedStatus: "claimed", event: "runner_started", actor: "system",
        reason: "Original SDK prepared callback accepted", idempotencyKey: `${id}:unit`, startedAt: now, lastHeartbeatAt: now, now });
      if (!unitResult.ok || unitResult.duplicate) fail("unit_start_failed");
      if (facts.task?.status === "claimed") {
        const taskResult = this.ports.transitionTaskStatus({ taskId: facts.task.id, expectedStatus: "claimed", event: "start_run", actor: "system",
          currentRunId: facts.run.id, idempotencyKey: `${id}:task`, now });
        if (!taskResult.ok || taskResult.duplicate) fail("task_start_failed");
      }
      this.ports.appendRuntimeEvent({ ...input.targetFence, type: "work_unit_started", actor: "system", ts: now,
        data: { kind: "run_suspension_root_start_v1", startId: id, activationId: facts.activation.id, observationId: observation.observationId } });
      const record = readSqliteWithinTransaction(this.context.database, () => readRootSuspensionStartRecord(this.context.database, input.suspensionId));
      const run = this.ports.getRun(facts.run.id), unit = this.ports.getWorkUnit(facts.unit.id), attempt = this.ports.getWorkUnitAttempt(facts.attempt.id);
      if (!record || !run || !same(run, facts.run) || !unit || !attempt || unit.status !== "running" || unit.activeAttemptId !== attempt.id
        || attempt.status !== "started") fail("commit_changed");
      return { kind: "started", record, run, workUnit: unit, attempt, continuation: started.value };
    });
  }

  getRootRunSuspensionStart(input: string | { readonly runId: string; readonly targetAttemptId: string }): RootRunSuspensionStartRecord | undefined {
    if (typeof input === "string") return readSqliteSnapshot(this.context.database,
      () => readRootSuspensionStartRecord(this.context.database, delegationId(input)));
    const value = delegationRecord(input, ["runId", "targetAttemptId"]), runId = delegationId(value.runId), attemptId = delegationId(value.targetAttemptId);
    return readSqliteSnapshot(this.context.database, () => {
      const row = this.context.database.prepare("SELECT suspension_id FROM run_suspension_root_starts WHERE run_id=? AND target_attempt_id=?").get(runId, attemptId);
      return row ? readRootSuspensionStartRecord(this.context.database, String(row.suspension_id)) : undefined;
    });
  }
  private write<T>(body: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = body(); if (!this.context.database.isTransaction) fail("transaction_lost"); this.context.database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); throw error; }
  }
}
