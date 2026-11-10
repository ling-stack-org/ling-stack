import assert from "node:assert/strict";
import test from "node:test";
import { createDelegationLifecycleAuthority } from "../dist/features/harness/delegations/lifecycle-authority.js";
import { createDelegationLifecycleCoordinator } from "../dist/features/harness/delegations/coordinator.js";

const now = "2026-10-19T00:00:00.000Z";
const fence = { workUnitId: "child-unit", attemptId: "child-attempt", runtimeInstanceId: "runtime", fencingToken: "1" };
function fixture() {
  const accepted = new WeakMap();
  const reference = {};
  accepted.set(reference, { childRunId: "child", sourceFence: fence, runnerId: "pi", observationId: "start-1", observedAt: now });
  const custody = createDelegationLifecycleAuthority({ readAcceptedRunnerStart(token) {
    assert.ok(accepted.has(token), "a real adapter reference is required by the Host source");
    return accepted.get(token);
  } });
  let claims = 0, dispatches = 0, commits = 0, stops = 0, replayed = false, runtimeKind = "dispatch_outcome_unknown";
  let behavior = async (_child, accept) => accept(reference), rejectCommit = false;
  const child = { step: { id: "step", state: "spawning" }, reservation: { id: "reservation", deadlineAt: "2026-10-19T00:01:00.000Z", state: "reserved" },
    run: { id: "child" }, workUnit: { id: fence.workUnitId },
    attempt: { id: fence.attemptId, workUnitId: fence.workUnitId, runtimeInstanceId: fence.runtimeInstanceId, fencingToken: fence.fencingToken }, replayed };
  const store = {
    claimDelegatedChild() { claims++; return { ...child, replayed }; },
    commitDelegatedChildStart(input) { commits++; custody.readRunnerStartObservation(input.observation);
      if (rejectCommit) throw new Error("start commit rejected"); runtimeKind = "running"; return { ...child, step: { ...child.step, state: "running" } }; },
    appendDelegationInstruction(input) { return input; },
    classifyDelegatedChildRecovery() { return { kind: runtimeKind, runtime: child }; },
  };
  const ports = { store, runtimeInstanceId: "runtime", now: () => now,
    dispatch: async (...args) => { dispatches++; return behavior(...args); }, captureStart: custody.captureStart,
    stopAfterRejectedStart: async () => { stops++; },
    waitForChange: async (_id, timeout) => new Promise(resolve => setTimeout(resolve, timeout)),
  };
  return { custody, child, reference, ports, coordinator: createDelegationLifecycleCoordinator(ports),
    behavior: value => { behavior = value; }, replay: () => { replayed = true; }, reject: () => { rejectCommit = true; },
    counts: () => ({ claims, dispatches, commits, stops }), runtime: kind => { runtimeKind = kind; } };
}

test("Host start custody rejects model DTOs, copies and another Host instance", () => {
  const f = fixture(), receipt = f.custody.captureStart(f.reference);
  assert.equal(f.custody.readRunnerStartObservation(receipt).childRunId, "child");
  for (const value of [{}, { ...receipt }, { childRunId: "child", sourceFence: fence }]) {
    assert.throws(() => f.custody.readRunnerStartObservation(value), { code: "delegation.authority_invalid" });
  }
  assert.throws(() => fixture().custody.readRunnerStartObservation(receipt), { code: "delegation.authority_invalid" });
});

test("one genuine acceptance starts once and concurrent duplicate starts single-flight", async () => {
  const f = fixture();
  const one = f.coordinator.start("reservation", 0), two = f.coordinator.start("reservation", 0);
  assert.equal(one, two);
  assert.equal((await one).status, "started");
  assert.deepEqual(f.counts(), { claims: 1, dispatches: 1, commits: 1, stops: 0 });
});

test("ready text / resolved dispatch without actual acceptance remains recovery-required", async () => {
  const f = fixture(); f.behavior(async () => {});
  const result = await f.coordinator.start("reservation", 0);
  assert.equal(result.status, "recovery_required");
  assert.equal(result.runtime.kind, "dispatch_outcome_unknown");
  assert.deepEqual(f.counts(), { claims: 1, dispatches: 1, commits: 0, stops: 0 });
});

test("a reopened/replayed claim is never dispatched again", async () => {
  const f = fixture(); f.replay();
  assert.equal((await f.coordinator.start("reservation", 0)).status, "recovery_required");
  assert.deepEqual(f.counts(), { claims: 1, dispatches: 0, commits: 0, stops: 0 });
});

test("actual acceptance rejected by SQLite requests physical stop, keeps unresolved claim", async () => {
  const f = fixture(); f.reject();
  assert.equal((await f.coordinator.start("reservation", 0)).status, "recovery_required");
  assert.deepEqual(f.counts(), { claims: 1, dispatches: 1, commits: 1, stops: 1 });
});

test("dispatch errors are not proof that the adapter never started", async () => {
  const f = fixture(); f.behavior(async () => { throw new Error("connection lost after unknown dispatch"); });
  assert.equal((await f.coordinator.start("reservation", 0)).status, "recovery_required");
  assert.deepEqual(f.counts(), { claims: 1, dispatches: 1, commits: 0, stops: 0 });
});

test("a late accepted-start event owns one physical stop even after dispatch already resolved", async () => {
  const f = fixture(); let accept;
  f.behavior(async (_child, callback) => { accept = callback; });
  assert.equal((await f.coordinator.start("reservation", 0)).status, "recovery_required");
  assert.throws(() => accept(f.reference), { code: "delegation.source_attempt_stale" });
  assert.throws(() => accept(f.reference), { code: "delegation.source_attempt_stale" });
  await f.coordinator.drainRejectedStarts();
  assert.deepEqual(f.counts(), { claims: 1, dispatches: 1, commits: 0, stops: 1 });
});

test("an adapter swallowing callback rejection cannot suppress owned physical stop", async () => {
  const f = fixture(); f.reject();
  f.behavior(async (_child, accept) => { try { accept(f.reference); } catch {} });
  assert.equal((await f.coordinator.start("reservation", 0)).status, "recovery_required");
  await f.coordinator.drainRejectedStarts();
  assert.deepEqual(f.counts(), { claims: 1, dispatches: 1, commits: 1, stops: 1 });
});

test("late stop failure is retained and observable by shutdown/recovery drain", async () => {
  const f = fixture(); let accept;
  f.ports.stopAfterRejectedStart = async () => { throw new Error("physical stop remains unverified"); };
  f.behavior(async (_child, callback) => { accept = callback; });
  await f.coordinator.start("reservation", 0);
  assert.throws(() => accept(f.reference), { code: "delegation.source_attempt_stale" });
  await assert.rejects(f.coordinator.drainRejectedStarts(), /physical stop remains unverified/);
  await assert.rejects(f.coordinator.drainRejectedStarts(), /physical stop remains unverified/);
});

test("observation wait timeout never mutates state or releases a reservation", async () => {
  const f = fixture();
  const result = await f.coordinator.wait("reservation", 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.runtime.runtime.reservation.state, "reserved");
  assert.deepEqual(f.counts(), { claims: 0, dispatches: 0, commits: 0, stops: 0 });
  f.runtime("terminal");
  assert.equal((await f.coordinator.wait("reservation", 100)).timedOut, false);
});
