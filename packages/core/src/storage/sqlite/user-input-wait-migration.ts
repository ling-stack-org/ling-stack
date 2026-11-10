import type { SqliteRunStoreMigrationContext } from "./migrations.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

/** Adds question-owned checkpoint fields; existing conversation/history rows are untouched. */
export function applyUserInputWaitMigration(context: SqliteRunStoreMigrationContext): void {
  // Guard on actual schema state too: databases from an abandoned WIP checkpoint may have
  // version 132 recorded under an unrelated migration name without these columns existing.
  if (context.hasMigration(132) && context.hasColumn("user_input_requests", "wait_status")) return;
  const { database } = context;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!context.hasColumn("user_input_requests", "wait_status")) {
      database.exec(
        "ALTER TABLE user_input_requests ADD COLUMN wait_status TEXT\n" +
          "        CHECK(wait_status IS NULL OR wait_status IN ('waiting','resuming','resumed','cancelled','blocked'));",
      );
    }
    if (!context.hasColumn("user_input_requests", "wait_revision")) {
      database.exec(
        "ALTER TABLE user_input_requests ADD COLUMN wait_revision INTEGER NOT NULL DEFAULT 0 CHECK(wait_revision >= 0);",
      );
    }
    if (!context.hasColumn("user_input_requests", "wait_checkpoint_json")) {
      database.exec("ALTER TABLE user_input_requests ADD COLUMN wait_checkpoint_json TEXT;");
    }
    if (!context.hasColumn("user_input_requests", "wait_checkpoint_fingerprint")) {
      database.exec("ALTER TABLE user_input_requests ADD COLUMN wait_checkpoint_fingerprint TEXT;");
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_input_wait_attempt ON user_input_requests(workspace_id, source_attempt_id)
        WHERE wait_status IN ('waiting','resuming');
      CREATE INDEX IF NOT EXISTS idx_user_input_wait_status ON user_input_requests(workspace_id, wait_status, request_id);
    `);
    context.recordMigration(132, "persist_user_input_yield_checkpoint");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
