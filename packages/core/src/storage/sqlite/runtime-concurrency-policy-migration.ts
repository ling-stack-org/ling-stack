import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION,
  RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME } from "./runtime-concurrency-policy-activation-migration.js";

export const RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION = 214;
export const RUNTIME_CONCURRENCY_POLICY_MIGRATION_NAME = "runtime_concurrency_policies";

const table = RUNTIME_CONCURRENCY_POLICY_MIGRATION_NAME;
const definition = `CREATE TABLE runtime_concurrency_policies (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id),
  runtime_instance_id TEXT NOT NULL CHECK(length(trim(runtime_instance_id))>0),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  max_concurrent_runs INTEGER NOT NULL CHECK(typeof(max_concurrent_runs)='integer' AND max_concurrent_runs BETWEEN 1 AND 64),
  max_read_only_runs INTEGER NOT NULL CHECK(typeof(max_read_only_runs)='integer' AND max_read_only_runs BETWEEN 1 AND 64),
  max_workspace_write_runs INTEGER NOT NULL CHECK(typeof(max_workspace_write_runs)='integer' AND max_workspace_write_runs BETWEEN 1 AND 4),
  max_runs_per_provider INTEGER NOT NULL CHECK(typeof(max_runs_per_provider)='integer' AND max_runs_per_provider BETWEEN 1 AND 64),
  max_runs_per_runner INTEGER NOT NULL CHECK(typeof(max_runs_per_runner)='integer' AND max_runs_per_runner BETWEEN 1 AND 64),
  installed_at TEXT NOT NULL CHECK(length(trim(installed_at))>0)
)`;
const successorDefinition = `${definition.slice(0, -1)}, enabled INTEGER NOT NULL DEFAULT 1 CHECK(typeof(enabled)='integer' AND enabled IN (0,1)))`;
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyRuntimeConcurrencyPolicyMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const inspect = () => {
    if (database.prepare("SELECT name FROM schema_migrations WHERE version=213").get()?.name !== "workflow_conflict_recoveries") {
      throw new Error("runtime_concurrency_policy.migration_predecessor_missing");
    }
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION, table);
    if (markers.length > 1
      || markers.some(row => row.version !== RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION || row.name !== table)
      || Boolean(markers.length) !== input.hasMigration(RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION)) {
      throw new Error("runtime_concurrency_policy.migration_marker_conflict");
    }
    const successors = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION, RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME);
    if (successors.length > 1
      || successors.some(row => row.version !== RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION
        || row.name !== RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME)
      || Boolean(successors.length) !== input.hasMigration(RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION)
      || (successors.length && !markers.length)) {
      throw new Error("runtime_concurrency_policy.migration_marker_conflict");
    }
    const actual = database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(table);
    if (actual && (actual.type !== "table" || typeof actual.sql !== "string"
      || normalize(actual.sql) !== normalize(successors.length ? successorDefinition : definition))) {
      throw new Error("runtime_concurrency_policy.migration_schema_conflict");
    }
    if (markers.length && !actual) throw new Error("runtime_concurrency_policy.migration_schema_missing");
    if (!markers.length && actual && database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error("runtime_concurrency_policy.migration_unmarked_data");
    }
    if (database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name<>? AND name NOT LIKE 'sqlite_autoindex_%'")
      .all(table, table).length) {
      throw new Error("runtime_concurrency_policy.migration_unexpected_object");
    }
    if (markers.length && database.prepare(`PRAGMA foreign_key_check(${table})`).all().length) {
      throw new Error("runtime_concurrency_policy.migration_fk_conflict");
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) database.exec(definition);
      input.recordMigration(RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION, table);
    }
    if (!inspect()) throw new Error("runtime_concurrency_policy.migration_postcondition");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
