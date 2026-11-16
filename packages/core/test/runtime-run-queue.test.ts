import assert from "node:assert/strict";
import test from "node:test";
import type { CreateResourceLeaseInput, DispatchRuntimeQueuedRunInput, AcquireRuntimeSemaphoreSlotInput,
  RuntimeRunQueueClaim } from "../dist/index.js";
import { runtimeRunQueueFixture, type RuntimeRunQueueFixture, type PreparedQueueRun } from "./support/runtime-run-queue-fixture.ts";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableDispatchInput = Omit<DispatchRuntimeQueuedRunInput, "leases" | "semaphores"> & {
  leases: Mutable<CreateResourceLeaseInput>[];
  semaphores: Mutable<AcquireRuntimeSemaphoreSlotInput>[];
};

function admitted(f: RuntimeRunQueueFixture, current: PreparedQueueRun, claim: RuntimeRunQueueClaim,
  overrides: Partial<DispatchRuntimeQueuedRunInput> = {}, store = f.store) {
  const result = f.dispatch(current, claim, overrides, store);
  assert.equal(result.status, "admitted", JSON.stringify(result));
  const expected = f.resources(current, overrides.now ?? f.at(5));
  assert.equal(result.leases.length, expected.leases.length);
  assert.equal(result.semaphores.length, expected.semaphores.length);
  assert.equal(f.peer.getTask(current.task.id)!.status, "claimed");
  assert.equal(f.peer.getTask(current.task.id)!.currentRunId, current.run.id);
  assert.equal(f.peer.getWorkUnit(current.unit.id)!.status, "claimed");
  assert.equal(f.peer.getWorkUnit(current.unit.id)!.activeAttemptId, current.attempt.id);
  assert.equal(f.peer.getWorkUnit(current.unit.id)!.attemptCount, 1);
  assert.deepEqual(f.peer.getWorkUnitAttempt(current.attempt.id),
    { ...current.attempt, lastEventAt: overrides.now ?? f.at(5) });
  assert.equal(f.peer.getRun(current.run.id)!.status, "queued", "Core admission is not a Runner ACK");
  assert.equal(result.entry.dispatchedAt, overrides.now ?? f.at(5));
  const events = f.peer.listRuntimeEvents(current.unit.id)
    .filter(event => event.type === "work_unit_claimed" && event.data !== null && typeof event.data === "object"
      && "runId" in event.data && event.data.runId === current.run.id);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { ...events[0], ...current.fence, actor: "system",
    ts: overrides.now ?? f.at(5), data: { runId: current.run.id } });
  for (const resource of [...result.leases, ...result.semaphores]) {
    for (const [key, value] of Object.entries(current.fence)) assert.equal(Reflect.get(resource, key), value);
  }
  return result;
}

function driftRequest(f: RuntimeRunQueueFixture, current: PreparedQueueRun,
  mutate: (request: PreparedQueueRun["run"]["requestSnapshot"]) => void, { both = false } = {}) {
  const request = structuredClone(f.store.getRun(current.run.id)!.requestSnapshot) as PreparedQueueRun["run"]["requestSnapshot"];
  mutate(request);
  testDatabase(f.store).prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id=?")
    .run(JSON.stringify(request), current.run.id);
  if (both) {
    const unitRequest = structuredClone(f.store.getWorkUnit(current.unit.id)!.request) as PreparedQueueRun["unit"]["request"];
    mutate(unitRequest);
    testDatabase(f.store).prepare("UPDATE work_units SET request_json=? WHERE id=?").run(JSON.stringify(unitRequest), current.unit.id);
  }
}

for (const kind of ["task_run", "conversation_run"] as const) {
  test(`${kind} enqueue and preparation claim preserve the original Attempt without taking execution resources`, async t => {
    const f = await runtimeRunQueueFixture(t), current = f.prepare(kind, { kind }), before = f.executionSnapshot();
    const entry = f.enqueue(current);
    assert.match(entry.snapshotDigest, /^[0-9a-f]{64}$/u);
    assert.deepEqual(entry.sourceFence, current.fence);
    assert.equal(entry.workspaceId, f.workspaceId);
    assert.equal(entry.groupKey, `channel:${f.channel.id}`);
    assert.equal(entry.revision, 1);
    assert.equal(entry.lastSelected, 0);
    assert.equal(entry.claim, undefined);
    assert.deepEqual(f.executionSnapshot(), before);
    const duplicate = f.noWrites(() => f.peer.enqueueRuntimeRun(f.enqueueInput(current,
      { reason: "resource_conflict", now: f.at(20) })));
    assert.equal(duplicate.status, "duplicate");
    assert.deepEqual(duplicate.entry, entry);
    const claim = f.claim({}, f.peer);
    assert.equal(claim.runId, current.run.id);
    assert.deepEqual(claim.sourceFence, current.fence);
    assert.equal(claim.runtimeInstanceId, f.store.getRuntimeConcurrencyPolicy(f.workspaceId)!.runtimeInstanceId);
    assert.notEqual(claim.runtimeInstanceId, current.attempt.runtimeInstanceId);
    assert.deepEqual(f.executionSnapshot(), before);
    f.noAdmission(current);
    admitted(f, current, claim);
    assert.deepEqual(f.store.getWorkUnitAttempt(current.attempt.id), { ...current.attempt, lastEventAt: f.at(5) });
    assert.equal(f.rows("runner_continuations").length, 0, "a queued first dispatch never creates a successor continuation");
  });
}

