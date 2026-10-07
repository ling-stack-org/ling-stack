import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { executeUnifiedBashTool } from "../dist/features/runs/unified-exec.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

const required = { kind: "user_input_required", requestId: "pause", requestVersion: 1 };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-command-operation-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "command-task", title: "Tracked command", prompt: "Isolated native command" };
  const f = createUnifiedExecFixture(t, cwd, task, "command-run");
  const source = { runId: f.run.id, ...f.sourceFence };
  const tracker = new AttemptHostOperationTracker({ store: f.store, source });
  const group = tracker.executorGroup;
  function reserve(id = "command-call") {
    const handle = tracker.beginHostCall("command", id);
    return { handle, hostOperation: tracker.commandOperation(handle) };
  }
  function execute(input = {}, extra = {}, id = "command-call") {
    return executeUnifiedBashTool({ store: f.store, run: f.run, sourceFence: f.sourceFence,
      request: { toolName: "bash", toolCallId: id, cwd, task, input: { command: "printf isolated", timeoutMs: 3000, ...input } },
      appendAndMaybeStream: (type, data) => f.store.appendExecutionEvent(f.run.id, f.sourceFence, type, data), ...extra });
  }
  const replace = () => f.store.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "replacement", runnerId: "pi", status: "started", now: new Date().toISOString() });
  return { ...f, cwd, task, source, tracker, group, reserve, execute, replace };
}

test("real command result remains succeeded while exact Host operation cannot claim physical drain", async t => {
  const f = await fixture(t), operation = f.reserve();
  const target = join(f.cwd, "actual.txt");
  const result = await f.execute({ command: `printf actual > ${quote(target)}` }, { hostOperation: operation.hostOperation });
  assert.equal(result.isError, false);
  assert.equal(result.details.unifiedExec.status, "succeeded");
  assert.equal(readFileSync(target, "utf8"), "actual");
  const prepared = f.store.listEvents(f.run.id).find(event => event.type === "host_command_prepared");
  const commandFact = f.store.listEvents(f.run.id).find(event => event.type === "host_command_settled");
  const row = f.store.getHostOperation(operation.handle.operationId);
  assert.deepEqual(row.evidenceRef, { kind: "host_command", id: prepared.data.executionId });
  assert.equal(commandFact.data.outcome, "completed");
  assert.equal(commandFact.data.observation.descendants, "unverified");
  assert.equal(row.phase, "unknown_outcome");
  assert.equal(row.code, "command_physical_scope_unverified");
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).status, "blocked");
  const reopened = createSqliteRunStore(f.cwd);
  try { assert.equal(reopened.listHostOperationBlockers(f.source)[0].phase, "unknown_outcome"); }
  finally { reopened.close(); }
});

test("unknown physical drain does not rewrite ordinary completed command admission semantics", async t => {
  const f = await fixture(t), first = f.reserve();
  await f.execute({}, { hostOperation: first.hostOperation });
  const second = f.reserve("second-call");
  const result = await f.execute({}, { hostOperation: second.hostOperation }, "second-call");
  assert.equal(result.details.unifiedExec.status, "succeeded");
  assert.equal(f.store.listHostOperationBlockers(f.source).length, 2);
  assert.deepEqual(f.store.listHostCommandWriteBlockers(f.cwd), []);
});

for (const kind of ["invalid_command", "pre_cancelled"]) {
  test(`${kind} safely releases a truly unstarted command reservation`, async t => {
    const f = await fixture(t), operation = f.reserve();
    if (kind === "invalid_command") {
      assert.equal((await f.execute({ command: "" }, { hostOperation: operation.hostOperation })).isError, true);
    } else {
      await assert.rejects(f.execute({}, { hostOperation: operation.hostOperation, signal: AbortSignal.abort() }), { name: "AbortError" });
    }
    assert.equal(f.store.getHostOperation(operation.handle.operationId).settlementKind, "known_no_start");
    assert.equal(f.store.listEvents(f.run.id).filter(event => event.type === "host_command_prepared").length, 0);
    f.group.closeAdmission(required);
    assert.equal((await f.group.drain()).status, "settled");
  });
}

test("required input after exact preparation prevents actual spawn and has durable no-start", async t => {
  const f = await fixture(t), operation = f.reserve();
  const target = join(f.cwd, "must-not-exist.txt");
  const result = await f.execute({ command: `printf forbidden > ${quote(target)}` }, { hostOperation: {
    ...operation.hostOperation, bindCommandExecution(id) { operation.hostOperation.bindCommandExecution(id); f.group.closeAdmission(required); },
  } });
  assert.equal(result.isError, true);
  assert.equal(existsSync(target), false);
  assert.equal(f.store.listEvents(f.run.id).find(event => event.type === "host_command_settled").data.outcome, "not_started");
  assert.equal(f.store.getHostOperation(operation.handle.operationId).settlementKind, "known_no_start");
  assert.equal((await f.group.drain()).status, "settled");
});

