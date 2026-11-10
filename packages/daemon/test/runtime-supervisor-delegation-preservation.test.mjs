import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveStoragePaths, toRuntimeAttemptFence } from "../../core/dist/index.js";
import { createBudgetHarness, budgetLater } from "../../core/test/support/delegation-budget-fixture.mjs";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

async function fixture(t, state, ownerType = "delegation_step") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-supervisor-delegation-preserve-"));
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  const config = { host: "127.0.0.1", port: 0, maxBodyBytes: 1024 * 1024, defaultWorkspaceCwd: cwd,
    runners: {}, runtimeTools: {}, transports: { providerWebSocketFallback: true, localWebSocketRpc: true }, channels: {} };
  let store = createSqliteRunStore(cwd, paths);
  const original = new RuntimeSupervisor(config), next = new RuntimeSupervisor(config);
  t.after(async () => { original.releaseAll(); next.releaseAll(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const runtime = original.getRuntime(cwd, store);
  const f = createBudgetHarness(cwd, { store });
  f.freeze(); f.start();
  const child = f.spawn(), unitId = child.childWorkUnit.id, runId = child.childRun.id;
  const attempt = store.createWorkUnitAttempt({ workUnitId: unitId, attemptNumber: 1,
    runtimeInstanceId: runtime.runtimeInstanceId, runnerId: "pi", status: "created", now: budgetLater });
  const fence = toRuntimeAttemptFence(attempt);
  // Persisted crash-window fixtures, not invented Host stop/drain evidence.
  store.database.prepare("UPDATE work_units SET status=?,owner_type=? WHERE id=?").run(state, ownerType, unitId);
  store.database.prepare("UPDATE work_unit_attempts SET status=?,abort_requested_at=? WHERE id=?")
    .run(state === "claimed" ? "created" : state === "cancelling" ? "cancelling" : "started",
      state === "cancelling" ? budgetLater : null, attempt.id);
  store.database.prepare("UPDATE run_sessions SET status=? WHERE id=?")
    .run(state === "claimed" ? "queued" : state === "waiting_for_approval" ? state : "running", runId);
  if (state !== "claimed") {
    store.database.prepare("UPDATE delegation_steps SET state='running',child_run_id=?,revision=revision+1 WHERE id=?").run(runId, child.stepId);
    if (state === "cancelling" || state === "waiting_for_approval") {
      store.database.prepare("UPDATE delegation_steps SET state=?,revision=revision+1 WHERE id=?")
        .run(state === "cancelling" ? "interrupting" : "waiting", child.stepId);
    }
  }
  const source = { ...fence, workspaceId: DEFAULT_WORKSPACE_ID, ownerType: "work_unit_attempt", ownerId: attempt.id,
    acquiredAt: budgetLater, expiresAt: "2026-10-19T00:00:02.000Z" };
  assert.ok(store.acquireResourceLease({ ...source, resourceType: "channel", resourceKey: "isolated-child" }));
  assert.ok(store.acquireRuntimeSemaphoreSlot({ ...source, resourceType: "runner", resourceKey: "pi", limit: 1 }));
  for (const [table, id] of [["run_sessions", "root"], ["work_units", "root-unit"], ["work_unit_attempts", "root-attempt"]]) {
    store.database.prepare(`UPDATE ${table} SET status='succeeded',ended_at=? WHERE id=?`).run(budgetLater, id);
  }
  original.releaseAll(); store.close();
  store = createSqliteRunStore(cwd, paths);
  const db = store.database;
  const scopes = [
    ["run_sessions", "id", runId], ["work_units", "id", unitId], ["work_unit_attempts", "work_unit_id", unitId],
    ["resource_leases", "work_unit_id", unitId], ["runtime_semaphore_slots", "work_unit_id", unitId],
    ["delegation_steps", "id", child.stepId], ["delegation_budget_reservations", "child_run_id", runId],
    ["delegation_root_budgets", "root_run_id", "root"], ["delegation_budget_charges", "root_run_id", "root"],
    ["host_attempt_completions", "run_id", runId], ["runtime_events", "work_unit_id", unitId],
    ["run_events", "run_id", runId],
  ];
  db.exec("CREATE TEMP TABLE preserved_write_audit(table_name TEXT, operation TEXT)");
  for (const [index, [table, column, id]] of scopes.entries()) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TEMP TRIGGER preserved_${index}_${operation} AFTER ${operation} ON ${table}
        WHEN ${row}.${column}='${id}' BEGIN INSERT INTO preserved_write_audit VALUES('${table}','${operation}'); END`);
    }
  }
  const snapshot = () => scopes.map(([table, column, id]) => [table, db.prepare(`SELECT * FROM ${table} WHERE ${column}=? ORDER BY 1`).all(id)]);
  return { store, db, next, cwd, runId, unitId, attemptId: attempt.id, snapshot };
}

for (const state of ["claimed", "running", "waiting_for_approval", "cancelling"]) {
  test(`Supervisor restart preserves ${state} delegated owner without reclassifying loss or expiring its resources`, async t => {
    const f = await fixture(t, state), before = f.snapshot();
    f.next.getRuntime(f.cwd, f.store);
    f.next.getRuntime(f.cwd, f.store);
    assert.equal(f.store.recoverStaleRuns(new Date().toISOString()), 0);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.db.prepare("SELECT * FROM preserved_write_audit").all(), []);
    assert.equal(f.store.getWorkUnit(f.unitId).status, state);
    assert.equal(f.store.listWorkUnitAttempts(f.unitId).length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM host_attempt_completions WHERE run_id=?").get(f.runId).n, 0);
  });
}

for (const state of ["claimed", "running", "cancelling"]) {
  test(`Supervisor retains normal startup stale reconciliation for an ordinary ${state} owner`, async t => {
    const f = await fixture(t, state, "run");
    f.next.getRuntime(f.cwd, f.store);
    assert.equal(f.store.getWorkUnit(f.unitId).status, "stale");
    assert.equal(f.store.getWorkUnitAttempt(f.attemptId).status, "lost");
    assert.ok(f.store.getWorkUnitAttempt(f.attemptId).endedAt);
    assert.equal(f.store.getWorkUnit(f.unitId).errorMessage, "runtime-startup-reconcile");
  });
}
