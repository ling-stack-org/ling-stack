import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { prepareNormalConversationInput } from "../dist/features/conversations/normal-conversation-input.js";
import { captureNormalConversationContext, readNormalConversationContext,
  renderNormalConversationRunPrompt } from "../dist/features/conversations/normal-conversation-context.js";
import { createNormalConversationThreadFork } from "../dist/features/conversations/normal-conversation-fork.js";
import { saveNormalConversationPreparedRequest } from "../dist/features/conversations/normal-conversation-prepared-request.js";
import { acceptanceState, appendLegacyUser, appendUser, assertAccepted, assertNoPartialInput,
  at, commitSummary, fixture, inputIdentity, ownedRun, seedUsers, userText } from "./support/a13-normal-context-fixtures.mjs";

// Test-only preparation. Running this file requires Root's separate isolated
// execution lease and fresh Core/Daemon dist; no provider or actual tool is used.
// Set LING_A13_KEEP_FIXTURES=1 in that owned run to retain SQLite/rollback evidence;
// each fixture reports its exact mkdtemp path and still closes both connections.
function accept(f, { thread = f.thread, key = "current", body = "A13_CURRENT_INPUT_END", attachmentIds = [], now = at(10_000) } = {}) {
  return prepareNormalConversationInput({ store: f.store, thread, title: body, message: body,
    attachmentIds, fileRefs: [], idempotencyKey: key, now });
}

/** Preserve rollback diagnostics while still failing on the actual admission error. */
function acceptOrVerifyRollback(f, options = {}) {
  const before = acceptanceState(f);
  try { return accept(f, options); }
  catch (error) {
    assertNoPartialInput(f, inputIdentity(f.thread, options.key ?? "current"), before);
    throw error;
  }
}

function occurrences(text, marker) { return text.split(marker).length - 1; }

test("A13 T01: the 499th real accepted input is a valid control with exact frozen history", async (t) => {
  const f = await fixture(t);
  const sources = seedUsers(f, 498);
  const current = acceptOrVerifyRollback(f);
  assertAccepted(f, current, "A13_CURRENT_INPUT_END", 499);
  assert.equal(current.context.hydration.entries.filter((entry) => entry.role === "user").length, 498);
  for (const source of sources) assert.equal(occurrences(current.context.renderedHistory, source.item.payload.body), 1);
});

test("A13 T02: the 500th real input must not be rejected by whole-thread row count", async (t) => {
  const f = await fixture(t);
  seedUsers(f, 499);
  const current = acceptOrVerifyRollback(f);
  assertAccepted(f, current, "A13_CURRENT_INPUT_END", 500);
  assert.equal(current.context.hydration.entries.filter((entry) => entry.role === "user").length, 499);
  for (const index of [1, 250, 499]) assert.equal(occurrences(current.context.renderedHistory, userText(index)), 1);
});

test("A13 T03: independent 501st input and subsequent same-thread input preserve the admitted tail", async (t) => {
  const f = await fixture(t);
  seedUsers(f, 500);
  const current = acceptOrVerifyRollback(f);
  assertAccepted(f, current, "A13_CURRENT_INPUT_END", 501);
  assert.ok(current.context.renderedHistory.includes(userText(500)));
  assert.equal(current.context.hydration.entries.filter((entry) => entry.role === "user").length, 499,
    "the existing 500-item projector includes current source, not every historical Turn");
  const next = acceptOrVerifyRollback(f, { key: "after-501", body: "A13_AFTER_501_END", now: at(10_001) });
  assertAccepted(f, next, "A13_AFTER_501_END", 502);
  assert.equal(occurrences(next.context.renderedHistory, "A13_CURRENT_INPUT_END"), 1);
  assert.equal(f.store.getConversationItem(current.turn.sourceItemId).payload.body, "A13_CURRENT_INPUT_END");
});

