import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "../dist/index.js";

const time = second => `2026-10-16T03:00:${String(second).padStart(2, "0")}.000Z`;

/** Explicit owned SQLite paths; no default HOME, real app, Provider or Runner. */
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-b006-task-ledger-")));
  const cwd = join(directory, "workspace");
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(directory, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${directory}/`));
  const stores = [], open = () => { const store = createSqliteRunStore(cwd, paths); stores.push(store); return store; };
  const store = open(), observer = open();
  t.after(async () => {
    for (const current of stores.reverse()) if (current.database.isOpen) current.close();
    assert.ok(directory.startsWith(`${await fs.realpath(os.tmpdir())}/ling-b006-task-ledger-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const channel = store.createChannel({ name: "B006 isolated channel", boundPath: cwd }, time(0));
  const task = store.createTask({ channelId: channel.id, title: "B006 atomic task", prompt: "Fixture only; no dispatch." }, time(0));
  const run = store.createRun({ id: "b006-fixture-run", cwd, taskId: task.id, channelId: channel.id,
    providerName: "isolated-fixture", providerModel: "no-model", taskSnapshot: task,
    providerSnapshot: {}, requestSnapshot: { tools: [], workspaceAccessMode: "read_only" }, createdAt: time(0) });
  const input = { taskId: task.id, expectedStatus: "todo", event: "claim", actor: "system",
    currentRunId: run.id, assigneeTeammateId: "b006_fixture_agent", idempotencyKey: "b006-first-claim",
    reason: "B006 owned fixture claim", now: time(1) };
  const facts = reader => ({ task: reader.getTask(task.id),
    events: reader.listStateTransitionEvents({ entityType: "task", entityId: task.id }),
    key: reader.findStateTransitionByIdempotency("task", task.id, input.idempotencyKey) });
  const extraTask = () => store.createTask({ channelId: channel.id, title: "Caller-owned work", prompt: "Preserve caller transaction." }, time(2));
  return { store, observer, open, task, run, input, facts, extraTask };
}

/** Observe a real INSERT and optionally fail it before or after its durable statement. */
function ledgerBoundary(t, f, mode) {
  const primary = Object.assign(new Error("B006 owned failure after real ledger INSERT"), { code: "EIO" });
  if (mode === "before") {
    f.store.database.exec(`CREATE TRIGGER b006_ledger_fault BEFORE INSERT ON state_transition_events
      WHEN NEW.entity_type = 'task' AND NEW.entity_id = '${f.task.id}'
      BEGIN SELECT RAISE(ABORT, 'B006 owned ledger INSERT failure'); END`);
  }
  const originalPrepare = f.store.database.prepare;
  const observations = [];
  const patch = t.mock.method(f.store.database, "prepare", function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (!/^\s*INSERT INTO state_transition_events\s*\(/u.test(sql)) return statement;
    const originalRun = statement.run;
    statement.run = function (...args) {
      const observed = { writerBefore: f.facts(f.store), peerBefore: f.facts(f.observer), wroteLedger: false };
      observations.push(observed);
      const result = originalRun.apply(this, args);
      observed.wroteLedger = Number(result.changes) === 1;
      observed.writerAfter = f.facts(f.store);
      observed.peerAfter = f.facts(f.observer);
      if (mode === "after") throw primary;
      return result;
    };
    return statement;
  });
  return { primary, observations, restore() {
    patch.mock.restore();
    if (mode === "before") f.store.database.exec("DROP TRIGGER b006_ledger_fault");
  } };
}

function assertRetry(f) {
  assert.deepEqual(f.store.transitionTaskStatus(f.input), { ok: true, from: "todo", to: "claimed" });
  const after = f.facts(f.store);
  assert.equal(after.task.status, "claimed");
  assert.equal(after.task.currentRunId, f.run.id);
  assert.equal(after.task.assigneeTeammateId, f.input.assigneeTeammateId);
  assert.equal(after.events.length, 1);
  assert.equal(after.key.id, after.events[0].id);
  assert.deepEqual(f.store.transitionTaskStatus({ ...f.input, currentRunId: null, assigneeTeammateId: null, now: time(3) }),
    { ok: true, from: "claimed", to: "claimed", duplicate: true });
  assert.deepEqual(f.facts(f.store), after, "a duplicate cannot partially update Task metadata or append ledger");
  return after;
}

