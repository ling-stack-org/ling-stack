import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_WORKSPACE_ID } from "../dist/index.js";
import { captureHostRunCapacityWorkspaceIdentity } from "../dist/host-run-capacity-workspace-identity.js";
import { RuntimeHostCapacityBridge } from "../dist/runtime-host-capacity-bridge.js";
import { applyRuntimeHostCapacityMigration } from "../dist/storage/sqlite/runtime-host-capacity-migration.js";
import { SqliteRuntimeHostCapacityStore } from "../dist/storage/sqlite/runtime-host-capacity-store.js";
import { hostCapacityFixture } from "./support/runtime-host-capacity-fixture.ts";
import { budgetLater, budgetNow, createBudgetHarness } from "./support/delegation-budget-fixture.mjs";

async function fixture(t: TestContext, settled: boolean) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-capacity-delegation-release-"));
  const budget = createBudgetHarness(cwd);
  const host = hostCapacityFixture(t);
  t.after(async () => { budget.store.close(); await rm(cwd, { recursive: true, force: true }); });
  applyRuntimeHostCapacityMigration({ database: budget.db,
    hasMigration: version => Boolean(budget.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => budget.db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
      .run(version, name, budgetNow) });
  const identity = captureHostRunCapacityWorkspaceIdentity({ workspaceId: DEFAULT_WORKSPACE_ID,
    cwd, databasePath: budget.store.paths.databasePath });
  const journal = new SqliteRuntimeHostCapacityStore({ database: budget.db }, budget.store, identity);
  const bridge = new RuntimeHostCapacityBridge(journal, host.host);
  const source = { runId: budget.root.id, ...budget.fence };
  const prepared = journal.prepareAttempt({ source, now: budgetNow });
  assert.equal(prepared.status, "prepared");
  const reserved = bridge.reserveAttempt({ source, now: budgetNow });
  assert.equal(reserved.status, "reserved");
  const intentId = reserved.record.intent.intentId;
  budget.db.prepare("UPDATE runtime_host_capacity_intents SET dispatched_at=? WHERE intent_id=?").run(budgetNow, intentId);
  budget.freeze();
  budget.start();
  const lifetime = new Promise<void>(resolve => { (budget as typeof budget & { release?: () => void }).release = resolve; });
  const completion = budget.store.trackHostAttemptCompletion(source, lifetime, () => true);
  const child = budget.spawn();
  if (settled) {
    budget.writer.settleDelegatedChild({ reservationId: child.reservation.id,
      receipt: budget.childReceipt({ kind: "no_dispatch", childRunId: child.childRun.id }), now: budgetLater });
  }
  budget.db.prepare("UPDATE run_sessions SET status='succeeded',started_at=?,ended_at=? WHERE id=?")
    .run(budgetNow, budgetLater, budget.root.id);
  budget.db.prepare("UPDATE work_units SET status='succeeded',started_at=?,ended_at=? WHERE id=?")
    .run(budgetNow, budgetLater, budget.unit.id);
  budget.db.prepare("UPDATE work_unit_attempts SET status='succeeded',started_at=?,ended_at=? WHERE id=?")
    .run(budgetNow, budgetLater, budget.attempt.id);
  (budget as typeof budget & { release?: () => void }).release!();
  await completion;
  return { host, journal, intentId, db: budget.db };
}

test("terminal parent with settled delegation history releases Host capacity", async t => {
  const f = await fixture(t, true);
  const result = f.journal.prepareStoppedRelease({ intentId: f.intentId, now: new Date().toISOString() });
  assert.equal(result.status, "prepared", JSON.stringify(result));
  assert.equal(result.release.kind, "stopped");
});

test("terminal parent with an unsettled delegation reservation retains Host capacity", async t => {
  const f = await fixture(t, false);
  assert.equal(f.journal.prepareStoppedRelease({ intentId: f.intentId, now: budgetLater }).status, "changed");
  assert.equal(f.host.host.counts().held, 1);
});
