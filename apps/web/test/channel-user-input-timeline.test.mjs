import assert from "node:assert/strict";
import test from "node:test";
import { projectChannelUserInputTimeline } from "../src/lib/channel-user-input-timeline.ts";
function fixture(surface = "channel_root") {
  const source = { workspaceId: "workspace", threadId: surface === "branch" ? "branch" : "root", turnId: "turn",
    runId: "run", attemptId: "attempt", participantId: "ling_agent", workUnitId: "unit", sourceItemId: "before" };
  const base = { ...source, channelId: "channel", status: "committed", visibility: "channel", revision: 1,
    actorType: "ling_agent", actorId: source.participantId, domainRefs: [] };
  const runEventPosition = { runId: "run", attemptId: "attempt", afterEventSequence: 2, afterEventId: "event-2" };
  const question = { kind: "user_input_request", availability: "available", itemId: "question", requestId: "request", requestVersion: 1,
    source, runEventPosition, status: "answered", statusRevision: 2, waitMode: "optional", createdAt: "time", updatedAt: "time", questions: [] };
  const answer = { kind: "user_input_answer", availability: "available", itemId: "answer", requestId: "request", requestVersion: 1,
    source, runEventPosition, answerId: "accepted", acceptedAt: "time", answers: [{ questionId: "q", prompt: "Prompt", kind: "text", text: "PRIVATE BODY" }],
    delivery: { status: "pending", revision: 1, updatedAt: "time" } };
  const conversationItems = [{ ...base, id: "before", sequence: 1, kind: "user_message", payload: {} },
    ...[question, answer].map((record, index) => ({ ...base, id: record.itemId, sequence: 2 + index, kind: record.kind,
      actorType: index ? "local_user" : "ling_agent", payload: { requestId: "request", requestVersion: 1, ...(index ? { answerId: "accepted" } : {}), runEventPosition } })),
    { ...base, id: "after", sequence: 4, kind: "assistant_message", payload: {} }];
  const items = [{ id: "before-row", itemId: "before", kind: "userMessage", revision: 1, threadSequence: 1000000, partIndex: 0, sourceRefs: [] },
    { id: "after-row", itemId: "after", kind: "agentMessage", revision: 1, threadSequence: 2000000, partIndex: 0, sourceRefs: [], markdown: "After" }];
  return { workspaceId: "workspace", channelId: "channel", threadId: source.threadId, surface, conversationItems, userInputs: [question, answer], items };
}
for (const surface of ["channel_root", "branch"]) test(surface + " uses canonical neighbors, not canonical 2 vs feed 1000000", () => {
  const input = fixture(surface), rows = projectChannelUserInputTimeline(input);
  assert.deepEqual(rows.map(row => row.id), ["before-row", "user-input:question", "user-input:answer", "after-row"]);
  assert.deepEqual(input.items.map(row => row.threadSequence), [1000000, 2000000]);
  assert.equal(rows[1].itemId, "question");
});
test("real tool boundary wins over the tool's source-item ownership anchor", () => {
  const input = fixture();
  const operation = seq => ({ id: "tool-" + seq, kind: "commandExecution", revision: 99, threadSequence: 1000000 + seq, partIndex: 0,
    runId: "run", attemptId: "attempt", participantId: "ling_agent", workflowStepId: null, sourceEventSequence: seq,
    sourceRefs: [{ kind: "conversation_item", id: "before" }] });
  input.items.splice(1, 0, operation(2), operation(5));
  assert.deepEqual(projectChannelUserInputTimeline(input).map(row => row.id), ["before-row", "tool-2", "user-input:question", "user-input:answer", "tool-5", "after-row"]);
});
test("unsequenced operations show body-free diagnostics instead of guessed question placement", () => {
  const input = fixture();
  input.items.splice(1, 0, { id: "tool", kind: "commandExecution", revision: 999, threadSequence: 1000001, partIndex: 0,
    runId: "run", attemptId: "attempt", participantId: "ling_agent", workflowStepId: null, sourceRefs: [] });
  const rows = projectChannelUserInputTimeline(input);
  assert.equal(rows.filter(row => row.kind.startsWith("userInput")).length, 0);
  assert(rows.some(row => row.code === "user_input_order_unavailable"));
  assert(!JSON.stringify(rows).includes("PRIVATE BODY"));
});
for (const key of ["workspaceId", "channelId", "threadId"]) test("reject other " + key, () => {
  const input = fixture();
  assert.equal(projectChannelUserInputTimeline({ ...input, [key]: "foreign" }), input.items);
});
test("private anchors never acquire channel visibility from matching IDs", () => {
  const input = fixture();
  input.conversationItems = input.conversationItems.map(item => ({ ...item, visibility: "owner_private", visibilityOwnerId: "other" }));
  assert.equal(projectChannelUserInputTimeline(input), input.items);
});
test("already nested canonical Q/A does not appear again at the root", () => {
  const input = fixture();
  input.items.push({ id: "child", kind: "subAgentActivity", revision: 1, threadSequence: 3000000, partIndex: 0, sourceRefs: [],
    childItems: [{ id: "user-input:question" }, { id: "user-input:answer" }] });
  assert.equal(projectChannelUserInputTimeline(input).filter(row => row.kind.startsWith("userInput")).length, 0);
});
test("workflow child hydration is not mounted as root narration", () => {
  const input = fixture();
  input.userInputs = input.userInputs.map(record => ({ ...record, source: { ...record.source, workflowStepId: "child-step" } }));
  const rows = projectChannelUserInputTimeline(input);
  assert.equal(rows.filter(row => row.kind.startsWith("userInput")).length, 0);
  assert(!JSON.stringify(rows).includes("PRIVATE BODY"));
});
test("unanchored display cannot append a question after unrelated pending rows", () => {
  const input = fixture();
  input.items = [{ id: "optimistic", kind: "agentMessage", revision: 1, threadSequence: 100, partIndex: 0, sourceRefs: [], markdown: "Pending" }];
  assert.equal(projectChannelUserInputTimeline(input).filter(row => row.kind.startsWith("userInput")).length, 0);
});
test("projection replay retains question identity and order", () => {
  const input = fixture(), once = projectChannelUserInputTimeline(input);
  assert.deepEqual(projectChannelUserInputTimeline({ ...input, items: once }), once);
});
for (const field of ["attemptId", "participantId"]) test("partial Run ownership cannot establish question order: " + field, () => {
  const input = fixture();
  const operation = seq => ({ id: "tool-" + seq, kind: "commandExecution", revision: 1, threadSequence: 1000000 + seq, partIndex: 0,
    runId: "run", attemptId: "attempt", participantId: "ling_agent", workflowStepId: null, sourceEventSequence: seq, sourceRefs: [] });
  const unknown = operation(3);
  delete unknown[field];
  input.items.splice(1, 0, operation(2), unknown, operation(5));
  const rows = projectChannelUserInputTimeline(input);
  assert.equal(rows.filter(row => row.kind.startsWith("userInput")).length, 0);
  assert.equal(rows.filter(row => row.code === "user_input_order_unavailable").length, 2);
  assert(!JSON.stringify(rows).includes("PRIVATE BODY"));
});
test("unplaced diagnostic replay is idempotent and can recover when anchors arrive", () => {
  const input = fixture();
  const optimistic = { id: "optimistic", kind: "agentMessage", revision: 1, threadSequence: 100, partIndex: 0, sourceRefs: [], markdown: "Pending" };
  const once = projectChannelUserInputTimeline({ ...input, items: [optimistic] });
  assert.equal(once.filter(row => row.kind === "diagnostic").length, 2);
  assert.deepEqual(projectChannelUserInputTimeline({ ...input, items: once }), once);
  const recovered = projectChannelUserInputTimeline({ ...input, items: [...once, ...input.items] });
  assert.equal(recovered.filter(row => row.kind === "diagnostic").length, 0);
  assert.equal(recovered.filter(row => row.kind.startsWith("userInput")).length, 2);
});
test("canonical sequence repairs a timestamp/ID-reversed contiguous message spine", () => {
  const input = fixture();
  input.items = [input.items[1], input.items[0]].map((row, index) => ({ ...row, threadSequence: index * 1000000 }));
  assert.deepEqual(projectChannelUserInputTimeline(input).map(row => row.id),
    ["before-row", "user-input:question", "user-input:answer", "after-row"]);
});
test("canonical repair cannot move messages across an unrelated operation", () => {
  const input = fixture();
  input.items = [input.items[1], { id: "foreign-tool", kind: "commandExecution", runId: "other-run", sourceRefs: [], revision: 1 }, input.items[0]]
    .map((row, index) => ({ ...row, threadSequence: index * 1000000, partIndex: 0 }));
  const rows = projectChannelUserInputTimeline(input);
  assert.equal(rows.filter(row => row.kind.startsWith("userInput")).length, 0);
  assert.deepEqual(rows.filter(row => row.kind !== "diagnostic").map(row => row.id), ["after-row", "foreign-tool", "before-row"]);
});
