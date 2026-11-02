import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkflowIsolationMigration, WORKFLOW_ISOLATION_MIGRATION_VERSION } from "../dist/storage/sqlite/workflow-isolation-migration.js";
import { isolationTables, workflowIsolationFixture } from "./support/workflow-isolation-fixture.mjs";

const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const markers = db => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const snapshot = db => ({ schema: schema(db), markers: markers(db) });
const has = db => version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
const record = db => (version, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, "2026-11-02T00:00:00.000Z");
const migrate = (db, extra = {}) => applyWorkflowIsolationMigration({ database: db, hasMigration: has(db), recordMigration: record(db), ...extra });

/** Reconstruct the actual predecessor, not a marker153/203 with the204 overlay left installed. */
async function predecessor(t) {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  assert.ok(isolationTables.every(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 0));
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    for (const table of [...isolationTables].reverse()) db.exec(`DROP TABLE ${table}`);
    db.prepare("DELETE FROM schema_migrations WHERE version=204").run();
  } finally { db.exec("PRAGMA foreign_keys=ON"); }
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 203);
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=203").get().name, "workflow_step_preparing_admission");
  assert.equal(schema(db).some(row => isolationTables.includes(row.tbl_name)), false);
  return f;
}

test("fresh Core SQLite installs independent204 tables, real foreign keys and exactly one marker", async t => {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  assert.equal(WORKFLOW_ISOLATION_MIGRATION_VERSION, 204);
  assert.deepEqual(db.prepare("SELECT version,name FROM schema_migrations WHERE version=204 OR name='workflow_isolation_foundation'").all(),
    [{ version: 204, name: "workflow_isolation_foundation" }].map(v => Object.assign(Object.create(null), v)));
  for (const table of isolationTables) {
    assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table).type, "table");
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), []);
    assert.ok(db.prepare(`PRAGMA foreign_key_list(${table})`).all().length > 0, `${table} must have real FK constraints`);
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(workflow_isolation_intents)").all();
  for (const from of ["writer_binding_id", "work_unit_id", "attempt_id", "runtime_instance_id", "fencing_token"])
    assert.ok(foreignKeys.some(row => row.table === "workflow_isolation_bindings" && row.from === from));
  const before = snapshot(db); migrate(db); assert.deepEqual(snapshot(db), before);
});

test("real203 schema upgrades additively, preserves old data, and reopens through the actual Core constructor", async t => {
  const f = await predecessor(t), db = f.store.database, beforeSchema = schema(db), beforeData = f.snapshot(), beforeMarkers = markers(db);
  migrate(db);
  assert.deepEqual(schema(db).filter(row => !isolationTables.includes(row.tbl_name)), beforeSchema);
  assert.deepEqual(f.snapshot(), beforeData);
  assert.deepEqual(markers(db).filter(row => row.version !== 204), beforeMarkers);
  const installed = snapshot(db);
  f.reopenIsolation();
  assert.deepEqual(snapshot(f.store.database), installed);
  assert.deepEqual(f.snapshot(), beforeData);
  f.create(); f.persistPin(); f.bind(); f.link();
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, requireReady: false, now: f.at(7) }).status, "current");
  f.reopenIsolation();
  assert.deepEqual(f.isolation.getScopePlan(f.plan.planId).planDigest, f.plan.planDigest);
});

for (const failure of ["throw-after-marker", "missing-marker", "wrong-marker", "deferred-commit-fk"]) {
  test(`migration204 rolls back every DDL and marker on ${failure}`, async t => {
    const f = await predecessor(t), db = f.store.database;
    if (failure === "deferred-commit-fk") {
      db.exec("CREATE TABLE migration204_fault (id TEXT REFERENCES channel_workflows(id) DEFERRABLE INITIALLY DEFERRED)");
      db.exec("CREATE TRIGGER migration204_fault_on_marker AFTER INSERT ON schema_migrations WHEN NEW.version=204"
        + " BEGIN INSERT INTO migration204_fault VALUES('missing-workflow'); END");
    }
    const before = snapshot(db), beforeData = f.snapshot();
    const write = (version, name) => {
      if (failure === "missing-marker") return;
      record(db)(version, failure === "wrong-marker" ? "foreign204" : name);
      if (failure === "throw-after-marker") throw new Error("migration204-after-marker");
    };
    assert.throws(() => migrate(db, { recordMigration: write }), /migration204-after-marker|migration_postcondition|migration_marker_conflict|FOREIGN KEY/);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(f.snapshot(), beforeData);
    if (failure === "deferred-commit-fk") db.exec("DROP TRIGGER migration204_fault_on_marker");
    migrate(db);
    assert.equal(has(db)(204), true);
  });
}

