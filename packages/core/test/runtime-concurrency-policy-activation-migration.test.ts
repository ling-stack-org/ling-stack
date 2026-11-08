import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore, resolveStoragePaths } from "../dist/index.js";
import { applyRuntimeConcurrencyPolicyMigration } from "../dist/storage/sqlite/runtime-concurrency-policy-migration.js";
import { applyRuntimeConcurrencyPolicyActivationMigration, RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION,
  RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME } from "../dist/storage/sqlite/runtime-concurrency-policy-activation-migration.js";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Store = ReturnType<typeof createSqliteRunStore>;
type MigrationInput = Parameters<typeof applyRuntimeConcurrencyPolicyActivationMigration>[0];
type Database = Pick<DatabaseSync, "prepare" | "exec">;
type SchemaRow = Record<string, SQLOutputValue> & { name: string; tbl_name: string; sql: string };
type Fixture = ReturnType<typeof fixture>;

const table = "runtime_concurrency_policies", name = "runtime_concurrency_policy_activation";
const successors = [{ version: 216, name: "runtime_delegation_capacity_admissions" }, { version: 217, name: "runtime_run_queue" },
  { version: 218, name: "runtime_host_capacity" }, { version: 219, name: "runtime_delegation_spawn_admissions" },
  { version: 220, name: "runtime_host_capacity_continuations" }];
const successorTables = (successor: typeof successors[number]) => successor.version === 218 ? ["runtime_host_capacity_intents", "runtime_host_capacity_releases"]
  : successor.version === 220 ? [] : [successor.name];
const successorOwned = (row: SchemaRow) => successors.flatMap(successorTables).includes(row.tbl_name);
const successorVersion = (version: SQLOutputValue) => successors.some(successor => successor.version === version);
const now = "2026-11-03T00:00:00.000Z", later = "2026-11-03T01:00:00.000Z";
const column = "enabled INTEGER NOT NULL DEFAULT 1 CHECK(typeof(enabled)='integer' AND enabled IN (0,1))";
const has = (db: Database) => (version: number) => !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
const record = (db: Database) => (version: number, name: string) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, now);
// Facades exercise the same SQLite connection with transaction metadata omitted.
const migrationInput = (db: Database, extra: Partial<Omit<MigrationInput, "database">> = {}): MigrationInput => ({ database: db as DatabaseSync, hasMigration: has(db), recordMigration: record(db), ...extra });
const migrate = (db: Database, extra: Partial<Omit<MigrationInput, "database">> = {}) => applyRuntimeConcurrencyPolicyActivationMigration(migrationInput(db, extra));
const migrate214 = (db: Database, extra: Partial<Omit<MigrationInput, "database">> = {}) => applyRuntimeConcurrencyPolicyMigration(migrationInput(db, extra));
const schema = (db: Database) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as SchemaRow[];
const markers = (db: Database) => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const rows = (db: Database, name: string) => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
const changes = (db: Database) => db.prepare("SELECT total_changes() AS n").get()!.n as number;
const executionTables = ["workspaces", "tasks", "run_sessions", "work_units", "work_unit_attempts", "runtime_events",
  "runtime_semaphore_slots", "resource_leases", "workflow_step_admissions", "workflow_step_admission_entries",
  "approval_requests", "approval_checkpoints", "approval_postcommit_effects", "approval_policies", "state_transition_events"];
const executionRows = (db: Database) => Object.fromEntries(executionTables.map(name => [name, rows(db, name)]));
const snapshot = (db: Database) => ({ schema: schema(db), markers: markers(db), execution: executionRows(db),
  policies: db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? rows(db, table) : undefined });
const migrationError = /runtime_concurrency_policy(?:_activation)?\.migration_/u;

