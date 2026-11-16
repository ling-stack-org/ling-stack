import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteRuntimeSemaphoreStore } from "../dist/storage/sqlite/runtime-semaphore-store.js";
import { hasActiveWorkflowMergeApplyLease } from "../dist/storage/sqlite/workflow-merge-lease-guard.js";
import { admissionSnapshot, workflowAdmissionFixture } from "./support/workflow-step-admission-fixture.mjs";

const resourceTypes = ["provider", "runner", "channel_parallel", "media_provider", "workflow_resource"];
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const unchanged = (db, action) => {
  const before = admissionSnapshot({ database: db });
  const result = action();
  assert.deepEqual(admissionSnapshot({ database: db }), before);
  return result;
};

async function runtimeFixture(t, { overlay = true } = {}) {
  const f = await workflowAdmissionFixture(t), db = f.store.database;
  f.mergeScope = f.scope("runtime-apply-guard");
  f.actor = f.outsider("runtime-apply-guard");
  f.runtime = new SqliteRuntimeSemaphoreStore({ database: db });
  f.peerRuntime = new SqliteRuntimeSemaphoreStore({ database: f.peer.database });
  f.peer.database.exec("PRAGMA busy_timeout=1");
  f.slot = (overrides = {}) => f.slotInput(f.actor,
    { resourceType: "provider", resourceKey: "runtime-provider", limit: 4 }, overrides);

  // Only the guard's relational projection, not issued authority or a migration208 test.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_merge_apply_permits'").get()) {
    assert.equal(rows(db, "workflow_merge_apply_permits").length, 0);
    db.exec("DROP TABLE workflow_merge_apply_permits");
  }
  db.prepare("DELETE FROM schema_migrations WHERE version=208").run();
  if (overlay) db.exec(`CREATE TABLE workflow_merge_apply_permits (
    permit_id TEXT PRIMARY KEY,lease_id TEXT UNIQUE REFERENCES resource_leases(id),
    round_id TEXT,generation INTEGER,created_at TEXT,expires_at TEXT
  )`);
  f.seedPermit = ({ inputsJson } = {}) => {
    const lease = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId,
      resourceType: "bound_path", resourceKey: f.cwd, ownerType: "system", ownerId: "runtime-apply-permit",
      acquiredAt: f.at(-10), expiresAt: f.at(-1) });
    assert.ok(lease);
    db.prepare(`INSERT INTO workflow_integration_rounds(round_id,workflow_id,current_generation,created_at)
      VALUES('runtime-apply-round',?,1,?)`).run(f.mergeScope.workflow.id, f.at(-10));
    db.prepare(`INSERT INTO workflow_integration_generations(round_id,generation,revision,inputs_json,inputs_digest,
      phase,last_confirmed_phase,created_at,updated_at)
      VALUES('runtime-apply-round',1,0,?,'runtime-apply-inputs','applying','awaiting_approval',?,?)`)
      .run(inputsJson ?? JSON.stringify({ canonicalWorkspaceId: lease.workspaceId, target: { executionRoot: lease.resourceKey } }),
        f.at(-10), f.at(-10));
    db.prepare(`INSERT INTO workflow_merge_apply_permits(permit_id,lease_id,round_id,generation,created_at,expires_at)
      VALUES(?,?,'runtime-apply-round',1,?,?)`).run(lease.ownerId, lease.id, lease.acquiredAt, lease.expiresAt);
    return lease;
  };
  return f;
}

function callerTransaction(db, peer, action) {
  db.exec("CREATE TABLE runtime_admission_probe(id TEXT PRIMARY KEY); BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO runtime_admission_probe VALUES(?)").run("before");
    db.exec("SAVEPOINT caller_admission");
    action();
    assert.equal(db.isTransaction, true, "admission must not finish the caller's transaction");
    assert.deepEqual(rows(db, "runtime_admission_probe").map(row => row.id), ["before"]);
    db.prepare("INSERT INTO runtime_admission_probe VALUES(?)").run("after");
    db.exec("RELEASE caller_admission; COMMIT");
    assert.deepEqual(rows(peer, "runtime_admission_probe").map(row => row.id), ["before", "after"]);
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
  }
}

