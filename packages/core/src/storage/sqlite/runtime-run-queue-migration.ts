import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION,
  RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_NAME } from "./runtime-delegation-capacity-admission-migration.js";

export const RUNTIME_RUN_QUEUE_MIGRATION_VERSION = 217;
export const RUNTIME_RUN_QUEUE_MIGRATION_NAME = "runtime_run_queue";

const table = RUNTIME_RUN_QUEUE_MIGRATION_NAME;
const definition = `CREATE TABLE runtime_run_queue (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE REFERENCES run_sessions(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  work_unit_id TEXT NOT NULL UNIQUE REFERENCES work_units(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES work_unit_attempts(id),
  runtime_instance_id TEXT NOT NULL,
  fencing_token TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK(typeof(snapshot_digest)='text' AND length(snapshot_digest)=64 AND length(CAST(snapshot_digest AS BLOB))=64 AND snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  group_key TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('resource_conflict','runtime_semaphore_conflict')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  last_selected INTEGER NOT NULL DEFAULT 0 CHECK(typeof(last_selected)='integer' AND last_selected BETWEEN 0 AND 9007199254740991),
  claim_owner_id TEXT,
  claim_token TEXT,
  claim_runtime_instance_id TEXT,
  claim_expires_at TEXT,
  retry_at TEXT,
  dispatched_at TEXT,
  CHECK((claim_owner_id IS NULL AND claim_token IS NULL AND claim_runtime_instance_id IS NULL AND claim_expires_at IS NULL)
    OR (claim_owner_id IS NOT NULL AND length(trim(claim_owner_id))>0
      AND claim_token IS NOT NULL AND length(trim(claim_token))>0
      AND claim_runtime_instance_id IS NOT NULL AND length(trim(claim_runtime_instance_id))>0
      AND claim_expires_at IS NOT NULL AND length(trim(claim_expires_at))>0)),
  CHECK(dispatched_at IS NULL OR claim_owner_id IS NOT NULL)
)`;
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyRuntimeRunQueueMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const inspect = () => {
    const predecessors = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION, RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_NAME);
    if (predecessors.length !== 1
      || predecessors.some(row => row.version !== RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION
        || row.name !== RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_NAME)
      || !input.hasMigration(RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION)) {
      throw new Error("runtime_run_queue.migration_predecessor_missing");
    }
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_RUN_QUEUE_MIGRATION_VERSION, table);
    if (markers.length > 1
      || markers.some(row => row.version !== RUNTIME_RUN_QUEUE_MIGRATION_VERSION || row.name !== table)
      || Boolean(markers.length) !== input.hasMigration(RUNTIME_RUN_QUEUE_MIGRATION_VERSION)) {
      throw new Error("runtime_run_queue.migration_marker_conflict");
    }
    const objects = database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").all(table);
    const actual = objects[0];
    if (objects.length > 1 || (actual && (actual.type !== "table" || typeof actual.sql !== "string"
      || normalize(actual.sql) !== normalize(definition)))) {
      throw new Error("runtime_run_queue.migration_schema_conflict");
    }
    if (markers.length && !actual) throw new Error("runtime_run_queue.migration_schema_missing");
    if (!markers.length && actual && database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error("runtime_run_queue.migration_unmarked_data");
    }
    if (database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name<>? AND name NOT LIKE 'sqlite_autoindex_%'")
      .all(table, table).length) {
      throw new Error("runtime_run_queue.migration_unexpected_object");
    }
    if (markers.length && database.prepare(`PRAGMA foreign_key_check(${table})`).all().length) {
      throw new Error("runtime_run_queue.migration_fk_conflict");
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) database.exec(definition);
      input.recordMigration(RUNTIME_RUN_QUEUE_MIGRATION_VERSION, table);
    }
    if (!inspect()) throw new Error("runtime_run_queue.migration_postcondition");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
