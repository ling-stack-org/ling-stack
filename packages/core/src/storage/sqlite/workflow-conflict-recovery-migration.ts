import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKFLOW_CONFLICT_RECOVERY_MIGRATION_VERSION = 213;
const name = "workflow_conflict_recoveries";
const definitions = [
  { type: "table", name, sql: `CREATE TABLE workflow_conflict_recoveries (
    recovery_id TEXT PRIMARY KEY NOT NULL,
    predecessor_workflow_id TEXT NOT NULL UNIQUE REFERENCES channel_workflows(id),
    predecessor_round_id TEXT NOT NULL,
    predecessor_generation INTEGER NOT NULL CHECK(typeof(predecessor_generation)='integer' AND predecessor_generation>0),
    successor_workflow_id TEXT NOT NULL UNIQUE REFERENCES channel_workflows(id),
    successor_round_id TEXT NOT NULL UNIQUE,
    successor_generation INTEGER NOT NULL CHECK(successor_generation=1),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
    request_digest TEXT NOT NULL,
    recovery_json TEXT NOT NULL CHECK(json_valid(recovery_json)),
    recovery_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK(predecessor_workflow_id<>successor_workflow_id AND predecessor_round_id<>successor_round_id),
    FOREIGN KEY(predecessor_round_id,predecessor_generation) REFERENCES workflow_integration_generations(round_id,generation),
    UNIQUE(predecessor_round_id,predecessor_generation)
  )` },
  { type: "trigger", name: "trg_workflow_conflict_recovery_immutable", sql: `CREATE TRIGGER trg_workflow_conflict_recovery_immutable
    BEFORE UPDATE ON workflow_conflict_recoveries BEGIN SELECT RAISE(ABORT,'workflow_recovery.lineage_immutable'); END` },
  { type: "trigger", name: "trg_workflow_conflict_recovery_retained", sql: `CREATE TRIGGER trg_workflow_conflict_recovery_retained
    BEFORE DELETE ON workflow_conflict_recoveries BEGIN SELECT RAISE(ABORT,'workflow_recovery.lineage_retained'); END` },
];
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyWorkflowConflictRecoveryMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): void {
  const inspect = () => {
    if (input.database.prepare("SELECT name FROM schema_migrations WHERE version=212").get()?.name !== "workflow_template_registry")
      throw new Error("workflow_recovery.migration_predecessor_missing");
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(WORKFLOW_CONFLICT_RECOVERY_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== WORKFLOW_CONFLICT_RECOVERY_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(WORKFLOW_CONFLICT_RECOVERY_MIGRATION_VERSION))
      throw new Error("workflow_recovery.migration_marker_conflict");
    for (const definition of definitions) {
      const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(definition.name);
      if (actual && (actual.type !== definition.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition.sql)))
        throw new Error(`workflow_recovery.migration_schema_conflict:${definition.name}`);
      if (markers.length && !actual) throw new Error(`workflow_recovery.migration_schema_missing:${definition.name}`);
      if (!markers.length && actual && definition.type === "table"
        && input.database.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get()) throw new Error("workflow_recovery.migration_unmarked_data");
    }
    const known = new Set(definitions.map(definition => definition.name));
    if (input.database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_autoindex_%'")
      .all(name).some(row => !known.has(String(row.name)))) throw new Error("workflow_recovery.migration_unexpected_object");
    if (markers.length && input.database.prepare(`PRAGMA foreign_key_check(${name})`).all().length)
      throw new Error("workflow_recovery.migration_fk_conflict");
    return Boolean(markers.length);
  };
  if (inspect()) return;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions)
        if (!input.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(definition.name)) input.database.exec(definition.sql);
      input.recordMigration(WORKFLOW_CONFLICT_RECOVERY_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("workflow_recovery.migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}
