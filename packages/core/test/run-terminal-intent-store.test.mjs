import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveStoragePaths, toRuntimeAttemptFence } from "../dist/index.js";
import { SqliteRunTerminalIntentStore, assertNoPendingRunTerminalIntent } from "../dist/storage/sqlite/run-terminal-intent-store.js";
import { SqliteDelegationLifecycleStore } from "../dist/storage/sqlite/delegation-lifecycle-store.js";
import { createBudgetHarness } from "./support/delegation-budget-fixture.mjs";

const now = () => new Date().toISOString();
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-terminal-intent-"));
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  let store = createSqliteRunStore(cwd, paths);
  const f = createBudgetHarness(cwd, { store, now: now(), later: now() }); f.freeze(); f.start();
  const source = { runId: f.root.id, ...f.fence }, lifetime = deferred();
  let coverage = true;
  const completion = store.trackHostAttemptCompletion(source, lifetime.promise, () => coverage);
  let failure;
  const ports = {
    getRun: id => store.getRun(id), getWorkUnit: id => store.getWorkUnit(id), getWorkUnitAttempt: id => store.getWorkUnitAttempt(id),
    getHostAttemptCompletion: source => store.getHostAttemptCompletion(source), getArtifact: id => store.getArtifact(id),
    getDelegationCompletionEvidence: input => store.getDelegationCompletionEvidence(input),
    transitionRunExecutionStatus: input => store.transitionRunExecutionStatus(input), transitionWorkUnitStatus: input => store.transitionWorkUnitStatus(input),
    updateWorkUnitAttemptStatus: input => store.updateWorkUnitAttemptStatus(input), appendTerminalRuntimeAudit: input => store.appendTerminalRuntimeAudit(input),
    getTask: id => store.getTask(id), transitionTaskStatus: input => store.transitionTaskStatus(input),
    appendEvent: (...args) => store.appendEvent(...args), getControlPlaneEventByIdempotency: (...args) => store.getControlPlaneEventByIdempotency(...args),
    createArtifactWithinTransaction: input => { const result = store.artifacts.createArtifactWithinTransaction(input); if (failure === "artifact") throw new Error("injected-artifact"); return result; },
    appendControlPlaneEventWithinTransaction: (input, at) => {
      const result = store.controlPlane.appendControlPlaneEventWithinTransaction(input, at);
      if (failure === "control-plane") throw new Error("injected-control-plane"); return result;
    },
    releaseResourceLeasesForAttempt: (...args) => store.releaseResourceLeasesForAttempt(...args),
    releaseRuntimeSemaphoreSlotsForAttempt: (...args) => {
      const result = store.releaseRuntimeSemaphoreSlotsForAttempt(...args);
      if (failure === "resources") throw new Error("injected-resources"); return result;
    },
    sealDelegatedTerminalWithinTransaction: () => { throw new Error("unexpected-delegated-seal"); },
  };
  let intents = new SqliteRunTerminalIntentStore({ database: store.database }, ports);
  const prepare = (outcome = "failed", changes = {}) => intents.prepareRunTerminalIntent({ runId: f.root.id, sourceFence: f.fence,
    desiredOutcome: outcome, errorCode: `controlled_${outcome}`, errorMessage: `controlled ${outcome}`, now: now(), ...changes });
  const reconcile = (changes = {}) => intents.reconcileRunTerminalIntent({ attemptId: f.attempt.id, now: now(), ...changes });
  const resources = () => {
    const fact = { ...f.fence, workspaceId: DEFAULT_WORKSPACE_ID, ownerType: "work_unit_attempt", ownerId: f.attempt.id,
      acquiredAt: now(), expiresAt: new Date(Date.now() + 1000).toISOString() };
    store.acquireResourceLease({ ...fact, resourceType: "channel", resourceKey: "parent" });
    store.acquireRuntimeSemaphoreSlot({ ...fact, resourceType: "runner", resourceKey: "pi", limit: 1 });
  };
  const snapshot = () => ["run_sessions", "work_units", "work_unit_attempts", "state_transition_events", "runtime_events",
    "resource_leases", "runtime_semaphore_slots", "delegation_budget_reservations", "delegation_budget_charges",
    "run_events", "control_plane_events", "run_terminal_intents", "artifacts", "delegation_steps", "delegation_messages", "harness_artifact_pins", "harness_artifact_pin_events"]
    .map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
  const reopen = () => { store.close(); store = createSqliteRunStore(cwd, paths); intents = new SqliteRunTerminalIntentStore({ database: store.database }, ports); };
  t.after(async () => { lifetime.resolve(); await completion.catch(() => undefined); store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { ...f, paths, get store() { return store; }, get intents() { return intents; }, ports, source, prepare, reconcile, resources,
    snapshot, reopen, setFailure: value => { failure = value; }, setCoverage: value => { coverage = value; },
    drain: async () => { lifetime.resolve(); await completion; } };
}

test("Host intent is private sealed disposition, not drain proof; pending leaves ownership, effects, budget and resources unchanged", async t => {
  const f = await fixture(t); f.resources(); const intent = f.prepare(), before = f.snapshot();
  assert.equal(typeof f.store.prepareRunTerminalIntent, "undefined");
  assert.equal(f.store.hasPendingRunTerminalIntent(f.source), true);
  assert.equal(f.reconcile({ receipt: { drained: true, safe: true } }).status, "pending");
  assert.deepEqual(f.snapshot(), before);
  const pins = f.store.database.prepare("SELECT reason FROM harness_artifact_pins WHERE artifact_id=? AND released_at IS NULL ORDER BY reason").all(intent.artifactId);
  assert.deepEqual(pins.map(row => row.reason), ["audit_hold", "recovery"]);
});

for (const [label, message] of [["empty", ""], ["whitespace", " \n\t "], ["NUL", "failed\0after dispatch"],
  ["long", "failure ".repeat(10000)], ["multibyte", "失败🛠️".repeat(10000)], ["escaped", "\u0001".repeat(20000)]]) {
  test(`${label} Error.message cannot prevent the original terminal disposition from being sealed`, async t => {
    const f = await fixture(t), intent = f.prepare("failed", { errorMessage: message });
    assert.ok(intent.payload.errorMessage.trim());
    assert.equal(intent.payload.errorMessage.includes("\0"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(intent.payload), "utf8") <= 65536);
    assert.deepEqual(f.prepare("failed", { errorMessage: message }), intent);
    await f.drain(); f.reopen();
    assert.equal(f.reconcile().status, "committed");
    assert.equal(f.store.getRun("root").errorMessage, intent.payload.errorMessage);
  });
}

for (const outcome of ["failed", "cancelled"]) test(`${outcome} same-source terminal is atomic, exact-once and survives close/reopen without Runner`, async t => {
  const f = await fixture(t); f.resources(); const intent = f.prepare(outcome);
  assert.deepEqual(f.prepare(outcome), intent);
  await f.drain(); f.reopen();
  const first = f.reconcile(); assert.equal(first.status, "committed"); assert.equal(first.replayed, false);
  assert.equal(first.controlPlaneEvents.length, 2);
  assert.deepEqual([f.store.getRun("root").status, f.store.getWorkUnit("root-unit").status, f.store.getWorkUnitAttempt("root-attempt").status], [outcome, outcome, outcome]);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
  const before = f.snapshot(); f.reopen();
  assert.equal(f.reconcile().replayed, true); assert.deepEqual(f.snapshot(), before);
  f.intents.acknowledgeRunTerminalIntent({ attemptId: f.attempt.id, now: now() });
  const ack = f.intents.getRunTerminalIntent(f.attempt.id); assert.ok(ack.notifiedAt);
  f.intents.acknowledgeRunTerminalIntent({ attemptId: f.attempt.id, now: now() });
  assert.equal(f.intents.getRunTerminalIntent(f.attempt.id).notifiedAt, ack.notifiedAt);
  assert.deepEqual(f.intents.listUnfinishedRunTerminalIntents({ cutoffAt: now(), limit: 100 }).attemptIds, []);
});

test("failed preparation rolls back sealed artifact, both pins and intent; no orphan authority", async t => {
  const f = await fixture(t), before = f.snapshot(), count = f.store.database.prepare("SELECT COUNT(*) n FROM artifacts").get().n;
  f.setFailure("artifact"); assert.throws(() => f.prepare(), /injected-artifact/);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM artifacts").get().n, count);
  f.setFailure(undefined); assert.equal(f.prepare().state, "pending");
});

for (const failure of ["control-plane", "resources"]) test(`${failure} fault rolls Run/WU/Attempt, audit, events, pins, resource release and intent back together`, async t => {
  const f = await fixture(t); f.resources(); f.prepare(); await f.drain(); const before = f.snapshot();
  f.setFailure(failure); assert.throws(() => f.reconcile(), new RegExp(`injected-${failure}`));
  assert.deepEqual(f.snapshot(), before); assert.equal(f.store.database.isTransaction, false);
  f.setFailure(undefined); assert.equal(f.reconcile().status, "committed");
});

for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) test(`old/foreign ${field} cannot replace original terminal intent`, async t => {
  const f = await fixture(t); const before = f.snapshot();
  assert.throws(() => f.prepare("failed", { sourceFence: { ...f.fence, [field]: "other" } }), /run_terminal_intent_source_invalid/);
  assert.deepEqual(f.snapshot(), before);
});

