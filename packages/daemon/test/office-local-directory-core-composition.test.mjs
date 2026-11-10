import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore, createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveSessionRunPolicy, toRuntimeAttemptFence } from "@ling-stack/core";
import {
  assertOriginalOfficeHostBridgeForCompositionCurrent,
  captureOriginalOfficeHostBridgeReader,
  createOriginalOfficeHostBridgeForComposition,
  mintOriginalOfficeDirectoryAuthorityV2,
  sealOriginalOfficeHostBridgeForComposition,
} from "@ling-stack/core/original-office-host-bridge";
import { resolveConfig } from "../dist/config.js";
import {
  RuntimeSupervisor,
  isOriginalRuntimeSupervisorOfficeRoot,
  retainOriginalRuntimeSupervisorOfficeStoreBridge,
} from "../dist/runtime/supervisor.js";
import {
  captureOriginalOfficeDirectoryAuthorityV2,
  createOriginalOfficeDirectoryStoreFactory,
  readOriginalOfficeDirectoryNativeRuntime,
} from "../dist/features/office-documents/office-local-directory-core-authority.js";
import {
  OfficeLocalNativeRuntime,
  assertOriginalOfficeDirectoryRuntimeBinding,
  captureOriginalOfficeDirectoryRuntimeCustody,
  isOwnedOfficeLocalNativeRuntime,
} from "../dist/features/office-documents/office-local-native-runtime.js";
import {
  ProtectedHostStageRegistry,
  assertOriginalProtectedHostOfficeStage,
  beginOriginalProtectedHostOfficeDirectoryWindow,
} from "../dist/runtime/sandbox/protected-host-staging.js";
import { readOriginalProtectedHostActorEntries } from "../dist/runtime/sandbox/protected-host-original-entry-manifest.js";

// Composition/retirement mechanisms and refusal paths only. No addon is loaded,
// native issuer fabricated, manifest substituted or genuine Host/Core-safe bind claimed.
const compositionInvalid = /office_local_directory_core_composition_invalid/u;
const unavailable = error => error?.code === "host_office_local_bridge_unavailable";
const wrongOwner = error => error?.code === "host_office_local_bridge_owner_invalid";
const copies = value => [Object.freeze({ ...value }), new Proxy(value, {})];