function fixture(t: TestContext, { installed = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-policy-activation-"))), cwd = join(root, "workspace");
  mkdirSync(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  let store: Store;
  const peers: DatabaseSync[] = [];
  t.after(() => {
    for (const peer of peers) if (peer.isOpen) peer.close();
    if (store && testDatabase(store).isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store = createSqliteRunStore(cwd, paths);
  assert.equal(testDatabase(store).prepare("SELECT name FROM schema_migrations WHERE version=214").get()!.name, table);
  assert.equal(testDatabase(store).prepare("SELECT name FROM schema_migrations WHERE version=215").get()!.name, name);
  const fullSchema = schema(testDatabase(store));
  if (!installed) {
    assert.deepEqual(rows(testDatabase(store), table), []);
    assert.deepEqual(markers(testDatabase(store)).filter(row => successorVersion(row.version)).map(({ version, name }) => ({ version, name })), successors);
    for (const table of successors.flatMap(successorTables)) {
      assert.deepEqual(rows(testDatabase(store), table), []);
      assert.deepEqual(fullSchema.filter(row => row.tbl_name === table).map(row => row.name), [table]);
    }
    testDatabase(store).exec("BEGIN IMMEDIATE");
    try {
      for (const successor of [...successors].reverse()) {
        for (const table of [...successorTables(successor)].reverse()) testDatabase(store).exec(`DROP TABLE ${table}`);
        assert.equal(testDatabase(store).prepare("DELETE FROM schema_migrations WHERE version=? AND name=?")
          .run(successor.version, successor.name).changes, 1);
      }
      testDatabase(store).exec(`ALTER TABLE ${table} DROP COLUMN enabled`);
      assert.equal(testDatabase(store).prepare("DELETE FROM schema_migrations WHERE version=215 AND name=?").run(name).changes, 1);
      testDatabase(store).exec("COMMIT");
    } catch (error) { if (testDatabase(store).isTransaction) testDatabase(store).exec("ROLLBACK"); throw error; }
    assert.equal(testDatabase(store).prepare("SELECT MAX(version) AS version FROM schema_migrations").get()!.version, 214);
    assert.equal(testDatabase(store).prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === "enabled"), false);
    const before = snapshot(testDatabase(store)), count = changes(testDatabase(store));
    migrate214(testDatabase(store));
    assert.deepEqual(snapshot(testDatabase(store)), before);
    assert.equal(changes(testDatabase(store)), count);
  }
  return { cwd, paths, fullSchema, activationSchema: fullSchema.filter(row => !successorOwned(row)),
    get store() { return store; }, get db() { return testDatabase(store); },
    peer() {
      const peer = new DatabaseSync(paths.databasePath);
      peer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      peers.push(peer);
      return peer;
    },
    reopen() { store.close(); store = createSqliteRunStore(cwd, paths); return store; } };
}

function assertReopenPreservesActivation(f: Fixture, before: ReturnType<typeof snapshot>) {
  f.reopen();
  const after = snapshot(f.db);
  assert.deepEqual(after.schema.filter(row => !successorOwned(row)), before.schema.filter(row => !successorOwned(row)));
  assert.deepEqual(after.schema.filter(successorOwned), f.fullSchema.filter(successorOwned));
  assert.deepEqual(after.markers.filter(row => !successorVersion(row.version)), before.markers.filter(row => !successorVersion(row.version)));
  assert.deepEqual(after.markers.filter(row => successorVersion(row.version)).map(({ version, name }) => ({ version, name })), successors);
  if (before.markers.some(row => successorVersion(row.version))) assert.deepEqual(after.markers, before.markers);
  assert.deepEqual(after.execution, before.execution);
  assert.deepEqual(after.policies, before.policies);
  for (const table of successors.flatMap(successorTables)) assert.deepEqual(rows(f.db, table), []);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
}

function insertPolicy(db: Database, workspaceId = DEFAULT_WORKSPACE_ID, revision = 7) {
  db.prepare(`INSERT INTO ${table}(workspace_id,runtime_instance_id,revision,max_concurrent_runs,max_read_only_runs,
    max_workspace_write_runs,max_runs_per_provider,max_runs_per_runner,installed_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(workspaceId, `runtime-${workspaceId}`, revision, 64, 3, 4, 2, 1, now);
}

function seedExecution(f: Fixture) {
  const channel = f.store.createChannel({ name: "Policy migration", boundPath: f.cwd }, now);
  const task = f.store.createTask({ channelId: channel.id, title: "Retained execution", prompt: "Retain ownership" }, now);
  const run = f.store.createRun({ id: "activation-run", cwd: f.cwd, taskId: task.id, channelId: channel.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task", ownerId: task.id,
    taskId: task.id, channelId: channel.id, idempotencyKey: "activation-unit", createdByActor: "system", request: {}, now });
  f.store.linkRunToWorkUnit(run.id, unit.id, now);
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "activation-runtime",
    runnerId: "pi", now });
  for (const [id, status] of [["activation-active", "active"], ["activation-released", "released"]]) {
    f.db.prepare(`INSERT INTO runtime_semaphore_slots(id,workspace_id,resource_type,resource_key,owner_type,owner_id,
      work_unit_id,attempt_id,runtime_instance_id,fencing_token,status,acquired_at,last_renewed_at,expires_at,released_at,release_reason)
      VALUES(?,?,'provider','activation-provider','work_unit_attempt',?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, DEFAULT_WORKSPACE_ID, attempt.id, unit.id, attempt.id, attempt.runtimeInstanceId, attempt.fencingToken,
        status, now, now, later, status === "released" ? now : null, status === "released" ? "completed" : null);
  }
  assert.ok(f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "workspace", resourceKey: "activation-workspace",
    ownerType: "system", ownerId: "activation-host", acquiredAt: now, expiresAt: later }));
  const approval = f.store.createApprovalRequest({ runId: run.id, taskId: task.id, actionType: "bash", risk: "medium",
    title: "Retained approval", description: "Read repository", payload: { type: "bash", cwd: f.cwd, command: "git status", riskFlags: [] } }, now);
  f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, now);
}

function rejectUnchanged(f: Fixture, { extra = {}, reopen = true }: {
  extra?: Partial<Omit<MigrationInput, "database">>; reopen?: boolean;
} = {}) {
  const before = snapshot(f.db), count = changes(f.db);
  assert.throws(() => migrate(f.db, extra), migrationError);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  if (reopen) {
    assert.throws(() => migrate214(f.db, extra), migrationError);
    let unexpected: Store | undefined;
    try { assert.throws(() => { unexpected = createSqliteRunStore(f.cwd, f.paths); }, migrationError); }
    finally { unexpected?.close(); }
    assert.deepEqual(snapshot(f.db), before);
    assert.equal(changes(f.db), count);
  }
}

test("fresh Core installs215 with an exact integer boolean gate and read-only214/215 reinspection", t => {
  const f = fixture(t, { installed: true });
  assert.equal(RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_VERSION, 215);
  assert.equal(RUNTIME_CONCURRENCY_POLICY_ACTIVATION_MIGRATION_NAME, name);
  assert.deepEqual(f.db.prepare("SELECT version,name FROM schema_migrations WHERE version=215 OR name=?").all(name).map(row => ({ ...row })),
    [{ version: 215, name }]);
  assert.deepEqual({ ...f.db.prepare(`PRAGMA table_info(${table})`).all().at(-1) },
    { cid: 9, name: "enabled", type: "INTEGER", notnull: 1, dflt_value: "1", pk: 0 });
  insertPolicy(f.db);
  f.db.prepare(`UPDATE ${table} SET enabled=0`).run();
  const before = snapshot(f.db), count = changes(f.db);
  migrate214(f.db); migrate(f.db); migrate(f.db);
  assert.equal(changes(f.db), count);
  assert.deepEqual(snapshot(f.db), before);
  assertReopenPreservesActivation(f, before);
  assert.equal(rows(f.db, table)[0].enabled, 0);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("215 upgrades the real214 schema and only defaults old policies to enabled without consuming revisions or execution ownership", t => {
  const f = fixture(t);
  seedExecution(f);
  insertPolicy(f.db);
  f.db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('other-workspace','Other',?,?)").run(now, now);
  insertPolicy(f.db, "other-workspace", Number.MAX_SAFE_INTEGER);
  const before = snapshot(f.db), count = changes(f.db);
  for (const table of ["tasks", "run_sessions", "work_units", "work_unit_attempts", "runtime_semaphore_slots", "resource_leases",
    "approval_requests", "approval_postcommit_effects"]) assert.ok(before.execution[table].length > 0, `${table} must be populated`);
  migrate(f.db);
  assert.equal(changes(f.db) - count, 1);
  assert.deepEqual(schema(f.db).filter(row => row.tbl_name !== table), before.schema.filter(row => row.tbl_name !== table));
  assert.equal(schema(f.db).find(row => row.name === table)!.sql,
    `${before.schema.find(row => row.name === table)!.sql.slice(0, -1)}, ${column})`);
  assert.deepEqual(schema(f.db), f.activationSchema);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 215), before.markers);
  assert.deepEqual(rows(f.db, table), before.policies!.map(row => Object.assign(Object.create(null), row, { enabled: 1 })));
  assert.deepEqual(executionRows(f.db), before.execution);
  assert.deepEqual(f.db.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row => [row.from, row.table, row.to]),
    [["workspace_id", "workspaces", "id"]]);
  const installed = snapshot(f.db), installedChanges = changes(f.db);
  migrate214(f.db); migrate(f.db);
  assert.equal(changes(f.db), installedChanges);
  assert.deepEqual(snapshot(f.db), installed);
  assertReopenPreservesActivation(f, installed);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("the production constructor alone upgrades a populated214 policy once and preserves the exact successor on reopen", t => {
  const f = fixture(t);
  insertPolicy(f.db);
  const before = snapshot(f.db);
  f.reopen();
  assert.deepEqual(schema(f.db), f.fullSchema);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 215 && !successorVersion(row.version)), before.markers);
  assert.deepEqual(markers(f.db).filter(row => successorVersion(row.version)).map(({ version, name }) => ({ version, name })), successors);
  for (const table of successors.flatMap(successorTables)) assert.deepEqual(rows(f.db, table), []);
  assert.deepEqual(executionRows(f.db), before.execution);
  assert.deepEqual(rows(f.db, table), before.policies!.map(row => Object.assign(Object.create(null), row, { enabled: 1 })));
  const installed = snapshot(f.db);
  f.reopen();
  assert.deepEqual(snapshot(f.db), installed);
});

