import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { acquireRunRuntimeSemaphores, DuplicateRunRequestError, prepareRunConcurrency }
  from "../dist/features/runs/concurrency.js";
import { claimFixtureContinuation, createContinuationConcurrencyFixture } from "./support/continuation-concurrency-admission-fixture.mjs";

function assertDuplicate(fixture, input) {
  assert.throws(() => prepareRunConcurrency(input), (error) => error instanceof DuplicateRunRequestError
    && error.runId === fixture.run.id);
  assert.equal(fixture.store.listResourceLeases().filter((lease) => lease.status === "active").length, 0);
}

test("A21 admission reuses original task dedupe only for its real current continuation and still takes leases/semaphores", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  const original = f.store.findStateTransitionByIdempotency("task", f.task.id, f.input.runRequest.idempotencyKey);
  const prepared = prepareRunConcurrency(f.input);
  assert.equal(prepared.task.id, f.task.id);
  assert.deepEqual(prepared.leases.map((lease) => lease.resourceType).sort(), ["bound_path", "task"]);
  for (const lease of prepared.leases) {
    assert.equal(lease.ownerId, f.run.id);
    assert.equal(lease.attemptId, f.activation.attempt.id);
    assert.equal(lease.fencingToken, f.activation.attempt.fencingToken);
  }
  acquireRunRuntimeSemaphores({ store: f.store, workUnit: f.input.workUnit, attempt: f.input.attempt,
    channel: prepared.channel, providerKey: "fixture-provider", runnerId: "pi", now: f.now });
  assert.equal(f.store.listRuntimeSemaphoreSlots().filter((slot) => slot.status === "active").length, 3);
  assert.deepEqual(f.store.findStateTransitionByIdempotency("task", f.task.id, f.input.runRequest.idempotencyKey), original);
});

test("A21 admission accepts a durable claimed continuation before its created target starts", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  claimFixtureContinuation(f);
  assert.equal(prepareRunConcurrency(f.input).leases.length, 2);
});

function changeTaskBeforeAdmissionSnapshot(fixture, changeTask) {
  const readSnapshot = fixture.store.readSnapshot.bind(fixture.store);
  fixture.store.readSnapshot = (read) => {
    fixture.store.readSnapshot = readSnapshot;
    // Persist a legal Task change after the outer Task read, before its authority snapshot.
    changeTask();
    return readSnapshot(read);
  };
}

test("A21 admission rejects Task changes to terminal before the authority snapshot", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  changeTaskBeforeAdmissionSnapshot(f, () => {
    assert.equal(f.store.transitionTaskStatus({ taskId: f.task.id, expectedStatus: "claimed", event: "cancel",
      actor: "system", reason: "owned Task cancellation", now: f.now }).ok, true);
  });
  assertDuplicate(f, f.input);
  assert.equal(f.store.getTask(f.task.id).status, "cancelled");
});

test("A21 admission rejects Task changes back to todo before the authority snapshot", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  changeTaskBeforeAdmissionSnapshot(f, () => {
    assert.equal(f.store.updateTask(f.task.id, { status: "todo" }, f.now).status, "todo");
  });
  assertDuplicate(f, f.input);
  assert.equal(f.store.getTask(f.task.id).status, "todo");
});

test("A21 admission rejects Task changes to another actual current Run before the authority snapshot", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  const other = await createContinuationConcurrencyFixture(t, { store: f.store, cwd: f.cwd });
  changeTaskBeforeAdmissionSnapshot(f, () => {
    assert.equal(f.store.updateTask(f.task.id, { currentRunId: other.run.id }, f.now).currentRunId, other.run.id);
  });
  assertDuplicate(f, f.input);
  assert.equal(f.store.getTask(f.task.id).status, "claimed");
  assert.equal(f.store.getTask(f.task.id).currentRunId, other.run.id);
});

