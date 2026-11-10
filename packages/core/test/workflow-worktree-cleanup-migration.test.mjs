import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkflowWorktreeCleanupMigration, WORKFLOW_WORKTREE_CLEANUP_MIGRATION_VERSION }
  from "../dist/storage/sqlite/workflow-worktree-cleanup-migration.js";
import { workflowIsolationFixture } from "./support/workflow-isolation-fixture.mjs";
import { workflowMigrationPredecessorFixture } from "./support/workflow-migration-predecessor-fixture.mjs";

const tables = ["workflow_worktree_cleanup_intents", "workflow_worktree_cleanup_receipts"];
const migrationName = "workflow_worktree_cleanup_journal";
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const markers = db => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const snapshot = db => ({ schema: schema(db), markers: markers(db) });
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const has = db => version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
const record = db => (version, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, "2026-11-02T00:00:00.000Z");
const migrate = (db, extra = {}) => applyWorkflowWorktreeCleanupMigration({ database: db,
  hasMigration: has(db), recordMigration: record(db), ...extra });

async function fixture(t, { predecessor = false } = {}) {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  if (predecessor) f.assertFullUpgrade = workflowMigrationPredecessorFixture(f, 209);
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=208").get().name,
    "workflow_merge_apply_permits");
  return f;
}

test("fresh209 installs separate append-only cleanup tables, exact marker and an irreversible removed tombstone", async t => {
  const f = await fixture(t), db = f.store.database;
  assert.equal(WORKFLOW_WORKTREE_CLEANUP_MIGRATION_VERSION, 209);
  assert.deepEqual(db.prepare("SELECT version,name FROM schema_migrations WHERE version=209 OR name=?")
    .all(migrationName).map(row => ({ ...row })), [{ version: 209, name: migrationName }]);
  for (const table of tables) {
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(table).n, 2);
  }
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_workflow_worktree_cleanup_removed'").get();
  assert.match(index.sql, /UNIQUE INDEX/u);
  assert.match(index.sql, /WHERE state='removed'/u);
  const before = snapshot(db);
  migrate(db);
  assert.deepEqual(snapshot(db), before);
  f.reopenIsolation();
  assert.deepEqual(snapshot(f.store.database), before);
});

test("actual208 upgrade preserves predecessor authority, Tasks, Runs, Attempts and artifacts", async t => {
  const f = await fixture(t, { predecessor: true }), db = f.store.database;
  f.create(); f.persistPin(); f.bind(); f.link();
  f.store.createArtifact({ runId: f.prepared.run.id, type: "json", path: "harness/pre-cleanup.json",
    sealedPayload: { kind: "predecessor_evidence" }, createdAt: f.at(7) });
  const before = snapshot(db), data = f.snapshotIsolation(), artifacts = rows(db, "artifacts");
  migrate(db);
  assert.deepEqual(schema(db).filter(row => !tables.includes(row.tbl_name)), before.schema);
  assert.deepEqual(markers(db).filter(row => row.version !== 209), before.markers);
  assert.deepEqual(f.snapshotIsolation(), data);
  assert.deepEqual(rows(db, "artifacts"), artifacts);
  const installed = snapshot(db);
  f.reopenIsolation();
  f.assertFullUpgrade(f.store.database, installed);
  assert.deepEqual(f.snapshotIsolation(), data);
  assert.deepEqual(rows(f.store.database, "artifacts"), artifacts);
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, requireReady: false, now: f.at(8) }).status, "current");
});

for (const failure of ["throw-before-marker", "throw-after-marker", "missing-marker", "wrong-marker", "deferred-commit-fk"]) {
  test(`migration209 rolls back all DDL and predecessor writes on ${failure}`, async t => {
    const f = await fixture(t, { predecessor: true }), db = f.store.database;
    f.create();
    if (failure === "deferred-commit-fk") {
      db.exec("CREATE TABLE migration209_fault (id TEXT REFERENCES channel_workflows(id) DEFERRABLE INITIALLY DEFERRED)");
      db.exec("CREATE TRIGGER migration209_fault_on_marker AFTER INSERT ON schema_migrations WHEN NEW.version=209 BEGIN INSERT INTO migration209_fault VALUES('missing'); END");
    }
    const before = snapshot(db), data = f.snapshotIsolation();
    assert.throws(() => migrate(db, { recordMigration(version, name) {
      db.prepare("UPDATE channel_workflows SET title='uncommitted-migration-change' WHERE id=?").run(f.plan.workflowId);
      if (failure === "throw-before-marker") throw new Error("migration209-before-marker");
      if (failure === "missing-marker") return;
      record(db)(version, failure === "wrong-marker" ? "foreign209" : name);
      if (failure === "throw-after-marker") throw new Error("migration209-after-marker");
    } }), /migration209-|migration_postcondition|migration_marker_conflict|FOREIGN KEY/u);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(f.snapshotIsolation(), data);
    if (failure === "deferred-commit-fk") db.exec("DROP TRIGGER migration209_fault_on_marker");
    migrate(db);
    assert.equal(has(db)(209), true);
  });
}

