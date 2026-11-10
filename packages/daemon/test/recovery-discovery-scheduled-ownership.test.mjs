import assert from "node:assert/strict";
import test from "node:test";
import { DaemonRunnerRecoveryCoordinator } from "../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import { createRecoveryDiscoveryFixture, DISCOVERY_CREATED_AT, waitForRecovery } from "./test-support/recovery-discovery-fixture.mjs";

const invalidOwnershipCases = [
  ["channel child", "channel_discussion", {}],
  ["non-owned external action", "conversation", { workUnitKind: "external_work_action" }],
  ["unknown kind", "conversation", { workUnitKind: "unknown_future_work" }],
  ["private thread teammate mismatch", "teammate_direct", { threadTeammateId: "teammate_builtin_designer" }],
  ["private WorkUnit teammate mismatch", "teammate_direct", { workUnitTeammateId: "teammate_builtin_designer" }],
  ["conversation thread kind mismatch", "task", { workUnitKind: "conversation_run" }],
  ["missing task", "task", { taskMissing: true }],
  ["inactive task", "task", {}],
];

for (const [reason, surface, ownership] of invalidOwnershipCases) {
  test(`scheduled ${reason} cannot be dispatched by general daemon recovery`, async (t) => {
    const fixture = await createRecoveryDiscoveryFixture(t, reason.replaceAll(" ", "-"));
    const seeded = await fixture.seedRun(surface, "invalid-owner", DISCOVERY_CREATED_AT, ownership);
    const continuation = fixture.schedule(seeded);
    if (reason === "inactive task") {
      assert.equal(fixture.store.transitionTaskStatus({ taskId: seeded.task.id, expectedStatus: "claimed", event: "cancel",
        actor: "local-user", reason: "Fixture task no longer owns work", now: DISCOVERY_CREATED_AT }).ok, true);
      assert.equal(fixture.store.getRun(seeded.run.id).status, "running",
        "a cancelled Run would mask the missing task ownership check");
    }
    assert.equal(fixture.store.getWorkUnit(seeded.unit.id).status, "queued");
    assert.equal(fixture.store.getWorkUnitAttempt(continuation.targetAttemptId).status, "created");
    assert.equal(fixture.store.listClaimableRunnerContinuations({ now: new Date().toISOString(), scheduledOnly: true,
      limit: 500 })[0].id, continuation.id);
    const calls = [];
    const coordinator = new DaemonRunnerRecoveryCoordinator({ runtimeSupervisor: fixture.supervisor,
      activeRuns: fixture.activeRuns, executeExistingRunContinuation: (input) => {
        calls.push(input);
        return new Promise(() => {});
      } });
    t.after(() => coordinator.beginShutdown());
    const result = coordinator.recoverStore(fixture.store);
    assert.equal(calls.length, 0, JSON.stringify({ reason, actualRunIds: calls.map((input) => input.runId), result }));
    assert.deepEqual(result, { scanned: 1, dispatched: 0, skipped: 1 });
    assert.equal(fixture.store.getRunnerContinuation(continuation.id).state, "prepared");
    assert.equal(fixture.store.getWorkUnitAttempt(continuation.targetAttemptId).status, "created");
  });
}

for (const surface of ["task", "conversation", "teammate_direct"]) {
  test(`scheduled owned ${surface} still completes with its exact durable Attempt`, async (t) => {
    const fixture = await createRecoveryDiscoveryFixture(t, `owned-${surface}`);
    const seeded = await fixture.seedRun(surface, "valid-owner");
    const continuation = fixture.schedule(seeded);
    const executor = fixture.executor();
    const calls = [];
    const coordinator = new DaemonRunnerRecoveryCoordinator({ runtimeSupervisor: fixture.supervisor,
      activeRuns: fixture.activeRuns, executeExistingRunContinuation: (input) => { calls.push(input); return executor.execute(input); } });
    t.after(() => coordinator.beginShutdown());
    assert.deepEqual(coordinator.recoverStore(fixture.store), { scanned: 1, dispatched: 1, skipped: 0 });
    assert.equal(calls[0].runId, seeded.run.id);
    assert.equal(calls[0].origin, "daemon_recovery");
    assert.equal(calls[0].idempotencyDiscriminator, continuation.id);
    assert.equal(calls[0].preparedExecution.attempt.id, continuation.targetAttemptId);
    await Promise.all(executor.completions);
    await waitForRecovery(() => fixture.store.getRun(seeded.run.id).status === "succeeded", JSON.stringify(executor.errors));
    assert.deepEqual(executor.errors, []);
    assert.equal(fixture.store.getRunnerContinuation(continuation.id).state, "succeeded");
    assert.deepEqual(executor.runnerCalls.map((call) => call.attemptId), [continuation.targetAttemptId]);
    assert.equal(executor.runnerCalls[0].inputFingerprint, seeded.execution.preparedInput.fingerprint);
    assert.deepEqual(fixture.store.listWorkUnitAttempts(seeded.unit.id).map((attempt) => attempt.status), ["lost", "succeeded"]);
    assert.equal(coordinator.recoverStore(fixture.store).dispatched, 0);
  });
}
