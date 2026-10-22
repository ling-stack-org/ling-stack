import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { toRuntimeAttemptFence } from "../dist/index.js";
import { createBudgetHarness, budgetLater } from "./support/delegation-budget-fixture.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-root-seal-"));
  const f = createBudgetHarness(cwd);
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.freeze(); f.start();
  const child = f.spawn({ required: false });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: child.childWorkUnit.id, attemptNumber: 1,
    runtimeInstanceId: "optional-runtime", runnerId: "pi", status: "created", now: budgetLater });
  f.start(child.childRun.id);
  // Isolated admitted-lifecycle fixture. All tested spawns use the real writer.
  f.db.prepare("UPDATE delegation_steps SET state='running',child_run_id=?,revision=revision+1,updated_at=? WHERE id=?")
    .run(child.childRun.id, budgetLater, child.stepId);
  const sourceFence = toRuntimeAttemptFence(attempt);
  const childCapture = { ...f.capture, budget: undefined, runId: child.childRun.id, sourceFence };
  const spawn = (changes = {}) => f.spawn({ parentRunId: child.childRun.id, sourceFence,
    capture: f.captureToken(childCapture), spawnCallId: "grandchild", requestedBudget: { tokenBudget: 10 }, ...changes });
  return { ...f, child, sourceFence, childCapture, spawn };
}

function rowCounts(f) {
  return Object.fromEntries(["artifacts", "work_units", "run_sessions", "delegation_steps", "delegation_budget_reservations"]
    .map(table => [table, f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}

const closed = error => error?.code === "delegation.parent_not_running";
const rootSuccess = f => f.store.transitionRunExecutionStatus({ runId: "root", sourceFence: f.fence,
  expectedStatus: "running", event: "runner_succeeded", actor: "runner", now: budgetLater, endedAt: budgetLater });

test("root success permanently closes new nested spawns without stopping existing optional work", async t => {
  const f = await fixture(t);
  assert.equal(rootSuccess(f).ok, true);
  const basis = f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] });
  assert.equal(basis.status, "satisfied");
  const before = rowCounts(f);
  assert.throws(() => f.spawn(), closed);
  assert.throws(() => f.spawn({ required: false }), closed);
  assert.deepEqual(rowCounts(f), before, "no artifact, reservation, work unit or child may leak");
  assert.deepEqual(f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] }), basis);
  assert.equal(f.store.getRun(f.child.childRun.id).status, "running");
  assert.equal(f.store.getDelegationStep(f.child.stepId).state, "running");
});

for (const status of ["succeeded", "failed", "cancelled", "yielded"]) {
  test(`a ${status} root closes nested admission even if its optional child still owns a running fence`, async t => {
    const f = await fixture(t);
    if (status === "failed") f.store.markRunFailed("root", budgetLater, "fixture root failure");
    else if (status === "cancelled") f.store.markRunCancelled("root", budgetLater);
    else if (status === "succeeded") f.store.markRunSucceeded("root", budgetLater);
    else f.db.prepare("UPDATE run_sessions SET status='yielded' WHERE id='root'").run();
    const before = rowCounts(f);
    assert.throws(() => f.spawn(), closed);
    assert.deepEqual(rowCounts(f), before);
  });
}

for (const damage of ["run_ended", "unit_cancelling", "unit_terminal", "attempt_aborting", "attempt_yielded"]) {
  test(`root admission fails closed on ${damage} during incomplete lifecycle publication`, async t => {
    const f = await fixture(t);
    if (damage === "run_ended") f.db.prepare("UPDATE run_sessions SET ended_at=? WHERE id='root'").run(budgetLater);
    if (damage === "unit_cancelling") f.db.prepare("UPDATE work_units SET status='cancelling' WHERE id='root-unit'").run();
    if (damage === "unit_terminal") f.db.prepare("UPDATE work_units SET status='succeeded',ended_at=? WHERE id='root-unit'").run(budgetLater);
    if (damage === "attempt_aborting") f.db.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id='root-attempt'").run(budgetLater);
    if (damage === "attempt_yielded") f.db.prepare("UPDATE work_unit_attempts SET status='yielded' WHERE id='root-attempt'").run();
    const before = rowCounts(f);
    assert.throws(() => f.spawn(), closed);
    assert.deepEqual(rowCounts(f), before);
  });
}

