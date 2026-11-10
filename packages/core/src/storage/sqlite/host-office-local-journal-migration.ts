import type { DatabaseSync } from "node:sqlite";

export const HOST_OFFICE_LOCAL_JOURNAL_MIGRATION_VERSION = 150;

// This is the complete 147 journal contract, not a replacement inferred from live rows.
// Validate it before widening the three enum lists; keep every old CHECK verbatim.
const JOURNAL_147_BODY = `
  operation_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE CASCADE,
  work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
  runtime_instance_id TEXT NOT NULL,
  fencing_token TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('command','file_mutation','mcp','plugin','media','host_capability',
    'approval','permission','approval_review','hydration','sdk_tool','cleanup')),
  tool_call_id TEXT NOT NULL,
  parent_operation_id TEXT REFERENCES host_operations(operation_id) ON DELETE RESTRICT,
  producer_id TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('admitted','launched','safe','unknown_outcome')),
  admitted_at TEXT NOT NULL,
  launched_at TEXT,
  settled_at TEXT,
  settlement_kind TEXT CHECK(settlement_kind IN ('known_no_start','file_completed','unknown_outcome','media_response_completed','media_remote_terminal','media_chain_completed')),
  evidence_kind TEXT CHECK(evidence_kind IN ('harness_tool_execution','host_command','media_chain_execution','media_transport_execution')),
  evidence_id TEXT,
  domain_identity_digest TEXT,
  evidence_digest TEXT,
  settlement_signature TEXT,
  code TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  CHECK((parent_operation_id IS NULL AND producer_id IS NULL)
    OR (parent_operation_id IS NOT NULL AND producer_id IS NOT NULL)),
  CHECK((evidence_kind IS NULL AND evidence_id IS NULL AND domain_identity_digest IS NULL)
    OR (evidence_kind IS NOT NULL AND evidence_id IS NOT NULL AND length(domain_identity_digest)=64)),
  CHECK((phase IN ('admitted','launched') AND settled_at IS NULL AND settlement_kind IS NULL
    AND evidence_digest IS NULL AND settlement_signature IS NULL AND code IS NULL)
    OR (phase='safe' AND settled_at IS NOT NULL AND settlement_kind IN ('known_no_start','file_completed','media_response_completed','media_remote_terminal','media_chain_completed')
      AND length(evidence_digest)=64 AND settlement_signature IS NOT NULL AND code IS NULL)
    OR (phase='unknown_outcome' AND settled_at IS NOT NULL AND settlement_kind='unknown_outcome'
      AND settlement_signature IS NOT NULL AND code IS NOT NULL)),
  CHECK(phase!='launched' OR launched_at IS NOT NULL),
  CHECK(settlement_kind IS NOT 'known_no_start' OR launched_at IS NULL),
  CHECK(settlement_kind IS NOT 'file_completed' OR launched_at IS NOT NULL),
  CHECK(evidence_kind NOT IN ('media_chain_execution','media_transport_execution') OR
    (kind='media' AND evidence_id IS NOT NULL AND domain_identity_digest IS NOT NULL AND length(domain_identity_digest)=64 AND
      (phase IN ('admitted','launched') OR
        (phase='safe' AND settlement_kind IS NOT NULL AND evidence_digest IS NOT NULL AND length(evidence_digest)=64 AND
          (settlement_kind='known_no_start' OR
            (settlement_kind IN ('media_response_completed','media_remote_terminal') AND evidence_kind='media_transport_execution') OR
            (settlement_kind='media_chain_completed' AND evidence_kind='media_chain_execution'))) OR
        (phase='unknown_outcome' AND settlement_kind IS NOT NULL AND settlement_kind='unknown_outcome')))),
  CHECK(settlement_kind NOT IN ('media_response_completed','media_remote_terminal','media_chain_completed') OR
    (kind='media' AND launched_at IS NOT NULL AND evidence_digest IS NOT NULL AND length(evidence_digest)=64
      AND evidence_kind IS NOT NULL AND evidence_id IS NOT NULL AND domain_identity_digest IS NOT NULL
      AND length(domain_identity_digest)=64 AND
      ((settlement_kind IN ('media_response_completed','media_remote_terminal') AND evidence_kind='media_transport_execution')
        OR (settlement_kind='media_chain_completed' AND evidence_kind='media_chain_execution')))),
  UNIQUE(evidence_kind,evidence_id)
`;