/** Real ephemeral SQLite Stores and an original constructor root, without native bootstrap. */
function fixture(t, { actorEntries } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-core-composition-")));
  const config = resolveConfig({ defaultWorkspaceCwd: root });
  const supervisor = new RuntimeSupervisor(config, undefined, { actorEntries }), stores = [], beforeClose = [];
  const factory = createOriginalOfficeDirectoryStoreFactory(supervisor);
  function workspace(name) {
    const cwd = join(root, name); mkdirSync(cwd, { mode: 0o700 }); return cwd;
  }
  function open(name, create = factory) {
    const cwd = workspace(name), store = create(cwd); stores.push(store); return store;
  }
  t.after(() => {
    try {
      for (const cleanup of beforeClose) cleanup();
      supervisor.releaseAll();
    }
    finally {
      try { for (const store of stores) store.close(); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  return { root, config, supervisor, factory, workspace, open, beforeClose };
}

/** A direct Core transport realm only: its no-op endpoint proves no Host/native authority. */
function transport(store) {
  const pair = createOriginalOfficeHostBridgeForComposition();
  const bridge = captureOriginalOfficeHostBridgeReader(pair.reader, store);
  sealOriginalOfficeHostBridgeForComposition(pair.setup, store, Object.freeze({
    assertBinding() {}, closeBoundWindow() {}, assertClosedBoundWindow() {},
  }));
  const authority = mintOriginalOfficeDirectoryAuthorityV2(pair.setup, Object.freeze({}));
  bridge.assertAuthorityOwned(authority);
  return { ...pair, store, bridge, authority };
}

function assertRetired(channel) {
  assert.throws(() => assertOriginalOfficeHostBridgeForCompositionCurrent(channel.setup, channel.store), unavailable);
  assert.throws(() => mintOriginalOfficeDirectoryAuthorityV2(channel.setup, Object.freeze({})), unavailable);
  assert.throws(() => channel.bridge.assertAuthorityOwned(channel.authority), unavailable);
}

test("fixed composition constructs exact SQLite Stores without exposing its setup, reader or endpoint", t => {
  const f = fixture(t), store = f.open("owned");
  assert.ok(isOriginalRuntimeSupervisorOfficeRoot(f.supervisor));
  assert.ok(store instanceof SqliteRunStore);
  assert.equal(store.paths.cwd, join(f.root, "owned"));
  assert.equal(f.supervisor.getOfficeLocalNativeRuntime(store.paths.cwd, store), undefined);
  assert.equal(readOriginalOfficeDirectoryNativeRuntime(store), undefined);
  for (const value of [store, f.factory]) {
    for (const key of ["setup", "reader", "endpoint", "custody", "originalOfficeHostBridge", "getSetup", "getOriginalOfficeHostBridgeSetup"]) {
      assert.equal(key in value, false, `fixed composition must not expose ${key}`);
    }
  }
});

test("fixed runtime lookup rejects injected/cloned Stores and replacement runtime facsimiles", t => {
  const f = fixture(t), owned = f.open("owned"), injected = f.open("injected", createSqliteRunStore);
  let reads = 0;
  const getter = t.mock.method(f.supervisor, "getOfficeLocalNativeRuntime", () => {
    reads++; return Object.freeze({ store: owned, supervisor: f.supervisor, coreSafe: true });
  });
  for (const store of [injected, ...copies(owned)]) {
    assert.throws(() => readOriginalOfficeDirectoryNativeRuntime(store), compositionInvalid);
  }
  assert.equal(reads, 0, "the private original Store check must precede public runtime lookup");
  assert.throws(() => readOriginalOfficeDirectoryNativeRuntime(owned), compositionInvalid);
  assert.equal(reads, 1); getter.mock.restore();
  assert.equal(readOriginalOfficeDirectoryNativeRuntime(owned), undefined);
  f.supervisor.releaseAll();
  assert.throws(() => readOriginalOfficeDirectoryNativeRuntime(owned), compositionInvalid);
});

test("fake, spread and Proxy roots cannot create a fixed composition or enroll a transport", t => {
  const f = fixture(t), store = f.open("owner"), channel = transport(store);
  const fake = Object.freeze({ active: true, getProtectedHostStageRegistry() {}, getOfficeLocalNativeRuntime() {} });
  for (const root of [fake, ...copies(f.supervisor), Object.create(RuntimeSupervisor.prototype)]) {
    assert.equal(isOriginalRuntimeSupervisorOfficeRoot(root), false);
    assert.throws(() => createOriginalOfficeDirectoryStoreFactory(root), compositionInvalid);
    assert.throws(() => retainOriginalRuntimeSupervisorOfficeStoreBridge(root, store, channel.setup), compositionInvalid);
  }
  assertOriginalOfficeHostBridgeForCompositionCurrent(channel.setup, store);
});

test("fixed composition does not consult replacement public root getters", t => {
  const f = fixture(t);
  const getters = ["getProtectedHostStageRegistry", "getOfficeLocalNativeRuntime"].map(name =>
    t.mock.method(f.supervisor, name, () => assert.fail("public getters cannot supply fixed composition custody")));
  f.open("without-public-getters");
  for (const getter of getters) assert.equal(getter.mock.callCount(), 0);
});

test("ordinary injected Stores and copied owning Stores cannot be retrofitted with authority", t => {
  const f = fixture(t), owned = f.open("owned"), injected = f.open("injected", createSqliteRunStore);
  let runtimeReads = 0;
  const runtime = { get store() { runtimeReads++; assert.fail("an unowned Store must fail before runtime access"); } };
  for (const store of [injected, ...copies(owned)]) {
    assert.throws(() => captureOriginalOfficeDirectoryAuthorityV2(store, runtime, Object.freeze({})), compositionInvalid);
  }
  assert.equal(runtimeReads, 0);
});

test("cache-derived runtime facsimiles and public no-op methods cannot provide constructor-private custody", t => {
  const f = fixture(t), store = f.open("owner"), cached = f.supervisor.getRuntime(store.paths.cwd, store);
  const registry = f.supervisor.getProtectedHostStageRegistry();
  let publicCalls = 0;
  const fields = { ...cached, store, supervisor: f.supervisor, registry,
    assertScopeBinding() { publicCalls++; }, scopeFacts() { publicCalls++; return { coreSafe: true }; },
    captureOriginalOfficeDirectoryRuntimeCustody() { publicCalls++; return Object.freeze({}); } };
  const prototypeCopy = Object.assign(Object.create(OfficeLocalNativeRuntime.prototype), fields);
  const facsimile = Object.freeze(fields), scope = Object.freeze({});
  for (const runtime of [facsimile, ...copies(facsimile), Object.freeze(prototypeCopy)]) {
    assert.equal(isOwnedOfficeLocalNativeRuntime(runtime), false);
    assert.throws(() => captureOriginalOfficeDirectoryAuthorityV2(store, runtime, scope), compositionInvalid);
    assert.throws(() => captureOriginalOfficeDirectoryRuntimeCustody(runtime, scope), /office_local_native_runtime_unowned/u);
    assert.throws(() => assertOriginalOfficeDirectoryRuntimeBinding(runtime, scope, {}), /office_local_native_runtime_unowned/u);
  }
  assert.equal(publicCalls, 0);
});

test("root enrollment rejects fake or foreign setup and wrong Store without retiring the genuine transport", t => {
  const f = fixture(t), store = f.open("owner"), other = f.open("other"), channel = transport(store);
  for (const setup of [Object.freeze({}), ...copies(channel.setup)]) {
    assert.throws(() => retainOriginalRuntimeSupervisorOfficeStoreBridge(f.supervisor, store, setup), wrongOwner);
  }
  assert.throws(() => retainOriginalRuntimeSupervisorOfficeStoreBridge(f.supervisor, other, channel.setup), wrongOwner);
  const unsealed = createOriginalOfficeHostBridgeForComposition();
  captureOriginalOfficeHostBridgeReader(unsealed.reader, store);
  assert.throws(() => retainOriginalRuntimeSupervisorOfficeStoreBridge(f.supervisor, store, unsealed.setup), unavailable);
  assertOriginalOfficeHostBridgeForCompositionCurrent(channel.setup, store);
  assert.deepEqual(Reflect.ownKeys(channel.setup), []);
  assert.deepEqual(Reflect.ownKeys(channel.reader), []);
});

test("retirement invalidates both enrolled exact-Store transports and is idempotent", t => {
  const f = fixture(t), channels = [transport(f.open("first")), transport(f.open("second"))];
  for (const channel of channels) retainOriginalRuntimeSupervisorOfficeStoreBridge(f.supervisor, channel.store, channel.setup);
  f.supervisor.releaseAll();
  assert.equal(isOriginalRuntimeSupervisorOfficeRoot(f.supervisor), false);
  for (const channel of channels) assertRetired(channel);
  f.supervisor.releaseAll();
  for (const channel of channels) assertRetired(channel);
});

test("a pre-retired transport and closed owning Store do not make root retirement reopen custody", t => {
  const f = fixture(t), store = f.open("owner"), channel = transport(store);
  retainOriginalRuntimeSupervisorOfficeStoreBridge(f.supervisor, store, channel.setup);
  channel.bridge.retire(); store.close();
  f.supervisor.releaseAll(); f.supervisor.releaseAll();
  assertRetired(channel);
});

test("retired roots reject new factories, existing factory calls, capture and lifecycle enrollment", t => {
  const f = fixture(t), store = f.open("owner"), channel = transport(store);
  retainOriginalRuntimeSupervisorOfficeStoreBridge(f.supervisor, store, channel.setup);
  f.supervisor.releaseAll();
  const unopened = join(f.root, "must-not-be-created");
  assert.throws(() => createOriginalOfficeDirectoryStoreFactory(f.supervisor), compositionInvalid);
  assert.throws(() => f.factory(unopened), compositionInvalid);
  assert.equal(existsSync(unopened), false);
  assert.throws(() => captureOriginalOfficeDirectoryAuthorityV2(store,
    Object.freeze({ store, supervisor: f.supervisor }), Object.freeze({})), compositionInvalid);
  assert.throws(() => retainOriginalRuntimeSupervisorOfficeStoreBridge(f.supervisor, store, channel.setup), compositionInvalid);
  assertRetired(channel);
});

// Actual runtime.lock cleanup fault, NOT native identity cleanup or genuine Host binding.
test("root retires all transports before an actual runtime-lock cleanup error and retries only the retained owner", t => {
  const f = fixture(t), channels = [transport(f.open("first")), transport(f.open("second"))];
  for (const channel of channels) {
    retainOriginalRuntimeSupervisorOfficeStoreBridge(f.supervisor, channel.store, channel.setup);
    f.supervisor.getRuntime(channel.store.paths.cwd, channel.store);
  }
  const locks = channels.map(channel => join(channel.store.paths.cwd, ".ling-stack", "runtime.lock"));
  for (const path of locks) assert.ok(existsSync(path));
  const unlink = fs.unlinkSync, observed = []; let assertionFailure, refused = false;
  const patch = t.mock.method(fs, "unlinkSync", path => {
    observed.push(path);
    try {
      assert.equal(isOriginalRuntimeSupervisorOfficeRoot(f.supervisor), false);
      for (const channel of channels) assertRetired(channel);
    } catch (error) { assertionFailure = error; throw error; }
    if (path === locks[0] && !refused) {
      refused = true;
      throw Object.assign(new Error("actual runtime lock cleanup failed"), { code: "EIO" });
    }
    return unlink(path);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.supervisor.releaseAll(), error => error instanceof AggregateError
      && error.message === "runtime_supervisor_release_incomplete"
      && error.errors.some(entry => entry?.message === "actual runtime lock cleanup failed"));
    if (assertionFailure) throw assertionFailure; // releaseAll drains neighboring owners before surfacing cleanup errors.
    assert.deepEqual(observed, locks);
    assert.equal(existsSync(locks[0]), true);
    assert.equal(existsSync(locks[1]), false);
    f.supervisor.releaseAll(); assert.deepEqual(observed, [...locks, locks[0]]);
    assert.equal(existsSync(locks[0]), false);
    f.supervisor.releaseAll(); assert.deepEqual(observed, [...locks, locks[0]]);
    for (const channel of channels) assertRetired(channel);
  } finally { patch.mock.restore(); syncBuiltinESMExports(); }
});

/** Original SQLite source and actual ephemeral readonly stage, never a native session. */
function registeredStage(t) {
  // This refusal fixture deliberately omits every source entry. Production
  // Supervisor defaults now enroll the fixed complete list; public no-op
  // methods must still be unable to repair an explicitly incomplete Registry.
  const f = fixture(t, { actorEntries: Object.freeze([]) }), store = f.open("workspace"), registry = f.supervisor.getProtectedHostStageRegistry();
  const runtime = f.supervisor.getRuntime(store.paths.cwd, store), now = new Date().toISOString(), id = "composition-stage-run";
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: id,
    idempotencyKey: id, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: runtime.runtimeInstanceId, runnerId: "pi", status: "started", now });
  const policy = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(), authorizationMode: "always",
    workspaceAccessMode: "workspace_write" }).snapshot;
  store.createRun({ id, cwd: store.paths.cwd, workUnitId: unit.id, taskId: "composition-stage-task", providerName: "fixture",
    providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: { effectivePolicySnapshot: policy }, createdAt: now });
  store.linkRunToWorkUnit(id, unit.id, now); store.markRunStarted(id, now);
  const run = store.getRun(id), sourceFence = toRuntimeAttemptFence(attempt), stagePath = f.workspace("stage");
  const stage = registry.registerStage({ store, run, sourceFence, stagePath });
  // The registered stage has no Office window on these refusal paths.
  f.beforeClose.push(() => registry.closeStage(stage));
  return { ...f, store, registry, stage,
    actorSource: () => registry.captureActorSource({ store, run, sourceFence, command: "node -e 'process.exit(0)'", toolCallId: "office-refusal-actor" }),
    expected: { source: { runId: run.id, ...sourceFence }, workspacePath: run.cwd } };
}

