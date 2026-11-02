import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  RUN_EVALUATION_GRADER_TYPES,
  RUN_EVALUATION_SEVERITIES,
  RUN_EVALUATION_VERDICTS,
  type RunEvaluationGradeV1,
  type RunEvaluationV1,
} from "@ling-stack/contracts";
import {
  createRunEvaluationGradeId,
  createRunEvaluationId,
  digestRunEvaluationGrade,
  runEvaluationIdempotencyKey,
  type AppendRunEvaluationGradeInput,
  type AppendRunEvaluationGradeResult,
  type ClaimRunEvaluationInput,
  type CompleteRunEvaluationInput,
  type CompleteRunEvaluationResult,
  type CreateRunEvaluationGradeInput,
  type EnqueuedRunEvaluation,
  type EnqueueRunEvaluationInput,
  type FailRunEvaluationInput,
  type ListClaimableRunEvaluationsInput,
  type ListRunEvaluationsInput,
  type RequeueRunEvaluationInput,
  type RunEvaluationMutationResult,
  type StartRunEvaluationInput,
} from "../../harness/evaluations.js";
import { isHarnessLeaseClaimable } from "../../harness/common.js";
import { HarnessReliabilityError } from "../../harness/reliability.js";
import type { RunArtifact, RunSession } from "../../run-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import {
  mapRunEvaluation,
  mapRunEvaluationGrade,
  runEvaluationGradeSelectSql,
  runEvaluationSelectSql,
} from "./run-evaluation-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";
import { harnessArtifactOwnerHolder, syncHarnessArtifactOwnerPins } from "./harness-artifact-recovery-pins.js";

interface RunEvaluationStorePorts {
  readonly getRun: (id: string) => RunSession | undefined;
  readonly getArtifact: (id: string) => RunArtifact | undefined;
}

