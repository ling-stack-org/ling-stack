import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const CHANNEL_PENDING_OPERATION_MIGRATION_VERSION = 191;
const name = "create_channel_pending_operation_resolutions";
const table = "channel_pending_operation_resolutions";
const sql = `CREATE TABLE channel_pending_operation_resolutions (
  pending_decision_id TEXT PRIMARY KEY REFERENCES channel_intent_decisions(id) ON DELETE CASCADE,
  draft_fingerprint TEXT NOT NULL,
  answer_item_id TEXT NOT NULL UNIQUE REFERENCES conversation_items(id) ON DELETE CASCADE,
  answer_revision INTEGER NOT NULL CHECK(typeof(answer_revision)='integer' AND answer_revision>=0),
  question_revision INTEGER NOT NULL CHECK(typeof(question_revision)='integer' AND question_revision>=0),
  decision_id TEXT NOT NULL UNIQUE REFERENCES channel_intent_decisions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
)`;
const normalize = (value: string) => value.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

/** Additive ledger only. No existing decision, conversation or approval is rewritten. */
export function applyChannelPendingOperationMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const inspect = () => {
    const markers = input.database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(CHANNEL_PENDING_OPERATION_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== CHANNEL_PENDING_OPERATION_MIGRATION_VERSION || row.name !== name)
      || Boolean(markers.length) !== input.hasMigration(CHANNEL_PENDING_OPERATION_MIGRATION_VERSION)) {
      throw new Error("channel_pending_operation.migration_marker_conflict");
    }
    const actual = input.database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(table);
    if (actual && (actual.type !== "table" || typeof actual.sql !== "string" || normalize(actual.sql) !== normalize(sql))) {
      throw new Error("channel_pending_operation.migration_schema_conflict");
    }
    if (markers.length && !actual) throw new Error("channel_pending_operation.migration_table_missing");
    return Boolean(markers.length);
  };
  if (inspect()) return;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      input.database.exec(sql);
      input.recordMigration(CHANNEL_PENDING_OPERATION_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("channel_pending_operation.migration_postcondition");
    input.database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}
