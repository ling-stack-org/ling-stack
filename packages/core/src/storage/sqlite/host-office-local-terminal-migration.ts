import type { DatabaseSync } from "node:sqlite";

export const HOST_OFFICE_LOCAL_TERMINAL_MIGRATION_VERSION = 149;

/** Append-only terminal facts freeze an effect set; this is not a safety receipt or settlement authority. */
export function applyHostOfficeLocalTerminalMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (name: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  if (input.hasMigration(HOST_OFFICE_LOCAL_TERMINAL_MIGRATION_VERSION)
    && input.hasTable("host_office_local_terminals")) return;
  input.database.exec("SAVEPOINT host_office_local_terminal_migration");
  try {
    input.database.exec(`
      CREATE TABLE host_office_local_terminals (
        execution_id TEXT NOT NULL PRIMARY KEY REFERENCES host_office_local_executions(execution_id) ON DELETE RESTRICT,
        schema_version INTEGER NOT NULL CHECK(schema_version=1),
        protocol TEXT NOT NULL CHECK(protocol='ling-office-local-binary-v1'),
        execution_identity_digest TEXT NOT NULL CHECK(length(execution_identity_digest)=64
          AND execution_identity_digest NOT GLOB '*[^0-9a-f]*' AND instr(execution_identity_digest,char(0))=0),
        terminal_artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
        terminal_digest TEXT NOT NULL CHECK(length(terminal_digest)=64
          AND terminal_digest NOT GLOB '*[^0-9a-f]*' AND instr(terminal_digest,char(0))=0),
        effect_set_digest TEXT NOT NULL CHECK(length(effect_set_digest)=64
          AND effect_set_digest NOT GLOB '*[^0-9a-f]*' AND instr(effect_set_digest,char(0))=0),
        effect_count INTEGER NOT NULL CHECK(typeof(effect_count)='integer' AND effect_count>=0 AND effect_count<=1024),
        sealed_at TEXT NOT NULL
      );
      CREATE TRIGGER host_office_local_terminal_no_replace BEFORE INSERT ON host_office_local_terminals
        WHEN EXISTS(SELECT 1 FROM host_office_local_terminals
          WHERE execution_id=NEW.execution_id OR terminal_artifact_id=NEW.terminal_artifact_id)
        BEGIN SELECT RAISE(ABORT,'host_office_local_terminal_append_only'); END;
      CREATE TRIGGER host_office_local_terminal_immutable BEFORE UPDATE ON host_office_local_terminals
        BEGIN SELECT RAISE(ABORT,'host_office_local_terminal_immutable'); END;
      CREATE TRIGGER host_office_local_terminal_no_delete BEFORE DELETE ON host_office_local_terminals
        BEGIN SELECT RAISE(ABORT,'host_office_local_terminal_append_only'); END;
      CREATE TRIGGER host_office_local_effect_sealed_insert BEFORE INSERT ON host_office_local_effects
        WHEN EXISTS(SELECT 1 FROM host_office_local_terminals WHERE execution_id=NEW.execution_id)
          OR EXISTS(SELECT 1 FROM host_office_local_effects AS protected
            JOIN host_office_local_terminals AS terminal ON terminal.execution_id=protected.execution_id
            WHERE protected.effect_id=NEW.effect_id OR (NEW.observation_artifact_id IS NOT NULL
              AND protected.observation_artifact_id=NEW.observation_artifact_id))
        BEGIN SELECT RAISE(ABORT,'host_office_local_execution_sealed'); END;
      CREATE TRIGGER host_office_local_effect_sealed_update BEFORE UPDATE ON host_office_local_effects
        WHEN EXISTS(SELECT 1 FROM host_office_local_terminals WHERE execution_id IN (OLD.execution_id,NEW.execution_id))
          OR EXISTS(SELECT 1 FROM host_office_local_effects AS protected
            JOIN host_office_local_terminals AS terminal ON terminal.execution_id=protected.execution_id
            WHERE protected.effect_id=NEW.effect_id OR (NEW.observation_artifact_id IS NOT NULL
              AND protected.observation_artifact_id=NEW.observation_artifact_id))
        BEGIN SELECT RAISE(ABORT,'host_office_local_execution_sealed'); END;
    `);
    if (!input.hasMigration(HOST_OFFICE_LOCAL_TERMINAL_MIGRATION_VERSION)) {
      input.recordMigration(HOST_OFFICE_LOCAL_TERMINAL_MIGRATION_VERSION, "seal_host_office_local_effect_sets");
    }
    input.database.exec("RELEASE host_office_local_terminal_migration");
  } catch (error) {
    input.database.exec("ROLLBACK TO host_office_local_terminal_migration");
    input.database.exec("RELEASE host_office_local_terminal_migration");
    throw error;
  }
}
