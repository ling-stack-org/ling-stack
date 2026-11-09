import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore, resolveStoragePaths } from "../dist/index.js";
import { applyRuntimeConcurrencyPolicyMigration } from "../dist/storage/sqlite/runtime-concurrency-policy-migration.js";
import { applyRuntimeConcurrencyPolicyActivationMigration } from "../dist/storage/sqlite/runtime-concurrency-policy-activation-migration.js";
import { applyRuntimeDelegationCapacityAdmissionMigration } from "../dist/storage/sqlite/runtime-delegation-capacity-admission-migration.js";
import { applyRuntimeDelegationSpawnAdmissionMigration } from "../dist/storage/sqlite/runtime-delegation-spawn-admission-migration.js";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Connection = Pick<DatabaseSync, "exec" | "prepare"> & Partial<Pick<DatabaseSync, "isTransaction">>;
type Migration = typeof import("../dist/storage/sqlite/runtime-run-queue-migration.js");
type MigrationInput = Parameters<Migration["applyRuntimeRunQueueMigration"]>[0];
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };
type Marker = { version: number; name: string; applied_at: string };

// Exercise the authored migration without writing shared dist; dependencies use the installed Core build.
const sourceUrl = new URL("../src/storage/sqlite/runtime-run-queue-migration.ts", import.meta.url);
const builtUrl = new URL("../dist/storage/sqlite/runtime-run-queue-migration.js", import.meta.url);
const source = stripTypeScriptTypes(await readFile(sourceUrl, "utf8"), { mode: "strip" })
  .replace(/from (["'])(\.[^"']+)\1/gu, (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, builtUrl).href)}`);
const { applyRuntimeRunQueueMigration, RUNTIME_RUN_QUEUE_MIGRATION_VERSION, RUNTIME_RUN_QUEUE_MIGRATION_NAME }
  : Migration = await import(`data:text/javascript,${encodeURIComponent(`${source}\n//# sourceURL=${sourceUrl.href}`)}`);

const table = "runtime_run_queue", predecessor = "runtime_delegation_capacity_admissions";
const successor = { version: 218, name: "runtime_host_capacity" };
const successorTables = ["runtime_host_capacity_intents", "runtime_host_capacity_releases"];
const successorOwned = (row: SchemaRow) => successorTables.includes(row.tbl_name);
const now = "2026-11-04T00:00:00.000Z", later = "2026-11-04T01:00:00.000Z";
const required = ["run_id", "workspace_id", "work_unit_id", "attempt_id", "runtime_instance_id", "fencing_token",
  "snapshot_digest", "group_key", "queued_at", "reason", "revision", "last_selected"];
const claimColumns = ["claim_owner_id", "claim_token", "claim_runtime_instance_id", "claim_expires_at"];
const nullable = [...claimColumns, "retry_at", "dispatched_at"];
const claim: Record<string, string> = { claim_owner_id: "queue-host", claim_token: "queue-token", claim_runtime_instance_id: "queue-runtime", claim_expires_at: later };
const has = (db: Connection) => (version: number) => !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
const record = (db: Connection) => (version: number, name: string) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, now);
// Metadata-free connections forward real SQLite operations to exercise older runtime capabilities.
const input = (db: Connection, extra: Partial<MigrationInput> = {}): MigrationInput =>
  ({ database: db as DatabaseSync, hasMigration: has(db), recordMigration: record(db), ...extra });
const migrate = (db: Connection, extra: Partial<MigrationInput> = {}) => applyRuntimeRunQueueMigration(input(db, extra));
const schema = (db: Connection) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as SchemaRow[];
const markers = (db: Connection) => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all() as Marker[];
const rows = (db: Connection, name: string) => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
const changes = (db: Connection) => Number(db.prepare("SELECT total_changes() AS n").get()!.n);
const dataTables = ["workspaces", "tasks", "run_sessions", "work_units", "work_unit_attempts", "runtime_events", "artifacts",
  "runtime_concurrency_policies", "runtime_delegation_capacity_admissions", "runtime_semaphore_slots", "resource_leases",
  "workflow_step_admissions", "workflow_step_admission_entries"];
const data = (db: Connection) => Object.fromEntries(dataTables.map(name => [name, rows(db, name)]));
const snapshot = (db: Connection) => ({ schema: schema(db), markers: markers(db), data: data(db),
  sequences: db.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all(),
  queue: db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? rows(db, table) : undefined });
const migrationError = /runtime_run_queue\.migration_/u;
const insert = (db: Connection, row: Record<string, SQLInputValue>) => db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
  .run(...Object.values(row));
const update = (db: Connection, row: Record<string, SQLInputValue>) => db.prepare(`UPDATE ${table} SET ${Object.keys(row).map(name => `${name}=?`).join(",")}`)
  .run(...Object.values(row));

function fixture(t: TestContext, { installed = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-runtime-queue-migration-"))), cwd = join(root, "workspace");
  mkdirSync(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  let store: ReturnType<typeof createSqliteRunStore> | undefined;
  const peers: DatabaseSync[] = [];
  t.after(() => {
    for (const peer of peers) if (peer.isOpen) peer.close();
    if (store && testDatabase(store).isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store = createSqliteRunStore(cwd, paths);
  const db = testDatabase(store);
  // This suite exercises the 217/218 history in isolation. The current Core
  // bootstrap also installs the later 219/220 migrations, so remove those
  // later-owned objects before taking the historical schema snapshot.
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec("DROP TABLE IF EXISTS runtime_delegation_spawn_admissions");
    db.prepare("DELETE FROM schema_migrations WHERE version IN (219,220)").run();
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=216").get()!.name, predecessor);
  migrate(db);
  const currentSchema = schema(db), definition = currentSchema.find(row => row.name === table)!.sql;
  assert.ok(typeof definition === "string");
  assert.deepEqual(markers(db).filter(row => row.version >= 216).map(({ version, name }) => ({ version, name })),
    [{ version: 216, name: predecessor }, { version: 217, name: table }, successor]);
  for (const table of successorTables) {
    assert.deepEqual(rows(db, table), []);
    assert.deepEqual(currentSchema.filter(row => row.tbl_name === table).map(row => row.name), [table]);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [...successorTables].reverse()) db.exec(`DROP TABLE ${table}`);
    assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=? AND name=?").run(successor.version, successor.name).changes, 1);
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  const fullSchema = schema(db);
  assert.deepEqual(fullSchema, currentSchema.filter(row => !successorOwned(row)));
  if (!installed) {
    assert.equal(db.isTransaction, false);
    assert.deepEqual(rows(db, table), []);
    assert.deepEqual(fullSchema.filter(row => row.tbl_name === table).map(row => row.name), [table]);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`DROP TABLE ${table}`);
      assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=217 AND name=?").run(table).changes, 1);
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()!.v, 216);
    assert.deepEqual(schema(db), fullSchema.filter(row => row.tbl_name !== table));
    const before = snapshot(db), count = changes(db);
    applyRuntimeConcurrencyPolicyMigration(input(db));
    applyRuntimeConcurrencyPolicyActivationMigration(input(db));
    applyRuntimeDelegationCapacityAdmissionMigration(input(db));
    assert.deepEqual(snapshot(db), before);
    assert.equal(changes(db), count);
  }
  return { cwd, paths, fullSchema, currentSchema, definition, get store() { assert.ok(store); return store; },
    get db() { assert.ok(store); return testDatabase(store); },
    peer() {
      const peer = new DatabaseSync(paths.databasePath);
      peer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      peers.push(peer);
      return peer;
    },
    reopen() {
      assert.ok(store); store.close(); store = undefined;
      const bootstrap = new DatabaseSync(paths.databasePath);
      bootstrap.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      if (bootstrap.prepare("SELECT 1 FROM schema_migrations WHERE version=218").get()
        && !bootstrap.prepare("SELECT 1 FROM schema_migrations WHERE version=219").get()) {
        applyRuntimeDelegationSpawnAdmissionMigration({
          database: bootstrap,
          hasMigration: version => Boolean(bootstrap.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
          recordMigration: (version, name) => { bootstrap.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(version, name, now); },
        });
      }
      if (bootstrap.prepare("SELECT 1 FROM schema_migrations WHERE version=218").get()
        && !bootstrap.prepare("SELECT 1 FROM schema_migrations WHERE version=220").get()) {
        bootstrap.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
          .run(220, "runtime_host_capacity_continuations", now);
      }
      bootstrap.close();
      const next = createSqliteRunStore(cwd, paths);
      const nextDb = testDatabase(next);
      nextDb.exec("PRAGMA foreign_keys=OFF");
      try {
        nextDb.exec("DROP TABLE IF EXISTS runtime_delegation_spawn_admissions");
        nextDb.prepare("DELETE FROM schema_migrations WHERE version IN (219,220)").run();
      } finally {
        nextDb.exec("PRAGMA foreign_keys=ON");
      }
      try { migrate(nextDb); } catch (error) { next.close(); throw error; }
      store = next;
      return store;
    } };
}

type Fixture = ReturnType<typeof fixture>;
function assertReopenPreservesQueue(f: Fixture, before: ReturnType<typeof snapshot>) {
  f.reopen();
  const after = snapshot(f.db);
  assert.deepEqual(after.schema, f.currentSchema);
  assert.deepEqual(after.schema.filter(row => !successorOwned(row)), before.schema);
  assert.deepEqual(after.markers.filter(row => row.version !== successor.version), before.markers);
  assert.deepEqual(after.markers.filter(row => row.version === successor.version).map(({ version, name }) => ({ version, name })), [successor]);
  assert.deepEqual(after.data, before.data);
  assert.deepEqual(after.queue, before.queue);
  assert.deepEqual(after.sequences, before.sequences);
  for (const table of successorTables) assert.deepEqual(rows(f.db, table), []);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  const installed = snapshot(f.db);
  f.reopen();
  assert.deepEqual(snapshot(f.db), installed);
}

function queuedRun(f: Fixture, id = "one") {
  const runId = `queue-run-${id}`;
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: runId,
    idempotencyKey: `queue-unit-${id}`, createdByActor: "system", request: {}, now });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "queue-runtime", runnerId: "pi", status: "created", now });
  const run = f.store.createRun({ id: runId, cwd: f.cwd, workUnitId: unit.id, taskId: "inline-task", providerName: "fixture",
    providerModel: "fixture-model", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  f.store.linkRunToWorkUnit(run.id, unit.id, now);
  assert.equal(run.status, "queued");
  assert.equal(f.store.getWorkUnitAttempt(attempt.id)!.status, "created");
  return { run_id: run.id, workspace_id: DEFAULT_WORKSPACE_ID, work_unit_id: unit.id, attempt_id: attempt.id,
    runtime_instance_id: attempt.runtimeInstanceId, fencing_token: attempt.fencingToken, snapshot_digest: "a".repeat(64),
    group_key: "channel:queue-fixture", queued_at: now, reason: "resource_conflict" };
}

function rejectUnchanged(f: Fixture, pattern = migrationError, extra: Partial<MigrationInput> = {}, reopen = true) {
  const before = snapshot(f.db), count = changes(f.db);
  assert.throws(() => migrate(f.db, extra), pattern);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  if (reopen) {
    const peer = f.peer();
    assert.throws(() => migrate(peer), pattern);
    assert.deepEqual(snapshot(peer), before);
    assert.deepEqual(snapshot(f.db), before);
    assert.equal(changes(f.db), count);
  }
}

test("217 installs the exact queue schema, four real foreign keys and three unique execution identities on a fresh Core database", t => {
  const f = fixture(t), before = snapshot(f.db), count = changes(f.db);
  assert.equal(RUNTIME_RUN_QUEUE_MIGRATION_VERSION, 217);
  assert.equal(RUNTIME_RUN_QUEUE_MIGRATION_NAME, table);
  migrate(f.db);
  assert.equal(changes(f.db) - count, 1);
  assert.deepEqual(schema(f.db), f.fullSchema);
  assert.deepEqual(schema(f.db).filter(row => row.tbl_name !== table), before.schema);
  assert.deepEqual(data(f.db), before.data);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 217), before.markers);
  assert.deepEqual(f.db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, row.type, row.notnull, row.dflt_value, row.pk]),
    [["sequence", "INTEGER", 0, null, 1], ...required.map(name => [name,
      ["revision", "last_selected"].includes(name) ? "INTEGER" : "TEXT", 1, name === "revision" ? "1" : name === "last_selected" ? "0" : null, 0]),
    ...nullable.map(name => [name, "TEXT", 0, null, 0])]);
  assert.match(f.definition, /sequence INTEGER PRIMARY KEY AUTOINCREMENT/u);
  assert.deepEqual(f.db.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row => [row.from, row.table, row.to, row.on_delete]).sort(),
    [["attempt_id", "work_unit_attempts", "id", "NO ACTION"], ["run_id", "run_sessions", "id", "NO ACTION"],
      ["work_unit_id", "work_units", "id", "NO ACTION"], ["workspace_id", "workspaces", "id", "NO ACTION"]]);
  const indexes = f.db.prepare(`PRAGMA index_list(${table})`).all();
  assert.equal(indexes.length, 3);
  assert.ok(indexes.every(row => row.unique === 1 && row.origin === "u"));
  assert.deepEqual(indexes.map(row => f.db.prepare(`PRAGMA index_info(${row.name})`).all().map(column => column.name)).sort(),
    [["attempt_id"], ["run_id"], ["work_unit_id"]]);
  assert.deepEqual(rows(f.db, table), []);
});

