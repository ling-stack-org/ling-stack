import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";

const firstAt = "2026-08-10T01:00:00.000Z";
const secondAt = "2026-08-10T01:01:00.000Z";
const thirdAt = "2026-08-10T01:02:00.000Z";
const policyVersion = "continuity-v2-segmentation-v1";

test("context assignments are append-only, invalidate moved-segment summaries, and promote related provisional segments", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-assignment-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const channel = store.createChannel({ name: "Context", boundPath: cwd }, firstAt);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Context",
    objective: "Test context segmentation",
  }, firstAt).thread;
  const first = appendUserTurn(store, channel.id, thread.id, "first", firstAt);
  const second = appendUserTurn(store, channel.id, thread.id, "second", secondAt);
  const bootstrap = store.getEffectiveTurnContextAssignment(second.turnId);
  assert.ok(bootstrap);
  assert.equal(bootstrap.segmentId, first.contextSegmentId);

  insertSegmentSummary(cwd, {
    id: "summary-before-correction",
    threadId: thread.id,
    segmentId: bootstrap.segmentId,
    throughSequence: first.item.sequence,
    createdAt: secondAt,
  });

  const moved = store.applyTurnContextAssignment({
    turnId: second.turnId,
    target: { kind: "new", state: "provisional", label: "Second topic" },
    status: "provisional",
    decisionSource: "model_policy",
    confidence: 0.72,
    evidenceRefs: [{ type: "conversation_item", id: second.item.id }],
    policyVersion,
  }, secondAt);
  assert.equal(moved.assignment.revision, 2);
  assert.equal(moved.assignment.supersedesAssignmentId, bootstrap.id);
  assert.notEqual(moved.segment.id, bootstrap.segmentId);
  assert.equal(moved.segment.state, "provisional");
  assert.deepEqual(moved.invalidatedSummaryIds, ["summary-before-correction"]);
  assert.equal(store.getConversationContextSummary("summary-before-correction")?.status, "invalidated");
  assert.equal(store.getConversationItem(first.item.id)?.payload.body, "first");
  assert.equal(store.getConversationItem(second.item.id)?.payload.body, "second");
  assert.equal(store.getContextSegment(bootstrap.segmentId)?.lastActiveTurnId, first.turnId);
  assert.notEqual(store.getContextSegment(bootstrap.segmentId)?.state, "archived");

  const replay = store.applyTurnContextAssignment({
    turnId: second.turnId,
    target: { kind: "new", state: "provisional", label: "Second topic" },
    status: "provisional",
    decisionSource: "model_policy",
    confidence: 0.72,
    evidenceRefs: [{ type: "conversation_item", id: second.item.id }],
    policyVersion,
  }, secondAt);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.assignment.id, moved.assignment.id);
  assert.equal(replay.segment.id, moved.segment.id);

  const third = appendUserTurn(store, channel.id, thread.id, "third", thirdAt);
  const promoted = store.applyTurnContextAssignment({
    turnId: third.turnId,
    target: { kind: "existing", segmentId: moved.segment.id },
    status: "committed",
    decisionSource: "structural",
    confidence: 1,
    antecedentTurnId: second.turnId,
    evidenceRefs: [{ type: "conversation_item", id: second.item.id }],
    policyVersion,
  }, thirdAt);
  assert.equal(promoted.segment.state, "active");
  assert.equal(promoted.segment.lastActiveTurnId, third.turnId);
  assert.deepEqual(
    store.listConversationItemsForSegment({
      threadId: thread.id,
      segmentId: moved.segment.id,
      throughSequence: third.item.sequence,
    }).map((item) => item.id),
    [second.item.id, third.item.id],
  );
});

