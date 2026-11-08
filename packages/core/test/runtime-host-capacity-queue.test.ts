import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeHostCapacityDispatchReference, RuntimeHostCapacityIntentRecord } from "../dist/runtime-host-capacity-types.js";
import { deferred, hostCapacityFixture, hostCapacityWorkspace, realNow } from "./support/runtime-host-capacity-fixture.ts";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Workspace = Awaited<ReturnType<typeof hostCapacityWorkspace>>;
type Current = ReturnType<Workspace["prepare"]>;

function reference(record: RuntimeHostCapacityIntentRecord): RuntimeHostCapacityDispatchReference {
  assert.ok(record.dispatchToken);
  return { intentId: record.intent.intentId, dispatchToken: record.dispatchToken };
}

function unchanged<T>(f: Workspace, operation: () => T): T {
  const journal = f.journalSnapshot(), capacity = f.hostSnapshot();
  try { return f.noWrites(operation); }
  finally {
    assert.deepEqual(f.journalSnapshot(), journal);
    assert.deepEqual(f.hostSnapshot(), capacity);
  }
}

function admitted(f: Workspace, current: Current, record: RuntimeHostCapacityIntentRecord,
  claim: Parameters<Workspace["dispatch"]>[1], { now = f.at(5), store = f.peer } = {}) {
  const before = f.hostSnapshot();
  const result = f.dispatch(current, claim, { hostCapacity: reference(record), now }, store);
  assert.equal(result.status, "admitted", JSON.stringify(result));
  assert.equal(result.entry.dispatchedAt, now);
  assert.equal(f.journal.getIntent(record.intent.intentId)!.dispatchedAt, now);
  assert.equal(f.peer.getTask(current.task.id)!.currentRunId, current.run.id);
  assert.equal(f.peer.getTask(current.task.id)!.status, "claimed");
  assert.equal(f.peer.getWorkUnit(current.unit.id)!.status, "claimed");
  assert.deepEqual(f.peer.getWorkUnitAttempt(current.attempt.id), { ...current.attempt, lastEventAt: now });
  assert.equal(f.rows("work_unit_attempts").filter(row => row.work_unit_id === current.unit.id).length, 1);
  assert.equal(f.rows("runner_continuations").length, 0);
  assert.deepEqual(f.hostSnapshot(), before, "local admission never writes the Host database");
  return result;
}

for (const receipt of [false, true]) {
  test(`a queue admission cannot omit its Host reference after ${receipt ? "reservation" : "intent"} persistence`, async t => {
    const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("missing-host-reference");
    const record = receipt ? f.reserve(current) : f.intent(current);
    f.enqueue(current);
    const claim = f.claim();
    assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, {}, f.peer)), { status: "changed" });
    f.noAdmission(current);
    assert.equal(f.journal.getIntent(record.intent.intentId)!.dispatchedAt, undefined);
  });
}

for (const kind of ["task_run", "conversation_run"] as const) {
  for (const tools of [["read"], ["read", "write"]]) {
    test(`${kind} with ${tools.join("/")} atomically consumes both gates through RunStore admission`, async t => {
      const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("queue-dispatch", { kind, tools });
      const record = f.reserve(current);
      f.enqueue(current);
      const claim = f.claim(), result = admitted(f, current, record, claim);
      assert.equal(result.leases.length, tools.includes("write") ? 2 : 1);
      assert.equal(result.semaphores.length, 3);
      assert.equal(f.store.hasRuntimeRunQueueCustody(current.run.id), true);
      assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity: reference(record), now: f.at(6) })), { status: "changed" });
      assert.equal(host.host.counts().held, 1);
    });
  }
}

test("a caller-supplied Host reference cannot create custody for an Attempt with no persisted intent", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("fabricated-intent");
  f.enqueue(current);
  const claim = f.claim();
  assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity: { intentId: "foreign", dispatchToken: "a".repeat(64) } })),
    { status: "changed" });
  f.noAdmission(current);
  assert.equal(f.dispatch(current, claim).status, "admitted", "ordinary unbound queue admission keeps its existing contract");
});

test("a durable intent without a reservation receipt cannot dispatch with a fabricated token", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("receipt-missing");
  const record = f.intent(current);
  f.enqueue(current);
  const claim = f.claim();
  assert.deepEqual(unchanged(f, () => f.dispatch(current, claim,
    { hostCapacity: { intentId: record.intent.intentId, dispatchToken: "a".repeat(64) } })), { status: "changed" });
  f.noAdmission(current);
  const reserved = f.reserve(current);
  admitted(f, current, reserved, claim);
});

