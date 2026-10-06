import type { DatabaseSync } from "node:sqlite";

export const HOST_OFFICE_LOCAL_DIRECTORY_V2_CERTIFICATE_MIGRATION_VERSION = 153;
/** Independent append-only issuance; V1 tables, checks and native-only flags are untouched. */
export function applyHostOfficeLocalDirectoryV2CertificateMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (name: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const version = HOST_OFFICE_LOCAL_DIRECTORY_V2_CERTIFICATE_MIGRATION_VERSION;
  if (input.hasMigration(version) && input.hasTable("host_office_local_directory_v2_certificates")) return;
  input.database.exec("SAVEPOINT host_office_local_directory_v2_certificate_migration");
  try {
    input.database.exec(`
      CREATE TABLE host_office_local_directory_v2_certificates (
        execution_id TEXT PRIMARY KEY NOT NULL REFERENCES host_office_local_directory_v2_executions(execution_id) ON DELETE RESTRICT,
        schema_version INTEGER NOT NULL CHECK(schema_version=2),
        protocol TEXT NOT NULL CHECK(protocol='ling-office-local-binary-v2'),
        certificate_json TEXT NOT NULL CHECK(json_valid(certificate_json)),
        certificate_digest TEXT NOT NULL CHECK(length(certificate_digest)=64 AND certificate_digest NOT GLOB '*[^0-9a-f]*' AND instr(certificate_digest,char(0))=0),
        settled_at TEXT NOT NULL,
        CHECK(json_extract(certificate_json,'$.schemaVersion')=schema_version
          AND json_extract(certificate_json,'$.protocol')=protocol
          AND json_extract(certificate_json,'$.kind')='office_local_directory_core_certificate_v2'
          AND json_extract(certificate_json,'$.executionId')=execution_id
          AND json_extract(certificate_json,'$.settledAt')=settled_at)
      );
      CREATE TRIGGER host_office_local_directory_v2_certificate_original_insert BEFORE INSERT ON host_office_local_directory_v2_certificates
        WHEN ling_office_directory_v2_certificate_insert(NEW.execution_id,NEW.certificate_json,NEW.certificate_digest,NEW.settled_at)<>1
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_certificate_original_required'); END;
      CREATE TRIGGER host_office_local_directory_v2_certificate_no_replace BEFORE INSERT ON host_office_local_directory_v2_certificates
        WHEN EXISTS(SELECT 1 FROM host_office_local_directory_v2_certificates WHERE execution_id=NEW.execution_id)
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_certificate_append_only'); END;
      CREATE TRIGGER host_office_local_directory_v2_certificate_immutable BEFORE UPDATE ON host_office_local_directory_v2_certificates
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_certificate_immutable'); END;
      CREATE TRIGGER host_office_local_directory_v2_certificate_no_delete BEFORE DELETE ON host_office_local_directory_v2_certificates
        BEGIN SELECT RAISE(ABORT,'host_office_local_directory_v2_certificate_append_only'); END;
    `);
    if (!input.hasMigration(version)) input.recordMigration(version, "create_host_office_local_directory_v2_certificate");
    input.database.exec("RELEASE host_office_local_directory_v2_certificate_migration");
  } catch (error) {
    input.database.exec("ROLLBACK TO host_office_local_directory_v2_certificate_migration");
    input.database.exec("RELEASE host_office_local_directory_v2_certificate_migration");
    throw error;
  }
}
