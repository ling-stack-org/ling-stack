import type { SqliteRunStoreMigrationContext } from "./migrations.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

/** Add domain storage only; never rewrites existing conversation history. */
export function applyUserInputMigration(context: SqliteRunStoreMigrationContext): void {
  // Guard on actual schema state too: databases from an abandoned WIP checkpoint may have
  // version 131 recorded under an unrelated migration name without these tables existing.
  if (context.hasMigration(131) && context.hasTable("user_input_deliveries")) return;
  const { database } = context;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS user_input_requests (
        request_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES ling_threads(id) ON DELETE CASCADE,
        request_version INTEGER NOT NULL CHECK(request_version = 1),
        status_revision INTEGER NOT NULL CHECK(status_revision > 0),
        status TEXT NOT NULL CHECK(status IN ('pending','answered','skipped','cancelled','expired','superseded')),
        source_run_id TEXT NOT NULL,
        source_attempt_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        source_json TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        tool_input_json TEXT NOT NULL,
        item_id TEXT NOT NULL UNIQUE REFERENCES conversation_items(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        UNIQUE(workspace_id, source_attempt_id, tool_call_id),
        UNIQUE(workspace_id, source_attempt_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_user_input_requests_scope_status
        ON user_input_requests(workspace_id, thread_id, status, created_at, request_id);
      CREATE INDEX IF NOT EXISTS idx_user_input_requests_source_run
        ON user_input_requests(workspace_id, source_run_id, source_attempt_id);
      CREATE TABLE IF NOT EXISTS user_input_answers (
        answer_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES user_input_requests(request_id) ON DELETE CASCADE,
        request_version INTEGER NOT NULL CHECK(request_version = 1),
        idempotency_key TEXT NOT NULL,
        submission_fingerprint TEXT NOT NULL,
        submission_json TEXT NOT NULL,
        answer_item_id TEXT NOT NULL UNIQUE REFERENCES conversation_items(id) ON DELETE CASCADE,
        accepted_at TEXT NOT NULL,
        UNIQUE(request_id, request_version)
      );
      CREATE TABLE IF NOT EXISTS user_input_deliveries (
        delivery_id TEXT PRIMARY KEY,
        answer_id TEXT NOT NULL REFERENCES user_input_answers(answer_id) ON DELETE CASCADE,
        consumer_work_unit_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','claimed','applied','failed','obsolete')),
        created_at TEXT NOT NULL,
        UNIQUE(answer_id, consumer_work_unit_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_input_deliveries_pending
        ON user_input_deliveries(status, created_at, delivery_id);
    `);
    context.recordMigration(131, "persist_structured_user_input_receipts");
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
