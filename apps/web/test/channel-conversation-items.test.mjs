import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommittedContextSegmentLookup,
  channelNarrationItemIds,
  mergeChannelUserInputPage,
  mergeConversationItems,
  mergeTurnContextAssignments,
  projectUncoveredChannelConversationItems,
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

const committedAssignment = {
  id: "assignment-1",
  turnId: turn.id,
  segmentId: "segment-1",
  status: "committed",
  revision: 2,
  decisionSource: "structural",
  evidenceRefs: [{ type: "conversation_item", id: userItem.id }],
  policyVersion: "test-v1",
  createdAt: "2026-08-10T00:00:00.000Z",
};

test("channel narration uses canonical role within the exact surface scope, never prose", () => {
  const narration = { ...assistantItem, payload: { ...assistantItem.payload, presentationRole: "narration" } };
  const items = [
    narration,
    { ...narration, id: "other-workspace", workspaceId: "other" },
    { ...narration, id: "other-channel", channelId: "other" },
    { ...narration, id: "other-thread", threadId: "other" },
    { ...assistantItem, id: "final", payload: { ...assistantItem.payload, body: "Run started: Engineer", presentationRole: "reply_result" } },
    userItem,
  ];
  assert.deepEqual([...channelNarrationItemIds(items, {
    workspaceId: thread.workspaceId, channelId: thread.channelId, threadId: thread.id,
  })], [narration.id]);
  assert.equal(channelNarrationItemIds(items, { channelId: thread.channelId, threadId: thread.id }).size, 0);
});

test("channel Web domain projects canonical items and discardable decorations", () => {
  const page = projectChannelConversationItemPage({
    cwd: "/repo",
    channelId: "channel-1",
    thread,
    turns: [turn],
    items: [userItem, assistantItem],
    turnContextAssignments: [committedAssignment],
    userInputs: [],
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
  assert.deepEqual(page.turnContextAssignments, [committedAssignment]);
  assert.equal(page.messages[0].threadId, thread.id);
  assert.equal(page.messages[0].turnId, turn.id);
  assert.equal(page.messages[0].threadSurfaceKind, "channel_root");
  assert.equal(page.messages[0].threadRelationKind, "root");
  assert.equal(page.messages[1].linkedRunId, "run-1");
  assert.equal(page.messages[1].editedAt, "2026-08-10T00:00:03.000Z");
  assert.equal(page.messages[1].webEvidence.sources[0].url, "https://example.com");
  assert.equal(page.nextBeforeSequence, 1);
});

test("channel context assignment merge rejects late revisions and batching uses only committed context", () => {
  const newer = { ...committedAssignment, id: "assignment-new", segmentId: "segment-new", revision: 3 };
  const stale = { ...committedAssignment, id: "assignment-stale", segmentId: "segment-stale", revision: 2 };
  assert.deepEqual(mergeTurnContextAssignments([newer], [stale]), [newer]);

  const incoming = projectChannelConversationItemPage({
    cwd: "/repo", channelId: "channel-1", thread, turns: [turn], items: [userItem, assistantItem],
    turnContextAssignments: [stale], userInputs: [], decorations: [], generatedMedia: [], hasMore: false,
  });
  const current = { ...incoming, turnContextAssignments: [newer] };
  assert.deepEqual(mergeChannelUserInputPage(current, incoming).turnContextAssignments, [newer]);

  assert.deepEqual(
    [...buildCommittedContextSegmentLookup([userItem, assistantItem], [newer])],
    [[userItem.id, "segment-new"], [assistantItem.id, "segment-new"]],
  );
  assert.equal(buildCommittedContextSegmentLookup(
    [userItem, assistantItem],
    [{ ...newer, status: "provisional", revision: 4 }],
  ).size, 0);
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

test("uncovered channel fact envelopes fail closed instead of becoming tool evidence", () => {
  const toolCall = {
    ...userItem,
    id: "item-tool-call",
    sequence: 2,
    kind: "tool_call",
    actorType: "ling_agent",
    actorId: "ling-agent",
    payload: {
      toolCallId: "tool-1",
      toolName: "read_file",
      title: "Read workspace file",
      inputSummary: "README.md",
    },
  };
  const projected = projectUncoveredChannelConversationItems([toolCall], "channel_root");
  assert.equal(projected.length, 1);
  assert.equal(projected[0].kind, "diagnostic");
  assert.equal(projected[0].status, "blocked");
  assert.equal(projected[0].description, "No verified execution evidence is attached.");
  assert.deepEqual(projected[0].sourceRefs, [{ kind: "conversation_item", id: toolCall.id }]);
});