test("changed disposition or error cannot mutate the first response-loss intent", async t => {
  const f = await fixture(t), intent = f.prepare(), before = f.snapshot();
  assert.throws(() => f.prepare("cancelled"), /run_terminal_intent_conflict/);
  assert.throws(() => f.prepare("failed", { errorMessage: "changed" }), /run_terminal_intent_conflict/);
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.intents.getRunTerminalIntent(f.attempt.id), intent);
});

test("a pending intent cannot adopt another writer's matching terminal states or notify their follow-up again", async t => {
  const f = await fixture(t); f.prepare(); await f.drain();
  const endedAt = now();
  f.store.database.prepare("UPDATE run_sessions SET status='failed',ended_at=? WHERE id='root'").run(endedAt);
  f.store.database.prepare("UPDATE work_units SET status='failed',ended_at=? WHERE id='root-unit'").run(endedAt);
  f.store.database.prepare("UPDATE work_unit_attempts SET status='failed',ended_at=? WHERE id='root-attempt'").run(endedAt);
  const before = f.snapshot();
  assert.equal(f.reconcile().code, "run_terminal_intent_terminal_owner_unverified");
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.intents.getRunTerminalIntent(f.attempt.id).state, "pending");
});

for (const damage of ["new-attempt", "context"]) test(`${damage} cannot borrow old intent to terminalize or release successor resources`, async t => {
  const f = await fixture(t); f.resources(); f.prepare(); await f.drain();
  if (damage === "new-attempt") f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor", runnerId: "pi", status: "started", now: now() });
  else f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json=? WHERE id='root'").run(JSON.stringify({ changed: true }));
  const before = f.snapshot(); assert.equal(f.reconcile().status, "blocked"); assert.deepEqual(f.snapshot(), before);
});

