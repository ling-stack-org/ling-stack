import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION = 215;
export const RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME = "runtime_concurrency_policy_activation";

const table = "runtime_concurrency_policies";
const predecessorDefinition = `CREATE TABLE runtime_concurrency_policies (
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
const column = "enabled INTEGER NOT NULL DEFAULT 1 CHECK(typeof(enabled)='integer' AND enabled IN (0,1))";
const definition = `${predecessorDefinition.slice(0, -1)}, ${column})`;
const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

export function applyRuntimeConcurrencyPolicyActivationMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const inspect = () => {
    const predecessors = database.prepare("SELECT version,name FROM schema_migrations WHERE version=214 OR name=?").all(table);
    if (predecessors.length !== 1 || predecessors.some(row => row.version !== 214 || row.name !== table)
      || !input.hasMigration(214)) {
      throw new Error("runtime_concurrency_policy_activation.migration_predecessor_missing");
    }
    const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION, RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME);
    if (markers.length > 1
      || markers.some(row => row.version !== RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION
        || row.name !== RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME)
      || Boolean(markers.length) !== input.hasMigration(RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION)) {
      throw new Error("runtime_concurrency_policy_activation.migration_marker_conflict");
    }
    const actual = database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(table);
    if (!actual) throw new Error("runtime_concurrency_policy_activation.migration_schema_missing");
    if (actual.type !== "table" || typeof actual.sql !== "string"
      || normalize(actual.sql) !== normalize(markers.length ? definition : predecessorDefinition)) {
      throw new Error("runtime_concurrency_policy_activation.migration_schema_conflict");
    }
    if (database.prepare("SELECT name FROM sqlite_master WHERE tbl_name=? AND name<>? AND name NOT LIKE 'sqlite_autoindex_%'")
      .all(table, table).length) {
      throw new Error("runtime_concurrency_policy_activation.migration_unexpected_object");
    }
    if (database.prepare(`PRAGMA foreign_key_check(${table})`).all().length) {
      throw new Error("runtime_concurrency_policy_activation.migration_fk_conflict");
    }
    return Boolean(markers.length);
  };
  if (inspect()) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
      input.recordMigration(RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION, RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME);
    }
    if (!inspect()) throw new Error("runtime_concurrency_policy_activation.migration_postcondition");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