for (const field of ["intentId", "dispatchToken"] as const) {
  test(`a foreign ${field} rolls back all local admission without consuming either gate`, async t => {
    const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("foreign-reference", { tools: ["write"] });
    const record = f.reserve(current);
    f.enqueue(current);
    const claim = f.claim(), hostCapacity = { ...reference(record), [field]: "a".repeat(64) };
    assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity })), { status: "changed" });
    f.noAdmission(current);
    admitted(f, current, record, claim);
  });
}

test("matching Run and Attempt IDs in another workspace cannot lend a reservation to local queue admission", async t => {
  const host = hostCapacityFixture(t), left = await hostCapacityWorkspace(t, host), right = await hostCapacityWorkspace(t, host);
  const a = left.prepare("shared-id"), b = right.prepare("shared-id"), ra = left.reserve(a), rb = right.reserve(b);
  assert.equal(a.run.id, b.run.id);
  assert.deepEqual(left.source(a), right.source(b));
  right.enqueue(b);
  const claim = right.claim();
  assert.deepEqual(unchanged(right, () => right.dispatch(b, claim, { hostCapacity: reference(ra) })), { status: "changed" });
  right.noAdmission(b);
  admitted(right, b, rb, claim);
  assert.equal(left.journal.getIntent(ra.intent.intentId)!.dispatchedAt, undefined);
});

test("revoking an unconsumed Host gate fences both explicit and omitted-reference queue dispatch", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("revoked");
  const record = f.reserve(current);
  f.enqueue(current);
  const claim = f.claim();
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: f.at(4) }).status, "prepared");
  for (const hostCapacity of [reference(record), undefined]) {
    assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity })), { status: "changed" });
    f.noAdmission(current);
  }
  assert.equal(host.host.counts().held, 1, "workspace revocation does not impersonate a Host ACK");
  assert.equal(f.bridge.flushRelease(record.intent.intentId, realNow()), true);
  assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity: reference(record) })), { status: "changed" });
});

test("the Host authority digest remains binding when changed inputs are enqueued with a fresh queue snapshot", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("authority-drift");
  const record = f.reserve(current);
  testDatabase(f.store).prepare("UPDATE run_sessions SET task_snapshot_json=? WHERE id=?")
    .run(JSON.stringify({ ...current.execution.input.task, title: "Changed frozen task" }), current.run.id);
  f.enqueue(current);
  const claim = f.claim();
  assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity: reference(record) })), { status: "changed" });
  f.noAdmission(current);
});

test("a replaced preparation claimant cannot consume or release the original Host reservation", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("claim-takeover");
  const record = f.reserve(current);
  f.enqueue(current);
  const old = f.claim({ leaseMs: 1_000 }), claim = f.claim({ ownerId: "worker-b", now: f.at(5) }, f.peer);
  assert.deepEqual(unchanged(f, () => f.dispatch(current, old, { hostCapacity: reference(record), now: f.at(6) })), { status: "changed" });
  f.noAdmission(current);
  admitted(f, current, record, claim, { now: f.at(6) });
  assert.deepEqual(unchanged(f, () => f.dispatch(current, old, { hostCapacity: reference(record), now: f.at(7) })), { status: "changed" });
  assert.equal(host.host.counts().held, 1);
});

for (const cap of ["total", "provider", "runner", "channel"] as const) {
  test(`a full ${cap} budget retains its Host reservation and rolls back local admission until capacity is free`, async t => {
    const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host);
    f.installPolicy(cap === "total" ? { maxConcurrentRuns: 1 } : cap === "provider" ? { maxRunsPerProvider: 1 }
      : cap === "runner" ? { maxRunsPerRunner: 1 } : {});
    if (cap === "channel") f.channel = f.store.updateChannel(f.channel.id,
      { runtimePolicy: { ...f.channel.runtimePolicy, maxConcurrentRuns: 1 } }, f.at(2))!;
    const holder = f.prepare("local-holder");
    f.enqueue(holder);
    assert.equal(f.dispatch(holder, f.claim()).status, "admitted");
    const current = f.prepare("local-full"), record = f.reserve(current);
    f.enqueue(current);
    const claim = f.claim({ now: f.at(6) });
    assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity: reference(record), now: f.at(7) })),
      { status: "busy", reason: "runtime_semaphore_conflict" });
    f.noAdmission(current);
    assert.equal(host.host.counts().held, 1);
    f.release(holder, f.at(8));
    admitted(f, current, record, claim, { now: f.at(9) });
  });
}