test("uncertified original effects stay blocked after a real local drain, with no terminal/resource writes", async t => {
  const f = await fixture(t); f.resources(); f.prepare(); f.setCoverage(false); await f.drain();
  const before = f.snapshot(); assert.match(f.reconcile().code, /effects_unverified/); assert.deepEqual(f.snapshot(), before);
});

test("current durable effect blockers veto even a persisted tool-free coverage marker", async t => {
  const f = await fixture(t); f.resources(); f.prepare();
  f.store.admitHostOperation({ operationId: "unsettled-plugin", source: f.source, kind: "plugin", toolCallId: "plugin", admittedAt: now() });
  await f.drain(); const before = f.snapshot(); assert.match(f.reconcile().code, /quiescence_unverified/); assert.deepEqual(f.snapshot(), before);
});

test("unknown Provider usage cannot be refunded or marked terminal even after real drain", async t => {
  const f = await fixture(t); f.resources(); f.charge({ now: now() }); f.prepare(); await f.drain();
  const before = f.snapshot(); assert.equal(f.reconcile().status, "blocked"); assert.deepEqual(f.snapshot(), before);
});

test("unknown child state preserves parent and allocation, and the durable latch rejects spawn after reconstruction", async t => {
  const f = await fixture(t), child = f.spawn({ now: now() }); f.resources(); f.prepare(); await f.drain();
  const before = f.snapshot(); assert.equal(f.reconcile().status, "pending"); assert.deepEqual(f.snapshot(), before);
  assert.equal(f.store.getRun(child.childRun.id).status, "queued");
  assert.throws(() => f.spawn({ spawnCallId: "late", now: now() }), /run_terminal_intent_admission_closed/);
  f.reopen(); assert.throws(() => assertNoPendingRunTerminalIntent({ database: f.store.database }, child.childRun.id), /run_terminal_intent_admission_closed/);
  assert.equal(f.store.recoverStaleRuns(now()), 0); assert.deepEqual(f.snapshot(), before);
});

