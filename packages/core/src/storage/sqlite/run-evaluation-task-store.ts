import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type {
  RunEvaluationArtifactPinV1,
  RunEvaluationFrozenGraderV1,
  RunEvaluationTaskV1,
  RunEvaluationV1,
} from "@ling-stack/contracts";
import { RunEvaluationInputError, digestRunEvaluationValue } from "../../harness/evaluation-json.js";
import { runEvaluationIdempotencyKey } from "../../harness/evaluations.js";
import {
  createRunEvaluationTaskId,
  createRunEvaluationTaskAttemptId,
  createRunEvaluationTaskInvocationId,
  createRunEvaluationTaskResultId,
  runEvaluationTaskIdempotencyKey,
  type RunEvaluationTaskStore,
  type EnqueueRunEvaluationTaskInput,
  type ClaimRunEvaluationTaskInput,
  type ListClaimableRunEvaluationTasksInput,
  type RunEvaluationTaskFence,
  type RenewRunEvaluationTaskLeaseInput,
  type AdmitRunEvaluationTaskDispatchInput,
  type CompleteRunEvaluationTaskInput,
  type FinishRunEvaluationTaskBeforeDispatchInput,
  type ReconcileExpiredRunEvaluationTaskAttemptInput,
  type ReconcileExpiredRunEvaluationTaskAttemptsPageInput,
  type RunEvaluationTaskMutationResult,
  type RunEvaluationTaskMutationCode,
  type RunEvaluationTaskClaim,
  type RunEvaluationTaskAdmission,
  type RunEvaluationTaskSettlement,
  type RunEvaluationTaskRecoveryPage,
  type RunEvaluationTaskResultInput,
} from "../../harness/evaluation-tasks.js";
import type { RunArtifact, RunSession } from "../../run-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { mapRunEvaluationTask, mapRunEvaluationTaskAttempt, mapRunEvaluationTaskResult } from "./run-evaluation-task-mappers.js";
import { taskIdentity, taskLimit, validateTaskInput, validateTaskFrozen, validateTaskArtifactJson, TASK_RESULT_FIELDS } from "./run-evaluation-task-validation.js";
import type { SqliteStoreContext } from "./store-context.js";
import { harnessArtifactOwnerHolder, syncHarnessArtifactOwnerPins } from "./harness-artifact-recovery-pins.js";
type Row = Record<string, SQLOutputValue>;
interface Ports {
  readonly getRun: (id: string) => RunSession | undefined;
  readonly getRunEvaluation: (id: string) => RunEvaluationV1 | undefined;
  readonly getArtifact: (id: string) => RunArtifact | undefined;
  readonly isQaTask?: (id: string) => boolean;
  readonly onDispatchUnknownWithinTransaction?: (attemptId: string, now: string) => void;
}
export class EvidenceError extends Error {
  constructor(readonly code: RunEvaluationTaskMutationCode) {
    super(code);
  }
}

