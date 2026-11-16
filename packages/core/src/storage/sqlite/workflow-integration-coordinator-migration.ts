import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKFLOW_INTEGRATION_COORDINATOR_MIGRATION_VERSION = 206;
const name = "workflow_integration_coordinator_evidence";
const hash = (column: string) => `length(${column})=64 AND ${column} NOT GLOB '*[^a-f0-9]*'`;
const definitions = [
  { type: "table", name: "workflow_integration_effect_links", sql: `CREATE TABLE workflow_integration_effect_links (
    intent_id TEXT NOT NULL PRIMARY KEY REFERENCES workflow_isolation_intents(intent_id),
    round_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0),
    effect_key TEXT NOT NULL CHECK(length(effect_key)>0),
    authority_digest TEXT NOT NULL,
    payload_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    payload_content_sha256 TEXT NOT NULL CHECK(${hash("payload_content_sha256")}),
    link_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(round_id,generation) REFERENCES workflow_integration_generations(round_id,generation),
    UNIQUE(round_id,generation,effect_key)
  )` },
  { type: "table", name: "workflow_integration_receipt_links", sql: `CREATE TABLE workflow_integration_receipt_links (
    receipt_id TEXT NOT NULL PRIMARY KEY REFERENCES workflow_isolation_receipts(receipt_id),
    intent_id TEXT NOT NULL REFERENCES workflow_integration_effect_links(intent_id),
    scope_revision INTEGER NOT NULL CHECK(typeof(scope_revision)='integer' AND scope_revision>=0),
    authority_digest TEXT NOT NULL,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    artifact_content_sha256 TEXT NOT NULL CHECK(${hash("artifact_content_sha256")}),
    link_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(intent_id,scope_revision)
  )` },
  ...["effect", "receipt"].flatMap(kind => [
    { type: "trigger", name: `trg_workflow_integration_${kind}_link_immutable`, sql: `CREATE TRIGGER trg_workflow_integration_${kind}_link_immutable
      BEFORE UPDATE ON workflow_integration_${kind}_links BEGIN SELECT RAISE(ABORT,'workflow_integration.link_immutable'); END` },
    { type: "trigger", name: `trg_workflow_integration_${kind}_link_retained`, sql: `CREATE TRIGGER trg_workflow_integration_${kind}_link_retained
      BEFORE DELETE ON workflow_integration_${kind}_links BEGIN SELECT RAISE(ABORT,'workflow_integration.link_retained'); END` },
  ]),
];
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Independent206 overlay: no alterations, triggers or indexes on204/205 objects. */
export function applyWorkflowIntegrationCoordinatorMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): void {
  const inspect = () => {
    if (input.database.prepare("SELECT name FROM schema_migrations WHERE version=205").get()?.name !== "workflow_isolation_terminal_results")
      throw new Error("workflow_integration.migration_predecessor_missing");
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(WORKFLOW_INTEGRATION_COORDINATOR_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== WORKFLOW_INTEGRATION_COORDINATOR_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(WORKFLOW_INTEGRATION_COORDINATOR_MIGRATION_VERSION))
      throw new Error("workflow_integration.migration_marker_conflict");
    const known = new Set(definitions.map(definition => definition.name));
    for (const definition of definitions) {
      const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(definition.name);
      if (actual && (actual.type !== definition.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition.sql)))
        throw new Error(`workflow_integration.migration_schema_conflict:${definition.name}`);
      if (markers.length && !actual) throw new Error(`workflow_integration.migration_schema_missing:${definition.name}`);
    }
    for (const table of definitions.filter(definition => definition.type === "table")) {
      if (input.database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_autoindex_%'")
        .all(table.name).some(row => !known.has(String(row.name)))) throw new Error(`workflow_integration.migration_unexpected_object:${table.name}`);
      if (markers.length && input.database.prepare(`PRAGMA foreign_key_check(${table.name})`).all().length)
        throw new Error(`workflow_integration.migration_fk_conflict:${table.name}`);
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions)
        if (!input.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(definition.name)) input.database.exec(definition.sql);
      input.recordMigration(WORKFLOW_INTEGRATION_COORDINATOR_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("workflow_integration.migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}
