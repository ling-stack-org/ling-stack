import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { resolve } from "node:path";
import type { RunnerContinuationV1 } from "@ling-stack/contracts";
import { delegationDigest, delegationFence, delegationId, delegationJson, delegationRecord, delegationTimestamp } from "../../harness/delegation-write-validation.js";
import type { DelegationRootBudgetRecord } from "../../harness/delegation-write-types.js";
import type { PrepareContinuationInput, PreparedContinuation, ClaimRunnerContinuationInput, RunnerContinuationMutationResult } from "../../harness/continuations.js";
import { assertRunProgressPayloadSecretFree, readRunProgressFrozenExecution } from "../../run-progress-checkpoint-lineage.js";
import type { ActivateRootRunSuspensionInput, ActivateRootRunSuspensionResult, RootRunSuspensionActivationRecord, RootRunSuspensionActivationV1 } from "../../run-suspension-activation-types.js";
import type { RunSuspensionRecord } from "../../run-suspension-types.js";
import type { RunSuspensionStopInput, RunSuspensionStopRecord } from "../../run-suspension-stop-types.js";
import type { CreateRunArtifactInput, RunArtifact, RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { harnessArtifactOwnerHolder, readHarnessRetainedBody, syncHarnessArtifactOwnerPins } from "./harness-artifact-recovery-pins.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { activationFail as fail, readRootSuspensionActivationRecord } from "./run-suspension-activation-records.js";
import { stopDigest, readRunSuspensionStopRecord } from "./run-suspension-stop-records.js";
import type { SqliteStoreContext } from "./store-context.js";
import { runSuspensionWitnessArtifactIds } from "./run-suspension-dependencies.js";

type Ports = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "getArtifact" | "transitionWorkUnitStatus" | "appendRuntimeEvent"> & {
  readonly assertStoppedWithinTransaction: (input: RunSuspensionStopInput) => RunSuspensionStopRecord;
  readonly getRunSuspension: (id: string) => RunSuspensionRecord | undefined;
  readonly assertAuthorityWithinTransaction: (input: { readonly runId: string; readonly sourceFence: RuntimeAttemptFenceV1; readonly runnerId: string; readonly now: string }) => DelegationRootBudgetRecord | undefined;
  readonly prepareWithinTransaction: (input: PrepareContinuationInput) => PreparedContinuation;
  readonly claimWithinTransaction: (input: ClaimRunnerContinuationInput) => RunnerContinuationMutationResult;
  readonly createArtifactWithinTransaction: (input: CreateRunArtifactInput) => RunArtifact;
  readonly assertRootStartProofWithinTransaction: (id: string, targetFence: RuntimeAttemptFenceV1, continuationId: string) => RunSuspensionRecord;
};
const hashJson = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Root-only consumption. OS dispatch/SDK prepared ACK are intentionally outside this SQLite transaction. */
export class SqliteRunSuspensionActivationStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}

  activateRootRunSuspension(raw: ActivateRootRunSuspensionInput): ActivateRootRunSuspensionResult {
    const input = this.input(raw), { now, ...identity } = input, inputDigest = delegationDigest(identity);
    return this.write(() => {
      const old = readSqliteWithinTransaction(this.context.database, () => readRootSuspensionActivationRecord(this.context.database, input.suspensionId));
      if (old) {
        if (old.activation.inputDigest !== inputDigest) fail("idempotency_conflict");
        return { kind: "already_activated", record: old };
      }
      if (input.claim.expiresAt <= now || input.target.runtimeInstanceId === input.sourceFence.runtimeInstanceId) fail("invalid_target");
      const facts = readSqliteWithinTransaction(this.context.database, () => {
        const stopped = this.ports.assertStoppedWithinTransaction({ suspensionId: input.suspensionId, sourceFence: input.sourceFence, now });
        const saved = this.ports.getRunSuspension(input.suspensionId), run = this.ports.getRun(stopped.begin.runId);
        const source = this.ports.getWorkUnitAttempt(input.sourceFence.attemptId), unit = this.ports.getWorkUnit(input.sourceFence.workUnitId);
        if (!saved?.seal || !run || !source || !unit || stopped.begin.source.kind !== "root" || run.parentRunId
          || stopped.receiptDigest !== input.expectedReceiptDigest || now < stopped.receipt!.stoppedAt
          || source.status !== "lost" || source.errorCode !== "runtime_graceful_suspend" || source.abortRequestedAt
          || unit.status !== "stale" || unit.activeAttemptId !== source.id || run.workUnitId !== unit.id || unit.linkedRunId !== run.id
          || run.status !== "running" || run.endedAt || !run.contextViewId || source.runnerId !== input.target.runnerId) fail("source_unverified");
        // The restart receiver requires the original source pointer. It must run
        // before any retry transition or replacement Attempt is persisted.
        const budget = this.ports.assertAuthorityWithinTransaction({ runId: run.id, sourceFence: input.sourceFence, runnerId: input.target.runnerId, now });
        const replay = this.replay(input, run, saved, stopped, source);
        return { stopped, saved, run, source, unit, budget, replay };
      });
      const key = `root-suspension-activation:${input.suspensionId}`;
      const transition = this.ports.transitionWorkUnitStatus({ workUnitId: facts.unit.id, expectedStatus: "stale", event: "retry", actor: "system",
        reason: "Host-verified graceful suspension activation", idempotencyKey: `${key}:queue`, now,
        activeAttemptId: input.sourceFence.attemptId, endedAt: null, errorCode: null, errorMessage: null });
      if (!transition.ok) fail("transition_failed");
      const prepared = this.ports.prepareWithinTransaction({ runId: facts.run.id, workUnitId: facts.unit.id, sourceFence: input.sourceFence,
        expectedTargetAttemptId: input.sourceFence.attemptId, origin: "daemon_recovery", strategy: "deterministic_replay",
        runnerId: input.target.runnerId, runnerCapabilityRevision: input.target.runnerCapabilityRevision, contextViewId: facts.run.contextViewId!,
        contextSnapshotArtifactId: input.replayArtifactId, idempotencyKey: key, generation: 0,
        targetAttempt: { runtimeInstanceId: input.target.runtimeInstanceId, runnerId: input.target.runnerId,
          requestedRunnerId: facts.source.requestedRunnerId, effectiveRunnerId: facts.source.effectiveRunnerId,
          fallbackReason: facts.source.fallbackReason, providerPresetId: facts.source.providerPresetId }, now });
      if (prepared.replayed || prepared.attempt.attemptNumber !== facts.unit.attemptCount + 1
        || prepared.attempt.id === input.sourceFence.attemptId || prepared.attempt.fencingToken === input.sourceFence.fencingToken) fail("target_conflict");
      const claim = this.ports.claimWithinTransaction({ continuationId: prepared.continuation.id, expectedRevision: prepared.continuation.revision,
        claimOwner: input.claim.owner, claimToken: input.claim.token, claimExpiresAt: input.claim.expiresAt, now });
      if (!claim.ok || claim.replayed || claim.value.state !== "claimed") fail("claim_failed");
      const targetFence = toRuntimeAttemptFence(prepared.attempt), id = `root_suspension_activation_${randomUUID()}`;
      const activation: RootRunSuspensionActivationV1 = { schemaVersion: 1, kind: "run.suspension_root_activation.v1", id,
        suspensionId: input.suspensionId, runId: facts.run.id, sourceFence: input.sourceFence, targetFence,
        stoppedReceiptArtifactId: facts.stopped.receiptArtifactId!, stoppedReceiptDigest: facts.stopped.receiptDigest!,
        replayArtifactId: input.replayArtifactId, replayDigest: facts.replay.contentSha256!, modelViewArtifactId: facts.saved.seal!.modelViewArtifactId,
        continuationId: claim.value.id, inputDigest, rootBudgetDigest: delegationDigest(facts.budget ?? null), activatedAt: now };
      const json = delegationJson(activation), artifact = this.ports.createArtifactWithinTransaction({ runId: facts.run.id, type: "json",
        path: "sqlite:run-suspension-root-activation", contentType: "application/vnd.ling.run-suspension-root-activation+json",
        sealedPayload: JSON.parse(json), contentSha256: delegationDigest(activation), sizeBytes: Buffer.byteLength(json), createdAt: now });
      this.context.database.prepare(`INSERT INTO run_suspension_root_activations
        (id,suspension_id,run_id,source_attempt_id,target_attempt_id,continuation_id,artifact_id,digest,activated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(id, input.suspensionId, facts.run.id, input.sourceFence.attemptId, targetFence.attemptId, claim.value.id, artifact.id, artifact.contentSha256!, now);
      const artifactIds = [artifact.id, input.replayArtifactId, activation.modelViewArtifactId, activation.stoppedReceiptArtifactId,
        facts.stopped.beginArtifactId, facts.saved.requestArtifactId, facts.saved.sealArtifactId!,
        ...runSuspensionWitnessArtifactIds(this.context, facts.saved.seal!.witness),
        ...(facts.budget ? [facts.budget.authorityArtifactId, ...(facts.budget.priceArtifactId ? [facts.budget.priceArtifactId] : [])] : [])];
      for (const [kind, reason] of [["run_suspension_activation", "recovery"], ["run_suspension_activation_audit", "audit_hold"]] as const) {
        syncHarnessArtifactOwnerPins(this.context.database, { holder: harnessArtifactOwnerHolder(kind, id), artifactIds, keep: true, reason, now });
      }
      this.ports.appendRuntimeEvent({ ...targetFence, type: "work_unit_queued", actor: "system", ts: now,
        data: { kind: "run_suspension_root_activation_v1", activationId: id, suspensionId: input.suspensionId, sourceAttemptId: input.sourceFence.attemptId } });
      const record = readSqliteWithinTransaction(this.context.database, () => readRootSuspensionActivationRecord(this.context.database, input.suspensionId));
      const run = this.ports.getRun(facts.run.id), unit = this.ports.getWorkUnit(facts.unit.id);
      if (!record || !run || !unit || !same(run, facts.run) || unit.activeAttemptId !== targetFence.attemptId) fail("commit_changed");
      return { kind: "activated", record, run, workUnit: unit, attempt: prepared.attempt, continuation: claim.value };
    });
  }

  /** Exact audit lookup only, including after a target has ended; not a dispatch or prepared-SDK acknowledgement. */
  getRootRunSuspensionActivation(input: string | { readonly runId: string; readonly targetAttemptId: string }): RootRunSuspensionActivationRecord | undefined {
    if (typeof input === "string") return readSqliteSnapshot(this.context.database,
      () => readRootSuspensionActivationRecord(this.context.database, delegationId(input)));
    const value = delegationRecord(input, ["runId", "targetAttemptId"]), runId = delegationId(value.runId), attemptId = delegationId(value.targetAttemptId);
    return readSqliteSnapshot(this.context.database, () => {
      const row = this.context.database.prepare("SELECT suspension_id FROM run_suspension_root_activations WHERE run_id=? AND target_attempt_id=?").get(runId, attemptId);
      return row ? readRootSuspensionActivationRecord(this.context.database, String(row.suspension_id)) : undefined;
    });
  }

  /** Joined185 verifier; activation custody is immutable and does not itself authorize a start. */
  assertRootStartWithinTransaction(suspensionId: string, targetFence: RuntimeAttemptFenceV1, now: string): RootRunSuspensionActivationRecord {
    if (!this.context.database.isTransaction) fail("transaction_missing");
    const record = readRootSuspensionActivationRecord(this.context.database, suspensionId);
    if (!record || !same(record.activation.targetFence, targetFence) || record.activation.activatedAt > now) fail("target_conflict");
    const activation = record.activation, saved = this.ports.assertRootStartProofWithinTransaction(suspensionId, targetFence, activation.continuationId);
    const run = this.ports.getRun(activation.runId), source = this.ports.getWorkUnitAttempt(activation.sourceFence.attemptId);
    const stopped = readRunSuspensionStopRecord(this.context.database, suspensionId);
    const continuation = this.context.database.prepare("SELECT runner_id,runner_capability_revision FROM runner_continuations WHERE id=?").get(activation.continuationId);
    if (!run || !source || !stopped || !continuation) fail("source_unverified");
    this.replay({ replayArtifactId: activation.replayArtifactId, sourceFence: activation.sourceFence,
      target: { runnerId: String(continuation.runner_id), runnerCapabilityRevision: String(continuation.runner_capability_revision) } }, run, saved, stopped, source);
    return record;
  }

  private input(raw: ActivateRootRunSuspensionInput): ActivateRootRunSuspensionInput {
    const value = delegationRecord(raw, ["suspensionId", "sourceFence", "expectedReceiptDigest", "replayArtifactId", "target", "claim", "now"]);
    const target = delegationRecord(value.target, ["runtimeInstanceId", "runnerId", "runnerCapabilityRevision"]), claim = delegationRecord(value.claim, ["owner", "token", "expiresAt"]);
    return { suspensionId: delegationId(value.suspensionId), sourceFence: delegationFence(value.sourceFence), expectedReceiptDigest: stopDigest(value.expectedReceiptDigest),
      replayArtifactId: delegationId(value.replayArtifactId), target: { runtimeInstanceId: delegationId(target.runtimeInstanceId), runnerId: delegationId(target.runnerId),
        runnerCapabilityRevision: delegationId(target.runnerCapabilityRevision) }, claim: { owner: delegationId(claim.owner), token: delegationId(claim.token),
        expiresAt: delegationTimestamp(claim.expiresAt) }, now: delegationTimestamp(value.now) };
  }

  private replay(input: { readonly replayArtifactId: string; readonly sourceFence: RuntimeAttemptFenceV1;
    readonly target: { readonly runnerId: string; readonly runnerCapabilityRevision: string } }, run: NonNullable<ReturnType<RunStore["getRun"]>>, saved: RunSuspensionRecord,
    stopped: RunSuspensionStopRecord, source: NonNullable<ReturnType<RunStore["getWorkUnitAttempt"]>>): RunArtifact {
    const retained = readHarnessRetainedBody(this.context.database, input.replayArtifactId), artifact = this.ports.getArtifact(input.replayArtifactId);
    if (retained.bytes > 1_048_576 || !artifact || artifact.runId !== run.id || artifact.type !== "json"
      || artifact.contentType !== "application/vnd.ling.runner-continuation-replay+json") fail("replay_unverified");
    const replay = delegationRecord(artifact.sealedPayload, ["schemaVersion", "boundary", "runId", "rootRunId", "workUnitId", "sourceRunId", "sourceWorkUnitId",
      "origin", "workspaceIdentity", "contextViewId", "contextProjectionVersion", "contextSourceRefs", "sourceFence", "priorAttempt", "runnerId",
      "runnerCapabilityRevision", "policySnapshotFingerprint", "preparedExecutionFingerprint", "acceptedInstructionsFingerprint", "execution",
      "assistantEvidence", "toolEvidence", "approvalEvidence", "artifactRefs", "fingerprint"]);
    const { fingerprint, ...body } = replay, lineage = saved.request.lineage;
    if (replay.schemaVersion !== 1 || replay.boundary !== "runner-continuation-replay" || fingerprint !== hashJson(body)
      || retained.contentSha256 !== hashJson(replay) || replay.runId !== run.id || replay.rootRunId !== run.id || replay.sourceRunId !== run.id
      || replay.workUnitId !== input.sourceFence.workUnitId || replay.sourceWorkUnitId !== input.sourceFence.workUnitId || replay.origin !== "daemon_recovery"
      || replay.workspaceIdentity !== `workspace:sha256:${createHash("sha256").update(resolve(run.cwd)).digest("hex")}`
      || replay.contextViewId !== run.contextViewId || !same(replay.sourceFence, input.sourceFence) || replay.runnerId !== input.target.runnerId
      || replay.runnerCapabilityRevision !== input.target.runnerCapabilityRevision || replay.policySnapshotFingerprint !== lineage.policySnapshotFingerprint
      || replay.preparedExecutionFingerprint !== lineage.preparedExecutionFingerprint || replay.acceptedInstructionsFingerprint !== lineage.acceptedInstructionsFingerprint
      || !same(replay.execution, readRunProgressFrozenExecution(run)) || !same(replay.priorAttempt,
        { status: source.status, ...(source.endedAt ? { endedAt: source.endedAt } : {}), ...(source.errorCode ? { errorCode: source.errorCode } : {}) })
      || !Array.isArray(replay.artifactRefs) || replay.artifactRefs.length > 192 || new Set(replay.artifactRefs).size !== replay.artifactRefs.length
      || ![saved.seal!.modelViewArtifactId, stopped.beginArtifactId, stopped.receiptArtifactId,
        ...runSuspensionWitnessArtifactIds(this.context, saved.seal!.witness)].every(id => (replay.artifactRefs as unknown[]).includes(id))) fail("replay_unverified");
    assertRunProgressPayloadSecretFree(replay);
    return artifact;
  }
  private write<T>(body: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try { const result = body(); if (!this.context.database.isTransaction) fail("transaction_lost"); this.context.database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(this.context.database); throw error; }
  }
}
