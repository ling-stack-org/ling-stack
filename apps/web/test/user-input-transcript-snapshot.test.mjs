import assert from "node:assert/strict";
import test from "node:test";
import { mergeConversationDetailSnapshots } from "../src/domains/conversations/conversation-detail-merge.ts";
import { projectChannelConversationItemPage, mergeChannelUserInputPage } from "../src/lib/channel-conversation-items.ts";
import { createConversationReadEpoch } from "../src/lib/conversation-read-epoch.ts";
import { projectConversationDetailTimeline } from "../src/domains/conversations/canonical-transcript-snapshot.ts";
import { reconcileCanonicalUserInputs, userInputTranscriptRevisionSignature } from "@ling-stack/conversation-ui-core";
import { userInputHistoryPresentation } from "../src/shared/conversation/timeline/user-input-history-presentation.ts";
import { selectNormalTimelineItems } from "../src/features/workspace/normal-conversation-timeline-items.ts";
import { projectTeammatePrivateTimelineItems } from "../src/features/teammates/teammate-private-timeline-items.ts";

const now = "2026-09-08T00:00:00.000Z";
const source = {
  workspaceId: "workspace-1", threadId: "thread-1", turnId: "turn-1",
  runId: "run-1", attemptId: "attempt-1", workUnitId: "unit-1", participantId: "engineer",
  sourceItemId: "source-1", workflowStepId: "step-1",
};
function request(overrides = {}) {
  return {
    availability: "available", kind: "user_input_request", itemId: "question-1", requestId: "request-1",
    requestVersion: 1, source, status: "pending", statusRevision: 1, waitMode: "required",
    questions: [{ questionId: "q1", prompt: "保留换行？\n```ts\nconst n = 1;\n```", required: true,
      allowFreeText: true, options: [{ optionId: "a", label: "保留" }] }],
    createdAt: now, updatedAt: now, ...overrides,
  };
}
function answer(overrides = {}) {
  return {
    availability: "available", kind: "user_input_answer", itemId: "answer-1", requestId: "request-1",
    requestVersion: 1, source, answerId: "accepted-1", acceptedAt: now,
    answers: [{ questionId: "q1", prompt: request().questions[0].prompt, kind: "text", text: "第一行\n\n`第二行`" }],
    delivery: { status: "pending", revision: 1, updatedAt: now }, ...overrides,
  };
}
function anchor(record, sequence = record.kind === "user_input_request" ? 10 : 12) {
  return {
    schemaVersion: 1, id: record.itemId, workspaceId: source.workspaceId, threadId: source.threadId,
    turnId: source.turnId, sequence, kind: record.kind, status: "committed",
    actorType: record.kind === "user_input_request" ? "teammate" : "local_user",
    actorId: record.kind === "user_input_request" ? source.participantId : "local-user",
    visibility: "thread_participants", payload: { requestId: record.requestId, requestVersion: record.requestVersion,
      ...(record.kind === "user_input_answer" ? { answerId: record.answerId } : {}) },
    domainRefs: [], revision: 1, createdAt: now, updatedAt: now, committedAt: now,
  };
}
function detail(records = [], overrides = {}) {
  return {
    cwd: "/private/tmp/ling-u4b-fixture",
    thread: { id: source.threadId, workspaceId: source.workspaceId, kind: "conversation", status: "open", updatedAt: now },
    userInputs: records, conversationItems: records.map(record => anchor(record)),
    supersessionTombstones: { turnIds: [], runIds: [], responseMessageIds: [] },
    turns: [], runLinks: [], runs: [], reasoningSummaries: [], executionActions: [], approvals: [], approvalCheckpoints: [], interventions: [],
    terminalReports: [], artifacts: [], messages: [], generatedMedia: [], defaults: {}, ...overrides,
  };
}
function unavailable(record) {
  return { availability: "unavailable", kind: record.kind, itemId: record.itemId };
}