test("apply ownership blocks every ordinary runtime resource and both supported owner types", async t => {
  const f = await runtimeFixture(t), db = f.store.database;
  f.seedPermit();
  for (const resourceType of resourceTypes) {
    for (const ownerType of ["work_unit_attempt", "system"]) {
      const input = f.slot({ resourceType, resourceKey: `unrelated:${resourceType}`, ownerType,
        ownerId: ownerType === "system" ? "ordinary-system" : f.actor.attempt.id, limit: 999 });
      assert.equal(unchanged(db, () => f.store.acquireRuntimeSemaphoreSlot(input)), undefined);
    }
    assert.deepEqual(unchanged(db, () => f.runtime.ensureRuntimeSemaphoreSlotForAttempt(f.slot({
      resourceType, resourceKey: `exact:${resourceType}`, limit: 999 }))), { status: "changed" });
  }
  assert.equal(f.count("runtime_semaphore_slots"), 0);
});

for (const mode of ["readonly", "no-task", "media"]) {
  test(`the ordinary acquire API also blocks a real ${mode} Run without a Task`, async t => {
    const f = await runtimeFixture(t), db = f.store.database;
    const run = f.store.createRun({ id: `runtime-${mode}`, cwd: f.cwd, taskId: `runtime-${mode}-without-task`,
      providerName: "fixture", providerModel: "fixture",
      taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: { cwd: f.cwd, ...(mode === "readonly" ? { readonly: true } : {}) },
      createdAt: f.at(3) });
    const unit = f.store.createWorkUnit({ workspaceId: f.channel.workspaceId, kind: "conversation_run",
      ownerType: "run", ownerId: run.id, idempotencyKey: `runtime-${mode}`, createdByActor: "system", request: {}, now: f.at(3) });
    f.store.linkRunToWorkUnit(run.id, unit.id, f.at(3));
    const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: `runtime-${mode}`, runnerId: "pi", now: f.at(3) });
    const input = f.slot({ workUnitId: unit.id, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken, ownerId: attempt.id,
      resourceType: mode === "media" ? "media_provider" : "provider", resourceKey: mode });
    assert.equal(f.store.getTask(f.store.getRun(run.id).taskId), undefined);
    assert.equal(f.count("tasks"), 0);
    const ordinary = f.store.acquireRuntimeSemaphoreSlot(input);
    assert.ok(ordinary, "the Run's fence is admissible before apply ownership");
    f.seedPermit();
    assert.equal(unchanged(db, () => f.store.acquireRuntimeSemaphoreSlot({ ...input, resourceKey: `${mode}:new` })), undefined);
  });
}

test("exact Attempt reuse is rejected before returning an existing slot", async t => {
  const f = await runtimeFixture(t), db = f.store.database, input = f.slot();
  const first = f.runtime.ensureRuntimeSemaphoreSlotForAttempt(input);
  assert.equal(first.status, "acquired");
  assert.deepEqual(f.runtime.ensureRuntimeSemaphoreSlotForAttempt(input), { status: "existing", slot: first.slot });
  f.seedPermit();
  assert.deepEqual(unchanged(db, () => f.runtime.ensureRuntimeSemaphoreSlotForAttempt(input)), { status: "changed" });
  callerTransaction(db, f.peer.database, () => {
    assert.deepEqual(unchanged(db, () => f.runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(input)), { status: "changed" });
    assert.deepEqual(unchanged(db, () => f.runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(
      { ...input, resourceKey: "new-within-transaction" }, "caller-reservation")), { status: "changed" });
  });
  assert.equal(f.count("runtime_semaphore_slots"), 1);
});

test("a permit created in the caller's transaction blocks within-transaction admission without discarding it", async t => {
  const f = await runtimeFixture(t), db = f.store.database;
  callerTransaction(db, f.peer.database, () => {
    f.seedPermit();
    assert.equal(hasActiveWorkflowMergeApplyLease(f.peer.database, f.channel.workspaceId), false);
    for (const resourceType of resourceTypes) {
      assert.deepEqual(unchanged(db, () => f.runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(
        f.slot({ resourceType, resourceKey: `within:${resourceType}` }), "caller-reservation")), { status: "changed" });
    }
    assert.equal(hasActiveWorkflowMergeApplyLease(db, f.channel.workspaceId), true);
  });
  assert.equal(hasActiveWorkflowMergeApplyLease(f.peer.database, f.channel.workspaceId), true);
  assert.equal(f.count("runtime_semaphore_slots"), 0);
});

