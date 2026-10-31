import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toRuntimeAttemptFence } from "../dist/index.js";
import { SqliteDelegationCompletionEvidenceStore } from "../dist/storage/sqlite/delegation-completion-evidence.js";
import { SqliteDelegationLifecycleStore } from "../dist/storage/sqlite/delegation-lifecycle-store.js";
import { createBudgetHarness } from "./support/delegation-budget-fixture.mjs";

const now = () => new Date().toISOString();

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-completion-"));
  const createdAt = now(), f = createBudgetHarness(cwd, { now: createdAt, later: createdAt });
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.freeze(); f.start();
  const observations = new WeakMap(), preparations = new WeakMap();
  const lifecycle = new SqliteDelegationLifecycleStore({ database: f.db }, {
    getRun: id => f.store.getRun(id), getWorkUnit: id => f.store.getWorkUnit(id), getWorkUnitAttempt: id => f.store.getWorkUnitAttempt(id),
    getDelegationStep: id => f.store.getDelegationStep(id), getDelegationBudgetReservation: id => f.writer.getDelegationBudgetReservation(id),
    getArtifact: id => f.store.getArtifact(id), createArtifactWithinTransaction: input => f.ports.createArtifactWithinTransaction(input),
    createWorkUnitAttemptWithinTransaction: input => f.store.runtimeWorkUnits.createWorkUnitAttemptWithinTransaction(input),
    transitionRunStatus: input => f.store.transitionRunStatus(input), transitionWorkUnitStatus: input => f.store.transitionWorkUnitStatus(input),
    updateWorkUnitAttemptStatus: input => f.store.updateWorkUnitAttemptStatus(input), appendRuntimeEvent: input => f.store.appendRuntimeEvent(input),
    getHostAttemptCompletion: source => f.store.getHostAttemptCompletion(source), appendTerminalRuntimeAudit: input => f.store.appendTerminalRuntimeAudit(input),
    releaseResourceLeasesForAttempt: (...args) => f.store.releaseResourceLeasesForAttempt(...args),
    releaseRuntimeSemaphoreSlotsForAttempt: (...args) => f.store.releaseRuntimeSemaphoreSlotsForAttempt(...args),
    assertDispatchAuthorityWithinTransaction: input => f.writer.assertDelegatedChildDispatchAuthorityWithinTransaction(input),
    readRunnerStartObservation: token => { assert.ok(observations.has(token)); return observations.get(token); },
    readExecutionPreparation: token => { assert.ok(preparations.has(token)); return structuredClone(preparations.get(token)); },
  });
  let completionReads = 0;
  const readPorts = {
    getRun: id => f.store.getRun(id), getWorkUnit: id => f.store.getWorkUnit(id), getWorkUnitAttempt: id => f.store.getWorkUnitAttempt(id),
    getHostAttemptCompletion: source => { completionReads++; return f.store.getHostAttemptCompletion(source); },
    getArtifact: id => f.store.getArtifact(id),
  };
  const reader = new SqliteDelegationCompletionEvidenceStore({ database: f.db }, readPorts);
  const spawn = changes => f.spawn({ now: now(), ...changes });
  const start = child => {
    const claimed = lifecycle.claimDelegatedChild({ reservationId: child.reservation.id, expectedStepRevision: child.reservation.revision,
      runtimeInstanceId: "runtime", now: now() });
    const sourceFence = toRuntimeAttemptFence(claimed.attempt), token = {};
    const preparation = {}, requestSnapshot = { cwd, task: claimed.run.taskSnapshot, parentRunId: claimed.step.parentRunId,
      teammateId: claimed.run.teammateId, workflowStepId: claimed.run.workflowStepId, threadId: claimed.run.threadId,
      providerPresetId: claimed.run.providerPresetId, runnerId: "pi" };
    preparations.set(preparation, { schemaVersion: 1, kind: "delegation.execution.v1", stepId: claimed.step.id,
      reservationId: claimed.reservation.id, rootRunId: claimed.step.rootRunId, parentRunId: claimed.step.parentRunId,
      childRunId: claimed.run.id, sourceFence, runnerId: "pi", preparedAt: now(), requestSnapshot,
      runnerExecutionInput: { schemaVersion: 1, runnerId: "pi", input: { cwd, task: claimed.run.taskSnapshot,
        provider: { provider: claimed.run.providerName, model: claimed.run.providerModel } },
        preparedInput: { taskId: claimed.run.taskId, fingerprint: "a".repeat(64) } },
      effectivePolicySnapshot: { mode: "workspace_write", workspacePolicyUpdatedAt: createdAt, toolDecisions: {}, allowedWritePaths: [cwd], riskNotes: [] } });
    lifecycle.commitDelegatedChildPreparation({ reservationId: child.reservation.id, sourceFence, preparation, now: now() });
    observations.set(token, { childRunId: child.childRun.id, sourceFence, runnerId: "pi", observationId: `accepted:${child.stepId}`, observedAt: now() });
    const started = lifecycle.commitDelegatedChildStart({ reservationId: child.reservation.id, sourceFence, observation: token, now: now() });
    return { ...started, sourceFence, capture: { ...f.capture, runId: child.childRun.id, sourceFence, budget: undefined } };
  };
  const terminal = async (child, started, outcome = "succeeded") => {
    await f.store.trackHostAttemptCompletion({ runId: child.childRun.id, ...started.sourceFence }, Promise.resolve(), () => true);
    const endedAt = now();
    // These isolated fixture writes represent already-admitted Host terminal
    // facts; the result itself is produced by the real lifecycle transaction.
    f.db.prepare("UPDATE run_sessions SET status=?,ended_at=?,updated_at=? WHERE id=?").run(outcome, endedAt, endedAt, child.childRun.id);
    f.db.prepare("UPDATE work_units SET status=?,ended_at=?,updated_at=? WHERE id=?").run(outcome, endedAt, endedAt, child.childWorkUnit.id);
    f.db.prepare("UPDATE work_unit_attempts SET status=?,ended_at=? WHERE id=?").run(outcome, endedAt, started.sourceFence.attemptId);
    f.writer.settleDelegatedChild({ reservationId: child.reservation.id,
      receipt: f.childReceipt({ kind: "verified_usage", childRunId: child.childRun.id, sourceFence: started.sourceFence }), now: now() });
    return lifecycle.commitDelegatedChildTerminal({ reservationId: child.reservation.id, sourceFence: started.sourceFence, now: now() });
  };
  return { ...f, reader, readPorts, lifecycle, spawn, start, terminal, completionReads: () => completionReads,
    read: (rootRunIds = ["root"]) => reader.getDelegationCompletionEvidence({ rootRunIds }) };
}