test("217 upgrades a populated real216 without backfilling queued Runs or changing Attempts, slots, leases or policies", t => {
  const f = fixture(t), base = queuedRun(f), second = queuedRun(f, "two");
  f.db.prepare(`INSERT INTO runtime_semaphore_slots(id,workspace_id,resource_type,resource_key,owner_type,owner_id,
    work_unit_id,attempt_id,runtime_instance_id,fencing_token,status,acquired_at,last_renewed_at,expires_at)
    VALUES('queue-retained-slot',?,'provider','queue-provider','work_unit_attempt',?,?,?,?,?,'active',?,?,?)`)
    .run(DEFAULT_WORKSPACE_ID, base.attempt_id, base.work_unit_id, base.attempt_id, base.runtime_instance_id, base.fencing_token, now, now, later);
  assert.ok(f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "workspace", resourceKey: "queue-workspace",
    ownerType: "system", ownerId: "queue-host", acquiredAt: now, expiresAt: later }));
  f.db.prepare(`INSERT INTO runtime_concurrency_policies(workspace_id,runtime_instance_id,revision,max_concurrent_runs,
    max_read_only_runs,max_workspace_write_runs,max_runs_per_provider,max_runs_per_runner,installed_at,enabled)
    VALUES(?,'queue-runtime',7,64,64,4,64,64,?,0)`).run(DEFAULT_WORKSPACE_ID, now);
  const before = snapshot(f.db), count = changes(f.db);
  migrate(f.db);
  assert.equal(changes(f.db) - count, 1, "only the217 marker is written");
  assert.deepEqual(schema(f.db), f.fullSchema);
  assert.deepEqual(data(f.db), before.data);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 217), before.markers);
  assert.deepEqual(rows(f.db, table), [], "old queued Runs are not automatically eligible for dispatch");
  insert(f.db, base); insert(f.db, { ...second, reason: "runtime_semaphore_conflict" });
  const installed = snapshot(f.db), installedChanges = changes(f.db);
  migrate(f.db); migrate(f.db);
  assert.equal(changes(f.db), installedChanges);
  assert.deepEqual(snapshot(f.db), installed);
  assertReopenPreservesQueue(f, installed);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("217 adopts only an exact empty unmarked table and idempotent inspection never changes schema or markers", t => {
  const f = fixture(t, { installed: true });
  f.db.prepare("DELETE FROM schema_migrations WHERE version=217").run();
  const before = snapshot(f.db), count = changes(f.db), schemaVersion = f.db.prepare("PRAGMA schema_version").get()!.schema_version;
  migrate(f.db);
  assert.equal(changes(f.db) - count, 1);
  assert.deepEqual(schema(f.db), before.schema);
  assert.deepEqual(data(f.db), before.data);
  assert.equal(f.db.prepare("PRAGMA schema_version").get()!.schema_version, schemaVersion);
  const installed = snapshot(f.db), installedChanges = changes(f.db);
  migrate(f.db); migrate(f.db);
  assert.deepEqual(snapshot(f.db), installed);
  assert.equal(changes(f.db), installedChanges);
});

