import assert from "node:assert/strict";
import test from "node:test";
import { prepareNormalConversationInput } from "../dist/features/conversations/normal-conversation-input.js";
import { captureNormalConversationContext, readNormalConversationContext } from "../dist/features/conversations/normal-conversation-context.js";
import { acceptanceState, appendLegacyUser, appendUser, assertAccepted, assertNoPartialInput,
  at, fixture, inputIdentity, ownedRun, payload } from "./support/a13-normal-context-fixtures.mjs";

// Candidate regressions, not execution evidence. Root owns the separate fresh
// Core/Daemon build and isolated test lease. This file uses no Provider or tool.
// Keep the original turn-window file and its assertions unchanged.
const SNAPSHOT_BYTE_LIMIT = 2_000_000;

/** SQLite BINARY ordering compares UTF-8 bytes, not the process locale. */
function binaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** An attachment-only user body is legally empty; an unadorned empty body is not. */
function emptyPayload(f) {
  return { ...payload(""), fileRefs: [{ path: `${f.cwd}/a13-empty-owned.txt`, source: "explicit_text" }] };
}

/** Create a lawful pre-bootstrap source using only the same public producers. */
function emptyLegacy(f, id, now = at(1)) {
  const itemId = `conversation-user:${id}`;
  f.store.createLingTurn({ id, threadId: f.thread.id, teammateId: "ling_agent", sourceItemId: itemId,
    kind: "manual_followup", title: "A13 empty attachment-only source", userInstruction: "", createdByActor: "local-user" }, now);
  const item = f.store.appendConversationItem({ id: itemId, threadId: f.thread.id, turnId: id, kind: "user_message",
    actorType: "local_user", visibility: "thread_participants", payload: emptyPayload(f),
    domainRefs: [{ type: "turn", id }] }, now);
  return { turnId: id, item };
}

function emptyAssigned(f, id, now = at(100), domainRefs = [{ type: "turn", id }]) {
  return f.store.appendConversationUserTurn({ threadId: f.thread.id, turnId: id, itemId: `conversation-user:${id}`,
    title: "A13 empty attachment-only source", userInstruction: "", payload: emptyPayload(f), domainRefs,
    idempotencyKey: `a13-streaming:${id}` }, now);
}

function capture(f, source, maxHistoryTextChars) {
  return captureNormalConversationContext({ store: f.store, threadId: f.thread.id,
    sourceItemId: source.item.id, ...(maxHistoryTextChars === undefined ? {} : { maxHistoryTextChars }) });
}

function accept(f, { key, attachmentIds = [], now = at(10_000) }) {
  return prepareNormalConversationInput({ store: f.store, thread: f.thread, title: "A13 streaming current input",
    message: "A13_STREAMING_CURRENT_END", attachmentIds, fileRefs: [], idempotencyKey: key, now });
}

/** Compare actual retained identities and references, not just row counts. */
function expectCanonicalUsers(captured, sources) {
  assert.deepEqual(captured.hydration.entries.filter((entry) => entry.role === "user" && entry.text !== "").map((entry) => ({
    origin: entry.origin, turnId: entry.turnId, text: entry.text, sourceRefs: entry.sourceRefs,
  })), sources.map((source) => ({ origin: "canonical_item", turnId: source.turnId, text: source.item.payload.body,
    sourceRefs: [{ kind: "conversation_item", id: source.item.id, sequence: source.item.sequence, revision: source.item.revision }] })));
  assert.deepEqual(readNormalConversationContext(JSON.parse(JSON.stringify(captured))), captured);
}

/** The full-input oracle makes no assumptions about the collector's scan order. */
function wholeUserOracle(sources, budget) {
  let remaining = budget;
  const selected = [];
  const ordered = [...sources].sort((left, right) => binaryCompare(right.item.createdAt, left.item.createdAt)
    || binaryCompare(right.turnId, left.turnId));
  for (const source of ordered) {
    if (source.item.payload.body.length > remaining) continue;
    remaining -= source.item.payload.body.length;
    selected.push(source);
  }
  return selected.reverse();
}

