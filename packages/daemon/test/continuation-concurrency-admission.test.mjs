import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { acquireRunRuntimeSemaphores, DuplicateRunRequestError, prepareRunConcurrency, recoverPreparedRunConcurrency }
  from "../dist/features/runs/concurrency.js";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { prepareUserInputContinuationRequest } from "../dist/features/runs/user-input-prepared-request.js";
import { userInputTranscriptFixture, claimedAt } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { claimFixtureContinuation, createContinuationConcurrencyFixture } from "./support/continuation-concurrency-admission-fixture.mjs";
import { prepareFixtureTaskInput } from "./support/prepared-input-fixture.mjs";

function assertDuplicate(fixture, input) {
  assert.throws(() => prepareRunConcurrency(input), (error) => error instanceof DuplicateRunRequestError
    && error.runId === fixture.run.id);
  assert.equal(fixture.store.listResourceLeases().filter((lease) => lease.status === "active").length, 0);
}

async function createPreparedRecoveryFixture(t) {
  const source = await userInputTranscriptFixture(t, { surface: "channel", storedTask: true, runnerId: "pi" });
  const sourceTask = { id: source.storedTask.id, channelId: source.channel.id,
    title: source.storedTask.title, prompt: source.storedTask.prompt };
  const provider = { provider: "fixture", model: "fixture", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", authHeader: false, reasoning: false };
  const sourceOptions = { cwd: source.cwd, task: sourceTask, provider, tools: ["write"],
    initialToolSurface: { userInput: true } };
  const sourcePreparedInput = await prepareFixtureTaskInput(sourceOptions);
  const sourceRunnerExecutionInput = capturePreparedRunnerInput({ runnerId: "pi", options: sourceOptions,
    preparedInput: sourcePreparedInput });
  const sourceRequest = { ...sourceOptions, workspaceCwd: source.cwd, threadId: source.thread.id,
    turnId: source.turn.turnId, channelId: source.channel.id, teammateId: source.participantId, runnerId: "pi",
    sourceMessageId: source.turn.item.id, createdByActor: "local-user", runnerExecutionInput: sourceRunnerExecutionInput };
  source.db.prepare("UPDATE run_sessions SET task_snapshot_json=?,request_snapshot_json=?,provider_snapshot_json=? WHERE id=?")
    .run(JSON.stringify(sourceTask), JSON.stringify(sourceRequest), JSON.stringify(provider), source.run.id);
  source.submit();
  const delivery = source.claim({ leaseMs: 60_000 });
  const claim = { threadId: source.thread.id, deliveryId: delivery.deliveryId, expectedRevision: delivery.revision,
    ownerId: delivery.claim.ownerId, claimToken: delivery.claim.token };
  const request = prepareUserInputContinuationRequest(source.store, claim, claimedAt).request;
  const executionOptions = { cwd: request.cwd, task: request.task, provider: request.provider, tools: request.tools };
  const preparedInput = await prepareFixtureTaskInput(executionOptions);
  const runnerExecutionInput = capturePreparedRunnerInput({ runnerId: "pi", options: executionOptions, preparedInput });
  const requestPreparation = source.store.getUserInputContinuationPreparation(claim.threadId, claim.deliveryId, "request");
  const execution = source.store.saveUserInputContinuationPreparation({ ...claim, stage: "execution",
    parentRef: { id: requestPreparation.id, fingerprint: requestPreparation.fingerprint }, payload: {
      schemaVersion: 1, runnerId: "pi", providerName: provider.provider, providerModel: provider.model,
      taskSnapshot: request.task, providerSnapshot: provider, requestSnapshot: request,
      runRequestSnapshot: { ...request, runnerExecutionInput }, preparedInput,
      preparedInputFingerprint: preparedInput.fingerprint, runnerExecutionInput,
    } }, claimedAt).snapshot;
  const binding = source.store.admitUserInputContinuation({ ...claim,
    executionRef: { id: execution.id, fingerprint: execution.fingerprint },
    runtimeInstanceId: "prepared-recovery-runtime" }, claimedAt);
  const run = source.store.getRun(binding.runId);
  const workUnit = source.store.getWorkUnit(binding.fence.workUnitId);
  const attempt = source.store.getWorkUnitAttempt(binding.fence.attemptId);
  assert.ok(run && workUnit && attempt);
  const recoveryClaimedAt = new Date(Date.parse(claimedAt) + 60_001).toISOString();
  const claimedRecovery = source.store.claimUserInputContinuationRecovery({
    threadId: source.thread.id,
    deliveryId: delivery.deliveryId,
    bindingRef: { id: binding.id, fingerprint: binding.fingerprint },
    sourceFence: binding.fence,
    ownerId: "prepared-recovery-worker",
    leaseMs: 60_000,
  }, recoveryClaimedAt);
  assert.equal(claimedRecovery.status, "claimed");
  const recoveryClaim = claimedRecovery.claim;
  const recovery = { store: source.store, claim: recoveryClaim, binding, runRequest: request, runId: run.id, workUnit, attempt,
    providerKey: `${provider.provider}:${provider.model}`, runnerId: "pi", now: recoveryClaimedAt };
  return { ...source, task: source.store.getTask(source.storedTask.id), run, workUnit, attempt,
    runRequest: request, recovery, claim: recoveryClaim, binding, now: recoveryClaimedAt };
}

function releasePreparedRecoveryResources(f, offsetMs = 1_000) {
  const releasedAt = new Date(Date.parse(f.now) + offsetMs).toISOString();
  const fence = toRuntimeAttemptFence(f.attempt);
  assert.equal(f.store.releaseResourceLeasesForAttempt(fence, releasedAt, "fixture-daemon-restart"), 2);
  assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(fence, releasedAt, "fixture-daemon-restart"), 3);
  const releasedSlots = f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "released" });
  assert.equal(releasedSlots.length, 3);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" }).length, 0);
  return { releasedAt, releasedSlots };
}

