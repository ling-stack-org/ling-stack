import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteDelegationLifecycleStore } from "../dist/storage/sqlite/delegation-lifecycle-store.js";
import { DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";
import { createBudgetHarness, budgetNow, budgetLater } from "./support/delegation-budget-fixture.mjs";

const later = "2026-10-19T00:00:02.000Z";
async function fixture(t, live = false) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-lifecycle-"));
  const localNow = live ? new Date().toISOString() : budgetNow;
  const localLater = live ? new Date(Date.parse(localNow) + 1).toISOString() : budgetLater;
  const startAt = live ? new Date(Date.parse(localNow) + 2).toISOString() : later;
  const f = createBudgetHarness(cwd, { now: localNow, later: localLater });
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.freeze(); f.start();
  const child = f.spawn();
  const observations = new WeakMap(), preparations = new WeakMap();
  let fault, authorizations = 0;
  const ports = {
    getRun: id => f.store.getRun(id), getWorkUnit: id => f.store.getWorkUnit(id), getWorkUnitAttempt: id => f.store.getWorkUnitAttempt(id),
    getDelegationStep: id => f.store.getDelegationStep(id), getDelegationBudgetReservation: id => f.writer.getDelegationBudgetReservation(id),
    getArtifact: id => f.store.getArtifact(id), createArtifactWithinTransaction: input => f.ports.createArtifactWithinTransaction(input),
    createWorkUnitAttemptWithinTransaction: input => f.store.runtimeWorkUnits.createWorkUnitAttemptWithinTransaction(input),
    transitionRunStatus: input => f.store.transitionRunStatus(input),
    transitionWorkUnitStatus: input => f.store.transitionWorkUnitStatus(input),
    updateWorkUnitAttemptStatus: input => { if (fault === "attempt") throw new Error("injected-start-fault"); return f.store.updateWorkUnitAttemptStatus(input); },
    appendRuntimeEvent: input => { const event = f.store.appendRuntimeEvent(input); if (fault === "event") throw new Error("injected-event-fault"); return event; },
    getHostAttemptCompletion: input => f.store.getHostAttemptCompletion(input),
    appendTerminalRuntimeAudit: input => f.store.appendTerminalRuntimeAudit(input),
    releaseResourceLeasesForAttempt: (...args) => f.store.releaseResourceLeasesForAttempt(...args),
    releaseRuntimeSemaphoreSlotsForAttempt: (...args) => f.store.releaseRuntimeSemaphoreSlotsForAttempt(...args),
    assertDispatchAuthorityWithinTransaction: input => { authorizations++; f.writer.assertDelegatedChildDispatchAuthorityWithinTransaction(input); },
    readRunnerStartObservation: token => { if (!observations.has(token)) throw Object.assign(new Error("delegation.authority_invalid"), { code: "delegation.authority_invalid" }); return observations.get(token); },
    readExecutionPreparation: token => { if (!preparations.has(token)) throw Object.assign(new Error("delegation.authority_invalid"), { code: "delegation.authority_invalid" }); return structuredClone(preparations.get(token)); },
  };
  const lifecycle = new SqliteDelegationLifecycleStore({ database: f.db }, ports);
  const claim = (changes = {}) => lifecycle.claimDelegatedChild({ reservationId: child.reservation.id, expectedStepRevision: 0,
    runtimeInstanceId: "runtime", now: localLater, ...changes });
  const observe = (claimed, changes = {}) => { const token = {}; observations.set(token, { childRunId: claimed.run.id,
    sourceFence: toRuntimeAttemptFence(claimed.attempt), runnerId: "pi", observationId: "accepted-1", observedAt: localLater, ...changes }); return token; };
  const preparationPayload = claimed => ({ schemaVersion: 1, kind: "delegation.execution.v1", stepId: child.stepId,
    reservationId: child.reservation.id, rootRunId: "root", parentRunId: "root", childRunId: claimed.run.id,
    sourceFence: toRuntimeAttemptFence(claimed.attempt), runnerId: "pi", preparedAt: localLater,
    requestSnapshot: { cwd, task: structuredClone(claimed.run.taskSnapshot), parentRunId: "root", runnerId: "pi" },
    runnerExecutionInput: { schemaVersion: 1, runnerId: "pi", input: { cwd, task: structuredClone(claimed.run.taskSnapshot),
      provider: { provider: claimed.run.providerName, model: claimed.run.providerModel } },
      preparedInput: { taskId: claimed.run.taskId, fingerprint: "a".repeat(64) } },
    effectivePolicySnapshot: { mode: "workspace_write", workspacePolicyUpdatedAt: localNow, toolDecisions: {}, allowedWritePaths: [cwd], riskNotes: [] } });
  const preparationToken = payload => { const token = Object.freeze({}); preparations.set(token, structuredClone(payload)); return token; };
  const prepare = (claimed, changes = {}) => lifecycle.commitDelegatedChildPreparation({ reservationId: child.reservation.id,
    sourceFence: toRuntimeAttemptFence(claimed.attempt), preparation: preparationToken(preparationPayload(claimed)), now: startAt, ...changes });
  const start = (claimed, changes = {}) => {
    if (!lifecycle.getDelegatedChildPreparation(child.reservation.id)) prepare(claimed);
    return lifecycle.commitDelegatedChildStart({ reservationId: child.reservation.id,
      sourceFence: toRuntimeAttemptFence(claimed.attempt), observation: observe(claimed), now: startAt, ...changes });
  };
  return { ...f, child, lifecycle, claim, observe, prepare, preparationToken, preparationPayload, start, ports, startAt,
    authorizations: () => authorizations, fault: value => { fault = value; } };
}

