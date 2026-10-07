import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";

const now = "2026-09-08T10:00:00.000Z";
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-prepared-input-test-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => { database.close(); f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = f.store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Prepared", objective: "Freeze" }, now);
  const accepted = f.store.appendConversationUserTurnWithAcceptedSnapshot({
    threadId: thread.id, turnId: "prepared-turn", itemId: "prepared-item", title: "Input",
    userInstruction: "Input", idempotencyKey: "prepared-key",
    payload: { body: "Input", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, (result) => ({
    projection: { projectionVersion: "v1", sourceStateFingerprint: "state", threadId: thread.id,
      turnId: result.turnId, segmentId: result.contextSegmentId, throughItemSequence: result.item.sequence,
      summaryIds: [], sourceRefs: [{ type: "conversation_item", id: result.item.id }],
      policyVersion: "fixture-v1", visibilityFingerprint: "visible" },
    payload: { frozenHistory: "ACCEPTED" },
  }), now).acceptedSnapshot;
  const input = { sourceItemId: accepted.sourceItemId, stage: "request", parentSnapshotId: accepted.id,
    parentFingerprint: accepted.fingerprint, payload: { task: { prompt: "MATERIALIZED-A" }, tone: "precise" } };
  return Object.assign(f, { database, thread, accepted, input });
}
function executionInput(f, request) {
  return { sourceItemId: f.accepted.sourceItemId, stage: "execution", parentSnapshotId: request.id,
    parentFingerprint: request.fingerprint, payload: { appendSystemPrompt: ["MEMORY-A", "SKILL-A"], tools: ["read"] } };
}

test("no-Run preparation first writer wins and reopens with the exact payload", async (t) => {
  const f = await fixture(t);
  const first = f.store.saveConversationPreparedInput(f.input, now);
  assert.equal(first.idempotentReplay, false);
  const replay = f.store.saveConversationPreparedInput({ ...f.input, payload: { task: { prompt: "DRIFT" } } }, "2026-09-08T10:01:00.000Z");
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.snapshot, first.snapshot);
  assert.equal(Object.isFrozen(first.snapshot.payload), true);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.store.getConversationPreparedInput(f.accepted.sourceItemId, "request"), first.snapshot);
  assert.equal(f.store.listLingTurnRuns("prepared-turn").length, 0);
  assert.equal(f.store.listRuns().length, 0);
});

test("request and execution snapshots bind exact predecessors without polluting accepted or fork getters", async (t) => {
  const f = await fixture(t);
  const request = f.store.saveConversationPreparedInput(f.input, now).snapshot;
  const execution = f.store.saveConversationPreparedInput(executionInput(f, request), now).snapshot;
  assert.equal(execution.parentSnapshotId, request.id);
  assert.equal(execution.acceptedSnapshotId, f.accepted.id);
  assert.equal(execution.acceptedFingerprint, f.accepted.fingerprint);
  assert.deepEqual(f.store.getConversationAcceptedInputSnapshot(f.accepted.sourceItemId), f.accepted);
  assert.equal(f.store.getConversationContextSnapshot(request.id), undefined);
  assert.equal(f.store.getConversationContextSnapshot(execution.id), undefined);
  assert.deepEqual(f.store.listConversationContextSnapshots({ threadId: f.thread.id }), []);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots").get().n, 3);
});

test("missing or stale parent is rejected before returning any existing winner", async (t) => {
  const f = await fixture(t);
  const request = f.store.saveConversationPreparedInput(f.input, now).snapshot;
  for (const invalid of [{ ...f.input, parentFingerprint: "stale" }, { ...f.input, parentSnapshotId: "foreign" },
    { ...executionInput(f, request), parentFingerprint: "stale" }, { ...executionInput(f, request), sourceItemId: "foreign-item" }]) {
    assert.throws(() => f.store.saveConversationPreparedInput(invalid, now), /prepared.*parent|prepared.*source/i);
  }
  f.database.prepare("DELETE FROM conversation_context_snapshots WHERE id=?").run(f.accepted.id);
  assert.throws(() => f.store.getConversationPreparedInput(f.accepted.sourceItemId, "request"), /prepared.*invalid|prepared.*parent/i);
});

test("execution preparation cannot precede request preparation", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.store.saveConversationPreparedInput(executionInput(f, { id: "absent", fingerprint: "absent" }), now), /prepared.*parent/i);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots").get().n, 1);
});

test("payload errors, secrets, and serialization writes leave acceptance intact and no prepared row", async (t) => {
  const f = await fixture(t);
  const cyclic = {}; cyclic.self = cyclic;
  for (const payload of [cyclic, undefined, { apiKey: "not-a-real-key" }, { text: "Bearer not-a-real-token" },
    { toJSON() { f.store.createLingThread({ kind: "conversation", title: "UNEXPECTED", objective: "Side effect" }, now); return {}; } }]) {
    assert.throws(() => f.store.saveConversationPreparedInput({ ...f.input, payload }, now));
    assert.equal(f.store.getConversationPreparedInput(f.accepted.sourceItemId, "request"), undefined);
    assert.deepEqual(f.store.getConversationAcceptedInputSnapshot(f.accepted.sourceItemId), f.accepted);
  }
  assert.ok(f.store.saveConversationPreparedInput(f.input, now).snapshot);
});

