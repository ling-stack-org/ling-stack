import assert from "node:assert/strict";
import test from "node:test";
import { createLingTraceId, createLingTraceSpanId } from "../../core/dist/index.js";
import { listAllExecutionActionsForRun } from "../dist/features/runs/execution-actions.js";
import { runtimeTraceFixture } from "./support/runtime-trace-canonical-fixture.mjs";

const coverage = { source: "execution_action", completeness: "complete" };

function toolSpans(detail, runId) {
  return detail.spans.filter(span => span.kind === "tool_call" && (!runId || span.refs.runId === runId));
}

function oneTool(detail, runId, toolCallId) {
  const matches = toolSpans(detail, runId).filter(span => span.refs.toolCallId === toolCallId);
  assert.equal(matches.length, 1, `one logical tool span for ${runId}/${toolCallId}`);
  return matches[0];
}

function canonicalAction(fixture, runId, toolCallId) {
  const matches = listAllExecutionActionsForRun(fixture.store, runId).filter(action => action.toolCallId === toolCallId);
  assert.equal(matches.length, 1, "the existing complete action path is the evidence baseline");
  return matches[0];
}

function assertCanonical(span, action) {
  assert.equal(span.refs.executionActionId, action.id);
  assert.equal(span.refs.runId, action.runId);
  assert.equal(span.endedAt, action.completedAt);
  assert.deepEqual(span.evidenceCoverage, coverage);
}

test("B012 real Run HTTP reads terminal action beyond the first 1000 durable events", async t => {
  const f = await runtimeTraceFixture(t), owner = f.createRun("b012-paged-run"), call = "paged-read";
  const start = f.startRead(owner.id, call);
  for (let i = 0; i < 1001; i++) f.store.appendEvent(owner.id, "assistant_text_delta", { text: `owned-progress-${i}` });
  const end = await f.endRead(owner.id, call);
  f.finishRun(owner.id, "succeeded");
  assert.ok(start.seq <= 1000 && end.seq > 1000);
  assert.ok(f.store.countEvents(owner.id) > 1000);
  assert.equal(f.store.listEvents(owner.id, { limit: 1000 }).some(event => event.id === end.id), false);
  assert.ok(f.store.listEvents(owner.id, { afterSeq: 1000, limit: 1000 }).some(event => event.id === end.id));
  const action = canonicalAction(f, owner.id, call);
  assert.equal(action.status, "succeeded"); assert.equal(action.completedAt, end.ts);
  const detail = await f.trace("run", owner.id), span = oneTool(detail, owner.id, call);
  assert.equal(detail.trace.status, "succeeded", "Trace must not recalculate the owning Run outcome");
  assert.equal(span.status, "succeeded"); assert.equal(span.endedAt, end.ts);
  assertCanonical(span, action);
  const replay = await f.trace("run", owner.id);
  assert.deepEqual(replay.spans, detail.spans, "repeat/reconnect reads cannot lose the terminal action");
});

test("B012 selected Run and thread HTTP preserve all 503 canonical actions, not a 500-action window", async t => {
  const f = await runtimeTraceFixture(t), owner = f.createRun("b012-many-actions");
  for (let i = 0; i < 503; i++) {
    const call = `read-${String(i).padStart(4, "0")}`;
    f.startRead(owner.id, call); await f.endRead(owner.id, call);
  }
  f.finishRun(owner.id, "succeeded");
  const actions = listAllExecutionActionsForRun(f.store, owner.id);
  assert.equal(actions.length, 503);
  const expectedIds = actions.map(action => action.id).sort();
  for (const [kind, id] of [["run", owner.id], ["thread", f.thread.id]]) {
    const detail = await f.trace(kind, id), spans = toolSpans(detail, owner.id);
    assert.equal(spans.length, 503);
    assert.deepEqual(spans.map(span => span.refs.executionActionId).sort(), expectedIds,
      "every selected action, including those outside bounded reads, needs its canonical owner");
    for (const span of spans) {
      assert.equal(span.status, "succeeded");
      assertCanonical(span, actions.find(action => action.id === span.refs.executionActionId));
    }
  }
});

