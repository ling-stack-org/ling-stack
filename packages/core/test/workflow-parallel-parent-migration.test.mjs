import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkflowParallelParentMigration, WORKFLOW_PARALLEL_PARENT_MIGRATION_VERSION }
  from "../dist/storage/sqlite/workflow-parallel-parent-migration.js";
import { workflowIsolationFixture } from "./support/workflow-isolation-fixture.mjs";
import { workflowMigrationPredecessorFixture } from "./support/workflow-migration-predecessor-fixture.mjs";

const table = "workflow_parallel_parent_fences";
const indexes = ["idx_workflow_parallel_parent_workspace", "idx_workflow_parallel_parent_common_dir"];
const triggers = ["trg_workflow_parallel_parent_immutable", "trg_workflow_parallel_parent_retained"];
const columns = ["round_id", "generation", "workspace_id", "common_dir", "inputs_digest", "state", "created_at", "released_at"];
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const markers = db => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const rows = (db, name) => db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
const exists = db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const snapshot = db => ({ schema: schema(db), markers: markers(db), parents: exists(db) ? rows(db, table) : [] });
const dataSnapshot = f => ({ isolation: f.snapshotIsolation(), ...Object.fromEntries([
  "artifacts", "harness_artifact_pins", "harness_artifact_pin_events", "workflow_worktree_cleanup_intents", "workflow_worktree_cleanup_receipts",
].map(name => [name, rows(f.peer.database, name)])) });
const has = db => version => !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
const record = db => (version, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, "2026-11-03T00:00:00.000Z");
const migrate = (db, extra = {}) => applyWorkflowParallelParentMigration({ database: db,
  hasMigration: has(db), recordMigration: record(db), ...extra });

async function fixture(t, { predecessor = false } = {}) {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  if (predecessor) {
    f.assertFullUpgrade = workflowMigrationPredecessorFixture(f, 210);
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 209);
    assert.equal(exists(db), false);
    assert.equal(has(db)(210), false);
  }
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=209").get().name,
    "workflow_worktree_cleanup_journal");
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

test("fresh210 installs exact parent identity, composite foreign keys and held-only unique fences; repeat and reopen preserve every marker", async t => {
  const f = await fixture(t), db = f.store.database;
  assert.equal(WORKFLOW_PARALLEL_PARENT_MIGRATION_VERSION, 210);
  assert.deepEqual(db.prepare("SELECT version,name FROM schema_migrations WHERE version=210 OR name=?")
    .all(table).map(row => ({ ...row })), [{ version: 210, name: table }]);
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  assert.deepEqual(info.map(row => row.name), columns);
  assert.deepEqual(info.filter(row => row.pk).sort((a, b) => a.pk - b.pk).map(row => row.name), ["round_id", "generation"]);
  const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  assert.equal(keys.length, 3);
  assert.ok(keys.some(row => row.from === "workspace_id" && row.table === "workspaces" && row.to === "id"));
  const roundKeys = keys.filter(row => row.table === "workflow_integration_generations").sort((a, b) => a.seq - b.seq);
  assert.deepEqual(roundKeys.map(row => [row.from, row.to]), [["round_id", "round_id"], ["generation", "generation"]]);
  assert.equal(roundKeys[0].id, roundKeys[1].id);
  assert.ok(keys.every(row => row.on_update === "NO ACTION" && row.on_delete === "NO ACTION"));
  const indexInfo = db.prepare(`PRAGMA index_list(${table})`).all();
  for (const [index, column] of [[indexes[0], "workspace_id"], [indexes[1], "common_dir"]]) {
    assert.equal(indexInfo.find(row => row.name === index)?.unique, 1);
    assert.equal(indexInfo.find(row => row.name === index)?.partial, 1);
    assert.deepEqual(db.prepare(`PRAGMA index_info(${index})`).all().map(row => row.name), [column]);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(index).sql, /WHERE state='held'$/u);
  }
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name")
    .all(table).map(row => row.name), triggers);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), []);
  const before = snapshot(db), data = dataSnapshot(f);
  migrate(db); migrate(db); f.reopenIsolation();
  assert.deepEqual(snapshot(f.store.database), before);
  assert.deepEqual(dataSnapshot(f), data);
});

