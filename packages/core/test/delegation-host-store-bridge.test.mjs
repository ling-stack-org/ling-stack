import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRunStore, resolveStoragePaths } from "../dist/index.js";
import { createDelegationHostStoreBinding, captureDelegationHostStoreBinding } from "../dist/delegation-host-store-bridge.js";
import { createBudgetHarness, budgetNow, budgetLater } from "./support/delegation-budget-fixture.mjs";

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
