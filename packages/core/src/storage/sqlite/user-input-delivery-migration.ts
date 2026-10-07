import type { SqliteRunStoreMigrationContext } from "./migrations.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

/** Adds lease/intent fields to the existing outbox; never updates conversation history. */
export function applyUserInputDeliveryMigration(context: SqliteRunStoreMigrationContext): void {
  if (context.hasMigration(133)) return;
  const { database } = context;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec([
      "ALTER TABLE user_input_deliveries ADD COLUMN status_revision INTEGER NOT NULL DEFAULT 1 CHECK(status_revision > 0);",
      "ALTER TABLE user_input_deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);",
      "ALTER TABLE user_input_deliveries ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';",
      "ALTER TABLE user_input_deliveries ADD COLUMN successor_run_id TEXT;",
      "ALTER TABLE user_input_deliveries ADD COLUMN claim_owner_id TEXT;",
      "ALTER TABLE user_input_deliveries ADD COLUMN claim_token TEXT;",
      "ALTER TABLE user_input_deliveries ADD COLUMN claim_expires_at TEXT;",
      "ALTER TABLE user_input_deliveries ADD COLUMN retry_at TEXT;",
      "ALTER TABLE user_input_deliveries ADD COLUMN last_error_code TEXT",
      "  CHECK(last_error_code IS NULL OR last_error_code IN ('receiver_unavailable','receiver_rejected','recoverable_failure'));",
      "UPDATE user_input_deliveries SET updated_at=created_at;",
      "CREATE UNIQUE INDEX idx_user_input_delivery_successor ON user_input_deliveries(successor_run_id) WHERE successor_run_id IS NOT NULL;",
      "CREATE INDEX idx_user_input_delivery_retry ON user_input_deliveries(status,retry_at,claim_expires_at,delivery_id);",
    ].join("\n"));
    context.recordMigration(133, "persist_user_input_delivery_claim");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