test("an existing root with no dynamic work has a stable empty required read set", async t => {
  const f = await fixture(t), first = f.read();
  assert.equal(first.status, "satisfied"); assert.equal(first.steps.length, 0);
  assert.equal(first.issues.length, 0); assert.deepEqual(f.read(["root", "root"]), first);
  assert.equal(Object.hasOwn(first, "observedAt"), false);
});

test("queued required children are pending without claiming a Runner or manufacturing a result", async t => {
  const f = await fixture(t), child = f.spawn(), read = f.read();
  assert.equal(read.status, "pending"); assert.deepEqual(read.issues, []);
  assert.equal(read.steps[0].step.id, child.stepId);
  assert.equal(read.steps[0].childRun.id, child.childRun.id);
  assert.equal(read.steps[0].step.childRunId, undefined);
  assert.equal(read.steps[0].attempt, undefined); assert.equal(read.steps[0].results.length, 0);
  assert.equal(f.store.listWorkUnitAttempts(child.childWorkUnit.id).length, 0);
});

test("real accepted start, Host drain, settlement and sealed result satisfy required completion", async t => {
  const f = await fixture(t), child = f.spawn(), started = f.start(child);
  await f.terminal(child, started);
  const read = f.read(), node = read.steps[0];
  assert.deepEqual(read.issues, []); assert.equal(read.status, "satisfied");
  assert.equal(node.quiescence, "verified"); assert.equal(node.hostCompletion.effectCoverage, "pi_no_tools_v1");
  assert.equal(node.reservation.state, "settled"); assert.equal(node.results.length, 1);
  assert.equal(node.results[0].payload.childRunId, child.childRun.id);
  assert.equal(node.results[0].payload.sourceFence.attemptId, started.sourceFence.attemptId);
  assert.equal(node.results[0].payload.evidenceRefs.length, 2); assert.ok(f.completionReads() > 0);
  assert.deepEqual(f.read(), read, "time passing alone must not invalidate every completion CAS");
});

