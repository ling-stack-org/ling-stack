import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { DEFAULT_RUNNER_ID, LEGACY_PI_RUNNER_ID } from "../../runner-ids.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
export { normalizeRunnerIdsInJson } from "../../runner-ids.js";
export { LEGACY_PI_RUNNER_ID } from "../../runner-ids.js";

export const RUNNER_ID_MIGRATION_VERSION = 178;
export const RUNNER_ID_MIGRATION_NAME = "canonicalize_pi_runner_ids";
export const CANONICAL_PI_RUNNER_ID = DEFAULT_RUNNER_ID;

export interface RunnerIdMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable?: (tableName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

const scalarRunnerColumns: Readonly<Record<string, readonly string[]>> = {
  work_units: ["runner_id", "requested_runner_id", "effective_runner_id"],
  work_unit_attempts: ["runner_id", "requested_runner_id", "effective_runner_id"],
  ai_teammates: ["runner_id"],
  runner_continuations: ["runner_id"],
};

/**
 * Canonicalizes the historical Pi runner alias in durable scalar columns and
 * mutable operational bindings. Immutable JSON snapshots and evidence are
 * deliberately left byte-for-byte intact and projected by read mappers.
 */
export function applyRunnerIdMigration(input: RunnerIdMigrationInput): boolean {
  if (input.hasMigration(RUNNER_ID_MIGRATION_VERSION)) return false;
  const hasTable = input.hasTable ?? ((tableName: string) => tableExists(input.database, tableName));

  input.database.exec("BEGIN IMMEDIATE;");
  try {
    for (const [table, columns] of Object.entries(scalarRunnerColumns)) {
      if (!hasTable(table)) continue;
      const available = tableColumns(input.database, table);
      for (const column of columns) {
        if (!available.has(column)) continue;
        input.database
          .prepare(`UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE ${quoteIdentifier(column)} = ?`)
          .run(CANONICAL_PI_RUNNER_ID, LEGACY_PI_RUNNER_ID);
      }
    }

    input.recordMigration(RUNNER_ID_MIGRATION_VERSION, RUNNER_ID_MIGRATION_NAME);
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableColumns(database: DatabaseSync, table: string): ReadonlySet<string> {
  return new Set((database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<Record<string, SQLOutputValue>>)
    .map((row) => typeof row.name === "string" ? row.name : ""));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