test("context assignments reject invented cross-thread segments and invalid confidence", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-assignment-boundary-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const firstChannel = store.createChannel({ name: "First", boundPath: cwd }, firstAt);
  const secondChannel = store.createChannel({ name: "Second", boundPath: cwd }, firstAt);
  const firstThread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: firstChannel.id,
    title: "First",
    objective: "First",
  }, firstAt).thread;
  const secondThread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: secondChannel.id,
    title: "Second",
    objective: "Second",
  }, firstAt).thread;
  const first = appendUserTurn(store, firstChannel.id, firstThread.id, "first", firstAt);
  const second = appendUserTurn(store, secondChannel.id, secondThread.id, "second", firstAt);
  const secondSegment = store.getEffectiveTurnContextAssignment(second.turnId)?.segmentId;
  assert.ok(secondSegment);

  assert.throws(() => store.applyTurnContextAssignment({
    turnId: first.turnId,
    target: { kind: "existing", segmentId: secondSegment },
    status: "committed",
    decisionSource: "model_policy",
    confidence: 0.9,
    policyVersion,
  }, secondAt), /not assignable in this thread/);
  assert.throws(() => store.applyTurnContextAssignment({
    turnId: first.turnId,
    target: { kind: "existing", segmentId: first.contextSegmentId },
    status: "committed",
    decisionSource: "model_policy",
    confidence: 1.1,
    policyVersion,
  }, secondAt), /between 0 and 1/);
});

test("channel acceptance atomically creates and reuses the Item Turn dispatch tuple", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-dispatch-ingest-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const now = "2026-08-13T01:00:00.000Z";
  const channel = store.createChannel({ name: "Dispatch", boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Dispatch",
    objective: "Verify atomic acceptance",
  }, now).thread;
  const input = {
    channelId: channel.id,
    threadId: thread.id,
    title: "accepted",
    userInstruction: "accepted",
    payload: {
      body: "accepted",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: "dispatch-atomic-key",
    dispatch: {
      schemaVersion: 1,
      requestAiReply: true,
      requestedTeammateId: "ling_agent",
      unavailableRequestedParticipantIds: ["teammate_paused"],
    },
  };
  const first = store.appendConversationUserTurn(input, now);
  const replay = store.appendConversationUserTurn(input, "2026-08-13T01:00:01.000Z");

  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.item.id, first.item.id);
  assert.equal(replay.turnId, first.turnId);
  assert.equal(replay.dispatchWorkUnitId, first.dispatchWorkUnitId);
  const replayAfterDerivedAvailabilityChange = store.appendConversationUserTurn({
    ...input,
    dispatch: { ...input.dispatch, unavailableRequestedParticipantIds: [] },
  }, "2026-08-13T01:00:01.500Z");
  assert.equal(replayAfterDerivedAvailabilityChange.dispatchWorkUnitId, first.dispatchWorkUnitId);
  assert.throws(() => store.appendConversationUserTurn({
    ...input,
    dispatch: { ...input.dispatch, requestedTeammateId: "teammate_builtin_engineer" },
  }, "2026-08-13T01:00:02.000Z"), /idempotency key belongs to another dispatch input/);
  const dispatch = store.getWorkUnit(first.dispatchWorkUnitId);
  assert.ok(dispatch);
  assert.equal(dispatch.kind, "channel_turn_dispatch");
  assert.equal(dispatch.ownerId, first.turnId);
  assert.equal(dispatch.linkedMessageId, first.item.id);
  assert.deepEqual(dispatch.request, {
    schemaVersion: 1,
    requestAiReply: true,
    requestedTeammateId: "ling_agent",
    unavailableRequestedParticipantIds: ["teammate_paused"],
    sourceTurnId: first.turnId,
    sourceItemId: first.item.id,
    channelId: channel.id,
    threadId: thread.id,
  });
  assert.equal(Object.hasOwn(dispatch.request, "stage"), false);
  assert.equal(store.listRuntimeEvents(dispatch.id).at(0)?.type, "work_unit_created");
});