for (const kind of ["conversation", "teammate_direct", "channel_discussion"]) {
  test(`${kind}: reconnect cannot roll back request or delivery revision`, () => {
    const newest = detail([request({ status: "answered", statusRevision: 4 }), answer({ delivery: { status: "claimed", revision: 7, updatedAt: now } })]);
    newest.thread.kind = kind;
    if (kind === "teammate_direct") newest.thread.teammateId = source.participantId;
    const older = detail([request(), answer()]);
    older.thread.kind = kind;
    if (kind === "teammate_direct") older.thread.teammateId = source.participantId;
    older.thread.updatedAt = "2099-01-01T00:00:00.000Z";
    const merged = mergeConversationDetailSnapshots(newest, older);
    assert.equal(merged.userInputs.find(x => x.kind === "user_input_request").statusRevision, 4);
    assert.equal(merged.userInputs.find(x => x.kind === "user_input_answer").delivery.revision, 7);
    assert.equal(merged.userInputs.find(x => x.kind === "user_input_answer").delivery.status, "claimed");
    assert.deepEqual(merged.executionActions, []);
    assert.deepEqual(merged.terminalReports, []);
    assert.deepEqual(merged.messages, []);
  });
}
test("request conflicts at equal revision hide both bodies in either merge order", () => {
  const first = detail([request()]);
  const second = detail([request({ questions: [{ ...request().questions[0], prompt: "CONFLICT_PRIVATE_BODY" }] })]);
  for (const [current, incoming] of [[first, second], [second, first]]) {
    const result = mergeConversationDetailSnapshots(current, incoming);
    assert.deepEqual(result.userInputs, [unavailable(request())]);
    assert.equal(JSON.stringify(result).includes("CONFLICT_PRIVATE_BODY"), false);
  }
});
test("higher status revision does not license changed immutable question or source", () => {
  for (const field of [
    { questions: [{ ...request().questions[0], prompt: "CONFLICT_PRIVATE_BODY" }] },
    { source: { ...source, participantId: "another-agent" } },
    { requestVersion: 2 },
  ]) {
    const incoming = detail([request({ ...field, statusRevision: 99 })]);
    const result = mergeConversationDetailSnapshots(detail([request()]), incoming);
    assert.deepEqual(result.userInputs, [unavailable(request())]);
  }
});
test("answer same-version delivery conflict is unavailable, never guessed from time", () => {
  const incoming = detail([answer({ delivery: { status: "claimed", revision: 1, updatedAt: "2099-01-01T00:00:00.000Z" } })]);
  assert.deepEqual(mergeConversationDetailSnapshots(detail([answer()]), incoming).userInputs, [unavailable(answer())]);
});
test("accepted answer is immutable even when delivery revision increases", () => {
  const incoming = detail([answer({ answers: [{ ...answer().answers[0], text: "CONFLICT_PRIVATE_BODY" }], delivery: { status: "claimed", revision: 2, updatedAt: now } })]);
  assert.deepEqual(mergeConversationDetailSnapshots(detail([answer()]), incoming).userInputs, [unavailable(answer())]);
});
test("unavailable contains no old content and cannot be revived by a later stale merge", () => {
  const old = detail([request(), answer()]);
  const withdrawn = { ...old, userInputs: old.userInputs.map(unavailable) };
  const hidden = mergeConversationDetailSnapshots(old, withdrawn);
  const result = mergeConversationDetailSnapshots(hidden, old);
  assert.deepEqual(result.userInputs, old.userInputs.map(unavailable));
  assert.equal(JSON.stringify(result).includes("第一行"), false);
});
test("full snapshot omission removes known anchors and retains only content-free replay tombstones", () => {
  const old = detail([request(), answer()]);
  const hidden = mergeConversationDetailSnapshots(old, detail([]));
  assert.deepEqual(hidden.conversationItems, []);
  assert.deepEqual(hidden.userInputs, old.userInputs.map(unavailable));
  const replay = mergeConversationDetailSnapshots(hidden, old);
  assert.deepEqual(replay.conversationItems, []);
  assert.deepEqual(replay.userInputs, old.userInputs.map(unavailable));
  assert.equal(JSON.stringify(replay).includes("第一行"), false);
});
test("missing hydration field is partial data, not a visibility withdrawal", () => {
  const old = detail([request(), answer()]);
  const partial = detail([]);
  delete partial.userInputs;
  assert.deepEqual(mergeConversationDetailSnapshots(old, partial).userInputs, old.userInputs);
});
test("thread IDs reused in another workspace never union the old workspace", () => {
  const incoming = detail([], { thread: { ...detail().thread, workspaceId: "workspace-2" } });
  const merged = mergeConversationDetailSnapshots(detail([request(), answer()]), incoming);
  assert.deepEqual(merged.userInputs, []);
  assert.deepEqual(merged.conversationItems, []);
});
test("hydration is selected only by exact canonical identity, never by a matching question name", () => {
  const invalid = detail([request({ source: { ...source, workspaceId: "workspace-foreign" } })]);
  const result = mergeConversationDetailSnapshots(undefined, invalid);
  assert.deepEqual(result.userInputs, [unavailable(request())]);
  const missingAnchor = detail([request()], { conversationItems: [] });
  assert.deepEqual(mergeConversationDetailSnapshots(undefined, missingAnchor).userInputs, []);
});
test("only whitelisted fields survive; Markdown, option labels and line breaks are exact", () => {
  const input = request({ fenceToken: "INTERNAL_AUTHORITY", source: { ...source, claimToken: "INTERNAL_AUTHORITY" } });
  const result = mergeConversationDetailSnapshots(undefined, detail([input]));
  assert.deepEqual(result.userInputs, [request()]);
  assert.equal(JSON.stringify(result).includes("INTERNAL_AUTHORITY"), false);
});
test("channel page carries request and answer hydration without projecting extra messages", () => {
  const records = [request(), answer()];
  const page = projectChannelConversationItemPage({
    thread: detail().thread, items: records.map(record => anchor(record)), userInputs: records,
    turnContextAssignments: [], decorations: [], generatedMedia: [], hasMore: true, nextBeforeSequence: 10,
  });
  assert.deepEqual(page.userInputs, records);
  assert.deepEqual(page.messages, []);
  assert.deepEqual(page.conversationItems.map(x => x.sequence), [10, 12]);
  assert.equal(page.hasMore, true);
});

