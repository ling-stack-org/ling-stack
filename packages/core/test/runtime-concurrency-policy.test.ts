import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { DEFAULT_WORKSPACE_ID, createSqliteRunStore, resolveStoragePaths } from "../dist/index.js";
import { validateRuntimeConcurrencyLimits, type InstallRuntimeConcurrencyPolicyInput,
  type InstallRuntimeConcurrencyPolicyResult, type RuntimeConcurrencyLimits } from "../dist/runtime-concurrency-policy.js";
import { SqliteRuntimeConcurrencyPolicyStore } from "../dist/storage/sqlite/runtime-concurrency-policy-store.js";
import { applyRuntimeConcurrencyPolicyMigration, RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION,
  RUNTIME_CONCURRENCY_POLICY_MIGRATION_NAME } from "../dist/storage/sqlite/runtime-concurrency-policy-migration.js";
import { testDatabase } from "./support/sqlite-test-database.ts";

type Store = ReturnType<typeof createSqliteRunStore>;
type MigrationInput = Parameters<typeof applyRuntimeConcurrencyPolicyMigration>[0];
type Database = Pick<DatabaseSync, "prepare" | "exec">;
type SchemaRow = Record<string, SQLOutputValue> & { name: string; tbl_name: string; sql: string };
type Fixture = ReturnType<typeof fixture>;

const table = "runtime_concurrency_policies";
const successors = [{ version: 216, name: "runtime_delegation_capacity_admissions" }, { version: 217, name: "runtime_run_queue" },
  { version: 218, name: "runtime_host_capacity" }, { version: 219, name: "runtime_delegation_spawn_admissions" },
  { version: 220, name: "runtime_host_capacity_continuations" }];
const successorTables = (successor: typeof successors[number]) => successor.version === 218 ? ["runtime_host_capacity_intents", "runtime_host_capacity_releases"]
  : successor.version === 220 ? [] : [successor.name];
const successorVersion = (version: SQLOutputValue) => successors.some(successor => successor.version === version);
const now = "2026-11-03T00:00:00.000Z";
const later = "2026-11-03T01:00:00.000Z";
const limits = () => ({ maxConcurrentRuns: 4, maxReadOnlyRuns: 4, maxWorkspaceWriteRuns: 2,
  maxRunsPerProvider: 4, maxRunsPerRunner: 4 });
const columns = ["max_concurrent_runs", "max_read_only_runs", "max_workspace_write_runs", "max_runs_per_provider", "max_runs_per_runner"];
const input = (extra: Partial<InstallRuntimeConcurrencyPolicyInput> = {}): Omit<InstallRuntimeConcurrencyPolicyInput, "limits"> & { limits: ReturnType<typeof limits> } => ({ workspaceId: DEFAULT_WORKSPACE_ID, runtimeInstanceId: "runtime-a",
  expectedRevision: 0, limits: limits(), installedAt: now, ...extra });
const has = (db: Database) => (version: number) => !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
const record = (db: Database) => (version: number, name: string) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, now);
// Facades exercise the same SQLite connection with transaction metadata omitted.
const migrate = (db: Database, extra: Partial<Omit<MigrationInput, "database">> = {}) => applyRuntimeConcurrencyPolicyMigration({ database: db as DatabaseSync,
  hasMigration: has(db), recordMigration: record(db), ...extra });
