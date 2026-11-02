import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkflowIntegrationCoordinatorMigration, WORKFLOW_INTEGRATION_COORDINATOR_MIGRATION_VERSION }
  from "../dist/storage/sqlite/workflow-integration-coordinator-migration.js";
import { workflowIsolationFixture } from "./support/workflow-isolation-fixture.mjs";

const tables = ["workflow_integration_effect_links", "workflow_integration_receipt_links"];
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const snapshot = db => ({ schema: schema(db), markers: db.prepare("SELECT * FROM schema_migrations ORDER BY version").all() });
const has = db => version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
const record = db => (version, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, "2026-11-02T00:00:00.000Z");
const migrate = (db, extra = {}) => applyWorkflowIntegrationCoordinatorMigration({ database: db,
  hasMigration: has(db), recordMigration: record(db), ...extra });

async function predecessor(t) {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  for (const table of tables) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  for (const table of [...tables].reverse()) db.exec(`DROP TABLE ${table}`);
  db.prepare("DELETE FROM schema_migrations WHERE version=206").run();
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=205").get().name, "workflow_isolation_terminal_results");
  return f;
}

test("fresh206 installs independent immutable evidence links and is idempotent", async t => {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  assert.equal(WORKFLOW_INTEGRATION_COORDINATOR_MIGRATION_VERSION, 206);
  assert.deepEqual(db.prepare("SELECT version,name FROM schema_migrations WHERE version=206 OR name='workflow_integration_coordinator_evidence'")
    .all().map(row => ({ ...row })), [{ version: 206, name: "workflow_integration_coordinator_evidence" }]);
  for (const table of tables) {
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(table).n, 2);
  }
  const before = snapshot(db); migrate(db); assert.deepEqual(snapshot(db), before);
  f.reopenIsolation(); assert.deepEqual(snapshot(f.store.database), before);
});

test("actual205 upgrade preserves predecessor schema and live authority data", async t => {
  const f = await predecessor(t), db = f.store.database;
  f.create(); f.persistPin(); f.bind(); f.link();
  const before = snapshot(db), data = f.snapshotIsolation();
  migrate(db);
  assert.deepEqual(schema(db).filter(row => !tables.includes(row.tbl_name)), before.schema);
  assert.deepEqual(snapshot(db).markers.filter(row => row.version !== 206), before.markers);
  assert.deepEqual(f.snapshotIsolation(), data);
  const installed = snapshot(db); f.reopenIsolation();
  assert.deepEqual(snapshot(f.store.database), installed);
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, requireReady: false, now: f.at(7) }).status, "current");
});

for (const failure of ["throw-after-marker", "missing-marker", "wrong-marker", "deferred-commit-fk"])
  test(`migration206 rolls back DDL and marker on ${failure}`, async t => {
    const f = await predecessor(t), db = f.store.database;
    if (failure === "deferred-commit-fk") {
      db.exec("CREATE TABLE migration206_fault (id TEXT REFERENCES channel_workflows(id) DEFERRABLE INITIALLY DEFERRED)");
      db.exec("CREATE TRIGGER migration206_fault_on_marker AFTER INSERT ON schema_migrations WHEN NEW.version=206 BEGIN INSERT INTO migration206_fault VALUES('missing'); END");
    }
    const before = snapshot(db), data = f.snapshotIsolation();
    assert.throws(() => migrate(db, { recordMigration: (version, name) => {
      if (failure === "missing-marker") return;
      record(db)(version, failure === "wrong-marker" ? "foreign206" : name);
      if (failure === "throw-after-marker") throw new Error("migration206-after-marker");
    } }), /migration206-after-marker|migration_postcondition|migration_marker_conflict|FOREIGN KEY/);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before); assert.deepEqual(f.snapshotIsolation(), data);
    if (failure === "deferred-commit-fk") db.exec("DROP TRIGGER migration206_fault_on_marker");
    migrate(db); assert.equal(has(db)(206), true);
  });

test("migration206 never adopts or rolls back its caller transaction", async t => {
  const f = await predecessor(t), db = f.store.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
    assert.throws(() => migrate(db), /transaction/i);
    assert.equal(db.isTransaction, true);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
  } finally { db.exec("ROLLBACK"); }
});

for (const corruption of ["predecessor-missing", "predecessor-renamed", "marker-renamed", "marker-duplicate", "callback-disagrees"])
  test(`migration206 rejects ${corruption} without rewriting the database`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    if (corruption === "predecessor-missing") db.prepare("DELETE FROM schema_migrations WHERE version=205").run();
    if (corruption === "predecessor-renamed") db.prepare("UPDATE schema_migrations SET name='foreign205' WHERE version=205").run();
    if (corruption === "marker-renamed") db.prepare("UPDATE schema_migrations SET name='foreign206' WHERE version=206").run();
    if (corruption === "marker-duplicate") record(db)(999206, "workflow_integration_coordinator_evidence");
    const before = snapshot(db);
    assert.throws(() => migrate(db, corruption === "callback-disagrees" ? { hasMigration: () => false } : {}),
      /migration_predecessor_missing|migration_marker_conflict/);
    assert.deepEqual(snapshot(db), before);
  });

for (const name of ["workflow_integration_receipt_links", "trg_workflow_integration_effect_link_immutable", "trg_workflow_integration_receipt_link_retained"])
  test(`marker206 cannot hide missing ${name} on reopen`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    const { type } = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    db.exec(`DROP ${type.toUpperCase()} ${name}`);
    const before = snapshot(db);
    assert.throws(() => migrate(db), /migration_schema_missing/);
    assert.deepEqual(snapshot(db), before);
    assert.throws(() => f.reopenIsolation(), /migration_schema_missing/);
  });

for (const corruption of ["check", "foreign-key", "trigger", "unexpected-index", "unexpected-trigger"])
  test(`migration206 rejects damaged ${corruption} rather than repairing foreign objects`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    if (corruption === "check" || corruption === "foreign-key") {
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE name='workflow_integration_receipt_links'").get().sql;
      const changed = corruption === "check" ? original.replace(" CHECK(typeof(scope_revision)='integer' AND scope_revision>=0)", "")
        : original.replace(" REFERENCES artifacts(id)", "");
      assert.notEqual(changed, original);
      db.exec("DROP TABLE workflow_integration_receipt_links"); db.exec(changed);
    }
    if (corruption === "trigger") {
      db.exec("DROP TRIGGER trg_workflow_integration_receipt_link_immutable");
      db.exec("CREATE TRIGGER trg_workflow_integration_receipt_link_immutable BEFORE UPDATE ON workflow_integration_receipt_links BEGIN SELECT 1; END");
    }
    if (corruption === "unexpected-index") db.exec("CREATE INDEX foreign206_index ON workflow_integration_effect_links(authority_digest)");
    if (corruption === "unexpected-trigger") db.exec("CREATE TRIGGER foreign206_trigger BEFORE INSERT ON workflow_integration_effect_links BEGIN SELECT 1; END");
    const before = snapshot(db);
    assert.throws(() => migrate(db), /migration_schema_conflict|migration_schema_missing|migration_unexpected_object/);
    assert.deepEqual(snapshot(db), before);
  });
