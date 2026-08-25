import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeConversationItems,
  projectChannelConversationItemPage,
  projectChannelConversationTurn,
} from "../src/lib/channel-conversation-items.ts";

const thread = {
  id: "thread-1",
  workspaceId: "workspace_default",
  kind: "channel_discussion",
  status: "open",
  title: "Channel",
  objective: "Conversation",
  channelId: "channel-1",
  surfaceKind: "channel_root",
  relationKind: "root",
  nextItemSequence: 3,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:01:00.000Z",
};

const turn = {
  id: "turn-1",
  workspaceId: "workspace_default",
  threadId: thread.id,
  kind: "initial_request",
  status: "succeeded",
  title: "Request",
  userInstruction: "Write the answer",
  channelId: "channel-1",
  sourceItemId: "item-user",
  createdByActor: "local-user",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:01:00.000Z",
};

const userItem = {
  schemaVersion: 1,
  id: "item-user",
  workspaceId: "workspace_default",
  channelId: "channel-1",
  threadId: thread.id,
  turnId: turn.id,
  sequence: 1,
  kind: "user_message",
  status: "committed",
  actorType: "local_user",
  visibility: "channel",
  payload: {
    body: "Write the answer",
    format: "plain_text",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
  },
  domainRefs: [],
  revision: 1,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
  committedAt: "2026-08-10T00:00:00.000Z",
};

const assistantItem = {
  schemaVersion: 1,
  id: "item-assistant",
  workspaceId: "workspace_default",
  channelId: "channel-1",
  threadId: thread.id,
  turnId: turn.id,
  sequence: 2,
  kind: "assistant_message",
  status: "committed",
  actorType: "ling_agent",
  actorId: "ling-agent",
  visibility: "channel",
  payload: {
    body: "Here is the answer.",
    format: "markdown",
    streaming: false,
    deliveryStatus: "ready",
  },
  domainRefs: [
    { type: "conversation_item", id: userItem.id },
    { type: "run", id: "run-1" },
  ],
  revision: 2,
  createdAt: "2026-08-10T00:00:01.000Z",
  updatedAt: "2026-08-10T00:00:02.000Z",
  committedAt: "2026-08-10T00:00:02.000Z",
};

test("channel Web domain projects canonical items and discardable decorations", () => {
  const page = projectChannelConversationItemPage({
    cwd: "/repo",
    channelId: "channel-1",
    thread,
    turns: [turn],
    items: [userItem, assistantItem],
    decorations: [{
      itemId: assistantItem.id,
      linkedRunId: "run-1",
      editedAt: "2026-08-10T00:00:03.000Z",
      webEvidence: {
        status: "available",
        sources: [{ url: "https://example.com" }],
        readUrls: [],
        updatedAt: "2026-08-10T00:00:03.000Z",
      },
    }],
    hasMore: true,
    nextBeforeSequence: 1,
  });
  assert.deepEqual(page.messages.map((message) => [message.id, message.kind]), [
    ["item-user", "message"],
    ["item-assistant", "ai_reply"],
  ]);
  assert.deepEqual(page.conversationItems.map((item) => item.id), ["item-user", "item-assistant"]);
  assert.equal(page.messages[0].threadId, thread.id);
  assert.equal(page.messages[0].turnId, turn.id);
  assert.equal(page.messages[0].threadSurfaceKind, "channel_root");
  assert.equal(page.messages[0].threadRelationKind, "root");
  assert.equal(page.messages[1].linkedRunId, "run-1");
  assert.equal(page.messages[1].editedAt, "2026-08-10T00:00:03.000Z");
  assert.equal(page.messages[1].webEvidence.sources[0].url, "https://example.com");
  assert.equal(page.nextBeforeSequence, 1);
});

test("channel stream projection derives presentation messages from turn items", () => {
  const projected = projectChannelConversationTurn({
    thread,
    turn,
    userItem,
    assistantItems: [assistantItem],
    decorations: [{ itemId: assistantItem.id, linkedRunId: "run-1" }],
  });
  assert.equal(projected.message.id, userItem.id);
  assert.equal(projected.aiReply.id, assistantItem.id);
  assert.deepEqual(projected.aiReplies.map((message) => message.id), [assistantItem.id]);
  assert.deepEqual(projected.conversationItems.map((item) => item.id), [userItem.id, assistantItem.id]);
});

test("canonical item merge orders by sequence, rejects stale revisions, and keeps transient refs", () => {
  const current = {
    ...assistantItem,
    revision: 2,
    domainRefs: [{ type: "run", id: "run-1" }],
  };
  const stale = {
    ...assistantItem,
    revision: 1,
    payload: { ...assistantItem.payload, body: "stale" },
  };
  const merged = mergeConversationItems([current], [stale, userItem]);
  assert.deepEqual(merged.map((item) => item.id), [userItem.id, assistantItem.id]);
  assert.equal(merged[1].payload.body, assistantItem.payload.body);
  assert.deepEqual(merged[1].domainRefs, [{ type: "run", id: "run-1" }]);
});
