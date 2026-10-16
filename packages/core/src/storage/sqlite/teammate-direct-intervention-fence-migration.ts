import type { SqliteRunStoreMigrationContext } from "./migrations.js";

export function applyTeammateDirectInterventionFenceMigration(context: SqliteRunStoreMigrationContext): void {
  if (!context.hasColumn("teammate_direct_reply_interventions", "source_attempt_id")) {
    context.database.exec("ALTER TABLE teammate_direct_reply_interventions ADD COLUMN source_attempt_id TEXT");
  }
  if (!context.hasMigration(168)) context.recordMigration(168, "teammate_direct_intervention_source_attempt");
}
