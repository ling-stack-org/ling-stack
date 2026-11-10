import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "@ling-stack/core";
import { prepareNormalConversationInput } from "../dist/features/conversations/normal-conversation-input.js";
import { captureNormalConversationContext, readNormalConversationContext } from "../dist/features/conversations/normal-conversation-context.js";
import { buildConversationDetail } from "../dist/features/conversations/routes.js";

test("no-Run accepted input reuses frozen history after late events and database reopen", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-normal-accepted-test-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "N03", objective: "Accepted snapshot" }, "2026-09-06T01:00:00.000Z");
  const old = prepareNormalConversationInput({ store, thread, message: "OLD_USER", title: "Old", attachmentIds: [], fileRefs: [], idempotencyKey: "old", now: "2026-09-06T01:01:00.000Z" });
  store.createRun({ id: "old-run", cwd, threadId: thread.id, turnId: old.turn.id, taskId: "old-task", providerName: "openai", providerModel: "fixture",
    requestSnapshot: {}, taskSnapshot: { id: "old-task", title: "Old", prompt: "OLD_USER" }, providerSnapshot: {}, createdAt: "2026-09-06T01:01:00.000Z" });
  store.appendEvent("old-run", "message_end", { role: "assistant", text: "EARLY_HISTORY" });
  const input = { thread, message: "CURRENT_USER", title: "Current", attachmentIds: [], fileRefs: [], idempotencyKey: "current", now: "2026-09-06T01:02:00.000Z" };
  const first = prepareNormalConversationInput({ store, ...input });
  assert.equal(store.listLingTurnRuns(first.turn.id).length, 0);
  store.appendEvent("old-run", "message_end", { role: "assistant", text: "LATE_HISTORY" });
  const second = prepareNormalConversationInput({ store, ...input });
  assert.equal(second.turn.id, first.turn.id);
  assert.equal(second.context.fingerprint, first.context.fingerprint);
  assert.equal(second.context.renderedHistory.includes("LATE_HISTORY"), false);
  store.close(); store = createSqliteRunStore(cwd);
  store.listEvents = () => assert.fail("accepted replay must not query historical events");
  const reopened = prepareNormalConversationInput({ store, ...input });
  assert.deepEqual(reopened.context, first.context);
  assert.equal(store.listLingTurns({ threadId: thread.id }).length, 2);
});

async function acceptedFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-normal-accepted-compat-test-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "N03", objective: "Exact evidence" }, "2026-09-06T01:00:00.000Z");
  const args = { store, thread, message: "CURRENT_USER", title: "Current", attachmentIds: [], fileRefs: [], idempotencyKey: "current", now: "2026-09-06T01:02:00.000Z" };
  return { cwd, store, database, thread, args };
}

function persistAcceptedRun(f, input, context, marker = input.acceptedSnapshotId) {
  const task = { id: "current-task", title: "Current", prompt: `${context.renderedHistory}\nCURRENT_USER` };
  const request = { threadId: f.thread.id, turnId: input.turn.id, idempotencyKey: input.idempotencyKey, task,
    normalConversationContext: context, contextProjection: context.projection,
    ...(marker !== undefined ? { normalConversationAcceptedSnapshotId: marker } : {}) };
  f.store.createRun({ id: "current-run", cwd: f.cwd, threadId: f.thread.id, turnId: input.turn.id, taskId: task.id,
    providerName: "openai", providerModel: "fixture", requestSnapshot: request, taskSnapshot: task, providerSnapshot: {}, createdAt: f.args.now });
}

