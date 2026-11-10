import type { SqliteRunStoreMigrationContext } from "./migrations.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

/** Adds lease/intent fields to the existing outbox; never updates conversation history. */
export function applyUserInputDeliveryMigration(context: SqliteRunStoreMigrationContext): void {
  // Guard on actual schema state too: databases from an abandoned WIP checkpoint may have
  // version 133 recorded without these columns existing (its predecessors were skipped).
  if (context.hasMigration(133) && context.hasColumn("user_input_deliveries", "status_revision")) return;
  const { database } = context;
  database.exec("BEGIN IMMEDIATE");
  try {
    const addColumnIfMissing = (columnName: string, statement: string): void => {
      if (!context.hasColumn("user_input_deliveries", columnName)) database.exec(statement);
    };
    addColumnIfMissing(
      "status_revision",
      "ALTER TABLE user_input_deliveries ADD COLUMN status_revision INTEGER NOT NULL DEFAULT 1 CHECK(status_revision > 0);",
    );
    addColumnIfMissing(
      "attempt_count",
      "ALTER TABLE user_input_deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);",
    );
    addColumnIfMissing(
      "updated_at",
      "ALTER TABLE user_input_deliveries ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';",
    );
    addColumnIfMissing(
      "successor_run_id",
      "ALTER TABLE user_input_deliveries ADD COLUMN successor_run_id TEXT;",
    );
    addColumnIfMissing(
      "claim_owner_id",
      "ALTER TABLE user_input_deliveries ADD COLUMN claim_owner_id TEXT;",
    );
    addColumnIfMissing(
      "claim_token",
      "ALTER TABLE user_input_deliveries ADD COLUMN claim_token TEXT;",
    );
    addColumnIfMissing(
      "claim_expires_at",
      "ALTER TABLE user_input_deliveries ADD COLUMN claim_expires_at TEXT;",
    );
    addColumnIfMissing(
      "retry_at",
      "ALTER TABLE user_input_deliveries ADD COLUMN retry_at TEXT;",
    );
    addColumnIfMissing(
      "last_error_code",
      "ALTER TABLE user_input_deliveries ADD COLUMN last_error_code TEXT\n" +
        "  CHECK(last_error_code IS NULL OR last_error_code IN ('receiver_unavailable','receiver_rejected','recoverable_failure'));",
    );
    database.exec([
      "UPDATE user_input_deliveries SET updated_at=created_at WHERE updated_at='';",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_input_delivery_successor ON user_input_deliveries(successor_run_id) WHERE successor_run_id IS NOT NULL;",
      "CREATE INDEX IF NOT EXISTS idx_user_input_delivery_retry ON user_input_deliveries(status,retry_at,claim_expires_at,delivery_id);",
    ].join("\n"));
    context.recordMigration(133, "persist_user_input_delivery_claim");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
