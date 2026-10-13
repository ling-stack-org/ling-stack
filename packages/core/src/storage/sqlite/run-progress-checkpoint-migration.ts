import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUN_PROGRESS_CHECKPOINT_MIGRATION_VERSION = 161;
const name = "create_run_progress_checkpoint_authority";
const columns = ["id", "schema_version", "kind", "run_id", "work_unit_id", "workspace_id", "source_attempt_id",
  "source_runtime_instance_id", "source_fencing_token", "source_event_seq", "predecessor_id", "model_view_artifact_id",
  "model_view_sha256", "lineage_json", "committed_at"];

export function applyRunProgressCheckpointMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): boolean {
  if (input.hasMigration(RUN_PROGRESS_CHECKPOINT_MIGRATION_VERSION)) { assertSchema(input.database); return false; }
  input.database.exec("BEGIN IMMEDIATE;");
  try {
    input.database.exec(`
      CREATE TABLE IF NOT EXISTS run_progress_checkpoints (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        kind TEXT NOT NULL CHECK(kind = 'noncompacted_model_view'),
        run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE CASCADE,
        work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
        workspace_id TEXT NOT NULL,
        source_attempt_id TEXT NOT NULL REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
        source_runtime_instance_id TEXT NOT NULL,
        source_fencing_token TEXT NOT NULL,
        source_event_seq INTEGER NOT NULL CHECK(source_event_seq >= 1),
        predecessor_id TEXT REFERENCES run_progress_checkpoints(id) ON DELETE RESTRICT,
        model_view_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
        model_view_sha256 TEXT NOT NULL,
        lineage_json TEXT NOT NULL CHECK(json_valid(lineage_json)),
        committed_at TEXT NOT NULL,
        UNIQUE(run_id, source_attempt_id, source_event_seq),
        UNIQUE(run_id, id)
      );
      CREATE TABLE IF NOT EXISTS run_progress_checkpoint_heads (
        run_id TEXT PRIMARY KEY REFERENCES run_sessions(id) ON DELETE CASCADE,
        checkpoint_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        FOREIGN KEY(run_id, checkpoint_id) REFERENCES run_progress_checkpoints(run_id, id) ON DELETE RESTRICT
      );
      CREATE TRIGGER IF NOT EXISTS run_progress_checkpoints_immutable
        BEFORE UPDATE ON run_progress_checkpoints BEGIN SELECT RAISE(ABORT, 'run progress checkpoint is immutable'); END;
    `);
    assertSchema(input.database);
    input.recordMigration(RUN_PROGRESS_CHECKPOINT_MIGRATION_VERSION, name);
    input.database.exec("COMMIT;");
    return true;
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}

function assertSchema(database: DatabaseSync): void {
  const actual = new Set(database.prepare("PRAGMA table_info(run_progress_checkpoints)").all().map(row => row.name));
  const head = new Set(database.prepare("PRAGMA table_info(run_progress_checkpoint_heads)").all().map(row => row.name));
  const sql = String(database.prepare("SELECT sql FROM sqlite_master WHERE name='run_progress_checkpoints'").get()?.sql ?? "");
  const headSql = String(database.prepare("SELECT sql FROM sqlite_master WHERE name='run_progress_checkpoint_heads'").get()?.sql ?? "");
  if (columns.some(column => !actual.has(column)) || ["run_id", "checkpoint_id", "revision"].some(column => !head.has(column))
    || !sql.includes("UNIQUE(run_id, source_attempt_id, source_event_seq)") || !sql.includes("UNIQUE(run_id, id)")
    || !headSql.includes("FOREIGN KEY(run_id, checkpoint_id) REFERENCES run_progress_checkpoints(run_id, id)")
    || !database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='run_progress_checkpoints_immutable'").get()
    || database.prepare("PRAGMA foreign_key_check(run_progress_checkpoints)").all().length
    || database.prepare("PRAGMA foreign_key_check(run_progress_checkpoint_heads)").all().length) {
    throw new Error("Run progress checkpoint migration postcondition failed.");
  }
}