test("a write lock conflict retains the Host reservation without committing the earlier Task lease", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), holder = f.prepare("write-holder", { tools: ["write"] });
  assert.ok(f.store.acquireResourceLease(f.resources(holder).leases.find(lease => lease.resourceType === "bound_path")!));
  const current = f.prepare("write-candidate", { tools: ["write"] }), record = f.reserve(current);
  f.enqueue(current);
  const claim = f.claim();
  assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity: reference(record) })),
    { status: "busy", reason: "resource_conflict" });
  f.noAdmission(current);
  f.release(holder, f.at(6));
  admitted(f, current, record, claim, { now: f.at(7) });
});

const faults = {
  "Host gate": "BEFORE UPDATE OF dispatched_at ON runtime_host_capacity_intents WHEN NEW.dispatched_at IS NOT NULL",
  "Task claim": "BEFORE UPDATE OF status ON tasks WHEN NEW.status='claimed'",
  "WorkUnit claim": "BEFORE UPDATE OF status ON work_units WHEN NEW.status='claimed'",
  "claimed event": "BEFORE INSERT ON runtime_events WHEN NEW.type='work_unit_claimed'",
  "queue gate": "BEFORE UPDATE OF dispatched_at ON runtime_run_queue WHEN NEW.dispatched_at IS NOT NULL",
};
for (const [boundary, trigger] of Object.entries(faults)) {
  test(`a ${boundary} write failure rolls back both gates, all resources and Task idempotency`, async t => {
    const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), idempotencyKey = "host-queue-claim";
    const current = f.prepare("write-fault", { tools: ["write"], requestOverrides: { idempotencyKey } }), record = f.reserve(current);
    f.enqueue(current);
    const claim = f.claim();
    testDatabase(f.store).exec(`CREATE TRIGGER host_queue_fault ${trigger} BEGIN SELECT RAISE(ABORT,'host-queue-fault'); END`);
    unchanged(f, () => assert.throws(() => f.dispatch(current, claim, { hostCapacity: reference(record) }), /host-queue-fault/u));
    f.noAdmission(current);
    assert.equal(f.store.findStateTransitionByIdempotency("task", current.task.id, idempotencyKey), undefined);
    testDatabase(f.store).exec("DROP TRIGGER host_queue_fault");
    admitted(f, current, record, claim);
    assert.equal(f.peer.findStateTransitionByIdempotency("task", current.task.id, idempotencyKey)!.event, "claim");
  });
}

for (const table of ["runtime_host_capacity_intents", "runtime_run_queue"]) {
  test(`a suppressed ${table} gate update cannot commit a partial admission`, async t => {
    const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("suppressed-gate");
    const record = f.reserve(current);
    f.enqueue(current);
    const claim = f.claim();
    testDatabase(f.store).exec(`CREATE TRIGGER host_queue_ignore BEFORE UPDATE OF dispatched_at ON ${table}
      WHEN NEW.dispatched_at IS NOT NULL BEGIN SELECT RAISE(IGNORE); END`);
    assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity: reference(record) })), { status: "changed" });
    f.noAdmission(current);
    testDatabase(f.store).exec("DROP TRIGGER host_queue_ignore");
    admitted(f, current, record, claim);
  });
}

test("Task cancellation after reservation rolls back a consumed Host gate without undoing the cancellation", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("task-cancel");
  const record = f.reserve(current);
  f.enqueue(current);
  const claim = f.claim();
  assert.equal(f.peer.transitionTaskStatus({ taskId: current.task.id, expectedStatus: "todo", event: "cancel",
    actor: "local-user", now: f.at(4) }).ok, true);
  assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity: reference(record) })), { status: "changed" });
  assert.equal(f.peer.getTask(current.task.id)!.status, "cancelled");
  assert.equal(f.rows("resource_leases").length, 0);
  assert.equal(f.rows("runtime_semaphore_slots").length, 0);
  assert.equal(f.journal.getIntent(record.intent.intentId)!.dispatchedAt, undefined);
});

test("independent processes consume the same Host and queue gates exactly once", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("dispatch-race", { tools: ["write"] });
  const record = f.reserve(current);
  f.enqueue(current);
  const claim = f.claim(), input = f.dispatchInput(current, claim, { hostCapacity: reference(record) }), before = f.hostSnapshot();
  const results = await f.race([{ method: "dispatchRuntimeQueuedRun", input }, { method: "dispatchRuntimeQueuedRun", input }]);
  assert.deepEqual(results.map(result => result.status).sort(), ["admitted", "changed"]);
  assert.equal(f.journal.getIntent(record.intent.intentId)!.dispatchedAt, input.now);
  assert.equal(f.peer.getRuntimeRunQueueEntry(current.run.id)!.dispatchedAt, input.now);
  assert.equal(f.rows("resource_leases").length, 2);
  assert.equal(f.rows("runtime_semaphore_slots").length, 3);
  assert.equal(f.rows("work_unit_attempts").length, 1);
  assert.equal(f.rows("state_transition_events").filter(event => event.event === "claim").length, 2);
  assert.deepEqual(f.hostSnapshot(), before);
});

