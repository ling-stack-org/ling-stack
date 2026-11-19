import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { applyNodeRerunIntentMigration, NODE_RERUN_INTENT_MIGRATION_VERSION } from "../dist/storage/sqlite/node-rerun-intent-migration.js";

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);
    INSERT INTO workspaces VALUES ('workspace');`);
  return { database, hasMigration: (version: number) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version: number, name: string) => { database.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(version, name); } };
}

test("node rerun migration preserves history and enforces workspace identity uniqueness", t => {
  const f = fixture();
  t.after(() => f.database.close());
  applyNodeRerunIntentMigration(f);
  const insert = f.database.prepare(`INSERT INTO node_rerun_intents
    (id,workspace_id,intent_id,idempotency_key,source_run_id,source_attempt_id,source_node_id,source_snapshot_digest,
      request_sha256,request_json,policy_fingerprint,status,prepared_at) VALUES (? ,? ,? ,? ,'run','attempt','node','digest','sha','{}','policy','prepared','now')`);
  insert.run("record", "workspace", "intent", "key");
  applyNodeRerunIntentMigration(f);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM node_rerun_intents").get()!.count, 1);
  assert.throws(() => insert.run("other-record", "workspace", "intent", "other-key"), /UNIQUE/u);
  assert.throws(() => insert.run("other-record", "workspace", "other-intent", "key"), /UNIQUE/u);
  f.database.exec("INSERT INTO workspaces VALUES ('other-workspace')");
  insert.run("other-record", "other-workspace", "intent", "key");
  assert.throws(() => f.database.exec("UPDATE node_rerun_intents SET status='running'"), /CHECK/u);
  f.database.exec("DELETE FROM workspaces WHERE id='workspace'");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM node_rerun_intents").get()!.count, 1);
});

test("node rerun migration fails closed for marker and schema conflicts", t => {
  for (const mutation of [
    `INSERT INTO schema_migrations VALUES (${NODE_RERUN_INTENT_MIGRATION_VERSION},'unrelated')`,
    "INSERT INTO schema_migrations VALUES (999,'node_rerun_intents')",
    `INSERT INTO schema_migrations VALUES (${NODE_RERUN_INTENT_MIGRATION_VERSION},'node_rerun_intents')`,
    "CREATE TABLE node_rerun_intents (id TEXT)",
    "CREATE TEMP TABLE node_rerun_intents (id TEXT)",
  ]) {
    const f = fixture();
    t.after(() => f.database.close());
    f.database.exec(mutation);
    assert.throws(() => applyNodeRerunIntentMigration(f), /migration_(?:marker_conflict|schema_conflict|table_missing)/u);
    assert.equal(f.database.isTransaction, false);
  }
});

test("node rerun migration rolls back a failed marker commit", t => {
  const f = fixture();
  t.after(() => f.database.close());
  assert.throws(() => applyNodeRerunIntentMigration({ ...f, recordMigration() { throw new Error("fixture marker failure"); } }), /fixture marker failure/u);
  assert.equal(f.database.prepare("SELECT 1 FROM sqlite_master WHERE name='node_rerun_intents'").get(), undefined);
  assert.equal(f.database.isTransaction, false);
  applyNodeRerunIntentMigration(f);
  assert.equal(f.hasMigration(NODE_RERUN_INTENT_MIGRATION_VERSION), true);
});

test("node rerun approval migration keeps one independent owner and survives reopen", t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-node-rerun-approval-migration-"));
  let store = createSqliteRunStore(cwd);
  t.after(() => { try { store.close(); } finally { rmSync(cwd, { recursive: true, force: true }); } });
  const db = (store as unknown as { readonly database: DatabaseSync }).database;
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=227").get()!.name, "node_rerun_approval_owner");
  assert.ok(db.prepare("PRAGMA table_info(approval_requests)").all().some((row: { readonly name?: unknown }) => row.name === "node_rerun_intent_id"));
  assert.ok(db.prepare("PRAGMA table_info(approval_checkpoints)").all().some((row: { readonly name?: unknown }) => row.name === "node_rerun_intent_id"));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='node_rerun_approval_requests'").get());
  db.prepare(`INSERT INTO node_rerun_intents
    (id,workspace_id,intent_id,idempotency_key,source_run_id,source_attempt_id,source_node_id,source_snapshot_digest,
      request_sha256,request_json,policy_fingerprint,status,prepared_at)
    VALUES ('record','workspace_default','intent','key','run','attempt','node','digest','sha','{}','${"a".repeat(64)}','prepared','now')`).run();
  db.prepare(`INSERT INTO approval_requests
    (id,node_rerun_intent_id,action_type,risk,title,description,payload_json,status,created_at,available_decisions_json)
    VALUES ('approval','record','node_rerun','high','Rerun','Rerun','{}','pending','now','["approve_once","deny"]')`).run();
  assert.throws(() => db.prepare(`INSERT INTO approval_requests
    (id,action_type,risk,title,description,payload_json,status,created_at) VALUES ('invalid','node_rerun','high','x','x','{}','pending','now')`).run(), /CHECK/u);
  store.close();
  store = createSqliteRunStore(cwd);
  assert.equal(store.getApprovalRequest("approval")?.nodeRerunIntentId, "record");
  assert.deepEqual((store as unknown as { readonly database: DatabaseSync }).database.prepare("PRAGMA foreign_key_check").all(), []);
});
