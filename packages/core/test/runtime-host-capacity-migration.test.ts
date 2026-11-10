import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore, resolveStoragePaths } from "../dist/index.js";
import { applyRuntimeRunQueueMigration } from "../dist/storage/sqlite/runtime-run-queue-migration.js";
import { testDatabase } from "./support/sqlite-test-database.ts";

const migrationUrl = process.env.LING_CORE_MIGRATION_DIST
  ? pathToFileURL(join(process.env.LING_CORE_MIGRATION_DIST, "storage/sqlite/runtime-host-capacity-migration.js"))
  : new URL("../dist/storage/sqlite/runtime-host-capacity-migration.js", import.meta.url);
const { applyRuntimeHostCapacityMigration, RUNTIME_HOST_CAPACITY_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_MIGRATION_NAME }
  : typeof import("../dist/storage/sqlite/runtime-host-capacity-migration.js") = await import(migrationUrl.href);

type Store = ReturnType<typeof createSqliteRunStore>;
type Database = Pick<DatabaseSync, "prepare" | "exec">;
type MigrationInput = Parameters<typeof applyRuntimeHostCapacityMigration>[0];
type MigrationOverrides = Partial<Omit<MigrationInput, "database">>;
type SchemaRow = Record<string, SQLOutputValue> & { name: string; tbl_name: string; sql: string };
type MarkerRow = Record<string, SQLOutputValue> & { version: number; name: string };
type SqlRow = Record<string, SQLInputValue>;
type Fixture = ReturnType<typeof fixture>;

const intents = "runtime_host_capacity_intents", releases = "runtime_host_capacity_releases";
const tables = [intents, releases], predecessor = "runtime_run_queue", name = "runtime_host_capacity";
const now = "2026-11-04T00:00:00.000Z", later = "2026-11-04T01:00:00.000Z";
const sourceColumns = ["run_id", "work_unit_id", "attempt_id", "runtime_instance_id", "fencing_token"];
const receiptColumns = ["reservation_id", "reservation_token", "host_policy_revision", "reserved_at", "dispatch_token"];
const requiredIntent = ["intent_id", "workspace_id", "workspace_key", "canonical_cwd", "database_path", "database_file_identity",
  "owner_kind", "owner_key", "authority_digest", "created_at"];
const requiredRelease = ["intent_id", "reservation_id", "reservation_token", "kind", "proof_json", "proof_digest", "created_at"];
const has = (db: Database) => (version: number) => !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
const record = (db: Database) => (version: number, migrationName: string) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, migrationName, now);
// Fault adapters intentionally omit isTransaction while forwarding real SQLite prepare/exec.
const input = (db: Database, extra: MigrationOverrides = {}): MigrationInput => ({ database: db as DatabaseSync,
  hasMigration: has(db), recordMigration: record(db), ...extra });
