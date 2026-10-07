import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";

const now = "2026-09-06T05:00:00.000Z";

test("system input freezes atomically with a matching actor and rejects actor relabelling", async (t) => {
  const f = await fixture(t);
  const input = { ...f.input, actorType: "system" };
  const first = f.store.appendConversationUserTurnWithAcceptedSnapshot(input, f.capture, now);
  assert.equal(first.item.actorType, "system");
  assert.equal(f.store.getLingTurn(first.turnId).createdByActor, "system");
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.store.appendConversationUserTurnWithAcceptedSnapshot(input, () => assert.fail("cannot recapture"), now).acceptedSnapshot, first.acceptedSnapshot);
  assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot({ ...input, actorType: "local_user" }, f.capture, now), /another input/);
  f.database.prepare("UPDATE ling_turns SET created_by_actor='local-user' WHERE id=?").run(first.turnId);
  assert.throws(() => f.store.getConversationAcceptedInputSnapshot(first.item.id), /invalid/);
});
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-accepted-input-test-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  database.exec("PRAGMA busy_timeout=1");
  t.after(async () => { database.close(); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = f.store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Accepted", objective: "Atomic freeze" }, now);
  const input = { threadId: thread.id, turnId: "accepted-turn", itemId: "accepted-item", title: "Input", userInstruction: "Input", idempotencyKey: "accepted-key",
    payload: { body: "Input", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } };
  const capture = (result) => ({ projection: { projectionVersion: "projection-v1", sourceStateFingerprint: "state-v1", threadId: thread.id,
    turnId: result.turnId, segmentId: result.contextSegmentId, throughItemSequence: result.item.sequence, summaryIds: [],
    sourceRefs: [{ type: "conversation_item", id: result.item.id }], policyVersion: "fixture-v1", visibilityFingerprint: "visibility-v1" },
    payload: { schemaVersion: 1, frozenText: "ACCEPTED_HISTORY" } });
  return Object.assign(f, { database, thread, input, capture });
}

test("atomic accepted input is invisible before commit, blocks competing writers and replays after reopen", async (t) => {
  const f = await fixture(t);
  const first = f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, (result) => {
    assert.ok(f.store.getLingTurn(result.turnId));
    assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM ling_turns WHERE id=?").get(result.turnId).n, 0);
    assert.throws(() => f.database.exec("BEGIN IMMEDIATE"), /locked|busy/);
    return f.capture(result);
  }, now);
  assert.equal(first.acceptedSnapshot.use, "normal_conversation_accepted_input");
  assert.equal(first.acceptedSnapshot.schemaVersion, 1);
  assert.equal(first.acceptedSnapshot.sourceItemId, first.item.id);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  const second = f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, () => assert.fail("must not recapture"), now);
  assert.deepEqual(second.acceptedSnapshot, first.acceptedSnapshot);
  assert.equal(second.idempotentReplay, true);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots WHERE source_item_id=?").get(first.item.id).n, 1);
  assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot({ ...f.input, userInstruction: "DRIFT" }, f.capture, now), /another input/);
});

test("capture, asynchronous callback, and snapshot insert failures roll back every accepted-input row", async (t) => {
  const f = await fixture(t);
  for (const capture of [() => { throw new Error("capture failed"); }, async () => ({}), () => Promise.resolve({})]) {
    assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, capture, now));
    assert.equal(f.store.getLingTurn(f.input.turnId), undefined);
    assert.equal(f.store.getConversationItem(f.input.itemId), undefined);
    assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, 1);
  }
  f.database.exec("CREATE TRIGGER reject_accepted BEFORE INSERT ON conversation_context_snapshots BEGIN SELECT RAISE(ABORT, 'snapshot rejected'); END");
  assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, f.capture, now), /snapshot rejected/);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM turn_context_assignments").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM context_segments").get().n, 0);
  assert.equal(f.store.getLingTurn(f.input.turnId), undefined);
  f.database.exec("DROP TRIGGER reject_accepted");
  assert.ok(f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, f.capture, now).acceptedSnapshot);
});