const changes = (db: Database) => db.prepare("SELECT total_changes() AS n").get()!.n as number;
const schema = (db: Database) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as SchemaRow[];
const markers = (db: Database) => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const policyRows = (db: Database) => db.prepare(`SELECT * FROM ${table} ORDER BY workspace_id`).all();
const executionRows = (db: Database) => Object.fromEntries(["workspaces", "tasks", "run_sessions", "work_units", "work_unit_attempts",
  "runtime_semaphore_slots", "resource_leases", "workflow_step_admissions", "workflow_step_admission_entries"]
  .map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
const snapshot = (db: Database) => ({ schema: schema(db), markers: markers(db), execution: executionRows(db) });

function fixture(t: TestContext, { predecessor = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ling-runtime-policy-")));
  const cwd = join(directory, "workspace");
  mkdirSync(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(directory, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  let store: Store;
  const peers: DatabaseSync[] = [];
  t.after(() => {
    for (const peer of peers) if (peer.isOpen) peer.close();
    if (store && testDatabase(store).isOpen) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store = createSqliteRunStore(cwd, paths);
  const fullSchema = schema(testDatabase(store));
  assert.equal(testDatabase(store).prepare("SELECT name FROM schema_migrations WHERE version=213").get()!.name, "workflow_conflict_recoveries");
  if (predecessor) {
    assert.equal(testDatabase(store).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
    assert.deepEqual(markers(testDatabase(store)).filter(row => successorVersion(row.version)).map(({ version, name }) => ({ version, name })), successors);
    for (const successor of [...successors].reverse()) {
      for (const table of [...successorTables(successor)].reverse()) {
        assert.equal(testDatabase(store).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
        assert.deepEqual(fullSchema.filter(row => row.tbl_name === table).map(row => row.name), [table]);
        testDatabase(store).exec(`DROP TABLE ${table}`);
      }
      assert.equal(testDatabase(store).prepare("DELETE FROM schema_migrations WHERE version=? AND name=?")
        .run(successor.version, successor.name).changes, 1);
    }
    assert.equal(testDatabase(store).prepare("DELETE FROM schema_migrations WHERE version=215 AND name='runtime_concurrency_policy_activation'").run().changes, 1);
    testDatabase(store).exec(`DROP TABLE IF EXISTS ${table}`);
    assert.equal(testDatabase(store).prepare("DELETE FROM schema_migrations WHERE version=214 AND name=?").run(table).changes, 1);
    assert.equal(testDatabase(store).prepare("SELECT MAX(version) AS version FROM schema_migrations").get()!.version, 213);
    assert.equal(has(testDatabase(store))(214), false);
    assert.equal(testDatabase(store).prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table), undefined);
  } else migrate(testDatabase(store));
  return {
    paths,
    fullSchema,
    get store() { return store; },
    get db() { return testDatabase(store); },
    get policy() { return new SqliteRuntimeConcurrencyPolicyStore({ database: testDatabase(store) }); },
    peer() {
      const database = new DatabaseSync(paths.databasePath);
      peers.push(database);
      database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      return { database, policy: new SqliteRuntimeConcurrencyPolicyStore({ database }) };
    },
    reopen() {
      store.close();
      store = createSqliteRunStore(cwd, paths);
      migrate(testDatabase(store));
      return this.policy;
    },
  };
}

function unchanged<T>(f: Fixture, action: () => T): T {
  const before = policyRows(f.db), count = changes(f.db);
  const result = action();
  assert.deepEqual(policyRows(f.db), before);
  assert.equal(changes(f.db), count);
  return result;
}

test("limits capture exactly five fields, accept both plain-object prototypes and freeze an independent copy", () => {
  for (const original of [limits(), Object.assign(Object.create(null), limits()), Object.freeze(limits())]) {
    const captured = validateRuntimeConcurrencyLimits(original);
    assert.deepEqual(captured, limits());
    assert.notEqual(captured, original);
    assert.ok(Object.isFrozen(captured));
    assert.throws(() => { (captured as { maxConcurrentRuns: number }).maxConcurrentRuns = 64; }, TypeError);
  }
  const original = limits(), captured = validateRuntimeConcurrencyLimits(original);
  original.maxConcurrentRuns = 64;
  assert.equal(captured.maxConcurrentRuns, 4);
  for (const value of [1, 64]) {
    assert.equal(validateRuntimeConcurrencyLimits({ ...limits(), maxConcurrentRuns: value }).maxConcurrentRuns, value);
  }
  assert.deepEqual(validateRuntimeConcurrencyLimits({ maxConcurrentRuns: 1, maxReadOnlyRuns: 64,
    maxWorkspaceWriteRuns: 4, maxRunsPerProvider: 64, maxRunsPerRunner: 64 }),
  { maxConcurrentRuns: 1, maxReadOnlyRuns: 64, maxWorkspaceWriteRuns: 4, maxRunsPerProvider: 64, maxRunsPerRunner: 64 });
});

test("limits reject non-plain objects, inherited fields, accessors, hidden fields, symbols, extras and omissions", () => {
  class LimitObject { constructor() { Object.assign(this, limits()); } }
  for (const value of [null, undefined, 4, "4", true, [], new Date(), new Map(), new LimitObject(), Object.create(limits())]) {
    assert.throws(() => validateRuntimeConcurrencyLimits(value), TypeError);
  }
  let invoked = false;
  const accessor = { ...limits(), get maxConcurrentRuns() { invoked = true; return 4; } };
  const hidden = Object.defineProperty(limits(), "maxConcurrentRuns", { value: 4, enumerable: false });
  const extraHidden = Object.defineProperty(limits(), "other", { value: 4, enumerable: false });
  for (const value of [accessor, hidden, extraHidden, { ...limits(), extra: 1 }, { ...limits(), [Symbol("extra")]: 1 },
    { maxReadOnlyRuns: 4, maxWorkspaceWriteRuns: 2, maxRunsPerProvider: 4, maxRunsPerRunner: 4 },
    { maxReadOnlyRuns: 4, maxWorkspaceWriteRuns: 2, maxRunsPerProvider: 4, maxRunsPerRunner: 4, other: 1 }]) {
    assert.throws(() => validateRuntimeConcurrencyLimits(value), TypeError);
  }
  assert.equal(invoked, false);
});

test("each limit rejects non-numbers and non-safe or out-of-range numbers without coercion", () => {
  for (const key of Object.keys(limits()) as (keyof RuntimeConcurrencyLimits)[]) {
    const maximum = key === "maxWorkspaceWriteRuns" ? 4 : 64;
    for (const value of ["4", 4n, new Number(4), null, undefined, true]) {
      assert.throws(() => validateRuntimeConcurrencyLimits({ ...limits(), [key]: value }), TypeError);
    }
    for (const value of [0, -1, -0, 1.5, NaN, Infinity, -Infinity, maximum + 1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateRuntimeConcurrencyLimits({ ...limits(), [key]: value }), RangeError);
    }
    for (const value of [1, maximum]) assert.equal(validateRuntimeConcurrencyLimits({ ...limits(), [key]: value })[key], value);
  }
});

test("214 upgrades the real 213 schema additively and is idempotent across SQLite reopen", t => {
  const f = fixture(t, { predecessor: true }), before = snapshot(f.db);
  assert.equal(RUNTIME_CONCURRENCY_POLICY_MIGRATION_VERSION, 214);
  assert.equal(RUNTIME_CONCURRENCY_POLICY_MIGRATION_NAME, table);
  migrate(f.db);
  assert.deepEqual(schema(f.db).filter(row => row.tbl_name !== table), before.schema);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 214), before.markers);
  assert.deepEqual(executionRows(f.db), before.execution);
  assert.deepEqual(policyRows(f.db), []);
  assert.deepEqual(f.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name),
    ["workspace_id", "runtime_instance_id", "revision", ...columns, "installed_at"]);
  assert.deepEqual(f.db.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row => [row.from, row.table, row.to]),
    [["workspace_id", "workspaces", "id"]]);
  const installed = snapshot(f.db), count = changes(f.db);
  migrate(f.db);
  assert.equal(changes(f.db), count);
  assert.deepEqual(snapshot(f.db), installed);
  f.reopen();
  assert.deepEqual(schema(f.db), f.fullSchema);
  assert.deepEqual(markers(f.db).filter(row => row.version !== 215 && !successorVersion(row.version)), installed.markers);
  assert.deepEqual(markers(f.db).filter(row => row.version === 215).map(({ version, name }) => ({ version, name })),
    [{ version: 215, name: "runtime_concurrency_policy_activation" }]);
  assert.deepEqual(markers(f.db).filter(row => successorVersion(row.version)).map(({ version, name }) => ({ version, name })), successors);
  for (const table of successors.flatMap(successorTables)) assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), []);
  assert.deepEqual(executionRows(f.db), installed.execution);
  assert.deepEqual(policyRows(f.db), []);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a genuine pre214 database has no installed policy and reads never install or migrate it", t => {
  const f = fixture(t, { predecessor: true }), before = snapshot(f.db), count = changes(f.db);
  assert.equal(f.policy.getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), undefined);
  assert.equal(f.store.getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), undefined);
  f.db.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(f.policy.getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), undefined);
    assert.equal(f.db.isTransaction, true);
  } finally { f.db.exec("ROLLBACK"); }
  assert.throws(() => f.policy.installRuntimeConcurrencyPolicy(input()), /runtime_concurrency_policy\.schema_unavailable/u);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(changes(f.db), count);
  migrate(f.db);
  assert.equal(f.policy.installRuntimeConcurrencyPolicy(input()).status, "installed");
});

