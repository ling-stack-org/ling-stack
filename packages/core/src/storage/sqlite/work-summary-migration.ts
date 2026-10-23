import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORK_SUMMARY_MIGRATION_VERSION = 188;
const name = "create_work_summary_pull_requests";
const tableSql = `CREATE TABLE work_summary_pull_requests (
  url TEXT PRIMARY KEY, created_at TEXT NOT NULL
)`;

export function applyWorkSummaryMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const db = input.database;
  const marker = () => {
    const rows = db.prepare("SELECT version,name FROM schema_migrations WHERE version=176 OR version=? OR name=?")
      .all(WORK_SUMMARY_MIGRATION_VERSION, name);
    const known = rows.filter(row => !(row.version === 176 && row.name === "durable_delegation_budget_authority_v1"));
    if (known.some(row => row.name !== name || ![176, WORK_SUMMARY_MIGRATION_VERSION].includes(Number(row.version)))) {
      throw new Error("work_summary.migration_marker_conflict");
    }
    const canonical = rows.some(row => row.version === WORK_SUMMARY_MIGRATION_VERSION);
    if (canonical !== input.hasMigration(WORK_SUMMARY_MIGRATION_VERSION)) throw new Error("work_summary.migration_marker_conflict");
    return { canonical, recorded: known.length > 0 };
  };
  const inspect = (recorded: boolean) => {
    const row = db.prepare("SELECT type,sql FROM sqlite_master WHERE name='work_summary_pull_requests'").get();
    if (!row) {
      if (recorded) throw new Error("work_summary.migration_table_missing");
      return false;
    }
    // No literals occur in this fixed schema. Whitespace/keyword case alone
    // cannot turn an unrelated table into an accepted historical main table.
    const normalize = (sql: string) => sql.replace(/\s+/gu, "").toLowerCase();
    if (row.type !== "table" || typeof row.sql !== "string" || normalize(row.sql) !== normalize(tableSql)) {
      throw new Error("work_summary.migration_schema_conflict");
    }
    return true;
  };
  const original = marker();
  if (inspect(original.recorded) && original.canonical) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = marker();
    if (!inspect(current.recorded)) db.exec(tableSql);
    if (!current.canonical) input.recordMigration(WORK_SUMMARY_MIGRATION_VERSION, name);
    if (!marker().canonical || !inspect(true)) throw new Error("work_summary.migration_postcondition");
    db.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(db);
    throw error;
  }
}