test("migration204 never adopts or rolls back a foreign transaction", async t => {
  const f = await predecessor(t), db = f.store.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
    assert.throws(() => migrate(db), /transaction/i);
    assert.equal(db.isTransaction, true);
    assert.equal(db.prepare("SELECT title FROM channel_workflows WHERE id=?").get(f.plan.workflowId).title, "caller-wip");
    assert.equal(has(db)(204), false);
  } finally { db.exec("ROLLBACK"); }
  migrate(db);
});

for (const corruption of ["predecessor-missing", "predecessor-renamed", "marker-renamed", "marker-duplicate", "callback-disagrees"]) {
  test(`migration204 rejects ${corruption} without repairing or claiming foreign authority`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    if (corruption === "predecessor-missing") db.prepare("DELETE FROM schema_migrations WHERE version=203").run();
    if (corruption === "predecessor-renamed") db.prepare("UPDATE schema_migrations SET name='foreign203' WHERE version=203").run();
    if (corruption === "marker-renamed") db.prepare("UPDATE schema_migrations SET name='foreign204' WHERE version=204").run();
    if (corruption === "marker-duplicate") record(db)(205, "workflow_isolation_foundation");
    const before = snapshot(db);
    assert.throws(() => migrate(db, corruption === "callback-disagrees" ? { hasMigration: () => false } : {}), /migration_predecessor_missing|migration_marker_conflict/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.isTransaction, false);
  });
}

for (const object of ["trg_workflow_isolation_plan_immutable", "idx_workflow_isolation_receipt_confirmed", "workflow_isolation_commands"]) {
  test(`reopen rejects a204 marker with missing ${object}`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    const row = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(object);
    db.exec(`DROP ${row.type.toUpperCase()} ${object}`);
    const before = snapshot(db);
    assert.throws(() => migrate(db), /migration_schema_missing/);
    assert.deepEqual(snapshot(db), before);
    assert.throws(() => f.reopenIsolation(), /migration_schema_missing/);
  });
}

for (const corruption of ["check", "foreign-key", "index", "trigger", "unexpected-index", "unexpected-trigger", "fk-data"]) {
  test(`strict204 schema verification rejects damaged ${corruption}`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    if (corruption === "check" || corruption === "foreign-key") {
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE name='workflow_isolation_commands'").get().sql;
      const changed = corruption === "check" ? original.replace(" CHECK(json_valid(result_json))", "")
        : original.replace(" REFERENCES workflow_isolation_bindings(binding_id)", "");
      assert.notEqual(changed, original);
      db.exec("DROP TABLE workflow_isolation_commands"); db.exec(changed);
    }
    if (corruption === "index") {
      db.exec("DROP INDEX idx_workflow_isolation_receipt_confirmed");
      db.exec("CREATE INDEX idx_workflow_isolation_receipt_confirmed ON workflow_isolation_receipts(intent_id)");
    }
    if (corruption === "trigger") {
      db.exec("DROP TRIGGER trg_workflow_isolation_plan_immutable");
      db.exec("CREATE TRIGGER trg_workflow_isolation_plan_immutable BEFORE UPDATE ON workflow_isolation_scope_plans BEGIN SELECT 1; END");
    }
    if (corruption === "unexpected-index") db.exec("CREATE INDEX foreign204_index ON workflow_isolation_bindings(status)");
    if (corruption === "unexpected-trigger") db.exec("CREATE TRIGGER foreign204_trigger BEFORE INSERT ON workflow_isolation_bindings BEGIN SELECT 1; END");
    if (corruption === "fk-data") {
      db.exec("PRAGMA foreign_keys=OFF");
      try { db.prepare("INSERT INTO workflow_integration_rounds VALUES('orphan','missing-workflow',1,?)").run(f.at(0)); }
      finally { db.exec("PRAGMA foreign_keys=ON"); }
    }
    const before = snapshot(db);
    assert.throws(() => migrate(db), /migration_schema_conflict|migration_schema_missing|migration_unexpected_object|migration_fk_conflict/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.isTransaction, false);
  });
}

