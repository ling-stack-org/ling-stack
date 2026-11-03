import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore, resolveStoragePaths } from "../dist/index.js";
import { createDelegationHostStoreBinding, captureDelegationHostStoreBinding } from "../dist/delegation-host-store-bridge.js";
import { createBudgetHarness, budgetNow, budgetLater } from "./support/delegation-budget-fixture.mjs";
import { prepareSuspensionSource } from "./support/run-suspension-integration-fixture.mjs";

const readers = () => ({
  readCapture() { throw new Error("fixture-unused"); },
  readCurrentAuthority() { throw new Error("fixture-unused"); },
  readUsageReceipt() { throw new Error("fixture-unused"); },
  readChildReceipt() { throw new Error("fixture-unused"); },
});
const denied = operation => assert.throws(operation, { code: "delegation.authority_invalid" });
async function directory(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-host-binding-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("delegation writer custody rejects JSON, premature access, and reused constructor ownership", async t => {
  const cwd = await directory(t);
  denied(() => captureDelegationHostStoreBinding({}, {}));
  const host = createDelegationHostStoreBinding(readers());
  denied(host.writer);
  const store = new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace, delegationHostBinding: host.binding });
  t.after(() => store.close());
  assert.equal(host.writer().getRootDelegationBudget("not-created"), undefined);
  denied(() => new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace, delegationHostBinding: host.binding }));
  assert.equal("freezeRootDelegationBudget" in store, false);
  assert.equal("delegationHostBinding" in store, false);
});

test("closing the exact Store retires both the accessor and already-retained writer methods", async t => {
  const cwd = await directory(t), host = createDelegationHostStoreBinding(readers());
  const store = new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace, delegationHostBinding: host.binding });
  const retained = host.writer(), get = retained.getRootDelegationBudget;
  assert.equal(Object.isFrozen(retained), true);
  store.close();
  denied(host.writer);
  denied(() => get("not-created"));
  denied(() => retained.prepareDelegatedChild({}));
  denied(() => new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace, delegationHostBinding: host.binding }));
});

test("suspension schema and mutation custody are installed only behind the original constructor binding", async t => {
  const cwd = await directory(t), host = createDelegationHostStoreBinding(readers());
  const store = new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace, delegationHostBinding: host.binding });
  const retained = host.writer();
  for (const name of ["requestRunSuspension", "sealRunSuspension", "getRunSuspensionForAttempt", "getRunSuspension",
    "beginRunSuspensionStop", "commitRunSuspensionStopped", "getRunSuspensionStop", "acknowledgeRootRunSuspensionStart", "getRootRunSuspensionStart",
    "activateDelegatedRunSuspension", "getDelegatedRunSuspensionActivation", "getDelegatedRunSuspensionStart"]) {
    assert.equal(name in store, false, `${name} is not a public RunStore capability`);
    assert.equal(typeof retained[name], "function");
  }
  assert.equal(store.database.prepare("SELECT name FROM schema_migrations WHERE version=182").get().name, "create_host_run_suspensions_v1");
  assert.equal(retained.getRunSuspension("missing"), undefined);
  assert.equal(retained.getRunSuspensionForAttempt("missing"), undefined);
  assert.equal(retained.getRunSuspensionStop("missing"), undefined);
  assert.equal(retained.getDelegatedRunSuspensionActivation("missing"), undefined);
  assert.equal(retained.getDelegatedRunSuspensionStart("missing"), undefined);
  assert.equal(store.database.prepare("SELECT version FROM schema_migrations WHERE version=183").get().version, 183);
  store.close();
  for (const name of ["requestRunSuspension", "sealRunSuspension", "getRunSuspensionForAttempt", "getRunSuspension",
    "beginRunSuspensionStop", "commitRunSuspensionStopped", "getRunSuspensionStop", "acknowledgeRootRunSuspensionStart", "getRootRunSuspensionStart",
    "activateDelegatedRunSuspension", "getDelegatedRunSuspensionActivation", "getDelegatedRunSuspensionStart"])
    denied(() => retained[name]({}));
});

