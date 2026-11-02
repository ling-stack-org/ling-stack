import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveStoragePaths, toRuntimeAttemptFence } from "../dist/index.js";
import { createBudgetHarness, budgetLater } from "./support/delegation-budget-fixture.mjs";

const restartAt = "2026-10-22T00:00:00.000Z";

async function fixture(t, state, ownerType = "delegation_step") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-core-delegation-preserve-"));
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  let store = createSqliteRunStore(cwd, paths);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const f = createBudgetHarness(cwd, { store });
  f.freeze(); f.start();
  const child = f.spawn(), unitId = child.childWorkUnit.id, runId = child.childRun.id;
  const attempt = store.createWorkUnitAttempt({ workUnitId: unitId, attemptNumber: 1,
    runtimeInstanceId: "original-daemon", runnerId: "pi", status: "created", now: budgetLater });
  const fence = toRuntimeAttemptFence(attempt);
  // Seed abandoned persisted states only. There is deliberately no original
  // completion/stop receipt, checkpoint, live parent, or permission to resume.
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
  // The parent is historical, not a second active recovery candidate.
  store.database.prepare("UPDATE run_sessions SET status='succeeded',ended_at=? WHERE id='root'").run(budgetLater);
  store.database.prepare("UPDATE work_units SET status='succeeded',ended_at=? WHERE id='root-unit'").run(budgetLater);
  store.database.prepare("UPDATE work_unit_attempts SET status='succeeded',ended_at=? WHERE id='root-attempt'").run(budgetLater);
  store.close();
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
  return { store, db, runId, unitId, snapshot };
}

for (const state of ["claimed", "running", "waiting_for_approval", "cancelling"]) {
  test(`Core startup preserves ${state} delegated ownership without stop proof or ledger/resource writes`, async t => {
    const f = await fixture(t, state), before = f.snapshot();
    assert.equal(f.store.recoverStaleRuns(restartAt), 0);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.db.prepare("SELECT * FROM preserved_write_audit").all(), []);
    assert.equal(f.store.getWorkUnit(f.unitId).status, state);
    assert.equal(f.db.prepare("SELECT state FROM delegation_budget_reservations WHERE child_run_id=?").get(f.runId).state, "reserved");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM host_attempt_completions WHERE run_id=?").get(f.runId).n, 0);
  });
}

test("Core startup still fails an abandoned ordinary owner instead of treating task_run shape as delegation authority", async t => {
  const f = await fixture(t, "running", "run");
  assert.equal(f.store.recoverStaleRuns(restartAt), 1);
  assert.equal(f.store.getRun(f.runId).status, "failed");
  assert.equal(f.store.listEvents(f.runId).filter(event => event.type === "run_error").length, 1);
});
