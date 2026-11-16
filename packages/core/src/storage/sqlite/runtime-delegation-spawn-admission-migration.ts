import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { RUNTIME_HOST_CAPACITY_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_MIGRATION_NAME } from "./runtime-host-capacity-migration.js";

export const RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_VERSION = 219;
export const RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_NAME = "runtime_delegation_spawn_admissions";

const table = RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_NAME;
const definition = `CREATE TABLE runtime_delegation_spawn_admissions (
  admission_id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(admission_id))>0),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES delegation_budget_reservations(id),
  attempt_number INTEGER NOT NULL CHECK(typeof(attempt_number)='integer' AND attempt_number BETWEEN 1 AND 9007199254740991),
  expected_step_revision INTEGER NOT NULL CHECK(typeof(expected_step_revision)='integer' AND expected_step_revision BETWEEN 0 AND 9007199254740991),
  runtime_instance_id TEXT NOT NULL CHECK(length(trim(runtime_instance_id))>0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key))>0),
  status TEXT NOT NULL CHECK(status IN ('pending','reserved','claimed','abandoned')),
  host_intent_id TEXT UNIQUE REFERENCES runtime_host_capacity_intents(intent_id),
  attempt_id TEXT UNIQUE REFERENCES work_unit_attempts(id),
  attempt_runtime_instance_id TEXT,
  fencing_token TEXT,
  created_at TEXT NOT NULL CHECK(length(trim(created_at))>0),
  updated_at TEXT NOT NULL CHECK(length(trim(updated_at))>0),
  claimed_at TEXT,
  abandoned_at TEXT,
  CHECK((status IN ('pending','reserved','abandoned') AND attempt_id IS NULL AND attempt_runtime_instance_id IS NULL AND fencing_token IS NULL)
    OR (status='claimed' AND attempt_id IS NOT NULL AND attempt_runtime_instance_id IS NOT NULL AND fencing_token IS NOT NULL)),
  CHECK((status='claimed' AND claimed_at IS NOT NULL) OR status<>'claimed'),
  CHECK((status='abandoned' AND abandoned_at IS NOT NULL) OR status<>'abandoned')
)`;
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyRuntimeDelegationSpawnAdmissionMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const inspect = () => {
    const predecessors = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_HOST_CAPACITY_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_MIGRATION_NAME);
    if (predecessors.length !== 1
      || predecessors.some(row => row.version !== RUNTIME_HOST_CAPACITY_MIGRATION_VERSION || row.name !== RUNTIME_HOST_CAPACITY_MIGRATION_NAME)
      || !input.hasMigration(RUNTIME_HOST_CAPACITY_MIGRATION_VERSION)) {
      throw new Error("runtime_delegation_spawn_admission.migration_predecessor_missing");
    }
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_VERSION, table);
    if (markers.length > 1
      || markers.some(row => row.version !== RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_VERSION || row.name !== table)
      || Boolean(markers.length) !== input.hasMigration(RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_VERSION)) {
      throw new Error("runtime_delegation_spawn_admission.migration_marker_conflict");
    }
    const actual = database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(table);
    if (actual && (actual.type !== "table" || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(definition))) {
      throw new Error("runtime_delegation_spawn_admission.migration_schema_conflict");
    }
    if (markers.length && !actual) throw new Error("runtime_delegation_spawn_admission.migration_schema_missing");
    if (!markers.length && actual && database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error("runtime_delegation_spawn_admission.migration_unmarked_data");
    }
    if (database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name<>? AND name NOT LIKE 'sqlite_autoindex_%'")
      .all(table, table).length) throw new Error("runtime_delegation_spawn_admission.migration_unexpected_object");
    if (markers.length && database.prepare(`PRAGMA foreign_key_check(${table})`).all().length) {
      throw new Error("runtime_delegation_spawn_admission.migration_fk_conflict");
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) database.exec(definition);
      input.recordMigration(RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_VERSION, table);
    }
    if (!inspect()) throw new Error("runtime_delegation_spawn_admission.migration_postcondition");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
