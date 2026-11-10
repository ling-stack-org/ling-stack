import type { SqliteRunStoreMigrationContext } from "./migrations.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export function applyTeammateDirectSubmissionMigration(context: SqliteRunStoreMigrationContext): void {
  if (context.hasMigration(164)) return;
  context.database.exec("BEGIN IMMEDIATE;");
  try {
    for (const column of ["submission_key", "submission_fingerprint"]) {
      if (!context.hasColumn("teammate_direct_messages", column)) {
        context.database.exec(`ALTER TABLE teammate_direct_messages ADD COLUMN ${column} TEXT`);
      }
    }
    context.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_teammate_direct_submission
      ON teammate_direct_messages(workspace_id, teammate_id, submission_key)
      WHERE submission_key IS NOT NULL`);
    context.recordMigration(164, "teammate_direct_initial_submission_identity");
    context.database.exec("COMMIT;");
  } catch (error) {
    rollbackOwnedSqliteTransaction(context.database);
    throw error;
  }
}