test("startup captures authority functions rather than accepting later callback replacement", () => {
  const source = readers(), original = {};
  source.readCapture = () => original;
  const host = createDelegationHostStoreBinding(source);
  source.readCapture = () => { throw new Error("replaced"); };
  const captured = captureDelegationHostStoreBinding(host.binding, {});
  assert.equal(captured.readers.readCapture({}), original);
  captured.retire();
  denied(() => captured.install({}));
});

test("real SqliteRunStore Host composition joins the claim transaction and never creates a second Attempt on replay", async t => {
  const cwd = await directory(t);
  let fixture;
  const host = createDelegationHostStoreBinding({
    readCapture: reference => fixture.ports.readCapture(reference),
    readCurrentAuthority: (...args) => fixture.ports.readCurrentAuthority(...args),
    readUsageReceipt: reference => fixture.ports.readUsageReceipt(reference),
    readChildReceipt: reference => fixture.ports.readChildReceipt(reference),
  });
  const store = new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace, delegationHostBinding: host.binding });
  t.after(() => store.close());
  fixture = createBudgetHarness(cwd, { store });
  const writer = host.writer();
  writer.freezeRootDelegationBudget({ runId: fixture.root.id, sourceFence: fixture.fence,
    capture: fixture.rootCapture, now: budgetNow });
  fixture.start();
  const child = writer.prepareDelegatedChild({ parentRunId: fixture.root.id, sourceFence: fixture.fence,
    spawnCallId: "composition-spawn", objective: "Inspect the QA fixture", requestedBudget: { tokenBudget: 40 },
    required: true, capture: fixture.rootCapture, now: budgetLater });
  const input = { reservationId: child.reservation.id, expectedStepRevision: 0, runtimeInstanceId: "runtime", now: budgetLater };
  const claimed = writer.claimDelegatedChild(input);
  assert.equal(claimed.replayed, false);
  assert.equal(claimed.run.status, "queued");
  assert.equal(claimed.workUnit.status, "claimed");
  assert.equal(claimed.attempt.status, "created");
  assert.equal(claimed.step.childRunId, undefined);
  const replay = writer.claimDelegatedChild(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.attempt.id, claimed.attempt.id);
  assert.equal(store.listWorkUnitAttempts(child.childWorkUnit.id).length, 1);
  assert.equal(store.database.isTransaction, false);
});

async function suspensionFixture(t) {
  const cwd = await directory(t); let fixture;
  const host = createDelegationHostStoreBinding({
    readCapture: ref => fixture.ports.readCapture(ref), readCurrentAuthority: (...args) => fixture.ports.readCurrentAuthority(...args),
    readUsageReceipt: ref => fixture.ports.readUsageReceipt(ref), readChildReceipt: ref => fixture.ports.readChildReceipt(ref) });
  const store = new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace, delegationHostBinding: host.binding });
  t.after(() => { if (store.database.isOpen) store.close(); });
  fixture = createBudgetHarness(cwd, { store }); fixture.freeze(); fixture.start();
  const source = prepareSuspensionSource(fixture, budgetLater);
  return { ...fixture, host, writer: host.writer(), source };
}

test("original constructor writer seals an actual verified ordinary view and records no stopped outcome", async t => {
  const f = await suspensionFixture(t), request = f.writer.requestRunSuspension(f.source.input);
  assert.equal(f.writer.getRunSuspensionForAttempt(f.fence.attemptId).id, request.id);
  const committed = f.store.commitRunProgressCheckpoint({ runId: f.root.id, sourceFence: f.fence,
    sourceEventSeq: f.store.listEvents(f.root.id).at(-1).seq, expectedHead: { checkpointId: null, revision: 0 },
    expectedLineage: f.source.lineage, modelView: f.source.view, now: budgetLater });
  assert.equal(committed.kind, "committed", JSON.stringify(committed));
  const verified = f.store.readRunProgressCheckpointForRecovery({ runId: f.root.id, sourceFence: f.fence, expectedLineage: f.source.lineage });
  assert.equal(verified.kind, "verified", JSON.stringify(verified));
  const sealed = f.writer.sealRunSuspension({ suspensionId: request.id, sourceFence: f.fence,
    witness: { kind: "ordinary", checkpoint: verified.witness }, now: budgetLater });
  assert.equal(sealed.state, "sealed"); assert.deepEqual(f.writer.getRunSuspension(sealed.id), sealed);
  assert.equal(f.store.getRun(f.root.id).status, "running"); assert.equal(f.store.getWorkUnit(f.unit.id).status, "running");
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 1);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM runner_continuations").get().n, 0);
});