test("initial claim creates only a fenced Attempt and replays without another claim", async t => {
  const f = await fixture(t), claimed = f.claim();
  assert.equal(claimed.replayed, false);
  assert.equal(claimed.run.status, "queued");
  assert.equal(claimed.workUnit.status, "claimed");
  assert.equal(claimed.attempt.status, "created");
  assert.equal(claimed.step.state, "spawning");
  assert.equal(claimed.step.childRunId, undefined);
  const replayed = f.claim();
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.attempt.id, claimed.attempt.id);
  assert.equal(f.store.listWorkUnitAttempts(claimed.workUnit.id).length, 1);
  assert.equal(f.authorizations(), 1);
});

test("restart discovery is bounded, stable across tied timestamps, and is not dispatch authority", async t => {
  const f = await fixture(t);
  const second = f.spawn({ spawnCallId: "second-child" });
  const first = f.lifecycle.listDelegatedRecoveryCandidates({ cutoffAt: later, limit: 1 });
  assert.equal(first.reservationIds.length, 1);
  assert.ok(first.nextCursor);
  const next = f.lifecycle.listDelegatedRecoveryCandidates({ cutoffAt: later, limit: 1, cursor: first.nextCursor });
  assert.equal(next.reservationIds.length, 1);
  assert.equal(next.nextCursor, undefined);
  assert.deepEqual(new Set([...first.reservationIds, ...next.reservationIds]), new Set([f.child.reservation.id, second.reservation.id]));
  const claimed = f.claim();
  assert.equal(f.lifecycle.classifyDelegatedChildRecovery(claimed.reservation.id).kind, "dispatch_outcome_unknown");
  assert.equal(f.lifecycle.listDelegatedRecoveryCandidates({ cutoffAt: later, limit: 100 }).reservationIds.length, 2);
  assert.equal(f.store.listWorkUnitAttempts(claimed.workUnit.id).length, 1);
  assert.deepEqual(f.lifecycle.listDelegatedRecoveryCandidates({ cutoffAt: "2026-10-18T00:00:00.000Z", limit: 1 }).reservationIds, []);
});

test("restart discovery rejects unbounded or noncanonical page inputs", async t => {
  const f = await fixture(t);
  for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "1" },
    { limit: 1, cursor: { createdAt: "2027-01-01T00:00:00.000Z", reservationId: "future" } },
    { limit: 1, cursor: { createdAt: budgetNow, reservationId: "valid", callback: "not-allowed" } }]) {
    assert.throws(() => f.lifecycle.listDelegatedRecoveryCandidates({ cutoffAt: later, ...input }));
  }
});

test("claim refuses a competing runtime and recovery classifies dispatch outcome as unknown", async t => {
  const f = await fixture(t);
  assert.equal(f.lifecycle.classifyDelegatedChildRecovery(f.child.reservation.id).kind, "queued_unclaimed");
  const claimed = f.claim();
  assert.throws(() => f.claim({ runtimeInstanceId: "another-runtime" }), { code: "delegation.recovery_required" });
  assert.equal(f.lifecycle.classifyDelegatedChildRecovery(f.child.reservation.id).kind, "dispatch_outcome_unknown");
  assert.equal(f.writer.getDelegationBudgetReservation(f.child.reservation.id).state, "reserved");
  assert.equal(f.store.listWorkUnitAttempts(claimed.workUnit.id).length, 1);
});