test("migration209 cannot adopt or roll back its caller's transaction", async t => {
  const f = await fixture(t, { predecessor: true }), db = f.store.database;
  f.create();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
    assert.throws(() => migrate(db), /transaction/iu);
    assert.equal(db.isTransaction, true);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
  } finally { db.exec("ROLLBACK"); }
  assert.equal(has(db)(209), false);
});

for (const corruption of ["predecessor-missing", "predecessor-renamed", "marker-renamed", "marker-moved", "marker-duplicate", "callback-disagrees"]) {
  test(`migration209 rejects ${corruption} without repairing or rewriting the database`, async t => {
    const f = await fixture(t), db = f.store.database;
    if (corruption === "predecessor-missing") db.prepare("DELETE FROM schema_migrations WHERE version=208").run();
    if (corruption === "predecessor-renamed") db.prepare("UPDATE schema_migrations SET name='foreign208' WHERE version=208").run();
    if (corruption === "marker-renamed") db.prepare("UPDATE schema_migrations SET name='foreign209' WHERE version=209").run();
    if (corruption === "marker-moved") db.prepare("UPDATE schema_migrations SET version=999209 WHERE version=209").run();
    if (corruption === "marker-duplicate") record(db)(999209, migrationName);
    const before = snapshot(db);
    assert.throws(() => migrate(db, corruption === "callback-disagrees" ? { hasMigration: () => false } : {}),
      /migration_predecessor_missing|migration_marker_conflict/u);
    assert.deepEqual(snapshot(db), before);
  });
}

for (const name of [tables[1], "idx_workflow_worktree_cleanup_removed", "trg_workflow_worktree_cleanup_intents_immutable",
  "trg_workflow_worktree_cleanup_receipts_retained"]) {
  test(`marker209 cannot hide missing ${name}, including Store reopen`, async t => {
    const f = await fixture(t), db = f.store.database;
    const { type } = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    db.exec(`DROP ${type.toUpperCase()} ${name}`);
    const before = snapshot(db);
    assert.throws(() => migrate(db), /migration_schema_missing/u);
    assert.deepEqual(snapshot(db), before);
    assert.throws(() => f.reopenIsolation(), /migration_schema_missing/u);
  });
}

for (const corruption of ["check", "foreign-key", "no-op-trigger", "unexpected-index", "unexpected-trigger"]) {
  test(`migration209 refuses altered ${corruption} instead of adopting a foreign schema`, async t => {
    const f = await fixture(t), db = f.store.database;
    if (corruption === "check" || corruption === "foreign-key") {
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(tables[1]).sql;
      const changed = corruption === "check" ? original.replace(" CHECK(state IN ('removed','present','unknown'))", "")
        : original.replace(" REFERENCES artifacts(id)", "");
      assert.notEqual(changed, original);
      db.exec(`DROP TABLE ${tables[1]}`);
      db.exec(changed);
    }
    if (corruption === "no-op-trigger") {
      db.exec("DROP TRIGGER trg_workflow_worktree_cleanup_receipts_immutable");
      db.exec("CREATE TRIGGER trg_workflow_worktree_cleanup_receipts_immutable BEFORE UPDATE ON workflow_worktree_cleanup_receipts BEGIN SELECT 1; END");
    }
    if (corruption === "unexpected-index") db.exec(`CREATE INDEX foreign209_index ON ${tables[0]}(workflow_id)`);
    if (corruption === "unexpected-trigger") db.exec(`CREATE TRIGGER foreign209_trigger BEFORE INSERT ON ${tables[0]} BEGIN SELECT 1; END`);
    const before = snapshot(db);
    assert.throws(() => migrate(db), /migration_schema_conflict|migration_schema_missing|migration_unexpected_object/u);
    assert.deepEqual(snapshot(db), before);
  });
}
