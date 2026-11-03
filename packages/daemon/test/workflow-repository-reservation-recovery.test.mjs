import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteWorkflowIsolationStore } from "@ling-stack/core";
import { installReservationSourceHooks, reservationDist, reservationRecoveryFixture,
  reservationOrdinaryRun, reservationSnapshot, reservationWorker } from "./support/workflow-repository-reservation-recovery-support.mjs";

installReservationSourceHooks();
const { assertWorkflowRepositoryRunAllowed, releaseWorkflowRepositoryFence, reserveWorkflowRepositoryFence }
  = await import(new URL("features/workspaces/workflow-repository-fence.js", reservationDist));
const { planWorkflowIsolatedRound } = await import(new URL("features/channels/workflow-isolation-planning.js", reservationDist));
const { prepareRunConcurrency } = await import(new URL("features/runs/concurrency.js", reservationDist));
const native = { skip: !["darwin", "linux"].includes(process.platform), timeout: 45_000 };

function assertFrozenOnce(f) {
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM workflow_integration_rounds").get().n, 1);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM workflow_isolation_scope_plans").get().n, 2);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM workflow_parallel_parent_fences").get().n, 1);
  assert.equal(reservationSnapshot(f).fence.state, "held");
  assert.throws(() => assertWorkflowRepositoryRunAllowed(f.store, { cwd: f.cwd }),
    error => ["workflow_repository_busy", "workflow_repository_fence_unknown"].includes(error.code));
}

function plan(f) { return planWorkflowIsolatedRound({ ...f.input, store: f.store }); }
function assertRunBlocked(f) {
  assert.throws(() => assertWorkflowRepositoryRunAllowed(f.store, { cwd: f.cwd }), { code: "workflow_repository_busy" });
}

test("SIGKILL before Core freeze permits exact planning retry on the same SQLite database", native, async t => {
  const f = await reservationRecoveryFixture(t), first = reservationWorker(f, { pauseInventory: true });
  assert.deepEqual(await first.next(), { type: "inventory", repositoryWriter: true, inventoryCalls: 1 });
  assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), undefined);
  const before = reservationSnapshot(f);
  assert.equal(before.fence.state, "held");
  assertRunBlocked(f);
  assert.deepEqual(await first.kill(), { code: null, signal: "SIGKILL" });
  assert.deepEqual(reservationSnapshot(f), before, "SQLite rollback retains the committed admission marker");
  assertRunBlocked(f);
  const retry = reservationWorker(f), result = await retry.next();
  await retry.done();
  assert.equal(result.type, "planned", JSON.stringify(result));
  assert.equal(result.roundId, f.input.roundId);
  assert.notEqual(reservationSnapshot(f).owner.reservationToken, before.owner.reservationToken);
  assertFrozenOnce(f);
});

test("SIGKILL after the durable marker but before writer reacquisition is recoverable", native, async t => {
  const f = await reservationRecoveryFixture(t), first = reservationWorker(f, { action: "crash-after-marker" });
  assert.deepEqual(await first.exited, { code: null, signal: "SIGKILL" });
  const before = reservationSnapshot(f);
  assert.equal(before.fence.state, "held");
  assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), undefined);
  assertRunBlocked(f);
  await plan(f);
  assertFrozenOnce(f);
  assert.notEqual(reservationSnapshot(f).owner.reservationToken, before.owner.reservationToken);
});

test("SIGKILL after Core COMMIT keeps Run admission closed before sidecar COMMIT", native, async t => {
  const f = await reservationRecoveryFixture(t), first = reservationWorker(f, { action: "crash-after-freeze" });
  assert.deepEqual(await first.exited, { code: null, signal: "SIGKILL" });
  assertFrozenOnce(f);
  const before = reservationSnapshot(f), round = createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId);
  assert.ok(round);
  await plan(f);
  assertFrozenOnce(f);
  assert.deepEqual(reservationSnapshot(f), before);
  assert.deepEqual(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), round);
  const database = new DatabaseSync(f.fencePath);
  try { assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); }
  finally { database.close(); }
});