test("serialization failure and serialization side effects roll back acceptance and restore query access", async (t) => {
  const f = await fixture(t);
  const cyclic = {}; cyclic.self = cyclic;
  for (const payload of [cyclic, { toJSON() { f.store.createLingThread({ kind: "conversation", title: "ILLEGAL", objective: "Write during serialization" }, now); return {}; } }]) {
    assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, (source) => ({ ...f.capture(source), payload }), now));
    assert.equal(f.store.getLingTurn(f.input.turnId), undefined);
    assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, 1);
  }
  assert.ok(f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, f.capture, now));
});

test("later assignment revisions never recapture or rewrite accepted evidence", async (t) => {
  const f = await fixture(t);
  const first = f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, f.capture, now);
  const moved = f.store.applyTurnContextAssignment({ turnId: first.turnId, target: { kind: "new", state: "provisional" },
    status: "provisional", decisionSource: "user", policyVersion: "later-assignment" }, "2026-09-06T07:00:00.000Z");
  assert.notEqual(moved.assignment.segmentId, first.acceptedSnapshot.projection.segmentId);
  const replay = f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, () => assert.fail("must not recapture"), now);
  assert.deepEqual(replay.acceptedSnapshot, first.acceptedSnapshot);
});

test("a deferred failure at COMMIT rolls back source, snapshot and attachment ownership", async (t) => {
  const f = await fixture(t);
  const attachment = f.store.createConversationAttachment({ kind: "file", fileName: "fixture.txt", contentType: "text/plain", sizeBytes: 1, path: join(f.cwd, "fixture.txt") });
  f.database.exec(`CREATE TABLE accepted_commit_failure (missing_id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_accepted_commit AFTER INSERT ON conversation_context_snapshots
    BEGIN INSERT INTO accepted_commit_failure VALUES ('missing-thread'); END`);
  const input = { ...f.input, payload: { ...f.input.payload, attachmentIds: [attachment.id] } };
  assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(input, f.capture, now), /FOREIGN KEY/);
  assert.equal(f.store.getLingTurn(input.turnId), undefined);
  assert.equal(f.store.getConversationItem(input.itemId), undefined);
  assert.equal(f.store.getConversationAttachment(attachment.id).turnId, undefined);
  assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots").get().n, 0);
  f.database.exec("DROP TRIGGER reject_accepted_commit");
  assert.ok(f.store.appendConversationUserTurnWithAcceptedSnapshot(input, f.capture, now));
});

test("capture callback is read-only and rejects foreign projection or unredacted payload", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, (result) => {
    f.store.createLingThread({ kind: "conversation", title: "ILLEGAL", objective: "Write" }, now);
    return f.capture(result);
  }, now), /readonly|read-only/);
  for (const mutate of [
    (value) => ({ ...value, projection: { ...value.projection, threadId: "foreign" } }),
    (value) => ({ ...value, projection: { ...value.projection, turnId: "foreign" } }),
    (value) => ({ ...value, payload: { text: "sk-test-not-a-real-secret-123456" } }),
  ]) assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, (result) => mutate(f.capture(result)), now));
  assert.equal(f.store.getLingTurn(f.input.turnId), undefined);
  assert.ok(f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, f.capture, now));
});

test("accepted snapshots cannot be read as fork snapshots or overwritten by fork creation", async (t) => {
  const f = await fixture(t);
  const accepted = f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, f.capture, now);
  assert.equal(f.store.getConversationContextSnapshot(accepted.acceptedSnapshot.id), undefined);
  assert.deepEqual(f.store.listConversationContextSnapshots({ threadId: f.thread.id }), []);
  const fork = { threadId: f.thread.id, segmentId: accepted.contextSegmentId, projectionVersion: "fork-v1", throughItemSequence: accepted.item.sequence,
    sourceRefs: [{ type: "conversation_item", id: accepted.item.id }], policyVersion: "fork-v1" };
  assert.throws(() => f.store.createConversationContextSnapshot({ ...fork, id: accepted.acceptedSnapshot.id }, now));
  const created = f.store.createConversationContextSnapshot(fork, now);
  assert.deepEqual(f.store.getConversationContextSnapshot(created.id), created);
  f.store.appendConversationUserTurnWithAcceptedSnapshot({ ...f.input, turnId: "later-turn", itemId: "later-item", idempotencyKey: "later-key" }, f.capture, "2026-09-06T06:00:00.000Z");
  assert.deepEqual(f.store.listConversationContextSnapshots({ threadId: f.thread.id, limit: 1 }), [created]);
});