function page(records, options = {}) {
  return projectChannelConversationItemPage({ thread: detail().thread, items: records.map(record => anchor(record)),
    turnContextAssignments: [], userInputs: records, decorations: [], generatedMedia: [], hasMore: false, ...options });
}
test("request and answer data remain sorted by canonical sequence, not time or type", () => {
  const incoming = detail([answer({ acceptedAt: "2000-01-01T00:00:00.000Z" }), request()]);
  const merged = mergeConversationDetailSnapshots(undefined, incoming);
  assert.deepEqual(merged.userInputs.map(x => x.itemId), ["question-1", "answer-1"]);
});
test("page append does not withdraw an item outside the page", () => {
  const current = page([request()]);
  const older = page([answer()], { items: [anchor(answer(), 4)] });
  const merged = mergeChannelUserInputPage(current, older, 10);
  assert.deepEqual(merged.userInputs.map(x => x.itemId), ["answer-1", "question-1"]);
  assert.equal(merged.userInputs.every(x => x.availability === "available"), true);
});
test("filtered empty page withdraws only its Host cursor window", () => {
  const current = page([request(), answer()], { items: [anchor(request(), 4), anchor(answer(), 12)] });
  const filtered = page([], { hasMore: true, nextBeforeSequence: 3 });
  const merged = mergeChannelUserInputPage(current, filtered, 10);
  assert.deepEqual(merged.conversationItems.map(x => x.id), ["answer-1"]);
  assert.equal(merged.userInputs.find(x => x.itemId === "answer-1").availability, "available");
  assert.deepEqual(merged.userInputs.find(x => x.itemId === "question-1"), unavailable(request()));
  const stale = mergeChannelUserInputPage(merged, current);
  assert.equal(stale.conversationItems.some(x => x.id === "question-1"), false);
});
test("latest page refresh does not interpret older history as revoked", () => {
  const current = page([request(), answer()], { items: [anchor(request(), 4), anchor(answer(), 12)] });
  const latest = page([answer()], { hasMore: true, nextBeforeSequence: 10 });
  const merged = mergeChannelUserInputPage(current, latest);
  assert.equal(merged.userInputs.find(x => x.itemId === "question-1").availability, "available");
});
test("page missing hydration is not an empty authoritative page", () => {
  const current = page([request()]);
  const missing = page([]); delete missing.userInputs;
  assert.deepEqual(mergeChannelUserInputPage(current, missing).userInputs, current.userInputs);
});
test("same ID in a different channel thread does not reuse cached unavailable state", () => {
  const current = mergeChannelUserInputPage(page([request()]), page([]));
  const foreign = request({ source: { ...source, threadId: "thread-2" } });
  const incoming = page([foreign], { thread: { ...detail().thread, id: "thread-2" }, items: [{ ...anchor(foreign), threadId: "thread-2" }] });
  assert.equal(mergeChannelUserInputPage(current, incoming).userInputs[0].availability, "available");
});
test("explicit page mode never turns absence into a withdrawal", () => {
  const current = detail([request()]);
  const result = reconcileCanonicalUserInputs({ scope: source,
    current: { items: current.conversationItems, userInputs: current.userInputs }, incoming: { items: [], userInputs: [] }, mode: "page" });
  assert.deepEqual(result.userInputs, current.userInputs);
});
test("damaged visible hydration fails closed without guessing another request", () => {
  for (const broken of [request({ statusRevision: 0 }), request({ questions: null }), request({ status: "unknown" }),
    answer({ delivery: null }), answer({ delivery: { revision: NaN, status: "pending", updatedAt: now } })]) {
    const result = mergeConversationDetailSnapshots(undefined, detail([broken]));
    assert.deepEqual(result.userInputs, [unavailable(broken)]);
  }
});
test("duplicate canonical identity conflicts remain unavailable regardless of arrival order", () => {
  const input = detail([request()]);
  input.conversationItems.push({ ...input.conversationItems[0], sequence: 999 });
  for (const items of [input.conversationItems, [...input.conversationItems].reverse()]) {
    assert.deepEqual(mergeConversationDetailSnapshots(undefined, { ...input, conversationItems: items }).userInputs, [unavailable(request())]);
  }
});
test("per-item invalidation changes even when a different request owns the maximum revision", () => {
  const high = request({ itemId: "question-high", requestId: "request-high", statusRevision: 999 });
  const previous = [request(), high];
  const next = [request({ statusRevision: 2, status: "cancelled" }), high];
  assert.notEqual(userInputTranscriptRevisionSignature(previous), userInputTranscriptRevisionSignature(next));
  assert.equal(userInputTranscriptRevisionSignature(next), userInputTranscriptRevisionSignature([...next].reverse()));
  assert.notEqual(userInputTranscriptRevisionSignature([answer()]), userInputTranscriptRevisionSignature([answer({ delivery: { revision: 2, status: "claimed", updatedAt: now } })]));
  assert.notEqual(userInputTranscriptRevisionSignature([request()]), userInputTranscriptRevisionSignature([unavailable(request())]));
});
test("cancelled continuation preserves the accepted answer and obsolete delivery separately", () => {
  const incoming = detail([request({ status: "answered", statusRevision: 4 }), answer({ delivery: { status: "obsolete", revision: 3, updatedAt: now } })]);
  const result = mergeConversationDetailSnapshots(detail([request(), answer()]), incoming);
  assert.equal(result.userInputs[0].status, "answered");
  assert.equal(result.userInputs[1].delivery.status, "obsolete");
  assert.deepEqual(result.userInputs[1].answers, answer().answers);
});
test("an explicit fresh scoped read can recover unavailable data without weakening merge tombstones", () => {
  const old = detail([request()]);
  const hidden = mergeConversationDetailSnapshots(old, detail([]));
  assert.equal(mergeConversationDetailSnapshots(hidden, old).userInputs[0].availability, "unavailable");
  assert.equal(mergeConversationDetailSnapshots(undefined, old).userInputs[0].availability, "available");
});
test("full refresh fences an older page including previously unseen IDs", async () => {
  const epoch = createConversationReadEpoch();
  const oldTicket = epoch.begin("workspace-1/thread-1", "page");
  let release;
  const latePage = new Promise(resolve => { release = resolve; });
  let visible = [];
  const oldTask = latePage.then(items => { if (epoch.isCurrent(oldTicket)) visible = items; });
  const freshTicket = epoch.begin("workspace-1/thread-1");
  if (epoch.isCurrent(freshTicket)) visible = [];
  release(["PREVIOUSLY_UNSEEN_PRIVATE_ITEM"]);
  await oldTask;
  assert.deepEqual(visible, []);
});
test("read epochs do not reuse tokens after reset or A to B to A", () => {
  const epoch = createConversationReadEpoch();
  const a = epoch.begin("A");
  epoch.begin("B");
  const a2 = epoch.begin("A");
  assert.equal(epoch.isCurrent(a), false);
  assert.equal(epoch.isCurrent(a2), true);
  epoch.invalidate();
  const a3 = epoch.begin("A", "page");
  assert.equal(epoch.isCurrent(a2), false);
  assert.equal(epoch.isCurrent(a3), true);
});
test("page reads share the current full epoch but cannot revive a failed superseded full read", () => {
  const epoch = createConversationReadEpoch();
  const first = epoch.begin("A");
  const second = epoch.begin("A");
  // No success callback is needed: failure of second must not re-authorize first.
  const pageTicket = epoch.begin("A", "page");
  assert.equal(epoch.isCurrent(first), false);
  assert.equal(epoch.isCurrent(second), true);
  assert.equal(epoch.isCurrent(pageTicket), true);
});