function assertMetadataFailure(error) {
  assert.ok(error, "must reject the oversized context instead of silently dropping lineage");
  assert.match(String(error), /(?:metadata|snapshot|context).*(?:byte|size|budget|limit|large|bound)|(?:byte|size|budget|limit).*(?:metadata|snapshot|context)/i,
    "must reach the metadata byte limit, not an unrelated Turn guard or invalid fixture");
  assert.doesNotMatch(String(error), /bounded Turn window/i);
}

test("A13 S01: reverse updatedAt traversal cannot lose the creation-ordered A4 + C6 budget result", async (t) => {
  const f = await fixture(t);
  const a = appendLegacyUser(f, { id: "a13-budget-A", body: "AAAA", now: at(1) });
  const b = appendLegacyUser(f, { id: "a13-budget-B", body: "BBBBBBB", now: at(2) });
  const c = appendLegacyUser(f, { id: "a13-budget-C", body: "CCCCCC", now: at(3) });
  // A legitimate status reconciliation changes updatedAt without changing creation.
  for (const [source, tick] of [[a, 90], [b, 80], [c, 70]]) f.store.reconcileLingTurnStatus(source.turnId, at(tick));
  const source = appendUser(f, 1, { id: "a13-budget-source", body: "S", now: at(100) });
  assert.deepEqual(f.store.listLingTurns({ threadId: f.thread.id, limit: 20 })
    .filter((turn) => turn.id !== source.turnId).map((turn) => turn.id), [a.turnId, b.turnId, c.turnId]);
  const captured = capture(f, source, 10);
  const expected = wholeUserOracle([a, b, c], 10);
  assert.deepEqual(expected.map((entry) => entry.turnId), [a.turnId, c.turnId]);
  expectCanonicalUsers(captured, expected);
  assert.equal(captured.hydration.usedTextChars, 10);
  assert.equal(f.store.getConversationItem(b.item.id).payload.body, "BBBBBBB");
});

test("A13 S02: equal-createdAt legacy pages use SQLite BINARY ID order without gaps or duplicates", async (t) => {
  const f = await fixture(t);
  const punctuation = ["!", "-", "A", "Z", "_", "a", "z", "~"];
  const legacy = Array.from({ length: 503 }, (_, index) => {
    const id = `a13-tie-${punctuation[index % punctuation.length]}-${String(index).padStart(4, "0")}`;
    return appendLegacyUser(f, { id, body: `A13_BINARY_${id}_END`, now: at(1) });
  });
  const source = appendUser(f, 1, { id: "a13-tie-source", body: "S", now: at(100) });
  const expected = [...legacy].sort((left, right) => binaryCompare(left.turnId, right.turnId));
  assert.notDeepEqual(expected.map((entry) => entry.turnId), [...legacy]
    .sort((left, right) => left.turnId.localeCompare(right.turnId)).map((entry) => entry.turnId),
  "the fixture must distinguish BINARY from locale collation");
  const captured = capture(f, source, 256_000);
  expectCanonicalUsers(captured, expected);
  assert.equal(new Set(captured.hydration.entries.map((entry) => entry.turnId)).size, 503);
  assert.equal(acceptanceState(f).turns, 504);
  for (const selected of [expected[0], expected[499], expected.at(-1)]) {
    assert.equal(captured.hydration.entries.filter((entry) => entry.turnId === selected.turnId).length, 1);
  }
});