function rejected(db, action, message = /constraint|immutable/i) {
  db.exec("SAVEPOINT invalid_isolation_write");
  try { assert.throws(action, message); }
  finally { db.exec("ROLLBACK TO invalid_isolation_write"); db.exec("RELEASE invalid_isolation_write"); }
}
function insertCopy(db, table, row, change) {
  const next = { ...row, ...change }, columns = Object.keys(next);
  db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(key => next[key]));
}

test("real SQLite constraints reject orphan identities, invalid phases/revisions/JSON, plan edits and fence forgery", async t => {
  const f = await workflowIsolationFixture(t); f.bind(); f.link(); const db = f.store.database;
  const plan = db.prepare("SELECT * FROM workflow_isolation_scope_plans").get();
  const binding = db.prepare("SELECT * FROM workflow_isolation_bindings").get();
  const round = db.prepare("SELECT * FROM workflow_integration_generations").get();
  const before = f.snapshotIsolation();
  for (const currentGeneration of [0, -1, "not-integer"])
    rejected(db, () => db.prepare("INSERT INTO workflow_integration_rounds VALUES(?,?,?,?)").run("bad-round", f.plan.workflowId, currentGeneration, f.at(0)));
  rejected(db, () => db.prepare("INSERT INTO workflow_integration_rounds VALUES('orphan','missing-workflow',1,?)").run(f.at(0)), /FOREIGN KEY/);
  for (const change of [{ generation: 0 }, { generation: 2, revision: -1 }, { generation: 2, phase: "model-approved" }, { generation: 2, inputs_json: "not-json" }])
    rejected(db, () => insertCopy(db, "workflow_integration_generations", round, change));
  for (const change of [{ plan_id: "copy-root" }, { plan_id: "copy-id", execution_root: "/different", worktree_id: "different", branch_ref: "refs/heads/different" }])
    rejected(db, () => insertCopy(db, "workflow_isolation_scope_plans", plan, change));
  rejected(db, () => db.prepare("UPDATE workflow_isolation_scope_plans SET plan_digest='forged'").run(), /plan_immutable/);
  rejected(db, () => db.prepare("UPDATE workflow_isolation_bindings SET fencing_token='999',revision=revision+1").run(), /binding_immutable/);
  rejected(db, () => db.prepare("UPDATE workflow_isolation_bindings SET revision=revision+2").run(), /binding_immutable/);
  rejected(db, () => db.prepare("UPDATE workflow_isolation_bindings SET status='ready',revision=revision+1").run());
  rejected(db, () => insertCopy(db, "workflow_isolation_bindings", binding, { binding_id: "forged", plan_id: "missing-plan", attempt_id: "missing-attempt" }), /FOREIGN KEY/);
  const intent = f.intent(), intentRow = db.prepare("SELECT * FROM workflow_isolation_intents").get();
  for (const change of [{ fencing_token: "999" }, { runtime_instance_id: "other" }, { scope_binding_id: "other" },
    { scope_type: "round", scope_binding_id: null, round_id: null }, { status: "invented" }, { before_json: "not-json" }])
    rejected(db, () => insertCopy(db, "workflow_isolation_intents", intentRow, { intent_id: "bad-intent", command_id: "bad-command", ...change }));
  const receipt = f.receipt(intent), receiptRow = db.prepare("SELECT * FROM workflow_isolation_receipts").get();
  rejected(db, () => insertCopy(db, "workflow_isolation_receipts", receiptRow, { receipt_id: "second-confirmed" }), /UNIQUE/);
  rejected(db, () => insertCopy(db, "workflow_isolation_receipts", receiptRow, { receipt_id: "orphan", intent_id: "missing-intent", outcome: "blocked" }), /FOREIGN KEY/);
  rejected(db, () => db.prepare("UPDATE workflow_isolation_receipts SET outcome='blocked' WHERE receipt_id=?").run(receipt.receiptId), /journal_immutable/);
  rejected(db, () => db.prepare("UPDATE workflow_isolation_intents SET status='pending' WHERE intent_id=?").run(intent.intentId), /intent_immutable/);
  assert.deepEqual(before.workflow_isolation_scope_plans, f.snapshotIsolation().workflow_isolation_scope_plans);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
