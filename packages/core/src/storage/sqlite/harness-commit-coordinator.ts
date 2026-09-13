import {
  RUNNER_CONTINUATION_ORIGINS,
  RUNNER_CONTINUATION_STRATEGIES,
  type RunnerContinuationV1,
} from "@ling-stack/contracts";
import {
  createRunnerContinuationId,
  RunnerContinuationStoreError,
  type PrepareContinuationInput,
  type PreparedContinuation,
} from "../../harness/continuations.js";
import type { RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence, type WorkUnitAttempt } from "../../runtime-supervisor-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteRunnerContinuationStore } from "./runner-continuation-store.js";
import type { SqliteRuntimeWorkUnitStore } from "./runtime-work-unit-store.js";
import type { SqliteStoreContext } from "./store-context.js";

type Ports = Pick<RunStore, "getRun" | "getArtifact">;

/** SQLite-only multi-entity commits. It never spans an OS process, runner, or filesystem effect. */
export class SqliteHarnessCommitCoordinator {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly continuations: SqliteRunnerContinuationStore,
    private readonly runtimeWorkUnits: SqliteRuntimeWorkUnitStore,
    private readonly ports: Ports,
  ) {}

  prepareContinuationAndAttempt(input: PrepareContinuationInput): PreparedContinuation {
    validatePrepareInput(input);
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.continuations.findRunnerContinuationByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        const replay = this.replayExisting(input, existing);
        this.context.database.exec("COMMIT;");
        return replay;
      }

      const sourceAttempt = this.runtimeWorkUnits.getWorkUnitAttempt(input.sourceFence.attemptId);
      const sourceWorkUnit = this.runtimeWorkUnits.getWorkUnit(input.sourceFence.workUnitId);
      if (!sourceAttempt
        || !sourceWorkUnit
        || sourceWorkUnit.activeAttemptId !== sourceAttempt.id
        || !sameFence(toRuntimeAttemptFence(sourceAttempt), input.sourceFence)) {
        throw new RunnerContinuationStoreError("continuation.source_attempt_stale");
      }

      const targetRun = this.ports.getRun(input.runId);
      const targetWorkUnit = this.runtimeWorkUnits.getWorkUnit(input.workUnitId);
      if (!targetRun
        || !targetWorkUnit
        || targetRun.workUnitId !== targetWorkUnit.id
        || targetWorkUnit.linkedRunId !== targetRun.id
        || targetWorkUnit.workspaceId !== sourceWorkUnit.workspaceId
        || ["succeeded", "failed", "cancelled"].includes(targetRun.status)) {
        throw new RunnerContinuationStoreError("continuation.lineage_mismatch");
      }
      if ((targetWorkUnit.activeAttemptId ?? null) !== input.expectedTargetAttemptId) {
        throw new RunnerContinuationStoreError("continuation.target_attempt_lost");
      }

      const sourceRunId = sourceWorkUnit.linkedRunId;
      if (!sourceRunId || (sourceRunId !== targetRun.id && targetRun.parentRunId !== sourceRunId)) {
        throw new RunnerContinuationStoreError("continuation.lineage_mismatch");
      }
      if (!targetRun.contextViewId || targetRun.contextViewId !== input.contextViewId) {
        throw new RunnerContinuationStoreError("continuation.lineage_mismatch");
      }
      const contextArtifact = this.ports.getArtifact(input.contextSnapshotArtifactId);
      if (!contextArtifact || contextArtifact.runId !== targetRun.id) {
        throw new RunnerContinuationStoreError("continuation.context_snapshot_missing");
      }
      if (input.targetAttempt.runnerId !== input.runnerId
        || (input.targetAttempt.effectiveRunnerId ?? input.targetAttempt.runnerId) !== input.runnerId
        || input.targetAttempt.providerPresetId !== targetRun.providerPresetId
        || (targetWorkUnit.effectiveRunnerId !== undefined && targetWorkUnit.effectiveRunnerId !== input.runnerId)
        || (targetWorkUnit.runnerId !== undefined && targetWorkUnit.runnerId !== input.runnerId)) {
        throw new RunnerContinuationStoreError("continuation.lineage_mismatch");
      }

      const attemptNumber = targetWorkUnit.attemptCount + 1;
      if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
        throw new RunnerContinuationStoreError("continuation.invalid_input");
      }
      const attempt = this.runtimeWorkUnits.createWorkUnitAttemptWithinTransaction({
        ...input.targetAttempt,
        workUnitId: targetWorkUnit.id,
        attemptNumber,
        status: "created",
        now: input.now,
      });
      const continuation = this.continuations.insertWithinTransaction({
        schemaVersion: 1,
        id: input.id ?? createRunnerContinuationId(),
        runId: targetRun.id,
        workUnitId: targetWorkUnit.id,
        sourceAttemptId: sourceAttempt.id,
        targetAttemptId: attempt.id,
        origin: input.origin,
        strategy: input.strategy,
        state: "prepared",
        runnerId: input.runnerId,
        runnerCapabilityRevision: input.runnerCapabilityRevision,
        contextViewId: input.contextViewId,
        contextSnapshotArtifactId: input.contextSnapshotArtifactId,
        runnerHandleRef: input.runnerHandleRef,
        idempotencyKey: input.idempotencyKey,
        generation: input.generation,
        revision: 0,
        createdAt: input.now,
        updatedAt: input.now,
      });
      this.context.database.exec("COMMIT;");
      return { continuation, attempt, replayed: false };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  private replayExisting(input: PrepareContinuationInput, existing: RunnerContinuationV1): PreparedContinuation {
    const attempt = existing.targetAttemptId
      ? this.runtimeWorkUnits.getWorkUnitAttempt(existing.targetAttemptId)
      : undefined;
    const sourceAttempt = this.runtimeWorkUnits.getWorkUnitAttempt(existing.sourceAttemptId);
    if (!attempt || !sourceAttempt) throw new RunnerContinuationStoreError("continuation.lineage_mismatch");
    const sameContinuation = existing.runId === input.runId
      && existing.workUnitId === input.workUnitId
      && existing.sourceAttemptId === input.sourceFence.attemptId
      && existing.origin === input.origin
      && existing.strategy === input.strategy
      && existing.runnerId === input.runnerId
      && existing.runnerCapabilityRevision === input.runnerCapabilityRevision
      && existing.contextViewId === input.contextViewId
      && existing.contextSnapshotArtifactId === input.contextSnapshotArtifactId
      && existing.runnerHandleRef === input.runnerHandleRef
      && existing.generation === input.generation
      && (!input.id || existing.id === input.id)
      && sameFence(toRuntimeAttemptFence(sourceAttempt), input.sourceFence);
    const sameAttempt = attempt.workUnitId === input.workUnitId
      && attempt.runtimeInstanceId === input.targetAttempt.runtimeInstanceId
      && attempt.runnerId === input.targetAttempt.runnerId
      && attempt.requestedRunnerId === input.targetAttempt.requestedRunnerId
      && attempt.effectiveRunnerId === (input.targetAttempt.effectiveRunnerId ?? input.targetAttempt.runnerId)
      && sameJson(attempt.fallbackReason, input.targetAttempt.fallbackReason)
      && attempt.providerPresetId === input.targetAttempt.providerPresetId
      && (!input.targetAttempt.id || attempt.id === input.targetAttempt.id)
      && (!input.targetAttempt.fencingToken || attempt.fencingToken === input.targetAttempt.fencingToken);
    if (!sameContinuation || !sameAttempt) {
      throw new RunnerContinuationStoreError("continuation.idempotency_conflict");
    }
    return { continuation: existing, attempt, replayed: true };
  }
}