test("A13 S03: assigned and legacy streams interleave under one whole-group budget, not separate allowances", async (t) => {
  const f = await fixture(t);
  const a = appendLegacyUser(f, { id: "a13-merge-A", body: "AAAA", now: at(1) });
  const b = appendLegacyUser(f, { id: "a13-merge-B", body: "BBBBBBB", now: at(2) });
  const c = appendLegacyUser(f, { id: "a13-merge-C", body: "CCCCCC", now: at(3) });
  const bootstrap = emptyAssigned(f, "a13-merge-bootstrap");
  f.store.applyTurnContextAssignment({ turnId: b.turnId, target: { kind: "existing", segmentId: bootstrap.contextSegmentId },
    status: "committed", decisionSource: "user", policyVersion: "a13-streaming-same-segment", evidenceRefs: [] }, at(101));
  assert.equal(f.store.getEffectiveTurnContextAssignment(a.turnId), undefined);
  assert.equal(f.store.getEffectiveTurnContextAssignment(c.turnId), undefined);
  assert.equal(f.store.getEffectiveTurnContextAssignment(b.turnId).segmentId, bootstrap.contextSegmentId);
  const source = appendUser(f, 1, { id: "a13-merge-source", body: "S", now: at(200) });
  const captured = capture(f, source, 10);
  expectCanonicalUsers(captured, wholeUserOracle([a, b, c], 10));
  assert.equal(captured.hydration.usedTextChars, 10);
  assert.equal(captured.hydration.entries.some((entry) => entry.turnId === b.turnId), false);
  assert.ok(captured.hydration.diagnostics.some((diagnostic) => diagnostic.code === "budget_exceeded" && diagnostic.turnId === b.turnId),
    "assigned omissions retain exact Turn diagnostics");
});

test("A13 S04: an oversized newer multi-entry group does not truncate code or prevent a smaller older group", async (t) => {
  const f = await fixture(t);
  const old = appendLegacyUser(f, { id: "a13-whole-old", body: "A13_OLD_USER_END", now: at(1) });
  const code = "```js\nconst whole = 'A13_OLD_CODE_END';\n```";
  const oldRun = ownedRun(f, old, { body: code, canonical: true });
  const large = appendLegacyUser(f, { id: "a13-whole-large", body: "u".repeat(600), now: at(2) });
  ownedRun(f, large, { body: `A13_LARGE_REPLY_END${"x".repeat(600)}`, canonical: true });
  const source = appendUser(f, 1, { id: "a13-whole-source", body: "S", now: at(100) });
  const captured = capture(f, source, 1_024);
  assert.deepEqual(captured.hydration.entries.map((entry) => [entry.turnId, entry.role, entry.text]),
    [[old.turnId, "user", old.item.payload.body], [old.turnId, "assistant", code]]);
  assert.equal(captured.hydration.entries[1].sourceRefs[0].id, oldRun.item.id);
  assert.equal(captured.renderedHistory.includes("A13_LARGE_REPLY_END"), false);
  assert.equal(captured.hydration.entries.some((entry) => entry.turnId === large.turnId), false);
  assert.equal(captured.hydration.usedTextChars, old.item.payload.body.length + code.length);
  assert.deepEqual(readNormalConversationContext(JSON.parse(JSON.stringify(captured))), captured);
});

