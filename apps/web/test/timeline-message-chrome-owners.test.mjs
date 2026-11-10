import assert from "node:assert/strict";
import test from "node:test";
import { timelineMessageChromeOwnerIds } from "../src/shared/conversation/timeline/timeline-message-chrome-owners.ts";

function message(id, overrides = {}) {
  return Object.freeze({
    id,
    kind: "agentMessage",
    itemId: "message_1",
    runId: "run_1",
    turnId: "turn_1",
    attemptId: "attempt_1",
    participantId: "agent_1",
    workflowStepId: null,
    revision: 1,
    threadSequence: 1,
    partIndex: 0,
    markdown: "Narration",
    sourceRefs: [],
    ...overrides,
  });
}

test("only the last narration segment owns logical message chrome across intervening facts", () => {
  const items = Object.freeze([
    message("user", { kind: "userMessage", itemId: "user_1" }),
    message("first", { phase: "final" }),
    { id: "command", kind: "commandExecution", itemId: "message_1" },
    message("second"),
    message("last", { phase: "commentary", markdown: "" }),
  ]);
  assert.deepEqual([...timelineMessageChromeOwnerIds(items)], ["user", "last"]);
  assert.equal(items[1].id, "first");
  assert.equal(items[4].markdown, "");
});

test("distinct messages and unanchored optimistic rows retain their own chrome", () => {
  const items = [
    message("one"),
    message("two", { itemId: "message_2" }),
    message("optimistic_1", { itemId: undefined }),
    message("optimistic_2", { itemId: undefined }),
  ];
  assert.deepEqual([...timelineMessageChromeOwnerIds(items)], items.map((item) => item.id));
});

test("owner selection never crosses role, run, attempt, participant, turn, or step", () => {
  for (const override of [
    { kind: "userMessage" },
    { runId: "run_2" },
    { attemptId: "attempt_2" },
    { participantId: "agent_2" },
    { turnId: "turn_2" },
    { workflowStepId: "step_2" },
  ]) {
    assert.deepEqual([...timelineMessageChromeOwnerIds([
      message("first"), message("other", override), message("last"),
    ])], ["last", "other"]);
  }
});

test("owner is recomputed from the current scoped snapshot, not retained across refreshes", () => {
  const first = message("first");
  const last = message("last");
  assert.deepEqual([...timelineMessageChromeOwnerIds([first])], ["first"]);
  assert.deepEqual([...timelineMessageChromeOwnerIds([first, last])], ["last"]);
  assert.deepEqual([...timelineMessageChromeOwnerIds([])], []);
});