const migrate = (db: Database, extra: MigrationOverrides = {}) => applyRuntimeHostCapacityMigration(input(db, extra));
const schema = (db: Database) => {
  const result = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  assert.ok(result.every((row): row is SchemaRow => typeof row.name === "string" && typeof row.tbl_name === "string" && typeof row.sql === "string"));
  return result;
};
const markers = (db: Database) => {
  const result = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  assert.ok(result.every((row): row is MarkerRow => typeof row.version === "number" && typeof row.name === "string"));
  return result;
};
const rows = (db: Database, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const changes = (db: Database) => {
  const count = db.prepare("SELECT total_changes() AS n").get()!.n;
  assert.ok(typeof count === "number");
  return count;
};
const dataTables = ["workspaces", "tasks", "run_sessions", "work_units", "work_unit_attempts", "runtime_events", "run_events", "artifacts",
  "host_attempt_completions", "host_operations", "harness_tool_executions", "native_submissions", "runtime_concurrency_policies",
  "runtime_delegation_capacity_admissions", "runtime_semaphore_slots", "resource_leases", "workflow_step_admissions",
  "workflow_step_admission_entries", "runtime_run_queue"];
const data = (db: Database) => Object.fromEntries(dataTables.map(table => [table, rows(db, table)]));
const snapshot = (db: Database) => ({ schema: schema(db), markers: markers(db), data: data(db),
  sequences: db.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all(),
  journal: Object.fromEntries(tables.map(table => [table,
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? rows(db, table) : undefined])) });
const migrationError = /runtime_host_capacity\.migration_/u;
const insert = (db: Database, table: string, row: SqlRow) => db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
  .run(...Object.values(row));
const update = (db: Database, table: string, row: SqlRow) => db.prepare(`UPDATE ${table} SET ${Object.keys(row).map(column => `${column}=?`).join(",")}`)
  .run(...Object.values(row));

function fixture(t: TestContext, { installed = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-host-capacity-migration-"))), cwd = join(root, "workspace");
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
  const db = testDatabase(store);
  applyRuntimeRunQueueMigration(input(db));
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=217").get()!.name, predecessor);
  migrate(db);
  const successorTable = "runtime_delegation_spawn_admissions";
  const currentMarkers = markers(db).filter(row => row.version >= 218).map(({ version, name }) => [version, name]);
  assert.deepEqual(currentMarkers, [[218, name], [219, successorTable], [220, "runtime_host_capacity_continuations"]]);
  for (const table of [...tables, successorTable]) {
    assert.deepEqual(rows(db, table), [], "only empty owned fixture overlays may be removed");
    assert.deepEqual(schema(db).filter(row => row.tbl_name === table).map(row => [row.type, row.name]), [["table", table]]);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DROP TABLE ${successorTable}`);
    for (const table of [...tables].reverse()) db.exec(`DROP TABLE ${table}`);
    for (const [version, markerName] of currentMarkers)
      assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=? AND name=?").run(version, markerName).changes, 1);
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()!.v, 217);
  migrate(db);
  const fullSchema = schema(db), definitions = Object.fromEntries(tables.map(table => [table, fullSchema.find(row => row.name === table)!.sql]));
  assert.deepEqual(markers(db).filter(row => row.version >= 217).map(({ version, name: markerName }) => [version, markerName]),
    [[217, predecessor], [218, name]]);
  if (!installed) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [...tables].reverse()) db.exec(`DROP TABLE ${table}`);
      assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=218 AND name=?").run(name).changes, 1);
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()!.v, 217);
    const before = snapshot(db), count = changes(db);
    applyRuntimeRunQueueMigration(input(db));
    assert.deepEqual(snapshot(db), before);
    assert.equal(changes(db), count);
  }
  return { cwd, paths, fullSchema, definitions, get store() { return store!; }, get db() { return testDatabase(store!); },
    peer() {
      const peer = new DatabaseSync(paths.databasePath);
      peer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      peers.push(peer);
      return peer;
    },
    reopen() {
      store!.close(); store = undefined;
      const next = createSqliteRunStore(cwd, paths);
      try { migrate(testDatabase(next)); } catch (error) { next.close(); throw error; }
      store = next;
    } };
}

function execution(f: Fixture, id = "one") {
  const runId = `host-capacity-run-${id}`;
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run", ownerType: "run", ownerId: runId,
    idempotencyKey: `host-capacity-unit-${id}`, createdByActor: "system", request: {}, now });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "host-capacity-runtime", runnerId: "pi", status: "created", now });
  const run = f.store.createRun({ id: runId, cwd: f.cwd, workUnitId: unit.id, taskId: "inline-task", providerName: "fixture",
    providerModel: "fixture-model", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  f.store.linkRunToWorkUnit(run.id, unit.id, now);
  return { run_id: run.id, work_unit_id: unit.id, attempt_id: attempt.id,
    runtime_instance_id: attempt.runtimeInstanceId, fencing_token: attempt.fencingToken };
}

function intent(f: Fixture, id = "one", source = execution(f, id)): SqlRow {
  return { intent_id: `host-intent-${id}`, workspace_id: DEFAULT_WORKSPACE_ID, workspace_key: "workspace-identity",
    canonical_cwd: f.cwd, database_path: f.paths.databasePath, database_file_identity: "dev:1:ino:2", owner_kind: "attempt",
    owner_key: `attempt:${source.attempt_id}`, authority_digest: "a".repeat(64), ...source, created_at: now };
}
const receipt = (id = "one"): SqlRow => ({ reservation_id: `host-reservation-${id}`, reservation_token: "b".repeat(64),
  host_policy_revision: 7, reserved_at: now, dispatch_token: "c".repeat(64) });
const release = (parent: SqlRow) => ({ intent_id: parent.intent_id, reservation_id: parent.reservation_id,
  reservation_token: parent.reservation_token, kind: "no_dispatch", proof_json: '{"kind":"no_dispatch"}', proof_digest: "d".repeat(64), created_at: later });

function rejectUnchanged(f: Fixture, pattern = migrationError, extra: MigrationOverrides = {}, checkPeer = true) {
  const before = snapshot(f.db), count = changes(f.db);
  assert.throws(() => migrate(f.db, extra), pattern);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  if (checkPeer) {
    const peer = f.peer();
    assert.throws(() => migrate(peer), pattern);
    assert.deepEqual(snapshot(peer), before);
    assert.deepEqual(snapshot(f.db), before);
  }
}

test("218 installs exactly two journal tables, five foreign keys and only the specified implicit unique indexes", t => {
  const f = fixture(t), before = snapshot(f.db), count = changes(f.db);
  assert.equal(RUNTIME_HOST_CAPACITY_MIGRATION_VERSION, 218);
  assert.equal(RUNTIME_HOST_CAPACITY_MIGRATION_NAME, name);
  migrate(f.db);
  assert.equal(changes(f.db) - count, 1);
  assert.deepEqual(schema(f.db), f.fullSchema);
  assert.deepEqual(schema(f.db).filter(row => !tables.includes(row.tbl_name)), before.schema);
  assert.deepEqual(data(f.db), before.data);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 218), before.markers);
  const intentColumns = [...requiredIntent.slice(0, -1), ...sourceColumns, "created_at", ...receiptColumns, "dispatched_at", "revoked_at"];
  for (const [table, columns, required] of [[intents, intentColumns, requiredIntent],
    [releases, [...requiredRelease, "acknowledged_at"], requiredRelease]] satisfies [string, string[], string[]][]) {
    assert.deepEqual(f.db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, row.type, row.notnull, row.dflt_value, row.pk]),
      columns.map(column => [column, column === "host_policy_revision" ? "INTEGER" : "TEXT", required.includes(column) ? 1 : 0,
        null, column === "intent_id" ? 1 : 0]));
    assert.deepEqual(rows(f.db, table), []);
  }
  assert.deepEqual(f.db.prepare(`PRAGMA foreign_key_list(${intents})`).all().map(row => [row.from, row.table, row.to, row.on_delete]).sort(),
    [["attempt_id", "work_unit_attempts", "id", "NO ACTION"], ["run_id", "run_sessions", "id", "NO ACTION"],
      ["work_unit_id", "work_units", "id", "NO ACTION"], ["workspace_id", "workspaces", "id", "NO ACTION"]]);
  assert.deepEqual(f.db.prepare(`PRAGMA foreign_key_list(${releases})`).all().map(row => [row.from, row.table, row.to, row.on_delete]),
    [["intent_id", intents, "intent_id", "NO ACTION"]]);
  for (const [table, expected] of [[intents, [["intent_id"], ["attempt_id"], ["reservation_id"], ["dispatch_token"], ["workspace_id", "owner_kind", "owner_key"]]],
    [releases, [["intent_id"]]]] satisfies [string, string[][]][]) {
    const indexes = f.db.prepare(`PRAGMA index_list(${table})`).all();
    assert.ok(indexes.every(row => row.unique === 1 && (row.origin === "pk" || row.origin === "u")));
    assert.deepEqual(indexes.map(row => f.db.prepare(`PRAGMA index_info(${row.name})`).all().map(column => column.name)).sort(), expected.sort());
  }
  assert.deepEqual(schema(f.db).filter(row => tables.includes(row.tbl_name)).map(row => [row.type, row.name]),
    tables.map(table => ["table", table]));
});

test("218 upgrades populated real 217 without altering execution facts or granting old Runs Host dispatch authority", t => {
  const f = fixture(t), source = execution(f), second = execution(f, "two");
  insert(f.db, predecessor, { ...source, workspace_id: DEFAULT_WORKSPACE_ID, snapshot_digest: "a".repeat(64),
    group_key: "thread:fixture", queued_at: now, reason: "resource_conflict" });
  f.db.prepare(`INSERT INTO runtime_semaphore_slots(id,workspace_id,resource_type,resource_key,owner_type,owner_id,
    work_unit_id,attempt_id,runtime_instance_id,fencing_token,status,acquired_at,last_renewed_at,expires_at)
    VALUES('host-retained-slot',?,'provider','host-provider','work_unit_attempt',?,?,?,?,?,'active',?,?,?)`)
    .run(DEFAULT_WORKSPACE_ID, source.attempt_id, source.work_unit_id, source.attempt_id, source.runtime_instance_id, source.fencing_token, now, now, later);
  assert.ok(f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "workspace", resourceKey: "host-workspace",
    ownerType: "system", ownerId: "host-owner", acquiredAt: now, expiresAt: later }));
  f.db.prepare(`INSERT INTO runtime_concurrency_policies(workspace_id,runtime_instance_id,revision,max_concurrent_runs,
    max_read_only_runs,max_workspace_write_runs,max_runs_per_provider,max_runs_per_runner,installed_at,enabled)
    VALUES(?,'host-capacity-runtime',7,64,64,4,64,64,?,0)`).run(DEFAULT_WORKSPACE_ID, now);
  const before = snapshot(f.db), count = changes(f.db);
  migrate(f.db);
  assert.equal(changes(f.db) - count, 1, "only the 218 marker is written");
  assert.deepEqual(data(f.db), before.data);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 218), before.markers);
  assert.deepEqual(tables.map(table => rows(f.db, table)), [[], []]);
  const parent = { ...intent(f, "one", source), ...receipt(), revoked_at: later };
  insert(f.db, intents, parent);
  insert(f.db, releases, { ...release(parent), acknowledged_at: later });
  insert(f.db, intents, intent(f, "two", second));
  const installed = snapshot(f.db), installedChanges = changes(f.db), version = f.db.prepare("PRAGMA schema_version").get()!.schema_version;
  migrate(f.db); migrate(f.db); migrate(f.peer());
  assert.deepEqual(snapshot(f.db), installed);
  assert.equal(changes(f.db), installedChanges);
  assert.equal(f.db.prepare("PRAGMA schema_version").get()!.schema_version, version);
  f.reopen();
  const reopened = snapshot(f.db);
  assert.deepEqual(reopened.data, installed.data);
  assert.deepEqual(reopened.journal, installed.journal);
  assert.deepEqual(reopened.sequences, installed.sequences);
  assert.deepEqual(reopened.markers.filter(row => row.version <= 218), installed.markers);
  assert.deepEqual(reopened.markers.filter(row => row.version > 218).map(({ version, name }) => [version, name]),
    [[219, "runtime_delegation_spawn_admissions"], [220, "runtime_host_capacity_continuations"]]);
  assert.deepEqual(reopened.schema.filter(row => ![intents, "runtime_delegation_spawn_admissions"].includes(row.tbl_name)),
    installed.schema.filter(row => row.tbl_name !== intents));
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("218 adopts only exact empty unmarked tables, including either partial installation", async t => {
  for (const retained of [[], [intents], [releases], tables]) await t.test(retained.join(",") || "none", t => {
    const f = fixture(t, { installed: true });
    f.db.prepare("DELETE FROM schema_migrations WHERE version=218").run();
    for (const table of [...tables].reverse()) if (!retained.includes(table)) f.db.exec(`DROP TABLE ${table}`);
    const before = data(f.db), count = changes(f.db);
    migrate(f.db);
    assert.equal(changes(f.db) - count, 1);
    assert.deepEqual(schema(f.db), f.fullSchema);
    assert.deepEqual(data(f.db), before);
    const installed = snapshot(f.db), installedChanges = changes(f.db);
    migrate(f.db);
    assert.deepEqual(snapshot(f.db), installed);
    assert.equal(changes(f.db), installedChanges);
  });
});

test("SQLite enforces nonempty NUL-free text, required values, lowerhex digests, owner/kind enums and safe positive revision", t => {
  const f = fixture(t, { installed: true }), parent = { ...intent(f), ...receipt() };
  insert(f.db, intents, parent); insert(f.db, releases, release(parent));
  const before = snapshot(f.db), count = changes(f.db);
  for (const [table, columns] of [[intents, requiredIntent], [releases, requiredRelease]] satisfies [string, string[]][])
    for (const column of columns) assert.throws(() => update(f.db, table, { [column]: null }), /NOT NULL/u, `${table}.${column}`);
  for (const [table, columns] of [[intents, [...requiredIntent, ...sourceColumns, "reservation_id"]],
    [releases, ["intent_id", "reservation_id", "kind", "proof_json"]]] satisfies [string, string[]][])
    for (const column of columns) for (const value of ["", "   ", "\0", `${parent[column] ?? "value"}\0tail`, new Uint8Array([97])])
      assert.throws(() => update(f.db, table, { [column]: value }), /CHECK/u, `${table}.${column}=${String(value)}`);
  for (const [table, columns] of [[intents, ["authority_digest", "reservation_token", "dispatch_token"]],
    [releases, ["reservation_token", "proof_digest"]]] satisfies [string, string[]][])
    for (const column of columns) for (const value of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64),
      "a".repeat(63) + "\0", "a".repeat(64) + "\0tail", "a".repeat(63) + "\u00e9", new Uint8Array(64).fill(97)])
      assert.throws(() => update(f.db, table, { [column]: value }), /CHECK/u, `${table}.${column}`);
  for (const value of ["other", "ATTEMPT", "attempt ", "workflow_start\0tail", "approval_resume_pending", "user_input_continuation"])
    assert.throws(() => update(f.db, intents, { owner_kind: value }), /CHECK/u);
  for (const value of ["other", "STOPPED", "stopped ", "no_dispatch\0tail"])
    assert.throws(() => update(f.db, releases, { kind: value }), /CHECK/u);
  for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "invalid", new Uint8Array([1])])
    assert.throws(() => update(f.db, intents, { host_policy_revision: value }), /CHECK/u);
  for (const value of ["{", "undefined", '{"kind":}', "{}\0tail", new Uint8Array([123, 125])])
    assert.throws(() => update(f.db, releases, { proof_json: value }), /CHECK/u);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  for (const value of [1, Number.MAX_SAFE_INTEGER]) {
    update(f.db, intents, { host_policy_revision: value });
    assert.equal(f.db.prepare(`SELECT typeof(host_policy_revision) AS t FROM ${intents}`).get()!.t, "integer");
  }
  update(f.db, releases, { kind: "stopped", proof_json: "null" });
});

test("journal timestamps are real canonical millisecond UTC text, with optional times remaining nullable", t => {
  const f = fixture(t, { installed: true }), parent = { ...intent(f), ...receipt() };
  insert(f.db, intents, parent); insert(f.db, releases, release(parent));
  const before = snapshot(f.db), count = changes(f.db);
  const invalid = ["", " ", "not-a-date", "2026-13-01T00:00:00.000Z", "2026-02-30T00:00:00.000Z", "2025-02-29T00:00:00.000Z",
    "2026-11-04T24:00:00.000Z", "2026-11-04T00:00:60.000Z", "2026-11-04T00:00:00Z", "2026-11-04T00:00:00.0Z",
    "2026-11-04T00:00:00.0000Z", "2026-11-04T00:00:00.000z", "2026-11-04T00:00:00.000+00:00", now + "\0", new Uint8Array([1])];
  for (const [table, columns] of [[intents, ["created_at", "reserved_at", "dispatched_at", "revoked_at"]],
    [releases, ["created_at", "acknowledged_at"]]] satisfies [string, string[]][]) for (const column of columns) for (const value of invalid)
    assert.throws(() => update(f.db, table, { [column]: value }), /CHECK/u, `${table}.${column}=${String(value)}`);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  update(f.db, intents, { created_at: "2024-02-29T23:59:59.999Z", dispatched_at: now });
  update(f.db, releases, { acknowledged_at: later });
  update(f.db, releases, { acknowledged_at: null });
  assert.equal(rows(f.db, releases)[0].acknowledged_at, null);
});

test("source and receipt groups are complete or absent, attempt owners require source, and dispatch/revocation are exclusive", t => {
  const f = fixture(t, { installed: true }), original = intent(f), source = Object.fromEntries(sourceColumns.map(column => [column, original[column]]));
  const base = { ...original, ...Object.fromEntries(sourceColumns.map(column => [column, null])), owner_kind: "workflow_start" };
  insert(f.db, intents, base);
  const before = snapshot(f.db), count = changes(f.db);
  for (const [columns, values] of [[sourceColumns, source], [receiptColumns, receipt()]] satisfies [string[], SqlRow][])
    for (let mask = 1; mask < (1 << columns.length) - 1; mask++) {
      const partial = Object.fromEntries(columns.map((column, index) => [column, mask & (1 << index) ? values[column] : null]));
      assert.throws(() => update(f.db, intents, partial), /CHECK/u, `${columns[0]} mask=${mask}`);
    }
  assert.throws(() => update(f.db, intents, { owner_kind: "attempt" }), /CHECK/u);
  for (const column of ["dispatched_at", "revoked_at"]) assert.throws(() => update(f.db, intents, { [column]: now }), /CHECK/u);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  update(f.db, intents, { owner_kind: "delegation_spawn" });
  update(f.db, intents, source);
  update(f.db, intents, { owner_kind: "attempt", ...receipt() });
  for (const column of sourceColumns) assert.throws(() => update(f.db, intents, { [column]: null }), /CHECK/u);
  for (const column of receiptColumns) assert.throws(() => update(f.db, intents, { [column]: null }), /CHECK/u);
  assert.throws(() => update(f.db, intents, { dispatched_at: now, revoked_at: later }), /CHECK/u);
  update(f.db, intents, { dispatched_at: now });
  assert.throws(() => update(f.db, intents, { revoked_at: later }), /CHECK/u);
  update(f.db, intents, { dispatched_at: null, revoked_at: later });
  assert.throws(() => update(f.db, intents, { dispatched_at: now }), /CHECK/u);
  update(f.db, intents, { revoked_at: null, ...Object.fromEntries(receiptColumns.map(column => [column, null])) });
  insert(f.db, intents, { ...base, intent_id: "preparing-two", owner_key: "workflow-start-two" });
  insert(f.db, intents, { ...base, intent_id: "preparing-three", owner_kind: "delegation_spawn", owner_key: "spawn-three" });
});

test("journal identity uniqueness and all parent foreign keys reject independent collisions", t => {
  const f = fixture(t, { installed: true }), parent = { ...intent(f), ...receipt() };
  const candidate = { ...intent(f, "two"), ...receipt("two"), dispatch_token: "e".repeat(64) };
  insert(f.db, intents, parent); insert(f.db, releases, release(parent));
  const before = snapshot(f.db), count = changes(f.db);
  for (const column of ["intent_id", "attempt_id", "reservation_id", "dispatch_token", "owner_key"])
    assert.throws(() => insert(f.db, intents, { ...candidate, [column]: parent[column] }), /UNIQUE/u, column);
  for (const column of ["workspace_id", "run_id", "work_unit_id", "attempt_id"])
    assert.throws(() => insert(f.db, intents, { ...candidate, [column]: "missing-parent" }), /FOREIGN KEY/u, column);
  assert.throws(() => insert(f.db, releases, release(parent)), /UNIQUE/u);
  assert.throws(() => insert(f.db, releases, { ...release(parent), intent_id: "missing-intent" }), /FOREIGN KEY/u);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
});

test("218 requires the exact 217 predecessor marker and callback agreement for pending and installed journals", async t => {
  for (const installed of [false, true]) for (const fault of ["missing", "renamed", "moved", "duplicate", "callback-denies", "callback-invents"])
    await t.test(`installed=${installed}/${fault}`, t => {
      const f = fixture(t, { installed });
      if (["missing", "callback-invents"].includes(fault)) f.db.prepare("DELETE FROM schema_migrations WHERE version=217").run();
      if (fault === "renamed") f.db.prepare("UPDATE schema_migrations SET name='foreign217' WHERE version=217").run();
      if (fault === "moved") f.db.prepare("UPDATE schema_migrations SET version=999217 WHERE version=217").run();
      if (fault === "duplicate") record(f.db)(999217, predecessor);
      const extra: MigrationOverrides = fault.startsWith("callback-") ? { hasMigration: version => version === 217 ? fault === "callback-invents" : has(f.db)(version) } : {};
      rejectUnchanged(f, /migration_predecessor_missing/u, extra, !fault.startsWith("callback-"));
    });
});

test("218 rejects version/name collisions and callback disagreement without rewriting markers", async t => {
  for (const fault of ["renamed", "moved", "duplicate", "callback-denies", "callback-invents"]) await t.test(fault, t => {
    const f = fixture(t, { installed: fault !== "callback-invents" });
    if (fault === "renamed") f.db.prepare("UPDATE schema_migrations SET name='foreign218' WHERE version=218").run();
    if (fault === "moved") f.db.prepare("UPDATE schema_migrations SET version=999218 WHERE version=218").run();
    if (fault === "duplicate") record(f.db)(999218, name);
    const extra: MigrationOverrides = fault.startsWith("callback-") ? { hasMigration: version => version === 218 ? fault === "callback-invents" : has(f.db)(version) } : {};
    rejectUnchanged(f, /migration_marker_conflict/u, extra, !fault.startsWith("callback-"));
  });
});

test("a 218 marker cannot hide either missing table and populated unmarked journals cannot be adopted", async t => {
  for (const table of tables) for (const fault of ["missing-table", "unmarked-populated"]) await t.test(`${table}/${fault}`, t => {
    const f = fixture(t, { installed: true });
    if (fault === "missing-table") f.db.exec(`DROP TABLE ${table}`);
    else {
      const parent = { ...intent(f), ...receipt() };
      insert(f.db, intents, parent);
      if (table === releases) {
        insert(f.db, releases, release(parent));
        f.db.exec("PRAGMA foreign_keys=OFF");
        try { f.db.exec(`DELETE FROM ${intents}`); } finally { f.db.exec("PRAGMA foreign_keys=ON"); }
      }
      f.db.prepare("DELETE FROM schema_migrations WHERE version=218").run();
    }
    rejectUnchanged(f, fault === "missing-table" ? /migration_schema_missing/u : /migration_unmarked_data/u);
  });
});

test("218 rejects foreign objects, extra columns and weakened SQL on either journal table", async t => {
  const mutations: Record<string, ((sql: string) => string)[]> = {
    [intents]: [sql => sql.replace("REFERENCES workspaces(id)", ""), sql => sql.replace("attempt_id TEXT UNIQUE", "attempt_id TEXT"),
      sql => sql.replace("reservation_id TEXT UNIQUE", "reservation_id TEXT"), sql => sql.replace("dispatch_token TEXT UNIQUE", "dispatch_token TEXT"),
      sql => sql.replace("UNIQUE(workspace_id,owner_kind,owner_key)", "CHECK(1)"),
      sql => sql.replace("owner_kind<>'attempt'", "1"), sql => sql.replace("revoked_at IS NULL))", "1))")],
    [releases]: [sql => sql.replace("REFERENCES runtime_host_capacity_intents(intent_id)", ""),
      sql => sql.replace("json_valid(proof_json)", "1"), sql => sql.replace("kind IN ('no_dispatch','stopped')", "length(kind)>0")],
  };
  for (const installed of [false, true]) for (const table of tables)
    for (const fault of ["table", "view", "same-name-index", "extra-column", "index", "autoindex-lookalike", "trigger", ...mutations[table].map((_, index) => index)])
      await t.test(`installed=${installed}/${table}/${fault}`, t => {
        const f = fixture(t, { installed });
        if (installed) f.db.exec(`DROP TABLE ${table}`);
        if (fault === "table") f.db.exec(`CREATE TABLE ${table}(id TEXT)`);
        else if (fault === "view") f.db.exec(`CREATE VIEW ${table} AS SELECT id FROM workspaces`);
        else if (fault === "same-name-index") f.db.exec(`CREATE INDEX ${table} ON workspaces(name)`);
        else {
          const changed = typeof fault === "number" ? mutations[table][fault](f.definitions[table]) : f.definitions[table];
          if (typeof fault === "number") assert.notEqual(changed, f.definitions[table]);
          f.db.exec(changed);
          if (fault === "extra-column") f.db.exec(`ALTER TABLE ${table} ADD COLUMN foreign_column TEXT`);
          if (fault === "index") f.db.exec(`CREATE INDEX foreign_host_index ON ${table}(created_at)`);
          if (fault === "autoindex-lookalike") f.db.exec(`CREATE INDEX sqlitexautoindex_host ON ${table}(created_at)`);
          if (fault === "trigger") f.db.exec(`CREATE TRIGGER foreign_host_trigger AFTER INSERT ON ${table} BEGIN SELECT 1; END`);
        }
        rejectUnchanged(f, ["index", "autoindex-lookalike", "trigger"].some(name => name === fault) ? /migration_unexpected_object/u : /migration_schema_conflict/u);
      });
});

test("installed 218 rejects orphaned parent facts even when both table definitions remain exact", async t => {
  for (const column of ["workspace_id", "run_id", "work_unit_id", "attempt_id", "release-intent"]) await t.test(column, t => {
    const f = fixture(t, { installed: true }), parent = { ...intent(f), ...receipt() };
    f.db.exec("PRAGMA foreign_keys=OFF");
    try {
      if (column === "release-intent") insert(f.db, releases, { ...release(parent), intent_id: "missing-intent" });
      else insert(f.db, intents, { ...parent, [column]: "missing-parent" });
    } finally { f.db.exec("PRAGMA foreign_keys=ON"); }
    rejectUnchanged(f, /migration_fk_conflict/u);
  });
});

test("218 rolls back both tables, markers and owned writes on callback, postcheck and deferred COMMIT failure", async t => {
  for (const fault of ["before-marker", "after-marker", "missing-marker", "wrong-marker", "missing-intents", "missing-releases",
    "foreign-index", "lost-predecessor", "deferred-commit"]) await t.test(fault, t => {
    const f = fixture(t);
    execution(f);
    if (fault === "deferred-commit") {
      f.db.exec("CREATE TABLE host_commit_fault(id TEXT REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED)");
      f.db.exec("CREATE TRIGGER host_deferred_fault AFTER INSERT ON schema_migrations WHEN NEW.version=218 BEGIN INSERT INTO host_commit_fault VALUES('missing-workspace'); END");
    }
    const before = snapshot(f.db);
    let reached = false;
    assert.throws(() => migrate(f.db, { recordMigration(version, migrationName) {
      reached = true;
      assert.equal(f.db.isTransaction, true);
      assert.equal(version, 218); assert.equal(migrationName, name);
      for (const table of tables) assert.equal(schema(f.db).find(row => row.name === table)!.sql, f.definitions[table]);
      f.db.prepare("UPDATE workspaces SET name='owned-migration-write' WHERE id=?").run(DEFAULT_WORKSPACE_ID);
      if (fault === "before-marker") throw new Error("host-before-marker");
      if (fault === "missing-marker") return;
      record(f.db)(version, fault === "wrong-marker" ? "foreign218" : migrationName);
      if (fault === "after-marker") throw new Error("host-after-marker");
      if (fault === "missing-intents") f.db.exec(`DROP TABLE ${intents}`);
      if (fault === "missing-releases") f.db.exec(`DROP TABLE ${releases}`);
      if (fault === "foreign-index") f.db.exec(`CREATE INDEX foreign_host_index ON ${releases}(created_at)`);
      if (fault === "lost-predecessor") f.db.prepare("DELETE FROM schema_migrations WHERE version=217").run();
    } }), /host-(before|after)-marker|runtime_host_capacity\.migration_|FOREIGN KEY/u);
    assert.equal(reached, true);
    assert.equal(f.db.isTransaction, false);
    assert.deepEqual(snapshot(f.db), before);
    if (fault === "deferred-commit") {
      assert.deepEqual(rows(f.db, "host_commit_fault"), []);
      f.db.exec("DROP TRIGGER host_deferred_fault; DROP TABLE host_commit_fault");
    }
    migrate(f.db);
    assert.equal(has(f.db)(218), true);
    assert.deepEqual(data(f.db), before.data);
  });
});

test("a failure creating either journal rolls back all owned DDL without relying on isTransaction metadata", async t => {
  for (const table of tables) await t.test(table, t => {
    const f = fixture(t), before = snapshot(f.db);
    let reached = false;
    const database = { prepare: f.db.prepare.bind(f.db), exec(sql: string) {
      const result = f.db.exec(sql);
      if (sql.startsWith(`CREATE TABLE ${table} (`)) {
        reached = true;
        assert.equal(has(f.db)(218), false);
        throw new Error("host-create-fault");
      }
      return result;
    } };
    assert.equal("isTransaction" in database, false);
    assert.throws(() => migrate(database), /host-create-fault/u);
    assert.equal(reached, true);
    assert.equal(f.db.isTransaction, false);
    assert.deepEqual(snapshot(f.db), before);
    migrate(f.db);
    assert.deepEqual(schema(f.db), f.fullSchema);
  });
});

test("218 reinspects predecessor, marker and both schemas after BEGIN before creating or publishing", async t => {
  for (const fault of ["predecessor", "marker", "intents-schema", "releases-schema", "already-installed"]) await t.test(fault, t => {
    const f = fixture(t), before = snapshot(f.db);
    const database = { prepare: f.db.prepare.bind(f.db), exec(sql: string) {
      const result = f.db.exec(sql);
      if (sql === "BEGIN IMMEDIATE") {
        if (fault === "predecessor") f.db.prepare("UPDATE schema_migrations SET name='foreign217' WHERE version=217").run();
        if (fault === "marker") record(f.db)(218, "foreign218");
        if (fault === "intents-schema") f.db.exec(`CREATE VIEW ${intents} AS SELECT id FROM workspaces`);
        if (fault === "releases-schema") f.db.exec(`CREATE VIEW ${releases} AS SELECT id FROM workspaces`);
        if (fault === "already-installed") {
          for (const table of tables) f.db.exec(f.definitions[table]);
          record(f.db)(218, name);
        }
      }
      return result;
    } };
    if (fault === "already-installed") migrate(database, { recordMigration() { assert.fail("installed marker must not be written twice"); } });
    else assert.throws(() => migrate(database), migrationError);
    assert.equal(f.db.isTransaction, false);
    if (fault === "already-installed") {
      assert.deepEqual(schema(f.db), f.fullSchema);
      assert.deepEqual(data(f.db), before.data);
      assert.deepEqual(markers(f.db).filter(row => row.version !== 218), before.markers);
    } else assert.deepEqual(snapshot(f.db), before);
    migrate(f.db);
  });
});

test("pending 218 cannot commit or roll back an outer transaction; installed 218 remains a read-only inspection", async t => {
  for (const installed of [false, true]) for (const metadata of [false, true]) await t.test(`installed=${installed}/metadata=${metadata}`, t => {
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
    assert.equal(has(f.db)(218), true);
  });
});