test("policy reads reject one-sided, renamed and post214 missing schema instead of treating it as legacy", async t => {
  for (const corruption of ["table", "marker", "both-after214", "renamed", "moved", "duplicate", "view"])
    await t.test(corruption, t => {
      const f = fixture(t), db = f.db;
      if (["table", "both-after214", "view"].includes(corruption)) db.exec(`DROP TABLE ${table}`);
      if (["marker", "both-after214"].includes(corruption)) db.prepare("DELETE FROM schema_migrations WHERE version=214").run();
      if (corruption === "both-after214") record(db)(999216, "later_migration");
      if (corruption === "renamed") db.prepare("UPDATE schema_migrations SET name='foreign214' WHERE version=214").run();
      if (corruption === "moved") db.prepare("UPDATE schema_migrations SET version=999214 WHERE version=214").run();
      if (corruption === "duplicate") record(db)(999214, table);
      if (corruption === "view") db.exec(`CREATE VIEW ${table} AS SELECT id FROM workspaces`);
      const before = snapshot(db), count = changes(db);
      assert.throws(() => f.policy.getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), /runtime_concurrency_policy\.schema_invalid/u);
      assert.throws(() => f.policy.installRuntimeConcurrencyPolicy(input()), /runtime_concurrency_policy\.schema_invalid/u);
      assert.equal(db.isTransaction, false);
      assert.deepEqual(snapshot(db), before);
      assert.equal(changes(db), count);
    });
});

