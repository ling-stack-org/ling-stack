import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths, toRuntimeAttemptFence } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { reconcileHarnessToolExecutionsAtStartup } from "../dist/features/harness/tool-execution/recovery.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

const now = "2026-09-13T00:00:00.000Z";
const expired = "2026-09-13T00:00:30.000Z";
const future = "2099-01-01T00:00:00.000Z";

async function fixture(t, count) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-tool-startup-tail-"));
  let seed;
  let observer;
  const daemons = [];
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const daemon of daemons) await daemon.stop();
    observer?.close();
    seed?.close();
    await rm(cwd, { recursive: true, force: true });
  });
  seed = createSqliteRunStore(cwd);
  const unit = seed.createWorkUnit({ workspaceId: "workspace_default", kind: "task_run", ownerType: "run",
    ownerId: "run-startup-tail", idempotencyKey: "startup-tail", status: "running", createdByActor: "system",
    request: {}, now });
  const attempt = seed.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "crashed-runtime", runnerId: "pi", status: "started", now });
  const run = seed.createRun({ id: "run-startup-tail", cwd, taskId: "task-startup-tail", workUnitId: unit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {},
    createdAt: now });
  seed.linkRunToWorkUnit(run.id, unit.id, now);
  seed.markRunStarted(run.id, now);
  const policy = seed.createArtifact({ id: "startup-tail-policy", runId: run.id, type: "json",
    path: "harness/startup-tail-policy.json", sealedPayload: {}, createdAt: now });
  const sourceFence = toRuntimeAttemptFence(attempt);
  for (let index = 0; index < count; index += 1) {
    const id = `startup-tool-${String(index).padStart(4, "0")}`;
    const execution = seed.prepareHarnessToolExecution({ id, runId: run.id, workUnitId: unit.id, sourceFence,
      toolCallId: id, toolName: "bash", executorKind: "bash", requestDigest: "a".repeat(64),
      sideEffectFingerprint: "b".repeat(64), policySnapshotArtifactId: policy.id, approvalState: "allowed",
      sandboxProfileId: "workspace-write", now }).execution;
    assert.equal(seed.claimHarnessToolExecution({ executionId: id, expectedRevision: execution.revision,
      claimOwner: "crashed-daemon", claimToken: id, claimExpiresAt: index === 501 ? future : expired,
      sourceFence, now }).ok, true);
    assert.equal(seed.startHarnessToolExecution({ executionId: id, expectedRevision: 1,
      claimOwner: "crashed-daemon", claimToken: id, sourceFence, now }).ok, true);
  }
  return { cwd, store: seed, closeSeed() { seed.close(); seed = undefined; },
    onCleanup(cleanup) { cleanups.push(cleanup); },
    observe() { observer = new DatabaseSync(resolveRuntimePaths(cwd).databasePath, { readOnly: true }); return observer; },
    createDaemon() {
      const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
        harness: { continuations: { mode: "off" }, evaluations: { mode: "off" }, delegations: { mode: "off" } } });
      daemons.push(daemon);
      return daemon;
    } };
}

/** Seed real fenced executions, close SQLite, and reopen through the production startup callback. */
test("daemon startup settles the expired ToolExecution tail beyond 500 before returning the Store", async t => {
  const f = await fixture(t, 502);
  const { cwd } = f;
  f.closeSeed();
  // Reproduce a crash after entering evidence commit, without claiming a known result.
  const crash = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  crash.prepare("UPDATE harness_tool_executions SET state = 'committing_evidence' WHERE id = ?")
    .run("startup-tool-0000");
  crash.close();
  const observer = f.observe();
  const rows = () => observer.prepare("SELECT id, state, revision, failure_code FROM harness_tool_executions ORDER BY id").all();
  assert.equal(rows().filter(row => row.state === "executing" || row.state === "committing_evidence").length, 502);

  const daemon = f.createDaemon();
  await daemon.start();
  const first = rows();
  assert.equal(first.filter(row => row.state === "unknown_outcome").length, 501,
    "all eligible pages must settle synchronously before any recovery dispatch can observe the Store");
  assert.ok(first.slice(0, 501).every(row => row.revision === 3 && row.failure_code === "tool.unknown_side_effect_outcome"));
  assert.deepEqual({ ...first[501] }, { id: "startup-tool-0501", state: "executing", revision: 2, failure_code: null });
  await daemon.stop();
  f.createDaemon();
  assert.deepEqual(rows(), first, "a second real startup must not re-settle or replay the prior tool effects");
});