test("SQLite enforces required fields, safe integer defaults and bounds, lowercase hex digests and conflict reasons", t => {
  const f = fixture(t, { installed: true }), base = queuedRun(f);
  insert(f.db, base);
  assert.equal(rows(f.db, table)[0].revision, 1);
  assert.equal(rows(f.db, table)[0].last_selected, 0);
  for (const column of nullable) assert.equal(rows(f.db, table)[0][column], null);
  const before = snapshot(f.db), count = changes(f.db);
  for (const column of required) assert.throws(() => update(f.db, { [column]: null }), /NOT NULL/u, column);
  for (const column of ["revision", "last_selected"])
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "invalid", new Uint8Array([1])])
      assert.throws(() => update(f.db, { [column]: value }), /CHECK/u, `${column}=${String(value)}`);
  assert.throws(() => update(f.db, { revision: 0 }), /CHECK/u);
  for (const value of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "a".repeat(63) + " ",
    "a".repeat(63) + "\0", "a".repeat(64) + "\0tail", new Uint8Array(64).fill(97)])
    assert.throws(() => update(f.db, { snapshot_digest: value }), /CHECK/u);
  for (const reason of ["", "conflict", "RESOURCE_CONFLICT", "resource_conflict\0tail", "runtime_semaphore_conflict "])
    assert.throws(() => update(f.db, { reason }), /CHECK/u);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  update(f.db, { revision: Number.MAX_SAFE_INTEGER, last_selected: Number.MAX_SAFE_INTEGER,
    snapshot_digest: "0123456789abcdef".repeat(4), reason: "runtime_semaphore_conflict" });
  assert.deepEqual({ ...f.db.prepare(`SELECT typeof(revision) AS revision,typeof(last_selected) AS selected FROM ${table}`).get() },
    { revision: "integer", selected: "integer" });
  const installed = snapshot(f.db);
  assertReopenPreservesQueue(f, installed);
});

