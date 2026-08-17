import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export const CONTROL_PLANE_REPLAY_STATE_MIGRATION_VERSION = 117;
export const CONTROL_PLANE_REPLAY_STATE_MIGRATION_NAME = "add_control_plane_replay_state";

export interface ControlPlaneReplayStateMigrationContext {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
  readonly now: string;
}

export function applyControlPlaneReplayStateMigration(input: ControlPlaneReplayStateMigrationContext): boolean {
  if (input.hasMigration(CONTROL_PLANE_REPLAY_STATE_MIGRATION_VERSION) && postconditionsPass(input.database)) return false;
  input.database.exec("BEGIN IMMEDIATE;");
  try {
    input.database.exec(`
      CREATE TABLE IF NOT EXISTS control_plane_replay_state (
        workspace_id TEXT PRIMARY KEY,
        replay_floor_seq INTEGER NOT NULL CHECK (replay_floor_seq >= 0),
        latest_seq INTEGER NOT NULL CHECK (latest_seq >= replay_floor_seq),
        updated_at TEXT NOT NULL
      );
    `);
    const workspaceRows = input.database.prepare(`
      SELECT workspace_id, COALESCE(MAX(seq), 0) AS latest_seq
      FROM control_plane_events
      GROUP BY workspace_id
    `).all() as Record<string, SQLOutputValue>[];
    const upsert = input.database.prepare(`
      INSERT INTO control_plane_replay_state (workspace_id, replay_floor_seq, latest_seq, updated_at)
      VALUES (?, 0, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        latest_seq = MAX(control_plane_replay_state.latest_seq, excluded.latest_seq),
        updated_at = excluded.updated_at
    `);
    for (const row of workspaceRows) upsert.run(String(row.workspace_id), Number(row.latest_seq), input.now);
    if (!input.hasMigration(CONTROL_PLANE_REPLAY_STATE_MIGRATION_VERSION)) {
      input.recordMigration(CONTROL_PLANE_REPLAY_STATE_MIGRATION_VERSION, CONTROL_PLANE_REPLAY_STATE_MIGRATION_NAME);
    }
    if (!postconditionsPass(input.database)) throw new Error("Control-plane replay-state migration postconditions failed.");
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    if (input.database.isTransaction) input.database.exec("ROLLBACK;");
    throw error;
  }
}

function postconditionsPass(database: DatabaseSync): boolean {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_plane_replay_state'").get();
  if (!table) return false;
  const invalid = database.prepare(`
    SELECT 1
    FROM control_plane_replay_state
    WHERE replay_floor_seq < 0 OR latest_seq < replay_floor_seq
    LIMIT 1
  `).get();
  if (invalid) return false;
  const missing = database.prepare(`
    SELECT 1
    FROM (SELECT workspace_id, MAX(seq) AS latest_seq FROM control_plane_events GROUP BY workspace_id) events
    LEFT JOIN control_plane_replay_state state ON state.workspace_id = events.workspace_id
    WHERE state.workspace_id IS NULL OR state.latest_seq < events.latest_seq
    LIMIT 1
  `).get();
  return !missing;
}
