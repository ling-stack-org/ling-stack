import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, createPreContinuityV2ReleaseSqliteRunStoreForMigrationTest } from "../dist/index.js";
import { applyChannelSessionMigration } from "../dist/storage/sqlite/channel-session-migration.js";
import { applyUserInputMigration } from "../dist/storage/sqlite/user-input-migration.js";
import { applyUserInputWaitMigration } from "../dist/storage/sqlite/user-input-wait-migration.js";
import { appendChannelItemFixture } from "./channel-conversation-fixture.mjs";

const now = "2026-10-29T01:00:00.000Z";
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-session-upgrade-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const store = createPreContinuityV2ReleaseSqliteRunStoreForMigrationTest(cwd);
  const channel = store.createChannel({ name: "Legacy channel" }, now);
  return { cwd, store, channel };
}

test("forward migration preserves history and IDs, classifies empty work sessions, and quarantines ambiguous mappings", async (t) => {
  const f = await fixture(t);
  const legacy = f.store.createLingThread({ channelId: f.channel.id, kind: "channel_discussion", title: "Old thread title",
    objective: "Old conversation", surfaceKind: "work" }, now);
  const branch = f.store.createChannelBranch({ channelId: f.channel.id, name: "Directory is canonical", rootThreadId: legacy.id, status: "archived" }, now);
  // Historical input existed before archiving through the old directory API.
  appendChannelItemFixture(f.store, { channelId: f.channel.id, threadId: legacy.id, authorType: "local-user", body: "Original history" }, now);
  const original = f.store.listConversationItemsPage({ threadId: legacy.id }).items;
  const other = f.store.createChannel({ name: "Other channel" }, now);
  const cross = f.store.createChannelBranch({ channelId: other.id, name: "Cross channel", rootThreadId: legacy.id }, now);
  // Duplicate directory and cross-channel evidence must remain intact, never choose a winner.
  const missing = f.store.createChannelBranch({ channelId: f.channel.id, name: "Missing thread" }, now);
  const clean = f.store.createLingThread({ channelId: f.channel.id, kind: "channel_discussion", title: "Clean", objective: "Clean", surfaceKind: "work" }, now);
  const cleanBranch = f.store.createChannelBranch({ channelId: f.channel.id, name: "Clean directory", rootThreadId: clean.id, status: "archived" }, now);
  const path = f.store.paths.databasePath;
  f.store.close();
  const upgraded = createSqliteRunStore(f.cwd);
  try {
    assert.ok(existsSync(`${path}.pre-channel-sessions-v179.backup`));
    const migratedDb = new DatabaseSync(path);
    try {
      assert.deepEqual(migratedDb.prepare("SELECT version, name FROM schema_migrations WHERE version BETWEEN 177 AND 179 ORDER BY version").all()
        .map(row => ({ version: row.version, name: row.name })), [
        { version: 177, name: "canonicalize_workspace_permission_settings" },
        { version: 178, name: "canonicalize_pi_runner_ids" },
        { version: 179, name: "channel_independent_sessions" },
      ]);
    } finally { migratedDb.close(); }
    assert.deepEqual(upgraded.listConversationItemsPage({ threadId: legacy.id }).items, original);
    assert.equal(upgraded.getChannelBranch(branch.id).rootThreadId, legacy.id);
    assert.equal(upgraded.getChannelBranch(cross.id).rootThreadId, legacy.id);
    assert.equal(upgraded.getLingThread(legacy.id).surfaceKind, "work");
    assert.ok(upgraded.listChannelSessions(f.channel.id).diagnostics.some((d) => d.branchId === branch.id && d.code === "duplicate_directory"));
    assert.ok(upgraded.listChannelSessions(other.id).diagnostics.some((d) => d.branchId === cross.id && d.code === "channel_mismatch"));
    assert.ok(upgraded.listChannelSessions(f.channel.id).diagnostics.some((d) => d.branchId === missing.id && d.code === "missing_thread"));
    assert.throws(() => appendChannelItemFixture(upgraded, { channelId: f.channel.id, threadId: legacy.id, authorType: "local-user", body: "Unsafe new work" }, now), { code: "session_requires_repair" });
    assert.equal(upgraded.getChannelSession(f.channel.id, clean.id).legacyBranchId, cleanBranch.id);
    assert.equal(upgraded.getLingThread(clean.id).surfaceKind, "channel_session");
    assert.ok(upgraded.getChannelSession(f.channel.id, clean.id).archivedAt);
    assert.equal(upgraded.getLingThread(clean.id).title, "Clean directory");
  } finally { upgraded.close(); }
  const again = createSqliteRunStore(f.cwd);
  try { assert.equal(again.getChannelSession(f.channel.id, clean.id).legacyBranchId, cleanBranch.id); } finally { again.close(); }
});

