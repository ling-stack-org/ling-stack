import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const DELEGATION_INSTRUCTION_MIGRATION_VERSION = 178;
const name = "create_delegation_instruction_checkpoint_receipts_v1";
const table = "delegation_instruction_receipts";
const definitions = [{ name: table, type: "table", sql: `CREATE TABLE delegation_instruction_receipts (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES delegation_messages(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
  checkpoint_id TEXT NOT NULL REFERENCES run_progress_checkpoints(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES run_events(id) ON DELETE RESTRICT,
  model_view_index INTEGER NOT NULL CHECK(typeof(model_view_index)='integer' AND model_view_index>0),
  message_digest TEXT NOT NULL CHECK(length(message_digest)=64 AND message_digest NOT GLOB '*[^0-9a-f]*'),
  committed_at TEXT NOT NULL,
  UNIQUE(checkpoint_id,model_view_index)
)` }, ...["UPDATE", "DELETE"].map(operation => ({
  name: `trg_delegation_instruction_receipts_no_${operation.toLowerCase()}`, type: "trigger",
  sql: `CREATE TRIGGER trg_delegation_instruction_receipts_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
    BEGIN SELECT RAISE(ABORT,'delegation instruction receipt is immutable'); END`,
}))];
const normalize = (sql: string): string => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive only. A recorded but missing/altered receipt schema fails closed. */
export function applyDelegationInstructionMigration(input: { readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean; readonly recordMigration: (version: number, name: string) => void }): boolean {
  const db = input.database;
  const inspect = (): boolean => {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(DELEGATION_INSTRUCTION_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== DELEGATION_INSTRUCTION_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(DELEGATION_INSTRUCTION_MIGRATION_VERSION)) throw new Error("delegation.instruction_migration_marker_conflict");
    for (const entry of definitions) {
      const actual = db.prepare("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(entry.name);
      if (!actual) { if (markers.length) throw new Error("delegation.instruction_migration_schema_missing"); continue; }
      if (actual.type !== entry.type || actual.tbl_name !== table || typeof actual.sql !== "string"
        || normalize(actual.sql) !== normalize(entry.sql)) throw new Error("delegation.instruction_migration_schema_conflict");
    }
    if (markers.length && db.prepare(`PRAGMA foreign_key_check(${table})`).all().length) throw new Error("delegation.instruction_migration_foreign_key");
    return markers.length === 1;
  };
  if (inspect()) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const entry of definitions) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(entry.name)) db.exec(entry.sql);
      input.recordMigration(DELEGATION_INSTRUCTION_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("delegation.instruction_migration_postcondition");
    db.exec("COMMIT"); return true;
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
