import type { SQLOutputValue } from "node:sqlite";
import type { RunnerContinuationV1 } from "@ling-stack/contracts";
import {
  transitionRunnerContinuation,
  type ClaimRunnerContinuationInput,
  type FinishRunnerContinuationInput,
  type ListClaimableRunnerContinuationsInput,
  type RunnerContinuationMutationResult,
  type StartRunnerContinuationInput,
} from "../../harness/continuations.js";
import { isHarnessLeaseClaimable } from "../../harness/common.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1, type WorkUnitAttempt } from "../../runtime-supervisor-types.js";
import type { RunArtifact } from "../../run-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { mapRunnerContinuation, runnerContinuationSelectSql } from "./runner-continuation-mappers.js";
import type { SqliteRuntimeWorkUnitStore } from "./runtime-work-unit-store.js";
import type { SqliteStoreContext } from "./store-context.js";

interface RunnerContinuationStorePorts {
  readonly getArtifact: (id: string) => RunArtifact | undefined;
}

/** Durable continuation reads and fenced lease/state transitions. */
export class SqliteRunnerContinuationStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly runtimeWorkUnits: SqliteRuntimeWorkUnitStore,
    private readonly ports: RunnerContinuationStorePorts,
  ) {}

  getRunnerContinuation(id: string): RunnerContinuationV1 | undefined {
    const row = this.context.database.prepare(runnerContinuationSelectSql("WHERE id = ?")).get(id);
    return row ? mapRunnerContinuation(row as Record<string, SQLOutputValue>) : undefined;
  }

  findRunnerContinuationByIdempotencyKey(idempotencyKey: string): RunnerContinuationV1 | undefined {
    const row = this.context.database
      .prepare(runnerContinuationSelectSql("WHERE idempotency_key = ?"))
      .get(idempotencyKey);
    return row ? mapRunnerContinuation(row as Record<string, SQLOutputValue>) : undefined;
  }

  listClaimableRunnerContinuations(input: ListClaimableRunnerContinuationsInput): readonly RunnerContinuationV1[] {
    assertTimestamp(input.now);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Runner continuation claim limit must be between 1 and 500.");
    }
    return this.context.database
      .prepare(`${runnerContinuationSelectSql(`
        WHERE state = 'prepared'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
      `)} ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, id ASC LIMIT ?`)
      .all(input.now, input.now, limit)
      .map((row) => mapRunnerContinuation(row as Record<string, SQLOutputValue>));
  }

  insertWithinTransaction(continuation: RunnerContinuationV1): RunnerContinuationV1 {
    this.context.database.prepare(`
      INSERT INTO runner_continuations (
        id, schema_version, run_id, work_unit_id, source_attempt_id, target_attempt_id,
        origin, strategy, state, runner_id, runner_capability_revision, context_view_id,
        context_snapshot_artifact_id, runner_handle_ref, idempotency_key,
        claim_owner, claim_token, claim_expires_at, next_attempt_at,
        generation, revision, failure_code, failure_detail_artifact_id,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      continuation.id,
      continuation.schemaVersion,
      continuation.runId,
      continuation.workUnitId,
      continuation.sourceAttemptId,
      continuation.targetAttemptId ?? null,
      continuation.origin,
      continuation.strategy,
      continuation.state,
      continuation.runnerId,
      continuation.runnerCapabilityRevision,
      continuation.contextViewId,
      continuation.contextSnapshotArtifactId,
      continuation.runnerHandleRef ?? null,
      continuation.idempotencyKey,
      continuation.claimOwner ?? null,
      continuation.claimToken ?? null,
      continuation.claimExpiresAt ?? null,
      continuation.nextAttemptAt ?? null,
      continuation.generation,
      continuation.revision,
      continuation.failureCode ?? null,
      continuation.failureDetailArtifactId ?? null,
      continuation.createdAt,
      continuation.updatedAt,
      continuation.completedAt ?? null,
    );
    const stored = this.getRunnerContinuation(continuation.id);
    if (!stored) throw new Error(`Failed to create runner continuation: ${continuation.id}`);
    return stored;
  }

  claimRunnerContinuation(input: ClaimRunnerContinuationInput): RunnerContinuationMutationResult {
    validateClaimInput(input);
    return this.transaction(() => {
      const current = this.getRunnerContinuation(input.continuationId);
      if (!current) return { ok: false, code: "not_found" };
      const target = this.currentTargetAttempt(current);
      if (!target || target.status !== "created") return { ok: false, code: "continuation.target_attempt_lost" };
      if (current.state === "claimed"
        && current.claimOwner === input.claimOwner
        && current.claimToken === input.claimToken) {
        if (!current.claimExpiresAt || current.claimExpiresAt <= input.now) {
          return { ok: false, code: "lease_not_claimable" };
        }
        return { ok: true, value: current, replayed: true };
      }
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      if (current.state !== "prepared") return { ok: false, code: "invalid_transition" };
      if (!isHarnessLeaseClaimable({ ...current, now: input.now })) {
        return { ok: false, code: "lease_not_claimable" };
      }
      const update = this.context.database.prepare(`
        UPDATE runner_continuations
        SET state = 'claimed', revision = revision + 1,
            claim_owner = ?, claim_token = ?, claim_expires_at = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'prepared'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
          AND EXISTS (
            SELECT 1
            FROM work_units wu
            JOIN work_unit_attempts wa ON wa.id = runner_continuations.target_attempt_id
            WHERE wu.id = runner_continuations.work_unit_id
              AND wu.active_attempt_id = wa.id
              AND wa.work_unit_id = wu.id
              AND wa.status = 'created'
          )
      `).run(
        input.claimOwner,
        input.claimToken,
        input.claimExpiresAt,
        input.now,
        input.continuationId,
        input.expectedRevision,
        input.now,
        input.now,
      );
      if (Number(update.changes) !== 1) return this.classifyClaimFailure(input);
      return { ok: true, value: this.getRunnerContinuation(input.continuationId)!, replayed: false };
    });
  }

  startRunnerContinuation(input: StartRunnerContinuationInput): RunnerContinuationMutationResult {
    validateExecutionMutationInput(input);
    return this.transaction(() => {
      const current = this.getRunnerContinuation(input.continuationId);
      if (!current) return { ok: false, code: "not_found" };
      if (!this.matchesLease(current, input) || !current.claimExpiresAt || current.claimExpiresAt <= input.now) {
        return { ok: false, code: "lease_mismatch" };
      }
      const target = this.currentTargetAttempt(current, input.targetFence);
      if (!target) return { ok: false, code: "continuation.target_attempt_lost" };
      if (current.state === "running" && target.status === "started") {
        return { ok: true, value: current, replayed: true };
      }
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      if (current.state !== "claimed" || !["created", "started"].includes(target.status)) {
        return { ok: false, code: "invalid_transition" };
      }
      if (target.status === "created") {
        const started = this.runtimeWorkUnits.updateWorkUnitAttemptStatus({
          ...input.targetFence,
          status: "started",
          startedAt: input.now,
          lastHeartbeatAt: input.now,
          errorCode: null,
          errorMessage: null,
          now: input.now,
        });
        if (!started) return { ok: false, code: "continuation.target_attempt_lost" };
      }
      const update = this.context.database.prepare(`
        UPDATE runner_continuations
        SET state = 'running', revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'claimed'
          AND claim_owner = ? AND claim_token = ? AND claim_expires_at > ?
      `).run(
        input.now,
        input.continuationId,
        input.expectedRevision,
        input.claimOwner,
        input.claimToken,
        input.now,
      );
      if (Number(update.changes) !== 1) return { ok: false, code: "stale_revision" };
      return { ok: true, value: this.getRunnerContinuation(input.continuationId)!, replayed: false };
    });
  }

  finishRunnerContinuation(input: FinishRunnerContinuationInput): RunnerContinuationMutationResult {
    validateExecutionMutationInput(input);
    return this.transaction(() => {
      const current = this.getRunnerContinuation(input.continuationId);
      if (!current) return { ok: false, code: "not_found" };
      if (input.failureDetailArtifactId) {
        const artifact = this.ports.getArtifact(input.failureDetailArtifactId);
        if (!artifact || artifact.runId !== current.runId) return { ok: false, code: "invalid_transition" };
      }
      if (!this.matchesLease(current, input) || !current.claimExpiresAt || current.claimExpiresAt <= input.now) {
        return { ok: false, code: "lease_mismatch" };
      }
      if (!this.currentTargetAttempt(current, input.targetFence)) {
        return { ok: false, code: "continuation.target_attempt_lost" };
      }
      if (current.state === input.nextState) {
        return { ok: true, value: current, replayed: true };
      }
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      const transition = transitionRunnerContinuation({
        current,
        expectedRevision: input.expectedRevision,
        nextState: input.nextState,
        now: input.now,
      });
      if (!transition.ok) return { ok: false, code: transition.code };
      const next = transition.value;
      const update = this.context.database.prepare(`
        UPDATE runner_continuations
        SET state = ?, revision = ?, failure_code = ?, failure_detail_artifact_id = ?,
            next_attempt_at = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND revision = ? AND state = ?
          AND claim_owner = ? AND claim_token = ? AND claim_expires_at > ?
      `).run(
        next.state,
        next.revision,
        input.failureCode ?? null,
        input.failureDetailArtifactId ?? null,
        input.nextState === "recovery_pending" ? input.nextAttemptAt ?? null : null,
        next.updatedAt,
        next.completedAt ?? null,
        input.continuationId,
        input.expectedRevision,
        current.state,
        input.claimOwner,
        input.claimToken,
        input.now,
      );
      if (Number(update.changes) !== 1) return { ok: false, code: "stale_revision" };
      return { ok: true, value: this.getRunnerContinuation(input.continuationId)!, replayed: false };
    });
  }

  private classifyClaimFailure(input: ClaimRunnerContinuationInput): RunnerContinuationMutationResult {
    const current = this.getRunnerContinuation(input.continuationId);
    if (!current) return { ok: false, code: "not_found" };
    if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
    if (current.state !== "prepared") return { ok: false, code: "invalid_transition" };
    if (!this.currentTargetAttempt(current)) return { ok: false, code: "continuation.target_attempt_lost" };
    return { ok: false, code: "lease_not_claimable" };
  }

  private currentTargetAttempt(
    continuation: RunnerContinuationV1,
    expectedFence?: RuntimeAttemptFenceV1,
  ): WorkUnitAttempt | undefined {
    if (!continuation.targetAttemptId) return undefined;
    const workUnit = this.runtimeWorkUnits.getWorkUnit(continuation.workUnitId);
    const attempt = this.runtimeWorkUnits.getWorkUnitAttempt(continuation.targetAttemptId);
    if (!workUnit || !attempt || workUnit.activeAttemptId !== attempt.id || attempt.workUnitId !== workUnit.id) {
      return undefined;
    }
    if (expectedFence && !sameFence(toRuntimeAttemptFence(attempt), expectedFence)) return undefined;
    return attempt;
  }

  private matchesLease(
    continuation: RunnerContinuationV1,
    input: { readonly claimOwner: string; readonly claimToken: string },
  ): boolean {
    return continuation.claimOwner === input.claimOwner && continuation.claimToken === input.claimToken;
  }

  private transaction<T>(operation: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.context.database.exec("COMMIT;");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }
}

function validateClaimInput(input: ClaimRunnerContinuationInput): void {
  validateIdentity(input.continuationId, "continuation id");
  validateIdentity(input.claimOwner, "claim owner");
  validateIdentity(input.claimToken, "claim token");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("Runner continuation revision must be a non-negative safe integer.");
  }
  assertTimestamp(input.now);
  assertTimestamp(input.claimExpiresAt);
  if (input.claimExpiresAt <= input.now) throw new Error("Runner continuation claim must expire after now.");
}

function validateExecutionMutationInput(input: StartRunnerContinuationInput | FinishRunnerContinuationInput): void {
  validateIdentity(input.continuationId, "continuation id");
  validateIdentity(input.claimOwner, "claim owner");
  validateIdentity(input.claimToken, "claim token");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("Runner continuation revision must be a non-negative safe integer.");
  }
  for (const [value, label] of [
    [input.targetFence.workUnitId, "target work unit"],
    [input.targetFence.attemptId, "target attempt"],
    [input.targetFence.runtimeInstanceId, "target runtime instance"],
    [input.targetFence.fencingToken, "target fencing token"],
  ] as const) validateIdentity(value, label);
  assertTimestamp(input.now);
  if ("nextAttemptAt" in input) {
    if (input.nextAttemptAt) assertTimestamp(input.nextAttemptAt);
    if (input.nextAttemptAt && input.nextState !== "recovery_pending") {
      throw new Error("Only a recovery-pending continuation may schedule another attempt.");
    }
    if (!["failed", "recovery_pending"].includes(input.nextState)
      && (input.failureCode || input.failureDetailArtifactId)) {
      throw new Error("Only a failed or recovery-pending continuation may carry failure metadata.");
    }
  }
}

function validateIdentity(value: string, label: string): void {
  if (!value.trim() || value !== value.trim() || value.length > 1024) {
    throw new Error(`Invalid runner continuation ${label}.`);
  }
}

function assertTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Runner continuation timestamp must be canonical UTC: ${value}`);
  }
}

function sameFence(left: RuntimeAttemptFenceV1, right: RuntimeAttemptFenceV1): boolean {
  return left.workUnitId === right.workUnitId
    && left.attemptId === right.attemptId
    && left.runtimeInstanceId === right.runtimeInstanceId
    && left.fencingToken === right.fencingToken;
}