test("A13 T04: a fresh fenced summary admits a long thread without reviving covered raw text", async (t) => {
  const f = await fixture(t);
  const sources = seedUsers(f, 500);
  const summary = commitSummary(f, sources.slice(0, 450));
  const current = acceptOrVerifyRollback(f);
  assertAccepted(f, current, "A13_CURRENT_INPUT_END", 501);
  assert.deepEqual(current.context.projection.summaryIds, [summary.id]);
  const summaries = current.context.hydration.entries.filter((entry) => entry.origin === "context_summary");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].summaryId, summary.id);
  assert.equal(occurrences(current.context.renderedHistory, "A13_FRESH_SUMMARY_END"), 1);
  for (let index = 1; index <= 450; index += 1) assert.equal(current.context.renderedHistory.includes(userText(index)), false);
  for (let index = 451; index <= 500; index += 1) assert.equal(occurrences(current.context.renderedHistory, userText(index)), 1);
  assert.equal(f.store.getConversationContextSummary(summary.id).status, "active");
  assert.equal(f.store.getConversationItem(sources[0].item.id).payload.body, userText(1));
});

test("A13 T05: a long parent segment never contaminates a newer segment or triggers its event reads", async (t) => {
  const f = await fixture(t);
  const sources = seedUsers(f, 500);
  const denied = ownedRun(f, sources[0], { canonical: true, visibility: "operator", body: "A13_HIDDEN_SEGMENT_REPLY_END" });
  const oldSegmentId = f.store.getEffectiveTurnContextAssignment(sources[0].turnId).segmentId;
  const moved = f.store.applyTurnContextAssignment({ turnId: sources.at(-1).turnId, target: { kind: "new", state: "active" },
    status: "committed", decisionSource: "user", policyVersion: "a13-new-segment", evidenceRefs: [] }, at(3_000));
  const newSegmentId = moved.assignment.segmentId;
  assert.notEqual(newSegmentId, oldSegmentId);
  const foreign = f.store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "A13 foreign", objective: "Not admitted" }, at(0));
  const foreignSource = appendUser(f, 1, { thread: foreign, id: "a13-foreign", body: "A13_FOREIGN_THREAD_END" });
  const foreignRun = ownedRun(f, foreignSource, { body: "A13_FOREIGN_REPLY_END" });
  const listEvents = f.store.listEvents.bind(f.store);
  const reads = [];
  f.store.listEvents = (runId, options) => { reads.push(runId); return listEvents(runId, options); };
  const current = acceptOrVerifyRollback(f);
  assertAccepted(f, current, "A13_CURRENT_INPUT_END", 501);
  assert.equal(current.context.projection.segmentId, newSegmentId);
  assert.equal(occurrences(current.context.renderedHistory, userText(500)), 1);
  for (const marker of [userText(1), "A13_HIDDEN_SEGMENT_REPLY_END", "A13_FOREIGN_THREAD_END", "A13_FOREIGN_REPLY_END"]) {
    assert.equal(current.context.renderedHistory.includes(marker), false, marker);
  }
  assert.equal(reads.includes(denied.run.id), false);
  assert.equal(reads.includes(foreignRun.run.id), false);
});

test("A13 T06: lawful equal-updatedAt legacy history beyond the first page is not lost by a timestamp cursor", async (t) => {
  const f = await fixture(t);
  const legacy = appendLegacyUser(f);
  const reply = ownedRun(f, legacy, { body: "A13_DEEP_LEGACY_REPLY_END", terminal: true, finishAt: at(100) });
  seedUsers(f, 501, { sameAt: at(100) });
  const bootstrap = f.store.listContextSegments({ threadId: f.thread.id, limit: 200 });
  assert.equal(bootstrap.length, 1);
  assert.ok(f.store.getLingTurn(legacy.turnId).createdAt < bootstrap[0].createdAt);
  assert.equal(f.store.getLingTurn(legacy.turnId).updatedAt, at(100));
  assert.equal(f.store.getEffectiveTurnContextAssignment(legacy.turnId), undefined);
  const firstPage = f.store.listLingTurns({ threadId: f.thread.id, limit: 500 });
  assert.equal(firstPage.length, 500);
  assert.equal(firstPage.some((turn) => turn.id === legacy.turnId), false);
  assert.ok(firstPage.every((turn) => turn.updatedAt === at(100)));
  const current = acceptOrVerifyRollback(f);
  assertAccepted(f, current, "A13_CURRENT_INPUT_END", 503);
  for (const marker of ["A13_DEEP_LEGACY_USER_END", "A13_DEEP_LEGACY_REPLY_END"]) {
    assert.equal(occurrences(current.context.renderedHistory, marker), 1, marker);
  }
  assert.equal(current.context.hydration.runEventWatermarks.filter((mark) => mark.runId === reply.run.id).length, 1);
});

