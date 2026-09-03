import type { DatabaseSync } from "node:sqlite";

export const RUN_CONTEXT_VIEW_LINEAGE_MIGRATION_VERSION = 122;
export const RUN_CONTEXT_VIEW_LINEAGE_MIGRATION_NAME = "add_run_context_view_lineage";

export interface RunContextViewLineageMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasColumn: (tableName: string, columnName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

/** Adds nullable lineage columns so pre-lineage runs remain readable. */
export function applyRunContextViewLineageMigration(input: RunContextViewLineageMigrationInput): boolean {
  const needsColumns = !input.hasColumn("run_sessions", "context_view_id")
    || !input.hasColumn("run_sessions", "context_view_created_at");
  if (!needsColumns && input.hasMigration(RUN_CONTEXT_VIEW_LINEAGE_MIGRATION_VERSION)) {
    return false;
  }

  if (!input.hasColumn("run_sessions", "context_view_id")) {
    input.database.exec("ALTER TABLE run_sessions ADD COLUMN context_view_id TEXT;");
  }
  if (!input.hasColumn("run_sessions", "context_view_created_at")) {
    input.database.exec("ALTER TABLE run_sessions ADD COLUMN context_view_created_at TEXT;");
  }
  input.database.exec(`
    CREATE INDEX IF NOT EXISTS idx_run_sessions_context_view
    ON run_sessions(context_view_id, context_view_created_at);
  `);
  if (!input.hasMigration(RUN_CONTEXT_VIEW_LINEAGE_MIGRATION_VERSION)) {
    input.recordMigration(RUN_CONTEXT_VIEW_LINEAGE_MIGRATION_VERSION, RUN_CONTEXT_VIEW_LINEAGE_MIGRATION_NAME);
  }
  return true;
}