test("a real sidecar COMMIT error after Core freeze preserves the durable fence without replay", native, async t => {
  const f = await reservationRecoveryFixture(t), failed = reservationWorker(f, { action: "fail-sidecar-commit" });
  const failure = await failed.next();
  await failed.done();
  assert.equal(failure.type, "error");
  assert.equal(failure.code, "workflow_repository_fence_unknown");
  assert.equal(failure.causeCode, "ERR_SQLITE_ERROR");
  assert.equal(failure.causeErrcode, 5);
  assert.equal(failure.freezeCalls, 1);
  assert.equal(failure.coreCommits, 1);
  assert.deepEqual(failure.commitFailure, { repositoryWriter: true, coreCommits: 1, state: "held",
    journalMode: "delete", code: "ERR_SQLITE_ERROR", errcode: 5 });
  assertFrozenOnce(f);
  assertRunBlocked(f);
  const ordinary = reservationOrdinaryRun(f);
  assert.throws(() => prepareRunConcurrency(ordinary), { code: "workflow_repository_busy", statusCode: 409 });
  const before = reservationSnapshot(f), isolation = createSqliteWorkflowIsolationStore(f.store);
  const durable = () => ({ round: isolation.getIntegrationRound(f.input.roundId),
    plans: f.store.database.prepare("SELECT * FROM workflow_isolation_scope_plans ORDER BY plan_id").all(),
    parents: f.store.database.prepare("SELECT * FROM workflow_parallel_parent_fences ORDER BY round_id,generation").all(),
    steps: f.store.listChannelWorkflowSteps({ workflowId: f.workflow.id, complete: true }) });
  const frozen = durable();
  assert.ok(frozen.round);
  assert.equal(frozen.round.inputs.mode, "candidate_only");
  assert.equal(f.store.listRuns().length, 0);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  const retry = reservationWorker(f), result = await retry.next();
  await retry.done();
  assert.deepEqual(result, { type: "planned", roundId: f.input.roundId, inventoryCalls: 1, freezeCalls: 1, coreCommits: 1 });
  assert.deepEqual(reservationSnapshot(f), before, "an exact retry retains the committed reservation owner");
  assert.deepEqual(durable(), frozen, "an exact retry does not replay frozen plans, pins or parent effects");
  releaseWorkflowRepositoryFence(f.store, f.input.roundId, 1, frozen.round.inputs, undefined, before.owner.reservationToken);
  assert.deepEqual(reservationSnapshot(f), before, "a COMMIT error never grants detached compensation authority");
  assert.throws(() => prepareRunConcurrency(ordinary), { code: "workflow_repository_busy", statusCode: 409 });
  assert.equal(f.store.listRuns().length, 0);
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assertFrozenOnce(f);
});

test("one live writer excludes eight same-owner planners and every detached cleanup", native, async t => {
  const f = await reservationRecoveryFixture(t), winner = reservationWorker(f, { pauseInventory: true });
  assert.deepEqual(await winner.next(), { type: "inventory", repositoryWriter: true, inventoryCalls: 1 });
  const before = reservationSnapshot(f);
  // Contenders run in the test process so there is only one child, even with the live-writer barrier.
  for (let i = 0; i < 8; i++) {
    await assert.rejects(plan(f), { code: "workflow_repository_busy" });
    assert.deepEqual(reservationSnapshot(f), before);
    assertRunBlocked(f);
  }
  assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), undefined);
  winner.resume();
  assert.equal((await winner.next()).type, "planned");
  await winner.done();
  const round = createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId);
  for (const token of [undefined, randomUUID(), before.owner.reservationToken]) {
    releaseWorkflowRepositoryFence(f.store, f.input.roundId, 1, round.inputs, undefined, token);
    assert.deepEqual(reservationSnapshot(f), before, "tokens never override Core's active-round authority");
  }
  assertFrozenOnce(f);
});

