import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore } from "../dist/index.js";

const now = "2026-10-14T00:00:00.000Z";
const teammateId = "teammate_builtin_engineer";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-direct-submission-"));
  const f = { cwd, store: createSqliteRunStore(cwd) };
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = f.store.getOrCreateTeammateDirectThread(teammateId, now);
  const input = { threadId: thread.id, teammateId, authorType: "local-user", authorId: "local-user",
    body: "Same text is not an identity", idempotencyKey: "input-one", requestFingerprint: "a".repeat(64) };
  return Object.assign(f, { thread, input });
}

test("private initial submission commits once, preserves its receipt on reopen and separates identical text", async t => {
  const f = await fixture(t);
  assert.equal(f.store.getTeammateDirectMessageByIdempotencyKey(teammateId, "input-one"), undefined);
  const first = f.store.acceptTeammateDirectMessage(f.input, now);
  assert.equal(first.created, true);
  const replay = f.store.acceptTeammateDirectMessage(f.input, now);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.message, first.message);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.store.getTeammateDirectMessageByIdempotencyKey(teammateId, "input-one"), first.message);
  assert.equal(f.store.acceptTeammateDirectMessage(f.input, now).created, false);
  const other = f.store.acceptTeammateDirectMessage({ ...f.input, idempotencyKey: "input-two" }, now);
  assert.notEqual(other.message.id, first.message.id);
  assert.equal(f.store.listTeammateDirectMessages({ teammateId }).length, 2);
});

test("private submission rejects drift and rolls back message creation when identity persistence fails", async t => {
  const f = await fixture(t);
  const first = f.store.acceptTeammateDirectMessage(f.input, now);
  assert.throws(() => f.store.acceptTeammateDirectMessage({ ...f.input, requestFingerprint: "b".repeat(64) }, now), /another input/);
  assert.throws(() => f.store.acceptTeammateDirectMessage({ ...f.input, threadId: "foreign" }, now), /another input/);
  assert.equal(f.store.listTeammateDirectMessages({ teammateId }).length, 1);
  const database = new DatabaseSync(f.store.paths.databasePath);
  try {
    database.exec(`CREATE TRIGGER fail_submission BEFORE UPDATE OF submission_key ON teammate_direct_messages
      BEGIN SELECT RAISE(ABORT, 'controlled identity write failure'); END`);
    assert.throws(() => f.store.acceptTeammateDirectMessage({ ...f.input, idempotencyKey: "rollback" }, now), /controlled identity write failure/);
    assert.equal(f.store.getTeammateDirectMessageByIdempotencyKey(teammateId, "rollback"), undefined);
    assert.deepEqual(f.store.listTeammateDirectMessages({ teammateId }), [first.message]);
  } finally { database.close(); }
});

test("private submission isolates teammate/workspace and preserves legacy unkeyed creation", async t => {
  const f = await fixture(t);
  const first = f.store.acceptTeammateDirectMessage(f.input, now);
  const designer = "teammate_builtin_designer";
  assert.equal(f.store.getTeammateDirectMessageByIdempotencyKey(designer, f.input.idempotencyKey), undefined);
  const otherThread = f.store.getOrCreateTeammateDirectThread(designer, now);
  const other = f.store.acceptTeammateDirectMessage({ ...f.input, teammateId: designer, threadId: otherThread.id }, now);
  assert.notEqual(other.message.id, first.message.id);
  const otherCwd = await mkdtemp(join(tmpdir(), "ling-direct-other-workspace-"));
  const otherStore = createSqliteRunStore(otherCwd);
  try {
    assert.equal(otherStore.getTeammateDirectMessageByIdempotencyKey(teammateId, f.input.idempotencyKey), undefined);
  } finally { otherStore.close(); await rm(otherCwd, { recursive: true, force: true }); }
  const legacy = { threadId: f.thread.id, teammateId, authorType: "local-user", authorId: "local-user", body: f.input.body };
  assert.notEqual(f.store.createTeammateDirectMessage(legacy, now).id, f.store.createTeammateDirectMessage(legacy, now).id);
});

test("two independent SQLite writers claim one private submission", async t => {
  const f = await fixture(t);
  const barrier = new SharedArrayBuffer(4);
  const gate = new Int32Array(barrier);
  const workers = [0, 1].map(() => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createSqliteRunStore } = await import(workerData.module);
      const store = createSqliteRunStore(workerData.cwd);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try { parentPort.postMessage({ result: store.acceptTeammateDirectMessage(workerData.input, workerData.now) }); }
      finally { store.close(); }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { cwd: f.cwd, input: f.input, now, barrier, module: new URL("../dist/index.js", import.meta.url).href } }));
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); });
  const results = workers.map(w => new Promise((resolve, reject) => { w.on("error", reject); w.on("message", m => { if (m.result) resolve(m.result); }); }));
  await Promise.all(workers.map(w => new Promise(resolve => w.on("message", m => { if (m.ready) resolve(); }))));
  Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
  const claims = await Promise.all(results);
  assert.deepEqual(claims.map(c => c.created).sort(), [false, true]);
  assert.equal(claims[0].message.id, claims[1].message.id);
  assert.equal(f.store.listTeammateDirectMessages({ teammateId }).length, 1);
});
