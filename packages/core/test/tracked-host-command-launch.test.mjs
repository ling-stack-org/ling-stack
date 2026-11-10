import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-tracked-command-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "runtime",
    runnerId: "pi", status: "started", now });
  const fence = toRuntimeAttemptFence(attempt);
  const run = store.createRun({ id: "run", cwd, workUnitId: unit.id, taskId: "task", providerName: "test", providerModel: "test",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now); store.markRunStarted(run.id, now);
  const source = { runId: run.id, ...fence };
  const host = store.admitHostOperation({ operationId: "host-call", source, kind: "command", toolCallId: "call" });
  const command = store.prepareHostCommandExecution({ runId: run.id, sourceFence: fence, toolCallId: "call", cwd,
    command: { kind: "shell", shell: "bash", command: "echo test" } });
  const bind = () => store.bindHostOperationEvidence(host, { kind: "host_command", id: command.executionId });
  const launch = callback => store.launchTrackedHostCommandExecution(host, command, callback);
  return { cwd, store, unit, run, fence, source, host, command, bind, launch };
}

test("tracked command uses one write transaction and exact immutable command binding", async t => {
  const f = await fixture(t); f.bind();
  let calls = 0;
  const result = f.launch(() => {
    calls++;
    assert.equal(f.store.database.isTransaction, true);
    assert.equal(f.store.getHostOperation(f.host.operationId).phase, "launched");
    assert.equal(f.store.getHostOperation(f.host.operationId).evidenceRef.id, f.command.executionId);
    return "spawned";
  });
  assert.equal(result, "spawned");
  assert.equal(calls, 1);
  assert.throws(() => f.launch(() => assert.fail("double spawn")), /already.*launch|launch.*claimed/);
  assert.throws(() => f.store.launchHostCommandExecution(f.command, () => assert.fail("legacy respawn")), /launch.*claimed/);
});

for (const problem of ["missing_binding", "forged_host", "forged_command", "wrong_command"]) {
  test(`tracked ${problem} never enters a spawn callback`, async t => {
    const f = await fixture(t);
    if (problem !== "missing_binding") f.bind();
    const wrongCommand = problem === "wrong_command" ? (() => {
      f.store.settleHostCommandExecution(f.command, { kind: "not_started" });
      return f.store.prepareHostCommandExecution({ runId: f.run.id, sourceFence: f.fence, toolCallId: "other", cwd: f.cwd,
        command: { kind: "shell", shell: "bash", command: "echo other" } });
    })() : f.command;
    assert.throws(() => f.store.launchTrackedHostCommandExecution(
      problem === "forged_host" ? { ...f.host } : f.host,
      problem === "forged_command" ? { ...f.command } : wrongCommand,
      () => assert.fail("invalid identity must not spawn")), error => error.code === (
        problem === "forged_host" ? "host_operation_invalid_ticket" : problem === "forged_command"
          ? "invalid_command_ticket" : "command_tracked_identity_invalid"));
    assert.equal(f.store.getHostOperation(f.host.operationId).phase, "admitted");
  });
}

test("replaced attempt never gains launch authority through either command journal", async t => {
  const f = await fixture(t); f.bind();
  f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2, runtimeInstanceId: "replacement", runnerId: "pi",
    status: "started", now: new Date().toISOString() });
  assert.throws(() => f.launch(() => assert.fail("stale spawn")), /stale.*owner|stale.*execution/);
  assert.equal(f.store.getHostOperation(f.host.operationId).phase, "admitted");
});

for (const failure of ["throw", "thenable", "commit"]) {
  test(`entered command ${failure} cannot be relabeled as Host no-start`, async t => {
    const f = await fixture(t); f.bind();
    const original = f.store.database.exec.bind(f.store.database);
    let entered = false;
    if (failure === "commit") f.store.database.exec = sql => {
      if (sql === "COMMIT") { f.store.database.exec = original; throw new Error("commit fixture"); }
      return original(sql);
    };
    assert.throws(() => f.launch(() => {
      entered = true;
      if (failure === "throw") throw new Error("effect fixture");
      return failure === "thenable" ? Promise.reject(new Error("not safety proof")) : "effect";
    }));
    assert.equal(entered, true);
    assert.equal(f.store.getHostOperation(f.host.operationId).phase, "admitted");
    assert.throws(() => f.store.settleHostOperation(f.host, { kind: "known_no_start" }), /launched.*no.start/);
    assert.throws(() => f.store.launchHostCommandExecution(f.command, () => assert.fail("respawn after rollback")), /launch.*claimed/);
    assert.equal(f.store.settleHostOperation(f.host, { kind: "unknown_outcome", code: "physical_scope_unverified" }).phase,
      "unknown_outcome");
  });
}

test("async command callback is rejected before any launch claim", async t => {
  const f = await fixture(t); f.bind();
  assert.throws(() => f.launch(async () => assert.fail("async launcher")), /synchronous/);
  assert.equal(f.store.getHostOperation(f.host.operationId).phase, "admitted");
  f.store.settleHostCommandExecution(f.command, { kind: "not_started" });
  assert.equal(f.store.settleHostOperation(f.host, { kind: "known_no_start" }).phase, "safe");
});