test("required nested admission before root completion blocks success instead of being omitted", async t => {
  const f = await fixture(t), child = f.spawn();
  assert.equal(child.replayed, false);
  assert.throws(() => rootSuccess(f), error => error?.code === "delegation.required_children_unsettled");
  assert.equal(f.store.getRun("root").status, "running");
  assert.equal(f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] }).status, "pending");
});

test("root approval wait retains nested admission before terminalization", async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE run_sessions SET status='waiting_for_approval' WHERE id='root'").run();
  f.db.prepare("UPDATE work_units SET status='waiting_for_approval' WHERE id='root-unit'").run();
  f.db.prepare("UPDATE work_unit_attempts SET status='waiting_for_approval' WHERE id='root-attempt'").run();
  assert.equal(f.spawn().replayed, false);
});

test("response-loss replay after root success returns the original optional allocation without admitting work", async t => {
  const f = await fixture(t);
  const original = f.spawn({ required: false });
  assert.equal(rootSuccess(f).ok, true);
  const before = rowCounts(f), replay = f.spawn({ required: false });
  assert.equal(replay.replayed, true);
  assert.equal(replay.childRun.id, original.childRun.id);
  assert.deepEqual(replay.reservation, original.reservation);
  assert.deepEqual(rowCounts(f), before);
  assert.throws(() => f.spawn({ spawnCallId: "different-spawn", required: false }), closed);
});

const workerSource = `
const { workerData, parentPort } = require("node:worker_threads");
(async () => {
  const { createBudgetHarness, budgetLater } = await import(workerData.fixtureUrl);
  const f = createBudgetHarness(workerData.cwd), gate = new Int32Array(workerData.gate);
  try {
    Atomics.add(gate, 0, 1); Atomics.notify(gate, 0);
    if (Atomics.wait(gate, 1, 0, 20_000) === "timed-out") throw new Error("root admission race barrier expired");
    if (workerData.role === "finish") {
      f.store.markRunSucceeded("root", budgetLater);
      parentPort.postMessage({ ok: true, role: "finish" });
    } else {
      const capture = f.captureToken({ ...f.capture, budget: undefined, runId: workerData.childRunId, sourceFence: workerData.sourceFence });
      const child = f.spawn({ parentRunId: workerData.childRunId, sourceFence: workerData.sourceFence, capture,
        spawnCallId: "racing-grandchild", requestedBudget: { tokenBudget: 10 } });
      parentPort.postMessage({ ok: true, role: "spawn", replayed: child.replayed, childRunId: child.childRun.id });
    }
  } catch (error) { parentPort.postMessage({ ok: false, role: workerData.role, code: error?.code, message: error?.message }); }
  finally { f.store.close(); }
})().catch(error => { throw error; });
`;

test("concurrent root completion and nested writers cannot commit both success and new required work", { timeout: 30_000 }, async t => {
  const f = await fixture(t), gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const participants = 8, signal = new Int32Array(gate), workers = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const results = Array.from({ length: participants }, (_, index) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { cwd: f.cwd, gate,
      role: index === 0 ? "finish" : "spawn", fixtureUrl: new URL("./support/delegation-budget-fixture.mjs", import.meta.url).href,
      childRunId: f.child.childRun.id, sourceFence: f.sourceFence } });
    workers.push(worker);
    return new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
  });
  const readyDeadline = Date.now() + 20_000;
  while (Atomics.load(signal, 0) !== participants) {
    if (Date.now() >= readyDeadline) throw new Error("root admission race workers did not become ready");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  Atomics.store(signal, 1, 1); Atomics.notify(signal, 1, participants);
  const outcomes = await Promise.all(results);
  const requiredRows = f.db.prepare("SELECT COUNT(*) AS n FROM delegation_steps WHERE parent_run_id=? AND required=1").get(f.child.childRun.id).n;
  const status = f.store.getRun("root").status;
  assert.ok(requiredRows === 0 || requiredRows === 1, "response-loss replays cannot multiply required children");
  assert.ok(status !== "succeeded" || requiredRows === 0, JSON.stringify(outcomes));
  assert.ok(status === "succeeded" || requiredRows === 1, "at least one serialized operation must make progress");
  assert.equal(outcomes.some(result => result.ok), true, JSON.stringify(outcomes));
  for (const outcome of outcomes.filter(result => !result.ok)) {
    assert.ok(["delegation.parent_not_running", "delegation.required_children_unsettled", "ERR_SQLITE_ERROR"].includes(outcome.code), JSON.stringify(outcome));
    if (outcome.code === "ERR_SQLITE_ERROR") assert.match(outcome.message, /locked|busy/iu);
  }
});