test("explicit context corrections use an atomic assignment revision fence", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-assignment-cas-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const channel = store.createChannel({ name: "Correction", boundPath: cwd }, firstAt);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Correction",
    objective: "Test explicit correction fencing",
  }, firstAt).thread;
  const first = appendUserTurn(store, channel.id, thread.id, "first", firstAt);
  const second = appendUserTurn(store, channel.id, thread.id, "second", secondAt);
  const firstAssignment = store.getEffectiveTurnContextAssignment(first.turnId);
  const secondAssignment = store.getEffectiveTurnContextAssignment(second.turnId);
  assert.ok(firstAssignment);
  assert.ok(secondAssignment);

  const corrected = store.applyTurnContextAssignment({
    turnId: second.turnId,
    expectedPreviousRevision: secondAssignment.revision,
    target: { kind: "existing", segmentId: firstAssignment.segmentId },
    status: "committed",
    decisionSource: "user",
    evidenceRefs: [{ type: "turn", id: second.turnId }],
    policyVersion: "continuity-v2-user-correction-v1",
  }, thirdAt);
  assert.equal(corrected.assignment.revision, secondAssignment.revision + 1);
  assert.equal(corrected.assignment.decisionSource, "user");

  assert.throws(() => store.applyTurnContextAssignment({
    turnId: second.turnId,
    expectedPreviousRevision: secondAssignment.revision,
    target: { kind: "existing", segmentId: firstAssignment.segmentId },
    status: "committed",
    decisionSource: "user",
    evidenceRefs: [{ type: "turn", id: second.turnId }],
    policyVersion: "continuity-v2-user-correction-v1",
  }, thirdAt), /Context assignment revision conflict/);
  assert.equal(store.getEffectiveTurnContextAssignment(second.turnId)?.id, corrected.assignment.id);
});

test("context summaries commit with a source fence, supersede atomically, and discard stale results", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-summary-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const channel = store.createChannel({ name: "Summary", boundPath: cwd }, firstAt);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Summary",
    objective: "Test summary fencing",
  }, firstAt).thread;
  const first = appendUserTurn(store, channel.id, thread.id, "summary first", firstAt);
  const second = appendUserTurn(store, channel.id, thread.id, "summary second", secondAt);
  const initialInput = summaryCommitInput(store, thread.id, first.contextSegmentId, [first, second]);

  const third = appendUserTurn(store, channel.id, thread.id, "summary third", thirdAt);
  const initial = store.commitConversationContextSummary(initialInput, thirdAt);
  assert.equal(initial.status, "committed");
  assert.equal(initial.summary.version, 1);
  assert.equal(initial.summary.coveredThroughSequence, second.item.sequence);

  const replacementInput = summaryCommitInput(
    store,
    thread.id,
    first.contextSegmentId,
    [first, second, third],
    initial.summary.id,
  );
  const replacement = store.commitConversationContextSummary(
    replacementInput,
    "2026-08-10T01:03:00.000Z",
  );
  assert.equal(replacement.status, "committed");
  assert.equal(replacement.summary.version, 2);
  assert.equal(replacement.summary.supersedesSummaryId, initial.summary.id);
  assert.equal(store.getConversationContextSummary(initial.summary.id)?.status, "superseded");
  assert.deepEqual(
    store.listConversationContextSummaries({ threadId: thread.id }).map((summary) => summary.id),
    [replacement.summary.id],
  );

  const duplicateLateResult = store.commitConversationContextSummary(
    replacementInput,
    "2026-08-10T01:04:00.000Z",
  );
  assert.deepEqual(duplicateLateResult, {
    status: "discarded_stale",
    reason: "active_summary_changed",
  });
});