test("SQLite defaults omitted activation to1, accepts0/1 and refuses null, non-integer and out-of-range gates", t => {
  const f = fixture(t, { installed: true });
  insertPolicy(f.db);
  assert.equal(rows(f.db, table)[0].enabled, 1);
  for (const enabled of [0, 1]) {
    f.db.prepare(`UPDATE ${table} SET enabled=?`).run(enabled);
    assert.equal(f.db.prepare(`SELECT enabled,typeof(enabled) AS type FROM ${table}`).get()!.enabled, enabled);
    assert.equal(f.db.prepare(`SELECT typeof(enabled) AS type FROM ${table}`).get()!.type, "integer");
  }
  for (const value of [null, -1, 2, 0.5, "invalid", new Uint8Array([1])]) {
    const before = snapshot(f.db), count = changes(f.db);
    assert.throws(() => f.db.prepare(`UPDATE ${table} SET enabled=?`).run(value), /CHECK|NOT NULL/u);
    assert.deepEqual(snapshot(f.db), before);
    assert.equal(changes(f.db), count);
  }
});

test("215 requires the real exact214 predecessor marker in both pending and installed databases", async t => {
  for (const installed of [false, true]) for (const fault of ["missing", "renamed", "moved", "duplicate", "callback-denies", "callback-invents"])
    await t.test(`installed=${installed}/${fault}`, t => {
      const f = fixture(t, { installed });
      if (["missing", "callback-invents"].includes(fault)) f.db.prepare("DELETE FROM schema_migrations WHERE version=214").run();
      if (fault === "renamed") f.db.prepare("UPDATE schema_migrations SET name='foreign214' WHERE version=214").run();
      if (fault === "moved") f.db.prepare("UPDATE schema_migrations SET version=999214 WHERE version=214").run();
      if (fault === "duplicate") record(f.db)(999214, table);
      const extra = fault.startsWith("callback-") ? { hasMigration: (version: number) => version === 214 ? fault === "callback-invents" : has(f.db)(version) } : {};
      rejectUnchanged(f, { extra, reopen: false });
    });
});

