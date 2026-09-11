import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkflowStepNarration } from "../dist/features/channels/workflow-step-narration.js";

const step = { id: "step", workspaceId: "workspace", channelId: "channel", workflowId: "workflow", runId: "run", toParticipantId: "engineer" };
const run = { id: "run", channelId: "channel", workflowStepId: "step", teammateId: "engineer", threadId: "child", turnId: "child-turn" };
const parent = { id: "parent", workspaceId: "workspace", channelId: "channel", threadId: "root", turnId: "root-turn",
  sequence: 1, kind: "user_message", visibility: "channel", status: "committed" };
const thread = { id: "child", workspaceId: "workspace", channelId: "channel", kind: "task" };
const turn = { id: "child-turn", workspaceId: "workspace", channelId: "channel", threadId: "child" };
const source = { workspaceId: "workspace", threadId: "child", turnId: "child-turn", runId: "run", attemptId: "attempt",
  participantId: "engineer", workflowStepId: "step", workUnitId: "unit", sourceItemId: "child-source" };
const question = { itemId: "question", kind: "user_input_request", availability: "available", source, requestId: "request",
  requestVersion: 1, status: "pending", statusRevision: 1, questions: [], waitMode: "required" };
const anchor = { ...parent, id: "question", kind: "user_input_request", threadId: "child", turnId: "child-turn", sequence: 3 };
function store(overrides = {}) {
  let reading = false;
  return { readSnapshot(fn) { assert.equal(reading, false); reading = true; try { return fn(); } finally { reading = false; } },
    getChannelWorkflowStep: () => step, getRun: () => run, getChannelWorkflow: () => ({ ...step, id: "workflow", metadata: { sourceMessageId: "parent" } }),
    getConversationItem: () => parent, getLingThread: () => thread, getLingTurnForRun: () => turn,
    listEvents: () => [], listConversationItemsForTurn: () => [anchor],
    readUserInputTranscript(input) { assert.equal(reading, true); assert.deepEqual(input, { threadId: "child", itemIds: ["question"] }); return [question]; }, ...overrides };
}
test("workflow reads the child's own Q/A under the verified parent snapshot, without tool evidence", () => {
  const result = projectWorkflowStepNarration(store(), step);
  assert.equal(result.runNarration.segments.length, 0);
  assert.equal(result.runUserInputHistory.threadId, "child");
  assert.equal(result.runUserInputHistory.parentThreadId, "root");
  assert.equal(result.runUserInputHistory.parentItemId, "parent");
  assert.equal(result.runUserInputHistory.attemptId, "attempt");
  assert.deepEqual(result.runUserInputHistory.userInputs, [question]);
});
for (const [name, overrides] of [
  ["foreign thread", { getLingThread: () => ({ ...thread, channelId: "other" }) }],
  ["private thread", { getLingThread: () => ({ ...thread, kind: "teammate_direct" }) }],
  ["foreign turn", { getLingTurnForRun: () => ({ ...turn, threadId: "other" }) }],
  ["private anchor", { listConversationItemsForTurn: () => [{ ...anchor, visibility: "agent_private" }] }],
  ["parent anchor in the child list", { listConversationItemsForTurn: () => [{ ...anchor, threadId: "root" }] }],
]) test("child Q/A rejects " + name + " before reading any body", () => {
  const result = projectWorkflowStepNarration(store({ ...overrides, readUserInputTranscript() { throw new Error("must not hydrate"); } }), step);
  assert.equal(result.runUserInputHistory, null);
});
for (const field of ["workspaceId", "threadId", "turnId", "runId", "participantId", "workflowStepId"]) {
  test("matching labels cannot import another " + field, () => {
    const result = projectWorkflowStepNarration(store({ readUserInputTranscript: () => [{ ...question, source: { ...source, [field]: "other" } }] }), step);
    assert.equal(result.runUserInputHistory, null);
  });
}
test("mixed attempts and unavailable bodies cannot be assigned to a selected child", () => {
  for (const values of [[question, { ...question, source: { ...source, attemptId: "other" } }],
    [{ availability: "unavailable", itemId: "question", kind: "user_input_request" }]]) {
    assert.equal(projectWorkflowStepNarration(store({ readUserInputTranscript: () => values }), step).runUserInputHistory, null);
  }
});
test("a stale route object cannot publish a superseded Run's question", () => {
  const result = projectWorkflowStepNarration(store({ getChannelWorkflowStep: () => ({ ...step, runId: "new-run" }) }), step);
  assert.equal(result.runUserInputHistory, null);
});
test("database errors remain observable, not converted to empty successful history", () => {
  assert.throws(() => projectWorkflowStepNarration(store({ readUserInputTranscript() { throw new Error("database unavailable"); } }), step), /database unavailable/);
});
