import {
  RUNNER_CONTINUATION_ORIGINS,
  RUNNER_CONTINUATION_STRATEGIES,
  type RunnerContinuationV1,
} from "@ling-stack/contracts";
import {
  createRunnerContinuationId,
  RunnerContinuationStoreError,
  type CommitExistingRunContinuationPreparationFailureInput,
  type CommitExistingRunContinuationPreparationFailureResult,
  type CommitExistingRunContinuationInput,
  type CommitExistingRunContinuationResult,
  type CommitStaleRunRecoveryFailureInput,
  type CommitStaleRunRecoveryFailureResult,
  type PrepareContinuationInput,
  type PreparedContinuation,
  type ReprepareContinuationInput,
} from "../../harness/continuations.js";
import type { RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence, type WorkUnitAttempt } from "../../runtime-supervisor-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteRunnerContinuationStore } from "./runner-continuation-store.js";
import type { SqliteRuntimeWorkUnitStore } from "./runtime-work-unit-store.js";
import type { SqliteStoreContext } from "./store-context.js";

type Ports = Pick<
  RunStore,
  | "getRun"
  | "getArtifact"
  | "getTask"
  | "transitionRunStatus"
  | "transitionTaskStatus"
  | "transitionWorkUnitStatus"
  | "appendRuntimeEvent"
  | "releaseResourceLeasesForAttempt"
  | "releaseRuntimeSemaphoreSlotsForAttempt"
