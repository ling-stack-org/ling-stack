import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkflowIsolationResultsMigration, WORKFLOW_ISOLATION_RESULTS_MIGRATION_VERSION } from "../dist/storage/sqlite/workflow-isolation-results-migration.js";
import { workflowIsolationFixture } from "./support/workflow-isolation-fixture.mjs";
import { resultTables, workflowIsolationResultsFixture } from "./support/workflow-isolation-results-fixture.mjs";
import { workflowMigrationPredecessorFixture } from "./support/workflow-migration-predecessor-fixture.mjs";

const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const snapshot = db => ({ schema: schema(db), markers: db.prepare("SELECT * FROM schema_migrations ORDER BY version").all() });
const has = db => version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
const record = db => (version, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, "2026-11-02T00:00:00.000Z");
const migrate = (db, extra = {}) => applyWorkflowIsolationResultsMigration({ database: db, hasMigration: has(db), recordMigration: record(db), ...extra });

async function predecessor(t) {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  f.assertFullUpgrade = workflowMigrationPredecessorFixture(f, 205);
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=204").get().name, "workflow_isolation_foundation");
  assert.equal(schema(db).some(row => resultTables.includes(row.tbl_name)), false);
  return f;
}

test("fresh205 installs exact retained journal tables, composite writer FKs and one independent marker", async t => {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  assert.equal(WORKFLOW_ISOLATION_RESULTS_MIGRATION_VERSION, 205);
  assert.deepEqual(db.prepare("SELECT version,name FROM schema_migrations WHERE version=205 OR name='workflow_isolation_terminal_results'").all()
    .map(row => ({ ...row })), [{ version: 205, name: "workflow_isolation_terminal_results" }]);
  for (const table of resultTables) {
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), []);
    const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
    for (const column of ["binding_id", "work_unit_id", "attempt_id", "runtime_instance_id", "fencing_token"])
      assert.ok(keys.some(row => row.from === column), `${table}.${column}`);
  }
  const before = snapshot(db); migrate(db); assert.deepEqual(snapshot(db), before);
});

test("actual204 predecessor upgrades additively, preserves data and reopens through the Core constructor", async t => {
  const f = await predecessor(t), db = f.store.database, before = snapshot(db), data = f.snapshotIsolation();
  migrate(db);
  assert.deepEqual(schema(db).filter(row => !resultTables.includes(row.tbl_name)), before.schema);
  assert.deepEqual(f.snapshotIsolation(), data);
  assert.deepEqual(snapshot(db).markers.filter(row => row.version !== 205), before.markers);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 205);
  const installed = snapshot(db); migrate(db); assert.deepEqual(snapshot(db), installed);
  f.reopenIsolation();
  f.assertFullUpgrade(f.store.database, installed);
  assert.deepEqual(f.snapshotIsolation(), data);
  f.create(); f.persistPin(); f.bind(); f.link();
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, requireReady: false, now: f.at(7) }).status, "current");
});

for (const failure of ["throw-after-marker", "missing-marker", "wrong-marker", "deferred-commit-fk"]) {
  test(`migration205 atomically rolls back DDL and marker on ${failure}`, async t => {
    const f = await predecessor(t), db = f.store.database;
    if (failure === "deferred-commit-fk") {
      db.exec("CREATE TABLE migration205_fault (id TEXT REFERENCES channel_workflows(id) DEFERRABLE INITIALLY DEFERRED)");
      db.exec("CREATE TRIGGER migration205_fault_on_marker AFTER INSERT ON schema_migrations WHEN NEW.version=205 BEGIN INSERT INTO migration205_fault VALUES('missing'); END");
    }
    const before = snapshot(db), data = f.snapshotIsolation();
    assert.throws(() => migrate(db, { recordMigration: (version, name) => {
      if (failure === "missing-marker") return;
      record(db)(version, failure === "wrong-marker" ? "foreign205" : name);
      if (failure === "throw-after-marker") throw new Error("migration205-after-marker");
    } }), /migration205-after-marker|migration_postcondition|migration_marker_conflict|FOREIGN KEY/);
    assert.equal(db.isTransaction, false); assert.deepEqual(snapshot(db), before); assert.deepEqual(f.snapshotIsolation(), data);
    if (failure === "deferred-commit-fk") db.exec("DROP TRIGGER migration205_fault_on_marker");
    migrate(db); assert.equal(has(db)(205), true);
  });
}

test("migration205 never adopts or rolls back the caller transaction", async t => {
  const f = await predecessor(t), db = f.store.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
    assert.throws(() => migrate(db), /transaction/i);
    assert.equal(db.isTransaction, true); assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
  } finally { db.exec("ROLLBACK"); }
});

for (const corruption of ["predecessor-missing", "predecessor-renamed", "marker-renamed", "marker-duplicate", "callback-disagrees"])
  test(`migration205 rejects ${corruption} without repairing foreign state`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    if (corruption === "predecessor-missing") db.prepare("DELETE FROM schema_migrations WHERE version=204").run();
    if (corruption === "predecessor-renamed") db.prepare("UPDATE schema_migrations SET name='foreign204' WHERE version=204").run();
    if (corruption === "marker-renamed") db.prepare("UPDATE schema_migrations SET name='foreign205' WHERE version=205").run();
    if (corruption === "marker-duplicate") record(db)(999205, "workflow_isolation_terminal_results");
    const before = snapshot(db);
    assert.throws(() => migrate(db, corruption === "callback-disagrees" ? { hasMigration: () => false } : {}), /migration_predecessor_missing|migration_marker_conflict/);
    assert.deepEqual(snapshot(db), before);
  });