test("B006 normal Task state and ledger are invisible to a peer until committed together", async t => {
  const f = await fixture(t), before = f.facts(f.observer), boundary = ledgerBoundary(t, f, "observe");
  let result;
  try { result = f.store.transitionTaskStatus(f.input); }
  finally { boundary.restore(); }
  assert.deepEqual(result, { ok: true, from: "todo", to: "claimed" });
  assert.equal(boundary.observations.length, 1);
  const observed = boundary.observations[0];
  assert.equal(observed.writerBefore.task.status, "claimed", "the actual UPDATE must precede the observed INSERT");
  assert.equal(observed.writerBefore.task.currentRunId, f.run.id);
  assert.equal(observed.writerBefore.events.length, 0);
  assert.equal(observed.wroteLedger, true, "the original INSERT must really execute");
  assert.deepEqual(observed.peerBefore, before, "never publish state without its audit/idempotency fact");
  assert.deepEqual(observed.peerAfter, before, "even a completed statement stays private until the atomic unit commits");
  const after = f.facts(f.observer);
  assert.equal(after.task.status, "claimed");
  assert.equal(after.events.length, 1);
  assert.deepEqual(f.facts(f.open()), after);
  assert.deepEqual(f.store.transitionTaskStatus({ ...f.input, now: time(4) }),
    { ok: true, from: "claimed", to: "claimed", duplicate: true });
  assert.deepEqual(f.facts(f.observer), after);
});

for (const mode of ["before", "after"]) {
  test(`B006 ledger INSERT ${mode} failure rolls back all Task fields and permits same-key retry`, async t => {
    const f = await fixture(t), before = f.facts(f.observer), boundary = ledgerBoundary(t, f, mode);
    let error;
    try { f.store.transitionTaskStatus(f.input); }
    catch (caught) { error = caught; }
    finally { boundary.restore(); }
    assert.equal(boundary.observations.length, 1);
    const observed = boundary.observations[0];
    assert.equal(observed.writerBefore.task.status, "claimed");
    assert.equal(observed.writerBefore.task.currentRunId, f.run.id);
    assert.equal(observed.writerBefore.task.assigneeTeammateId, f.input.assigneeTeammateId);
    if (mode === "before") assert.match(error?.message ?? "", /B006 owned ledger INSERT failure/u);
    else {
      assert.equal(error, boundary.primary, "the original after-INSERT failure identity must survive cleanup");
      assert.equal(observed.wroteLedger, true);
      assert.equal(observed.writerAfter.events.length, 1);
    }
    assert.deepEqual(f.facts(f.store), before);
    assert.deepEqual(f.facts(f.observer), before);
    assert.deepEqual(f.facts(f.open()), before);
    assert.deepEqual(observed.peerBefore, before);
    if (mode === "after") assert.deepEqual(observed.peerAfter, before);
    const after = assertRetry(f);
    assert.deepEqual(f.facts(f.observer), after);
    assert.deepEqual(f.facts(f.open()), after);
  });
}

test("B006 successful nested Task transition cannot commit its caller's transaction", async t => {
  const f = await fixture(t), before = f.facts(f.observer);
  let extra;
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    extra = f.extraTask();
    assertRetry(f);
    assert.deepEqual(f.facts(f.observer), before);
    assert.equal(f.observer.getTask(extra.id), undefined);
  } finally { f.store.database.exec("ROLLBACK"); }
  assert.deepEqual(f.facts(f.store), before);
  assert.deepEqual(f.facts(f.observer), before);
  assert.deepEqual(f.facts(f.open()), before);
  assert.equal(f.store.getTask(extra.id), undefined);
  const afterRetry = assertRetry(f);
  assert.deepEqual(f.facts(f.observer), afterRetry, "the caller rollback must leave the connection reusable");
});

