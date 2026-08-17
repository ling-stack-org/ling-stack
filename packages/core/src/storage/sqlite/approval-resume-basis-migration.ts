import type { DatabaseSync } from "node:sqlite";

export const APPROVAL_RESUME_BASIS_MIGRATION_VERSION = 118;
export const APPROVAL_RESUME_BASIS_MIGRATION_NAME = "add_approval_resume_basis";

export interface ApprovalResumeBasisMigrationContext {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasColumn: (tableName: string, columnName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export function applyApprovalResumeBasisMigration(input: ApprovalResumeBasisMigrationContext): boolean {
  const recorded = input.hasMigration(APPROVAL_RESUME_BASIS_MIGRATION_VERSION);
  const hasRevision = input.hasColumn("approval_checkpoints", "revision");
  const hasResumeBasis = input.hasColumn("approval_checkpoints", "resume_basis_json");
  if (recorded && hasRevision && hasResumeBasis) return false;

  input.database.exec("BEGIN IMMEDIATE;");
  try {
    if (!hasRevision) {
      input.database.exec("ALTER TABLE approval_checkpoints ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;");
    }
    if (!hasResumeBasis) {
      input.database.exec("ALTER TABLE approval_checkpoints ADD COLUMN resume_basis_json TEXT;");
    }
    if (!recorded) {
      input.recordMigration(APPROVAL_RESUME_BASIS_MIGRATION_VERSION, APPROVAL_RESUME_BASIS_MIGRATION_NAME);
    }
    if (!input.hasColumn("approval_checkpoints", "revision") || !input.hasColumn("approval_checkpoints", "resume_basis_json")) {
      throw new Error("Approval resume-basis migration postconditions failed.");
    }
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    if (input.database.isTransaction) input.database.exec("ROLLBACK;");
    throw error;
  }
}