test("B012 real HTTP preserves the first accepted end when a later raw failure arrives", async t => {
  const f = await runtimeTraceFixture(t), owner = f.createRun("b012-late-failure"), call = "same-logical-read";
  f.startRead(owner.id, call);
  const accepted = await f.endRead(owner.id, call);
  const late = await f.endRead(owner.id, call, "deliberately-missing.txt");
  assert.equal(late.data.isError, true);
  f.finishRun(owner.id, "succeeded");
  const action = canonicalAction(f, owner.id, call);
  assert.equal(action.status, "succeeded"); assert.equal(action.completedAt, accepted.ts);
  assert.ok(action.diagnostics.some(item => item.sourceRefs.some(ref => ref.id === late.id)));
  assert.equal(action.sourceRefs.some(ref => ref.id === late.id), false);
  const span = oneTool(await f.trace("run", owner.id), owner.id, call);
  assert.equal(span.status, "succeeded"); assert.equal(span.endedAt, accepted.ts);
  assertCanonical(span, action);
});

test("B012 real thread HTTP isolates reused call IDs by Run owner, including failure", async t => {
  const f = await runtimeTraceFixture(t), first = f.createRun("b012-cross-first"), second = f.createRun("b012-cross-second");
  const call = "provider-reused-call-id";
  f.startRead(first.id, call); const firstEnd = await f.endRead(first.id, call);
  f.finishRun(first.id, "succeeded");
  f.startRead(second.id, call, "deliberately-missing.txt");
  const secondEnd = await f.endRead(second.id, call, "deliberately-missing.txt");
  f.finishRun(second.id, "failed");
  f.store.updateLingThread(f.thread.id, { status: "failed", lastRunId: second.id }, new Date().toISOString());
  const detail = await f.trace("thread", f.thread.id);
  assert.equal(detail.trace.status, "failed");
  assert.equal(toolSpans(detail).length, 2);
  const left = oneTool(detail, first.id, call), right = oneTool(detail, second.id, call);
  assert.equal(left.status, "succeeded"); assert.equal(right.status, "failed");
  assert.equal(left.endedAt, firstEnd.ts); assert.equal(right.endedAt, secondEnd.ts);
  assert.notEqual(left.id, right.id);
  for (const [owner, span] of [[first, left], [second, right]]) {
    assertCanonical(span, canonicalAction(f, owner.id, call));
    assert.equal(span.parentSpanId, createLingTraceSpanId(createLingTraceId("thread", f.thread.id), "agent_run", owner.id));
  }
});

for (const status of ["cancelled", "failed"]) {
  test(`B012 ${status} Run without physical tool receipt stays terminal but never invents tool endedAt`, async t => {
    const f = await runtimeTraceFixture(t), owner = f.createRun(`b012-no-receipt-${status}`), call = "unfinished-read";
    f.startRead(owner.id, call);
    f.finishRun(owner.id, status);
    // A valid Host append records a late diagnostic; the canonical Run fence
    // deliberately prevents it becoming the unfinished tool's physical receipt.
    const late = await f.endRead(owner.id, call);
    const action = canonicalAction(f, owner.id, call);
    assert.equal(action.status, status); assert.equal(action.completedAt, undefined);
    assert.ok(action.diagnostics.some(item => item.sourceRefs.some(ref => ref.id === late.id)));
    const detail = await f.trace("run", owner.id), span = oneTool(detail, owner.id, call);
    assert.equal(detail.trace.status, status);
    assert.equal(span.status, status); assert.equal(span.endedAt, undefined);
    assertCanonical(span, action);
  });
}