for (const reason of ["budget", "visibility", "whole-group"]) {
  test(`A13 T07 ${reason}: long-thread evidence stays denied or whole-group omitted, never replayed as fallback`, async (t) => {
    const f = await fixture(t);
    seedUsers(f, 499);
    const marker = `A13_DENIED_${reason.toUpperCase()}_END`;
    const selected = appendUser(f, 500, { body: reason === "whole-group" ? "u".repeat(600) : userText(500) });
    const body = reason === "budget" ? `${marker}\n\n\`\`\`js\n${"x".repeat(2_000)}\n\`\`\``
      : reason === "whole-group" ? `${marker}${"a".repeat(600)}` : marker;
    const reply = ownedRun(f, selected, { body, canonical: reason !== "whole-group",
      visibility: reason === "visibility" ? "operator" : "thread_participants" });
    const source = appendUser(f, 501, { body: "A13_CAPTURE_SOURCE_END" });
    const reads = [];
    const listEvents = f.store.listEvents.bind(f.store);
    f.store.listEvents = (runId, options) => { reads.push(runId); return listEvents(runId, options); };
    const captured = captureNormalConversationContext({ store: f.store, threadId: f.thread.id,
      sourceItemId: source.item.id, maxHistoryTextChars: 1_024 });
    assert.equal(captured.renderedHistory.includes(marker), false);
    assert.ok(captured.hydration.usedTextChars <= 1_024);
    assert.equal(captured.renderedHistory.includes("A13_CAPTURE_SOURCE_END"), false);
    if (reason === "whole-group") {
      assert.ok(captured.hydration.diagnostics.some((diagnostic) => diagnostic.code === "budget_exceeded" && diagnostic.turnId === selected.turnId));
      assert.equal(captured.hydration.entries.some((entry) => entry.turnId === selected.turnId), false);
    } else {
      assert.equal(reads.includes(reply.run.id), false, "canonical existence is a deny signal, not permission to read its events");
      assert.equal(f.store.getConversationItem(reply.item.id).payload.body, body);
    }
    assert.equal(acceptanceState(f).turns, 501);
    assert.deepEqual(readNormalConversationContext(JSON.parse(JSON.stringify(captured))), captured);
  });
}

test("A13 T08: a long-thread capture keeps the real read-snapshot event boundary during a competing write", async (t) => {
  const f = await fixture(t);
  const sources = seedUsers(f, 500);
  const reply = ownedRun(f, sources.at(-1), { body: "A13_SNAPSHOT_ORIGINAL_END" });
  const source = appendUser(f, 501, { body: "A13_CAPTURE_SOURCE_END" });
  const expectedLast = f.store.listEvents(reply.run.id, { limit: 1_000 }).at(-1);
  const listEvents = f.store.listEvents.bind(f.store);
  let concurrentWrite = false;
  f.store.listEvents = (runId, options) => {
    if (runId === reply.run.id && !concurrentWrite) {
      concurrentWrite = true;
      f.database.prepare("UPDATE run_events SET data_json=? WHERE id=?").run(
        JSON.stringify({ role: "assistant", text: "A13_CONCURRENT_WRITE_END" }), reply.event.id);
    }
    return listEvents(runId, options);
  };
  const captured = captureNormalConversationContext({ store: f.store, threadId: f.thread.id, sourceItemId: source.item.id });
  assert.equal(concurrentWrite, true, "must reach the actual RunEvent read, not an earlier guard");
  assert.equal(occurrences(captured.renderedHistory, "A13_SNAPSHOT_ORIGINAL_END"), 1);
  assert.equal(captured.renderedHistory.includes("A13_CONCURRENT_WRITE_END"), false);
  assert.deepEqual(captured.hydration.runEventWatermarks.filter((mark) => mark.runId === reply.run.id),
    [{ runId: reply.run.id, throughEventSequence: expectedLast.seq, throughEventId: expectedLast.id }]);
  const frozen = JSON.stringify(captured);
  f.store.appendEvent(reply.run.id, "message_end", { role: "assistant", text: "A13_LATE_AFTER_CAPTURE_END" });
  assert.equal(JSON.stringify(readNormalConversationContext(JSON.parse(frozen))), frozen);
  assert.equal(captured.renderedHistory.includes("A13_LATE_AFTER_CAPTURE_END"), false);
});

