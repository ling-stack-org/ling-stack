import assert from "node:assert/strict";
import test from "node:test";
import { interleaveUserInputRunTimeline, projectCanonicalUserInputTimeline, reconcileCanonicalUserInputs } from "../dist/index.js";

const scope = { threadId: "thread", runId: "run", attemptId: "attempt", participantId: "engineer", workflowStepId: "step" };
const source = { ...scope, workspaceId: "workspace", threadId: "thread", turnId: "turn", workUnitId: "unit", sourceItemId: "source" };
function question(seq, after, overrides = {}) {
  const boundary = { runId: scope.runId, attemptId: scope.attemptId, afterEventSequence: after,
    ...(after ? { afterEventId: "event-" + after } : {}) };
  const record = { kind: "user_input_request", availability: "available", itemId: "question-" + seq, requestId: "request-" + seq,
    requestVersion: 1, source, runEventPosition: boundary, status: "pending", statusRevision: 1,
    waitMode: "required", questions: [], createdAt: "time", updatedAt: "time", ...overrides };
  const anchor = { id: record.itemId, workspaceId: source.workspaceId, threadId: source.threadId, turnId: source.turnId,
    sequence: seq, kind: record.kind, actorType: "teammate", actorId: scope.participantId, status: "committed", revision: 1,
    payload: { requestId: record.requestId, requestVersion: 1, runEventPosition: record.runEventPosition } };
  const projectionScope = { surface: "child", depth: 1, ...source };
  return { record, anchor, projectionScope, row: projectCanonicalUserInputTimeline({ scope: projectionScope, items: [anchor], userInputs: [record] })[0] };
}
function item(id, seq, kind = "commandExecution", overrides = {}) {
  return { id, kind, revision: 1, threadSequence: 1, partIndex: seq, sourceEventSequence: seq,
    ...scope, sourceRefs: [{ kind: "conversation_item", id: "source" }], ...overrides };
}
test("Host boundary survives hydration whitelist and preserves canonical identity", () => {
  const q = question(10, 0).row;
  assert.deepEqual(interleaveUserInputRunTimeline({ scope: { ...scope, surface: "child", depth: 1 }, items: [], userInputs: [q] }).items, [q]);
});
test("Host boundary retains exact public lineage", () => {
  const q = question(10, 5);
  assert.deepEqual(q.row.userInput.runEventPosition, q.record.runEventPosition);
  assert.equal(q.row.threadSequence, 10);
  assert.equal(q.row.sourceEventSequence, undefined, "a boundary is not a new Run event");
  assert(q.row.sourceRefs.some(ref => ref.kind === "run_event" && ref.id === "event-5"));
});
test("narration, question, answer and subsequent tool remain interleaved by event position", () => {
  const q = question(10, 5).row;
  const a = { ...question(11, 5).row, kind: "userInputAnswer", userInput: { ...question(11, 5).record,
    kind: "user_input_answer", answerId: "answer", answers: [], delivery: { status: "pending", revision: 1 } } };
  const original = [item("narration", 1, "agentMessage"), item("tool", 6), item("final", 20, "agentMessage")];
  const result = interleaveUserInputRunTimeline({ scope, items: original, userInputs: [a, q] });
  assert.deepEqual(result.items.map(row => row.id), ["narration", q.id, a.id, "tool", "final"]);
  assert.deepEqual(result.unplaced, []);
  assert.equal(original.length, 3);
});
test("command updates change revision without moving the question", () => {
  const q = question(10, 2).row;
  for (const revision of [3, 3000]) {
    const result = interleaveUserInputRunTimeline({ scope, items: [item("before", 2, "commandExecution", { revision }), item("after", 4)], userInputs: [q] });
    assert.deepEqual(result.items.map(row => row.id), ["before", q.id, "after"]);
  }
});
test("question before any event can be the child's first and only activity", () => {
  const q = question(10, 0).row;
  assert.deepEqual(interleaveUserInputRunTimeline({ scope, items: [], userInputs: [q] }).items, [q]);
  assert.deepEqual(interleaveUserInputRunTimeline({ scope, items: [item("tool", 1)], userInputs: [q] }).items.map(row => row.id), [q.id, "tool"]);
});
test("missing boundary is explicitly unplaced and never appended behind all tools", () => {
  const q = question(10, 2, { runEventPosition: undefined }).row;
  const rows = [item("tool", 3)];
  assert.deepEqual(interleaveUserInputRunTimeline({ scope, items: rows, userInputs: [q] }), { items: rows, unplaced: [q] });
});
test("unsequenced atomic rows cannot be ordered from action revision", () => {
  const q = question(10, 2).row;
  const rows = [item("tool", undefined, "commandExecution", { revision: 100 })];
  assert.deepEqual(interleaveUserInputRunTimeline({ scope, items: rows, userInputs: [q] }), { items: rows, unplaced: [q] });
});
test("same seq in another run, attempt, participant or step cannot claim a question", () => {
  const q = question(10, 2).row;
  for (const field of ["runId", "attemptId", "participantId", "workflowStepId"]) {
    const other = { ...scope, [field]: "another" };
    assert.deepEqual(interleaveUserInputRunTimeline({ scope: other, items: [item("other", 2, "commandExecution", other)], userInputs: [q] }).unplaced, [q]);
  }
});
test("conflicting or altered position cannot be laundered by a higher status revision", () => {
  const a = question(10, 2), b = question(10, 3, { statusRevision: 99 });
  const merged = reconcileCanonicalUserInputs({ scope: source,
    current: { items: [a.anchor], userInputs: [a.record] }, incoming: { items: [b.anchor], userInputs: [b.record] }, mode: "page" });
  assert.equal(merged.userInputs[0].availability, "unavailable");
});
test("DTO boundary must exactly match its canonical payload and source", () => {
  const a = question(10, 2);
  for (const change of [{ afterEventSequence: 3 }, { runId: "other" }, { attemptId: "other" }, { afterEventId: undefined }, { claim: "SECRET" }]) {
    const record = { ...a.record, runEventPosition: { ...a.record.runEventPosition, ...change } };
    const result = reconcileCanonicalUserInputs({ scope: source, incoming: { items: [a.anchor], userInputs: [record] }, mode: "page" });
    assert.equal(result.userInputs[0].availability, "unavailable");
  }
});
test("deduplication does not duplicate repeated anchors within a projection", () => {
  const q = question(10, 2).row;
  assert.deepEqual(interleaveUserInputRunTimeline({ scope, items: [item("tool", 3)], userInputs: [q, q] }).items.map(row => row.id), [q.id, "tool"]);
});
test("regressed incoming event order is reported, not used to guess an insertion", () => {
  const q = question(10, 2).row;
  const items = [item("later", 9), item("earlier", 1)];
  assert.deepEqual(interleaveUserInputRunTimeline({ scope, items, userInputs: [q] }), { items, unplaced: [q] });
});
test("identical run labels cannot import a question from a different owning thread", () => {
  const q = question(10, 0).row;
  assert.deepEqual(interleaveUserInputRunTimeline({ scope: { ...scope, threadId: "foreign" }, items: [], userInputs: [q] }).unplaced, [q]);
});
test("projection replay preserves old Q/A and places a newly received answer once", () => {
  const q = question(10, 2).row, a = question(11, 2).row;
  const once = interleaveUserInputRunTimeline({ scope, items: [item("tool", 3)], userInputs: [q] });
  const next = interleaveUserInputRunTimeline({ scope, items: once.items, userInputs: [q, a] });
  assert.deepEqual(next.items.map(row => row.id), [q.id, a.id, "tool"]);
  assert.deepEqual(next.unplaced, []);
});