function validatePrepareInput(input: PrepareContinuationInput): void {
  for (const [value, label] of [
    [input.id, "id"],
    [input.runId, "run id"],
    [input.workUnitId, "work unit id"],
    [input.sourceFence.workUnitId, "source work unit id"],
    [input.sourceFence.attemptId, "source attempt id"],
    [input.sourceFence.runtimeInstanceId, "source runtime instance id"],
    [input.sourceFence.fencingToken, "source fencing token"],
    [input.runnerId, "runner id"],
    [input.runnerCapabilityRevision, "runner capability revision"],
    [input.contextViewId, "context view id"],
    [input.contextSnapshotArtifactId, "context snapshot artifact id"],
    [input.runnerHandleRef, "runner handle ref"],
    [input.idempotencyKey, "idempotency key"],
    [input.targetAttempt.id, "target attempt id"],
    [input.targetAttempt.runtimeInstanceId, "target runtime instance id"],
    [input.targetAttempt.runnerId, "target runner id"],
    [input.targetAttempt.requestedRunnerId, "requested runner id"],
    [input.targetAttempt.effectiveRunnerId, "effective runner id"],
    [input.targetAttempt.providerPresetId, "provider preset id"],
    [input.targetAttempt.fencingToken, "target fencing token"],
  ] as const) {
    if (value !== undefined && (!value.trim() || value !== value.trim() || value.length > 4096)) {
      throw new RunnerContinuationStoreError("continuation.invalid_input");
    }
  }
  if (!RUNNER_CONTINUATION_ORIGINS.includes(input.origin)
    || !RUNNER_CONTINUATION_STRATEGIES.includes(input.strategy)
    || !Number.isSafeInteger(input.generation)
    || input.generation < 0) {
    throw new RunnerContinuationStoreError("continuation.invalid_input");
  }
  assertTimestamp(input.now);
}

function assertTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new RunnerContinuationStoreError("continuation.invalid_input");
  }
}

function sameFence(left: ReturnType<typeof toRuntimeAttemptFence>, right: ReturnType<typeof toRuntimeAttemptFence>): boolean {
  return left.workUnitId === right.workUnitId
    && left.attemptId === right.attemptId
    && left.runtimeInstanceId === right.runtimeInstanceId
    && left.fencingToken === right.fencingToken;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
