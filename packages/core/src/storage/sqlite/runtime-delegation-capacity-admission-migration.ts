import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION,
  RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME } from "./runtime-concurrency-policy-activation-migration.js";

export const RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION = 216;
export const RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_NAME = "runtime_delegation_capacity_admissions";

const table = RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_NAME;
const definition = `CREATE TABLE runtime_delegation_capacity_admissions (
  reservation_id TEXT NOT NULL REFERENCES delegation_budget_reservations(id),
  attempt_number INTEGER NOT NULL CHECK(typeof(attempt_number)='integer' AND attempt_number BETWEEN 1 AND 9007199254740991),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider_key TEXT NOT NULL CHECK(length(trim(provider_key))>0),
  runner_id TEXT NOT NULL CHECK(length(trim(runner_id))>0),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision BETWEEN 1 AND 9007199254740991),
  admitted_at TEXT NOT NULL CHECK(length(trim(admitted_at))>0),
  PRIMARY KEY(reservation_id,attempt_number)
)`;
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyRuntimeDelegationCapacityAdmissionMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const inspect = () => {
    const predecessors = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION, RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME);
    if (predecessors.length !== 1
      || predecessors.some(row => row.version !== RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION
        || row.name !== RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME)
      || !input.hasMigration(RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION)) {
      throw new Error("runtime_delegation_capacity_admission.migration_predecessor_missing");
    }
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION, table);
    if (markers.length > 1
      || markers.some(row => row.version !== RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION || row.name !== table)
      || Boolean(markers.length) !== input.hasMigration(RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION)) {
      throw new Error("runtime_delegation_capacity_admission.migration_marker_conflict");
    }
    const objects = database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").all(table);
    const actual = objects[0];
    if (objects.length > 1 || (actual && (actual.type !== "table" || typeof actual.sql !== "string"
      || normalize(actual.sql) !== normalize(definition)))) {
      throw new Error("runtime_delegation_capacity_admission.migration_schema_conflict");
    }
    if (markers.length && !actual) throw new Error("runtime_delegation_capacity_admission.migration_schema_missing");
    if (!markers.length && actual && database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error("runtime_delegation_capacity_admission.migration_unmarked_data");
    }
    if (database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name<>? AND name NOT LIKE 'sqlite_autoindex_%'")
      .all(table, table).length) {
      throw new Error("runtime_delegation_capacity_admission.migration_unexpected_object");
    }
    if (markers.length && database.prepare(`PRAGMA foreign_key_check(${table})`).all().length) {
      throw new Error("runtime_delegation_capacity_admission.migration_fk_conflict");
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) database.exec(definition);
      input.recordMigration(RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION, table);
    }
    if (!inspect()) throw new Error("runtime_delegation_capacity_admission.migration_postcondition");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