test("independent enqueue Workers persist one queue identity for the same original Run", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("enqueue-race"), input = f.enqueueInput(current);
  const before = f.executionSnapshot(), results = await f.race([
    { method: "enqueueRuntimeRun", input }, { method: "enqueueRuntimeRun", input },
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ["duplicate", "enqueued"]);
  const [left, right] = results;
  assert.ok(left.status !== "changed" && right.status !== "changed");
  assert.deepEqual(left.entry, right.entry);
  assert.equal(f.rows("runtime_run_queue").length, 1);
  assert.deepEqual(f.executionSnapshot(), before);
});

for (const state of ["paused", "disabled", "hidden"] as const) {
  test(`a ${state} participant cannot consume a queue gate and its original claim survives restoration`, async t => {
    const f = await runtimeRunQueueFixture(t);
    const teammate = f.store.createAiTeammate({ roleKey: "engineer", displayName: "Queued engineer",
      description: "Queue participant", allowedTools: ["read"], approvalProfile: { mode: "none" } }, f.at(0));
    const current = f.prepare(`participant-${state}`, { teammateId: teammate.id });
    f.enqueue(current);
    const claim = f.claim();
    const original = { run: current.run.requestSnapshot, unit: current.unit.request, attempt: current.attempt };
    if (state === "disabled") f.peer.disableAiTeammate(teammate.id, f.at(4));
    else f.peer.updateAiTeammate(teammate.id, state === "hidden" ? { hidden: true } : { status: state }, f.at(4));
    assert.equal(f.noWrites(() => f.dispatch(current, claim)).status, "changed");
    f.noAdmission(current);
    assert.deepEqual(f.store.getRun(current.run.id)!.requestSnapshot, original.run);
    assert.deepEqual(f.store.getWorkUnit(current.unit.id)!.request, original.unit);
    assert.deepEqual(f.store.getWorkUnitAttempt(current.attempt.id), original.attempt);
    assert.deepEqual(f.store.getRuntimeRunQueueEntry(current.run.id)!.claim, claim);
    f.peer.updateAiTeammate(teammate.id, { status: "active", hidden: false }, f.at(5));
    admitted(f, current, claim);
    assert.equal(f.store.getRun(current.run.id)!.teammateId, teammate.id);
  });
}

test("a conflict on the second write lease rolls back the earlier Task lease and leaves the dispatch gate reusable", async t => {
  const f = await runtimeRunQueueFixture(t), holder = f.prepare("write-holder", { tools: ["write"] });
  const heldInput = f.resources(holder).leases.find(lease => lease.resourceType === "bound_path");
  assert.ok(heldInput);
  assert.ok(f.store.acquireResourceLease(heldInput));
  const current = f.prepare("write-conflict", { tools: ["read", "write"] });
  f.enqueue(current, { reason: "resource_conflict" });
  const claim = f.claim();
  assert.equal(f.resources(current).leases.length, 2);
  assert.deepEqual(f.noWrites(() => f.dispatch(current, claim, {}, f.peer)), { status: "busy", reason: "resource_conflict" });
  f.noAdmission(current);
  assert.deepEqual(f.store.getRuntimeRunQueueEntry(current.run.id)!.claim, claim);
  assert.equal(f.release(holder).leases, 1);
  admitted(f, current, claim, { now: f.at(7) }, f.peer);
});