test("current revocation rolls the new Attempt and claim back together", async t => {
  const f = await fixture(t);
  f.setCurrentAuthority({ ...f.authority, tools: ["read"], toolDecisions: { read: "allow" } });
  assert.throws(() => f.claim(), { code: "delegation.capability_escalation" });
  assert.equal(f.store.getWorkUnit(f.child.childWorkUnit.id).status, "queued");
  assert.equal(f.store.listWorkUnitAttempts(f.child.childWorkUnit.id).length, 0);
  assert.equal(f.store.getDelegationStep(f.child.stepId).state, "spawning");
});

test("accepted Runner start cannot bypass the original durable preparation", async t => {
  const f = await fixture(t), claimed = f.claim();
  assert.throws(() => f.lifecycle.commitDelegatedChildStart({ reservationId: f.child.reservation.id,
    sourceFence: toRuntimeAttemptFence(claimed.attempt), observation: f.observe(claimed), now: f.startAt }),
  { code: "delegation.recovery_required" });
  assert.equal(f.store.getWorkUnitAttempt(claimed.attempt.id).status, "created");
  assert.equal(f.store.getRun(claimed.run.id).status, "queued");
});

test("only Host preparation custody seals one immutable input and rejects changed replay", async t => {
  const f = await fixture(t), claimed = f.claim(), payload = f.preparationPayload(claimed);
  assert.throws(() => f.prepare(claimed, { preparation: payload }), { code: "delegation.authority_invalid" });
  const token = f.preparationToken(payload), first = f.prepare(claimed, { preparation: token });
  payload.requestSnapshot.task.title = "Mutated after capture";
  assert.notEqual(f.lifecycle.getDelegatedChildPreparation(f.child.reservation.id).payload.requestSnapshot.task.title, payload.requestSnapshot.task.title);
  assert.deepEqual(f.prepare(claimed, { preparation: token }), first);
  const changed = f.preparationPayload(claimed);
  changed.effectivePolicySnapshot.riskNotes = [{ code: "changed", message: "Different policy" }];
  assert.throws(() => f.prepare(claimed, { preparation: f.preparationToken(changed) }), { code: "delegation.idempotency_conflict" });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE path='sqlite:delegation-execution'").get().n, 1);
});

test("preparation rejects secrets, wrong Provider and stale source without storing an artifact", async t => {
  const f = await fixture(t), claimed = f.claim();
  for (const mutate of [
    value => { value.requestSnapshot.provider = { apiKey: "fixture-secret-value" }; },
    value => { value.runnerExecutionInput.input.provider.provider = "foreign"; },
    value => { value.sourceFence.fencingToken = "foreign"; },
  ]) {
    const payload = f.preparationPayload(claimed); mutate(payload);
    assert.throws(() => f.prepare(claimed, { preparation: f.preparationToken(payload) }));
    assert.equal(f.lifecycle.getDelegatedChildPreparation(f.child.reservation.id), undefined);
  }
});

test("preparation artifact failure rolls back and a subsequent sealed-input retry succeeds", async t => {
  const f = await fixture(t), claimed = f.claim();
  f.setFaultPort("artifact");
  assert.throws(() => f.prepare(claimed), /injected-artifact-fault/);
  assert.equal(f.lifecycle.getDelegatedChildPreparation(f.child.reservation.id), undefined);
  f.setFaultPort(undefined);
  const prepared = f.prepare(claimed);
  assert.equal(prepared.payload.sourceFence.attemptId, claimed.attempt.id);
  assert.equal(f.start(claimed).step.state, "running");
});

