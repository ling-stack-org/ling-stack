import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKFLOW_MERGE_APPLY_MIGRATION_VERSION = 208;
const name = "workflow_merge_apply_permits";
const table = "workflow_merge_apply_permits";
const definitions = [
  { type: "table", name: table, sql: `CREATE TABLE workflow_merge_apply_permits (
    permit_id TEXT NOT NULL PRIMARY KEY,
    approval_id TEXT NOT NULL UNIQUE REFERENCES workflow_merge_approval_requests(approval_id),
    request_id TEXT NOT NULL REFERENCES workflow_merge_approval_requests(request_id),
    round_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0),
    authority_digest TEXT NOT NULL,
    basis_fingerprint TEXT NOT NULL,
    owner_token TEXT NOT NULL UNIQUE CHECK(length(owner_token)>0),
    lease_id TEXT NOT NULL UNIQUE REFERENCES resource_leases(id),
    intent_id TEXT NOT NULL UNIQUE REFERENCES workflow_integration_effect_links(intent_id),
    permit_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(round_id,generation) REFERENCES workflow_integration_generations(round_id,generation),
    UNIQUE(round_id,generation)
  )` },
  { type: "trigger", name: "trg_workflow_merge_apply_permit_immutable", sql: `CREATE TRIGGER trg_workflow_merge_apply_permit_immutable
    BEFORE UPDATE ON workflow_merge_apply_permits BEGIN SELECT RAISE(ABORT,'workflow_merge.permit_immutable'); END` },
  { type: "trigger", name: "trg_workflow_merge_apply_permit_retained", sql: `CREATE TRIGGER trg_workflow_merge_apply_permit_retained
    BEFORE DELETE ON workflow_merge_apply_permits BEGIN SELECT RAISE(ABORT,'workflow_merge.permit_retained'); END` },
];
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Immutable authority overlay. It neither runs Git nor infers quiescence from lease expiry. */
export function applyWorkflowMergeApplyMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): void {
  const inspect = () => {
    if (input.database.prepare("SELECT name FROM schema_migrations WHERE version=207").get()?.name !== "workflow_merge_approval_basis")
      throw new Error("workflow_merge.migration_predecessor_missing");
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(WORKFLOW_MERGE_APPLY_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== WORKFLOW_MERGE_APPLY_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(WORKFLOW_MERGE_APPLY_MIGRATION_VERSION))
      throw new Error("workflow_merge.migration_marker_conflict");
    const known = new Set(definitions.map(definition => definition.name));
    for (const definition of definitions) {
      const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(definition.name);
      if (actual && (actual.type !== definition.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition.sql)))
        throw new Error(`workflow_merge.migration_schema_conflict:${definition.name}`);
      if (markers.length && !actual) throw new Error(`workflow_merge.migration_schema_missing:${definition.name}`);
    }
    if (input.database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_autoindex_%'")
      .all(table).some(row => !known.has(String(row.name)))) throw new Error("workflow_merge.migration_unexpected_object");
    if (markers.length && input.database.prepare(`PRAGMA foreign_key_check(${table})`).all().length)
      throw new Error("workflow_merge.migration_fk_conflict");
    return Boolean(markers.length);
  };
  if (inspect()) return;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions)
        if (!input.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(definition.name)) input.database.exec(definition.sql);
      input.recordMigration(WORKFLOW_MERGE_APPLY_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("workflow_merge.migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}
