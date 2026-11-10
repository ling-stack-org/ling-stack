import type { SqliteRunStoreMigrationContext } from "./migrations.js";

/** Add an explicitly scoped payload to the existing snapshot table after v2 cutover. */
export function applyConversationAcceptedInputMigration(context: SqliteRunStoreMigrationContext): void {
  if (context.hasMigration(130)) return;
  const { database } = context;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [name, definition] of [
      ["snapshot_use", "TEXT NOT NULL DEFAULT 'fork_context'"],
      ["payload_version", "INTEGER"], ["source_item_id", "TEXT"],
      ["payload_json", "TEXT"], ["payload_fingerprint", "TEXT"],
    ] as const) {
      if (!context.hasColumn("conversation_context_snapshots", name)) {
        database.exec(`ALTER TABLE conversation_context_snapshots ADD COLUMN ${name} ${definition}`);
      }
    }
    database.exec(`CREATE UNIQUE INDEX idx_conversation_accepted_input_source_use
      ON conversation_context_snapshots(workspace_id, source_item_id, snapshot_use)
      WHERE source_item_id IS NOT NULL`);
    context.recordMigration(130, "persist_normal_conversation_accepted_input");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
