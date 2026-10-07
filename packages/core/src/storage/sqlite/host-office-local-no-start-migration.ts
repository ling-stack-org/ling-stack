import type { DatabaseSync } from "node:sqlite";

export const HOST_OFFICE_LOCAL_NO_START_MIGRATION_VERSION = 151;

/** Preserve failed terminals and freeze the exact unentered effect set without backfilling authority. */
export function applyHostOfficeLocalNoStartMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (name: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  if (input.hasMigration(HOST_OFFICE_LOCAL_NO_START_MIGRATION_VERSION)
    && input.hasTable("host_office_local_no_start_receipts")) return;
  input.database.exec("SAVEPOINT host_office_local_no_start_migration");
  try {
    input.database.exec(`
      CREATE TABLE host_office_local_no_start_receipts (
        execution_id TEXT NOT NULL PRIMARY KEY REFERENCES host_office_local_executions(execution_id) ON DELETE RESTRICT,
        schema_version INTEGER NOT NULL CHECK(schema_version=1),
        protocol TEXT NOT NULL CHECK(protocol='ling-office-local-binary-v1'),
        execution_identity_digest TEXT NOT NULL CHECK(typeof(execution_identity_digest)='text' AND length(execution_identity_digest)=64
          AND execution_identity_digest NOT GLOB '*[^0-9a-f]*' AND instr(execution_identity_digest,char(0))=0),
        prepared_artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
        prepared_digest TEXT NOT NULL CHECK(typeof(prepared_digest)='text' AND length(prepared_digest)=64
          AND prepared_digest NOT GLOB '*[^0-9a-f]*' AND instr(prepared_digest,char(0))=0),
        receipt_json TEXT NOT NULL CHECK(typeof(receipt_json)='text' AND json_valid(receipt_json) AND json_type(receipt_json)='object'
          AND coalesce(json_type(receipt_json,'$.schemaVersion')='integer',0)
          AND coalesce(json_extract(receipt_json,'$.schemaVersion')=schema_version,0)
          AND coalesce(json_extract(receipt_json,'$.protocol')=protocol,0)
          AND coalesce(json_extract(receipt_json,'$.kind')='office_local_no_start_v1',0)
          AND coalesce(json_extract(receipt_json,'$.executionId')=execution_id,0)
          AND coalesce(json_extract(receipt_json,'$.executionIdentityDigest')=execution_identity_digest,0)
          AND coalesce(json_extract(receipt_json,'$.preparedArtifactId')=prepared_artifact_id,0)
          AND coalesce(json_extract(receipt_json,'$.preparedDigest')=prepared_digest,0)
          AND coalesce(json_extract(receipt_json,'$.receiptDigest')=receipt_digest,0)
          AND coalesce(json_type(receipt_json,'$.source')='object',0)
          AND coalesce(json_type(receipt_json,'$.effects')='array',0)
          AND coalesce(json_array_length(receipt_json,'$.effects')=effect_count,0)
          AND coalesce(json_type(receipt_json,'$.requiredDescendants')='array',0)
          AND coalesce(json_array_length(receipt_json,'$.requiredDescendants')=descendant_count,0)
          AND coalesce(json_extract(receipt_json,'$.closedAt')=closed_at,0)),
        receipt_digest TEXT NOT NULL UNIQUE CHECK(typeof(receipt_digest)='text' AND length(receipt_digest)=64
          AND receipt_digest NOT GLOB '*[^0-9a-f]*' AND instr(receipt_digest,char(0))=0),
        effect_set_digest TEXT NOT NULL CHECK(typeof(effect_set_digest)='text' AND length(effect_set_digest)=64
          AND effect_set_digest NOT GLOB '*[^0-9a-f]*' AND instr(effect_set_digest,char(0))=0),
        effect_count INTEGER NOT NULL CHECK(typeof(effect_count)='integer' AND effect_count>=0 AND effect_count<=1024),
        descendant_set_digest TEXT NOT NULL CHECK(typeof(descendant_set_digest)='text' AND length(descendant_set_digest)=64
          AND descendant_set_digest NOT GLOB '*[^0-9a-f]*' AND instr(descendant_set_digest,char(0))=0),
        descendant_count INTEGER NOT NULL CHECK(typeof(descendant_count)='integer' AND descendant_count>=0),
        closed_at TEXT NOT NULL CHECK(typeof(closed_at)='text' AND length(closed_at)>0 AND instr(closed_at,char(0))=0)
      );
      CREATE TRIGGER host_office_local_no_start_no_replace BEFORE INSERT ON host_office_local_no_start_receipts
        WHEN EXISTS(SELECT 1 FROM host_office_local_no_start_receipts
          WHERE execution_id=NEW.execution_id OR receipt_digest=NEW.receipt_digest
            OR prepared_artifact_id=NEW.prepared_artifact_id)
        BEGIN SELECT RAISE(ABORT,'host_office_local_no_start_append_only'); END;
      CREATE TRIGGER host_office_local_no_start_immutable BEFORE UPDATE ON host_office_local_no_start_receipts
        BEGIN SELECT RAISE(ABORT,'host_office_local_no_start_immutable'); END;
      CREATE TRIGGER host_office_local_no_start_no_delete BEFORE DELETE ON host_office_local_no_start_receipts
        BEGIN SELECT RAISE(ABORT,'host_office_local_no_start_append_only'); END;
      CREATE TRIGGER host_office_local_effect_no_start_insert BEFORE INSERT ON host_office_local_effects
        WHEN EXISTS(SELECT 1 FROM host_office_local_no_start_receipts WHERE execution_id=NEW.execution_id)
          OR EXISTS(SELECT 1 FROM host_office_local_effects AS protected
            JOIN host_office_local_no_start_receipts AS receipt ON receipt.execution_id=protected.execution_id
            WHERE protected.effect_id=NEW.effect_id OR (NEW.observation_artifact_id IS NOT NULL
              AND protected.observation_artifact_id=NEW.observation_artifact_id))
        BEGIN SELECT RAISE(ABORT,'host_office_local_execution_no_start_closed'); END;
      CREATE TRIGGER host_office_local_effect_no_start_update BEFORE UPDATE ON host_office_local_effects
        WHEN EXISTS(SELECT 1 FROM host_office_local_no_start_receipts WHERE execution_id IN (OLD.execution_id,NEW.execution_id))
          OR EXISTS(SELECT 1 FROM host_office_local_effects AS protected
            JOIN host_office_local_no_start_receipts AS receipt ON receipt.execution_id=protected.execution_id
            WHERE protected.effect_id=NEW.effect_id OR (NEW.observation_artifact_id IS NOT NULL
              AND protected.observation_artifact_id=NEW.observation_artifact_id))
        BEGIN SELECT RAISE(ABORT,'host_office_local_execution_no_start_closed'); END;
    `);
    if (!input.hasMigration(HOST_OFFICE_LOCAL_NO_START_MIGRATION_VERSION)) {
      input.recordMigration(HOST_OFFICE_LOCAL_NO_START_MIGRATION_VERSION, "seal_host_office_local_no_start_receipts");
    }
    input.database.exec("RELEASE host_office_local_no_start_migration");
  } catch (error) {
    input.database.exec("ROLLBACK TO host_office_local_no_start_migration");
    input.database.exec("RELEASE host_office_local_no_start_migration");
    throw error;
  }
}
