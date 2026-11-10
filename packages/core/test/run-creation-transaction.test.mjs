import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const now = "2026-09-09T08:00:00.000Z";
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-run-create-atomic-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createLingThread({ kind: "task", taskId: "task", title: "Atomic creation", objective: "Atomic creation" }, now);
  const turn = store.createLingTurn({ threadId: thread.id, kind: "initial_request", title: "Atomic creation", userInstruction: "Continue original work" }, now);
  const input = { id: "new-run", cwd, taskId: "task", threadId: thread.id, turnId: turn.id,
    providerName: "fixture", providerModel: "fixture", selectedSkillId: "fixture-skill",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now };
  const before = { thread: store.getLingThread(thread.id), turn: store.getLingTurn(turn.id) };
  const absent = () => {
    assert.equal(store.getRun(input.id), undefined);
    assert.deepEqual(store.listLingTurnRuns(turn.id), []);
    assert.deepEqual(store.listSkillUsageEvents({ runId: input.id }), []);
    assert.deepEqual(store.getLingTurn(turn.id), before.turn);
    assert.deepEqual(store.getLingThread(thread.id), before.thread);
  };
  return { cwd, store, input, thread, turn, absent };
}

for (const mode of ["ABORT", "ROLLBACK"]) test(`selected skill audit failure rolls back Run and Turn: ${mode}`, async t => {
  const f = await fixture(t);
  f.store.database.exec(`CREATE TRIGGER selected_failure BEFORE INSERT ON skill_usage_events BEGIN SELECT RAISE(${mode}, 'selected_write_failed'); END`);
  assert.throws(() => f.store.createRun(f.input), /selected_write_failed/);
  f.absent();
  assert.equal(f.store.database.isTransaction, false);
});

test("successful creation atomically records selected usage exactly once", async t => {
  const f = await fixture(t);
  const run = f.store.createRun(f.input);
  assert.equal(run.status, "queued");
  assert.equal(f.store.getLingTurnForRun(run.id).id, f.turn.id);
  assert.equal(f.store.getLingTurn(f.turn.id).activeRunId, run.id);
  assert.deepEqual(f.store.listSkillUsageEvents({ runId: run.id }).map(event => event.kind), ["selected"]);
  assert.throws(() => f.store.createRun(f.input), /UNIQUE|constraint/i);
  assert.deepEqual(f.store.getRun(run.id), run);
  assert.equal(f.store.listSkillUsageEvents({ runId: run.id }).length, 1);
});

test("creation without a selected skill does not synthesize usage", async t => {
  const f = await fixture(t);
  f.store.createRun({ ...f.input, selectedSkillId: undefined });
  assert.deepEqual(f.store.listSkillUsageEvents({ runId: f.input.id }), []);
});

for (const joined of [false, true]) test(`creation uses SQLite transaction ownership, not a version-specific JS flag: ${joined}`, async t => {
  const f = await fixture(t);
  const sessions = f.store.runSessions;
  const originalContext = sessions.context;
  sessions.context = { ...originalContext, database: new Proxy(f.store.database, {
    get(target, key) {
      if (key === "isTransaction") throw new Error("transaction JS flag is unavailable on this runtime");
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) };
  try {
    if (joined) f.store.database.exec("BEGIN IMMEDIATE");
    const run = joined ? f.store.runSessions.createRunWithinTransaction(f.input) : f.store.createRun(f.input);
    assert.equal(run.id, f.input.id);
    if (joined) { f.store.database.exec("ROLLBACK"); f.absent(); }
  } finally {
    sessions.context = originalContext;
    if (f.store.database.isTransaction) f.store.database.exec("ROLLBACK");
  }
});

test("unknown Turn rolls back Run and selection without affecting other turns", async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.createRun({ ...f.input, turnId: "absent-turn" }), /Ling turn not found/);
  f.absent();
});

test("joined creation requires an active caller-owned transaction", async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.runSessions.createRunWithinTransaction(f.input), /active SQLite transaction/);
  f.absent();
});

test("joined creation remains invisible to another connection until the caller commits", async t => {
  const f = await fixture(t);
  const reader = createSqliteRunStore(f.cwd);
  try {
    f.store.database.exec("BEGIN IMMEDIATE");
    const run = f.store.runSessions.createRunWithinTransaction(f.input);
    assert.equal(f.store.database.isTransaction, true);
    assert.equal(f.store.getRun(run.id).status, "queued");
    assert.equal(reader.getRun(run.id), undefined);
    assert.deepEqual(reader.listLingTurnRuns(f.turn.id), []);
    assert.deepEqual(reader.listSkillUsageEvents({ runId: run.id }), []);
    f.store.database.exec("COMMIT");
    assert.equal(reader.getRun(run.id).status, "queued");
    assert.equal(reader.listLingTurnRuns(f.turn.id).length, 1);
    assert.equal(reader.listSkillUsageEvents({ runId: run.id }).length, 1);
  } finally {
    if (f.store.database.isTransaction) f.store.database.exec("ROLLBACK");
    reader.close();
  }
});

