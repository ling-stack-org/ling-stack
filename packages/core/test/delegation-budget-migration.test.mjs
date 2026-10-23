import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDelegationMigration } from "../dist/storage/sqlite/delegation-migration.js";
import { applyWorkSummaryMigration } from "../dist/storage/sqlite/work-summary-migration.js";
import { applyDelegationBudgetMigration, DELEGATION_BUDGET_MIGRATION_VERSION, DELEGATION_BUDGET_MIGRATION_NAME, DELEGATION_BUDGET_SCHEMA_OBJECTS } from "../dist/storage/sqlite/delegation-budget-migration.js";
import { createBudgetHarness, budgetLater } from "./support/delegation-budget-fixture.mjs";

const now = "2026-10-19T00:00:00.000Z";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ling-delegation-budget-schema-"));
  const path = join(dir, "schema.sqlite"), db = new DatabaseSync(path), readers = [];
  t.after(async () => { for (const reader of readers) reader.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    CREATE TABLE run_sessions(id TEXT PRIMARY KEY,work_unit_id TEXT,parent_run_id TEXT);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY,run_id TEXT);
    CREATE TABLE work_unit_attempts(id TEXT PRIMARY KEY,work_unit_id TEXT);
    CREATE TABLE channel_workflows(id TEXT PRIMARY KEY);
    CREATE TABLE channel_workflow_steps(id TEXT PRIMARY KEY);
  `);
  const input = database => ({ database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now) });
  applyDelegationMigration(input(db));
  // Real main head markers; 176 must not collide with native execution 169–175.
  for (let version = 155; version <= 175; version++) db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, `fixture-existing-${version}`, now);
  const apply = overrides => applyDelegationBudgetMigration({ ...input(db), ...overrides });
  const reopen = () => { const reader = new DatabaseSync(path); reader.exec("PRAGMA foreign_keys=ON"); readers.push(reader); return { db: reader, apply: () => applyDelegationBudgetMigration(input(reader)) }; };
  return { db, input, apply, reopen };
}
function oldSchema(db) { return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE '%delegation_steps%' OR name LIKE '%delegation_messages%' ORDER BY name").all(); }

// Regression: P3-MERGE-176 — main and E6 assigned migration176 to different domains.
// Found by /qa on 2026-10-24
// Report: output/e6-20260928/p3-main-integration-migration-20261024.md
test("main work-summary176 upgrades without replacing its marker or PR bindings", async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TABLE work_summary_pull_requests(url TEXT PRIMARY KEY,created_at TEXT NOT NULL)");
  f.db.prepare("INSERT INTO work_summary_pull_requests VALUES(?,?)").run("https://github.com/example/repo/pull/9", now);
  f.db.prepare("INSERT INTO schema_migrations VALUES(176,?,?)").run("create_work_summary_pull_requests", now);
  const old = f.db.prepare("SELECT * FROM schema_migrations WHERE version=176").get();
  applyWorkSummaryMigration(f.input(f.db));
  assert.equal(f.apply(), true);
  assert.deepEqual(f.db.prepare("SELECT * FROM schema_migrations WHERE version=176").get(), old);
  assert.equal(f.db.prepare("SELECT name FROM schema_migrations WHERE version=188").get().name, "create_work_summary_pull_requests");
  assert.equal(f.db.prepare("SELECT name FROM schema_migrations WHERE version=189").get().name, DELEGATION_BUDGET_MIGRATION_NAME);
  assert.equal(f.db.prepare("SELECT count(*) n FROM work_summary_pull_requests").get().n, 1);
  assert.equal(f.reopen().apply(), false);
});

test("E6 budget176 appends a canonical marker without rewriting its ledger or history", async t => {
  const f = await fixture(t);
  f.apply();
  f.db.exec("INSERT INTO run_sessions(id) VALUES('legacy-root'); INSERT INTO artifacts VALUES('legacy-authority','legacy-root')");
  f.db.prepare("INSERT INTO delegation_root_budgets VALUES(?,1,?,?,NULL,NULL,?,NULL,?,?,?)")
    .run("legacy-root", "legacy-authority", "a".repeat(64), 321, "2026-10-19T01:00:00.000Z", now, now);
  f.db.prepare("UPDATE schema_migrations SET version=176 WHERE name=?").run(DELEGATION_BUDGET_MIGRATION_NAME);
  const old = f.db.prepare("SELECT * FROM schema_migrations WHERE version=176").get();
  const root = f.db.prepare("SELECT * FROM delegation_root_budgets").get();
  const schema = f.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  assert.equal(f.apply(), true);
  assert.deepEqual(f.db.prepare("SELECT * FROM schema_migrations WHERE version=176").get(), old);
  assert.deepEqual(f.db.prepare("SELECT * FROM delegation_root_budgets").get(), root);
  assert.deepEqual(f.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(), schema);
  assert.equal(f.db.prepare("SELECT name FROM schema_migrations WHERE version=189").get().name, DELEGATION_BUDGET_MIGRATION_NAME);
  assert.equal(f.apply(), false);
});

// Regression: P3-MERGE-LEDGER — FK checks alone adopted corrupt legacy facts.
// Found by /qa independent review on 2026-10-24
// Report: output/e6-20260928/p3-main-integration-migration-20261024.md
for (const markerVersion of [176, 189]) {
  for (const fault of ["negative-budget", "wrong-attempt-owner", "wrong-authority-owner"]) {
    test(`budget${markerVersion} rejects ${fault} without adopting or repairing corrupt history`, async t => {
      const f = await fixture(t); f.apply();
      f.db.exec("INSERT INTO run_sessions VALUES('root','unit',NULL),('other','other-unit',NULL); INSERT INTO artifacts VALUES('authority','root'),('other-authority','other'); INSERT INTO work_unit_attempts VALUES('wrong-attempt','other-unit')");
      f.db.prepare("INSERT INTO delegation_root_budgets VALUES('root',1,'authority',?,NULL,NULL,321,NULL,?,?,?)")
        .run("a".repeat(64), "2026-10-19T01:00:00.000Z", now, now);
      if (markerVersion === 176) f.db.prepare("UPDATE schema_migrations SET version=176 WHERE name=?").run(DELEGATION_BUDGET_MIGRATION_NAME);
      if (fault === "wrong-attempt-owner") {
        f.db.exec("DROP TRIGGER trg_delegation_budget_charges_lineage");
        f.db.prepare(`INSERT INTO delegation_budget_charges(id,schema_version,root_run_id,run_id,attempt_id,invocation_id,request_digest,state,idempotency_key,revision,created_at,updated_at)
          VALUES('bad-charge',1,'root','root','wrong-attempt','invoke',?,'reserved','charge-key',0,?,?)`)
          .run("b".repeat(64), now, now);
      } else {
        const sql = f.db.prepare("SELECT sql FROM sqlite_master WHERE name='trg_delegation_root_budgets_no_update'").get().sql;
        f.db.exec("DROP TRIGGER trg_delegation_root_budgets_no_update; PRAGMA ignore_check_constraints=ON");
        f.db.exec(fault === "negative-budget" ? "UPDATE delegation_root_budgets SET token_budget=-1" : "UPDATE delegation_root_budgets SET authority_artifact_id='other-authority'");
        f.db.exec("PRAGMA ignore_check_constraints=OFF");
        f.db.exec(sql);
      }
      f.db.exec("DROP INDEX idx_delegation_reservations_root_parent");
      const before = f.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
      const markers = f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      const roots = f.db.prepare("SELECT * FROM delegation_root_budgets").all();
      const charges = f.db.prepare("SELECT * FROM delegation_budget_charges").all();
      assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.throws(() => f.apply(), /delegation\.budget_migration_(integrity|lineage)/u);
      assert.deepEqual(f.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(), before);
      assert.deepEqual(f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), markers);
      assert.deepEqual(f.db.prepare("SELECT * FROM delegation_root_budgets").all(), roots);
      assert.deepEqual(f.db.prepare("SELECT * FROM delegation_budget_charges").all(), charges);
      assert.equal(f.db.isTransaction, false);
    });
  }
}

test("legacy adoption and canonical reopen accept real nested and terminal ledger history", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-budget-history-adoption-"));
  const f = createBudgetHarness(cwd);
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.freeze(); f.start();
  const child = f.spawn();
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: child.childWorkUnit.id, attemptNumber: 1,
    runtimeInstanceId: "runtime", runnerId: "pi", status: "created", now: budgetLater });
  f.start(child.childRun.id);
  f.db.prepare("UPDATE delegation_steps SET state='running',child_run_id=?,revision=revision+1,updated_at=? WHERE id=?")
    .run(child.childRun.id, budgetLater, child.stepId);
  const sourceFence = { workUnitId: attempt.workUnitId, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken };
  const capture = f.captureToken({ ...f.capture, budget: undefined, runId: child.childRun.id, sourceFence });
  const grandchild = f.spawn({ parentRunId: child.childRun.id, sourceFence, capture, spawnCallId: "nested", requestedBudget: { tokenBudget: 10 } });
  f.writer.settleDelegatedChild({ reservationId: grandchild.reservation.id,
    receipt: f.childReceipt({ kind: "no_dispatch", childRunId: grandchild.childRun.id }), now: budgetLater });
  const charge = f.charge({ runId: child.childRun.id, sourceFence, capture });
  f.writer.settleModelInvocation({ chargeId: charge.id, receipt: f.receipt(charge), now: budgetLater });
  f.db.prepare("UPDATE run_sessions SET status='succeeded',ended_at=? WHERE id=?").run(budgetLater, child.childRun.id);
  f.db.prepare("UPDATE work_units SET status='succeeded',ended_at=? WHERE id=?").run(budgetLater, child.childWorkUnit.id);
  f.db.prepare("UPDATE work_unit_attempts SET status='succeeded',ended_at=? WHERE id=?").run(budgetLater, attempt.id);
  f.writer.settleDelegatedChild({ reservationId: child.reservation.id,
    receipt: f.childReceipt({ kind: "verified_usage", childRunId: child.childRun.id, sourceFence }), now: budgetLater });
  f.db.prepare("UPDATE schema_migrations SET version=176 WHERE name=?").run(DELEGATION_BUDGET_MIGRATION_NAME);
  const before = f.db.prepare("SELECT * FROM delegation_budget_reservations ORDER BY id").all();
  assert.deepEqual(before.map(row => row.state).sort(), ["released", "settled"]);
  const input = { database: f.db,
    hasMigration: version => Boolean(f.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => f.db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now) };
  assert.equal(applyDelegationBudgetMigration(input), true);
  assert.equal(applyDelegationBudgetMigration(input), false);
  assert.deepEqual(f.db.prepare("SELECT * FROM delegation_budget_reservations ORDER BY id").all(), before);
});

for (const fault of ["root-reservation-over", "root-reservation-null", "parent-reservation-over", "parent-reservation-null", "root-charge-over", "root-charge-null"]) {
  test(`legacy ledger rejects ${fault} without rewriting original allocations`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-budget-cap-adoption-"));
    const f = createBudgetHarness(cwd);
    t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
    f.freeze(); f.start();
    let target;
    if (fault.includes("reservation")) {
      const child = f.spawn(); target = child.reservation.id;
      if (fault.startsWith("parent")) {
        const attempt = f.store.createWorkUnitAttempt({ workUnitId: child.childWorkUnit.id, attemptNumber: 1,
          runtimeInstanceId: "runtime", runnerId: "pi", status: "created", now: budgetLater });
        f.start(child.childRun.id);
        f.db.prepare("UPDATE delegation_steps SET state='running',child_run_id=?,revision=revision+1,updated_at=? WHERE id=?")
          .run(child.childRun.id, budgetLater, child.stepId);
        const sourceFence = { workUnitId: attempt.workUnitId, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken };
        target = f.spawn({ parentRunId: child.childRun.id, sourceFence,
          capture: f.captureToken({ ...f.capture, budget: undefined, runId: child.childRun.id, sourceFence }),
          spawnCallId: "nested", requestedBudget: { tokenBudget: 10 } }).reservation.id;
      }
    } else target = f.charge().id;
    const guards = f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('delegation_steps','delegation_budget_reservations','delegation_budget_charges')").all();
    for (const guard of guards) f.db.exec(`DROP TRIGGER ${guard.name}`);
    const value = fault.endsWith("null") ? null : fault.startsWith("parent") ? 41 : 200;
    if (fault.includes("reservation")) {
      const step = f.db.prepare("SELECT delegation_step_id FROM delegation_budget_reservations WHERE id=?").get(target).delegation_step_id;
      f.db.prepare("UPDATE delegation_steps SET token_budget=? WHERE id=?").run(value, step);
      f.db.prepare("UPDATE delegation_budget_reservations SET token_reserved=? WHERE id=?").run(value, target);
    } else f.db.prepare("UPDATE delegation_budget_charges SET reserved_tokens=? WHERE id=?").run(value, target);
    for (const guard of guards) f.db.exec(guard.sql);
    f.db.prepare("UPDATE schema_migrations SET version=176 WHERE name=?").run(DELEGATION_BUDGET_MIGRATION_NAME);
    const markers = f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    const rows = f.db.prepare(`SELECT * FROM ${fault.includes("reservation") ? "delegation_budget_reservations" : "delegation_budget_charges"} ORDER BY id`).all();
    const input = { database: f.db,
      hasMigration: version => Boolean(f.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
      recordMigration: (version, name) => f.db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now) };
    assert.throws(() => applyDelegationBudgetMigration(input), /delegation\.budget_migration_lineage/u);
    assert.deepEqual(f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), markers);
    assert.deepEqual(f.db.prepare(`SELECT * FROM ${fault.includes("reservation") ? "delegation_budget_reservations" : "delegation_budget_charges"} ORDER BY id`).all(), rows);
  });
}

test("canonical work-summary migration rejects foreign markers and recorded missing or changed tables", async t => {
  for (const fault of ["canonical-owner", "unknown176-owner", "name-at-wrong-version", "missing-legacy", "changed-legacy"]) {
    await t.test(fault, async t => {
      const f = await fixture(t);
      if (fault === "canonical-owner") f.db.prepare("INSERT INTO schema_migrations VALUES(188,?,?)").run("foreign-owner", now);
      else if (fault === "unknown176-owner") f.db.prepare("INSERT INTO schema_migrations VALUES(176,?,?)").run("foreign-owner", now);
      else if (fault === "name-at-wrong-version") f.db.prepare("INSERT INTO schema_migrations VALUES(190,?,?)").run("create_work_summary_pull_requests", now);
      else {
        f.db.prepare("INSERT INTO schema_migrations VALUES(176,?,?)").run("create_work_summary_pull_requests", now);
        if (fault === "changed-legacy") f.db.exec("CREATE TABLE work_summary_pull_requests(url TEXT PRIMARY KEY,created_at TEXT)");
      }
      const markers = f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      assert.throws(() => applyWorkSummaryMigration(f.input(f.db)), /work_summary\.migration_(marker_conflict|table_missing|schema_conflict)/u);
      assert.deepEqual(f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), markers);
      assert.equal(f.db.isTransaction, false);
    });
  }
});

test("work-summary marker failure rolls back a fresh table and leaves caller transactions owned", async t => {
  const f = await fixture(t);
  assert.throws(() => applyWorkSummaryMigration({ ...f.input(f.db), recordMigration() { throw new Error("injected summary marker"); } }), /injected summary marker/);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_summary_pull_requests'").get(), undefined);
  assert.equal(f.db.prepare("SELECT 1 FROM schema_migrations WHERE version=188").get(), undefined);
  f.db.exec("BEGIN IMMEDIATE; INSERT INTO run_sessions(id) VALUES('summary-caller-owned')");
  assert.throws(() => applyWorkSummaryMigration(f.input(f.db)), /cannot start a transaction/);
  assert.equal(f.db.isTransaction, true);
  assert.ok(f.db.prepare("SELECT 1 FROM run_sessions WHERE id='summary-caller-owned'").get());
  f.db.exec("ROLLBACK");
});

test("canonical budget marker failure retains the original E6 marker and ledger", async t => {
  const f = await fixture(t); f.apply();
  f.db.prepare("UPDATE schema_migrations SET version=176 WHERE name=?").run(DELEGATION_BUDGET_MIGRATION_NAME);
  const markers = f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  assert.throws(() => f.apply({ recordMigration() { throw new Error("injected canonical marker"); } }), /injected canonical marker/);
  assert.deepEqual(f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), markers);
  assert.equal(f.db.isTransaction, false);
  assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegation_root_budgets'").get());
  assert.equal(f.apply(), true);
});

test("189 installs durable ledger, preserves all migration 154 SQL/trigger bytes and reopens idempotently", async t => {
  const f = await fixture(t), old = oldSchema(f.db);
  assert.equal(DELEGATION_BUDGET_MIGRATION_VERSION, 189);
  assert.equal(f.apply(), true);
  assert.deepEqual(oldSchema(f.db), old);
  assert.equal(f.apply(), false);
  assert.equal(f.reopen().apply(), false);
  for (const name of DELEGATION_BUDGET_SCHEMA_OBJECTS) assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), name);
  assert.equal(f.db.prepare("SELECT name FROM schema_migrations WHERE version=189").get().name, DELEGATION_BUDGET_MIGRATION_NAME);
});

test("missing derived index/trigger may be recreated but changed constraint text fails closed", async t => {
  const f = await fixture(t); f.apply();
  f.db.exec("DROP INDEX idx_delegation_reservations_root_parent; DROP TRIGGER trg_delegation_budget_charges_no_delete");
  assert.equal(f.apply(), true);
  f.db.exec("DROP TRIGGER trg_delegation_budget_charges_no_delete; CREATE TRIGGER trg_delegation_budget_charges_no_delete BEFORE DELETE ON delegation_budget_charges BEGIN SELECT 1; END");
  assert.throws(() => f.apply(), /budget_migration_schema_conflict/);
});

test("recorded missing authority table is never silently rebuilt", async t => {
  const f = await fixture(t); f.apply();
  f.db.exec("DROP TABLE delegation_budget_charges");
  assert.throws(() => f.apply(), /budget_migration_table_missing/);
});

test("a reused version/name marker is rejected without creating any ledger objects", async t => {
  const f = await fixture(t);
  f.db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(176, "another-owner", now);
  assert.throws(() => f.apply(), /budget_migration_marker_conflict/);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='delegation_root_budgets'").get(), undefined);
});

test("DDL and marker recording failures roll back the entire migration", async t => {
  for (const fault of ["ddl", "marker"]) {
    const f = await fixture(t);
    const database = fault === "ddl" ? {
      prepare: (...args) => f.db.prepare(...args),
      exec: sql => { if (sql.startsWith("CREATE TABLE delegation_budget_charges")) throw new Error("injected DDL"); return f.db.exec(sql); },
    } : f.db;
    assert.throws(() => f.apply({ database, ...(fault === "marker" ? { recordMigration: () => { throw new Error("injected marker"); } } : {}) }), /injected/);
    assert.equal(f.db.prepare("SELECT 1 FROM schema_migrations WHERE version=189").get(), undefined);
    for (const name of DELEGATION_BUDGET_SCHEMA_OBJECTS) assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), undefined);
    assert.equal(f.db.isTransaction, false);
  }
});

test("rejected nested migration BEGIN preserves the caller's owned transaction", async t => {
  const f = await fixture(t);
  f.db.exec("BEGIN IMMEDIATE; INSERT INTO run_sessions(id) VALUES('caller-owned')");
  assert.throws(() => f.apply(), /cannot start a transaction/);
  assert.equal(f.db.isTransaction, true);
  assert.ok(f.db.prepare("SELECT 1 FROM run_sessions WHERE id='caller-owned'").get());
  f.db.exec("ROLLBACK");
});

test("root authority rows reject unsafe budgets, bad time, mutation, deletion and replacement", async t => {
  const f = await fixture(t); f.apply();
  f.db.exec("INSERT INTO run_sessions(id) VALUES('root'); INSERT INTO artifacts VALUES('authority','root')");
  const insert = (budget = 100, deadline = "2026-10-19T01:00:00.000Z", verb = "INSERT") => f.db.prepare(`${verb} INTO delegation_root_budgets VALUES(?,1,?,?,NULL,NULL,?,NULL,?,?,?)`)
    .run("root", "authority", "a".repeat(64), budget, deadline, now, now);
  assert.throws(() => insert(1.5), /CHECK/);
  assert.throws(() => insert(9007199254740992n), /CHECK/);
  assert.throws(() => insert(100, now), /CHECK/);
  assert.throws(() => insert(100, "2026-10-19T01:00:00Z"), /CHECK/);
  insert();
  assert.throws(() => f.db.exec("UPDATE delegation_root_budgets SET token_budget=200"), /immutable/);
  assert.throws(() => f.db.exec("DELETE FROM delegation_root_budgets"), /durable/);
  assert.throws(() => insert(100, "2026-10-19T01:00:00.000Z", "INSERT OR REPLACE"), /cannot be replaced/);
  assert.equal(f.db.prepare("SELECT token_budget FROM delegation_root_budgets").get().token_budget, 100);
});