test("missing, wrong-use, unknown-version and tampered accepted snapshots fail closed", async (t) => {
  for (const corruption of ["missing", "use", "version", "payload", "thread"]) {
    const f = await fixture(t);
    const result = f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, f.capture, now);
    const id = result.acceptedSnapshot.id;
    if (corruption === "missing") f.database.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(id);
    if (corruption === "use") f.database.prepare("UPDATE conversation_context_snapshots SET snapshot_use='fork_context' WHERE id=?").run(id);
    if (corruption === "version") f.database.prepare("UPDATE conversation_context_snapshots SET payload_version=2 WHERE id=?").run(id);
    if (corruption === "payload") f.database.prepare("UPDATE conversation_context_snapshots SET payload_json='{}' WHERE id=?").run(id);
    if (corruption === "thread") {
      const foreign = f.store.createLingThread({ kind: "conversation", title: "Foreign", objective: "Wrong scope" }, now);
      f.database.prepare("UPDATE conversation_context_snapshots SET thread_id=? WHERE id=?").run(foreign.id, id);
    }
    assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, () => assert.fail("must not recapture"), now), /accepted.*snapshot|snapshot.*accepted/i, corruption);
  }
});

test("attachment claims commit with acceptance, reject another input, and roll back on capture failure", async (t) => {
  const f = await fixture(t);
  const attachment = f.store.createConversationAttachment({ kind: "file", fileName: "fixture.txt", contentType: "text/plain", sizeBytes: 1, path: join(f.cwd, "fixture.txt") });
  const input = { ...f.input, payload: { ...f.input.payload, attachmentIds: [attachment.id] } };
  assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(input, () => { throw new Error("fail after claim"); }, now));
  assert.equal(f.store.getConversationAttachment(attachment.id).turnId, undefined);
  assert.equal(f.store.getConversationItem(input.itemId), undefined);
  f.store.appendConversationUserTurnWithAcceptedSnapshot(input, f.capture, now);
  assert.equal(f.store.getConversationAttachment(attachment.id).turnId, input.turnId);
  const other = { ...input, turnId: "loser-turn", itemId: "loser-item", idempotencyKey: "loser-key", sourceTurnId: input.turnId };
  assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(other, f.capture, now), /already used/);
  assert.equal(f.store.getConversationItem(other.itemId), undefined);
  assert.equal(f.store.getLingTurn(other.turnId), undefined);
  assert.equal(f.store.getLingThread(f.thread.id).nextItemSequence, 2);
  const replacement = f.store.appendConversationUserTurnWithAcceptedSnapshot({ ...other, replacementSourceTurnId: input.turnId }, f.capture, now);
  assert.ok(replacement.acceptedSnapshot);
  assert.equal(f.store.getConversationAttachment(attachment.id).turnId, input.turnId);
});

