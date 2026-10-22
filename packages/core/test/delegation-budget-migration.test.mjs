import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDelegationMigration } from "../dist/storage/sqlite/delegation-migration.js";
import { applyDelegationBudgetMigration, DELEGATION_BUDGET_MIGRATION_VERSION, DELEGATION_BUDGET_MIGRATION_NAME, DELEGATION_BUDGET_SCHEMA_OBJECTS } from "../dist/storage/sqlite/delegation-budget-migration.js";

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

test("176 installs durable ledger, preserves all migration 154 SQL/trigger bytes and reopens idempotently", async t => {
  const f = await fixture(t), old = oldSchema(f.db);
  assert.equal(DELEGATION_BUDGET_MIGRATION_VERSION, 176);
  assert.equal(f.apply(), true);
  assert.deepEqual(oldSchema(f.db), old);
  assert.equal(f.apply(), false);
  assert.equal(f.reopen().apply(), false);
  for (const name of DELEGATION_BUDGET_SCHEMA_OBJECTS) assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), name);
  assert.equal(f.db.prepare("SELECT name FROM schema_migrations WHERE version=176").get().name, DELEGATION_BUDGET_MIGRATION_NAME);
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
    assert.equal(f.db.prepare("SELECT 1 FROM schema_migrations WHERE version=176").get(), undefined);
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