test("expired apply evidence stays active through cleanup and SQLite reopen", async t => {
  const f = await runtimeFixture(t), lease = f.seedPermit(), input = f.slot({ acquiredAt: f.at(10_000), expiresAt: f.at(10_100) });
  assert.equal(f.store.expireResourceLeases(f.at(10_000)), 0);
  assert.equal(f.runtime.expireRuntimeSemaphoreSlots(f.at(10_000)), 0);
  f.store.close();
  const db = new DatabaseSync(f.paths.databasePath);
  try {
    const runtime = new SqliteRuntimeSemaphoreStore({ database: db });
    assert.equal(hasActiveWorkflowMergeApplyLease(db, f.channel.workspaceId), true);
    assert.equal(unchanged(db, () => runtime.acquireRuntimeSemaphoreSlot(input)), undefined);
    assert.deepEqual(unchanged(db, () => runtime.ensureRuntimeSemaphoreSlotForAttempt(input)), { status: "changed" });
    callerTransaction(db, f.peer.database, () => {
      assert.deepEqual(unchanged(db, () => runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(input)), { status: "changed" });
    });
    assert.equal(db.prepare("SELECT status FROM resource_leases WHERE id=?").get(lease.id).status, "active");
    assert.deepEqual(rows(db, "workflow_merge_apply_permits").map(row => row.lease_id), [lease.id]);
  } finally { db.close(); }
});

for (const overlay of [false, true]) {
  test(`ordinary admission and exact reuse remain usable with ${overlay ? "an empty overlay" : "legacy no208 storage"}`, async t => {
    const f = await runtimeFixture(t, { overlay }), db = f.store.database, input = f.slot();
    assert.equal(hasActiveWorkflowMergeApplyLease(db, input.workspaceId), false);
    const first = f.store.acquireRuntimeSemaphoreSlot(input);
    assert.ok(first);
    assert.deepEqual(f.runtime.ensureRuntimeSemaphoreSlotForAttempt(input), { status: "existing", slot: first });
    assert.equal(f.runtime.ensureRuntimeSemaphoreSlotForAttempt({ ...input, resourceKey: "new-exact" }).status, "acquired");
    callerTransaction(db, f.peer.database, () => {
      assert.equal(f.runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction({ ...input, resourceKey: "new-within" }).status, "acquired");
      assert.deepEqual(f.runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(input), { status: "existing", slot: first });
    });
    assert.equal(f.count("runtime_semaphore_slots"), 3);
  });
}

test("a valid foreign-workspace permit does not block any runtime admission entry point", async t => {
  const f = await runtimeFixture(t), db = f.store.database;
  f.seedPermit();
  db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('runtime-foreign','Foreign',?,?)").run(f.at(0), f.at(0));
  db.prepare("UPDATE work_units SET workspace_id='runtime-foreign' WHERE id=?").run(f.actor.unit.id);
  const input = f.slot({ workspaceId: "runtime-foreign" });
  assert.equal(hasActiveWorkflowMergeApplyLease(db, f.channel.workspaceId), true);
  assert.equal(hasActiveWorkflowMergeApplyLease(db, input.workspaceId), false);
  const first = f.store.acquireRuntimeSemaphoreSlot(input);
  assert.ok(first);
  assert.deepEqual(f.runtime.ensureRuntimeSemaphoreSlotForAttempt(input), { status: "existing", slot: first });
  assert.equal(f.runtime.ensureRuntimeSemaphoreSlotForAttempt({ ...input, resourceKey: "foreign-exact" }).status, "acquired");
  callerTransaction(db, f.peer.database, () => {
    assert.equal(f.runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction({ ...input, resourceKey: "foreign-within" }).status, "acquired");
    assert.deepEqual(f.runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(input), { status: "existing", slot: first });
  });
});

test("a valid released apply lease no longer blocks ordinary admission or reuse", async t => {
  const f = await runtimeFixture(t), db = f.store.database, lease = f.seedPermit(), input = f.slot();
  // Represents dedicated apply settlement after observing a stop, not TTL-based release.
  db.prepare("UPDATE resource_leases SET status='released',released_at=? WHERE id=?").run(f.at(5), lease.id);
  const first = f.store.acquireRuntimeSemaphoreSlot(input);
  assert.ok(first);
  assert.deepEqual(f.runtime.ensureRuntimeSemaphoreSlotForAttempt(input), { status: "existing", slot: first });
  callerTransaction(db, f.peer.database, () => {
    assert.equal(f.runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction({ ...input, resourceKey: "released-within" }).status, "acquired");
  });
});

