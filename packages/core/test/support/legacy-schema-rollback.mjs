import assert from "node:assert/strict";

// Test-fixture reconstruction only. Never used by a product migration or store.
export function removePendingAuthorityOverlay(database) {
  for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'pending_authority_*'").all()) {
    assert.match(name, /^pending_authority_[a-z0-9_]+$/u);
    database.exec(`DROP TRIGGER ${name}`);
  }
  database.exec("DROP TABLE channel_pending_authority_versions; DELETE FROM schema_migrations WHERE version=192");
}

/** Restore the real pre-190 NOT NULL table before removing pre-130 columns. */
export function restorePreEmptyForkSnapshots(database) {
  assert.equal(database.prepare("SELECT count(*) AS n FROM conversation_context_snapshots WHERE segment_id IS NULL").get().n, 0,
    "a legacy fixture must not contain post-190 empty forks");
  const columns = "id, workspace_id, thread_id, segment_id, projection_version, through_item_sequence, summary_ids_json, source_refs_json, policy_version, created_at, snapshot_use, payload_version, source_item_id, payload_json, payload_fingerprint";
  database.exec(`BEGIN IMMEDIATE;
    CREATE TABLE legacy_context_snapshots (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      segment_id TEXT NOT NULL, projection_version TEXT NOT NULL, through_item_sequence INTEGER NOT NULL,
      summary_ids_json TEXT NOT NULL, source_refs_json TEXT NOT NULL, policy_version TEXT NOT NULL,
      created_at TEXT NOT NULL, snapshot_use TEXT NOT NULL DEFAULT 'fork_context',
      payload_version INTEGER, source_item_id TEXT, payload_json TEXT, payload_fingerprint TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id) REFERENCES context_segments(id) ON DELETE CASCADE
    );
    INSERT INTO legacy_context_snapshots (${columns}) SELECT ${columns} FROM conversation_context_snapshots;
    DROP TABLE conversation_context_snapshots;
    ALTER TABLE legacy_context_snapshots RENAME TO conversation_context_snapshots;
    CREATE INDEX idx_conversation_context_snapshots_thread_created ON conversation_context_snapshots(thread_id, created_at);
    CREATE UNIQUE INDEX idx_conversation_accepted_input_source_use ON conversation_context_snapshots(workspace_id, source_item_id, snapshot_use) WHERE source_item_id IS NOT NULL;
    DELETE FROM schema_migrations WHERE version=190;
    COMMIT;`);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check(conversation_context_snapshots)").all(), []);
}