test("B012 pending approval, approved-only and actual resumed receipt remain one stable logical HTTP span", async t => {
  const f = await runtimeTraceFixture(t), owner = f.createRun("b012-approval-resume"), call = "approved-read";
  const approval = f.store.createApprovalRequest({ runId: owner.id, taskId: f.task.id, toolCallId: call,
    actionType: "read", risk: "low", title: "Approve owned read", description: "Read the isolated fixture file",
    payload: { type: "tool_call", toolName: "read", cwd: f.cwd, input: { path: "owned.txt" } } }, new Date().toISOString());
  const waiting = oneTool(await f.trace("run", owner.id), owner.id, call);
  assert.equal(waiting.status, "waiting_for_approval"); assert.equal(waiting.endedAt, undefined);
  assertCanonical(waiting, canonicalAction(f, owner.id, call));
  const resolvedAt = new Date().toISOString();
  f.store.approveApprovalRequest(approval.id, { reason: "B012 explicit fixture approval", resolvedBy: "local-user" }, resolvedAt);
  const approvedAction = canonicalAction(f, owner.id, call);
  assert.equal(approvedAction.status, "approved"); assert.equal(approvedAction.resolvedAt, resolvedAt);
  assert.equal(approvedAction.completedAt, undefined);
  const approved = oneTool(await f.trace("run", owner.id), owner.id, call);
  assert.equal(approved.status, "running"); assert.equal(approved.endedAt, undefined,
    "approval resolution is not a physical tool completion timestamp");
  assert.equal(approved.id, waiting.id); assertCanonical(approved, approvedAction);
  f.startRead(owner.id, call); const end = await f.endRead(owner.id, call);
  f.finishRun(owner.id, "succeeded");
  const completed = oneTool(await f.trace("run", owner.id), owner.id, call);
  assert.equal(completed.status, "succeeded"); assert.equal(completed.endedAt, end.ts);
  assert.equal(completed.id, waiting.id, "approval resume must not replace the span with a duplicate raw identity");
  assert.equal(completed.refs.approvalId, approval.id);
  assertCanonical(completed, canonicalAction(f, owner.id, call));
});

test("B012 normal short streams and collection/detail/spans reads stay deterministic and private", async t => {
  const f = await runtimeTraceFixture(t), owner = f.createRun("b012-short-stream"), call = "short-read";
  f.startRead(owner.id, call);
  const end = await f.endRead(owner.id, call);
  f.finishRun(owner.id, "succeeded");
  const listed = await f.get(`/traces?cwd=${encodeURIComponent(f.cwd)}&runId=${encodeURIComponent(owner.id)}`);
  assert.equal(listed.traces.length, 1);
  assert.equal(listed.traces[0].status, "succeeded");
  const detail = await f.trace("run", owner.id), replay = await f.trace("run", owner.id);
  assert.equal(detail.trace.id, listed.traces[0].id);
  assert.deepEqual(replay.spans, detail.spans);
  const span = oneTool(detail, owner.id, call);
  assert.equal(span.status, "succeeded"); assert.equal(span.endedAt, end.ts);
  assertCanonical(span, canonicalAction(f, owner.id, call));
  assert.doesNotMatch(JSON.stringify(detail), /B012 owned local read evidence/u, "raw file content is not trace metadata");
});

test("B012 denying a real pending approval keeps one canonical failed span without executing a tool", async t => {
  const f = await runtimeTraceFixture(t), owner = f.createRun("b012-denied"), call = "denied-read";
  const approval = f.store.createApprovalRequest({ runId: owner.id, taskId: f.task.id, toolCallId: call,
    actionType: "read", risk: "low", title: "Review denied read", description: "Do not execute this fixture read",
    payload: { type: "tool_call", toolName: "read", cwd: f.cwd, input: { path: "owned.txt" } } }, new Date().toISOString());
  const waiting = oneTool(await f.trace("run", owner.id), owner.id, call);
  const resolvedAt = new Date().toISOString();
  assert.equal(f.store.denyApprovalRequest(approval.id, { reason: "B012 explicit denial", resolvedBy: "local-user" }, resolvedAt)?.status, "denied");
  const action = canonicalAction(f, owner.id, call);
  assert.equal(action.status, "denied");
  assert.equal(action.completedAt, resolvedAt, "the canonical rejection is terminal without pretending execution occurred");
  const denied = oneTool(await f.trace("run", owner.id), owner.id, call);
  assert.equal(denied.status, "failed");
  assert.equal(denied.id, waiting.id);
  assert.equal(denied.refs.approvalId, approval.id);
  assertCanonical(denied, action);
  assert.equal(f.store.listEvents(owner.id, { limit: 1000 }).some(event => event.type === "tool_start" || event.type === "tool_end"), false);
});
