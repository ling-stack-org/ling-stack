import type { DatabaseSync } from "node:sqlite";

export const PROPOSED_PLAN_REVISION_MIGRATION_VERSION = 163;

/** Add a durable row revision without rewriting plan content, lineage or accepted facts. */
export function applyProposedPlanRevisionMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasColumn: (table: string, column: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  if (input.hasMigration(PROPOSED_PLAN_REVISION_MIGRATION_VERSION)
    && input.hasColumn("ling_thread_proposed_plans", "revision")) return;
  input.database.exec("SAVEPOINT proposed_plan_revision_migration");
  try {
    if (!input.hasColumn("ling_thread_proposed_plans", "revision")) {
      input.database.exec(`ALTER TABLE ling_thread_proposed_plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
        CHECK(typeof(revision)='integer' AND revision>=1)`);
    }
    if (!input.hasMigration(PROPOSED_PLAN_REVISION_MIGRATION_VERSION)) {
      input.recordMigration(PROPOSED_PLAN_REVISION_MIGRATION_VERSION, "add_proposed_plan_revision");
    }
    input.database.exec("RELEASE proposed_plan_revision_migration");
  } catch (error) {
    try {
      input.database.exec("ROLLBACK TO proposed_plan_revision_migration");
      input.database.exec("RELEASE proposed_plan_revision_migration");
    } catch { /* Preserve the original migration failure. */ }
    throw error;
  }
}