test("the final budget await keeps one exact writer owner against competing planners and stale cleanup", native, async t => {
  const f = await reservationRecoveryFixture(t), failed = reservationWorker(f, { action: "fail-before-freeze" });
  const failure = await failed.next();
  await failed.done();
  assert.equal(failure.code, "fixture_reservation_freeze_failed");
  assert.ok(failure.inputs);
  const stale = reservationSnapshot(f);
  assert.equal(stale.fence.state, "released");
  const winner = reservationWorker(f, { pauseBudget: true }), barrier = await winner.next();
  const held = reservationSnapshot(f), isolation = createSqliteWorkflowIsolationStore(f.store);
  assert.deepEqual(barrier, { type: "budget", repositoryWriter: true, inventoryCalls: 2, freezeCalls: 0,
    coreCommits: 0, reservationToken: held.owner.reservationToken });
  assert.notEqual(held.owner.reservationToken, stale.owner.reservationToken);
  assert.equal(held.fence.state, "held");
  assert.equal(isolation.getIntegrationRound(f.input.roundId), undefined);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM workflow_isolation_scope_plans").get().n, 0);
  const ordinary = reservationOrdinaryRun(f);
  const contenders = await Promise.allSettled(Array.from({ length: 8 }, () => plan(f)));
  assert.equal(contenders.length, 8);
  for (const contender of contenders) {
    assert.equal(contender.status, "rejected");
    assert.equal(contender.reason.code, "workflow_repository_busy");
    assert.equal(contender.reason.statusCode, 409);
  }
  for (const token of [undefined, randomUUID(), stale.owner.reservationToken, held.owner.reservationToken]) {
    assert.throws(() => releaseWorkflowRepositoryFence(f.store, f.input.roundId, 1, failure.inputs, undefined, token),
      { code: "workflow_repository_busy", statusCode: 409 });
    assert.deepEqual(reservationSnapshot(f), held);
  }
  assert.throws(() => prepareRunConcurrency(ordinary), { code: "workflow_repository_busy", statusCode: 409 });
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(isolation.getIntegrationRound(f.input.roundId), undefined);
  winner.resume();
  assert.deepEqual(await winner.next(), { type: "planned", roundId: f.input.roundId, inventoryCalls: 2,
    freezeCalls: 1, coreCommits: 1 });
  await winner.done();
  assert.deepEqual(reservationSnapshot(f), held, "only the barrier's exact reservation token freezes Core");
  for (const token of [undefined, randomUUID(), stale.owner.reservationToken, held.owner.reservationToken]) {
    releaseWorkflowRepositoryFence(f.store, f.input.roundId, 1, failure.inputs, undefined, token);
    assert.deepEqual(reservationSnapshot(f), held, "late loser cleanup cannot release the committed winner");
  }
  assertFrozenOnce(f);
  assertRunBlocked(f);
});

test("a live planner losing the COMMIT/re-BEGIN race cannot freeze or release the winner", native, async t => {
  const f = await reservationRecoveryFixture(t), loser = reservationWorker(f, { pauseAfterMarker: true });
  assert.deepEqual(await loser.next(), { type: "marker", repositoryWriter: false });
  const before = reservationSnapshot(f);
  await plan(f);
  const winner = reservationSnapshot(f);
  assert.notEqual(winner.owner.reservationToken, before.owner.reservationToken);
  loser.resumeMarker();
  const rejected = await loser.next();
  await loser.done();
  assert.equal(rejected.code, "workflow_repository_busy");
  assert.deepEqual(reservationSnapshot(f), winner);
  assertFrozenOnce(f);
});