test("Host GC cannot prune live/replay intent evidence, even if an explicit retention policy expires", async t => {
  const f = await fixture(t), intent = f.prepare();
  f.store.enrollHarnessArtifactRetention({ artifactId: intent.artifactId, retainUntil: now(), now: now() });
  assert.deepEqual(f.store.collectHarnessArtifactBodies({ now: now() }).prunedArtifactIds, []);
  await f.drain(); assert.equal(f.reconcile().status, "committed");
  assert.deepEqual(f.store.collectHarnessArtifactBodies({ now: now() }).prunedArtifactIds, []);
  assert.ok(f.store.getArtifact(intent.artifactId).sealedPayload);
});

test("actual artifact byte corruption is rejected, not accepted through parsed JSON or a stale metadata hash", async t => {
  const f = await fixture(t), intent = f.prepare(); await f.drain();
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json=sealed_payload_json||' ' WHERE id=?").run(intent.artifactId);
  const before = f.snapshot(); assert.throws(() => f.reconcile(), /artifact.body_digest_mismatch/); assert.deepEqual(f.snapshot(), before);
});

test("another actual process consumes the sealed original disposition and lost-response replay creates no second terminal", async t => {
  const f = await fixture(t); f.resources(); f.prepare(); await f.drain();
  const worker = new URL("./support/run-terminal-intent-reopen-worker.mjs", import.meta.url);
  const invoke = () => JSON.parse(execFileSync(process.execPath, [...process.execArgv, worker.pathname,
    f.cwd, JSON.stringify(f.paths), f.attempt.id], { encoding: "utf8" }));
  const first = invoke(); assert.equal(first.status, "committed"); assert.equal(first.replayed, false);
  const before = f.snapshot(), second = invoke(); assert.equal(second.replayed, true); assert.deepEqual(f.snapshot(), before);
});

async function startedChild(f) {
  const child = f.spawn({ now: now() }), observations = new WeakMap(), preparations = new WeakMap();
  const lifecycle = new SqliteDelegationLifecycleStore({ database: f.store.database }, {
    getRun: id => f.store.getRun(id), getWorkUnit: id => f.store.getWorkUnit(id), getWorkUnitAttempt: id => f.store.getWorkUnitAttempt(id),
    getDelegationStep: id => f.store.getDelegationStep(id), getDelegationBudgetReservation: id => f.writer.getDelegationBudgetReservation(id),
    getArtifact: id => f.store.getArtifact(id), createArtifactWithinTransaction: input => f.store.artifacts.createArtifactWithinTransaction(input),
    createWorkUnitAttemptWithinTransaction: input => f.store.runtimeWorkUnits.createWorkUnitAttemptWithinTransaction(input),
    transitionRunStatus: input => f.store.transitionRunStatus(input), transitionWorkUnitStatus: input => f.store.transitionWorkUnitStatus(input),
    updateWorkUnitAttemptStatus: input => f.store.updateWorkUnitAttemptStatus(input), appendRuntimeEvent: input => f.store.appendRuntimeEvent(input),
    getHostAttemptCompletion: source => f.store.getHostAttemptCompletion(source), appendTerminalRuntimeAudit: input => f.store.appendTerminalRuntimeAudit(input),
    releaseResourceLeasesForAttempt: (...args) => f.store.releaseResourceLeasesForAttempt(...args),
    releaseRuntimeSemaphoreSlotsForAttempt: (...args) => f.store.releaseRuntimeSemaphoreSlotsForAttempt(...args),
    assertDispatchAuthorityWithinTransaction: input => f.writer.assertDelegatedChildDispatchAuthorityWithinTransaction(input),
    readRunnerStartObservation: token => { assert.ok(observations.has(token)); return observations.get(token); },
    readExecutionPreparation: token => { assert.ok(preparations.has(token)); return preparations.get(token); },
  });
  const claimed = lifecycle.claimDelegatedChild({ reservationId: child.reservation.id, expectedStepRevision: 0, runtimeInstanceId: "runtime", now: now() });
  const fence = toRuntimeAttemptFence(claimed.attempt), preparation = {}, observation = {};
  preparations.set(preparation, { schemaVersion: 1, kind: "delegation.execution.v1", stepId: child.stepId,
    reservationId: child.reservation.id, rootRunId: "root", parentRunId: "root", childRunId: child.childRun.id, sourceFence: fence,
    runnerId: "pi", preparedAt: now(), requestSnapshot: { cwd: f.cwd, task: claimed.run.taskSnapshot, parentRunId: "root", runnerId: "pi" },
    runnerExecutionInput: { schemaVersion: 1, runnerId: "pi", input: { cwd: f.cwd, task: claimed.run.taskSnapshot,
      provider: { provider: claimed.run.providerName, model: claimed.run.providerModel } }, preparedInput: { taskId: claimed.run.taskId, fingerprint: "a".repeat(64) } },
    effectivePolicySnapshot: { mode: "workspace_write", workspacePolicyUpdatedAt: f.root.createdAt, toolDecisions: {}, allowedWritePaths: [f.cwd], riskNotes: [] } });
  lifecycle.commitDelegatedChildPreparation({ reservationId: child.reservation.id, sourceFence: fence, preparation, now: now() });
  observations.set(observation, { childRunId: child.childRun.id, sourceFence: fence, runnerId: "pi", observationId: "accepted", observedAt: now() });
  lifecycle.commitDelegatedChildStart({ reservationId: child.reservation.id, sourceFence: fence, observation, now: now() });
  await f.store.trackHostAttemptCompletion({ runId: child.childRun.id, ...fence }, Promise.resolve(), () => true);
  f.ports.sealDelegatedTerminalWithinTransaction = input => {
    f.writer.settleDelegatedChildWithinTransaction({ reservationId: child.reservation.id, receipt: input.receipt, now: input.now });
    lifecycle.commitDelegatedChildTerminalWithinTransaction({ reservationId: child.reservation.id, sourceFence: input.sourceFence, now: input.now });
  };
  return { child, fence, receipt: f.childReceipt({ kind: "verified_usage", childRunId: child.childRun.id, sourceFence: fence }) };
}

