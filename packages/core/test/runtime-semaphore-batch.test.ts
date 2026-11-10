import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { toRuntimeAttemptFence } from "../dist/index.js";
import type { AcquireRuntimeSemaphoreSlotInput, CreateResourceLeaseInput, WorkflowStepAdmissionEntry,
  WorkflowIsolationScopePlanV1 } from "../dist/index.js";
import { SqliteRuntimeSemaphoreStore } from "../dist/storage/sqlite/runtime-semaphore-store.js";
import { admissionRace, workflowAdmissionFixture } from "./support/workflow-step-admission-fixture.mjs";
import { workflowParallelParentFixture } from "./support/workflow-parallel-parent-fixture.mjs";
import type { WorkflowAdmissionFixture, AdmissionOwner } from "./support/workflow-step-admission-fixture.mjs";
import { testDatabase } from "./support/sqlite-test-database.ts";

type SlotOwner = Pick<AdmissionOwner, "attempt" | "fence">;
type ParallelPrepared = AdmissionOwner & { plan: WorkflowIsolationScopePlanV1; leaseInput: CreateResourceLeaseInput };
type ParallelFixture = WorkflowAdmissionFixture & {
  prepareOriginal(): ParallelPrepared;
  persistOriginal(prepared: ParallelPrepared): ParallelPrepared;
  readyOriginal(prepared: ParallelPrepared): ParallelPrepared;
  noWrites<T>(action: () => T): T;
  parent(): { state: string };
};

const batch = (f: WorkflowAdmissionFixture, current: SlotOwner, overrides: Partial<AcquireRuntimeSemaphoreSlotInput> = {}) => ([
  { resourceType: "provider", resourceKey: "batch-provider", limit: 4 },
  { resourceType: "runner", resourceKey: "pi", limit: 4 },
  { resourceType: "channel_parallel", resourceKey: f.channel.id, limit: 4 },
] satisfies WorkflowStepAdmissionEntry[]).map(entry => f.slotInput(current, entry, overrides));
const slots = (f: WorkflowAdmissionFixture) => testDatabase(f.peer).prepare("SELECT * FROM runtime_semaphore_slots ORDER BY id").all();
const attemptSlots = (f: WorkflowAdmissionFixture, current: SlotOwner) => slots(f).filter(slot => slot.attempt_id === current.attempt.id);
const noWrites = <T>(f: WorkflowAdmissionFixture, action: () => T): T => {
  const before = f.snapshot(), result = action();
  for (const store of [f.store, f.peer]) {
    if (typeof testDatabase(store).isTransaction === "boolean") assert.equal(testDatabase(store).isTransaction, false);
  }
  assert.deepEqual(f.snapshot(), before);
  return result;
};
const noAdmissionHistory = (f: WorkflowAdmissionFixture, current: SlotOwner) => {
  assert.deepEqual(attemptSlots(f, current), []);
  assert.equal(testDatabase(f.peer).prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE attempt_id=? AND type='semaphore_acquired'")
    .get(current.attempt.id)?.n, 0);
};

for (const ownerType of ["work_unit_attempt", "system"] as const) {
  test(`batch admits one fresh ${ownerType} group with exact ordered slots and unchanged inputs`, async t => {
    const f = await workflowAdmissionFixture(t), current = f.outsider(ownerType);
    const inputs = Object.freeze(batch(f, current, { ownerType,
      ownerId: ownerType === "system" ? "batch-system" : current.attempt.id,
      resourceKey: "same-key", expiresAt: f.at(100_000) }).map((input, index) => Object.freeze({ ...input, limit: index + 1 })));
    const result = f.store.acquireRuntimeSemaphoreSlots(inputs);
    assert.equal(result.status, "acquired", JSON.stringify(result));
    assert.equal(result.slots.length, inputs.length);
    result.slots.forEach((slot, index) => {
      for (const [key, value] of Object.entries(inputs[index])) if (key !== "limit") assert.equal(Reflect.get(slot, key), value, key);
      assert.equal(slot.status, "active");
      assert.equal(slot.lastRenewedAt, inputs[index].acquiredAt);
    });
    assert.equal(new Set(result.slots.map(slot => slot.id)).size, 3);
    assert.deepEqual(slots(f).map(slot => slot.id).sort(), result.slots.map(slot => slot.id).sort());
  });
}