test("214 and215 reject conflicting successor markers and callback disagreement instead of accepting an enabled-looking schema", async t => {
  for (const fault of ["renamed", "moved", "duplicate", "callback-denies", "callback-invents"])
    await t.test(fault, t => {
      const f = fixture(t, { installed: fault !== "callback-invents" });
      if (fault === "renamed") f.db.prepare("UPDATE schema_migrations SET name='foreign215' WHERE version=215").run();
      if (fault === "moved") f.db.prepare("UPDATE schema_migrations SET version=999215 WHERE version=215").run();
      if (fault === "duplicate") record(f.db)(999215, name);
      const extra = fault.startsWith("callback-") ? { hasMigration: (version: number) => version === 215 ? fault === "callback-invents" : has(f.db)(version) } : {};
      rejectUnchanged(f, { extra, reopen: !fault.startsWith("callback-") });
      if (fault.startsWith("callback-")) assert.throws(() => migrate214(f.db, extra), /migration_marker_conflict/u);
    });
});

test("214 and215 refuse either one-sided activation state even for an empty policy table", async t => {
  for (const fault of ["unmarked-empty", "unmarked-populated", "marked-missing-column", "marked-missing-table"])
    await t.test(fault, t => {
      const f = fixture(t, { installed: true });
      if (fault === "unmarked-populated") insertPolicy(f.db);
      if (fault.startsWith("unmarked-")) f.db.prepare("DELETE FROM schema_migrations WHERE version=215").run();
      if (fault === "marked-missing-column") f.db.exec(`ALTER TABLE ${table} DROP COLUMN enabled`);
      if (fault === "marked-missing-table") f.db.exec(`DROP TABLE ${table}`);
      rejectUnchanged(f);
    });
});

