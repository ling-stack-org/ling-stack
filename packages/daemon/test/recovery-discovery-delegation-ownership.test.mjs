import assert from "node:assert/strict";
import test from "node:test";
import { DaemonRunnerRecoveryCoordinator } from "../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import { createRecoveryDiscoveryFixture } from "./test-support/recovery-discovery-fixture.mjs";

for (const scheduled of [false, true]) {
  test(`${scheduled ? "scheduled" : "stale"} delegation owner is never dispatched by general daemon recovery`, async (t) => {
    const fixture = await createRecoveryDiscoveryFixture(t, `delegation-owner-${scheduled}`);
    const seeded = await fixture.seedRun("task", "delegated-child");
    const continuation = scheduled ? fixture.schedule(seeded) : undefined;
    // This is an ownership-admission fixture, not a fabricated delegation
    // ledger or a model/SDK run. Child lifecycle creation has separate tests.
    fixture.store.database.prepare("UPDATE work_units SET owner_type='delegation_step',owner_id=? WHERE id=?")
      .run("step-owned-by-private-delegation-registry", seeded.unit.id);
    const beforeUnit = fixture.store.getWorkUnit(seeded.unit.id);
    const beforeAttempts = fixture.store.listWorkUnitAttempts(seeded.unit.id);
    const beforeContinuation = continuation ? fixture.store.getRunnerContinuation(continuation.id) : undefined;
    const calls = [];
    const coordinator = new DaemonRunnerRecoveryCoordinator({
      runtimeSupervisor: fixture.supervisor,
      activeRuns: fixture.activeRuns,
      executeExistingRunContinuation: async (input) => { calls.push(input); return undefined; },
    });
    t.after(() => coordinator.beginShutdown());
    const result = coordinator.recoverStore(fixture.store);
    await coordinator.waitForIdle();
    assert.equal(calls.length, 0, "generic callback must not receive a delegation-owned child");
    assert.deepEqual(result, { scanned: 1, dispatched: 0, skipped: 1 });
    assert.deepEqual(fixture.store.getWorkUnit(seeded.unit.id), beforeUnit);
    assert.deepEqual(fixture.store.listWorkUnitAttempts(seeded.unit.id), beforeAttempts);
    if (continuation) assert.deepEqual(fixture.store.getRunnerContinuation(continuation.id), beforeContinuation);
    assert.equal(coordinator.recoverStore(fixture.store).dispatched, 0);
  });
}

test("a direct ordinary continuation cannot bypass delegation recovery ownership", async (t) => {
  const fixture = await createRecoveryDiscoveryFixture(t, "delegation-direct-entry");
  const seeded = await fixture.seedRun("task", "delegated-direct");
  fixture.store.database.prepare("UPDATE work_units SET owner_type='delegation_step',owner_id=? WHERE id=?")
    .run("step-owned-by-private-delegation-registry", seeded.unit.id);
  const beforeUnit = fixture.store.getWorkUnit(seeded.unit.id);
  const beforeAttempts = fixture.store.listWorkUnitAttempts(seeded.unit.id);
  const executor = fixture.executor();
  await executor.execute({ cwd: fixture.cwd, runId: seeded.run.id, origin: "daemon_recovery",
    idempotencyDiscriminator: "direct-bypass-probe" });
  assert.equal(executor.runnerCalls.length, 0, "ordinary continuation must refuse before SDK/Runner entry");
  assert.equal(executor.errors.length, 1);
  assert.equal(executor.errors[0].error, "delegation.authority_invalid");
  assert.deepEqual(fixture.store.getWorkUnit(seeded.unit.id), beforeUnit);
  assert.deepEqual(fixture.store.listWorkUnitAttempts(seeded.unit.id), beforeAttempts);
});
