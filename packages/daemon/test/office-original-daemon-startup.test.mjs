import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { DaemonRunnerRecoveryCoordinator } from "../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import { captureOriginalOfficeDirectoryAuthorityV2, createOriginalOfficeDirectoryStoreFactory,
  readOriginalOfficeDirectoryNativeRuntime }
  from "../dist/features/office-documents/office-local-directory-core-authority.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { isOriginalRuntimeSupervisorOfficeRoot, RuntimeSupervisor } from "../dist/runtime/supervisor.js";

/** Observe the real early Store access; no replacement factory or native authority. */
async function fixture(t, dependencies = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-office-original-startup-"));
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(cwd, "ling-home");
  const stores = [], retired = [], getStore = RunStoreRegistry.prototype.getStore,
    releaseAll = RuntimeSupervisor.prototype.releaseAll;
  t.mock.method(RunStoreRegistry.prototype, "getStore", function (path) {
    const store = getStore.call(this, path);
    if (!stores.includes(store)) stores.push(store);
    return store;
  });
  t.mock.method(RuntimeSupervisor.prototype, "releaseAll", function () {
    releaseAll.call(this);
    if (!retired.includes(this)) retired.push(this);
  });
  let daemon;
  t.after(async () => {
    try { await daemon?.stop(); }
    finally {
      t.mock.restoreAll();
      if (previousHome === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = previousHome;
      await rm(cwd, { recursive: true, force: true });
    }
  });
  daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, dependencies);
  return { cwd, daemon, stores, retired };
}

/** A sentinel is only a map-membership probe, not a fake positive native proof. */
function compositionProbe(store) {
  const reachedRuntime = new Error("original Store admitted before runtime validation");
  let runtimeReads = 0;
  const runtime = { get store() { runtimeReads++; throw reachedRuntime; } };
  let failure;
  try { captureOriginalOfficeDirectoryAuthorityV2(store, runtime, Object.freeze({})); }
  catch (error) { failure = error; }
  return { failure, reachedRuntime, runtimeReads };
}

test("the actual daemon opens its default original Store before start and retires the same root on stop", async t => {
  const f = await fixture(t);
  assert.equal(f.daemon.server.listening, false);
  assert.equal(f.stores.length, 1, "early plugin sync must reuse one cached default Store");
  const probe = compositionProbe(f.stores[0]);
  assert.equal(probe.failure, probe.reachedRuntime, "default startup must use the private original composition factory");
  assert.equal(probe.runtimeReads, 1);
  assert.equal(readOriginalOfficeDirectoryNativeRuntime(f.stores[0]), undefined,
    "the original factory alone must not enable an unconfigured native artifact");
  await f.daemon.start();
  assert.equal(f.daemon.server.listening, true);
  assert.equal(f.stores.length, 1, "startup/recovery must not construct another Store");
  await f.daemon.stop();
  assert.equal(f.daemon.server.listening, false);
  assert.equal(f.retired.length, 1, "one original Supervisor owns all early/default Store access");
  assert.equal(isOriginalRuntimeSupervisorOfficeRoot(f.retired[0]), false);
  assert.throws(() => createOriginalOfficeDirectoryStoreFactory(f.retired[0]), /office_local_directory_core_composition_invalid/u);
});

test("an injected ordinary Store factory remains untrusted through actual daemon startup", async t => {
  const produced = [];
  const f = await fixture(t, { storeFactory(cwd) {
    const store = createSqliteRunStore(cwd); produced.push(store); return store;
  } });
  assert.deepEqual(f.stores, produced);
  assert.equal(produced.length, 1);
  const probe = compositionProbe(produced[0]);
  assert.match(probe.failure?.message ?? "", /office_local_directory_core_composition_invalid/u);
  assert.equal(probe.runtimeReads, 0, "injection cannot be retrofitted by a caller runtime getter");
  assert.throws(() => readOriginalOfficeDirectoryNativeRuntime(produced[0]), /office_local_directory_core_composition_invalid/u);
  await f.daemon.start();
  assert.equal(produced.length, 1);
  await f.daemon.stop();
  assert.equal(f.retired.length, 1);
  assert.equal(isOriginalRuntimeSupervisorOfficeRoot(f.retired[0]), false);
});

test("construction without start still retires the one original root on stop", async t => {
  const f = await fixture(t), probe = compositionProbe(f.stores[0]);
  assert.equal(probe.failure, probe.reachedRuntime);
  assert.equal(f.daemon.server.listening, false);
  await f.daemon.stop();
  assert.equal(f.retired.length, 1);
  assert.equal(isOriginalRuntimeSupervisorOfficeRoot(f.retired[0]), false);
  assert.throws(() => readOriginalOfficeDirectoryNativeRuntime(f.stores[0]), /office_local_directory_core_composition_invalid/u);
});

test("failed initialization retires its original default Store root and a new daemon starts independently", async t => {
  const f = await fixture(t), failure = new Error("isolated original startup failure");
  const patch = t.mock.method(DaemonRunnerRecoveryCoordinator.prototype, "start", () => { throw failure; });
  const probe = compositionProbe(f.stores[0]);
  assert.equal(probe.failure, probe.reachedRuntime);
  await assert.rejects(f.daemon.start(), error => error === failure);
  assert.equal(f.daemon.server.listening, false);
  assert.equal(f.retired.length, 1);
  assert.equal(isOriginalRuntimeSupervisorOfficeRoot(f.retired[0]), false);
  assert.throws(() => createOriginalOfficeDirectoryStoreFactory(f.retired[0]), /office_local_directory_core_composition_invalid/u);
  patch.mock.restore();
  const replacement = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: f.cwd });
  try {
    await replacement.start();
    assert.equal(replacement.server.listening, true);
    assert.notEqual(f.stores[1], f.stores[0]);
    const next = compositionProbe(f.stores[1]);
    assert.equal(next.failure, next.reachedRuntime, "a fresh default root cannot borrow the retired Store");
  } finally { await replacement.stop(); }
});
