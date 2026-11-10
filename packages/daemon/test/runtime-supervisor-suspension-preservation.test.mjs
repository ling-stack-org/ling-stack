import assert from "node:assert/strict";
import test from "node:test";
import { createSuspensionStartupFixture } from "../../core/test/support/run-suspension-startup-fixture.mjs";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

for (const state of ["requested", "sealed"]) {
  test(`Supervisor restart does not convert a ${state} root into generic startup loss`, async t => {
    // Release the retained owner before the fixture closes/removes its storage.
    let next;
    t.after(() => next?.releaseAll());
    const f = await createSuspensionStartupFixture(t, state);
    next = new RuntimeSupervisor({ host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024,
      defaultWorkspaceCwd: f.cwd, runners: {}, runtimeTools: {},
      transports: { providerWebSocketFallback: true, localWebSocketRpc: true }, channels: {} });
    const before = f.snapshot();
    next.getRuntime(f.cwd, f.store); next.getRuntime(f.cwd, f.store);
    assert.equal(f.store.recoverStaleRuns(new Date().toISOString()), 0);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.store.getWorkUnit(f.source.workUnitId).status, "running");
    assert.equal(f.store.getWorkUnitAttempt(f.source.attemptId).status, "started");
    assert.equal(f.store.getHostAttemptCompletion(f.source), undefined);
  });
}
