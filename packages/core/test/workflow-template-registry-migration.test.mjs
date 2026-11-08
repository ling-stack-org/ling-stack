import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { applyWorkflowTemplateRegistryMigration, WORKFLOW_TEMPLATE_REGISTRY_MIGRATION_VERSION }
  from "../dist/storage/sqlite/workflow-template-registry-migration.js";
import { at, businessSnapshot, fixture, markers, persistSkill, registrySnapshot, registryTables, registryTriggers,
  registrySuccessorTables, removeRegistryOverlay, rows, saveInput, schema } from "./support/workflow-template-registry-fixture.mjs";

const has = db => version => !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
const record = db => (version, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(version, name, at(0));
const migrate = (db, extra = {}) => applyWorkflowTemplateRegistryMigration({ database: db,
  hasMigration: has(db), recordMigration: record(db), ...extra });
const snapshot = db => ({ schema: schema(db), markers: markers(db), workspaces: rows(db, "workspaces"),
  ...Object.fromEntries(registryTables.filter(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
    .map(name => [name, rows(db, name)])) });
const owned = row => registryTables.includes(row.tbl_name);
const successorOwned = row => registrySuccessorTables.includes(row.tbl_name);
const markerIdentity = db => markers(db).map(({ version, name }) => ({ version, name }));

function rejectUnchanged(f, pattern, extra = {}, reopen = true) {
  const before = snapshot(f.db), data = businessSnapshot(f.db);
  assert.throws(() => migrate(f.db, extra), pattern);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(snapshot(f.db), before);
  assert.deepEqual(businessSnapshot(f.db), data);
  if (reopen) {
    assert.throws(() => createSqliteRunStore(f.root, f.paths), pattern);
    assert.deepEqual(snapshot(f.db), before);
    assert.deepEqual(businessSnapshot(f.db), data);
  }
}

test("fresh Core installs migration212 with exact owned tables, foreign keys and immutable retention guards", t => {
  const f = fixture(t, { fresh: true }), db = f.db;
  assert.equal(WORKFLOW_TEMPLATE_REGISTRY_MIGRATION_VERSION, 212);
  assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, 220);
  assert.deepEqual(db.prepare("SELECT version,name FROM schema_migrations WHERE version=212 OR name='workflow_template_registry'").all()
    .map(row => ({ ...row })), [{ version: 212, name: "workflow_template_registry" }]);
  assert.deepEqual(schema(db).filter(owned).map(row => row.name).sort(), [...registryTables, ...registryTriggers].sort());
  assert.deepEqual(db.prepare("PRAGMA table_info(workflow_template_registry)").all().map(row => row.name),
    ["workspace_id", "id", "kind", "source", "source_path", "visibility_json", "review_status", "latest_version",
      "published_version", "published_digest", "revision", "created_at", "updated_at"]);
  assert.deepEqual(db.prepare("PRAGMA table_info(workflow_template_versions)").all().map(row => row.name),
    ["workspace_id", "template_id", "kind", "version", "digest", "template_json", "created_at"]);
  assert.equal(db.prepare("PRAGMA foreign_key_list(workflow_template_registry)").all().length, 8);
  assert.equal(db.prepare("PRAGMA foreign_key_list(workflow_template_versions)").all().length, 2);
  const before = snapshot(db), data = businessSnapshot(db);
  migrate(db); migrate(db); f.reopen();
  assert.deepEqual(snapshot(f.db), before);
  assert.deepEqual(businessSnapshot(f.db), data);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("real211 upgrade is additive and the production constructor preserves existing tasks, execution records and skills", t => {
  const f = fixture(t, { fresh: true });
  const channel = f.store.createChannel({ name: "Pre-registry", boundPath: f.root }, at(0));
  const task = f.store.createTask({ channelId: channel.id, title: "Keep predecessor", prompt: "Do not execute" }, at(0));
  f.store.createRun({ id: "registry-predecessor-run", cwd: f.root, taskId: task.id, channelId: channel.id,
    providerName: "Fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at(0) });
  persistSkill(f.store);
  const fullSchema = schema(f.db), fullMarkers = markerIdentity(f.db);
  removeRegistryOverlay(f);
  const before = snapshot(f.db), data = businessSnapshot(f.db);
  assert.ok(data.tasks.length > 0 && data.run_sessions.length > 0 && data.skill_definitions.length > 0);
  migrate(f.db);
  assert.deepEqual(schema(f.db).filter(row => !owned(row)), before.schema);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 212), before.markers);
  assert.deepEqual(registrySnapshot(f.db), { workflow_template_registry: [], workflow_template_versions: [] });
  const installed = snapshot(f.db);
  f.reopen();
  assert.deepEqual(schema(f.db).filter(row => !successorOwned(row)), installed.schema);
  assert.deepEqual(markers(f.db).filter(row => row.version <= 212), installed.markers);
  assert.deepEqual({ ...snapshot(f.db), schema: schema(f.db).filter(row => !successorOwned(row)),
    markers: markers(f.db).filter(row => row.version <= 212) }, installed);
  assert.deepEqual(schema(f.db), fullSchema);
  assert.deepEqual(markerIdentity(f.db), fullMarkers);
  for (const table of registrySuccessorTables) assert.deepEqual(rows(f.db, table), []);
  assert.deepEqual(businessSnapshot(f.db), data);
  assert.deepEqual(f.registry.list(), []);
  assert.equal(f.store.getTask(task.id).title, "Keep predecessor");
});

test("Core constructor alone upgrades a real211 database exactly once", t => {
  const f = fixture(t, { fresh: true });
  const fullSchema = schema(f.db), fullMarkers = markerIdentity(f.db);
  removeRegistryOverlay(f);
  const before = snapshot(f.db), data = businessSnapshot(f.db);
  f.reopen();
  const installed = snapshot(f.db);
  assert.deepEqual(installed.schema.filter(row => !owned(row) && !successorOwned(row)), before.schema);
  assert.deepEqual(installed.markers.filter(row => row.version < 212), before.markers);
  assert.equal(installed.markers.at(-1).version, 220);
  assert.deepEqual(installed.schema, fullSchema);
  assert.deepEqual(markerIdentity(f.db), fullMarkers);
  for (const table of registrySuccessorTables) assert.deepEqual(rows(f.db, table), []);
  assert.deepEqual(businessSnapshot(f.db), data);
  f.reopen();
  assert.deepEqual(snapshot(f.db), installed);
});

test("migration212 refuses predecessor and marker conflicts without repairing foreign authority", async t => {
  for (const fault of ["predecessor-missing", "predecessor-renamed", "marker-renamed", "marker-moved", "marker-duplicate",
    "callback-denies-marker", "callback-invents-marker"]) await t.test(fault, t => {
    const f = fixture(t, { fresh: true }), db = f.db;
    if (fault === "callback-invents-marker") removeRegistryOverlay(f);
    if (fault === "predecessor-missing") db.prepare("DELETE FROM schema_migrations WHERE version=211").run();
    if (fault === "predecessor-renamed") db.prepare("UPDATE schema_migrations SET name='foreign211' WHERE version=211").run();
    if (fault === "marker-renamed") db.prepare("UPDATE schema_migrations SET name='foreign212' WHERE version=212").run();
    if (fault === "marker-moved") db.prepare("UPDATE schema_migrations SET version=999212 WHERE version=212").run();
    if (fault === "marker-duplicate") record(db)(999212, "workflow_template_registry");
    const extra = fault === "callback-denies-marker" ? { hasMigration: () => false }
      : fault === "callback-invents-marker" ? { hasMigration: () => true } : {};
    rejectUnchanged(f, fault.startsWith("predecessor-") ? /registry.migration_predecessor_missing/u : /registry.migration_marker_conflict/u,
      extra, !fault.startsWith("predecessor-") && !fault.startsWith("callback-"));
  });
});

test("marker212 cannot conceal either missing table or any missing immutable/history guard", async t => {
  for (const name of [...registryTables, ...registryTriggers]) await t.test(name, t => {
    const f = fixture(t, { fresh: true }), db = f.db;
    const { type } = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    db.exec(`DROP ${type.toUpperCase()} ${name}`);
    rejectUnchanged(f, new RegExp(`registry.migration_schema_missing:${name}`, "u"));
  });
});

test("migration212 rejects weakened checks, no-op guards and unexpected indexes/triggers", async t => {
  for (const fault of ["source-check", "visibility-check", "version-check", "noop-trigger", "foreign-index", "foreign-trigger"])
    await t.test(fault, t => {
      const f = fixture(t, { fresh: true }), db = f.db;
      if (["source-check", "visibility-check", "version-check"].includes(fault)) {
        const table = fault === "version-check" ? registryTables[1] : registryTables[0];
        const original = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table).sql;
        const altered = fault === "source-check" ? original.replace("CHECK(source IN ('builtin','gstack','workspace','skill-directory','agents-md','custom'))", "CHECK(1)")
          : fault === "visibility-check" ? original.replace("COALESCE(json_type(visibility_json,'$.workspaceVisible') IN ('true','false'),0)", "1")
          : original.replace("CHECK(length(version) BETWEEN 1 AND 128)", "CHECK(1)");
        assert.notEqual(altered, original);
        const triggers = schema(db).filter(row => row.tbl_name === table && row.type === "trigger");
        db.exec(`DROP TABLE ${table}`); db.exec(altered);
        for (const trigger of triggers) db.exec(trigger.sql);
      }
      if (fault === "noop-trigger") {
        db.exec(`DROP TRIGGER ${registryTriggers[3]}`);
        db.exec(`CREATE TRIGGER ${registryTriggers[3]} BEFORE UPDATE ON workflow_template_versions BEGIN SELECT 1; END`);
      }
      if (fault === "foreign-index") db.exec("CREATE INDEX foreign_registry_index ON workflow_template_registry(source)");
      if (fault === "foreign-trigger") db.exec("CREATE TRIGGER foreign_registry_trigger BEFORE INSERT ON workflow_template_versions BEGIN SELECT 1; END");
      rejectUnchanged(f, /registry.migration_schema_conflict|registry.migration_unexpected_object/u);
    });
});

test("pending migration cannot adopt a same-name view or unmarked populated registry tables", async t => {
  for (const fault of ["view", "populated-unmarked"]) await t.test(fault, t => {
    const f = fixture(t, { fresh: true }), db = f.db;
    if (fault === "view") {
      removeRegistryOverlay(f);
      db.exec("CREATE VIEW workflow_template_registry AS SELECT id FROM workspaces");
    } else {
      f.registry.saveVersion(saveInput());
      db.prepare("DELETE FROM schema_migrations WHERE version=212").run();
    }
    rejectUnchanged(f, /registry.migration_schema_conflict|registry.migration_unmarked_data/u);
  });
});

test("exact empty partial DDL can finish migration without replacing already installed objects", t => {
  const f = fixture(t, { fresh: true }), db = f.db;
  db.prepare("DELETE FROM schema_migrations WHERE version=212").run();
  db.exec(`DROP TRIGGER ${registryTriggers.at(-1)}`);
  const before = schema(db), data = businessSnapshot(db);
  migrate(db);
  assert.deepEqual(schema(db).filter(row => row.name !== registryTriggers.at(-1)), before);
  assert.deepEqual(businessSnapshot(db), data);
  assert.equal(has(db)(212), true);
});

test("migration and constructor refuse orphan registry version ownership instead of silently accepting it", t => {
  const f = fixture(t, { fresh: true }), db = f.db;
  f.registry.saveVersion(saveInput());
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec(`INSERT INTO workflow_template_versions SELECT workspace_id,'orphan',kind,version,digest,
      json_set(template_json,'$.id','orphan'),created_at FROM workflow_template_versions WHERE template_id='review'`);
  } finally { db.exec("PRAGMA foreign_keys=ON"); }
  rejectUnchanged(f, /registry.migration_fk_conflict/u);
});

test("migration212 rolls back owned DDL, markers and predecessor writes on callback, postcondition and commit failures", async t => {
  for (const fault of ["before-marker", "after-marker", "missing-marker", "wrong-marker", "missing-guard", "foreign-guard", "commit-fk"])
    await t.test(fault, t => {
      const f = fixture(t, { fresh: true }), db = f.db;
      removeRegistryOverlay(f);
      if (fault === "commit-fk") {
        db.exec("CREATE TABLE registry_migration_fault (id TEXT REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED)");
        db.exec("CREATE TRIGGER registry_migration_fault_trigger AFTER INSERT ON schema_migrations WHEN NEW.version=212 BEGIN INSERT INTO registry_migration_fault VALUES('missing-task'); END");
      }
      const before = snapshot(db), data = businessSnapshot(db);
      let reached = false;
      assert.throws(() => migrate(db, { recordMigration(version, name) {
        reached = true;
        assert.equal(db.isTransaction, true);
        assert.equal(version, 212); assert.equal(name, "workflow_template_registry");
        db.prepare("UPDATE workspaces SET name='migration-owned-wip' WHERE id='workspace_default'").run();
        if (fault === "before-marker") throw new Error("registry-before-marker");
        if (fault === "missing-marker") return;
        record(db)(version, fault === "wrong-marker" ? "foreign212" : name);
        if (fault === "after-marker") throw new Error("registry-after-marker");
        if (fault === "missing-guard") db.exec(`DROP TRIGGER ${registryTriggers[0]}`);
        if (fault === "foreign-guard") db.exec("CREATE TRIGGER registry_foreign_guard BEFORE INSERT ON workflow_template_registry BEGIN SELECT 1; END");
      } }), /registry-(before|after)-marker|registry.migration_|FOREIGN KEY/u);
      assert.equal(reached, true);
      assert.equal(db.isTransaction, false);
      assert.deepEqual(snapshot(db), before);
      assert.deepEqual(businessSnapshot(db), data);
      if (fault === "commit-fk") {
        assert.deepEqual(rows(db, "registry_migration_fault"), []);
        db.exec("DROP TRIGGER registry_migration_fault_trigger");
      }
      migrate(db);
      assert.equal(has(db)(212), true);
    });
});

test("partial migration DDL is rolled back when the last immutable trigger cannot be created", t => {
  const f = fixture(t, { fresh: true }), db = f.db;
  removeRegistryOverlay(f);
  const before = snapshot(db), exec = db.exec.bind(db);
  let reached = false;
  const fault = t.mock.method(db, "exec", sql => {
    if (sql.startsWith(`CREATE TRIGGER ${registryTriggers.at(-1)}`)) {
      reached = true;
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_template_versions'").get());
      throw new Error("registry-ddl-fault");
    }
    return exec(sql);
  });
  try { assert.throws(() => migrate(db), /registry-ddl-fault/u); }
  finally { fault.mock.restore(); }
  assert.equal(reached, true);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(snapshot(db), before);
  migrate(db);
  assert.equal(has(db)(212), true);
});

test("pending212 never adopts or ends a caller transaction; installed inspection is read-only inside it", async t => {
  for (const installed of [false, true]) await t.test(`installed=${installed}`, t => {
    const f = fixture(t, { fresh: true }), db = f.db;
    if (!installed) removeRegistryOverlay(f);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE workspaces SET name='caller-wip' WHERE id='workspace_default'").run();
      const before = snapshot(db);
      if (installed) migrate(db);
      else assert.throws(() => migrate(db), /transaction/iu);
      assert.equal(db.isTransaction, true);
      assert.deepEqual(snapshot(db), before);
    } finally { db.exec("ROLLBACK"); }
    migrate(db);
    assert.equal(has(db)(212), true);
  });
});

