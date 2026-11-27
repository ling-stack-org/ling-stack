import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CONVERSATION_VISUALIZATION_MAX_BYTES } from "@ling-stack/contracts";
import { applyConversationVisualizationMigration, getConversationVisualization } from "../dist/storage/sqlite/conversation-visualization-store.js";

test("upgrading a 128 KiB visualization table preserves committed bytes, index and deletion", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (238, 'conversation_visualizations');
    CREATE TABLE run_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE ling_threads (id TEXT PRIMARY KEY);
    CREATE TABLE ling_turns (id TEXT PRIMARY KEY);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    INSERT INTO run_sessions VALUES ('run');
    INSERT INTO ling_threads VALUES ('thread');
    INSERT INTO ling_turns VALUES ('turn');
    INSERT INTO workspaces VALUES ('workspace');
    CREATE TABLE conversation_visualizations (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES run_sessions(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES ling_threads(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES ling_turns(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      html BLOB NOT NULL CHECK(length(html) BETWEEN 1 AND 131072),
      sha256 TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      layout TEXT NOT NULL CHECK(layout IN ('standard', 'wide')),
      interaction TEXT NOT NULL CHECK(interaction IN ('native', 'script')),
      preferred_height INTEGER NOT NULL CHECK(preferred_height BETWEEN 160 AND 480),
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_conversation_visualizations_run ON conversation_visualizations(run_id);
  `);
  const oldHtml = "<p>Saved before upgrade</p>";
  const largeHtml = "<main>" + "a".repeat(750 * 1024) + "</main>";
  const insert = (id: string, html: string, height: number) => db.prepare(`
    INSERT INTO conversation_visualizations VALUES (
      ?, 'run', 'thread', 'turn', 'workspace', 'message', 'Preview', 'Summary',
      ?, ?, 'input-digest', 'wide', 'script', ?, '2026-11-27T10:00:00.000Z'
    )
  `).run(id, Buffer.from(html), createHash("sha256").update(html).digest("hex"), height);
  insert("old", oldHtml, 360);
  assert.throws(() => insert("large", largeHtml, 600), /CHECK constraint failed/u);
  const migrate = () => applyConversationVisualizationMigration({
    database: db,
    hasMigration: version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => { db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(version, name); },
  });
  migrate();
  migrate();
  assert.deepEqual(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(row => row.version), [238, 239]);
  assert.equal(getConversationVisualization(db, "old")?.html, oldHtml);
  assert.equal(getConversationVisualization(db, "old")?.runId, "run");
  assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_conversation_visualizations_run'").get());
  insert("large", largeHtml, 600);
  assert.equal(getConversationVisualization(db, "large")?.html, largeHtml);
  assert.throws(() => insert("oversized", "a".repeat(CONVERSATION_VISUALIZATION_MAX_BYTES + 1), 600), /CHECK constraint failed/u);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.exec("DELETE FROM run_sessions WHERE id='run'");
  assert.equal(db.prepare("SELECT count(*) AS count FROM conversation_visualizations").get()!.count, 0);
});