test("private hydration never imports another participant even with internally matching anchors", () => {
  const input = detail([request(), answer()], { thread: { ...detail().thread, kind: "teammate_direct", teammateId: "qa" } });
  assert.deepEqual(mergeConversationDetailSnapshots(undefined, input).userInputs, [unavailable(request()), unavailable(answer())]);
});
test("question actor and accepted-answer user actor are checked independently", () => {
  for (const record of [request(), answer()]) {
    const input = detail([record]);
    input.conversationItems[0].actorType = "system";
    assert.deepEqual(mergeConversationDetailSnapshots(undefined, input).userInputs, [unavailable(record)]);
  }
});
test("actual detail projection invalidates on request and delivery updates without execution evidence", () => {
  const first = projectConversationDetailTimeline(detail([request(), answer()]));
  const second = projectConversationDetailTimeline(detail([request({ statusRevision: 2 }), answer()]));
  const third = projectConversationDetailTimeline(detail([request({ statusRevision: 2 }), answer({ delivery: { status: "claimed", revision: 2, updatedAt: now } })]));
  assert.notEqual(first.sourceRevision, second.sourceRevision);
  assert.notEqual(second.sourceRevision, third.sourceRevision);
  assert.deepEqual(first.terminalEvidence, []);
  assert.deepEqual(third.terminalEvidence, []);
  assert.equal(third.items.some(x => x.kind === "commandExecution"), false);
});