for (const cap of ["total", "provider", "runner", "channel"]) {
  test(`queue dispatch uses current ${cap} capacity and rolls back the complete resource group on saturation`, async t => {
    const policyLimits = cap === "total" ? { maxConcurrentRuns: 1 } : cap === "provider" ? { maxRunsPerProvider: 1 }
      : cap === "runner" ? { maxRunsPerRunner: 1 } : {};
    const f = await runtimeRunQueueFixture(t, { policyLimits });
    if (cap === "channel") f.channel = f.store.updateChannel(f.channel.id,
      { runtimePolicy: { ...f.channel.runtimePolicy, maxConcurrentRuns: 1 } }, f.at(1))!;
    const holder = f.prepare(`cap-holder-${cap}`);
    f.enqueue(holder);
    admitted(f, holder, f.claim());
    const current = f.prepare(`cap-candidate-${cap}`, { preset: cap === "provider" ? f.preset : f.provider(`candidate-${cap}`) });
    f.enqueue(current);
    const claim = f.claim({ now: f.at(6) });
    const input = f.dispatchInput(current, claim, { now: f.at(7) });
    assert.equal(input.semaphores.find(slot => slot.resourceType === "provider")!.limit, 4);
    assert.equal(input.semaphores.find(slot => slot.resourceType === "runner")!.limit, 4);
    assert.deepEqual(f.noWrites(() => f.peer.dispatchRuntimeQueuedRun(input)),
      { status: "busy", reason: "runtime_semaphore_conflict" });
    f.noAdmission(current);
    assert.equal(f.rows("runtime_semaphore_slots").filter(slot => slot.status === "active").length, 3);
    assert.equal(f.release(holder, f.at(8)).semaphores, 3);
    admitted(f, current, claim, { now: f.at(9) }, f.peer);
  });
}

test("a new executor fences the old claim and the reclaimed Run obeys the lowered current policy", async t => {
  const f = await runtimeRunQueueFixture(t, { policyLimits: { maxConcurrentRuns: 2 } });
  const holder = f.prepare("lower-holder");
  f.enqueue(holder);
  admitted(f, holder, f.claim());
  const current = f.prepare("lower-candidate", { preset: f.provider("lower-candidate") });
  f.enqueue(current);
  const old = f.claim({ now: f.at(6) }), before = f.executionSnapshot();
  const policy = f.installPolicy({ maxConcurrentRuns: 1 }, { store: f.peer, now: f.at(7) });
  assert.deepEqual(f.executionSnapshot(), before, "lowering capacity does not release an admitted execution");
  assert.deepEqual(f.noWrites(() => f.dispatch(current, old, { now: f.at(8) })), { status: "changed" });
  const claim = f.claim({ ownerId: "queue-worker-b", now: f.at(67) }, f.peer);
  assert.equal(claim.runtimeInstanceId, policy.runtimeInstanceId);
  assert.deepEqual(claim.sourceFence, current.fence);
  assert.deepEqual(f.noWrites(() => f.dispatch(current, claim, { now: f.at(68) })),
    { status: "busy", reason: "runtime_semaphore_conflict" });
  f.noAdmission(current);
  f.release(holder, f.at(69));
  admitted(f, current, claim, { now: f.at(70) });
});

test("dispatch binds the original Task idempotency key and records one claimed event without replay", async t => {
  const f = await runtimeRunQueueFixture(t), idempotencyKey = "queue-task-first-claim";
  const current = f.prepare("task-idempotency", { requestOverrides: { idempotencyKey } });
  f.enqueue(current);
  const claim = f.claim();
  admitted(f, current, claim);
  const event = f.peer.findStateTransitionByIdempotency("task", current.task.id, idempotencyKey);
  assert.ok(event);
  assert.equal(event.event, "claim");
  assert.equal(event.fromStatus, "todo");
  assert.equal(event.toStatus, "claimed");
  assert.equal(event.createdAt, f.at(5));
  assert.deepEqual(f.noWrites(() => f.dispatch(current, claim, { now: f.at(6) }, f.peer)), { status: "changed" });
  assert.deepEqual(f.peer.findStateTransitionByIdempotency("task", current.task.id, idempotencyKey), event);
});

test("an already-consumed Task idempotency key cannot admit a queued Run even when the Task can retry", async t => {
  const f = await runtimeRunQueueFixture(t), idempotencyKey = "queue-task-consumed";
  const current = f.prepare("task-idempotency-consumed", { tools: ["write"], requestOverrides: { idempotencyKey } });
  assert.equal(f.store.transitionTaskStatus({ taskId: current.task.id, expectedStatus: "todo", event: "claim",
    actor: "system", currentRunId: current.run.id, idempotencyKey, now: f.at(2) }).ok, true);
  assert.equal(f.store.transitionTaskStatus({ taskId: current.task.id, expectedStatus: "claimed", event: "run_failed",
    actor: "system", now: f.at(3) }).ok, true);
  f.enqueue(current);
  const claim = f.claim();
  assert.deepEqual(f.noWrites(() => f.dispatch(current, claim, {}, f.peer)), { status: "changed" });
  assert.equal(f.rows("resource_leases").length, 0);
  assert.equal(f.rows("runtime_semaphore_slots").length, 0);
  assert.equal(f.peer.getTask(current.task.id)!.status, "failed");
  assert.equal(f.peer.getWorkUnit(current.unit.id)!.status, "queued");
  assert.equal(f.peer.getWorkUnitAttempt(current.attempt.id)!.status, "created");
  assert.equal(f.peer.listRuntimeEvents(current.unit.id)
    .filter(event => event.type === "work_unit_claimed" && event.data !== null && typeof event.data === "object"
      && "runId" in event.data && event.data.runId === current.run.id).length, 0);
  assert.deepEqual(f.peer.getRuntimeRunQueueEntry(current.run.id)!.claim, claim);
  assert.equal(f.peer.getRuntimeRunQueueEntry(current.run.id)!.dispatchedAt, undefined);
});