test("insert and deferred commit failures do not leave prepared evidence", async (t) => {
  const f = await fixture(t);
  f.database.exec(`CREATE TRIGGER reject_prepare BEFORE INSERT ON conversation_context_snapshots
    WHEN NEW.snapshot_use LIKE 'normal_conversation_prepared_%'
    BEGIN SELECT RAISE(ABORT, 'prepare rejected'); END`);
  assert.throws(() => f.store.saveConversationPreparedInput(f.input, now), /prepare rejected/);
  f.database.exec("DROP TRIGGER reject_prepare");
  f.database.exec(`CREATE TABLE prepared_commit_failure (missing_id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_prepare_commit AFTER INSERT ON conversation_context_snapshots
    WHEN NEW.snapshot_use LIKE 'normal_conversation_prepared_%'
    BEGIN INSERT INTO prepared_commit_failure VALUES ('missing-thread'); END`);
  assert.throws(() => f.store.saveConversationPreparedInput(f.input, now), /FOREIGN KEY/);
  assert.equal(f.store.getConversationPreparedInput(f.accepted.sourceItemId, "request"), undefined);
  assert.deepEqual(f.store.getConversationAcceptedInputSnapshot(f.accepted.sourceItemId), f.accepted);
  f.database.exec("DROP TRIGGER reject_prepare_commit");
  assert.ok(f.store.saveConversationPreparedInput(f.input, now).snapshot);
});

for (const field of ["use", "version", "payload", "fingerprint", "thread", "id", "source"]) {
  test(`prepared ${field} corruption fails closed on read and rewrite`, async (t) => {
    const f = await fixture(t);
    const saved = f.store.saveConversationPreparedInput(f.input, now).snapshot;
    const updates = { use: "snapshot_use='fork_context'", version: "payload_version=9", payload: "payload_json='{}'",
      fingerprint: "payload_fingerprint='bad'", thread: "thread_id='other-thread'", id: "id='other-id'", source: "source_item_id='other-item'" };
    // Scope corruption may violate foreign keys; create actual foreign owners instead.
    if (field === "thread") f.store.createLingThread({ id: "other-thread", kind: "conversation", title: "Other", objective: "Other" }, now);
    f.database.prepare(`UPDATE conversation_context_snapshots SET ${updates[field]} WHERE id=?`).run(saved.id);
    assert.throws(() => f.store.getConversationPreparedInput(f.accepted.sourceItemId, "request"), /prepared.*invalid|prepared.*ambiguous/i);
    assert.throws(() => f.store.saveConversationPreparedInput(f.input, now), /prepared.*invalid|accepted.*snapshot|prepared.*ambiguous/i);
  });
}

test("independent SQLite writers converge on one complete snapshot without a fake Run", async (t) => {
  const f = await fixture(t);
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const workerSource = `import { parentPort, workerData } from "node:worker_threads";
    const { createSqliteRunStore } = await import(workerData.coreUrl);
    const store = createSqliteRunStore(workerData.cwd);
    parentPort.postMessage("ready");
    Atomics.wait(new Int32Array(workerData.signal), 0, 0);
    try { parentPort.postMessage({ value: store.saveConversationPreparedInput(workerData.input, workerData.now) }); }
    catch (error) { parentPort.postMessage({ error: error.message }); }
    finally { store.close(); }`;
  const workers = ["A", "B"].map((label) => new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`), {
    workerData: { cwd: f.cwd, signal: signal.buffer, now, coreUrl: new URL("../dist/index.js", import.meta.url).href,
      input: { ...f.input, payload: { task: { prompt: label.repeat(10_000) } } } },
  }));
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));
  const ready = [];
  const outcomes = workers.map((worker) => {
    let markReady; ready.push(new Promise((resolve) => { markReady = resolve; }));
    return new Promise((resolve, reject) => {
      worker.on("message", (message) => message === "ready" ? markReady() : resolve(message));
      worker.on("error", reject);
    });
  });
  await Promise.all(ready); Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
  const results = await Promise.all(outcomes);
  assert.ok(results.every((result) => !result.error), JSON.stringify(results));
  assert.deepEqual(results[0].value.snapshot, results[1].value.snapshot);
  assert.deepEqual(results.map((result) => result.value.idempotentReplay).sort(), [false, true]);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots WHERE snapshot_use='normal_conversation_prepared_request'").get().n, 1);
  assert.equal(f.store.listRuns().length, 0);
});