test("failed Office binding retains its lease even when original stage close returned but its reply was lost",
  { skip: process.platform !== "darwin" }, t => {
    const f = registeredStage(t), actor = f.actorSource();
    assert.throws(() => beginOriginalProtectedHostOfficeDirectoryWindow(f.registry, f.stage, f.expected), /protected_host_actor_inventory_incomplete/u);
    const originalClose = fs.closeSync; let closes = 0;
    const patch = t.mock.method(fs, "closeSync", fd => {
      closes++; originalClose(fd);
      if (closes === 1) throw new Error("actual_office_stage_close_return_lost");
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => f.registry.closeStage(f.stage), /protected_host_stage_close_unknown/u);
      assert.ok(closes > 1); // The other original ancestor lifetimes also drained.
    } finally {
      patch.mock.restore(); syncBuiltinESMExports();
      f.beforeClose.length = 0; // Never retry an unknown original close in teardown.
    }
    assert.throws(() => f.registry.protectedRoots(actor), /protected_host_office_window_admission_closed|protected_host_stage_closed/u);
    assert.throws(() => f.registry.closeStage(f.stage), /protected_host_stage_close_unknown/u);
  });

test("failed Office binding keeps its closed protection member until a genuine invalid-cleanup claim exists",
  { skip: process.platform !== "darwin" }, t => {
    const f = registeredStage(t), actor = f.actorSource();
    assert.throws(() => beginOriginalProtectedHostOfficeDirectoryWindow(f.registry, f.stage, f.expected), /protected_host_actor_inventory_incomplete/u);
    f.registry.closeStage(f.stage);
    assert.throws(() => f.registry.protectedRoots(actor), /protected_host_office_window_admission_closed|protected_host_stage_closed/u);
    f.registry.closeStage(f.stage); // Known closure is idempotent, not lease release.
  });