for (const boundary of ["claimed event", "dispatch gate"]) {
  test(`a ${boundary} write failure rolls back resources, Task idempotency and WorkUnit transitions`, async t => {
    const f = await runtimeRunQueueFixture(t), idempotencyKey = "queue-atomic-claim";
    const current = f.prepare("dispatch-rollback", { tools: ["write"], requestOverrides: { idempotencyKey } });
    f.enqueue(current);
    const claim = f.claim();
    const trigger = boundary === "claimed event" ? "BEFORE INSERT ON runtime_events WHEN NEW.type='work_unit_claimed'"
      : "BEFORE UPDATE OF dispatched_at ON runtime_run_queue WHEN NEW.dispatched_at IS NOT NULL";
    testDatabase(f.store).exec(`CREATE TRIGGER queue_dispatch_fault ${trigger}
      BEGIN SELECT RAISE(ABORT,'queue-dispatch-fault'); END`);
    f.noWrites(() => assert.throws(() => f.dispatch(current, claim), /queue-dispatch-fault/u));
    f.noAdmission(current);
    assert.equal(f.peer.findStateTransitionByIdempotency("task", current.task.id, idempotencyKey), undefined);
    testDatabase(f.store).exec("DROP TRIGGER queue_dispatch_fault");
    admitted(f, current, claim, {}, f.peer);
    assert.equal(f.peer.findStateTransitionByIdempotency("task", current.task.id, idempotencyKey)!.event, "claim");
  });
}

const invalidResources: Record<string, (input: MutableDispatchInput) => void> = {
  "missing Task lease": input => { input.leases = input.leases.filter(lease => lease.resourceType !== "task"); },
  "foreign Task lease": input => { input.leases.find(lease => lease.resourceType === "task")!.resourceKey = "unrelated-task"; },
  "missing write lease": input => { input.leases = input.leases.filter(lease => lease.resourceType === "task"); },
  "foreign write scope": input => { input.leases.find(lease => lease.resourceType === "bound_path")!.resourceKey += "/unrelated"; },
  "missing Provider slot": input => { input.semaphores = input.semaphores.filter(slot => slot.resourceType !== "provider"); },
  "foreign Provider slot": input => { input.semaphores.find(slot => slot.resourceType === "provider")!.resourceKey = "other-provider"; },
  "foreign Runner slot": input => { input.semaphores.find(slot => slot.resourceType === "runner")!.resourceKey = "codex"; },
  "foreign channel slot": input => { input.semaphores.find(slot => slot.resourceType === "channel_parallel")!.resourceKey = "other-channel"; },
  "stale lease fence": input => { input.leases[0].fencingToken = "999999"; },
  "stale slot fence": input => { input.semaphores[0].runtimeInstanceId = "stale-runtime"; },
  "duplicate Task lease": input => { input.leases.push({ ...input.leases[0] }); },
  "duplicate Provider slot": input => { input.semaphores.push({ ...input.semaphores[0] }); },
};
for (const [name, mutate] of Object.entries(invalidResources)) {
  test(`${name} cannot consume a queue gate or claim any partial execution resources`, async t => {
    const f = await runtimeRunQueueFixture(t), current = f.prepare("invalid-resources", { tools: ["read", "write"] });
    f.enqueue(current);
    const claim = f.claim(), input = structuredClone(f.dispatchInput(current, claim)) as MutableDispatchInput;
    mutate(input);
    assert.deepEqual(f.noWrites(() => f.peer.dispatchRuntimeQueuedRun(input)), { status: "changed" });
    f.noAdmission(current);
    admitted(f, current, claim);
  });
}

test("a claim is exclusive until its exact TTL boundary and stale defer/dispatch cannot clear the replacement claim", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("claim-takeover");
  f.enqueue(current);
  const old = f.claim({ leaseMs: 1_000 });
  assert.equal(f.noWrites(() => f.peer.claimNextRuntimeRun(f.claimInput({ ownerId: "queue-worker-b", now: f.at(4.999) }))).status, "empty");
  const claim = f.claim({ ownerId: "queue-worker-b", now: f.at(5) }, f.peer);
  assert.ok(claim.revision > old.revision);
  assert.notEqual(claim.token, old.token);
  assert.deepEqual(claim.sourceFence, old.sourceFence);
  assert.equal(f.noWrites(() => f.store.deferRuntimeQueuedRun({ claim: old, reason: "resource_conflict",
    now: f.at(5.001), retryAt: f.at(10) })), false);
  assert.deepEqual(f.noWrites(() => f.dispatch(current, old, { now: f.at(5.001) })), { status: "changed" });
  assert.deepEqual(f.store.getRuntimeRunQueueEntry(current.run.id)!.claim, claim);
  f.noAdmission(current);
  admitted(f, current, claim, { now: f.at(6) });
});

