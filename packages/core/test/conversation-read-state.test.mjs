import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "./channel-conversation-fixture.mjs";
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

test("daemon-owned read cursor is monotonic and later message revisions become unread", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-conversation-read-state-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Unread", boundPath: cwd }, "2026-07-31T03:00:00.000Z");
    const readKey = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: "local-user",
      conversationKind: "channel",
      conversationId: channel.id,
    };
    const initial = store.getConversationReadState(readKey, "2026-07-31T03:00:00.000Z");
    assert.equal(initial.unreadCount, 0);
    assert.equal(initial.mentioned, false);

    const reply = appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "ai-teammate",
      authorId: createBuiltinAiTeammateId("engineer"),
      body: "Please review this.",
      mentions: [{ id: "local-user", label: "You", kind: "local-user" }],
      status: "pending",
    }, "2026-07-31T03:00:01.000Z");
    const unread = store.getConversationReadState(readKey, "2026-07-31T03:00:01.000Z");
    assert.equal(unread.unreadCount, 1);
    assert.equal(unread.mentioned, false);

    const marked = store.markConversationRead({
      ...readKey,
      throughActivitySeq: unread.activitySeq,
    }, "2026-07-31T03:00:02.000Z");
    assert.equal(marked.readThroughActivitySeq, unread.activitySeq);
    assert.equal(marked.unreadCount, 0);
    assert.equal(marked.mentioned, false);

    const backwards = store.markConversationRead({
      ...readKey,
      throughActivitySeq: 0,
    }, "2026-07-31T03:00:03.000Z");
    assert.equal(backwards.readThroughActivitySeq, unread.activitySeq);

    updateChannelItemFixture(store, reply.id, {
      body: "Please review the completed answer.",
      status: "ready",
    }, "2026-07-31T03:00:04.000Z");
    const editedUnread = store.getConversationReadState(readKey, "2026-07-31T03:00:04.000Z");
    assert.equal(editedUnread.unreadCount, 1);
    assert.ok(editedUnread.activitySeq > editedUnread.readThroughActivitySeq);
    assert.equal(editedUnread.mentioned, false);

    const capped = store.markConversationRead({
      ...readKey,
      throughActivitySeq: Number.MAX_SAFE_INTEGER,
    }, "2026-07-31T03:00:05.000Z");
    assert.equal(capped.readThroughActivitySeq, editedUnread.activitySeq);
    assert.equal(capped.unreadCount, 0);

    appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "ai-teammate",
      authorId: createBuiltinAiTeammateId("designer"),
      body: "This arrived after mark-read committed.",
    }, "2026-07-31T03:00:06.000Z");
    const raced = store.getConversationReadState(readKey, "2026-07-31T03:00:06.000Z");
    assert.equal(raced.readThroughActivitySeq, editedUnread.activitySeq);
    assert.equal(raced.unreadCount, 1);
    assert.equal(raced.mentioned, false);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("direct-conversation unread state ignores the local user's own mobile send", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-direct-read-state-"));
  const store = createSqliteRunStore(cwd);
  try {
    const teammateId = createBuiltinAiTeammateId("designer");
    const direct = store.getOrCreateTeammateDirectThread(teammateId, "2026-07-31T04:00:00.000Z");
    const readKey = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: "local-user",
      conversationKind: "teammate_direct",
      conversationId: direct.id,
    };
    store.createTeammateDirectMessage({
      threadId: direct.id,
      teammateId,
      authorType: "local-user",
      authorId: "local-user",
      body: "My own message.",
    }, "2026-07-31T04:00:01.000Z");
    assert.equal(store.getConversationReadState(readKey, "2026-07-31T04:00:01.000Z").unreadCount, 0);

    store.createTeammateDirectMessage({
      threadId: direct.id,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "A teammate reply.",
    }, "2026-07-31T04:00:02.000Z");
    assert.equal(store.getConversationReadState(readKey, "2026-07-31T04:00:02.000Z").unreadCount, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("one normal-conversation reply counts as one unread entity across completion events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-normal-read-state-"));
  const store = createSqliteRunStore(cwd);
  try {
    const thread = store.createLingThread({
      kind: "conversation",
      teammateId: createBuiltinAiTeammateId("ling"),
      title: "Unread reply",
      objective: "Count one reply once",
    }, "2026-07-31T05:00:00.000Z");
    const run = store.createRun({
      id: "run_normal_unread_1",
      cwd,
      taskId: "task_normal_unread_1",
      providerName: "openai",
      providerModel: "gpt-test",
      taskSnapshot: { id: "task_normal_unread_1", title: "Reply", prompt: "Reply" },
      providerSnapshot: { provider: "openai", model: "gpt-test" },
      requestSnapshot: { cwd, task: { id: "task_normal_unread_1", title: "Reply", prompt: "Reply" } },
      threadId: thread.id,
      createdAt: "2026-07-31T05:00:01.000Z",
    });
    store.appendEvent(run.id, "message_end", { content: "The completed answer." });

    const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    try {
      const nextSeq = database.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?")
        .get(run.id).seq;
      database.prepare(`
        INSERT INTO run_events (id, run_id, seq, ts, type, data_json)
        VALUES (?, ?, ?, ?, 'result', '{}')
      `).run("event_normal_unread_result", run.id, nextSeq, "2026-07-31T05:00:03.000Z");
      assert.ok(database.prepare(`
        SELECT version FROM schema_migrations
        WHERE version = 109 AND name = 'deduplicate_remote_run_unread_entities'
      `).get());
    } finally {
      database.close();
    }

    const readState = store.getConversationReadState({
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: "local-user",
      conversationKind: "conversation",
      conversationId: thread.id,
    }, "2026-07-31T05:00:04.000Z");
    assert.equal(readState.unreadCount, 1);
    const completionRecords = store.listRemoteProjectionOutbox({
      workspaceId: DEFAULT_WORKSPACE_ID,
      conversationKind: "conversation",
      conversationId: thread.id,
      limit: 1_000,
    }).filter((record) => record.affectsUnread);
    assert.equal(completionRecords.length, 2);
    assert.ok(completionRecords.every((record) => record.entityType === "run_session" && record.entityId === run.id));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unread-entity migration repairs existing run-event projection rows", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-normal-read-migration-"));
  let store = createSqliteRunStore(cwd);
  try {
    const thread = store.createLingThread({
      kind: "conversation",
      title: "Legacy unread reply",
      objective: "Repair old projection identity",
    }, "2026-07-31T06:00:00.000Z");
    const run = store.createRun({
      id: "run_legacy_unread_1",
      cwd,
      taskId: "task_legacy_unread_1",
      providerName: "openai",
      providerModel: "gpt-test",
      taskSnapshot: { id: "task_legacy_unread_1", title: "Reply", prompt: "Reply" },
      providerSnapshot: { provider: "openai", model: "gpt-test" },
      requestSnapshot: { cwd, task: { id: "task_legacy_unread_1", title: "Reply", prompt: "Reply" } },
      threadId: thread.id,
      createdAt: "2026-07-31T06:00:01.000Z",
    });
    const messageEnd = store.appendEvent(run.id, "message_end", { content: "Legacy answer." });
    const resultEventId = "event_legacy_unread_result";
    const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    try {
      const nextSeq = database.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?")
        .get(run.id).seq;
      database.prepare(`
        INSERT INTO run_events (id, run_id, seq, ts, type, data_json)
        VALUES (?, ?, ?, ?, 'result', '{}')
      `).run(resultEventId, run.id, nextSeq, "2026-07-31T06:00:03.000Z");
      database.prepare("DELETE FROM remote_projection_outbox WHERE conversation_id = ?").run(thread.id);
      const insertLegacy = database.prepare(`
        INSERT INTO remote_projection_outbox (
          workspace_id, conversation_kind, conversation_id, entity_type, entity_id,
          operation, affects_unread, occurred_at
        ) VALUES (?, 'conversation', ?, 'run_event', ?, 'insert', 1, ?)
      `);
      insertLegacy.run(DEFAULT_WORKSPACE_ID, thread.id, messageEnd.id, messageEnd.ts);
      insertLegacy.run(DEFAULT_WORKSPACE_ID, thread.id, resultEventId, "2026-07-31T06:00:03.000Z");
      database.prepare("DELETE FROM schema_migrations WHERE version = 109").run();
    } finally {
      database.close();
    }

    store.close();
    store = createSqliteRunStore(cwd);
    const repaired = store.listRemoteProjectionOutbox({
      workspaceId: DEFAULT_WORKSPACE_ID,
      conversationKind: "conversation",
      conversationId: thread.id,
      limit: 1_000,
    });
    assert.equal(repaired.length, 2);
    assert.ok(repaired.every((record) => record.entityType === "run_session" && record.entityId === run.id));
    assert.equal(store.getConversationReadState({
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: "local-user",
      conversationKind: "conversation",
      conversationId: thread.id,
    }, "2026-07-31T06:00:04.000Z").unreadCount, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
