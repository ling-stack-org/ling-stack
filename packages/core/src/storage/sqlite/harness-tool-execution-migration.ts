import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const HARNESS_TOOL_EXECUTION_MIGRATION_VERSION = 136;
export const HARNESS_TOOL_EXECUTION_MIGRATION_NAME = "create_harness_tool_executions";

export interface HarnessToolExecutionMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

const requiredColumns = [
  "id", "schema_version", "run_id", "work_unit_id", "attempt_id", "continuation_id",
  "delegation_step_id", "supersedes_execution_id", "tool_call_id", "tool_name", "executor_kind", "state",
  "request_digest", "side_effect_fingerprint", "policy_snapshot_artifact_id", "approval_id",
  "sandbox_profile_id", "claim_owner", "claim_token", "claim_expires_at", "next_attempt_at",
  "execution_started_at", "execution_finished_at", "result_digest", "result_summary_json",
  "failure_code", "revision", "created_at", "updated_at",
] as const;

const requiredIndexes = [
  "idx_harness_tool_executions_run_created",
  "idx_harness_tool_executions_claimable",
  "idx_harness_tool_executions_attempt_call",
  "idx_harness_tool_executions_supersedes",
  "idx_harness_tool_executions_approval",
  "idx_harness_tool_executions_side_effect",
  "idx_harness_tool_execution_artifacts_artifact",
] as const;

/** Creates the durable Tool Broker domain without synthesizing historical tool calls. */
export function applyHarnessToolExecutionMigration(input: HarnessToolExecutionMigrationInput): boolean {
  if (input.hasMigration(HARNESS_TOOL_EXECUTION_MIGRATION_VERSION) && hasCompleteSchema(input.database)) {
    return false;
  }
  input.database.exec("BEGIN IMMEDIATE;");
  try {
    input.database.exec(`
      CREATE TABLE IF NOT EXISTS harness_tool_executions (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        run_id TEXT NOT NULL,
        work_unit_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        continuation_id TEXT,
        delegation_step_id TEXT,
        supersedes_execution_id TEXT,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        executor_kind TEXT NOT NULL CHECK(executor_kind IN ('bash', 'apply_patch', 'write')),
        state TEXT NOT NULL CHECK(state IN (
          'proposed', 'prepared', 'approval_pending', 'approved', 'claimed', 'executing',
          'committing_evidence', 'succeeded', 'denied', 'failed', 'cancelled',
          'superseded', 'unknown_outcome'
        )),
        request_digest TEXT NOT NULL,
        side_effect_fingerprint TEXT NOT NULL,
        policy_snapshot_artifact_id TEXT NOT NULL,
        approval_id TEXT,
        sandbox_profile_id TEXT NOT NULL,
        claim_owner TEXT,
        claim_token TEXT,
        claim_expires_at TEXT,
        next_attempt_at TEXT,
        execution_started_at TEXT,
        execution_finished_at TEXT,
        result_digest TEXT,
        result_summary_json TEXT,
        failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN (
          'tool.invalid_request', 'tool.policy_denied', 'tool.approval_denied',
          'tool.sandbox_unavailable', 'tool.executor_failed', 'tool.execution_timeout',
          'tool.execution_cancelled', 'tool.stale_attempt', 'tool.evidence_commit_failed',
          'tool.unknown_side_effect_outcome'
        )),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(length(request_digest) = 64),
        CHECK(length(side_effect_fingerprint) = 64),
        CHECK(result_digest IS NULL OR length(result_digest) = 64),
        CHECK(
          (claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
          OR
          (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
        ),
        CHECK(state NOT IN ('executing', 'committing_evidence', 'succeeded', 'unknown_outcome')
          OR execution_started_at IS NOT NULL),
        CHECK(state NOT IN ('succeeded', 'denied', 'failed', 'cancelled', 'superseded', 'unknown_outcome')
          OR execution_finished_at IS NOT NULL),
        FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
        FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
        FOREIGN KEY(continuation_id) REFERENCES runner_continuations(id) ON DELETE SET NULL,
        FOREIGN KEY(supersedes_execution_id) REFERENCES harness_tool_executions(id) ON DELETE SET NULL,
        FOREIGN KEY(policy_snapshot_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
        FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_tool_executions_attempt_call
        ON harness_tool_executions(attempt_id, tool_call_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_tool_executions_supersedes
        ON harness_tool_executions(supersedes_execution_id)
        WHERE supersedes_execution_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_harness_tool_executions_run_created
        ON harness_tool_executions(run_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_harness_tool_executions_claimable
        ON harness_tool_executions(state, next_attempt_at, claim_expires_at, id);
      CREATE INDEX IF NOT EXISTS idx_harness_tool_executions_approval
        ON harness_tool_executions(approval_id, id);
      CREATE INDEX IF NOT EXISTS idx_harness_tool_executions_side_effect
        ON harness_tool_executions(side_effect_fingerprint, id);

      CREATE TABLE IF NOT EXISTS harness_tool_execution_artifacts (
        execution_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        PRIMARY KEY(execution_id, artifact_id),
        UNIQUE(execution_id, ordinal),
        FOREIGN KEY(execution_id) REFERENCES harness_tool_executions(id) ON DELETE CASCADE,
        FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_harness_tool_execution_artifacts_artifact
        ON harness_tool_execution_artifacts(artifact_id, execution_id);
    `);
    assertPostconditions(input.database);
    if (!input.hasMigration(HARNESS_TOOL_EXECUTION_MIGRATION_VERSION)) {
      input.recordMigration(HARNESS_TOOL_EXECUTION_MIGRATION_VERSION, HARNESS_TOOL_EXECUTION_MIGRATION_NAME);
    }
    if (!input.hasMigration(HARNESS_TOOL_EXECUTION_MIGRATION_VERSION)) {
      throw new Error("Harness tool execution migration marker postcondition failed.");
    }
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}

function hasCompleteSchema(database: DatabaseSync): boolean {
  try {
    assertPostconditions(database);
    return true;
  } catch {
    return false;
  }
}

function assertPostconditions(database: DatabaseSync): void {
  const table = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='harness_tool_executions'",
  ).get() as { readonly sql?: string } | undefined;
  const artifacts = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='harness_tool_execution_artifacts'",
  ).get() as { readonly sql?: string } | undefined;
  if (!table?.sql || !table.sql.includes("tool.unknown_side_effect_outcome") || !artifacts?.sql) {
    throw new Error("Harness tool execution migration table postcondition failed.");
  }
  const columns = new Set((database.prepare("PRAGMA table_info(harness_tool_executions)").all() as
    Array<{ readonly name: string }>).map((row) => row.name));
  if (requiredColumns.some((column) => !columns.has(column))) {
    throw new Error("Harness tool execution migration column postcondition failed.");
  }
  const indexes = new Set([
    ...(database.prepare("PRAGMA index_list(harness_tool_executions)").all() as Array<{ readonly name: string }>),
    ...(database.prepare("PRAGMA index_list(harness_tool_execution_artifacts)").all() as Array<{ readonly name: string }>),
  ].map((row) => row.name));
  if (requiredIndexes.some((index) => !indexes.has(index))) {
    throw new Error("Harness tool execution migration index postcondition failed.");
  }
  if (database.prepare("PRAGMA foreign_key_check(harness_tool_executions)").all().length > 0
    || database.prepare("PRAGMA foreign_key_check(harness_tool_execution_artifacts)").all().length > 0) {
    throw new Error("Harness tool execution migration foreign-key postcondition failed.");
  }
}