test("an expired preparation claim cannot dispatch or defer before a replacement worker has claimed it", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("expired-unclaimed");
  f.enqueue(current);
  const claim = f.claim({ leaseMs: 1_000 });
  assert.deepEqual(f.noWrites(() => f.dispatch(current, claim, { now: f.at(5) })), { status: "changed" });
  assert.equal(f.noWrites(() => f.store.deferRuntimeQueuedRun({ claim, reason: "resource_conflict", now: f.at(5), retryAt: f.at(10) })), false);
  f.noAdmission(current);
});

test("independent claim Workers select the original queue head exactly once without taking execution resources", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("claim-race");
  f.enqueue(current);
  const before = f.executionSnapshot(), results = await f.race(["worker-a", "worker-b"].map(ownerId =>
    ({ method: "claimNextRuntimeRun", input: f.claimInput({ ownerId }) })));
  assert.deepEqual(results.map(result => result.status).sort(), ["claimed", "empty"]);
  const winner = results.find(result => result.status === "claimed");
  assert.ok(winner && winner.status === "claimed");
  assert.deepEqual(f.peer.getRuntimeRunQueueEntry(current.run.id)!.claim, winner.claim);
  assert.deepEqual(f.executionSnapshot(), before);
  f.noAdmission(current);
});

test("two dispatch Workers sharing one claim consume its gate only once", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("dispatch-race");
  f.enqueue(current);
  const claim = f.claim(), input = f.dispatchInput(current, claim);
  const results = await f.race([{ method: "dispatchRuntimeQueuedRun", input }, { method: "dispatchRuntimeQueuedRun", input }]);
  assert.deepEqual(results.map(result => result.status).sort(), ["admitted", "changed"]);
  assert.equal(f.rows("resource_leases").length, 1);
  assert.equal(f.rows("runtime_semaphore_slots").length, 3);
  assert.equal(f.rows("state_transition_events").filter(event => event.entity_id === current.task.id && event.event === "claim").length, 1);
  assert.equal(f.rows("state_transition_events").filter(event => event.entity_id === current.unit.id && event.event === "claim").length, 1);
  assert.equal(f.peer.listRuntimeEvents(current.unit.id)
    .filter(event => event.type === "work_unit_claimed" && event.data !== null && typeof event.data === "object"
      && "runId" in event.data && event.data.runId === current.run.id).length, 1);
  assert.equal(f.rows("work_unit_attempts").length, 1);
});

test("independent dispatch Workers with distinct claims compete atomically for the same final workspace place", async t => {
  const f = await runtimeRunQueueFixture(t, { policyLimits: { maxConcurrentRuns: 1 } });
  const currents = [f.prepare("capacity-race-a"), f.prepare("capacity-race-b", { channel: f.channelFor("race-b"), preset: f.provider("race-b") })];
  currents.forEach(current => f.enqueue(current));
  const claims = [f.claim(), f.claim({ ownerId: "queue-worker-b" }, f.peer)];
  const results = await f.race(currents.map((current, index) => ({ method: "dispatchRuntimeQueuedRun",
    input: f.dispatchInput(current, claims[index]) })));
  assert.deepEqual(results.map(result => result.status).sort(), ["admitted", "busy"]);
  const winner = results.findIndex(result => result.status === "admitted"), loser = 1 - winner;
  assert.deepEqual(results[loser], { status: "busy", reason: "runtime_semaphore_conflict" });
  f.noAdmission(currents[loser]);
  assert.equal(f.rows("resource_leases").length, 1);
  assert.equal(f.rows("runtime_semaphore_slots").length, 3);
  f.release(currents[winner]);
  admitted(f, currents[loser], claims[loser], { now: f.at(7) });
  assert.deepEqual(f.noWrites(() => f.dispatch(currents[winner], claims[winner], { now: f.at(8) })), { status: "changed" });
});

test("a consumed dispatch gate survives claim expiry and SQLite reopen without replaying or releasing unknown execution", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("consumed");
  f.enqueue(current);
  const claim = f.claim(), result = admitted(f, current, claim), before = f.snapshot();
  f.reopen();
  f.reopen("peer");
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.peer.getRuntimeRunQueueEntry(current.run.id), result.entry);
  assert.equal(f.noWrites(() => f.store.claimNextRuntimeRun(f.claimInput({ now: f.at(30_000) }))).status, "empty");
  assert.deepEqual(f.noWrites(() => f.dispatch(current, claim, { now: f.at(30_000) }, f.peer)), { status: "changed" });
  assert.equal(f.noWrites(() => f.store.deferRuntimeQueuedRun({ claim, reason: "resource_conflict",
    now: f.at(30_000), retryAt: f.at(30_001) })), false);
  assert.equal(f.noWrites(() => f.store.expireRuntimeSemaphoreSlots(f.at(30_000))), 0);
  assert.equal(f.noWrites(() => f.peer.expireResourceLeases(f.at(30_000))), 0);
  assert.equal(f.store.hasRuntimeRunQueueCustody(current.run.id), true);
  assert.equal(f.noWrites(() => f.store.recoverStaleRuns(f.at(30_000))), 0);
});