test("pending source closes new child/model/claim admissions atomically but permits response replay and usage settlement", async t => {
  const f = await suspensionFixture(t), child = f.spawn({ spawnCallId: "before-suspend" }), charge = f.charge();
  const beforeDeadline = f.writer.getRootDelegationBudget(f.root.id).deadlineAt;
  f.writer.requestRunSuspension(f.source.input);
  const counts = () => ["delegation_budget_reservations", "delegation_budget_charges", "work_unit_attempts", "run_sessions", "artifacts"]
    .map(table => f.store.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  const before = counts();
  assert.throws(() => f.spawn({ spawnCallId: "new-after-suspend" }), /suspension.admission_closed/);
  assert.throws(() => f.charge({ invocationId: "new-after-suspend" }), /suspension.admission_closed/);
  assert.throws(() => f.writer.claimDelegatedChild({ reservationId: child.reservation.id,
    expectedStepRevision: 0, runtimeInstanceId: "runtime", now: budgetLater }), /suspension.admission_closed/);
  assert.deepEqual(counts(), before, "failed claim rolls back even a newly-created Attempt");
  assert.equal(f.spawn({ spawnCallId: "before-suspend" }).reservation.id, child.reservation.id);
  assert.equal(f.charge().id, charge.id);
  const measured = f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: budgetLater });
  assert.equal(measured.state, "measured"); assert.equal(f.writer.getRootDelegationBudget(f.root.id).deadlineAt, beforeDeadline);
  assert.equal(f.store.getWorkUnit(child.childWorkUnit.id).status, "queued");
});

test("original constructor writer completes the exact root suspension transaction without exposing mutations on public Store", async t => {
  const f = await suspensionFixture(t), now = () => new Date().toISOString();
  await f.store.trackHostAttemptCompletion({ runId: f.root.id, ...f.fence }, Promise.resolve(), () => true);
  const request = f.writer.requestRunSuspension({ ...f.source.input, now: now() });
  assert.equal(f.store.commitRunProgressCheckpoint({ runId: f.root.id, sourceFence: f.fence,
    sourceEventSeq: f.store.listEvents(f.root.id).at(-1).seq, expectedHead: { checkpointId: null, revision: 0 },
    expectedLineage: f.source.lineage, modelView: f.source.view, now: now() }).kind, "committed");
  const verified = f.store.readRunProgressCheckpointForRecovery({ runId: f.root.id, sourceFence: f.fence, expectedLineage: f.source.lineage });
  const sealed = f.writer.sealRunSuspension({ suspensionId: request.id, sourceFence: f.fence,
    witness: { kind: "ordinary", checkpoint: verified.witness }, now: now() });
  const input = { suspensionId: sealed.id, sourceFence: f.fence, now: now() }, begun = f.writer.beginRunSuspensionStop(input);
  assert.equal(begun.state, "stopping");
  const stopped = f.writer.commitRunSuspensionStopped({ ...input, now: now() });
  assert.equal(stopped.state, "stopped"); assert.deepEqual(f.writer.getRunSuspensionStop(sealed.id), stopped);
  assert.equal(f.store.getRun(f.root.id).status, "running"); assert.equal(f.store.getWorkUnit(f.unit.id).status, "stale");
  assert.equal(f.store.hasPendingRunSuspension({ runId: f.root.id, ...f.fence }), true);
});

test("a pending suspension vetoes a new failed/cancelled terminal disposition, not its own checkpoint producer", async t => {
  const f = await suspensionFixture(t);
  f.writer.requestRunSuspension(f.source.input);
  const before = f.store.database.prepare("SELECT COUNT(*) n FROM artifacts").get().n;
  for (const desiredOutcome of ["failed", "cancelled"]) assert.throws(() => f.writer.prepareRunTerminalIntent({
    runId: f.root.id, sourceFence: f.fence, desiredOutcome, errorCode: "new-disposition", errorMessage: "Must not replace suspension", now: budgetLater }),
  /suspension.admission_closed/);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM run_terminal_intents").get().n, 0);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) n FROM artifacts").get().n, before);
});
