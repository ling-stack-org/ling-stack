import type { SQLOutputValue } from "node:sqlite";
import {
  DELEGATION_FAILURE_CODES,
  DELEGATION_STEP_STATES,
  type DelegationMessageDirection,
  type DelegationMessageKind,
  type DelegationMessageV1,
  type DelegationStepV1,
} from "@ling-stack/contracts";
import { DelegationReadError } from "../../harness/delegations.js";

type Row = Record<string, SQLOutputValue>;
const directions: Readonly<Record<DelegationMessageDirection, true>> = { parent_to_child: true, child_to_parent: true };
const kinds: Readonly<Record<DelegationMessageKind, true>> = { instruction: true, progress: true, result: true, control: true };
const terminalStates = new Set<string>(["succeeded", "failed", "cancelled", "lost"]);
const boundChildStates = new Set<string>(["running", "waiting", "interrupting", "interrupted", "resuming", "succeeded"]);

/** The clause is an authored SQL fragment, never caller-supplied SQL. */
export function delegationStepSelectSql(clause: string): string {
  return `SELECT id, schema_version, root_run_id, parent_run_id, parent_attempt_id, workflow_id,
    workflow_step_id, parent_delegation_step_id, child_run_id, spawn_call_id, objective_artifact_id,
    required, state, depth, permission_snapshot_artifact_id, tool_allowlist_artifact_id,
    workspace_scope_artifact_id, provider_policy_artifact_id, token_budget, cost_budget_micros,
    wall_time_budget_ms, idempotency_key, revision, failure_code, created_at, updated_at, completed_at
    FROM delegation_steps ${clause}`;
}

export function delegationMessageSelectSql(clause: string): string {
  return `SELECT id, schema_version, delegation_step_id, direction, kind, body_artifact_id,
    digest, idempotency_key, created_at FROM delegation_messages ${clause}`;
}

/** Validates persisted V1 shape only: no artifact, lineage, fence or capability certification. */
export function mapDelegationStep(row: Row): DelegationStepV1 {
  schema(row);
  const required = value(row, "required");
  if (required !== 0 && required !== 1 && required !== 0n && required !== 1n) invalid("required");
  const step: DelegationStepV1 = {
    schemaVersion: 1,
    id: text(row, "id", true),
    rootRunId: text(row, "root_run_id"),
    parentRunId: text(row, "parent_run_id"),
    parentAttemptId: text(row, "parent_attempt_id"),
    workflowId: nullableText(row, "workflow_id"),
    workflowStepId: nullableText(row, "workflow_step_id"),
    parentDelegationStepId: nullableText(row, "parent_delegation_step_id"),
    childRunId: nullableText(row, "child_run_id"),
    spawnCallId: text(row, "spawn_call_id", true),
    objectiveArtifactId: text(row, "objective_artifact_id"),
    required: required === 1 || required === 1n,
    state: enumeration(row, "state", DELEGATION_STEP_STATES),
    depth: integer(row, "depth", 1),
    permissionSnapshotArtifactId: text(row, "permission_snapshot_artifact_id"),
    toolAllowlistArtifactId: text(row, "tool_allowlist_artifact_id"),
    workspaceScopeArtifactId: text(row, "workspace_scope_artifact_id"),
    providerPolicyArtifactId: text(row, "provider_policy_artifact_id"),
    tokenBudget: nullableInteger(row, "token_budget"),
    costBudgetMicros: nullableInteger(row, "cost_budget_micros"),
    wallTimeBudgetMs: nullableInteger(row, "wall_time_budget_ms"),
    idempotencyKey: text(row, "idempotency_key", true),
    revision: integer(row, "revision", 0),
    failureCode: nullableEnumeration(row, "failure_code", DELEGATION_FAILURE_CODES),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    completedAt: nullableText(row, "completed_at"),
  };
  if ((step.workflowStepId !== undefined && step.workflowId === undefined)
    || step.parentDelegationStepId === step.id
    || (step.parentDelegationStepId === undefined ? step.depth !== 1 : step.depth < 2)
    || (step.childRunId !== undefined && (step.childRunId === step.parentRunId || step.childRunId === step.rootRunId))
    || (step.state === "planned" && step.childRunId !== undefined)
    || (boundChildStates.has(step.state) && step.childRunId === undefined)
    || (terminalStates.has(step.state) !== (step.completedAt !== undefined))
    || (step.state === "succeeded" && step.failureCode !== undefined)) invalid("step structure");
  return step;
}

export function mapDelegationMessage(row: Row): DelegationMessageV1 {
  schema(row);
  const direction = text(row, "direction");
  const kind = text(row, "kind");
  if (!Object.hasOwn(directions, direction)) invalid("direction");
  if (!Object.hasOwn(kinds, kind)) invalid("kind");
  const digest = text(row, "digest", true);
  if (!/^[a-f0-9]{64}$/u.test(digest)) invalid("digest");
  return {
    schemaVersion: 1,
    id: text(row, "id", true),
    delegationStepId: text(row, "delegation_step_id"),
    direction: direction as DelegationMessageDirection,
    kind: kind as DelegationMessageKind,
    bodyArtifactId: text(row, "body_artifact_id"),
    digest,
    idempotencyKey: text(row, "idempotency_key", true),
    createdAt: text(row, "created_at"),
  };
}

function invalid(column: string): never {
  throw new DelegationReadError("invalid_persisted_row", `Invalid delegation SQLite ${column}`);
}

function value(row: Row, key: string): SQLOutputValue {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) invalid(key);
  return descriptor.value as SQLOutputValue;
}

function text(row: Row, key: string, rejectNul = false): string {
  const entry = value(row, key);
  // SQLite length(text) stops at NUL. Preserve all other schema-legal raw strings.
  if (typeof entry !== "string" || entry.length === 0 || entry.startsWith("\0") || (rejectNul && entry.includes("\0"))) invalid(key);
  return entry;
}

function nullableText(row: Row, key: string): string | undefined {
  return value(row, key) === null ? undefined : text(row, key);
}

function integer(row: Row, key: string, minimum: number): number {
  const entry = value(row, key);
  if (typeof entry === "bigint") {
    if (entry < BigInt(minimum) || entry > BigInt(Number.MAX_SAFE_INTEGER)) invalid(key);
    return Number(entry);
  }
  if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < minimum) invalid(key);
  return entry;
}

function nullableInteger(row: Row, key: string): number | undefined {
  return value(row, key) === null ? undefined : integer(row, key, 0);
}

function schema(row: Row): void {
  if (integer(row, "schema_version", 0) !== 1) invalid("schema_version");
}

function enumeration<const T extends readonly string[]>(row: Row, key: string, entries: T): T[number] {
  const entry = text(row, key);
  if (!(entries as readonly string[]).includes(entry)) invalid(key);
  return entry as T[number];
}

function nullableEnumeration<const T extends readonly string[]>(row: Row, key: string, entries: T): T[number] | undefined {
  return value(row, key) === null ? undefined : enumeration(row, key, entries);
}