test("constructor-private Registry readers reject copied registries without touching public methods", t => {
  const registry = new ProtectedHostStageRegistry(), stage = Object.freeze({}); let publicCalls = 0;
  t.mock.method(registry, "assertActorInventoryCurrent", () => { publicCalls++; });
  t.mock.method(registry, "assertStageCurrent", () => { publicCalls++; });
  for (const candidate of [...copies(registry), Object.freeze({ assertActorInventoryCurrent() {}, assertStageCurrent() {} })]) {
    assert.throws(() => assertOriginalProtectedHostOfficeStage(candidate, stage), /protected_host_registry_invalid/u);
    assert.throws(() => beginOriginalProtectedHostOfficeDirectoryWindow(candidate, stage, {}), /protected_host_registry_invalid/u);
  }
  assert.equal(publicCalls, 0);
});

test("real stage cannot pass private Office inventory through public no-op checks and failed begin stays closed",
  { skip: process.platform !== "darwin" }, t => {
    const f = registeredStage(t);
    assert.equal(readOriginalProtectedHostActorEntries().length, 21);
    f.registry.assertStageCurrent(f.stage); // Control: actual original stage/source is currently valid.
    assert.ok(Object.isFrozen(f.stage)); assert.deepEqual(Reflect.ownKeys(f.stage), []);
    let publicCalls = 0;
    for (const method of ["assertActorInventoryCurrent", "assertStageCurrent", "assertHostStageSourceCurrent"])
      t.mock.method(f.registry, method, () => { publicCalls++; });
    const opens = [], originalOpen = fs.openSync;
    const patch = t.mock.method(fs, "openSync", (...args) => { opens.push(args); return originalOpen(...args); });
    syncBuiltinESMExports();
    try {
      assert.throws(() => assertOriginalProtectedHostOfficeStage(f.registry, f.stage), /protected_host_actor_inventory_incomplete/u);
      assert.throws(() => beginOriginalProtectedHostOfficeDirectoryWindow(f.registry, f.stage, f.expected), /protected_host_actor_inventory_incomplete/u);
      assert.throws(() => beginOriginalProtectedHostOfficeDirectoryWindow(f.registry, f.stage, f.expected), /protected_host_office_window_admission_closed/u);
      assert.deepEqual(opens, []);
    } finally { patch.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(publicCalls, 0);
  });

test("frozen stage clones, Proxy tokens and foreign registries cannot borrow actual stage membership",
  { skip: process.platform !== "darwin" }, t => {
    const f = registeredStage(t), foreign = new ProtectedHostStageRegistry();
    for (const stage of copies(f.stage)) {
      assert.throws(() => assertOriginalProtectedHostOfficeStage(f.registry, stage), /protected_host_stage_registration_invalid/u);
      assert.throws(() => beginOriginalProtectedHostOfficeDirectoryWindow(f.registry, stage, f.expected), /protected_host_office_window_admission_closed/u);
    }
    assert.throws(() => assertOriginalProtectedHostOfficeStage(foreign, f.stage), /protected_host_stage_registration_invalid/u);
    assert.throws(() => beginOriginalProtectedHostOfficeDirectoryWindow(foreign, f.stage, f.expected), /protected_host_office_window_admission_closed/u);
    f.registry.assertStageCurrent(f.stage); // Forgery attempts did not consume its original stage.
  });