test("claim columns are all null or all nonblank, and a dispatched row cannot lose its claim", t => {
  const f = fixture(t, { installed: true });
  insert(f.db, queuedRun(f));
  const before = snapshot(f.db), count = changes(f.db);
  for (let mask = 1; mask < 15; mask++) {
    const partial = Object.fromEntries(claimColumns.map((column, index) => [column, mask & (1 << index) ? claim[column] : null]));
    assert.throws(() => update(f.db, partial), /CHECK/u, `claim mask=${mask}`);
  }
  for (const column of claimColumns) for (const value of ["", "   ", "\0"])
    assert.throws(() => update(f.db, { ...claim, [column]: value }), /CHECK/u, column);
  assert.throws(() => update(f.db, { dispatched_at: now }), /CHECK/u);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  update(f.db, { ...claim, retry_at: later, dispatched_at: now });
  assert.equal(rows(f.db, table)[0].dispatched_at, now);
  const dispatched = snapshot(f.db);
  assert.throws(() => update(f.db, Object.fromEntries(claimColumns.map(column => [column, null]))), /CHECK/u);
  assert.deepEqual(snapshot(f.db), dispatched);
  update(f.db, { ...Object.fromEntries(claimColumns.map(column => [column, null])), dispatched_at: null, retry_at: null });
  assert.deepEqual(rows(f.db, table), before.queue);
});

