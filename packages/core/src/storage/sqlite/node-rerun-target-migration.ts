import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { NODE_RERUN_APPROVAL_MIGRATION_VERSION } from "./node-rerun-approval-migration.js";

export const NODE_RERUN_TARGET_MIGRATION_VERSION = 228;
const name = "node_rerun_targets";
const table = `CREATE TABLE node_rerun_targets (
  intent_id TEXT PRIMARY KEY REFERENCES node_rerun_intents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL UNIQUE,
  basis_sha256 TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_attempt_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL UNIQUE,
  work_unit_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL UNIQUE,
  runtime_instance_id TEXT NOT NULL,
  fencing_token TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  execution_sha256 TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  released_at TEXT
)`;
const indexName = "idx_node_rerun_targets_active_source";
const index = `CREATE UNIQUE INDEX idx_node_rerun_targets_active_source
  ON node_rerun_targets(workspace_id,source_attempt_id,source_node_id) WHERE released_at IS NULL`;
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive custody records deliberately outlive Run/approval history cleanup. */
export function applyNodeRerunTargetMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const db = input.database;
  const objects = (objectName: string) => db.prepare(`SELECT type,sql FROM main.sqlite_master WHERE name=? COLLATE NOCASE
    UNION ALL SELECT type,sql FROM temp.sqlite_master WHERE name=? COLLATE NOCASE`).all(objectName, objectName);
  const inspect = () => {
    const predecessor = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name='node_rerun_approval_owner'")
      .all(NODE_RERUN_APPROVAL_MIGRATION_VERSION);
    if (predecessor.length !== 1 || predecessor[0]!.version !== NODE_RERUN_APPROVAL_MIGRATION_VERSION
      || predecessor[0]!.name !== "node_rerun_approval_owner" || !input.hasMigration(NODE_RERUN_APPROVAL_MIGRATION_VERSION))
      throw new Error("node_rerun_target.migration_predecessor_missing");
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(NODE_RERUN_TARGET_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== NODE_RERUN_TARGET_MIGRATION_VERSION || row.name !== name)
      || input.hasMigration(NODE_RERUN_TARGET_MIGRATION_VERSION) !== (markers.length === 1))
      throw new Error("node_rerun_target.migration_marker_conflict");
    const installed = markers.length === 1;
    for (const [objectName, kind, sql] of [[name, "table", table], [indexName, "index", index]] as const) {
      const found = objects(objectName);
      if (installed ? found.length !== 1 || found[0]!.type !== kind || typeof found[0]!.sql !== "string"
        || normalize(found[0]!.sql) !== normalize(sql) : found.length !== 0)
        throw new Error(`node_rerun_target.migration_schema_conflict:${objectName}`);
    }
    if (db.prepare("SELECT name FROM main.sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL AND name<>?")
      .all(name, indexName).length)
      throw new Error("node_rerun_target.migration_unexpected_object");
    if (installed && db.prepare("PRAGMA foreign_key_check(node_rerun_targets)").all().length)
      throw new Error("node_rerun_target.migration_fk_conflict");
    return installed;
  };
  if (inspect()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      db.exec(table);
      db.exec(index);
      input.recordMigration(NODE_RERUN_TARGET_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("node_rerun_target.migration_postcondition");
    db.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
