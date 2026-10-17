import assert from "node:assert/strict";
import test from "node:test";
import { projectCanonicalConversationTimeline, isConversationTimelineItem, projectDisplayBatches } from "../dist/index.js";

const now = "2026-09-08T00:00:00.000Z";
const scope = { surface: "normal", workspaceId: "workspace", threadId: "thread", depth: 0 };
const source = { workspaceId: "workspace", threadId: "thread", turnId: "turn", runId: "run",
  attemptId: "attempt", participantId: "engineer", workUnitId: "unit", sourceItemId: "origin" };
function authority(overrides = {}) {
  return { schemaVersion: 1, threadId: source.threadId, runId: source.runId, attemptId: source.attemptId,
    participantId: source.participantId, requestId: "request", requestVersion: 1, statusRevision: 1,
    token: "a".repeat(64), ...overrides };
}
function request(overrides = {}) {
  return { availability: "available", itemId: "question", kind: "user_input_request", requestId: "request",
    requestVersion: 1, source, status: "pending", statusRevision: 1, waitMode: "required",
    questions: [{ questionId: "q", prompt: "保留格式？\n\n**第二段**", required: true, allowFreeText: true,
      options: [{ optionId: "yes", label: "保留" }] }], createdAt: now, updatedAt: now, ...overrides };
}
function answer(overrides = {}) {
  return { availability: "available", itemId: "answer", kind: "user_input_answer", requestId: "request",
    requestVersion: 1, source, answerId: "accepted", acceptedAt: now,
    answers: [{ questionId: "q", prompt: "保留格式？", kind: "text", text: "第一行\n\n第二行" }],
    delivery: { status: "pending", revision: 1, updatedAt: now }, ...overrides };
}
function anchor(record, sequence) {
  return { id: record.itemId, workspaceId: "workspace", threadId: "thread", turnId: "turn", sequence,
    kind: record.kind, status: "committed", revision: 1,
    actorType: record.kind === "user_input_request" ? "teammate" : "local_user",
    actorId: record.kind === "user_input_request" ? "engineer" : "user",
    payload: { requestId: record.requestId, requestVersion: record.requestVersion,
      ...(record.kind === "user_input_answer" ? { answerId: record.answerId } : {}) }, domainRefs: [] };
}
function project(records = [request(), answer()], overrides = {}) {
  return projectCanonicalConversationTimeline({ scope, items: records.map((r, i) => anchor(r, i + 1)),
    userInputs: records, actions: [], turnRuns: [], sourceSequence: records.length, sourceRevision: "snapshot", ...overrides });
}
test("questions and answers have independent typed rows at their canonical sequence", () => {
  const result = project();
  assert.deepEqual(result.items.map(i => [i.kind, i.threadSequence, i.partIndex]),
    [["userInputRequest", 1, 0], ["userInputAnswer", 2, 0]]);
  assert.ok(result.items.every(isConversationTimelineItem));
  assert.equal(result.items[0].userInput.questions[0].prompt, request().questions[0].prompt);
  assert.equal(result.items[1].userInput.answers[0].text, answer().answers[0].text);
  assert.deepEqual(result.terminalEvidence, []);
  for (const row of result.items) {
    assert.equal(row.runId, source.runId);
    assert.equal(row.attemptId, source.attemptId);
    assert.equal(row.participantId, source.participantId);
    assert.equal(row.actionId, undefined);
    assert.ok(row.sourceRefs.some(ref => ref.kind === "conversation_item" && ref.id === row.itemId));
  }
});
test("request and delivery revisions are independent, never completion evidence", () => {
  const result = project([request({ status: "answered", statusRevision: 5 }),
    answer({ delivery: { status: "applied", revision: 8, updatedAt: now } })]);
  assert.deepEqual(result.items.map(i => i.revision), [5, 8]);
  assert.ok(result.items.every(i => i.status !== "succeeded"));
  assert.deepEqual(result.terminalEvidence, []);
});
test("pending request projects only exact public answer authority", () => {
  const result = project([request({ answerAuthority: authority() })]);
  assert.deepEqual(result.items[0].userInput.answerAuthority, authority());
  assert.equal(JSON.stringify(result).includes("fenceToken"), false);
  for (const answerAuthority of [authority({ threadId: "other" }), authority({ participantId: "other" }),
    authority({ requestVersion: 2 }), authority({ statusRevision: 2 }), { ...authority(), claimToken: "private" }]) {
    const invalid = project([request({ answerAuthority })]);
    assert.equal(invalid.items[0].userInput.availability, "unavailable");
  }
  assert.equal(project([request({ status: "answered", statusRevision: 2,
    answerAuthority: authority({ statusRevision: 2 }) })]).items[0].userInput.availability, "unavailable");
});
test("absent hydration differs from an anchored unavailable record", () => {
  assert.deepEqual(project(undefined, { userInputs: undefined }).items, []);
  const result = project(undefined, { userInputs: [] });
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(i => i.userInput.availability === "unavailable"));
  assert.equal(JSON.stringify(result.items).includes("第一行"), false);
});
test("unanchored replay tombstones and orphan bodies never render", () => {
  assert.deepEqual(project(undefined, { items: [] }).items, []);
  assert.deepEqual(project(undefined, { items: [], userInputs: [{ itemId: "question",
    kind: "user_input_request", availability: "unavailable" }] }).items, []);
});
test("conflicting hydration fails closed in both arrival orders", () => {
  const corrupt = request({ questions: [{ ...request().questions[0], prompt: "PRIVATE_CONFLICT" }] });
  for (const records of [[request(), corrupt], [corrupt, request()]]) {
    const result = project(records, { items: [anchor(request(), 1)] });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].userInput.availability, "unavailable");
    assert.equal(JSON.stringify(result.items).includes("PRIVATE_CONFLICT"), false);
  }
});
test("invalid actor cannot publish the question body", () => {
  const result = project([request()], { items: [{ ...anchor(request(), 1), actorId: "other" }] });
  assert.equal(result.items[0].userInput.availability, "unavailable");
});
for (const field of ["runId", "attemptId", "participantId", "turnId"]) {
  test("selected child rejects a different " + field, () => {
    const child = { ...scope, surface: "child", depth: 1, ...Object.fromEntries(
      ["runId", "attemptId", "participantId", "turnId"].map(key => [key, source[key]])), [field]: "other" };
    assert.deepEqual(project(undefined, { scope: child }).items, []);
  });
}
test("a child that only asks a question needs no fake tool action to prove its owner", () => {
  const result = project(undefined, { scope: { ...scope, surface: "child", depth: 1,
    runId: source.runId, participantId: source.participantId, attemptId: source.attemptId } });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.terminalEvidence, []);
});
test("child unavailable data cannot borrow lineage from the selected surface", () => {
  const result = project(undefined, { scope: { ...scope, surface: "child", depth: 1,
    runId: source.runId, participantId: source.participantId }, userInputs: [] });
  assert.deepEqual(result.items, []);
});
test("root suppresses only question rows actually rendered in a verified child span", () => {
  const child = project();
  const delegation = { id: "delegation", workspaceId: "workspace", threadId: "thread", turnId: "turn",
    sequence: 3, kind: "system_event", status: "committed", actorType: "system", revision: 1, payload: {} };
  const span = { id: "span", revision: 1, workspaceId: "workspace", threadId: "thread", anchorItemId: "delegation",
    runId: source.runId, participantId: source.participantId, lifecycle: "waiting", label: "Engineer",
    sourceRefs: [{ kind: "conversation_item", id: "delegation" }], childItems: child.items };
  const result = project(undefined, { sourceSequence: 3, items: [anchor(request(), 1), anchor(answer(), 2), delegation],
    participantSpans: [span] });
  assert.equal(result.items.filter(i => i.kind === "userInputRequest" || i.kind === "userInputAnswer").length, 0);
  assert.equal(result.items.find(i => i.kind === "subAgentActivity").childItems.length, 2);
});
test("questions and answers are preserved as display batch barriers", () => {
  const items = project().items;
  assert.deepEqual(projectDisplayBatches(items).items, items);
});
test("adjacent successful commands cannot batch across a question or an answer", () => {
  for (const barrier of project().items) {
    const command = n => ({ id: "command:" + n, kind: "commandExecution", actionId: "action:" + n,
      revision: 1, threadSequence: n, partIndex: 1, status: "succeeded", title: "node --version",
      command: "node --version", risk: "low", exitCode: 0, outputTail: [], runId: source.runId,
      attemptId: source.attemptId, participantId: source.participantId, workflowStepId: null,
      sourceRefs: [{ kind: "conversation_item", id: "command-anchor:" + n }], itemId: "command-anchor:" + n });
    const rows = [1, 2, 3].map(command).concat({ ...barrier, threadSequence: 4 }, [5, 6, 7].map(command));
    const context = { contextSegmentIdByItemId: new Map(rows.map(row => [row.itemId, "segment"])) };
    const batched = projectDisplayBatches(rows, context);
    assert.deepEqual(batched.items.map(row => row.kind), ["commandBatch", barrier.kind, "commandBatch"]);
    assert.equal(batched.boundaries.find(boundary => boundary.beforeItemId === barrier.id)?.reason, "kind");
  }
});
test("typed row validation rejects malformed public content", () => {
  const row = project().items[0];
  assert.ok(row);
  for (const userInput of [null, { ...request(), questions: null }, { ...request(), status: "success" }]) {
    assert.equal(isConversationTimelineItem({ ...row, userInput }), false);
  }
  assert.equal(isConversationTimelineItem({ ...row, userInput: request({ answerAuthority: authority({ runId: "other" }) }) }), false);
});