test("context summary assignment races are discarded and snapshots remain source-linked", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-snapshot-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const channel = store.createChannel({ name: "Snapshot", boundPath: cwd }, firstAt);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root",
    channelId: channel.id,
    title: "Snapshot",
    objective: "Test snapshot reconstruction",
  }, firstAt).thread;
  const first = appendUserTurn(store, channel.id, thread.id, "snapshot first", firstAt);
  const second = appendUserTurn(store, channel.id, thread.id, "snapshot second", secondAt);
  const staleInput = summaryCommitInput(store, thread.id, first.contextSegmentId, [first, second]);

  store.applyTurnContextAssignment({
    turnId: first.turnId,
    target: { kind: "existing", segmentId: first.contextSegmentId },
    status: "committed",
    decisionSource: "user",
    confidence: 1,
    evidenceRefs: [{ type: "conversation_item", id: first.item.id }],
    policyVersion,
  }, thirdAt);
  assert.deepEqual(
    store.commitConversationContextSummary(staleInput, "2026-08-10T01:03:00.000Z"),
    { status: "discarded_stale", reason: "assignments_changed" },
  );

  const snapshot = store.createConversationContextSnapshot({
    id: "snapshot-fork-boundary",
    threadId: thread.id,
    segmentId: first.contextSegmentId,
    projectionVersion: "ctxv2_snapshot_fixture",
    throughItemSequence: second.item.sequence,
    summaryIds: [],
    sourceRefs: [
      { type: "thread", id: thread.id },
      { type: "conversation_item", id: first.item.id },
      { type: "conversation_item", id: second.item.id },
    ],
    policyVersion: "continuity-v2-snapshot-v1",
  }, "2026-08-10T01:04:00.000Z");
  assert.equal(store.getConversationContextSnapshot(snapshot.id)?.projectionVersion, "ctxv2_snapshot_fixture");
  assert.deepEqual(
    store.listConversationContextSnapshots({ threadId: thread.id }).map((candidate) => candidate.id),
    [snapshot.id],
  );

  appendUserTurn(store, channel.id, thread.id, "parent changed later", "2026-08-10T01:05:00.000Z");
  assert.equal(store.getConversationContextSnapshot(snapshot.id)?.throughItemSequence, second.item.sequence);
  assert.deepEqual(store.getConversationContextSnapshot(snapshot.id)?.sourceRefs, snapshot.sourceRefs);
});

test("new input follows the effective assignment decision in both segment directions, not a segment UUID tie", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-segment-continuation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const channel = store.createChannel({ name: "Segment continuation", boundPath: cwd }, firstAt);
  const { thread } = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root", channelId: channel.id,
    title: "Segment continuation", objective: "Follow durable context decisions",
  }, firstAt);
  const first = appendUserTurn(store, channel.id, thread.id, "original", firstAt);
  const second = appendUserTurn(store, channel.id, thread.id, "move latest", secondAt);
  const moved = store.applyTurnContextAssignment({
    turnId: second.turnId, target: { kind: "new", state: "active" },
    status: "committed", decisionSource: "user", policyVersion,
  }, thirdAt);
  assert.equal(store.getContextSegment(first.contextSegmentId).updatedAt, thirdAt);
  assert.equal(moved.segment.updatedAt, thirdAt);
  const next = appendUserTurn(store, channel.id, thread.id, "continue new", "2026-08-10T01:03:00.000Z");
  assert.equal(next.contextSegmentId, moved.segment.id);

  store.applyTurnContextAssignment({
    turnId: next.turnId, target: { kind: "existing", segmentId: first.contextSegmentId },
    status: "committed", decisionSource: "user", policyVersion,
  }, "2026-08-10T01:04:00.000Z");
  assert.equal(store.getContextSegment(first.contextSegmentId).updatedAt, "2026-08-10T01:04:00.000Z");
  assert.equal(store.getContextSegment(moved.segment.id).updatedAt, "2026-08-10T01:04:00.000Z");
  const back = appendUserTurn(store, channel.id, thread.id, "continue original", "2026-08-10T01:05:00.000Z");
  assert.equal(back.contextSegmentId, first.contextSegmentId);
  assert.equal(store.getEffectiveTurnContextAssignment(second.turnId).segmentId, moved.segment.id);
  assert.equal(store.getEffectiveTurnContextAssignment(next.turnId).segmentId, first.contextSegmentId);
});