test("a stale queued projection cannot erase a consumed dispatch fact", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("projection-replay");
  f.enqueue(current);
  const claim = f.claim(), result = admitted(f, current, claim);
  testDatabase(f.store).prepare("UPDATE work_units SET status='queued' WHERE id=?").run(current.unit.id);
  testDatabase(f.store).prepare("UPDATE tasks SET status='todo',current_run_id=NULL WHERE id=?").run(current.task.id);
  f.reopen();
  assert.equal(f.noWrites(() => f.store.claimNextRuntimeRun(f.claimInput({ now: f.at(30_000) }))).status, "empty");
  assert.deepEqual(f.noWrites(() => f.dispatch(current, claim, { now: f.at(30_000) })), { status: "changed" });
  assert.equal(f.peer.getRuntimeRunQueueEntry(current.run.id)!.dispatchedAt, result.entry.dispatchedAt);
});

for (const phase of ["before-claim", "after-claim"]) {
  for (const boundary of ["Run", "WorkUnit", "Attempt"]) {
    test(`${boundary} cancellation ${phase} forbids queue dispatch without releasing unrelated resources`, async t => {
      const f = await runtimeRunQueueFixture(t), current = f.prepare(`cancel-${boundary}-${phase}`);
      f.enqueue(current);
      const claim = phase === "after-claim" ? f.claim() : undefined;
      if (boundary === "Run") assert.equal(f.store.transitionRunStatus({ runId: current.run.id, expectedStatus: "queued",
        event: "cancel", actor: "local-user", now: f.at(4) }).ok, true);
      if (boundary === "WorkUnit") assert.equal(f.store.transitionWorkUnitStatus({ ...current.fence, expectedStatus: "queued",
        event: "cancel", actor: "local-user", now: f.at(4) }).ok, true);
      if (boundary === "Attempt") assert.ok(f.store.updateWorkUnitAttemptStatus({ ...current.fence, status: "created",
        abortRequestedAt: f.at(4), now: f.at(4) }));
      if (claim) assert.deepEqual(f.noWrites(() => f.dispatch(current, claim)), { status: "changed" });
      else assert.notEqual(f.noWrites(() => f.peer.claimNextRuntimeRun(f.claimInput())).status, "claimed");
      assert.equal(f.rows("resource_leases").length, 0);
      assert.equal(f.rows("runtime_semaphore_slots").length, 0);
      assert.equal(f.peer.getRuntimeRunQueueEntry(current.run.id)!.dispatchedAt, undefined);
      assert.equal(f.peer.hasRuntimeRunQueueCustody(current.run.id), false);
    });
  }
}

test("Task cancellation between preparation and dispatch rolls back the complete admission", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("task-cancel", { tools: ["write"] });
  f.enqueue(current);
  const claim = f.claim();
  assert.equal(f.peer.transitionTaskStatus({ taskId: current.task.id, expectedStatus: "todo", event: "cancel",
    actor: "local-user", now: f.at(4) }).ok, true);
  assert.deepEqual(f.noWrites(() => f.dispatch(current, claim)), { status: "changed" });
  assert.equal(f.rows("resource_leases").length, 0);
  assert.equal(f.rows("runtime_semaphore_slots").length, 0);
  assert.equal(f.peer.getWorkUnit(current.unit.id)!.status, "queued");
  assert.equal(f.peer.getRuntimeRunQueueEntry(current.run.id)!.dispatchedAt, undefined);
});

for (const both of [false, true]) {
  for (const field of ["execution", "policy"]) {
    test(`${field} drift in ${both ? "both matching" : "only the Run"} frozen snapshots invalidates a queue claim`, async t => {
      const f = await runtimeRunQueueFixture(t), current = f.prepare(`drift-${field}-${both}`);
      f.enqueue(current);
      const claim = f.claim();
      driftRequest(f, current, request => {
        if (field === "execution") request.runnerExecutionInput.input.systemPrompt += " Drift.";
        else request.effectivePolicySnapshot = { ...request.effectivePolicySnapshot, workspacePolicyUpdatedAt: f.at(10) };
      }, { both });
      assert.deepEqual(f.noWrites(() => f.dispatch(current, claim, {}, f.peer)), { status: "changed" });
      assert.equal(f.peer.hasRuntimeRunQueueCustody(current.run.id), false);
      f.noAdmission(current);
    });
  }
}