/** Durable evaluation queue, immutable lineage, and append-only grade commits. */
export class SqliteRunEvaluationStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: RunEvaluationStorePorts,
  ) {}

  getRunEvaluation(id: string): RunEvaluationV1 | undefined {
    const row = this.context.database.prepare(runEvaluationSelectSql("WHERE id = ?")).get(id);
    return row ? mapRunEvaluation(row as Record<string, SQLOutputValue>) : undefined;
  }

  /** Exact bounded grade lookup; does not enumerate evaluation history. */
  getRunEvaluationGrade(id: string): RunEvaluationGradeV1 | undefined {
    validateIdentity(id, "grade id");
    return this.getRunEvaluationGradeUnchecked(id);
  }

  findRunEvaluationByIdempotencyKey(idempotencyKey: string): RunEvaluationV1 | undefined {
    const row = this.context.database.prepare(runEvaluationSelectSql("WHERE idempotency_key = ?")).get(idempotencyKey);
    return row ? mapRunEvaluation(row as Record<string, SQLOutputValue>) : undefined;
  }

  listRunEvaluations(input: ListRunEvaluationsInput = {}): readonly RunEvaluationV1[] {
    const limit = validateLimit(input.limit);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.runId) {
      validateIdentity(input.runId, "run id");
      clauses.push("run_id = ?");
      params.push(input.runId);
    }
    if (input.rootRunId) {
      validateIdentity(input.rootRunId, "root run id");
      clauses.push("root_run_id = ?");
      params.push(input.rootRunId);
    }
    if (input.state) {
      clauses.push("state = ?");
      params.push(input.state);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.context.database
      .prepare(`${runEvaluationSelectSql(where)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit)
      .map((row) => mapRunEvaluation(row as Record<string, SQLOutputValue>));
  }

  listClaimableRunEvaluations(input: ListClaimableRunEvaluationsInput): readonly RunEvaluationV1[] {
    assertTimestamp(input.now);
    const limit = validateLimit(input.limit);
    return this.context.database.prepare(`${runEvaluationSelectSql(`
      WHERE (
        (state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR
        (state IN ('claimed', 'grading') AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?)
      )
      AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
    `)} ORDER BY COALESCE(next_attempt_at, claim_expires_at, created_at) ASC, created_at ASC, id ASC LIMIT ?`)
      .all(input.now, input.now, input.now, limit)
      .map((row) => mapRunEvaluation(row as Record<string, SQLOutputValue>));
  }

  listRunEvaluationGrades(evaluationId: string): readonly RunEvaluationGradeV1[] {
    validateIdentity(evaluationId, "evaluation id");
    return this.context.database
      .prepare(`${runEvaluationGradeSelectSql("WHERE evaluation_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(evaluationId)
      .map((row) => mapRunEvaluationGrade(row as Record<string, SQLOutputValue>));
  }

  enqueueRunEvaluation(input: EnqueueRunEvaluationInput): EnqueuedRunEvaluation {
    validateEnqueueInput(input);
    return this.transaction(() => {
      const run = this.ports.getRun(input.runId);
      if (!run || !["succeeded", "failed", "cancelled"].includes(run.status)) {
        throw new RunEvaluationStoreError("evaluation.lineage_invalid");
      }
      const rootRunId = this.resolveRootRunId(run);
      if (input.rootRunId && input.rootRunId !== rootRunId) {
        throw new RunEvaluationStoreError("evaluation.lineage_invalid");
      }
      const suite = this.requireSealedArtifact(input.suiteArtifactId, [rootRunId, run.id]);
      const testCase = this.requireSealedArtifact(input.caseArtifactId, [rootRunId, run.id]);
      const baseline = this.requireSealedArtifact(input.baselineArtifactId, [rootRunId, run.id]);
      const candidate = this.requireSealedArtifact(input.candidateArtifactId, [run.id]);
      const identity = {
        rootRunId,
        runId: run.id,
        suiteId: input.suiteId,
        suiteVersion: input.suiteVersion,
        suiteArtifactId: suite.id,
        suiteDigest: suite.contentSha256!,
        caseId: input.caseId,
        caseVersion: input.caseVersion,
        caseArtifactId: testCase.id,
        caseDigest: testCase.contentSha256!,
        baselineId: input.baselineId,
        baselineVersion: input.baselineVersion,
        baselineArtifactId: baseline.id,
        baselineDigest: baseline.contentSha256!,
        candidateArtifactId: candidate.id,
        candidateDigest: candidate.contentSha256!,
      };
      const idempotencyKey = runEvaluationIdempotencyKey(identity);
      const existing = this.findRunEvaluationByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (!sameEnqueueIdentity(existing, input, identity, suite.id, testCase.id, baseline.id)) {
          throw new RunEvaluationStoreError("evaluation.idempotency_conflict");
        }
        this.syncRecoveryPins(existing, input.now);
        return { evaluation: existing, replayed: true };
      }
      if (input.id && this.getRunEvaluation(input.id)) {
        throw new RunEvaluationStoreError("evaluation.idempotency_conflict");
      }
      const evaluation: RunEvaluationV1 = {
        schemaVersion: 1,
        id: input.id ?? createRunEvaluationId(),
        rootRunId,
        runId: run.id,
        suiteId: input.suiteId,
        suiteVersion: input.suiteVersion,
        suiteArtifactId: suite.id,
        suiteDigest: suite.contentSha256!,
        caseId: input.caseId,
        caseVersion: input.caseVersion,
        caseArtifactId: testCase.id,
        caseDigest: testCase.contentSha256!,
        baselineId: input.baselineId,
        baselineVersion: input.baselineVersion,
        baselineArtifactId: baseline.id,
        baselineDigest: baseline.contentSha256!,
        candidateArtifactId: candidate.id,
        candidateDigest: candidate.contentSha256!,
        idempotencyKey,
        state: "queued",
        revision: 0,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.insertEvaluation(evaluation);
      this.syncRecoveryPins(evaluation, input.now);
      return { evaluation: this.getRunEvaluation(evaluation.id)!, replayed: false };
    });
  }

  claimRunEvaluation(input: ClaimRunEvaluationInput): RunEvaluationMutationResult {
    validateClaimInput(input);
    return this.transaction(() => {
      const current = this.getRunEvaluation(input.evaluationId);
      if (!current) return { ok: false, code: "not_found" };
      if (current.state === "claimed" && matchesLease(current, input)
        && current.claimExpiresAt && current.claimExpiresAt > input.now) {
        if (!this.syncAdmissionRecoveryPins(current, input.now)) {
          return { ok: false, code: "evaluation.artifact_invalid" };
        }
        return { ok: true, value: current, replayed: true };
      }
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      const expiredLease = ["claimed", "grading"].includes(current.state)
        && Boolean(current.claimExpiresAt && current.claimExpiresAt <= input.now);
      if (current.state !== "queued" && !expiredLease) return { ok: false, code: "invalid_transition" };
      if (!isHarnessLeaseClaimable({ ...current, now: input.now })) {
        return { ok: false, code: "lease_not_claimable" };
      }
      const result = this.context.database.prepare(`
        UPDATE run_evaluations
        SET state = 'claimed', revision = revision + 1, claim_owner = ?, claim_token = ?,
            claim_expires_at = ?, next_attempt_at = NULL, failure_code = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state IN ('queued', 'claimed', 'grading')
          AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      `).run(
        input.claimOwner,
        input.claimToken,
        input.claimExpiresAt,
        expiredLease ? "evaluation.lease_expired" : null,
        input.now,
        input.evaluationId,
        input.expectedRevision,
        input.now,
        input.now,
      );
      if (Number(result.changes) !== 1) return { ok: false, code: "stale_revision" };
      if (!this.syncAdmissionRecoveryPins(this.getRunEvaluation(input.evaluationId)!, input.now)) {
        return { ok: false, code: "evaluation.artifact_invalid" };
      }
      return { ok: true, value: this.getRunEvaluation(input.evaluationId)!, replayed: false };
    });
  }

  startRunEvaluation(input: StartRunEvaluationInput): RunEvaluationMutationResult {
    validateLeaseMutationInput(input);
    return this.transaction(() => {
      const current = this.getRunEvaluation(input.evaluationId);
      if (!current) return { ok: false, code: "not_found" };
      if (!matchesLiveLease(current, input)) return { ok: false, code: "lease_mismatch" };
      if (current.state === "grading") {
        if (!this.syncAdmissionRecoveryPins(current, input.now)) {
          return { ok: false, code: "evaluation.artifact_invalid" };
        }
        return { ok: true, value: current, replayed: true };
      }
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      if (current.state !== "claimed") return { ok: false, code: "invalid_transition" };
      const result = this.context.database.prepare(`
        UPDATE run_evaluations
        SET state = 'grading', revision = revision + 1, failure_code = NULL, updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'claimed'
          AND claim_owner = ? AND claim_token = ? AND claim_expires_at > ?
      `).run(input.now, input.evaluationId, input.expectedRevision, input.claimOwner, input.claimToken, input.now);
      if (Number(result.changes) !== 1) return { ok: false, code: "stale_revision" };
      if (!this.syncAdmissionRecoveryPins(this.getRunEvaluation(input.evaluationId)!, input.now)) {
        return { ok: false, code: "evaluation.artifact_invalid" };
      }
      return { ok: true, value: this.getRunEvaluation(input.evaluationId)!, replayed: false };
    });
  }

  requeueRunEvaluation(input: RequeueRunEvaluationInput): RunEvaluationMutationResult {
    validateLeaseMutationInput(input);
    assertTimestamp(input.nextAttemptAt);
    if (input.nextAttemptAt <= input.now) throw new Error("Evaluation retry time must be after now.");
    return this.transaction(() => {
      const current = this.getRunEvaluation(input.evaluationId);
      if (!current) return { ok: false, code: "not_found" };
      if (!matchesLiveLease(current, input)) return { ok: false, code: "lease_mismatch" };
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      if (!["claimed", "grading"].includes(current.state)) return { ok: false, code: "invalid_transition" };
      // Verify while this exact live lease still owns the work. Once requeued,
      // no old token may be used to terminalize a queue row on a later read.
      if (!this.syncAdmissionRecoveryPins(current, input.now)) {
        return { ok: false, code: "evaluation.artifact_invalid" };
      }
      const result = this.context.database.prepare(`
        UPDATE run_evaluations
        SET state = 'queued', revision = revision + 1, claim_owner = NULL, claim_token = NULL,
            claim_expires_at = NULL, next_attempt_at = ?, failure_code = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state IN ('claimed', 'grading')
          AND claim_owner = ? AND claim_token = ?
      `).run(input.nextAttemptAt, input.failureCode, input.now, input.evaluationId, input.expectedRevision,
        input.claimOwner, input.claimToken);
      if (Number(result.changes) !== 1) return { ok: false, code: "stale_revision" };
      // The immutable artifact set and nonterminal recovery owner are unchanged.
      return { ok: true, value: this.getRunEvaluation(input.evaluationId)!, replayed: false };
    });
  }

  failRunEvaluation(input: FailRunEvaluationInput): RunEvaluationMutationResult {
    validateLeaseMutationInput(input);
    return this.transaction(() => {
      const current = this.getRunEvaluation(input.evaluationId);
      if (!current) return { ok: false, code: "not_found" };
      if (current.state === "failed" && current.failureCode === input.failureCode) {
        return { ok: true, value: current, replayed: true };
      }
      if (!matchesLiveLease(current, input)) return { ok: false, code: "lease_mismatch" };
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      if (!["claimed", "grading"].includes(current.state)) return { ok: false, code: "invalid_transition" };
      const result = this.context.database.prepare(`
        UPDATE run_evaluations
        SET state = 'failed', revision = revision + 1, claim_owner = NULL, claim_token = NULL,
            claim_expires_at = NULL, next_attempt_at = NULL, failure_code = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state IN ('claimed', 'grading')
          AND claim_owner = ? AND claim_token = ?
      `).run(input.failureCode, input.now, input.now, input.evaluationId, input.expectedRevision,
        input.claimOwner, input.claimToken);
      if (Number(result.changes) !== 1) return { ok: false, code: "stale_revision" };
      this.syncRecoveryPins(this.getRunEvaluation(input.evaluationId)!, input.now);
      return { ok: true, value: this.getRunEvaluation(input.evaluationId)!, replayed: false };
    });
  }

  completeRunEvaluation(input: CompleteRunEvaluationInput): CompleteRunEvaluationResult {
    validateLeaseMutationInput(input);
    return this.transaction(() => {
      const current = this.getRunEvaluation(input.evaluationId);
      if (!current) return { ok: false, code: "not_found" };
      const preparedGrade = this.prepareGrade(current, input.grade, input.now);
      const existing = this.findGradeByIdentity(current.id, preparedGrade);
      if (current.state === "completed" && existing?.gradeDigest === preparedGrade.gradeDigest) {
        return { ok: true, evaluation: current, grade: existing, replayed: true };
      }
      if (existing) return { ok: false, code: "grade_conflict" };
      if (!matchesLiveLease(current, input)) return { ok: false, code: "lease_mismatch" };
      if (current.revision !== input.expectedRevision) return { ok: false, code: "stale_revision" };
      if (current.state !== "grading") return { ok: false, code: "invalid_transition" };
      this.insertGrade(preparedGrade);
      const result = this.context.database.prepare(`
        UPDATE run_evaluations
        SET state = 'completed', revision = revision + 1, claim_owner = NULL, claim_token = NULL,
            claim_expires_at = NULL, next_attempt_at = NULL, failure_code = NULL,
            completed_at = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state = 'grading'
          AND claim_owner = ? AND claim_token = ? AND claim_expires_at > ?
      `).run(input.now, input.now, input.evaluationId, input.expectedRevision,
        input.claimOwner, input.claimToken, input.now);
      if (Number(result.changes) !== 1) throw new Error("Evaluation grade commit lost its transaction-local CAS.");
      this.syncRecoveryPins(this.getRunEvaluation(input.evaluationId)!, input.now);
      return {
        ok: true,
        evaluation: this.getRunEvaluation(input.evaluationId)!,
        grade: this.getRunEvaluationGradeUnchecked(preparedGrade.id)!,
        replayed: false,
      };
    });
  }

  appendRunEvaluationGrade(input: AppendRunEvaluationGradeInput): AppendRunEvaluationGradeResult {
    assertTimestamp(input.now);
    return this.transaction(() => {
      const evaluation = this.getRunEvaluation(input.evaluationId);
      if (!evaluation) return { ok: false, code: "not_found" };
      if (evaluation.state !== "completed") return { ok: false, code: "invalid_transition" };
      const grade = this.prepareGrade(evaluation, input.grade, input.now);
      const existing = this.findGradeByIdentity(evaluation.id, grade);
      if (existing) {
        return existing.gradeDigest === grade.gradeDigest
          ? { ok: true, grade: existing, replayed: true }
          : { ok: false, code: "grade_conflict" };
      }
      this.insertGrade(grade);
      return { ok: true, grade: this.getRunEvaluationGradeUnchecked(grade.id)!, replayed: false };
    });
  }

  private resolveRootRunId(run: RunSession): string {
    let current = run;
    const visited = new Set<string>([run.id]);
    for (let depth = 0; current.parentRunId; depth += 1) {
      if (depth >= 100 || visited.has(current.parentRunId)) {
        throw new RunEvaluationStoreError("evaluation.lineage_invalid");
      }
      visited.add(current.parentRunId);
      const parent = this.ports.getRun(current.parentRunId);
      if (!parent) throw new RunEvaluationStoreError("evaluation.lineage_invalid");
      current = parent;
    }
    return current.id;
  }

  private requireSealedArtifact(id: string, allowedRunIds: readonly string[]): RunArtifact {
    const artifact = this.ports.getArtifact(id);
    if (!artifact || !artifact.runId || !allowedRunIds.includes(artifact.runId)
      || artifact.sealedPayload === undefined || !isDigest(artifact.contentSha256)
      || digestArtifactPayload(artifact.sealedPayload) !== artifact.contentSha256) {
      throw new RunEvaluationStoreError("evaluation.artifact_invalid");
    }
    return artifact;
  }

  private insertEvaluation(evaluation: RunEvaluationV1): void {
    this.context.database.prepare(`
      INSERT INTO run_evaluations (
        id, schema_version, root_run_id, run_id, suite_id, suite_version, suite_artifact_id,
        suite_digest, case_id, case_version, case_artifact_id, case_digest, baseline_id,
        baseline_version, baseline_artifact_id, baseline_digest, candidate_artifact_id,
        candidate_digest, idempotency_key, state, claim_owner, claim_token, claim_expires_at,
        next_attempt_at, failure_code, revision, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evaluation.id, evaluation.schemaVersion, evaluation.rootRunId, evaluation.runId,
      evaluation.suiteId, evaluation.suiteVersion, evaluation.suiteArtifactId, evaluation.suiteDigest,
      evaluation.caseId, evaluation.caseVersion, evaluation.caseArtifactId, evaluation.caseDigest,
      evaluation.baselineId, evaluation.baselineVersion, evaluation.baselineArtifactId,
      evaluation.baselineDigest, evaluation.candidateArtifactId, evaluation.candidateDigest,
      evaluation.idempotencyKey, evaluation.state, evaluation.claimOwner ?? null, evaluation.claimToken ?? null,
      evaluation.claimExpiresAt ?? null, evaluation.nextAttemptAt ?? null, evaluation.failureCode ?? null,
      evaluation.revision, evaluation.createdAt, evaluation.updatedAt, evaluation.completedAt ?? null,
    );
  }

  private prepareGrade(
    evaluation: RunEvaluationV1,
    input: CreateRunEvaluationGradeInput,
    now: string,
  ): RunEvaluationGradeV1 {
    validateGradeInput(input);
    for (const artifactId of [input.rationaleArtifactId, input.rawOutputArtifactId]) {
      if (!artifactId) continue;
      this.requireSealedArtifact(artifactId, [evaluation.runId, evaluation.rootRunId]);
    }
    const gradeDigest = digestRunEvaluationGrade(evaluation.id, input);
    return {
      schemaVersion: 1,
      id: input.id ?? createRunEvaluationGradeId(),
      evaluationId: evaluation.id,
      graderType: input.graderType,
      graderId: input.graderId,
      graderVersion: input.graderVersion,
      verdict: input.verdict,
      ...(input.score === undefined ? {} : { score: input.score }),
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      ...(input.rationaleArtifactId === undefined ? {} : { rationaleArtifactId: input.rationaleArtifactId }),
      ...(input.rawOutputArtifactId === undefined ? {} : { rawOutputArtifactId: input.rawOutputArtifactId }),
      ...(input.costInputTokens === undefined ? {} : { costInputTokens: input.costInputTokens }),
      ...(input.costOutputTokens === undefined ? {} : { costOutputTokens: input.costOutputTokens }),
      ...(input.costAmountMicros === undefined ? {} : { costAmountMicros: input.costAmountMicros }),
      ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
      ...(input.adjudicationStatus === undefined ? {} : { adjudicationStatus: input.adjudicationStatus }),
      gradeDigest,
      createdAt: now,
    };
  }

  // Internal commit readback retains existing write semantics, including legacy ID validation.
  private getRunEvaluationGradeUnchecked(id: string): RunEvaluationGradeV1 | undefined {
    const row = this.context.database.prepare(runEvaluationGradeSelectSql("WHERE id = ?")).get(id);
    return row ? mapRunEvaluationGrade(row as Record<string, SQLOutputValue>) : undefined;
  }

  private findGradeByIdentity(
    evaluationId: string,
    grade: Pick<RunEvaluationGradeV1, "graderType" | "graderId" | "graderVersion">,
  ): RunEvaluationGradeV1 | undefined {
    const row = this.context.database.prepare(runEvaluationGradeSelectSql(`
      WHERE evaluation_id = ? AND grader_type = ? AND grader_id = ? AND grader_version = ?
    `)).get(evaluationId, grade.graderType, grade.graderId, grade.graderVersion);
    return row ? mapRunEvaluationGrade(row as Record<string, SQLOutputValue>) : undefined;
  }

  private insertGrade(grade: RunEvaluationGradeV1): void {
    this.context.database.prepare(`
      INSERT INTO run_evaluation_grades (
        id, schema_version, evaluation_id, grader_type, grader_id, grader_version, verdict,
        score, severity, rationale_artifact_id, raw_output_artifact_id, cost_input_tokens,
        cost_output_tokens, cost_amount_micros, latency_ms, adjudication_status, grade_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      grade.id, grade.schemaVersion, grade.evaluationId, grade.graderType, grade.graderId,
      grade.graderVersion, grade.verdict, grade.score ?? null, grade.severity ?? null,
      grade.rationaleArtifactId ?? null, grade.rawOutputArtifactId ?? null,
      grade.costInputTokens ?? null, grade.costOutputTokens ?? null, grade.costAmountMicros ?? null,
      grade.latencyMs ?? null, grade.adjudicationStatus ?? null, grade.gradeDigest, grade.createdAt,
    );
  }

  private syncRecoveryPins(evaluation: RunEvaluationV1, now: string): void {
    const holder = harnessArtifactOwnerHolder("evaluation", evaluation.id);
    const artifactIds = [evaluation.suiteArtifactId, evaluation.caseArtifactId, evaluation.baselineArtifactId, evaluation.candidateArtifactId];
    const keep = ["queued", "claimed", "grading"].includes(evaluation.state);
    if (!keep) {
      // Verify the whole owner set before releasing any pin. A corrupt earlier
      // body must not hide a later pin's changed reason and release an audit hold.
      const findPin = this.context.database.prepare("SELECT reason FROM harness_artifact_pins WHERE artifact_id=? AND holder=?");
      for (const artifactId of new Set(artifactIds)) {
        const pin = findPin.get(artifactId, holder);
        if (pin && pin.reason !== "recovery") throw new HarnessReliabilityError("artifact.pin_holder_conflict");
      }
    }
    syncHarnessArtifactOwnerPins(this.context.database, { holder, artifactIds, keep, now });
  }

  /** False guarantees this exact live owner's durable failed/result_invalid transition committed with its caller. */
  private syncAdmissionRecoveryPins(evaluation: RunEvaluationV1, now: string): boolean {
    try {
      this.syncRecoveryPins(evaluation, now);
      return true;
    } catch (error) {
      // Keep transaction/SQLite faults and pin ownership conflicts observable.
      // Only the original retained-body verifier can classify permanent input loss.
      if (!(error instanceof HarnessReliabilityError) || ![
        "artifact.body_unavailable", "artifact.body_budget_exceeded", "artifact.body_digest_mismatch",
      ].includes(error.code)) throw error;
      const failed = this.context.database.prepare(`
        UPDATE run_evaluations
        SET state = 'failed', revision = revision + 1, claim_owner = NULL, claim_token = NULL,
            claim_expires_at = NULL, next_attempt_at = NULL,
            failure_code = 'evaluation.result_invalid', completed_at = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND state IN ('claimed', 'grading')
          AND claim_owner = ? AND claim_token = ? AND claim_expires_at > ?
      `).run(now, now, evaluation.id, evaluation.revision, evaluation.claimOwner!, evaluation.claimToken!, now);
      if (Number(failed.changes) !== 1) throw new Error("Evaluation input failure lost its transaction-local CAS.");
      // Releasing this terminal owner's recovery pins reads no corrupt body;
      // metadata, original digests and other owners' audit holds remain intact.
      this.syncRecoveryPins(this.getRunEvaluation(evaluation.id)!, now);
      return false;
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

export type RunEvaluationStoreErrorCode =
  | "evaluation.idempotency_conflict"
  | "evaluation.lineage_invalid"
  | "evaluation.artifact_invalid";

export class RunEvaluationStoreError extends Error {
  constructor(readonly code: RunEvaluationStoreErrorCode) {
    super(code);
    this.name = "RunEvaluationStoreError";
  }
}

function sameEnqueueIdentity(
  existing: RunEvaluationV1,
  input: EnqueueRunEvaluationInput,
  identity: Parameters<typeof runEvaluationIdempotencyKey>[0],
  suiteArtifactId: string,
  caseArtifactId: string,
  baselineArtifactId: string,
): boolean {
  return existing.rootRunId === identity.rootRunId
    && existing.runId === identity.runId
    && existing.suiteId === identity.suiteId
    && existing.suiteVersion === identity.suiteVersion
    && existing.suiteArtifactId === suiteArtifactId
    && existing.suiteDigest === identity.suiteDigest
    && existing.caseId === identity.caseId
    && existing.caseVersion === identity.caseVersion
    && existing.caseArtifactId === caseArtifactId
    && existing.caseDigest === identity.caseDigest
    && existing.baselineId === identity.baselineId
    && existing.baselineVersion === identity.baselineVersion
    && existing.baselineArtifactId === baselineArtifactId
    && existing.baselineDigest === identity.baselineDigest
    && existing.candidateArtifactId === identity.candidateArtifactId
    && existing.candidateDigest === identity.candidateDigest
    && (!input.id || existing.id === input.id);
}

function validateEnqueueInput(input: EnqueueRunEvaluationInput): void {
  for (const [value, field] of [
    [input.runId, "run id"], [input.suiteId, "suite id"], [input.suiteVersion, "suite version"],
    [input.suiteArtifactId, "suite artifact id"], [input.caseId, "case id"],
    [input.caseVersion, "case version"], [input.caseArtifactId, "case artifact id"],
    [input.baselineId, "baseline id"], [input.baselineVersion, "baseline version"],
    [input.baselineArtifactId, "baseline artifact id"], [input.candidateArtifactId, "candidate artifact id"],
  ] as const) validateIdentity(value, field);
  if (input.id) validateIdentity(input.id, "evaluation id");
  if (input.rootRunId) validateIdentity(input.rootRunId, "root run id");
  assertTimestamp(input.now);
}

function validateClaimInput(input: ClaimRunEvaluationInput): void {
  validateLeaseMutationInput(input);
  assertTimestamp(input.claimExpiresAt);
  if (input.claimExpiresAt <= input.now) throw new Error("Evaluation claim must expire after now.");
}

function validateLeaseMutationInput(input: StartRunEvaluationInput): void {
  validateIdentity(input.evaluationId, "evaluation id");
  validateIdentity(input.claimOwner, "claim owner");
  validateIdentity(input.claimToken, "claim token");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("Evaluation revision must be a non-negative safe integer.");
  }
  assertTimestamp(input.now);
}

function validateGradeInput(input: CreateRunEvaluationGradeInput): void {
  validateIdentity(input.graderId, "grader id");
  validateIdentity(input.graderVersion, "grader version");
  if (input.id) validateIdentity(input.id, "grade id");
  if (!(RUN_EVALUATION_GRADER_TYPES as readonly string[]).includes(input.graderType)
    || !(RUN_EVALUATION_VERDICTS as readonly string[]).includes(input.verdict)
    || (input.severity !== undefined
      && !(RUN_EVALUATION_SEVERITIES as readonly string[]).includes(input.severity))) {
    throw new Error("Evaluation grade enum value is invalid.");
  }
  if (input.score !== undefined && (!Number.isFinite(input.score) || input.score < 0 || input.score > 1)) {
    throw new Error("Evaluation grade score must be between 0 and 1.");
  }
  for (const [value, field] of [
    [input.costInputTokens, "input token cost"], [input.costOutputTokens, "output token cost"],
    [input.costAmountMicros, "monetary cost"], [input.latencyMs, "latency"],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Evaluation grade ${field} must be a non-negative safe integer.`);
    }
  }
  if (input.adjudicationStatus !== undefined) validateIdentity(input.adjudicationStatus, "adjudication status");
}

function matchesLease(
  evaluation: RunEvaluationV1,
  input: Pick<StartRunEvaluationInput, "claimOwner" | "claimToken">,
): boolean {
  return evaluation.claimOwner === input.claimOwner && evaluation.claimToken === input.claimToken;
}

function matchesLiveLease(evaluation: RunEvaluationV1, input: StartRunEvaluationInput): boolean {
  return matchesLease(evaluation, input)
    && Boolean(evaluation.claimExpiresAt && evaluation.claimExpiresAt > input.now);
}

function validateIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length < 1 || value !== value.trim() || value.length > 500) {
    throw new Error(`Evaluation ${field} is invalid.`);
  }
}

function assertTimestamp(value: string): void {
  if (typeof value !== "string") {
    throw new Error(`Evaluation timestamp must be canonical UTC: ${String(value)}`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Evaluation timestamp must be canonical UTC: ${value}`);
  }
}

function validateLimit(limit: number | undefined): number {
  const value = limit ?? 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new Error("Evaluation list limit must be between 1 and 500.");
  }
  return value;
}

function isDigest(value: string | undefined): value is string {
  return Boolean(value && /^[a-f0-9]{64}$/u.test(value));
}

function digestArtifactPayload(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    return createHash("sha256").update(serialized, "utf8").digest("hex");
  } catch {
    return undefined;
  }
}
