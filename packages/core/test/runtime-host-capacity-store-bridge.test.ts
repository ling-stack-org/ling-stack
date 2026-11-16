import assert from "node:assert/strict";
import { copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as core from "../dist/index.js";
import { DEFAULT_WORKSPACE_ID, SqliteRunStore } from "../dist/index.js";
import { createHostRunCapacityStore, createRuntimeHostCapacityStoreBinding, HostRunCapacityStore,
  RuntimeHostCapacityBridge } from "../dist/runtime-host-capacity-store-bridge.js";
import type { HostOperationSource, RuntimeHostCapacityDispatchReference, RuntimeHostCapacityIntentRecord,
  RuntimeHostCapacityJournal, RuntimeHostCapacityStoreBinding } from "../dist/runtime-host-capacity-store-bridge.js";
import { SqliteRuntimeHostCapacityStore } from "../dist/storage/sqlite/runtime-host-capacity-store.js";
import { hostCapacityFixture } from "./support/runtime-host-capacity-fixture.ts";
import { runtimeRunQueueFixture, type PreparedQueueRun } from "./support/runtime-run-queue-fixture.ts";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Binding = ReturnType<typeof createRuntimeHostCapacityStoreBinding>;
const denied = (operation: () => unknown) => assert.throws(operation, { message: "runtime_host_capacity.binding_invalid" });
const methods = ["getWorkspaceIdentity", "assertOutsideTransaction", "prepareAttempt", "prepareExecution", "prepareWorkflowStart", "prepareDelegationSpawn",
  "prepareDelegationPending", "prepareApprovalResumePending", "prepareUserInputContinuation", "getIntent", "getAttemptIntent", "attachReservation",
  "consumeDispatchGateWithinTransaction", "consumeDispatchGate", "bindDelegationSourceWithinTransaction",
  "bindApprovalResumeSourceWithinTransaction", "bindUserInputSourceWithinTransaction",
  "prepareNoDispatchRelease", "prepareStoppedRelease", "getRelease", "listPendingReleases", "acknowledgeRelease"] as const satisfies readonly (keyof RuntimeHostCapacityJournal)[];

async function bindingFixture(t: TestContext, capacity = createRuntimeHostCapacityStoreBinding()) {
  const opened = new Set<SqliteRunStore>();
  t.after(() => { for (const store of opened) if (testDatabase(store).isOpen) store.close(); });
  const queue = await runtimeRunQueueFixture(t);
  const open = (capacity: Binding = createRuntimeHostCapacityStoreBinding()) => {
    const store = new SqliteRunStore({ cwd: queue.cwd, paths: queue.paths, runtimeHostCapacityBinding: capacity.binding });
    opened.add(store);
    return { store, capacity, journal: capacity.workspace(queue.workspaceId) };
  };
  return { queue, open, ...open(capacity) };
}

type Fixture = Awaited<ReturnType<typeof bindingFixture>>;
const source = (current: PreparedQueueRun): HostOperationSource => ({ runId: current.run.id, ...current.fence });

function reserve(f: Fixture, host: HostRunCapacityStore, current: PreparedQueueRun) {
  const bridge = new RuntimeHostCapacityBridge(f.journal, host);
  const result = bridge.reserveAttempt({ source: source(current), now: f.queue.at(3) });
  assert.ok(result.status === "reserved" || result.status === "duplicate", JSON.stringify(result));
  return { bridge, record: result.record };
}

function reference(record: RuntimeHostCapacityIntentRecord): RuntimeHostCapacityDispatchReference {
  assert.ok(record.dispatchToken);
  return { intentId: record.intent.intentId, dispatchToken: record.dispatchToken };
}

test("the opaque constructor handle cannot produce a journal before Store initialization", async t => {
  const capacity = createRuntimeHostCapacityStoreBinding();
  assert.ok(Object.isFrozen(capacity) && Object.isFrozen(capacity.binding));
  assert.deepEqual(Reflect.ownKeys(capacity.binding), []);
  denied(() => capacity.workspace(DEFAULT_WORKSPACE_ID));
  const f = await bindingFixture(t, capacity);
  assert.equal(capacity.workspace(f.queue.workspaceId), f.journal);
  assert.match(f.journal.getWorkspaceIdentity().workspaceKey, /^[0-9a-f]{64}$/u);
  assert.equal(f.journal.getIntent("missing"), undefined);
  assert.ok(Object.isFrozen(f.journal));
  assert.deepEqual(Object.keys(f.journal).sort(), [...methods].sort());
  for (const name of ["context", "ports", "identity"])
    assert.equal(name in f.journal, false, name);
  for (const name of [...methods, "runtimeHostCapacityBinding", "workspace"])
    assert.equal(name in f.store, false, name);
  for (const name of ["createRuntimeHostCapacityStoreBinding", "RuntimeHostCapacityBridge", "HostRunCapacityStore"])
    assert.equal(name in core, false, `${name} must remain outside the public Core entrypoint`);
});

test("unknown and copied constructor handles are rejected without consuming the real binding", async t => {
  const capacity = createRuntimeHostCapacityStoreBinding(), f = await bindingFixture(t);
  const copies: RuntimeHostCapacityStoreBinding[] = [{}, { ...capacity.binding },
    JSON.parse(JSON.stringify(capacity.binding)) as RuntimeHostCapacityStoreBinding] as RuntimeHostCapacityStoreBinding[];
  for (const binding of copies) denied(() => new SqliteRunStore({ cwd: f.queue.cwd, paths: f.queue.paths,
    runtimeHostCapacityBinding: binding }));
  denied(() => capacity.workspace(f.queue.workspaceId));
  const accepted = f.open(capacity);
  assert.equal(accepted.journal.getIntent("missing"), undefined);
});

test("failed reuse cannot retire the original Store, accessor, facade or extracted method", async t => {
  const f = await bindingFixture(t), other = await bindingFixture(t), retained = f.journal.getIntent;
  for (const queue of [f.queue, other.queue]) {
    denied(() => new SqliteRunStore({ cwd: queue.cwd, paths: queue.paths, runtimeHostCapacityBinding: f.capacity.binding }));
    assert.equal(f.capacity.workspace(f.queue.workspaceId), f.journal);
    assert.equal(f.journal.getIntent("missing"), undefined);
    assert.equal(retained("missing"), undefined);
  }
});

test("unknown workspace IDs never acquire or cache a fabricated journal", async t => {
  const f = await bindingFixture(t), database = testDatabase(f.store);
  const before = database.prepare("SELECT * FROM workspaces ORDER BY id").all();
  for (const workspaceId of ["", "missing-workspace", f.queue.cwd, f.queue.paths.databasePath, "../another.sqlite"]) {
    for (let repeat = 0; repeat < 2; repeat++) assert.throws(() => f.capacity.workspace(workspaceId),
      { message: "runtime_host_capacity.workspace_unknown" });
  }
  assert.deepEqual(database.prepare("SELECT * FROM workspaces ORDER BY id").all(), before);
  const secondary = "secondary-workspace";
  assert.throws(() => f.capacity.workspace(secondary), { message: "runtime_host_capacity.workspace_unknown" });
  database.prepare("INSERT INTO workspaces(id,name,default_provider_preset_id,created_at,updated_at) VALUES(?,?,NULL,?,?)")
    .run(secondary, "Secondary", f.queue.at(0), f.queue.at(0));
  const journal = f.capacity.workspace(secondary);
  assert.notEqual(journal, f.journal);
  assert.equal(f.capacity.workspace(secondary), journal);
  assert.equal(journal.getIntent("missing"), undefined);
  const current = f.queue.prepare("other-workspace");
  assert.deepEqual(journal.prepareAttempt({ source: source(current), now: f.queue.at(3) }), { status: "changed" });
  assert.equal(f.queue.rows("runtime_host_capacity_intents").length, 0);
  assert.equal(f.capacity.workspace(f.queue.workspaceId), f.journal);
});

test("independent Stores with matching logical workspace and Run IDs cannot borrow a writer or receipt", async t => {
  const host = hostCapacityFixture(t), left = await bindingFixture(t), right = await bindingFixture(t);
  const a = left.queue.prepare("matching-identity"), b = right.queue.prepare("matching-identity");
  assert.equal(left.queue.workspaceId, right.queue.workspaceId);
  assert.deepEqual(source(a), source(b));
  const ra = reserve(left, host.host, a).record, rb = reserve(right, host.host, b).record;
  assert.notEqual(left.journal, right.journal);
  assert.notEqual(ra.intent.workspaceKey, rb.intent.workspaceKey);
  assert.notEqual(ra.intent.databasePath, rb.intent.databasePath);
  assert.equal(left.journal.getIntent(rb.intent.intentId), undefined);
  assert.equal(right.journal.getIntent(ra.intent.intentId), undefined);
  right.queue.enqueue(b);
  const claim = right.queue.claim();
  assert.deepEqual(right.queue.dispatch(b, claim, { hostCapacity: reference(ra) }, right.store), { status: "changed" });
  right.queue.noAdmission(b);
  assert.equal(right.queue.dispatch(b, claim, { hostCapacity: reference(rb) }, right.store).status, "admitted");
  assert.equal(left.journal.getIntent(ra.intent.intentId)!.dispatchedAt, undefined);
  assert.equal(host.host.counts().held, 2);
});

test("close retires the accessor, every saved facade method and all old bindings after reopen", async t => {
  const host = hostCapacityFixture(t), f = await bindingFixture(t), current = f.queue.prepare("closed-journal");
  const { record } = reserve(f, host.host, current), retained = f.journal.getIntent;
  const savedMethods = methods.map(name => f.journal[name]);
  f.store.close();
  denied(() => f.capacity.workspace(f.queue.workspaceId));
  denied(() => f.journal.getIntent(record.intent.intentId));
  denied(() => retained(record.intent.intentId));
  for (const method of savedMethods) denied(() => Reflect.apply(method, undefined, []));
  denied(() => f.open(f.capacity));
  const reopened = f.open();
  assert.notEqual(reopened.journal, f.journal);
  assert.deepEqual(reopened.journal.getIntent(record.intent.intentId), record);
  denied(() => f.capacity.workspace(f.queue.workspaceId));
  denied(() => retained(record.intent.intentId));
  f.store.close();
  assert.equal(reopened.journal.getIntent(record.intent.intentId)!.intent.intentId, record.intent.intentId);
});

for (const failure of ["open", "default-workspace"] as const) {
  test(`a ${failure} constructor failure retires the uninstalled binding and never publishes a facade`, async t => {
    const f = await bindingFixture(t), capacity = createRuntimeHostCapacityStoreBinding();
    const paths = failure === "open" ? { ...f.queue.paths, databasePath: f.queue.cwd } : f.queue.paths;
    const database = testDatabase(f.store);
    if (failure === "default-workspace") database.exec(`CREATE TRIGGER host_binding_startup_fault BEFORE INSERT ON workspaces
      BEGIN SELECT RAISE(ABORT,'host-binding-startup-fault'); END`);
    try {
      assert.throws(() => new SqliteRunStore({ cwd: f.queue.cwd, paths, runtimeHostCapacityBinding: capacity.binding }),
        failure === "default-workspace" ? /host-binding-startup-fault/u : /directory|unable to open/u);
    } finally {
      if (failure === "default-workspace") database.exec("DROP TRIGGER host_binding_startup_fault");
    }
    denied(() => capacity.workspace(f.queue.workspaceId));
    denied(() => f.open(capacity));
    const fresh = f.open();
    assert.equal(fresh.journal.getIntent("missing"), undefined);
    assert.equal(f.journal.getIntent("missing"), undefined);
  });
}

test("a cached journal keeps its original database file identity instead of rebinding a replaced pathname", async t => {
  const f = await bindingFixture(t), retained = f.journal.getIntent;
  const original = join(f.queue.root, "original.sqlite");
  testDatabase(f.store).exec("PRAGMA wal_checkpoint(TRUNCATE)");
  renameSync(f.queue.paths.databasePath, original);
  copyFileSync(original, f.queue.paths.databasePath);
  assert.equal(f.capacity.workspace(f.queue.workspaceId), f.journal);
  assert.throws(() => retained("missing"), { message: "runtime_host_capacity.database_identity_changed" });
});

test("queue dispatch consumes the same bound journal and rolls back both gates with the full local resource group", async t => {
  const host = hostCapacityFixture(t), prototype = SqliteRuntimeHostCapacityStore.prototype;
  const originalGet = prototype.getIntent, originalConsume = prototype.consumeDispatchGateWithinTransaction;
  const readBy: SqliteRuntimeHostCapacityStore[] = [];
  const consumedBy: SqliteRuntimeHostCapacityStore[] = [];
  t.mock.method(prototype, "getIntent", function (this: SqliteRuntimeHostCapacityStore, intentId: string) {
    readBy.push(this);
    return originalGet.call(this, intentId);
  });
  t.mock.method(prototype, "consumeDispatchGateWithinTransaction", function (this: SqliteRuntimeHostCapacityStore,
    input: Parameters<SqliteRuntimeHostCapacityStore["consumeDispatchGateWithinTransaction"]>[0]) {
    consumedBy.push(this);
    return originalConsume.call(this, input);
  });
  const f = await bindingFixture(t), current = f.queue.prepare("bound-dispatch", { tools: ["read", "write"] });
  const { record } = reserve(f, host.host, current);
  readBy.length = 0;
  const savedRead = f.journal.getIntent;
  assert.deepEqual(savedRead(record.intent.intentId), record);
  assert.equal(readBy.length, 1);
  const expectedOwner = readBy[0];
  assert.ok(expectedOwner);
  f.queue.enqueue(current);
  const claim = f.queue.claim(), before = f.queue.snapshot();
  testDatabase(f.store).exec(`CREATE TRIGGER host_binding_dispatch_fault BEFORE UPDATE OF dispatched_at ON runtime_run_queue
    WHEN NEW.dispatched_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'host-binding-dispatch-fault'); END`);
  assert.throws(() => f.queue.dispatch(current, claim, { hostCapacity: reference(record) }, f.store), /host-binding-dispatch-fault/u);
  assert.deepEqual(f.queue.snapshot(), before);
  f.queue.noAdmission(current);
  assert.equal(savedRead(record.intent.intentId)!.dispatchedAt, undefined);
  testDatabase(f.store).exec("DROP TRIGGER host_binding_dispatch_fault");
  const result = f.queue.dispatch(current, claim, { hostCapacity: reference(record) }, f.store);
  assert.equal(result.status, "admitted", JSON.stringify(result));
  assert.equal(result.entry.dispatchedAt, f.queue.at(5));
  assert.equal(result.leases.length, 2);
  assert.equal(result.semaphores.length, 3);
  assert.equal(savedRead(record.intent.intentId)!.dispatchedAt, f.queue.at(5));
  assert.equal(f.store.getTask(current.task.id)!.currentRunId, current.run.id);
  assert.equal(f.store.getWorkUnit(current.unit.id)!.status, "claimed");
  assert.equal(consumedBy.length, 2);
  assert.ok(consumedBy.every(journal => journal === expectedOwner), "facade and both queue transactions must share one journal");
  assert.equal(host.host.counts().held, 1);
});

test("the bound journal releases only an unconsumed gate through its durable outbox and Host ACK", async t => {
  const host = hostCapacityFixture(t), f = await bindingFixture(t), current = f.queue.prepare("bound-no-dispatch");
  const { bridge, record } = reserve(f, host.host, current), intentId = record.intent.intentId;
  f.queue.enqueue(current);
  const claim = f.queue.claim();
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId, now: f.queue.at(4) }).status, "prepared");
  assert.equal(f.journal.getIntent(intentId)!.revokedAt, f.queue.at(4));
  assert.equal(f.journal.getRelease(intentId)!.kind, "no_dispatch");
  assert.deepEqual(f.journal.listPendingReleases().map(release => release.intentId), [intentId]);
  assert.equal(host.host.counts().held, 1);
  assert.deepEqual(f.queue.dispatch(current, claim, { hostCapacity: reference(record) }, f.store), { status: "changed" });
  f.queue.noAdmission(current);
  assert.equal(bridge.flushRelease(intentId, f.queue.at(5)), true);
  assert.equal(f.journal.getRelease(intentId)!.acknowledgedAt, f.queue.at(5));
  assert.deepEqual(f.journal.listPendingReleases(), []);
  assert.deepEqual(host.host.counts(), { held: 0, released: 1, total: 1 });
});

