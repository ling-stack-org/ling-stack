import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { applyRuntimeHostCapacityMigration } from "../dist/storage/sqlite/runtime-host-capacity-migration.js";
import { applyRuntimeDelegationSpawnAdmissionMigration } from "../dist/storage/sqlite/runtime-delegation-spawn-admission-migration.js";
import { applyRuntimeHostCapacityContinuationMigration } from "../dist/storage/sqlite/runtime-host-capacity-continuation-migration.js";
import { applyNodeRerunTargetMigration } from "../dist/storage/sqlite/node-rerun-target-migration.js";
import { applyRuntimeHostCapacityNodeRerunMigration as migrate,
  RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_NAME } from "../dist/storage/sqlite/runtime-host-capacity-node-rerun-migration.js";
import { hostCapacityFixture, hostCapacityWorkspace } from "./support/runtime-host-capacity-fixture.ts";
import { rewindNodeRerunCapacityFixture } from "./support/node-rerun-capacity-predecessor.ts";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Input = Parameters<typeof migrate>[0];
type Row = Record<string, SQLInputValue>;
const table = "runtime_host_capacity_intents", replacement = "runtime_host_capacity_intents_rerun_upgrade";
const releases = "runtime_host_capacity_releases", delegations = "runtime_delegation_spawn_admissions";
const now = "2026-11-17T00:00:00.000Z", later = "2026-11-17T00:01:00.000Z";
const rows = (db: DatabaseSync, name: string) => db.prepare(`SELECT * FROM main.${name}`).all();
const insert = (db: DatabaseSync, name: string, row: Row) => db.prepare(`INSERT INTO ${name}(${Object.keys(row).join(",")})
  VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
const snapshot = (db: DatabaseSync) => {
  const objects = db.prepare(`SELECT 'main' AS schema_name,type,name,tbl_name,sql FROM main.sqlite_master
    UNION ALL SELECT 'temp' AS schema_name,type,name,tbl_name,sql FROM temp.sqlite_master ORDER BY schema_name,type,name`).all();
  return { objects, data: Object.fromEntries(objects.filter(row => row.schema_name === "main" && row.type === "table")
    .map(row => [String(row.name), rows(db, String(row.name))])) };
};
const input = (db: DatabaseSync): Input => ({ database: db,
  hasMigration: version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
  recordMigration: (version, name) => { db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now); } });
const source = { run_id: "run", work_unit_id: "unit", attempt_id: "attempt", runtime_instance_id: "runtime", fencing_token: "fence" };
const receipt = { reservation_id: "reservation", reservation_token: "b".repeat(64), host_policy_revision: 7,
  reserved_at: now, dispatch_token: "c".repeat(64) };
const intent = (id: string, ownerKind = "node_rerun_target"): Row => ({ intent_id: id, workspace_id: "workspace",
  workspace_key: "workspace-key", canonical_cwd: "/workspace", database_path: "/workspace/state.sqlite", database_file_identity: "file-identity",
  owner_kind: ownerKind, owner_key: `owner:${id}`, authority_digest: "a".repeat(64), created_at: now });

function fixture(t: TestContext, installed = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-rerun-capacity-migration-"))), path = join(root, "workspace.sqlite");
  const db = new DatabaseSync(path), peers: DatabaseSync[] = [];
  t.after(() => { for (const peer of peers) if (peer.isOpen) peer.close(); if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES('workspace');
    CREATE TABLE run_sessions(id TEXT PRIMARY KEY); INSERT INTO run_sessions VALUES('run');
    CREATE TABLE work_units(id TEXT PRIMARY KEY); INSERT INTO work_units VALUES('unit');
    CREATE TABLE work_unit_attempts(id TEXT PRIMARY KEY); INSERT INTO work_unit_attempts VALUES('attempt');
    CREATE TABLE delegation_budget_reservations(id TEXT PRIMARY KEY); INSERT INTO delegation_budget_reservations VALUES('delegation');
    CREATE TABLE node_rerun_intents(id TEXT PRIMARY KEY); INSERT INTO node_rerun_intents VALUES('rerun');
    CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('retained');`);
  const config = input(db);
  config.recordMigration(217, "runtime_run_queue"); config.recordMigration(227, "node_rerun_approval_owner");
  applyRuntimeHostCapacityMigration(config); applyRuntimeDelegationSpawnAdmissionMigration(config);
  applyRuntimeHostCapacityContinuationMigration(config); applyNodeRerunTargetMigration(config);
  if (installed) migrate(config);
  return { db, config, peer() {
    const peer = new DatabaseSync(path); peer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1"); peers.push(peer); return peer;
  } };
}

