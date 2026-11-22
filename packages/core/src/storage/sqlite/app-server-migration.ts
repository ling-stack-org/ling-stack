import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteRunStoreMigrationContext } from "./migrations.js";

const WORK_ITEM_CONTROL_MIGRATION_VERSION = 235;
const WORK_ITEM_CONTROL_MIGRATION_NAME = "add_work_item_control_projection";
const WORK_ITEM_EVIDENCE_MIGRATION_VERSION = 236;
const WORK_ITEM_EVIDENCE_MIGRATION_NAME = "create_work_item_evidence";
const APP_SERVER_STATE_MIGRATION_VERSION = 237;
const APP_SERVER_STATE_MIGRATION_NAME = "create_app_server_state";

const controlColumns = [
  ["revision", "INTEGER NOT NULL DEFAULT 1"],
  ["plan_revision", "TEXT"],
  ["control_state", "TEXT NOT NULL DEFAULT 'active'"],
  ["control_generation", "INTEGER NOT NULL DEFAULT 0"],
  ["control_receipt_json", "TEXT"],
  ["control_unresolved_effect_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["control_recovery_owner", "TEXT"],
  ["holds_json", "TEXT NOT NULL DEFAULT '[]'"],
] as const;

export function applyAppServerMigrations(context: SqliteRunStoreMigrationContext): void {
  const { database } = context;
  const hasWorkItemControl = context.hasMigration(WORK_ITEM_CONTROL_MIGRATION_VERSION);
  const hasWorkItemEvidence = context.hasMigration(WORK_ITEM_EVIDENCE_MIGRATION_VERSION);
  const hasAppServerState = context.hasMigration(APP_SERVER_STATE_MIGRATION_VERSION);
  if (hasWorkItemControl && hasWorkItemEvidence && hasAppServerState && context.hasColumn("work_items", "control_state")) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [name, definition] of controlColumns) {
      if (!context.hasColumn("work_items", name)) {
        database.exec(`ALTER TABLE work_items ADD COLUMN ${name} ${definition}`);
      }
    }
    if (!hasWorkItemControl) {
      context.recordMigration(WORK_ITEM_CONTROL_MIGRATION_VERSION, WORK_ITEM_CONTROL_MIGRATION_NAME);
    }
    if (!hasWorkItemEvidence) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS work_item_evidence (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          work_item_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          subject_revision TEXT NOT NULL,
          kind TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          content TEXT NOT NULL,
          option_id TEXT,
          source_refs_json TEXT NOT NULL,
          visibility TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(workspace_id, work_item_id, idempotency_key),
          UNIQUE(workspace_id, work_item_id, sequence),
          FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_work_item_evidence_item_sequence
          ON work_item_evidence(workspace_id, work_item_id, sequence);
      `);
      context.recordMigration(WORK_ITEM_EVIDENCE_MIGRATION_VERSION, WORK_ITEM_EVIDENCE_MIGRATION_NAME);
    }
    if (!hasAppServerState) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS app_server_state (
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          record_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          idempotency_key TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, kind, record_id),
          UNIQUE (workspace_id, kind, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_app_server_state_kind_updated
          ON app_server_state(workspace_id, kind, updated_at);
      `);
      context.recordMigration(APP_SERVER_STATE_MIGRATION_VERSION, APP_SERVER_STATE_MIGRATION_NAME);
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