test("pre-start recovery reuses and renews the exact admitted Attempt resources", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  recoverPreparedRunConcurrency(f.recovery);
  const leaseIds = f.store.listResourceLeases({ attemptId: f.attempt.id, status: "active" }).map(value => value.id).sort();
  const slotIds = f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" }).map(value => value.id).sort();
  const eventIds = f.store.listRuntimeEvents(f.workUnit.id)
    .filter(event => event.type === "semaphore_acquired").map(event => event.id).sort();
  const eventTime = f.store.getWorkUnit(f.workUnit.id).lastEventAt;
  const recoveredAt = new Date(Date.parse(f.now) + 1_000).toISOString();

  const recovered = recoverPreparedRunConcurrency({ ...f.recovery, now: recoveredAt });

  assert.deepEqual(recovered.leases.map(value => value.id).sort(), leaseIds);
  assert.deepEqual(f.store.listResourceLeases({ attemptId: f.attempt.id, status: "active" }).map(value => value.id).sort(), leaseIds);
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" }).map(value => value.id).sort(), slotIds);
  assert.ok(recovered.leases.every(value => value.lastRenewedAt === recoveredAt));
  assert.ok(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" })
    .every(value => value.lastRenewedAt === recoveredAt));
  assert.deepEqual(f.store.listRuntimeEvents(f.workUnit.id)
    .filter(event => event.type === "semaphore_acquired").map(event => event.id).sort(), eventIds);
  assert.equal(f.store.getWorkUnit(f.workUnit.id).lastEventAt, eventTime,
    "renewing resources without new events must not rewrite the last evidence timestamp");
});

test("pre-start recovery completes only missing resources for the exact admitted Attempt", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  const expiresAt = new Date(Date.parse(f.now) + 60_000).toISOString();
  assert.ok(f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "task",
    resourceKey: f.task.id, ownerType: "run", ownerId: f.run.id, ...toRuntimeAttemptFence(f.attempt),
    acquiredAt: f.now, expiresAt }));
  assert.ok(f.store.acquireRuntimeSemaphoreSlot({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "provider",
    resourceKey: f.recovery.providerKey, limit: 4, ownerType: "work_unit_attempt", ownerId: f.attempt.id,
    ...toRuntimeAttemptFence(f.attempt), acquiredAt: f.now, expiresAt }));

  const recovered = recoverPreparedRunConcurrency(f.recovery);

  assert.deepEqual(recovered.leases.map(value => value.resourceType).sort(), ["bound_path", "task"]);
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" })
    .map(value => value.resourceType).sort(), ["channel_parallel", "provider", "runner"]);
  assert.deepEqual(f.store.listRuntimeEvents(f.workUnit.id)
    .filter(event => event.type === "semaphore_acquired").map(event => event.data.resourceType).sort(),
  ["channel_parallel", "provider", "runner"]);
});

