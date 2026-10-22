import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { createBudgetHarness, budgetNow, budgetLater, budgetPrice } from "./support/delegation-budget-fixture.mjs";

const code = value => error => error?.code === value;
async function fixture(t, options) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-writer-"));
  const f = createBudgetHarness(cwd, options);
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  return f;
}
function counts(f) {
  return Object.fromEntries(["artifacts", "work_units", "run_sessions", "delegation_steps", "delegation_budget_reservations", "delegation_budget_charges"]
    .map(table => [table, f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}
function startChild(f, child) {
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: child.childWorkUnit.id, attemptNumber: 1,
    runtimeInstanceId: "runtime", runnerId: "pi", status: "created", now: budgetLater });
  f.start(child.childRun.id);
  f.db.prepare("UPDATE delegation_steps SET state='running',child_run_id=?,revision=revision+1,updated_at=? WHERE id=?")
    .run(child.childRun.id, budgetLater, child.stepId);
  const sourceFence = { workUnitId: attempt.workUnitId, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken };
  const capture = { ...f.capture, budget: undefined, runId: child.childRun.id, sourceFence };
  return { sourceFence, capture };
}
function endChild(f, child, sourceFence) {
  f.db.prepare("UPDATE run_sessions SET status='succeeded',ended_at=? WHERE id=?").run(budgetLater, child.childRun.id);
  f.db.prepare("UPDATE work_units SET status='succeeded',ended_at=? WHERE id=?").run(budgetLater, child.childWorkUnit.id);
  f.db.prepare("UPDATE work_unit_attempts SET status='succeeded',ended_at=? WHERE id=?").run(budgetLater, sourceFence.attemptId);
}

test("root budget is frozen before start, replays immutably and survives reopening", async t => {
  const f = await fixture(t);
  const root = f.freeze();
  assert.equal(f.store.getRun("root").status, "queued");
  assert.equal(root.tokenBudget, 100);
  f.start();
  assert.deepEqual(f.freeze({ now: budgetLater }), root);
  const reopened = createBudgetHarness(f.cwd);
  t.after(() => reopened.store.close());
  assert.deepEqual(reopened.writer.getRootDelegationBudget("root"), root);
  assert.throws(() => f.db.exec("UPDATE delegation_root_budgets SET token_budget=999"), /immutable/);
});

test("running-but-unfrozen root cannot be backfilled by first spawn or late freeze", async t => {
  const f = await fixture(t); f.start();
  const before = counts(f);
  assert.throws(() => f.freeze(), code("delegation.parent_not_running"));
  assert.throws(() => f.spawn(), code("delegation.root_budget_missing"));
  assert.deepEqual(counts(f), before);
});

test("different root authority cannot replace the frozen snapshot", async t => {
  const f = await fixture(t); const root = f.freeze();
  const capture = f.captureToken({ ...f.capture, budget: { tokenBudget: 200 } });
  assert.throws(() => f.freeze({ capture }), code("delegation.root_budget_conflict"));
  assert.deepEqual(f.writer.getRootDelegationBudget("root"), root);
});

test("root freeze rejects mismatched fence and ordinary JSON authority", async t => {
  const f = await fixture(t); const before = counts(f);
  assert.throws(() => f.freeze({ sourceFence: { ...f.fence, fencingToken: "stale" } }), code("delegation.authority_invalid"));
  assert.throws(() => f.freeze({ capture: f.capture }), code("delegation.authority_invalid"));
  assert.deepEqual(counts(f), before);
});

test("queued child and budget commit atomically without Attempt, Runner or running child binding", async t => {
  const f = await fixture(t); f.freeze(); f.start();
  const result = f.spawn();
  assert.equal(result.childRun.status, "queued");
  assert.equal(result.childRun.parentRunId, "root");
  assert.equal(result.childWorkUnit.activeAttemptId, undefined);
  assert.equal(result.childWorkUnit.attemptCount, 0);
  const step = f.store.getDelegationStep(result.stepId);
  assert.equal(step.state, "spawning");
  assert.equal(step.childRunId, undefined);
  assert.equal(result.reservation.childRunId, result.childRun.id);
  assert.equal(result.reservation.tokenReserved, 40);
  assert.equal(result.reservation.state, "reserved");
});

test("response-loss replay returns exact child even after parent termination and never re-reserves", async t => {
  const f = await fixture(t); f.freeze(); f.start();
  const original = f.spawn(), before = counts(f);
  f.db.exec("UPDATE run_sessions SET status='succeeded' WHERE id='root'");
  const replay = f.spawn({ now: "2026-10-19T00:05:00.000Z" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.childRun.id, original.childRun.id);
  assert.deepEqual(replay.reservation, original.reservation);
  assert.deepEqual(counts(f), before);
  assert.throws(() => f.spawn({ objective: "Different request" }), code("delegation.idempotency_conflict"));
});

for (const status of ["queued", "waiting_for_approval", "waiting_for_input", "cancelling"]) {
  test(`a matching fence in ${status} state cannot spawn`, async t => {
    const f = await fixture(t); f.freeze(); f.start();
    f.db.prepare("UPDATE work_units SET status=? WHERE id=?").run(status, f.unit.id);
    const before = counts(f);
    assert.throws(() => f.spawn(), code("delegation.parent_not_running"));
    assert.deepEqual(counts(f), before);
  });
}

test("stale active Attempt is rejected before artifacts or child creation", async t => {
  const f = await fixture(t); f.freeze(); f.start();
  f.db.prepare("UPDATE work_unit_attempts SET fencing_token='replacement' WHERE id=?").run(f.attempt.id);
  const before = counts(f);
  assert.throws(() => f.spawn(), code("delegation.source_attempt_stale"));
  assert.deepEqual(counts(f), before);
});

for (const change of [
  a => ({ ...a, tools: [...a.tools, "bash"], toolDecisions: { ...a.toolDecisions, bash: "allow" } }),
  a => ({ ...a, toolDecisions: { ...a.toolDecisions, write: "allow" } }),
  a => ({ ...a, sandbox: "full_access" }), a => ({ ...a, mayEscalate: true }),
  a => ({ ...a, networkScopes: [...a.networkScopes, "other.invalid"] }),
  a => ({ ...a, secretRefs: [...a.secretRefs, "env:FOREIGN_KEY"] }),
  a => ({ ...a, workspaceRoots: [{ path: tmpdir(), access: "write" }] }),
]) test("new child cannot widen any frozen authority dimension", async t => {
  const f = await fixture(t); f.freeze(); f.start();
  const authority = change(f.authority);
  f.setCurrentAuthority(authority); // Parent gains authority after freeze: old children still cannot.
  const before = counts(f);
  assert.throws(() => f.spawn({ capture: f.captureToken({ ...f.capture, authority }) }), code("delegation.capability_escalation"));
  assert.deepEqual(counts(f), before);
});

test("current revocation overrides a still-valid historical snapshot", async t => {
  const f = await fixture(t); f.freeze(); f.start();
  f.setCurrentAuthority({ ...f.authority, sourceRevision: "policy-2", toolDecisions: { read: "allow", write: "deny" } });
  const before = counts(f);
  assert.throws(() => f.spawn(), code("delegation.capability_escalation"));
  assert.deepEqual(counts(f), before);
});

test("deadline is absolute and requested shorter child deadline is persisted", async t => {
  const f = await fixture(t); const root = f.freeze(); f.start();
  const child = f.spawn({ requestedBudget: { tokenBudget: 20, wallTimeBudgetMs: 5000 } });
  assert.equal(child.reservation.deadlineAt, "2026-10-19T00:00:06.000Z");
  assert.throws(() => f.spawn({ spawnCallId: "expired", now: root.deadlineAt }), code("delegation.deadline_exceeded"));
});

test("nested allocations share the frozen maxDepth policy rather than the ancestry hard limit", async t => {
  const f = await fixture(t, { maxDepth: 1 }); f.freeze(); f.start();
  const child = f.spawn();
  const own = startChild(f, child), before = counts(f);
  assert.throws(() => f.spawn({ parentRunId: child.childRun.id, sourceFence: own.sourceFence,
    capture: f.captureToken(own.capture), spawnCallId: "grandchild", requestedBudget: { tokenBudget: 10 } }), code("delegation.depth_exceeded"));
  assert.deepEqual(counts(f), before);
});

test("later parent depth expansion cannot widen frozen authority and current depth revocation is honored", async t => {
  const f = await fixture(t, { maxDepth: 2 }); f.freeze(); f.start();
  f.setCurrentAuthority({ ...f.authority, maxDepth: 4 });
  assert.throws(() => f.spawn({ capture: f.captureToken({ ...f.capture, authority: { ...f.authority, maxDepth: 4 } }) }), code("delegation.capability_escalation"));
  f.setCurrentAuthority({ ...f.authority, maxDepth: 1 });
  assert.throws(() => f.spawn(), code("delegation.capability_escalation"));
  const child = f.spawn({ capture: f.captureToken({ ...f.capture, authority: { ...f.authority, maxDepth: 1 } }) });
  assert.equal(f.store.getDelegationStep(child.stepId).depth, 1);
});

test("nested reservations are not counted twice and measured adapter overruns propagate to root", async t => {
  const f = await fixture(t); f.freeze(); f.start();
  const child = f.spawn(), own = startChild(f, child);
  const capture = f.captureToken(own.capture);
  f.spawn({ parentRunId: child.childRun.id, sourceFence: own.sourceFence, capture,
    spawnCallId: "grandchild", requestedBudget: { tokenBudget: 20 } });
  const nestedCharge = f.charge({ runId: child.childRun.id, sourceFence: own.sourceFence, capture, reservedTokens: 10 });
  f.charge({ invocationId: "root-call", reservedTokens: 50 }); // 40+50, not 40+20+10+50.
  f.writer.settleModelInvocation({ chargeId: nestedCharge.id,
    receipt: f.receipt(nestedCharge, { inputTokens: 50, outputTokens: 5 }), now: budgetLater });
  assert.throws(() => f.charge({ invocationId: "after-overrun", reservedTokens: 1 }), code("delegation.budget_exhausted"));
});

for (const dimension of ["tokens", "cost"]) test(`a sibling adapter overrun blocks the intermediate ${dimension} allocation even while root has capacity`, async t => {
  const monetary = dimension === "cost";
  const f = await fixture(t, { price: budgetPrice, budget: { tokenBudget: 1000, ...(monetary ? { costBudgetMicros: 1000 } : {}) } });
  f.freeze(); f.start();
  const requested = amount => ({ tokenBudget: monetary ? (amount === 100 ? 500 : 100) : amount,
    ...(monetary ? { costBudgetMicros: amount } : {}) });
  const a = f.spawn({ spawnCallId: "A", requestedBudget: requested(100) }), aOwner = startChild(f, a);
  const aCapture = f.captureToken(aOwner.capture);
  const b = f.spawn({ parentRunId: a.childRun.id, sourceFence: aOwner.sourceFence, capture: aCapture,
    spawnCallId: "B", requestedBudget: requested(50) }), bOwner = startChild(f, b);
  const c = f.spawn({ parentRunId: a.childRun.id, sourceFence: aOwner.sourceFence, capture: aCapture,
    spawnCallId: "C", requestedBudget: requested(50) }), cOwner = startChild(f, c);
  const bCharge = f.charge({ runId: b.childRun.id, sourceFence: bOwner.sourceFence, capture: f.captureToken(bOwner.capture),
    reservedTokens: monetary ? 20 : 40, ...(monetary ? { reservedCostMicros: 40 } : {}) });
  f.writer.settleModelInvocation({ chargeId: bCharge.id,
    receipt: f.receipt(bCharge, { inputTokens: 80, outputTokens: 0 }), now: budgetLater });
  const before = counts(f);
  assert.throws(() => f.charge({ runId: c.childRun.id, sourceFence: cOwner.sourceFence, capture: f.captureToken(cOwner.capture),
    reservedTokens: 10, ...(monetary ? { reservedCostMicros: 10 } : {}) }), code("delegation.budget_exhausted"));
  assert.deepEqual(counts(f), before, "rejected descendant charge must not leave a reservation row");
  // The root is not exhausted (A's propagated use is 130 of 1000): this control
  // distinguishes an intermediate gate from accidentally tightening root use.
  assert.equal(f.charge({ invocationId: "root-still-has-room", reservedTokens: 10,
    ...(monetary ? { reservedCostMicros: 10 } : {}) }).state, "reserved");
});

test("missing, cyclic and foreign-workspace ancestry reject the whole child transaction", async t => {
  for (const damage of ["missing", "cycle", "foreign"]) {
    const f = await fixture(t); f.freeze(); f.start(); const child = f.spawn(), own = startChild(f, child);
    if (damage === "missing") f.db.prepare("UPDATE run_sessions SET parent_run_id='missing' WHERE id=?").run(child.childRun.id);
    if (damage === "cycle") f.db.prepare("UPDATE run_sessions SET parent_run_id=? WHERE id='root'").run(child.childRun.id);
    if (damage === "foreign") {
      f.db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('foreign','Foreign fixture',?,?)").run(budgetNow, budgetNow);
      f.db.prepare("UPDATE work_units SET workspace_id='foreign' WHERE id=?").run(child.childWorkUnit.id);
    }
    const before = counts(f);
    assert.throws(() => f.spawn({ parentRunId: child.childRun.id, sourceFence: own.sourceFence,
      capture: f.captureToken(own.capture), spawnCallId: "grandchild", requestedBudget: { tokenBudget: 10 } }),
    error => ["delegation.lineage_invalid", "delegation.cycle_detected"].includes(error?.code));
    assert.deepEqual(counts(f), before);
  }
});

test("unknown price permits token/time-only but refuses monetary reservation without orphan rows", async t => {
  const f = await fixture(t); f.freeze(); f.start();
  f.spawn();
  const before = counts(f);
  assert.throws(() => f.spawn({ spawnCallId: "money", requestedBudget: { tokenBudget: 10, costBudgetMicros: 50 } }), code("delegation.price_unknown"));
  assert.deepEqual(counts(f), before);
});

test("monetary root cannot freeze with unknown price", async t => {
  const f = await fixture(t, { budget: { costBudgetMicros: 50 } }); const before = counts(f);
  assert.throws(() => f.freeze(), code("delegation.price_unknown"));
  assert.deepEqual(counts(f), before);
});

test("root own Provider charges share child capacity and unknown usage cannot refund it", async t => {
  const f = await fixture(t); f.freeze(); f.start();
  const charge = f.charge({ reservedTokens: 70 });
  assert.throws(() => f.spawn(), code("delegation.budget_exhausted"));
  const unresolved = f.writer.settleModelInvocation({ chargeId: charge.id,
    receipt: f.receipt(charge, { kind: "unknown", inputTokens: undefined, cachedInputTokens: undefined, outputTokens: undefined }), now: budgetLater });
  assert.equal(unresolved.state, "unresolved");
  assert.throws(() => f.spawn(), code("delegation.budget_exhausted"));
  const settled = f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: budgetLater });
  assert.equal(settled.inputTokens + settled.outputTokens, 15);
  assert.equal(f.spawn().reservation.tokenReserved, 40);
});

