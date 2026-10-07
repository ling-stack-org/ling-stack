import type { DatabaseSync } from "node:sqlite";

export const HOST_OFFICE_LOCAL_DIRECTORY_V2_MIGRATION_VERSION = 152;
/** New append-only protocol storage; no v1 row, CHECK, receipt or verifier is rewritten. */
export function applyHostOfficeLocalDirectoryV2Migration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (name: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  if (input.hasMigration(HOST_OFFICE_LOCAL_DIRECTORY_V2_MIGRATION_VERSION)
    && ["host_office_local_directory_v2_executions", "host_office_local_directory_v2_effects", "host_office_local_directory_v2_terminals"].every(input.hasTable)) return;
  input.database.exec("SAVEPOINT host_office_local_directory_v2_migration");
  try {
    input.database.exec(`
      CREATE TABLE host_office_local_directory_v2_executions (
        execution_id TEXT PRIMARY KEY NOT NULL,
        schema_version INTEGER NOT NULL CHECK(schema_version=2),
        protocol TEXT NOT NULL CHECK(protocol='ling-office-local-binary-v2'),
        run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
        work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
        runtime_instance_id TEXT NOT NULL,
        fencing_token TEXT NOT NULL,
        parent_operation_id TEXT NOT NULL UNIQUE REFERENCES host_operations(operation_id) ON DELETE RESTRICT,
        producer_operation_id TEXT NOT NULL UNIQUE REFERENCES host_operations(operation_id) ON DELETE RESTRICT,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL CHECK(tool_name IN ('office_create_workbook','office_create_document','office_create_presentation')),
        prepared_artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
        prepared_digest TEXT NOT NULL CHECK(length(prepared_digest)=64 AND prepared_digest NOT GLOB '*[^0-9a-f]*' AND instr(prepared_digest,char(0))=0),
        identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64 AND identity_digest NOT GLOB '*[^0-9a-f]*' AND instr(identity_digest,char(0))=0),
        prepared_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision=0),
        CHECK(parent_operation_id<>producer_operation_id)
      );
      CREATE INDEX idx_host_office_local_directory_v2_source ON host_office_local_directory_v2_executions(run_id,attempt_id);
      CREATE TABLE host_office_local_directory_v2_effects (
        effect_id TEXT PRIMARY KEY NOT NULL,
        execution_id TEXT NOT NULL REFERENCES host_office_local_directory_v2_executions(execution_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal>=0 AND ordinal<1024),
        descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)),
        effect_digest TEXT NOT NULL CHECK(length(effect_digest)=64 AND effect_digest NOT GLOB '*[^0-9a-f]*' AND instr(effect_digest,char(0))=0),
        entered_at TEXT,
        observation_artifact_id TEXT UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0),
        UNIQUE(execution_id,ordinal)
      );
      CREATE TABLE host_office_local_directory_v2_terminals (
        execution_id TEXT PRIMARY KEY NOT NULL REFERENCES host_office_local_directory_v2_executions(execution_id) ON DELETE RESTRICT,
        schema_version INTEGER NOT NULL CHECK(schema_version=2),
        protocol TEXT NOT NULL CHECK(protocol='ling-office-local-binary-v2'),
        execution_identity_digest TEXT NOT NULL CHECK(length(execution_identity_digest)=64 AND execution_identity_digest NOT GLOB '*[^0-9a-f]*' AND instr(execution_identity_digest,char(0))=0),
        terminal_artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
        terminal_digest TEXT NOT NULL CHECK(length(terminal_digest)=64 AND terminal_digest NOT GLOB '*[^0-9a-f]*' AND instr(terminal_digest,char(0))=0),
        effect_set_digest TEXT NOT NULL CHECK(length(effect_set_digest)=64 AND effect_set_digest NOT GLOB '*[^0-9a-f]*' AND instr(effect_set_digest,char(0))=0),
        effect_count INTEGER NOT NULL CHECK(typeof(effect_count)='integer' AND effect_count>=0 AND effect_count<=1024),
        sealed_at TEXT NOT NULL
      );
      CREATE TRIGGER host_office_local_directory_v2_execution_no_replace BEFORE INSERT ON host_office_local_directory_v2_executions
        WHEN EXISTS(SELECT 1 FROM host_office_local_directory_v2_executions WHERE execution_id=NEW.execution_id
          OR prepared_artifact_id=NEW.prepared_artifact_id OR parent_operation_id IN (NEW.parent_operation_id,NEW.producer_operation_id)
          OR producer_operation_id IN (NEW.parent_operation_id,NEW.producer_operation_id))
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_append_only'); END;
      CREATE TRIGGER host_office_local_directory_v2_cross_version BEFORE INSERT ON host_office_local_directory_v2_executions
        WHEN EXISTS(SELECT 1 FROM host_office_local_executions WHERE execution_id=NEW.execution_id
          OR prepared_artifact_id=NEW.prepared_artifact_id OR parent_operation_id IN (NEW.parent_operation_id,NEW.producer_operation_id)
          OR producer_operation_id IN (NEW.parent_operation_id,NEW.producer_operation_id))
        BEGIN SELECT RAISE(ABORT,'host_office_local_cross_version_identity_conflict'); END;
      CREATE TRIGGER host_office_local_v1_cross_directory_v2 BEFORE INSERT ON host_office_local_executions
        WHEN EXISTS(SELECT 1 FROM host_office_local_directory_v2_executions WHERE execution_id=NEW.execution_id
          OR prepared_artifact_id=NEW.prepared_artifact_id OR parent_operation_id IN (NEW.parent_operation_id,NEW.producer_operation_id)
          OR producer_operation_id IN (NEW.parent_operation_id,NEW.producer_operation_id))
        BEGIN SELECT RAISE(ABORT,'host_office_local_cross_version_identity_conflict'); END;
      CREATE TRIGGER host_office_local_directory_v2_execution_immutable BEFORE UPDATE ON host_office_local_directory_v2_executions
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_identity_immutable'); END;
      CREATE TRIGGER host_office_local_directory_v2_execution_no_delete BEFORE DELETE ON host_office_local_directory_v2_executions
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_append_only'); END;
      CREATE TRIGGER host_office_local_directory_v2_effect_no_replace BEFORE INSERT ON host_office_local_directory_v2_effects
        WHEN EXISTS(SELECT 1 FROM host_office_local_directory_v2_effects WHERE effect_id=NEW.effect_id
          OR (execution_id=NEW.execution_id AND ordinal=NEW.ordinal) OR observation_artifact_id=NEW.observation_artifact_id)
          OR EXISTS(SELECT 1 FROM host_office_local_directory_v2_terminals WHERE execution_id=NEW.execution_id)
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_append_only'); END;
      CREATE TRIGGER host_office_local_directory_v2_effect_immutable BEFORE UPDATE ON host_office_local_directory_v2_effects
        WHEN NEW.effect_id IS NOT OLD.effect_id OR NEW.execution_id IS NOT OLD.execution_id OR NEW.ordinal IS NOT OLD.ordinal
          OR NEW.descriptor_json IS NOT OLD.descriptor_json OR NEW.effect_digest IS NOT OLD.effect_digest
          OR NEW.revision<>OLD.revision+1 OR (OLD.entered_at IS NOT NULL AND NEW.entered_at IS NOT OLD.entered_at)
          OR (OLD.observation_artifact_id IS NOT NULL AND NEW.observation_artifact_id IS NOT OLD.observation_artifact_id)
          OR EXISTS(SELECT 1 FROM host_office_local_directory_v2_effects WHERE effect_id<>OLD.effect_id AND observation_artifact_id=NEW.observation_artifact_id)
          OR EXISTS(SELECT 1 FROM host_office_local_directory_v2_terminals WHERE execution_id=OLD.execution_id)
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_effect_immutable'); END;
      CREATE TRIGGER host_office_local_directory_v2_effect_no_delete BEFORE DELETE ON host_office_local_directory_v2_effects
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_append_only'); END;
      CREATE TRIGGER host_office_local_directory_v2_terminal_no_replace BEFORE INSERT ON host_office_local_directory_v2_terminals
        WHEN EXISTS(SELECT 1 FROM host_office_local_directory_v2_terminals WHERE execution_id=NEW.execution_id OR terminal_artifact_id=NEW.terminal_artifact_id)
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_append_only'); END;
      CREATE TRIGGER host_office_local_directory_v2_terminal_immutable BEFORE UPDATE ON host_office_local_directory_v2_terminals
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_terminal_immutable'); END;
      CREATE TRIGGER host_office_local_directory_v2_terminal_no_delete BEFORE DELETE ON host_office_local_directory_v2_terminals
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_append_only'); END;
    `);
    if (!input.hasMigration(HOST_OFFICE_LOCAL_DIRECTORY_V2_MIGRATION_VERSION)) input.recordMigration(HOST_OFFICE_LOCAL_DIRECTORY_V2_MIGRATION_VERSION, "create_host_office_local_directory_v2_facts");
    input.database.exec("RELEASE host_office_local_directory_v2_migration");
  } catch (error) {
    input.database.exec("ROLLBACK TO host_office_local_directory_v2_migration");
    input.database.exec("RELEASE host_office_local_directory_v2_migration");
    throw error;
  }
}