test("actual209 upgrades additively and reopens through Core preserving schema, markers, Tasks, Runs, Attempts and sealed artifacts", async t => {
  const f = await fixture(t, { predecessor: true }), db = f.store.database;
  f.create(); f.persistPin(); f.bind(); f.link();
  const artifact = f.store.createArtifact({ runId: f.prepared.run.id, type: "json", path: "harness/pre-parent-fence.json",
    sealedPayload: { kind: "schema209_predecessor_evidence" }, createdAt: f.at(7) });
  const before = snapshot(db), data = dataSnapshot(f);
  for (const name of ["tasks", "run_sessions", "work_units", "work_unit_attempts"])
    assert.ok(data.isolation[name].length > 0, `${name} must contain genuine predecessor data`);
  assert.ok(data.artifacts.some(row => row.id === artifact.id));
  migrate(db);
  assert.deepEqual(schema(db).filter(row => row.tbl_name !== table), before.schema);
  assert.deepEqual(markers(db).filter(row => row.version !== 210), before.markers);
  assert.deepEqual(dataSnapshot(f), data);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 210);
  assert.deepEqual(rows(db, table), []);
  const installed = snapshot(db);
  migrate(db); assert.deepEqual(snapshot(db), installed);
  f.reopenIsolation();
  f.assertFullUpgrade(f.store.database, installed);
  assert.deepEqual(rows(f.store.database, table), installed.parents);
  assert.deepEqual(dataSnapshot(f), data);
  const upgraded = snapshot(f.store.database);
  f.reopenIsolation();
  f.assertFullUpgrade(f.store.database, installed);
  assert.deepEqual(snapshot(f.store.database), upgraded);
  assert.deepEqual(dataSnapshot(f), data);
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, requireReady: false, now: f.at(8) }).status, "current");
});

const rollbackFailures = {
  "throw-before-marker": /migration210-before-marker/u,
  "throw-after-marker": /migration210-after-marker/u,
  "missing-marker": /migration_postcondition/u,
  "wrong-marker": /migration_marker_conflict/u,
  "missing-index-after-marker": /migration_schema_missing/u,
  "foreign-trigger-after-marker": /migration_unexpected_object/u,
  "deferred-commit-fk": /FOREIGN KEY/u,
};
for (const [failure, pattern] of Object.entries(rollbackFailures)) {
  test(`migration210 rolls back all DDL, markers and predecessor writes on ${failure}`, async t => {
    const f = await fixture(t, { predecessor: true }), db = f.store.database;
    f.create();
    if (failure === "deferred-commit-fk") {
      db.exec("CREATE TABLE migration210_fault (id TEXT REFERENCES channel_workflows(id) DEFERRABLE INITIALLY DEFERRED)");
      db.exec("CREATE TRIGGER migration210_fault_on_marker AFTER INSERT ON schema_migrations WHEN NEW.version=210 BEGIN INSERT INTO migration210_fault VALUES('missing-workflow'); END");
    }
    const before = snapshot(db), data = dataSnapshot(f);
    let reachedMarker = false;
    assert.throws(() => migrate(db, { recordMigration(version, name) {
      reachedMarker = true;
      assert.equal(version, 210); assert.equal(name, table);
      assert.equal(schema(db).filter(row => row.tbl_name === table).length, 5, "all owned DDL must precede the marker callback");
      db.prepare("UPDATE channel_workflows SET title='migration210-wip' WHERE id=?").run(f.plan.workflowId);
      if (failure === "throw-before-marker") throw new Error("migration210-before-marker");
      if (failure === "missing-marker") return;
      record(db)(version, failure === "wrong-marker" ? "foreign210" : name);
      if (failure === "throw-after-marker") throw new Error("migration210-after-marker");
      if (failure === "missing-index-after-marker") db.exec(`DROP INDEX ${indexes[0]}`);
      if (failure === "foreign-trigger-after-marker") db.exec(`CREATE TRIGGER foreign210_trigger BEFORE INSERT ON ${table} BEGIN SELECT 1; END`);
    } }), pattern);
    assert.equal(reachedMarker, true);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(dataSnapshot(f), data);
    if (failure === "deferred-commit-fk") {
      assert.deepEqual(rows(db, "migration210_fault"), []);
      db.exec("DROP TRIGGER migration210_fault_on_marker");
    }
    migrate(db);
    assert.equal(has(db)(210), true, "a fully rolled-back attempt must remain retryable");
    assert.deepEqual(dataSnapshot(f), data);
  });
}