test("only a genuine accepted-start observation commits all four execution entities", async t => {
  const f = await fixture(t), claimed = f.claim(), observation = f.observe(claimed);
  assert.throws(() => f.start(claimed, { observation: { childRunId: claimed.run.id } }), { code: "delegation.authority_invalid" });
  const started = f.start(claimed, { observation });
  assert.equal(started.run.status, "running");
  assert.equal(started.workUnit.status, "running");
  assert.equal(started.attempt.status, "started");
  assert.equal(started.step.state, "running");
  assert.equal(started.step.childRunId, started.run.id);
  assert.equal(started.step.revision, 1);
  assert.equal(f.authorizations(), 3);
  assert.equal(f.start(claimed, { observation }).replayed, true);
  assert.equal(f.store.listRuntimeEvents(claimed.workUnit.id).filter(event => event.data?.kind === "delegation_runner_start").length, 1);
  assert.equal(f.store.getRun("root").status, "running");
});

test("a different acceptance digest cannot replay the same physical start", async t => {
  const f = await fixture(t), claimed = f.claim();
  f.start(claimed);
  assert.throws(() => f.start(claimed, { observation: f.observe(claimed, { observationId: "accepted-other" }) }), { code: "delegation.idempotency_conflict" });
});

test("stale or future observations cannot start a claimed child", async t => {
  const f = await fixture(t), claimed = f.claim();
  assert.throws(() => f.start(claimed, { observation: f.observe(claimed, { observedAt: budgetNow }) }), { code: "delegation.authority_invalid" });
  assert.throws(() => f.start(claimed, { observation: f.observe(claimed, { observedAt: "2026-10-20T00:00:00.000Z" }) }), { code: "delegation.authority_invalid" });
  assert.throws(() => f.start(claimed, { sourceFence: { ...toRuntimeAttemptFence(claimed.attempt), fencingToken: "stale" } }), { code: "delegation.authority_invalid" });
  assert.equal(f.store.getDelegationStep(f.child.stepId).state, "spawning");
});

for (const fault of ["attempt", "event"]) test(`start ${fault} fault rolls Run/WorkUnit/Attempt/step back atomically`, async t => {
  const f = await fixture(t), claimed = f.claim();
  f.fault(fault);
  assert.throws(() => f.start(claimed), /injected-/);
  assert.equal(f.store.getRun(claimed.run.id).status, "queued");
  assert.equal(f.store.getWorkUnit(claimed.workUnit.id).status, "claimed");
  assert.equal(f.store.getWorkUnitAttempt(claimed.attempt.id).status, "created");
  assert.equal(f.store.getDelegationStep(f.child.stepId).state, "spawning");
  assert.equal(f.store.getDelegationStep(f.child.stepId).childRunId, undefined);
  assert.equal(f.store.listRuntimeEvents(claimed.workUnit.id).filter(event => event.type === "work_unit_started").length, 0);
});

test("root deadline and frozen child deadline cannot be extended by claim", async t => {
  const f = await fixture(t);
  assert.throws(() => f.claim({ now: f.child.reservation.deadlineAt }), { code: "delegation.deadline_exceeded" });
  assert.equal(f.store.listWorkUnitAttempts(f.child.childWorkUnit.id).length, 0);
});

test("instructions append a sealed artifact once and reject changed response-loss replay", async t => {
  const f = await fixture(t);
  const request = { reservationId: f.child.reservation.id, parentFence: f.fence, messageCallId: "message-1", text: "Only inspect README", now: later };
  const first = f.lifecycle.appendDelegationInstruction(request);
  assert.equal(first.replayed, false);
  assert.equal(f.lifecycle.appendDelegationInstruction(request).replayed, true);
  assert.throws(() => f.lifecycle.appendDelegationInstruction({ ...request, text: "Also write" }), { code: "delegation.idempotency_conflict" });
  assert.equal(f.store.listDelegationMessages(f.child.stepId).length, 1);
  assert.equal(f.store.getArtifact(first.message.bodyArtifactId).sealedPayload.text, request.text);
});

test("new instructions require the exact current parent fence", async t => {
  const f = await fixture(t);
  assert.throws(() => f.lifecycle.appendDelegationInstruction({ reservationId: f.child.reservation.id,
    parentFence: { ...f.fence, fencingToken: "stale" }, messageCallId: "message-1", text: "Inspect", now: later }), { code: "delegation.source_attempt_stale" });
  assert.equal(f.store.listDelegationMessages(f.child.stepId).length, 0);
});