test("all detail topologies project the same Q/A grammar independently of ordinary messages", () => {
  for (const thread of [
    { kind: "conversation" },
    { kind: "teammate_direct", teammateId: source.participantId },
    { kind: "channel_discussion" },
    { kind: "channel_discussion", parentThreadId: "root" },
    { kind: "channel_discussion", parentThreadId: "root", forkedFromRunId: source.runId },
  ]) {
    const input = detail([request(), answer()]);
    Object.assign(input.thread, thread);
    assert.deepEqual(projectConversationDetailTimeline(input).items.map(x => x.kind), ["userInputRequest", "userInputAnswer"]);
  }
  const rows = projectConversationDetailTimeline(detail([request(), answer()])).items;
  assert.deepEqual(selectNormalTimelineItems(rows, []), rows);
});

test("private Q/A has its own anchor, not a mandatory legacy message ID", () => {
  const records = [request({ source: { ...source, workflowStepId: undefined } }),
    answer({ source: { ...source, workflowStepId: undefined } })];
  const input = detail(records);
  Object.assign(input.thread, { kind: "teammate_direct", teammateId: source.participantId });
  const canonical = projectConversationDetailTimeline(input);
  const scope = { messages: [], canonical, teammateId: source.participantId, directThreadId: "direct-thread",
    canonicalThreadId: source.threadId,
    runs: [{ id: source.runId, threadId: source.threadId, teammateId: source.participantId }],
    runLinks: [{ runId: source.runId, turnId: source.turnId }] };
  assert.equal(projectTeammatePrivateTimelineItems(scope).length, 2);
  assert.equal(projectTeammatePrivateTimelineItems({ ...scope, teammateId: "another" }).length, 0);
  assert.equal(projectTeammatePrivateTimelineItems({ ...scope, runs: [{ ...scope.runs[0], channelId: "foreign" }] }).length, 0);
});

