import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createBuiltinAiTeammateId,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";

test("remote projection migration and triggers are idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-outbox-migration-"));
  try {
    createSqliteRunStore(cwd).close();
    createSqliteRunStore(cwd).close();
    const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    try {
      for (const table of [
        "remote_command_receipts",
        "remote_dispatch_intents",
        "remote_projection_outbox",
        "conversation_read_states",
      ]) {
        assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
      }
      assert.ok(database.prepare(
        "SELECT version FROM schema_migrations WHERE version = 108 AND name = 'create_remote_conversation_state'",
      ).get());
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 108").get().count, 1);
    } finally {
      database.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("existing conversation and profile writes durably enqueue lightweight projection changes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-outbox-"));
  const store = createSqliteRunStore(cwd);
  try {
    const start = store.listRemoteProjectionOutbox({ limit: 1_000 }).at(-1)?.activitySeq ?? 0;
    const channel = store.createChannel({ name: "Projection", boundPath: cwd }, "2026-07-31T02:00:00.000Z");
    const channelMessage = store.createChannelMessage({
      channelId: channel.id,
      authorType: "ai-teammate",
      authorId: createBuiltinAiTeammateId("engineer"),
      body: "A durable channel reply.",
    }, "2026-07-31T02:00:01.000Z");
    const direct = store.getOrCreateTeammateDirectThread(
      createBuiltinAiTeammateId("designer"),
      "2026-07-31T02:00:02.000Z",
    );
    const directMessage = store.createTeammateDirectMessage({
      threadId: direct.id,
      teammateId: direct.teammateId,
      authorType: "ai-teammate",
      authorId: direct.teammateId,
      body: "A durable direct reply.",
    }, "2026-07-31T02:00:03.000Z");
    const conversation = store.createLingThread({
      kind: "conversation",
      teammateId: createBuiltinAiTeammateId("ling"),
      title: "Projection conversation",
      objective: "Verify outbox",
    }, "2026-07-31T02:00:04.000Z");
    const turn = store.createLingTurn({
      threadId: conversation.id,
      kind: "manual_followup",
      title: "Projection turn",
      userInstruction: "Verify the durable outbox.",
    }, "2026-07-31T02:00:05.000Z");
    store.updateUserProfile({ displayName: "Mobile User" }, "2026-07-31T02:00:06.000Z");

    const changes = store.listRemoteProjectionOutbox({
      workspaceId: DEFAULT_WORKSPACE_ID,
      afterActivitySeq: start,
      limit: 1_000,
    });
    assert.ok(changes.some((item) => item.entityType === "channel" && item.entityId === channel.id));
    assert.ok(changes.some((item) => item.entityType === "channel_message" && item.entityId === channelMessage.id && item.affectsUnread));
    assert.ok(changes.some((item) => item.entityType === "teammate_direct_thread" && item.entityId === direct.id));
    assert.ok(changes.some((item) => item.entityType === "teammate_direct_message" && item.entityId === directMessage.id && item.affectsUnread));
    assert.ok(changes.some((item) => item.entityType === "ling_thread" && item.entityId === conversation.id));
    assert.ok(changes.some((item) => item.entityType === "ling_turn" && item.entityId === turn.id));
    assert.ok(changes.some((item) => item.entityType === "user_profile" && item.conversationId === undefined));
    assert.equal(changes.some((item) => Object.hasOwn(item, "body")), false);

    const pending = store.listRemoteProjectionOutbox({ afterActivitySeq: start, unprocessedOnly: true, limit: 1_000 });
    assert.equal(store.markRemoteProjectionOutboxProcessed(pending.map((item) => item.activitySeq), "2026-07-31T02:01:00.000Z"), pending.length);
    assert.equal(store.listRemoteProjectionOutbox({ afterActivitySeq: start, unprocessedOnly: true, limit: 1_000 }).length, 0);
    assert.ok(store.listRemoteProjectionOutbox({ afterActivitySeq: start, limit: 1_000 }).every((item) => item.processedAt));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