test("run, WorkUnit and Attempt uniqueness and all four parent foreign keys reject independent collisions", t => {
  const f = fixture(t, { installed: true }), base = queuedRun(f), candidate = queuedRun(f, "two");
  insert(f.db, base);
  const before = snapshot(f.db), count = changes(f.db);
  for (const column of ["run_id", "work_unit_id", "attempt_id"] as const)
    assert.throws(() => insert(f.db, { ...candidate, [column]: base[column] }), /UNIQUE/u, column);
  for (const column of ["run_id", "workspace_id", "work_unit_id", "attempt_id"])
    assert.throws(() => insert(f.db, { ...candidate, [column]: "missing-parent" }), /FOREIGN KEY/u, column);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
});

test("AUTOINCREMENT does not reuse the highest deleted sequence and survives real SQLite reopen", t => {
  const f = fixture(t, { installed: true });
  const first = insert(f.db, queuedRun(f)), second = insert(f.db, queuedRun(f, "two"));
  assert.equal(first.lastInsertRowid, 1);
  assert.equal(second.lastInsertRowid, 2);
  f.db.prepare(`DELETE FROM ${table} WHERE sequence=2`).run();
  const third = insert(f.db, queuedRun(f, "three"));
  assert.equal(third.lastInsertRowid, 3);
  const installed = snapshot(f.db);
  assertReopenPreservesQueue(f, installed);
  assert.equal(insert(f.db, queuedRun(f, "four")).lastInsertRowid, 4);
});

