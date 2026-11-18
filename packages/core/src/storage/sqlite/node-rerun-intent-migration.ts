import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

// F5 durable migrations follow the mainline automation/agent migrations at 221-222.
export const NODE_RERUN_INTENT_MIGRATION_VERSION = 226;
const name = "node_rerun_intents";
const definition = `CREATE TABLE node_rerun_intents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  intent_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_attempt_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  source_snapshot_digest TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  request_json TEXT NOT NULL,
  policy_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status='prepared'),
  prepared_at TEXT NOT NULL,
  UNIQUE(workspace_id,intent_id),
  UNIQUE(workspace_id,idempotency_key)
)`;
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyNodeRerunIntentMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const db = input.database;
  const inspect = () => {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(NODE_RERUN_INTENT_MIGRATION_VERSION, name);
    if (markers.some(row => row.version !== NODE_RERUN_INTENT_MIGRATION_VERSION || row.name !== name)
      || markers.length > 1 || input.hasMigration(NODE_RERUN_INTENT_MIGRATION_VERSION) !== (markers.length === 1)) {
      throw new Error("node_rerun_intents.migration_marker_conflict");
    }
    const objects = db.prepare(`SELECT type,sql FROM main.sqlite_master WHERE name=? COLLATE NOCASE
      UNION ALL SELECT type,sql FROM temp.sqlite_master WHERE name=? COLLATE NOCASE`).all(name, name);
    if (objects.length > 1 || objects.some(row => row.type !== "table" || typeof row.sql !== "string"
      || normalize(row.sql) !== normalize(definition))) throw new Error("node_rerun_intents.migration_schema_conflict");
    if (markers.length && !objects.length) throw new Error("node_rerun_intents.migration_table_missing");
    return { recorded: markers.length === 1, exists: objects.length === 1 };
  };
  if (inspect().recorded) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = inspect();
    if (!current.exists) db.exec(definition);
    if (!current.recorded) input.recordMigration(NODE_RERUN_INTENT_MIGRATION_VERSION, name);
    if (!inspect().recorded) throw new Error("node_rerun_intents.migration_postcondition");
    db.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(db);
    throw error;
  }
}
