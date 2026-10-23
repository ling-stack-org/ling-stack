import assert from "node:assert/strict";
import test from "node:test";
import { createSuspensionStartupFixture } from "./support/run-suspension-startup-fixture.mjs";

for (const state of ["requested", "sealed"]) {
  test(`Core restart preserves an exact ${state} root without stopped proof, loss, release or replay`, async t => {
    const f = await createSuspensionStartupFixture(t, state), before = f.snapshot();
    assert.equal(f.store.recoverStaleRuns("2026-10-23T00:00:00.000Z"), 0);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.store.hasPendingRunSuspension(f.source), true);
    for (const key of ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
      assert.equal(f.store.hasPendingRunSuspension({ ...f.source, [key]: "foreign" }), false);
    }
    assert.equal(f.store.getHostAttemptCompletion(f.source), undefined);
    assert.equal(f.store.listWorkUnitAttempts(f.source.workUnitId).length, 1);
  });
}

test("a source without a suspension request keeps ordinary stale-run failure semantics", async t => {
  const f = await createSuspensionStartupFixture(t, "absent");
  assert.equal(f.store.recoverStaleRuns("2026-10-23T00:00:00.000Z"), 1);
  assert.equal(f.store.getRun(f.source.runId).status, "failed");
  assert.equal(f.store.listEvents(f.source.runId).filter(event => event.type === "run_error").length, 1);
});
