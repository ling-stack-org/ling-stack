import type { DatabaseSync } from "node:sqlite";

export const HOST_MEDIA_OPERATION_MIGRATION_VERSION = 146;

/** New facts only. Existing handles and history are never promoted to launch or receipt authority. */
export function applyHostMediaOperationMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (name: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  if (input.hasMigration(HOST_MEDIA_OPERATION_MIGRATION_VERSION)
    && input.hasTable("host_media_executions") && input.hasTable("host_media_effects")) return;
  input.database.exec("SAVEPOINT host_media_operation_migration");
  try {
    input.database.exec(`
      CREATE TABLE IF NOT EXISTS host_media_executions (
        execution_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version=1),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        media_job_id TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE RESTRICT,
        media_child_work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
        execution_generation_id TEXT NOT NULL,
        parent_operation_id TEXT NOT NULL UNIQUE REFERENCES host_operations(operation_id) ON DELETE RESTRICT,
        transport_operation_id TEXT NOT NULL UNIQUE REFERENCES host_operations(operation_id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE RESTRICT,
        work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
        runtime_instance_id TEXT NOT NULL,
        fencing_token TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL CHECK(tool_name IN ('image_generate','video_generate')),
        operation TEXT NOT NULL CHECK(operation IN ('image_generate','image_edit','video_generate')),
        protocol TEXT NOT NULL CHECK(protocol IN ('image_response_v1','seedance_task_v1','comfy_jobs_v1','comfy_prompt_legacy_v1')),
        adapter_id TEXT NOT NULL,
        intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),
        target_digest TEXT NOT NULL CHECK(length(target_digest)=64),
        namespace_digest TEXT NOT NULL CHECK(length(namespace_digest)=64),
        prepared_request_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
        prepared_request_digest TEXT NOT NULL CHECK(length(prepared_request_digest)=64),
        prepared_at TEXT NOT NULL,
        identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64),
        child_attempt_id TEXT REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
        child_runtime_instance_id TEXT,
        child_fencing_token TEXT,
        child_bound_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
        UNIQUE(media_job_id,execution_generation_id),
        CHECK(parent_operation_id<>transport_operation_id),
        CHECK((child_attempt_id IS NULL AND child_runtime_instance_id IS NULL AND child_fencing_token IS NULL AND child_bound_at IS NULL)
          OR (child_attempt_id IS NOT NULL AND child_runtime_instance_id IS NOT NULL AND child_fencing_token IS NOT NULL AND child_bound_at IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_host_media_executions_source ON host_media_executions(run_id,attempt_id,media_child_work_unit_id);
      CREATE TABLE IF NOT EXISTS host_media_effects (
        effect_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version=1),
        execution_id TEXT NOT NULL REFERENCES host_media_executions(execution_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK(ordinal>=0),
        kind TEXT NOT NULL CHECK(kind IN ('image_request','comfy_image_upload','remote_generation_submit')),
        method TEXT NOT NULL CHECK(method='POST'),
        route_digest TEXT NOT NULL CHECK(length(route_digest)=64),
        wire_digest TEXT NOT NULL CHECK(length(wire_digest)=64),
        prepared_at TEXT NOT NULL,
        launched_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
        UNIQUE(execution_id,ordinal)
      );
      CREATE TRIGGER IF NOT EXISTS host_media_executions_immutable_identity
        BEFORE UPDATE ON host_media_executions WHEN
          NEW.execution_id IS NOT OLD.execution_id OR NEW.schema_version IS NOT OLD.schema_version
          OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.media_job_id IS NOT OLD.media_job_id
          OR NEW.media_child_work_unit_id IS NOT OLD.media_child_work_unit_id
          OR NEW.execution_generation_id IS NOT OLD.execution_generation_id
          OR NEW.parent_operation_id IS NOT OLD.parent_operation_id OR NEW.transport_operation_id IS NOT OLD.transport_operation_id
          OR NEW.run_id IS NOT OLD.run_id OR NEW.work_unit_id IS NOT OLD.work_unit_id OR NEW.attempt_id IS NOT OLD.attempt_id
          OR NEW.runtime_instance_id IS NOT OLD.runtime_instance_id OR NEW.fencing_token IS NOT OLD.fencing_token
          OR NEW.tool_call_id IS NOT OLD.tool_call_id OR NEW.tool_name IS NOT OLD.tool_name OR NEW.operation IS NOT OLD.operation
          OR NEW.protocol IS NOT OLD.protocol OR NEW.adapter_id IS NOT OLD.adapter_id
          OR NEW.intent_digest IS NOT OLD.intent_digest OR NEW.target_digest IS NOT OLD.target_digest
          OR NEW.namespace_digest IS NOT OLD.namespace_digest
          OR NEW.prepared_request_artifact_id IS NOT OLD.prepared_request_artifact_id
          OR NEW.prepared_request_digest IS NOT OLD.prepared_request_digest OR NEW.prepared_at IS NOT OLD.prepared_at
          OR NEW.identity_digest IS NOT OLD.identity_digest
        BEGIN SELECT RAISE(ABORT,'host_media_identity_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS host_media_executions_immutable_child
        BEFORE UPDATE ON host_media_executions WHEN OLD.child_attempt_id IS NOT NULL AND
          (NEW.child_attempt_id IS NOT OLD.child_attempt_id OR NEW.child_runtime_instance_id IS NOT OLD.child_runtime_instance_id
            OR NEW.child_fencing_token IS NOT OLD.child_fencing_token OR NEW.child_bound_at IS NOT OLD.child_bound_at)
        BEGIN SELECT RAISE(ABORT,'host_media_child_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS host_media_effects_immutable_identity
        BEFORE UPDATE ON host_media_effects WHEN NEW.effect_id IS NOT OLD.effect_id OR NEW.schema_version IS NOT OLD.schema_version
          OR NEW.execution_id IS NOT OLD.execution_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.kind IS NOT OLD.kind
          OR NEW.method IS NOT OLD.method OR NEW.route_digest IS NOT OLD.route_digest OR NEW.wire_digest IS NOT OLD.wire_digest
          OR NEW.prepared_at IS NOT OLD.prepared_at
        BEGIN SELECT RAISE(ABORT,'host_media_effect_identity_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS host_media_effects_immutable_launch
        BEFORE UPDATE ON host_media_effects WHEN OLD.launched_at IS NOT NULL AND NEW.launched_at IS NOT OLD.launched_at
        BEGIN SELECT RAISE(ABORT,'host_media_effect_launch_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS host_media_executions_no_delete BEFORE DELETE ON host_media_executions
        BEGIN SELECT RAISE(ABORT,'host_media_execution_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS host_media_effects_no_delete BEFORE DELETE ON host_media_effects
        BEGIN SELECT RAISE(ABORT,'host_media_effect_append_only'); END;
    `);
    if (!input.hasMigration(HOST_MEDIA_OPERATION_MIGRATION_VERSION)) {
      input.recordMigration(HOST_MEDIA_OPERATION_MIGRATION_VERSION, "create_host_media_operation_facts");
    }
    input.database.exec("RELEASE host_media_operation_migration");
  } catch (error) {
    input.database.exec("ROLLBACK TO host_media_operation_migration");
    input.database.exec("RELEASE host_media_operation_migration");
    throw error;
  }
}