const clock = f => new Date(Math.max(Date.now(), Date.parse(f.startAt) + 1)).toISOString();
function requestInterrupt(f, changes = {}) {
  return f.lifecycle.requestDelegatedChildInterrupt({ reservationId: f.child.reservation.id,
    parentFence: f.fence, callId: "interrupt-1", now: clock(f), ...changes });
}
async function stopped(f) {
  const started = f.start(f.claim()), fence = toRuntimeAttemptFence(started.attempt);
  await f.store.trackHostAttemptCompletion({ runId: started.run.id, ...fence }, Promise.resolve(), () => true);
  requestInterrupt(f);
  const runtime = f.lifecycle.commitDelegatedChildInterrupted({ reservationId: f.child.reservation.id, sourceFence: fence, now: clock(f) });
  return { started, fence, runtime };
}

test("an interrupt request cannot pretend a pending original Host lifetime has physically stopped", async t => {
  const f = await fixture(t, true), started = f.start(f.claim()), fence = toRuntimeAttemptFence(started.attempt);
  let resolve;
  const completion = f.store.trackHostAttemptCompletion({ runId: started.run.id, ...fence }, new Promise(done => { resolve = done; }), () => true);
  try {
    const request = requestInterrupt(f);
    assert.equal(request.step.state, "interrupting");
    assert.equal(request.workUnit.status, "cancelling");
    assert.equal(request.attempt.status, "cancelling");
    assert.equal(request.run.status, "running");
    assert.throws(() => f.lifecycle.commitDelegatedChildInterrupted({ reservationId: f.child.reservation.id,
      sourceFence: fence, now: clock(f) }), { code: "delegation.recovery_required" });
    assert.equal(requestInterrupt(f).replayed, true);
    assert.equal(f.store.listDelegationMessages(f.child.stepId).filter(message => message.kind === "control").length, 1);
  } finally { resolve(); await completion; }
  assert.equal(f.lifecycle.commitDelegatedChildInterrupted({ reservationId: f.child.reservation.id,
    sourceFence: fence, now: clock(f) }).step.state, "interrupted");
  assert.equal(f.store.getRun("root").status, "running");
});