test("drifted frozen input cannot be deduplicated or selected as a new valid queue entry", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("drift-before-claim");
  const original = f.enqueue(current);
  driftRequest(f, current, request => { request.runnerExecutionInput.input.task.prompt += " Drift."; }, { both: true });
  assert.deepEqual(f.noWrites(() => f.peer.enqueueRuntimeRun(f.enqueueInput(current))), { status: "changed" });
  const before = f.executionSnapshot();
  assert.deepEqual(f.peer.claimNextRuntimeRun(f.claimInput()), { status: "empty" });
  assert.deepEqual(f.executionSnapshot(), before);
  const deferred = f.peer.getRuntimeRunQueueEntry(current.run.id);
  assert.deepEqual(deferred, { ...original, retryAt: f.at(64) });
  assert.equal(f.peer.hasRuntimeRunQueueCustody(current.run.id), false);
  f.noAdmission(current);
});

test("a drifted queue head is deferred without blocking an independent group or changing frozen queue identity", async t => {
  const f = await runtimeRunQueueFixture(t), head = f.prepare("invalid-head"), sibling = f.prepare("invalid-head-sibling");
  const independent = f.prepare("valid-independent", { channel: f.channelFor("valid-independent") });
  const original = f.enqueue(head);
  for (const current of [sibling, independent]) f.enqueue(current);
  driftRequest(f, head, request => { request.runnerExecutionInput.input.systemPrompt += " Drift."; }, { both: true });
  const before = f.executionSnapshot(), claim = f.claim({}, f.peer);
  assert.equal(claim.runId, independent.run.id);
  assert.deepEqual(f.executionSnapshot(), before);
  const deferred = f.peer.getRuntimeRunQueueEntry(head.run.id);
  assert.deepEqual(deferred, { ...original, retryAt: f.at(64) });
  f.noAdmission(head);
  f.noAdmission(sibling);
  admitted(f, independent, claim);
  f.reopen();
  assert.deepEqual(f.store.getRuntimeRunQueueEntry(head.run.id), deferred);
  assert.equal(f.noWrites(() => f.store.claimNextRuntimeRun(f.claimInput({ now: f.at(6) }))).status, "empty");
});

test("same-group FIFO prevents self-claim bypass while the head is claimed or deferred", async t => {
  const f = await runtimeRunQueueFixture(t), first = f.prepare("fifo-first"), second = f.prepare("fifo-second");
  const a = f.enqueue(first), b = f.enqueue(second);
  assert.ok(a.sequence < b.sequence);
  assert.equal(a.groupKey, b.groupKey);
  assert.equal(f.noWrites(() => f.peer.claimNextRuntimeRun(f.claimInput({ runId: second.run.id }))).status, "empty");
  const claim = f.claim();
  assert.equal(claim.runId, first.run.id);
  assert.equal(f.noWrites(() => f.peer.claimNextRuntimeRun(f.claimInput({ ownerId: "worker-b" }))).status, "empty");
  assert.equal(f.store.deferRuntimeQueuedRun({ claim, reason: "resource_conflict", now: f.at(5), retryAt: f.at(10) }), true);
  assert.equal(f.noWrites(() => f.peer.claimNextRuntimeRun(f.claimInput({ now: f.at(9) }))).status, "empty");
  const retried = f.claim({ now: f.at(10) }, f.peer);
  assert.equal(retried.runId, first.run.id);
  admitted(f, first, retried, { now: f.at(11) });
  const next = f.claim({ now: f.at(12) });
  assert.equal(next.runId, second.run.id);
  admitted(f, second, next, { now: f.at(13) });
});

test("persisted cross-group round robin alternates groups instead of draining the oldest group", async t => {
  const f = await runtimeRunQueueFixture(t), channelB = f.channelFor("round-robin-b");
  const a1 = f.prepare("rr-a1"), a2 = f.prepare("rr-a2"), b1 = f.prepare("rr-b1", { channel: channelB }), b2 = f.prepare("rr-b2", { channel: channelB });
  for (const current of [a1, a2, b1, b2]) f.enqueue(current);
  let selected = 0;
  for (const [index, current] of [a1, b1, a2, b2].entries()) {
    const claim = f.claim({ now: f.at(4 + index * 2) }, index % 2 ? f.peer : f.store);
    assert.equal(claim.runId, current.run.id);
    const entry = f.peer.getRuntimeRunQueueEntry(current.run.id);
    assert.ok(entry);
    assert.ok(entry.lastSelected > selected);
    selected = entry.lastSelected;
    admitted(f, current, claim, { now: f.at(5 + index * 2) });
    f.reopen();
  }
  assert.equal(f.noWrites(() => f.peer.claimNextRuntimeRun(f.claimInput({ now: f.at(20) }))).status, "empty");
});