test("model invocation reserve and settlement are exact-once, including price and duplicate receipt", async t => {
  const f = await fixture(t, { price: budgetPrice, budget: { costBudgetMicros: 200 } }); f.freeze(); f.start();
  const charge = f.charge({ reservedCostMicros: 50 });
  assert.deepEqual(f.charge({ reservedCostMicros: 50 }), charge);
  assert.throws(() => f.charge({ reservedTokens: 21, reservedCostMicros: 50 }), code("delegation.idempotency_conflict"));
  const receipt = f.receipt(charge);
  const measured = f.writer.settleModelInvocation({ chargeId: charge.id, receipt, now: budgetLater });
  assert.equal(measured.actualCostMicros, 20);
  assert.deepEqual(f.writer.settleModelInvocation({ chargeId: charge.id, receipt, now: budgetLater }), measured);
  assert.throws(() => f.writer.settleModelInvocation({ chargeId: charge.id,
    receipt: f.receipt(charge, { outputTokens: 6 }), now: budgetLater }), code("delegation.settlement_conflict"));
});

test("price revision drift is rejected rather than overwriting pinned historical price", async t => {
  const f = await fixture(t, { price: budgetPrice, budget: { costBudgetMicros: 200 } }); f.freeze(); f.start();
  const capture = f.captureToken({ ...f.capture, price: { ...budgetPrice, version: "fixture-2" } });
  assert.throws(() => f.charge({ capture, reservedCostMicros: 50 }), code("delegation.price_scope_conflict"));
});