test("217 requires the exact216 predecessor marker and callback agreement in pending and installed databases", async t => {
  for (const installed of [false, true]) for (const fault of ["missing", "renamed", "moved", "duplicate", "callback-denies", "callback-invents"])
    await t.test(`installed=${installed}/${fault}`, t => {
      const f = fixture(t, { installed });
      if (["missing", "callback-invents"].includes(fault)) f.db.prepare("DELETE FROM schema_migrations WHERE version=216").run();
      if (fault === "renamed") f.db.prepare("UPDATE schema_migrations SET name='foreign216' WHERE version=216").run();
      if (fault === "moved") f.db.prepare("UPDATE schema_migrations SET version=999216 WHERE version=216").run();
      if (fault === "duplicate") record(f.db)(999216, predecessor);
      const extra = fault.startsWith("callback-") ? { hasMigration: (version: number) => version === 216 ? fault === "callback-invents" : has(f.db)(version) } : {};
      rejectUnchanged(f, /migration_predecessor_missing/u, extra, false);
    });
});

test("217 rejects version/name collisions and callback disagreement without rewriting foreign markers", async t => {
  for (const fault of ["renamed", "moved", "duplicate", "callback-denies", "callback-invents"])
    await t.test(fault, t => {
      const f = fixture(t, { installed: fault !== "callback-invents" });
      if (fault === "renamed") f.db.prepare("UPDATE schema_migrations SET name='foreign217' WHERE version=217").run();
      if (fault === "moved") f.db.prepare("UPDATE schema_migrations SET version=999217 WHERE version=217").run();
      if (fault === "duplicate") record(f.db)(999217, table);
      const extra = fault.startsWith("callback-") ? { hasMigration: (version: number) => version === 217 ? fault === "callback-invents" : has(f.db)(version) } : {};
      rejectUnchanged(f, /migration_marker_conflict/u, extra, !fault.startsWith("callback-"));
    });
});

test("a217 marker cannot hide a missing table and populated unmarked queue rows are never adopted", async t => {
  for (const fault of ["missing-table", "unmarked-populated"]) await t.test(fault, t => {
    const f = fixture(t, { installed: true });
    if (fault === "missing-table") f.db.exec(`DROP TABLE ${table}`);
    else { insert(f.db, queuedRun(f)); f.db.prepare("DELETE FROM schema_migrations WHERE version=217").run(); }
    rejectUnchanged(f, fault === "missing-table" ? /migration_schema_missing/u : /migration_unmarked_data/u);
  });
});