test("a deferred conflicting group does not block an independent group or permit its own later sibling to overtake", async t => {
  const f = await runtimeRunQueueFixture(t), holder = f.prepare("defer-holder", { tools: ["write"] });
  assert.ok(f.store.acquireResourceLease(f.resources(holder).leases.find(lease => lease.resourceType === "bound_path")!));
  const a1 = f.prepare("defer-a1", { tools: ["write"] }), a2 = f.prepare("defer-a2"), b1 = f.prepare("defer-b1", { channel: f.channelFor("defer-b") });
  for (const current of [a1, a2, b1]) f.enqueue(current);
  const blocked = f.claim();
  assert.equal(blocked.runId, a1.run.id);
  assert.deepEqual(f.noWrites(() => f.dispatch(a1, blocked)), { status: "busy", reason: "resource_conflict" });
  assert.equal(f.store.deferRuntimeQueuedRun({ claim: blocked, reason: "resource_conflict", now: f.at(6), retryAt: f.at(20) }), true);
  const deferred = f.peer.getRuntimeRunQueueEntry(a1.run.id);
  assert.ok(deferred);
  assert.equal(deferred.claim, undefined);
  assert.equal(deferred.retryAt, f.at(20));
  assert.equal(deferred.reason, "resource_conflict");
  f.noAdmission(a1);
  const independent = f.claim({ now: f.at(7) }, f.peer);
  assert.equal(independent.runId, b1.run.id);
  admitted(f, b1, independent, { now: f.at(8) });
  assert.equal(f.noWrites(() => f.peer.claimNextRuntimeRun(f.claimInput({ now: f.at(9) }))).status, "empty");
  f.reopen();
  const retry = f.claim({ now: f.at(20) });
  assert.equal(retry.runId, a1.run.id);
  f.release(holder, f.at(21));
  admitted(f, a1, retry, { now: f.at(22) });
  const sibling = f.claim({ now: f.at(23) }, f.peer);
  assert.equal(sibling.runId, a2.run.id);
});

for (const stage of ["enqueued", "preparing", "dispatched"]) {
  test(`reopen and recoverStaleRuns preserve exact ${stage} queue custody without inventing a successor or permission to replay`, async t => {
    const f = await runtimeRunQueueFixture(t), current = f.prepare(`recover-${stage}`);
    f.enqueue(current);
    const claim = stage === "enqueued" ? undefined : f.claim({ leaseMs: 1_000 });
    if (stage === "dispatched") { assert.ok(claim); admitted(f, current, claim, { now: f.at(4.5) }); }
    const before = f.snapshot();
    f.reopen();
    f.reopen("peer");
    assert.equal(f.store.hasRuntimeRunQueueCustody(current.run.id), true);
    assert.equal(f.noWrites(() => f.peer.recoverStaleRuns(f.at(30_000))), 0);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.rows("work_unit_attempts").length, 1);
    assert.equal(f.rows("runner_continuations").length, 0);
    if (stage === "dispatched") assert.equal(f.noWrites(() => f.store.claimNextRuntimeRun(f.claimInput({ now: f.at(30_000) }))).status, "empty");
    else {
      const reclaimed = f.claim({ now: f.at(30_000), ownerId: "queue-worker-restarted" });
      assert.deepEqual(reclaimed.sourceFence, current.fence);
      admitted(f, current, reclaimed, { now: f.at(30_001) }, f.peer);
    }
  });
}

test("a request-level queued flag without a durable queue entry is not restart custody", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("legacy-queued", { requestOverrides: { queued: true } });
  assert.equal(f.store.getRuntimeRunQueueEntry(current.run.id), undefined);
  assert.equal(f.store.hasRuntimeRunQueueCustody(current.run.id), false);
  f.reopen();
  assert.equal(f.store.recoverStaleRuns(f.at(30_000)), 1);
  assert.equal(f.peer.getRun(current.run.id)!.status, "failed");
  assert.equal(f.rows("runtime_run_queue").length, 0);
  assert.equal(f.rows("runtime_semaphore_slots").length, 0);
});

test("a queue row with drifted frozen input does not exempt an ordinary abandoned Run from stale recovery", async t => {
  const f = await runtimeRunQueueFixture(t), current = f.prepare("invalid-custody");
  f.enqueue(current);
  driftRequest(f, current, request => { request.runnerExecutionInput.input.systemPrompt += " Drift."; }, { both: true });
  assert.equal(f.store.hasRuntimeRunQueueCustody(current.run.id), false);
  f.reopen();
  assert.equal(f.store.recoverStaleRuns(f.at(30_000)), 1);
  assert.equal(f.peer.getRun(current.run.id)!.status, "failed");
  assert.equal(f.peer.getRuntimeRunQueueEntry(current.run.id)!.dispatchedAt, undefined);
  assert.equal(f.rows("work_unit_attempts").length, 1);
});
