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
