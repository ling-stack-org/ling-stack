import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialRemoteClientState,
  reduceRemoteClientState,
} from "../dist/index.js";

const now = "2026-07-31T10:00:00.000Z";
const workspace = { workspaceId: "default", workspaceBindingId: "binding_1", displayName: "Ling PC", policyVersion: 1 };
const summary = {
  workspaceId: "default",
  conversationId: "channel_1",
  kind: "channel",
  title: "Design",
  identity: { kind: "channel", label: "Design" },
  status: "active",
  activitySeq: 1,
  unreadCount: 1,
  mentioned: false,
  updatedAt: now,
};
const message = {
  messageId: "message_1",
  workspaceId: "default",
  conversationId: "channel_1",
  role: "assistant",
  authorLabel: "Ling",
  body: "First",
  status: "ready",
  revision: 1,
  activitySeq: 1,
  createdAt: now,
  updatedAt: now,
};

test("conversation projections merge revisions, read state, and older pages deterministically", () => {
  let state = createInitialRemoteClientState();
  state = reduceRemoteClientState(state, {
    type: "conversation_list",
    snapshot: { workspaceId: "default", workspaceBindingId: "binding_1", conversations: [summary], generatedAt: now },
  });
  state = reduceRemoteClientState(state, {
    type: "conversation_snapshot",
    appendOlder: false,
    snapshot: {
      snapshotId: "snapshot_1",
      barrierSeq: 1,
      workspace,
      conversation: summary,
      readState: { workspaceId: "default", conversationId: "channel_1", readThroughActivitySeq: 0, unreadCount: 1, mentioned: false, updatedAt: now },
      messages: [message],
      hasMoreOlder: true,
      olderPageCursor: "message_1",
      generatedAt: now,
    },
  });
  state = reduceRemoteClientState(state, {
    type: "conversation_delta",
    delta: { operation: "message_upsert", workspaceId: "default", conversationId: "channel_1", message: { ...message, body: "Edited", revision: 2, activitySeq: 2 } },
  });
  state = reduceRemoteClientState(state, {
    type: "conversation_delta",
    delta: {
      operation: "read_state",
      readState: { workspaceId: "default", conversationId: "channel_1", readThroughActivitySeq: 2, unreadCount: 0, mentioned: false, updatedAt: now },
    },
  });

  assert.equal(state.details.channel_1.messages.length, 1);
  assert.equal(state.details.channel_1.messages[0].body, "Edited");
  assert.equal(state.details.channel_1.barrierSeq, 2);
  assert.equal(state.conversations.channel_1.unreadCount, 0);
});

test("failed sends remain retryable with the original command identity", () => {
  let state = createInitialRemoteClientState();
  state = reduceRemoteClientState(state, {
    type: "send_started",
    send: { commandId: "send_1", conversationId: "channel_1", body: "Retry me", issuedAt: now, retryUntil: "2026-08-01T10:00:00.000Z", status: "sending" },
  });
  state = reduceRemoteClientState(state, {
    type: "send_failed",
    commandId: "send_1",
    error: { code: "pc_unavailable", message: "offline", retryable: true },
  });
  assert.deepEqual(state.pendingSends.send_1, {
    commandId: "send_1",
    conversationId: "channel_1",
    body: "Retry me",
    issuedAt: now,
    retryUntil: "2026-08-01T10:00:00.000Z",
    status: "failed",
    error: { code: "pc_unavailable", message: "offline", retryable: true },
  });
});
