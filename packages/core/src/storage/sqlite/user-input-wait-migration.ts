import type { SqliteRunStoreMigrationContext } from "./migrations.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

/** Adds question-owned checkpoint fields; existing conversation/history rows are untouched. */
export function applyUserInputWaitMigration(context: SqliteRunStoreMigrationContext): void {
  if (context.hasMigration(132)) return;
  const { database } = context;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ALTER TABLE user_input_requests ADD COLUMN wait_status TEXT
        CHECK(wait_status IS NULL OR wait_status IN ('waiting','resuming','resumed','cancelled','blocked'));
      ALTER TABLE user_input_requests ADD COLUMN wait_revision INTEGER NOT NULL DEFAULT 0 CHECK(wait_revision >= 0);
      ALTER TABLE user_input_requests ADD COLUMN wait_checkpoint_json TEXT;
      ALTER TABLE user_input_requests ADD COLUMN wait_checkpoint_fingerprint TEXT;
      CREATE UNIQUE INDEX idx_user_input_wait_attempt ON user_input_requests(workspace_id, source_attempt_id)
        WHERE wait_status IN ('waiting','resuming');
      CREATE INDEX idx_user_input_wait_status ON user_input_requests(workspace_id, wait_status, request_id);
    `);
    context.recordMigration(132, "persist_user_input_yield_checkpoint");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