test("shared question and answer copy never includes internal metadata or delivery claims", () => {
  const rows = projectConversationDetailTimeline(detail([request(), answer()])).items;
  assert.equal(userInputHistoryPresentation(rows[1]).copyText, answer().answers[0].text);
  assert.equal(userInputHistoryPresentation(rows[1]).labelKey, "user_input.delivery.pending");
  assert.ok(userInputHistoryPresentation(rows[0]).copyText.includes(request().questions[0].prompt));
  const hidden = projectConversationDetailTimeline(detail([unavailable(request()), unavailable(answer())], {
    conversationItems: [anchor(request()), anchor(answer())],
  })).items;
  assert.equal(hidden.length, 2);
  assert.ok(hidden.every(row => userInputHistoryPresentation(row).copyText === undefined));
});

test("saved, claimed, applied, failed and obsolete remain distinct read-only states", () => {
  for (const status of ["pending", "claimed", "applied", "failed", "obsolete"]) {
    const row = projectConversationDetailTimeline(detail([answer({ delivery: { status, revision: 3, updatedAt: now } })])).items[0];
    const view = userInputHistoryPresentation(row);
    assert.equal(view.labelKey, "user_input.delivery." + status);
    assert.equal(view.copyText, answer().answers[0].text);
    assert.notEqual(row.status, "succeeded");
  }
});

test("copied workspace IDs or changed surface owners do not carry another detail cache", () => {
  const current = detail([request(), answer()]);
  for (const incoming of [
    detail([], { cwd: "/private/tmp/another-workspace" }),
    detail([], { thread: { ...detail().thread, kind: "teammate_direct", teammateId: "qa" } }),
    detail([], { thread: { ...detail().thread, channelId: "another-channel" } }),
  ]) {
    const result = mergeConversationDetailSnapshots(current, incoming);
    assert.deepEqual(result.userInputs, []);
    assert.deepEqual(result.conversationItems, []);
  }
});
