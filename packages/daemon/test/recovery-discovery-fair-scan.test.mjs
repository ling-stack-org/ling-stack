import assert from "node:assert/strict";
import test from "node:test";
import { DaemonRunnerRecoveryCoordinator } from "../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import { createRecoveryDiscoveryFixture, DISCOVERY_CREATED_AT, DISCOVERY_DUE_AT,
  seedScheduledBlockedPrefix, waitForRecovery } from "./test-support/recovery-discovery-fixture.mjs";

function recordingCoordinator(t, fixture, execute) {
  const calls = [];
  const coordinator = new DaemonRunnerRecoveryCoordinator({ runtimeSupervisor: fixture.supervisor,
    activeRuns: fixture.activeRuns, executeExistingRunContinuation: (input) => {
      calls.push(input);
      return execute ? execute(input) : new Promise(() => {});
    } });
  t.after(() => coordinator.beginShutdown());
  return { coordinator, calls };
}

for (const [surface, kind] of [["task", "task_run"], ["conversation", "conversation_run"],
  ["teammate_direct", "teammate_direct_reply"]]) {
  test(`${kind}: valid persisted Run behind 500 cancelled rows is discovered in two bounded scans`, async (t) => {
    const fixture = await createRecoveryDiscoveryFixture(t, kind);
    const valid = await fixture.seedRun(surface, "a-valid");
    fixture.seedBlockedStalePrefix(valid);
    assert.equal(fixture.store.listWorkUnits({ kind, status: "stale", limit: 500 }).length, 500);
    const executor = fixture.executor();
    const { coordinator, calls } = recordingCoordinator(t, fixture, executor.execute);
    assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 500, dispatched: 0, skipped: 500 });
    const tail = coordinator.recoverStore(fixture.store);
    assert.deepEqual(tail, { scanned: 1, dispatched: 1, skipped: 0 });
    assert.deepEqual(calls.map(({ runId, origin, idempotencyDiscriminator }) => ({ runId, origin, idempotencyDiscriminator })),
      [{ runId: valid.run.id, origin: "daemon_recovery", idempotencyDiscriminator: "runtime-startup" }]);
    await waitForRecovery(() => fixture.store.getRun(valid.run.id).status === "succeeded", JSON.stringify(executor.errors));
    assert.deepEqual(executor.errors, []);
    assert.deepEqual(fixture.store.listWorkUnitAttempts(valid.unit.id).map((attempt) => attempt.status), ["lost", "succeeded"]);
    assert.deepEqual(executor.runnerCalls.map((call) => call.runId), [valid.run.id]);
    assert.notEqual(executor.runnerCalls[0].attemptId, valid.attempt.id);
    assert.equal(executor.runnerCalls[0].inputFingerprint, valid.execution.preparedInput.fingerprint);
    assert.equal(fixture.store.getLingTurnForRun(valid.run.id).status, "succeeded");
    // Discovery reset after a restart cannot bypass durable terminal/Attempt state.
    const restarted = recordingCoordinator(t, fixture, executor.execute);
    restarted.coordinator.recoverStore(fixture.store);
    restarted.coordinator.recoverStore(fixture.store);
    assert.equal(restarted.calls.length, 0);
  });
}

test("scheduled: a prepared continuation behind 500 cancelled Runs is discovered in two bounded scans", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "scheduled");
  await seedScheduledBlockedPrefix(fixture);
  const valid = await fixture.seedRun("conversation", "scheduled-valid");
  const continuation = fixture.schedule(valid, DISCOVERY_DUE_AT, "z-valid");
  assert.equal(fixture.store.listClaimableRunnerContinuations({ now: new Date().toISOString(), scheduledOnly: true,
    limit: 500 }).length, 500);
  const { coordinator, calls } = recordingCoordinator(t, fixture);
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 500, dispatched: 0, skipped: 500 });
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 1, skipped: 0 });
  assert.equal(calls[0].preparedExecution.continuation.id, continuation.id);
  assert.equal(calls[0].preparedExecution.attempt.id, continuation.targetAttemptId);
  assert.deepEqual({ runId: calls[0].runId, origin: calls[0].origin, idempotencyDiscriminator: calls[0].idempotencyDiscriminator },
    { runId: valid.run.id, origin: "daemon_recovery", idempotencyDiscriminator: continuation.id });
  assert.equal(fixture.store.getRunnerContinuation(continuation.id).state, "prepared",
    "the executor, not discovery, owns the eventual claim CAS");
});