test("failed freeze compensates only its own reservation and stale cleanup cannot release a new planner", native, async t => {
  const f = await reservationRecoveryFixture(t), failed = reservationWorker(f, { action: "fail-before-freeze" });
  const failure = await failed.next();
  await failed.done();
  assert.equal(failure.code, "fixture_reservation_freeze_failed");
  assert.ok(failure.inputs);
  const released = reservationSnapshot(f);
  assert.equal(released.fence.state, "released");
  assertWorkflowRepositoryRunAllowed(f.store, { cwd: f.cwd });
  const winner = reservationWorker(f, { pauseInventory: true });
  assert.deepEqual(await winner.next(), { type: "inventory", repositoryWriter: true, inventoryCalls: 1 });
  const held = reservationSnapshot(f);
  assert.notEqual(held.owner.reservationToken, released.owner.reservationToken);
  for (const token of [undefined, released.owner.reservationToken, held.owner.reservationToken]) {
    assert.throws(() => releaseWorkflowRepositoryFence(f.store, f.input.roundId, 1, failure.inputs, undefined, token),
      { code: "workflow_repository_busy" });
    assert.deepEqual(reservationSnapshot(f), held);
  }
  await winner.kill();
  for (const token of [released.owner.reservationToken, held.owner.reservationToken]) {
    releaseWorkflowRepositoryFence(f.store, f.input.roundId, 1, failure.inputs, undefined, token);
    assert.deepEqual(reservationSnapshot(f), held, "a detached token does not release a recoverable no-round marker");
  }
  await plan(f);
  assertFrozenOnce(f);
});

test("inventory failure releases an unused reservation without freezing Core", native, async t => {
  const f = await reservationRecoveryFixture(t), failed = reservationWorker(f, { pauseInventory: true });
  assert.equal((await failed.next()).repositoryWriter, true);
  failed.resume(true);
  assert.equal((await failed.next()).code, "fixture_reservation_inventory_failed");
  await failed.done();
  assert.equal(reservationSnapshot(f).fence.state, "released");
  assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), undefined);
  assertWorkflowRepositoryRunAllowed(f.store, { cwd: f.cwd });
  await plan(f);
  assertFrozenOnce(f);
});

test("legacy token-only no-round reservations remain fail-closed", native, async t => {
  const f = await reservationRecoveryFixture(t), failed = reservationWorker(f, { action: "fail-before-freeze" });
  const failure = await failed.next();
  await failed.done();
  assert.ok(failure.inputs);
  const token = await reserveWorkflowRepositoryFence(f.store, f.input.roundId, failure.inputs);
  const before = reservationSnapshot(f);
  assert.equal(before.owner.reservationProtocol, undefined);
  await assert.rejects(plan(f), { code: "workflow_repository_busy" });
  assert.deepEqual(reservationSnapshot(f), before);
  assertRunBlocked(f);
  releaseWorkflowRepositoryFence(f.store, f.input.roundId, 1, failure.inputs, undefined, token);
  assert.equal(reservationSnapshot(f).fence.state, "released");
});

for (const malformed of ["missing token", "unknown protocol"]) {
  test(`a no-round marker with ${malformed} cannot be reclaimed or admit a Run`, native, async t => {
    const f = await reservationRecoveryFixture(t), first = reservationWorker(f, { action: "crash-after-marker" });
    assert.deepEqual(await first.exited, { code: null, signal: "SIGKILL" });
    const owner = reservationSnapshot(f).owner;
    if (malformed === "missing token") delete owner.reservationToken;
    else owner.reservationProtocol = "unrecognized_writer";
    const database = new DatabaseSync(f.fencePath);
    try { database.prepare("UPDATE repository_fence SET owner_json=? WHERE singleton=1").run(JSON.stringify(owner)); }
    finally { database.close(); }
    const before = reservationSnapshot(f), code = malformed === "missing token"
      ? "workflow_repository_busy" : "workflow_repository_fence_unknown";
    await assert.rejects(plan(f), { code });
    assert.throws(() => assertWorkflowRepositoryRunAllowed(f.store, { cwd: f.cwd }), { code });
    assert.deepEqual(reservationSnapshot(f), before);
    assert.equal(createSqliteWorkflowIsolationStore(f.store).getIntegrationRound(f.input.roundId), undefined);
  });
}
