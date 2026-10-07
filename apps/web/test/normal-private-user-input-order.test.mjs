import assert from "node:assert/strict";
import test from "node:test";
import { projectConversationRunNarration } from "@ling-stack/conversation-ui-core";
import { selectNormalTimelineItems } from "../src/features/workspace/normal-conversation-timeline-items.ts";
import { projectTeammatePrivateTimelineItems } from "../src/features/teammates/teammate-private-timeline-items.ts";

const source = { workspaceId: "workspace", threadId: "thread", turnId: "turn", runId: "run",
  workUnitId: "unit", attemptId: "attempt", participantId: "engineer" };
const base = { revision: 1, threadSequence: 1, partIndex: 0, turnId: source.turnId, sourceRefs: [] };
function fixture(surface) {
  const user = { ...base, id: "user", itemId: "user", kind: "userMessage", markdown: "User" };
  const read = { ...base, ...source, id: "read", actionId: "read", kind: "exploration", title: "read",
    operation: "read", targets: [], sourceEventSequence: 2, partIndex: 2, workflowStepId: null };
  const assistant = { ...base, id: "assistant", itemId: "assistant", kind: "agentMessage", runId: source.runId, markdown: "Before\n\nAfter" };
  const segments = [
    { content: "Before", firstEventId: "event-1", lastEventId: "event-1", startEventSequence: 1, endEventSequence: 1, completed: true, source },
    { content: "After", firstEventId: "event-4", lastEventId: "event-4", startEventSequence: 4, endEventSequence: 4, completed: true, source },
  ];
  const question = { ...base, ...source, id: "question", itemId: "question", kind: "userInputRequest", threadSequence: 2,
    workflowStepId: null, userInput: {
      availability: "available", kind: "user_input_request", itemId: "question", requestId: "request", requestVersion: 1,
      source: { ...source, sourceItemId: "user" }, statusRevision: 1, status: "pending", waitMode: "required",
      questions: [{ questionId: "q", prompt: "QUESTION_BODY", required: true, allowFreeText: true, options: [] }],
      runEventPosition: { runId: "run", attemptId: "attempt", afterEventSequence: 3, afterEventId: "event-3" },
    } };
  const answer = { ...question, id: "answer", itemId: "answer", threadSequence: 3, kind: "userInputAnswer",
    userInput: { ...question.userInput, kind: "user_input_answer", itemId: "answer", answerId: "accepted",
      answers: [{ questionId: "q", kind: "text", prompt: "QUESTION_BODY", text: "ANSWER_BODY" }],
      delivery: { status: "pending", revision: 1 } } };
  const canonical = { items: [user, read, question, answer], diagnostics: [], sourceSequence: 3, terminalEvidence: [] };
  const normalFeed = [
    { message: { id: "user", role: "user", turnId: "turn" }, timelineItems: [user] },
    { message: { id: "assistant", role: "assistant", runId: "run", turnId: "turn", narrationSegments: segments }, timelineItems: [assistant] },
  ];
  const privateInput = {
    teammateId: "engineer", directThreadId: "direct", canonicalThreadId: "thread",
    runs: [{ id: "run", threadId: "thread", teammateId: "engineer" }],
    runLinks: [{ runId: "run", turnId: "turn" }], canonical,
    messages: [
      { message: { id: "user", workspaceId: "workspace", threadId: "direct", teammateId: "engineer", authorType: "local-user", body: "User", status: "ready", fileRefs: [] }, body: "User", facts: [] },
      { message: { id: "assistant", workspaceId: "workspace", threadId: "direct", teammateId: "engineer", authorType: "ai-teammate", authorId: "engineer", body: "Before\n\nAfter",
        linkedRunId: "run", status: "ready", narrationSegments: segments, fileRefs: [] }, body: "Before\n\nAfter", facts: [] },
    ],
  };
  return { user, read, question, answer, assistant, segments, canonical,
    project: () => surface === "normal" ? selectNormalTimelineItems(canonical.items, normalFeed) : projectTeammatePrivateTimelineItems(privateInput) };
}
const labels = rows => rows.map(row => row.markdown ?? row.title ?? row.id);
for (const surface of ["normal", "private"]) {
  test(surface + " interleaves narrative, tool, question, answer and subsequent narrative", () => {
    const f = fixture(surface), rows = f.project();
    assert.deepEqual(labels(rows), ["User", "Before", "read", "question", "answer", "After"]);
    assert.deepEqual(rows.filter(row => row.kind === "agentMessage").map(row => [row.runId, row.attemptId, row.participantId]),
      [["run", "attempt", "engineer"], ["run", "attempt", "engineer"]]);
    assert.equal(rows.find(row => row.id === "question").userInput, f.question.userInput);
  });
  for (const missing of ["source", "boundary", "attempt", "thread"]) {
    test(surface + " unknown " + missing + " produces no-body ordering diagnosis", () => {
      const f = fixture(surface);
      if (missing === "source") f.segments.forEach(segment => delete segment.source);
      if (missing === "boundary") { delete f.question.userInput.runEventPosition; delete f.answer.userInput.runEventPosition; }
      if (missing === "attempt") f.read.attemptId = "other";
      if (missing === "thread") f.segments.forEach(segment => segment.source = { ...source, threadId: "foreign-thread" });
      const rows = f.project();
      assert.ok(rows.some(row => row.kind === "diagnostic"));
      assert.ok(!JSON.stringify(rows).includes("QUESTION_BODY"));
      assert.ok(!JSON.stringify(rows).includes("ANSWER_BODY"));
    });
  }
  test(surface + " refreshed lineage withdraws stale ownership and restores without duplicate rows", () => {
    const f = fixture(surface), first = f.project();
    f.segments.forEach(segment => { delete segment.source; segment.sourceRevision = 1; });
    const withdrawn = f.project();
    assert.ok(withdrawn.some(row => row.kind === "diagnostic"));
    assert.ok(withdrawn.find(row => row.kind === "agentMessage").revision > first.find(row => row.kind === "agentMessage").revision);
    f.segments.forEach(segment => { segment.source = source; delete segment.sourceRevision; });
    assert.deepEqual(f.project(), first);
  });
  test(surface + " question before first narrative needs no preceding tool", () => {
    const f = fixture(surface);
    f.canonical.items = [f.user, f.question];
    f.question.userInput.runEventPosition = { runId: "run", attemptId: "attempt", afterEventSequence: 0 };
    assert.deepEqual(labels(f.project()), ["User", "question", "Before", "After"]);
  });
}
test("narration projection never inherits stale ownership or accepts incomplete source fields", () => {
  const f = fixture("normal");
  for (const invalid of [undefined, { runId: "run", turnId: "turn" }, { ...source, turnId: "foreign" }, { ...source, runId: "foreign" }]) {
    const rows = projectConversationRunNarration({ message: { ...f.assistant, attemptId: "cached-attempt", participantId: "engineer",
      workUnitId: "cached-unit", workflowStepId: null, sourceRefs: [{ kind: "attempt", id: "cached-attempt" }] },
      segments: f.segments.map(segment => ({ ...segment, source: invalid })), runId: "run", anchor: f.user });
    assert.ok(rows.every(row => row.attemptId === undefined && row.participantId === undefined && row.workUnitId === undefined));
    assert.ok(rows.every(row => !row.sourceRefs.some(ref => ref.kind === "attempt")));
  }
});

