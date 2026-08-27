import type { DatabaseSync } from "node:sqlite";

export const POST_COMPACTION_UNDO_MIGRATION_VERSION = 124;
export const POST_COMPACTION_UNDO_MIGRATION_NAME = "create_post_compaction_undo_records";

export interface PostCompactionUndoMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (tableName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export function applyPostCompactionUndoMigration(input: PostCompactionUndoMigrationInput): boolean {
  if (input.hasTable("post_compaction_undo_records") && input.hasMigration(POST_COMPACTION_UNDO_MIGRATION_VERSION)) {
    return false;
  }
  input.database.exec(`
    CREATE TABLE IF NOT EXISTS post_compaction_undo_records (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      target_turn_id TEXT NOT NULL,
      target_run_ids_json TEXT NOT NULL,
      checkpoint_id TEXT,
      expected_workspace_fingerprint TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('undo', 'reapply')),
      state TEXT NOT NULL CHECK(state IN (
        'available', 'validating', 'applied', 'undone', 'conflict',
        'provenance_missing', 'snapshot_unverified', 'expired', 'failed'
      )),
      affected_paths_json TEXT NOT NULL,
      last_event_seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(target_turn_id) REFERENCES ling_turns(id) ON DELETE CASCADE,
      FOREIGN KEY(checkpoint_id) REFERENCES compaction_checkpoints(id) ON DELETE SET NULL,
      UNIQUE(workspace_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_post_compaction_undo_turn_created
    ON post_compaction_undo_records(workspace_id, target_turn_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_post_compaction_undo_thread_created
    ON post_compaction_undo_records(workspace_id, thread_id, created_at DESC);
  `);
  if (!input.hasMigration(POST_COMPACTION_UNDO_MIGRATION_VERSION)) {
    input.recordMigration(POST_COMPACTION_UNDO_MIGRATION_VERSION, POST_COMPACTION_UNDO_MIGRATION_NAME);
  }
  return true;
}
