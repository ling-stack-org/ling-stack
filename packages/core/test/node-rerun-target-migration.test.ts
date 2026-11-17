import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { applyNodeRerunTargetMigration } from "../dist/storage/sqlite/node-rerun-target-migration.js";
import { testDatabase } from "./support/sqlite-test-database.ts";
import { predecessorCapacitySchema, rewindNodeRerunCapacityFixture } from "./support/node-rerun-capacity-predecessor.ts";

const now = "2026-11-17T00:00:00.000Z";
const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const markers = (db: DatabaseSync) => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const snapshot = (db: DatabaseSync) => ({ schema: schema(db), markers: markers(db),
  workspaces: db.prepare("SELECT * FROM workspaces ORDER BY id").all() });
const input = (db: DatabaseSync) => ({ database: db,
  hasMigration: (version: number) => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
  recordMigration: (version: number, name: string) => { db.prepare("INSERT INTO schema_migrations(version,name) VALUES(?,?)").run(version, name); } });

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO workspaces VALUES('workspace','Retained');
    CREATE TABLE node_rerun_intents(id TEXT PRIMARY KEY);
    INSERT INTO node_rerun_intents VALUES('intent');
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);
    INSERT INTO schema_migrations VALUES(227,'node_rerun_approval_owner');`);
  return db;
}

test("228 upgrades populated real227 additively and the production constructor preserves existing execution and approval data", t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-node-rerun-target-migration-"));
  let store = createSqliteRunStore(cwd);
  t.after(() => { try { store.close(); } finally { rmSync(cwd, { recursive: true, force: true }); } });
  const channel = store.createChannel({ name: "Retained", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Existing task", prompt: "Keep execution history" }, now);
  const run = store.createRun({ id: "source-run", taskId: task.id, cwd, channelId: channel.id, providerName: "fixture",
    providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const approval = store.createApprovalRequest({ runId: run.id, taskId: task.id, actionType: "bash", risk: "medium", title: "Status",
    description: "Read status", payload: { type: "bash", cwd, command: "git status", riskFlags: [] } }, now);
  const db = testDatabase(store), fullSchema = schema(db);
  rewindNodeRerunCapacityFixture(db);
  assert.deepEqual(db.prepare("SELECT * FROM node_rerun_targets").all(), []);
  db.exec("DROP TABLE node_rerun_targets");
  assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=228 AND name='node_rerun_targets'").run().changes, 1);
  const before = snapshot(db);
  const data = () => [store.getTask(task.id), store.getRun(run.id), store.getApprovalRequest(approval.id)];
  const retained = data();
  store.close(); store = createSqliteRunStore(cwd);
  const next = testDatabase(store);
  assert.deepEqual(schema(next), fullSchema);
  assert.deepEqual(predecessorCapacitySchema(schema(next).filter(row => row.tbl_name !== "node_rerun_targets")), before.schema);
  assert.deepEqual(markers(next).filter(row => row.version !== 228 && row.version !== 229), before.markers);
  assert.deepEqual(data(), retained);
  assert.deepEqual(next.prepare("SELECT * FROM node_rerun_targets").all(), []);
  assert.deepEqual(next.prepare("PRAGMA foreign_key_check").all(), []);
  const installed = snapshot(next);
  applyNodeRerunTargetMigration({ ...input(next), recordMigration: () => assert.fail("installed migration is read-only") });
  store.close(); store = createSqliteRunStore(cwd);
  assert.deepEqual(snapshot(testDatabase(store)), installed);
  assert.deepEqual(data(), retained);
});

test("228 refuses predecessor, marker, schema and temporary-name conflicts without altering state", async t => {
  for (const fault of ["predecessor", "predecessor-callback", "marker", "moved-marker", "table", "temp-table", "temp-index-name", "missing-table", "missing-index", "weakened-index", "extra-index", "trigger"] as const)
    await t.test(fault, t => {
      const db = fixture(t);
      if (["missing-table", "missing-index", "weakened-index", "extra-index", "trigger"].includes(fault)) applyNodeRerunTargetMigration(input(db));
      if (fault === "predecessor") db.exec("UPDATE schema_migrations SET name='foreign227' WHERE version=227");
      if (fault === "marker") db.exec("INSERT INTO schema_migrations VALUES(228,'foreign228')");
      if (fault === "moved-marker") db.exec("INSERT INTO schema_migrations VALUES(999,'node_rerun_targets')");
      if (fault === "table") db.exec("CREATE TABLE node_rerun_targets(id TEXT)");
      if (fault === "temp-table") db.exec("CREATE TEMP TABLE node_rerun_targets(id TEXT)");
      if (fault === "temp-index-name") db.exec("CREATE TEMP TABLE idx_node_rerun_targets_active_source(id TEXT)");
      if (fault === "missing-table") db.exec("DROP TABLE node_rerun_targets");
      if (fault === "missing-index" || fault === "weakened-index") db.exec("DROP INDEX idx_node_rerun_targets_active_source");
      if (fault === "weakened-index") db.exec("CREATE INDEX idx_node_rerun_targets_active_source ON node_rerun_targets(source_node_id)");
      if (fault === "extra-index") db.exec("CREATE INDEX foreign_target_index ON node_rerun_targets(source_node_id)");
      if (fault === "trigger") db.exec("CREATE TRIGGER foreign_target_insert BEFORE INSERT ON node_rerun_targets BEGIN SELECT 1; END");
      const before = snapshot(db);
      const config = input(db);
      assert.throws(() => applyNodeRerunTargetMigration(fault === "predecessor-callback"
        ? { ...config, hasMigration: version => version !== 227 && config.hasMigration(version) } : config), /node_rerun_target\.migration_/u);
      assert.deepEqual(snapshot(db), before);
      assert.equal(db.isTransaction, false);
    });
});

test("228 rolls back table, index, marker and callback writes on failure", async t => {
  for (const fault of ["throw", "ignore", "wrong-marker", "postcondition", "commit"] as const) await t.test(fault, t => {
    const db = fixture(t);
    if (fault === "commit") db.exec(`CREATE TABLE deferred_target_failure(id TEXT REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER deferred_target_marker AFTER INSERT ON schema_migrations WHEN NEW.version=228
      BEGIN INSERT INTO deferred_target_failure VALUES('missing'); END;`);
    const before = snapshot(db);
    assert.throws(() => applyNodeRerunTargetMigration({ ...input(db), recordMigration(version, name) {
      db.exec("UPDATE workspaces SET name='callback write'");
      if (fault === "throw") throw new Error("target marker failure");
      if (fault === "ignore") return;
      input(db).recordMigration(version, fault === "wrong-marker" ? "foreign228" : name);
      if (fault === "postcondition") db.exec("DROP INDEX idx_node_rerun_targets_active_source");
    } }), /target marker failure|node_rerun_target\.migration_|FOREIGN KEY/u);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.isTransaction, false);
    if (fault === "commit") {
      assert.deepEqual(db.prepare("SELECT * FROM deferred_target_failure").all(), []);
      db.exec("DROP TRIGGER deferred_target_marker");
    }
    applyNodeRerunTargetMigration(input(db));
  });
});

test("228 pending migration never adopts a caller transaction and installed inspection is read-only", t => {
  const db = fixture(t);
  db.exec("BEGIN IMMEDIATE");
  db.exec("UPDATE workspaces SET name='caller write'");
  const before = snapshot(db);
  assert.throws(() => applyNodeRerunTargetMigration(input(db)), /transaction/iu);
  assert.equal(db.isTransaction, true);
  assert.deepEqual(snapshot(db), before);
  db.exec("ROLLBACK");
  applyNodeRerunTargetMigration(input(db));
  db.exec("BEGIN IMMEDIATE");
  const installed = snapshot(db);
  applyNodeRerunTargetMigration(input(db));
  assert.equal(db.isTransaction, true);
  assert.deepEqual(snapshot(db), installed);
  db.exec("ROLLBACK");
});
