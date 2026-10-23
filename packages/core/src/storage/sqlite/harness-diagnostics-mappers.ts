import type { SQLOutputValue } from "node:sqlite";
import {
  DELEGATION_FAILURE_CODES,
  DELEGATION_STEP_STATES,
  HARNESS_TOOL_EXECUTION_FAILURE_CODES,
  HARNESS_TOOL_EXECUTION_STATES,
  RUN_EVALUATION_FAILURE_CODES,
  RUN_EVALUATION_STATES,
  RUNNER_CONTINUATION_FAILURE_CODES,
  RUNNER_CONTINUATION_ORIGINS,
  RUNNER_CONTINUATION_STATES,
  RUNNER_CONTINUATION_STRATEGIES,
  type HarnessDiagnosticAttemptV1,
  type HarnessDiagnosticRecordV1,
  type HarnessDiagnosticScopeV1,
  type WorkUnitAttemptStatus,
} from "@ling-stack/contracts";
import { assertRecoveryDiscoveryId, assertRecoveryDiscoveryTimestamp } from "./recovery-discovery-validation.js";
import { HarnessDiagnosticsStoreError } from "./harness-diagnostics-validation.js";

type Row = Record<string, SQLOutputValue>;

/** Scope discovery never parses WorkUnit requests or Run snapshots. Missing links remain explicit. */
export function mapHarnessDiagnosticScope(row: Row): HarnessDiagnosticScopeV1 {
  const workUnitId = identity(row, "work_unit_id");
  const runId = optionalIdentity(row, "linked_run_id");
  if (runId === undefined) return { workUnitId, status: "run_unlinked" };
  const observedRunId = optionalIdentity(row, "run_id");
  if (observedRunId === undefined) return { workUnitId, runId, status: "run_missing" };
  const runWorkUnitId = optionalIdentity(row, "run_work_unit_id");
  return {
    workUnitId, runId,
    status: observedRunId === runId && runWorkUnitId === workUnitId ? "available" : "lineage_mismatch",
  };
}

const attemptStatuses = {
  created: true, started: true, waiting_for_approval: true, cancelling: true, yielded: true,
  succeeded: true, failed: true, cancelled: true, lost: true,
} satisfies Readonly<Record<WorkUnitAttemptStatus, true>>;

/** A foreign Attempt is only an ownership diagnosis: no foreign owner, runtime, fence or state is disclosed. */
export function mapHarnessDiagnosticAttempt(row: Row | undefined, workUnitId: string, attemptId: string): HarnessDiagnosticAttemptV1 {
  if (!row) return { id: attemptId, status: "missing" };
  const id = identity(row, "id");
  const ownerId = identity(row, "work_unit_id");
  if (id !== attemptId) invalidRecord("attempt identity");
  if (ownerId !== workUnitId) return { id, status: "ownership_mismatch" };
  const attemptStatus = identity(row, "status");
  if (!Object.hasOwn(attemptStatuses, attemptStatus)) invalidRecord("attempt status");
  return {
    id, status: "observed", workUnitId: ownerId,
    runtimeInstanceId: identity(row, "runtime_instance_id"),
    fencingToken: identity(row, "fencing_token"),
    attemptStatus,
  };
}