test("a late correction of an older source cannot change the latest source's default segment", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-historical-correction-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const channel = store.createChannel({ name: "Historical correction", boundPath: cwd }, firstAt);
  const { thread } = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root", channelId: channel.id,
    title: "Historical correction", objective: "Keep corrections scoped to their source",
  }, firstAt);
  const first = appendUserTurn(store, channel.id, thread.id, "historical", firstAt);
  // Equal timestamps must still follow canonical per-thread source sequence.
  const latest = appendUserTurn(store, channel.id, thread.id, "latest", firstAt);
  const moved = store.applyTurnContextAssignment({
    turnId: latest.turnId, target: { kind: "new", state: "active" },
    status: "committed", decisionSource: "user", policyVersion,
  }, secondAt);
  store.applyTurnContextAssignment({
    turnId: first.turnId, target: { kind: "existing", segmentId: first.contextSegmentId },
    status: "committed", decisionSource: "user", policyVersion,
  }, thirdAt);
  const next = appendUserTurn(store, channel.id, thread.id, "continue latest", "2026-08-10T01:03:00.000Z");
  assert.equal(next.contextSegmentId, moved.segment.id);
  assert.equal(store.getEffectiveTurnContextAssignment(first.turnId).segmentId, first.contextSegmentId);
  assert.equal(store.getConversationItem(first.item.id).sequence, 1);
  assert.equal(store.getConversationItem(latest.item.id).sequence, 2);
});

function appendUserTurn(store, channelId, threadId, body, now) {
  return store.appendConversationUserTurn({
    channelId,
    threadId,
    title: body,
    userInstruction: body,
    payload: {
      body,
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: `context-test:${body}`,
  }, now);
}

function summaryCommitInput(store, threadId, segmentId, turns, expectedActiveSummaryId = null) {
  return {
    threadId,
    segmentId,
    scope: "segment",
    coveredFromSequence: turns[0].item.sequence,
    coveredThroughSequence: turns.at(-1).item.sequence,
    objective: "Preserve the current objective.",
    decisions: ["Use fenced summaries."],
    constraints: ["Do not overwrite a newer summary."],
    openQuestions: [],
    activeWorkRefs: [],
    sourceRefs: [
      ...(expectedActiveSummaryId ? [{ type: "context_summary", id: expectedActiveSummaryId }] : []),
      ...turns.map((turn) => ({ type: "conversation_item", id: turn.item.id })),
    ],
    policyVersion: "continuity-v2-summary-v1",
    projectionVersion: `ctxv2_fixture_${turns.at(-1).item.sequence}`,
    visibilityFingerprint: "visibility_fixture_channel",
    expectedActiveSummaryId,
    sourceFence: turns.map((turn) => {
      const assignment = store.getEffectiveTurnContextAssignment(turn.turnId);
      assert.ok(assignment);
      return {
        itemId: turn.item.id,
        sequence: turn.item.sequence,
        revision: turn.item.revision,
        updatedAt: turn.item.updatedAt,
        visibility: turn.item.visibility,
        visibilityOwnerId: turn.item.visibilityOwnerId,
        turnId: turn.turnId,
        assignmentId: assignment.id,
        assignmentRevision: assignment.revision,
      };
    }),
  };
}

function insertSegmentSummary(cwd, input) {
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.prepare(`
      INSERT INTO conversation_context_summaries (
        id, workspace_id, thread_id, segment_id, scope, status, version,
        covered_from_sequence, covered_through_sequence, objective, decisions_json,
        constraints_json, open_questions_json, active_work_refs_json, source_refs_json,
        supersedes_summary_id, policy_version, created_at
      ) VALUES (?, 'workspace_default', ?, ?, 'segment', 'active', 1, 1, ?, ?, '[]',
        '[]', '[]', '[]', '[]', NULL, ?, ?)
    `).run(
      input.id,
      input.threadId,
      input.segmentId,
      input.throughSequence,
      "Prior summary",
      policyVersion,
      input.createdAt,
    );
  } finally {
    database.close();
  }
}

const b007At = (tick) => new Date(Date.UTC(2026, 9, 15) + tick * 1_000).toISOString();

/** Public producers own every summary/assignment; raw SQL only observes or injects a failure. */
async function b007Fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-b007-summary-rebuild-"));
  const preserve = process.env.LING_B007_KEEP_FIXTURES === "1";
  if (preserve) t.diagnostic(`B-007 Core retained fixture root: ${cwd}`);
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(store.paths.databasePath);
  t.after(async () => {
    try { database.close(); }
    finally {
      try { store.close(); }
      finally { if (!preserve) await rm(cwd, { recursive: true, force: true }); }
    }
  });
  const channel = store.createChannel({ name: "B-007 rebuild", boundPath: cwd }, b007At(0));
  const { thread } = store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: channel.id,
    title: "B-007 rebuild", objective: "Rebuild corrected facts without reviving invalidated summaries" }, b007At(0));
  const turns = ["retained first fact", "moved second fact", "retained third fact", "retained tail fact"]
    .map((body, index) => appendUserTurn(store, channel.id, thread.id, body, b007At(index + 1)));
  assert.ok(turns.every((turn) => turn.contextSegmentId === turns[0].contextSegmentId));
  return { cwd, store, database, channel, thread, turns, segmentId: turns[0].contextSegmentId, nextTick: 10 };
}

