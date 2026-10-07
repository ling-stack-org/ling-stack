import type { SQLOutputValue } from "node:sqlite";
import type {
  ApprovalRequest,
  HarnessToolExecutionV1,
  RunArtifact,
  RunnerContinuationV1,
} from "@ling-stack/contracts";
import {
  createHarnessToolExecutionId,
  digestHarnessToolValue,
  HarnessToolExecutionStoreError,
  type ClaimHarnessToolExecutionInput,
  type FailApprovedHarnessToolExecutionInput,
  type FinishHarnessToolExecutionInput,
  type HarnessToolExecutionMutationResult,
  type PrepareHarnessToolExecutionInput,
  type PreparedHarnessToolExecution,
  type ReconcileAbandonedHarnessToolExecutionsInput,
  type ReconciledHarnessToolExecutionOutcome,
  type ResolveHarnessToolApprovalInput,
  type StartHarnessToolExecutionInput,
} from "../../harness/tool-executions.js";
import { isHarnessLeaseClaimable } from "../../harness/common.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1, type WorkUnitAttempt } from "../../runtime-supervisor-types.js";
import type { RunSession } from "../../run-types.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import { rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import { harnessToolExecutionSelectSql, mapHarnessToolExecution } from "./harness-tool-execution-mappers.js";
import type { SqliteRuntimeWorkUnitStore } from "./runtime-work-unit-store.js";
import type { SqliteStoreContext } from "./store-context.js";

interface HarnessToolExecutionStorePorts {
  readonly getRun: (id: string) => RunSession | undefined;
  readonly getArtifact: (id: string) => RunArtifact | undefined;
  readonly getApprovalRequest: (id: string) => ApprovalRequest | undefined;
  readonly getRunnerContinuation: (id: string) => RunnerContinuationV1 | undefined;
}

