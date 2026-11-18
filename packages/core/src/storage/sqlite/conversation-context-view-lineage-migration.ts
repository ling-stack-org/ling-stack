import type { DatabaseSync } from "node:sqlite";

// Keep this after the current database-global migration range. This store is
// additive and must not reuse a version owned by a historical feature branch.
export const CONVERSATION_CONTEXT_VIEW_LINEAGE_MIGRATION_VERSION = 225;
export const CONVERSATION_CONTEXT_VIEW_LINEAGE_MIGRATION_NAME = "persist_rebuildable_context_view_lineage";

export interface ConversationContextViewLineageMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export function applyConversationContextViewLineageMigration(input: ConversationContextViewLineageMigrationInput): void {
  if (input.hasMigration(CONVERSATION_CONTEXT_VIEW_LINEAGE_MIGRATION_VERSION)) return;
  input.database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_context_view_lineage (
      lineage_key TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT,
      thread_id TEXT,
      source_item_id TEXT,
      kind TEXT NOT NULL,
      consumer_teammate_id TEXT,
      context_view_id TEXT NOT NULL,
      context_view_created_at TEXT NOT NULL,
      projection_json TEXT,
      view_fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_view_lineage_source
      ON conversation_context_view_lineage(workspace_id, channel_id, thread_id, source_item_id, kind);
    CREATE INDEX IF NOT EXISTS idx_context_view_lineage_view
      ON conversation_context_view_lineage(context_view_id);
  `);
  input.recordMigration(CONVERSATION_CONTEXT_VIEW_LINEAGE_MIGRATION_VERSION, CONVERSATION_CONTEXT_VIEW_LINEAGE_MIGRATION_NAME);
}