for (const [name, mutate] of [
  ["new request without the private continuation identity", (f) => ({ ...f.input, existingContinuationId: undefined })],
  ["public request boolean or id", (f) => ({ ...f.input, existingContinuationId: undefined,
    runRequest: { ...f.input.runRequest, existingContinuationId: f.activation.continuation.id, existingContinuation: true } })],
  ["unknown continuation", (f) => ({ ...f.input, existingContinuationId: "not-a-continuation" })],
  ["different run", (f) => ({ ...f.input, runId: "different-run" })],
  ["different work unit", (f) => ({ ...f.input, workUnit: { ...f.input.workUnit, id: "different-unit" } })],
  ["old source Attempt", (f) => ({ ...f.input, attempt: f.sourceAttempt })],
  ["changed runtime", (f) => ({ ...f.input, attempt: { ...f.input.attempt, runtimeInstanceId: "other-runtime" } })],
  ["changed fence", (f) => ({ ...f.input, attempt: { ...f.input.attempt, fencingToken: "other-fence" } })],
]) {
  test(`A21 admission rejects task dedupe reuse for ${name}`, async (t) => {
    const f = await createContinuationConcurrencyFixture(t);
    assertDuplicate(f, mutate(f));
  });
}

test("A21 admission rejects an actual other Run continuation", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  const other = await createContinuationConcurrencyFixture(t, { store: f.store, cwd: f.cwd });
  assert.equal(f.store.getRunnerContinuation(other.activation.continuation.id).runId, other.run.id);
  assert.notEqual(other.run.id, f.run.id);
  assertDuplicate(f, { ...f.input, existingContinuationId: other.activation.continuation.id });
});

test("A21 admission rejects an expired durable continuation claim", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  claimFixtureContinuation(f);
  assertDuplicate(f, { ...f.input, now: new Date(Date.parse(f.now) + 60_000).toISOString() });
});

test("A21 admission rejects a replaced target even when the old input still looks valid", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  f.store.createWorkUnitAttempt({ workUnitId: f.input.workUnit.id, attemptNumber: 3,
    runtimeInstanceId: "replacement-runtime", runnerId: "pi", status: "created", now: f.now });
  assertDuplicate(f, f.input);
});

test("A21 admission rejects a terminal Run", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  f.store.markRunSucceeded(f.run.id, f.now);
  assertDuplicate(f, f.input);
});

test("A21 admission does not turn an already-running continuation into new admission", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  const claimed = claimFixtureContinuation(f);
  assert.equal(f.store.startRunnerContinuation({ continuationId: f.activation.continuation.id,
    expectedRevision: claimed.claim.value.revision, claimOwner: claimed.claimOwner, claimToken: claimed.claimToken,
    targetFence: toRuntimeAttemptFence(f.activation.attempt), now: f.now }).ok, true);
  assertDuplicate(f, f.input);
});

test("A21 admission keeps resource conflicts after valid continuation dedupe reuse", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  const blocker = f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "task",
    resourceKey: f.task.id, ownerType: "system", ownerId: "owned-fixture-blocker", acquiredAt: f.now,
    expiresAt: new Date(Date.parse(f.now) + 60_000).toISOString() });
  assert.ok(blocker);
  assert.throws(() => prepareRunConcurrency(f.input), (error) => error.code === "resource_conflict");
  assert.deepEqual(f.store.listResourceLeases().filter((lease) => lease.status === "active").map((lease) => lease.id), [blocker.id]);
});

test("A21 admission keeps provider semaphore limits and releases only its own leases on conflict", async (t) => {
  const f = await createContinuationConcurrencyFixture(t);
  const prepared = prepareRunConcurrency(f.input);
  const blockers = [];
  for (let index = 0; index < 4; index++) {
    const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
      ownerId: `blocker-${index}`, runnerId: "pi", idempotencyKey: `blocker-${index}`, request: {}, createdByActor: "system", now: f.now });
    const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: `blocker-runtime-${index}`, runnerId: "pi", now: f.now });
    const slot = f.store.acquireRuntimeSemaphoreSlot({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "provider",
      resourceKey: "full-provider", limit: 4, ownerType: "work_unit_attempt", ownerId: attempt.id,
      ...toRuntimeAttemptFence(attempt), acquiredAt: f.now, expiresAt: new Date(Date.parse(f.now) + 60_000).toISOString() });
    assert.ok(slot);
    blockers.push(slot.id);
  }
  assert.throws(() => acquireRunRuntimeSemaphores({ store: f.store, workUnit: f.input.workUnit, attempt: f.input.attempt,
    channel: prepared.channel, providerKey: "full-provider", runnerId: "pi", now: f.now }),
  (error) => error.code === "runtime_semaphore_conflict");
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots().filter((slot) => slot.status === "active").map((slot) => slot.id).sort(), blockers.sort());
  assert.equal(f.store.listResourceLeases().filter((lease) => lease.status === "active").length, 0);
});