test("two Store pre-start recovery calls reuse one exact semaphore set without duplicate evidence", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  const peer = createSqliteRunStore(f.cwd);
  t.after(() => peer.close());
  const first = recoverPreparedRunConcurrency(f.recovery);
  const second = recoverPreparedRunConcurrency({ ...f.recovery, store: peer,
    now: new Date(Date.parse(f.now) + 1_000).toISOString() });

  const slots = f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" });
  assert.deepEqual(second.leases.map(value => value.id).sort(), first.leases.map(value => value.id).sort());
  assert.deepEqual(slots.map(value => value.resourceType).sort(), ["channel_parallel", "provider", "runner"]);
  const acquiredEvents = f.store.listRuntimeEvents(f.workUnit.id)
    .filter(event => event.type === "semaphore_acquired");
  assert.equal(acquiredEvents.length, 3);
  assert.deepEqual(acquiredEvents.map(event => event.data.resourceType).sort(),
    ["channel_parallel", "provider", "runner"]);
});

test("pre-start recovery after daemon resource release preserves historical evidence and creates one fresh semaphore set", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  recoverPreparedRunConcurrency(f.recovery);
  const initialEvents = f.store.listRuntimeEvents(f.workUnit.id)
    .filter(event => event.type === "semaphore_acquired");
  assert.equal(initialEvents.length, 3);
  const { releasedSlots } = releasePreparedRecoveryResources(f);
  const releasedIds = new Set(releasedSlots.map(slot => slot.id));
  const peer = createSqliteRunStore(f.cwd);
  t.after(() => peer.close());
  const recoveredAt = new Date(Date.parse(f.now) + 2_000).toISOString();

  const recovered = recoverPreparedRunConcurrency({ ...f.recovery, store: peer, now: recoveredAt });

  assert.equal(recovered.leases.length, 2);
  const activeSlots = peer.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" });
  assert.deepEqual(activeSlots.map(slot => slot.resourceType).sort(), ["channel_parallel", "provider", "runner"]);
  assert.ok(activeSlots.every(slot => !releasedIds.has(slot.id)));
  assert.deepEqual(peer.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "released" })
    .map(slot => slot.id).sort(), [...releasedIds].sort());
  const recoveredEvents = peer.listRuntimeEvents(f.workUnit.id)
    .filter(event => event.type === "semaphore_acquired");
  assert.equal(recoveredEvents.length, 6);
  assert.deepEqual(recoveredEvents.map(event => event.data.id).sort(),
    [...releasedIds, ...activeSlots.map(slot => slot.id)].sort());

  recoverPreparedRunConcurrency({ ...f.recovery, store: peer,
    now: new Date(Date.parse(f.now) + 3_000).toISOString() });
  assert.equal(peer.listRuntimeEvents(f.workUnit.id)
    .filter(event => event.type === "semaphore_acquired").length, 6);
});

test("pre-start recovery fails closed when released semaphore evidence is forged", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  recoverPreparedRunConcurrency(f.recovery);
  const { releasedSlots } = releasePreparedRecoveryResources(f);
  const event = f.store.listRuntimeEvents(f.workUnit.id)
    .find(candidate => candidate.type === "semaphore_acquired" && candidate.data.id === releasedSlots[0].id);
  assert.ok(event);
  const forged = f.store.database.prepare("UPDATE runtime_events SET data_json=? WHERE id=?")
    .run(JSON.stringify({ ...event.data, resourceKey: `forged:${event.data.resourceKey}` }), event.id);
  assert.equal(Number(forged.changes), 1);

  assert.throws(() => recoverPreparedRunConcurrency({ ...f.recovery,
    now: new Date(Date.parse(f.now) + 2_000).toISOString() }),
  (error) => error.code === "continuation_resource_recovery_changed");
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "released" }).length, 3);
});

test("pre-start recovery fails closed when released semaphore evidence references a missing row", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  recoverPreparedRunConcurrency(f.recovery);
  const { releasedSlots } = releasePreparedRecoveryResources(f);
  const removed = f.store.database.prepare("DELETE FROM runtime_semaphore_slots WHERE id=?").run(releasedSlots[0].id);
  assert.equal(Number(removed.changes), 1);

  assert.throws(() => recoverPreparedRunConcurrency({ ...f.recovery,
    now: new Date(Date.parse(f.now) + 2_000).toISOString() }),
  (error) => error.code === "continuation_resource_recovery_changed");
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "released" }).length, 2);
});