test("A13 S05: deep legacy deny signals are not revived as Turn text or RunEvents after pagination", async (t) => {
  const f = await fixture(t);
  const allowed = appendLegacyUser(f, { id: "a13-000-allowed", body: "A13_DEEP_ALLOWED_USER_END", now: at(1) });
  const allowedRun = ownedRun(f, allowed, { body: "A13_DEEP_ALLOWED_REPLY_END" });
  const hiddenUser = appendLegacyUser(f, { id: "a13-001-hidden-user", body: "A13_HIDDEN_USER_FALLBACK_END", now: at(1) });
  f.store.appendConversationItem({ id: "a13-hidden-user-correction", threadId: f.thread.id, turnId: hiddenUser.turnId,
    kind: "user_message", actorType: "local_user", visibility: "operator", payload: payload("A13_HIDDEN_USER_BODY_END"),
    domainRefs: [{ type: "turn", id: hiddenUser.turnId }], supersedesItemId: hiddenUser.item.id }, at(2));
  const hiddenUserRun = ownedRun(f, hiddenUser, { body: "A13_HIDDEN_USER_RUN_END" });
  const hiddenReply = appendLegacyUser(f, { id: "a13-002-hidden-reply", body: "A13_VISIBLE_HIDDEN_REPLY_OWNER_END", now: at(1) });
  const hiddenReplyRun = ownedRun(f, hiddenReply, { body: "A13_HIDDEN_REPLY_REPLAY_END", canonical: true, visibility: "operator" });
  const wrongOwner = appendLegacyUser(f, { id: "a13-003-wrong-owner", body: "A13_WRONG_RUN_OWNER_USER_END", now: at(1) });
  const wrongOwnerRun = ownedRun(f, wrongOwner, { body: "A13_WRONG_RUN_OWNER_REPLY_END" });
  // Deliberate corruption of this fixture-owned row tests request-lineage rejection.
  f.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(
    JSON.stringify({ threadId: f.thread.id, turnId: allowed.turnId, providerPresetId: "fixture", tools: ["read"] }), wrongOwnerRun.run.id);
  const interventionId = "a13-004-intervention";
  const interventionItemId = `conversation-user:${interventionId}`;
  f.store.createLingTurn({ id: interventionId, threadId: f.thread.id, teammateId: "ling_agent", sourceItemId: interventionItemId,
    kind: "manual_followup", title: "A13 intervention", userInstruction: "A13_INTERVENTION_FALLBACK_END",
    interventionId: "a13-fixture-intervention", createdByActor: "local-user" }, at(1));
  const interventionItem = f.store.appendConversationItem({ id: interventionItemId, threadId: f.thread.id, turnId: interventionId,
    kind: "user_message", actorType: "local_user", visibility: "thread_participants", payload: payload("A13_INTERVENTION_USER_END"),
    domainRefs: [{ type: "turn", id: interventionId }] }, at(1));
  const interventionRun = ownedRun(f, { turnId: interventionId, item: interventionItem }, { body: "A13_INTERVENTION_REPLY_END" });
  for (let index = 0; index < 501; index += 1) emptyLegacy(f, `a13-z-deep-padding-${String(index).padStart(4, "0")}`, at(3));
  const source = appendUser(f, 1, { id: "a13-deep-source", body: "S", now: at(100) });
  const reads = [];
  const listEvents = f.store.listEvents.bind(f.store);
  f.store.listEvents = (runId, options) => { reads.push(runId); return listEvents(runId, options); };
  const captured = capture(f, source);
  assert.ok(captured.renderedHistory.includes("A13_DEEP_ALLOWED_USER_END"));
  assert.ok(captured.renderedHistory.includes("A13_DEEP_ALLOWED_REPLY_END"), "positive control must reach the deep legacy page");
  assert.ok(reads.includes(allowedRun.run.id));
  for (const marker of ["A13_HIDDEN_USER_FALLBACK_END", "A13_HIDDEN_USER_BODY_END", "A13_HIDDEN_USER_RUN_END",
    "A13_HIDDEN_REPLY_REPLAY_END", "A13_WRONG_RUN_OWNER_REPLY_END", "A13_INTERVENTION_FALLBACK_END",
    "A13_INTERVENTION_USER_END", "A13_INTERVENTION_REPLY_END"]) assert.equal(captured.renderedHistory.includes(marker), false, marker);
  for (const runId of [hiddenUserRun.run.id, hiddenReplyRun.run.id, interventionRun.run.id]) assert.equal(reads.includes(runId), false, runId);
  assert.equal(captured.hydration.entries.some((entry) => entry.turnId === hiddenUser.turnId || entry.turnId === interventionId), false);
  assert.equal(captured.hydration.runEventWatermarks.some((mark) => mark.runId === wrongOwnerRun.run.id), false);
  assert.deepEqual(readNormalConversationContext(JSON.parse(JSON.stringify(captured))), captured);
});

