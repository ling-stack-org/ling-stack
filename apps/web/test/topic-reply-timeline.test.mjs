import assert from "node:assert/strict";
import test from "node:test";
import { projectTopicReplyTimeline } from "../src/features/workspace/topic-reply-timeline.ts";

const now = "2026-09-08T00:00:00.000Z";
const scope = { workspaceId: "workspace", channelId: "channel", threadId: "topic" };
const source = { ...scope, turnId: "turn", runId: "run", attemptId: "attempt", workUnitId: "unit",
  participantId: "engineer", sourceItemId: "reply-before" };
const request = { kind: "user_input_request", availability: "available", itemId: "question", requestId: "request",
  requestVersion: 1, status: "answered", statusRevision: 2, source, waitMode: "required",
  questions: [{ questionId: "q", prompt: "保留格式？", required: true, allowFreeText: true, options: [] }], createdAt: now, updatedAt: now };
const answer = { kind: "user_input_answer", availability: "available", itemId: "answer", requestId: "request",
  requestVersion: 1, source, answerId: "accepted", acceptedAt: now,
  answers: [{ questionId: "q", prompt: "保留格式？", kind: "text", text: "第一段。\n\n第二段。" }],
  delivery: { status: "pending", revision: 1, updatedAt: now } };
function message(id, body = id, overrides = {}) {
  return { id, ...scope, turnId: "turn", authorType: "ai-teammate", authorId: "engineer", kind: "ai_reply",
    body, status: "ready", revision: 1, createdAt: now, ...overrides };
}
function anchor(id, sequence, record) {
  return { schemaVersion: 1, id, ...scope, turnId: "turn", sequence, kind: record?.kind ?? "assistant_message",
    actorType: record?.kind === "user_input_answer" ? "local_user" : "teammate",
    actorId: record?.kind === "user_input_answer" ? "local-user" : "engineer", status: "committed",
    visibility: "thread_participants", revision: 1, domainRefs: [],
    payload: record ? { requestId: record.requestId, requestVersion: 1, ...(record.answerId ? { answerId: record.answerId } : {}) } : {},
    createdAt: now, updatedAt: now, committedAt: now };
}
function input(overrides = {}) {
  return { ...scope, rootMessage: message("parent", "父频道引用", { threadId: "root", turnId: "parent-turn" }),
    replies: [message("reply-after"), message("reply-before")],
    conversationItems: [anchor("reply-before", 1), anchor("question", 2, request), anchor("answer", 3, answer), anchor("reply-after", 4)],
    userInputs: [request, answer], reasoningSummaries: [], ...overrides };
}

test("topic history interleaves Q/A on canonical sequence, not feed order or timestamps", () => {
  const rows = projectTopicReplyTimeline(input());
  assert.deepEqual(rows.map(row => row.itemId), ["parent", "reply-before", "question", "answer", "reply-after"]);
  assert.deepEqual(rows.map(row => row.kind), ["agentMessage", "agentMessage", "userInputRequest", "userInputAnswer", "agentMessage"]);
  assert.equal(rows[3].userInput.answers[0].text, "第一段。\n\n第二段。");
  assert.deepEqual(rows.slice(1).map(row => row.threadSequence), [1, 2, 3, 4]);
  assert.equal(rows[2].runId, "run");
  assert.equal(rows[2].attemptId, "attempt");
  assert.equal(rows[2].participantId, "engineer");
  assert.equal(rows[2].actionId, undefined);
});
test("parent quote is pinned as a reference, never uses the parent thread sequence", () => {
  const data = input();
  data.conversationItems.push({ ...anchor("parent", 9000), threadId: "root" });
  assert.deepEqual(projectTopicReplyTimeline(data).map(row => row.itemId), ["parent", "reply-before", "question", "answer", "reply-after"]);
  assert.equal(projectTopicReplyTimeline(data)[0].turnId, "parent-turn");
});
test("owner switch or not-yet-resolved topic cannot borrow question bodies", () => {
  for (const field of [{ threadId: "other" }, { workspaceId: "other" }, { channelId: "other" }, { threadId: "" }]) {
    const rows = projectTopicReplyTimeline(input(field));
    assert.equal(rows.some(row => row.kind === "userInputRequest" || row.kind === "userInputAnswer"), false);
    assert.equal(rows.some(row => row.itemId === "reply-before"), false);
  }
});
test("loading without canonical anchors does not project cached durable replies", () => {
  assert.deepEqual(projectTopicReplyTimeline(input({ conversationItems: [] })).map(row => row.itemId), ["parent"]);
});
test("duplicate replies render once and payload cannot overwrite a message with a Q/A anchor", () => {
  const data = input();
  data.replies.push(data.replies[0], message("question", "WRONG BODY"));
  const rows = projectTopicReplyTimeline(data);
  assert.equal(rows.filter(row => row.itemId === "reply-after").length, 1);
  assert.equal(rows.filter(row => row.itemId === "question").length, 1);
  assert.equal(JSON.stringify(rows).includes("WRONG BODY"), false);
});
test("unavailable history and unexplained visible anchors are content-free", () => {
  const rows = projectTopicReplyTimeline(input({ userInputs: [{ kind: request.kind, itemId: request.itemId, availability: "unavailable" }] }));
  assert.equal(rows.find(row => row.itemId === "question").userInput.availability, "unavailable");
  assert.equal(JSON.stringify(rows).includes("保留格式"), false);
  assert.equal(rows.find(row => row.itemId === "answer").userInput.availability, "unavailable");
});
test("request and delivery updates keep positions while invalidating their own revisions", () => {
  const before = projectTopicReplyTimeline(input());
  const after = projectTopicReplyTimeline(input({ userInputs: [{ ...request, statusRevision: 9 },
    { ...answer, delivery: { ...answer.delivery, status: "failed", revision: 4 } }] }));
  assert.deepEqual(after.map(row => [row.id, row.threadSequence]), before.map(row => [row.id, row.threadSequence]));
  assert.equal(after.find(row => row.kind === "userInputRequest").revision, 9);
  assert.equal(after.find(row => row.kind === "userInputAnswer").revision, 4);
});
test("only exact scoped pending transient replies may lack a canonical message anchor", () => {
  const data = input();
  data.replies.push(message("pending", "Thinking", { status: "pending" }), message("foreign", "PRIVATE", { threadId: "another", status: "pending" }));
  const rows = projectTopicReplyTimeline(data);
  assert.equal(rows.at(-1).itemId, "pending");
  assert.equal(rows.some(row => row.itemId === "foreign"), false);
});