test("startup recovery follows discovery cursor even when a competing recovery wins the whole first page", async t => {
  const f = await fixture(t, 5);
  const original = f.store.reconcileAbandonedHarnessToolExecutionsPage.bind(f.store);
  let calls = 0;
  f.store.reconcileAbandonedHarnessToolExecutionsPage = input => {
    calls += 1;
    return original({ ...input, classify: execution => {
      if (calls === 1) original({ now: input.now, limit: 2 });
      return input.classify?.(execution);
    } });
  };
  const result = reconcileHarnessToolExecutionsAtStartup({ cwd: f.cwd, store: f.store, now: future, limit: 2 });
  assert.deepEqual(result, { scanned: 5, updated: 3, skipped: 2, pages: 3 });
  assert.equal(calls, 3);
  assert.ok(f.store.listHarnessToolExecutions("run-startup-tail").every(row => row.state === "unknown_outcome" && row.revision === 3));
});

test("synchronous shutdown signal between pages aborts startup and the next sweep consumes the remaining rows", async t => {
  const f = await fixture(t, 5);
  const controller = new AbortController();
  const original = f.store.reconcileAbandonedHarnessToolExecutionsPage.bind(f.store);
  const stopped = new Error("fixture-shutdown");
  let calls = 0;
  f.store.reconcileAbandonedHarnessToolExecutionsPage = input => {
    calls += 1;
    const result = original(input);
    controller.abort(stopped);
    return result;
  };
  assert.throws(() => reconcileHarnessToolExecutionsAtStartup({ cwd: f.cwd, store: f.store,
    now: future, limit: 2, signal: controller.signal }), error => error === stopped);
  assert.equal(calls, 1);
  assert.equal(f.store.listHarnessToolExecutions("run-startup-tail").filter(row => row.state === "unknown_outcome").length, 2);
  f.store.reconcileAbandonedHarnessToolExecutionsPage = original;
  assert.deepEqual(reconcileHarnessToolExecutionsAtStartup({ cwd: f.cwd, store: f.store, now: future, limit: 2 }),
    { scanned: 3, updated: 3, skipped: 0, pages: 2 });
  assert.deepEqual(reconcileHarnessToolExecutionsAtStartup({ cwd: f.cwd, store: f.store, now: future, limit: 2 }),
    { scanned: 0, updated: 0, skipped: 0, pages: 1 });
});

test("startup page errors propagate instead of returning an incomplete success", async t => {
  const f = await fixture(t, 5);
  const original = f.store.reconcileAbandonedHarnessToolExecutionsPage.bind(f.store);
  const failed = new Error("fixture-page-query-failed");
  let calls = 0;
  f.store.reconcileAbandonedHarnessToolExecutionsPage = input => {
    calls += 1;
    if (calls === 2) throw failed;
    return original(input);
  };
  assert.throws(() => reconcileHarnessToolExecutionsAtStartup({ cwd: f.cwd, store: f.store, now: future, limit: 2 }),
    error => error === failed);
  assert.equal(calls, 2);
  assert.equal(f.store.listHarnessToolExecutions("run-startup-tail").filter(row => row.state === "unknown_outcome").length, 2);
});