test("pre-start recovery fails closed when one released semaphore has duplicate acquisition evidence", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  recoverPreparedRunConcurrency(f.recovery);
  const { releasedSlots } = releasePreparedRecoveryResources(f);
  const event = f.store.listRuntimeEvents(f.workUnit.id)
    .find(candidate => candidate.type === "semaphore_acquired" && candidate.data.id === releasedSlots[0].id);
  assert.ok(event);
  f.store.appendRuntimeEvent({ ...toRuntimeAttemptFence(f.attempt), type: "semaphore_acquired", actor: "system",
    ts: new Date(Date.parse(f.now) + 1_500).toISOString(), data: event.data });

  assert.throws(() => recoverPreparedRunConcurrency({ ...f.recovery,
    now: new Date(Date.parse(f.now) + 2_000).toISOString() }),
  (error) => error.code === "continuation_resource_recovery_changed");
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeEvents(f.workUnit.id)
    .filter(candidate => candidate.type === "semaphore_acquired").length, 4);
});

test("run_created replay preserves the first fact after physical recovery leases rotate", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  const initial = recoverPreparedRunConcurrency(f.recovery);
  const data = leases => ({ taskId: f.run.taskId, workUnitId: f.workUnit.id, attemptId: f.attempt.id,
    threadId: f.thread.id, cwd: f.run.cwd, providerName: f.run.providerName,
    leases: leases.map(({ id, resourceType, resourceKey, workUnitId, attemptId }) =>
      ({ id, resourceType, resourceKey, workUnitId, attemptId })) });
  const input = { claim: f.claim, bindingRef: { id: f.binding.id, fingerprint: f.binding.fingerprint },
    sourceFence: f.binding.fence, runId: f.run.id, workspaceCwd: f.cwd, data: data(initial.leases) };
  const first = f.store.publishUserInputContinuationRunCreated(input, f.now);
  releasePreparedRecoveryResources(f);
  const now = new Date(Date.parse(f.now) + 2_000).toISOString();
  const recovered = recoverPreparedRunConcurrency({ ...f.recovery, now });
  assert.ok(recovered.leases.every(lease => !initial.leases.some(old => old.id === lease.id)));
  const replay = f.store.publishUserInputContinuationRunCreated({ ...input, data: data(recovered.leases) }, now);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.event, first.event);
  assert.deepEqual(f.store.listEvents(f.run.id).filter(event => event.type === "run_created"), [first.event]);
  for (const damage of [
    { ...data(recovered.leases), providerName: "changed-provider" },
    { ...data(recovered.leases), leases: data(recovered.leases).leases.slice(1) },
    { ...data(recovered.leases), leases: [...data(recovered.leases).leases, data(recovered.leases).leases[0]] },
    { ...data(recovered.leases), leases: data(initial.leases).leases },
    { ...data(recovered.leases), leases: data(recovered.leases).leases.map(lease => ({ ...lease, id: "missing-row" })) },
  ]) {
    // The exact original event remains a valid replay; a new publication must
    // reference the current physical set, not substitute arbitrary stale IDs.
    if (JSON.stringify(damage) === JSON.stringify(input.data)) continue;
    assert.throws(() => f.store.publishUserInputContinuationRunCreated({ ...input, data: damage }, now),
      error => error.code === "source_conflict");
  }
});

test("pre-start recovery rejects released lease history outside its frozen logical set", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  recoverPreparedRunConcurrency(f.recovery);
  releasePreparedRecoveryResources(f);
  const old = f.store.listResourceLeases({ attemptId: f.attempt.id, status: "released" })[0];
  assert.ok(old);
  f.store.database.prepare("UPDATE resource_leases SET resource_key=? WHERE id=?").run("changed-logical-key", old.id);
  assert.throws(() => recoverPreparedRunConcurrency({ ...f.recovery,
    now: new Date(Date.parse(f.now) + 2_000).toISOString() }),
  error => error.code === "continuation_resource_recovery_changed");
  assert.equal(f.store.listResourceLeases({ attemptId: f.attempt.id, status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" }).length, 0);
});

test("pre-start recovery rejects released slots with missing historical acquisition evidence", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  recoverPreparedRunConcurrency(f.recovery);
  const { releasedSlots } = releasePreparedRecoveryResources(f);
  const event = f.store.listRuntimeEvents(f.workUnit.id)
    .find(event => event.type === "semaphore_acquired" && event.data.id === releasedSlots[0].id);
  f.store.database.prepare("DELETE FROM runtime_events WHERE id=?").run(event.id);
  assert.throws(() => recoverPreparedRunConcurrency({ ...f.recovery,
    now: new Date(Date.parse(f.now) + 2_000).toISOString() }),
  error => error.code === "continuation_resource_recovery_changed");
  assert.equal(f.store.listResourceLeases({ attemptId: f.attempt.id, status: "active" }).length, 0);
});

test("pre-start recovery rejects foreign blockers without replacing their ownership", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  const blocker = f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "task",
    resourceKey: f.task.id, ownerType: "system", ownerId: "foreign-pre-start-owner", acquiredAt: f.now,
    expiresAt: new Date(Date.parse(f.now) + 60_000).toISOString() });
  assert.ok(blocker);

  assert.throws(() => recoverPreparedRunConcurrency(f.recovery),
    (error) => error.code === "user_input_continuation_prestart_busy" && error.kind === "resource");
  assert.deepEqual(f.store.listResourceLeases({ status: "active" }).map(value => value.id), [blocker.id]);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
});