test("SQLite enforces all five ranges, integer revisions, required ownership and the workspace foreign key", t => {
  const f = fixture(t);
  f.policy.installRuntimeConcurrencyPolicy(input());
  for (const [index, column] of columns.entries()) {
    const maximum = index === 2 ? 4 : 64;
    for (const value of [0, -1, 1.5, maximum + 1, "invalid", new Uint8Array([1]), null]) {
      unchanged(f, () => assert.throws(() => f.db.prepare(`UPDATE ${table} SET ${column}=?`).run(value), /CHECK|NOT NULL/u));
    }
  }
  for (const value of [0, -1, 1.5, 9007199254740992n, "invalid", null]) {
    unchanged(f, () => assert.throws(() => f.db.prepare(`UPDATE ${table} SET revision=?`).run(value), /CHECK|NOT NULL/u));
  }
  for (const column of ["runtime_instance_id", "installed_at"]) {
    for (const value of ["", "   ", null]) {
      unchanged(f, () => assert.throws(() => f.db.prepare(`UPDATE ${table} SET ${column}=?`).run(value), /CHECK|NOT NULL/u));
    }
  }
  unchanged(f, () => assert.throws(() => f.db.prepare(`UPDATE ${table} SET workspace_id='missing-workspace'`).run(), /FOREIGN KEY/u));
});

test("installation persists frozen snapshots through a real peer connection and Core reopen", t => {
  const f = fixture(t), peer = f.peer(), original = input();
  assert.equal(f.policy.getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), undefined);
  const result = f.policy.installRuntimeConcurrencyPolicy(original);
  assert.equal(result.status, "installed");
  assert.equal(result.policy.revision, 1);
  assert.deepEqual(result.policy, { workspaceId: DEFAULT_WORKSPACE_ID, runtimeInstanceId: "runtime-a",
    revision: 1, enabled: true, limits: limits(), installedAt: now });
  assert.ok(Object.isFrozen(result.policy));
  assert.ok(Object.isFrozen(result.policy.limits));
  assert.notEqual(result.policy.limits, original.limits);
  original.limits.maxConcurrentRuns = 64;
  assert.throws(() => {
    // @ts-expect-error Frozen policy ownership must reject JavaScript mutation.
    result.policy.runtimeInstanceId = "mutated";
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error Frozen limits must reject JavaScript mutation.
    result.policy.limits.maxConcurrentRuns = 64;
  }, TypeError);
  const read = peer.policy.getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID);
  assert.deepEqual(read, result.policy);
  assert.notEqual(read, result.policy);
  assert.ok(Object.isFrozen(read));
  assert.ok(Object.isFrozen(read.limits));
  assert.deepEqual(f.reopen().getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), result.policy);
});

test("same runtime and limits replay without any write, timestamp change or revision consumption", t => {
  const f = fixture(t), installed = f.policy.installRuntimeConcurrencyPolicy(input());
  assert.equal(installed.status, "installed");
  const first = installed.policy;
  f.db.exec(`CREATE TRIGGER reject_policy_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'unexpected-insert'); END`);
  f.db.exec(`CREATE TRIGGER reject_policy_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'unexpected-update'); END`);
  for (const expectedRevision of [0, 1, 9]) {
    const replay = unchanged(f, () => f.policy.installRuntimeConcurrencyPolicy(input({ expectedRevision, installedAt: later })));
    assert.equal(replay.status, "duplicate");
    assert.deepEqual(replay.policy, first);
  }
  f.db.exec("DROP TRIGGER reject_policy_insert; DROP TRIGGER reject_policy_update");
  f.reopen();
  assert.equal(unchanged(f, () => f.policy.installRuntimeConcurrencyPolicy(input())).status, "duplicate");
});