for (const resourceType of ["provider", "runner", "channel_parallel"] as const) {
  test(`independently full ${resourceType} rolls back the whole group without released slots or acquired events`, async t => {
    const f = await workflowAdmissionFixture(t), current = f.outsider("candidate"), holder = f.outsider("holder");
    const inputs = batch(f, current, { limit: 1 }), blocked = inputs.find(input => input.resourceType === resourceType);
    assert.ok(blocked);
    assert.ok(f.peer.acquireRuntimeSemaphoreSlot(f.slotInput(holder, blocked)));
    assert.deepEqual(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(inputs)),
      { status: "full", resourceType, resourceKey: blocked.resourceKey });
    noAdmissionHistory(f, current);
    assert.equal(slots(f).length, 1);
  });
}

test("a late full resource preserves prior Attempt slots, other owners and rolled-back terminal expiry", async t => {
  const f = await workflowAdmissionFixture(t), current = f.outsider("prior"), holder = f.outsider("busy"), ended = f.outsider("ended");
  assert.ok(f.store.acquireRuntimeSemaphoreSlot(f.slotInput(current,
    { resourceType: "media_provider", resourceKey: "prior-slot", limit: 1 })));
  assert.ok(f.peer.acquireRuntimeSemaphoreSlot(f.slotInput(holder, { resourceType: "runner", resourceKey: "pi", limit: 1 })));
  const expiring = f.store.acquireRuntimeSemaphoreSlot(f.slotInput(ended,
    { resourceType: "provider", resourceKey: "terminal-slot", limit: 1 }, { expiresAt: f.at(5) }));
  assert.ok(expiring);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...ended.fence, status: "lost", endedAt: f.at(6), now: f.at(6) }));
  assert.deepEqual(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(batch(f, current,
    { limit: 1, acquiredAt: f.at(10_000), expiresAt: f.at(20_000) }))),
  { status: "full", resourceType: "runner", resourceKey: "pi" });
  assert.equal(attemptSlots(f, current).length, 1);
  assert.equal(f.peer.expireRuntimeSemaphoreSlots(f.at(10_000)), 1);
  assert.equal(attemptSlots(f, current)[0].status, "active");
  assert.equal(attemptSlots(f, holder)[0].status, "active");
});

test("duplicate batches return changed without reusing or disturbing the original three slots", async t => {
  const f = await workflowAdmissionFixture(t), current = f.outsider("duplicate"), inputs = batch(f, current);
  const first = f.store.acquireRuntimeSemaphoreSlots(inputs);
  assert.equal(first.status, "acquired");
  for (const store of [f.peer, f.store]) {
    assert.deepEqual(noWrites(f, () => store.acquireRuntimeSemaphoreSlots(inputs)), { status: "changed" });
    assert.deepEqual(slots(f).map(slot => slot.id).sort(), first.slots.map(slot => slot.id).sort());
  }
  assert.equal(slots(f).length, 3);
  assert.ok(slots(f).every(slot => slot.status === "active"));
});

test("an existing exact owner on a later resource is changed even if an earlier resource is full", async t => {
  const f = await workflowAdmissionFixture(t), current = f.outsider("partial"), holder = f.outsider("partial-holder");
  const inputs = batch(f, current, { limit: 1 });
  assert.ok(f.store.acquireRuntimeSemaphoreSlot(inputs[1]));
  assert.ok(f.peer.acquireRuntimeSemaphoreSlot(f.slotInput(holder, inputs[0])));
  assert.deepEqual(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(inputs)), { status: "changed" });
  assert.equal(attemptSlots(f, current).length, 1);
});

test("ordinary single acquisition and recovery retain their existing fresh/reuse semantics", async t => {
  const f = await workflowAdmissionFixture(t), current = f.outsider("single"), input = batch(f, current)[0];
  const first = f.store.acquireRuntimeSemaphoreSlot(input);
  assert.ok(first);
  const recovery = new SqliteRuntimeSemaphoreStore({ database: testDatabase(f.store) }, f.store);
  assert.equal(noWrites(f, () => recovery.ensureRuntimeSemaphoreSlotForAttempt(input)).status, "existing");
  const second = f.peer.acquireRuntimeSemaphoreSlot(input);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots([input])), { status: "changed" });
  assert.equal(slots(f).length, 2);
});