test("215 strictly verifies all predecessor and successor checks, foreign keys and owned objects", async t => {
  for (const installed of [false, true]) for (const fault of ["missing-table", "view", "limit-check", "foreign-key", "extra-column", "index", "trigger", "orphan"])
    await t.test(`installed=${installed}/${fault}`, t => {
      const f = fixture(t, { installed });
      if (["missing-table", "view"].includes(fault)) f.db.exec(`DROP TABLE ${table}`);
      if (fault === "view") f.db.exec(`CREATE VIEW ${table} AS SELECT id AS workspace_id FROM workspaces`);
      if (["limit-check", "foreign-key"].includes(fault)) {
        const original = schema(f.db).find(row => row.name === table)!.sql;
        const changed = fault === "limit-check" ? original.replace("max_workspace_write_runs BETWEEN 1 AND 4", "max_workspace_write_runs BETWEEN 1 AND 64")
          : original.replace(" REFERENCES workspaces(id)", "");
        assert.notEqual(changed, original);
        f.db.exec(`DROP TABLE ${table}`); f.db.exec(changed);
      }
      if (fault === "extra-column") f.db.exec(`ALTER TABLE ${table} ADD COLUMN foreign_column TEXT`);
      if (fault === "index") f.db.exec(`CREATE INDEX foreign_policy_index ON ${table}(runtime_instance_id)`);
      if (fault === "trigger") f.db.exec(`CREATE TRIGGER foreign_policy_trigger AFTER INSERT ON ${table} BEGIN SELECT 1; END`);
      if (fault === "orphan") {
        insertPolicy(f.db);
        f.db.exec("PRAGMA foreign_keys=OFF");
        try { f.db.prepare(`UPDATE ${table} SET workspace_id='missing-workspace'`).run(); }
        finally { f.db.exec("PRAGMA foreign_keys=ON"); }
      }
      rejectUnchanged(f);
    });
});

