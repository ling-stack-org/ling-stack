import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const RUNNER_ID_MIGRATION_VERSION = 178;
export const RUNNER_ID_MIGRATION_NAME = "canonicalize_pi_runner_ids";
export const LEGACY_PI_RUNNER_ID = "pi-coding-agent";
export const CANONICAL_PI_RUNNER_ID = "pi";

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

const jsonRunnerColumns: Readonly<Record<string, readonly string[]>> = {
  work_units: ["request_json"],
  run_sessions: ["task_snapshot_json", "provider_snapshot_json", "request_snapshot_json"],
  channel_workflows: ["metadata_json"],
  channel_workflow_steps: ["metadata_json"],
  conversation_context_snapshots: ["payload_json"],
};

const jsonFingerprintColumns: Readonly<Record<string, string>> = {
  conversation_context_snapshots: "payload_fingerprint",
};

/**
 * Canonicalizes the historical Pi runner alias in durable scalar columns and
 * known JSON snapshots. The migration is deliberately table/column aware so
 * arbitrary user text is never rewritten.
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

    for (const [table, columns] of Object.entries(jsonRunnerColumns)) {
      if (!hasTable(table)) continue;
      const available = tableColumns(input.database, table);
      for (const column of columns) {
        if (!available.has(column)) continue;
        const fingerprintColumn = jsonFingerprintColumns[table];
        rewriteJsonColumn(input.database, table, column, fingerprintColumn && available.has(fingerprintColumn) ? fingerprintColumn : undefined);
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

export function normalizeRunnerIdsInJson(value: unknown): { readonly value: unknown; readonly changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = normalizeRunnerIdsInJson(item);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!isRecord(value)) return { value, changed: false };

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeRunnerIdsInJson(child);
    let nextChild = normalized.value;
    if (isRunnerIdKey(key) && nextChild === LEGACY_PI_RUNNER_ID) {
      nextChild = CANONICAL_PI_RUNNER_ID;
    }
    changed ||= normalized.changed || nextChild !== child;
    next[key] = nextChild;
  }
  return { value: changed ? next : value, changed };
}

function rewriteJsonColumn(database: DatabaseSync, table: string, column: string, fingerprintColumn?: string): void {
  const fingerprintSelection = fingerprintColumn ? `, ${quoteIdentifier(fingerprintColumn)} AS __migration_fingerprint` : "";
  const rows = database
    .prepare(`SELECT rowid AS __migration_rowid, ${quoteIdentifier(column)} AS __migration_value${fingerprintSelection} FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} LIKE ?`)
    .all(`%${LEGACY_PI_RUNNER_ID}%`) as Array<Record<string, SQLOutputValue>>;
  const update = database.prepare(fingerprintColumn
    ? `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ?, ${quoteIdentifier(fingerprintColumn)} = ? WHERE rowid = ?`
    : `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE rowid = ?`);
  for (const row of rows) {
    const raw = row.__migration_value;
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string") {
      throw new Error(`runner_id_migration_invalid_json:${table}.${column}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`runner_id_migration_invalid_json:${table}.${column}`, { cause: error });
    }
    const normalized = normalizeRunnerIdsInJson(parsed);
    if (!normalized.changed) continue;
    let nextValue = normalized.value;
    let nextFingerprint = row.__migration_fingerprint;
    if (fingerprintColumn && isRecord(nextValue) && typeof nextValue.fingerprint === "string") {
      const { fingerprint: _fingerprint, ...body } = nextValue;
      const fingerprint = hashJson(body);
      nextValue = { ...body, fingerprint };
      nextFingerprint = fingerprint;
    }
    if (fingerprintColumn) {
      update.run(JSON.stringify(nextValue), nextFingerprint ?? null, row.__migration_rowid);
    } else {
      update.run(JSON.stringify(nextValue), row.__migration_rowid);
    }
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isRunnerIdKey(key: string): boolean {
  return key === "runnerId" || key === "requestedRunnerId" || key === "effectiveRunnerId"
    || key === "runner_id" || key === "requested_runner_id" || key === "effective_runner_id";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