test("raw succeeded state without original Host completion cannot certify a required child", async t => {
  const f = await fixture(t), child = f.spawn(), started = f.start(child), endedAt = now();
  f.db.prepare("UPDATE run_sessions SET status='succeeded',ended_at=? WHERE id=?").run(endedAt, child.childRun.id);
  f.db.prepare("UPDATE work_units SET status='succeeded',ended_at=? WHERE id=?").run(endedAt, child.childWorkUnit.id);
  f.db.prepare("UPDATE work_unit_attempts SET status='succeeded',ended_at=? WHERE id=?").run(endedAt, started.sourceFence.attemptId);
  f.db.prepare("UPDATE delegation_steps SET state='succeeded',revision=revision+1,completed_at=?,updated_at=? WHERE id=?")
    .run(endedAt, endedAt, child.stepId);
  const read = f.read(); assert.equal(read.status, "blocked");
  assert.ok(read.issues.some(issue => issue.code === "delegation.completion_effects_unverified"));
  assert.ok(read.issues.some(issue => issue.code === "delegation.completion_budget_unsettled"));
});

test("required grandchildren under an optional parent remain in the canonical pending basis", async t => {
  const f = await fixture(t), parent = f.spawn({ required: false }), parentOwner = f.start(parent);
  assert.equal(f.read().status, "pending", "optional work must physically finish before the parent can finish");
  const before = f.read();
  const child = f.spawn({ parentRunId: parent.childRun.id, sourceFence: parentOwner.sourceFence,
    capture: f.captureToken(parentOwner.capture), spawnCallId: "required-grandchild", requestedBudget: { tokenBudget: 10 } });
  const after = f.read(); assert.equal(after.status, "pending"); assert.equal(after.steps.length, 2);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(after.steps.find(node => node.step.id === child.stepId).step.parentDelegationStepId, parent.stepId);
});

test("queued optional work is outstanding even before step.childRunId and Attempt exist", async t => {
  const f = await fixture(t), child = f.spawn({ required: false }), read = f.read();
  assert.equal(read.status, "pending"); assert.deepEqual(read.issues, []);
  assert.equal(read.steps[0].step.childRunId, undefined);
  assert.equal(read.steps[0].reservation.childRunId, child.childRun.id);
  assert.equal(f.store.listWorkUnitAttempts(child.childWorkUnit.id).length, 0);
  assert.equal(read.steps[0].reservation.state, "reserved");
});

for (const outcome of ["succeeded", "failed", "cancelled"]) test(`verified optional ${outcome} permits parent success only after sealed result`, async t => {
  const f = await fixture(t), child = f.spawn({ required: false }), started = f.start(child);
  assert.equal(f.read().status, "pending");
  await f.terminal(child, started, outcome);
  const read = f.read();
  assert.equal(read.status, "satisfied"); assert.deepEqual(read.issues, []);
  assert.equal(read.steps[0].hostCompletion.effectCoverage, "pi_no_tools_v1");
  assert.equal(read.steps[0].reservation.state, "settled");
  assert.equal(read.steps[0].results[0].payload.outcome, outcome);
  const endedAt = now();
  assert.equal(f.store.transitionRunExecutionStatus({ runId: "root", sourceFence: f.fence,
    expectedStatus: "running", event: "runner_succeeded", actor: "runner", now: endedAt, endedAt }).ok, true,
  "a physically settled optional failure/cancellation is not a required business failure");
  assert.equal(f.store.getRun("root").status, "succeeded");
});

test("optional lost is blocked, not a stopped receipt or successful fan-in", async t => {
  const f = await fixture(t), child = f.spawn({ required: false }); f.start(child);
  const endedAt = now();
  f.db.prepare("UPDATE delegation_steps SET state='lost',revision=revision+1,completed_at=?,updated_at=? WHERE id=?")
    .run(endedAt, endedAt, child.stepId);
  assert.equal(f.read().status, "blocked");
  assert.equal(f.read().steps[0].reservation.state, "reserved");
});