test("SQL constraints reject missing visibility fields, invalid kind/version/template and unpinned publication", t => {
  const f = fixture(t, { fresh: true }), db = f.db;
  const insert = (visibility, extra = {}) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO workflow_template_registry(workspace_id,id,kind,source,visibility_json,review_status,latest_version,revision,created_at,updated_at)
        VALUES('workspace_default','review',?,'custom',?,?,'v1',1,?,?)`).run(extra.kind ?? "workflow_template", visibility,
          extra.status ?? "draft", at(0), at(0));
      db.prepare(`INSERT INTO workflow_template_versions VALUES('workspace_default','review','workflow_template',?,?,?,?)`)
        .run(extra.version ?? "v1", `wt1_${"a".repeat(64)}`, extra.json ?? '{"schemaVersion":1,"id":"review"}', at(0));
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  };
  const visibility = '{"workspaceVisible":true,"promotableToWorkspace":false}';
  for (const missing of ["{}", '{"workspaceVisible":true}', '{"promotableToWorkspace":false}', '{"workspaceVisible":1,"promotableToWorkspace":false}'])
    assert.throws(() => insert(missing), /CHECK constraint/u);
  for (const extra of [{ kind: "skill" }, { status: "published" }, { version: "" }, { json: "{}" },
    { json: '{"schemaVersion":1,"id":"foreign"}' }, { json: '{"schemaVersion":"1","id":"review"}' }])
    assert.throws(() => insert(visibility, extra), /CHECK constraint|create_draft_required/u);
  assert.deepEqual(registrySnapshot(db), { workflow_template_registry: [], workflow_template_versions: [] });
});
