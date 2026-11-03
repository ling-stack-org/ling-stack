import assert from "node:assert/strict";
import test from "node:test";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { cancelChannelWorkflow } from "../dist/features/channels/orchestrator.js";
import { configureWorkflowIsolationLifecycle, runWorkflowIsolationOperation, waitForWorkflowIsolationIdle,
  workflowIsolationIsDraining } from "../dist/features/channels/workflow-isolation-lifecycle.js";
import { recoverWorkflowIsolationsAtStartup } from "../dist/features/channels/workflow-isolation-recovery.js";
import { collectWorkflowIsolationRisks } from "../dist/features/channels/terminal-report-isolation-evidence.js";
import { nativeGit, now, workflowIntegrationCoordinatorFixture }
  from "./support/workflow-integration-coordinator-fixture.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("isolation settlement notifies once after the original callback leaves the drain set", async () => {
  const store = {}, gate = deferred(), events = [];
  let committed = false;
  configureWorkflowIsolationLifecycle(store, {
    trackCompletion: () => {}, isShuttingDown: () => false,
    onSettled: event => events.push({ ...event, committed, draining: workflowIsolationIsDraining(store, "wf") }),
  });
  const first = runWorkflowIsolationOperation(store, "wf", "merge-approval:round", async () => {
    await gate.promise;
    committed = true;
    return "approval persisted";
  });
  assert.equal(runWorkflowIsolationOperation(store, "wf", "merge-approval:round", async () => assert.fail("duplicate")), first);
  await Promise.resolve();
  assert.deepEqual(events, [], "an admitted operation is not a settled state");
  gate.resolve();
  assert.equal(await first, "approval persisted");
  assert.deepEqual(events, [{ workflowId: "wf", operationKey: "merge-approval:round", committed: true, draining: false }]);
});

test("nested isolation settlement retains the enclosing Host drain", async () => {
  const store = {}, events = [];
  configureWorkflowIsolationLifecycle(store, {
    trackCompletion: () => {}, isShuttingDown: () => false,
    onSettled: event => events.push({ ...event, draining: workflowIsolationIsDraining(store, "wf") }),
  });
  await runWorkflowIsolationOperation(store, "wf", "integration:round", async () => {
    await runWorkflowIsolationOperation(store, "wf", "merge-apply:round", async () => "applied");
  });
  assert.deepEqual(events, [
    { workflowId: "wf", operationKey: "merge-apply:round", draining: true },
    { workflowId: "wf", operationKey: "integration:round", draining: false },
  ]);
});

test("rejected isolation callbacks notify without replacing their original failure", async () => {
  const store = {}, events = [], failure = new Error("unknown physical outcome");
  configureWorkflowIsolationLifecycle(store, {
    trackCompletion: () => {}, isShuttingDown: () => false,
    onSettled: event => events.push({ ...event, draining: workflowIsolationIsDraining(store, "wf") }),
  });
  await assert.rejects(runWorkflowIsolationOperation(store, "wf", "capture:branch", async () => { throw failure; }),
    error => error === failure);
  assert.deepEqual(events, [{ workflowId: "wf", operationKey: "capture:branch", draining: false }]);
});

test("a failed isolation notification does not replace the operation result or leak its drain", async t => {
  const store = {};
  const warn = t.mock.method(console, "warn", () => {});
  configureWorkflowIsolationLifecycle(store, {
    trackCompletion: () => {}, isShuttingDown: () => false,
    onSettled: () => { throw new Error("notification unavailable"); },
  });
  assert.equal(await runWorkflowIsolationOperation(store, "wf", "integration:round", async () => "retained"), "retained");
  await waitForWorkflowIsolationIdle(store, "wf");
  assert.equal(workflowIsolationIsDraining(store, "wf"), false);
  assert.equal(warn.mock.callCount(), 1);
});