for (const corrupt of ["lease-owner", "lease-expired", "missing-lease", "scope-json", "permit-schema", "permit-view"]) {
  test(`damaged apply evidence fails closed for new slots and reuse while preserving the caller transaction: ${corrupt}`, async t => {
    const f = await runtimeFixture(t), db = f.store.database, input = f.slot();
    assert.equal(f.runtime.ensureRuntimeSemaphoreSlotForAttempt(input).status, "acquired");
    // Fault injection models damaged on-disk JSON without updating an immutable generation.
    if (corrupt === "scope-json") db.exec("PRAGMA ignore_check_constraints=ON");
    const lease = f.seedPermit({ inputsJson: corrupt === "scope-json" ? "broken" : undefined });
    if (corrupt === "lease-owner") db.prepare("UPDATE resource_leases SET owner_id='wrong' WHERE id=?").run(lease.id);
    if (corrupt === "lease-expired") db.prepare("UPDATE resource_leases SET status='expired' WHERE id=?").run(lease.id);
    if (corrupt === "missing-lease") {
      db.exec("PRAGMA foreign_keys=OFF");
      db.prepare("UPDATE workflow_merge_apply_permits SET lease_id='missing'").run();
    }
    if (corrupt === "permit-schema") db.exec("DROP TABLE workflow_merge_apply_permits; CREATE TABLE workflow_merge_apply_permits(lease_id TEXT)");
    if (corrupt === "permit-view") db.exec("DROP TABLE workflow_merge_apply_permits; CREATE VIEW workflow_merge_apply_permits AS SELECT 'missing' AS lease_id");
    assert.throws(() => hasActiveWorkflowMergeApplyLease(db, input.workspaceId));
    assert.equal(unchanged(db, () => f.store.acquireRuntimeSemaphoreSlot({ ...input, resourceKey: "corrupt-acquire" })), undefined);
    assert.deepEqual(unchanged(db, () => f.runtime.ensureRuntimeSemaphoreSlotForAttempt(input)), { status: "changed" });
    assert.deepEqual(unchanged(db, () => f.runtime.ensureRuntimeSemaphoreSlotForAttempt({ ...input, resourceKey: "corrupt-exact" })), { status: "changed" });
    callerTransaction(db, f.peer.database, () => {
      for (const resourceKey of [input.resourceKey, "corrupt-within"]) {
        assert.deepEqual(unchanged(db, () => f.runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(
          { ...input, resourceKey }, "caller-reservation")), { status: "changed" });
      }
    });
    assert.equal(f.count("runtime_semaphore_slots"), 1);
  });
}

test("competing SQLite writers cannot use a stale read to bypass uncommitted apply ownership", async t => {
  const f = await runtimeFixture(t), db = f.store.database, input = f.slot();
  assert.equal(hasActiveWorkflowMergeApplyLease(f.peer.database, input.workspaceId), false);
  db.exec("BEGIN IMMEDIATE");
  try {
    f.seedPermit();
    assert.equal(hasActiveWorkflowMergeApplyLease(f.peer.database, input.workspaceId), false);
    assert.equal(f.peer.acquireRuntimeSemaphoreSlot(input), undefined);
    assert.deepEqual(f.peerRuntime.ensureRuntimeSemaphoreSlotForAttempt(input), { status: "changed" });
    assert.equal(f.peer.database.isTransaction, false);
    assert.equal(db.isTransaction, true);
    db.exec("COMMIT");
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
  assert.equal(unchanged(f.peer.database, () => f.peer.acquireRuntimeSemaphoreSlot(input)), undefined);
  assert.deepEqual(unchanged(f.peer.database, () => f.peerRuntime.ensureRuntimeSemaphoreSlotForAttempt(input)), { status: "changed" });
  assert.equal(f.count("runtime_semaphore_slots"), 0);
});

test("the caller can roll back an apply permit after a within-transaction veto and ordinary admission recovers", async t => {
  const f = await runtimeFixture(t), db = f.store.database, input = f.slot();
  db.exec("BEGIN IMMEDIATE");
  try {
    f.seedPermit();
    assert.deepEqual(f.runtime.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(input), { status: "changed" });
    assert.equal(db.isTransaction, true);
    assert.equal(rows(db, "workflow_merge_apply_permits").length, 1);
    db.exec("ROLLBACK");
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
  assert.equal(hasActiveWorkflowMergeApplyLease(f.peer.database, input.workspaceId), false);
  assert.equal(rows(f.peer.database, "resource_leases").length, 0);
  assert.ok(f.peer.acquireRuntimeSemaphoreSlot(input));
});
