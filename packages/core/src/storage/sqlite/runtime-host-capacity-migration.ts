import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { RUNTIME_RUN_QUEUE_MIGRATION_VERSION, RUNTIME_RUN_QUEUE_MIGRATION_NAME } from "./runtime-run-queue-migration.js";

export const RUNTIME_HOST_CAPACITY_MIGRATION_VERSION = 218;
export const RUNTIME_HOST_CAPACITY_MIGRATION_NAME = "runtime_host_capacity";
export const RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_VERSION = 220;
export const RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_NAME = "runtime_host_capacity_continuations";

const text = (column: string) => `typeof(${column})='text' AND length(trim(${column}))>0 AND instr(${column},char(0))=0`;
const digest = (column: string) => `${text(column)} AND length(${column})=64 AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const timestamp = (column: string) => `${text(column)} AND length(${column})=24
  AND strftime('%Y-%m-%dT%H:%M:%fZ',${column},'+0 days') IS NOT NULL
  AND strftime('%Y-%m-%dT%H:%M:%fZ',${column},'+0 days')=${column}`;
const source = ["run_id", "work_unit_id", "attempt_id", "runtime_instance_id", "fencing_token"];
const receipt = ["reservation_id", "reservation_token", "host_policy_revision", "reserved_at", "dispatch_token"];
const allNull = (columns: readonly string[]) => columns.map(column => `${column} IS NULL`).join(" AND ");
const allPresent = (columns: readonly string[]) => columns.map(column => `${column} IS NOT NULL`).join(" AND ");
const definitions = [
  ["runtime_host_capacity_intents", `CREATE TABLE runtime_host_capacity_intents (
    intent_id TEXT PRIMARY KEY NOT NULL CHECK(${text("intent_id")}),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) CHECK(${text("workspace_id")}),
    workspace_key TEXT NOT NULL CHECK(${text("workspace_key")}),
    canonical_cwd TEXT NOT NULL CHECK(${text("canonical_cwd")}),
    database_path TEXT NOT NULL CHECK(${text("database_path")}),
    database_file_identity TEXT NOT NULL CHECK(${text("database_file_identity")}),
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('attempt','workflow_start','delegation_spawn')),
    owner_key TEXT NOT NULL CHECK(${text("owner_key")}),
    authority_digest TEXT NOT NULL CHECK(${digest("authority_digest")}),
    run_id TEXT REFERENCES run_sessions(id) CHECK(run_id IS NULL OR (${text("run_id")})),
    work_unit_id TEXT REFERENCES work_units(id) CHECK(work_unit_id IS NULL OR (${text("work_unit_id")})),
    attempt_id TEXT UNIQUE REFERENCES work_unit_attempts(id) CHECK(attempt_id IS NULL OR (${text("attempt_id")})),
    runtime_instance_id TEXT CHECK(runtime_instance_id IS NULL OR (${text("runtime_instance_id")})),
    fencing_token TEXT CHECK(fencing_token IS NULL OR (${text("fencing_token")})),
    created_at TEXT NOT NULL CHECK(${timestamp("created_at")}),
    reservation_id TEXT UNIQUE CHECK(reservation_id IS NULL OR (${text("reservation_id")})),
    reservation_token TEXT CHECK(reservation_token IS NULL OR (${digest("reservation_token")})),
    host_policy_revision INTEGER CHECK(host_policy_revision IS NULL OR
      (typeof(host_policy_revision)='integer' AND host_policy_revision BETWEEN 1 AND 9007199254740991)),
    reserved_at TEXT CHECK(reserved_at IS NULL OR (${timestamp("reserved_at")})),
    dispatch_token TEXT UNIQUE CHECK(dispatch_token IS NULL OR (${digest("dispatch_token")})),
    dispatched_at TEXT CHECK(dispatched_at IS NULL OR (${timestamp("dispatched_at")})),
    revoked_at TEXT CHECK(revoked_at IS NULL OR (${timestamp("revoked_at")})),
    UNIQUE(workspace_id,owner_kind,owner_key),
    CHECK((${allNull(source)}) OR (${allPresent(source)})),
    CHECK(owner_kind<>'attempt' OR (${allPresent(source)})),
    CHECK((${allNull(receipt)}) OR (${allPresent(receipt)})),
    CHECK(dispatched_at IS NULL OR (reservation_id IS NOT NULL AND revoked_at IS NULL)),
    CHECK(revoked_at IS NULL OR (reservation_id IS NOT NULL AND dispatched_at IS NULL))
  )`],
  ["runtime_host_capacity_releases", `CREATE TABLE runtime_host_capacity_releases (
    intent_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_host_capacity_intents(intent_id) CHECK(${text("intent_id")}),
    reservation_id TEXT NOT NULL CHECK(${text("reservation_id")}),
    reservation_token TEXT NOT NULL CHECK(${digest("reservation_token")}),
    kind TEXT NOT NULL CHECK(kind IN ('no_dispatch','stopped')),
    proof_json TEXT NOT NULL CHECK(${text("proof_json")} AND json_valid(proof_json)),
    proof_digest TEXT NOT NULL CHECK(${digest("proof_digest")}),
    created_at TEXT NOT NULL CHECK(${timestamp("created_at")}),
    acknowledged_at TEXT CHECK(acknowledged_at IS NULL OR (${timestamp("acknowledged_at")}))
  )`],
] as const;
// SQLite quotes the replacement table name when ALTER TABLE ... RENAME TO publishes it.
export const runtimeHostCapacityContinuationIntentDefinition = definitions[0][1]
  .replace("CREATE TABLE runtime_host_capacity_intents", 'CREATE TABLE "runtime_host_capacity_intents"')
  .replace("owner_kind IN ('attempt','workflow_start','delegation_spawn')",
    "owner_kind IN ('attempt','workflow_start','delegation_spawn','approval_resume_pending','user_input_continuation')");
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyRuntimeHostCapacityMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const inspect = () => {
    const predecessors = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_RUN_QUEUE_MIGRATION_VERSION, RUNTIME_RUN_QUEUE_MIGRATION_NAME);
    if (predecessors.length !== 1
      || predecessors.some(row => row.version !== RUNTIME_RUN_QUEUE_MIGRATION_VERSION || row.name !== RUNTIME_RUN_QUEUE_MIGRATION_NAME)
      || !input.hasMigration(RUNTIME_RUN_QUEUE_MIGRATION_VERSION)) {
      throw new Error("runtime_host_capacity.migration_predecessor_missing");
    }
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_HOST_CAPACITY_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_MIGRATION_NAME);
    if (markers.length > 1
      || markers.some(row => row.version !== RUNTIME_HOST_CAPACITY_MIGRATION_VERSION || row.name !== RUNTIME_HOST_CAPACITY_MIGRATION_NAME)
      || Boolean(markers.length) !== input.hasMigration(RUNTIME_HOST_CAPACITY_MIGRATION_VERSION)) {
      throw new Error("runtime_host_capacity.migration_marker_conflict");
    }
    const successors = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_NAME);
    if (successors.length > 1
      || successors.some(row => row.version !== RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_VERSION
        || row.name !== RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_NAME)
      || Boolean(successors.length) !== input.hasMigration(RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_VERSION)
      || (successors.length && !markers.length)) {
      throw new Error("runtime_host_capacity.migration_marker_conflict");
    }
    if (successors.length) {
      const delegations = database.prepare("SELECT version,name FROM schema_migrations WHERE version=219 OR name=?")
        .all("runtime_delegation_spawn_admissions");
      if (delegations.length !== 1 || delegations[0]!.version !== 219
        || delegations[0]!.name !== "runtime_delegation_spawn_admissions" || !input.hasMigration(219)) {
        throw new Error("runtime_host_capacity.migration_predecessor_missing");
      }
    }
    for (const [table, definition] of definitions) {
      const objects = database.prepare(`SELECT 'main' AS schema_name,type,name,sql FROM main.sqlite_master WHERE name=? COLLATE NOCASE
        UNION ALL SELECT 'temp' AS schema_name,type,name,sql FROM temp.sqlite_master WHERE name=? COLLATE NOCASE`).all(table, table);
      const actual = objects[0];
      const expected = successors.length && table === "runtime_host_capacity_intents"
        ? runtimeHostCapacityContinuationIntentDefinition : definition;
      if (objects.length > 1 || (actual && (actual.schema_name !== "main" || actual.name !== table
        || actual.type !== "table" || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(expected)))) {
        throw new Error("runtime_host_capacity.migration_schema_conflict");
      }
      if (markers.length && !actual) throw new Error("runtime_host_capacity.migration_schema_missing");
      if (!markers.length && actual && database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
        throw new Error("runtime_host_capacity.migration_unmarked_data");
      }
      if (database.prepare(`SELECT name FROM main.sqlite_master WHERE tbl_name=? COLLATE NOCASE AND name<>?
          AND NOT (type='index' AND sql IS NULL AND name GLOB 'sqlite_autoindex_*')
        UNION ALL SELECT name FROM temp.sqlite_master WHERE tbl_name=? COLLATE NOCASE`)
        .all(table, table, table).length) {
        throw new Error("runtime_host_capacity.migration_unexpected_object");
      }
      if (markers.length && database.prepare(`PRAGMA foreign_key_check(${table})`).all().length) {
        throw new Error("runtime_host_capacity.migration_fk_conflict");
      }
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const [table, definition] of definitions) {
        if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) database.exec(definition);
      }
      input.recordMigration(RUNTIME_HOST_CAPACITY_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_MIGRATION_NAME);
    }
    if (!inspect()) throw new Error("runtime_host_capacity.migration_postcondition");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
