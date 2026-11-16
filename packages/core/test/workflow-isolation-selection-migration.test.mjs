import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkflowIsolationSelectionMigration, WORKFLOW_ISOLATION_SELECTION_MIGRATION_VERSION }
  from "../dist/storage/sqlite/workflow-isolation-selection-migration.js";
import { workflowIsolationFixture } from "./support/workflow-isolation-fixture.mjs";
import { workflowMigrationPredecessorFixture } from "./support/workflow-migration-predecessor-fixture.mjs";

const table = "workflow_isolation_selections";
const triggers = ["trg_workflow_isolation_selection_immutable", "trg_workflow_isolation_selection_retained"];
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const markers = db => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const rows = (db, name) => db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
const exists = db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const snapshot = db => ({ schema: schema(db), markers: markers(db), selections: exists(db) ? rows(db, table) : [] });
const dataSnapshot = f => ({ ...f.snapshotIsolation(), ...Object.fromEntries([
  "workflow_parallel_parent_fences", "artifacts", "harness_artifact_pins", "harness_artifact_pin_events",
  "workflow_worktree_cleanup_intents", "workflow_worktree_cleanup_receipts",
].map(name => [name, rows(f.peer.database, name)])) });
const has = db => version => !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
const record = db => (version, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, "2026-11-03T00:00:00.000Z");
const migrate = (db, extra = {}) => applyWorkflowIsolationSelectionMigration({ database: db,
  hasMigration: has(db), recordMigration: record(db), ...extra });

async function fixture(t, { predecessor = false, populated = false } = {}) {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  if (populated) {
    f.create(); f.persistPin(); f.bind(); f.link();
    f.artifact = f.store.createArtifact({ runId: f.prepared.run.id, type: "json", path: "harness/pre-selection.json",
      sealedPayload: { kind: "schema210_predecessor_evidence" }, createdAt: f.at(7) });
  }
  if (predecessor) {
    f.assertFullUpgrade = workflowMigrationPredecessorFixture(f, 211);
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 210);
    assert.equal(has(db)(211), false);
    assert.equal(exists(db), false);
  }
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=210").get().name, "workflow_parallel_parent_fences");
  return f;
}