/** Deliberate allowlist construction. Never spread execution records or retrieve private payload columns. */
export function mapHarnessDiagnostic(row: Row): HarnessDiagnosticRecordV1 {
  if (integer(row, "schema_version") !== 1) invalidRecord("schema_version");
  const common = {
    id: identity(row, "id"),
    runId: identity(row, "run_id"),
    workUnitId: identity(row, "work_unit_id"),
    revision: integer(row, "revision"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
    claimOwner: optionalIdentity(row, "claim_owner"),
    claimExpiresAt: optionalTimestamp(row, "claim_expires_at"),
    nextAttemptAt: optionalTimestamp(row, "next_attempt_at"),
  };
  if ((common.claimOwner === undefined) !== (common.claimExpiresAt === undefined)) invalidRecord("claim lease");
  if (row.kind === "continuation") {
    return {
      ...common,
      kind: "continuation",
      state: enumeration(row, "state", RUNNER_CONTINUATION_STATES),
      sourceAttemptId: identity(row, "source_attempt_id"),
      targetAttemptId: optionalIdentity(row, "target_attempt_id"),
      origin: enumeration(row, "origin", RUNNER_CONTINUATION_ORIGINS),
      strategy: enumeration(row, "strategy", RUNNER_CONTINUATION_STRATEGIES),
      runnerId: identity(row, "runner_id"),
      generation: integer(row, "generation"),
      failureCode: optionalEnumeration(row, "failure_code", RUNNER_CONTINUATION_FAILURE_CODES),
      failureDetailArtifactId: optionalIdentity(row, "failure_detail_artifact_id"),
      completedAt: optionalTimestamp(row, "completed_at"),
    };
  }
  if (row.kind === "tool_execution") {
    return {
      ...common,
      kind: "tool_execution",
      state: enumeration(row, "state", HARNESS_TOOL_EXECUTION_STATES),
      attemptId: identity(row, "attempt_id"),
      toolCallId: identity(row, "tool_call_id"),
      toolName: identity(row, "tool_name"),
      executorKind: enumeration(row, "executor_kind", ["bash", "apply_patch", "write"] as const),
      continuationId: optionalIdentity(row, "continuation_id"),
      delegationStepId: optionalIdentity(row, "delegation_step_id"),
      supersedesExecutionId: optionalIdentity(row, "supersedes_execution_id"),
      policySnapshotArtifactId: identity(row, "policy_snapshot_artifact_id"),
      approvalId: optionalIdentity(row, "approval_id"),
      sandboxProfileId: identity(row, "sandbox_profile_id"),
      failureCode: optionalEnumeration(row, "failure_code", HARNESS_TOOL_EXECUTION_FAILURE_CODES),
      executionStartedAt: optionalTimestamp(row, "execution_started_at"),
      executionFinishedAt: optionalTimestamp(row, "execution_finished_at"),
    };
  }
  if (row.kind === "evaluation") {
    return {
      ...common,
      kind: "evaluation",
      rootRunId: identity(row, "root_run_id"),
      state: enumeration(row, "state", RUN_EVALUATION_STATES),
      failureCode: optionalEnumeration(row, "failure_code", RUN_EVALUATION_FAILURE_CODES),
      completedAt: optionalTimestamp(row, "completed_at"),
    };
  }
  if (row.kind === "delegation") {
    const workflowId = optionalIdentity(row, "workflow_id");
    const workflowStepId = optionalIdentity(row, "workflow_step_id");
    if (workflowStepId !== undefined && workflowId === undefined) invalidRecord("workflow lineage");
    return {
      ...common,
      kind: "delegation",
      rootRunId: identity(row, "root_run_id"),
      state: enumeration(row, "state", DELEGATION_STEP_STATES),
      parentAttemptId: identity(row, "parent_attempt_id"),
      workflowId,
      workflowStepId,
      parentDelegationStepId: optionalIdentity(row, "parent_delegation_step_id"),
      childRunId: optionalIdentity(row, "child_run_id"),
      required: booleanInteger(row, "required"),
      depth: positiveInteger(row, "depth"),
      failureCode: optionalEnumeration(row, "failure_code", DELEGATION_FAILURE_CODES),
      completedAt: optionalTimestamp(row, "completed_at"),
    };
  }
  return invalidRecord("kind");
}

function identity(row: Row, key: string): string {
  const value = row[key];
  try { assertRecoveryDiscoveryId(value); return value; } catch { return invalidRecord(key); }
}

function optionalIdentity(row: Row, key: string): string | undefined {
  return row[key] === null ? undefined : identity(row, key);
}

function timestamp(row: Row, key: string): string {
  const value = row[key];
  try { assertRecoveryDiscoveryTimestamp(value, key); return value; } catch { return invalidRecord(key); }
}

function optionalTimestamp(row: Row, key: string): string | undefined {
  return row[key] === null ? undefined : timestamp(row, key);
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) invalidRecord(key);
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalidRecord(key);
  return value;
}

function positiveInteger(row: Row, key: string): number {
  const value = integer(row, key);
  if (value < 1) invalidRecord(key);
  return value;
}

function booleanInteger(row: Row, key: string): boolean {
  const value = integer(row, key);
  if (value !== 0 && value !== 1) invalidRecord(key);
  return value === 1;
}

function enumeration<const T extends readonly string[]>(row: Row, key: string, values: T): T[number] {
  const value = row[key];
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) invalidRecord(key);
  return value as T[number];
}

function optionalEnumeration<const T extends readonly string[]>(row: Row, key: string, values: T): T[number] | undefined {
  return row[key] === null ? undefined : enumeration(row, key, values);
}

function invalidRecord(field: string): never {
  throw new HarnessDiagnosticsStoreError("diagnostics.record_invalid", `Invalid Harness diagnostics metadata field: ${field}.`);
}