test("217 rejects same-name tables/views, weakened schema and unexpected owned indexes/triggers", async t => {
  const mutations: Record<string, (sql: string) => string> = {
    "run-fk": sql => sql.replace(" REFERENCES run_sessions(id)", ""),
    "workspace-fk": sql => sql.replace(" REFERENCES workspaces(id)", ""),
    "unit-fk": sql => sql.replace(" REFERENCES work_units(id)", ""),
    "attempt-fk": sql => sql.replace(" REFERENCES work_unit_attempts(id)", ""),
    "autoincrement": sql => sql.replace(" PRIMARY KEY AUTOINCREMENT", " PRIMARY KEY"),
    "unique-run": sql => sql.replace("run_id TEXT NOT NULL UNIQUE", "run_id TEXT NOT NULL"),
    "unique-unit": sql => sql.replace("work_unit_id TEXT NOT NULL UNIQUE", "work_unit_id TEXT NOT NULL"),
    "unique-attempt": sql => sql.replace("attempt_id TEXT NOT NULL UNIQUE", "attempt_id TEXT NOT NULL"),
    "nullable-fence": sql => sql.replace("fencing_token TEXT NOT NULL", "fencing_token TEXT"),
    "digest-length": sql => sql.replace("length(snapshot_digest)=64", "length(snapshot_digest)>0"),
    "reason": sql => sql.replace("reason IN ('resource_conflict','runtime_semaphore_conflict')", "length(reason)>0"),
    "revision-default": sql => sql.replace("revision INTEGER NOT NULL DEFAULT 1", "revision INTEGER NOT NULL DEFAULT 0"),
    "revision-integer": sql => sql.replace("typeof(revision)='integer' AND ", ""),
    "revision-range": sql => sql.replace("revision BETWEEN 1 AND 9007199254740991", "revision BETWEEN 0 AND 9007199254740991"),
    "selection-range": sql => sql.replace("last_selected BETWEEN 0 AND 9007199254740991", "last_selected BETWEEN -1 AND 9007199254740991"),
    "claim-shape": sql => sql.replace("claim_owner_id IS NULL AND claim_token IS NULL AND claim_runtime_instance_id IS NULL AND claim_expires_at IS NULL", "claim_owner_id IS NULL"),
    "dispatch-claim": sql => sql.replace("CHECK(dispatched_at IS NULL OR claim_owner_id IS NOT NULL)", "CHECK(dispatched_at IS NULL OR 1)"),
  };
  for (const installed of [false, true]) for (const fault of ["table", "view", ...Object.keys(mutations), "extra-column", "index", "trigger"])
    await t.test(`installed=${installed}/${fault}`, t => {
      const f = fixture(t, { installed });
      if (installed) f.db.exec(`DROP TABLE ${table}`);
      if (fault === "table") f.db.exec(`CREATE TABLE ${table}(id TEXT)`);
      else if (fault === "view") f.db.exec(`CREATE VIEW ${table} AS SELECT id FROM workspaces`);
      else {
        const changed = mutations[fault]?.(f.definition) ?? f.definition;
        if (mutations[fault]) assert.notEqual(changed, f.definition);
        f.db.exec(changed);
        if (fault === "extra-column") f.db.exec(`ALTER TABLE ${table} ADD COLUMN foreign_column TEXT`);
        if (fault === "index") f.db.exec(`CREATE INDEX foreign_queue_index ON ${table}(group_key)`);
        if (fault === "trigger") f.db.exec(`CREATE TRIGGER foreign_queue_trigger AFTER INSERT ON ${table} BEGIN SELECT 1; END`);
      }
      rejectUnchanged(f, ["index", "trigger"].includes(fault) ? /migration_unexpected_object/u : /migration_schema_conflict/u);
    });
});

test("installed217 fails closed on each orphaned parent even when its table SQL remains exact", async t => {
  for (const column of ["run_id", "workspace_id", "work_unit_id", "attempt_id"]) await t.test(column, t => {
    const f = fixture(t, { installed: true }), base = queuedRun(f);
    f.db.exec("PRAGMA foreign_keys=OFF");
    try { insert(f.db, { ...base, [column]: "missing-parent" }); }
    finally { f.db.exec("PRAGMA foreign_keys=ON"); }
    rejectUnchanged(f, /migration_fk_conflict/u);
  });
});