for (const outcome of ["succeeded", "failed", "cancelled"]) test(`required grandchild ${outcome} retains required semantics below a verified optional cancellation`, async t => {
  const f = await fixture(t), parent = f.spawn({ required: false }), parentOwner = f.start(parent);
  const child = f.spawn({ parentRunId: parent.childRun.id, sourceFence: parentOwner.sourceFence,
    capture: f.captureToken(parentOwner.capture), spawnCallId: "required-grandchild", requestedBudget: { tokenBudget: 10 } });
  const childOwner = f.start(child);
  await f.terminal(child, childOwner, outcome);
  await f.terminal(parent, parentOwner, "cancelled");
  const read = f.read();
  assert.deepEqual(read.issues, []);
  assert.equal(read.status, outcome === "succeeded" ? "satisfied" : outcome);
});

test("a child completion check does not depend on its own incoming required step", async t => {
  const f = await fixture(t), child = f.spawn(), started = f.start(child);
  const ownDescendants = f.read([child.childRun.id]);
  assert.equal(ownDescendants.status, "satisfied"); assert.deepEqual(ownDescendants.issues, []);
  assert.equal(ownDescendants.steps.length, 0, "incoming edge must not create a terminalization deadlock");
  const grandchild = f.spawn({ parentRunId: child.childRun.id, sourceFence: started.sourceFence,
    capture: f.captureToken(started.capture), spawnCallId: "nested", requestedBudget: { tokenBudget: 10 } });
  const nested = f.read([child.childRun.id]);
  assert.equal(nested.status, "pending"); assert.deepEqual(nested.issues, []);
  assert.equal(nested.steps.length, 1); assert.equal(nested.steps[0].step.id, grandchild.stepId);
  assert.equal(nested.steps[0].parentDelegationStep.id, child.stepId);
  assert.equal(nested.steps[0].parentReservation.id, child.reservation.id);
});

test("a nested completion scope does not import sibling allocations as orphan facts", async t => {
  const f = await fixture(t), a = f.spawn({ spawnCallId: "a" }), owner = f.start(a);
  f.spawn({ spawnCallId: "sibling" });
  const nested = f.spawn({ parentRunId: a.childRun.id, sourceFence: owner.sourceFence, capture: f.captureToken(owner.capture),
    spawnCallId: "a-child", requestedBudget: { tokenBudget: 10 } });
  const read = f.read([a.childRun.id]);
  assert.deepEqual(read.issues, []); assert.equal(read.steps.length, 1);
  assert.equal(read.steps[0].step.id, nested.stepId); assert.equal(read.status, "pending");
});

test("later required child insertion changes the canonical completion fingerprint", async t => {
  const f = await fixture(t), first = f.spawn(), started = f.start(first);
  await f.terminal(first, started); const completed = f.read();
  f.spawn({ spawnCallId: "after-first" }); const next = f.read();
  assert.equal(completed.status, "satisfied"); assert.equal(next.status, "pending");
  assert.notEqual(completed.fingerprint, next.fingerprint);
});

for (const field of ["parent_run_id", "workflow_step_id", "channel_id"]) test(`a child's foreign ${field} cannot escape required descendant discovery`, async t => {
  const f = await fixture(t), child = f.spawn();
  f.db.prepare(`UPDATE run_sessions SET ${field}='foreign-scope' WHERE id=?`).run(child.childRun.id);
  const read = f.read(); assert.equal(read.status, "blocked"); assert.equal(read.steps.length, 1);
  assert.ok(read.issues.some(issue => issue.code === "delegation.completion_lineage_invalid"));
});

test("foreign workspace is a lineage failure even when root/channel ids look equal", async t => {
  const f = await fixture(t), child = f.spawn(), at = now();
  f.db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('foreign','Foreign',?,?)").run(at, at);
  f.db.prepare("UPDATE work_units SET workspace_id='foreign' WHERE id=?").run(child.childWorkUnit.id);
  assert.equal(f.read().status, "blocked");
});

test("new current Attempt invalidates a previously completed result's complete source fence", async t => {
  const f = await fixture(t), child = f.spawn(), started = f.start(child);
  await f.terminal(child, started); const before = f.read();
  const next = f.store.createWorkUnitAttempt({ workUnitId: child.childWorkUnit.id, attemptNumber: 2,
    runtimeInstanceId: "runtime-after-restart", runnerId: "pi", status: "started", now: now() });
  const after = f.read(); assert.equal(after.status, "blocked"); assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(after.steps[0].attempt.sourceFence.attemptId, next.id);
});