test("individually valid accepted A and Run B must agree on frozen history", async (t) => {
  const f = await acceptedFixture(t);
  const old = prepareNormalConversationInput({ ...f.args, message: "OLD_USER", title: "Old", idempotencyKey: "old", now: "2026-09-06T01:01:00.000Z" });
  f.store.createRun({ id: "history-run", cwd: f.cwd, threadId: f.thread.id, turnId: old.turn.id, taskId: "history-task",
    providerName: "openai", providerModel: "fixture", requestSnapshot: {}, taskSnapshot: { prompt: "OLD_USER" }, providerSnapshot: {}, createdAt: f.args.now });
  f.store.appendEvent("history-run", "message_end", { role: "assistant", text: "BEFORE_ACCEPT" });
  const first = prepareNormalConversationInput(f.args);
  f.store.appendEvent("history-run", "message_end", { role: "assistant", text: "AFTER_ACCEPT" });
  const changed = captureNormalConversationContext({ store: f.store, threadId: f.thread.id, sourceItemId: first.turn.sourceItemId });
  assert.notEqual(first.context.fingerprint, changed.fingerprint);
  assert.deepEqual(readNormalConversationContext(changed), changed);
  persistAcceptedRun(f, first, changed);
  assert.throws(() => prepareNormalConversationInput(f.args), /accepted.*Run context mismatch/i);
});

test("new Run requires its exact accepted snapshot marker; missing rows and wrong IDs fail closed", async (t) => {
  for (const corruption of ["missing", "wrong-id"]) {
    const f = await acceptedFixture(t);
    const first = prepareNormalConversationInput(f.args);
    persistAcceptedRun(f, first, first.context, corruption === "wrong-id" ? "foreign-snapshot" : first.acceptedSnapshotId);
    if (corruption === "missing") f.database.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(first.acceptedSnapshotId);
    f.store.listEvents = () => assert.fail("must not recapture");
    assert.throws(() => prepareNormalConversationInput(f.args), /accepted input snapshot/i);
  }
});

test("upgrade-only old Run recovers durable input without creating an accepted snapshot", async (t) => {
  const f = await acceptedFixture(t);
  const first = prepareNormalConversationInput(f.args);
  // Build a pre-cutover Run: original durable context, no new marker and no accepted row.
  persistAcceptedRun(f, { ...first, acceptedSnapshotId: undefined }, first.context);
  f.database.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(first.acceptedSnapshotId);
  f.store.listEvents = () => assert.fail("old Run must not recapture");
  const replay = prepareNormalConversationInput(f.args);
  assert.deepEqual(replay.context, first.context);
  assert.equal(replay.acceptedSnapshotId, undefined);
  assert.equal(f.store.getConversationAcceptedInputSnapshot(first.turn.sourceItemId), undefined);
  assert.throws(() => prepareNormalConversationInput({ ...f.args, message: "DRIFT" }), /another input/);
});

test("no-Run legacy input missing its accepted row cannot be hydrated retroactively", async (t) => {
  const f = await acceptedFixture(t);
  const first = prepareNormalConversationInput(f.args);
  f.database.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(first.acceptedSnapshotId);
  f.store.listEvents = () => assert.fail("legacy no-Run must not recapture");
  assert.throws(() => prepareNormalConversationInput(f.args), /snapshot is missing/i);
});

function persistPreparedDetailRun(f) {
  const input = prepareNormalConversationInput(f.args);
  const accepted = f.store.getConversationAcceptedInputSnapshot(input.turn.sourceItemId);
  const request = f.store.saveConversationPreparedInput({ sourceItemId: input.turn.sourceItemId, stage: "request",
    parentSnapshotId: accepted.id, parentFingerprint: accepted.fingerprint, payload: { internal: "REQUEST_PAYLOAD_SENTINEL" } }, f.args.now).snapshot;
  const execution = f.store.saveConversationPreparedInput({ sourceItemId: input.turn.sourceItemId, stage: "execution",
    parentSnapshotId: request.id, parentFingerprint: request.fingerprint, payload: { internal: "EXECUTION_PAYLOAD_SENTINEL" } }, f.args.now).snapshot;
  persistAcceptedRun(f, input, input.context);
  const run = f.store.getRun("current-run");
  const snapshot = { ...run.requestSnapshot,
    normalConversationPreparedRequestRef: { id: request.id, fingerprint: request.fingerprint },
    normalConversationPreparedExecutionRef: { id: execution.id, fingerprint: execution.fingerprint } };
  f.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?").run(JSON.stringify(snapshot), run.id);
  return { input, accepted, request, execution, snapshot };
}

