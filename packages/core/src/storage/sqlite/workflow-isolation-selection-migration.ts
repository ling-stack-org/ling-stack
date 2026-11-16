import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKFLOW_ISOLATION_SELECTION_MIGRATION_VERSION = 211;
const name = "workflow_isolation_selections";
const definitions = [
  { type: "table", name, sql: `CREATE TABLE workflow_isolation_selections (
    workflow_id TEXT PRIMARY KEY NOT NULL REFERENCES channel_workflows(id),
    profile TEXT NOT NULL CHECK(profile='pi_host_isolated_files_v1'),
    round_id TEXT NOT NULL UNIQUE CHECK(length(round_id)>0),
    phase TEXT NOT NULL CHECK(phase IN ('planning','ready')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL CHECK(updated_at>=created_at)
  )` },
  { type: "trigger", name: "trg_workflow_isolation_selection_immutable", sql: `CREATE TRIGGER trg_workflow_isolation_selection_immutable
    BEFORE UPDATE ON workflow_isolation_selections WHEN
      NEW.workflow_id IS NOT OLD.workflow_id OR NEW.profile IS NOT OLD.profile OR NEW.round_id IS NOT OLD.round_id
      OR NEW.created_at IS NOT OLD.created_at OR OLD.phase<>'planning' OR NEW.phase<>'ready'
      OR NEW.updated_at<OLD.updated_at
    BEGIN SELECT RAISE(ABORT,'workflow_isolation.selection_immutable'); END` },
  { type: "trigger", name: "trg_workflow_isolation_selection_retained", sql: `CREATE TRIGGER trg_workflow_isolation_selection_retained
    BEFORE DELETE ON workflow_isolation_selections BEGIN SELECT RAISE(ABORT,'workflow_isolation.selection_retained'); END` },
];
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyWorkflowIsolationSelectionMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): void {
  const inspect = () => {
    if (input.database.prepare("SELECT name FROM schema_migrations WHERE version=210").get()?.name !== "workflow_parallel_parent_fences")
      throw new Error("workflow_isolation.selection_migration_predecessor_missing");
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(WORKFLOW_ISOLATION_SELECTION_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== WORKFLOW_ISOLATION_SELECTION_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(WORKFLOW_ISOLATION_SELECTION_MIGRATION_VERSION))
      throw new Error("workflow_isolation.selection_migration_marker_conflict");
    for (const definition of definitions) {
      const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(definition.name);
      if (actual && (actual.type !== definition.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition.sql)))
        throw new Error(`workflow_isolation.selection_migration_schema_conflict:${definition.name}`);
      if (markers.length && !actual) throw new Error(`workflow_isolation.selection_migration_schema_missing:${definition.name}`);
    }
    const known = new Set(definitions.map(definition => definition.name));
    if (input.database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_autoindex_%'")
      .all(name).some(row => !known.has(String(row.name)))) throw new Error("workflow_isolation.selection_migration_unexpected_object");
    if (markers.length && input.database.prepare(`PRAGMA foreign_key_check(${name})`).all().length)
      throw new Error("workflow_isolation.selection_migration_fk_conflict");
    return Boolean(markers.length);
  };
  if (inspect()) return;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions)
        if (!input.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(definition.name)) input.database.exec(definition.sql);
      input.recordMigration(WORKFLOW_ISOLATION_SELECTION_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("workflow_isolation.selection_migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}
