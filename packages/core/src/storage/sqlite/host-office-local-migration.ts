import type { DatabaseSync } from "node:sqlite";

export const HOST_OFFICE_LOCAL_MIGRATION_VERSION = 148;

/** Append-only local binary facts. Does not widen the patch verifier or synthesize old receipts. */
export function applyHostOfficeLocalMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (name: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  if (input.hasMigration(HOST_OFFICE_LOCAL_MIGRATION_VERSION)
    && input.hasTable("host_office_local_executions") && input.hasTable("host_office_local_effects")) return;
  input.database.exec("SAVEPOINT host_office_local_migration");
  try {
    input.database.exec(`
      CREATE TABLE host_office_local_executions (
        execution_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version=1),
        protocol TEXT NOT NULL CHECK(protocol='ling-office-local-binary-v1'),
        run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
        work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
        runtime_instance_id TEXT NOT NULL,
        fencing_token TEXT NOT NULL,
        parent_operation_id TEXT NOT NULL UNIQUE REFERENCES host_operations(operation_id) ON DELETE RESTRICT,
        producer_operation_id TEXT NOT NULL UNIQUE REFERENCES host_operations(operation_id) ON DELETE RESTRICT,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL CHECK(tool_name IN ('office_create_workbook','office_edit_workbook',
          'office_create_document','office_edit_document','office_create_presentation','office_edit_presentation')),
        prepared_artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
        prepared_digest TEXT NOT NULL CHECK(length(prepared_digest)=64 AND prepared_digest NOT GLOB '*[^0-9a-f]*'),
        identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64 AND identity_digest NOT GLOB '*[^0-9a-f]*'),
        prepared_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
        CHECK(parent_operation_id<>producer_operation_id)
      );
      CREATE INDEX idx_host_office_local_source ON host_office_local_executions(run_id,attempt_id);
      CREATE TABLE host_office_local_effects (
        effect_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES host_office_local_executions(execution_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<1024),
        descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)),
        effect_digest TEXT NOT NULL CHECK(length(effect_digest)=64 AND effect_digest NOT GLOB '*[^0-9a-f]*'),
        entered_at TEXT,
        observation_artifact_id TEXT UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
        UNIQUE(execution_id,ordinal)
      );
      CREATE TRIGGER host_office_local_execution_immutable BEFORE UPDATE ON host_office_local_executions
        BEGIN SELECT RAISE(ABORT,'host_office_local_identity_immutable'); END;
      CREATE TRIGGER host_office_local_effect_immutable BEFORE UPDATE ON host_office_local_effects
        WHEN NEW.effect_id IS NOT OLD.effect_id OR NEW.execution_id IS NOT OLD.execution_id
          OR NEW.ordinal IS NOT OLD.ordinal OR NEW.descriptor_json IS NOT OLD.descriptor_json
          OR NEW.effect_digest IS NOT OLD.effect_digest
          OR (OLD.entered_at IS NOT NULL AND NEW.entered_at IS NOT OLD.entered_at)
          OR (OLD.observation_artifact_id IS NOT NULL AND NEW.observation_artifact_id IS NOT OLD.observation_artifact_id)
        BEGIN SELECT RAISE(ABORT,'host_office_local_effect_immutable'); END;
      CREATE TRIGGER host_office_local_execution_no_delete BEFORE DELETE ON host_office_local_executions
        BEGIN SELECT RAISE(ABORT,'host_office_local_execution_append_only'); END;
      CREATE TRIGGER host_office_local_effect_no_delete BEFORE DELETE ON host_office_local_effects
        BEGIN SELECT RAISE(ABORT,'host_office_local_effect_append_only'); END;
    `);
    if (!input.hasMigration(HOST_OFFICE_LOCAL_MIGRATION_VERSION)) {
      input.recordMigration(HOST_OFFICE_LOCAL_MIGRATION_VERSION, "create_host_office_local_binary_facts");
    }
    input.database.exec("RELEASE host_office_local_migration");
  } catch (error) {
    input.database.exec("ROLLBACK TO host_office_local_migration");
    input.database.exec("RELEASE host_office_local_migration");
    throw error;
  }
}