test("A13 T09: reopening a now-long thread reuses first-winner prepared input without recapture or config reads", async (t) => {
  const f = await fixture(t);
  seedUsers(f, 498);
  const current = acceptOrVerifyRollback(f);
  const request = saveNormalConversationPreparedRequest(f.store, { cwd: f.cwd, threadId: f.thread.id,
    turnId: current.turn.id, teammateId: "ling_agent", createdByActor: "local-user", providerPresetId: "fixture",
    tools: ["read"], idempotencyKey: current.idempotencyKey, sourceMessageId: current.turn.sourceItemId,
    normalConversationContext: current.context, contextProjection: current.context.projection,
    normalConversationAcceptedSnapshotId: current.acceptedSnapshotId,
    task: { id: "a13-prepared-task", title: "A13 prepared", prompt: renderNormalConversationRunPrompt(current.context, "A13_CURRENT_INPUT_END") } }, at(10_000));
  seedUsers(f, 12, { startIndex: 600 });
  const before = acceptanceState(f);
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  f.store.listLingTurns = () => assert.fail("replay must not collect Turn history");
  f.store.listEvents = () => assert.fail("replay must not collect RunEvents");
  f.store.getWorkspaceSettings = () => assert.fail("replay must not read new provider/config choices");
  const replay = accept(f, { now: at(20_000) });
  assert.deepEqual(replay.context, current.context);
  assert.equal(replay.acceptedSnapshotId, current.acceptedSnapshotId);
  assert.deepEqual(replay.replayRequest, request);
  assert.deepEqual(acceptanceState(f), before);
  assert.throws(() => accept(f, { body: "A13_DRIFTED_INPUT_END", now: at(20_001) }), /another input|conflict|mismatch/i);
  assert.deepEqual(acceptanceState(f), before);
});

test("A13 T10: terminal long-parent fork freezes once and child input receives only its own live scope", async (t) => {
  const f = await fixture(t);
  const sources = seedUsers(f, 500);
  const anchor = sources.at(-1);
  const reply = ownedRun(f, anchor, { body: "A13_FORK_SELECTED_REPLY_END", canonical: true, terminal: true });
  const fork = () => createNormalConversationThreadFork({ store: f.store, sourceThread: f.thread,
    body: { turnId: anchor.turnId, idempotencyKey: "a13-frozen-fork" }, now: at(3_000),
    resolveAnchor: () => ({ sourceTurn: f.store.getLingTurn(anchor.turnId), sourceRun: f.store.getRun(reply.run.id) }) });
  const first = fork();
  assert.equal(first.created, true);
  const seed = f.store.getNormalConversationForkSeed(first.childThread.id);
  assert.ok(seed);
  const serializedSeed = JSON.stringify(seed);
  f.store.appendEvent(reply.run.id, "message_end", { role: "assistant", text: "A13_FORK_LATE_PARENT_END" });
  appendUser(f, 900, { body: "A13_PARENT_POST_FORK_END", now: at(4_000) });
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  const replay = fork();
  assert.equal(replay.created, false);
  assert.equal(replay.childThread.id, first.childThread.id);
  assert.equal(JSON.stringify(f.store.getNormalConversationForkSeed(first.childThread.id)), serializedSeed);
  const current = accept(f, { thread: replay.childThread, key: "child", body: "A13_CHILD_CURRENT_END" });
  assertAccepted(f, current, "A13_CHILD_CURRENT_END", 1, replay.childThread);
  assert.equal(occurrences(current.context.renderedHistory, "A13_FORK_SELECTED_REPLY_END"), 1);
  for (const marker of ["A13_FORK_LATE_PARENT_END", "A13_PARENT_POST_FORK_END"]) assert.equal(current.context.renderedHistory.includes(marker), false);
  assert.equal(current.context.forkHistory.seedId, first.childThread.forkContextSnapshotId);
  assert.ok(current.context.forkHistory.groups.every((group) => group.threadId === f.thread.id));
  assert.equal(Object.hasOwn(seed.payload, "permissionConfirmation"), false);
  assert.deepEqual(readNormalConversationContext(JSON.parse(JSON.stringify(current.context))), current.context);
});