for (const object of ["workflow_isolation_result_receipts", "idx_workflow_isolation_result_confirmed", "trg_workflow_isolation_result_intent_immutable"])
  test(`marker205 cannot hide missing ${object} on reopen`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    const { type } = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(object);
    db.exec(`DROP ${type.toUpperCase()} ${object}`);
    const before = snapshot(db); assert.throws(() => migrate(db), /migration_schema_missing/); assert.deepEqual(snapshot(db), before);
    assert.throws(() => f.reopenIsolation(), /migration_schema_missing/);
  });

for (const corruption of ["check", "foreign-key", "index", "trigger", "unexpected-index", "unexpected-trigger"])
  test(`migration205 rejects damaged ${corruption} constraints`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    if (["check", "foreign-key"].includes(corruption)) {
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE name='workflow_isolation_result_receipts'").get().sql;
      const changed = corruption === "check" ? original.replace("    CHECK(outcome<>'confirmed' OR observed_commit IS NOT NULL),\n", "")
        : original.replace(" REFERENCES artifacts(id)", "");
      assert.notEqual(changed, original); db.exec("DROP TABLE workflow_isolation_result_receipts"); db.exec(changed);
    }
    if (corruption === "index") {
      db.exec("DROP INDEX idx_workflow_isolation_result_confirmed");
      db.exec("CREATE INDEX idx_workflow_isolation_result_confirmed ON workflow_isolation_result_receipts(intent_id)");
    }
    if (corruption === "trigger") {
      db.exec("DROP TRIGGER trg_workflow_isolation_result_intent_immutable");
      db.exec("CREATE TRIGGER trg_workflow_isolation_result_intent_immutable BEFORE UPDATE ON workflow_isolation_result_intents BEGIN SELECT 1; END");
    }
    if (corruption === "unexpected-index") db.exec("CREATE INDEX foreign205_index ON workflow_isolation_result_intents(status)");
    if (corruption === "unexpected-trigger") db.exec("CREATE TRIGGER foreign205_trigger BEFORE INSERT ON workflow_isolation_result_intents BEGIN SELECT 1; END");
    const before = snapshot(db);
    assert.throws(() => migrate(db), /migration_schema_conflict|migration_schema_missing|migration_unexpected_object/);
    assert.deepEqual(snapshot(db), before);
  });

function insertCopy(db, table, row, change) {
  const next = { ...row, ...change }, columns = Object.keys(next);
  db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(key => next[key]));
}
function rejected(db, action, pattern = /constraint|immutable|retained/i) {
  db.exec("SAVEPOINT invalid_result_write");
  try { assert.throws(action, pattern); }
  finally { db.exec("ROLLBACK TO invalid_result_write"); db.exec("RELEASE invalid_result_write"); }
}

test("real205 constraints retain evidence, reject wrong writer FKs, duplicate binding/ref/revision and replacement confirmation", async t => {
  const f = await workflowIsolationResultsFixture(t), db = f.store.database;
  f.resultIntent(); const intent = db.prepare("SELECT * FROM workflow_isolation_result_intents").get();
  rejected(db, () => insertCopy(db, "workflow_isolation_result_intents", intent, { intent_id: "duplicate-binding", ref: "other" }), /UNIQUE/);
  rejected(db, () => insertCopy(db, "workflow_isolation_result_intents", intent, { intent_id: "orphan", binding_id: "foreign", ref: "other" }), /FOREIGN KEY/);
  for (const field of ["run_id", "packet_artifact_id"])
    rejected(db, () => insertCopy(db, "workflow_isolation_result_intents", intent, { intent_id: "orphan", binding_id: "foreign", ref: "other", [field]: "missing" }), /FOREIGN KEY/);
  for (const field of ["proof_digest", "packet_digest", "result_commit", "ref", "fencing_token"])
    rejected(db, () => db.prepare(`UPDATE workflow_isolation_result_intents SET ${field}='changed',revision=revision+1,status='blocked'`).run());
  rejected(db, () => db.prepare("DELETE FROM workflow_isolation_result_intents").run(), /journal_retained/);
  f.resultReceipt(); const receipt = db.prepare("SELECT * FROM workflow_isolation_result_receipts").get();
  rejected(db, () => insertCopy(db, "workflow_isolation_result_receipts", receipt, { receipt_id: "duplicate-revision" }), /UNIQUE/);
  rejected(db, () => insertCopy(db, "workflow_isolation_result_receipts", receipt, { receipt_id: "duplicate-confirmation", revision: 2 }), /UNIQUE/);
  for (const field of ["work_unit_id", "attempt_id", "runtime_instance_id", "fencing_token", "binding_id"])
    rejected(db, () => insertCopy(db, "workflow_isolation_result_receipts", receipt, { receipt_id: "forged", revision: 2, outcome: "blocked", [field]: "foreign" }), /FOREIGN KEY/);
  rejected(db, () => insertCopy(db, "workflow_isolation_result_receipts", receipt, { receipt_id: "empty-confirmation", revision: 2, observed_commit: null }), /CHECK/);
  rejected(db, () => db.prepare("UPDATE workflow_isolation_result_receipts SET outcome='blocked'").run(), /receipt_immutable/);
  rejected(db, () => db.prepare("DELETE FROM workflow_isolation_result_receipts").run(), /journal_retained/);
  rejected(db, () => db.prepare("UPDATE workflow_isolation_result_intents SET revision=revision+1,status='blocked'").run(), /intent_immutable/);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