function populate(db: DatabaseSync) {
  insert(db, table, { ...intent("ordinary", "attempt"), ...source, ...receipt, revoked_at: later });
  insert(db, table, intent("approval", "approval_resume_pending"));
  insert(db, table, intent("answer", "user_input_continuation"));
  insert(db, table, intent("delegation", "delegation_spawn"));
  insert(db, releases, { intent_id: "ordinary", reservation_id: receipt.reservation_id, reservation_token: receipt.reservation_token,
    kind: "no_dispatch", proof_json: '{"evidence":"retained"}', proof_digest: "d".repeat(64), created_at: later, acknowledged_at: later });
  insert(db, delegations, { admission_id: "delegation", reservation_id: "delegation", attempt_number: 1, expected_step_revision: 0,
    runtime_instance_id: "runtime", idempotency_key: "delegation", status: "reserved", host_intent_id: "delegation", created_at: now, updated_at: now });
}

test("229 preserves capacity credentials, continuation owners, release outbox and incoming references and reopens without writes", t => {
  const f = fixture(t); populate(f.db);
  const before = snapshot(f.db), foreignKeys = [releases, delegations].map(name => f.db.prepare(`PRAGMA foreign_key_list(${name})`).all());
  assert.equal(RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_VERSION, 229);
  assert.equal(RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_NAME, "runtime_host_capacity_node_rerun");
  assert.throws(() => insert(f.db, table, { ...intent("rerun"), ...source }), /CHECK/u);
  migrate(f.config);
  const after = snapshot(f.db);
  assert.deepEqual({ ...after.data, schema_migrations: before.data.schema_migrations }, before.data);
  assert.deepEqual(after.objects.filter(row => row.tbl_name !== table), before.objects.filter(row => row.tbl_name !== table));
  assert.deepEqual([releases, delegations].map(name => f.db.prepare(`PRAGMA foreign_key_list(${name})`).all()), foreignKeys);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  const count = f.db.prepare("SELECT total_changes() n").get()!.n;
  const version = f.db.prepare("PRAGMA schema_version").get()!.schema_version;
  for (const db of [f.db, f.peer()]) {
    const config = { ...input(db), recordMigration: () => assert.fail("installed inspection cannot write") };
    applyRuntimeHostCapacityMigration(config); applyRuntimeHostCapacityContinuationMigration(config);
    migrate(config); migrate(config);
    assert.deepEqual(snapshot(db), after);
  }
  assert.equal(f.db.prepare("SELECT total_changes() n").get()!.n, count);
  assert.equal(f.db.prepare("PRAGMA schema_version").get()!.schema_version, version);
});

