import type { DatabaseSync } from "node:sqlite";
import { createRequiredParticipantManifestV1 } from "@ling-stack/contracts";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const CHANNEL_INTENT_V2_MIGRATION_VERSION = 111;
export const CHANNEL_INTENT_V2_MIGRATION_NAME = "replace_channel_intent_decisions_with_v2";

const EMPTY_MANIFEST_JSON = JSON.stringify(createRequiredParticipantManifestV1([])).replaceAll("'", "''");

export interface ChannelIntentV2MigrationContext {
  readonly database: DatabaseSync;
  readonly appliedAt: string;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export function applyChannelIntentV2Migration(input: ChannelIntentV2MigrationContext): boolean {
  if (input.hasMigration(CHANNEL_INTENT_V2_MIGRATION_VERSION)) return false;
  assertCanonicalTimestamp(input.appliedAt);
  assertContinuityV2Authority(input.database);

  input.database.exec("BEGIN IMMEDIATE;");
  try {
    input.database.exec(`
      DROP INDEX IF EXISTS idx_channel_intent_decisions_channel_created;
      DROP INDEX IF EXISTS idx_channel_intent_decisions_source;
      DROP INDEX IF EXISTS idx_channel_intent_decisions_status;

      ALTER TABLE channel_intent_decisions RENAME TO channel_intent_decisions_v1_removed;

      CREATE TABLE channel_intent_decisions (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 2),
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        source_item_id TEXT NOT NULL,
        context_segment_id TEXT NOT NULL,
        context_projection_version TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN (
          'no_reply', 'reply', 'visible_multi_reply', 'clarify', 'workflow_proposal', 'execute'
        )),
        selected_teammate_ids_json TEXT NOT NULL,
        participant_manifest_json TEXT NOT NULL DEFAULT '${EMPTY_MANIFEST_JSON}',
        proposal_id TEXT,
        result_item_ids_json TEXT NOT NULL,
        workflow_id TEXT,
        reason TEXT NOT NULL,
        clarification_json TEXT,
        execution_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'suppressed', 'failed')),
        created_by TEXT NOT NULL CHECK (created_by IN ('deterministic', 'model_policy')),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY(source_turn_id) REFERENCES ling_turns(id) ON DELETE CASCADE,
        FOREIGN KEY(source_item_id) REFERENCES conversation_items(id) ON DELETE CASCADE,
        FOREIGN KEY(context_segment_id) REFERENCES context_segments(id) ON DELETE RESTRICT,
        FOREIGN KEY(proposal_id) REFERENCES channel_execution_proposals(id) ON DELETE SET NULL,
        FOREIGN KEY(workflow_id) REFERENCES channel_workflows(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_channel_intent_decisions_channel_created
      ON channel_intent_decisions(workspace_id, channel_id, created_at);

      CREATE INDEX idx_channel_intent_decisions_source
      ON channel_intent_decisions(workspace_id, source_item_id);

      CREATE INDEX idx_channel_intent_decisions_turn
      ON channel_intent_decisions(workspace_id, source_turn_id, created_at);

      CREATE INDEX idx_channel_intent_decisions_segment
      ON channel_intent_decisions(workspace_id, context_segment_id, created_at);

      CREATE INDEX idx_channel_intent_decisions_status
      ON channel_intent_decisions(workspace_id, channel_id, status, updated_at);

      DROP TABLE channel_intent_decisions_v1_removed;
    `);
    input.recordMigration(CHANNEL_INTENT_V2_MIGRATION_VERSION, CHANNEL_INTENT_V2_MIGRATION_NAME);
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}

function assertContinuityV2Authority(database: DatabaseSync): void {
  for (const table of [
    "channel_intent_decisions",
    "conversation_items",
    "ling_turns",
    "context_segments",
  ]) {
    const exists = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) throw new Error(`Channel Intent v2 migration requires table: ${table}`);
  }
}

function assertCanonicalTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Expected canonical ISO timestamp: ${value}`);
  }
}
