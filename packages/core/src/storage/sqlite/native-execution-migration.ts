import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const NATIVE_EXECUTION_MIGRATION_VERSION = 169;
export const NATIVE_ACP_CORRELATION_MIGRATION_VERSION = 170;
export const NATIVE_HOST_EFFECT_MIGRATION_VERSION = 171;
export const NATIVE_HOST_REPLY_MIGRATION_VERSION = 172;
export const NATIVE_HOST_TERMINAL_MIGRATION_VERSION = 173;
export const NATIVE_OPENCLAW_SESSION_MIGRATION_VERSION = 174;

export interface NativeMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
  readonly hasTable?: (tableName: string) => boolean;
  readonly hasColumn?: (tableName: string, columnName: string) => boolean;
}

// Databases from abandoned WIP checkpoints may contain this schema without the version
// markers (or with the versions taken by unrelated migration names). When the caller can
// inspect real schema state, guard on it so such databases finish migrating instead of
// crashing on duplicate CREATE/ALTER.
function tableExists(input: NativeMigrationInput, tableName: string): boolean {
  if (input.hasTable) return input.hasTable(tableName);
  const row = input.database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName);
  return row !== undefined;
}

function columnExists(input: NativeMigrationInput, tableName: string, columnName: string): boolean {
  if (input.hasColumn) return input.hasColumn(tableName, columnName);
  if (!tableExists(input, tableName)) return false;
  return input.database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((row) => (row as { name: string }).name === columnName);
}

function addColumnIfMissing(input: NativeMigrationInput, tableName: string, columnName: string, statement: string): void {
  if (!columnExists(input, tableName, columnName)) input.database.exec(statement);
}

export function applyNativeAttemptCompletionMigration(input: NativeMigrationInput): void {
  if (input.hasMigration(175) && columnExists(input, "host_attempt_completions", "native_effect_inventory_json")) return;
  input.database.exec("SAVEPOINT native_attempt_completion_migration");
  try {
    addColumnIfMissing(input, "host_attempt_completions", "native_effect_inventory_json",
      "ALTER TABLE host_attempt_completions ADD COLUMN native_effect_inventory_json TEXT");
    input.recordMigration(175, "original_native_attempt_effect_inventory");
    input.database.exec("RELEASE native_attempt_completion_migration");
  } catch (error) {
    input.database.exec("ROLLBACK TO native_attempt_completion_migration");
    input.database.exec("RELEASE native_attempt_completion_migration");
    throw error;
  }
}

export function applyNativeOpenClawSessionMigration(input: NativeMigrationInput): void {
  if (input.hasMigration(NATIVE_OPENCLAW_SESSION_MIGRATION_VERSION)
    && columnExists(input, "native_execution_bindings", "openclaw_session_key")) return;
  const db = input.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(input, "native_execution_bindings", "openclaw_agent_id",
      "ALTER TABLE native_execution_bindings ADD COLUMN openclaw_agent_id TEXT");
    addColumnIfMissing(input, "native_execution_bindings", "openclaw_session_key",
      "ALTER TABLE native_execution_bindings ADD COLUMN openclaw_session_key TEXT");
    addColumnIfMissing(input, "native_execution_bindings", "openclaw_accepted_at",
      "ALTER TABLE native_execution_bindings ADD COLUMN openclaw_accepted_at TEXT");
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS native_openclaw_session_identity ON native_execution_bindings(openclaw_session_key)
        WHERE openclaw_session_key IS NOT NULL;`);
    input.recordMigration(NATIVE_OPENCLAW_SESSION_MIGRATION_VERSION, "native_openclaw_session_identity");
    db.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(db);
    throw error;
  }
}

export function applyNativeHostTerminalMigration(input: NativeMigrationInput): void {
  if (input.hasMigration(NATIVE_HOST_TERMINAL_MIGRATION_VERSION)
    && columnExists(input, "native_host_operations", "terminal_id")) return;
  const db = input.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(input, "native_host_operations", "terminal_id",
      "ALTER TABLE native_host_operations ADD COLUMN terminal_id TEXT");
    addColumnIfMissing(input, "native_host_operations", "terminal_started_at",
      "ALTER TABLE native_host_operations ADD COLUMN terminal_started_at TEXT");
    addColumnIfMissing(input, "native_host_operations", "terminal_exit_json",
      "ALTER TABLE native_host_operations ADD COLUMN terminal_exit_json TEXT");
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS native_host_terminal_identity ON native_host_operations(submission_id, terminal_id)
        WHERE terminal_id IS NOT NULL;`);
    input.recordMigration(NATIVE_HOST_TERMINAL_MIGRATION_VERSION, "native_host_terminal_lifecycle");
    db.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(db);
    throw error;
  }
}

