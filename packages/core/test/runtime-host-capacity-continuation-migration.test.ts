import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { applyRuntimeHostCapacityMigration } from "../dist/storage/sqlite/runtime-host-capacity-migration.js";
import { applyRuntimeDelegationSpawnAdmissionMigration } from "../dist/storage/sqlite/runtime-delegation-spawn-admission-migration.js";
import { applyRuntimeHostCapacityContinuationMigration, RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_VERSION,
  RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_NAME } from "../dist/storage/sqlite/runtime-host-capacity-continuation-migration.js";

type Database = Pick<DatabaseSync, "prepare" | "exec">;
type Input = Parameters<typeof applyRuntimeHostCapacityContinuationMigration>[0];
type Overrides = Partial<Omit<Input, "database">>;
type Row = Record<string, SQLInputValue>;
const now = "2026-11-07T00:00:00.000Z", later = "2026-11-07T01:00:00.000Z";
const intents = "runtime_host_capacity_intents", releases = "runtime_host_capacity_releases";
const delegations = "runtime_delegation_spawn_admissions", markerName = "runtime_host_capacity_continuations";
const sourceColumns = ["run_id", "work_unit_id", "attempt_id", "runtime_instance_id", "fencing_token"];
const receiptColumns = ["reservation_id", "reservation_token", "host_policy_revision", "reserved_at", "dispatch_token"];
const has = (db: Database) => (version: number) => !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
const record = (db: Database) => (version: number, name: string) => db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now);
const input = (db: Database, extra: Overrides = {}): Input => ({ database: db as DatabaseSync,
  hasMigration: has(db), recordMigration: record(db), ...extra });
const migrate = (db: Database, extra: Overrides = {}) => applyRuntimeHostCapacityContinuationMigration(input(db, extra));
const rows = (db: Database, table: string) => db.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all();
const changes = (db: Database) => db.prepare("SELECT total_changes() AS n").get()!.n;
const snapshot = (db: Database) => {
  const objects = db.prepare(`SELECT 'main' AS schema_name,type,name,tbl_name,sql FROM main.sqlite_master
    UNION ALL SELECT 'temp' AS schema_name,type,name,tbl_name,sql FROM temp.sqlite_master ORDER BY schema_name,type,name`).all();
  return { objects, data: Object.fromEntries(objects.filter(row => row.schema_name === "main" && row.type === "table")
    .map(row => [String(row.name), rows(db, String(row.name))])) };
};
const insert = (db: Database, table: string, row: Row) => db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")})
  VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));