test("same runtime cannot hot-update any limit, while a new runtime requires the exact persisted revision", t => {
  const f = fixture(t), installed = f.policy.installRuntimeConcurrencyPolicy(input());
  assert.equal(installed.status, "installed");
  const first = installed.policy;
  for (const key of Object.keys(limits())) {
    for (const expectedRevision of [0, first.revision]) {
      assert.deepEqual(unchanged(f, () => f.policy.installRuntimeConcurrencyPolicy(input({ expectedRevision,
        limits: { ...limits(), [key]: 1 } }))), { status: "changed" });
    }
  }
  for (const expectedRevision of [0, 2, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(unchanged(f, () => f.policy.installRuntimeConcurrencyPolicy(input({ runtimeInstanceId: "runtime-b", expectedRevision }))),
      { status: "changed" });
  }
  const replacement = f.policy.installRuntimeConcurrencyPolicy(input({ runtimeInstanceId: "runtime-b", expectedRevision: 1, installedAt: later }));
  assert.equal(replacement.status, "installed");
  assert.equal(replacement.policy.revision, 2);
  assert.equal(replacement.policy.runtimeInstanceId, "runtime-b");
  assert.deepEqual(unchanged(f, () => f.policy.installRuntimeConcurrencyPolicy(input())), { status: "changed" });
});

async function race(t: TestContext, f: Fixture, inputs: readonly InstallRuntimeConcurrencyPolicyInput[]) {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const source = `import { parentPort, workerData } from "node:worker_threads";
    import { DatabaseSync } from "node:sqlite";
    const { SqliteRuntimeConcurrencyPolicyStore } = await import(workerData.moduleUrl);
    const db = new DatabaseSync(workerData.path);
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      parentPort.postMessage({ ready: true });
      const gate = new Int32Array(workerData.gate);
      if (Atomics.wait(gate, 0, 0, 10000) === "timed-out") throw new Error("policy race gate timed out");
      const result = new SqliteRuntimeConcurrencyPolicyStore({ database: db }).installRuntimeConcurrencyPolicy(workerData.input);
      db.close();
      parentPort.postMessage({ result });
    } finally { if (db.isOpen) db.close(); }`;
  const runners = inputs.map(value => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { workerData: {
      moduleUrl: new URL("../dist/storage/sqlite/runtime-concurrency-policy-store.js", import.meta.url).href,
      path: f.paths.databasePath, gate: gate.buffer, input: value,
    } });
    t.after(() => worker.terminate());
    let readyResolve!: () => void, readyReject!: (error: unknown) => void;
    let result: InstallRuntimeConcurrencyPolicyResult | undefined;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise<InstallRuntimeConcurrencyPolicyResult>((resolve, reject) => {
      worker.on("message", (message: { ready: true } | { ready?: false; result: InstallRuntimeConcurrencyPolicyResult }) => { if (message.ready) readyResolve(); else result = message.result; });
      worker.on("error", error => { readyReject(error); reject(error); });
      worker.on("exit", code => {
        if (code === 0 && result) resolve(result);
        else { const error = new Error(`policy race worker exited ${code} without a result`); readyReject(error); reject(error); }
      });
    });
    return { ready, done };
  });
  const completed = Promise.all(runners.map(runner => runner.done));
  await Promise.all(runners.map(runner => runner.ready));
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  return completed;
}

for (const expectedRevision of [0, 1]) {
  test(`real independent SQLite writers competing for revision ${expectedRevision} install exactly once`, async t => {
    const f = fixture(t);
    if (expectedRevision) f.policy.installRuntimeConcurrencyPolicy(input());
    const results = await race(t, f, ["left", "right"].map(runtimeInstanceId => input({ runtimeInstanceId, expectedRevision })));
    assert.deepEqual(results.map(result => result.status).sort(), ["changed", "installed"]);
    const winner = results.find(result => result.status === "installed")!;
    assert.equal(winner.status, "installed");
    const policy = winner.policy;
    assert.equal(policy.revision, expectedRevision + 1);
    assert.deepEqual(f.reopen().getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), policy);
    assert.equal(policyRows(f.db).length, 1);
  });
}

