import type { SQLOutputValue } from "node:sqlite";
import {
  RUN_EVALUATION_FAILURE_CODES,
  RUN_EVALUATION_GRADER_TYPES,
  RUN_EVALUATION_SEVERITIES,
  RUN_EVALUATION_STATES,
  RUN_EVALUATION_VERDICTS,
  type RunEvaluationGradeV1,
  type RunEvaluationV1,
} from "@ling-stack/contracts";
import { readNullableNumber, readNullableString, readNumber, readString } from "./helpers.js";

export function runEvaluationSelectSql(whereClause: string): string {
  return `
    SELECT
      id, schema_version, root_run_id, run_id, suite_id, suite_version, suite_artifact_id,
      suite_digest, case_id, case_version, case_artifact_id, case_digest, baseline_id,
      baseline_version, baseline_artifact_id, baseline_digest, candidate_artifact_id,
      candidate_digest, idempotency_key, state, claim_owner, claim_token, claim_expires_at,
      next_attempt_at, failure_code, revision, created_at, updated_at, completed_at
    FROM run_evaluations
    ${whereClause}
  `;
}

export function runEvaluationGradeSelectSql(whereClause: string): string {
  return `
    SELECT
      id, schema_version, evaluation_id, grader_type, grader_id, grader_version, verdict,
      score, severity, rationale_artifact_id, raw_output_artifact_id, cost_input_tokens,
      cost_output_tokens, cost_amount_micros, latency_ms, adjudication_status, grade_digest,
      created_at
    FROM run_evaluation_grades
    ${whereClause}
  `;
}

export function mapRunEvaluation(row: Record<string, SQLOutputValue>): RunEvaluationV1 {
  const schemaVersion = readNumber(row, "schema_version");
  if (schemaVersion !== 1) throw new Error(`Unsupported run evaluation schema: ${schemaVersion}`);
  return {
    schemaVersion: 1,
    id: readString(row, "id"),
    rootRunId: readString(row, "root_run_id"),
    runId: readString(row, "run_id"),
    suiteId: readString(row, "suite_id"),
    suiteVersion: readString(row, "suite_version"),
    suiteArtifactId: readString(row, "suite_artifact_id"),
    suiteDigest: readString(row, "suite_digest"),
    caseId: readString(row, "case_id"),
    caseVersion: readString(row, "case_version"),
    caseArtifactId: readString(row, "case_artifact_id"),
    caseDigest: readString(row, "case_digest"),
    baselineId: readString(row, "baseline_id"),
    baselineVersion: readString(row, "baseline_version"),
    baselineArtifactId: readString(row, "baseline_artifact_id"),
    baselineDigest: readString(row, "baseline_digest"),
    candidateArtifactId: readString(row, "candidate_artifact_id"),
    candidateDigest: readString(row, "candidate_digest"),
    idempotencyKey: readString(row, "idempotency_key"),
    state: readEnum(row, "state", RUN_EVALUATION_STATES),
    claimOwner: readNullableString(row, "claim_owner"),
    claimToken: readNullableString(row, "claim_token"),
    claimExpiresAt: readNullableString(row, "claim_expires_at"),
    nextAttemptAt: readNullableString(row, "next_attempt_at"),
    failureCode: readNullableEnum(row, "failure_code", RUN_EVALUATION_FAILURE_CODES),
    revision: readNumber(row, "revision"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    completedAt: readNullableString(row, "completed_at"),
  };
}

export function mapRunEvaluationGrade(row: Record<string, SQLOutputValue>): RunEvaluationGradeV1 {
  const schemaVersion = readNumber(row, "schema_version");
  if (schemaVersion !== 1) throw new Error(`Unsupported run evaluation grade schema: ${schemaVersion}`);
  return {
    schemaVersion: 1,
    id: readString(row, "id"),
    evaluationId: readString(row, "evaluation_id"),
    graderType: readEnum(row, "grader_type", RUN_EVALUATION_GRADER_TYPES),
    graderId: readString(row, "grader_id"),
    graderVersion: readString(row, "grader_version"),
    verdict: readEnum(row, "verdict", RUN_EVALUATION_VERDICTS),
    score: readNullableNumber(row, "score"),
    severity: readNullableEnum(row, "severity", RUN_EVALUATION_SEVERITIES),
    rationaleArtifactId: readNullableString(row, "rationale_artifact_id"),
    rawOutputArtifactId: readNullableString(row, "raw_output_artifact_id"),
    costInputTokens: readNullableNumber(row, "cost_input_tokens"),
    costOutputTokens: readNullableNumber(row, "cost_output_tokens"),
    costAmountMicros: readNullableNumber(row, "cost_amount_micros"),
    latencyMs: readNullableNumber(row, "latency_ms"),
    adjudicationStatus: readNullableString(row, "adjudication_status"),
    gradeDigest: readString(row, "grade_digest"),
    createdAt: readString(row, "created_at"),
  };
}

function readEnum<const T extends readonly string[]>(
  row: Record<string, SQLOutputValue>,
  key: string,
  values: T,
): T[number] {
  const value = readString(row, key);
  if (!(values as readonly string[]).includes(value)) throw new Error(`Invalid run evaluation ${key}: ${value}`);
  return value as T[number];
}

function readNullableEnum<const T extends readonly string[]>(
  row: Record<string, SQLOutputValue>,
  key: string,
  values: T,
): T[number] | undefined {
  const value = readNullableString(row, key);
  if (value !== undefined && !(values as readonly string[]).includes(value)) {
    throw new Error(`Invalid run evaluation ${key}: ${value}`);
  }
  return value as T[number] | undefined;
}
