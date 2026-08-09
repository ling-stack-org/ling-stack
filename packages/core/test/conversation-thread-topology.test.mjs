import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createLegacySqliteRunStoreForMigrationTest,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";
import { applyContinuityV2StorageMigration } from "../dist/storage/sqlite/continuity-v2-migration.js";

const now = "2026-08-09T15:00:00.000Z";

test("Conversation topology resolves one root and one topic per committed anchor", async (t) => {
  const fixture = await createMigratedFixture(t);
  const root = fixture.store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: fixture.channelId,
    title: "Ignored replacement title",
    objective: "Ignored replacement objective",
  }, now);
  assert.equal(root.created, false);
  assert.equal(root.thread.id, fixture.rootThreadId);
  assert.ok(fixture.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 110").get());
  assert.equal(fixture.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel_messages'").get(), undefined);
  assert.equal(fixture.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_context_summaries'").get(), undefined);

  const anchor = appendUserTurn(fixture, "topic-anchor", "Discuss topology");
  const topicInput = {
    id: "thread-topic-runtime",
    surfaceKind: "topic",
    channelId: fixture.channelId,
    anchorItemId: anchor.item.id,
    title: "Topology",
    objective: "Discuss topology",
  };
  const topic = fixture.store.resolveOrCreateConversationThread(topicInput, "2026-08-09T15:01:00.000Z");
  assert.equal(topic.created, true);
  assert.equal(topic.thread.parentThreadId, fixture.rootThreadId);
  assert.equal(topic.thread.parentTurnId, anchor.turnId);
  assert.equal(topic.thread.anchorItemId, anchor.item.id);
  assert.equal(topic.thread.nextItemSequence, 1);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM conversation_items WHERE thread_id = ?").get(topic.thread.id).count, 0);

  const replay = fixture.store.resolveOrCreateConversationThread({ ...topicInput, id: undefined }, "2026-08-09T15:02:00.000Z");
  assert.equal(replay.created, false);
  assert.equal(replay.thread.id, topic.thread.id);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM ling_threads WHERE anchor_item_id = ?").get(anchor.item.id).count, 1);
});

test("Conversation topology creates branch lineage atomically and rejects cross-channel parents", async (t) => {
  const fixture = await createMigratedFixture(t);
  const parent = appendUserTurn(fixture, "branch-parent", "Fork here");
  const branchInput = {
    id: "thread-branch-runtime",
    surfaceKind: "branch",
    channelId: fixture.channelId,
    parentThreadId: fixture.rootThreadId,
    parentTurnId: parent.turnId,
    title: "Branch",
    objective: "Explore a branch",
  };
  const branch = fixture.store.resolveOrCreateConversationThread(branchInput, now);
  assert.equal(branch.created, true);
  assert.equal(branch.thread.relationKind, "branch");
  assert.equal(branch.thread.parentThreadId, fixture.rootThreadId);
  assert.equal(branch.thread.parentTurnId, parent.turnId);

  const replay = fixture.store.resolveOrCreateConversationThread(branchInput, "2026-08-09T15:01:00.000Z");
  assert.equal(replay.created, false);
  assert.equal(replay.thread.id, branch.thread.id);

  const other = fixture.store.createChannel({ name: "Other", boundPath: fixture.cwd }, now);
  assert.throws(() => fixture.store.resolveOrCreateConversationThread({
    ...branchInput,
    id: "thread-invalid-cross-channel",
    channelId: other.id,
  }, now), /parent thread does not belong to channel/);
  assert.equal(fixture.database.prepare("SELECT 1 FROM ling_threads WHERE id = 'thread-invalid-cross-channel'").get(), undefined);
});

function appendUserTurn(fixture, suffix, body) {
  return fixture.store.appendConversationUserTurn({
    itemId: `item-${suffix}`,
    turnId: `turn-${suffix}`,
    channelId: fixture.channelId,
    threadId: fixture.rootThreadId,
    title: body,
    userInstruction: body,
    payload: {
      body,
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: `request-${suffix}`,
  }, now);
}

async function createMigratedFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-conversation-topology-"));
  const legacyStore = createLegacySqliteRunStoreForMigrationTest(cwd);
  const channel = legacyStore.createChannel({ name: "Topology", boundPath: cwd }, "2026-08-09T13:00:00.000Z");
  const rootThread = legacyStore.createLingThread({
    id: "thread-topology-root",
    kind: "channel_discussion",
    channelId: channel.id,
    title: "Root",
    objective: "Root conversation",
  }, "2026-08-09T13:00:01.000Z");
  legacyStore.close();
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  applyContinuityV2StorageMigration({
    database,
    appliedAt: "2026-08-09T13:30:00.000Z",
    hasMigration: (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)),
    recordMigration: (version, name) => database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)
    `).run(version, name, "2026-08-09T13:30:00.000Z"),
  });
  assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = 110").get());
  assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_messages'").get(), undefined);
  database.close();
  const store = createSqliteRunStore(cwd);
  const reopened = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  reopened.exec("PRAGMA foreign_keys = ON;");
  assert.equal(reopened.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
  t.after(async () => {
    store.close();
    reopened.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    database: reopened,
    channelId: channel.id,
    rootThreadId: rootThread.id,
    store,
  };
}
