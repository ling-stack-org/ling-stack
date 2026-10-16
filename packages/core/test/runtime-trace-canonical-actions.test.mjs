import assert from "node:assert/strict";
import test from "node:test";
import { createLingTraceSpanId, createLingTraceId, projectLingTrace } from "../dist/index.js";

const createdAt = "2026-10-16T00:00:00.000Z";
const startedAt = "2026-10-16T00:00:01.000Z";
const completedAt = "2026-10-16T00:00:02.000Z";
const lateAt = "2026-10-16T00:00:03.000Z";
const canonicalCoverage = { source: "execution_action", completeness: "complete" };
const partialCoverage = { source: "raw_event_fallback", completeness: "partial" };

function run(id = "b012-run", status = "succeeded") {
  return { id, status, cwd: "/b012/owned-workspace", taskId: "b012-task", threadId: "b012-thread",
    workUnitId: `unit-${id}`, workflowStepId: `step-${id}`, providerName: "fixture", providerModel: "no-network",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, eventLogPath: "/b012/unused-fixture-log",
    createdAt, startedAt, updatedAt: lateAt, ...(status === "running" ? {} : { endedAt: lateAt }) };
}

function event(owner, seq, type, data = {}) {
  return { id: `${owner.id}-event-${seq}`, runId: owner.id, seq,
    ts: seq === 1 ? startedAt : seq === 2 ? completedAt : lateAt, type,
    data: { toolCallId: "reused-call", toolName: "read", ...data } };
}

function action(owner, overrides = {}) {
  return { id: `tool:${owner.id}:reused-call`, revision: 2, workspaceId: "workspace_default",
    threadId: owner.threadId, runId: owner.id, workUnitId: owner.workUnitId,
    attemptId: `attempt-${owner.id}`, workflowStepId: owner.workflowStepId, participantId: "owned-participant",
    toolCallId: "reused-call", actionType: "read", risk: "low", status: "succeeded", title: "Read owned evidence",
    targetRefs: [], previewArtifactIds: [], resultArtifactIds: [], sourceRefs: [
      { kind: "execution_action", id: `tool:${owner.id}:reused-call` },
      { kind: "run", id: owner.id },
      { kind: "run_event", id: `${owner.id}-event-2` },
    ], createdAt, executedAt: startedAt, completedAt, updatedAt: completedAt, ...overrides };
}

function project(runs, eventsByRunId = {}, executionActions = []) {
  return projectLingTrace({ workspaceId: "workspace_default", subjectKind: "thread", subjectId: "b012-thread",
    status: "succeeded", runs, eventsByRunId, executionActions, generatedAt: lateAt });
}

function onlyTool(result, runId) {
  const spans = result.spans.filter(span => span.kind === "tool_call" && span.refs.runId === runId);
  assert.equal(spans.length, 1, `exactly one logical tool span for ${runId}`);
  return spans[0];
}

test("B012 canonical terminal action wins over a raw window that only contains start", () => {
  const owner = run(), canonical = action(owner);
  const result = project([owner], { [owner.id]: [event(owner, 1, "tool_start", { args: { path: "owned.txt" } })] }, [canonical]);
  const span = onlyTool(result, owner.id);
  assert.equal(span.status, "succeeded");
  assert.equal(span.endedAt, completedAt);
  assert.equal(span.refs.executionActionId, canonical.id);
  assert.equal(span.refs.attemptId, canonical.attemptId);
  assert.equal(span.refs.workflowStepId, canonical.workflowStepId);
  assert.deepEqual(span.evidenceCoverage, canonicalCoverage);
});

test("B012 raw duplicate failure cannot replace the accepted canonical terminal receipt", () => {
  const owner = run(), canonical = action(owner);
  const result = project([owner], { [owner.id]: [event(owner, 1, "tool_start"),
    event(owner, 2, "tool_end", { isError: false }), event(owner, 3, "tool_end", { isError: true })] }, [canonical]);
  const span = onlyTool(result, owner.id);
  assert.equal(span.status, "succeeded");
  assert.equal(span.endedAt, completedAt);
  assert.equal(span.refs.executionActionId, canonical.id);
  assert.deepEqual(span.evidenceCoverage, canonicalCoverage);
});

test("B012 identical call IDs from different Runs retain distinct canonical owners and parents", () => {
  const first = run("b012-first", "failed"), second = run("b012-second");
  const result = project([first, second], { [first.id]: [event(first, 1, "tool_start")] },
    [action(first, { status: "failed" }), action(second)]);
  const left = onlyTool(result, first.id), right = onlyTool(result, second.id);
  assert.equal(left.status, "failed");
  assert.equal(right.status, "succeeded");
  assert.notEqual(left.id, right.id);
  const traceId = createLingTraceId("thread", "b012-thread");
  for (const [owner, span] of [[first, left], [second, right]]) {
    assert.equal(span.parentSpanId, createLingTraceSpanId(traceId, "agent_run", owner.id));
    assert.equal(span.refs.executionActionId, `tool:${owner.id}:reused-call`);
    assert.deepEqual(span.evidenceCoverage, canonicalCoverage);
  }
});

