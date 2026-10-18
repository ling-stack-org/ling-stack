import type { SqliteRunStoreMigrationContext } from "./migrations.js";

export function applyHostAttemptCompletionMigration(context: SqliteRunStoreMigrationContext): void {
  if (context.hasMigration(165) && context.hasTable("host_attempt_completions")) return;
  context.database.exec("SAVEPOINT host_attempt_completion_migration");
  try {
    context.database.exec(`CREATE TABLE IF NOT EXISTS host_attempt_completions (
      attempt_id TEXT PRIMARY KEY REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
      schema_version INTEGER NOT NULL CHECK(schema_version=1),
      run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE CASCADE,
      work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
      runtime_instance_id TEXT NOT NULL,
      fencing_token TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      drained_at TEXT
    );
    CREATE TRIGGER IF NOT EXISTS host_attempt_completion_immutable_identity
      BEFORE UPDATE ON host_attempt_completions WHEN NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.schema_version IS NOT OLD.schema_version OR NEW.run_id IS NOT OLD.run_id
        OR NEW.work_unit_id IS NOT OLD.work_unit_id OR NEW.runtime_instance_id IS NOT OLD.runtime_instance_id
        OR NEW.fencing_token IS NOT OLD.fencing_token OR NEW.registered_at IS NOT OLD.registered_at
      BEGIN SELECT RAISE(ABORT,'host_attempt_completion_identity_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS host_attempt_completion_immutable_terminal
      BEFORE UPDATE ON host_attempt_completions WHEN OLD.drained_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'host_attempt_completion_terminal_immutable'); END;`);
    if (!context.hasMigration(165)) context.recordMigration(165, "original_host_attempt_local_completion");
    context.database.exec("RELEASE host_attempt_completion_migration");
  } catch (error) {
    context.database.exec("ROLLBACK TO host_attempt_completion_migration");
    context.database.exec("RELEASE host_attempt_completion_migration");
    throw error;
  }
}