function rejectUnchanged(f, pattern, extra = {}, { reopen = true } = {}) {
  const db = f.store.database, before = snapshot(db), data = dataSnapshot(f);
  assert.throws(() => migrate(db, extra), pattern);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(dataSnapshot(f), data);
  if (reopen) {
    assert.throws(() => f.reopenIsolation(), pattern);
    assert.deepEqual(snapshot(f.peer.database), before);
    assert.deepEqual(dataSnapshot(f), data);
    assert.equal(f.peer.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  }
}

test("fresh Core installs211 with exact columns, workflow ownership, unique round and both protection triggers", async t => {
  const f = await fixture(t), db = f.store.database;
  assert.equal(WORKFLOW_ISOLATION_SELECTION_MIGRATION_VERSION, 211);
  assert.deepEqual(db.prepare("SELECT version,name FROM schema_migrations WHERE version=211 OR name=?")
    .all(table).map(row => ({ ...row })), [{ version: 211, name: table }]);
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  assert.deepEqual(info.map(row => row.name), ["workflow_id", "profile", "round_id", "phase", "created_at", "updated_at"]);
  assert.deepEqual(info.filter(row => row.pk).map(row => row.name), ["workflow_id"]);
  assert.ok(info.every(row => row.notnull === 1));
  const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  assert.equal(keys.length, 1);
  assert.deepEqual(keys.map(row => [row.from, row.table, row.to, row.on_update, row.on_delete]),
    [["workflow_id", "channel_workflows", "id", "NO ACTION", "NO ACTION"]]);
  const uniqueColumns = db.prepare(`PRAGMA index_list(${table})`).all().filter(row => row.unique)
    .map(row => db.prepare(`PRAGMA index_info("${row.name}")`).all().map(column => column.name));
  assert.deepEqual(uniqueColumns.sort(), [["round_id"], ["workflow_id"]]);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name")
    .all(table).map(row => row.name), triggers);
  const insert = values => db.prepare(`INSERT INTO ${table}(workflow_id,profile,round_id,phase,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).run(...values);
  const valid = [f.plan.workflowId, "pi_host_isolated_files_v1", "selection-constraints", "planning", f.at(0), f.at(0)];
  for (const [column, value] of [[0, "missing-workflow"], [1, "serial_v1"], [2, ""], [3, "applied"], [5, f.at(-1)]]) {
    const values = [...valid]; values[column] = value;
    const before = snapshot(db);
    assert.throws(() => insert(values), /FOREIGN KEY|CHECK constraint/u);
    assert.deepEqual(snapshot(db), before);
  }
  insert(valid);
  const other = f.scope("selection-unique-owner", { plan: f.scopeIsolation.plan }).workflow;
  assert.throws(() => insert([other.id, ...valid.slice(1)]), /UNIQUE constraint/u);
  assert.throws(() => insert([valid[0], valid[1], "different-round", ...valid.slice(3)]), /UNIQUE constraint/u);
  const before = snapshot(db), data = dataSnapshot(f);
  migrate(db); migrate(db); f.reopenIsolation();
  assert.deepEqual(snapshot(f.store.database), before);
  assert.deepEqual(dataSnapshot(f), data);
  assert.equal(f.isolation.getSelection(f.plan.workflowId).roundId, valid[2]);
  assert.deepEqual(f.store.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("real210 upgrades additively and full Core reopen preserves populated execution and sealed artifacts", async t => {
  const f = await fixture(t, { predecessor: true, populated: true }), db = f.store.database;
  const before = snapshot(db), data = dataSnapshot(f);
  for (const name of ["tasks", "run_sessions", "work_units", "work_unit_attempts", "workflow_step_admissions"])
    assert.ok(data[name].length > 0, `${name} must hold real predecessor data`);
  assert.ok(data.artifacts.some(row => row.id === f.artifact.id));
  migrate(db);
  assert.deepEqual(schema(db).filter(row => row.tbl_name !== table), before.schema);
  assert.deepEqual(markers(db).filter(row => row.version !== 211), before.markers);
  assert.deepEqual(rows(db, table), []);
  assert.deepEqual(dataSnapshot(f), data);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 211);
  const installed = snapshot(db);
  migrate(db); assert.deepEqual(snapshot(db), installed);
  f.reopenIsolation();
  f.assertFullUpgrade(f.store.database, installed);
  const fullyUpgraded = snapshot(f.store.database);
  assert.deepEqual(dataSnapshot(f), data);
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, requireReady: false, now: f.at(8) }).status, "current");
  f.reopenIsolation();
  assert.deepEqual(snapshot(f.store.database), fullyUpgraded);
  assert.deepEqual(dataSnapshot(f), data);
});

test("Core constructor alone upgrades an actual210 database exactly once", async t => {
  const f = await fixture(t, { predecessor: true }), data = dataSnapshot(f);
  f.reopenIsolation();
  const installed = snapshot(f.store.database);
  f.assertFullUpgrade(f.store.database, installed);
  assert.deepEqual(installed.markers.filter(row => row.version === 211).map(row => row.name), [table]);
  assert.deepEqual(dataSnapshot(f), data);
  f.reopenIsolation();
  assert.deepEqual(snapshot(f.store.database), installed);
});

test("actual210 without the table or211 marker retains legacy admission and is never retroactively selected", async t => {
  const f = await fixture(t, { predecessor: true }), db = f.store.database;
  assert.equal(f.isolation.getSelection(f.plan.workflowId), undefined);
  const generation = f.begin(f.scopeIsolation), data = dataSnapshot(f);
  assert.equal(f.admission(f.scopeIsolation, generation).status, "preparing");
  migrate(db);
  const installed = snapshot(db);
  assert.equal(f.isolation.getSelection(f.plan.workflowId), undefined);
  assert.deepEqual(dataSnapshot(f), data);
  f.reopenIsolation();
  f.assertFullUpgrade(f.store.database, installed);
  assert.deepEqual(dataSnapshot(f), data);
  assert.equal(f.isolation.getSelection(f.plan.workflowId), undefined);
});

test("a one-sided selection table or211 marker is not treated as legacy data", async t => {
  for (const missing of ["table", "marker"]) await t.test(missing, async t => {
    const f = await fixture(t), db = f.store.database;
    if (missing === "table") db.exec(`DROP TABLE ${table}`);
    else db.prepare("DELETE FROM schema_migrations WHERE version=211").run();
    const before = snapshot(db), data = dataSnapshot(f);
    assert.throws(() => f.isolation.getSelection(f.plan.workflowId), /workflow_isolation\.selection_schema_invalid/u);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(dataSnapshot(f), data);
  });
});

test("migration211 fails closed on predecessor and marker authority conflicts without rewriting them", async t => {
  for (const corruption of ["predecessor-missing", "predecessor-renamed", "marker-renamed", "marker-moved", "marker-duplicate",
    "callback-denies-marker", "callback-invents-marker"]) await t.test(corruption, async t => {
    const f = await fixture(t, { predecessor: corruption === "callback-invents-marker" }), db = f.store.database;
    if (corruption === "predecessor-missing") db.prepare("DELETE FROM schema_migrations WHERE version=210").run();
    if (corruption === "predecessor-renamed") db.prepare("UPDATE schema_migrations SET name='foreign210' WHERE version=210").run();
    if (corruption === "marker-renamed") db.prepare("UPDATE schema_migrations SET name='foreign211' WHERE version=211").run();
    if (corruption === "marker-moved") db.prepare("UPDATE schema_migrations SET version=999211 WHERE version=211").run();
    if (corruption === "marker-duplicate") record(db)(999211, table);
    const extra = corruption === "callback-denies-marker" ? { hasMigration: () => false }
      : corruption === "callback-invents-marker" ? { hasMigration: () => true } : {};
    const pattern = corruption.startsWith("predecessor-") ? /selection_migration_predecessor_missing/u
      : /selection_migration_marker_conflict/u;
    rejectUnchanged(f, pattern, extra, { reopen: !corruption.startsWith("predecessor-") && !corruption.startsWith("callback-") });
  });
});

test("marker211 cannot hide a missing table or either missing protection trigger, including Core reopen", async t => {
  for (const name of [table, ...triggers]) await t.test(name, async t => {
    const f = await fixture(t), db = f.store.database;
    const { type } = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    db.exec(`DROP ${type.toUpperCase()} ${name}`);
    rejectUnchanged(f, new RegExp(`selection_migration_schema_missing:${name}`, "u"));
  });
});

test("migration211 refuses weakened table constraints instead of repairing foreign schema", async t => {
  for (const [constraint, change] of [
    ["workflow-foreign-key", sql => sql.replace(" REFERENCES channel_workflows(id)", "")],
    ["unique-round", sql => sql.replace("round_id TEXT NOT NULL UNIQUE", "round_id TEXT NOT NULL")],
    ["profile-check", sql => sql.replace(" CHECK(profile='pi_host_isolated_files_v1')", "")],
    ["phase-check", sql => sql.replace(" CHECK(phase IN ('planning','ready'))", "")],
    ["timestamp-order", sql => sql.replace(" CHECK(updated_at>=created_at)", "")],
  ]) await t.test(constraint, async t => {
    const f = await fixture(t), db = f.store.database;
    const original = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table).sql, changed = change(original);
    assert.notEqual(changed, original, "the corruption must actually weaken a constraint");
    const dependents = schema(db).filter(row => row.tbl_name === table && row.type !== "table");
    db.exec(`DROP TABLE ${table}`); db.exec(changed);
    for (const object of dependents) db.exec(object.sql);
    rejectUnchanged(f, /selection_migration_schema_conflict:workflow_isolation_selections/u);
  });
});

test("migration211 rejects no-op protection triggers, unexpected objects and a table-name view", async t => {
  for (const corruption of [...triggers, "unexpected-index", "unexpected-trigger", "table-is-view"]) await t.test(corruption, async t => {
    const f = await fixture(t, { predecessor: corruption === "table-is-view" }), db = f.store.database;
    if (triggers.includes(corruption)) {
      db.exec(`DROP TRIGGER ${corruption}`);
      db.exec(`CREATE TRIGGER ${corruption} BEFORE UPDATE ON ${table} BEGIN SELECT 1; END`);
    }
    if (corruption === "unexpected-index") db.exec(`CREATE INDEX foreign211_index ON ${table}(phase)`);
    if (corruption === "unexpected-trigger") db.exec(`CREATE TRIGGER foreign211_trigger BEFORE INSERT ON ${table} BEGIN SELECT 1; END`);
    if (corruption === "table-is-view") db.exec(`CREATE VIEW ${table} AS SELECT id AS workflow_id FROM channel_workflows`);
    rejectUnchanged(f, /selection_migration_schema_conflict|selection_migration_unexpected_object/u);
  });
});

test("installed211 refuses an orphan selection on migration and Core reopen", async t => {
  const f = await fixture(t), db = f.store.database;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.prepare(`INSERT INTO ${table}(workflow_id,profile,round_id,phase,created_at,updated_at)
      VALUES('missing-workflow','pi_host_isolated_files_v1','orphan-round','planning',?,?)`).run(f.at(0), f.at(0));
  } finally { db.exec("PRAGMA foreign_keys=ON"); }
  assert.equal(db.prepare(`PRAGMA foreign_key_check(${table})`).all().length, 1);
  rejectUnchanged(f, /selection_migration_fk_conflict/u);
});

test("migration211 rolls back DDL, markers and predecessor writes on callback, postcondition or commit failure", async t => {
  for (const [failure, pattern] of [
    ["throw-before-marker", /migration211-before-marker/u], ["throw-after-marker", /migration211-after-marker/u],
    ["missing-marker", /selection_migration_postcondition/u], ["wrong-marker", /selection_migration_marker_conflict/u],
    ["missing-trigger-after-marker", /selection_migration_schema_missing/u],
    ["foreign-trigger-after-marker", /selection_migration_unexpected_object/u], ["deferred-commit-fk", /FOREIGN KEY/u],
  ]) await t.test(failure, async t => {
    const f = await fixture(t, { predecessor: true }), db = f.store.database;
    if (failure === "deferred-commit-fk") {
      db.exec("CREATE TABLE migration211_fault (id TEXT REFERENCES channel_workflows(id) DEFERRABLE INITIALLY DEFERRED)");
      db.exec("CREATE TRIGGER migration211_fault_on_marker AFTER INSERT ON schema_migrations WHEN NEW.version=211 BEGIN INSERT INTO migration211_fault VALUES('missing-workflow'); END");
    }
    const before = snapshot(db), data = dataSnapshot(f);
    let reachedMarker = false;
    assert.throws(() => migrate(db, { recordMigration(version, name) {
      reachedMarker = true;
      assert.equal(db.isTransaction, true);
      assert.equal(version, 211); assert.equal(name, table);
      assert.deepEqual(schema(db).filter(row => row.tbl_name === table).map(row => row.name), [table, ...triggers]);
      db.prepare("UPDATE channel_workflows SET title='migration211-wip' WHERE id=?").run(f.plan.workflowId);
      if (failure === "throw-before-marker") throw new Error("migration211-before-marker");
      if (failure === "missing-marker") return;
      record(db)(version, failure === "wrong-marker" ? "foreign211" : name);
      if (failure === "throw-after-marker") throw new Error("migration211-after-marker");
      if (failure === "missing-trigger-after-marker") db.exec(`DROP TRIGGER ${triggers[0]}`);
      if (failure === "foreign-trigger-after-marker") db.exec(`CREATE TRIGGER foreign211_trigger BEFORE INSERT ON ${table} BEGIN SELECT 1; END`);
    } }), pattern);
    assert.equal(reachedMarker, true);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(dataSnapshot(f), data);
    if (failure === "deferred-commit-fk") {
      assert.deepEqual(rows(db, "migration211_fault"), []);
      db.exec("DROP TRIGGER migration211_fault_on_marker");
    }
    migrate(db);
    assert.equal(has(db)(211), true, "a rolled-back migration must remain retryable");
    assert.deepEqual(dataSnapshot(f), data);
  });
});

test("partial211 DDL is rolled back if the second protection trigger cannot be created", async t => {
  const f = await fixture(t, { predecessor: true }), db = f.store.database;
  const before = snapshot(db), data = dataSnapshot(f), exec = db.exec.bind(db);
  let reachedFault = false, reachedMarker = false;
  const fault = t.mock.method(db, "exec", sql => {
    if (sql.startsWith(`CREATE TRIGGER ${triggers[1]}`)) {
      reachedFault = true;
      assert.ok(exists(db));
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(triggers[0]));
      db.prepare("UPDATE channel_workflows SET title='migration211-ddl-wip' WHERE id=?").run(f.plan.workflowId);
      throw new Error("migration211-partial-ddl");
    }
    return exec(sql);
  });
  try { assert.throws(() => migrate(db, { recordMigration: () => { reachedMarker = true; } }), /migration211-partial-ddl/u); }
  finally { fault.mock.restore(); }
  assert.equal(reachedFault, true);
  assert.equal(reachedMarker, false);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(dataSnapshot(f), data);
  migrate(db);
  assert.equal(has(db)(211), true);
});

test("pending211 never adopts, commits or rolls back a caller transaction", async t => {
  for (const finish of ["COMMIT", "ROLLBACK"]) await t.test(finish, async t => {
    const f = await fixture(t, { predecessor: true }), db = f.store.database;
    const original = f.store.getChannelWorkflow(f.plan.workflowId).title;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE channel_workflows SET title='caller211-wip' WHERE id=?").run(f.plan.workflowId);
      const before = snapshot(db);
      let reachedMarker = false;
      assert.throws(() => migrate(db, { recordMigration: () => { reachedMarker = true; } }), /transaction/iu);
      assert.equal(reachedMarker, false);
      assert.equal(db.isTransaction, true);
      assert.deepEqual(snapshot(db), before);
      assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller211-wip");
      assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, original);
      db.exec(finish);
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
    assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, finish === "COMMIT" ? "caller211-wip" : original);
    assert.equal(has(db)(211), false);
    assert.equal(exists(db), false);
    migrate(db);
    assert.equal(has(db)(211), true);
  });
});

test("installed211 inspection, including a corrupt marker, leaves caller transaction ownership untouched", async t => {
  for (const corrupt of [false, true]) await t.test(`corrupt=${corrupt}`, async t => {
    const f = await fixture(t), db = f.store.database;
    const original = f.store.getChannelWorkflow(f.plan.workflowId).title;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE channel_workflows SET title='caller211-wip' WHERE id=?").run(f.plan.workflowId);
      if (corrupt) db.prepare("UPDATE schema_migrations SET name='foreign211' WHERE version=211").run();
      const before = snapshot(db);
      if (corrupt) assert.throws(() => migrate(db), /selection_migration_marker_conflict/u);
      else migrate(db);
      assert.equal(db.isTransaction, true);
      assert.deepEqual(snapshot(db), before);
      assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller211-wip");
      assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, original);
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
    migrate(db);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, original);
  });
});