const OFFICE_ROLE_CHECKS = `
  CHECK(evidence_kind NOT IN ('office_local_chain_execution','office_local_binary_execution') OR
    (evidence_kind IS NOT NULL AND evidence_id IS NOT NULL AND domain_identity_digest IS NOT NULL
      AND length(domain_identity_digest)=64 AND
      ((evidence_kind='office_local_chain_execution' AND kind='mcp'
          AND parent_operation_id IS NULL AND producer_id IS NULL)
        OR (evidence_kind='office_local_binary_execution' AND kind='file_mutation'
          AND parent_operation_id IS NOT NULL AND producer_id IS NOT NULL AND producer_id='office-local-binary'))
      AND ((phase IN ('admitted','launched') AND settlement_kind IS NULL)
        OR (phase='safe' AND settlement_kind IS NOT NULL AND evidence_digest IS NOT NULL
          AND length(evidence_digest)=64
          AND ((settlement_kind='known_no_start' AND launched_at IS NULL)
            OR (launched_at IS NOT NULL
              AND ((settlement_kind='office_local_chain_completed' AND evidence_kind='office_local_chain_execution')
                OR (settlement_kind='office_local_binary_completed' AND evidence_kind='office_local_binary_execution')))))
        OR (phase='unknown_outcome' AND settlement_kind IS NOT NULL AND settlement_kind='unknown_outcome')))),
  CHECK(settlement_kind NOT IN ('office_local_chain_completed','office_local_binary_completed') OR
    (settlement_kind IS NOT NULL AND phase='safe' AND settled_at IS NOT NULL AND launched_at IS NOT NULL
      AND evidence_kind IS NOT NULL AND evidence_id IS NOT NULL AND domain_identity_digest IS NOT NULL
      AND length(domain_identity_digest)=64 AND evidence_digest IS NOT NULL AND length(evidence_digest)=64
      AND ((settlement_kind='office_local_chain_completed' AND evidence_kind='office_local_chain_execution'
          AND kind='mcp' AND parent_operation_id IS NULL AND producer_id IS NULL)
        OR (settlement_kind='office_local_binary_completed' AND evidence_kind='office_local_binary_execution'
          AND kind='file_mutation' AND parent_operation_id IS NOT NULL
          AND producer_id IS NOT NULL AND producer_id='office-local-binary')))),
  UNIQUE(evidence_kind,evidence_id)`;

/**
 * Admit closed Office journal roles without certifying any historical or physical result.
 *
 * Completed and known-no-start schema cases still require the Core sealed-effect verifier;
 * this migration does not backfill facts, invent receipts, or convert unknown outcomes.
 * Own the top-level transaction, preserve self/external FKs and views via create-copy-drop-
 * rename, and quarantine an owned handle if rollback or PRAGMA restoration is uncertain.
 */
export function applyHostOfficeLocalJournalMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (name: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  if (input.hasMigration(HOST_OFFICE_LOCAL_JOURNAL_MIGRATION_VERSION) && input.hasTable("host_operations")) return;
  const database = input.database;
  const foreignKeys = readPragma(database, "foreign_keys"), legacyAlterTable = readPragma(database, "legacy_alter_table");
  let ownsTransaction = false;
  let enteredMigration = false;
  let migrationError: unknown;
  try {
    database.exec("PRAGMA foreign_keys=OFF");
    // SQLite ignores this write inside caller-owned transactions; always read it back.
    if (readPragma(database, "foreign_keys") !== 0) throw new Error("host_office_local_journal_migration_requires_top_level");
    database.exec("BEGIN IMMEDIATE");
    ownsTransaction = true;
    enteredMigration = true;
    database.exec("PRAGMA legacy_alter_table=ON");
    rebuildHostOperations(database);
    if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("host_office_local_journal_foreign_key_invalid");
    if (!input.hasMigration(HOST_OFFICE_LOCAL_JOURNAL_MIGRATION_VERSION)) {
      input.recordMigration(HOST_OFFICE_LOCAL_JOURNAL_MIGRATION_VERSION, "add_host_office_local_journal_roles");
    }
    database.exec("COMMIT");
    ownsTransaction = false;
  } catch (error) {
    migrationError = error;
    if (ownsTransaction) {
      try { database.exec("ROLLBACK"); }
      catch (rollbackError) {
        const failures = [error, rollbackError];
        try { database.close(); } catch (closeError) { failures.push(closeError); }
        migrationError = new AggregateError(failures, "host_office_local_journal_migration_rollback_failed");
        throw migrationError;
      }
    }
    throw error;
  } finally {
    if (database.isOpen) restorePragmas(database, foreignKeys, legacyAlterTable, enteredMigration, migrationError);
  }
}