test("migration failure rolls back schema, classifications, and the marker before retry", async (t) => {
  const f = await fixture(t);
  const path = f.store.paths.databasePath;
  f.store.close();
  const db = new DatabaseSync(path);
  try {
    const input = { database: db, hasMigration: (v) => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(v)),
      recordMigration: (v, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(v, name, now) };
    // The historical fixture predates structured input; production applies these
    // overlays before installing the channel-session input admission triggers.
    const context = { ...input,
      hasTable: (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)),
      hasColumn: (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column) };
    applyUserInputMigration(context);
    applyUserInputWaitMigration(context);
    const schema = () => db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
    const before = schema();
    for (const failedVersion of [179, 180, 181]) {
      assert.throws(() => applyChannelSessionMigration({ ...input, recordMigration: (version, name) => {
        if (version === failedVersion) throw new Error("injected marker failure");
        input.recordMigration(version, name);
      } }), /injected marker failure/);
      assert.deepEqual(schema(), before);
      assert.equal(input.hasMigration(179), false);
      assert.equal(input.hasMigration(180), false);
      assert.equal(input.hasMigration(181), false);
    }
    applyChannelSessionMigration(input);
    assert.equal(input.hasMigration(179), true);
    assert.equal(input.hasMigration(180), true);
    assert.equal(input.hasMigration(181), true);
    const after = schema();
    applyChannelSessionMigration({ ...input, recordMigration: () => assert.fail("do not rerun") });
    assert.deepEqual(schema(), after);
  } finally { db.close(); }
});

test("proven historical fork retains its snapshot and parent while ordinary sessions have no fork lineage", async (t) => {
  const f = await fixture(t);
  const root = f.store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: f.channel.id,
    title: "Original root", objective: "Original root" }, now).thread;
  const parent = f.store.appendConversationUserTurn({ channelId: f.channel.id, threadId: root.id, title: "Fork here", userInstruction: "Fork here",
    payload: { body: "Fork here", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] }, idempotencyKey: "fork-parent" }, now);
  const fork = f.store.resolveOrCreateConversationThread({ surfaceKind: "branch", channelId: f.channel.id, parentThreadId: root.id, parentTurnId: parent.turnId,
    title: "Fork", objective: "Fork", forkContextSnapshot: { id: "legacy-fork-snapshot", segmentId: parent.contextSegmentId,
      projectionVersion: "ctxv2_branch_runtime", throughItemSequence: parent.item.sequence, summaryIds: [],
      sourceRefs: [{ type: "conversation_item", id: parent.item.id }], policyVersion: "continuity-v2-snapshot-v1" } }, now).thread;
  const branch = f.store.createChannelBranch({ channelId: f.channel.id, name: "Proven fork", rootThreadId: fork.id }, now);
  const path = f.store.paths.databasePath;
  f.store.close();
  const legacyDb = new DatabaseSync(path);
  try { legacyDb.prepare("UPDATE ling_threads SET surface_kind = 'work' WHERE id = ?").run(fork.id); } finally { legacyDb.close(); }
  const upgraded = createSqliteRunStore(f.cwd);
  try {
    const session = upgraded.getChannelSession(f.channel.id, fork.id);
    assert.equal(session.legacyBranchId, branch.id);
    assert.equal(session.surfaceKind, "branch");
    const thread = upgraded.getLingThread(fork.id);
    assert.equal(thread.parentThreadId, root.id);
    assert.equal(thread.parentTurnId, parent.turnId);
    assert.equal(thread.forkContextSnapshotId, "legacy-fork-snapshot");
    assert.equal(upgraded.listChannelSessions(f.channel.id).defaultSession.id, root.id);
    assert.equal(upgraded.getConversationContextSnapshot("legacy-fork-snapshot").threadId, root.id);
  } finally { upgraded.close(); }
});

test("upgrade keeps the active default when an archived historical root also exists", async (t) => {
  const f = await fixture(t);
  const old = f.store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: f.channel.id,
    title: "Old default", objective: "Old default" }, now).thread;
  f.store.updateLingThread(old.id, { archivedAt: now }, now);
  const active = f.store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: f.channel.id,
    title: "Current default", objective: "Current default" }, now).thread;
  assert.notEqual(old.id, active.id);
  f.store.close();
  const upgraded = createSqliteRunStore(f.cwd);
  try {
    assert.equal(upgraded.listChannelSessions(f.channel.id).defaultSession.id, active.id);
    assert.equal(upgraded.getLingThread(old.id).archivedAt, now);
  } finally { upgraded.close(); }
});
