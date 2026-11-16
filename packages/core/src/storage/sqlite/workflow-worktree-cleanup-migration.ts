import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKFLOW_WORKTREE_CLEANUP_MIGRATION_VERSION = 209;
const name = "workflow_worktree_cleanup_journal";
const tables = ["workflow_worktree_cleanup_intents", "workflow_worktree_cleanup_receipts"];
const definitions = [
  { type: "table", name: tables[0]!, sql: `CREATE TABLE workflow_worktree_cleanup_intents (
    cleanup_id TEXT NOT NULL PRIMARY KEY,
    round_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0),
    workflow_id TEXT NOT NULL REFERENCES channel_workflows(id),
    worktree_id TEXT NOT NULL,
    owner_token TEXT NOT NULL UNIQUE CHECK(length(owner_token)>0),
    plan_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    plan_content_sha256 TEXT NOT NULL,
    plan_digest TEXT NOT NULL,
    retained_artifacts_json TEXT NOT NULL CHECK(json_valid(retained_artifacts_json)),
    intent_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(round_id,generation) REFERENCES workflow_integration_generations(round_id,generation),
    UNIQUE(round_id,generation,worktree_id)
  )` },
  { type: "table", name: tables[1]!, sql: `CREATE TABLE workflow_worktree_cleanup_receipts (
    receipt_id TEXT NOT NULL PRIMARY KEY,
    cleanup_id TEXT NOT NULL REFERENCES workflow_worktree_cleanup_intents(cleanup_id),
    state TEXT NOT NULL CHECK(state IN ('removed','present','unknown')),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    artifact_content_sha256 TEXT NOT NULL,
    receipt_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(cleanup_id,artifact_id)
  )` },
  { type: "index", name: "idx_workflow_worktree_cleanup_removed", sql: `CREATE UNIQUE INDEX idx_workflow_worktree_cleanup_removed
    ON workflow_worktree_cleanup_receipts(cleanup_id) WHERE state='removed'` },
  ...tables.flatMap(table => [
    { type: "trigger", name: `trg_${table}_immutable`, sql: `CREATE TRIGGER trg_${table}_immutable
      BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'workflow_cleanup.journal_immutable'); END` },
    { type: "trigger", name: `trg_${table}_retained`, sql: `CREATE TRIGGER trg_${table}_retained
      BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'workflow_cleanup.journal_retained'); END` },
  ]),
];
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Separate immutable cleanup evidence; no business round transition or Git effect. */
export function applyWorkflowWorktreeCleanupMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): void {
  const inspect = () => {
    if (input.database.prepare("SELECT name FROM schema_migrations WHERE version=208").get()?.name !== "workflow_merge_apply_permits")
      throw new Error("workflow_cleanup.migration_predecessor_missing");
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(WORKFLOW_WORKTREE_CLEANUP_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== WORKFLOW_WORKTREE_CLEANUP_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(WORKFLOW_WORKTREE_CLEANUP_MIGRATION_VERSION))
      throw new Error("workflow_cleanup.migration_marker_conflict");
    const known = new Set(definitions.map(definition => definition.name));
    for (const definition of definitions) {
      const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(definition.name);
      if (actual && (actual.type !== definition.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition.sql)))
        throw new Error(`workflow_cleanup.migration_schema_conflict:${definition.name}`);
      if (markers.length && !actual) throw new Error(`workflow_cleanup.migration_schema_missing:${definition.name}`);
    }
    for (const table of tables) {
      if (input.database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_autoindex_%'")
        .all(table).some(row => !known.has(String(row.name)))) throw new Error("workflow_cleanup.migration_unexpected_object");
      if (markers.length && input.database.prepare(`PRAGMA foreign_key_check(${table})`).all().length)
        throw new Error("workflow_cleanup.migration_fk_conflict");
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  // A failed BEGIN must not roll back a transaction owned by the caller.
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions)
        if (!input.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(definition.name)) input.database.exec(definition.sql);
      input.recordMigration(WORKFLOW_WORKTREE_CLEANUP_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("workflow_cleanup.migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}
