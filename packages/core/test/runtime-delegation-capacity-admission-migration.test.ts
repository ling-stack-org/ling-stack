import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore, resolveStoragePaths } from "../dist/index.js";
import { applyRuntimeConcurrencyPolicyMigration } from "../dist/storage/sqlite/runtime-concurrency-policy-migration.js";
import { applyRuntimeConcurrencyPolicyActivationMigration } from "../dist/storage/sqlite/runtime-concurrency-policy-activation-migration.js";
import { applyRuntimeDelegationCapacityAdmissionMigration, RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION,
  RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_NAME } from "../dist/storage/sqlite/runtime-delegation-capacity-admission-migration.js";
import { createBudgetHarness } from "./support/delegation-budget-fixture.mjs";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Store = ReturnType<typeof createSqliteRunStore>;
type MigrationInput = Parameters<typeof applyRuntimeDelegationCapacityAdmissionMigration>[0];
type Database = Pick<DatabaseSync, "prepare" | "exec">;
type SchemaRow = Record<string, SQLOutputValue> & { name: string; tbl_name: string; sql: string };
type Fixture = ReturnType<typeof fixture>;

const table = "runtime_delegation_capacity_admissions", predecessor = "runtime_concurrency_policy_activation";
const successors = [{ version: 217, name: "runtime_run_queue" }, { version: 218, name: "runtime_host_capacity" },
  { version: 219, name: "runtime_delegation_spawn_admissions" }, { version: 220, name: "runtime_host_capacity_continuations" }];
const successorTables = ["runtime_run_queue", "runtime_host_capacity_intents", "runtime_host_capacity_releases", "runtime_delegation_spawn_admissions"];
const successorOwned = (row: SchemaRow) => successorTables.includes(row.tbl_name);
const successorVersion = (version: SQLOutputValue) => successors.some(successor => successor.version === version);
const now = "2026-11-04T00:00:00.000Z", later = "2026-11-04T01:00:00.000Z";
const columns = ["reservation_id", "attempt_number", "workspace_id", "provider_key", "runner_id", "policy_revision", "admitted_at"];
const has = (db: Database) => (version: number) => !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
const record = (db: Database) => (version: number, name: string) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, now);
// Facades exercise the same SQLite connection with transaction metadata omitted.
const input = (db: Database, extra: Partial<Omit<MigrationInput, "database">> = {}): MigrationInput => ({ database: db as DatabaseSync, hasMigration: has(db), recordMigration: record(db), ...extra });
const migrate = (db: Database, extra: Partial<Omit<MigrationInput, "database">> = {}) => applyRuntimeDelegationCapacityAdmissionMigration(input(db, extra));
const schema = (db: Database) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as SchemaRow[];
const markers = (db: Database) => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const rows = (db: Database, name: string) => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
const changes = (db: Database) => db.prepare("SELECT total_changes() AS n").get()!.n as number;
const dataTables = ["workspaces", "tasks", "run_sessions", "work_units", "work_unit_attempts", "runtime_events", "artifacts",
  "harness_artifact_pins", "delegation_steps", "delegation_root_budgets", "delegation_budget_reservations", "delegation_budget_charges",
  "delegation_messages", "runtime_concurrency_policies", "runtime_semaphore_slots", "resource_leases", "workflow_step_admissions",
  "workflow_step_admission_entries"];
const data = (db: Database) => Object.fromEntries(dataTables.map(name => [name, rows(db, name)]));
const snapshot = (db: Database) => ({ schema: schema(db), markers: markers(db), data: data(db),
  admissions: db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? rows(db, table) : undefined });
const migrationError = /runtime_delegation_capacity_admission\.migration_/u;