test("an approval skipped in a full stale page is reconsidered after tail/wrap, not treated as authority", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "approval-wrap");
  const valid = await fixture.seedRun("conversation", "zz-approval");
  fixture.seedBlockedStalePrefix(valid);
  const approval = fixture.blockWithApproval(valid.run);
  const { coordinator, calls } = recordingCoordinator(t, fixture);
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 500, dispatched: 0, skipped: 500 });
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 0, skipped: 1 });
  assert.equal(calls.length, 0);
  assert.equal(fixture.store.cancelApprovalRequest(approval.id, {}, DISCOVERY_CREATED_AT).status, "cancelled");
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 500, dispatched: 1, skipped: 499 });
  assert.deepEqual(calls.map((input) => input.runId), [valid.run.id]);
  coordinator.recoverStore(fixture.store);
  coordinator.recoverStore(fixture.store);
  assert.equal(calls.length, 1, "in-flight dedup remains effective after discovery wraps");
});

test("a scheduled Attempt behind 500 cancelled Runs completes and durable state survives store reopen", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "scheduled-executor");
  await seedScheduledBlockedPrefix(fixture);
  const valid = await fixture.seedRun("conversation", "scheduled-real");
  const continuation = fixture.schedule(valid);
  const executor = fixture.executor();
  const { coordinator, calls } = recordingCoordinator(t, fixture, executor.execute);
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 500, dispatched: 0, skipped: 500 });
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 1, skipped: 0 });
  assert.equal(calls[0].preparedExecution.attempt.id, continuation.targetAttemptId);
  await waitForRecovery(() => fixture.store.getRun(valid.run.id).status === "succeeded", JSON.stringify(executor.errors));
  assert.deepEqual(executor.errors, []);
  assert.equal(fixture.store.getRunnerContinuation(continuation.id).state, "succeeded");
  assert.equal(executor.runnerCalls[0].attemptId, continuation.targetAttemptId);
  assert.equal(executor.runnerCalls[0].inputFingerprint, valid.execution.preparedInput.fingerprint);
  await Promise.all(executor.completions);
  coordinator.beginShutdown();
  const reopened = fixture.reopenAfterRestart();
  assert.notEqual(reopened.store, fixture.store);
  const restarted = recordingCoordinator(t, reopened);
  assert.deepEqual(restarted.coordinator.recoverStore(reopened.store), { scanned: 500, dispatched: 0, skipped: 500 });
  assert.deepEqual(restarted.coordinator.recoverStore(reopened.store), { scanned: 0, dispatched: 0, skipped: 0 });
  assert.equal(restarted.calls.length, 0);
});

test("ActiveRun, missing prepared evidence, ownership mismatch and channel children still deny takeover", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "fences");
  const active = await fixture.seedRun("conversation", "active");
  const missing = await fixture.seedRun("conversation", "missing-input");
  const privateRun = await fixture.seedRun("teammate_direct", "wrong-owner");
  await fixture.seedRun("channel_discussion", "channel-child");
  fixture.activeRuns.add(active.run.id, { abortController: new AbortController(), streamEnvelope() {} });
  t.after(() => fixture.activeRuns.delete(active.run.id));
  const getRun = fixture.store.getRun.bind(fixture.store);
  fixture.store.getRun = (id) => {
    const run = getRun(id);
    if (id !== missing.run.id) return run;
    return { ...run, requestSnapshot: { ...run.requestSnapshot, runnerExecutionInput: undefined } };
  };
  const getThread = fixture.store.getLingThread.bind(fixture.store);
  fixture.store.getLingThread = (id) => {
    const thread = getThread(id);
    return id === privateRun.thread.id ? { ...thread, teammateId: "teammate_builtin_designer" } : thread;
  };
  const { coordinator, calls } = recordingCoordinator(t, fixture);
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 3, dispatched: 0, skipped: 3 });
  assert.equal(calls.length, 0);
  assert.equal(fixture.store.getWorkUnit(privateRun.unit.id).activeAttemptId, privateRun.attempt.id);
});

test("synchronous dispatch failure releases in-flight ownership and query re-entry guard", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "dispatch-throw");
  const valid = await fixture.seedRun("task", "dispatch-error");
  let first = true;
  const { coordinator, calls } = recordingCoordinator(t, fixture, () => {
    if (first) { first = false; throw new Error("fixture-dispatch-error"); }
    return new Promise(() => {});
  });
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 0, skipped: 1 });
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 1, skipped: 0 });
  assert.deepEqual(calls.map((input) => input.runId), [valid.run.id, valid.run.id]);
});