test("A13 S06: the 50K event allowance is shared across legacy groups and 50,001 rolls back input before safe retry", async (t) => {
  const f = await fixture(t);
  const older = appendLegacyUser(f, { id: "a13-events-old", body: "A13_EVENTS_OLD_USER_END", now: at(1) });
  const newer = appendLegacyUser(f, { id: "a13-events-new", body: "A13_EVENTS_NEW_USER_END", now: at(2) });
  const replies = [ownedRun(f, older, { body: "A13_EVENTS_OLD_REPLY_END" }), ownedRun(f, newer, { body: "A13_EVENTS_NEW_REPLY_END" })];
  for (const reply of replies) {
    // The public event producer retains the real SQLite prefix and event-log file.
    for (let count = 1; count < 25_000; count += 1) f.store.appendEvent(reply.run.id, "progress", { message: "" });
    assert.equal(f.store.countEvents(reply.run.id), 25_000);
  }
  const source = appendUser(f, 1, { id: "a13-events-source", body: "S", now: at(100) });
  const exact = capture(f, source);
  assert.deepEqual(exact.hydration.runEventWatermarks.map((mark) => [mark.runId, mark.throughEventSequence]),
    replies.map((reply) => [reply.run.id, 25_000]));
  for (const reply of replies) assert.ok(exact.renderedHistory.includes(reply.event.data.text));
  f.store.appendEvent(replies[1].run.id, "progress", { message: "A13_EVENT_50001_END" });
  const attachment = f.store.createConversationAttachment({ kind: "file", fileName: "a13-event-limit.txt", contentType: "text/plain",
    sizeBytes: 1, path: `${f.cwd}/a13-event-limit.txt` });
  const beforeAttachment = f.store.getConversationAttachment(attachment.id);
  const before = acceptanceState(f);
  const identity = inputIdentity(f.thread, "event-limit");
  let failure;
  try { accept(f, { key: "event-limit", attachmentIds: [attachment.id] }); } catch (error) { failure = error; }
  assertNoPartialInput(f, identity, before);
  assert.deepEqual(f.store.getConversationAttachment(attachment.id), beforeAttachment);
  assert.match(String(failure), /bounded event window/i, "a per-group reset would incorrectly accept 50,001 total events");
  assert.equal(f.store.countEvents(replies[0].run.id) + f.store.countEvents(replies[1].run.id), 50_001);
  // Add lawful canonical narration instead of deleting an immutable event to retry.
  f.store.appendConversationItem({ id: "a13-events-canonical-old", threadId: f.thread.id, turnId: older.turnId,
    kind: "assistant_message", actorType: "ling_agent", actorId: "ling_agent", visibility: "thread_participants",
    payload: { body: replies[0].event.data.text, format: "markdown", streaming: false, deliveryStatus: "ready", presentationRole: "narration" },
    domainRefs: [{ type: "turn", id: older.turnId }, { type: "run", id: replies[0].run.id }] }, at(101));
  const retried = accept(f, { key: "event-limit", attachmentIds: [attachment.id] });
  assertAccepted(f, retried, "A13_STREAMING_CURRENT_END", 4);
  assert.equal(retried.turn.id, identity.turnId);
  assert.equal(f.store.getConversationAttachment(attachment.id).turnId, identity.turnId);
  assert.equal(retried.context.hydration.runEventWatermarks.some((mark) => mark.runId === replies[0].run.id), false);
  assert.equal(retried.context.hydration.runEventWatermarks.find((mark) => mark.runId === replies[1].run.id).throughEventSequence, 25_001);
});

