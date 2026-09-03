import assert from "node:assert/strict";
import test from "node:test";
import {
  projectChannelItemDelta,
  projectChannelItemRunLinked,
  projectChannelItemsReady,
  projectChannelItemsTerminal,
  projectChannelStreamReady,
  projectChannelStreamTerminal,
} from "../src/app/channel-message-stream-projection.ts";

const sourceMessage = message("message_guidance", "message", "local-user");
const existingMessage = message("message_existing", "message", "local-user");

test("bare channel stream acceptance stays optimistic until dispatch is known", () => {
  assert.deepEqual(projectChannelStreamReady([existingMessage], { message: sourceMessage }), [existingMessage]);
});

test("queued channel guidance is removed from the transcript projection", () => {
  const projected = projectChannelStreamTerminal([existingMessage, sourceMessage], {
    message: sourceMessage,
    replyDispatch: {
      targetTeammateId: "teammate_designer",
      disposition: "followup_queued",
      sourceRunId: "run_active",
    },
  });
  assert.deepEqual(projected, [existingMessage]);
});

test("a normal reply commits the source message and reply together", () => {
  const reply = message("message_reply", "ai_reply", "ai-teammate");
  assert.deepEqual(projectChannelStreamTerminal([existingMessage], {
    message: sourceMessage,
    aiReply: reply,
  }), [existingMessage, sourceMessage, reply]);
});

const assistantItem = {
  schemaVersion: 1,
  id: "assistant-1",
  workspaceId: "workspace-1",
  channelId: "channel-1",
  threadId: "thread-1",
  turnId: "turn-1",
  sequence: 2,
  kind: "assistant_message",
  status: "committed",
  actorType: "ling_agent",
  actorId: "ling-agent",
  visibility: "channel",
  payload: { body: "start", format: "markdown", streaming: true, deliveryStatus: "pending" },
  domainRefs: [],
  revision: 1,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

const userItem = {
  schemaVersion: 1,
  id: "user-1",
  workspaceId: "workspace-1",
  channelId: "channel-1",
  threadId: "thread-1",
  turnId: "turn-1",
  sequence: 1,
  kind: "user_message",
  status: "committed",
  actorType: "local_user",
  visibility: "channel",
  payload: { body: "hello", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  domainRefs: [],
  revision: 1,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

test("stream item projection updates body and run linkage without inventing canonical metadata", () => {
  const delta = projectChannelItemDelta([assistantItem], assistantItem.id, "streamed");
  assert.equal(delta[0].payload.body, "streamed");
  assert.equal(delta[0].payload.streaming, true);
  assert.equal(delta[0].revision, assistantItem.revision);
  assert.equal(delta[0].updatedAt, assistantItem.updatedAt);
  const linked = projectChannelItemRunLinked(delta, assistantItem.id, "run-1");
  assert.deepEqual(linked[0].domainRefs, [{ type: "run", id: "run-1" }]);
  assert.equal(linked[0].revision, assistantItem.revision);
  assert.equal(linked[0].updatedAt, assistantItem.updatedAt);
});

test("stream item delta updates user messages but leaves structured and unknown items unchanged", () => {
  const toolCall = { ...assistantItem, id: "tool-1", kind: "tool_call", payload: { toolName: "read_file" } };
  const current = [userItem, toolCall];
  const userDelta = projectChannelItemDelta(current, userItem.id, "edited");
  assert.equal(userDelta[0].payload.body, "edited");
  assert.equal(userDelta[1], toolCall);
  assert.deepEqual(projectChannelItemDelta(current, "missing", "ignored"), current);
  assert.deepEqual(projectChannelItemDelta(current, toolCall.id, "ignored"), current);
});

test("run linkage is additive and idempotent", () => {
  const linked = projectChannelItemRunLinked([assistantItem], assistantItem.id, "run-1");
  assert.deepEqual(projectChannelItemRunLinked(linked, assistantItem.id, "run-1"), linked);
  assert.deepEqual(projectChannelItemRunLinked(linked, "missing", "run-2"), linked);
});

test("ready and terminal item projections handle empty, stale, and queued payloads", () => {
  assert.deepEqual(projectChannelItemsReady([assistantItem], { message: { id: "m" } }), [assistantItem]);
  const ready = projectChannelItemsReady([], { message: { id: "m" }, conversationItems: [assistantItem] });
  assert.deepEqual(ready.map((item) => item.id), [assistantItem.id]);
  const stale = projectChannelItemsTerminal(ready, {
    conversationItems: [{ ...assistantItem, revision: 0, payload: { ...assistantItem.payload, body: "stale" } }],
  });
  assert.equal(stale[0].payload.body, assistantItem.payload.body);
  assert.deepEqual(projectChannelItemsTerminal(stale, {}), stale);
  assert.deepEqual(projectChannelItemsTerminal([userItem], {
    message: { id: userItem.id },
    conversationItems: [userItem, assistantItem],
    replyDispatch: { disposition: "followup_queued" },
  }).map((item) => item.id), [assistantItem.id]);
});

test("authoritative item upsert ignores lower revisions and preserves transient run linkage", () => {
  const linked = projectChannelItemRunLinked([assistantItem], assistantItem.id, "run-1");
  const projected = projectChannelItemsTerminal(linked, {
    conversationItems: [{ ...assistantItem, payload: { ...assistantItem.payload, body: "older" }, revision: 0 }],
  });
  assert.equal(projected[0].payload.body, "start");
  assert.deepEqual(projected[0].domainRefs, [{ type: "run", id: "run-1" }]);
});

test("queued follow-up removes the source item instead of re-adding it from terminal payload", () => {
  const projected = projectChannelItemsTerminal(
    [userItem],
    {
      message: { id: userItem.id },
      conversationItems: [userItem, assistantItem],
      replyDispatch: { disposition: "followup_queued" },
    },
  );
  assert.deepEqual(projected.map((item) => item.id), [assistantItem.id]);
});

function message(id, kind, authorType) {
  return {
    id,
    workspaceId: "workspace_default",
    channelId: "channel_main",
    kind,
    intent: "discuss",
    authorType,
    body: id,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}