function b007Input(f, turns, expectedActiveSummaryId = null, extra = {}) {
  return { ...summaryCommitInput(f.store, f.thread.id, f.segmentId, turns, expectedActiveSummaryId), ...extra };
}

function b007Commit(f, turns, expectedActiveSummaryId = null, extra = {}) {
  const result = f.store.commitConversationContextSummary(b007Input(f, turns, expectedActiveSummaryId, extra), b007At(f.nextTick++));
  assert.equal(result.status, "committed", JSON.stringify(result));
  return result.summary;
}

function b007Move(f, turn, target) {
  const previous = f.store.getEffectiveTurnContextAssignment(turn.turnId);
  assert.ok(previous);
  const result = f.store.applyTurnContextAssignment({ turnId: turn.turnId, expectedPreviousRevision: previous.revision,
    target, status: "committed", decisionSource: "user", evidenceRefs: [{ type: "conversation_item", id: turn.item.id }],
    policyVersion: "continuity-v2-user-correction-v1" }, b007At(f.nextTick++));
  assert.equal(result.assignment.revision, previous.revision + 1);
  return result;
}

function b007History(f) {
  return f.store.listConversationContextSummaries({ threadId: f.thread.id,
    statuses: ["active", "superseded", "invalidated"], limit: 200 }).slice().sort((left, right) => left.version - right.version);
}

function b007Snapshot(f) {
  return Object.fromEntries(f.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, f.database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]));
}

function b007InsertFault(f) {
  const threadId = f.thread.id.replaceAll("'", "''");
  f.database.exec(`CREATE TRIGGER b007_summary_insert_fault BEFORE INSERT ON conversation_context_summaries
    WHEN NEW.thread_id='${threadId}' BEGIN SELECT RAISE(ABORT, 'B007_SUMMARY_INSERT_FAULT'); END`);
}

test("B-007 public correction rebuilds an invalidated v1 with fresh fences as v2", async (t) => {
  const f = await b007Fixture(t);
  const initial = b007Commit(f, f.turns.slice(0, 2));
  assert.equal(initial.version, 1);
  const moved = b007Move(f, f.turns[1], { kind: "new", state: "active", label: "Corrected second topic" });
  assert.deepEqual(moved.invalidatedSummaryIds, [initial.id]);
  const invalidated = f.store.getConversationContextSummary(initial.id);
  assert.equal(invalidated.status, "invalidated");
  assert.deepEqual(f.store.listConversationContextSummaries({ threadId: f.thread.id, segmentId: f.segmentId }), []);
  const fresh = b007Input(f, [f.turns[0]]);
  assert.equal(fresh.expectedActiveSummaryId, null);
  assert.equal(fresh.sourceFence[0].assignmentId, f.store.getEffectiveTurnContextAssignment(f.turns[0].turnId).id);
  const result = f.store.commitConversationContextSummary(fresh, b007At(f.nextTick++));
  assert.equal(result.status, "committed", JSON.stringify(result));
  assert.equal(result.summary.version, 2);
  assert.equal(result.summary.supersedesSummaryId, undefined);
  assert.deepEqual(result.summary.sourceRefs, [{ type: "conversation_item", id: f.turns[0].item.id }]);
  assert.deepEqual(f.store.getConversationContextSummary(initial.id), invalidated);
  assert.deepEqual(b007History(f).map(({ version, status }) => [version, status]), [[1, "invalidated"], [2, "active"]]);
  assert.equal(f.store.getConversationItem(f.turns[1].item.id).payload.body, "moved second fact");
});