test("unknown child outcome keeps full reservation, and no-dispatch release requires an actually unstarted child", async t => {
  const f = await fixture(t); f.freeze(); f.start(); const child = f.spawn({ requestedBudget: { tokenBudget: 80 } });
  const unresolved = f.writer.settleDelegatedChild({ reservationId: child.reservation.id,
    receipt: f.childReceipt({ kind: "unknown", childRunId: child.childRun.id }), now: budgetLater });
  assert.equal(unresolved.state, "unresolved");
  assert.throws(() => f.spawn({ spawnCallId: "second" }), code("delegation.budget_exhausted"));
  const released = f.writer.settleDelegatedChild({ reservationId: child.reservation.id,
    receipt: f.childReceipt({ kind: "no_dispatch", childRunId: child.childRun.id }), now: budgetLater });
  assert.equal(released.state, "released");
  assert.equal(f.spawn({ spawnCallId: "second" }).reservation.state, "reserved");
});

test("verified child settlement accounts actual receipts, requires current exact Attempt and is replay exact-once", async t => {
  const f = await fixture(t); f.freeze(); f.start(); const child = f.spawn(), own = startChild(f, child);
  const charge = f.charge({ runId: child.childRun.id, sourceFence: own.sourceFence, capture: f.captureToken(own.capture), reservedTokens: 20 });
  f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: budgetLater });
  endChild(f, child, own.sourceFence);
  const receipt = f.childReceipt({ kind: "verified_usage", childRunId: child.childRun.id, sourceFence: own.sourceFence });
  const settled = f.writer.settleDelegatedChild({ reservationId: child.reservation.id, receipt, now: budgetLater });
  assert.equal(settled.state, "settled"); assert.equal(settled.settledTokenUsage, 15);
  assert.equal(settled.settlementDigest.length, 64);
  assert.deepEqual(f.writer.settleDelegatedChild({ reservationId: child.reservation.id, receipt, now: budgetLater }), settled);
  assert.throws(() => f.writer.settleDelegatedChild({ reservationId: child.reservation.id,
    receipt: f.childReceipt({ kind: "verified_usage", childRunId: child.childRun.id, sourceFence: { ...own.sourceFence, fencingToken: "other" } }), now: budgetLater }), code("delegation.settlement_conflict"));
  assert.equal(f.spawn({ spawnCallId: "after-measured", requestedBudget: { tokenBudget: 80 } }).reservation.tokenReserved, 80);
});

