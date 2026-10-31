import assert from "node:assert/strict";
import test from "node:test";
import { DelegationCompletionBarrierError } from "@ling-stack/core";
import { resumedDelegationFixture, capabilityNow } from "../../core/test/support/resumed-delegation-fixture.mjs";
import { waitForRequiredDelegationCompletion } from "../dist/features/harness/delegations/completion-wait.js";
import { transitionWorkUnitCancelled } from "../dist/runtime/work-units.js";

function waitForRoot(f, changes = {}) {
  return waitForRequiredDelegationCompletion({ store: f.store, runId: "root", sourceFence: f.capture.sourceFence,
    signal: new AbortController().signal, ...changes });
}

async function terminal(f, outcome = "succeeded") {
  await f.store.trackHostAttemptCompletion(f.source, Promise.resolve(), () => true);
  const at = capabilityNow();
  assert.equal(f.store.transitionRunExecutionStatus({ runId: f.run.id, sourceFence: f.fence, expectedStatus: "running",
    event: outcome === "succeeded" ? "runner_succeeded" : outcome === "failed" ? "runner_failed" : "cancel",
    actor: "runner", now: at, endedAt: at }).ok, true);
  if (outcome === "cancelled") {
    transitionWorkUnitCancelled(f.store, f.unit.id, f.attempt.id, "fixture-cancel", at);
    assert.equal(f.store.getWorkUnit(f.unit.id).status, "cancelled");
  } else {
    assert.equal(f.store.transitionWorkUnitAttemptTerminal({ ...f.fence,
      event: outcome === "succeeded" ? "runner_succeeded" : "runner_failed",
      attemptStatus: outcome, runtimeEventType: `work_unit_${outcome}`, actor: "runner", now: at }), true);
  }
  f.writer.settleDelegatedChild({ reservationId: f.child.reservation.id,
    receipt: f.childReceipt({ kind: "verified_usage", childRunId: f.run.id, sourceFence: f.fence }), now: at });
  f.lifecycle.commitDelegatedChildTerminal({ reservationId: f.child.reservation.id, sourceFence: f.fence, now: at });
}

test("fan-in observes sealed results before success, without dispatching or creating an Attempt", async t => {
  const f = await resumedDelegationFixture(t);
  let observed;
  const pending = new Promise(resolve => { observed = resolve; });
  const changes = [];
  const abort = new AbortController();
  const waiting = waitForRoot(f, { signal: abort.signal, onChanged(evidence) { changes.push(evidence.status); observed(); } });
  // Own the wait even if an assertion fails, before the temporary Store closes.
  void waiting.catch(() => {});
  try {
    await pending;
    assert.deepEqual(changes, ["pending"]);
    assert.equal(f.store.getRun("root").status, "running");
    const attempts = f.store.listWorkUnitAttempts(f.unit.id).length;
    await terminal(f);
    await waiting;
    assert.deepEqual(changes, ["pending", "satisfied"]);
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, attempts);
    assert.equal(f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] }).steps[0].results.length, 1);
  } finally { abort.abort(); await waiting.catch(() => {}); }
});

test("fan-in abort stops only the observer and retains unsettled child budget and owner", async t => {
  const f = await resumedDelegationFixture(t), abort = new AbortController();
  const waiting = waitForRoot(f, { signal: abort.signal, onChanged: () => abort.abort(new Error("stop-wait")) });
  await assert.rejects(waiting, error => error.cause?.message === "stop-wait" || error.message === "stop-wait");
  assert.equal(f.store.getRun("root").status, "running");
  assert.equal(f.store.getRun(f.run.id).status, "running");
  assert.equal(f.writer.getDelegationBudgetReservation(f.child.reservation.id).state, "reserved");
});

for (const outcome of ["failed", "cancelled"]) test(`fan-in exposes real required child ${outcome} without inventing parent success`, async t => {
  const f = await resumedDelegationFixture(t);
  await terminal(f, outcome);
  await assert.rejects(waitForRoot(f), error => error instanceof DelegationCompletionBarrierError && error.status === outcome);
  assert.equal(f.store.getRun("root").status, "running");
});

test("fan-in blocks raw succeeded children without original drain, settlement and result", async t => {
  const f = await resumedDelegationFixture(t), at = capabilityNow();
  // Isolated corruption injection: the observer must not trust the status string.
  f.db.prepare("UPDATE delegation_steps SET state='succeeded',revision=revision+1,completed_at=?,updated_at=? WHERE id=?")
    .run(at, at, f.child.stepId);
  await assert.rejects(waitForRoot(f), error => error instanceof DelegationCompletionBarrierError && error.status === "blocked");
  assert.equal(f.store.getRun("root").status, "running");
});

test("fan-in cannot read completion on behalf of a stale parent fence", async t => {
  const f = await resumedDelegationFixture(t);
  await assert.rejects(waitForRoot(f, { sourceFence: { ...f.capture.sourceFence, fencingToken: "foreign" } }),
    { code: "delegation.source_attempt_stale" });
});

test("a root without dynamic children finishes without a pending poll or new model call", async t => {
  const f = await resumedDelegationFixture(t, { delegated: false });
  // This fixture intentionally resumes the root itself, so use its current owner.
  const states = [];
  await waitForRoot(f, { sourceFence: f.fence, onChanged: evidence => states.push(evidence.status) });
  assert.deepEqual(states, ["satisfied"]);
});