test("B-007 moving a covered turn back invalidates v2 and rebuilds its original segment as v3", async (t) => {
  const f = await b007Fixture(t);
  const first = b007Commit(f, f.turns.slice(0, 2));
  b007Move(f, f.turns[1], { kind: "new", state: "active" });
  const second = b007Commit(f, [f.turns[0]]);
  assert.equal(second.version, 2);
  const movedBack = b007Move(f, f.turns[1], { kind: "existing", segmentId: f.segmentId });
  assert.deepEqual(movedBack.invalidatedSummaryIds, [second.id]);
  const third = b007Commit(f, f.turns.slice(0, 2));
  assert.equal(third.version, 3);
  assert.equal(third.supersedesSummaryId, undefined);
  assert.equal(f.store.getEffectiveTurnContextAssignment(f.turns[1].turnId).segmentId, f.segmentId);
  assert.deepEqual(b007History(f).map(({ version, status }) => [version, status]),
    [[1, "invalidated"], [2, "invalidated"], [3, "active"]]);
  assert.equal(f.store.getConversationContextSummary(first.id).status, "invalidated");
});

test("B-007 rebuilding after a higher public history chooses max version across superseded and invalidated rows", async (t) => {
  const f = await b007Fixture(t);
  const first = b007Commit(f, f.turns.slice(0, 1));
  const second = b007Commit(f, f.turns.slice(0, 2), first.id);
  const third = b007Commit(f, f.turns.slice(0, 3), second.id);
  assert.deepEqual(b007History(f).map(({ version, status }) => [version, status]),
    [[1, "superseded"], [2, "superseded"], [3, "active"]]);
  assert.deepEqual(b007Move(f, f.turns[1], { kind: "new", state: "active" }).invalidatedSummaryIds, [third.id]);
  const fourth = b007Commit(f, [f.turns[0], f.turns[2]]);
  assert.equal(fourth.version, 4);
  assert.equal(fourth.coveredFromSequence, f.turns[0].item.sequence);
  assert.equal(fourth.coveredThroughSequence, f.turns[2].item.sequence);
  assert.deepEqual(b007History(f).map(({ version, status }) => [version, status]),
    [[1, "superseded"], [2, "superseded"], [3, "invalidated"], [4, "active"]]);
});

for (const scope of ["thread_core", "work"]) {
  test(`B-007 ${scope} and segment summaries share the durable non-null unique version partition`, async (t) => {
    const f = await b007Fixture(t);
    const segment = b007Commit(f, f.turns.slice(0, 2));
    const otherScope = b007Commit(f, f.turns.slice(0, 2), null, { scope });
    assert.equal(otherScope.version, 2);
    assert.equal(otherScope.segmentId, segment.segmentId);
    assert.equal(otherScope.supersedesSummaryId, undefined);
    const replacement = b007Commit(f, f.turns.slice(0, 3), segment.id);
    assert.equal(replacement.version, 3, "the lower active segment version cannot hide a higher other-scope version");
    assert.equal(replacement.supersedesSummaryId, segment.id);
    assert.equal(f.store.getConversationContextSummary(otherScope.id).status, "active");
    assert.deepEqual(b007History(f).map(({ version, status }) => [version, status]),
      [[1, "superseded"], [2, "active"], [3, "active"]]);
  });
}

test("B-007 null segment history remains monotonic across thread_core and work scopes", async (t) => {
  const f = await b007Fixture(t);
  const first = b007Commit(f, f.turns.slice(0, 2), null, { scope: "thread_core", segmentId: undefined });
  const second = b007Commit(f, f.turns.slice(0, 2), null, { scope: "work", segmentId: undefined });
  const third = b007Commit(f, f.turns.slice(0, 3), first.id, { scope: "thread_core", segmentId: undefined });
  assert.equal(first.segmentId, undefined);
  assert.equal(second.segmentId, undefined);
  assert.deepEqual([first.version, second.version, third.version], [1, 2, 3]);
  assert.equal(third.supersedesSummaryId, first.id);
  assert.equal(f.store.getConversationContextSummary(second.id).status, "active");
});