test("terminal-looking Run with stale Attempt or unknown Provider outcome cannot release reserved capacity", async t => {
  for (const fault of ["stale", "unknown"]) {
    const f = await fixture(t); f.freeze(); f.start(); const child = f.spawn(), own = startChild(f, child);
    const charge = f.charge({ runId: child.childRun.id, sourceFence: own.sourceFence, capture: f.captureToken(own.capture) });
    if (fault === "stale") f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: budgetLater });
    endChild(f, child, own.sourceFence);
    if (fault === "stale") f.db.prepare("UPDATE work_unit_attempts SET fencing_token='new-fence' WHERE id=?").run(own.sourceFence.attemptId);
    const before = f.writer.getDelegationBudgetReservation(child.reservation.id);
    assert.throws(() => f.writer.settleDelegatedChild({ reservationId: child.reservation.id,
      receipt: f.childReceipt({ kind: "verified_usage", childRunId: child.childRun.id, sourceFence: own.sourceFence }), now: budgetLater }),
    code(fault === "stale" ? "delegation.source_attempt_stale" : "delegation.settlement_incomplete"));
    assert.deepEqual(f.writer.getDelegationBudgetReservation(child.reservation.id), before);
  }
});

for (const point of ["artifact", "unit", "run"]) test(`failure after ${point} insertion leaves no partial child facts`, async t => {
  const f = await fixture(t); f.freeze(); f.start(); const before = counts(f); f.setFaultPort(point);
  assert.throws(() => f.spawn(), /injected/);
  assert.deepEqual(counts(f), before);
  assert.equal(f.db.isTransaction, false);
});
for (const table of ["delegation_steps", "delegation_budget_reservations"]) test(`failure inserting ${table} rolls back all earlier artifacts and identities`, async t => {
  const f = await fixture(t); f.freeze(); f.start(); const before = counts(f);
  f.db.exec(`CREATE TRIGGER delegation_test_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected insert'); END`);
  assert.throws(() => f.spawn(), /injected/);
  assert.deepEqual(counts(f), before);
});

test("competing SQLite connections cannot both reserve a sibling's last capacity", async t => {
  const f = await fixture(t); f.freeze(); f.start();
  const gate = new SharedArrayBuffer(8), state = new Int32Array(gate);
  const workers = ["a", "b"].map(id => new Worker(new URL("./support/delegation-budget-worker.mjs", import.meta.url), { workerData: { cwd: f.cwd, id, gate } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const results = workers.map(worker => new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); worker.once("exit", status => { if (status !== 0) reject(new Error(`Worker exit ${status}`)); }); }));
  const limit = Date.now() + 20_000;
  while (Atomics.load(state, 0) !== 2) { if (Date.now() > limit) throw new Error("workers did not reach bounded barrier"); await new Promise(resolve => setTimeout(resolve, 10)); }
  Atomics.store(state, 1, 1); Atomics.notify(state, 1, 2);
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(item => item.ok).length, 1);
  assert.equal(outcomes.filter(item => item.code === "delegation.budget_exhausted").length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM delegation_budget_reservations").get().n, 1);
});