test("verified interrupt releases exact physical resources but preserves logical Run and budget reservation", async t => {
  const f = await fixture(t, true), started = f.start(f.claim()), fence = toRuntimeAttemptFence(started.attempt), source = { runId: started.run.id, ...fence };
  assert.ok(f.store.acquireResourceLease({ ...source, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "channel",
    resourceKey: "delegation-owned", ownerType: "work_unit_attempt", ownerId: fence.attemptId,
    acquiredAt: clock(f), expiresAt: "2099-01-01T00:00:00.000Z" }));
  assert.ok(f.store.acquireRuntimeSemaphoreSlot({ ...source, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner",
    resourceKey: "pi", limit: 2, ownerType: "work_unit_attempt", ownerId: fence.attemptId,
    acquiredAt: clock(f), expiresAt: "2099-01-01T00:00:00.000Z" }));
  await f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => true);
  requestInterrupt(f);
  const input = { reservationId: f.child.reservation.id, sourceFence: fence, now: clock(f) };
  const result = f.lifecycle.commitDelegatedChildInterrupted(input);
  assert.equal(result.step.state, "interrupted");
  assert.equal(result.attempt.status, "cancelled");
  assert.equal(result.workUnit.status, "cancelled");
  assert.equal(result.run.status, "running");
  assert.equal(result.run.endedAt, undefined);
  assert.equal(result.reservation.state, "reserved");
  assert.equal(f.store.listResourceLeases({ status: "active", attemptId: fence.attemptId }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active", attemptId: fence.attemptId }).length, 0);
  assert.deepEqual(f.lifecycle.commitDelegatedChildInterrupted(input), result);
});

test("resume retains child Run and deadline, creates a monotonic Attempt, and needs real acceptance again", async t => {
  const f = await fixture(t, true), previous = await stopped(f);
  const input = { reservationId: f.child.reservation.id, expectedStepRevision: previous.runtime.step.revision,
    runtimeInstanceId: "runtime-2", parentFence: f.fence, callId: "resume-child", now: clock(f) };
  const claimed = f.lifecycle.resumeDelegatedChild(input);
  assert.equal(claimed.run.id, previous.runtime.run.id);
  assert.equal(claimed.run.status, "running");
  assert.equal(claimed.reservation.deadlineAt, f.child.reservation.deadlineAt);
  assert.equal(claimed.step.state, "resuming");
  assert.equal(claimed.workUnit.status, "claimed");
  assert.equal(claimed.attempt.attemptNumber, 2);
  assert.notEqual(claimed.attempt.id, previous.started.attempt.id);
  assert.notEqual(claimed.attempt.fencingToken, previous.started.attempt.fencingToken);
  assert.equal(f.lifecycle.resumeDelegatedChild(input).replayed, true);
  assert.equal(f.store.listWorkUnitAttempts(claimed.workUnit.id).length, 2);
  const originalPlan = f.lifecycle.getDelegatedChildPreparation(f.child.reservation.id);
  assert.equal(originalPlan.payload.sourceFence.attemptId, previous.started.attempt.id);
  const acceptedAt = clock(f);
  const resumed = f.start(claimed, { observation: f.observe(claimed, { observedAt: acceptedAt, observationId: "accepted-resume" }), now: acceptedAt });
  assert.equal(resumed.step.state, "running");
  assert.equal(resumed.step.childRunId, previous.runtime.run.id);
  assert.equal(resumed.attempt.status, "started");
  assert.equal(f.store.getWorkUnitAttempt(previous.started.attempt.id).status, "cancelled");
});

// Regression: response-loss retries of an accepted resume are observations,
// even after Store reconstruction and the original absolute deadline.
test("accepted resume replays from its sealed control fact after Store reconstruction and deadline", async t => {
  const f = await fixture(t, true), previous = await stopped(f);
  const input = { reservationId: f.child.reservation.id, expectedStepRevision: previous.runtime.step.revision,
    runtimeInstanceId: "runtime-2", parentFence: f.fence, callId: "resume-response-loss", now: clock(f) };
  const claimed = f.lifecycle.resumeDelegatedChild(input);
  const acceptedAt = clock(f);
  const resumed = f.start(claimed, { observation: f.observe(claimed,
    { observationId: "accepted-response-loss", observedAt: acceptedAt }), now: acceptedAt });
  const attempts = f.store.listWorkUnitAttempts(resumed.workUnit.id).length;
  const authorizations = f.authorizations();
  const reopened = new SqliteDelegationLifecycleStore({ database: f.db }, f.ports);
  assert.throws(() => reopened.resumeDelegatedChild({ ...input, expectedStepRevision: input.expectedStepRevision + 1 }),
    { code: "delegation.idempotency_conflict" });
  assert.throws(() => reopened.resumeDelegatedChild({ ...input,
    parentFence: { ...input.parentFence, fencingToken: `${BigInt(input.parentFence.fencingToken) + 1n}` } }),
  { code: "delegation.idempotency_conflict" });
  const brokenLineage = new SqliteDelegationLifecycleStore({ database: f.db }, { ...f.ports,
    getWorkUnitAttempt: id => {
      const attempt = f.ports.getWorkUnitAttempt(id);
      return attempt?.id === claimed.attempt.id ? { ...attempt, fencingToken: `${BigInt(attempt.fencingToken) + 1n}` } : attempt;
    } });
  assert.throws(() => brokenLineage.resumeDelegatedChild(input), { code: "delegation.idempotency_conflict" });
  const replayed = reopened.resumeDelegatedChild({ ...input, runtimeInstanceId: "runtime-after-restart",
    now: f.child.reservation.deadlineAt });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.attempt.id, claimed.attempt.id);
  assert.equal(replayed.step.state, "running");
  assert.equal(f.store.listWorkUnitAttempts(resumed.workUnit.id).length, attempts);
  assert.equal(f.authorizations(), authorizations);
});

test("resume current revocation or expired deadline rolls back the new Attempt and step transition", async t => {
  for (const fault of ["revoked", "deadline"]) {
    const f = await fixture(t, true), previous = await stopped(f);
    if (fault === "revoked") f.setCurrentAuthority({ ...f.authority, tools: ["read"], toolDecisions: { read: "allow" } });
    assert.throws(() => f.lifecycle.resumeDelegatedChild({ reservationId: f.child.reservation.id,
      expectedStepRevision: previous.runtime.step.revision, runtimeInstanceId: "runtime-2", parentFence: f.fence,
      callId: `resume-${fault}`,
      now: fault === "deadline" ? f.child.reservation.deadlineAt : clock(f) }),
    { code: fault === "revoked" ? "delegation.capability_escalation" : "delegation.deadline_exceeded" });
    assert.equal(f.store.getDelegationStep(f.child.stepId).state, "interrupted");
    assert.equal(f.store.getWorkUnit(f.child.childWorkUnit.id).status, "cancelled");
    assert.equal(f.store.listWorkUnitAttempts(f.child.childWorkUnit.id).length, 1);
  }
});