/** Durable Tool Broker identity, Attempt fencing, leases, and evidence commit. */
export class SqliteHarnessToolExecutionStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly runtimeWorkUnits: SqliteRuntimeWorkUnitStore,
    private readonly ports: HarnessToolExecutionStorePorts,
  ) {}

  getHarnessToolExecution(id: string): HarnessToolExecutionV1 | undefined {
    const row = this.context.database.prepare(harnessToolExecutionSelectSql("WHERE execution.id = ?")).get(id);
    return row ? mapHarnessToolExecution(row as Record<string, SQLOutputValue>) : undefined;
  }

  findHarnessToolExecution(attemptId: string, toolCallId: string): HarnessToolExecutionV1 | undefined {
    const row = this.context.database
      .prepare(harnessToolExecutionSelectSql("WHERE execution.attempt_id = ? AND execution.tool_call_id = ?"))
      .get(attemptId, toolCallId);
    return row ? mapHarnessToolExecution(row as Record<string, SQLOutputValue>) : undefined;
  }

  listHarnessToolExecutions(runId: string): readonly HarnessToolExecutionV1[] {
    validateIdentity(runId, "run id");
    return this.context.database
      .prepare(`${harnessToolExecutionSelectSql("WHERE execution.run_id = ?")} ORDER BY execution.created_at ASC, execution.id ASC`)
      .all(runId)
      .map((row) => mapHarnessToolExecution(row as Record<string, SQLOutputValue>));
  }

  prepareHarnessToolExecution(input: PrepareHarnessToolExecutionInput): PreparedHarnessToolExecution {
    validatePrepareInput(input);
    return this.transaction(() => {
      const existing = this.findHarnessToolExecution(input.sourceFence.attemptId, input.toolCallId);
      if (existing) return this.replayPreparation(input, existing);
      const attempt = this.requireCurrentAttempt(input.runId, input.sourceFence, false);
      const run = this.ports.getRun(input.runId);
      if (!run || run.workUnitId !== input.workUnitId || attempt.workUnitId !== input.workUnitId) {
        throw new HarnessToolExecutionStoreError("tool.lineage_mismatch");
      }
      this.assertPolicySnapshot(input.policySnapshotArtifactId, input.runId);
      this.assertApproval(
        input.approvalId,
        input.approvalState,
        input.failureCode,
        input.runId,
        input.toolCallId,
      );
      if (input.continuationId) {
        const continuation = this.ports.getRunnerContinuation(input.continuationId);
        if (!continuation || continuation.runId !== input.runId || continuation.targetAttemptId !== input.sourceFence.attemptId) {
          throw new HarnessToolExecutionStoreError("tool.lineage_mismatch");
        }
      }
      if (input.supersedesExecutionId) {
        this.supersedePreEffectExecution(input);
      }
      const state = input.approvalState === "allowed"
        ? "approved"
        : input.approvalState === "approval_pending" ? "approval_pending" : "denied";
      const terminal = state === "denied";
      const execution: HarnessToolExecutionV1 = {
        schemaVersion: 1,
        id: input.id ?? createHarnessToolExecutionId(),
        runId: input.runId,
        workUnitId: input.workUnitId,
        attemptId: input.sourceFence.attemptId,
        continuationId: input.continuationId,
        delegationStepId: input.delegationStepId,
        supersedesExecutionId: input.supersedesExecutionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        executorKind: input.executorKind,
        state,
        requestDigest: input.requestDigest,
        sideEffectFingerprint: input.sideEffectFingerprint,
        policySnapshotArtifactId: input.policySnapshotArtifactId,
        approvalId: input.approvalId,
        sandboxProfileId: input.sandboxProfileId,
        executionFinishedAt: terminal ? input.now : undefined,
        resultSummary: input.resultSummary,
        evidenceArtifactIds: [],
        failureCode: input.failureCode,
        revision: 0,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.insert(execution);
      return { execution: this.getHarnessToolExecution(execution.id)!, replayed: false };
    });
  }

  resolveHarnessToolApproval(input: ResolveHarnessToolApprovalInput): HarnessToolExecutionMutationResult {
    validateResolveInput(input);
    return this.transaction(() => {
      const current = this.getHarnessToolExecution(input.executionId);
      if (!current) return { ok: false, code: "not_found" };
      const approval = this.ports.getApprovalRequest(input.approvalId);
      if (!approval || approval.id !== current.approvalId || approval.runId !== current.runId
        || approval.toolCallId !== current.toolCallId || !approvalStatusMatches(approval.status, input.nextState)) {
        return { ok: false, code: "invalid_transition" };
      }
      if (current.state === input.nextState) {
        return { ok: true, value: current, replayed: true };
      }
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      if (current.state !== "approval_pending") return { ok: false, code: "invalid_transition" };
      if (!this.isCurrentExecution(current, false)) return { ok: false, code: "tool.stale_attempt" };
      const terminal = input.nextState !== "approved";
      const updated = this.context.database.prepare(`
        UPDATE harness_tool_executions
        SET state = ?, revision = revision + 1, failure_code = ?, result_summary_json = ?,
            execution_finished_at = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'approval_pending' AND approval_id = ?
      `).run(
        input.nextState,
        input.failureCode ?? null,
        input.resultSummary ? boundedJson(input.resultSummary, "approval result summary") : null,
        terminal ? input.now : null,
        input.now,
        input.executionId,
        input.expectedRevision,
        input.approvalId,
      );
      if (Number(updated.changes) !== 1) return { ok: false, code: "stale_revision" };
      return { ok: true, value: this.getHarnessToolExecution(input.executionId)!, replayed: false };
    });
  }

  claimHarnessToolExecution(input: ClaimHarnessToolExecutionInput): HarnessToolExecutionMutationResult {
    validateClaimInput(input);
    return this.transaction(() => {
      const current = this.getHarnessToolExecution(input.executionId);
      if (!current) return { ok: false, code: "not_found" };
      if (!this.matchesStoredFence(current, input.sourceFence) || !this.isCurrentExecution(current, false)) {
        return { ok: false, code: "tool.stale_attempt" };
      }
      if (current.state === "claimed" && this.matchesLease(current, input)
        && current.claimExpiresAt && current.claimExpiresAt > input.now) {
        return { ok: true, value: current, replayed: true };
      }
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      const reclaimExpiredClaim = current.state === "claimed"
        && Boolean(current.claimExpiresAt && current.claimExpiresAt <= input.now);
      if (current.state !== "approved" && !reclaimExpiredClaim) return { ok: false, code: "invalid_transition" };
      if (!isHarnessLeaseClaimable({ ...current, now: input.now })) return { ok: false, code: "lease_not_claimable" };
      const updated = this.context.database.prepare(`
        UPDATE harness_tool_executions
        SET state = 'claimed', revision = revision + 1, claim_owner = ?, claim_token = ?,
            claim_expires_at = ?, next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND revision = ? AND state IN ('approved', 'claimed')
          AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
      `).run(input.claimOwner, input.claimToken, input.claimExpiresAt, input.now,
        input.executionId, input.expectedRevision, input.now);
      if (Number(updated.changes) !== 1) return this.classifyClaimFailure(input);
      return { ok: true, value: this.getHarnessToolExecution(input.executionId)!, replayed: false };
    });
  }

  startHarnessToolExecution(input: StartHarnessToolExecutionInput): HarnessToolExecutionMutationResult {
    validateExecutionMutationInput(input);
    return this.transaction(() => {
      const current = this.getHarnessToolExecution(input.executionId);
      if (!current) return { ok: false, code: "not_found" };
      if (!this.matchesStoredFence(current, input.sourceFence) || !this.isCurrentExecution(current, false)) {
        return { ok: false, code: "tool.stale_attempt" };
      }
      if (!this.matchesLease(current, input) || !current.claimExpiresAt || current.claimExpiresAt <= input.now) {
        return { ok: false, code: "lease_mismatch" };
      }
      if (current.state === "executing") return { ok: true, value: current, replayed: true };
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      if (current.state !== "claimed") return { ok: false, code: "invalid_transition" };
      const updated = this.context.database.prepare(`
        UPDATE harness_tool_executions
        SET state = 'executing', revision = revision + 1, execution_started_at = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'claimed'
          AND claim_owner = ? AND claim_token = ? AND claim_expires_at > ?
      `).run(input.now, input.now, input.executionId, input.expectedRevision,
        input.claimOwner, input.claimToken, input.now);
      if (Number(updated.changes) !== 1) return { ok: false, code: "stale_revision" };
      return { ok: true, value: this.getHarnessToolExecution(input.executionId)!, replayed: false };
    });
  }

  finishHarnessToolExecution(input: FinishHarnessToolExecutionInput): HarnessToolExecutionMutationResult {
    validateFinishInput(input);
    return this.transaction(() => {
      const current = this.getHarnessToolExecution(input.executionId);
      if (!current) return { ok: false, code: "not_found" };
      if (isSameTerminalOutcome(current, input)) {
        return { ok: true, value: current, replayed: true };
      }
      if (!this.matchesStoredFence(current, input.sourceFence) || !this.isCurrentExecution(current, true)) {
        return { ok: false, code: "tool.stale_attempt" };
      }
      if (!this.matchesLease(current, input)) return { ok: false, code: "lease_mismatch" };
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      if (current.state !== "executing") return { ok: false, code: "invalid_transition" };
      const artifacts = uniqueEvidenceIds(input.evidenceArtifactIds);
      if (artifacts.length !== input.evidenceArtifactIds.length
        || artifacts.some((id) => this.ports.getArtifact(id)?.runId !== current.runId)) {
        return { ok: false, code: "tool.evidence_invalid" };
      }
      const summaryJson = boundedJson(input.resultSummary, "tool result summary");
      const committing = this.context.database.prepare(`
        UPDATE harness_tool_executions
        SET state = 'committing_evidence', revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'executing'
          AND claim_owner = ? AND claim_token = ?
      `).run(input.now, input.executionId, input.expectedRevision, input.claimOwner, input.claimToken);
      if (Number(committing.changes) !== 1) return { ok: false, code: "stale_revision" };
      const insertArtifact = this.context.database.prepare(`
        INSERT INTO harness_tool_execution_artifacts (execution_id, artifact_id, ordinal)
        VALUES (?, ?, ?)
      `);
      artifacts.forEach((artifactId, ordinal) => insertArtifact.run(input.executionId, artifactId, ordinal));
      const terminal = this.context.database.prepare(`
        UPDATE harness_tool_executions
        SET state = ?, revision = revision + 1, result_digest = ?, result_summary_json = ?,
            failure_code = ?, execution_finished_at = ?, updated_at = ?, next_attempt_at = NULL
        WHERE id = ? AND revision = ? AND state = 'committing_evidence'
          AND claim_owner = ? AND claim_token = ?
      `).run(input.nextState, input.resultDigest, summaryJson, input.failureCode ?? null,
        input.now, input.now, input.executionId, input.expectedRevision + 1, input.claimOwner, input.claimToken);
      if (Number(terminal.changes) !== 1) {
        throw new Error("Harness tool evidence terminal commit lost its transaction-local CAS.");
      }
      return { ok: true, value: this.getHarnessToolExecution(input.executionId)!, replayed: false };
    });
  }

  failApprovedHarnessToolExecution(input: FailApprovedHarnessToolExecutionInput): HarnessToolExecutionMutationResult {
    validateFailApprovedInput(input);
    return this.transaction(() => {
      const current = this.getHarnessToolExecution(input.executionId);
      if (!current) return { ok: false, code: "not_found" };
      if (current.state === input.nextState && current.failureCode === input.failureCode) {
        return { ok: true, value: current, replayed: true };
      }
      if (!this.matchesStoredFence(current, input.sourceFence)) return { ok: false, code: "tool.stale_attempt" };
      if (input.nextState !== "superseded" && !this.isCurrentExecution(current, true)) {
        return { ok: false, code: "tool.stale_attempt" };
      }
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      if (current.state !== "approved") return { ok: false, code: "invalid_transition" };
      const updated = this.context.database.prepare(`
        UPDATE harness_tool_executions
        SET state = ?, revision = revision + 1, failure_code = ?, result_summary_json = ?,
            execution_finished_at = ?, updated_at = ?, next_attempt_at = NULL
        WHERE id = ? AND revision = ? AND state = 'approved'
      `).run(input.nextState, input.failureCode,
        input.resultSummary ? boundedJson(input.resultSummary, "tool failure summary") : null,
        input.now, input.now, input.executionId, input.expectedRevision);
      if (Number(updated.changes) !== 1) return { ok: false, code: "stale_revision" };
      return { ok: true, value: this.getHarnessToolExecution(input.executionId)!, replayed: false };
    });
  }

  reconcileAbandonedHarnessToolExecutions(
    input: ReconcileAbandonedHarnessToolExecutionsInput,
  ): readonly HarnessToolExecutionV1[] {
    validateReconcileInput(input);
    const limit = input.limit ?? 100;
    const rows = this.context.database.prepare(`
      SELECT id FROM harness_tool_executions
      WHERE state IN ('executing', 'committing_evidence')
        AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?
      ORDER BY claim_expires_at ASC, id ASC LIMIT ?
    `).all(input.now, limit) as Array<{ readonly id: string }>;
    const updated: HarnessToolExecutionV1[] = [];
    for (const row of rows) {
      const current = this.getHarnessToolExecution(row.id);
      if (!current) continue;
      let classified: ReconciledHarnessToolExecutionOutcome | undefined;
      try {
        classified = input.classify?.(current);
      } catch {
        classified = undefined;
      }
      const outcome = classified ?? defaultUnknownReconciliation(current);
      const recovered = this.reconcileExpiredExecution(current, outcome, input.now);
      if (recovered) updated.push(recovered);
    }
    return updated;
  }

  private reconcileExpiredExecution(
    current: HarnessToolExecutionV1,
    outcome: ReconciledHarnessToolExecutionOutcome,
    now: string,
  ): HarnessToolExecutionV1 | undefined {
    return this.transaction(() => {
      const artifacts = uniqueEvidenceIds(outcome.evidenceArtifactIds);
      if (artifacts.length !== outcome.evidenceArtifactIds.length
        || artifacts.some((id) => this.ports.getArtifact(id)?.runId !== current.runId)) {
        throw new HarnessToolExecutionStoreError("tool.invalid_input");
      }
      validateReconciledOutcome(outcome);
      const result = this.context.database.prepare(`
        UPDATE harness_tool_executions
        SET state = ?, revision = revision + 1, result_digest = ?, result_summary_json = ?,
            failure_code = ?, execution_finished_at = ?, updated_at = ?, next_attempt_at = NULL
        WHERE id = ? AND revision = ? AND state IN ('executing', 'committing_evidence')
          AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?
      `).run(
        outcome.nextState,
        outcome.resultDigest,
        boundedJson(outcome.resultSummary, "reconciliation summary"),
        outcome.failureCode ?? null,
        now,
        now,
        current.id,
        current.revision,
        now,
      );
      if (Number(result.changes) !== 1) return undefined;
      const insertArtifact = this.context.database.prepare(`
        INSERT OR IGNORE INTO harness_tool_execution_artifacts (execution_id, artifact_id, ordinal)
        VALUES (?, ?, ?)
      `);
      artifacts.forEach((artifactId, ordinal) => insertArtifact.run(current.id, artifactId, ordinal));
      return this.getHarnessToolExecution(current.id)!;
    });
  }

  private insert(execution: HarnessToolExecutionV1): void {
    this.context.database.prepare(`
      INSERT INTO harness_tool_executions (
        id, schema_version, run_id, work_unit_id, attempt_id, continuation_id,
        delegation_step_id, supersedes_execution_id, tool_call_id, tool_name, executor_kind, state,
        request_digest, side_effect_fingerprint, policy_snapshot_artifact_id, approval_id,
        sandbox_profile_id, claim_owner, claim_token, claim_expires_at, next_attempt_at,
        execution_started_at, execution_finished_at, result_digest, result_summary_json,
        failure_code, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      execution.id, execution.schemaVersion, execution.runId, execution.workUnitId, execution.attemptId,
      execution.continuationId ?? null, execution.delegationStepId ?? null, execution.supersedesExecutionId ?? null,
      execution.toolCallId,
      execution.toolName, execution.executorKind, execution.state, execution.requestDigest,
      execution.sideEffectFingerprint, execution.policySnapshotArtifactId, execution.approvalId ?? null,
      execution.sandboxProfileId, execution.claimOwner ?? null, execution.claimToken ?? null,
      execution.claimExpiresAt ?? null, execution.nextAttemptAt ?? null, execution.executionStartedAt ?? null,
      execution.executionFinishedAt ?? null, execution.resultDigest ?? null,
      execution.resultSummary ? boundedJson(execution.resultSummary, "tool result summary") : null,
      execution.failureCode ?? null, execution.revision, execution.createdAt, execution.updatedAt,
    );
  }

  private replayPreparation(
    input: PrepareHarnessToolExecutionInput,
    existing: HarnessToolExecutionV1,
  ): PreparedHarnessToolExecution {
    const expectedState = input.approvalState === "allowed"
      ? "approved"
      : input.approvalState === "approval_pending" ? "approval_pending" : "denied";
    if (existing.runId !== input.runId || existing.workUnitId !== input.workUnitId
      || existing.attemptId !== input.sourceFence.attemptId || existing.continuationId !== input.continuationId
      || existing.delegationStepId !== input.delegationStepId
      || existing.supersedesExecutionId !== input.supersedesExecutionId || existing.toolName !== input.toolName
      || existing.executorKind !== input.executorKind || existing.requestDigest !== input.requestDigest
      || existing.sideEffectFingerprint !== input.sideEffectFingerprint
      || existing.policySnapshotArtifactId !== input.policySnapshotArtifactId
      || existing.approvalId !== input.approvalId || existing.sandboxProfileId !== input.sandboxProfileId
      || existing.state !== expectedState || existing.failureCode !== input.failureCode
      || stringifyJson(existing.resultSummary) !== stringifyJson(input.resultSummary)) {
      throw new HarnessToolExecutionStoreError("tool.idempotency_conflict");
    }
    return { execution: existing, replayed: true };
  }

  private supersedePreEffectExecution(input: PrepareHarnessToolExecutionInput): void {
    const prior = this.getHarnessToolExecution(input.supersedesExecutionId!);
    if (!prior
      || prior.runId !== input.runId
      || prior.workUnitId !== input.workUnitId
      || prior.attemptId === input.sourceFence.attemptId
      || prior.toolCallId !== input.toolCallId
      || prior.approvalId !== input.approvalId
      || prior.sideEffectFingerprint !== input.sideEffectFingerprint
      || !["approval_pending", "approved"].includes(prior.state)) {
      throw new HarnessToolExecutionStoreError("tool.lineage_mismatch");
    }
    const updated = this.context.database.prepare(`
      UPDATE harness_tool_executions
      SET state = 'superseded', revision = revision + 1,
          failure_code = 'tool.stale_attempt',
          result_summary_json = ?, execution_finished_at = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND state IN ('approval_pending', 'approved')
    `).run(
      boundedJson({ reason: "approval_recovered_on_successor_attempt", successorAttemptId: input.sourceFence.attemptId },
        "supersession summary"),
      input.now,
      input.now,
      prior.id,
      prior.revision,
    );
    if (Number(updated.changes) !== 1) {
      throw new HarnessToolExecutionStoreError("tool.lineage_mismatch");
    }
  }

  private requireCurrentAttempt(runId: string, fence: RuntimeAttemptFenceV1, allowCleanup: boolean): WorkUnitAttempt {
    const attempt = this.runtimeWorkUnits.getWorkUnitAttempt(fence.attemptId);
    if (!attempt || !sameFence(toRuntimeAttemptFence(attempt), fence)
      || !isCurrentRunExecutionOwner(this.context, runId, fence, allowCleanup)) {
      throw new HarnessToolExecutionStoreError("tool.lineage_mismatch");
    }
    return attempt;
  }

  private isCurrentExecution(execution: HarnessToolExecutionV1, allowCleanup: boolean): boolean {
    const attempt = this.runtimeWorkUnits.getWorkUnitAttempt(execution.attemptId);
    return Boolean(attempt && isCurrentRunExecutionOwner(
      this.context,
      execution.runId,
      toRuntimeAttemptFence(attempt),
      allowCleanup,
    ));
  }

  private matchesStoredFence(execution: HarnessToolExecutionV1, fence: RuntimeAttemptFenceV1): boolean {
    const attempt = this.runtimeWorkUnits.getWorkUnitAttempt(execution.attemptId);
    return Boolean(attempt && sameFence(toRuntimeAttemptFence(attempt), fence)
      && execution.workUnitId === fence.workUnitId && execution.attemptId === fence.attemptId);
  }

  private matchesLease(
    execution: HarnessToolExecutionV1,
    input: { readonly claimOwner: string; readonly claimToken: string },
  ): boolean {
    return execution.claimOwner === input.claimOwner && execution.claimToken === input.claimToken;
  }

  private classifyClaimFailure(input: ClaimHarnessToolExecutionInput): HarnessToolExecutionMutationResult {
    const current = this.getHarnessToolExecution(input.executionId);
    if (!current) return { ok: false, code: "not_found" };
    if (!this.matchesStoredFence(current, input.sourceFence) || !this.isCurrentExecution(current, false)) {
      return { ok: false, code: "tool.stale_attempt" };
    }
    if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
    if (current.state !== "approved" && current.state !== "claimed") return { ok: false, code: "invalid_transition" };
    return { ok: false, code: "lease_not_claimable" };
  }

  private assertPolicySnapshot(artifactId: string, runId: string): void {
    if (this.ports.getArtifact(artifactId)?.runId !== runId) {
      throw new HarnessToolExecutionStoreError("tool.policy_snapshot_missing");
    }
  }

  private assertApproval(
    approvalId: string | undefined,
    approvalState: PrepareHarnessToolExecutionInput["approvalState"],
    failureCode: PrepareHarnessToolExecutionInput["failureCode"],
    runId: string,
    toolCallId: string,
  ): void {
    if (!approvalId) {
      if (approvalState !== "allowed"
        && !(approvalState === "denied" && failureCode === "tool.policy_denied")) {
        throw new HarnessToolExecutionStoreError("tool.approval_invalid");
      }
      return;
    }
    const approval = this.ports.getApprovalRequest(approvalId);
    if (!approval || approval.runId !== runId || approval.toolCallId !== toolCallId
      || (approvalState === "approval_pending" && approval.status !== "pending")
      || (approvalState === "denied" && !["denied", "expired", "cancelled"].includes(approval.status))
      || (approvalState === "allowed" && approval.status !== "approved")) {
      throw new HarnessToolExecutionStoreError("tool.approval_invalid");
    }
  }

  private transaction<T>(operation: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const value = operation();
      this.context.database.exec("COMMIT;");
      return value;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }
}

function validatePrepareInput(input: PrepareHarnessToolExecutionInput): void {
  for (const [value, label] of [
    [input.runId, "run id"], [input.workUnitId, "work unit id"],
    [input.sourceFence.attemptId, "attempt id"], [input.sourceFence.runtimeInstanceId, "runtime instance id"],
    [input.sourceFence.fencingToken, "fencing token"], [input.toolCallId, "tool call id"],
    [input.toolName, "tool name"], [input.policySnapshotArtifactId, "policy snapshot artifact id"],
    [input.sandboxProfileId, "sandbox profile id"],
  ] as const) validateIdentity(value, label);
  if (input.supersedesExecutionId) validateIdentity(input.supersedesExecutionId, "superseded execution id");
  if (input.sourceFence.workUnitId !== input.workUnitId) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  validateDigest(input.requestDigest, "request digest");
  validateDigest(input.sideEffectFingerprint, "side-effect fingerprint");
  assertTimestamp(input.now);
  if (input.approvalState === "denied" && !input.failureCode) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  if (input.approvalState !== "denied" && input.failureCode) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  if (input.resultSummary) boundedJson(input.resultSummary, "tool result summary");
}

function validateResolveInput(input: ResolveHarnessToolApprovalInput): void {
  validateIdentity(input.executionId, "execution id");
  validateIdentity(input.approvalId, "approval id");
  validateRevision(input.expectedRevision);
  assertTimestamp(input.now);
  if (input.nextState === "denied" && input.failureCode !== "tool.approval_denied") {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  if (input.nextState === "cancelled" && input.failureCode !== "tool.execution_cancelled") {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  if (input.nextState === "approved" && input.failureCode) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  if (input.resultSummary) boundedJson(input.resultSummary, "approval result summary");
}

function validateClaimInput(input: ClaimHarnessToolExecutionInput): void {
  validateExecutionIdentity(input);
  validateIdentity(input.claimOwner, "claim owner");
  validateIdentity(input.claimToken, "claim token");
  assertTimestamp(input.claimExpiresAt);
  if (input.claimExpiresAt <= input.now) throw new HarnessToolExecutionStoreError("tool.invalid_input");
}

function validateExecutionMutationInput(input: StartHarnessToolExecutionInput): void {
  validateExecutionIdentity(input);
  validateIdentity(input.claimOwner, "claim owner");
  validateIdentity(input.claimToken, "claim token");
}

function validateFinishInput(input: FinishHarnessToolExecutionInput): void {
  validateExecutionIdentity(input);
  validateIdentity(input.claimOwner, "claim owner");
  validateIdentity(input.claimToken, "claim token");
  validateDigest(input.resultDigest, "result digest");
  boundedJson(input.resultSummary, "tool result summary");
  if (input.evidenceArtifactIds.length > 256) throw new HarnessToolExecutionStoreError("tool.invalid_input");
  input.evidenceArtifactIds.forEach((id) => validateIdentity(id, "evidence artifact id"));
  if (input.nextState === "succeeded" && input.failureCode) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  if (input.nextState !== "succeeded" && !input.failureCode) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
}

function validateFailApprovedInput(input: FailApprovedHarnessToolExecutionInput): void {
  validateExecutionIdentity(input);
  if (input.nextState === "superseded" && input.failureCode !== "tool.stale_attempt") {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  if (input.resultSummary) boundedJson(input.resultSummary, "tool failure summary");
}

function validateReconcileInput(input: ReconcileAbandonedHarnessToolExecutionsInput): void {
  assertTimestamp(input.now);
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
}

function validateExecutionIdentity(input: {
  readonly executionId: string;
  readonly expectedRevision: number;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly now: string;
}): void {
  validateIdentity(input.executionId, "execution id");
  validateRevision(input.expectedRevision);
  for (const [value, label] of [
    [input.sourceFence.workUnitId, "source work unit"], [input.sourceFence.attemptId, "source attempt"],
    [input.sourceFence.runtimeInstanceId, "source runtime instance"], [input.sourceFence.fencingToken, "source fencing token"],
  ] as const) validateIdentity(value, label);
  assertTimestamp(input.now);
}

function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new HarnessToolExecutionStoreError("tool.invalid_input");
}

function validateIdentity(value: string, label: string): void {
  if (!value.trim() || value !== value.trim() || value.length > 1024) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  void label;
}

function validateDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    void label;
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
}

function assertTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
}

function boundedJson(value: Readonly<Record<string, unknown>>, label: string): string {
  let serialized: string;
  try {
    serialized = stringifyJson(value);
  } catch {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 32 * 1024) {
    void label;
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  return serialized;
}

function uniqueEvidenceIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function defaultUnknownReconciliation(execution: HarnessToolExecutionV1): ReconciledHarnessToolExecutionOutcome {
  const resultSummary = {
    status: "unknown_outcome",
    reason: "claim_expired_after_possible_side_effect",
    executorKind: execution.executorKind,
  };
  return {
    nextState: "unknown_outcome",
    resultDigest: digestHarnessToolValue(resultSummary),
    resultSummary,
    evidenceArtifactIds: [],
    failureCode: "tool.unknown_side_effect_outcome",
  };
}

function validateReconciledOutcome(outcome: ReconciledHarnessToolExecutionOutcome): void {
  validateDigest(outcome.resultDigest, "reconciliation result digest");
  boundedJson(outcome.resultSummary, "reconciliation result summary");
  if (outcome.evidenceArtifactIds.length > 256) throw new HarnessToolExecutionStoreError("tool.invalid_input");
  outcome.evidenceArtifactIds.forEach((id) => validateIdentity(id, "reconciliation evidence artifact id"));
  if (outcome.nextState === "succeeded" && outcome.failureCode) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
  if (outcome.nextState !== "succeeded" && !outcome.failureCode) {
    throw new HarnessToolExecutionStoreError("tool.invalid_input");
  }
}

function approvalStatusMatches(status: ApprovalRequest["status"], state: ResolveHarnessToolApprovalInput["nextState"]): boolean {
  if (state === "approved") return status === "approved";
  if (state === "denied") return status === "denied";
  return status === "cancelled" || status === "expired";
}

function isSameTerminalOutcome(current: HarnessToolExecutionV1, input: FinishHarnessToolExecutionInput): boolean {
  return current.state === input.nextState
    && current.claimOwner === input.claimOwner
    && current.claimToken === input.claimToken
    && current.resultDigest === input.resultDigest
    && current.failureCode === input.failureCode
    && stringifyJson(current.resultSummary) === stringifyJson(input.resultSummary)
    && stringifyJson(current.evidenceArtifactIds) === stringifyJson(input.evidenceArtifactIds);
}

function sameFence(left: RuntimeAttemptFenceV1, right: RuntimeAttemptFenceV1): boolean {
  return left.workUnitId === right.workUnitId
    && left.attemptId === right.attemptId
    && left.runtimeInstanceId === right.runtimeInstanceId
    && left.fencingToken === right.fencingToken;
}