test("229 requires the complete rerun fence and retains source, receipt, uniqueness and dispatch constraints", t => {
  const { db } = fixture(t, true);
  assert.throws(() => insert(db, table, intent("unbound")), /CHECK/u);
  for (const missing of Object.keys(source)) {
    const row: Row = { ...intent("partial"), ...source }; delete row[missing];
    assert.throws(() => insert(db, table, row), /CHECK/u);
  }
  for (const owner of ["node_rerun_intent", "NODE_RERUN_TARGET", "node_rerun_target ", "node_rerun_target\0tail"])
    assert.throws(() => insert(db, table, { ...intent(owner, owner), ...source }), /CHECK/u);
  insert(db, table, { ...intent("rerun"), ...source });
  const update = (values: Row) => db.prepare(`UPDATE ${table} SET ${Object.keys(values).map(key => `${key}=?`).join(",")} WHERE intent_id='rerun'`)
    .run(...Object.values(values));
  for (const key of Object.keys(source)) assert.throws(() => update({ [key]: null }), /CHECK/u);
  for (const [key, value] of Object.entries(receipt)) assert.throws(() => update({ [key]: value }), /CHECK/u);
  assert.throws(() => update({ dispatched_at: now }), /CHECK/u);
  assert.throws(() => update({ run_id: "missing" }), /FOREIGN KEY/u);
  assert.throws(() => insert(db, table, { ...intent("duplicate"), ...source }), /UNIQUE/u);
  update(receipt);
  assert.throws(() => update({ dispatched_at: now, revoked_at: later }), /CHECK/u);
  update({ dispatched_at: now });
  assert.throws(() => update({ revoked_at: later }), /CHECK/u);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("229 and its predecessor inspectors refuse marker, schema, shadow and foreign-key conflicts without mutation", async t => {
  const faults = ["missing-220", "missing-228", "renamed-marker", "moved-marker", "callback-denies", "callback-invents",
    "unmarked-schema", "marked-old-schema", "column", "trigger", "index", "temp-shadow", "replacement", "orphan"] as const;
  for (const fault of faults) await t.test(fault, t => {
    const f = fixture(t, ["renamed-marker", "moved-marker", "callback-denies", "unmarked-schema"].includes(fault));
    if (fault === "missing-220" || fault === "missing-228") f.db.prepare("DELETE FROM schema_migrations WHERE version=?").run(fault === "missing-220" ? 220 : 228);
    if (fault === "renamed-marker") f.db.exec("UPDATE schema_migrations SET name='foreign229' WHERE version=229");
    if (fault === "moved-marker") f.db.exec("UPDATE schema_migrations SET version=999 WHERE version=229");
    if (fault === "unmarked-schema") f.db.exec("DELETE FROM schema_migrations WHERE version=229");
    if (fault === "marked-old-schema") f.config.recordMigration(229, "runtime_host_capacity_node_rerun");
    if (fault === "column") f.db.exec(`ALTER TABLE ${table} ADD COLUMN foreign_column TEXT`);
    if (fault === "trigger") f.db.exec(`CREATE TRIGGER foreign_capacity_insert AFTER INSERT ON ${table} BEGIN SELECT 1; END`);
    if (fault === "index") f.db.exec(`CREATE INDEX foreign_capacity_index ON ${table}(owner_key)`);
    if (fault === "temp-shadow") f.db.exec(`CREATE TEMP TABLE ${table}(value TEXT)`);
    if (fault === "replacement") f.db.exec(`CREATE TEMP TABLE ${replacement}(value TEXT); INSERT INTO ${replacement} VALUES('retained')`);
    if (fault === "orphan") {
      populate(f.db); f.db.exec("PRAGMA foreign_keys=OFF"); f.db.exec("DELETE FROM work_unit_attempts"); f.db.exec("PRAGMA foreign_keys=ON");
    }
    const before = snapshot(f.db), count = f.db.prepare("SELECT total_changes() n").get()!.n;
    const config = { ...f.config, hasMigration: (version: number) => version === 229 && fault === "callback-denies" ? false
      : version === 229 && fault === "callback-invents" ? true : f.config.hasMigration(version) };
    assert.throws(() => migrate(config), /runtime_.*\.migration_/u);
    assert.deepEqual(snapshot(f.db), before); assert.equal(f.db.prepare("SELECT total_changes() n").get()!.n, count);
    assert.equal(f.db.isTransaction, false); assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  });
});

test("229 rolls back every DDL step, marker failure, postcondition and COMMIT fault and restores foreign_keys", async t => {
  for (const fault of ["create", "copy", "drop", "rename", "marker", "ignored-marker", "postcondition", "commit"])
    await t.test(fault, t => {
      const f = fixture(t); populate(f.db); const before = snapshot(f.db), exec = f.db.exec.bind(f.db);
      const mock = t.mock.method(f.db, "exec", (sql: string) => {
        if (fault === "commit" && sql === "COMMIT") throw new Error("injected-capacity-migration-fault");
        const result = exec(sql);
        if (fault === "create" && sql.startsWith(`CREATE TABLE ${replacement}`)
          || fault === "copy" && sql.startsWith(`INSERT INTO ${replacement}`)
          || fault === "drop" && sql === `DROP TABLE main.${table}`
          || fault === "rename" && sql.startsWith(`ALTER TABLE ${replacement}`)) throw new Error("injected-capacity-migration-fault");
        return result;
      });
      try {
        assert.throws(() => migrate({ ...f.config, recordMigration(version, name) {
          f.db.exec("UPDATE sentinel SET value='callback write'");
          if (fault === "marker") throw new Error("injected-capacity-migration-fault");
          if (fault === "ignored-marker") return;
          f.config.recordMigration(version, name);
          if (fault === "postcondition") f.db.exec(`ALTER TABLE ${table} ADD COLUMN foreign_column TEXT`);
        } }), /injected-capacity-migration-fault|runtime_.*\.migration_/u);
      } finally { mock.mock.restore(); }
      assert.deepEqual(snapshot(f.db), before); assert.equal(f.db.isTransaction, false);
      assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
      migrate(f.config); assert.deepEqual(rows(f.db, table), before.data[table]);
    });
});

test("229 never takes ownership of an outer writer and preserves caller foreign_keys settings", t => {
  const f = fixture(t);
  f.db.exec("BEGIN IMMEDIATE; UPDATE sentinel SET value='caller work'"); const before = snapshot(f.db);
  assert.throws(() => migrate(f.config), /nested_transaction/u);
  assert.equal(f.db.isTransaction, true); assert.deepEqual(snapshot(f.db), before);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1); f.db.exec("ROLLBACK; PRAGMA foreign_keys=OFF");
  migrate(f.config); assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 0);
  f.db.exec("BEGIN IMMEDIATE; UPDATE sentinel SET value='installed caller work'");
  const installed = snapshot(f.db); migrate(f.config);
  assert.equal(f.db.isTransaction, true); assert.deepEqual(snapshot(f.db), installed); f.db.exec("ROLLBACK");
});

