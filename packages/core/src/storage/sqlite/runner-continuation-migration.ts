import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUNNER_CONTINUATION_MIGRATION_VERSION = 135;
export const RUNNER_CONTINUATION_MIGRATION_NAME = "create_runner_continuations";

export interface RunnerContinuationMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

const requiredColumns = [
  "id",
  "schema_version",
  "run_id",
  "work_unit_id",
  "source_attempt_id",
  "target_attempt_id",
  "origin",
  "strategy",
  "state",
  "runner_id",
  "runner_capability_revision",
  "context_view_id",
  "context_snapshot_artifact_id",
  "runner_handle_ref",
  "idempotency_key",
  "claim_owner",
  "claim_token",
  "claim_expires_at",
  "next_attempt_at",
  "generation",
  "revision",
  "failure_code",
  "failure_detail_artifact_id",
  "created_at",
  "updated_at",
  "completed_at",
] as const;

const requiredIndexes = [
  "idx_runner_continuations_run_created",
  "idx_runner_continuations_claimable",
  "idx_runner_continuations_idempotency",
] as const;

/** Creates only the durable harness continuation domain. Historical runs are not synthesized. */
export function applyRunnerContinuationMigration(input: RunnerContinuationMigrationInput): boolean {
  if (input.hasMigration(RUNNER_CONTINUATION_MIGRATION_VERSION) && hasCompleteSchema(input.database)) {
    return false;
  }

  input.database.exec("BEGIN IMMEDIATE;");
  try {
    input.database.exec(`
      CREATE TABLE IF NOT EXISTS runner_continuations (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        run_id TEXT NOT NULL,
        work_unit_id TEXT NOT NULL,
        source_attempt_id TEXT NOT NULL,
        target_attempt_id TEXT,
        origin TEXT NOT NULL CHECK(origin IN (
          'manual_resume', 'queued_followup', 'interrupt_redirect',
          'approval_resume', 'runner_retry', 'daemon_recovery'
        )),
        strategy TEXT NOT NULL CHECK(strategy IN ('native_resume', 'deterministic_replay')),
        state TEXT NOT NULL CHECK(state IN (
          'requested', 'prepared', 'claimed', 'running', 'recovery_pending',
          'succeeded', 'failed', 'cancelled', 'superseded'
        )),
        runner_id TEXT NOT NULL,
        runner_capability_revision TEXT NOT NULL,
        context_view_id TEXT NOT NULL,
        context_snapshot_artifact_id TEXT NOT NULL,
        runner_handle_ref TEXT,
        idempotency_key TEXT NOT NULL,
        claim_owner TEXT,
        claim_token TEXT,
        claim_expires_at TEXT,
        next_attempt_at TEXT,
        generation INTEGER NOT NULL CHECK(generation >= 0),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN (
          'continuation.handle_missing', 'continuation.handle_rejected',
          'continuation.context_snapshot_missing', 'continuation.source_attempt_stale',
          'continuation.target_attempt_lost', 'continuation.runner_not_conformant'
        )),
        failure_detail_artifact_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK(
          (claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
          OR
          (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
        ),
        CHECK(state = 'requested' OR target_attempt_id IS NOT NULL),
        FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
        FOREIGN KEY(source_attempt_id) REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
        FOREIGN KEY(target_attempt_id) REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
        FOREIGN KEY(context_snapshot_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
        FOREIGN KEY(failure_detail_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runner_continuations_run_created
        ON runner_continuations(run_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_runner_continuations_claimable
        ON runner_continuations(state, next_attempt_at, claim_expires_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_continuations_idempotency
        ON runner_continuations(idempotency_key);
    `);

    assertPostconditions(input.database);
    if (!input.hasMigration(RUNNER_CONTINUATION_MIGRATION_VERSION)) {
      input.recordMigration(RUNNER_CONTINUATION_MIGRATION_VERSION, RUNNER_CONTINUATION_MIGRATION_NAME);
    }
    if (!input.hasMigration(RUNNER_CONTINUATION_MIGRATION_VERSION)) {
      throw new Error("Runner continuation migration marker postcondition failed.");
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
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runner_continuations'")
    .get() as { readonly sql?: string } | undefined;
  if (!table?.sql || !table.sql.includes("claim_token") || !table.sql.includes("continuation.target_attempt_lost")) {
    throw new Error("Runner continuation migration table postcondition failed.");
  }
  const columns = new Set(
    (database.prepare("PRAGMA table_info(runner_continuations)").all() as Array<{ readonly name: string }>)
      .map((row) => row.name),
  );
  if (requiredColumns.some((column) => !columns.has(column))) {
    throw new Error("Runner continuation migration column postcondition failed.");
  }
  const indexes = new Set(
    (database.prepare("PRAGMA index_list(runner_continuations)").all() as Array<{ readonly name: string }>)
      .map((row) => row.name),
  );
  if (requiredIndexes.some((index) => !indexes.has(index))) {
    throw new Error("Runner continuation migration index postcondition failed.");
  }
  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check(runner_continuations)").all();
  if (foreignKeyFailures.length > 0) {
    throw new Error("Runner continuation migration foreign-key postcondition failed.");
  }
}
