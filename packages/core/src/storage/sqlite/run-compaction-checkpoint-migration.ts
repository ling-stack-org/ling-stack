import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUN_COMPACTION_CHECKPOINT_MIGRATION_VERSION = 140;
export const RUN_COMPACTION_CHECKPOINT_MIGRATION_NAME = "create_run_compaction_checkpoints";

export interface RunCompactionCheckpointMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

const requiredColumns = [
  "id", "schema_version", "run_id", "attempt_id", "source_event_seq", "predecessor_id",
  "context_snapshot_artifact_id", "summary_artifact_id", "summary_content_sha256",
  "context_view_id", "provider_name", "provider_model",
  "policy_version", "objective", "constraints_json", "unresolved_tool_call_ids_json",
  "policy_snapshot_fingerprint", "workspace_provenance_watermark",
  "unresolved_approval_ids_json", "unresolved_question_ids_json", "state", "revision",
  "blocker_code", "blocker_detail", "created_at", "updated_at", "committed_at",
] as const;

export function applyRunCompactionCheckpointMigration(input: RunCompactionCheckpointMigrationInput): boolean {
  if (input.hasMigration(RUN_COMPACTION_CHECKPOINT_MIGRATION_VERSION) && hasCompleteSchema(input.database)) {
    return false;
  }

  input.database.exec("BEGIN IMMEDIATE;");
  try {
    input.database.exec(`
      CREATE TABLE IF NOT EXISTS run_compaction_checkpoints (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        source_event_seq INTEGER NOT NULL CHECK(source_event_seq >= 1),
        predecessor_id TEXT,
        context_snapshot_artifact_id TEXT NOT NULL,
        summary_artifact_id TEXT NOT NULL,
        summary_content_sha256 TEXT NOT NULL,
        context_view_id TEXT,
        provider_name TEXT NOT NULL,
        provider_model TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        policy_snapshot_fingerprint TEXT NOT NULL,
        workspace_provenance_watermark TEXT NOT NULL,
        objective TEXT NOT NULL,
        constraints_json TEXT NOT NULL DEFAULT '[]',
        unresolved_tool_call_ids_json TEXT NOT NULL DEFAULT '[]',
        unresolved_approval_ids_json TEXT NOT NULL DEFAULT '[]',
        unresolved_question_ids_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL CHECK(state IN ('prepared', 'committed', 'blocked')),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        blocker_code TEXT,
        blocker_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        committed_at TEXT,
        FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
        FOREIGN KEY(predecessor_id) REFERENCES run_compaction_checkpoints(id) ON DELETE RESTRICT,
        FOREIGN KEY(context_snapshot_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
        FOREIGN KEY(summary_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
        UNIQUE(run_id, attempt_id, source_event_seq),
        UNIQUE(run_id, predecessor_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_compaction_checkpoints_run_created
        ON run_compaction_checkpoints(run_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_run_compaction_checkpoints_attempt
        ON run_compaction_checkpoints(attempt_id, source_event_seq DESC);
      CREATE INDEX IF NOT EXISTS idx_run_compaction_checkpoints_state
        ON run_compaction_checkpoints(state, updated_at DESC);
    `);
    assertPostconditions(input.database);
    if (!input.hasMigration(RUN_COMPACTION_CHECKPOINT_MIGRATION_VERSION)) {
      input.recordMigration(RUN_COMPACTION_CHECKPOINT_MIGRATION_VERSION, RUN_COMPACTION_CHECKPOINT_MIGRATION_NAME);
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
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_compaction_checkpoints'")
    .get() as { readonly sql?: string } | undefined;
  if (!table?.sql || !table.sql.includes("UNIQUE(run_id, predecessor_id)")) {
    throw new Error("Run compaction checkpoint migration table postcondition failed.");
  }
  const columns = new Set(
    (database.prepare("PRAGMA table_info(run_compaction_checkpoints)").all() as Array<{ readonly name: string }>)
      .map((row) => row.name),
  );
  if (requiredColumns.some((column) => !columns.has(column))) {
    throw new Error("Run compaction checkpoint migration column postcondition failed.");
  }
  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check(run_compaction_checkpoints)").all();
  if (foreignKeyFailures.length > 0) {
    throw new Error("Run compaction checkpoint migration foreign-key postcondition failed.");
  }
}