test("229 busy admission preserves the peer writer and rechecks facts after acquiring its own writer", async t => {
  const f = fixture(t), peer = f.peer(); f.db.exec("PRAGMA busy_timeout=1");
  peer.exec("BEGIN IMMEDIATE; UPDATE sentinel SET value='peer work'");
  const before = snapshot(f.db);
  assert.throws(() => migrate(f.config), /locked/u);
  assert.deepEqual(snapshot(f.db), before); assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.equal(peer.isTransaction, true); assert.equal(peer.prepare("SELECT value FROM sentinel").get()!.value, "peer work");
  peer.exec("ROLLBACK");
  for (const fault of ["predecessor", "marker", "shadow"]) await t.test(fault, t => {
    const f = fixture(t), before = snapshot(f.db), exec = f.db.exec.bind(f.db);
    const mock = t.mock.method(f.db, "exec", (sql: string) => {
      const result = exec(sql);
      if (sql === "BEGIN IMMEDIATE") {
        if (fault === "predecessor") f.db.exec("UPDATE schema_migrations SET name='foreign228' WHERE version=228");
        if (fault === "marker") f.config.recordMigration(229, "foreign229");
        if (fault === "shadow") f.db.exec(`CREATE TEMP TABLE ${table}(value TEXT)`);
      }
      return result;
    });
    try { assert.throws(() => migrate(f.config), /runtime_.*\.migration_/u); }
    finally { mock.mock.restore(); }
    assert.deepEqual(snapshot(f.db), before); assert.equal(f.db.isTransaction, false);
    assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  });
  migrate(f.config);
});

test("production 228 upgrade preserves execution, capacity release and identity facts and a capacity row grants no rerun dispatch", async t => {
  const host = hostCapacityFixture(t), f = await hostCapacityWorkspace(t, host), current = f.prepare("preserved");
  const reserved = f.reserve(current), db = testDatabase(f.store);
  assert.equal(f.journal.prepareNoDispatchRelease({ intentId: reserved.intent.intentId, now: f.at(4) }).status, "prepared");
  assert.equal(f.bridge.flushRelease(reserved.intent.intentId, f.at(5)), true);
  rewindNodeRerunCapacityFixture(db);
  const before = snapshot(db); f.reopen();
  const next = testDatabase(f.store), after = snapshot(next);
  assert.deepEqual({ ...after.data, schema_migrations: before.data.schema_migrations }, before.data);
  assert.deepEqual(after.objects.filter(row => row.tbl_name !== table), before.objects.filter(row => row.tbl_name !== table));
  assert.equal(f.journal.getIntent(reserved.intent.intentId)?.revokedAt, f.at(4));
  const rerun = f.prepare("closed-rerun", { runOverrides: { parentRunId: current.run.id } }), source = f.source(rerun);
  next.prepare("UPDATE work_units SET owner_type='node_rerun_intent',owner_id='test-rerun' WHERE id=?").run(rerun.unit.id);
  for (const prepare of [f.journal.prepareAttempt.bind(f.journal), f.journal.prepareExecution.bind(f.journal)])
    assert.equal(prepare({ source, now: f.at(6) }).status, "changed");
  const identity = f.identity;
  insert(next, table, { ...intent("closed-rerun"), workspace_id: f.workspaceId, workspace_key: identity.workspaceKey,
    canonical_cwd: identity.canonicalCwd, database_path: identity.databasePath, database_file_identity: identity.databaseFileIdentity,
    ...Object.fromEntries(Object.entries(source).map(([key, value]) => [key.replace(/[A-Z]/gu, c => `_${c.toLowerCase()}`), value])),
    ...receipt, created_at: f.at(6), reserved_at: f.at(6) });
  const record = f.journal.getIntent("closed-rerun")!;
  assert.equal(record.intent.ownerKind, "node_rerun_target");
  const unchanged = snapshot(next);
  assert.equal(f.journal.consumeDispatchGate({ intentId: "closed-rerun", token: receipt.dispatch_token, source, now: f.at(7) }), false);
  assert.deepEqual(snapshot(next), unchanged);
  assert.equal(f.store.isCurrentRunExecutionOwner(rerun.run.id, rerun.fence), false);
});
