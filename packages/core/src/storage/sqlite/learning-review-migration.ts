import type { SqliteRunStoreMigrationContext } from "./migrations.js";

export function applyLearningReviewMigration(context: SqliteRunStoreMigrationContext): void {
  if (context.hasMigration(186)) return;
  context.database.exec("SAVEPOINT learning_review_migration");
  try {
  context.database.exec(`
    CREATE TABLE IF NOT EXISTS learning_review_policy (id INTEGER PRIMARY KEY CHECK(id = 1), record_json TEXT NOT NULL CHECK(json_valid(record_json)));
    CREATE TABLE IF NOT EXISTS learning_review_jobs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_key TEXT NOT NULL, mode TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      UNIQUE(workspace_id, source_key)
    );
    CREATE INDEX IF NOT EXISTS learning_review_queue ON learning_review_jobs(workspace_id, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS learning_review_single_running ON learning_review_jobs(workspace_id) WHERE status = 'running';
  `);
  context.recordMigration(186, "bounded_learning_review_jobs_default_off");
  context.database.exec("RELEASE learning_review_migration");
  } catch (error) {
    context.database.exec("ROLLBACK TO learning_review_migration; RELEASE learning_review_migration"); throw error;
  }
}