test("private final reply with only a durable run link does not invalidate event-positioned Q/A", () => {
  const f = fixture("private");
  const input = {
    teammateId: "engineer", directThreadId: "direct", canonicalThreadId: "thread",
    runs: [{ id: "run", threadId: "thread", teammateId: "engineer" }],
    runLinks: [{ runId: "run", turnId: "turn" }], canonical: f.canonical,
    messages: [
      { message: { id: "user", workspaceId: "workspace", threadId: "direct", teammateId: "engineer", authorType: "local-user",
        body: "User", status: "ready", fileRefs: [] }, body: "User", facts: [] },
      { message: { id: "assistant-final", workspaceId: "workspace", threadId: "direct", teammateId: "engineer", authorType: "ai-teammate",
        authorId: "engineer", body: "Final reply", linkedRunId: "run", status: "ready", fileRefs: [] }, body: "Final reply", facts: [] },
    ],
  };
  const rows = projectTeammatePrivateTimelineItems(input);
  assert.equal(rows.filter(row => row.kind === "userInputRequest").length, 1);
  assert.equal(rows.filter(row => row.kind === "userInputAnswer").length, 1);
  assert.equal(rows.some(row => row.kind === "diagnostic" && row.code === "user_input_order_unavailable"), false);
  assert.equal(rows.find(row => row.kind === "agentMessage" && row.markdown === "Final reply")?.runId, "run");
});
