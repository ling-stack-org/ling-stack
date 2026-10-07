import type { DatabaseSync } from "node:sqlite";

// 139 was already allocated by an older development branch (`create_delegation_tree`).
// Migration versions are database-global, so reusing it makes an existing database
// incorrectly report this migration as applied while the table is absent.
export const APPROVAL_POSTCOMMIT_MIGRATION_VERSION = 144;
export const APPROVAL_POSTCOMMIT_MIGRATION_NAME = "create_approval_postcommit_effects";

/** Durable owner work is created in the same savepoint as an approval decision. */
export function applyApprovalPostCommitMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (tableName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const migrationRecorded = input.hasMigration(APPROVAL_POSTCOMMIT_MIGRATION_VERSION);
  if (migrationRecorded && input.hasTable("approval_postcommit_effects")) return;
  input.database.exec("SAVEPOINT approval_postcommit_migration");
  try {
    input.database.exec(`
    CREATE TABLE IF NOT EXISTS approval_postcommit_effects (
      approval_id TEXT NOT NULL,
      effect_kind TEXT NOT NULL CHECK(effect_kind IN ('decision_event', 'owner', 'control_plane_event')),
      owner_kind TEXT CHECK(owner_kind IN ('run', 'workflow_step', 'media_job', 'external_work_action')),
      owner_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'completed', 'blocked', 'effect_unknown')),
      revision INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT,
      claim_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(approval_id, effect_kind),
      FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_approval_postcommit_recovery
      ON approval_postcommit_effects(status, created_at, approval_id, effect_kind);
  `);
    if (!migrationRecorded) {
      input.recordMigration(APPROVAL_POSTCOMMIT_MIGRATION_VERSION, APPROVAL_POSTCOMMIT_MIGRATION_NAME);
    }
    input.database.exec("RELEASE approval_postcommit_migration");
  } catch (error) {
    input.database.exec("ROLLBACK TO approval_postcommit_migration");
    input.database.exec("RELEASE approval_postcommit_migration");
    throw error;
  }
}