test("pre-accepted-schema fork rows migrate and reopen without changing their DTO", async (t) => {
  const f = await fixture(t);
  const source = f.store.appendConversationUserTurn(f.input, now);
  const fork = f.store.createConversationContextSnapshot({ threadId: f.thread.id, segmentId: source.contextSegmentId,
    projectionVersion: "fork-v1", throughItemSequence: source.item.sequence, sourceRefs: [{ type: "conversation_item", id: source.item.id }], policyVersion: "fork-v1" }, now);
  f.store.close();
  f.database.exec("DROP INDEX idx_conversation_accepted_input_source_use");
  for (const column of ["snapshot_use", "payload_version", "source_item_id", "payload_json", "payload_fingerprint"]) {
    f.database.exec(`ALTER TABLE conversation_context_snapshots DROP COLUMN ${column}`);
  }
  f.database.exec("DELETE FROM schema_migrations WHERE version=130");
  f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.store.getConversationContextSnapshot(fork.id), fork);
  assert.deepEqual(f.store.listConversationContextSnapshots({ threadId: f.thread.id, limit: 1 }), [fork]);
  assert.throws(() => f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, () => assert.fail("legacy no-Run cannot recapture"), now), /snapshot is missing/);
});

async function competingWriter(t, f, input) {
  const shared = new SharedArrayBuffer(4);
  const signal = new Int32Array(shared);
  const source = `import { parentPort, workerData } from 'node:worker_threads';
    const { createSqliteRunStore } = await import(workerData.coreUrl);
    const store = createSqliteRunStore(workerData.cwd);
    const signal = new Int32Array(workerData.shared);
    parentPort.postMessage('ready');
    Atomics.wait(signal, 0, 0);
    Atomics.store(signal, 0, 2); Atomics.notify(signal, 0);
    try {
      const result = store.appendConversationUserTurnWithAcceptedSnapshot(workerData.input, () => { throw new Error('competing writer must not capture'); }, workerData.now);
      parentPort.postMessage({ result });
    } catch (error) { parentPort.postMessage({ error: error.message }); }
    finally { store.close(); }`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { workerData: {
    cwd: f.cwd, input, now, shared, coreUrl: new URL("../dist/index.js", import.meta.url).href,
  } });
  t.after(() => worker.terminate());
  let resolveReady;
  let resolveResult;
  let rejectResult;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  worker.on("message", (message) => message === "ready" ? resolveReady() : resolveResult(message));
  worker.on("error", rejectResult);
  await ready;
  return { result, contend() {
    Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
    assert.notEqual(Atomics.wait(signal, 0, 1, 2_000), "timed-out", "writer must enter before acceptance commits");
    // Keep the acceptance transaction open while the other process enters BEGIN IMMEDIATE.
    Atomics.wait(signal, 0, 2, 30);
  } };
}

test("independent writer racing the same key restores the winner without a second capture", async (t) => {
  const f = await fixture(t);
  const competing = await competingWriter(t, f, f.input);
  const first = f.store.appendConversationUserTurnWithAcceptedSnapshot(f.input, (source) => {
    competing.contend();
    return f.capture(source);
  }, now);
  const second = await competing.result;
  assert.equal(second.error, undefined);
  assert.equal(second.result.idempotentReplay, true);
  assert.deepEqual(second.result.acceptedSnapshot, first.acceptedSnapshot);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots").get().n, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM ling_turns").get().n, 1);
});

test("independent inputs competing for a pending attachment leave no losing source or snapshot", async (t) => {
  const f = await fixture(t);
  const attachment = f.store.createConversationAttachment({ kind: "file", fileName: "fixture.txt", contentType: "text/plain", sizeBytes: 1, path: join(f.cwd, "fixture.txt") });
  const firstInput = { ...f.input, payload: { ...f.input.payload, attachmentIds: [attachment.id] } };
  const secondInput = { ...firstInput, turnId: "loser", itemId: "loser-item", idempotencyKey: "loser-key" };
  const competing = await competingWriter(t, f, secondInput);
  f.store.appendConversationUserTurnWithAcceptedSnapshot(firstInput, (source) => {
    competing.contend();
    return f.capture(source);
  }, now);
  const second = await competing.result;
  assert.match(second.error, /already used/);
  assert.equal(f.store.getLingTurn(secondInput.turnId), undefined);
  assert.equal(f.store.getConversationItem(secondInput.itemId), undefined);
  assert.equal(f.store.getConversationAcceptedInputSnapshot(secondInput.itemId), undefined);
  assert.equal(f.store.getConversationAttachment(attachment.id).turnId, firstInput.turnId);
});