test("B012 a raw-only owner cannot suppress a sibling Run's canonical action with the same call ID", () => {
  const first = run("b012-raw", "running"), second = run("b012-canonical");
  const result = project([first, second], { [first.id]: [event(first, 1, "tool_start")] }, [action(second)]);
  const left = onlyTool(result, first.id), right = onlyTool(result, second.id);
  assert.equal(right.status, "succeeded");
  assert.equal(right.refs.executionActionId, `tool:${second.id}:reused-call`);
  assert.deepEqual(right.evidenceCoverage, canonicalCoverage);
  assert.deepEqual(left.evidenceCoverage, partialCoverage);
  assert.equal(left.endedAt, undefined);
});

for (const isError of [false, true]) {
  test(`B012 raw-only tool_end is explicitly partial, not a canonical terminal verdict: isError=${isError}`, () => {
    const owner = run();
    const result = project([owner], { [owner.id]: [event(owner, 1, "tool_start"),
      event(owner, 2, "tool_end", { isError, result: "raw-payload-must-not-be-exposed" })] });
    const span = onlyTool(result, owner.id);
    assert.equal(span.endedAt, undefined, "raw receipt must not impersonate canonical completedAt");
    assert.equal(span.status, "running", "legacy nonterminal presentation is qualified by required partial coverage");
    assert.deepEqual(span.evidenceCoverage, partialCoverage);
    assert.equal(span.refs.executionActionId, undefined);
    assert.doesNotMatch(JSON.stringify(result), /raw-payload-must-not-be-exposed/u);
  });
}

for (const [status, expected] of [["waiting_for_approval", "waiting_for_approval"], ["approved", "running"]]) {
  test(`B012 ${status} is not an execution finish merely because approval resolved`, () => {
    const owner = run("b012-approval", "running");
    const canonical = action(owner, { id: "approval:b012", status, approvalId: "b012", executedAt: undefined,
      completedAt: undefined, ...(status === "approved" ? { resolvedAt: completedAt } : {}) });
    const span = onlyTool(project([owner], {}, [canonical]), owner.id);
    assert.equal(span.status, expected);
    assert.equal(span.endedAt, undefined);
    assert.equal(span.refs.approvalId, "b012");
    assert.deepEqual(span.evidenceCoverage, canonicalCoverage);
  });
}

for (const status of ["cancelled", "failed"]) {
  test(`B012 ${status} without physical receipt cannot borrow a raw or Run terminal timestamp`, () => {
    const owner = run(`b012-${status}`, status);
    const canonical = action(owner, { status, completedAt: undefined, updatedAt: lateAt });
    const result = project([owner], { [owner.id]: [event(owner, 1, "tool_start"),
      event(owner, 3, "tool_end", { isError: false })] }, [canonical]);
    const span = onlyTool(result, owner.id);
    assert.equal(span.status, status);
    assert.equal(span.endedAt, undefined);
    assert.deepEqual(span.evidenceCoverage, canonicalCoverage);
  });
}

test("B012 external action spans use the same canonical coverage contract without inventing a finish", () => {
  const owner = run("b012-deploy", "running");
  const canonical = action(owner, { id: "approval:deploy", actionType: "deploy", status: "approved",
    completedAt: undefined, resolvedAt: completedAt });
  const result = project([owner], {}, [canonical]);
  const span = result.spans.find(item => item.kind === "external_action");
  assert.ok(span);
  assert.equal(span.status, "running");
  assert.equal(span.endedAt, undefined);
  assert.equal(span.refs.executionActionId, canonical.id);
  assert.deepEqual(span.evidenceCoverage, canonicalCoverage);
});

test("B012 repeated projection keeps canonical tool identity and complete evidence deterministic", () => {
  const owner = run(), canonical = action(owner);
  const inputEvents = { [owner.id]: [event(owner, 1, "tool_start"), event(owner, 2, "tool_end", { isError: false })] };
  const first = project([owner], inputEvents, [canonical]);
  const replay = project([owner], inputEvents, [canonical]);
  assert.deepEqual(replay, first);
  const span = onlyTool(first, owner.id);
  assert.equal(span.refs.executionActionId, canonical.id);
  assert.deepEqual(span.evidenceCoverage, canonicalCoverage);
});