test("lowering limits changes only the policy, retaining active and released slots and their exact Attempt fences", t => {
  const f = fixture(t);
  f.policy.installRuntimeConcurrencyPolicy(input());
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task", ownerId: "policy-task",
    idempotencyKey: "policy-slot-owner", createdByActor: "system", request: {}, now });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "runtime-a", runnerId: "pi", now });
  for (const [id, status] of [["policy-active-a", "active"], ["policy-active-b", "active"], ["policy-released", "released"]]) {
    f.db.prepare(`INSERT INTO runtime_semaphore_slots(id,workspace_id,resource_type,resource_key,owner_type,owner_id,
      work_unit_id,attempt_id,runtime_instance_id,fencing_token,status,acquired_at,last_renewed_at,expires_at,released_at,release_reason)
      VALUES(?,?,'provider','policy-provider','work_unit_attempt',?,?,?,?,?,?,?,? ,?,?,?)`)
      .run(id, DEFAULT_WORKSPACE_ID, attempt.id, unit.id, attempt.id, attempt.runtimeInstanceId, attempt.fencingToken,
        status, now, now, later, status === "released" ? now : null, status === "released" ? "completed" : null);
  }
  const before = executionRows(f.db);
  assert.equal(before.runtime_semaphore_slots.filter(row => row.status === "active").length, 2);
  const lowered = Object.fromEntries(Object.keys(limits()).map(key => [key, 1])) as unknown as RuntimeConcurrencyLimits;
  const result = f.policy.installRuntimeConcurrencyPolicy(input({ runtimeInstanceId: "runtime-b", expectedRevision: 1, limits: lowered, installedAt: later }));
  assert.equal(result.status, "installed");
  assert.deepEqual(result.policy.limits, lowered);
  assert.deepEqual(executionRows(f.db), before);
  f.reopen();
  assert.deepEqual(executionRows(f.db), before);
});

test("malformed installation parameters consistently throw type/range errors without writes", t => {
  const f = fixture(t);
  const cases: [unknown, typeof TypeError][] = [[null, TypeError], [undefined, TypeError], [[], TypeError], [{ ...input(), workspaceId: 1 }, TypeError],
    [input({ workspaceId: " " }), RangeError], [input({ runtimeInstanceId: undefined }), TypeError],
    [input({ runtimeInstanceId: "\0runtime" }), RangeError], [{ ...input(), installedAt: null }, TypeError],
    [input({ installedAt: "invalid" }), RangeError], [input({ installedAt: "2026-11-03" }), RangeError],
    [{ ...input(), expectedRevision: "0" }, TypeError], [{ ...input(), expectedRevision: 0n }, TypeError],
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((expectedRevision): [unknown, typeof RangeError] => [input({ expectedRevision }), RangeError]),
    [{ ...input(), limits: null }, TypeError], [{ ...input(), limits: { ...limits(), extra: 1 } }, TypeError],
    [input({ limits: { ...limits(), maxWorkspaceWriteRuns: 5 } }), RangeError]];
  for (const [value, error] of cases) unchanged(f, () => assert.throws(() => f.policy.installRuntimeConcurrencyPolicy(value as InstallRuntimeConcurrencyPolicyInput), error));
  for (const value of [null, undefined, 0, "", " "]) {
    unchanged(f, () => assert.throws(() => f.policy.getRuntimeConcurrencyPolicy(value as string), value === "" || value === " " ? RangeError : TypeError));
  }
  assert.throws(() => f.policy.installRuntimeConcurrencyPolicy(input({ workspaceId: "missing-workspace" })), /FOREIGN KEY/u);
  assert.equal(f.policy.installRuntimeConcurrencyPolicy(input()).status, "installed");
});

