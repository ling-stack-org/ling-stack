import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKFLOW_ISOLATION_RESULTS_MIGRATION_VERSION = 205;
const name = "workflow_isolation_terminal_results";
const hash = (column: string) => `length(${column})=64 AND ${column} NOT GLOB '*[^a-f0-9]*'`;
const oid = (column: string) => `length(${column}) IN (40,64) AND ${column} NOT GLOB '*[^a-f0-9]*'`;
const definitions = [
  { type: "table", name: "workflow_isolation_result_intents", sql: `CREATE TABLE workflow_isolation_result_intents (
    intent_id TEXT NOT NULL PRIMARY KEY,
    binding_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES run_sessions(id),
    work_unit_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    runtime_instance_id TEXT NOT NULL,
    fencing_token TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK(typeof(binding_revision)='integer' AND binding_revision>=0),
    proof_digest TEXT NOT NULL,
    packet_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    packet_content_sha256 TEXT NOT NULL CHECK(${hash("packet_content_sha256")}),
    packet_digest TEXT NOT NULL,
    common_dir TEXT NOT NULL,
    ref TEXT NOT NULL,
    result_commit TEXT NOT NULL CHECK(${oid("result_commit")}),
    result_tree TEXT NOT NULL CHECK(${oid("result_tree")} AND length(result_tree)=length(result_commit)),
    intent_digest TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
    status TEXT NOT NULL CHECK(status IN ('pending','confirmed','blocked','effect_unknown')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((revision=0 AND status='pending') OR (revision>0 AND status<>'pending')),
    FOREIGN KEY(binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token)
      REFERENCES workflow_isolation_bindings(binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token),
    UNIQUE(common_dir,ref),
    UNIQUE(intent_id,binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token)
  )` },
  { type: "table", name: "workflow_isolation_result_receipts", sql: `CREATE TABLE workflow_isolation_result_receipts (
    receipt_id TEXT NOT NULL PRIMARY KEY,
    intent_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    work_unit_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    runtime_instance_id TEXT NOT NULL,
    fencing_token TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
    outcome TEXT NOT NULL CHECK(outcome IN ('confirmed','blocked','effect_unknown')),
    observed_commit TEXT CHECK(observed_commit IS NULL OR (${oid("observed_commit")})),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    artifact_content_sha256 TEXT NOT NULL CHECK(${hash("artifact_content_sha256")}),
    receipt_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK(outcome<>'confirmed' OR observed_commit IS NOT NULL),
    FOREIGN KEY(intent_id,binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token)
      REFERENCES workflow_isolation_result_intents(intent_id,binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token),
    UNIQUE(intent_id,revision)
  )` },
  { type: "index", name: "idx_workflow_isolation_result_confirmed", sql: `CREATE UNIQUE INDEX idx_workflow_isolation_result_confirmed
    ON workflow_isolation_result_receipts(intent_id) WHERE outcome='confirmed'` },
  { type: "trigger", name: "trg_workflow_isolation_result_intent_immutable", sql: `CREATE TRIGGER trg_workflow_isolation_result_intent_immutable
    BEFORE UPDATE ON workflow_isolation_result_intents WHEN NEW.intent_id<>OLD.intent_id OR NEW.binding_id<>OLD.binding_id
      OR NEW.run_id<>OLD.run_id OR NEW.work_unit_id<>OLD.work_unit_id OR NEW.attempt_id<>OLD.attempt_id
      OR NEW.runtime_instance_id<>OLD.runtime_instance_id OR NEW.fencing_token<>OLD.fencing_token
      OR NEW.binding_revision<>OLD.binding_revision OR NEW.proof_digest<>OLD.proof_digest
      OR NEW.packet_artifact_id<>OLD.packet_artifact_id OR NEW.packet_content_sha256<>OLD.packet_content_sha256
      OR NEW.packet_digest<>OLD.packet_digest OR NEW.common_dir<>OLD.common_dir OR NEW.ref<>OLD.ref
      OR NEW.result_commit<>OLD.result_commit OR NEW.result_tree<>OLD.result_tree OR NEW.intent_digest<>OLD.intent_digest
      OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 OR NEW.status='pending' OR OLD.status='confirmed'
    BEGIN SELECT RAISE(ABORT,'workflow_isolation.result_intent_immutable'); END` },
  { type: "trigger", name: "trg_workflow_isolation_result_receipt_immutable", sql: `CREATE TRIGGER trg_workflow_isolation_result_receipt_immutable
    BEFORE UPDATE ON workflow_isolation_result_receipts BEGIN SELECT RAISE(ABORT,'workflow_isolation.result_receipt_immutable'); END` },
  ...["intents", "receipts"].map(table => ({ type: "trigger", name: `trg_workflow_isolation_result_${table}_retained`,
    sql: `CREATE TRIGGER trg_workflow_isolation_result_${table}_retained BEFORE DELETE ON workflow_isolation_result_${table}
      BEGIN SELECT RAISE(ABORT,'workflow_isolation.result_journal_retained'); END` })),
];
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive205 journal. No new authority, backfill or changes to204 objects. */
export function applyWorkflowIsolationResultsMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): void {
  const inspect = () => {
    if (input.database.prepare("SELECT name FROM schema_migrations WHERE version=204").get()?.name !== "workflow_isolation_foundation")
      throw new Error("workflow_isolation.results_migration_predecessor_missing");
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(WORKFLOW_ISOLATION_RESULTS_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== WORKFLOW_ISOLATION_RESULTS_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(WORKFLOW_ISOLATION_RESULTS_MIGRATION_VERSION))
      throw new Error("workflow_isolation.results_migration_marker_conflict");
    const known = new Set(definitions.map(definition => definition.name));
    for (const definition of definitions) {
      const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(definition.name);
      if (actual && (actual.type !== definition.type || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition.sql)))
        throw new Error(`workflow_isolation.results_migration_schema_conflict:${definition.name}`);
      if (markers.length && !actual) throw new Error(`workflow_isolation.results_migration_schema_missing:${definition.name}`);
    }
    for (const table of definitions.filter(definition => definition.type === "table")) {
      if (input.database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name NOT LIKE 'sqlite_autoindex_%'")
        .all(table.name).some(row => !known.has(String(row.name))))
        throw new Error(`workflow_isolation.results_migration_unexpected_object:${table.name}`);
      if (markers.length && input.database.prepare(`PRAGMA foreign_key_check(${table.name})`).all().length)
        throw new Error(`workflow_isolation.results_migration_fk_conflict:${table.name}`);
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions)
        if (!input.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(definition.name)) input.database.exec(definition.sql);
      input.recordMigration(WORKFLOW_ISOLATION_RESULTS_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("workflow_isolation.results_migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(input.database); throw error; }
}