async function terminal(f, started = f.start(f.claim())) {
  const fence = toRuntimeAttemptFence(started.attempt);
  await f.store.trackHostAttemptCompletion({ runId: started.run.id, ...fence }, Promise.resolve(), () => true);
  const now = clock(f);
  assert.equal(f.store.transitionRunStatus({ runId: started.run.id, expectedStatus: "running", event: "runner_succeeded", actor: "system",
    idempotencyKey: "test-terminal-run", now, endedAt: now }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "runner_succeeded", actor: "system",
    idempotencyKey: "test-terminal-unit", now, endedAt: now }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "succeeded", now, endedAt: now }));
  f.writer.settleDelegatedChild({ reservationId: f.child.reservation.id,
    receipt: f.childReceipt({ kind: "verified_usage", childRunId: started.run.id, sourceFence: fence }), now });
  return { started, fence, now };
}

// Regression: a completed child and a later resume must not erase the durable
// response of an older resume call or create another Attempt.
test("terminal and successor attempts preserve old resume response-loss replay", async t => {
  const terminalFixture = await fixture(t, true), previous = await stopped(terminalFixture);
  const input = { reservationId: terminalFixture.child.reservation.id,
    expectedStepRevision: previous.runtime.step.revision, runtimeInstanceId: "runtime-2",
    parentFence: terminalFixture.fence, callId: "resume-terminal-response-loss", now: clock(terminalFixture) };
  const claimed = terminalFixture.lifecycle.resumeDelegatedChild(input);
  const terminalAcceptedAt = clock(terminalFixture);
  const resumed = terminalFixture.start(claimed, {
    observation: terminalFixture.observe(claimed,
      { observationId: "accepted-terminal-response-loss", observedAt: terminalAcceptedAt }), now: terminalAcceptedAt });
  const ended = await terminal(terminalFixture, resumed);
  terminalFixture.lifecycle.commitDelegatedChildTerminal({ reservationId: terminalFixture.child.reservation.id,
    sourceFence: ended.fence, now: ended.now });
  const terminalAttempts = terminalFixture.store.listWorkUnitAttempts(resumed.workUnit.id).length;
  const terminalReplay = terminalFixture.lifecycle.resumeDelegatedChild({ ...input, now: terminalFixture.child.reservation.deadlineAt });
  assert.equal(terminalReplay.replayed, true);
  assert.equal(terminalReplay.attempt.id, claimed.attempt.id);
  assert.equal(terminalReplay.step.state, "succeeded");
  assert.equal(terminalFixture.store.listWorkUnitAttempts(resumed.workUnit.id).length, terminalAttempts);

  const successorFixture = await fixture(t, true), firstStopped = await stopped(successorFixture);
  const firstInput = { reservationId: successorFixture.child.reservation.id,
    expectedStepRevision: firstStopped.runtime.step.revision, runtimeInstanceId: "runtime-2",
    parentFence: successorFixture.fence, callId: "resume-before-successor", now: clock(successorFixture) };
  const firstClaim = successorFixture.lifecycle.resumeDelegatedChild(firstInput);
  const successorAcceptedAt = clock(successorFixture);
  const firstResume = successorFixture.start(firstClaim, {
    observation: successorFixture.observe(firstClaim,
      { observationId: "accepted-before-successor", observedAt: successorAcceptedAt }), now: successorAcceptedAt });
  const firstFence = toRuntimeAttemptFence(firstResume.attempt);
  await successorFixture.store.trackHostAttemptCompletion({ runId: firstResume.run.id, ...firstFence }, Promise.resolve(), () => true);
  successorFixture.lifecycle.requestDelegatedChildInterrupt({ reservationId: successorFixture.child.reservation.id,
    parentFence: successorFixture.fence, callId: "interrupt-before-successor", now: clock(successorFixture) });
  const interrupted = successorFixture.lifecycle.commitDelegatedChildInterrupted({ reservationId: successorFixture.child.reservation.id,
    sourceFence: firstFence, now: clock(successorFixture) });
  successorFixture.lifecycle.resumeDelegatedChild({ reservationId: successorFixture.child.reservation.id,
    expectedStepRevision: interrupted.step.revision, runtimeInstanceId: "runtime-3", parentFence: successorFixture.fence,
    callId: "resume-successor", now: clock(successorFixture) });
  const successorAttempts = successorFixture.store.listWorkUnitAttempts(firstResume.workUnit.id).length;
  const oldReplay = successorFixture.lifecycle.resumeDelegatedChild(firstInput);
  assert.equal(oldReplay.replayed, true);
  assert.equal(oldReplay.attempt.id, firstClaim.attempt.id);
  assert.equal(oldReplay.step.state, "resuming");
  assert.equal(successorFixture.store.listWorkUnitAttempts(firstResume.workUnit.id).length, successorAttempts);
});

