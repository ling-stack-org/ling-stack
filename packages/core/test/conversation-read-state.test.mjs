import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createBuiltinAiTeammateId,
  createSqliteRunStore,
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

    const reply = store.createChannelMessage({
      channelId: channel.id,
      authorType: "ai-teammate",
      authorId: createBuiltinAiTeammateId("engineer"),
      body: "Please review this.",
      mentions: [{ id: "local-user", label: "You", kind: "local-user" }],
    }, "2026-07-31T03:00:01.000Z");
    const unread = store.getConversationReadState(readKey, "2026-07-31T03:00:01.000Z");
    assert.equal(unread.unreadCount, 1);
    assert.equal(unread.mentioned, true);

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

    store.updateChannelMessageRuntime(reply.id, { body: "Please review the edited answer." }, "2026-07-31T03:00:04.000Z");
    const editedUnread = store.getConversationReadState(readKey, "2026-07-31T03:00:04.000Z");
    assert.equal(editedUnread.unreadCount, 1);
    assert.ok(editedUnread.activitySeq > editedUnread.readThroughActivitySeq);
    assert.equal(editedUnread.mentioned, true);

    const capped = store.markConversationRead({
      ...readKey,
      throughActivitySeq: Number.MAX_SAFE_INTEGER,
    }, "2026-07-31T03:00:05.000Z");
    assert.equal(capped.readThroughActivitySeq, editedUnread.activitySeq);
    assert.equal(capped.unreadCount, 0);

    store.createChannelMessage({
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