test("a215 marker cannot conceal a weakened activation type, nullability, default or boolean check", async t => {
  for (const changed of ["enabled REAL NOT NULL DEFAULT 1 CHECK(typeof(enabled)='integer' AND enabled IN (0,1))",
    "enabled INTEGER DEFAULT 1 CHECK(typeof(enabled)='integer' AND enabled IN (0,1))",
    "enabled INTEGER NOT NULL DEFAULT 0 CHECK(typeof(enabled)='integer' AND enabled IN (0,1))",
    "enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))",
    "enabled INTEGER NOT NULL DEFAULT 1 CHECK(typeof(enabled)='integer' AND enabled BETWEEN 0 AND 2)"])
    await t.test(changed, t => {
      const f = fixture(t, { installed: true }), original = schema(f.db).find(row => row.name === table)!.sql;
      assert.ok(original.includes(column));
      f.db.exec(`DROP TABLE ${table}`); f.db.exec(original.replace(column, changed));
      rejectUnchanged(f);
    });
});

test("215 rolls back ALTER, markers, policies and owned writes on callback, postcondition and deferred COMMIT failures", async t => {
  for (const fault of ["before-marker", "after-marker", "missing-marker", "wrong-marker", "missing-column", "missing-table", "foreign-index",
    "lost-predecessor", "deferred-commit"]) await t.test(fault, t => {
    const f = fixture(t);
    insertPolicy(f.db);
    if (fault === "deferred-commit") {
      f.db.exec("CREATE TABLE activation_commit_fault(id TEXT REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED)");
      f.db.exec("CREATE TRIGGER activation_deferred_fault AFTER INSERT ON schema_migrations WHEN NEW.version=215 BEGIN INSERT INTO activation_commit_fault VALUES('missing-workspace'); END");
    }
    const before = snapshot(f.db);
    let reached = false;
    assert.throws(() => migrate(f.db, { recordMigration(version, markerName) {
      reached = true;
      assert.equal(f.db.isTransaction, true);
      assert.equal(version, 215); assert.equal(markerName, name);
      assert.equal(rows(f.db, table)[0].enabled, 1);
      f.db.prepare("UPDATE workspaces SET name='owned-migration-write' WHERE id=?").run(DEFAULT_WORKSPACE_ID);
      if (fault === "before-marker") throw new Error("activation-before-marker");
      if (fault === "missing-marker") return;
      record(f.db)(version, fault === "wrong-marker" ? "foreign215" : markerName);
      if (fault === "after-marker") throw new Error("activation-after-marker");
      if (fault === "missing-column") f.db.exec(`ALTER TABLE ${table} DROP COLUMN enabled`);
      if (fault === "missing-table") f.db.exec(`DROP TABLE ${table}`);
      if (fault === "foreign-index") f.db.exec(`CREATE INDEX foreign_activation_index ON ${table}(enabled)`);
      if (fault === "lost-predecessor") f.db.prepare("DELETE FROM schema_migrations WHERE version=214").run();
    } }), /activation-(before|after)-marker|runtime_concurrency_policy_activation\.migration_|FOREIGN KEY/u);
    assert.equal(reached, true);
    assert.equal(f.db.isTransaction, false);
    assert.deepEqual(snapshot(f.db), before);
    if (fault === "deferred-commit") {
      assert.deepEqual(rows(f.db, "activation_commit_fault"), []);
      f.db.exec("DROP TRIGGER activation_deferred_fault; DROP TABLE activation_commit_fault");
    }
    migrate(f.db);
    assert.deepEqual(rows(f.db, table), before.policies!.map(row => Object.assign(Object.create(null), row, { enabled: 1 })));
    assert.equal(has(f.db)(215), true);
  });
});

