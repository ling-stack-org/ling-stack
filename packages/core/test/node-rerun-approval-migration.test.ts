import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { applyNodeRerunApprovalMigration } from "../dist/storage/sqlite/node-rerun-approval-migration.js";
import { rewindNodeRerunApprovalFixture } from "./support/node-rerun-approval-predecessor.ts";
import { testDatabase } from "./support/sqlite-test-database.ts";
import { rewindNodeRerunCapacityFixture } from "./support/node-rerun-capacity-predecessor.ts";

const now = "2026-11-16T00:00:00.000Z";
const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const data = (db: DatabaseSync) => ["approval_requests", "approval_checkpoints", "approval_postcommit_effects", "schema_migrations"]
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const input = (db: DatabaseSync) => ({ database: db,
  hasMigration: (version: number) => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
  hasColumn: (table: string, column: string) => db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column),
  recordMigration: (version: number, name: string) => { db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(version, name, now); } });
function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "ling-rerun-approval-migration-"));
  let store = createSqliteRunStore(cwd);
  t.after(() => { try { store.close(); } finally { rmSync(cwd, { recursive: true, force: true }); } });
  const channel = store.createChannel({ name: "Migration", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Retain approval", prompt: "Read status" }, now);
  const run = store.createRun({ id: "retained-run", taskId: task.id, cwd, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const approval = store.createApprovalRequest({ runId: run.id, taskId: task.id, actionType: "bash", risk: "medium", title: "Status",
    description: "Read repository", payload: { type: "bash", cwd, command: "git status", riskFlags: [] } }, now);
  store.approveApprovalRequest(approval.id, {}, now);
  rewindNodeRerunApprovalFixture(testDatabase(store));
  return { get db() { return testDatabase(store); }, reopen() { store.close(); store = createSqliteRunStore(cwd); }, approval };
}

test("227 upgrades populated226 without losing approval rows, checkpoint, ledger, indexes or application triggers", t => {
  const f = fixture(t), db = f.db;
  db.exec("CREATE INDEX custom_approval_title ON approval_requests(title)");
  db.exec("CREATE TRIGGER custom_approval_update AFTER UPDATE OF title ON approval_requests BEGIN SELECT 1; END");
  db.exec("CREATE TRIGGER custom_effect_insert AFTER INSERT ON approval_postcommit_effects BEGIN SELECT 1; END");
  const retained = data(db), custom = schema(db).filter(row => String(row.name).startsWith("custom_"));
  assert.equal(db.prepare("PRAGMA table_info(approval_requests)").all().some(row => row.name === "node_rerun_intent_id"), false);
  applyNodeRerunApprovalMigration(input(db));
  assert.deepEqual(data(db).slice(0, 2), retained.slice(0, 2).map(rows => rows.map(row => Object.assign(Object.create(null), row, { node_rerun_intent_id: null }))));
  assert.deepEqual(data(db)[2], retained[2]);
  assert.deepEqual(schema(db).filter(row => String(row.name).startsWith("custom_")), custom);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const installed = { schema: schema(db), data: data(db) };
  applyNodeRerunApprovalMigration(input(db));
  assert.deepEqual({ schema: schema(db), data: data(db) }, installed);
  f.reopen();
  const reopenedDb = f.db;
  rewindNodeRerunCapacityFixture(reopenedDb);
  reopenedDb.exec("DROP TABLE node_rerun_targets");
  assert.equal(reopenedDb.prepare("DELETE FROM schema_migrations WHERE version=228 AND name='node_rerun_targets'").run().changes, 1);
  assert.deepEqual({ schema: schema(reopenedDb), data: data(reopenedDb) }, installed);
});

test("227 rejects conflicting predecessor, markers, schema, temporary names and stale foreign keys without altering state", async t => {
  for (const fault of ["predecessor", "marker", "column", "binding", "temp", "replacement", "orphan"])
    await t.test(fault, t => {
      const f = fixture(t), db = f.db;
      if (fault === "predecessor") db.prepare("UPDATE schema_migrations SET name='other226' WHERE version=226").run();
      if (fault === "marker") input(db).recordMigration(227, "other227");
      if (fault === "column") db.exec("ALTER TABLE approval_requests ADD COLUMN foreign_column TEXT");
      if (fault === "binding") db.exec("CREATE TABLE node_rerun_approval_requests(id TEXT)");
      if (fault === "temp") db.exec("CREATE TEMP TABLE approval_requests(id TEXT)");
      if (fault === "replacement") db.exec("CREATE TABLE approval_requests_node_rerun_next(id TEXT)");
      if (fault === "orphan") { db.exec("PRAGMA foreign_keys=OFF"); db.prepare("UPDATE approval_requests SET run_id='absent'").run(); db.exec("PRAGMA foreign_keys=ON"); }
      const before = schema(db), marker = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      assert.throws(() => applyNodeRerunApprovalMigration(input(db)), /node_rerun_approval\.migration_/u);
      assert.deepEqual(schema(db), before);
      assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), marker);
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    });
});

test("227 rolls back schema, data and retained objects after marker or postcondition failure", async t => {
  for (const fault of ["throw", "ignore", "schema"])
    await t.test(fault, t => {
      const f = fixture(t), db = f.db, before = { schema: schema(db), data: data(db) };
      assert.throws(() => applyNodeRerunApprovalMigration({ ...input(db), recordMigration(version, name) {
        if (fault === "throw") throw new Error("marker failure");
        if (fault === "ignore") return;
        input(db).recordMigration(version, name);
        db.exec("DROP INDEX idx_approval_requests_node_rerun_intent");
      } }), /marker failure|node_rerun_approval\.migration_/u);
      assert.deepEqual({ schema: schema(db), data: data(db) }, before);
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
      applyNodeRerunApprovalMigration(input(db));
    });
});

test("227 never adopts caller transactions and restores PRAGMAs when BEGIN fails", t => {
  const f = fixture(t), db = f.db;
  db.exec("BEGIN IMMEDIATE");
  assert.throws(() => applyNodeRerunApprovalMigration(input(db)), /caller_transaction/u);
  assert.equal(db.isTransaction, true);
  db.exec("ROLLBACK");
  const exec = db.exec.bind(db), before = schema(db);
  const mock = t.mock.method(db, "exec", (sql: string) => {
    if (sql === "BEGIN IMMEDIATE") throw new Error("begin failure");
    return exec(sql);
  });
  try { assert.throws(() => applyNodeRerunApprovalMigration(input(db)), /begin failure/u); }
  finally { mock.mock.restore(); }
  assert.deepEqual(schema(db), before);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA legacy_alter_table").get()!.legacy_alter_table, 0);
});