>;

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
      const prepared = this.prepareContinuationAndAttemptWithinTransaction(input);
      this.context.database.exec("COMMIT;");
      return prepared;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  /**
   * Reopens one logical Run and prepares its replacement Attempt in the same
   * SQLite transaction. Runner dispatch remains outside SQLite and is guarded
   * by the newly-created Attempt fence.
   */
  commitExistingRunContinuation(
    input: CommitExistingRunContinuationInput,
  ): CommitExistingRunContinuationResult {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.continuations.findRunnerContinuationByIdempotencyKey(input.preparation.idempotencyKey);
      if (existing) {
        const replay = this.replayExisting(input.preparation, existing);
        const run = this.ports.getRun(input.preparation.runId);
        const workUnit = this.runtimeWorkUnits.getWorkUnit(input.preparation.workUnitId);
        if (!run || !workUnit || workUnit.activeAttemptId !== replay.attempt.id) {
          throw new ExistingRunContinuationActivationAbort("continuation.activation_lineage_stale");
        }
        this.context.database.exec("COMMIT;");
        return { ok: true, run, workUnit, attempt: replay.attempt, continuation: replay.continuation, replayed: true };
      }

      const run = this.ports.getRun(input.preparation.runId);
      const workUnit = this.runtimeWorkUnits.getWorkUnit(input.preparation.workUnitId);
      const sourceAttempt = this.runtimeWorkUnits.getWorkUnitAttempt(input.preparation.sourceFence.attemptId);
      const task = run ? this.ports.getTask(run.taskId) : undefined;
      if (!run || !workUnit || !sourceAttempt
        || run.workUnitId !== workUnit.id
        || workUnit.linkedRunId !== run.id
        || workUnit.activeAttemptId !== sourceAttempt.id
        || !sameFence(toRuntimeAttemptFence(sourceAttempt), input.preparation.sourceFence)) {
        throw new ExistingRunContinuationActivationAbort("continuation.activation_lineage_stale");
      }
      if (run.status !== input.expectedRunStatus
        || workUnit.status !== input.expectedWorkUnitStatus
        || (input.expectedTaskStatus !== undefined && task?.status !== input.expectedTaskStatus)) {
        throw new ExistingRunContinuationActivationAbort("continuation.activation_state_stale");
      }

      if (input.preparation.origin === "runner_retry") {
        if (run.status !== "failed" || workUnit.status !== "failed" || task?.status !== "failed") {
          throw new ExistingRunContinuationActivationAbort("continuation.activation_state_stale");
        }
        const runTransition = this.ports.transitionRunStatus({
          runId: run.id,
          expectedStatus: "failed",
          event: "retry",
          actor: input.actor,
          reason: input.reason,
          idempotencyKey: `${input.preparation.idempotencyKey}:run-retry`,
          now: input.now,
          endedAt: null,
          summaryPath: null,
          errorMessage: null,
        });
        const taskTransition = this.ports.transitionTaskStatus({
          taskId: task.id,
          expectedStatus: "failed",
          event: "retry",
          actor: input.actor,
          reason: input.reason,
          idempotencyKey: `${input.preparation.idempotencyKey}:task-retry`,
          now: input.now,
          currentRunId: run.id,
        });
        if (!runTransition.ok || !taskTransition.ok) {
          throw new ExistingRunContinuationActivationAbort("continuation.activation_transition_failed");
        }
      } else if (input.preparation.origin === "daemon_recovery") {
        if ((run.status !== "running" && run.status !== "queued") || workUnit.status !== "stale") {
          throw new ExistingRunContinuationActivationAbort("continuation.activation_state_stale");
        }
      } else {
        throw new ExistingRunContinuationActivationAbort("continuation.activation_state_stale");
      }

      const workUnitTransition = this.ports.transitionWorkUnitStatus({
        workUnitId: workUnit.id,
        expectedStatus: input.expectedWorkUnitStatus,
        event: "retry",
        actor: input.actor,
        reason: input.reason,
        idempotencyKey: `${input.preparation.idempotencyKey}:work-unit-retry`,
        now: input.now,
        activeAttemptId: sourceAttempt.id,
        endedAt: null,
        errorCode: null,
        errorMessage: null,
      });
      if (!workUnitTransition.ok) {
        throw new ExistingRunContinuationActivationAbort("continuation.activation_transition_failed");
      }
      const prepared = this.prepareContinuationAndAttemptWithinTransaction(input.preparation);
      this.ports.appendRuntimeEvent({
        workUnitId: workUnit.id,
        attemptId: prepared.attempt.id,
        runtimeInstanceId: prepared.attempt.runtimeInstanceId,
        fencingToken: prepared.attempt.fencingToken,
        type: "work_unit_queued",
        actor: input.actor,
        ts: input.now,
        data: { reason: input.reason, origin: input.preparation.origin, sourceAttemptId: sourceAttempt.id },
      });
      this.context.database.exec("COMMIT;");
      const committedRun = this.ports.getRun(run.id);
      const committedWorkUnit = this.runtimeWorkUnits.getWorkUnit(workUnit.id);
      if (!committedRun || !committedWorkUnit) throw new Error("Existing Run continuation committed but could not be reloaded.");
      return {
        ok: true,
        run: committedRun,
        workUnit: committedWorkUnit,
        attempt: prepared.attempt,
        continuation: prepared.continuation,
        replayed: prepared.replayed,
      };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof ExistingRunContinuationActivationAbort) {
        return { ok: false, code: error.code };
      }
      throw error;
    }
  }

  /**
   * Closes a continuation that was activated but failed before Runner start.
   * The logical Run, Task, WorkUnit, Attempt, and continuation share one
   * transaction so recovery can never expose a half-activated lineage.
   */
  commitExistingRunContinuationPreparationFailure(
    input: CommitExistingRunContinuationPreparationFailureInput,
  ): CommitExistingRunContinuationPreparationFailureResult {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const run = this.ports.getRun(input.runId);
      const workUnit = this.runtimeWorkUnits.getWorkUnit(input.workUnitId);
      const attempt = this.runtimeWorkUnits.getWorkUnitAttempt(input.targetFence.attemptId);
      const task = run ? this.ports.getTask(run.taskId) : undefined;
      const continuation = this.continuations.getRunnerContinuation(input.continuationId);
      if (!run || !workUnit || !attempt || !task || !continuation
        || run.workUnitId !== workUnit.id
        || workUnit.linkedRunId !== run.id
        || workUnit.activeAttemptId !== attempt.id
        || attempt.workUnitId !== workUnit.id
        || continuation.runId !== run.id
        || continuation.workUnitId !== workUnit.id
        || continuation.targetAttemptId !== attempt.id
        || !sameFence(toRuntimeAttemptFence(attempt), input.targetFence)) {
        throw new ExistingRunContinuationPreparationFailureAbort(
          "continuation.preparation_failure_lineage_stale",
        );
      }
      if (run.status !== input.expectedRunStatus
        || workUnit.status !== input.expectedWorkUnitStatus
        || attempt.status !== input.expectedAttemptStatus
        || continuation.state !== input.expectedContinuationState
        || continuation.revision !== input.expectedContinuationRevision) {
        throw new ExistingRunContinuationPreparationFailureAbort(
          "continuation.preparation_failure_state_stale",
        );
      }

      const failedContinuation = this.continuations.failPreparationWithinTransaction(input);
      const runTransition = this.ports.transitionRunStatus({
        runId: run.id,
        expectedStatus: input.expectedRunStatus,
        event: "runner_failed",
        actor: "system",
        reason: input.errorCode,
        idempotencyKey: `${continuation.id}:preparation-failure:run`,
        now: input.now,
        endedAt: input.now,
        errorMessage: input.errorMessage,
      });
      const workUnitTransition = this.ports.transitionWorkUnitStatus({
        ...input.targetFence,
        activeAttemptId: attempt.id,
        expectedStatus: input.expectedWorkUnitStatus,
        event: "runner_failed",
        actor: "system",
        reason: input.errorCode,
        idempotencyKey: `${continuation.id}:preparation-failure:work-unit`,
        now: input.now,
        endedAt: input.now,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      });
      const failedAttempt = this.runtimeWorkUnits.updateWorkUnitAttemptStatus({
        ...input.targetFence,
        status: "failed",
        now: input.now,
        endedAt: input.now,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      });
      if (!failedContinuation || !runTransition.ok || !workUnitTransition.ok || !failedAttempt) {
        throw new ExistingRunContinuationPreparationFailureAbort(
          "continuation.preparation_failure_transition_failed",
        );
      }
      let failedTask = task;
      if (task.status === "claimed" || task.status === "running") {
        const taskTransition = this.ports.transitionTaskStatus({
          taskId: task.id,
          expectedStatus: task.status,
          event: "run_failed",
          actor: "system",
          reason: input.errorCode,
          idempotencyKey: `${continuation.id}:preparation-failure:task`,
          now: input.now,
          currentRunId: run.id,
        });
        if (!taskTransition.ok) {
          throw new ExistingRunContinuationPreparationFailureAbort(
            "continuation.preparation_failure_transition_failed",
          );
        }
        failedTask = this.ports.getTask(task.id)!;
      } else if (task.status !== "failed") {
        throw new ExistingRunContinuationPreparationFailureAbort(
          "continuation.preparation_failure_state_stale",
        );
      }
      this.runtimeWorkUnits.appendTerminalRuntimeAudit({
        capability: {
          ...input.targetFence,
          attemptStatus: "failed",
          transitionedAt: input.now,
        },
        type: "work_unit_failed",
        actor: "system",
        data: {
          fromStatus: input.expectedWorkUnitStatus,
          toStatus: "failed",
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
        },
      });
      this.ports.releaseResourceLeasesForAttempt(input.targetFence, input.now, "continuation-preparation-failed");
      this.ports.releaseRuntimeSemaphoreSlotsForAttempt(input.targetFence, input.now, "continuation-preparation-failed");
      this.context.database.exec("COMMIT;");
      return {
        ok: true,
        run: this.ports.getRun(run.id)!,
        task: failedTask,
        workUnit: this.runtimeWorkUnits.getWorkUnit(workUnit.id)!,
        attempt: failedAttempt,
        continuation: failedContinuation,
      };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof ExistingRunContinuationPreparationFailureAbort) {
        return { ok: false, code: error.code };
      }
      throw error;
    }
  }

  /** Settles a pre-activation recovery failure without modifying the lost source Attempt. */
  commitStaleRunRecoveryFailure(input: CommitStaleRunRecoveryFailureInput): CommitStaleRunRecoveryFailureResult {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const run = this.ports.getRun(input.runId);
      const workUnit = this.runtimeWorkUnits.getWorkUnit(input.sourceFence.workUnitId);
      const attempt = this.runtimeWorkUnits.getWorkUnitAttempt(input.sourceFence.attemptId);
      const task = run ? this.ports.getTask(run.taskId) : undefined;
      if (!run || !workUnit || !attempt || !task
        || run.workUnitId !== workUnit.id || workUnit.linkedRunId !== run.id
        || workUnit.activeAttemptId !== attempt.id || attempt.workUnitId !== workUnit.id
        || !sameFence(toRuntimeAttemptFence(attempt), input.sourceFence)) {
        throw new StaleRunRecoveryFailureAbort("recovery_failure_lineage_stale");
      }
      if (run.status !== input.expectedRunStatus || workUnit.status !== "stale" || attempt.status !== "lost"
        || (task.status !== "claimed" && task.status !== "running")) {
        throw new StaleRunRecoveryFailureAbort("recovery_failure_state_stale");
      }
      const runTransition = this.ports.transitionRunStatus({
        runId: run.id, expectedStatus: run.status, event: "runner_failed", actor: "system",
        reason: input.errorCode, now: input.now, endedAt: input.now,
        summaryPath: input.summaryPath, errorMessage: input.errorMessage,
      });
      const workUnitTransition = this.ports.transitionWorkUnitStatus({
        workUnitId: workUnit.id, expectedStatus: "stale", event: "reconcile_failed", actor: "system",
        reason: input.errorCode, now: input.now, endedAt: input.now,
        errorCode: input.errorCode, errorMessage: input.errorMessage,
      });
      const taskTransition = this.ports.transitionTaskStatus({
        taskId: task.id, expectedStatus: task.status, event: "run_failed", actor: "system",
        reason: input.errorCode, now: input.now, currentRunId: run.id,
      });
      if (!runTransition.ok || !workUnitTransition.ok || !taskTransition.ok) {
        throw new StaleRunRecoveryFailureAbort("recovery_failure_transition_failed");
      }
      this.ports.appendRuntimeEvent({
        workUnitId: workUnit.id, type: "work_unit_failed", actor: "system", ts: input.now,
        data: { reason: "daemon_recovery_preflight", sourceAttemptId: attempt.id,
          errorCode: input.errorCode, errorMessage: input.errorMessage },
      });
      this.ports.releaseResourceLeasesForAttempt(input.sourceFence, input.now, "recovery-preflight-failed");
      this.ports.releaseRuntimeSemaphoreSlotsForAttempt(input.sourceFence, input.now, "recovery-preflight-failed");
      this.context.database.exec("COMMIT;");
      return { ok: true, run: this.ports.getRun(run.id)!, workUnit: this.runtimeWorkUnits.getWorkUnit(workUnit.id)! };
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof StaleRunRecoveryFailureAbort) return { ok: false, code: error.code };
      throw error;
    }
  }

  /** Caller owns BEGIN/COMMIT. Used only by another SQLite commit coordinator. */
  prepareContinuationAndAttemptWithinTransaction(input: PrepareContinuationInput): PreparedContinuation {
    validatePrepareInput(input);
    const existing = this.continuations.findRunnerContinuationByIdempotencyKey(input.idempotencyKey);
    if (existing) return this.replayExisting(input, existing);

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
    return { continuation, attempt, replayed: false };
  }

  /**
   * Replaces one rejected native-resume Attempt with exactly one deterministic
   * replay Attempt. The abandoned fence, continuation generation, and lease are
   * checked in the same transaction that moves the Work Unit active pointer.
   */
  reprepareContinuationAndAttempt(input: ReprepareContinuationInput): PreparedContinuation {
    validateReprepareInput(input);
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.continuations.getRunnerContinuation(input.continuationId);
      if (!current) throw new RunnerContinuationStoreError("continuation.lineage_mismatch");

      if (current.state === "prepared"
        && current.strategy === "deterministic_replay"
        && current.generation === input.expectedGeneration + 1) {
        const replay = this.replayReprepared(input, current);
        this.context.database.exec("COMMIT;");
        return replay;
      }

      if (current.revision !== input.expectedRevision
        || current.state !== "recovery_pending"
        || current.strategy !== "native_resume"
        || current.generation !== input.expectedGeneration
        || current.claimOwner !== input.claimOwner
        || current.claimToken !== input.claimToken
        || !current.claimExpiresAt
        || current.claimExpiresAt <= input.now
        || !["continuation.handle_missing", "continuation.handle_rejected", "continuation.runner_not_conformant"].includes(current.failureCode ?? "")) {
        throw new RunnerContinuationStoreError("continuation.lineage_mismatch");
      }
      const abandoned = this.runtimeWorkUnits.getWorkUnitAttempt(input.abandonedTargetFence.attemptId);
      const workUnit = this.runtimeWorkUnits.getWorkUnit(current.workUnitId);
      if (!abandoned
        || !workUnit
        || current.targetAttemptId !== abandoned.id
        || workUnit.activeAttemptId !== abandoned.id
        || !sameFence(toRuntimeAttemptFence(abandoned), input.abandonedTargetFence)) {
        throw new RunnerContinuationStoreError("continuation.target_attempt_lost");
      }
      if (input.targetAttempt.runnerId !== current.runnerId
        || (input.targetAttempt.effectiveRunnerId ?? input.targetAttempt.runnerId) !== current.runnerId
        || input.targetAttempt.providerPresetId !== abandoned.providerPresetId) {
        throw new RunnerContinuationStoreError("continuation.lineage_mismatch");
      }

      const attempt = this.runtimeWorkUnits.createWorkUnitAttemptWithinTransaction({
        ...input.targetAttempt,
        workUnitId: current.workUnitId,
        attemptNumber: workUnit.attemptCount + 1,
        status: "created",
        now: input.now,
      });
      const updated = this.context.database.prepare(`
        UPDATE runner_continuations
        SET target_attempt_id = ?, strategy = 'deterministic_replay', state = 'prepared',
            generation = generation + 1, revision = revision + 1,
            claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL,
            next_attempt_at = NULL, failure_code = NULL,
            failure_detail_artifact_id = NULL, updated_at = ?, completed_at = NULL
        WHERE id = ? AND revision = ? AND state = 'recovery_pending'
          AND strategy = 'native_resume' AND generation = ?
          AND target_attempt_id = ? AND claim_owner = ? AND claim_token = ?
      `).run(
        attempt.id,
        input.now,
        current.id,
        input.expectedRevision,
        input.expectedGeneration,
        abandoned.id,
        input.claimOwner,
        input.claimToken,
      );
      if (Number(updated.changes) !== 1) {
        throw new RunnerContinuationStoreError("continuation.target_attempt_lost");
      }
      const continuation = this.continuations.getRunnerContinuation(current.id);
      if (!continuation) throw new RunnerContinuationStoreError("continuation.lineage_mismatch");
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

  private replayReprepared(input: ReprepareContinuationInput, current: RunnerContinuationV1): PreparedContinuation {
    const attempt = current.targetAttemptId
      ? this.runtimeWorkUnits.getWorkUnitAttempt(current.targetAttemptId)
      : undefined;
    const abandoned = this.runtimeWorkUnits.getWorkUnitAttempt(input.abandonedTargetFence.attemptId);
    if (!attempt || !abandoned
      || abandoned.status !== "lost"
      || !sameFence(toRuntimeAttemptFence(abandoned), input.abandonedTargetFence)
      || attempt.id !== input.targetAttempt.id
      || attempt.workUnitId !== current.workUnitId
      || attempt.runtimeInstanceId !== input.targetAttempt.runtimeInstanceId
      || attempt.runnerId !== input.targetAttempt.runnerId
      || attempt.requestedRunnerId !== input.targetAttempt.requestedRunnerId
      || attempt.effectiveRunnerId !== (input.targetAttempt.effectiveRunnerId ?? input.targetAttempt.runnerId)
      || !sameJson(attempt.fallbackReason, input.targetAttempt.fallbackReason)
      || attempt.providerPresetId !== input.targetAttempt.providerPresetId
      || (input.targetAttempt.fencingToken !== undefined && attempt.fencingToken !== input.targetAttempt.fencingToken)) {
      throw new RunnerContinuationStoreError("continuation.idempotency_conflict");
    }
    return { continuation: current, attempt, replayed: true };
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

function validateReprepareInput(input: ReprepareContinuationInput): void {
  for (const [value, label] of [
    [input.continuationId, "continuation id"],
    [input.claimOwner, "claim owner"],
    [input.claimToken, "claim token"],
    [input.abandonedTargetFence.workUnitId, "abandoned work unit id"],
    [input.abandonedTargetFence.attemptId, "abandoned attempt id"],
    [input.abandonedTargetFence.runtimeInstanceId, "abandoned runtime instance id"],
    [input.abandonedTargetFence.fencingToken, "abandoned fencing token"],
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
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
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

class ExistingRunContinuationActivationAbort extends Error {
  constructor(readonly code: Extract<CommitExistingRunContinuationResult, { readonly ok: false }>["code"]) {
    super(code);
    this.name = "ExistingRunContinuationActivationAbort";
  }
}

class ExistingRunContinuationPreparationFailureAbort extends Error {
  constructor(
    readonly code: Extract<
      CommitExistingRunContinuationPreparationFailureResult,
      { readonly ok: false }
    >["code"],
  ) {
    super(code);
    this.name = "ExistingRunContinuationPreparationFailureAbort";
  }
}

class StaleRunRecoveryFailureAbort extends Error {
  constructor(readonly code: Extract<CommitStaleRunRecoveryFailureResult, { readonly ok: false }>["code"]) {
    super(code);
    this.name = "StaleRunRecoveryFailureAbort";
  }
}
