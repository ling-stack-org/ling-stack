import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";
import { applyDelegationMigration } from "../dist/storage/sqlite/delegation-migration.js";

const now = "2026-10-09T00:00:00.000Z";
const isReadError = (code) => (error) => error?.name === "DelegationReadError" && error.kind === "read_error" && error.code === code;

/** Disposable FK-only metadata deliberately does not certify execution or artifacts. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-read-"));
  const path = join(cwd, "fixture.sqlite");
  const database = new DatabaseSync(path);
  t.after(async () => { database.close(); await rm(cwd, { recursive: true, force: true }); });
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    CREATE TABLE run_sessions(id TEXT PRIMARY KEY);
    CREATE TABLE work_unit_attempts(id TEXT PRIMARY KEY);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY);
    CREATE TABLE channel_workflows(id TEXT PRIMARY KEY);
    CREATE TABLE channel_workflow_steps(id TEXT PRIMARY KEY);
    INSERT INTO run_sessions VALUES('root'),('parent'),('child');
    INSERT INTO work_unit_attempts VALUES('attempt');
    INSERT INTO artifacts VALUES('artifact');
  `);
  applyDelegationMigration({ database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now),
  });
  const { SqliteDelegationStore } = await import("../dist/storage/sqlite/delegation-store.js");
  return { database, path, store: new SqliteDelegationStore({ database }),
    step: changes => insert(database, "delegation_steps", stepRow(changes)),
    message: changes => insert(database, "delegation_messages", messageRow(changes)),
  };
}

function stepRow(changes = {}) {
  const id = changes.id ?? "parent-step";
  return {
    id, schema_version: 1, root_run_id: "root", parent_run_id: "parent", parent_attempt_id: "attempt",
    workflow_id: null, workflow_step_id: null, parent_delegation_step_id: null, child_run_id: null,
    spawn_call_id: `spawn:${id}`, objective_artifact_id: "artifact", required: 1, state: "planned", depth: 1,
    permission_snapshot_artifact_id: "artifact", tool_allowlist_artifact_id: "artifact",
    workspace_scope_artifact_id: "artifact", provider_policy_artifact_id: "artifact",
    token_budget: null, cost_budget_micros: null, wall_time_budget_ms: null, idempotency_key: `intent:${id}`,
    revision: 0, failure_code: null, created_at: now, updated_at: now, completed_at: null, ...changes,
  };
}

function messageRow(changes = {}) {
  const id = changes.id ?? "message";
  return { id, schema_version: 1, delegation_step_id: "parent-step", direction: "parent_to_child",
    kind: "instruction", body_artifact_id: "artifact", digest: "a".repeat(64),
    idempotency_key: `message:${id}`, created_at: now, ...changes };
}

function insert(database, table, row) {
  database.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

function seedChildren(f, ids, createdAt = now) {
  for (const id of ids) f.step({ id, parent_delegation_step_id: "parent-step", parent_run_id: "child", depth: 2, created_at: createdAt });
}

function snapshot(database) {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === "table" && !row.name.startsWith("sqlite_"));
  return { schema, rows: tables.map(row => [row.name, database.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all()]) };
}

test("delegation read facet exists on the public SQLite facade", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-read-missing-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  for (const method of ["getDelegationStep", "listDelegationChildren", "listDelegationMessages",
    "queryDelegationChildren", "queryDelegationMessages"]) {
    assert.equal(typeof store[method], "function", `Missing delegation read method: ${method}`);
  }
  assert.equal(store.getDelegationStep("missing"), undefined);
  assert.deepEqual(store.listDelegationChildren("missing"), []);
  assert.deepEqual(store.listDelegationMessages("missing"), []);
  assert.deepEqual(store.queryDelegationChildren("missing"), { items: [], hasMore: false });
  assert.deepEqual(store.queryDelegationMessages("missing"), { items: [], hasMore: false });
});

test("delegation metadata round-trips through the public facade and reopen without certifying the source", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-public-read-"));
  const stores = [];
  const first = createSqliteRunStore(cwd);
  stores.push(first);
  const writer = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => { writer.close(); for (const store of stores) store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = first.createChannel({ name: "Read fixture", boundPath: cwd }, now);
  const task = first.createTask({ channelId: channel.id, title: "Read", prompt: "Metadata only" }, now);
  const run = first.createRun({ id: "root", cwd, taskId: task.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const unit = first.createWorkUnit({ id: "unit", workspaceId: "workspace_default", kind: "task_run", ownerType: "task",
    ownerId: task.id, idempotencyKey: "unit-read", createdByActor: "system", request: {}, now });
  const attempt = first.createWorkUnitAttempt({ id: "attempt", workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "stale-runtime", runnerId: "pi", status: "succeeded", now });
  first.createArtifact({ id: "artifact", runId: run.id, type: "json", path: "unsealed-reference.json", createdAt: now });
  // Seed persisted metadata directly; the read facade must not authenticate this ended Attempt/unsealed artifact.
  insert(writer, "delegation_steps", stepRow({ parent_run_id: run.id, parent_attempt_id: attempt.id }));
  insert(writer, "delegation_messages", messageRow());
  const expected = first.getDelegationStep("parent-step");
  assert.equal(expected.rootRunId, run.id);
  assert.equal(expected.parentAttemptId, attempt.id);
  assert.equal(expected.permissionSnapshotArtifactId, "artifact");
  stores.pop().close();
  const second = createSqliteRunStore(cwd);
  stores.push(second);
  assert.deepEqual(second.getDelegationStep("parent-step"), expected);
  assert.equal(second.listDelegationMessages("parent-step")[0].bodyArtifactId, "artifact");
  assert.equal(second.queryDelegationMessages("parent-step").hasMore, false);
});

test("SELECT-only reads preserve exact rows/schema, same-connection changes and observer data_version", async (t) => {
  const f = await fixture(t);
  f.step({ state: "running", child_run_id: "child" });
  seedChildren(f, ["a", "b"]);
  f.message();
  const observer = new DatabaseSync(f.path);
  t.after(() => observer.close());
  const before = snapshot(observer);
  const version = observer.prepare("PRAGMA data_version").get().data_version;
  const changes = f.database.prepare("SELECT total_changes() AS count").get().count;
  f.database.exec("PRAGMA query_only=ON");
  assert.equal(f.store.getDelegationStep("parent-step").required, true);
  const firstRead = f.store.getDelegationStep("a");
  firstRead.required = false;
  assert.equal(f.store.getDelegationStep("a").required, true);
  assert.deepEqual(f.store.listDelegationChildren("parent-step").map(row => row.id), ["a", "b"]);
  assert.equal(f.store.listDelegationMessages("parent-step").length, 1);
  assert.equal(f.store.queryDelegationChildren("parent-step", { limit: 1 }).hasMore, true);
  assert.equal(f.store.queryDelegationMessages("parent-step").items.length, 1);
  assert.equal(f.database.prepare("PRAGMA query_only").get().query_only, 1);
  assert.equal(f.database.prepare("SELECT total_changes() AS count").get().count, changes);
  assert.equal(observer.prepare("PRAGMA data_version").get().data_version, version);
  assert.deepEqual(snapshot(observer), before);
});

test("BINARY keyset preserves tied/noncanonical strings, scope and the last returned cursor", async (t) => {
  const f = await fixture(t);
  f.step({ state: "running", child_run_id: "child" });
  seedChildren(f, ["a", "A", "ä", "中", "𐀀"], " opaque time ");
  f.step({ id: "other-scope", state: "running", child_run_id: "parent", parent_run_id: "child" });
  f.step({ id: "other-child", parent_delegation_step_id: "other-scope", parent_run_id: "parent", depth: 2, created_at: " opaque time " });
  const expected = f.database.prepare("SELECT id FROM delegation_steps WHERE parent_delegation_step_id=? ORDER BY created_at COLLATE BINARY,id COLLATE BINARY")
    .all("parent-step").map(row => row.id);
  const ids = [];
  let after;
  do {
    const page = f.store.queryDelegationChildren("parent-step", { limit: 2, after });
    ids.push(...page.items.map(row => row.id));
    if (page.hasMore) assert.deepEqual(page.nextCursor, { schemaVersion: 1, kind: "children", scopeId: "parent-step",
      createdAt: " opaque time ", id: page.items.at(-1).id });
    else assert.equal(page.nextCursor, undefined);
    after = page.nextCursor;
  } while (after);
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, 5);
  assert.throws(() => f.store.queryDelegationChildren("other-scope", { after: { schemaVersion: 1, kind: "children",
    scopeId: "parent-step", createdAt: " opaque time ", id: "A" } }), isReadError("invalid_read_input"));
});

test("legacy lists return all 1000 or fail while explicit pages expose 200/1000 boundaries", async (t) => {
  const f = await fixture(t);
  f.step({ state: "running", child_run_id: "child" });
  seedChildren(f, Array.from({ length: 1000 }, (_, index) => `child-${String(index).padStart(4, "0")}`));
  for (let index = 0; index < 1000; index += 1) f.message({ id: `message-${String(index).padStart(4, "0")}` });
  assert.equal(f.store.listDelegationChildren("parent-step").length, 1000);
  assert.equal(f.store.listDelegationMessages("parent-step").length, 1000);
  assert.equal(f.store.queryDelegationChildren("parent-step").items.length, 200);
  assert.equal(f.store.queryDelegationMessages("parent-step").items.length, 200);
  seedChildren(f, ["child-1000"]);
  f.message({ id: "message-1000" });
  assert.throws(() => f.store.listDelegationChildren("parent-step"), isReadError("read_limit_exceeded"));
  assert.throws(() => f.store.listDelegationMessages("parent-step"), isReadError("read_limit_exceeded"));
  for (const method of ["queryDelegationChildren", "queryDelegationMessages"]) {
    const page = f.store[method]("parent-step", { limit: 1000 });
    assert.equal(page.items.length, 1000);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextCursor.id, page.items.at(-1).id);
    const tail = f.store[method]("parent-step", { limit: 1000, after: page.nextCursor });
    assert.equal(tail.items.length, 1);
    assert.equal(tail.hasMore, false);
  }
});

test("read inputs reject invalid limits/cursors and do not invoke getters or inherited fields", async (t) => {
  const f = await fixture(t);
  const cursor = { schemaVersion: 1, kind: "children", scopeId: "parent-step", createdAt: now, id: "a" };
  for (const limit of [0, -1, 1.5, NaN, Infinity, 1001, "1", null]) {
    assert.throws(() => f.store.queryDelegationChildren("parent-step", { limit }), isReadError("invalid_read_input"));
  }
  for (const change of [{ schemaVersion: 2 }, { kind: "messages" }, { scopeId: "other" }, { id: "" }, { id: "a\0b" },
    { createdAt: "" }, { createdAt: null }, { unknown: true }]) {
    assert.throws(() => f.store.queryDelegationChildren("parent-step", { after: { ...cursor, ...change } }), isReadError("invalid_read_input"));
  }
  const missingId = { ...cursor }; delete missingId.id;
  assert.throws(() => f.store.queryDelegationChildren("parent-step", { after: missingId }), isReadError("invalid_read_input"));
  assert.throws(() => f.store.queryDelegationChildren("parent-step", { after: Object.create(cursor) }), isReadError("invalid_read_input"));
  let calls = 0;
  for (const key of ["limit", "after"]) {
    const options = Object.defineProperty({}, key, { get() { calls += 1; throw new Error("getter ran"); } });
    assert.throws(() => f.store.queryDelegationChildren("parent-step", options), isReadError("invalid_read_input"));
  }
  const accessorCursor = { ...cursor };
  Object.defineProperty(accessorCursor, "id", { get() { calls += 1; return "a"; } });
  assert.throws(() => f.store.queryDelegationChildren("parent-step", { after: accessorCursor }), isReadError("invalid_read_input"));
  const proxy = new Proxy({}, { ownKeys() { throw new Error("descriptor trap"); } });
  assert.throws(() => f.store.queryDelegationChildren("parent-step", proxy), isReadError("invalid_read_input"));
  assert.equal(calls, 0);
  assert.deepEqual(f.store.queryDelegationChildren("parent-step", { after: cursor }), { items: [], hasMore: false });
  for (const id of ["", "a\0b", 1, null]) assert.throws(() => f.store.getDelegationStep(id), isReadError("invalid_read_input"));
});

test("revoked Proxy options produce a typed read error", async (t) => {
  const f = await fixture(t);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.throws(() => f.store.queryDelegationChildren("parent-step", revoked.proxy), isReadError("invalid_read_input"));
});

test("revoked Proxy cursor produces a typed read error", async (t) => {
  const f = await fixture(t);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.throws(() => f.store.queryDelegationChildren("parent-step", { after: revoked.proxy }), isReadError("invalid_read_input"));
});

test("strict mappers reject corruption without coercion and preserve schema-legal raw/nullable values", async () => {
  const { mapDelegationStep, mapDelegationMessage } = await import("../dist/storage/sqlite/delegation-mappers.js");
  const mapped = mapDelegationStep(stepRow({ id: " raw id ", created_at: " opaque time ", updated_at: " ", required: 0n,
    token_budget: 0n, cost_budget_micros: BigInt(Number.MAX_SAFE_INTEGER), revision: BigInt(Number.MAX_SAFE_INTEGER) }));
  assert.equal(mapped.id, " raw id ");
  assert.equal(mapped.createdAt, " opaque time ");
  assert.equal(mapped.required, false);
  assert.equal(mapped.tokenBudget, 0);
  assert.equal(mapped.costBudgetMicros, Number.MAX_SAFE_INTEGER);
  assert.equal(mapped.wallTimeBudgetMs, undefined);
  assert.equal(mapped.workflowId, undefined);
  assert.equal(mapped.childRunId, undefined);
  for (const change of [{ schema_version: 2 }, { required: 2 }, { required: "1" }, { state: "unknown" }, { failure_code: "unknown" },
    { token_budget: -1 }, { cost_budget_micros: 1.5 }, { wall_time_budget_ms: NaN }, { revision: Infinity },
    { revision: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, { depth: 0 }, { id: "" }, { spawn_call_id: "a\0b" },
    { created_at: "" }, { workflow_step_id: "step" }, { parent_delegation_step_id: "parent-step" },
    { state: "running" }, { child_run_id: "child" }, { state: "failed" }, { completed_at: now },
    { state: "succeeded", child_run_id: "child", completed_at: now, failure_code: "delegation.child_lost" }]) {
    assert.throws(() => mapDelegationStep(stepRow(change)), isReadError("invalid_persisted_row"));
  }
  for (const key of Object.keys(stepRow())) {
    const row = stepRow(); delete row[key];
    assert.throws(() => mapDelegationStep(row), isReadError("invalid_persisted_row"), `Missing column ${key}`);
  }
  for (const change of [{ schema_version: 2 }, { direction: "unknown" }, { kind: "unknown" }, { digest: "A".repeat(64) },
    { digest: "g".repeat(64) }, { digest: "a".repeat(63) }, { digest: `${"a".repeat(63)}\0` }, { body_artifact_id: null }]) {
    assert.throws(() => mapDelegationMessage(messageRow(change)), isReadError("invalid_persisted_row"));
  }
  for (const key of Object.keys(messageRow())) {
    const row = messageRow(); delete row[key];
    assert.throws(() => mapDelegationMessage(row), isReadError("invalid_persisted_row"));
  }
  assert.equal(mapDelegationMessage(messageRow({ created_at: "raw" })).createdAt, "raw");
});

test("a malformed row, including the probe, fails the entire bounded read rather than being skipped", async (t) => {
  const f = await fixture(t);
  f.step({ state: "running", child_run_id: "child" });
  seedChildren(f, ["a", "b"]);
  f.database.exec("PRAGMA ignore_check_constraints=ON");
  // Poison disposable data without asking identity-immutable production triggers to permit the mutation.
  f.database.exec("DROP TRIGGER trg_delegation_steps_identity_immutable; DROP TRIGGER trg_delegation_steps_transition;");
  f.database.prepare("UPDATE delegation_steps SET required=2 WHERE id='b'").run();
  assert.throws(() => f.store.getDelegationStep("b"), isReadError("invalid_persisted_row"));
  assert.throws(() => f.store.listDelegationChildren("parent-step"), isReadError("invalid_persisted_row"));
  assert.throws(() => f.store.queryDelegationChildren("parent-step", { limit: 1 }), isReadError("invalid_persisted_row"));
});

test("poisoned SQLite integers pass through BigInt reads and fail with a typed row error", async (t) => {
  const f = await fixture(t);
  f.step({ state: "running", child_run_id: "child" });
  seedChildren(f, ["a", "b"]);
  f.database.exec("PRAGMA ignore_check_constraints=ON; DROP TRIGGER trg_delegation_steps_identity_immutable;");
  f.database.prepare("UPDATE delegation_steps SET token_budget=?,revision=revision+1 WHERE id='b'").run(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  assert.throws(() => f.store.getDelegationStep("b"), isReadError("invalid_persisted_row"));
  assert.throws(() => f.store.listDelegationChildren("parent-step"), isReadError("invalid_persisted_row"));
  assert.throws(() => f.store.queryDelegationChildren("parent-step", { limit: 1 }), isReadError("invalid_persisted_row"));
});