test("a recomputed Host coverage veto overrides a persisted pi_no_tools marker", async t => {
  const f = await fixture(t), child = f.spawn(), started = f.start(child);
  await f.terminal(child, started);
  const reader = new SqliteDelegationCompletionEvidenceStore({ database: f.db }, { ...f.readPorts,
    getHostAttemptCompletion: source => { const completion = f.store.getHostAttemptCompletion(source);
      const { effectCoverage, ...unverified } = completion; return unverified; } });
  const read = reader.getDelegationCompletionEvidence({ rootRunIds: ["root"] });
  assert.equal(read.status, "blocked"); assert.ok(read.issues.some(issue => issue.code === "delegation.completion_effects_unverified"));
});

test("sealed result content corruption invalidates the atomic read set", async t => {
  const f = await fixture(t), child = f.spawn(), started = f.start(child);
  await f.terminal(child, started); const before = f.read(), result = before.steps[0].results[0];
  const payload = f.store.getArtifact(result.artifactId).sealedPayload;
  f.db.prepare("UPDATE artifacts SET sealed_payload_json=? WHERE id=?")
    .run(JSON.stringify({ ...payload, childRunId: "not-the-child" }), result.artifactId);
  const after = f.read(); assert.equal(after.status, "blocked"); assert.notEqual(after.fingerprint, before.fingerprint);
  assert.ok(after.issues.some(issue => issue.code === "delegation.completion_result_invalid"));
});

test("all invocation charges including measured history appear in the sealed result evidence", async t => {
  const f = await fixture(t), child = f.spawn(), started = f.start(child);
  const charge = f.charge({ runId: child.childRun.id, sourceFence: started.sourceFence,
    capture: f.captureToken(started.capture), reservedTokens: 20, now: now() });
  const measured = f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: now() });
  await f.terminal(child, started); const read = f.read();
  assert.deepEqual(read.issues, []); assert.equal(read.status, "satisfied");
  assert.equal(read.steps[0].charges[0].id, measured.id); assert.equal(read.steps[0].reservation.settledTokenUsage, 15);
  assert.equal(read.steps[0].results[0].payload.evidenceRefs.some(ref => ref.kind === "delegation_budget_charge" && ref.id === measured.id), true);
});

for (const outcome of ["failed", "cancelled"]) test(`a real ${outcome} result cannot become required success`, async t => {
  const f = await fixture(t), child = f.spawn(), started = f.start(child);
  await f.terminal(child, started, outcome); const read = f.read();
  assert.deepEqual(read.issues, []); assert.equal(read.status, outcome);
  assert.equal(read.steps[0].results[0].payload.outcome, outcome);
});

test("the reader participates in a writer transaction without committing or losing caller writes", async t => {
  const f = await fixture(t); f.spawn();
  const original = f.store.getRun("root").updatedAt;
  f.db.exec("BEGIN IMMEDIATE");
  f.db.prepare("UPDATE run_sessions SET updated_at='2026-10-19T00:00:00.000Z' WHERE id='root'").run();
  assert.equal(f.read().status, "pending");
  assert.equal(f.db.prepare("SELECT updated_at FROM run_sessions WHERE id='root'").get().updated_at, "2026-10-19T00:00:00.000Z");
  f.db.exec("ROLLBACK");
  assert.equal(f.store.getRun("root").updatedAt, original);
});

test("an attempted port write is rejected read-only and does not roll back the outer writer", async t => {
  const f = await fixture(t), child = f.spawn(); f.start(child);
  const reader = new SqliteDelegationCompletionEvidenceStore({ database: f.db }, { ...f.readPorts,
    getHostAttemptCompletion: () => { f.db.prepare("UPDATE run_sessions SET status='failed' WHERE id='root'").run(); } });
  f.db.exec("BEGIN IMMEDIATE");
  f.db.prepare("UPDATE run_sessions SET updated_at='2026-10-19T00:00:00.000Z' WHERE id='root'").run();
  assert.throws(() => reader.getDelegationCompletionEvidence({ rootRunIds: ["root"] }), /readonly|read-only/iu);
  assert.equal(f.db.prepare("SELECT updated_at,status FROM run_sessions WHERE id='root'").get().updated_at, "2026-10-19T00:00:00.000Z");
  assert.equal(f.store.getRun("root").status, "running"); f.db.exec("ROLLBACK");
});