test("isolation single-flight retains its actual callback in the existing shutdown drain", async () => {
  const store = {}, activeRuns = new ActiveRunRegistry(), gate = deferred();
  configureWorkflowIsolationLifecycle(store, {
    trackCompletion: completion => activeRuns.trackCompletion(completion),
    isShuttingDown: () => activeRuns.isShuttingDown(),
  });
  let starts = 0, idle = false, workflowIdle = false;
  const first = runWorkflowIsolationOperation(store, "wf", "round:1", async () => { starts++; await gate.promise; return "settled"; });
  const duplicate = runWorkflowIsolationOperation(store, "wf", "round:1", async () => assert.fail("duplicate physical operation"));
  assert.equal(duplicate, first);
  assert.equal(workflowIsolationIsDraining(store, "wf"), true);
  const drain = activeRuns.waitForIdle().then(() => { idle = true; });
  const workflowDrain = waitForWorkflowIsolationIdle(store, "wf").then(() => { workflowIdle = true; });
  await Promise.resolve();
  assert.equal(starts, 1);
  assert.equal(idle, false);
  assert.equal(workflowIdle, false);
  activeRuns.stopAdmission();
  await assert.rejects(runWorkflowIsolationOperation(store, "wf", "new", async () => assert.fail("shutdown admission")),
    /runtime_shutting_down/);
  assert.equal(runWorkflowIsolationOperation(store, "wf", "round:1", async () => assert.fail("restart during drain")), first);
  gate.resolve();
  assert.equal(await first, "settled");
  await Promise.all([drain, workflowDrain]);
  assert.equal(workflowIsolationIsDraining(store, "wf"), false);
});

test("a rejected operation drains without becoming reusable execution authority", async () => {
  const store = {}, gate = deferred(), failure = new Error("unknown after effect"), events = [];
  const operation = runWorkflowIsolationOperation(store, "wf", "one", async () => { await gate.promise; throw failure; });
  const observed = assert.rejects(operation, error => error === failure);
  const drain = waitForWorkflowIsolationIdle(store, "wf").then(() => events.push("drained"));
  await Promise.resolve();
  assert.deepEqual(events, []);
  gate.resolve();
  await Promise.all([observed, drain]);
  assert.deepEqual(events, ["drained"]);
});

for (const stage of ["captured", "succeeded"]) {
  test(`startup recovers ${stage} branch semantics through candidate validation without another Run`, nativeGit, async t => {
    const f = await workflowIntegrationCoordinatorFixture(t, { stage });
    f.reopenIsolation();
    const execution = f.executionSnapshot(), target = await f.targetSnapshot();
    assert.doesNotThrow(() => f.store.recoverStaleChannelWorkflows(now()));
    assert.notEqual(f.workflow().status, "succeeded", "raw storage recovery must not bypass integration completion");
    if (stage === "captured") assert.equal(f.step().status, "running");
    assert.equal(await recoverWorkflowIsolationsAtStartup(f.store), 1);
    assert.equal(f.step().status, "succeeded");
    assert.equal(f.workflow().status, "succeeded");
    assert.equal(f.round().phase, "awaiting_approval");
    assert.ok(f.round().candidate);
    assert.deepEqual(await f.targetSnapshot(), target);
    assert.deepEqual(f.executionSnapshot(), execution, "recovery never creates/retries a Run or Attempt");
    const before = await f.integrationSnapshot();
    assert.equal(await recoverWorkflowIsolationsAtStartup(f.store), 0);
    assert.deepEqual(await f.integrationSnapshot(), before, "completed recovery is observation-only");
  });
}

test("startup enumerates persisted rounds after a mutable participant pin is removed", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t);
  const metadata = { ...f.step().metadata };
  delete metadata.isolationScopePlan;
  f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json=? WHERE id=?")
    .run(JSON.stringify(metadata), f.step().id);
  f.reopenIsolation();
  const before = await f.integrationSnapshot();
  assert.equal(await recoverWorkflowIsolationsAtStartup(f.store), 0);
  assert.notEqual(f.workflow().status, "succeeded");
  assert.deepEqual(await f.integrationSnapshot(), before, "missing mutable pins must not hide the round or authorize effects");
});

