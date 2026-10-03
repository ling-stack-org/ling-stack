import type { DatabaseSync } from "node:sqlite";

export const HOST_MEDIA_RECEIPT_MIGRATION_VERSION = 147;

const EXECUTION_RECEIPT_COLUMNS = ["submission_artifact_id", "terminal_artifact_id", "manifest_artifact_id", "finalization_artifact_id"] as const;
const EFFECT_RECEIPT_COLUMNS = ["response_artifact_id", "no_start_artifact_id"] as const;

/**
 * Add receipt bindings without synthesizing authority from existing Media history.
 *
 * host_operations has self and external RESTRICT foreign keys. Rebuild it only in
 * a transaction owned here, with FK enforcement disabled before BEGIN and checked
 * again before COMMIT. Never rename the old table: doing so rewrites its dependents.
 * Both connection PRAGMAs are restored and read back; an owned transaction that
 * cannot roll back or restore its settings is quarantined by closing the handle.
 * The caller must not wrap this migration in another transaction.
 */
export function applyHostMediaReceiptMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (name: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  if (input.hasMigration(HOST_MEDIA_RECEIPT_MIGRATION_VERSION)
    && input.hasTable("host_operations") && input.hasTable("host_media_executions") && input.hasTable("host_media_effects")) return;
  const database = input.database;
  const foreignKeys = readPragma(database, "foreign_keys"), legacyAlterTable = readPragma(database, "legacy_alter_table");
  let ownsTransaction = false;
  let enteredMigration = false;
  let migrationError: unknown;
  try {
    database.exec("PRAGMA foreign_keys=OFF");
    // SQLite silently ignores this PRAGMA in an active transaction; do not trust the write alone.
    if (readPragma(database, "foreign_keys") !== 0) throw new Error("host_media_receipt_migration_requires_top_level");
    database.exec("BEGIN IMMEDIATE");
    ownsTransaction = true;
    enteredMigration = true;
    // A dependent view temporarily refers to the dropped table during create-copy-drop-rename.
    // Legacy rename avoids validating/rebinding that view until the final table name exists again.
    database.exec("PRAGMA legacy_alter_table=ON");
    rebuildHostOperations(database);
    addReceiptColumns(database, "host_media_executions", EXECUTION_RECEIPT_COLUMNS);
    addReceiptColumns(database, "host_media_effects", EFFECT_RECEIPT_COLUMNS);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS host_media_effects_receipt_conflict_insert
        BEFORE INSERT ON host_media_effects WHEN NEW.response_artifact_id IS NOT NULL AND NEW.no_start_artifact_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'host_media_effect_receipt_conflict'); END;
      CREATE TRIGGER IF NOT EXISTS host_media_effects_receipt_conflict_update
        BEFORE UPDATE ON host_media_effects WHEN NEW.response_artifact_id IS NOT NULL AND NEW.no_start_artifact_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'host_media_effect_receipt_conflict'); END;
    `);
    if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("host_media_receipt_foreign_key_invalid");
    if (!input.hasMigration(HOST_MEDIA_RECEIPT_MIGRATION_VERSION)) {
      input.recordMigration(HOST_MEDIA_RECEIPT_MIGRATION_VERSION, "add_host_media_execution_receipts");
    }
    database.exec("COMMIT");
    ownsTransaction = false;
  } catch (error) {
    migrationError = error;
    if (ownsTransaction) {
      try { database.exec("ROLLBACK"); }
      catch (rollbackError) {
        const failures = [error, rollbackError];
        // Restoring foreign_keys inside a still-active transaction is a silent no-op.
        // Closing releases our writer/transaction instead of exporting an unsafe connection.
        try { database.close(); } catch (closeError) { failures.push(closeError); }
        migrationError = new AggregateError(failures, "host_media_receipt_migration_rollback_failed");
        throw migrationError;
      }
    }
    throw error;
  } finally {
    if (database.isOpen) restorePragmas(database, foreignKeys, legacyAlterTable, enteredMigration, migrationError);
  }
}

/** Restore both settings even when one write throws, and never mistake SQLite's silent no-op for success. */
function restorePragmas(database: DatabaseSync, foreignKeys: 0 | 1, legacyAlterTable: 0 | 1, enteredMigration: boolean, migrationError: unknown): void {
  const failures: unknown[] = [];
  try { database.exec(`PRAGMA legacy_alter_table=${legacyAlterTable}`); } catch (error) { failures.push(error); }
  try { database.exec(`PRAGMA foreign_keys=${foreignKeys}`); } catch (error) { failures.push(error); }
  let restored = false;
  try { restored = readPragma(database, "foreign_keys") === foreignKeys && readPragma(database, "legacy_alter_table") === legacyAlterTable; }
  catch (error) { failures.push(error); }
  if (!restored) {
    failures.push(new Error("host_media_receipt_pragma_readback_mismatch"));
    // Rejected caller-owned transactions are never ours to roll back by closing.
    if (enteredMigration) { try { database.close(); } catch (error) { failures.push(error); } }
  }
  if (failures.length) {
    if (migrationError !== undefined) failures.unshift(migrationError);
    throw new AggregateError(failures, "host_media_receipt_pragma_restore_failed");
  }
}

function readPragma(database: DatabaseSync, name: "foreign_keys" | "legacy_alter_table"): 0 | 1 {
  const value = database.prepare(`PRAGMA ${name}`).get()?.[name];
  if (value !== 0 && value !== 1) throw new Error("host_media_receipt_migration_invalid_pragma");
  return value;
}

/** Preserve the persisted CHECKs/columns and all named indexes/triggers, adding only closed Media cases. */
function rebuildHostOperations(database: DatabaseSync): void {
  const original = database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='host_operations'").get()?.sql;
  if (typeof original !== "string") throw new Error("host_media_receipt_migration_missing_journal");
  let sql = replaceExactlyOnce(original, /^CREATE TABLE(?: IF NOT EXISTS)? host_operations\s*\(/i,
    "CREATE TABLE host_operations_media_receipt_new (");
  sql = replaceExactlyOnce(sql, /settlement_kind IN \('known_no_start','file_completed','unknown_outcome'\)/,
    "settlement_kind IN ('known_no_start','file_completed','unknown_outcome','media_response_completed','media_remote_terminal','media_chain_completed')");
  sql = replaceExactlyOnce(sql, /evidence_kind IN \('harness_tool_execution','host_command'\)/,
    "evidence_kind IN ('harness_tool_execution','host_command','media_chain_execution','media_transport_execution')");
  sql = replaceExactlyOnce(sql, /settlement_kind IN \('known_no_start','file_completed'\)/,
    "settlement_kind IN ('known_no_start','file_completed','media_response_completed','media_remote_terminal','media_chain_completed')");
  sql = replaceExactlyOnce(sql, /UNIQUE\(evidence_kind,evidence_id\)/, `
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
    UNIQUE(evidence_kind,evidence_id)`);
  const objects = database.prepare(`SELECT sql FROM sqlite_schema WHERE tbl_name='host_operations'
    AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`).all();
  database.exec(sql);
  database.exec(`INSERT INTO host_operations_media_receipt_new SELECT * FROM host_operations;
    DROP TABLE host_operations;
    ALTER TABLE host_operations_media_receipt_new RENAME TO host_operations;`);
  for (const object of objects) {
    if (typeof object.sql !== "string") throw new Error("host_media_receipt_migration_invalid_schema_object");
    database.exec(object.sql);
  }
}

/** Never silently weaken a drifted journal schema that does not match the known 145 contract. */
function replaceExactlyOnce(sql: string, pattern: RegExp, replacement: string): string {
  if (Array.from(sql.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))).length !== 1) {
    throw new Error("host_media_receipt_migration_journal_schema_mismatch");
  }
  return sql.replace(pattern, replacement);
}

function addReceiptColumns(database: DatabaseSync, table: "host_media_executions" | "host_media_effects", columns: readonly string[]): void {
  for (const column of columns) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT REFERENCES artifacts(id) ON DELETE RESTRICT`);
  const immutable = columns.map(column => `(OLD.${column} IS NOT NULL AND NEW.${column} IS NOT OLD.${column})`).join(" OR ");
  database.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_receipts BEFORE UPDATE ON ${table} WHEN ${immutable}
    BEGIN SELECT RAISE(ABORT,'host_media_receipt_immutable'); END;`);
}