function fixture(t: TestContext, { installed = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-host-continuation-migration-"))), path = join(root, "workspace.sqlite");
  const db = new DatabaseSync(path), peers: DatabaseSync[] = [];
  t.after(() => { for (const peer of peers) if (peer.isOpen) peer.close(); if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY);
    CREATE TABLE run_sessions(id TEXT PRIMARY KEY);
    CREATE TABLE work_units(id TEXT PRIMARY KEY);
    CREATE TABLE work_unit_attempts(id TEXT PRIMARY KEY);
    CREATE TABLE delegation_budget_reservations(id TEXT PRIMARY KEY);
    CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep');
    INSERT INTO workspaces VALUES('workspace'); INSERT INTO run_sessions VALUES('run');
    INSERT INTO work_units VALUES('unit'); INSERT INTO work_unit_attempts VALUES('attempt');
    INSERT INTO delegation_budget_reservations VALUES('delegation-reservation');`);
  record(db)(217, "runtime_run_queue");
  applyRuntimeHostCapacityMigration(input(db));
  applyRuntimeDelegationSpawnAdmissionMigration(input(db));
  const legacyDefinition = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(intents)!.sql;
  assert.ok(typeof legacyDefinition === "string");
  if (installed) migrate(db);
  return { db, legacyDefinition, peer() {
    const peer = new DatabaseSync(path); peer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1"); peers.push(peer); return peer;
  } };
}

function intent(id = "one", ownerKind = "attempt"): Row {
  return { intent_id: id, workspace_id: "workspace", workspace_key: "workspace-identity", canonical_cwd: "/workspace",
    database_path: "/workspace/workspace.sqlite", database_file_identity: "dev:1:ino:2", owner_kind: ownerKind,
    owner_key: `owner:${id}`, authority_digest: "a".repeat(64), created_at: now,
    ...(ownerKind === "attempt" ? { run_id: "run", work_unit_id: "unit", attempt_id: "attempt",
      runtime_instance_id: "runtime", fencing_token: "fence" } : {}) };
}
const receipt = (id = "one"): Row => ({ reservation_id: `reservation:${id}`, reservation_token: "b".repeat(64),
  host_policy_revision: 9, reserved_at: now, dispatch_token: "c".repeat(64) });

function populate(db: Database) {
  insert(db, intents, { ...intent(), ...receipt(), revoked_at: later });
  insert(db, intents, intent("workflow", "workflow_start"));
  insert(db, intents, intent("delegation", "delegation_spawn"));
  insert(db, releases, { intent_id: "one", reservation_id: "reservation:one", reservation_token: "b".repeat(64),
    kind: "no_dispatch", proof_json: '{"kind":"no_dispatch"}', proof_digest: "d".repeat(64), created_at: later, acknowledged_at: later });
  insert(db, delegations, { admission_id: "delegation", reservation_id: "delegation-reservation", attempt_number: 1,
    expected_step_revision: 0, runtime_instance_id: "runtime", idempotency_key: "delegation", status: "reserved",
    host_intent_id: "delegation", created_at: now, updated_at: now });
}

function rejectUnchanged(db: DatabaseSync, extra: Overrides = {}, pattern = /runtime_.*\.migration_/u) {
  const before = snapshot(db), count = changes(db), foreignKeys = db.prepare("PRAGMA foreign_keys").get()!.foreign_keys;
  assert.throws(() => migrate(db, extra), pattern);
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, foreignKeys);
  assert.deepEqual(snapshot(db), before);
  assert.equal(changes(db), count);
}

test("220 preserves populated 218/219 facts, receipts, outbox rows and incoming foreign keys across upgrade and reopen", t => {
  const f = fixture(t); populate(f.db);
  const before = snapshot(f.db), intentIndexes = f.db.prepare(`PRAGMA index_list(${intents})`).all();
  const references = [releases, delegations].map(table => f.db.prepare(`PRAGMA foreign_key_list(${table})`).all());
  assert.equal(RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_VERSION, 220);
  assert.equal(RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_NAME, markerName);
  assert.throws(() => insert(f.db, intents, intent("approval", "approval_resume_pending")), /CHECK/u);
  assert.throws(() => insert(f.db, intents, intent("answer", "user_input_continuation")), /CHECK/u);
  let recorded = 0;
  migrate(f.db, { recordMigration(version, name) { recorded++; record(f.db)(version, name); } });
  assert.equal(recorded, 1);
  const after = snapshot(f.db);
  assert.deepEqual(after.data, { ...before.data,
    schema_migrations: [...before.data.schema_migrations, Object.assign(Object.create(null), { version: 220, name: markerName, applied_at: now })] });
  assert.deepEqual(after.objects.filter(row => row.tbl_name !== intents), before.objects.filter(row => row.tbl_name !== intents));
  assert.deepEqual(f.db.prepare(`PRAGMA index_list(${intents})`).all(), intentIndexes);
  assert.deepEqual([releases, delegations].map(table => f.db.prepare(`PRAGMA foreign_key_list(${table})`).all()), references);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  const count = changes(f.db), schemaVersion = f.db.prepare("PRAGMA schema_version").get()!.schema_version;
  for (const db of [f.db, f.peer()]) {
    applyRuntimeHostCapacityMigration(input(db)); applyRuntimeDelegationSpawnAdmissionMigration(input(db)); migrate(db); migrate(db);
    assert.deepEqual(snapshot(db), after);
  }
  assert.equal(changes(f.db), count);
  assert.equal(f.db.prepare("PRAGMA schema_version").get()!.schema_version, schemaVersion);
});

test("220 permits pending continuation owners while retaining atomic source/receipt groups, uniqueness and dispatch checks", t => {
  const { db } = fixture(t, { installed: true });
  for (const owner of ["approval_resume_pending", "user_input_continuation"]) insert(db, intents, intent(owner, owner));
  for (const owner of ["unknown", "APPROVAL_RESUME_PENDING", "user_input_continuation ", "approval_resume_pending\0tail"])
    assert.throws(() => insert(db, intents, intent(owner, owner)), /CHECK/u);
  const update = (values: Row) => db.prepare(`UPDATE ${intents} SET ${Object.keys(values).map(column => `${column}=?`).join(",")}
    WHERE intent_id='approval_resume_pending'`).run(...Object.values(values));
  for (const column of sourceColumns) assert.throws(() => update({ [column]: column === "run_id" ? "run" : column === "work_unit_id"
    ? "unit" : column === "attempt_id" ? "attempt" : "runtime" }), /CHECK/u);
  for (const column of receiptColumns) assert.throws(() => update({ [column]: receipt()[column] }), /CHECK/u);
  assert.throws(() => update({ owner_kind: "attempt" }), /CHECK/u);
  assert.throws(() => update({ dispatched_at: now }), /CHECK/u);
  assert.throws(() => update({ revoked_at: now }), /CHECK/u);
  assert.throws(() => insert(db, intents, { ...intent("other", "approval_resume_pending"), owner_key: "owner:approval_resume_pending" }), /UNIQUE/u);
  update({ run_id: "run", work_unit_id: "unit", attempt_id: "attempt", runtime_instance_id: "runtime", fencing_token: "fence", ...receipt() });
  assert.throws(() => update({ dispatched_at: now, revoked_at: later }), /CHECK/u);
  update({ dispatched_at: now });
  assert.throws(() => update({ revoked_at: later }), /CHECK/u);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("218 and 220 require an exact 220 marker and matching callback, including empty or populated unmarked successor schemas", async t => {
  for (const fault of ["renamed", "moved", "duplicate", "callback-denies", "callback-invents", "unmarked-empty", "unmarked-populated", "marked-old-schema"])
    await t.test(fault, t => {
      const f = fixture(t, { installed: fault !== "callback-invents" && fault !== "marked-old-schema" });
      if (fault === "unmarked-populated") insert(f.db, intents, intent("approval", "approval_resume_pending"));
      if (fault === "renamed") f.db.prepare("UPDATE schema_migrations SET name='foreign220' WHERE version=220").run();
      if (fault === "moved") f.db.prepare("UPDATE schema_migrations SET version=999220 WHERE version=220").run();
      if (fault === "duplicate") record(f.db)(999220, markerName);
      if (fault.startsWith("unmarked-")) f.db.prepare("DELETE FROM schema_migrations WHERE version=220").run();
      if (fault === "marked-old-schema") record(f.db)(220, markerName);
      const extra = fault.startsWith("callback-") ? { hasMigration: (version: number) => version === 220 ? fault === "callback-invents" : has(f.db)(version) } : {};
      rejectUnchanged(f.db, extra);
      const before = snapshot(f.db);
      assert.throws(() => applyRuntimeHostCapacityMigration(input(f.db, extra)), /runtime_host_capacity\.migration_/u);
      assert.deepEqual(snapshot(f.db), before);
    });
});

test("220 never installs missing or conflicting predecessor history, even for marked successor schemas", async t => {
  for (const installed of [false, true]) for (const version of [217, 218, 219])
    for (const fault of ["missing", "renamed", "moved", "duplicate", "callback-denies", "callback-invents"])
      await t.test(`${installed}/${version}/${fault}`, t => {
        const { db } = fixture(t, { installed });
        const name = db.prepare("SELECT name FROM schema_migrations WHERE version=?").get(version)!.name;
        assert.ok(typeof name === "string");
        if (["missing", "callback-invents"].includes(fault)) db.prepare("DELETE FROM schema_migrations WHERE version=?").run(version);
        if (fault === "renamed") db.prepare("UPDATE schema_migrations SET name='foreign' WHERE version=?").run(version);
        if (fault === "moved") db.prepare("UPDATE schema_migrations SET version=999999 WHERE version=?").run(version);
        if (fault === "duplicate") record(db)(999999, name);
        const extra = fault.startsWith("callback-") ? { hasMigration: (candidate: number) => candidate === version ? fault === "callback-invents" : has(db)(candidate) } : {};
        rejectUnchanged(db, extra);
      });
});

test("220 refuses missing/weakened schemas, incoming FK orphans, unexpected objects and temporary shadows without repair", async t => {
  for (const installed of [false, true]) for (const fault of ["missing-intents", "missing-releases", "missing-delegations", "view", "extra-column",
    "weakened-owner", "extra-index", "autoindex-lookalike", "trigger", "temporary-intents", "temporary-trigger", "replacement-collision",
    "orphan-intent", "orphan-release", "orphan-delegation"])
    await t.test(`${installed}/${fault}`, t => {
      const { db } = fixture(t, { installed });
      if (fault.startsWith("missing-")) db.exec(`DROP TABLE ${fault === "missing-intents" ? intents : fault === "missing-releases" ? releases : delegations}`);
      if (fault === "view") { db.exec(`DROP TABLE ${intents}`); db.exec(`CREATE VIEW ${intents} AS SELECT id FROM workspaces`); }
      if (fault === "extra-column") db.exec(`ALTER TABLE ${intents} ADD COLUMN unexpected TEXT`);
      if (fault === "weakened-owner") {
        const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(intents)!.sql;
        assert.ok(typeof ddl === "string"); db.exec(`DROP TABLE ${intents}`);
        db.exec(ddl.replace(/CHECK\(owner_kind IN \([^)]*\)\)/u, "CHECK(length(owner_kind)>0)"));
      }
      if (fault === "extra-index") db.exec(`CREATE INDEX foreign_host_index ON ${intents}(created_at)`);
      if (fault === "autoindex-lookalike") db.exec(`CREATE INDEX sqlitexautoindex_host ON ${intents}(created_at)`);
      if (fault === "trigger") db.exec(`CREATE TRIGGER foreign_host_trigger AFTER INSERT ON ${intents} BEGIN SELECT 1; END`);
      if (fault === "temporary-intents") db.exec(`CREATE TEMP TABLE ${intents} AS SELECT * FROM main.${intents} WHERE 0`);
      if (fault === "temporary-trigger") db.exec(`CREATE TEMP TRIGGER foreign_host_trigger AFTER INSERT ON main.${intents} BEGIN SELECT 1; END`);
      if (fault === "replacement-collision") db.exec("CREATE TABLE runtime_host_capacity_intents_upgrade(value TEXT)");
      if (fault.startsWith("orphan-")) {
        db.exec("PRAGMA foreign_keys=OFF"); populate(db);
        if (fault === "orphan-intent") db.prepare(`UPDATE ${intents} SET workspace_id='missing' WHERE intent_id='one'`).run();
        if (fault === "orphan-release") db.prepare(`UPDATE ${releases} SET intent_id='missing'`).run();
        if (fault === "orphan-delegation") db.prepare(`UPDATE ${delegations} SET host_intent_id='missing'`).run();
        db.exec("PRAGMA foreign_keys=ON");
      }
      rejectUnchanged(db);
    });
});

test("220 rolls back table copy/drop/rename, marker and postcondition/COMMIT failures and restores foreign_keys", async t => {
  for (const foreignKeys of [0, 1]) for (const fault of ["create", "copy", "drop", "rename", "before-marker", "after-marker", "missing-marker", "wrong-marker", "postcondition", "commit"])
    await t.test(`${foreignKeys}/${fault}`, t => {
      const { db } = fixture(t); populate(db); db.exec(`PRAGMA foreign_keys=${foreignKeys}`);
      const before = snapshot(db), exec = db.exec.bind(db);
      let reached = false;
      const database = { prepare: db.prepare.bind(db), exec(sql: string) {
        const result = exec(sql);
        if ((fault === "create" && sql.startsWith("CREATE TABLE runtime_host_capacity_intents_upgrade"))
          || (fault === "copy" && sql.startsWith("INSERT INTO runtime_host_capacity_intents_upgrade"))
          || (fault === "drop" && sql === `DROP TABLE main.${intents}`)
          || (fault === "rename" && sql.startsWith("ALTER TABLE runtime_host_capacity_intents_upgrade"))
          || (fault === "commit" && sql === "COMMIT")) {
          if (fault === "commit") assert.fail("COMMIT fault must be injected before the commit");
          reached = true; throw new Error("injected-upgrade-failure");
        }
        return result;
      } };
      if (fault === "commit") database.exec = (sql: string) => { if (sql === "COMMIT") { reached = true; throw new Error("injected-upgrade-failure"); } return exec(sql); };
      assert.throws(() => migrate(database, { recordMigration(version, name) {
        if (fault === "before-marker") { reached = true; throw new Error("injected-upgrade-failure"); }
        if (fault === "missing-marker") { reached = true; return; }
        record(db)(version, fault === "wrong-marker" ? "foreign220" : name);
        if (fault === "after-marker") { reached = true; throw new Error("injected-upgrade-failure"); }
        if (fault === "wrong-marker") reached = true;
        if (fault === "postcondition") { reached = true; db.exec(`CREATE INDEX foreign_host_index ON ${intents}(created_at)`); }
      } }), /injected-upgrade-failure|runtime_.*\.migration_/u);
      assert.equal(reached, true);
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, foreignKeys);
      assert.deepEqual(snapshot(db), before);
      migrate(db);
      assert.deepEqual(rows(db, intents), before.data[intents]);
      assert.deepEqual(rows(db, releases), before.data[releases]);
      assert.deepEqual(rows(db, delegations), before.data[delegations]);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    });
});

test("220 reinspects under BEGIN IMMEDIATE and rejects changed authority/schema before writing", async t => {
  for (const fault of ["marker", "predecessor", "schema"]) await t.test(fault, t => {
    const { db } = fixture(t), before = snapshot(db), exec = db.exec.bind(db);
    const database = { prepare: db.prepare.bind(db), exec(sql: string) {
      const result = exec(sql);
      if (sql === "BEGIN IMMEDIATE") {
        if (fault === "marker") record(db)(220, "foreign220");
        if (fault === "predecessor") db.prepare("DELETE FROM schema_migrations WHERE version=219").run();
        if (fault === "schema") exec(`ALTER TABLE ${intents} ADD COLUMN unexpected TEXT`);
      }
      return result;
    } };
    assert.throws(() => migrate(database), /runtime_.*\.migration_/u);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  });
});

test("pending 220 cannot end a caller transaction; installed 218/220 inspection is read-only without transaction metadata", async t => {
  for (const installed of [false, true]) for (const foreignKeys of [0, 1]) for (const metadata of [false, true])
    await t.test(`${installed}/${foreignKeys}/${metadata}`, t => {
      const f = fixture(t, { installed }), db = f.db, peer = f.peer(); db.exec(`PRAGMA foreign_keys=${foreignKeys}`);
      const database = metadata ? db : { prepare: db.prepare.bind(db), exec: db.exec.bind(db) };
      for (const finish of ["COMMIT", "ROLLBACK"]) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec("UPDATE sentinel SET value='caller-write'");
          const before = snapshot(db), count = changes(db);
          if (installed) migrate(database); else assert.throws(() => migrate(database), /transaction/iu);
          applyRuntimeHostCapacityMigration(input(database));
          assert.equal(db.isTransaction, true);
          assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, foreignKeys);
          assert.deepEqual(snapshot(db), before);
          assert.equal(changes(db), count);
          assert.equal(peer.prepare("SELECT value FROM sentinel").get()!.value, "keep");
          db.exec(finish);
        } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
        assert.equal(peer.prepare("SELECT value FROM sentinel").get()!.value, finish === "COMMIT" ? "caller-write" : "keep");
        db.exec("UPDATE sentinel SET value='keep'");
      }
    });
});