test("empty, duplicate, mixed-owner and malformed batches fail closed without any writes", async t => {
  const f = await workflowAdmissionFixture(t), current = f.outsider("invalid"), inputs = batch(f, current);
  const cases: [string, unknown][] = [
    ["empty", []], ["missing", undefined], ["null", null], ["not an array", {}], ["sparse", Array(1)],
    ["duplicate resource", [inputs[0], inputs[1], { ...inputs[0], limit: 10 }]],
    ["unknown type", inputs.map(input => ({ ...input, resourceType: "unknown" }))],
    ["unknown owner", inputs.map(input => ({ ...input, ownerType: "unknown" }))],
    ["wrong Attempt owner", inputs.map(input => ({ ...input, ownerId: "wrong-attempt" }))],
    ["blank system owner", inputs.map(input => ({ ...input, ownerType: "system", ownerId: " " }))],
    ["blank resource", inputs.map(input => ({ ...input, resourceKey: " " }))],
    ["padded resource", inputs.map(input => ({ ...input, resourceKey: " padded " }))],
  ];
  for (const field of ["workspaceId", "ownerType", "ownerId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken", "acquiredAt", "expiresAt"] as const) {
    cases.push([`mixed ${field}`, inputs.map((input, index) => index === 1 ? { ...input, [field]: `other-${input[field]}` } : input)]);
  }
  for (const field of ["workspaceId", "ownerId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
    cases.push([`blank ${field}`, inputs.map(input => ({ ...input, [field]: "" }))]);
  }
  for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
    cases.push([`invalid limit ${String(limit)}`, inputs.map((input, index) => index === 1 ? { ...input, limit } : input)]);
  }
  for (const times of [
    { acquiredAt: "not-a-time" }, { expiresAt: "not-a-time" },
    { acquiredAt: inputs[0].acquiredAt.replace(/\.\d{3}Z$/, "Z") },
    { expiresAt: inputs[0].expiresAt.replace(/\.\d{3}Z$/, "Z") },
    { expiresAt: inputs[0].acquiredAt }, { expiresAt: f.at(0) }, { acquiredAt: null }, { expiresAt: undefined },
  ]) cases.push([`invalid time ${JSON.stringify(times)}`, inputs.map(input => ({ ...input, ...times }))]);
  // Malformed values exercise runtime validation below the typed API boundary.
  for (const [label, value] of cases) {
    assert.deepEqual(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(value as readonly AcquireRuntimeSemaphoreSlotInput[])), { status: "changed" }, label);
  }
  noAdmissionHistory(f, current);
});

test("uniform stale fences and foreign workspaces cannot admit a batch or alter existing owners", async t => {
  const f = await workflowAdmissionFixture(t), current = f.outsider("stale"), holder = f.outsider("stale-holder");
  assert.equal(f.store.acquireRuntimeSemaphoreSlots(batch(f, holder)).status, "acquired");
  for (const field of ["workspaceId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
    const inputs = batch(f, current, { [field]: `stale-${field}`, ...(field === "attemptId" ? { ownerId: `stale-${field}` } : {}) });
    assert.deepEqual(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(inputs)), { status: "changed" }, field);
  }
  noAdmissionHistory(f, current);
});

test("a replaced Attempt cannot reacquire or release its successor's complete group", async t => {
  const f = await workflowAdmissionFixture(t), prior = f.outsider("replaced");
  assert.equal(f.store.acquireRuntimeSemaphoreSlots(batch(f, prior)).status, "acquired");
  const attempt = f.peer.createWorkUnitAttempt({ workUnitId: prior.unit.id, attemptNumber: 2,
    runtimeInstanceId: "batch-successor", runnerId: "pi", now: f.at(5) });
  const successor = { unit: prior.unit, attempt, fence: toRuntimeAttemptFence(attempt) };
  assert.equal(f.store.getWorkUnitAttempt(prior.attempt.id)!.status, "lost");
  assert.equal(f.peer.acquireRuntimeSemaphoreSlots(batch(f, successor)).status, "acquired");
  assert.deepEqual(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(batch(f, prior))), { status: "changed" });
  assert.equal(noWrites(f, () => f.store.releaseRuntimeSemaphoreSlotsForAttempt(prior.fence, f.at(7), "stale callback")), 0);
  assert.ok(attemptSlots(f, successor).every(slot => slot.status === "active"));
});