test("217 rolls back owned DDL, markers and caller writes at callback, postcondition and deferred COMMIT failures", async t => {
  for (const fault of ["before-marker", "after-marker", "missing-marker", "wrong-marker", "missing-table", "foreign-index", "lost-predecessor", "deferred-commit"])
    await t.test(fault, t => {
      const f = fixture(t);
      queuedRun(f);
      if (fault === "deferred-commit") {
        f.db.exec("CREATE TABLE queue_commit_fault(id TEXT REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED)");
        f.db.exec("CREATE TRIGGER queue_deferred_fault AFTER INSERT ON schema_migrations WHEN NEW.version=217 BEGIN INSERT INTO queue_commit_fault VALUES('missing-workspace'); END");
      }
      const before = snapshot(f.db);
      let reached = false;
      assert.throws(() => migrate(f.db, { recordMigration(version, name) {
        reached = true;
        assert.equal(f.db.isTransaction, true);
        assert.equal(version, 217); assert.equal(name, table);
        assert.equal(schema(f.db).find(row => row.name === table)!.sql, f.definition);
        f.db.prepare("UPDATE workspaces SET name='owned-migration-write' WHERE id=?").run(DEFAULT_WORKSPACE_ID);
        if (fault === "before-marker") throw new Error("queue-before-marker");
        if (fault === "missing-marker") return;
        record(f.db)(version, fault === "wrong-marker" ? "foreign217" : name);
        if (fault === "after-marker") throw new Error("queue-after-marker");
        if (fault === "missing-table") f.db.exec(`DROP TABLE ${table}`);
        if (fault === "foreign-index") f.db.exec(`CREATE INDEX foreign_queue_index ON ${table}(revision)`);
        if (fault === "lost-predecessor") f.db.prepare("DELETE FROM schema_migrations WHERE version=216").run();
      } }), /queue-(before|after)-marker|runtime_run_queue\.migration_|FOREIGN KEY/u);
      assert.equal(reached, true);
      assert.equal(f.db.isTransaction, false);
      assert.deepEqual(snapshot(f.db), before);
      if (fault === "deferred-commit") {
        assert.deepEqual(rows(f.db, "queue_commit_fault"), []);
        f.db.exec("DROP TRIGGER queue_deferred_fault; DROP TABLE queue_commit_fault");
      }
      migrate(f.db);
      assert.equal(has(f.db)(217), true);
      assert.deepEqual(data(f.db), before.data);
      assert.deepEqual(rows(f.db, table), []);
    });
});

test("a CREATE failure rolls back owned DDL before publishing217 without isTransaction metadata", t => {
  const f = fixture(t), before = snapshot(f.db);
  let reached = false;
  const database = { prepare: f.db.prepare.bind(f.db), exec(sql: string) {
    const result = f.db.exec(sql);
    if (sql.startsWith(`CREATE TABLE ${table} (`)) {
      reached = true;
      assert.equal(has(f.db)(217), false);
      throw new Error("queue-create-fault");
    }
    return result;
  } };
  assert.equal("isTransaction" in database, false);
  assert.throws(() => migrate(database), /queue-create-fault/u);
  assert.equal(reached, true);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(snapshot(f.db), before);
  migrate(f.db);
  assert.deepEqual(schema(f.db), f.fullSchema);
});

test("217 reinspects predecessor, marker and schema after BEGIN before writing or publishing", async t => {
  for (const fault of ["predecessor", "marker", "schema", "already-installed"]) await t.test(fault, t => {
    const f = fixture(t), before = snapshot(f.db);
    const database = { prepare: f.db.prepare.bind(f.db), exec(sql: string) {
      const result = f.db.exec(sql);
      if (sql === "BEGIN IMMEDIATE") {
        if (fault === "predecessor") f.db.prepare("UPDATE schema_migrations SET name='foreign216' WHERE version=216").run();
        if (fault === "marker") record(f.db)(217, "foreign217");
        if (fault === "schema") f.db.exec(`CREATE VIEW ${table} AS SELECT id FROM workspaces`);
        if (fault === "already-installed") { f.db.exec(f.definition); record(f.db)(217, table); }
      }
      return result;
    } };
    if (fault === "already-installed") migrate(database, { recordMigration() { assert.fail("must not duplicate an installed marker"); } });
    else assert.throws(() => migrate(database), migrationError);
    assert.equal(f.db.isTransaction, false);
    if (fault === "already-installed") {
      assert.deepEqual(schema(f.db), f.fullSchema);
      assert.deepEqual(markers(f.db).filter(row => row.version !== 217), before.markers);
    } else assert.deepEqual(snapshot(f.db), before);
    migrate(f.db);
  });
});

test("pending217 never commits or rolls back an outer transaction without isTransaction; installed217 is read-only", async t => {
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
      assert.equal(has(f.db)(217), true);
    });
});
