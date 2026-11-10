import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const moduleUrl = process.env.LING_MEDIA_RECEIPT_MIGRATION_MODULE
  ? pathToFileURL(process.env.LING_MEDIA_RECEIPT_MIGRATION_MODULE)
  : new URL("../../dist/storage/sqlite/host-media-receipt-migration.js", import.meta.url);
export const { applyHostMediaReceiptMigration, HOST_MEDIA_RECEIPT_MIGRATION_VERSION } = await import(moduleUrl.href);
const { applyHostOperationJournalMigration } = await import(new URL("host-operation-journal-migration.js", moduleUrl).href);
const { applyHostMediaOperationMigration } = await import(new URL("host-media-operation-migration.js", moduleUrl).href);
export const digest = "a".repeat(64);
export const at = "2026-10-04T00:00:00.000Z";
export const executionRefs = ["submission_artifact_id", "terminal_artifact_id", "manifest_artifact_id", "finalization_artifact_id"];
export const effectRefs = ["response_artifact_id", "no_start_artifact_id"];

export function migrationInput(database, override = {}) {
  return {
    database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    hasTable: name => Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations(version,name) VALUES(?,?)").run(version, name),
    ...override,
  };
}

export function insertOperation(database, operationId, override = {}) {
  const row = {
    operation_id: operationId, schema_version: 1, run_id: "run", work_unit_id: "unit", attempt_id: "attempt",
    runtime_instance_id: "runtime", fencing_token: "fence", kind: "media", tool_call_id: operationId,
    parent_operation_id: null, producer_id: null, phase: "admitted", admitted_at: at, launched_at: null,
    settled_at: null, settlement_kind: null, evidence_kind: null, evidence_id: null, domain_identity_digest: null,
    evidence_digest: null, settlement_signature: null, code: null, revision: 0, ...override,
  };
  const names = Object.keys(row);
  database.prepare(`INSERT INTO host_operations(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...Object.values(row));
}

export function snapshot(database) {
  return Object.fromEntries(["host_operations", "host_media_executions", "host_media_effects", "schema_migrations"]
    .map(name => [name, database.prepare(`SELECT * FROM ${name} ORDER BY 1`).all().map(row => ({ ...row }))]));
}

export async function fixture(t, { foreignKeys = 1, legacyAlterTable = 0, populated = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-receipt-migration-")), path = join(cwd, "facts.sqlite");
  let database = new DatabaseSync(path);
  t.after(async () => { if (database.isOpen) database.close(); await rm(cwd, { recursive: true, force: true }); });
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY); CREATE TABLE media_jobs(id TEXT PRIMARY KEY);
    CREATE TABLE run_sessions(id TEXT PRIMARY KEY); CREATE TABLE work_units(id TEXT PRIMARY KEY);
    CREATE TABLE work_unit_attempts(id TEXT PRIMARY KEY); CREATE TABLE artifacts(id TEXT PRIMARY KEY);
    INSERT INTO workspaces VALUES('workspace'); INSERT INTO media_jobs VALUES('job');
    INSERT INTO run_sessions VALUES('run'); INSERT INTO work_units VALUES('unit'),('child');
    INSERT INTO work_unit_attempts VALUES('attempt'),('child-attempt');
    INSERT INTO artifacts VALUES('prepared'),('receipt-a'),('receipt-b');`);
  applyHostOperationJournalMigration(migrationInput(database));
  applyHostMediaOperationMigration(migrationInput(database));
  if (!populated) {
    database.exec(`PRAGMA foreign_keys=${foreignKeys}; PRAGMA legacy_alter_table=${legacyAlterTable}`);
    return {
      path, get database() { return database; },
      apply: override => applyHostMediaReceiptMigration(migrationInput(database, override)),
      reopen: () => { if (database.isOpen) database.close(); database = new DatabaseSync(path); database.exec(`PRAGMA foreign_keys=${foreignKeys}; PRAGMA legacy_alter_table=${legacyAlterTable}`); return database; },
    };
  }
  insertOperation(database, "parent");
  insertOperation(database, "transport", { parent_operation_id: "parent", producer_id: "media-http-chain", phase: "launched", launched_at: at });
  insertOperation(database, "safe-file", { kind: "file_mutation", phase: "safe", launched_at: at, settled_at: at,
    settlement_kind: "file_completed", evidence_kind: "harness_tool_execution", evidence_id: "file-evidence",
    domain_identity_digest: digest, evidence_digest: digest, settlement_signature: "file-signature" });
  insertOperation(database, "safe-no-start", { kind: "command", phase: "safe", settled_at: at,
    settlement_kind: "known_no_start", evidence_digest: digest, settlement_signature: "no-start-signature" });
  insertOperation(database, "unknown", { kind: "command", phase: "unknown_outcome", launched_at: at, settled_at: at,
    settlement_kind: "unknown_outcome", evidence_kind: "host_command", evidence_id: "command-evidence",
    domain_identity_digest: digest, settlement_signature: "unknown-signature", code: "uncertain" });
  const execution = {
    execution_id: "execution", schema_version: 1, workspace_id: "workspace", media_job_id: "job",
    media_child_work_unit_id: "child", execution_generation_id: "generation", parent_operation_id: "parent",
    transport_operation_id: "transport", run_id: "run", work_unit_id: "unit", attempt_id: "attempt",
    runtime_instance_id: "runtime", fencing_token: "fence", tool_call_id: "parent", tool_name: "image_generate",
    operation: "image_generate", protocol: "image_response_v1", adapter_id: "images", intent_digest: digest,
    target_digest: digest, namespace_digest: digest, prepared_request_artifact_id: "prepared",
    prepared_request_digest: digest, prepared_at: at, identity_digest: digest, child_attempt_id: "child-attempt",
    child_runtime_instance_id: "child-runtime", child_fencing_token: "child-fence", child_bound_at: at,
  };
  const names = Object.keys(execution);
  database.prepare(`INSERT INTO host_media_executions(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...Object.values(execution));
  database.prepare(`INSERT INTO host_media_effects(effect_id,schema_version,execution_id,ordinal,kind,method,
    route_digest,wire_digest,prepared_at,launched_at) VALUES('effect',1,'execution',0,'image_request','POST',?,?,?,?)`).run(digest, digest, at, at);
  // A dependent view, external FK, and custom trigger/index exercise safe DROP/rename ordering.
  database.exec(`CREATE TABLE external_media_refs(id TEXT PRIMARY KEY,operation_id TEXT REFERENCES host_operations(operation_id) ON DELETE RESTRICT);
    INSERT INTO external_media_refs VALUES('external','transport');
    CREATE VIEW media_operation_view AS SELECT operation_id,phase FROM host_operations;
    CREATE TRIGGER external_media_ref_guard BEFORE UPDATE ON external_media_refs
      WHEN NOT EXISTS(SELECT 1 FROM host_operations WHERE operation_id=NEW.operation_id)
      BEGIN SELECT RAISE(ABORT,'external_reference_guard_preserved'); END;
    CREATE INDEX custom_host_operation_code ON host_operations(code);
    CREATE TRIGGER custom_host_operation_guard BEFORE UPDATE OF code ON host_operations
      WHEN NEW.code='custom-forbidden' BEGIN SELECT RAISE(ABORT,'custom_guard_preserved'); END;`);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.exec(`PRAGMA foreign_keys=${foreignKeys}; PRAGMA legacy_alter_table=${legacyAlterTable}`);
  const f = {
    path, get database() { return database; },
    apply: override => applyHostMediaReceiptMigration(migrationInput(database, override)),
    reopen: () => { if (database.isOpen) database.close(); database = new DatabaseSync(path); database.exec(`PRAGMA foreign_keys=${foreignKeys}; PRAGMA legacy_alter_table=${legacyAlterTable}`); return database; },
  };
  return f;
}