for (const trigger of triggers) {
  test(`migration210 rolls back partial DDL when creating ${trigger} fails`, async t => {
    const f = await fixture(t, { predecessor: true }), db = f.store.database;
    const before = snapshot(db), data = dataSnapshot(f), exec = db.exec.bind(db);
    let reachedFault = false, reachedMarker = false;
    const fault = t.mock.method(db, "exec", sql => {
      if (sql.startsWith(`CREATE TRIGGER ${trigger}`)) {
        reachedFault = true;
        assert.ok(exists(db));
        assert.ok(indexes.every(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name)));
        db.prepare("UPDATE channel_workflows SET title='migration210-ddl-wip' WHERE id=?").run(f.plan.workflowId);
        throw new Error("migration210-ddl-fault");
      }
      return exec(sql);
    });
    try { assert.throws(() => migrate(db, { recordMigration: () => { reachedMarker = true; } }), /migration210-ddl-fault/u); }
    finally { fault.mock.restore(); }
    assert.equal(reachedFault, true);
    assert.equal(reachedMarker, false);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(dataSnapshot(f), data);
    migrate(db);
    assert.equal(has(db)(210), true);
  });
}

for (const finish of ["COMMIT", "ROLLBACK"]) {
  test(`pending210 never adopts or finishes a caller transaction before its ${finish}`, async t => {
    const f = await fixture(t, { predecessor: true }), db = f.store.database;
    const original = f.store.getChannelWorkflow(f.plan.workflowId).title;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
      const before = snapshot(db);
      assert.throws(() => migrate(db), /transaction/iu);
      assert.equal(db.isTransaction, true);
      assert.deepEqual(snapshot(db), before);
      assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
      assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, original);
      db.exec(finish);
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
    assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, finish === "COMMIT" ? "caller-wip" : original);
    assert.equal(has(db)(210), false);
    migrate(db);
    assert.equal(has(db)(210), true);
  });
}

for (const corrupt of [false, true]) {
  test(`installed210 inspection preserves a caller transaction and its writes: corrupt=${corrupt}`, async t => {
    const f = await fixture(t), db = f.store.database;
    const original = f.store.getChannelWorkflow(f.plan.workflowId).title;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
      if (corrupt) db.prepare("UPDATE schema_migrations SET name='foreign210' WHERE version=210").run();
      const before = snapshot(db);
      if (corrupt) assert.throws(() => migrate(db), /migration_marker_conflict/u);
      else migrate(db);
      assert.equal(db.isTransaction, true);
      assert.deepEqual(snapshot(db), before);
      assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
      assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, original);
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
    migrate(db);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, original);
  });
}

for (const corruption of ["predecessor-missing", "predecessor-renamed", "marker-renamed", "marker-moved", "marker-duplicate",
  "callback-denies-marker", "callback-invents-marker"]) {
  test(`migration210 rejects ${corruption} without rewriting durable state`, async t => {
    const f = await fixture(t, { predecessor: corruption === "callback-invents-marker" }), db = f.store.database;
    if (corruption === "predecessor-missing") db.prepare("DELETE FROM schema_migrations WHERE version=209").run();
    if (corruption === "predecessor-renamed") db.prepare("UPDATE schema_migrations SET name='foreign209' WHERE version=209").run();
    if (corruption === "marker-renamed") db.prepare("UPDATE schema_migrations SET name='foreign210' WHERE version=210").run();
    if (corruption === "marker-moved") db.prepare("UPDATE schema_migrations SET version=999210 WHERE version=210").run();
    if (corruption === "marker-duplicate") record(db)(999210, table);
    const extra = corruption === "callback-denies-marker" ? { hasMigration: () => false }
      : corruption === "callback-invents-marker" ? { hasMigration: () => true } : {};
    rejectUnchanged(f, /migration_predecessor_missing|migration_marker_conflict/u, extra,
      { reopen: !corruption.startsWith("callback-") && !corruption.startsWith("predecessor-") });
  });
}