test("scheduled due time moved before the cursor is reconsidered after an empty tail wraps", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "due-wrap");
  await seedScheduledBlockedPrefix(fixture);
  const valid = await fixture.seedRun("conversation", "rescheduled");
  const continuation = fixture.schedule(valid, "2026-10-01T02:00:00.000Z", "z-rescheduled");
  const { coordinator, calls } = recordingCoordinator(t, fixture);
  assert.equal(coordinator.recoverStore(fixture.store).scanned, 500);
  assert.equal(fixture.store.deferRunnerContinuation({ continuationId: continuation.id, expectedRevision: continuation.revision,
    now: DISCOVERY_CREATED_AT, nextAttemptAt: "2026-10-01T00:30:00.000Z" }).ok, true);
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 0, dispatched: 0, skipped: 0 });
  assert.equal(calls.length, 0);
  const wrapped = coordinator.recoverStore(fixture.store);
  assert.deepEqual(wrapped, { scanned: 500, dispatched: 1, skipped: 499 });
  assert.equal(calls[0].runId, valid.run.id);
  assert.equal(calls[0].preparedExecution.continuation.nextAttemptAt, "2026-10-01T00:30:00.000Z");
});

test("creation and due cutoffs stay frozen until wrap; execution leases use current time", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "frozen-sweep");
  const sweepTime = Date.parse("2026-10-02T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: sweepTime });
  await seedScheduledBlockedPrefix(fixture);
  const later = await fixture.seedRun("conversation", "due-later");
  fixture.schedule(later, new Date(sweepTime + 1_000).toISOString(), "zz-due-later");
  const requests = [];
  const original = fixture.store.listClaimableRunnerContinuations.bind(fixture.store);
  fixture.store.listClaimableRunnerContinuations = (input) => { requests.push(input); return original(input); };
  const { coordinator, calls } = recordingCoordinator(t, fixture);
  assert.equal(coordinator.recoverStore(fixture.store).scanned, 500);
  t.mock.timers.tick(2_000);
  const inserted = await fixture.seedRun("conversation", "inserted-later", new Date().toISOString());
  fixture.schedule(inserted, new Date().toISOString(), "zzzz-inserted");
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 0, dispatched: 0, skipped: 0 });
  assert.equal(requests[0].now, requests[1].now);
  assert.equal(requests[1].createdAtOrBefore, requests[0].now);
  assert.equal(coordinator.recoverStore(fixture.store).scanned, 500);
  t.mock.timers.tick(2_000);
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 2, dispatched: 2, skipped: 0 });
  assert.equal(requests[2].now, new Date(sweepTime + 2_000).toISOString());
  assert.equal(requests[3].now, requests[2].now);
  assert.deepEqual(calls.map((input) => input.runId), [later.run.id, inserted.run.id]);
  const workUnit = fixture.store.getWorkUnit(later.unit.id);
  const ttl = workUnit.timeoutPolicy.hardTimeoutMs + workUnit.timeoutPolicy.cancelGraceMs + 60_000;
  assert.equal(calls[0].preparedExecution.claimExpiresAt, new Date(sweepTime + 4_000 + ttl).toISOString());
});

test("failed stale tail query keeps its exact cursor/cutoff and the scan re-entry lock releases", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "failed-tail");
  const valid = await fixture.seedRun("conversation", "a-valid");
  fixture.seedBlockedStalePrefix(valid);
  const requests = [];
  let throwOnce = true;
  const original = fixture.store.listWorkUnits.bind(fixture.store);
  fixture.store.listWorkUnits = (input) => {
    if (input.kind === "conversation_run" && input.status === "stale") {
      requests.push(input);
      if (input.after && throwOnce) { throwOnce = false; throw new Error("fixture-discovery-query-failed"); }
    }
    return original(input);
  };
  const { coordinator, calls } = recordingCoordinator(t, fixture);
  coordinator.recoverStore(fixture.store);
  assert.throws(() => coordinator.recoverStore(fixture.store), /fixture-discovery-query-failed/);
  assert.equal(calls.length, 0);
  assert.equal(coordinator.recoverStore(fixture.store).dispatched, 1);
  assert.deepEqual(requests[1], requests[2]);
  assert.equal(calls[0].runId, valid.run.id);
});

test("a failed first scheduled query commits no cutoff or cursor", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "failed-first");
  const valid = await fixture.seedRun("conversation", "first-query");
  fixture.schedule(valid);
  const sweepTime = Date.parse("2026-10-02T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: sweepTime });
  const original = fixture.store.listClaimableRunnerContinuations.bind(fixture.store);
  const requests = [];
  fixture.store.listClaimableRunnerContinuations = (input) => {
    requests.push(input);
    if (requests.length === 1) throw new Error("fixture-first-query-failed");
    return original(input);
  };
  const { coordinator, calls } = recordingCoordinator(t, fixture);
  assert.throws(() => coordinator.recoverStore(fixture.store), /fixture-first-query-failed/);
  t.mock.timers.tick(1_000);
  assert.equal(coordinator.recoverStore(fixture.store).dispatched, 1);
  assert.equal(requests[1].after, undefined);
  assert.equal(requests[1].now, new Date(sweepTime + 1_000).toISOString());
  assert.equal(calls[0].runId, valid.run.id);
});

