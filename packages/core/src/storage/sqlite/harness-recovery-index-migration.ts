import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const HARNESS_RECOVERY_INDEX_MIGRATION_VERSION = 180;
const migrationName = "create_harness_recovery_discovery_indexes_v1";
const definitions = [
  ["idx_harness_delegation_charge_reservation", "delegation_budget_charges", "(reservation_id)"],
  ["idx_harness_delegation_reservation_created", "delegation_budget_reservations", "(created_at,id)"],
  ["idx_harness_work_units_discovery", "work_units", "(kind,status,created_at DESC,id DESC)"],
  ["idx_harness_continuations_due", "runner_continuations", "(state,COALESCE(next_attempt_at,created_at),created_at,id) WHERE state='prepared'"],
  ["idx_harness_continuations_scheduled_due", "runner_continuations", "(state,next_attempt_at,created_at,id) WHERE state='prepared' AND next_attempt_at IS NOT NULL"],
] as const;
const normalize = (value: string): string => value.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive only: historical domain migrations and persisted facts stay unchanged. */
export function applyHarnessRecoveryIndexMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): boolean {
  const inspect = (): boolean => {
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(HARNESS_RECOVERY_INDEX_MIGRATION_VERSION, migrationName);
    if (markers.length > 1 || markers.some(row => row.version !== HARNESS_RECOVERY_INDEX_MIGRATION_VERSION || row.name !== migrationName)
      || Boolean(markers.length) !== input.hasMigration(HARNESS_RECOVERY_INDEX_MIGRATION_VERSION)) {
      throw new Error("harness_recovery_index_migration_marker_conflict");
    }
    for (const [name, table, suffix] of definitions) {
      const row = input.database.prepare("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(name);
      if (row && (row.type !== "index" || row.tbl_name !== table || typeof row.sql !== "string"
        || normalize(row.sql) !== normalize(`CREATE INDEX ${name} ON ${table}${suffix}`))) {
        throw new Error("harness_recovery_index_migration_schema_conflict");
      }
      if (markers.length && !row) throw new Error("harness_recovery_index_migration_schema_missing");
    }
    return markers.length === 1;
  };
  if (inspect()) return false;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const [name, table, suffix] of definitions) {
        if (!input.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name)) {
          input.database.exec(`CREATE INDEX ${name} ON ${table}${suffix}`);
        }
      }
      input.recordMigration(HARNESS_RECOVERY_INDEX_MIGRATION_VERSION, migrationName);
    }
    if (!inspect()) throw new Error("harness_recovery_index_migration_postcondition");
    input.database.exec("COMMIT");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}