test("an ALTER failure rolls back its DDL before any marker is published and remains retryable", t => {
  const f = fixture(t), before = snapshot(f.db), exec = f.db.exec.bind(f.db);
  let reached = false;
  const fault = t.mock.method(f.db, "exec", (sql: string) => {
    const result = exec(sql);
    if (sql.startsWith(`ALTER TABLE ${table} ADD COLUMN`)) {
      reached = true;
      assert.equal(f.db.prepare(`PRAGMA table_info(${table})`).all().at(-1)!.name, "enabled");
      assert.equal(has(f.db)(215), false);
      throw new Error("activation-alter-fault");
    }
    return result;
  });
  try { assert.throws(() => migrate(f.db), /activation-alter-fault/u); }
  finally { fault.mock.restore(); }
  assert.equal(reached, true);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(snapshot(f.db), before);
  migrate(f.db);
  assert.deepEqual(schema(f.db), f.activationSchema);
});

test("215 reinspects predecessor, marker and schema under its owned transaction", async t => {
  for (const changed of ["predecessor", "marker", "schema", "already-installed"]) await t.test(changed, t => {
    const f = fixture(t), before = snapshot(f.db), exec = f.db.exec.bind(f.db);
    const fault = t.mock.method(f.db, "exec", (sql: string) => {
      const result = exec(sql);
      if (sql === "BEGIN IMMEDIATE") {
        if (changed === "predecessor") f.db.prepare("UPDATE schema_migrations SET name='foreign214' WHERE version=214").run();
        if (changed === "marker") record(f.db)(215, "foreign215");
        if (changed === "schema") exec(`ALTER TABLE ${table} ADD COLUMN foreign_column TEXT`);
        if (changed === "already-installed") { exec(`ALTER TABLE ${table} ADD COLUMN ${column}`); record(f.db)(215, name); }
      }
      return result;
    });
    try {
      if (changed === "already-installed") migrate(f.db, { recordMigration() { assert.fail("must not duplicate an installed marker"); } });
      else assert.throws(() => migrate(f.db), migrationError);
    } finally { fault.mock.restore(); }
    assert.equal(f.db.isTransaction, false);
    if (changed === "already-installed") {
      assert.deepEqual(schema(f.db), f.activationSchema);
      assert.deepEqual(markers(f.db).filter(row => row.version !== 215), before.markers);
    } else assert.deepEqual(snapshot(f.db), before);
    migrate(f.db);
  });
});

test("pending215 never adopts or ends a caller transaction, including without isTransaction metadata; installed215 is read-only", async t => {
  for (const installed of [false, true]) for (const metadata of [false, true])
    await t.test(`installed=${installed}/metadata=${metadata}`, t => {
      const f = fixture(t, { installed }), peer = f.peer();
      const original = f.db.prepare("SELECT name FROM workspaces WHERE id=?").get(DEFAULT_WORKSPACE_ID)!.name;
      const database = metadata ? f.db : { exec: f.db.exec.bind(f.db), prepare: f.db.prepare.bind(f.db) };
      assert.equal("isTransaction" in database, metadata);
      for (const finish of ["COMMIT", "ROLLBACK"]) {
        f.db.exec("BEGIN IMMEDIATE");
        try {
          f.db.prepare("UPDATE workspaces SET name='caller-write' WHERE id=?").run(DEFAULT_WORKSPACE_ID);
          const before = snapshot(f.db), count = changes(f.db);
          if (installed) { migrate(database); migrate214(database); }
          else assert.throws(() => migrate(database), /transaction/iu);
          assert.equal(f.db.isTransaction, true);
          assert.deepEqual(snapshot(f.db), before);
          assert.equal(changes(f.db), count);
          assert.equal(peer.prepare("SELECT name FROM workspaces WHERE id=?").get(DEFAULT_WORKSPACE_ID)!.name, original);
          f.db.exec(finish);
        } catch (error) { if (f.db.isTransaction) f.db.exec("ROLLBACK"); throw error; }
        assert.equal(peer.prepare("SELECT name FROM workspaces WHERE id=?").get(DEFAULT_WORKSPACE_ID)!.name,
          finish === "COMMIT" ? "caller-write" : original);
        f.db.prepare("UPDATE workspaces SET name=? WHERE id=?").run(original, DEFAULT_WORKSPACE_ID);
      }
      migrate(database);
      assert.equal(has(f.db)(215), true);
    });
});
