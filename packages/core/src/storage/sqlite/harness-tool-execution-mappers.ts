import type { SQLOutputValue } from "node:sqlite";
import {
  HARNESS_TOOL_EXECUTION_FAILURE_CODES,
  HARNESS_TOOL_EXECUTION_STATES,
  type HarnessToolExecutionV1,
} from "@ling-stack/contracts";
import {
  parseJsonObject,
  parseJsonStringArray,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function harnessToolExecutionSelectSql(whereClause: string): string {
  return `
    SELECT
      execution.id,
      execution.schema_version,
      execution.run_id,
      execution.work_unit_id,
      execution.attempt_id,
      execution.continuation_id,
      execution.delegation_step_id,
      execution.supersedes_execution_id,
      execution.tool_call_id,
      execution.tool_name,
      execution.executor_kind,
      execution.state,
      execution.request_digest,
      execution.side_effect_fingerprint,
      execution.policy_snapshot_artifact_id,
      execution.approval_id,
      execution.sandbox_profile_id,
      execution.claim_owner,
      execution.claim_token,
      execution.claim_expires_at,
      execution.next_attempt_at,
      execution.execution_started_at,
      execution.execution_finished_at,
      execution.result_digest,
      execution.result_summary_json,
      execution.failure_code,
      execution.revision,
      execution.created_at,
      execution.updated_at,
      COALESCE((
        SELECT json_group_array(ordered.artifact_id)
        FROM (
          SELECT artifact_id
          FROM harness_tool_execution_artifacts
          WHERE execution_id = execution.id
          ORDER BY ordinal ASC
        ) AS ordered
      ), '[]') AS evidence_artifact_ids_json
    FROM harness_tool_executions AS execution
    ${whereClause}
  `;
}

export function mapHarnessToolExecution(row: Record<string, SQLOutputValue>): HarnessToolExecutionV1 {
  const schemaVersion = readNumber(row, "schema_version");
  if (schemaVersion !== 1) throw new Error(`Unsupported harness tool execution schema: ${schemaVersion}`);
  const executorKind = readString(row, "executor_kind");
  if (!["bash", "apply_patch", "write"].includes(executorKind)) {
    throw new Error(`Invalid harness tool executor kind: ${executorKind}`);
  }
  const state = readEnum(row, "state", HARNESS_TOOL_EXECUTION_STATES);
  const resultSummaryJson = readNullableString(row, "result_summary_json");
  return {
    schemaVersion: 1,
    id: readString(row, "id"),
    runId: readString(row, "run_id"),
    workUnitId: readString(row, "work_unit_id"),
    attemptId: readString(row, "attempt_id"),
    continuationId: readNullableString(row, "continuation_id"),
    delegationStepId: readNullableString(row, "delegation_step_id"),
    supersedesExecutionId: readNullableString(row, "supersedes_execution_id"),
    toolCallId: readString(row, "tool_call_id"),
    toolName: readString(row, "tool_name"),
    executorKind: executorKind as HarnessToolExecutionV1["executorKind"],
    state,
    requestDigest: readString(row, "request_digest"),
    sideEffectFingerprint: readString(row, "side_effect_fingerprint"),
    policySnapshotArtifactId: readString(row, "policy_snapshot_artifact_id"),
    approvalId: readNullableString(row, "approval_id"),
    sandboxProfileId: readString(row, "sandbox_profile_id"),
    claimOwner: readNullableString(row, "claim_owner"),
    claimToken: readNullableString(row, "claim_token"),
    claimExpiresAt: readNullableString(row, "claim_expires_at"),
    nextAttemptAt: readNullableString(row, "next_attempt_at"),
    executionStartedAt: readNullableString(row, "execution_started_at"),
    executionFinishedAt: readNullableString(row, "execution_finished_at"),
    resultDigest: readNullableString(row, "result_digest"),
    resultSummary: resultSummaryJson ? parseJsonObject(resultSummaryJson) : undefined,
    evidenceArtifactIds: parseJsonStringArray(readString(row, "evidence_artifact_ids_json")),
    failureCode: readNullableEnum(row, "failure_code", HARNESS_TOOL_EXECUTION_FAILURE_CODES),
    revision: readNumber(row, "revision"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function readEnum<const T extends readonly string[]>(
  row: Record<string, SQLOutputValue>,
  key: string,
  values: T,
): T[number] {
  const value = readString(row, key);
  if (!(values as readonly string[]).includes(value)) throw new Error(`Invalid harness tool execution ${key}: ${value}`);
  return value as T[number];
}

function readNullableEnum<const T extends readonly string[]>(
  row: Record<string, SQLOutputValue>,
  key: string,
  values: T,
): T[number] | undefined {
  const value = readNullableString(row, key);
  if (value !== undefined && !(values as readonly string[]).includes(value)) {
    throw new Error(`Invalid harness tool execution ${key}: ${value}`);
  }
  return value as T[number] | undefined;
}