test("workflow cancellation withdraws authority immediately but waits for the original isolation callback", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t), gate = deferred(), entered = deferred();
  const target = await f.targetSnapshot(), activeRuns = new ActiveRunRegistry();
  configureWorkflowIsolationLifecycle(f.store, {
    trackCompletion: completion => activeRuns.trackCompletion(completion),
    isShuttingDown: () => activeRuns.isShuttingDown(),
  });
  const operation = runWorkflowIsolationOperation(f.store, f.workflowId, "fixture-in-flight", async () => {
    entered.resolve();
    await gate.promise;
    return f.coordinate();
  });
  t.after(() => gate.resolve());
  await entered.promise;
  let returned = false;
  const cancellation = cancelChannelWorkflow({ store: f.store, workflowId: f.workflowId }).then(result => { returned = true; return result; });
  assert.equal(f.workflow().status, "cancelled", "withdrawal must not wait for physical drain");
  assert.equal(returned, false);
  const repeated = cancelChannelWorkflow({ store: f.store, workflowId: f.workflowId });
  assert.equal(collectWorkflowIsolationRisks(f.store, f.workflowId, "en-US")[0]?.status, "unverified");
  gate.resolve();
  const result = await operation;
  assert.equal(result.status, "blocked");
  await Promise.all([cancellation, repeated, activeRuns.waitForIdle()]);
  assert.equal(returned, true);
  assert.equal(workflowIsolationIsDraining(f.store, f.workflowId), false);
  assert.deepEqual(await f.targetSnapshot(), target);
  assert.deepEqual(await f.journal(), { effects: [], receipts: [] });
  assert.deepEqual(collectWorkflowIsolationRisks(f.store, f.workflowId, "en-US"), [], "no Git effect was launched after withdrawal");
});

test("cancellation after a real worktree effect retains its unconfirmed journal and report risk after drain", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t), target = await f.targetSnapshot();
  const createArtifact = f.store.createArtifact;
  let cancellation, observedDrain = false;
  t.mock.method(f.store, "createArtifact", function(input, ...rest) {
    if (!cancellation && input.sealedPayload?.kind === "workflow_integration_coordinator_receipt"
      && input.sealedPayload.effectKey === "worktree:create") {
      assert.equal(workflowIsolationIsDraining(f.store, f.workflowId), true);
      cancellation = cancelChannelWorkflow({ store: f.store, workflowId: f.workflowId }).then(result => { observedDrain = true; return result; });
      assert.equal(f.workflow().status, "cancelled");
      assert.equal(observedDrain, false);
    }
    return createArtifact.call(this, input, ...rest);
  });
  const result = await f.coordinate();
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.ok(cancellation, "the cancellation was injected only after a real worktree-create completed");
  await cancellation;
  assert.equal(observedDrain, true);
  const journal = await f.journal();
  assert.equal(journal.effects.length, 1);
  assert.equal(journal.effects[0].status, "pending", "revocation must not manufacture a confirmed effect receipt");
  assert.equal(f.round().openIntentId, journal.effects[0].intentId);
  const risks = collectWorkflowIsolationRisks(f.store, f.workflowId, "en-US");
  assert.equal(risks.length, 1);
  assert.equal(risks[0].severity, "critical");
  assert.equal(risks[0].status, "unverified");
  assert.equal(workflowIsolationIsDraining(f.store, f.workflowId), false, "drained and effect-confirmed are distinct facts");
  const before = await f.integrationSnapshot();
  assert.equal((await f.coordinate()).status, "blocked");
  assert.deepEqual(await f.integrationSnapshot(), before, "withdrawn coordination cannot repeat or confirm the effect");
  assert.deepEqual(await f.targetSnapshot(), target);
});

test("simultaneous real coordinator ticks share one Git execution and one immutable journal", nativeGit, async t => {
  const f = await workflowIntegrationCoordinatorFixture(t);
  const target = await f.targetSnapshot();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.coordinate()));
  assert.ok(results.every(result => result.status === "awaiting_approval"), JSON.stringify(results));
  assert.ok(results.every(result => result.round.candidate.packetDigest === results[0].round.candidate.packetDigest));
  const journal = await f.journal();
  assert.equal(journal.effects.filter(effect => effect.effectKey === "worktree:create").length, 1);
  assert.equal(journal.effects.filter(effect => effect.effectKey === "candidate:verify").length, 1);
  assert.ok(journal.effects.every(effect => effect.status === "confirmed"));
  assert.equal(journal.receipts.length, journal.effects.length);
  assert.deepEqual(await f.targetSnapshot(), target);
});
