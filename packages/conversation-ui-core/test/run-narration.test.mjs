import assert from "node:assert/strict";
import test from "node:test";
import { mergeConversationRunNarration, projectConversationRunNarration, projectDisplayBatches } from "../dist/index.js";

function message(id, runId, threadSequence = 1) {
  return { id, itemId: id, kind: "agentMessage", runId, turnId: "turn-1", revision: 1, threadSequence, partIndex: 0, markdown: "aggregate", phase: "final", sourceRefs: [{ kind: "conversation_item", id }] };
}

function segment(sequence, content, end = sequence + 1) {
  return { content, firstEventId: `event-${sequence}`, lastEventId: `event-${end}`, startEventSequence: sequence, endEventSequence: end, completed: true };
}

function action(id, runId, sequence, partIndex, threadSequence = 1) {
  return {
    id, kind: "exploration", actionId: id, runId, turnId: "turn-1", attemptId: `attempt-${runId}`,
    participantId: "ling", workflowStepId: null, status: "succeeded", revision: sequence + 20,
    threadSequence, partIndex, sourceEventSequence: sequence, title: `Read ${id}`,
    operation: "read", targets: [{ kind: "file", id: `${id}.ts` }], sourceRefs: [{ kind: "conversation_item", id: "user-1" }],
  };
}

const user = { ...message("user-1", undefined), kind: "userMessage", markdown: "Inspect" };

test("run narration preserves stable identity and real anchor refs across streaming revisions", () => {
  const input = { message: message("assistant-1", "run-1"), runId: "run-1", anchor: user };
  const first = projectConversationRunNarration({ ...input, segments: [segment(5, "First")] })[0];
  const refreshed = projectConversationRunNarration({ ...input, segments: [segment(5, "First\n\nmore.", 18)] })[0];
  assert.equal(first.id, refreshed.id);
  assert.equal(refreshed.itemId, "assistant-1");
  assert.equal(refreshed.revision, 18);
  assert.equal(refreshed.markdown, "First\n\nmore.");
  assert.deepEqual(refreshed.sourceRefs, [
    { kind: "conversation_item", id: "user-1" }, { kind: "run", id: "run-1" },
    { kind: "run_event", id: "event-5" }, { kind: "run_event", id: "event-18" },
  ]);
});

test("run narration uses only its own event order and keeps other runs in place", () => {
  const actions = [action("a-first", "run-a", 49, 1), action("a-second", "run-a", 99, 2), action("b-first", "run-b", 1, 3)];
  const narration = projectConversationRunNarration({
    message: message("assistant-a", "run-a"), runId: "run-a", anchor: user,
    segments: [segment(5, "Before A"), segment(57, "Between A"), segment(101, "After A")],
  });
  const merged = mergeConversationRunNarration([user, ...actions], narration);
  assert.deepEqual(merged.map((item) => item.markdown ?? item.id), ["Inspect", "Before A", "a-first", "Between A", "a-second", "After A", "b-first"]);
  assert.deepEqual(merged.map((item) => item.partIndex), [0, 1, 2, 3, 4, 5, 6]);
});

test("run narration interleaves facts on distinct canonical tool anchors", () => {
  const actions = [action("read", "run-a", 49, 1, 2), action("write", "run-a", 99, 1, 3)];
  const narration = projectConversationRunNarration({
    message: message("assistant-a", "run-a"), runId: "run-a", anchor: user,
    segments: [segment(5, "Before read"), segment(57, "Before write")],
  });
  const merged = mergeConversationRunNarration([user, ...actions], narration);
  assert.deepEqual(merged.map((item) => item.markdown ?? item.id), ["Inspect", "Before read", "read", "Before write", "write"]);
  assert.deepEqual(merged.map((item) => [item.threadSequence, item.partIndex]), [[1, 0], [2, 0], [2, 1], [3, 0], [3, 1]]);
});

test("run narration restores immutable event order when a legacy adapter emits dense actions out of order", () => {
  const actions = [action("late", "run-a", 7, 0), action("early", "run-a", 3, 1)];
  const narration = projectConversationRunNarration({
    message: message("assistant-a", "run-a"), runId: "run-a", anchor: user,
    segments: [segment(1, "Before actions"), segment(5, "Between actions")],
  });
  const merged = mergeConversationRunNarration(actions, narration);
  assert.deepEqual(merged.map((item) => item.markdown ?? item.id), ["Before actions", "early", "Between actions", "late"]);
  assert.deepEqual(merged.map((item) => item.partIndex), [0, 1, 2, 3]);
});

test("narration insertion preserves contiguous action batching despite gaps between start events", () => {
  const actions = [action("read-a", "run-a", 49, 1), action("read-b", "run-a", 61, 2), action("read-c", "run-a", 78, 3)];
  const narration = projectConversationRunNarration({
    message: message("assistant-a", "run-a"), runId: "run-a", anchor: user,
    segments: [segment(5, "Before reads"), segment(101, "After reads")],
  });
  const merged = mergeConversationRunNarration([user, ...actions], narration);
  const batched = projectDisplayBatches(merged, { contextSegmentIdByItemId: new Map(merged.map((item) => [item.id, "segment-1"])) });
  assert.deepEqual(batched.items.map((item) => item.kind), ["userMessage", "agentMessage", "explorationBatch", "agentMessage"]);
});
