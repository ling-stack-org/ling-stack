import type { DatabaseSync } from "node:sqlite";

/** Additive seek indexes also cover existing databases; never rewrite stored Turns. */
export function ensureLingTurnCursorIndexes(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_ling_turns_workspace_thread_created_id
      ON ling_turns(workspace_id, thread_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_ling_turns_workspace_thread_updated_id
      ON ling_turns(workspace_id, thread_id, updated_at DESC, id DESC);
  `);
}
