import assert from "node:assert/strict";
test("canonical publication replaces the same logical fallback instead of hiding or duplicating it", () => {
  const user = messageItem("userMessage", "message:user:user", "user", "turn", undefined, 0, 1);
  const canonical = messageItem("agentMessage", "message:agent:reply:event:e2", "narration:run", "turn", "run", 1, 1);
  const fallback = messageItem("agentMessage", "message:agent:reply", "reply", "turn", "run");
  const feed = feedMessage("reply", "assistant", "turn", "run", [fallback]);
  feed.message.canonicalItemId = "narration:run";
  const rows = selectNormalTimelineItems([user, canonical], [feedMessage("user", "user", "turn", undefined, [user]), feed]);
  assert.deepEqual(rows.map(item => item.id), [user.id, canonical.id]);
});
import test from "node:test";
test("published logical identity also deduplicates an older SSE DTO with no canonicalItemId", () => {
  const canonical = messageItem("agentMessage", "message:agent:reply:event:e2", "narration:run", "turn", "run", 0, 1);
  canonical.logicalMessageId = "reply";
  const stale = { ...canonical, id: "message:agent:reply:event:old", itemId: "narration:old", runId: "old-run" };
  const fallback = messageItem("agentMessage", "message:agent:reply", "reply", "turn", "run");
  const feed = feedMessage("reply", "assistant", "turn", "run", [fallback]);
  assert.deepEqual(selectNormalTimelineItems([stale, canonical], [feed]).map(item => item.id), [canonical.id]);
});
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

test("normal timeline keeps the assistant final before its factual result cards", () => {
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
    assistant1.id,
    fact1.id,
    user2.id,
    assistant2.id,
  ]);
  assert.equal(selected.find((item) => item.id === assistant1.id)?.threadSequence, 1);
  assert.equal(selected.find((item) => item.id === assistant1.id)?.partIndex, 1);
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

test("normal timeline interleaves durable narration segments before their tool actions", () => {
  const user = messageItem("userMessage", "message:user:user-1", "user-1", "turn-1", undefined, 0, 8);
  const read = { ...factItem("read", "turn-1", "run-1", 8, 49), sourceEventSequence: 49 };
  const write = { ...factItem("write", "turn-1", "run-1", 8, 99), sourceEventSequence: 99 };
  const assistant = messageItem("agentMessage", "message:agent:assistant-1", "assistant-1", "turn-1", "run-1");
  const feedAssistant = feedMessage("assistant-1", "assistant", "turn-1", "run-1", [assistant]);
  feedAssistant.message.narrationSegments = [
    { content: "First narration.", firstEventId: "event-5", lastEventId: "event-48", startEventSequence: 5, endEventSequence: 48, completed: true },
    { content: "Second narration.", firstEventId: "event-57", lastEventId: "event-98", startEventSequence: 57, endEventSequence: 98, completed: true },
  ];
  const selected = selectNormalTimelineItems([user, write, read], [feedMessage("user-1", "user", "turn-1", undefined, [user]), feedAssistant]);
  assert.deepEqual(selected.map((item) => item.markdown ?? item.title), [user.markdown, "First narration.", "read", "Second narration.", "write"]);
  const narrated = selected.filter((item) => item.kind === "agentMessage");
  assert.deepEqual(narrated.map((item) => item.sourceEventSequence), [5, 57]);
  assert.deepEqual(selected.map((item) => item.partIndex), [0, 1, 2, 3, 4]);
  assert.ok(narrated.every((item) => item.sourceRefs.some((ref) => ref.kind === "conversation_item" && ref.id === "user-1")));
  assert.equal(narrated[0].sourceRefs.find((ref) => ref.kind === "run_event")?.id, "event-5");
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

test("normal live fallback interleaves narration before canonical refresh without inventing item refs", () => {
  const assistant = messageItem("agentMessage", "message:agent:assistant-1", "assistant-1", "turn-1", "run-1");
  const read = { ...factItem("read", "turn-1", "run-1", 0), sourceEventSequence: 49 };
  const feed = feedMessage("assistant-1", "assistant", "turn-1", "run-1", [read, assistant]);
  feed.message.narrationSegments = [
    { content: "Before tool.", firstEventId: "event-5", lastEventId: "event-48", startEventSequence: 5, endEventSequence: 48, completed: true },
    { content: "After tool.", firstEventId: "event-57", lastEventId: "event-58", startEventSequence: 57, endEventSequence: 58, completed: false },
  ];
  const live = flattenNormalTimelineItems([feed]);
  assert.deepEqual(live.map((item) => item.markdown ?? item.title), ["Before tool.", "read", "After tool."]);
  assert.ok(live.filter((item) => item.kind === "agentMessage").every((item) =>
    item.itemId === "assistant-1" && item.sourceRefs.every((ref) => ref.kind !== "conversation_item"),
  ));
  const user = messageItem("userMessage", "message:user:user-1", "user-1", "turn-1", undefined, 0, 8);
  const refreshed = selectNormalTimelineItems([user, { ...read, threadSequence: 8 }], [
    feedMessage("user-1", "user", "turn-1", undefined, [user]), feed,
  ]);
  assert.deepEqual(refreshed.filter((item) => item.kind === "agentMessage").map((item) => item.id),
    live.filter((item) => item.kind === "agentMessage").map((item) => item.id));
});

test("normal partial canonical snapshot still splits narration for an unanchored optimistic turn", () => {
  const user = messageItem("userMessage", "user-previous", "user-previous", "turn-previous");
  const assistant = messageItem("agentMessage", "assistant-new", "assistant-new", "turn-new", "run-new");
  const feed = feedMessage("assistant-new", "assistant", "turn-new", "run-new", [assistant]);
  feed.message.narrationSegments = [
    { content: "First message.", firstEventId: "new-1", lastEventId: "new-2", startEventSequence: 1, endEventSequence: 2, completed: true },
    { content: "Second message.", firstEventId: "new-3", lastEventId: "new-4", startEventSequence: 3, endEventSequence: 4, completed: false },
  ];
  const selected = selectNormalTimelineItems([user], [feedMessage(user.itemId, "user", user.turnId, undefined, [user]), feed]);
  assert.deepEqual(selected.map((item) => item.markdown), [user.markdown, "First message.", "Second message."]);
  assert.equal(selected[1].sourceRefs.some((ref) => ref.kind === "conversation_item"), false);
});
