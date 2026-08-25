import type { DatabaseSync } from "node:sqlite";

export const WORKSPACE_PROVENANCE_MIGRATION_VERSION = 123;
export const WORKSPACE_PROVENANCE_MIGRATION_NAME = "create_workspace_provenance_and_compaction_checkpoints";

export interface WorkspaceProvenanceMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (tableName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export function applyWorkspaceProvenanceMigration(input: WorkspaceProvenanceMigrationInput): boolean {
  const complete = input.hasTable("workspace_mutation_records")
    && input.hasTable("compaction_checkpoints")
    && input.hasTable("workspace_provenance_sequences");
  if (complete && input.hasMigration(WORKSPACE_PROVENANCE_MIGRATION_VERSION)) {
    return false;
  }

  input.database.exec(`
    CREATE TABLE IF NOT EXISTS workspace_provenance_sequences (
      workspace_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS workspace_mutation_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      thread_id TEXT,
      turn_id TEXT,
      run_id TEXT NOT NULL,
      tool_call_id TEXT,
      approval_id TEXT,
      artifact_id TEXT,
      forward_patch_artifact_id TEXT,
      patch_plan_id TEXT NOT NULL,
      operation_index INTEGER NOT NULL,
      path TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('add', 'update', 'delete', 'move')),
      before_sha256 TEXT NOT NULL,
      after_sha256 TEXT NOT NULL,
      inverse_patch_artifact_id TEXT NOT NULL,
      provenance_seq INTEGER NOT NULL,
      effect_state TEXT NOT NULL CHECK(effect_state IN ('applied', 'effect_unknown', 'failed')),
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE SET NULL,
      FOREIGN KEY(turn_id) REFERENCES ling_turns(id) ON DELETE SET NULL,
      FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE SET NULL,
      FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL,
      FOREIGN KEY(forward_patch_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL,
      FOREIGN KEY(inverse_patch_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
      UNIQUE(workspace_id, provenance_seq),
      UNIQUE(run_id, patch_plan_id, operation_index)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_mutations_turn_seq
    ON workspace_mutation_records(workspace_id, turn_id, provenance_seq);
    CREATE INDEX IF NOT EXISTS idx_workspace_mutations_run_seq
    ON workspace_mutation_records(run_id, provenance_seq);
    CREATE INDEX IF NOT EXISTS idx_workspace_mutations_plan
    ON workspace_mutation_records(patch_plan_id, operation_index);

    CREATE TABLE IF NOT EXISTS compaction_checkpoints (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      channel_id TEXT,
      source_turn_id TEXT NOT NULL,
      context_view_id TEXT,
      context_view_created_at TEXT,
      covered_item_seq_from INTEGER NOT NULL,
      covered_item_seq_to INTEGER NOT NULL,
      covered_turn_ids_json TEXT NOT NULL,
      summary_ids_json TEXT NOT NULL DEFAULT '[]',
      summary_content_sha256 TEXT,
      source_refs_json TEXT NOT NULL,
      workspace_provenance_watermark TEXT NOT NULL,
      compaction_policy_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(source_turn_id) REFERENCES ling_turns(id) ON DELETE RESTRICT,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_compaction_checkpoints_thread_created
    ON compaction_checkpoints(workspace_id, thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_compaction_checkpoints_turn
    ON compaction_checkpoints(source_turn_id, created_at DESC);
  `);

  if (!input.hasMigration(WORKSPACE_PROVENANCE_MIGRATION_VERSION)) {
    input.recordMigration(WORKSPACE_PROVENANCE_MIGRATION_VERSION, WORKSPACE_PROVENANCE_MIGRATION_NAME);
  }
  return true;
}
