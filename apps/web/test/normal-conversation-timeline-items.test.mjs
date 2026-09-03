import assert from "node:assert/strict";
import test from "node:test";
import {
  flattenNormalTimelineItems,
  maxTimelineRevision,
  selectNormalTimelineItems,
} from "../src/features/workspace/normal-conversation-timeline-items.ts";

function messageItem(kind, id, itemId, turnId, runId, partIndex = 0, threadSequence = 0) {
  return {
    id,
    kind,
    revision: 1,
    threadSequence,
    partIndex,
    itemId,
    turnId,
    runId,
    sourceRefs: [],
    markdown: id,
  };
}

function factItem(id, turnId, runId, threadSequence, partIndex = 1) {
  return {
    id,
    kind: "exploration",
    revision: 2,
    threadSequence,
    partIndex,
    turnId,
    runId,
    actionId: `action:${id}`,
    attemptId: `attempt:${runId}`,
    participantId: "ling-agent",
    workflowStepId: null,
    sourceRefs: [],
    title: id,
    operation: "read",
    targets: [],
  };
}

function feedMessage(id, role, turnId, runId, timelineItems) {
  return {
    message: { id, role, turnId, runId },
    timelineItems,
  };
}

test("normal timeline restores assistant narration after the facts for its turn", () => {
  const user1 = messageItem("userMessage", "message:user:user-1", "user-1", "turn-1", undefined, 0, 1);
  const fact1 = factItem("fact:run-1", "turn-1", "run-1", 1);
  const user2 = messageItem("userMessage", "message:user:user-2", "user-2", "turn-2", undefined, 0, 2);
  const assistant1 = messageItem("agentMessage", "message:agent:assistant-1", "assistant-1", "turn-1", "run-1");
  const assistant2 = messageItem("agentMessage", "message:agent:assistant-2", "assistant-2", "turn-2", "run-2");
  const feedItems = [
    feedMessage("user-1", "user", "turn-1", undefined, [user1]),
    feedMessage("assistant-1", "assistant", "turn-1", "run-1", [assistant1]),
    feedMessage("user-2", "user", "turn-2", undefined, [user2]),
    feedMessage("assistant-2", "assistant", "turn-2", "run-2", [assistant2]),
  ];

  const selected = selectNormalTimelineItems([user1, fact1, user2], feedItems);

  assert.deepEqual(selected.map((item) => item.id), [
    user1.id,
    fact1.id,
    assistant1.id,
    user2.id,
    assistant2.id,
  ]);
  assert.equal(selected.find((item) => item.id === assistant1.id)?.threadSequence, 1);
  assert.equal(selected.find((item) => item.id === assistant1.id)?.partIndex, 2);
});

test("normal timeline does not duplicate a canonical message and keeps fallback order", () => {
  const canonicalUser = messageItem("userMessage", "message:user:user-1", "user-1", "turn-1");
  const fallbackUser = messageItem("userMessage", "message:user:user-1", "user-1", "turn-1");
  const fallbackAssistant = messageItem("agentMessage", "message:agent:assistant-1", "assistant-1", "turn-1", "run-1");
  const selected = selectNormalTimelineItems(
    [canonicalUser],
    [
      feedMessage("user-1", "user", "turn-1", undefined, [fallbackUser]),
      feedMessage("assistant-1", "assistant", "turn-1", "run-1", [fallbackAssistant]),
    ],
  );

  assert.deepEqual(selected.map((item) => item.id), [canonicalUser.id, fallbackAssistant.id]);
  assert.equal(new Set(selected.map((item) => item.id)).size, selected.length);
});

test("normal timeline fallback flattening rebases duplicate local positions", () => {
  const first = messageItem("userMessage", "message:first", "first", "turn-1");
  const second = messageItem("agentMessage", "message:second", "second", "turn-1");
  const flattened = flattenNormalTimelineItems([
    feedMessage("first", "user", "turn-1", undefined, [first]),
    feedMessage("second", "assistant", "turn-1", "run-1", [second]),
  ]);

  assert.deepEqual(flattened.map((item) => [item.id, item.threadSequence, item.partIndex]), [
    [first.id, 0, 0],
    [second.id, 1, 0],
  ]);
  assert.equal(maxTimelineRevision(flattened), 1);
});