test("a later SQL insertion fault rolls back the entire group and leaves capacity reusable", async t => {
  const f = await workflowAdmissionFixture(t), current = f.outsider("fault"), inputs = batch(f, current);
  testDatabase(f.store).exec(`CREATE TRIGGER batch_slot_fault BEFORE INSERT ON runtime_semaphore_slots
    WHEN NEW.resource_type='runner' BEGIN SELECT RAISE(ABORT,'batch slot fault'); END`);
  assert.deepEqual(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(inputs)), { status: "changed" });
  noAdmissionHistory(f, current);
  testDatabase(f.store).exec("DROP TRIGGER batch_slot_fault");
  assert.equal(f.store.acquireRuntimeSemaphoreSlots(inputs).status, "acquired");
});

test("a failed nested BEGIN preserves the caller's transaction without DatabaseSync.isTransaction", async t => {
  const f = await workflowAdmissionFixture(t), current = f.outsider("outer"), database = testDatabase(f.store);
  const priority = f.store.getWorkUnit(current.unit.id)!.priority;
  // Forward real SQLite operations without the newer runtime flag.
  const semaphores = new SqliteRuntimeSemaphoreStore({ database: {
    exec: database.exec.bind(database), prepare: database.prepare.bind(database),
  } as DatabaseSync }, f.store);
  database.exec("BEGIN IMMEDIATE;");
  let committed = false;
  try {
    database.prepare("UPDATE work_units SET priority=priority+1 WHERE id=?").run(current.unit.id);
    assert.deepEqual(semaphores.acquireRuntimeSemaphoreSlots(batch(f, current)), { status: "changed" });
    assert.equal(f.store.getWorkUnit(current.unit.id)!.priority, priority + 1, "outer transaction sentinel must survive");
    assert.equal(f.peer.getWorkUnit(current.unit.id)!.priority, priority, "the caller has not committed its sentinel");
    database.exec("COMMIT;");
    committed = true;
    assert.equal(f.peer.getWorkUnit(current.unit.id)!.priority, priority + 1);
    noAdmissionHistory(f, current);
  } finally {
    if (!committed) database.exec("ROLLBACK;");
  }
});

test("two independent Stores racing the last slot admit only one complete group", async t => {
  const f = await workflowAdmissionFixture(t), holder = f.outsider("race-holder"), contenders = [f.outsider("left"), f.outsider("right")];
  assert.equal(f.store.acquireRuntimeSemaphoreSlots(batch(f, holder, { limit: 2 })).status, "acquired");
  const results = await admissionRace(t, f, contenders.map((current, index) => ({ method: "acquireRuntimeSemaphoreSlots",
    input: index ? batch(f, current, { limit: 2 }).reverse() : batch(f, current, { limit: 2 }) })));
  assert.deepEqual(results.map(result => result.status).sort(), ["acquired", "full"]);
  results.forEach((result, index) => {
    assert.equal(attemptSlots(f, contenders[index]).length, result.status === "acquired" ? 3 : 0);
    if (result.status === "full") noAdmissionHistory(f, contenders[index]);
  });
  assert.equal(slots(f).length, 6);
  assert.ok(slots(f).every(slot => slot.status === "active"));
});

test("concurrent duplicate batches create only one exact owner's group", async t => {
  const f = await workflowAdmissionFixture(t), current = f.outsider("duplicate-race"), input = batch(f, current);
  const results = await admissionRace(t, f, [0, 1].map(() => ({ method: "acquireRuntimeSemaphoreSlots", input })));
  assert.deepEqual(results.map(result => result.status).sort(), ["acquired", "changed"]);
  assert.equal(attemptSlots(f, current).length, 3);
});

for (const resourceType of ["provider", "runner", "channel_parallel"] as const) {
  test(`batch counts overdue preparing ${resourceType} reservations even if its caller widens the limit`, async t => {
    const f = await workflowAdmissionFixture(t), plan = f.plan({ resourceKeys: [] });
    plan.entries = plan.entries.map(entry => ({ ...entry, limit: 1 }));
    const scope = f.scope(resourceType, { plan }), generation = f.begin(scope), current = f.outsider(`preparing-${resourceType}`);
    const blocked = plan.entries.find(entry => entry.resourceType === resourceType);
    assert.ok(blocked);
    const inputs = batch(f, current, { limit: 999, acquiredAt: f.at(10_000), expiresAt: f.at(20_000) })
      .map(input => ({ ...input, resourceKey: input.resourceType === resourceType ? blocked.resourceKey : `free-${input.resourceType}` }));
    assert.deepEqual(noWrites(f, () => f.store.acquireRuntimeSemaphoreSlots(inputs)),
      { status: "full", resourceType, resourceKey: blocked.resourceKey });
    assert.equal(f.admission(scope, generation)!.status, "preparing");
    noAdmissionHistory(f, current);
  });
}