test("a fresh binding after reopen preserves an unknown queue dispatch and cannot free capacity for another workspace", async t => {
  const host = hostCapacityFixture(t, { maximum: 1 }), f = await bindingFixture(t), other = await bindingFixture(t);
  const current = f.queue.prepare("unknown-bound-dispatch"), pending = other.queue.prepare("pending-other-workspace");
  const { record } = reserve(f, host.host, current), intentId = record.intent.intentId;
  f.queue.enqueue(current);
  const claim = f.queue.claim();
  assert.equal(f.queue.dispatch(current, claim, { hostCapacity: reference(record) }, f.store).status, "admitted");
  const dispatched = f.journal.getIntent(intentId);
  f.store.close();
  host.reopen();
  const reopened = f.open(), bridge = new RuntimeHostCapacityBridge(reopened.journal, host.host);
  assert.deepEqual(bridge.observeReservation(intentId, f.queue.at(6)), dispatched);
  assert.equal(reopened.store.getRuntimeRunQueueEntry(current.run.id)!.dispatchedAt, f.queue.at(5));
  assert.equal(reopened.journal.prepareNoDispatchRelease({ intentId, now: f.queue.at(30_000) }).status, "changed");
  assert.equal(reopened.journal.prepareStoppedRelease({ intentId, now: f.queue.at(30_000) }).status, "changed");
  assert.equal(reopened.store.expireRuntimeSemaphoreSlots(f.queue.at(30_000)), 0);
  assert.equal(reopened.store.expireResourceLeases(f.queue.at(30_000)), 0);
  assert.equal(bridge.flushRelease(intentId, f.queue.at(30_000)), false);
  const otherBridge = new RuntimeHostCapacityBridge(other.journal, host.host);
  assert.deepEqual(otherBridge.reserveAttempt({ source: source(pending), now: other.queue.at(3) }), { status: "full" });
  assert.deepEqual(host.host.counts(), { held: 1, released: 0, total: 1 });
});

test("the dedicated binding entrypoint exposes the same Host implementation and factory", async t => {
  const fixture = hostCapacityFixture(t), host = createHostRunCapacityStore({ globalDatabasePath: fixture.databasePath });
  try {
    assert.ok(host instanceof HostRunCapacityStore);
    assert.deepEqual(host.getPolicy(), fixture.host.getPolicy());
    assert.deepEqual(host.counts(), fixture.host.counts());
  } finally { host.close(); }
});
