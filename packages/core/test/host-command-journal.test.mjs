import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

const now = "2026-09-09T05:00:00.000Z";
const normalClose = { scope: "process_group", leaderExited: true, stdioClosed: true,
  descendants: "unverified", settledBy: "close", signalFailures: [] };
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-command-journal-"));
  const workspace = join(cwd, "workspace");
  await mkdir(join(workspace, "child"), { recursive: true });
  await mkdir(join(cwd, "other"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "original-runtime", runnerId: "pi", status: "started", now });
  const run = store.createRun({ id: "run", cwd: workspace, workUnitId: unit.id, taskId: "task", providerName: "test", providerModel: "test",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now); store.markRunStarted(run.id, now);
  const fence = toRuntimeAttemptFence(attempt);
  const prepare = (call = "call", writer = store, sourceFence = fence) => writer.prepareHostCommandExecution({
    runId: run.id, sourceFence, toolCallId: call, command: { kind: "shell", command: "echo fixture", shell: "bash" }, cwd: workspace });
  const settle = (ticket, observation = normalClose) => store.settleHostCommandExecution(ticket, { kind: "observed", observation });
  const replace = () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
    runtimeInstanceId: "replacement", runnerId: "pi", status: "started", now });
  return { cwd, workspace, store, run, unit, fence, prepare, settle, replace };
}

test("prepare is durable before spawn and excludes a second writer across connections", async t => {
  const f = await fixture(t); const ticket = f.prepare();
  const other = createSqliteRunStore(f.cwd);
  try {
    assert.equal(other.listHostCommandWriteBlockers(f.workspace)[0].executionId, ticket.executionId);
    assert.throws(() => f.prepare("another", other), e => e.code === "command_workspace_busy");
  } finally { other.close(); }
  assert.equal(f.store.listEvents(f.run.id).filter(e => e.type === "host_command_prepared").length, 1);
});
test("overlap includes parent, child and symlink aliases but not isolated workspaces", async t => {
  const f = await fixture(t); f.prepare(); const alias = join(f.cwd, "alias");
  await symlink(f.workspace, alias);
  for (const path of [f.workspace, f.cwd, join(f.workspace, "child"), alias, join(alias, "child")]) {
    assert.equal(f.store.listHostCommandWriteBlockers(path).length, 1, path);
  }
  assert.deepEqual(f.store.listHostCommandWriteBlockers(join(f.cwd, "other")), []);
});
test("normal completion releases command admission without claiming descendants are verified", async t => {
  const f = await fixture(t); const ticket = f.prepare();
  const result = f.settle(ticket);
  assert.equal(result.data.outcome, "completed");
  assert.equal(result.data.observation.descendants, "unverified");
  assert.deepEqual(f.store.listHostCommandWriteBlockers(f.workspace), []);
  assert.ok(f.prepare("next"));
});
for (const stopReason of ["cancelled", "timeout", "output_drain", "observer_error"]) {
  test(`stop risk survives a fresh SQLite connection: ${stopReason}`, async t => {
    const f = await fixture(t); const ticket = f.prepare();
    assert.equal(f.settle(ticket, { ...normalClose, stopReason }).data.outcome, "stop_unconfirmed");
    const reopened = createSqliteRunStore(f.cwd);
    try { assert.equal(reopened.listHostCommandWriteBlockers(f.workspace)[0].state, "stop_unconfirmed"); }
    finally { reopened.close(); }
    assert.throws(() => f.prepare("retry"), e => e.code === "command_workspace_busy");
  });
}
for (const close of ["cancelled", "yielded", "replaced"]) {
  test(`late normal close cannot clear risk after ${close}`, async t => {
    const f = await fixture(t); const ticket = f.prepare();
    if (close === "replaced") f.replace();
    else f.store.database.prepare("UPDATE run_sessions SET status=? WHERE id=?").run(close, f.run.id);
    const result = f.settle(ticket);
    assert.equal(result.data.outcome, "stop_unconfirmed");
    assert.equal(result.data.ownerCurrent, false);
    assert.equal(f.store.listHostCommandWriteBlockers(f.workspace).length, 1);
    assert.equal(f.store.listEvents(f.run.id).at(-1).type, "host_command_settled");
  });
}
test("settlement is first-write idempotent and cannot be forged from a persisted ticket ID", async t => {
  const f = await fixture(t); const ticket = f.prepare();
  assert.throws(() => f.settle({ ...ticket }), e => e.code === "invalid_command_ticket");
  const first = f.settle(ticket, { ...normalClose, stopReason: "cancelled" });
  assert.equal(f.settle(ticket, { ...normalClose, stopReason: "cancelled" }).id, first.id);
  assert.throws(() => f.settle(ticket), e => e.code === "command_settlement_conflict");
  assert.equal(f.store.listHostCommandWriteBlockers(f.workspace).length, 1);
});
test("generic Host or runner event APIs cannot forge journal records", async t => {
  const f = await fixture(t); f.prepare();
  const event = f.store.listEvents(f.run.id).at(-1);
  for (const append of [() => f.store.appendEvent(f.run.id, event.type, event.data),
    () => f.store.appendExecutionEvent(f.run.id, f.fence, event.type, event.data)]) {
    assert.throws(append, e => e.code === "host_command_event_reserved");
  }
});
test("stale source is rejected before creating prepared facts and tool-call replay cannot spawn twice", async t => {
  const f = await fixture(t);
  assert.throws(() => f.prepare("forged", f.store, { ...f.fence, attemptId: "other" }), e => e.code === "stale_run_execution");
  assert.equal(f.store.countEvents(f.run.id), 0);
  const ticket = f.prepare(); f.settle(ticket);
  assert.throws(() => f.prepare(), e => e.code === "command_call_already_prepared");
});
test("synchronous spawn failure releases its reservation; incomplete observations do not", async t => {
  const f = await fixture(t); const first = f.prepare();
  assert.equal(f.store.settleHostCommandExecution(first, { kind: "not_started" }).data.outcome, "not_started");
  const second = f.prepare("second");
  assert.equal(f.settle(second, { ...normalClose, stdioClosed: false, settledBy: "cleanup_deadline" }).data.outcome, "stop_unconfirmed");
});
test("preparation uses immutable Run workspace and rejects command cwd escape", async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: f.fence, toolCallId: "call",
    command: { kind: "shell", command: "echo fixture", shell: "bash" }, cwd: join(f.cwd, "other") }), e => e.code === "command_cwd_out_of_scope");
  assert.equal(f.store.countEvents(f.run.id), 0);
});