for (const name of [table, ...indexes, ...triggers]) {
  test(`marker210 cannot hide missing ${name}, including Core reopen`, async t => {
    const f = await fixture(t), db = f.store.database;
    const { type } = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    db.exec(`DROP ${type.toUpperCase()} ${name}`);
    rejectUnchanged(f, /migration_schema_missing/u);
  });
}

const schemaCorruptions = {
  "generation-check": sql => sql.replace(" CHECK(typeof(generation)='integer' AND generation>0)", ""),
  "workspace-foreign-key": sql => sql.replace(" REFERENCES workspaces(id)", ""),
  "round-generation-foreign-key": sql => sql.replace(
    "    FOREIGN KEY(round_id,generation) REFERENCES workflow_integration_generations(round_id,generation),\n", ""),
};
for (const [corruption, change] of Object.entries(schemaCorruptions)) {
  test(`migration210 rejects damaged ${corruption} instead of repairing the schema`, async t => {
    const f = await fixture(t), db = f.store.database;
    const original = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table).sql, changed = change(original);
    assert.notEqual(changed, original, "the corruption must actually alter the table");
    const dependents = schema(db).filter(row => row.tbl_name === table && row.type !== "table");
    db.exec(`DROP TABLE ${table}`); db.exec(changed);
    for (const object of dependents) db.exec(object.sql);
    rejectUnchanged(f, /migration_schema_conflict/u);
  });
}

for (const corruption of ["nonunique-workspace-index", "common-dir-predicate", "no-op-trigger", "unexpected-index", "unexpected-trigger"]) {
  test(`migration210 rejects altered ${corruption} without adopting foreign objects`, async t => {
    const f = await fixture(t), db = f.store.database;
    if (corruption === "nonunique-workspace-index" || corruption === "common-dir-predicate") {
      const name = corruption === "nonunique-workspace-index" ? indexes[0] : indexes[1];
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name).sql;
      const changed = corruption === "nonunique-workspace-index" ? original.replace("CREATE UNIQUE INDEX", "CREATE INDEX")
        : original.replace("WHERE state='held'", "WHERE state='released'");
      assert.notEqual(changed, original);
      db.exec(`DROP INDEX ${name}`); db.exec(changed);
    }
    if (corruption === "no-op-trigger") {
      db.exec(`DROP TRIGGER ${triggers[0]}`);
      db.exec(`CREATE TRIGGER ${triggers[0]} BEFORE UPDATE ON ${table} BEGIN SELECT 1; END`);
    }
    if (corruption === "unexpected-index") db.exec(`CREATE INDEX foreign210_index ON ${table}(inputs_digest)`);
    if (corruption === "unexpected-trigger") db.exec(`CREATE TRIGGER foreign210_trigger BEFORE INSERT ON ${table} BEGIN SELECT 1; END`);
    rejectUnchanged(f, /migration_schema_conflict|migration_unexpected_object/u);
  });
}

test("marker210 cannot hide an orphan parent row, and migration and Core reopen both refuse it", async t => {
  const f = await fixture(t), db = f.store.database;
  f.create();
  // Storage-level corruption only; this row is not an issued parallel execution capability.
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.prepare(`INSERT INTO ${table}(round_id,generation,workspace_id,common_dir,inputs_digest,state,created_at)
      VALUES(?,1,'missing-workspace',?,?,'held',?)`).run(f.roundId, f.inputs.repositoryIdentity.commonDir, f.round().inputsDigest, f.at(0));
  } finally { db.exec("PRAGMA foreign_keys=ON"); }
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare(`PRAGMA foreign_key_check(${table})`).all().length, 1);
  rejectUnchanged(f, /migration_fk_conflict/u);
});