test("A13 S07: zero-text large refs consume UTF-8 snapshot bytes and acceptance rolls back before a lawful corrected retry", async (t) => {
  const f = await fixture(t);
  const refs = Array.from({ length: 800 }, (_, index) => ({ type: "task",
    id: `s${String(index).padStart(4, "0")}:${"界".repeat(500)}`, label: "证".repeat(512) }));
  const serializedRefs = JSON.stringify(refs);
  assert.ok(serializedRefs.length < SNAPSHOT_BYTE_LIMIT, "the fixture must not accidentally test only a character cap");
  assert.ok(Buffer.byteLength(serializedRefs, "utf8") > SNAPSHOT_BYTE_LIMIT);
  const historical = emptyAssigned(f, "a13-metadata-large-refs", at(100), [{ type: "turn", id: "a13-metadata-large-refs" }, ...refs]);
  assert.equal(historical.item.payload.body.length, 0);
  const attachment = f.store.createConversationAttachment({ kind: "file", fileName: "a13-metadata.txt", contentType: "text/plain",
    sizeBytes: 1, path: `${f.cwd}/a13-metadata.txt` });
  const beforeAttachment = f.store.getConversationAttachment(attachment.id);
  const before = acceptanceState(f);
  const identity = inputIdentity(f.thread, "metadata-refs");
  let failure;
  try { accept(f, { key: "metadata-refs", attachmentIds: [attachment.id] }); } catch (error) { failure = error; }
  assertNoPartialInput(f, identity, before);
  assert.deepEqual(f.store.getConversationAttachment(attachment.id), beforeAttachment);
  assertMetadataFailure(failure);
  const replacement = f.store.appendConversationItem({ id: "a13-metadata-safe-replacement", threadId: f.thread.id, turnId: historical.turnId,
    kind: "user_message", actorType: "local_user", visibility: "thread_participants", payload: payload("A13_SAFE_REPLACEMENT_END"),
    domainRefs: [{ type: "turn", id: historical.turnId }], supersedesItemId: historical.item.id }, at(101));
  const retried = accept(f, { key: "metadata-refs", attachmentIds: [attachment.id] });
  assertAccepted(f, retried, "A13_STREAMING_CURRENT_END", 2);
  assert.equal(retried.turn.id, identity.turnId);
  assert.equal(f.store.getConversationAttachment(attachment.id).turnId, identity.turnId);
  assert.equal(retried.context.hydration.entries.find((entry) => entry.turnId === historical.turnId).sourceRefs[0].id, replacement.id);
  assert.equal(retried.context.projection.sourceRefs.some((ref) => ref.id === refs[0].id), false);
  assert.ok(Buffer.byteLength(JSON.stringify(retried.context), "utf8") <= SNAPSHOT_BYTE_LIMIT);
  assert.equal(f.store.getConversationItem(historical.item.id).domainRefs.length, refs.length + 1,
    "correction must not mutate or delete the old durable source");
});

test("A13 S08: many valid empty legacy groups cannot bypass retained-metadata bytes and leave partial bootstrap facts", async (t) => {
  const f = await fixture(t);
  const legacyCount = 1_500;
  const legacy = [];
  for (let index = 0; index < legacyCount; index += 1) {
    const id = `a13-empty-${String(index).padStart(4, "0")}-${"x".repeat(440)}`;
    legacy.push(emptyLegacy(f, id));
  }
  assert.equal(f.store.listContextSegments({ threadId: f.thread.id, limit: 200 }).length, 0);
  assert.ok(legacy.every((source) => source.item.payload.body.length === 0));
  const before = acceptanceState(f);
  const identity = inputIdentity(f.thread, "empty-metadata");
  let failure;
  try { accept(f, { key: "empty-metadata" }); } catch (error) { failure = error; }
  assertNoPartialInput(f, identity, before);
  assertMetadataFailure(failure);
  assert.equal(f.store.listContextSegments({ threadId: f.thread.id, limit: 200 }).length, 0,
    "first-input metadata rejection must roll back the newly created bootstrap segment too");
  // An explicit new segment is a lawful scope change, not silent lineage trimming.
  const bootstrap = appendUser(f, 1, { id: "a13-empty-safe-bootstrap", body: "A13_EMPTY_NEW_SCOPE_END", now: at(100) });
  f.store.applyTurnContextAssignment({ turnId: bootstrap.turnId, target: { kind: "new", state: "active" },
    status: "committed", decisionSource: "user", policyVersion: "a13-explicit-safe-scope", evidenceRefs: [] }, at(101));
  const retried = accept(f, { key: "empty-metadata" });
  assertAccepted(f, retried, "A13_STREAMING_CURRENT_END", legacyCount + 2);
  assert.equal(retried.turn.id, identity.turnId);
  assert.equal(retried.context.hydration.entries.some((entry) => entry.turnId.startsWith("a13-empty-000")), false);
  assert.ok(retried.context.renderedHistory.includes("A13_EMPTY_NEW_SCOPE_END"));
  assert.ok(Buffer.byteLength(JSON.stringify(retried.context), "utf8") <= SNAPSHOT_BYTE_LIMIT);
  for (const source of [legacy[0], legacy.at(-1)]) assert.equal(f.store.getConversationItem(source.item.id).payload.body, "");
});
