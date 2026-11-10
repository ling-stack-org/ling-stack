import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKFLOW_PARALLEL_PARENT_MIGRATION_VERSION = 210;
const name = "workflow_parallel_parent_fences";
const definitions = [
  { type: "table", name, sql: `CREATE TABLE workflow_parallel_parent_fences (
    round_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    common_dir TEXT NOT NULL CHECK(length(common_dir)>0),
    inputs_digest TEXT NOT NULL CHECK(length(inputs_digest)>0),
    state TEXT NOT NULL CHECK(state IN ('held','released')),
    created_at TEXT NOT NULL,
    released_at TEXT,
    PRIMARY KEY(round_id,generation),
    FOREIGN KEY(round_id,generation) REFERENCES workflow_integration_generations(round_id,generation),
    CHECK((state='held' AND released_at IS NULL) OR (state='released' AND released_at IS NOT NULL))
  )` },
  { type: "index", name: "idx_workflow_parallel_parent_workspace", sql: `CREATE UNIQUE INDEX idx_workflow_parallel_parent_workspace
    ON workflow_parallel_parent_fences(workspace_id) WHERE state='held'` },
  { type: "index", name: "idx_workflow_parallel_parent_common_dir", sql: `CREATE UNIQUE INDEX idx_workflow_parallel_parent_common_dir
    ON workflow_parallel_parent_fences(common_dir) WHERE state='held'` },
  { type: "trigger", name: "trg_workflow_parallel_parent_immutable", sql: `CREATE TRIGGER trg_workflow_parallel_parent_immutable
    BEFORE UPDATE ON workflow_parallel_parent_fences WHEN
      NEW.round_id IS NOT OLD.round_id OR NEW.generation IS NOT OLD.generation OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.common_dir IS NOT OLD.common_dir OR NEW.inputs_digest IS NOT OLD.inputs_digest OR NEW.created_at IS NOT OLD.created_at
      OR OLD.state<>'held' OR NEW.state<>'released' OR NEW.released_at IS NULL
    BEGIN SELECT RAISE(ABORT,'workflow_parallel.parent_immutable'); END` },
  { type: "trigger", name: "trg_workflow_parallel_parent_retained", sql: `CREATE TRIGGER trg_workflow_parallel_parent_retained
    BEFORE DELETE ON workflow_parallel_parent_fences BEGIN SELECT RAISE(ABORT,'workflow_parallel.parent_retained'); END` },
];
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Persistent shared-parent ownership is independent of individual leases and their TTL. */
export function applyWorkflowParallelParentMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): void {
  const inspect = () => {
    if (input.database.prepare("SELECT name FROM schema_migrations WHERE version=209").get()?.name !== "workflow_worktree_cleanup_journal")
      throw new Error("workflow_parallel.migration_predecessor_missing");
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(WORKFLOW_PARALLEL_PARENT_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== WORKFLOW_PARALLEL_PARENT_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(WORKFLOW_PARALLEL_PARENT_MIGRATION_VERSION))
      throw new Error("workflow_parallel.migration_marker_conflict");
    const known = new Set(definitions.map(definition => definition.name));
    for (const definition of definitions) {
      const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(definition.name);
      if (actual && (actual.type !== definition.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition.sql)))
        throw new Error(`workflow_parallel.migration_schema_conflict:${definition.name}`);
      if (markers.length && !actual) throw new Error(`workflow_parallel.migration_schema_missing:${definition.name}`);
    }
    if (input.database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_autoindex_%'")
      .all(name).some(row => !known.has(String(row.name)))) throw new Error("workflow_parallel.migration_unexpected_object");
    if (markers.length && input.database.prepare(`PRAGMA foreign_key_check(${name})`).all().length)
      throw new Error("workflow_parallel.migration_fk_conflict");
    return Boolean(markers.length);
  };
  if (inspect()) return;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions)
        if (!input.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(definition.name)) input.database.exec(definition.sql);
      input.recordMigration(WORKFLOW_PARALLEL_PARENT_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("workflow_parallel.migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}