for (const status of ["created", "started", "waiting_for_approval", "cancelling"] as const) {
  test(`TTL cannot free a live ${status} owner's batch to admit a rival`, async t => {
    const f = await workflowAdmissionFixture(t), current = f.outsider(status), rival = f.outsider(`rival-${status}`);
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...current.fence, status, now: f.at(3) }));
    assert.equal(f.store.acquireRuntimeSemaphoreSlots(batch(f, current, { limit: 1 })).status, "acquired");
    assert.equal(noWrites(f, () => f.peer.expireRuntimeSemaphoreSlots(f.at(10_000))), 0);
    assert.deepEqual(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, rival,
      { limit: 1, acquiredAt: f.at(10_000), expiresAt: f.at(20_000) }))),
    { status: "full", resourceType: "provider", resourceKey: "batch-provider" });
    assert.equal(f.peer.getWorkUnitAttempt(current.attempt.id)!.status, status);
    noAdmissionHistory(f, rival);
  });
}

test("terminal cancellation with an undrained Host lifetime vetoes expiry during batch admission", async t => {
  const f = await workflowAdmissionFixture(t), scope = f.scope("cancel-veto"), generation = f.begin(scope);
  const current = f.prepare(scope, generation, "cancel-veto"), rival = f.outsider("cancel-veto-rival");
  assert.equal(f.store.acquireRuntimeSemaphoreSlots(batch(f, current, { expiresAt: f.at(5) })).status, "acquired");
  let stop!: () => void;
  const lifetime = new Promise<void>(resolve => { stop = resolve; });
  const completion = f.store.trackHostAttemptCompletion({ runId: current.run.id, ...current.fence }, lifetime, () => true);
  try {
    assert.equal(f.store.transitionRunStatus({ runId: current.run.id, expectedStatus: "queued", event: "cancel",
      actor: "system", now: f.at(6) }).ok, true);
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...current.fence, status: "cancelled", endedAt: f.at(6), now: f.at(6) }));
    assert.equal(noWrites(f, () => f.peer.expireRuntimeSemaphoreSlots(f.at(10_000))), 0);
    assert.deepEqual(noWrites(f, () => f.peer.acquireRuntimeSemaphoreSlots(batch(f, rival,
      { limit: 1, acquiredAt: f.at(10_000), expiresAt: f.at(20_000) }))),
    { status: "full", resourceType: "provider", resourceKey: "batch-provider" });
    assert.ok(attemptSlots(f, current).every(slot => slot.status === "active"));
    noAdmissionHistory(f, rival);
  } finally { stop(); await completion; }
});

test("batch cannot bypass a held workflow parent before or after its exact admission handoff", async t => {
  const f = await workflowParallelParentFixture(t) as unknown as ParallelFixture, outsider = f.outsider("parent"), prepared = f.prepareOriginal();
  assert.deepEqual(f.noWrites(() => f.store.acquireRuntimeSemaphoreSlots(batch(f, outsider))), { status: "changed" });
  const planned = prepared.plan.resourcePlan.entries.map(entry => f.slotInput(prepared, entry));
  assert.deepEqual(f.noWrites(() => f.store.acquireRuntimeSemaphoreSlots(planned)), { status: "changed" });
  assert.ok(f.store.acquireResourceLease(prepared.leaseInput));
  f.persistOriginal(prepared); f.readyOriginal(prepared);
  assert.deepEqual(f.noWrites(() => f.store.acquireRuntimeSemaphoreSlots(batch(f, prepared, { acquiredAt: f.at(12) }))),
    { status: "changed" });
  assert.deepEqual(f.noWrites(() => f.store.acquireRuntimeSemaphoreSlots(planned)), { status: "changed" });
  assert.equal(f.parent().state, "held");
});