for (const mode of ["before", "after"]) {
  test(`B006 nested ledger ${mode} failure preserves caller work and supports in-transaction retry`, async t => {
    const f = await fixture(t), before = f.facts(f.observer), boundary = ledgerBoundary(t, f, mode);
    let extra, after, restored = false;
    f.store.database.exec("BEGIN IMMEDIATE");
    try {
      extra = f.extraTask();
      let error;
      try { f.store.transitionTaskStatus(f.input); }
      catch (caught) { error = caught; }
      assert.equal(boundary.observations.length, 1);
      if (mode === "before") assert.match(error?.message ?? "", /B006 owned ledger INSERT failure/u);
      else { assert.equal(error, boundary.primary); assert.equal(boundary.observations[0].wroteLedger, true); }
      assert.deepEqual(f.facts(f.store), before, "only the method's Task/ledger writes roll back");
      assert.deepEqual(f.store.getTask(extra.id), extra, "do not rollback work owned by the parent transaction");
      assert.deepEqual(f.facts(f.observer), before);
      assert.equal(f.observer.getTask(extra.id), undefined, "do not commit parent work on failure either");
      boundary.restore(); restored = true;
      after = assertRetry(f);
      assert.deepEqual(f.facts(f.observer), before);
      f.store.database.exec("COMMIT");
    } catch (error) {
      try { f.store.database.exec("ROLLBACK"); } catch { /* Keep the actual contract failure if a broken implementation ended the parent. */ }
      throw error;
    } finally { if (!restored) boundary.restore(); }
    assert.deepEqual(f.facts(f.observer), after);
    assert.deepEqual(f.facts(f.open()), after);
    assert.deepEqual(f.observer.getTask(extra.id), extra);
  });
}

for (const phase of ["rollback", "release"]) {
  test(`B006 ${phase} cleanup failure preserves both errors without committing unknown writes`, async t => {
    const f = await fixture(t), before = f.facts(f.observer), boundary = ledgerBoundary(t, f, "after");
    const cleanup = Object.assign(new Error(`B006 owned ${phase} cleanup failure`), { code: "EIO" });
    const originalExec = f.store.database.exec, statements = [];
    const target = phase === "rollback" ? "ROLLBACK TO task_status_transition" : "RELEASE task_status_transition";
    const patch = t.mock.method(f.store.database, "exec", function (sql) {
      const statement = sql.trim();
      statements.push(statement);
      if (statement === target) throw cleanup;
      return originalExec.call(this, sql);
    });
    try {
      let result, error;
      try { result = f.store.transitionTaskStatus(f.input); }
      catch (caught) { error = caught; }
      assert.equal(result, undefined);
      assert.equal(boundary.observations.length, 1);
      assert.equal(boundary.observations[0].wroteLedger, true, "fault must follow the actual Task UPDATE and ledger INSERT");
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [boundary.primary, cleanup]);
      assert.equal(error.cause, boundary.primary);
      assert.deepEqual(f.facts(f.observer), before, "no failure branch may commit partial or unknown state");
      assert.equal(statements.filter(value => value === "ROLLBACK TO task_status_transition").length, 1);
      if (phase === "rollback") {
        assert.equal(statements.filter(value => value === "RELEASE task_status_transition").length, 0,
          "never RELEASE after failed rollback: outermost RELEASE would commit the unknown writes");
        assert.equal(f.facts(f.store).task.status, "claimed", "rollback fault must leave genuine uncommitted changes, not a simulated clean state");
        assert.equal(f.facts(f.store).events.length, 1);
      } else {
        assert.equal(statements.filter(value => value === "RELEASE task_status_transition").length, 1);
        assert.deepEqual(f.facts(f.store), before, "the real successful ROLLBACK TO precedes the failed release");
      }
    } finally {
      patch.mock.restore(); boundary.restore();
      // This test owns the outermost operation. Explicit fixture recovery is
      // not a product cleanup receipt and never adopts someone else's transaction.
      try { originalExec.call(f.store.database, "ROLLBACK"); } catch { /* Preserve any earlier contract assertion if a broken implementation already committed. */ }
    }
    assert.deepEqual(f.facts(f.store), before);
    assert.deepEqual(f.facts(f.observer), before);
    assert.deepEqual(f.facts(f.open()), before);
    const after = assertRetry(f);
    assert.deepEqual(f.facts(f.observer), after);
  });
}
