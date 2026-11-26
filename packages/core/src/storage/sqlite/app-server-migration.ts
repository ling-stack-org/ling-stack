import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteRunStoreMigrationContext } from "./migrations.js";

const WORK_ITEM_CONTROL_MIGRATION_VERSION = 235;
const WORK_ITEM_CONTROL_MIGRATION_NAME = "add_work_item_control_projection";
const WORK_ITEM_EVIDENCE_MIGRATION_VERSION = 236;
const WORK_ITEM_EVIDENCE_MIGRATION_NAME = "create_work_item_evidence";
export const APP_SERVER_STATE_MIGRATION_VERSION = 237;
const APP_SERVER_STATE_MIGRATION_NAME = "create_app_server_state";
const WORK_ITEM_DEVICE_EFFECTS_MIGRATION_VERSION = 239;
const WORK_ITEM_DEVICE_EFFECTS_MIGRATION_NAME = "project_unresolved_work_item_device_effects";

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
  const hasDeviceEffects = context.hasMigration(WORK_ITEM_DEVICE_EFFECTS_MIGRATION_VERSION);
  if (hasWorkItemControl && hasWorkItemEvidence && hasAppServerState && hasDeviceEffects && context.hasColumn("work_items", "control_state")) return;

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
    if (!hasDeviceEffects) {
      database.exec(`
        WITH unresolved_devices AS (
          SELECT binding.workspace_id, binding.record_id AS effect_id,
            json_extract(binding.payload_json, '$.binding.workItemId') AS work_item_id
          FROM app_server_state AS binding
          WHERE binding.kind = 'work_item_device_binding' AND COALESCE((
            SELECT json_extract(receipt.payload_json, '$.receipt.status')
            FROM app_server_state AS receipt
            WHERE receipt.workspace_id = binding.workspace_id AND receipt.kind = 'work_item_device_receipt'
              AND json_extract(receipt.payload_json, '$.bindingId') = binding.record_id
              AND json_extract(receipt.payload_json, '$.bindingRevision') = json_extract(binding.payload_json, '$.binding.revision')
              AND json_extract(receipt.payload_json, '$.receipt.receivedAt') > COALESCE(json_extract(binding.payload_json, '$.binding.receipt.receivedAt'), '')
            ORDER BY json_extract(receipt.payload_json, '$.receipt.receivedAt') DESC,
              json_extract(receipt.payload_json, '$.receipt.receiptId') DESC
            LIMIT 1
          ), json_extract(binding.payload_json, '$.binding.status')) = 'unknown'
        )
        UPDATE work_items AS item SET
          control_unresolved_effect_ids_json = (
            SELECT json_group_array(effect_id) FROM (
              SELECT value AS effect_id FROM json_each(item.control_unresolved_effect_ids_json)
              UNION
              SELECT effect_id FROM unresolved_devices WHERE workspace_id = item.workspace_id AND work_item_id = item.id
            )
          ),
          control_recovery_owner = COALESCE(control_recovery_owner, 'device_fabric'),
          control_state = CASE control_state WHEN 'active' THEN 'blocked' WHEN 'cancelled' THEN 'cancelling' ELSE control_state END,
          revision = revision + 1
        WHERE EXISTS (SELECT 1 FROM unresolved_devices WHERE workspace_id = item.workspace_id AND work_item_id = item.id);
      `);
      context.recordMigration(WORK_ITEM_DEVICE_EFFECTS_MIGRATION_VERSION, WORK_ITEM_DEVICE_EFFECTS_MIGRATION_NAME);
    }
    database.exec("COMMIT");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }
}
