import type { DatabaseSync } from "node:sqlite";

export const HOST_OPERATION_JOURNAL_MIGRATION_VERSION = 145;

/** New Host facts only. Never synthesizes operation authority from historical tool rows. */
export function applyHostOperationJournalMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (name: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  if (input.hasMigration(HOST_OPERATION_JOURNAL_MIGRATION_VERSION) && input.hasTable("host_operations")) return;
  input.database.exec("SAVEPOINT host_operation_journal_migration");
  try {
    input.database.exec(`
      CREATE TABLE IF NOT EXISTS host_operations (
        operation_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK(schema_version=1),
        run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE CASCADE,
        work_unit_id TEXT NOT NULL REFERENCES work_units(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
        runtime_instance_id TEXT NOT NULL,
        fencing_token TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('command','file_mutation','mcp','plugin','media','host_capability',
          'approval','permission','approval_review','hydration','sdk_tool','cleanup')),
        tool_call_id TEXT NOT NULL,
        parent_operation_id TEXT REFERENCES host_operations(operation_id) ON DELETE RESTRICT,
        producer_id TEXT,
        phase TEXT NOT NULL CHECK(phase IN ('admitted','launched','safe','unknown_outcome')),
        admitted_at TEXT NOT NULL,
        launched_at TEXT,
        settled_at TEXT,
        settlement_kind TEXT CHECK(settlement_kind IN ('known_no_start','file_completed','unknown_outcome')),
        evidence_kind TEXT CHECK(evidence_kind IN ('harness_tool_execution','host_command')),
        evidence_id TEXT,
        domain_identity_digest TEXT,
        evidence_digest TEXT,
        settlement_signature TEXT,
        code TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
        CHECK((parent_operation_id IS NULL AND producer_id IS NULL)
          OR (parent_operation_id IS NOT NULL AND producer_id IS NOT NULL)),
        CHECK((evidence_kind IS NULL AND evidence_id IS NULL AND domain_identity_digest IS NULL)
          OR (evidence_kind IS NOT NULL AND evidence_id IS NOT NULL AND length(domain_identity_digest)=64)),
        CHECK((phase IN ('admitted','launched') AND settled_at IS NULL AND settlement_kind IS NULL
          AND evidence_digest IS NULL AND settlement_signature IS NULL AND code IS NULL)
          OR (phase='safe' AND settled_at IS NOT NULL AND settlement_kind IN ('known_no_start','file_completed')
            AND length(evidence_digest)=64 AND settlement_signature IS NOT NULL AND code IS NULL)
          OR (phase='unknown_outcome' AND settled_at IS NOT NULL AND settlement_kind='unknown_outcome'
            AND settlement_signature IS NOT NULL AND code IS NOT NULL)),
        CHECK(phase!='launched' OR launched_at IS NOT NULL),
        CHECK(settlement_kind IS NOT 'known_no_start' OR launched_at IS NULL),
        CHECK(settlement_kind IS NOT 'file_completed' OR launched_at IS NOT NULL),
        UNIQUE(evidence_kind,evidence_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_host_operations_root_identity
        ON host_operations(attempt_id,kind,tool_call_id) WHERE parent_operation_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_host_operations_producer_identity
        ON host_operations(parent_operation_id,kind,producer_id) WHERE parent_operation_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_host_operations_source
        ON host_operations(run_id,attempt_id,phase,operation_id);
      CREATE TRIGGER IF NOT EXISTS host_operations_immutable_identity
        BEFORE UPDATE ON host_operations WHEN NEW.operation_id IS NOT OLD.operation_id
          OR NEW.schema_version IS NOT OLD.schema_version OR NEW.run_id IS NOT OLD.run_id
          OR NEW.work_unit_id IS NOT OLD.work_unit_id OR NEW.attempt_id IS NOT OLD.attempt_id
          OR NEW.runtime_instance_id IS NOT OLD.runtime_instance_id OR NEW.fencing_token IS NOT OLD.fencing_token
          OR NEW.kind IS NOT OLD.kind OR NEW.tool_call_id IS NOT OLD.tool_call_id
          OR NEW.parent_operation_id IS NOT OLD.parent_operation_id OR NEW.producer_id IS NOT OLD.producer_id
          OR NEW.admitted_at IS NOT OLD.admitted_at
        BEGIN SELECT RAISE(ABORT,'host_operation_identity_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS host_operations_immutable_binding
        BEFORE UPDATE ON host_operations WHEN OLD.evidence_id IS NOT NULL
          AND (NEW.evidence_kind IS NOT OLD.evidence_kind OR NEW.evidence_id IS NOT OLD.evidence_id
            OR NEW.domain_identity_digest IS NOT OLD.domain_identity_digest)
        BEGIN SELECT RAISE(ABORT,'host_operation_binding_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS host_operations_immutable_settlement
        BEFORE UPDATE ON host_operations WHEN OLD.phase IN ('safe','unknown_outcome')
        BEGIN SELECT RAISE(ABORT,'host_operation_settlement_immutable'); END;
    `);
    if (!input.hasMigration(HOST_OPERATION_JOURNAL_MIGRATION_VERSION)) {
      input.recordMigration(HOST_OPERATION_JOURNAL_MIGRATION_VERSION, "create_host_operation_journal");
    }
    input.database.exec("RELEASE host_operation_journal_migration");
  } catch (error) {
    input.database.exec("ROLLBACK TO host_operation_journal_migration");
    input.database.exec("RELEASE host_operation_journal_migration");
    throw error;
  }
}