test("pre-start recovery fails closed when the admitted Attempt owns an unexpected resource", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  const unexpected = f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "workspace",
    resourceKey: DEFAULT_WORKSPACE_ID, ownerType: "run", ownerId: f.run.id, ...toRuntimeAttemptFence(f.attempt),
    acquiredAt: f.now, expiresAt: new Date(Date.parse(f.now) + 60_000).toISOString() });
  assert.ok(unexpected);

  assert.throws(() => recoverPreparedRunConcurrency(f.recovery),
    (error) => error.code === "continuation_resource_recovery_changed");
  assert.deepEqual(f.store.listResourceLeases({ status: "active" }).map(value => value.id), [unexpected.id]);
});

test("pre-start recovery preserves a full foreign semaphore without taking an extra slot", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  const blockers = [];
  for (let index = 0; index < 4; index++) {
    const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
      ownerId: `recovery-blocker-${index}`, runnerId: "pi", idempotencyKey: `recovery-blocker-${index}`,
      request: {}, createdByActor: "system", now: f.now });
    const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: `recovery-blocker-runtime-${index}`, runnerId: "pi", status: "created", now: f.now });
    const slot = f.store.acquireRuntimeSemaphoreSlot({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "provider",
      resourceKey: f.recovery.providerKey, limit: 4, ownerType: "work_unit_attempt", ownerId: attempt.id,
      ...toRuntimeAttemptFence(attempt), acquiredAt: f.now,
      expiresAt: new Date(Date.parse(f.now) + 60_000).toISOString() });
    assert.ok(slot);
    blockers.push(slot.id);
  }

  assert.throws(() => recoverPreparedRunConcurrency(f.recovery),
    (error) => error.code === "user_input_continuation_prestart_busy" && error.kind === "semaphore");
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ resourceType: "provider", status: "active" })
    .map(value => value.id).sort(), blockers.sort());
  assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" }).length, 0);
});

test("pre-start recovery rejects an unexpected active semaphore owned by the admitted Attempt", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  const unexpected = f.store.acquireRuntimeSemaphoreSlot({ workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "provider", resourceKey: "unexpected-provider", limit: 4,
    ownerType: "work_unit_attempt", ownerId: f.attempt.id, ...toRuntimeAttemptFence(f.attempt),
    acquiredAt: f.now, expiresAt: new Date(Date.parse(f.now) + 60_000).toISOString() });
  assert.ok(unexpected);

  assert.throws(() => recoverPreparedRunConcurrency(f.recovery),
    (error) => error.code === "continuation_resource_recovery_changed");
  assert.deepEqual(f.store.listRuntimeSemaphoreSlots({ ownerId: f.attempt.id, status: "active" })
    .map(value => value.id), [unexpected.id]);
});

test("pre-start recovery rejects a matching semaphore key with a stale Attempt fence", async (t) => {
  const f = await createPreparedRecoveryFixture(t);
  const stale = f.store.acquireRuntimeSemaphoreSlot({ workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "provider", resourceKey: f.recovery.providerKey, limit: 4,
    ownerType: "work_unit_attempt", ownerId: f.attempt.id, ...toRuntimeAttemptFence(f.attempt),
    acquiredAt: f.now, expiresAt: new Date(Date.parse(f.now) + 60_000).toISOString() });
  assert.ok(stale);
  f.store.database.prepare("UPDATE runtime_semaphore_slots SET fencing_token=? WHERE id=?")
    .run("stale-recovery-fence", stale.id);

  assert.throws(() => recoverPreparedRunConcurrency(f.recovery),
    (error) => error.code === "continuation_resource_recovery_changed");
  assert.equal(f.store.database.prepare("SELECT fencing_token FROM runtime_semaphore_slots WHERE id=?")
    .get(stale.id).fencing_token, "stale-recovery-fence");
});

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