test("B-007 two Store generation results cannot both install after invalidation", async (t) => {
  const f = await b007Fixture(t);
  const initial = b007Commit(f, f.turns.slice(0, 2));
  b007Move(f, f.turns[1], { kind: "new", state: "active" });
  const other = createSqliteRunStore(f.cwd);
  try {
    const firstPlan = b007Input(f, [f.turns[0]]);
    const latePlan = summaryCommitInput(other, f.thread.id, f.segmentId, [f.turns[0]]);
    assert.equal(firstPlan.expectedActiveSummaryId, null);
    assert.equal(latePlan.expectedActiveSummaryId, null);
    const winner = f.store.commitConversationContextSummary(firstPlan, b007At(f.nextTick++));
    assert.equal(winner.status, "committed");
    assert.equal(winner.summary.version, 2);
    const beforeLate = b007Snapshot(f);
    assert.deepEqual(other.commitConversationContextSummary(latePlan, b007At(f.nextTick++)),
      { status: "discarded_stale", reason: "active_summary_changed" });
    assert.deepEqual(b007Snapshot(f), beforeLate);
    assert.equal(other.getConversationContextSummary(initial.id).status, "invalidated");
    assert.deepEqual(b007History(f).map(({ version }) => version), [1, 2]);
  } finally { other.close(); }
});

test("B-007 fresh rebuild keeps assignment fencing when a second Store corrects its source during generation", async (t) => {
  const f = await b007Fixture(t);
  b007Commit(f, f.turns.slice(0, 2));
  b007Move(f, f.turns[1], { kind: "new", state: "active" });
  const pending = b007Input(f, [f.turns[0]]);
  const other = createSqliteRunStore(f.cwd);
  try {
    const assignment = other.getEffectiveTurnContextAssignment(f.turns[0].turnId);
    other.applyTurnContextAssignment({ turnId: f.turns[0].turnId, expectedPreviousRevision: assignment.revision,
      target: { kind: "existing", segmentId: f.segmentId }, status: "committed", decisionSource: "user",
      evidenceRefs: [{ type: "turn", id: f.turns[0].turnId }], policyVersion: "continuity-v2-user-correction-v1" }, b007At(f.nextTick++));
    const beforeLate = b007Snapshot(f);
    assert.deepEqual(f.store.commitConversationContextSummary(pending, b007At(f.nextTick++)),
      { status: "discarded_stale", reason: "assignments_changed" });
    assert.deepEqual(b007Snapshot(f), beforeLate);
    assert.deepEqual(b007History(f).map(({ version, status }) => [version, status]), [[1, "invalidated"]]);
  } finally { other.close(); }
});

for (const mode of ["invalidated rebuild", "active replacement"]) {
  test(`B-007 ${mode} INSERT fault rolls back the full transaction and permits one clean retry`, async (t) => {
    const f = await b007Fixture(t);
    const initial = b007Commit(f, f.turns.slice(0, 2));
    if (mode === "invalidated rebuild") b007Move(f, f.turns[1], { kind: "new", state: "active" });
    const input = mode === "invalidated rebuild" ? b007Input(f, [f.turns[0]]) : b007Input(f, f.turns.slice(0, 3), initial.id);
    const before = b007Snapshot(f);
    b007InsertFault(f);
    try {
      assert.throws(() => f.store.commitConversationContextSummary(input, b007At(f.nextTick++)), /B007_SUMMARY_INSERT_FAULT/u);
      assert.deepEqual(b007Snapshot(f), before, "the separate connection cannot observe a partial replacement or new row");
      assert.equal(f.store.getConversationContextSummary(initial.id).status,
        mode === "invalidated rebuild" ? "invalidated" : "active");
    } finally { f.database.exec("DROP TRIGGER b007_summary_insert_fault"); }
    const retried = f.store.commitConversationContextSummary(input, b007At(f.nextTick++));
    assert.equal(retried.status, "committed");
    assert.equal(retried.summary.version, 2);
    assert.equal(b007History(f).length, 2);
    assert.equal(f.store.getConversationContextSummary(initial.id).status,
      mode === "invalidated rebuild" ? "invalidated" : "superseded");
  });
}
