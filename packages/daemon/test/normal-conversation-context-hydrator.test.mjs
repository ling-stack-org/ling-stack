import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// This pure source test does not require rebuilding daemon/core or touching a DB.
const sourceUrl = new URL("../src/features/conversations/normal-conversation-context-hydrator.ts", import.meta.url);
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === sourceUrl.href && specifier === "./narration-segments.js") {
      return nextResolve(new URL("../src/features/conversations/narration-segments.ts", import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { hydrateNormalConversationContext: hydrate } = await import(sourceUrl.href);
hook.deregister();

const firstAt = "2026-09-06T00:00:00.000Z";
const secondAt = "2026-09-06T00:01:00.000Z";
const thirdAt = "2026-09-06T00:02:00.000Z";

function fixture() {
  const thread = { id: "normal-thread", workspaceId: "workspace", kind: "conversation", teammateId: "ling_agent", status: "open" };
  const turn = (id, createdAt, sourceItemId) => ({
    id, workspaceId: thread.workspaceId, threadId: thread.id, teammateId: thread.teammateId,
    kind: "manual_followup", status: "succeeded", sourceItemId, title: id,
    userInstruction: id === "t1" ? "My project codename is amber-otter." : "What codename and plan did we agree?",
    createdByActor: "local-user", createdAt, updatedAt: createdAt,
  });
  const previousTurn = { ...turn("t1", firstAt, "u1"), lastRunId: "r1" };
  const sourceTurn = turn("t2", secondAt, "u2");
  const userItem = (owner, sequence) => ({
    schemaVersion: 1, id: owner.sourceItemId, workspaceId: owner.workspaceId, threadId: owner.threadId,
    turnId: owner.id, kind: "user_message", status: "committed", actorType: "local_user", visibility: "thread_participants",
    sequence, revision: 0, payload: { body: owner.userInstruction, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    domainRefs: [{ type: "turn", id: owner.id }], createdAt: owner.createdAt, updatedAt: owner.updatedAt,
  });
  const firstUser = userItem(previousTurn, 1);
  const sourceItem = userItem(sourceTurn, 3);
  const run = { id: "r1", threadId: thread.id, teammateId: thread.teammateId, status: "succeeded", createdAt: firstAt, updatedAt: firstAt,
    requestSnapshot: { threadId: thread.id, turnId: previousTurn.id, teammateId: thread.teammateId } };
  const event = (seq, type, data) => ({ id: `e${seq}`, runId: "r1", seq, type, data, ts: firstAt });
  const events = [
    event(1, "assistant_text_delta", { text: "We will ship the amber-otter parser." }),
    event(2, "message_end", { role: "assistant", text: "We will ship the amber-otter parser." }),
    event(3, "tool_start", { toolCallId: "read-1", toolName: "read", args: { path: "ignored-tool-path" } }),
    event(4, "message_end", { role: "toolResult", text: "TOOL_OUTPUT_IS_NOT_ASSISTANT_HISTORY" }),
    event(5, "message_end", { role: "assistant", text: "The agreed first step is syntax tests." }),
  ];
  return {
    thread, sourceTurn, sourceItem, turns: [previousTurn, sourceTurn], canonicalItems: [firstUser, sourceItem],
    runLinks: [{ turnId: previousTurn.id, runId: run.id, attemptNumber: 1, role: "primary", createdAt: firstAt }],
    runs: [run], eventsByRunId: new Map([[run.id, events]]),
    runEventWatermarks: [{ runId: run.id, throughEventSequence: 5, throughEventId: "e5" }],
    contextSegmentId: "normal-segment", turnContextAssignments: [],
    maxHistoryTextChars: 32_768,
  };
}

const texts = (snapshot) => snapshot.entries.map((entry) => entry.text);
const roles = (snapshot) => snapshot.entries.map((entry) => entry.role);
const assistantPayload = body => ({ body, format: "markdown", deliveryStatus: "ready", streaming: false, presentationRole: "narration" });

test("system sources are accepted only with matching Turn actors and stay context rather than user history", () => {
  const input = fixture();
  input.sourceItem.actorType = "system";
  input.sourceTurn.createdByActor = "system";
  assert.equal(hydrate(input).source.itemId, input.sourceItem.id);
  input.canonicalItems[0].actorType = "system";
  input.turns[0].createdByActor = "system";
  assert.deepEqual(roles(hydrate(input)), ["context", "assistant", "assistant"]);
  input.sourceTurn.createdByActor = "local-user";
  assert.throws(() => hydrate(input), /source scope mismatch/);
});

test("history cannot relabel a user as a system source or a system source as user guidance", () => {
  for (const [actorType, createdByActor] of [["system", "local-user"], ["local_user", "system"]]) {
    const input = fixture();
    input.canonicalItems[0].actorType = actorType;
    input.turns[0].createdByActor = createdByActor;
    const snapshot = hydrate(input);
    assert.equal(snapshot.entries.some((entry) => entry.origin === "canonical_item"), false);
    assert.ok(snapshot.diagnostics.some((entry) => entry.code === "ambiguous_history"));
  }
});

test("existing normal canonical user without assignment gains source-linked historical assistant context", () => {
  const input = fixture();
  const snapshot = hydrate(input);
  assert.deepEqual(roles(snapshot), ["user", "assistant", "assistant"]);
  assert.deepEqual(texts(snapshot), [input.turns[0].userInstruction, "We will ship the amber-otter parser.", "The agreed first step is syntax tests."]);
  assert.equal(snapshot.entries[0].origin, "canonical_item");
  assert.ok(snapshot.entries.slice(1).every((entry) => entry.origin === "run_narration" && entry.turnId === "t1"));
  assert.deepEqual(snapshot.runEventWatermarks, input.runEventWatermarks);
  assert.ok(snapshot.sourceRefs.some((ref) => ref.kind === "run_event" && ref.id === "e5" && ref.runId === "r1" && ref.sequence === 5));
  assert.equal(JSON.stringify(snapshot).includes("TOOL_OUTPUT_IS_NOT_ASSISTANT_HISTORY"), false);
  assert.equal(JSON.stringify(snapshot).includes("ignored-tool-path"), false);
  assert.equal(texts(snapshot).includes(input.sourceTurn.userInstruction), false, "Current user belongs to the task prompt exactly once");
  assert.ok(snapshot.entries.slice(1).every((entry) => !Object.hasOwn(entry, "sequence") && !Object.hasOwn(entry, "itemId")));
});

test("legacy normal history with no canonical item uses durable Turn instruction, never UI text", () => {
  const input = fixture();
  input.canonicalItems = [input.sourceItem];
  input.turns[0].sourceItemId = undefined;
  input.uiMessages = [{ role: "assistant", body: "FORGED_UI_CONTENT" }];
  const snapshot = hydrate(input);
  assert.equal(snapshot.entries[0].origin, "legacy_turn_user");
  assert.equal(snapshot.entries[0].text, input.turns[0].userInstruction);
  assert.equal(snapshot.entries[0].sourceRefs.some((ref) => ref.kind === "conversation_item"), false);
  assert.equal(JSON.stringify(snapshot).includes("FORGED_UI_CONTENT"), false);
  assert.equal(snapshot.entries.length, 3);
});

test("canonical replies outrank Run narration by exact Turn and Run identity, not body equality", () => {
  const input = fixture();
  input.canonicalItems.push({ ...input.canonicalItems[0], id: "canonical-a1", kind: "assistant_message", actorType: "ling_agent", sequence: 2,
    payload: assistantPayload("Canonical edited answer."), domainRefs: [{ type: "run", id: "r1" }] });
  const snapshot = hydrate(input);
  assert.deepEqual(texts(snapshot), [input.turns[0].userInstruction, "Canonical edited answer."]);
  assert.ok(snapshot.entries.every((entry) => entry.origin === "canonical_item"));
  assert.deepEqual(snapshot.runEventWatermarks, []);
});

test("canonical text outside the current watermark cannot suppress or replace historical narration", () => {
  const input = fixture();
  input.canonicalItems.push({ ...input.canonicalItems[0], id: "late-a1", kind: "assistant_message", actorType: "ling_agent", sequence: 4,
    payload: assistantPayload("LATE_CANONICAL_TEXT"), domainRefs: [{ type: "run", id: "r1" }] });
  const snapshot = hydrate(input);
  assert.equal(snapshot.entries.filter((entry) => entry.origin === "run_narration").length, 2);
  assert.equal(JSON.stringify(snapshot).includes("LATE_CANONICAL_TEXT"), false);
});

test("future or foreign supersessions cannot erase a frozen canonical reply", () => {
  for (const scenario of ["future", "foreign-thread", "foreign-author", "uncommitted", "duplicate"]) {
    const input = fixture();
    const answer = { ...input.canonicalItems[0], id: "answer", kind: "assistant_message", actorType: "ling_agent", sequence: 2,
      payload: assistantPayload("FROZEN_CANONICAL_REPLY"), domainRefs: [{ type: "run", id: "r1" }] };
    input.sourceItem.sequence = 5;
    const replacement = { ...answer, id: "replacement", sequence: 4, supersedesItemId: answer.id, payload: assistantPayload("INVALID_REPLACEMENT") };
    if (scenario === "future") replacement.sequence = 6;
    if (scenario === "foreign-thread") replacement.threadId = "foreign-thread";
    if (scenario === "foreign-author") replacement.actorType = "teammate";
    if (scenario === "uncommitted") replacement.status = "draft";
    input.canonicalItems.push(answer, replacement);
    if (scenario === "duplicate") input.canonicalItems.push({ ...replacement });
    assert.deepEqual(texts(hydrate(input)), [input.turns[0].userInstruction, "FROZEN_CANONICAL_REPLY"], scenario);
  }
});

test("frozen event watermark excludes later text and remains detached from mutable input", () => {
  const input = fixture();
  input.eventsByRunId.get("r1").push({ id: "e6", runId: "r1", seq: 6, ts: thirdAt, type: "message_end", data: { role: "assistant", text: "LATE_EVENT_TEXT" } });
  const snapshot = hydrate(input);
  const original = JSON.stringify(snapshot);
  input.eventsByRunId.get("r1")[0].data.text = "MUTATED_SOURCE_TEXT";
  input.canonicalItems[0].payload.body = "MUTATED_USER_TEXT";
  input.runEventWatermarks[0].throughEventSequence = 6;
  assert.equal(JSON.stringify(snapshot), original);
  assert.equal(original.includes("LATE_EVENT_TEXT"), false);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("event ordering and exact duplicate delivery do not change frozen history identity", () => {
  const input = fixture();
  const original = hydrate(input);
  input.eventsByRunId.set("r1", [...input.eventsByRunId.get("r1").reverse(), structuredClone(input.eventsByRunId.get("r1")[0])]);
  assert.deepEqual(hydrate(input), original);
  assert.ok(original.fingerprint.length >= 32);
});

test("ambiguous, missing, truncated or foreign event boundaries never publish assistant text", () => {
  for (const mutate of [
    (input) => { input.runEventWatermarks = []; },
    (input) => { input.runEventWatermarks.push({ ...input.runEventWatermarks[0], throughEventSequence: 4, throughEventId: "e4" }); },
    (input) => { input.runEventWatermarks[0].throughEventId = "missing-event"; },
    (input) => { input.eventsByRunId.get("r1")[1].runId = "foreign-run"; },
    (input) => { input.eventsByRunId.get("r1").splice(2, 1); },
    (input) => { input.eventsByRunId.get("r1").push({ ...input.eventsByRunId.get("r1")[1], id: "conflicting-event", data: { role: "assistant", text: "CONFLICT" } }); },
    (input) => { input.eventsByRunId.get("r1")[1].id = "e1"; },
  ]) {
    const input = fixture();
    mutate(input);
    const snapshot = hydrate(input);
    assert.deepEqual(roles(snapshot), ["user"]);
    assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "invalid_event_boundary"));
    assert.deepEqual(snapshot.runEventWatermarks, []);
  }
});

test("foreign source scopes are rejected before hydration", () => {
  for (const mutate of [
    (input) => { input.thread.kind = "teammate_direct"; },
    (input) => { input.sourceTurn.workspaceId = "foreign-workspace"; },
    (input) => { input.sourceTurn.teammateId = "foreign-agent"; },
    (input) => { input.sourceItem.threadId = "foreign-thread"; },
    (input) => { input.sourceItem.turnId = "foreign-turn"; },
    (input) => { input.sourceItem.visibility = "agent_private"; },
    (input) => { input.sourceItem.actorType = "teammate"; },
    (input) => { input.sourceTurn.sourceItemId = "unrelated-item"; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => hydrate(input), /Normal context source scope mismatch/);
  }
});

test("foreign or superseded historical owners cannot leak text or resurrect a prior reply", () => {
  for (const mutate of [
    (input) => { input.turns[0].workspaceId = "foreign-workspace"; },
    (input) => { input.turns[0].threadId = "foreign-thread"; },
    (input) => { input.turns[0].teammateId = "foreign-agent"; },
    (input) => { input.turns[0].channelId = "foreign-channel"; },
    (input) => { input.turns[0].workflowStepId = "foreign-step"; },
    (input) => { input.turns[0].status = "superseded"; },
    (input) => { input.supersededTurnIds = ["t1"]; },
    (input) => { input.turns[0].createdAt = thirdAt; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.deepEqual(hydrate(input).entries, []);
  }
});

test("selected Run must have one verified owner link and cannot fall back to an unrelated retry", () => {
  for (const mutate of [
    (input) => { input.runs[0].threadId = "foreign-thread"; },
    (input) => { input.runs[0].teammateId = "foreign-agent"; },
    (input) => { input.runs[0].channelId = "foreign-channel"; },
    (input) => { input.runs[0].requestSnapshot.turnId = "foreign-turn"; },
    (input) => { input.runLinks.push({ ...input.runLinks[0], turnId: "another-turn" }); },
    (input) => { input.runLinks.push({ ...input.runLinks[0] }); },
    (input) => { input.turns[0].lastRunId = "missing-run"; },
    (input) => { input.runs.push({ ...input.runs[0] }); },
    (input) => { input.turns[0].lastRunId = undefined; input.runLinks.push({ ...input.runLinks[0], runId: "retry-r1", attemptNumber: 2, role: "retry" }); },
  ]) {
    const input = fixture();
    mutate(input);
    const snapshot = hydrate(input);
    assert.deepEqual(roles(snapshot), ["user"]);
    assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "unverified_run_owner"));
  }
});

test("an explicit active retry excludes the old selected Run and its canonical answer", () => {
  const input = fixture();
  input.turns[0].activeRunId = "retry-r1";
  input.runLinks.push({ ...input.runLinks[0], runId: "retry-r1", attemptNumber: 2, role: "retry" });
  input.runs.push({ ...input.runs[0], id: "retry-r1" });
  input.eventsByRunId.set("retry-r1", [{ id: "retry-e1", runId: "retry-r1", seq: 1, ts: firstAt, type: "message_end", data: { role: "assistant", text: "Selected retry answer." } }]);
  input.runEventWatermarks.push({ runId: "retry-r1", throughEventSequence: 1, throughEventId: "retry-e1" });
  input.canonicalItems.push({ ...input.canonicalItems[0], id: "old-run-answer", kind: "assistant_message", actorType: "ling_agent", sequence: 2,
    payload: assistantPayload("OLD_RETRY_ANSWER"), domainRefs: [{ type: "run", id: "r1" }] });
  assert.deepEqual(texts(hydrate(input)), [input.turns[0].userInstruction, "Selected retry answer."]);
});

test("summary-covered Turn history cannot be reintroduced through Run events", () => {
  const input = fixture();
  input.contextSummaries = [{ id: "summary-1", threadId: input.thread.id, status: "active", version: 1,
    coveredFromSequence: 1, coveredThroughSequence: 1, sourceRefs: [{ type: "conversation_item", id: "u1" }, { type: "run", id: "r1" }], createdAt: firstAt,
    objective: "Keep the amber-otter parser plan.", decisions: [], constraints: [], openQuestions: [], activeWorkRefs: [] }];
  const snapshot = hydrate(input);
  assert.deepEqual(roles(snapshot), ["context"]);
  assert.equal(snapshot.entries[0].origin, "context_summary");
  assert.ok(snapshot.entries[0].text.includes("Keep the amber-otter parser plan."));
  assert.deepEqual(snapshot.runEventWatermarks, []);
});

test("shared projection exclusions and other segments cannot be bypassed by legacy hydration", () => {
  for (const scenario of ["other-segment", "canonical-omitted", "revoked-assignment", "conflicting-assignment"]) {
    const input = fixture();
    input.turnContextAssignments = [{ id: "assignment-t1", turnId: "t1", segmentId: "normal-segment", revision: 1, status: "committed" }];
    if (scenario === "other-segment") input.turnContextAssignments[0].segmentId = "other-segment";
    if (scenario === "canonical-omitted") input.canonicalItems = [input.sourceItem];
    if (scenario === "revoked-assignment") input.turnContextAssignments[0].status = "superseded";
    if (scenario === "conflicting-assignment") input.turnContextAssignments.push({ ...input.turnContextAssignments[0], id: "conflicting-assignment", segmentId: "other-segment" });
    assert.deepEqual(hydrate(input).entries, [], scenario);
  }
  const input = fixture();
  input.turnContextAssignments = [{ id: "assignment-t1", turnId: "t1", segmentId: "normal-segment", revision: 1, status: "committed" }];
  assert.equal(hydrate(input).entries.filter((entry) => entry.origin === "run_narration").length, 2, "An admitted same-segment Turn may fill its missing assistant");
});

test("an empty summary cannot erase history and a user-only summary cannot swallow an uncovered reply", () => {
  const input = fixture();
  const summary = { id: "empty-summary", threadId: input.thread.id, status: "active", version: 1,
    coveredFromSequence: 1, coveredThroughSequence: 1, sourceRefs: [{ type: "conversation_item", id: "u1" }], createdAt: firstAt,
    decisions: [], constraints: [], openQuestions: [], activeWorkRefs: [] };
  input.contextSummaries = [summary];
  assert.deepEqual(roles(hydrate(input)), ["user", "assistant", "assistant"]);
  summary.objective = "User codename is amber-otter.";
  assert.deepEqual(roles(hydrate(input)), ["context", "assistant", "assistant"]);
});

test("summary coverage of one canonical reply does not swallow another reply from the same Run", () => {
  const input = fixture();
  input.sourceItem.sequence = 6;
  const early = { ...input.canonicalItems[0], id: "early-answer", kind: "assistant_message", actorType: "ling_agent", sequence: 2,
    payload: assistantPayload("EARLY_REPLY"), domainRefs: [{ type: "run", id: "r1" }] };
  const later = { ...early, id: "later-answer", sequence: 4, payload: assistantPayload("UNCOVERED_LATER_REPLY") };
  input.canonicalItems.push(early, later);
  input.contextSummaries = [{ id: "early-summary", threadId: input.thread.id, status: "active", version: 1,
    coveredFromSequence: 1, coveredThroughSequence: 2, sourceRefs: [{ type: "conversation_item", id: early.id }], createdAt: firstAt,
    objective: "EARLY SUMMARY ONLY", decisions: [], constraints: [], openQuestions: [], activeWorkRefs: [] }];
  assert.deepEqual(texts(hydrate(input)), ["EARLY SUMMARY ONLY", input.turns[0].userInstruction, "UNCOVERED_LATER_REPLY"]);
});

test("foreign canonical authors cannot override a verified Run reply", () => {
  const input = fixture();
  input.canonicalItems.push({ ...input.canonicalItems[0], id: "foreign-author-answer", kind: "assistant_message", actorType: "teammate", actorId: "foreign-agent", sequence: 2,
    payload: assistantPayload("FOREIGN_CANONICAL_AUTHOR"), domainRefs: [{ type: "run", id: "r1" }] });
  const result = hydrate(input);
  assert.equal(result.entries.filter((entry) => entry.origin === "run_narration").length, 2);
  assert.equal(JSON.stringify(result).includes("FOREIGN_CANONICAL_AUTHOR"), false);
});

test("canonical users need a local-user actor and a verified Turn source pointer", () => {
  for (const scenario of ["actor", "source-pointer", "missing-source-pointer", "conflicting-turn-ref"]) {
    const input = fixture();
    input.canonicalItems[0].payload.body = "UNVERIFIED_USER_TEXT";
    if (scenario === "actor") input.canonicalItems[0].actorType = "teammate";
    if (scenario === "source-pointer") input.turns[0].sourceItemId = "another-user";
    if (scenario === "missing-source-pointer") input.turns[0].sourceItemId = undefined;
    if (scenario === "conflicting-turn-ref") input.canonicalItems[0].domainRefs = [{ type: "turn", id: "another-turn" }];
    assert.equal(texts(hydrate(input)).includes("UNVERIFIED_USER_TEXT"), false, scenario);
  }
  const input = fixture();
  input.canonicalItems.push({ ...input.canonicalItems[0], id: "edited-u1", sequence: 2, supersedesItemId: "u1", payload: { body: "Verified edited instruction." } });
  assert.equal(hydrate(input).entries[0].text, "Verified edited instruction.");
});

test("summary sources cannot reintroduce current, superseded or foreign history", () => {
  for (const scenario of ["current-item", "current-turn", "superseded-item", "superseded-turn", "foreign-item", "other-segment"]) {
    const input = fixture();
    const summary = { id: "invalid-source-summary", threadId: input.thread.id, status: "active", version: 1,
      coveredFromSequence: 1, coveredThroughSequence: 1, sourceRefs: [{ type: "conversation_item", id: "u1" }], createdAt: firstAt,
      objective: "INVALID_SUMMARY_TEXT", decisions: [], constraints: [], openQuestions: [], activeWorkRefs: [] };
    input.contextSummaries = [summary];
    if (scenario === "current-item") summary.sourceRefs = [{ type: "conversation_item", id: input.sourceItem.id }];
    if (scenario === "current-turn") summary.sourceRefs = [{ type: "turn", id: input.sourceTurn.id }];
    if (scenario === "superseded-item" || scenario === "superseded-turn") input.turns[0].status = "superseded";
    if (scenario === "superseded-turn") summary.sourceRefs = [{ type: "turn", id: "t1" }];
    if (scenario === "foreign-item") input.canonicalItems[0].threadId = "foreign-thread";
    if (scenario === "other-segment") summary.segmentId = "other-segment";
    const snapshot = hydrate(input);
    assert.equal(texts(snapshot).includes("INVALID_SUMMARY_TEXT"), false, scenario);
    assert.ok(snapshot.diagnostics.some((entry) => entry.code === "invalid_summary"), scenario);
  }
});

test("an admitted summary remains valid when the shared projector omits its covered canonical tail", () => {
  const input = fixture();
  input.turnContextAssignments = [{ id: "assignment-t1", turnId: "t1", segmentId: "normal-segment", revision: 1, status: "committed" }];
  input.canonicalItems = [input.sourceItem];
  input.contextSummaries = [{ id: "covered-summary", threadId: input.thread.id, status: "active", version: 1,
    coveredFromSequence: 1, coveredThroughSequence: 1, sourceRefs: [{ type: "turn", id: "t1" }, { type: "conversation_item", id: "u1" }, { type: "run", id: "r1" }], createdAt: firstAt,
    objective: "PRESERVE_ADMITTED_SUMMARY", decisions: [], constraints: [], openQuestions: [], activeWorkRefs: [] }];
  assert.deepEqual(texts(hydrate(input)), ["PRESERVE_ADMITTED_SUMMARY"]);
});

test("canonical and hydrated text consume one budget with whole-Turn omission diagnostics", () => {
  const input = fixture();
  const old = { ...input.turns[0], id: "old-turn", sourceItemId: "old-user", lastRunId: undefined,
    userInstruction: "x".repeat(100), createdAt: "2026-09-05T00:00:00.000Z" };
  input.turns.unshift(old);
  input.canonicalItems[0].sequence = 2;
  input.sourceItem.sequence = 4;
  input.canonicalItems.unshift({ ...input.canonicalItems[0], id: "old-user", turnId: old.id, sequence: 1,
    payload: { body: old.userInstruction }, domainRefs: [{ type: "turn", id: old.id }] });
  input.maxHistoryTextChars = 140;
  const snapshot = hydrate(input);
  assert.deepEqual(texts(snapshot), [input.turns[1].userInstruction, "We will ship the amber-otter parser.", "The agreed first step is syntax tests."]);
  assert.equal(snapshot.usedTextChars, texts(snapshot).join("").length);
  assert.ok(snapshot.usedTextChars <= input.maxHistoryTextChars);
  assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "budget_exceeded" && diagnostic.turnId === "old-turn"));
});

test("duplicate canonical or Turn identities fail closed instead of picking array order", () => {
  const duplicateTurn = fixture();
  duplicateTurn.turns.push({ ...duplicateTurn.turns[0], userInstruction: "AMBIGUOUS_USER" });
  assert.deepEqual(hydrate(duplicateTurn).entries, []);
  const duplicateCanonical = fixture();
  duplicateCanonical.canonicalItems.push({ ...duplicateCanonical.canonicalItems[0], payload: { body: "AMBIGUOUS_CANONICAL" } });
  assert.equal(texts(hydrate(duplicateCanonical)).some((text) => text.includes("AMBIGUOUS") || text.includes("My project codename")), false);
});
