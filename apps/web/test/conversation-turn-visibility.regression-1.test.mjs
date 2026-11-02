import assert from "node:assert/strict";
import test from "node:test";
import { deriveSilentChannelReplyRunIds } from "../src/lib/conversation-runtime-visibility.ts";
import { buildConversationTurnProjection } from "../src/lib/conversation-turn-projector.ts";

// Regression: C03-TURN-VISIBILITY — embedded turn cells bypassed silent reply filtering.
// Found by /qa on 2026-10-25.
// Report: output/e6-20260928/p3-bash-cwd-contract-live-20261025/c03-scope-findings.md
// Real visibility + turn projectors, synthetic Host records; not packaged GUI proof.
const at = "2026-10-25T00:00:00.000Z";
function fixture({ surface = "branch", status = "succeeded", actions = [], approvals = [], cellOverrides = {} } = {}) {
  const run = { id: "run-reply", threadId: `thread-${surface}`, status, workUnitId: "wu-reply" };
  const user = { id: "user", channelId: "channel", threadId: run.threadId, turnId: "turn-reply",
    linkedRunId: run.id, authorType: "local-user", kind: "message", body: "A content question",
    createdAt: at, updatedAt: at };
  const reply = { ...user, id: "reply", linkedRunId: undefined, authorType: "ai-teammate", authorId: "ling-agent",
    body: "A content answer", createdAt: "2026-10-25T00:00:01.000Z" };
  const cell = { id: "cell-reply", sourceKind: "run_thread", threadId: run.threadId, turnId: user.turnId,
    anchorRunId: run.id, runIds: [run.id], mode: "completed", status, title: "Channel discussion", summary: "Completed",
    stats: [], operationRows: [], agentSpans: [], agentBranches: [], terminalReportRows: [], activeRows: [],
    groups: [], evidenceLinks: [], artifactStripItems: [], updatedAt: at, ...cellOverrides };
  const silentChannelReplyRunIds = deriveSilentChannelReplyRunIds({ runs: [run],
    workUnits: [{ id: run.workUnitId, kind: "channel_ai_reply" }], approvals,
    executionActions: actions, terminalReports: [] });
  return { run, user, reply, cell, input: { channelId: user.channelId, messages: [user, reply],
    proposals: [], intentDecisions: [], workflows: [], workflowSteps: [], runs: [run], usedMemoryEvents: [],
    operationCellByWorkflowId: new Map(), operationCellByThreadId: new Map([[run.threadId, cell]]),
    lingAgentAuthorId: "ling-agent", silentChannelReplyRunIds } };
}

for (const surface of ["channel-root", "topic", "branch"]) {
  test(`pure ${surface} reply keeps its prose without an embedded execution card`, () => {
    const { input, reply } = fixture({ surface });
    const projected = buildConversationTurnProjection(input).turns[0];
    assert.equal(projected.operationCell, undefined);
    assert.equal(projected.blocks.some(block => block.kind === "operation" || block.kind === "final_result"), false);
    assert.deepEqual(projected.blocks.filter(block => block.kind === "coordinator_message").map(block => block.message.body), [reply.body]);
  });
}

for (const [name, options] of [
  ["real tool action", { actions: [{ id: "action-read", runId: "run-reply" }] }],
  ["pending approval", { status: "waiting_for_approval", approvals: [{ id: "approval", runId: "run-reply", status: "pending" }] }],
  ["failed execution", { status: "failed" }],
]) {
  test(`${name} still produces the turn's execution card`, () => {
    const { input, cell } = fixture(options);
    const projected = buildConversationTurnProjection(input).turns[0];
    assert.equal(projected.operationCell, cell);
    assert.equal(projected.blocks.some(block => block.kind === "operation"), true);
  });
}

test("a pure new reply cannot borrow a previous work cell from the same thread", () => {
  const { input } = fixture({ cellOverrides: { turnId: "turn-previous", anchorRunId: "run-previous", runIds: ["run-previous"] } });
  assert.equal(buildConversationTurnProjection(input).turns[0].operationCell, undefined);
});

test("a visible run cannot borrow a work cell belonging to another turn", () => {
  const { input } = fixture({ status: "failed", cellOverrides: { turnId: "turn-previous", anchorRunId: "run-previous", runIds: ["run-previous"] } });
  assert.equal(buildConversationTurnProjection(input).turns[0].operationCell, undefined);
});

test("matching Run identity alone cannot override a known different Turn", () => {
  const { input } = fixture({ status: "failed", cellOverrides: { turnId: "turn-previous" } });
  assert.equal(buildConversationTurnProjection(input).turns[0].operationCell, undefined);
});

test("an explicit workflow remains visible even when its source reply run is silent", () => {
  const { input, user, cell } = fixture();
  const workflow = { id: "workflow", channelId: user.channelId, updatedAt: at, metadata: { sourceMessageId: user.id } };
  const projected = buildConversationTurnProjection({ ...input, workflows: [workflow],
    operationCellByWorkflowId: new Map([[workflow.id, { ...cell, sourceKind: "workflow" }]]) }).turns[0];
  assert.deepEqual(projected.operationRef, { kind: "workflow", workflowId: workflow.id });
});