test("workspace policies are independent and revision exhaustion cannot wrap or consume a write", t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('other-workspace','Other',?,?)").run(now, now);
  const installed = f.policy.installRuntimeConcurrencyPolicy(input());
  assert.equal(installed.status, "installed");
  const first = installed.policy;
  const other = f.policy.installRuntimeConcurrencyPolicy(input({ workspaceId: "other-workspace" }));
  assert.equal(other.status, "installed");
  assert.equal(other.policy.revision, 1);
  assert.deepEqual(f.policy.getRuntimeConcurrencyPolicy(DEFAULT_WORKSPACE_ID), first);
  f.db.prepare(`UPDATE ${table} SET revision=? WHERE workspace_id=?`).run(Number.MAX_SAFE_INTEGER, DEFAULT_WORKSPACE_ID);
  assert.deepEqual(unchanged(f, () => f.policy.installRuntimeConcurrencyPolicy(input({ runtimeInstanceId: "runtime-b",
    expectedRevision: Number.MAX_SAFE_INTEGER }))), { status: "changed" });
  assert.equal(unchanged(f, () => f.policy.installRuntimeConcurrencyPolicy(input())).status, "duplicate");
});

test("install failures roll back only the owned transaction, including a deferred COMMIT failure", t => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER policy_insert_fault AFTER INSERT ON ${table} BEGIN
    UPDATE workspaces SET name='owned-write' WHERE id=NEW.workspace_id; SELECT RAISE(ABORT,'policy-insert-fault'); END`);
  const before = snapshot(f.db);
  assert.throws(() => f.policy.installRuntimeConcurrencyPolicy(input()), /policy-insert-fault/u);
  assert.deepEqual(snapshot(f.db), before);
  assert.deepEqual(policyRows(f.db), []);
  f.db.exec("DROP TRIGGER policy_insert_fault");
  f.db.exec("CREATE TABLE policy_commit_fault(id TEXT REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED)");
  f.db.exec(`CREATE TRIGGER policy_deferred_fault AFTER INSERT ON ${table} BEGIN INSERT INTO policy_commit_fault VALUES('missing-workspace'); END`);
  assert.throws(() => f.policy.installRuntimeConcurrencyPolicy(input()), /FOREIGN KEY/u);
  assert.deepEqual(policyRows(f.db), []);
  assert.deepEqual(f.db.prepare("SELECT * FROM policy_commit_fault").all(), []);
  f.db.exec("DROP TRIGGER policy_deferred_fault; DROP TABLE policy_commit_fault");
  assert.equal(f.policy.installRuntimeConcurrencyPolicy(input()).status, "installed");
});

test("failed nested install and pending migration never commit or roll back an outer transaction without isTransaction", t => {
  const f = fixture(t, { predecessor: true }), peer = f.peer();
  const original = f.db.prepare("SELECT name FROM workspaces WHERE id=?").get(DEFAULT_WORKSPACE_ID)!.name;
  // SQL still executes on the real connection; only the optional metadata property is absent.
  const database = { exec: f.db.exec.bind(f.db), prepare: f.db.prepare.bind(f.db) };
  const policy = new SqliteRuntimeConcurrencyPolicyStore({ database: database as DatabaseSync });
  assert.equal("isTransaction" in database, false);
  for (const phase of ["pending", "installed"]) {
    if (phase === "installed") {
      migrate(database);
      assert.equal(policy.installRuntimeConcurrencyPolicy(input()).status, "installed");
    }
    for (const finish of ["COMMIT", "ROLLBACK"]) {
      f.db.exec("BEGIN IMMEDIATE");
      try {
        f.db.prepare("UPDATE workspaces SET name='caller-write' WHERE id=?").run(DEFAULT_WORKSPACE_ID);
        const before = snapshot(f.db);
        if (phase === "pending") assert.throws(() => migrate(database), /transaction/iu);
        else migrate(database);
        assert.throws(() => policy.installRuntimeConcurrencyPolicy(input()), /transaction/iu);
        assert.deepEqual(snapshot(f.db), before);
        assert.equal(f.db.prepare("SELECT name FROM workspaces WHERE id=?").get(DEFAULT_WORKSPACE_ID)!.name, "caller-write");
        assert.equal(peer.database.prepare("SELECT name FROM workspaces WHERE id=?").get(DEFAULT_WORKSPACE_ID)!.name, original);
        f.db.exec(finish);
      } catch (error) { try { f.db.exec("ROLLBACK"); } catch {} throw error; }
      assert.equal(peer.database.prepare("SELECT name FROM workspaces WHERE id=?").get(DEFAULT_WORKSPACE_ID)!.name,
        finish === "COMMIT" ? "caller-write" : original);
      f.db.prepare("UPDATE workspaces SET name=? WHERE id=?").run(original, DEFAULT_WORKSPACE_ID);
    }
  }
  assert.equal(policy.installRuntimeConcurrencyPolicy(input()).status, "duplicate");
});

test("migration rejects predecessor, version/name and schema collisions without rewriting them", async t => {
  for (const corruption of ["predecessor", "version", "name", "duplicate-name", "callback-invents", "callback-denies",
    "foreign-table", "foreign-view", "missing-table", "weakened-check", "extra-trigger", "unmarked-data", "orphan"]) {
    await t.test(corruption, t => {
      const uninstalled = ["version", "name", "callback-invents", "foreign-table", "foreign-view"].includes(corruption);
      const f = fixture(t, { predecessor: uninstalled });
      if (corruption === "predecessor") f.db.prepare("UPDATE schema_migrations SET name='foreign213' WHERE version=213").run();
      if (corruption === "version") record(f.db)(214, "foreign214");
      if (corruption === "name") record(f.db)(999214, table);
      if (corruption === "duplicate-name") record(f.db)(999214, table);
      if (corruption === "foreign-table") f.db.exec(`CREATE TABLE ${table}(workspace_id TEXT)`);
      if (corruption === "foreign-view") f.db.exec(`CREATE VIEW ${table} AS SELECT id AS workspace_id FROM workspaces`);
      if (corruption === "missing-table") f.db.exec(`DROP TABLE ${table}`);
      if (corruption === "weakened-check") {
        const sql = f.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table)!.sql as string;
        const weakened = sql.replace("max_workspace_write_runs BETWEEN 1 AND 4", "max_workspace_write_runs BETWEEN 1 AND 64");
        assert.notEqual(weakened, sql);
        f.db.exec(`DROP TABLE ${table}`);
        f.db.exec(weakened);
      }
      if (corruption === "extra-trigger") f.db.exec(`CREATE TRIGGER foreign_policy_trigger AFTER INSERT ON ${table} BEGIN SELECT 1; END`);
      if (corruption === "unmarked-data" || corruption === "orphan") f.policy.installRuntimeConcurrencyPolicy(input());
      if (corruption === "unmarked-data") f.db.prepare("DELETE FROM schema_migrations WHERE version=214").run();
      if (corruption === "orphan") {
        f.db.exec("PRAGMA foreign_keys=OFF");
        f.db.prepare(`UPDATE ${table} SET workspace_id='orphan-workspace'`).run();
        f.db.exec("PRAGMA foreign_keys=ON");
      }
      const before = snapshot(f.db), extra = corruption === "callback-invents" ? { hasMigration: () => true }
        : corruption === "callback-denies" ? { hasMigration: () => false } : {};
      assert.throws(() => migrate(f.db, extra), /runtime_concurrency_policy\.migration_/u);
      assert.deepEqual(snapshot(f.db), before);
      f.db.exec("BEGIN IMMEDIATE");
      f.db.exec("ROLLBACK");
    });
  }
});

test("migration callback and postcondition failures roll back DDL and markers and remain retryable", async t => {
  for (const failure of ["throw-before", "throw-after", "missing-marker", "wrong-marker", "missing-table", "deferred-commit"]) {
    await t.test(failure, t => {
      const f = fixture(t, { predecessor: true });
      if (failure === "deferred-commit") {
        f.db.exec("CREATE TABLE policy_migration_fault(id TEXT REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED)");
        f.db.exec("CREATE TRIGGER policy_migration_deferred AFTER INSERT ON schema_migrations WHEN NEW.version=214 BEGIN INSERT INTO policy_migration_fault VALUES('missing-workspace'); END");
      }
      const before = snapshot(f.db);
      assert.throws(() => migrate(f.db, { recordMigration(version, name) {
        f.db.prepare("UPDATE workspaces SET name='owned-migration-write' WHERE id=?").run(DEFAULT_WORKSPACE_ID);
        if (failure === "throw-before") throw new Error("policy-migration-fault");
        if (failure === "missing-marker") return;
        record(f.db)(version, failure === "wrong-marker" ? "foreign214" : name);
        if (failure === "throw-after") throw new Error("policy-migration-fault");
        if (failure === "missing-table") f.db.exec(`DROP TABLE ${table}`);
      } }), /policy-migration-fault|runtime_concurrency_policy\.migration_|FOREIGN KEY/u);
      assert.deepEqual(snapshot(f.db), before);
      if (failure === "deferred-commit") f.db.exec("DROP TRIGGER policy_migration_deferred; DROP TABLE policy_migration_fault");
      migrate(f.db);
      assert.equal(has(f.db)(214), true);
      assert.deepEqual(policyRows(f.db), []);
    });
  }
});
