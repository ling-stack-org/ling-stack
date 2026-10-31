import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyConversationEmptyForkMigration } from "../dist/storage/sqlite/conversation-empty-fork-migration.js";

// Regression: C03-BRANCH-TOPOLOGY — empty origins must not discard snapshot payloads.
// Found by /qa on 2026-10-25.
// Report: output/e6-20260928/p3-bash-cwd-contract-live-20261025/c03-scope-findings.md
// Real isolated SQLite; minimal parent schemas, no real profile/GUI coverage.
function fixture(t) {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE workspaces(id TEXT PRIMARY KEY); CREATE TABLE ling_threads(id TEXT PRIMARY KEY);
    CREATE TABLE context_segments(id TEXT PRIMARY KEY);
    INSERT INTO workspaces VALUES ('workspace_default'); INSERT INTO ling_threads VALUES ('parent');
    INSERT INTO context_segments VALUES ('segment');
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT);
    CREATE TABLE conversation_context_snapshots (
      id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,thread_id TEXT NOT NULL,segment_id TEXT NOT NULL,
      projection_version TEXT NOT NULL,through_item_sequence INTEGER NOT NULL,summary_ids_json TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,policy_version TEXT NOT NULL,created_at TEXT NOT NULL,
      snapshot_use TEXT NOT NULL DEFAULT 'fork_context',payload_version INTEGER,source_item_id TEXT,
      payload_json TEXT,payload_fingerprint TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id) REFERENCES context_segments(id) ON DELETE CASCADE);
    CREATE INDEX idx_conversation_context_snapshots_thread_created ON conversation_context_snapshots(thread_id,created_at);
    CREATE UNIQUE INDEX idx_conversation_accepted_input_source_use
      ON conversation_context_snapshots(workspace_id,source_item_id,snapshot_use) WHERE source_item_id IS NOT NULL;
    INSERT INTO conversation_context_snapshots VALUES
      ('fork','workspace_default','parent','segment','projection',1,'[]','[]','policy','2026-10-25T00:00:00.000Z','fork_context',NULL,NULL,NULL,NULL),
      ('accepted','workspace_default','parent','segment','projection2',2,'[]','[]','policy','2026-10-25T00:00:01.000Z','accepted_input',1,'item','{"text":"EXACT\\nPAYLOAD"}','fingerprint');`);
  return { database, hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(version, name, "2026-10-25T00:01:00.000Z") };
}
const rows = f => f.database.prepare("SELECT * FROM conversation_context_snapshots ORDER BY id").all();
const segment = f => f.database.prepare("PRAGMA table_info(conversation_context_snapshots)").all().find(row => row.name === "segment_id");
test("migration preserves every snapshot and accepted payload column and both indexes", t => {
  const f = fixture(t), before = rows(f);
  applyConversationEmptyForkMigration(f);
  assert.deepEqual(rows(f), before); assert.equal(segment(f).notnull, 0);
  assert.equal(f.hasMigration(190), true);
  assert.equal(f.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(f.database.prepare("PRAGMA index_list(conversation_context_snapshots)").all().length, 3);
  assert.throws(() => f.database.exec(`INSERT INTO conversation_context_snapshots SELECT
    'duplicate',workspace_id,thread_id,segment_id,projection_version,through_item_sequence,summary_ids_json,
    source_refs_json,policy_version,created_at,snapshot_use,payload_version,source_item_id,payload_json,payload_fingerprint
    FROM conversation_context_snapshots WHERE id='accepted'`), /UNIQUE/);
  applyConversationEmptyForkMigration(f); assert.deepEqual(rows(f), before);
});
test("a failed migration rolls back schema, payloads and marker together", t => {
  const f = fixture(t), before = rows(f);
  assert.throws(() => applyConversationEmptyForkMigration({ ...f, recordMigration() { throw new Error("fixture-write-failure"); } }), /fixture-write-failure/);
  assert.deepEqual(rows(f), before); assert.equal(segment(f).notnull, 1);
  assert.equal(f.hasMigration(190), false);
  assert.equal(f.database.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_context_snapshots_v190'").get(), undefined);
});
test("unknown schema extensions are refused before a rebuild can discard them", t => {
  const f = fixture(t);
  f.database.exec("ALTER TABLE conversation_context_snapshots ADD COLUMN future_payload TEXT");
  assert.throws(() => applyConversationEmptyForkMigration(f), /schema|source/);
  assert.equal(segment(f).notnull, 1); assert.equal(f.hasMigration(190), false);
});
