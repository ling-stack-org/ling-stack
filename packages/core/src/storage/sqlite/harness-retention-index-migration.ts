import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const HARNESS_RETENTION_INDEX_MIGRATION_VERSION = 179;
const name = "create_harness_retention_due_cursor_index_v2";
const index = "idx_harness_retention_due_v2";
const sql = `CREATE INDEX ${index} ON harness_artifact_retention(retain_until,artifact_id) WHERE pruned_at IS NULL`;
const normalize = (value: string): string => value.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive repair for deadline-first retention scans; migration 177 remains immutable. */
export function applyHarnessRetentionIndexMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): boolean {
  const inspect = (): boolean => {
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(HARNESS_RETENTION_INDEX_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== HARNESS_RETENTION_INDEX_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(HARNESS_RETENTION_INDEX_MIGRATION_VERSION)) {
      throw new Error("harness_retention_index_migration_marker_conflict");
    }
    const actual = input.database.prepare("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(index);
    if (actual && (actual.type !== "index" || actual.tbl_name !== "harness_artifact_retention"
      || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(sql))) {
      throw new Error("harness_retention_index_migration_schema_conflict");
    }
    if (markers.length && !actual) throw new Error("harness_retention_index_migration_schema_missing");
    return markers.length === 1;
  };

  if (inspect()) return false;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      input.database.exec(sql);
      input.recordMigration(HARNESS_RETENTION_INDEX_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("harness_retention_index_migration_postcondition");
    input.database.exec("COMMIT");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}