export function applyNativeHostReplyMigration(input: NativeMigrationInput): void {
  if (input.hasMigration(NATIVE_HOST_REPLY_MIGRATION_VERSION)
    && columnExists(input, "native_host_operations", "reply_status")) return;
  const db = input.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(input, "native_host_operations", "reply_status",
      `ALTER TABLE native_host_operations ADD COLUMN reply_status TEXT NOT NULL DEFAULT 'unknown'
      CHECK (reply_status IN ('written', 'not_written', 'unknown'))`);
    addColumnIfMissing(input, "native_host_operations", "reply_observed_at",
      "ALTER TABLE native_host_operations ADD COLUMN reply_observed_at TEXT");
    input.recordMigration(NATIVE_HOST_REPLY_MIGRATION_VERSION, "native_host_reply_observations");
    db.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(db);
    throw error;
  }
}

export function applyNativeHostEffectMigration(input: NativeMigrationInput): void {
  if (input.hasMigration(NATIVE_HOST_EFFECT_MIGRATION_VERSION) && tableExists(input, "native_host_operations")) return;
  const db = input.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS native_host_actions (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES native_submissions(id),
        tool_call_id TEXT NOT NULL,
        action_fingerprint TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        methods_json TEXT NOT NULL,
        authorization_json TEXT NOT NULL,
        approval_id TEXT UNIQUE REFERENCES native_approval_requests(approval_id),
        status TEXT NOT NULL CHECK (status IN ('reserved', 'running', 'succeeded', 'failed', 'cancelled', 'unknown')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (submission_id, tool_call_id)
      );
      CREATE TABLE IF NOT EXISTS native_host_operations (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL REFERENCES native_host_actions(id),
        submission_id TEXT NOT NULL REFERENCES native_submissions(id),
        step INTEGER NOT NULL CHECK (step >= 0 AND step < 2),
        request_key TEXT NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('fs/read_text_file', 'fs/write_text_file', 'terminal/create')),
        operation_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed', 'succeeded', 'failed', 'not_started', 'unknown')),
        result_fingerprint TEXT,
        claimed_at TEXT NOT NULL,
        settled_at TEXT,
        UNIQUE (action_id, step),
        UNIQUE (submission_id, request_key)
      );
    `);
    input.recordMigration(NATIVE_HOST_EFFECT_MIGRATION_VERSION, "native_host_effect_journal");
    db.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(db);
    throw error;
  }
}

export function applyNativeAcpCorrelationMigration(input: NativeMigrationInput): void {
  if (input.hasMigration(NATIVE_ACP_CORRELATION_MIGRATION_VERSION)
    && columnExists(input, "native_submissions", "native_prompt_request_key")) return;
  const db = input.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(input, "native_submissions", "native_prompt_request_key",
      `ALTER TABLE native_submissions ADD COLUMN native_prompt_request_key TEXT
      CHECK (native_prompt_request_key IS NULL OR native_turn_id IS NULL)`);
    input.recordMigration(NATIVE_ACP_CORRELATION_MIGRATION_VERSION, "native_acp_prompt_correlation");
    db.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(db);
    throw error;
  }
}

export function applyNativeExecutionMigration(input: NativeMigrationInput): void {
  if (input.hasMigration(NATIVE_EXECUTION_MIGRATION_VERSION) && tableExists(input, "native_execution_bindings")) return;
  const db = input.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS native_execution_bindings (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        profile_id TEXT NOT NULL,
        selection_json TEXT NOT NULL,
        native_session_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (thread_id, participant_id, generation),
        UNIQUE (profile_id, native_session_id)
      );
      CREATE TABLE IF NOT EXISTS native_submissions (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES native_execution_bindings(id),
        thread_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        work_unit_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        runtime_instance_id TEXT NOT NULL,
        fencing_token TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved', 'submission_pending', 'accepted', 'unknown',
          'not_submitted', 'rejected', 'completed', 'failed', 'cancelled')),
        native_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (binding_id, native_turn_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS native_submission_active_scope ON native_submissions(thread_id, participant_id)
        WHERE status IN ('reserved', 'submission_pending', 'accepted', 'unknown');
      CREATE TABLE IF NOT EXISTS native_approval_requests (
        approval_id TEXT PRIMARY KEY REFERENCES approval_requests(id),
        submission_id TEXT NOT NULL REFERENCES native_submissions(id),
        request_key TEXT NOT NULL,
        method TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        reply_status TEXT NOT NULL CHECK (reply_status IN ('pending', 'claimed', 'written', 'not_written', 'unknown')),
        resolved_at TEXT,
        UNIQUE (submission_id, request_key)
      );
    `);
    input.recordMigration(NATIVE_EXECUTION_MIGRATION_VERSION, "native_execution_journal");
    db.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(db);
    throw error;
  }
}