test("a replaced attempt after exact bind cannot spawn or borrow new owner safety", async t => {
  const f = await fixture(t), operation = f.reserve();
  const target = join(f.cwd, "must-not-exist.txt");
  await assert.rejects(f.execute({ command: `printf forbidden > ${quote(target)}` }, { hostOperation: {
    ...operation.hostOperation, bindCommandExecution(id) { operation.hostOperation.bindCommandExecution(id); f.replace(); },
  } }));
  assert.equal(existsSync(target), false);
  assert.equal(f.store.getHostOperation(operation.handle.operationId).phase, "unknown_outcome");
  assert.equal(f.store.listEvents(f.run.id).find(event => event.type === "host_command_settled").data.outcome, "stop_unconfirmed");
});

test("a COMMIT failure after actual spawn keeps its exact process and unknown operation", async t => {
  const f = await fixture(t), operation = f.reserve();
  const result = await f.execute({ command: `${quote(process.execPath)} -e 'setTimeout(() => {}, 1000)'` }, { hostOperation: {
    ...operation.hostOperation, launch(ticket, effect) {
      return operation.hostOperation.launch(ticket, () => {
        const value = effect();
        const original = f.store.database.exec.bind(f.store.database);
        f.store.database.exec = sql => {
          if (sql === "COMMIT") { f.store.database.exec = original; throw new Error("after-spawn commit fixture"); }
          return original(sql);
        };
        return value;
      });
    },
  } });
  assert.equal(result.isError, true);
  assert.equal(result.details.unifiedExec.processObservation.stopReason, "observer_error");
  assert.equal(f.store.getHostOperation(operation.handle.operationId).phase, "unknown_outcome");
  assert.equal(f.store.listEvents(f.run.id).find(event => event.type === "host_command_settled").data.outcome, "stop_unconfirmed");
});

test("unknown persistence failure remains blocked in memory and exact retry restores durability", async t => {
  const f = await fixture(t), operation = f.reserve();
  f.store.database.exec(`CREATE TEMP TRIGGER reject_unknown BEFORE UPDATE ON host_operations
    WHEN NEW.phase='unknown_outcome' BEGIN SELECT RAISE(ABORT,'unknown write fixture'); END`);
  await assert.rejects(f.execute({}, { hostOperation: operation.hostOperation }), /unknown write fixture/);
  assert.equal(f.group.getSnapshot().operations[0].state, "blocked");
  assert.equal(f.store.getHostOperation(operation.handle.operationId).phase, "launched");
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).blockers[0].durablyRecorded, false);
  f.store.database.exec("DROP TRIGGER reject_unknown");
  operation.hostOperation.markUnknown("command_physical_scope_unverified");
  assert.equal((await f.group.drain()).blockers[0].durablyRecorded, true);
});

test("native preparation producers are enrolled before effects and never hidden by main no-start", async t => {
  const f = await fixture(t), operation = f.reserve();
  const preparation = operation.hostOperation.registerPreparation("native-copy");
  const rows = f.store.listHostOperationBlockers(f.source);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].parentOperationId ?? rows[0].parentOperationId, operation.handle.operationId);
  const target = join(f.cwd, "copied.txt");
  preparation.effectGuard.launch(() => writeFileSync(target, "native preparation effect"));
  f.group.closeAdmission(required);
  assert.throws(() => preparation.effectGuard.launch(() => writeFileSync(target, "late forbidden")), /admission.*closed/);
  preparation.effectGuard.cleanup(() => writeFileSync(target, "bounded cleanup"));
  preparation.finish();
  assert.equal(readFileSync(target, "utf8"), "bounded cleanup");
  assert.throws(() => operation.hostOperation.settleNoStart(), /evidence.*invalid/);
  operation.hostOperation.markUnknown("command_physical_scope_unverified");
  const blocked = await f.group.drain();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockers.length, 2);
  assert.ok(blocked.blockers.every(blocker => blocker.durablyRecorded));
});

test("never-entered native producer plus never-started main command can drain safely", async t => {
  const f = await fixture(t), operation = f.reserve();
  const preparation = operation.hostOperation.registerPreparation("native-unstarted");
  f.group.closeAdmission(required);
  assert.throws(() => preparation.effectGuard.launch(() => assert.fail("closed helper spawn")), /admission.*closed/);
  preparation.finish();
  operation.hostOperation.settleNoStart();
  assert.equal((await f.group.drain()).status, "settled");
});

test("async native preparation effect is refused before its body or deferred mutation", async t => {
  const f = await fixture(t), operation = f.reserve();
  const preparation = operation.hostOperation.registerPreparation("native-async-refusal");
  let effects = 0;
  assert.throws(() => preparation.effectGuard.launch(async () => {
    effects++;
    await Promise.resolve();
    effects++;
  }), /synchronous/);
  await Promise.resolve();
  assert.equal(effects, 0);
  preparation.finish(); operation.hostOperation.settleNoStart();
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).status, "settled");
});
