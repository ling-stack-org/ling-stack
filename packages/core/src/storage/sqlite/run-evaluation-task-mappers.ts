import type { SQLOutputValue } from "node:sqlite";
import {
  RUN_EVALUATION_TASK_STATES,
  RUN_EVALUATION_TASK_ATTEMPT_STATES,
  RUN_EVALUATION_TASK_FAILURE_CODES,
  RUN_EVALUATION_VERDICTS,
  RUN_EVALUATION_SEVERITIES,
  type RunEvaluationFrozenGraderV1,
  type RunEvaluationTaskV1,
  type RunEvaluationTaskAttemptV1,
  type RunEvaluationTaskResultV1,
} from "@ling-stack/contracts";
import { RunEvaluationInputError } from "../../harness/evaluation-json.js";
import { readString, readNullableString, readNumber, readNullableNumber } from "./helpers.js";
import { validateTaskFrozen } from "./run-evaluation-task-validation.js";
type Row = Record<string, SQLOutputValue>;
function enumeration<const T extends readonly string[]>(row: Row, key: string, values: T): T[number] {
  const value = readString(row, key);
  if (!values.includes(value)) throw new RunEvaluationInputError("evaluation.task_invalid");
  return value as T[number];
}
function failure(row: Row) {
  const value = readNullableString(row, "failure_code");
  if (value !== undefined && !RUN_EVALUATION_TASK_FAILURE_CODES.includes(value as never)) throw new RunEvaluationInputError("evaluation.task_invalid");
  return value as (typeof RUN_EVALUATION_TASK_FAILURE_CODES)[number] | undefined;
}
export function mapRunEvaluationTask(row: Row): RunEvaluationTaskV1 {
  const json = readString(row, "frozen_json");
  let frozen: RunEvaluationFrozenGraderV1;
  try {
    if (json.length > 10_000) throw new Error();
    frozen = JSON.parse(json) as RunEvaluationFrozenGraderV1;
    validateTaskFrozen(frozen);
  } catch {
    throw new RunEvaluationInputError("evaluation.task_invalid");
  }
  if (readNumber(row, "schema_version") !== 1 || readString(row, "grader_type") !== "model") throw new RunEvaluationInputError("evaluation.task_invalid");
  return {
    schemaVersion: 1,
    id: readString(row, "id"),
    evaluationId: readString(row, "evaluation_id"),
    evaluationKey: readString(row, "evaluation_key"),
    graderType: "model",
    frozenGrader: frozen,
    frozenGraderArtifact: {
      artifactId: readString(row, "frozen_artifact_id"),
      contentSha256: readString(row, "frozen_artifact_sha")
    },
    frozenGraderDigest: readString(row, "frozen_digest"),
    repeatOrdinal: readNumber(row, "repeat_ordinal"),
    idempotencyKey: readString(row, "idempotency_key"),
    state: enumeration(row, "state", RUN_EVALUATION_TASK_STATES),
    activeAttemptId: readNullableString(row, "active_attempt_id"),
    nextAttemptAt: readNullableString(row, "next_attempt_at"),
    revision: readNumber(row, "revision"),
    failureCode: failure(row),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    completedAt: readNullableString(row, "completed_at")
  };
}
export function mapRunEvaluationTaskAttempt(row: Row): RunEvaluationTaskAttemptV1 {
  if (readNumber(row, "schema_version") !== 1) throw new RunEvaluationInputError("evaluation.task_invalid");
  return {
    schemaVersion: 1,
    id: readString(row, "id"),
    taskId: readString(row, "task_id"),
    attemptNumber: readNumber(row, "attempt_number"),
    state: enumeration(row, "state", RUN_EVALUATION_TASK_ATTEMPT_STATES),
    claimOwner: readString(row, "claim_owner"),
    claimToken: readString(row, "claim_token"),
    claimExpiresAt: readString(row, "claim_expires_at"),
    revision: readNumber(row, "revision"),
    invocationId: readNullableString(row, "invocation_id"),
    requestDigest: readNullableString(row, "request_digest"),
    executionScopeDigest: readNullableString(row, "scope_digest"),
    dispatchAdmittedAt: readNullableString(row, "admitted_at"),
    failureCode: failure(row),
    claimedAt: readString(row, "claimed_at"),
    updatedAt: readString(row, "updated_at"),
    completedAt: readNullableString(row, "completed_at")
  };
}
export function mapRunEvaluationTaskResult(row: Row): RunEvaluationTaskResultV1 {
  if (readNumber(row, "schema_version") !== 1 || readString(row, "authority") !== "unverified") throw new RunEvaluationInputError("evaluation.task_invalid");
  const severity = readNullableString(row, "severity");
  if (severity !== undefined && !RUN_EVALUATION_SEVERITIES.includes(severity as never)) throw new RunEvaluationInputError("evaluation.task_invalid");
  const rationaleId = readNullableString(row, "rationale_artifact_id");
  return {
    schemaVersion: 1,
    authority: "unverified",
    id: readString(row, "id"),
    taskId: readString(row, "task_id"),
    attemptId: readString(row, "attempt_id"),
    invocationId: readString(row, "invocation_id"),
    evaluationKey: readString(row, "evaluation_key"),
    frozenGraderDigest: readString(row, "frozen_digest"),
    requestDigest: readString(row, "request_digest"),
    executionScopeDigest: readString(row, "scope_digest"),
    verdict: enumeration(row, "verdict", RUN_EVALUATION_VERDICTS),
    score: readNullableNumber(row, "score"),
    severity: severity as RunEvaluationTaskResultV1["severity"],
    rawOutputArtifact: {
      artifactId: readString(row, "raw_artifact_id"),
      contentSha256: readString(row, "raw_artifact_sha")
    },
    rationaleArtifact: rationaleId === undefined ? undefined : {
      artifactId: rationaleId,
      contentSha256: readString(row, "rationale_artifact_sha")
    },
    costInputTokens: readNullableNumber(row, "input_tokens"),
    costOutputTokens: readNullableNumber(row, "output_tokens"),
    costAmountMicros: readNullableNumber(row, "amount_micros"),
    latencyMs: readNullableNumber(row, "latency_ms"),
    resultDigest: readString(row, "result_digest"),
    createdAt: readString(row, "created_at")
  };
}
