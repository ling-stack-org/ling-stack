import type { SqliteRunStoreMigrationContext } from "./migrations.js";

export function applyHostAttemptEffectCoverageMigration(context: SqliteRunStoreMigrationContext): void {
  if (!context.hasColumn("host_attempt_completions", "effect_coverage")) {
    context.database.exec(`ALTER TABLE host_attempt_completions ADD COLUMN effect_coverage TEXT NOT NULL
      DEFAULT 'unverified' CHECK(effect_coverage IN ('unverified','pi_no_tools_v1'))`);
  }
  if (!context.hasMigration(166)) context.recordMigration(166, "original_host_tool_free_completion");
  if (!context.hasColumn("host_attempt_completions", "tracked_tool_calls_json")) {
    context.database.exec("ALTER TABLE host_attempt_completions ADD COLUMN tracked_tool_calls_json TEXT");
  }
  if (!context.hasMigration(167)) context.recordMigration(167, "original_host_tracked_effect_coverage");
}