test("Host fullness prevents queue admission in another workspace without reclaiming an unknown dispatched execution", async t => {
  const host = hostCapacityFixture(t, { maximum: 1 }), left = await hostCapacityWorkspace(t, host), right = await hostCapacityWorkspace(t, host);
  const a = left.prepare("shared-id"), b = right.prepare("shared-id"), record = left.reserve(a);
  left.enqueue(a);
  admitted(left, a, record, left.claim());
  assert.equal(right.bridge.reserveAttempt({ source: right.source(b), now: right.at(3) }).status, "full");
  right.enqueue(b);
  const claim = right.claim();
  assert.deepEqual(unchanged(right, () => right.dispatch(b, claim)), { status: "changed" });
  right.noAdmission(b);
  assert.equal(left.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
  assert.equal(host.host.counts().held, 1, "consumed gates cannot be reclaimed as no-dispatch");
});

test("an already consumed unbound queue gate cannot be backfilled as an undispatched Host intent", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("legacy-dispatched");
  f.enqueue(current);
  assert.equal(f.dispatch(current, f.claim()).status, "admitted");
  f.release(current, f.at(6));
  assert.equal(f.peer.getWorkUnitAttempt(current.attempt.id)!.status, "created", "no SDK ACK is known");
  assert.deepEqual(unchanged(f, () => f.bridge.reserveAttempt({ source: f.source(current), now: f.at(7) })), { status: "changed" });
  assert.deepEqual(host.host.counts(), { held: 0, released: 0, total: 0 });
});

test("reopening a reserved and claimed queue preserves the original receipt and permits one current-owner admission", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("reopen-before-gate");
  const record = f.reserve(current);
  f.enqueue(current);
  const claim = f.claim();
  host.reopen(); f.reopen(); f.reopen("peer");
  const observed = f.bridge.observeReservation(record.intent.intentId, f.at(5));
  assert.deepEqual(observed, record);
  f.noAdmission(current);
  admitted(f, current, record, claim, { now: f.at(6), store: f.store });
  assert.equal(host.host.counts().total, 1);
});

test("an unknown dispatched queue execution remains held after reopen and is not replayed when its preparation claim expires", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("unknown-queue-dispatch");
  const record = f.reserve(current);
  f.enqueue(current);
  const claim = f.claim();
  admitted(f, current, record, claim);
  host.reopen(); f.reopen(); f.reopen("peer");
  assert.deepEqual(unchanged(f, () => f.dispatch(current, claim, { hostCapacity: reference(record), now: f.at(30_000) })), { status: "changed" });
  assert.equal(unchanged(f, () => f.store.claimNextRuntimeRun(f.claimInput({ now: f.at(30_000) }))).status, "empty");
  assert.equal(unchanged(f, () => f.store.expireRuntimeSemaphoreSlots(f.at(30_000))), 0);
  assert.equal(unchanged(f, () => f.store.expireResourceLeases(f.at(30_000))), 0);
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
  assert.equal(f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
  assert.equal(host.host.counts().held, 1);
});

test("a queue-admitted Attempt releases Host capacity only after its original lifetime, terminal and resource drain", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("queue-stopped");
  const record = f.reserve(current);
  f.enqueue(current);
  admitted(f, current, record, f.claim());
  testDatabase(f.store).prepare("UPDATE work_units SET status='running',started_at=? WHERE id=?").run(f.at(6), current.unit.id);
  testDatabase(f.store).prepare("UPDATE work_unit_attempts SET status='started',started_at=? WHERE id=?").run(f.at(6), current.attempt.id);
  f.store.markRunStarted(current.run.id, f.at(6));
  const lifetime = deferred(), completion = f.store.trackHostAttemptCompletion(f.source(current), lifetime.promise, () => true);
  f.terminal(current, { status: "succeeded" });
  assert.equal(f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() }).status, "changed");
  lifetime.resolve();
  assert.equal((await completion).effectCoverage, "pi_no_tools_v1");
  f.store.releaseHostAttemptResources(f.source(current), realNow());
  f.reopen();
  assert.equal(f.journal.prepareStoppedRelease({ intentId: record.intent.intentId, now: realNow() }).status, "prepared");
  assert.equal(f.bridge.flushRelease(record.intent.intentId, realNow()), true);
  assert.deepEqual(host.host.counts(), { held: 0, released: 1, total: 1 });
});
