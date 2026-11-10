import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

const now = "2026-09-10T08:00:00.000Z";
async function fixture(t, engineId = "openclaw-acp") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-openclaw-routing-"));
  const stores = [];
  const open = () => { const store = createSqliteRunStore(cwd); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) store.close(); await rm(cwd, { recursive: true, force: true }); });
  const store = open();
  const channel = store.createChannel({ name: "Routing test", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Routing", prompt: "Synthetic" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "Routing", objective: "Synthetic" }, now);
  let number = 0;
  const reserve = (options = {}) => {
    const id = `routing_${++number}`;
    store.createRun({ id, cwd, taskId: task.id, channelId: channel.id, threadId: options.threadId ?? thread.id,
      teammateId: options.teammateId, providerName: "native", providerModel: "fixture", taskSnapshot: task,
      providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
    const work = store.createWorkUnit({ id: `work_${id}`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
      ownerType: "run", ownerId: id, linkedRunId: id, idempotencyKey: id, createdByActor: "user", request: {}, runnerId: engineId, now });
    const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1, runtimeInstanceId: "owned", runnerId: engineId, now });
    store.linkRunToWorkUnit(id, work.id, now);
    const fence = toRuntimeAttemptFence(attempt);
    const input = { runId: id, fence, generation: options.generation ?? 1, selection: { engineId,
      profileId: "profile", profileRevision: 1, profileFingerprint: "a".repeat(64), configurationFingerprint: "b".repeat(64) } };
    const entry = store.reserveNativeExecution(input, now);
    return { ...entry, input, key: { submissionId: entry.submission.id, fence } };
  };
  return { cwd, store, open, reserve, thread };
}

test("OpenClaw route is separate from its ACP id and survives idempotency and SQLite reopen", async t => {
  const f = await fixture(t);
  const entry = f.reserve();
  const route = f.store.prepareNativeOpenClawSession({ ...entry.key, agentId: "My_Agent" }, now);
  assert.equal(route.agentId, "my_agent");
  assert.match(route.sessionKey, /^agent:my_agent:ling:[0-9a-f-]{36}$/);
  assert.equal(route.requireExistingSession, false);
  assert.deepEqual(f.open().prepareNativeOpenClawSession({ ...entry.key, agentId: "my_agent" }, now), route);
  assert.equal(f.store.reserveNativeExecution(entry.input, now).binding.openclawSession.sessionKey, route.sessionKey);
  f.store.bindNativeExecutionSession({ ...entry.key, nativeSessionId: "opaque-acp-uuid" }, now);
  const binding = f.open().getNativeExecutionBinding(entry.binding.id);
  assert.equal(binding.nativeSessionId, "opaque-acp-uuid");
  assert.deepEqual(binding.openclawSession, { agentId: "my_agent", sessionKey: route.sessionKey });
  assert.equal(f.store.prepareNativeOpenClawSession({ ...entry.key, agentId: "my_agent" }, now).requireExistingSession, false);
  assert.throws(() => f.store.prepareNativeOpenClawSession({ ...entry.key, agentId: "other" }, now), { code: "native_binding_conflict" });
  assert.deepEqual(f.store.getNativeExecutionBinding(entry.binding.id), binding);
});

test("OpenClaw requires prior accepted activity, not local session allocation or prompt write", async t => {
  const f = await fixture(t);
  const first = f.reserve();
  const prepare = key => f.store.prepareNativeOpenClawSession({ ...key, agentId: "main" }, now);
  const initial = prepare(first.key);
  f.store.bindNativeExecutionSession({ ...first.key, nativeSessionId: "acp-only" }, now);
  f.store.finishNativeSubmission({ ...first.key, outcome: "not_submitted" }, now);
  const second = f.reserve();
  assert.deepEqual(prepare(second.key), initial);
  f.store.beginNativeSubmission({ ...second.key, nativePromptRequestId: 1 }, now);
  assert.equal(f.open().getNativeExecutionBinding(first.binding.id).openclawSession.acceptedAt, undefined);
  assert.throws(() => prepare(second.key), { code: "native_submission_conflict" });
  f.store.acceptNativeSubmission({ ...second.key, nativePromptRequestId: 1 }, now);
  assert.equal(f.open().getNativeExecutionBinding(first.binding.id).openclawSession.acceptedAt, now);
  f.store.finishNativeSubmission({ ...second.key, outcome: "completed" }, now);
  const third = f.reserve();
  assert.deepEqual(prepare(third.key), { ...initial, requireExistingSession: true });
  f.store.beginNativeSubmission({ ...third.key, nativePromptRequestId: 1 }, now);
  f.store.markNativeSubmissionUnknown(third.key, now);
  assert.throws(() => f.open().prepareNativeOpenClawSession({ ...third.key, agentId: "main" }, now), { code: "native_submission_conflict" });
  assert.throws(() => f.reserve(), { code: "native_session_busy" });
});

test("OpenClaw invalid or caller-chosen routing never consumes a reservation", async t => {
  const f = await fixture(t), entry = f.reserve();
  for (const agentId of [undefined, "", " main", "main ", "with.dot", "-main", "a".repeat(65), "main\n", "agent:main", "../main", "中文"]) {
    assert.throws(() => f.store.prepareNativeOpenClawSession({ ...entry.key, agentId }, now), { code: "native_journal_invalid" });
  }
  for (const extra of [{ sessionKey: "agent:main:main" }, { sessionLabel: "global" }, { requireExistingSession: false }, { resetSession: true }]) {
    assert.throws(() => f.store.prepareNativeOpenClawSession({ ...entry.key, agentId: "main", ...extra }, now), { code: "native_journal_invalid" });
  }
  assert.equal(f.store.getNativeExecutionBinding(entry.binding.id).openclawSession, undefined);
  assert.equal(f.store.getNativeSubmission(entry.key.submissionId).status, "reserved");
});

test("OpenClaw route allocation is fenced against a replacement Attempt and cannot affect Kimi", async t => {
  const f = await fixture(t), entry = f.reserve();
  f.store.createWorkUnitAttempt({ workUnitId: entry.key.fence.workUnitId, attemptNumber: 2, runtimeInstanceId: "replacement", runnerId: "openclaw-acp", now });
  assert.throws(() => f.store.prepareNativeOpenClawSession({ ...entry.key, agentId: "main" }, now), { code: "native_owner_mismatch" });
  assert.equal(f.store.getNativeExecutionBinding(entry.binding.id).openclawSession, undefined);
  const k = await fixture(t, "kimi-acp"), kimi = k.reserve();
  assert.throws(() => k.store.prepareNativeOpenClawSession({ ...kimi.key, agentId: "main" }, now), { code: "native_binding_conflict" });
  assert.equal(k.store.getNativeExecutionBinding(kimi.binding.id).openclawSession, undefined);
  assert.equal(k.store.bindNativeExecutionSession({ ...kimi.key, nativeSessionId: "kimi-session" }, now).nativeSessionId, "kimi-session");
});

test("OpenClaw remote identities are isolated by thread, participant, generation and workspace", async t => {
  const f = await fixture(t), first = f.reserve();
  const routes = [f.store.prepareNativeOpenClawSession({ ...first.key, agentId: "main" }, now)];
  const thread = f.store.createLingThread({ kind: "conversation", title: "Other", objective: "Synthetic" }, now);
  for (const options of [{ threadId: thread.id }, { teammateId: "teammate-fixture" }]) {
    const entry = f.reserve(options);
    routes.push(f.store.prepareNativeOpenClawSession({ ...entry.key, agentId: "main" }, now));
  }
  f.store.finishNativeSubmission({ ...first.key, outcome: "not_submitted" }, now);
  const generation = f.reserve({ generation: 2 });
  routes.push(f.store.prepareNativeOpenClawSession({ ...generation.key, agentId: "other" }, now));
  const other = await fixture(t), entry = other.reserve();
  routes.push(other.store.prepareNativeOpenClawSession({ ...entry.key, agentId: "main" }, now));
  assert.equal(new Set(routes.map(route => route.sessionKey)).size, 5);
  assert.ok(routes.every(route => route.requireExistingSession === false));
});

test("OpenClaw cannot bind or send without a dedicated route", async t => {
  const f = await fixture(t), entry = f.reserve();
  assert.throws(() => f.store.bindNativeExecutionSession({ ...entry.key, nativeSessionId: "unrouted" }, now), { code: "native_session_missing" });
  const db = new DatabaseSync(f.store.paths.databasePath);
  try { db.prepare("UPDATE native_execution_bindings SET native_session_id = 'legacy' WHERE id = ?").run(entry.binding.id); }
  finally { db.close(); }
  assert.throws(() => f.store.prepareNativeOpenClawSession({ ...entry.key, agentId: "main" }, now), { code: "native_binding_conflict" });
  assert.throws(() => f.store.beginNativeSubmission({ ...entry.key, nativePromptRequestId: 1 }, now), { code: "native_session_missing" });
  assert.equal(f.store.getNativeSubmission(entry.key.submissionId).status, "reserved");
});

test("OpenClaw migration keeps legacy ACP identity without inventing remote history", async t => {
  const f = await fixture(t), entry = f.reserve();
  const path = f.store.paths.databasePath;
  f.store.close();
  const db = new DatabaseSync(path);
  try {
    db.exec("DROP INDEX native_openclaw_session_identity; ALTER TABLE native_execution_bindings DROP COLUMN openclaw_agent_id; ALTER TABLE native_execution_bindings DROP COLUMN openclaw_session_key; ALTER TABLE native_execution_bindings DROP COLUMN openclaw_accepted_at; DELETE FROM schema_migrations WHERE version = 174;");
    db.prepare("UPDATE native_execution_bindings SET native_session_id = 'legacy-acp' WHERE id = ?").run(entry.binding.id);
  } finally { db.close(); }
  const migrated = f.open(), binding = migrated.getNativeExecutionBinding(entry.binding.id);
  assert.equal(binding.nativeSessionId, "legacy-acp");
  assert.equal(binding.openclawSession, undefined);
  assert.throws(() => migrated.prepareNativeOpenClawSession({ ...entry.key, agentId: "main" }, now), { code: "native_binding_conflict" });
  assert.deepEqual(f.open().getNativeExecutionBinding(entry.binding.id), binding);
});

test("OpenClaw first acceptance rolls back with a failed submission transition", async t => {
  const f = await fixture(t), entry = f.reserve();
  f.store.prepareNativeOpenClawSession({ ...entry.key, agentId: "main" }, now);
  f.store.bindNativeExecutionSession({ ...entry.key, nativeSessionId: "acp" }, now);
  f.store.beginNativeSubmission({ ...entry.key, nativePromptRequestId: 1 }, now);
  const db = new DatabaseSync(f.store.paths.databasePath);
  try {
    db.exec("CREATE TRIGGER reject_accept BEFORE UPDATE OF status ON native_submissions WHEN NEW.status = 'accepted' BEGIN SELECT RAISE(FAIL, 'injected_accept'); END;");
    assert.throws(() => f.store.acceptNativeSubmission({ ...entry.key, nativePromptRequestId: 1 }, now), /injected_accept/);
    assert.equal(f.open().getNativeExecutionBinding(entry.binding.id).openclawSession.acceptedAt, undefined);
    assert.equal(f.store.getNativeSubmission(entry.key.submissionId).status, "submission_pending");
    db.exec("DROP TRIGGER reject_accept;");
    f.store.acceptNativeSubmission({ ...entry.key, nativePromptRequestId: 1 }, now);
    const later = "2026-09-10T09:00:00.000Z";
    f.open().acceptNativeSubmission({ ...entry.key, nativePromptRequestId: 1 }, later);
    assert.equal(f.store.getNativeExecutionBinding(entry.binding.id).openclawSession.acceptedAt, now);
  } finally { db.close(); }
});

test("OpenClaw migration failure rolls back columns and can be retried without losing legacy rows", async t => {
  const f = await fixture(t), entry = f.reserve();
  f.store.close();
  const db = new DatabaseSync(f.store.paths.databasePath);
  try {
    db.exec("DROP INDEX native_openclaw_session_identity; ALTER TABLE native_execution_bindings DROP COLUMN openclaw_agent_id; ALTER TABLE native_execution_bindings DROP COLUMN openclaw_session_key; ALTER TABLE native_execution_bindings DROP COLUMN openclaw_accepted_at; DELETE FROM schema_migrations WHERE version = 174;");
    db.exec("CREATE TRIGGER reject_route_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 174 BEGIN SELECT RAISE(FAIL, 'injected_route_migration'); END;");
    assert.throws(() => f.open(), /injected_route_migration/);
    assert.equal(db.prepare("PRAGMA table_info(native_execution_bindings)").all().some(row => row.name.startsWith("openclaw_")), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_execution_bindings WHERE id = ?").get(entry.binding.id).count, 1);
    db.exec("DROP TRIGGER reject_route_migration;");
  } finally { db.close(); }
  assert.equal(f.open().getNativeExecutionBinding(entry.binding.id).openclawSession, undefined);
});

for (const conflict of [false, true]) test(`OpenClaw competing route allocators preserve one identity (different Agent=${conflict})`, { timeout: 15000 }, async t => {
  const f = await fixture(t), entry = f.reserve();
  const start = new SharedArrayBuffer(4);
  const workers = ["main", conflict ? "other" : "main"].map(agentId => new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {createSqliteRunStore}=await import(workerData.module);
      const store=createSqliteRunStore(workerData.cwd);parentPort.postMessage({ready:true});
      Atomics.wait(new Int32Array(workerData.start),0,0);
      try {parentPort.postMessage({route:store.prepareNativeOpenClawSession({...workerData.key,agentId:workerData.agentId},workerData.now)});}
      catch(error){parentPort.postMessage({error:error.code??error.message});}
      finally{store.close();}})();
  `, { eval: true, workerData: { cwd: f.cwd, key: entry.key, agentId, now, start, module: new URL("../dist/index.js", import.meta.url).href } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const ready = workers.map(worker => new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); }));
  const results = workers.map(worker => new Promise((resolve, reject) => {
    worker.on("message", value => { if (!value.ready) resolve(value); }); worker.once("error", reject);
  }));
  const exits = workers.map(worker => new Promise((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); }));
  await Promise.all(ready); Atomics.store(new Int32Array(start), 0, 1); Atomics.notify(new Int32Array(start), 0);
  const values = await Promise.all(results);
  assert.deepEqual(await Promise.all(exits), [0, 0]);
  const saved = f.open().getNativeExecutionBinding(entry.binding.id).openclawSession;
  assert.equal(values.filter(value => value.error).length, conflict ? 1 : 0);
  for (const value of values) {
    if (value.error) assert.equal(value.error, "native_binding_conflict");
    else assert.deepEqual(value.route, { ...saved, requireExistingSession: false });
  }
});