for (const outcome of ["failed", "cancelled"]) test(`nested ${outcome} status, measured incoming allocation and sealed child result commit in one original transaction`, async t => {
  const f = await fixture(t), nested = await startedChild(f);
  f.intents.prepareRunTerminalIntent({ runId: nested.child.childRun.id, sourceFence: nested.fence, desiredOutcome: outcome,
    errorCode: `nested_${outcome}`, errorMessage: `nested ${outcome}`, now: now() });
  const result = f.intents.reconcileRunTerminalIntent({ attemptId: nested.fence.attemptId, receipt: nested.receipt, now: now() });
  assert.equal(result.status, "committed");
  assert.equal(f.store.getRun(nested.child.childRun.id).status, outcome);
  assert.equal(f.writer.getDelegationBudgetReservation(nested.child.reservation.id).state, "settled");
  assert.equal(f.store.getDelegationStep(nested.child.stepId).state, outcome);
  assert.equal(f.store.listDelegationMessages(nested.child.stepId).filter(message => message.kind === "result").length, 1);
  assert.equal(f.store.getRun("root").status, "running", "nested cleanup does not finish the external root");
});

test("nested forged receipt and result-insertion failure roll back status, allocation, result artifact/message, events and pins", async t => {
  const f = await fixture(t), nested = await startedChild(f);
  f.intents.prepareRunTerminalIntent({ runId: nested.child.childRun.id, sourceFence: nested.fence, desiredOutcome: "failed",
    errorCode: "nested_failed", errorMessage: "nested failed", now: now() });
  const before = f.snapshot();
  assert.throws(() => f.intents.reconcileRunTerminalIntent({ attemptId: nested.fence.attemptId, receipt: { verified: true }, now: now() }), /delegation.authority_invalid/);
  assert.deepEqual(f.snapshot(), before);
  f.store.database.exec("CREATE TEMP TRIGGER terminal_result_failure BEFORE INSERT ON delegation_messages WHEN NEW.kind='result' BEGIN SELECT RAISE(ABORT,'injected-nested-result'); END");
  assert.throws(() => f.intents.reconcileRunTerminalIntent({ attemptId: nested.fence.attemptId, receipt: nested.receipt, now: now() }), /injected-nested-result/);
  assert.deepEqual(f.snapshot(), before);
  f.store.database.exec("DROP TRIGGER terminal_result_failure");
  assert.equal(f.intents.reconcileRunTerminalIntent({ attemptId: nested.fence.attemptId, receipt: nested.receipt, now: now() }).status, "committed");
});