test("simultaneous Host writers have exactly one durable winner", async t => {
  const f = await fixture(t);
  const workerSource = `
    import { parentPort, workerData } from "node:worker_threads";
    const { createSqliteRunStore } = await import(workerData.module);
    const store = createSqliteRunStore(workerData.cwd);
    parentPort.once("message", () => {
      try {
        const ticket = store.prepareHostCommandExecution(workerData.input);
        parentPort.postMessage({ outcome: "prepared", executionId: ticket.executionId });
      } catch (error) { parentPort.postMessage({ outcome: error.code }); }
      finally { store.close(); parentPort.close(); }
    });
    parentPort.postMessage({ ready: true });
  `;
  const workers = [0, 1].map(index => new Worker(new URL("data:text/javascript," + encodeURIComponent(workerSource)), {
    workerData: { module: new URL("../dist/index.js", import.meta.url).href, cwd: f.cwd,
      input: { runId: f.run.id, sourceFence: f.fence, toolCallId: "parallel-" + index, cwd: f.workspace,
        command: { kind: "shell", command: "echo fixture", shell: "bash" } } },
  }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.once("message", resolve); worker.once("error", reject);
  })));
  const results = workers.map(worker => new Promise((resolve, reject) => {
    worker.once("message", resolve); worker.once("error", reject);
  }));
  workers.forEach(worker => worker.postMessage("go"));
  assert.deepEqual((await Promise.all(results)).map(result => result.outcome).sort(), ["command_workspace_busy", "prepared"]);
  assert.equal(f.store.countEvents(f.run.id), 1);
});

test("settlement storage failure keeps the prepared risk and rolls back its transaction", async t => {
  const f = await fixture(t); const ticket = f.prepare();
  f.store.database.exec("CREATE TEMP TRIGGER reject_settlement BEFORE INSERT ON run_events WHEN NEW.type='host_command_settled' BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END");
  assert.throws(() => f.settle(ticket), /fixture write failed/);
  assert.equal(f.store.listHostCommandWriteBlockers(f.workspace)[0].state, "prepared");
  f.store.database.exec("DROP TRIGGER reject_settlement");
  assert.equal(f.settle(ticket).data.outcome, "completed");
});

test("corrupt completion is not interpreted as a recovered execution unlock", async t => {
  const f = await fixture(t); f.settle(f.prepare());
  f.store.database.prepare("UPDATE run_events SET data_json=json_set(data_json,'$.ownerCurrent',json('false')) WHERE type='host_command_settled'").run();
  assert.throws(() => f.store.listHostCommandWriteBlockers(f.workspace), e => e.code === "command_journal_corrupt");
});

test("an owner replaced after durable prepare cannot physically launch", async t => {
  const f = await fixture(t); const ticket = f.prepare(); f.replace();
  let launched = false;
  assert.throws(() => f.store.launchHostCommandExecution(ticket, () => { launched = true; }), e => e.code === "stale_run_execution");
  assert.equal(launched, false);
  assert.equal(f.store.listHostCommandWriteBlockers(f.workspace).length, 1);
});
test("a Host launch ticket is single-use even when the launcher throws", async t => {
  const f = await fixture(t); const ticket = f.prepare();
  assert.throws(() => f.store.launchHostCommandExecution(ticket, () => { throw new Error("spawn fixture"); }), /spawn fixture/);
  assert.throws(() => f.store.launchHostCommandExecution(ticket, () => assert.fail("must not respawn")), e => e.code === "command_launch_already_claimed");
  assert.equal(f.store.settleHostCommandExecution(ticket, { kind: "not_started" }).data.outcome, "not_started");
});