test("A13 T11: snapshot INSERT failure at the 500th input rolls back attachment, cursor and segment before safe retry", async (t) => {
  const f = await fixture(t);
  seedUsers(f, 499);
  const attachment = f.store.createConversationAttachment({ kind: "file", fileName: "a13-owned.txt", contentType: "text/plain",
    sizeBytes: 1, path: `${f.cwd}/a13-owned.txt` });
  const beforeAttachment = f.store.getConversationAttachment(attachment.id);
  const identity = inputIdentity(f.thread, "trigger");
  const before = acceptanceState(f);
  // IDs are Host SHA-256 identifiers above, not user SQL. Reject only this source.
  f.database.exec(`CREATE TRIGGER a13_reject_target_snapshot BEFORE INSERT ON conversation_context_snapshots
    WHEN NEW.source_item_id='${identity.itemId}' BEGIN SELECT RAISE(ABORT, 'A13_TARGET_SNAPSHOT_INSERT'); END`);
  let failure;
  try { accept(f, { key: "trigger", attachmentIds: [attachment.id] }); }
  catch (error) { failure = error; }
  assertNoPartialInput(f, identity, before);
  assert.deepEqual(f.store.getConversationAttachment(attachment.id), beforeAttachment);
  assert.match(String(failure), /A13_TARGET_SNAPSHOT_INSERT/,
    "must actually reach the injected INSERT error; a Turn guard is not trigger/rollback coverage");
  f.database.exec("DROP TRIGGER a13_reject_target_snapshot");
  const current = acceptOrVerifyRollback(f, { key: "trigger", attachmentIds: [attachment.id] });
  assertAccepted(f, current, "A13_CURRENT_INPUT_END", 500);
  assert.equal(f.store.getConversationAttachment(attachment.id).turnId, current.turn.id);
  assert.equal(f.store.getConversationAttachment(attachment.id).threadId, f.thread.id);
  assert.equal(acceptanceState(f).snapshots, before.snapshots + 1);
});

test("A13 T12: the same thread accepts inputs 499 through 501 without replacing earlier accepted snapshots", async (t) => {
  const f = await fixture(t);
  seedUsers(f, 498);
  const accepted = [];
  for (const count of [499, 500, 501]) {
    const key = `sequence-${count}`;
    const body = `A13_SEQUENTIAL_${count}_END`;
    const current = acceptOrVerifyRollback(f, { key, body, now: at(10_000 + count) });
    assertAccepted(f, current, body, count);
    for (const previous of accepted) {
      assert.equal(occurrences(current.context.renderedHistory, previous.body), 1);
      assert.deepEqual(f.store.getConversationAcceptedInputSnapshot(previous.sourceItemId), previous.snapshot);
    }
    accepted.push({ body, sourceItemId: current.turn.sourceItemId,
      snapshot: f.store.getConversationAcceptedInputSnapshot(current.turn.sourceItemId) });
    assert.equal(acceptanceState(f).snapshots, accepted.length);
  }
  assert.equal(new Set(accepted.map((entry) => entry.snapshot.id)).size, 3);
  assert.equal(accepted[2].snapshot.payload.renderedHistory.includes(userText(1)), false,
    "the existing admitted 500-item tail drops old context, not durable history");
  assert.equal(f.store.getConversationItem("conversation-user:a13-z-modern-00001").payload.body, userText(1));
});