test("different stores and stale kinds do not share sweep positions", async (t) => {
  const first = await createRecoveryDiscoveryFixture(t, "store-first");
  // One daemon Supervisor owns both stores; independent owners must not steal a live lease.
  const second = await createRecoveryDiscoveryFixture(t, "store-second", { runtimeSupervisor: first.supervisor });
  assert.equal(second.supervisor, first.supervisor);
  const valid = await first.seedRun("conversation", "a-valid");
  first.seedBlockedStalePrefix(valid);
  const firstTask = await first.seedRun("task", "first-task");
  const firstPrivate = await first.seedRun("teammate_direct", "first-private");
  const secondValid = await second.seedRun("conversation", "same-kind-other-store");
  const { coordinator, calls } = recordingCoordinator(t, first);
  assert.deepEqual(coordinator.recoverStore(first.store), { scanned: 502, dispatched: 2, skipped: 500 });
  assert.deepEqual(coordinator.recoverStore(second.store), { scanned: 1, dispatched: 1, skipped: 0 });
  assert.deepEqual(coordinator.recoverStore(first.store), { scanned: 3, dispatched: 1, skipped: 2 });
  assert.deepEqual(calls.map((input) => input.runId), [firstTask.run.id, firstPrivate.run.id, secondValid.run.id, valid.run.id]);
});

for (const shutdown of ["coordinator", "active-runs"]) {
  test(`${shutdown} shutdown from a synchronous dispatch prevents every later row and lane`, async (t) => {
    const fixture = await createRecoveryDiscoveryFixture(t, shutdown);
    const first = await fixture.seedRun("task", "z-first");
    await fixture.seedRun("task", "a-second");
    await fixture.seedRun("conversation", "next-lane");
    let coordinator;
    const recorded = recordingCoordinator(t, fixture, async () => {
      if (shutdown === "coordinator") coordinator.beginShutdown();
      else fixture.activeRuns.suspendAll("daemon_restart");
    });
    coordinator = recorded.coordinator;
    assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 1, skipped: 0 });
    assert.deepEqual(recorded.calls.map((input) => input.runId), [first.run.id]);
    assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 0, dispatched: 0, skipped: 0 });
  });
}

test("synchronous executor re-entry is bounded and duplicate in-flight scans remain deduplicated", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "reentry");
  const first = await fixture.seedRun("task", "z-first");
  const second = await fixture.seedRun("task", "a-second");
  let coordinator;
  const nested = [];
  const recorded = recordingCoordinator(t, fixture, () => {
    nested.push(coordinator.recoverStore(fixture.store));
    return new Promise(() => {});
  });
  coordinator = recorded.coordinator;
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 2, dispatched: 2, skipped: 0 });
  assert.deepEqual(nested, [{ scanned: 0, dispatched: 0, skipped: 0 }, { scanned: 0, dispatched: 0, skipped: 0 }]);
  assert.deepEqual(recorded.calls.map((input) => input.runId), [first.run.id, second.run.id]);
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 2, dispatched: 0, skipped: 2 });
});

test("start does not install a scan interval after a synchronous executor begins shutdown", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "start-shutdown");
  await fixture.seedRun("task", "start-shutdown");
  const intervals = t.mock.method(globalThis, "setInterval", () => ({ unref() {} }));
  let coordinator;
  const recorded = recordingCoordinator(t, fixture, async () => { coordinator.beginShutdown(); });
  coordinator = recorded.coordinator;
  coordinator.registerStore(fixture.store);
  coordinator.start();
  assert.equal(recorded.calls.length, 1);
  assert.equal(intervals.mock.callCount(), 0);
});

test("stale sweep excludes a new later-created Run until wrap and freezes its cutoff per lane", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "stale-insert");
  const sweepTime = Date.parse("2026-10-02T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: sweepTime });
  const valid = await fixture.seedRun("conversation", "a-tail");
  fixture.seedBlockedStalePrefix(valid);
  const requests = [];
  const original = fixture.store.listWorkUnits.bind(fixture.store);
  fixture.store.listWorkUnits = (input) => {
    if (input.kind === "conversation_run") requests.push(input);
    return original(input);
  };
  const { coordinator, calls } = recordingCoordinator(t, fixture);
  assert.equal(coordinator.recoverStore(fixture.store).scanned, 500);
  t.mock.timers.tick(1_000);
  const inserted = await fixture.seedRun("conversation", "zz-new-run", new Date().toISOString());
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 1, skipped: 0 });
  assert.deepEqual(calls.map((input) => input.runId), [valid.run.id]);
  assert.equal(requests[1].createdAtOrBefore, requests[0].createdAtOrBefore);
  assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 500, dispatched: 1, skipped: 499 });
  assert.equal(requests[2].createdAtOrBefore, new Date(sweepTime + 1_000).toISOString());
  assert.deepEqual(calls.map((input) => input.runId), [valid.run.id, inserted.run.id]);
});