function fixture(t: TestContext, { installed = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-delegation-capacity-migration-"))), cwd = join(root, "workspace");
  mkdirSync(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  let store: Store | undefined;
  const peers: DatabaseSync[] = [];
  t.after(() => {
    for (const peer of peers) if (peer.isOpen) peer.close();
    if (store && testDatabase(store).isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store = createSqliteRunStore(cwd, paths);
  const db = testDatabase(store), fullSchema = schema(db), definition = fullSchema.find(row => row.name === table)?.sql;
  assert.equal(typeof definition, "string", "the production constructor must install216");
  assert.deepEqual(markers(db).filter(row => (row.version as number) >= 215).map(({ version, name }) => ({ version, name })),
    [{ version: 215, name: predecessor }, { version: 216, name: table }, ...successors]);
  if (!installed) {
    assert.equal(db.isTransaction, false);
    assert.deepEqual(rows(db, table), []);
    assert.deepEqual(fullSchema.filter(row => row.tbl_name === table).map(row => row.name), [table]);
    for (const table of successorTables) {
      assert.deepEqual(rows(db, table), []);
      assert.deepEqual(fullSchema.filter(row => row.tbl_name === table).map(row => row.name), [table]);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [...successorTables].reverse()) db.exec(`DROP TABLE ${table}`);
      for (const successor of [...successors].reverse())
        assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=? AND name=?").run(successor.version, successor.name).changes, 1);
      db.exec(`DROP TABLE ${table}`);
      assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=216 AND name=?").run(table).changes, 1);
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()!.v, 215);
    assert.deepEqual(schema(db), fullSchema.filter(row => row.tbl_name !== table && !successorOwned(row)));
    const before = snapshot(db), count = changes(db);
    applyRuntimeConcurrencyPolicyMigration(input(db));
    applyRuntimeConcurrencyPolicyActivationMigration(input(db));
    assert.deepEqual(snapshot(db), before);
    assert.equal(changes(db), count);
  }
  return { cwd, paths, fullSchema, admissionSchema: fullSchema.filter(row => !successorOwned(row)), definition: definition!,
    get store() { return store!; }, get db() { return testDatabase(store!); },
    peer() {
      const peer = new DatabaseSync(paths.databasePath);
      peer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      peers.push(peer);
      return peer;
    },
    reopen() { store!.close(); store = undefined; store = createSqliteRunStore(cwd, paths); return store; } };
}

function assertReopenPreservesAdmissions(f: Fixture, before: ReturnType<typeof snapshot>) {
  f.reopen();
  const after = snapshot(f.db);
  assert.deepEqual(after.schema, f.fullSchema);
  assert.deepEqual(after.schema.filter(row => !successorOwned(row)), before.schema.filter(row => !successorOwned(row)));
  assert.deepEqual(after.markers.filter(row => !successorVersion(row.version)), before.markers.filter(row => !successorVersion(row.version)));
  assert.deepEqual(after.markers.filter(row => successorVersion(row.version)).map(({ version, name }) => ({ version, name })), successors);
  if (before.markers.some(row => successorVersion(row.version))) assert.deepEqual(after.markers, before.markers);
  assert.deepEqual(after.data, before.data);
  assert.deepEqual(after.admissions, before.admissions);
  for (const table of successorTables) assert.deepEqual(rows(f.db, table), []);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
}

function seedLegacy(f: Fixture) {
  const host = createBudgetHarness(f.cwd, { store: f.store, now, later: now, budget: { tokenBudget: 1000 } });
  host.freeze(); host.start();
  const children = ["legacy-one", "legacy-two"].map(spawnCallId => host.spawn({ spawnCallId,
    objective: "Retain a token-only delegation", requestedBudget: { tokenBudget: 10 }, now }));
  for (const child of children) {
    assert.equal(child.reservation.state, "reserved");
    assert.equal(f.store.listWorkUnitAttempts(child.childWorkUnit.id).length, 0);
  }
  f.db.prepare(`INSERT INTO runtime_semaphore_slots(id,workspace_id,resource_type,resource_key,owner_type,owner_id,
    work_unit_id,attempt_id,runtime_instance_id,fencing_token,status,acquired_at,last_renewed_at,expires_at)
    VALUES(?,?,'provider','legacy-provider','work_unit_attempt',?,?,?,?,?,'active',?,?,?)`)
    .run("legacy-provider-slot", DEFAULT_WORKSPACE_ID, host.attempt.id, host.unit.id, host.attempt.id,
      host.attempt.runtimeInstanceId, host.attempt.fencingToken, now, now, later);
  assert.ok(f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "workspace", resourceKey: "legacy-workspace",
    ownerType: "system", ownerId: "legacy-host", acquiredAt: now, expiresAt: later }));
  f.db.prepare(`INSERT INTO runtime_concurrency_policies(workspace_id,runtime_instance_id,revision,max_concurrent_runs,
    max_read_only_runs,max_workspace_write_runs,max_runs_per_provider,max_runs_per_runner,installed_at,enabled)
    VALUES(?,'legacy-runtime',7,64,64,4,64,64,?,1)`).run(DEFAULT_WORKSPACE_ID, now);
  return children;
}

const admission = (reservationId: string, extra: Record<string, SQLInputValue> = {}) => ({ reservation_id: reservationId, attempt_number: 1,
  workspace_id: DEFAULT_WORKSPACE_ID, provider_key: "fixture:fixture-model", runner_id: "pi", policy_revision: 7, admitted_at: now, ...extra });
const insert = (db: Database, row: Record<string, SQLInputValue>) => db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(?,?,?,?,?,?,?)`)
  .run(...columns.map(column => row[column]));

function rejectUnchanged(f: Fixture, pattern = migrationError, extra: Partial<Omit<MigrationInput, "database">> = {}, reopen = true) {
  const before = snapshot(f.db), count = changes(f.db);
  assert.throws(() => migrate(f.db, extra), pattern);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  if (reopen) {
    let unexpected: Store | undefined;
    try { assert.throws(() => { unexpected = createSqliteRunStore(f.cwd, f.paths); }, pattern); }
    finally { unexpected?.close(); }
    assert.deepEqual(snapshot(f.db), before);
    assert.equal(changes(f.db), count);
  }
}

test("fresh Core installs216 with exactly the composite identity, safe integers and two foreign keys", t => {
  const f = fixture(t, { installed: true });
  assert.equal(RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_VERSION, 216);
  assert.equal(RUNTIME_DELEGATION_CAPACITY_ADMISSION_MIGRATION_NAME, table);
  assert.deepEqual(f.db.prepare("SELECT version,name FROM schema_migrations WHERE version=216 OR name=?").all(table)
    .map(row => ({ ...row })), [{ version: 216, name: table }]);
  assert.deepEqual(f.db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, row.type, row.notnull, row.dflt_value, row.pk]),
    columns.map((name, index) => [name, [1, 5].includes(index) ? "INTEGER" : "TEXT", 1, null, index < 2 ? index + 1 : 0]));
  assert.deepEqual(f.db.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row => [row.from, row.table, row.to, row.on_delete]).sort(),
    [["reservation_id", "delegation_budget_reservations", "id", "NO ACTION"], ["workspace_id", "workspaces", "id", "NO ACTION"]]);
  assert.deepEqual(schema(f.db).filter(row => row.tbl_name === table).map(row => row.name), [table]);
  assert.deepEqual(rows(f.db, table), []);
  const before = snapshot(f.db), count = changes(f.db);
  migrate(f.db); migrate(f.db);
  applyRuntimeConcurrencyPolicyMigration(input(f.db));
  applyRuntimeConcurrencyPolicyActivationMigration(input(f.db));
  assert.equal(changes(f.db), count);
  assert.deepEqual(snapshot(f.db), before);
  f.reopen();
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("216 upgrades a populated real215 additively without backfilling token-only reservations or changing ownership", t => {
  const f = fixture(t), children = seedLegacy(f), before = snapshot(f.db), count = changes(f.db);
  for (const name of ["run_sessions", "work_units", "work_unit_attempts", "artifacts", "delegation_steps", "delegation_root_budgets",
    "delegation_budget_reservations", "runtime_concurrency_policies", "runtime_semaphore_slots", "resource_leases"])
    assert.ok(before.data[name].length > 0, `${name} must be populated`);
  migrate(f.db);
  assert.equal(changes(f.db) - count, 1, "only the216 marker is written");
  assert.deepEqual(schema(f.db), f.admissionSchema);
  assert.deepEqual(schema(f.db).filter(row => row.tbl_name !== table), before.schema);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 216), before.markers);
  assert.deepEqual(data(f.db), before.data);
  assert.deepEqual(rows(f.db, table), [], "an enabled policy must not confer provenance on old reservations");
  insert(f.db, admission(children[0].reservation.id));
  const installed = snapshot(f.db), installedChanges = changes(f.db);
  migrate(f.db); migrate(f.db);
  assert.equal(changes(f.db), installedChanges);
  assert.deepEqual(snapshot(f.db), installed);
  assertReopenPreservesAdmissions(f, installed);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("the production constructor alone upgrades215 once without synthesizing receipts", t => {
  const f = fixture(t);
  seedLegacy(f);
  const before = snapshot(f.db);
  f.reopen();
  assert.deepEqual(schema(f.db), f.fullSchema);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 216 && !successorVersion(row.version)), before.markers);
  assert.deepEqual(markers(f.db).filter(row => successorVersion(row.version)).map(({ version, name }) => ({ version, name })), successors);
  for (const table of successorTables) assert.deepEqual(rows(f.db, table), []);
  assert.deepEqual(data(f.db), before.data);
  assert.deepEqual(rows(f.db, table), []);
  const installed = snapshot(f.db);
  f.reopen();
  assert.deepEqual(snapshot(f.db), installed);
});

test("216 adopts only an exact empty unmarked table without recreating its schema", t => {
  const f = fixture(t, { installed: true });
  f.db.prepare("DELETE FROM schema_migrations WHERE version=216").run();
  const before = snapshot(f.db), count = changes(f.db), schemaVersion = f.db.prepare("PRAGMA schema_version").get()!.schema_version;
  migrate(f.db);
  assert.deepEqual(schema(f.db), before.schema);
  assert.deepEqual(data(f.db), before.data);
  assert.equal(f.db.prepare("PRAGMA schema_version").get()!.schema_version, schemaVersion);
  assert.equal(changes(f.db) - count, 1);
  assert.equal(has(f.db)(216), true);
});

test("SQLite enforces NOT NULL, safe integer ranges, nonblank identities, the composite key and foreign keys", t => {
  const f = fixture(t, { installed: true }), children = seedLegacy(f), base = admission(children[0].reservation.id);
  insert(f.db, base);
  insert(f.db, { ...base, attempt_number: Number.MAX_SAFE_INTEGER, policy_revision: Number.MAX_SAFE_INTEGER });
  insert(f.db, admission(children[1].reservation.id, { policy_revision: 1 }));
  assert.deepEqual(f.db.prepare(`SELECT typeof(attempt_number) AS attempt,typeof(policy_revision) AS revision FROM ${table}`).all()
    .map(row => ({ ...row })), Array.from({ length: 3 }, () => ({ attempt: "integer", revision: "integer" })));
  const before = snapshot(f.db), count = changes(f.db), candidate = { ...base, attempt_number: 2 };
  assert.throws(() => insert(f.db, base), /UNIQUE/u);
  for (const column of columns) assert.throws(() => insert(f.db, { ...candidate, [column]: null }), /NOT NULL/u, column);
  for (const column of ["attempt_number", "policy_revision"])
    for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "invalid", new Uint8Array([1])])
      assert.throws(() => insert(f.db, { ...candidate, [column]: value }), /CHECK/u, `${column}=${String(value)}`);
  for (const column of ["provider_key", "runner_id", "admitted_at"])
    for (const value of ["", "   "]) assert.throws(() => insert(f.db, { ...candidate, [column]: value }), /CHECK/u, column);
  assert.throws(() => insert(f.db, { ...candidate, reservation_id: "missing-reservation" }), /FOREIGN KEY/u);
  assert.throws(() => insert(f.db, { ...candidate, workspace_id: "missing-workspace" }), /FOREIGN KEY/u);
  assert.throws(() => f.db.prepare(`UPDATE ${table} SET attempt_number=0`).run(), /CHECK/u);
  assert.throws(() => f.db.prepare(`UPDATE ${table} SET workspace_id='missing-workspace'`).run(), /FOREIGN KEY/u);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  f.reopen();
  assert.deepEqual(snapshot(f.db), before);
});

test("216 requires the exact215 predecessor marker and callback agreement in pending and installed databases", async t => {
  for (const installed of [false, true]) for (const fault of ["missing", "renamed", "moved", "duplicate", "callback-denies", "callback-invents"])
    await t.test(`installed=${installed}/${fault}`, t => {
      const f = fixture(t, { installed });
      if (["missing", "callback-invents"].includes(fault)) f.db.prepare("DELETE FROM schema_migrations WHERE version=215").run();
      if (fault === "renamed") f.db.prepare("UPDATE schema_migrations SET name='foreign215' WHERE version=215").run();
      if (fault === "moved") f.db.prepare("UPDATE schema_migrations SET version=999215 WHERE version=215").run();
      if (fault === "duplicate") record(f.db)(999215, predecessor);
      const extra = fault.startsWith("callback-") ? { hasMigration: (version: number) => version === 215 ? fault === "callback-invents" : has(f.db)(version) } : {};
      rejectUnchanged(f, /migration_predecessor_missing/u, extra, false);
    });
});

test("216 refuses version or name collisions and callback disagreement without rewriting markers", async t => {
  for (const fault of ["renamed", "moved", "duplicate", "callback-denies", "callback-invents"])
    await t.test(fault, t => {
      const f = fixture(t, { installed: fault !== "callback-invents" });
      if (fault === "renamed") f.db.prepare("UPDATE schema_migrations SET name='foreign216' WHERE version=216").run();
      if (fault === "moved") f.db.prepare("UPDATE schema_migrations SET version=999216 WHERE version=216").run();
      if (fault === "duplicate") record(f.db)(999216, table);
      const extra = fault.startsWith("callback-") ? { hasMigration: (version: number) => version === 216 ? fault === "callback-invents" : has(f.db)(version) } : {};
      rejectUnchanged(f, /migration_marker_conflict/u, extra, !fault.startsWith("callback-"));
    });
});

test("a216 marker cannot conceal a missing table and unmarked data cannot be adopted", async t => {
  for (const fault of ["missing-table", "unmarked-populated"]) await t.test(fault, t => {
    const f = fixture(t, { installed: true });
    if (fault === "missing-table") f.db.exec(`DROP TABLE ${table}`);
    else {
      const children = seedLegacy(f);
      insert(f.db, admission(children[0].reservation.id));
      f.db.prepare("DELETE FROM schema_migrations WHERE version=216").run();
    }
    rejectUnchanged(f, fault === "missing-table" ? /migration_schema_missing/u : /migration_unmarked_data/u);
  });
});

test("216 rejects same-name tables or views, altered contracts and extra owned indexes or triggers", async t => {
  const changesToDefinition: Record<string, (sql: string) => string> = {
    "reservation-fk": sql => sql.replace(" REFERENCES delegation_budget_reservations(id)", ""),
    "workspace-fk": sql => sql.replace(" REFERENCES workspaces(id)", ""),
    "nullable-identity": sql => sql.replace("reservation_id TEXT NOT NULL", "reservation_id TEXT"),
    "integer-type": sql => sql.replace("attempt_number INTEGER", "attempt_number REAL"),
    "integer-check": sql => sql.replace("typeof(attempt_number)='integer' AND ", ""),
    "attempt-range": sql => sql.replace("attempt_number BETWEEN 1 AND 9007199254740991", "attempt_number BETWEEN 0 AND 9007199254740991"),
    "revision-range": sql => sql.replace("policy_revision BETWEEN 1 AND 9007199254740991", "policy_revision BETWEEN 0 AND 9007199254740991"),
    "blank-provider": sql => sql.replace("CHECK(length(trim(provider_key))>0)", "CHECK(length(provider_key)>0)"),
    "blank-runner": sql => sql.replace("CHECK(length(trim(runner_id))>0)", "CHECK(length(runner_id)>0)"),
    "blank-time": sql => sql.replace("CHECK(length(trim(admitted_at))>0)", "CHECK(length(admitted_at)>0)"),
    "primary-key": sql => sql.replace("PRIMARY KEY(reservation_id,attempt_number)", "PRIMARY KEY(reservation_id)"),
  };
  for (const installed of [false, true]) for (const fault of ["table", "view", ...Object.keys(changesToDefinition), "extra-column", "index", "trigger"])
    await t.test(`installed=${installed}/${fault}`, t => {
      const f = fixture(t, { installed });
      if (installed) f.db.exec(`DROP TABLE ${table}`);
      if (fault === "table") f.db.exec(`CREATE TABLE ${table}(id TEXT)`);
      else if (fault === "view") f.db.exec(`CREATE VIEW ${table} AS SELECT id FROM workspaces`);
      else {
        const changed = changesToDefinition[fault]?.(f.definition) ?? f.definition;
        if (changesToDefinition[fault]) assert.notEqual(changed, f.definition);
        f.db.exec(changed);
        if (fault === "extra-column") f.db.exec(`ALTER TABLE ${table} ADD COLUMN foreign_column TEXT`);
        if (fault === "index") f.db.exec(`CREATE INDEX foreign_capacity_index ON ${table}(provider_key)`);
        if (fault === "trigger") f.db.exec(`CREATE TRIGGER foreign_capacity_trigger AFTER INSERT ON ${table} BEGIN SELECT 1; END`);
      }
      rejectUnchanged(f, ["index", "trigger"].includes(fault) ? /migration_unexpected_object/u : /migration_schema_conflict/u);
    });
});

test("installed216 refuses orphaned workspace or reservation provenance even when its SQL remains exact", async t => {
  for (const column of ["reservation_id", "workspace_id"]) await t.test(column, t => {
    const f = fixture(t, { installed: true }), children = seedLegacy(f);
    f.db.exec("PRAGMA foreign_keys=OFF");
    try { insert(f.db, admission(children[0].reservation.id, { [column]: "missing-parent" })); }
    finally { f.db.exec("PRAGMA foreign_keys=ON"); }
    rejectUnchanged(f, /migration_fk_conflict/u);
  });
});

test("216 rolls back DDL, markers and owned writes at callback, postcondition and deferred COMMIT failures", async t => {
  for (const fault of ["before-marker", "after-marker", "missing-marker", "wrong-marker", "missing-table", "foreign-index", "lost-predecessor", "deferred-commit"])
    await t.test(fault, t => {
      const f = fixture(t);
      seedLegacy(f);
      if (fault === "deferred-commit") {
        f.db.exec("CREATE TABLE capacity_commit_fault(id TEXT REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED)");
        f.db.exec("CREATE TRIGGER capacity_deferred_fault AFTER INSERT ON schema_migrations WHEN NEW.version=216 BEGIN INSERT INTO capacity_commit_fault VALUES('missing-workspace'); END");
      }
      const before = snapshot(f.db);
      let reached = false;
      assert.throws(() => migrate(f.db, { recordMigration(version, name) {
        reached = true;
        assert.equal(f.db.isTransaction, true);
        assert.equal(version, 216); assert.equal(name, table);
        assert.equal(schema(f.db).find(row => row.name === table)!.sql, f.definition);
        f.db.prepare("UPDATE workspaces SET name='owned-migration-write' WHERE id=?").run(DEFAULT_WORKSPACE_ID);
        if (fault === "before-marker") throw new Error("capacity-before-marker");
        if (fault === "missing-marker") return;
        record(f.db)(version, fault === "wrong-marker" ? "foreign216" : name);
        if (fault === "after-marker") throw new Error("capacity-after-marker");
        if (fault === "missing-table") f.db.exec(`DROP TABLE ${table}`);
        if (fault === "foreign-index") f.db.exec(`CREATE INDEX foreign_capacity_index ON ${table}(policy_revision)`);
        if (fault === "lost-predecessor") f.db.prepare("DELETE FROM schema_migrations WHERE version=215").run();
      } }), /capacity-(before|after)-marker|runtime_delegation_capacity_admission\.migration_|FOREIGN KEY/u);
      assert.equal(reached, true);
      assert.equal(f.db.isTransaction, false);
      assert.deepEqual(snapshot(f.db), before);
      if (fault === "deferred-commit") {
        assert.deepEqual(rows(f.db, "capacity_commit_fault"), []);
        f.db.exec("DROP TRIGGER capacity_deferred_fault; DROP TABLE capacity_commit_fault");
      }
      migrate(f.db);
      assert.equal(has(f.db)(216), true);
      assert.deepEqual(rows(f.db, table), []);
      assert.deepEqual(data(f.db), before.data);
    });
});

test("a CREATE failure after DDL rolls back before publishing216 and remains retryable without isTransaction metadata", t => {
  const f = fixture(t), before = snapshot(f.db);
  let reached = false;
  const database = { prepare: f.db.prepare.bind(f.db), exec(sql: string) {
    const result = f.db.exec(sql);
    if (sql.startsWith(`CREATE TABLE ${table} (`)) {
      reached = true;
      assert.equal(has(f.db)(216), false);
      throw new Error("capacity-create-fault");
    }
    return result;
  } };
  assert.equal("isTransaction" in database, false);
  assert.throws(() => migrate(database), /capacity-create-fault/u);
  assert.equal(reached, true);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(snapshot(f.db), before);
  migrate(f.db);
  assert.deepEqual(schema(f.db), f.admissionSchema);
});

test("216 reinspects predecessor, marker and schema after BEGIN before creating or publishing anything", async t => {
  for (const fault of ["predecessor", "marker", "schema", "already-installed"]) await t.test(fault, t => {
    const f = fixture(t), before = snapshot(f.db);
    const database = { prepare: f.db.prepare.bind(f.db), exec(sql: string) {
      const result = f.db.exec(sql);
      if (sql === "BEGIN IMMEDIATE") {
        if (fault === "predecessor") f.db.prepare("UPDATE schema_migrations SET name='foreign215' WHERE version=215").run();
        if (fault === "marker") record(f.db)(216, "foreign216");
        if (fault === "schema") f.db.exec(`CREATE VIEW ${table} AS SELECT id FROM workspaces`);
        if (fault === "already-installed") { f.db.exec(f.definition); record(f.db)(216, table); }
      }
      return result;
    } };
    if (fault === "already-installed") migrate(database, { recordMigration() { assert.fail("must not duplicate an installed marker"); } });
    else assert.throws(() => migrate(database), migrationError);
    assert.equal(f.db.isTransaction, false);
    if (fault === "already-installed") {
      assert.deepEqual(schema(f.db), f.admissionSchema);
      assert.deepEqual(markers(f.db).filter(row => row.version !== 216), before.markers);
    } else assert.deepEqual(snapshot(f.db), before);
    migrate(f.db);
  });
});

test("pending216 never commits or rolls back an outer transaction without isTransaction; installed216 remains read-only", async t => {
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
          if (installed) migrate(database);
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
      assert.equal(has(f.db)(216), true);
    });
});