/** Model-task integrity and recovery only. No Provider, Run mutation, quota or promotion authority. */
export class SqliteRunEvaluationTaskStore implements RunEvaluationTaskStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports) {}
  getRunEvaluationTask(id: string) {
    taskIdentity(id);
    const row = this.context.database.prepare("SELECT * FROM run_evaluation_tasks WHERE id=?").get(id);
    return row ? mapRunEvaluationTask(row as Row) : undefined;
  }
  getRunEvaluationTaskAttempt(id: string) {
    taskIdentity(id);
    const row = this.context.database.prepare("SELECT * FROM run_evaluation_task_attempts WHERE id=?").get(id);
    return row ? mapRunEvaluationTaskAttempt(row as Row) : undefined;
  }
  getRunEvaluationTaskResult(taskId: string) {
    taskIdentity(taskId);
    const row = this.context.database.prepare("SELECT * FROM run_evaluation_task_results WHERE task_id=?").get(taskId);
    return row ? mapRunEvaluationTaskResult(row as Row) : undefined;
  }
  enqueueRunEvaluationTask(input: EnqueueRunEvaluationTaskInput): RunEvaluationTaskMutationResult<RunEvaluationTaskV1> {
    validateTaskInput(input, "enqueue");
    return this.mutate(() => this.enqueueWithinTransaction(input));
  }
  /** Internal coordinator seam, never exposed through RunStore. Caller owns transaction. */
  enqueueWithinTransaction(input: EnqueueRunEvaluationTaskInput): RunEvaluationTaskMutationResult<RunEvaluationTaskV1> {
    validateTaskInput(input, "enqueue");
      const evaluation = this.evaluation(input.evaluationId, input.evaluationKey);
      const frozen = this.frozen(input.frozenGraderArtifact, input.frozenGraderDigest, evaluation);
      const identity = {
        evaluationId: input.evaluationId,
        evaluationKey: input.evaluationKey,
        frozenGraderArtifact: input.frozenGraderArtifact,
        frozenGraderDigest: input.frozenGraderDigest,
        repeatOrdinal: input.repeatOrdinal
      };
      const key = runEvaluationTaskIdempotencyKey(identity);
      const row = this.context.database.prepare("SELECT * FROM run_evaluation_tasks WHERE evaluation_id=? AND frozen_digest=? AND repeat_ordinal=?").get(input.evaluationId, input.frozenGraderDigest, input.repeatOrdinal);
      if (row) {
        const task = mapRunEvaluationTask(row as Row);
        if (task.idempotencyKey !== key) return fail("identity_conflict");
        this.syncRecoveryPins(task, input.now);
        return ok(task, true);
      }
      const id = createRunEvaluationTaskId();
      this.context.database.prepare("INSERT INTO run_evaluation_tasks(id,schema_version,evaluation_id,evaluation_key,grader_type,frozen_json,frozen_artifact_id,frozen_artifact_sha,frozen_digest,repeat_ordinal,idempotency_key,state,revision,created_at,updated_at) VALUES(?,1,?,?,'model',?,?,?,?,?,?,'queued',0,?,?)").run(id, evaluation.id, evaluation.idempotencyKey, JSON.stringify(frozen), input.frozenGraderArtifact.artifactId, input.frozenGraderArtifact.contentSha256, input.frozenGraderDigest, input.repeatOrdinal, key, input.now, input.now);
      this.syncRecoveryPins(this.getRunEvaluationTask(id)!, input.now);
      return ok(this.getRunEvaluationTask(id)!);
  }
  listClaimableRunEvaluationTasks(input: ListClaimableRunEvaluationTasksInput) {
    validateTaskInput(input, "list");
    return this.context.database.prepare("SELECT * FROM run_evaluation_tasks WHERE state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY COALESCE(next_attempt_at,created_at),created_at,id LIMIT ?").all(input.now, taskLimit(input.limit)).map(row => mapRunEvaluationTask(row as Row));
  }
  claimRunEvaluationTask(input: ClaimRunEvaluationTaskInput): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim> {
    validateTaskInput(input, "claim");
    return this.mutate(() => {
      const task = this.getRunEvaluationTask(input.taskId);
      if (!task) return fail("not_found");
      const replay = this.context.database.prepare("SELECT * FROM run_evaluation_task_attempts WHERE task_id=? AND claim_token=?").get(task.id, input.claimToken);
      if (replay) {
        const attempt = mapRunEvaluationTaskAttempt(replay as Row);
        return task.activeAttemptId === attempt.id && task.state === "active" && attempt.state === "claimed" && attempt.claimOwner === input.claimOwner && attempt.claimExpiresAt === input.claimExpiresAt && attempt.claimExpiresAt > input.now && (input.expectedTaskRevision === task.revision || input.expectedTaskRevision + 1 === task.revision) ? ok({
          task,
          attempt
        }, true) : fail("identity_conflict");
      }
      if (task.revision !== input.expectedTaskRevision) return fail("stale_revision");
      if (task.state !== "queued") return fail("invalid_transition");
      if (task.nextAttemptAt && task.nextAttemptAt > input.now) return fail("lease_not_claimable");
      this.validateTask(task);
      this.syncRecoveryPins(task, input.now);
      const count = this.context.database.prepare("SELECT COALESCE(MAX(attempt_number),0) AS n FROM run_evaluation_task_attempts WHERE task_id=?").get(task.id)!.n as number;
      const id = createRunEvaluationTaskAttemptId();
      this.context.database.prepare("INSERT INTO run_evaluation_task_attempts(id,schema_version,task_id,attempt_number,state,claim_owner,claim_token,claim_expires_at,revision,claimed_at,updated_at) VALUES(?,1,?,?,'claimed',?,?,?,0,?,?)").run(id, task.id, count + 1, input.claimOwner, input.claimToken, input.claimExpiresAt, input.now, input.now);
      const changed = this.context.database.prepare("UPDATE run_evaluation_tasks SET state='active',active_attempt_id=?,next_attempt_at=NULL,failure_code=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=?)").run(id, input.now, task.id, input.expectedTaskRevision, input.now);
      this.changed(changed.changes);
      return ok(this.pair(task.id, id));
    });
  }
  renewRunEvaluationTaskLease(input: RenewRunEvaluationTaskLeaseInput): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim> {
    validateTaskInput(input, "renew");
    return this.mutate(() => {
      const pair = this.fence(input);
      if (!pair.ok) return pair;
      if (input.claimExpiresAt < pair.value.attempt.claimExpiresAt) return fail("lease_mismatch");
      this.updatePair(pair.value, input, "claim_expires_at=?,updated_at=?", [input.claimExpiresAt, input.now], "updated_at=?", [input.now]);
      return ok(this.pair(input.taskId, input.attemptId));
    });
  }
  admitRunEvaluationTaskDispatch(input: AdmitRunEvaluationTaskDispatchInput): RunEvaluationTaskMutationResult<RunEvaluationTaskAdmission> {
    validateTaskInput(input, "admit");
    return this.mutate(() => this.ports.isQaTask?.(input.taskId) ? fail("invalid_transition") : this.admitWithinTransaction(input));
  }
  /** Internal QA coordinator seam: quota reservation and task admission share one transaction. */
  admitWithinTransaction(input: AdmitRunEvaluationTaskDispatchInput): RunEvaluationTaskMutationResult<RunEvaluationTaskAdmission> {
    validateTaskInput(input, "admit");
      const pair = this.fence(input, true);
      if (!pair.ok) return pair;
      this.validateTask(pair.value.task);
      this.syncRecoveryPins(pair.value.task, input.now);
      if (pair.value.attempt.state === "dispatch_admitted") return pair.value.attempt.requestDigest === input.requestDigest && pair.value.attempt.executionScopeDigest === input.executionScopeDigest ? ok({
        ...pair.value,
        mayDispatch: false
      }, true) : fail("identity_conflict");
      if (pair.value.attempt.state !== "claimed") return fail("invalid_transition");
      this.updatePair(pair.value, input, "state='dispatch_admitted',invocation_id=?,request_digest=?,scope_digest=?,admitted_at=?,updated_at=?", [createRunEvaluationTaskInvocationId(), input.requestDigest, input.executionScopeDigest, input.now, input.now], "updated_at=?", [input.now]);
      return ok({
        ...this.pair(input.taskId, input.attemptId),
        mayDispatch: true
      });
  }
  completeRunEvaluationTask(input: CompleteRunEvaluationTaskInput): RunEvaluationTaskMutationResult<RunEvaluationTaskSettlement> {
    validateTaskInput(input, "complete");
    return this.mutate(() => this.ports.isQaTask?.(input.taskId) ? fail("invalid_transition") : this.completeWithinTransaction(input));
  }
  /** Internal QA coordinator seam: result, usage receipt and task settlement share one transaction. */
  completeWithinTransaction(input: CompleteRunEvaluationTaskInput): RunEvaluationTaskMutationResult<RunEvaluationTaskSettlement> {
    validateTaskInput(input, "complete");
      const pair = this.fence(input, true, true);
      if (!pair.ok) return pair;
      const {
        task,
        attempt
      } = pair.value;
      const evaluation = this.validateTask(task);
      this.artifact(input.result.rawOutputArtifact, evaluation);
      if (input.result.rationaleArtifact) this.artifact(input.result.rationaleArtifact, evaluation);
      const body = this.resultBody(input.result);
      const digest = digestRunEvaluationValue({
        taskId: task.id,
        attemptId: attempt.id,
        invocationId: attempt.invocationId,
        evaluationKey: task.evaluationKey,
        frozenGraderDigest: task.frozenGraderDigest,
        requestDigest: attempt.requestDigest,
        executionScopeDigest: attempt.executionScopeDigest,
        authority: "unverified",
        ...body
      });
      if (task.state === "completed" && attempt.state === "completed") {
        const result = this.getRunEvaluationTaskResult(task.id);
        return result?.resultDigest === digest ? ok({
          task,
          attempt,
          result
        }, true) : fail("result_conflict");
      }
      if (attempt.state !== "dispatch_admitted") return fail("invalid_transition");
      const columns = ["id", "schema_version", "authority", "task_id", "attempt_id", "invocation_id", "evaluation_key", "frozen_digest", "request_digest", "scope_digest", "verdict", "score", "severity", "raw_artifact_id", "raw_artifact_sha", "rationale_artifact_id", "rationale_artifact_sha", "input_tokens", "output_tokens", "amount_micros", "latency_ms", "result_digest", "created_at"];
      const values = [createRunEvaluationTaskResultId(), 1, "unverified", task.id, attempt.id, attempt.invocationId!, task.evaluationKey, task.frozenGraderDigest, attempt.requestDigest!, attempt.executionScopeDigest!, input.result.verdict, input.result.score ?? null, input.result.severity ?? null, input.result.rawOutputArtifact.artifactId, input.result.rawOutputArtifact.contentSha256, input.result.rationaleArtifact?.artifactId ?? null, input.result.rationaleArtifact?.contentSha256 ?? null, input.result.costInputTokens ?? null, input.result.costOutputTokens ?? null, input.result.costAmountMicros ?? null, input.result.latencyMs ?? null, digest, input.now];
      this.context.database.prepare(`INSERT INTO run_evaluation_task_results(${columns.join(",")}) SELECT ${columns.map(() => "?").join(",")} WHERE EXISTS(SELECT 1 FROM run_evaluation_tasks t JOIN run_evaluation_task_attempts a ON a.id=t.active_attempt_id WHERE t.id=? AND a.id=? AND t.revision=? AND a.revision=? AND a.claim_owner=? AND a.claim_token=? AND a.claim_expires_at>? AND t.state='active' AND a.state='dispatch_admitted')`).run(...values, task.id, attempt.id, task.revision, attempt.revision, input.claimOwner, input.claimToken, input.now);
      if (!this.getRunEvaluationTaskResult(task.id)) throw new RunEvaluationInputError("evaluation.task_invalid");
      this.updatePair(pair.value, input, "state='completed',completed_at=?,updated_at=?", [input.now, input.now], "state='completed',completed_at=?,failure_code=NULL,updated_at=?", [input.now, input.now]);
      this.syncRecoveryPins(this.getRunEvaluationTask(task.id)!, input.now);
      return ok({
        ...this.pair(task.id, attempt.id),
        result: this.getRunEvaluationTaskResult(task.id)!
      });
  }
  finishRunEvaluationTaskBeforeDispatch(input: FinishRunEvaluationTaskBeforeDispatchInput): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim> {
    validateTaskInput(input, "finish");
    return this.mutate(() => {
      const pair = this.fence(input);
      if (!pair.ok) return pair;
      if (pair.value.attempt.state !== "claimed") return fail("invalid_transition");
      this.finishBefore(pair.value, input, input.nextState, input.failureCode, input.nextAttemptAt);
      return ok(this.pair(input.taskId, input.attemptId));
    });
  }
  markRunEvaluationTaskDispatchUnknown(input: RunEvaluationTaskFence): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim> {
    validateTaskInput(input, "unknown");
    return this.mutate(() => this.markUnknownWithinTransaction(input));
  }
  /** Internal recovery seam. QA hook quarantines its ledger in the same transaction. */
  markUnknownWithinTransaction(input: RunEvaluationTaskFence): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim> {
    validateTaskInput(input, "unknown");
      const pair = this.fence(input);
      if (!pair.ok) return pair;
      if (pair.value.attempt.state !== "dispatch_admitted") return fail("invalid_transition");
      this.unknown(pair.value, input);
      return ok(this.pair(input.taskId, input.attemptId));
  }
  /** A different Host boot conservatively retires an admitted task, even before lease expiry. */
  reconcileQaOrphanWithinTransaction(taskId: string, attemptId: string, now: string): void {
    const task = this.getRunEvaluationTask(taskId), attempt = this.getRunEvaluationTaskAttempt(attemptId);
    if (!task || !attempt || task.activeAttemptId !== attempt.id || attempt.taskId !== task.id || task.state !== "active" || attempt.state !== "dispatch_admitted") return;
    this.unknown({ task, attempt }, { taskId, attemptId, now, expectedTaskRevision: task.revision, expectedAttemptRevision: attempt.revision, claimOwner: attempt.claimOwner, claimToken: attempt.claimToken }, attempt.claimExpiresAt <= now);
  }
  reconcileExpiredRunEvaluationTaskAttempt(input: ReconcileExpiredRunEvaluationTaskAttemptInput): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim> {
    validateTaskInput(input, "recoverExact");
    return this.mutate(() => this.recover(input));
  }
  reconcileExpiredRunEvaluationTaskAttemptsPage(input: ReconcileExpiredRunEvaluationTaskAttemptsPageInput): RunEvaluationTaskRecoveryPage {
    validateTaskInput(input, "recover");
    const limit = taskLimit(input.limit);
    const cursor = input.cursor;
    const rows = this.context.database.prepare(`SELECT a.id,a.task_id,a.claim_expires_at FROM run_evaluation_task_attempts a JOIN run_evaluation_tasks t ON t.active_attempt_id=a.id AND t.id=a.task_id WHERE t.state='active' AND a.state IN ('claimed','dispatch_admitted') AND a.claim_expires_at<=? ${cursor ? "AND (a.claim_expires_at>? OR (a.claim_expires_at=? AND a.id>?))" : ""} ORDER BY a.claim_expires_at,a.id LIMIT ?`).all(input.now, ...(cursor ? [cursor.claimExpiresAt, cursor.claimExpiresAt, cursor.attemptId] : []), limit + 1);
    const changed: RunEvaluationTaskClaim[] = [];
    for (const row of rows.slice(0, limit)) {
      const result = this.reconcileExpiredRunEvaluationTaskAttempt({
        taskId: row.task_id as string,
        attemptId: row.id as string,
        now: input.now
      });
      if (result.ok) changed.push(result.value);
    }
    const last = rows[Math.min(rows.length, limit) - 1];
    return {
      examinedCount: Math.min(rows.length, limit),
      changed,
      ...(rows.length > limit && last ? {
        nextCursor: {
          claimExpiresAt: last.claim_expires_at as string,
          attemptId: last.id as string
        }
      } : {})
    };
  }
  private recover(input: ReconcileExpiredRunEvaluationTaskAttemptInput): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim> {
    const task = this.getRunEvaluationTask(input.taskId),
      attempt = this.getRunEvaluationTaskAttempt(input.attemptId);
    if (!task || !attempt) return fail("not_found");
    if (task.activeAttemptId !== attempt.id || attempt.taskId !== task.id || task.state !== "active" || !["claimed", "dispatch_admitted"].includes(attempt.state)) return fail("invalid_transition");
    if (attempt.claimExpiresAt > input.now) return fail("lease_not_claimable");
    const fence = {
      ...input,
      expectedTaskRevision: task.revision,
      expectedAttemptRevision: attempt.revision,
      claimOwner: attempt.claimOwner,
      claimToken: attempt.claimToken
    };
    const pair = {
      task,
      attempt
    };
    if (attempt.state === "claimed") {
      this.finishBefore(pair, fence, "queued", "evaluation.lease_expired_before_dispatch", undefined, true);
    } else {
      this.unknown(pair, fence, true);
    }
    return ok(this.pair(task.id, attempt.id));
  }
  private fence(input: RunEvaluationTaskFence, replay = false, terminalReplay = false): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim> {
    const task = this.getRunEvaluationTask(input.taskId),
      attempt = this.getRunEvaluationTaskAttempt(input.attemptId);
    if (!task || !attempt) return fail("not_found");
    if (task.activeAttemptId !== attempt.id || attempt.taskId !== task.id) return fail("lease_mismatch");
    if (attempt.claimOwner !== input.claimOwner || attempt.claimToken !== input.claimToken) return fail("lease_mismatch");
    const exact = task.revision === input.expectedTaskRevision && attempt.revision === input.expectedAttemptRevision;
    // A preceding revision is authority only for historical no-op replay. Never
    // turn a renewal's stale fence into permission for new admission/settlement.
    const historicalReplay = terminalReplay ? task.state === "completed" && attempt.state === "completed" : attempt.state === "dispatch_admitted";
    const previous = replay && historicalReplay && task.revision === input.expectedTaskRevision + 1 && attempt.revision === input.expectedAttemptRevision + 1;
    if (!exact && !previous) return fail("stale_revision");
    if (terminalReplay && task.state === "completed" && attempt.state === "completed") return ok({
      task,
      attempt
    });
    if (task.state !== "active" || !["claimed", "dispatch_admitted"].includes(attempt.state)) return fail("invalid_transition");
    if (attempt.claimExpiresAt <= input.now) return fail("lease_mismatch");
    return ok({
      task,
      attempt
    });
  }
  private pair(taskId: string, attemptId: string): RunEvaluationTaskClaim {
    return {
      task: this.getRunEvaluationTask(taskId)!,
      attempt: this.getRunEvaluationTaskAttempt(attemptId)!
    };
  }
  private updatePair(
    pair: RunEvaluationTaskClaim,
    input: RunEvaluationTaskFence,
    attemptSql: string,
    attemptValues: (string | number | null)[],
    taskSql: string,
    taskValues: (string | number | null)[],
    expired = false,
  ): void {
    const { task, attempt } = pair;
    const compare = expired ? "<=" : ">";
    const first = this.context.database.prepare(`UPDATE run_evaluation_task_attempts SET ${attemptSql},revision=revision+1 WHERE id=? AND task_id=? AND revision=? AND state=? AND claim_owner=? AND claim_token=? AND claim_expires_at${compare}? AND EXISTS(SELECT 1 FROM run_evaluation_tasks WHERE id=? AND active_attempt_id=? AND revision=? AND state='active')`).run(...attemptValues, attempt.id, task.id, attempt.revision, attempt.state, input.claimOwner, input.claimToken, input.now, task.id, attempt.id, task.revision);
    this.changed(first.changes);
    const second = this.context.database.prepare(`UPDATE run_evaluation_tasks SET ${taskSql},revision=revision+1 WHERE id=? AND active_attempt_id=? AND revision=? AND state='active' AND EXISTS(SELECT 1 FROM run_evaluation_task_attempts WHERE id=? AND task_id=? AND revision=? AND claim_owner=? AND claim_token=? AND claim_expires_at${compare}?)`).run(...taskValues, task.id, attempt.id, task.revision, attempt.id, task.id, attempt.revision + 1, input.claimOwner, input.claimToken, input.now);
    this.changed(second.changes);
  }
  private finishBefore(pair: RunEvaluationTaskClaim, input: RunEvaluationTaskFence, next: "queued" | "failed" | "cancelled", code: string, nextAt?: string, expired = false): void {
    this.updatePair(pair, input, "state=?,failure_code=?,completed_at=?,updated_at=?", [next === "queued" ? "abandoned_before_dispatch" : next, code, input.now, input.now], "state=?,active_attempt_id=?,next_attempt_at=?,failure_code=?,completed_at=?,updated_at=?", [next, next === "queued" ? null : pair.attempt.id, nextAt ?? null, code, next === "queued" ? null : input.now, input.now], expired);
    this.syncRecoveryPins(this.getRunEvaluationTask(pair.task.id)!, input.now);
  }
  private unknown(pair: RunEvaluationTaskClaim, input: RunEvaluationTaskFence, expired = false): void {
    this.updatePair(pair, input, "state='unknown_outcome',failure_code='evaluation.dispatch_outcome_unknown',completed_at=?,updated_at=?", [input.now, input.now], "state='unknown_outcome',failure_code='evaluation.dispatch_outcome_unknown',completed_at=?,updated_at=?", [input.now, input.now], expired);
    this.syncRecoveryPins(this.getRunEvaluationTask(pair.task.id)!, input.now);
    this.ports.onDispatchUnknownWithinTransaction?.(pair.attempt.id, input.now);
  }
  private syncRecoveryPins(task: RunEvaluationTaskV1, now: string): void {
    const evaluation = this.ports.getRunEvaluation(task.evaluationId);
    if (!evaluation) throw new EvidenceError("evaluation.lineage_invalid");
    syncHarnessArtifactOwnerPins(this.context.database, {
      holder: harnessArtifactOwnerHolder("evaluation_task", task.id), now,
      keep: ["queued", "active", "unknown_outcome"].includes(task.state),
      artifactIds: [evaluation.suiteArtifactId, evaluation.caseArtifactId, evaluation.baselineArtifactId,
        evaluation.candidateArtifactId, task.frozenGraderArtifact.artifactId],
    });
  }
  private changed(count: number | bigint): void {
    if (count !== 1 && count !== 1n) throw new RunEvaluationInputError("evaluation.task_invalid");
  }
  private resultBody(input: RunEvaluationTaskResultInput): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const field of TASK_RESULT_FIELDS) if (Object.hasOwn(input, field)) {
      const value = input[field];
      body[field] = field === "rawOutputArtifact" || field === "rationaleArtifact" ? {
        artifactId: (value as RunEvaluationArtifactPinV1).artifactId,
        contentSha256: (value as RunEvaluationArtifactPinV1).contentSha256
      } : value;
    }
    return body;
  }
  private validateTask(task: RunEvaluationTaskV1): RunEvaluationV1 {
    const evaluation = this.evaluation(task.evaluationId, task.evaluationKey);
    const frozen = this.frozen(task.frozenGraderArtifact, task.frozenGraderDigest, evaluation);
    if (digestRunEvaluationValue(frozen) !== digestRunEvaluationValue(task.frozenGrader)) throw new EvidenceError("identity_conflict");
    return evaluation;
  }
  /** Revalidates physical byte pins and the completed evaluation inside the coordinator transaction. */
  validateTaskWithinTransaction(task: RunEvaluationTaskV1): RunEvaluationV1 {
    return this.validateTask(task);
  }
  private evaluation(id: string, key: string): RunEvaluationV1 {
    const evaluation = this.ports.getRunEvaluation(id);
    if (!evaluation || evaluation.state !== "completed" || !evaluation.completedAt || evaluation.idempotencyKey !== key) throw new EvidenceError("evaluation.lineage_invalid");
    const run = this.ports.getRun(evaluation.runId);
    if (!run || !["succeeded", "failed", "cancelled"].includes(run.status)) throw new EvidenceError("evaluation.lineage_invalid");
    let root = run;
    const visited = new Set<string>();
    for (let depth = 0; root.parentRunId; depth++) {
      if (depth >= 100 || visited.has(root.id)) throw new EvidenceError("evaluation.lineage_invalid");
      visited.add(root.id);
      const parent = this.ports.getRun(root.parentRunId);
      if (!parent) throw new EvidenceError("evaluation.lineage_invalid");
      root = parent;
    }
    if (root.id !== evaluation.rootRunId) throw new EvidenceError("evaluation.lineage_invalid");
    const identity = {
      rootRunId: evaluation.rootRunId,
      runId: evaluation.runId,
      suiteId: evaluation.suiteId,
      suiteVersion: evaluation.suiteVersion,
      suiteArtifactId: evaluation.suiteArtifactId,
      suiteDigest: evaluation.suiteDigest,
      caseId: evaluation.caseId,
      caseVersion: evaluation.caseVersion,
      caseArtifactId: evaluation.caseArtifactId,
      caseDigest: evaluation.caseDigest,
      baselineId: evaluation.baselineId,
      baselineVersion: evaluation.baselineVersion,
      baselineArtifactId: evaluation.baselineArtifactId,
      baselineDigest: evaluation.baselineDigest,
      candidateArtifactId: evaluation.candidateArtifactId,
      candidateDigest: evaluation.candidateDigest
    };
    if (runEvaluationIdempotencyKey(identity) !== key) throw new EvidenceError("identity_conflict");
    for (const prefix of ["suite", "case", "baseline", "candidate"] as const) this.artifact({
      artifactId: evaluation[`${prefix}ArtifactId`],
      contentSha256: evaluation[`${prefix}Digest`]
    }, evaluation, prefix === "candidate");
    return evaluation;
  }
  private frozen(pin: RunEvaluationArtifactPinV1, digest: string, evaluation: RunEvaluationV1): RunEvaluationFrozenGraderV1 {
    const artifact = this.artifact(pin, evaluation);
    validateTaskFrozen(artifact.sealedPayload);
    if (digestRunEvaluationValue(artifact.sealedPayload) !== digest) throw new EvidenceError("identity_conflict");
    return artifact.sealedPayload as RunEvaluationFrozenGraderV1;
  }
  private artifact(pin: RunEvaluationArtifactPinV1, evaluation: RunEvaluationV1, candidate = false): RunArtifact {
    const artifact = this.ports.getArtifact(pin.artifactId);
    if (!artifact || !artifact.runId || !(candidate ? [evaluation.runId] : [evaluation.runId, evaluation.rootRunId]).includes(artifact.runId) || artifact.contentSha256 !== pin.contentSha256 || artifact.sealedPayload === undefined) throw new EvidenceError("evaluation.artifact_invalid");
    validateTaskArtifactJson(artifact.sealedPayload);
    if (createHash("sha256").update(JSON.stringify(artifact.sealedPayload), "utf8").digest("hex") !== pin.contentSha256) throw new EvidenceError("evaluation.artifact_invalid");
    return artifact;
  }
  private mutate<T>(operation: () => RunEvaluationTaskMutationResult<T>): RunEvaluationTaskMutationResult<T> {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try {
      const value = operation();
      this.context.database.exec("COMMIT;");
      return value;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof EvidenceError) return fail(error.code);
      throw new RunEvaluationInputError("evaluation.task_invalid");
    }
  }
}
function ok<T>(value: T, replayed = false): RunEvaluationTaskMutationResult<T> {
  return {
    ok: true,
    value,
    replayed
  };
}
function fail(code: RunEvaluationTaskMutationCode): {
  readonly ok: false;
  readonly code: RunEvaluationTaskMutationCode;
} {
  return {
    ok: false,
    code
  };
}