test("normal detail exposes validated acceptance/preparation metadata, never internal payloads or fork aliases", async (t) => {
  const f = await acceptedFixture(t);
  const chain = persistPreparedDetailRun(f);
  const before = f.database.prepare("SELECT COUNT(*) AS count FROM conversation_context_snapshots").get().count;
  const detail = buildConversationDetail(f.store, f.cwd, f.thread);
  assert.deepEqual(new Set(detail.contextSnapshots.map(s => s.id)), new Set([chain.accepted.id, chain.request.id, chain.execution.id]));
  for (const snapshot of detail.contextSnapshots) {
    assert.equal(snapshot.segmentId, chain.accepted.projection.segmentId);
    assert.equal(snapshot.throughItemSequence, 1);
    assert.ok(snapshot.sourceRefs.some(ref => ref.type === "conversation_item" && ref.id === chain.input.turn.sourceItemId));
    assert.deepEqual(Object.keys(snapshot).sort(), ["id", "threadId", "segmentId", "projectionVersion", "throughItemSequence",
      "summaryIds", "sourceRefs", "policyVersion", "createdAt"].sort());
  }
  assert.doesNotMatch(JSON.stringify(detail.contextSnapshots), /PAYLOAD_SENTINEL|renderedHistory|fingerprint|hydration/);
  assert.equal(f.store.getConversationContextSnapshot(chain.accepted.id), undefined, "fork API must keep its existing meaning");
  assert.deepEqual(f.store.listConversationContextSnapshots({ threadId: f.thread.id }), []);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM conversation_context_snapshots").get().count, before, "detail read cannot manufacture snapshots");
});

test("normal detail refuses stale, missing, corrupted and foreign snapshot lineage without hiding the transcript", async (t) => {
  for (const corruption of ["accepted-id", "request-fingerprint", "execution-without-request", "missing-execution", "corrupt-row", "foreign-turn"]) {
    const f = await acceptedFixture(t);
    const chain = persistPreparedDetailRun(f);
    const request = structuredClone(chain.snapshot);
    if (corruption === "accepted-id") request.normalConversationAcceptedSnapshotId = "foreign-accepted";
    if (corruption === "request-fingerprint") request.normalConversationPreparedRequestRef.fingerprint = "wrong";
    if (corruption === "execution-without-request") delete request.normalConversationPreparedRequestRef;
    if (corruption === "missing-execution") f.database.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(chain.execution.id);
    if (corruption === "corrupt-row") f.database.prepare("UPDATE conversation_context_snapshots SET payload_fingerprint='wrong' WHERE id=?").run(chain.accepted.id);
    if (corruption === "foreign-turn") request.turnId = "foreign-turn";
    f.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id='current-run'").run(JSON.stringify(request));
    const detail = buildConversationDetail(f.store, f.cwd, f.thread);
    assert.deepEqual(detail.contextSnapshots, [], corruption);
    assert.ok(detail.conversationItems.some(item => item.id === chain.input.turn.sourceItemId), corruption);
  }
});

test("unbound accepted input and unmarked Runs do not create execution context metadata", async (t) => {
  const f = await acceptedFixture(t);
  const input = prepareNormalConversationInput(f.args);
  assert.deepEqual(buildConversationDetail(f.store, f.cwd, f.thread).contextSnapshots, []);
  persistAcceptedRun(f, { ...input, acceptedSnapshotId: undefined }, input.context);
  assert.deepEqual(buildConversationDetail(f.store, f.cwd, f.thread).contextSnapshots, []);
});