test("real second-page failure evicts the Store and a fresh initialization settles the remaining SQLite tail before dispatch", async t => {
  const f = await fixture(t, 3);
  f.closeSeed();
  const failed = new Error("fixture-real-page-two-failed");
  const stores = [];
  const dispatched = [];
  let initialization = 0;
  const registry = new RunStoreRegistry(cwd => {
    const store = createSqliteRunStore(cwd);
    stores.push(store);
    const original = store.reconcileAbandonedHarnessToolExecutionsPage.bind(store);
    let page = 0;
    store.reconcileAbandonedHarnessToolExecutionsPage = input => {
      page += 1;
      if (initialization === 1 && page === 2) throw failed;
      return original(input);
    };
    return store;
  }, { onStoreInitialized(cwd, store) {
    initialization += 1;
    registry.rememberRun("run-startup-tail", store);
    reconcileHarnessToolExecutionsAtStartup({ cwd, store, now: future, limit: 2 });
    dispatched.push(store);
  } });
  f.onCleanup(() => registry.closeAll());
  assert.throws(() => registry.getStore(f.cwd), error => error === failed);
  assert.deepEqual(dispatched, []);
  const observer = f.observe();
  assert.equal(observer.prepare("SELECT count(*) AS n FROM harness_tool_executions WHERE state='unknown_outcome'").get().n, 2);
  assert.throws(() => stores[0].listHarnessToolExecutions("run-startup-tail"), /closed|not open/u);
  const recovered = registry.getStore(f.cwd);
  assert.equal(stores.length, 2);
  assert.equal(initialization, 2);
  assert.deepEqual(dispatched, [recovered]);
  assert.equal(registry.findStoreForRun("run-startup-tail", f.cwd), recovered);
  assert.ok(recovered.listHarnessToolExecutions("run-startup-tail").every(row => row.state === "unknown_outcome" && row.revision === 3));
});

test("production approval sweep does not retain a Store whose tool startup failed", { timeout: 20000 }, async t => {
  const f = await fixture(t, 3);
  f.closeSeed();
  const defaultCwd = await mkdtemp(join(tmpdir(), "ling-tool-startup-default-"));
  let targetOpens = 0;
  let queriesAgainstClosedStore = 0;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: defaultCwd,
    harness: { continuations: { mode: "off" }, evaluations: { mode: "off" }, delegations: { mode: "off" } } }, {
    storeFactory(cwd) {
      const store = createSqliteRunStore(cwd);
      if (cwd !== f.cwd) return store;
      targetOpens += 1;
      const failedOpening = targetOpens === 1;
      const reconcile = store.reconcileAbandonedHarnessToolExecutionsPage.bind(store);
      const effects = store.listApprovalPostCommitEffects.bind(store);
      const close = store.close.bind(store);
      let closed = false;
      store.close = () => { close(); closed = true; };
      store.listApprovalPostCommitEffects = (...args) => {
        if (closed) queriesAgainstClosedStore += 1;
        return effects(...args);
      };
      store.reconcileAbandonedHarnessToolExecutionsPage = input => {
        if (failedOpening) throw new Error("fixture-production-startup-query-failed");
        return reconcile(input);
      };
      return store;
    },
  });
  f.onCleanup(async () => { await daemon.stop(); await rm(defaultCwd, { recursive: true, force: true }); });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/runs?cwd=${encodeURIComponent(f.cwd)}`;
  const first = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(first.status, 400);
  await first.json();
  // Observe the actual 10s approval recovery interval, not a synthetic Set or callback.
  await new Promise(resolve => setTimeout(resolve, 11000));
  assert.equal(queriesAgainstClosedStore, 0, "failed initialization must not register a closed Store for periodic approval recovery");
  const retry = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).runs.length, 1);
  assert.equal(targetOpens, 2);
  const observer = f.observe();
  assert.equal(observer.prepare("SELECT count(*) AS n FROM harness_tool_executions WHERE state='unknown_outcome'").get().n, 3);
});
