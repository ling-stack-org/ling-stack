import type { SQLOutputValue } from "node:sqlite";
import {
  RUNNER_CONTINUATION_FAILURE_CODES,
  RUNNER_CONTINUATION_ORIGINS,
  RUNNER_CONTINUATION_STATES,
  RUNNER_CONTINUATION_STRATEGIES,
  type RunnerContinuationV1,
} from "@ling-stack/contracts";
import {
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";
import { normalizeStoredRunnerId } from "./runtime-work-mappers.js";

export function runnerContinuationSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      schema_version,
      run_id,
      work_unit_id,
      source_attempt_id,
      target_attempt_id,
      origin,
      strategy,
      state,
      runner_id,
      runner_capability_revision,
      context_view_id,
      context_snapshot_artifact_id,
      runner_handle_ref,
      idempotency_key,
      claim_owner,
      claim_token,
      claim_expires_at,
      next_attempt_at,
      generation,
      revision,
      failure_code,
      failure_detail_artifact_id,
      created_at,
      updated_at,
      completed_at
    FROM runner_continuations
    ${whereClause}
  `;
}

export function mapRunnerContinuation(row: Record<string, SQLOutputValue>): RunnerContinuationV1 {
  const schemaVersion = readNumber(row, "schema_version");
  if (schemaVersion !== 1) throw new Error(`Unsupported runner continuation schema: ${schemaVersion}`);
  const origin = readEnum(row, "origin", RUNNER_CONTINUATION_ORIGINS);
  const strategy = readEnum(row, "strategy", RUNNER_CONTINUATION_STRATEGIES);
  const state = readEnum(row, "state", RUNNER_CONTINUATION_STATES);
  const failureCode = readNullableEnum(row, "failure_code", RUNNER_CONTINUATION_FAILURE_CODES);
  return {
    schemaVersion: 1,
    id: readString(row, "id"),
    runId: readString(row, "run_id"),
    workUnitId: readString(row, "work_unit_id"),
    sourceAttemptId: readString(row, "source_attempt_id"),
    targetAttemptId: readNullableString(row, "target_attempt_id"),
    origin,
    strategy,
    state,
    runnerId: normalizeStoredRunnerId(readString(row, "runner_id")) ?? readString(row, "runner_id"),
    runnerCapabilityRevision: readString(row, "runner_capability_revision"),
    contextViewId: readString(row, "context_view_id"),
    contextSnapshotArtifactId: readString(row, "context_snapshot_artifact_id"),
    runnerHandleRef: readNullableString(row, "runner_handle_ref"),
    idempotencyKey: readString(row, "idempotency_key"),
    claimOwner: readNullableString(row, "claim_owner"),
    claimToken: readNullableString(row, "claim_token"),
    claimExpiresAt: readNullableString(row, "claim_expires_at"),
    nextAttemptAt: readNullableString(row, "next_attempt_at"),
    generation: readNumber(row, "generation"),
    revision: readNumber(row, "revision"),
    failureCode,
    failureDetailArtifactId: readNullableString(row, "failure_detail_artifact_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    completedAt: readNullableString(row, "completed_at"),
  };
}

function readEnum<const T extends readonly string[]>(
  row: Record<string, SQLOutputValue>,
  key: string,
  values: T,
): T[number] {
  const value = readString(row, key);
  if (!(values as readonly string[]).includes(value)) throw new Error(`Invalid runner continuation ${key}: ${value}`);
  return value as T[number];
}

function readNullableEnum<const T extends readonly string[]>(
  row: Record<string, SQLOutputValue>,
  key: string,
  values: T,
): T[number] | undefined {
  const value = readNullableString(row, key);
  if (value !== undefined && !(values as readonly string[]).includes(value)) {
    throw new Error(`Invalid runner continuation ${key}: ${value}`);
  }
  return value as T[number] | undefined;
}