test("provider-safe reasoning is placed before its final topic reply without exposing raw thinking", () => {
  const data = input();
  data.conversationItems[3] = {
    ...data.conversationItems[3],
    domainRefs: [{ type: "run", id: "run" }],
  };
  data.reasoningSummaries = [{
    id: "summary", revision: 7, ...scope, turnId: "turn", runId: "run", participantId: "engineer",
    anchorItemId: "reply-after", eventId: "event-summary", eventSequence: 7,
    text: "检查了边界。", parts: ["检查了边界。"], semantic: "safe_summary", source: "openai_responses",
    truncated: false, sourceRefs: [{ kind: "conversation_item", id: "reply-after" }, { kind: "run", id: "run" },
      { kind: "run_event", id: "event-summary" }, { kind: "participant", id: "engineer" }], createdAt: now,
  }];
  const rows = projectTopicReplyTimeline(data);
  const reasoningIndex = rows.findIndex(row => row.kind === "reasoning");
  const replyIndex = rows.findIndex(row => row.itemId === "reply-after" && row.kind === "agentMessage");
  assert.ok(reasoningIndex > 0 && reasoningIndex < replyIndex);
  assert.equal(rows[reasoningIndex].summary, "检查了边界。");
  assert.equal(JSON.stringify(rows).includes("raw thinking"), false);
});


test("topic compaction is anchored before its own reply and cannot cross a topic switch", () => {
  const data = input();
  data.conversationItems[3] = { ...data.conversationItems[3], domainRefs: [{ type: "run", id: "run" }] };
  const record = {
    id: "compaction", revision: 4, ...scope, turnId: "turn", runId: "run", anchorItemId: "reply-after",
    eventId: "event-start", eventSequence: 3, status: "running", reason: "threshold", summary: "",
    sourceRefs: [{ kind: "conversation_item", id: "reply-after" }, { kind: "run", id: "run" },
      { kind: "run_event", id: "event-start" }],
  };
  data.contextCompactions = [record];
  const before = projectTopicReplyTimeline(data);
  const compactionIndex = before.findIndex(row => row.kind === "contextCompaction");
  assert.ok(compactionIndex > 0 && compactionIndex < before.findIndex(row => row.itemId === "reply-after" && row.kind === "agentMessage"));
  const after = projectTopicReplyTimeline({ ...data, contextCompactions: [{ ...record, revision: 6, status: "succeeded" }] });
  assert.equal(after[compactionIndex].id, before[compactionIndex].id);
  assert.equal(after[compactionIndex].status, "succeeded");
  assert.equal(after[compactionIndex].revision, 6);
  for (const fields of [{ workspaceId: "foreign" }, { threadId: "foreign" }, { turnId: "foreign" }, { runId: "foreign" }]) {
    assert.equal(projectTopicReplyTimeline({ ...data, contextCompactions: [{ ...record, ...fields }] })
      .some(row => row.kind === "contextCompaction"), false);
  }
});