/** Restore both settings independently and read them back, including SQLite's silent no-op cases. */
function restorePragmas(database: DatabaseSync, foreignKeys: 0 | 1, legacyAlterTable: 0 | 1,
  enteredMigration: boolean, migrationError: unknown): void {
  const failures: unknown[] = [];
  try { database.exec(`PRAGMA legacy_alter_table=${legacyAlterTable}`); } catch (error) { failures.push(error); }
  try { database.exec(`PRAGMA foreign_keys=${foreignKeys}`); } catch (error) { failures.push(error); }
  let restored = false;
  try { restored = readPragma(database, "foreign_keys") === foreignKeys && readPragma(database, "legacy_alter_table") === legacyAlterTable; }
  catch (error) { failures.push(error); }
  if (!restored) {
    failures.push(new Error("host_office_local_journal_pragma_readback_mismatch"));
    // Never close or roll back a rejected caller-owned transaction.
    if (enteredMigration) { try { database.close(); } catch (error) { failures.push(error); } }
  }
  if (failures.length) {
    if (migrationError !== undefined) failures.unshift(migrationError);
    throw new AggregateError(failures, "host_office_local_journal_pragma_restore_failed");
  }
}

function readPragma(database: DatabaseSync, name: "foreign_keys" | "legacy_alter_table"): 0 | 1 {
  const value = database.prepare(`PRAGMA ${name}`).get()?.[name];
  if (value !== 0 && value !== 1) throw new Error("host_office_local_journal_migration_invalid_pragma");
  return value;
}

/** Preserve named/custom indexes and triggers; never rename the old referenced table. */
function rebuildHostOperations(database: DatabaseSync): void {
  const original = database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='host_operations'").get()?.sql;
  if (typeof original !== "string") throw new Error("host_office_local_journal_migration_missing_journal");
  const header = /^CREATE TABLE(?: IF NOT EXISTS)? (?:host_operations|"host_operations")\s*\(/i;
  const body = original.replace(header, "").replace(/\)\s*;?\s*$/, "");
  if (!header.test(original) || normalizeSql(body) !== normalizeSql(JOURNAL_147_BODY)) {
    throw new Error("host_office_local_journal_migration_journal_schema_mismatch");
  }
  let sql = replaceExactlyOnce(original, header, "CREATE TABLE host_operations_office_local_new (");
  sql = replaceExactlyOnce(sql, /settlement_kind IN \('known_no_start','file_completed','unknown_outcome','media_response_completed','media_remote_terminal','media_chain_completed'\)/,
    "settlement_kind IN ('known_no_start','file_completed','unknown_outcome','media_response_completed','media_remote_terminal','media_chain_completed','office_local_chain_completed','office_local_binary_completed')");
  sql = replaceExactlyOnce(sql, /evidence_kind IN \('harness_tool_execution','host_command','media_chain_execution','media_transport_execution'\)/,
    "evidence_kind IN ('harness_tool_execution','host_command','media_chain_execution','media_transport_execution','office_local_chain_execution','office_local_binary_execution')");
  sql = replaceExactlyOnce(sql, /settlement_kind IN \('known_no_start','file_completed','media_response_completed','media_remote_terminal','media_chain_completed'\)/,
    "settlement_kind IN ('known_no_start','file_completed','media_response_completed','media_remote_terminal','media_chain_completed','office_local_chain_completed','office_local_binary_completed')");
  sql = replaceExactlyOnce(sql, /UNIQUE\(evidence_kind,evidence_id\)/, OFFICE_ROLE_CHECKS);
  const objects = database.prepare(`SELECT sql FROM sqlite_schema WHERE tbl_name='host_operations'
    AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`).all();
  database.exec(sql);
  database.exec(`INSERT INTO host_operations_office_local_new SELECT * FROM host_operations;
    DROP TABLE host_operations;
    ALTER TABLE host_operations_office_local_new RENAME TO host_operations;`);
  for (const object of objects) {
    if (typeof object.sql !== "string") throw new Error("host_office_local_journal_migration_invalid_schema_object");
    database.exec(object.sql);
  }
}

function normalizeSql(sql: string): string { return sql.replace(/\s+/g, " ").trim(); }

/** A drifted or partially widened journal is never silently reconstructed with weaker CHECKs. */
function replaceExactlyOnce(sql: string, pattern: RegExp, replacement: string): string {
  if (Array.from(sql.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))).length !== 1) {
    throw new Error("host_office_local_journal_migration_journal_schema_mismatch");
  }
  return sql.replace(pattern, replacement);
}