test("a terminal delegated Host source projects runId away before the strict stopped-handoff check", async t => {
  const f = await fixture(t, true), started = f.start(f.claim());
  const fence = toRuntimeAttemptFence(started.attempt), source = { runId: started.run.id, ...fence };
  assert.ok(f.store.acquireResourceLease({ ...source, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "channel",
    resourceKey: "terminal-delegation-owned", ownerType: "work_unit_attempt", ownerId: fence.attemptId,
    acquiredAt: clock(f), expiresAt: "2099-01-01T00:00:00.000Z" }));
  assert.ok(f.store.acquireRuntimeSemaphoreSlot({ ...source, workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "runner",
    resourceKey: "terminal-pi", limit: 2, ownerType: "work_unit_attempt", ownerId: fence.attemptId,
    acquiredAt: clock(f), expiresAt: "2099-01-01T00:00:00.000Z" }));
  await f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => true);
  const now = clock(f);
  assert.equal(f.store.transitionRunStatus({ runId: started.run.id, expectedStatus: "running", event: "runner_succeeded", actor: "system",
    idempotencyKey: "terminal-source-run", now, endedAt: now }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "runner_succeeded", actor: "system",
    idempotencyKey: "terminal-source-unit", now, endedAt: now }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "succeeded", now, endedAt: now }));
  f.store.releaseHostAttemptResources(source, now);
  assert.equal(f.store.listResourceLeases({ status: "active", attemptId: fence.attemptId }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active", attemptId: fence.attemptId }).length, 0);
});

test("terminal commits a sealed Host result and step together, with exact response-loss replay", async t => {
  const f = await fixture(t, true), ended = await terminal(f);
  const input = { reservationId: f.child.reservation.id, sourceFence: ended.fence, now: ended.now };
  const result = f.lifecycle.commitDelegatedChildTerminal(input);
  assert.equal(result.step.state, "succeeded");
  const messages = f.store.listDelegationMessages(f.child.stepId).filter(message => message.kind === "result");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, "child_to_parent");
  const artifact = f.store.getArtifact(messages[0].bodyArtifactId);
  assert.equal(artifact.runId, ended.started.run.id);
  assert.equal(artifact.sealedPayload.kind, "delegation.result.v1");
  assert.deepEqual(artifact.sealedPayload.sourceFence, ended.fence);
  assert.equal(artifact.sealedPayload.settlementDigest, result.reservation.settlementDigest);
  assert.deepEqual(artifact.sealedPayload.evidenceRefs.map(ref => ref.kind).sort(), ["delegation_budget_reservation", "host_attempt_completion"]);
  assert.deepEqual(f.lifecycle.commitDelegatedChildTerminal(input), result);
  assert.equal(f.store.listDelegationMessages(f.child.stepId).filter(message => message.kind === "result").length, 1);
});

test("terminal result artifact failure rolls step and message back and permits a clean retry", async t => {
  const f = await fixture(t, true), ended = await terminal(f);
  f.setFaultPort("artifact");
  const input = { reservationId: f.child.reservation.id, sourceFence: ended.fence, now: ended.now };
  assert.throws(() => f.lifecycle.commitDelegatedChildTerminal(input), /injected-artifact-fault/);
  assert.equal(f.store.getDelegationStep(f.child.stepId).state, "running");
  assert.equal(f.store.listDelegationMessages(f.child.stepId).filter(message => message.kind === "result").length, 0);
  f.setFaultPort(undefined);
  assert.equal(f.lifecycle.commitDelegatedChildTerminal(input).step.state, "succeeded");
});