test("caller rollback removes joined Run, Turn projection and selection", async t => {
  const f = await fixture(t);
  f.store.database.exec("BEGIN IMMEDIATE");
  f.store.runSessions.createRunWithinTransaction(f.input);
  f.store.database.exec("ROLLBACK");
  f.absent();
});

test("public creation cannot roll back a transaction it did not begin", async t => {
  const f = await fixture(t);
  f.store.database.exec("CREATE TABLE caller_marker (value INTEGER); BEGIN IMMEDIATE; INSERT INTO caller_marker VALUES (1)");
  try {
    assert.throws(() => f.store.createRun(f.input), /transaction/i);
    assert.equal(f.store.database.isTransaction, true);
    assert.equal(f.store.database.prepare("SELECT value FROM caller_marker").get().value, 1);
    f.absent();
  } finally { f.store.database.exec("ROLLBACK"); }
});

test("a failure at COMMIT removes all creation records and preserves the original error", async t => {
  const f = await fixture(t);
  const database = f.store.database;
  const original = database.exec.bind(database);
  const error = new Error("fixture_commit_failed");
  database.exec = sql => {
    if (sql === "COMMIT") throw error;
    return original(sql);
  };
  try { assert.throws(() => f.store.createRun(f.input), candidate => candidate === error); }
  finally { database.exec = original; }
  assert.equal(database.isTransaction, false);
  f.absent();
  assert.equal(f.store.createRun(f.input).id, f.input.id);
});

test("snapshot getters cannot write SQL during creation normalization", async t => {
  const f = await fixture(t);
  f.store.database.exec("CREATE TABLE payload_writes (value INTEGER)");
  const requestSnapshot = { get note() {
    f.store.database.exec("INSERT INTO payload_writes VALUES (1)");
    return "not-reached";
  } };
  assert.throws(() => f.store.createRun({ ...f.input, requestSnapshot }), /readonly/i);
  f.absent();
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM payload_writes").get().n, 0);
});

test("normalization captures top-level identity once even when a snapshot mutates its source", async t => {
  const f = await fixture(t);
  const input = { ...f.input };
  input.requestSnapshot = { get note() { input.id = "mutated-id"; return "captured"; } };
  const run = f.store.createRun(input);
  assert.equal(run.id, f.input.id);
  assert.equal(f.store.getRun("mutated-id"), undefined);
  assert.match(run.eventLogPath, /new-run/);
  assert.equal(run.requestSnapshot.note, "captured");
});

test("snapshots still redact provider secrets before durable storage", async t => {
  const f = await fixture(t);
  const run = f.store.createRun({ ...f.input,
    providerSnapshot: { apiKey: "sk-test-runcreation000000000000", label: "fixture" } });
  assert.equal(run.providerSnapshot.label, "fixture");
  assert.equal(run.providerSnapshot.apiKey, "[REDACTED]");
  assert.ok(!JSON.stringify(run).includes("sk-test-runcreation"));
});

test("a cache-only ABORT remains recoverable without losing authoritative creation", async t => {
  const f = await fixture(t);
  f.store.database.exec("CREATE TRIGGER cache_failure BEFORE UPDATE OF metadata_json ON ling_threads BEGIN SELECT RAISE(ABORT, 'cache_only_failed'); END");
  const run = f.store.createRun(f.input);
  assert.equal(f.store.getRun(run.id).status, "queued");
  assert.equal(f.store.getLingTurn(f.turn.id).activeRunId, run.id);
  assert.equal(f.store.listSkillUsageEvents({ runId: run.id }).length, 1);
});

test("a swallowed cache ROLLBACK cannot cause orphan selection or false success", async t => {
  const f = await fixture(t);
  f.store.database.exec("CREATE TRIGGER cache_rollback BEFORE UPDATE OF metadata_json ON ling_threads BEGIN SELECT RAISE(ROLLBACK, 'cache_rolled_back_transaction'); END");
  assert.throws(() => f.store.createRun(f.input), /transaction.*lost|active SQLite transaction/i);
  f.absent();
  assert.equal(f.store.database.isTransaction, false);
});

test("joined answer continuation preserves caller-selected original Turn and resume lineage", async t => {
  const f = await fixture(t);
  const parent = f.store.createRun({ ...f.input, id: "parent-run" });
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    const child = f.store.runSessions.createRunWithinTransaction({ ...f.input, id: "answer-run",
      parentRunId: parent.id, continuationReason: "user_input_answer", turnRunRole: "resume" });
    assert.equal(child.parentRunId, parent.id);
    assert.equal(child.continuationReason, "user_input_answer");
    const links = f.store.listLingTurnRuns(f.turn.id);
    assert.deepEqual(links.map(link => link.role), ["primary", "resume"]);
    assert.equal(f.store.getLingTurnForRun(child.id).id, f.turn.id);
    // This primitive is not continuation admission: no answer delivery or ACK is created.
    f.store.database.exec("ROLLBACK");
    assert.equal(f.store.getRun(child.id), undefined);
    assert.equal(f.store.listLingTurnRuns(f.turn.id).length, 1);
  } finally { if (f.store.database.isTransaction) f.store.database.exec("ROLLBACK"); }
});
