import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveSessionRunPolicy } from "../../core/dist/index.js";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { executeHarnessedFileMutationTool } from "../dist/features/harness/tool-execution/broker.js";
import { createFileMutationActionDraft } from "../dist/features/harness/tool-execution/executors/file-mutation.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

const required = Object.freeze({ kind: "user_input_required", requestId: "pause", requestVersion: 1 });
async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-host-operation-tracker-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "tracker-task", title: "Tracked mutation", prompt: "Write isolated files" };
  const f = createUnifiedExecFixture(t, cwd, task, "tracker-run");
  const source = { runId: f.run.id, ...f.sourceFence };
  const tracker = new AttemptHostOperationTracker({ store: f.store, source });
  const effectivePolicySnapshot = resolveSessionRunPolicy({ workspacePolicy: f.store.getApprovalPolicy(),
    authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot;
  function request(input = { path: "result.txt", content: "tracked result\n" }, toolCallId = "write_1") {
    return { toolCallId, toolName: "write", cwd, task, input };
  }
  async function execute(request, hostOperation) {
    return executeHarnessedFileMutationTool({ mode: "enforce", store: f.store, sourceFence: f.sourceFence,
      run: f.run, request, draft: createFileMutationActionDraft({ request, allowedWritePaths: [cwd] }),
      allowedWritePaths: [cwd], effectivePolicySnapshot, hostOperation,
      appendAndMaybeStream: (type, data) => f.store.appendExecutionEvent(f.run.id, f.sourceFence, type, data) });
  }
  const replace = () => f.store.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "successor", runnerId: "pi", status: "started", now: new Date().toISOString() });
  return { ...f, cwd, task, source, tracker, group: tracker.executorGroup, request, execute, replace };
}

test("begin reserves and durably admits an exact immutable operation before returning", async t => {
  const f = await fixture(t);
  const operation = f.tracker.beginHostCall("hydration", "call_1");
  const row = f.store.getHostOperation(operation.operationId);
  assert.equal(Object.isFrozen(operation), true);
  assert.deepEqual(operation.source, f.source);
  assert.equal(row.phase, "admitted");
  assert.equal(row.operationId, f.group.getSnapshot().operations[0].ticket.id);
  const reopened = createSqliteRunStore(f.cwd);
  try { assert.deepEqual(reopened.getHostOperation(operation.operationId), row); }
  finally { reopened.close(); }
});

test("caller callbacks cannot replace the tracker-owned settlement verifier", async t => {
  const f = await fixture(t);
  assert.throws(() => new AttemptHostOperationTracker({ store: f.store, source: f.source, verifySettlement: () => true }),
    /host.*hook|constructor.*option/i);
});

test("opaque handles reject clones, structural forgery and handles from another tracker", async t => {
  const f = await fixture(t);
  const operation = f.tracker.beginHostCall("command", "call_1");
  const other = new AttemptHostOperationTracker({ store: f.store, source: f.source });
  const sibling = other.beginHostCall("command", "call_2");
  for (const invalid of [{ ...operation }, Object.create(operation), sibling, undefined]) {
    assert.throws(() => f.tracker.launchHostEffect(invalid, () => assert.fail("forged launch")), /invalid.*handle/i);
    assert.throws(() => f.tracker.settleNoStart(invalid), /invalid.*handle/i);
    assert.throws(() => f.tracker.fileMutationOperation(invalid), /invalid.*handle/i);
  }
});

test("admission persistence failure leaves a pending barrier and cannot launch anything", async t => {
  const f = await fixture(t);
  const original = f.store.admitHostOperation;
  f.store.admitHostOperation = () => { throw new Error("database unavailable"); };
  try { assert.throws(() => f.tracker.beginHostCall("command", "call_1"), /database unavailable/); }
  finally { f.store.admitHostOperation = original; }
  assert.equal(f.group.getSnapshot().operations.length, 1);
  f.group.closeAdmission(required);
  assert.equal((await f.group.observeDrain(0)).status, "blocked");
});

test("producer is linked to its actual parent and requires child-first safe settlement", async t => {
  const f = await fixture(t);
  const parent = f.tracker.beginHostCall("media", "media_call");
  const child = f.tracker.registerProducer(parent, "media", "actual_job");
  const row = f.store.getHostOperation(child.operationId);
  assert.equal(row.parentOperationId, parent.operationId);
  assert.equal(row.producerId, "actual_job");
  f.group.closeAdmission(required);
  assert.throws(() => f.tracker.registerProducer(parent, "media", "late_job"), /admission.*closed/i);
  f.tracker.settleNoStart(child);
  assert.equal((await f.group.observeDrain(0)).blockers[0].operationId, parent.operationId);
  f.tracker.settleNoStart(parent);
  assert.equal((await f.group.drain()).status, "settled");
});

test("no-start must be independently true in both group and Core before safe settlement", async t => {
  const f = await fixture(t);
  const operation = f.tracker.beginHostCall("command", "never_launched");
  assert.throws(() => f.tracker.settleFromStore(operation), /settlement.*unconfirmed/i);
  f.group.closeAdmission(required);
  const record = f.tracker.settleNoStart(operation);
  assert.equal(record.phase, "safe");
  assert.equal(record.settlementKind, "known_no_start");
  const drain = await f.group.drain();
  assert.equal(drain.status, "settled");
  assert.equal(drain.operations[0].settlement.kind, "known_no_start");
  assert.deepEqual(f.tracker.settleFromStore(operation), record);
});

test("first effect enters journal launch synchronously and never launches twice", async t => {
  const f = await fixture(t);
  const operation = f.tracker.beginHostCall("command", "command_1");
  let effects = 0;
  const value = f.tracker.launchHostEffect(operation, () => { effects++; return "launched"; });
  assert.equal(value, "launched");
  assert.equal(f.store.getHostOperation(operation.operationId).phase, "launched");
  assert.throws(() => f.tracker.launchHostEffect(operation, () => { effects++; }), /already.*launch|phase/i);
  assert.throws(() => f.tracker.settleNoStart(operation), /launch.*no.start|no.start.*launch/i);
  assert.equal(effects, 1);
});

test("launch denied after await/close cannot produce an effect or journal launch", async t => {
  const f = await fixture(t);
  const operation = f.tracker.beginHostCall("command", "prepared");
  await Promise.resolve(); f.group.closeAdmission(required);
  assert.throws(() => f.tracker.launchHostEffect(operation, () => assert.fail("closed launch")), /admission.*closed/i);
  assert.equal(f.store.getHostOperation(operation.operationId).phase, "admitted");
  f.tracker.settleNoStart(operation);
  assert.equal((await f.group.drain()).status, "settled");
});

test("launch and subsequent effects never borrow successor authority", async t => {
  for (const firstLaunched of [false, true]) {
    const f = await fixture(t);
    const operation = f.tracker.beginHostCall("file_mutation", `mutation_${firstLaunched}`);
    if (firstLaunched) f.tracker.launchHostEffect(operation, () => {});
    f.replace();
    const effect = () => assert.fail("stale effect must not run");
    assert.throws(() => firstLaunched ? f.tracker.continueHostEffect(operation, effect) : f.tracker.launchHostEffect(operation, effect));
    if (firstLaunched) assert.throws(() => f.tracker.continueHostEffect(operation, effect, "cleanup"));
  }
});

test("return, rejection and thrown observer errors cannot fabricate a safe command fact", async t => {
  const f = await fixture(t);
  for (const [id, effect] of [["return", () => 0], ["reject", () => Promise.reject(new Error("late callback"))],
    ["throw", () => { throw new Error("observer failed"); }]]) {
    const operation = f.tracker.beginHostCall("command", id);
    try { await f.tracker.launchHostEffect(operation, effect); } catch {}
    assert.throws(() => f.tracker.settleFromStore(operation), /settlement.*unconfirmed/i);
  }
  f.group.closeAdmission(required);
  assert.equal((await f.group.observeDrain(0)).blockers.length, 3);
});

test("cleanup is only for an already-launched unsettled operation and does not manufacture settlement", async t => {
  const f = await fixture(t);
  const operation = f.tracker.beginHostCall("file_mutation", "mutation_1");
  assert.throws(() => f.tracker.continueHostEffect(operation, () => assert.fail("no launch"), "cleanup"));
  f.tracker.launchHostEffect(operation, () => {});
  f.group.closeAdmission(required);
  let cleaned = false;
  f.tracker.continueHostEffect(operation, () => { cleaned = true; }, "cleanup");
  assert.equal(cleaned, true);
  assert.equal(f.store.getHostOperation(operation.operationId).phase, "launched");
  assert.equal((await f.group.observeDrain(0)).status, "blocked");
  assert.throws(() => f.tracker.continueHostEffect(operation, () => assert.fail("forward still closed")));
});

test("exact file Broker plus real filesystem facts safely settle through tracker and SQLite", async t => {
  const f = await fixture(t);
  const request = f.request();
  const operation = f.tracker.beginHostCall("file_mutation", request.toolCallId);
  const result = await f.execute(request, f.tracker.fileMutationOperation(operation));
  assert.notEqual(result.isError, true);
  assert.equal(readFileSync(join(f.cwd, "result.txt"), "utf8"), "tracked result\n");
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  const record = f.tracker.settleFileFromStore(operation);
  assert.deepEqual(record.evidenceRef, { kind: "harness_tool_execution", id: execution.id });
  assert.equal(record.phase, "safe");
  assert.equal(record.settlementKind, "file_completed");
  f.group.closeAdmission(required);
  const drain = await f.group.drain();
  assert.equal(drain.status, "settled");
  assert.equal(drain.operations[0].settlement.kind, "completed_persisted");
  assert.equal(drain.operations[0].settlement.physicalScope, "entire_operation");
});

test("multi-file forward effects reuse one operation while every write rechecks the guard", async t => {
  const f = await fixture(t);
  const request = f.request({ patch: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch" });
  const operation = f.tracker.beginHostCall("file_mutation", request.toolCallId);
  await f.execute(request, f.tracker.fileMutationOperation(operation));
  assert.equal(readFileSync(join(f.cwd, "first.txt"), "utf8"), "first\n");
  assert.equal(readFileSync(join(f.cwd, "second.txt"), "utf8"), "second\n");
  assert.equal(f.store.getHostOperation(operation.operationId).phase, "launched");
  f.tracker.settleFileFromStore(operation);
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).operations.length, 1);
});

test("close between writes blocks forward effects but permits bounded same-source rollback", async t => {
  const f = await fixture(t);
  const request = f.request({ patch: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch" });
  const operation = f.tracker.beginHostCall("file_mutation", request.toolCallId);
  const host = f.tracker.fileMutationOperation(operation);
  let launches = 0, cleanups = 0;
  const result = await f.execute(request, { ...host, effectGuard: {
    launch(effect) { const value = host.effectGuard.launch(effect); if (++launches === 1) f.group.closeAdmission(required); return value; },
    cleanup(effect) { cleanups++; return host.effectGuard.cleanup(effect); } } });
  assert.equal(result.isError, true);
  assert.equal(launches, 1);
  assert.equal(cleanups, 1);
  assert.equal(existsSync(join(f.cwd, "first.txt")), false);
  assert.equal(existsSync(join(f.cwd, "second.txt")), false);
  assert.equal(f.store.listHarnessToolExecutions(f.run.id)[0].resultSummary.outcome, "rolled_back");
  f.tracker.settleFileFromStore(operation);
  assert.equal((await f.group.drain()).status, "settled");
});

test("file settlement requires an exact immutable Broker binding, not a toolCallId lookup", async t => {
  const f = await fixture(t);
  const unbound = f.tracker.beginHostCall("file_mutation", "same_call");
  f.tracker.launchHostEffect(unbound, () => {});
  assert.throws(() => f.tracker.settleFileFromStore(unbound));
  const request = f.request(undefined, "actual_bound_call");
  const bound = f.tracker.beginHostCall("file_mutation", request.toolCallId);
  await f.execute(request, f.tracker.fileMutationOperation(bound));
  const record = f.tracker.settleFileFromStore(bound);
  assert.throws(() => f.tracker.bindEvidence(bound, { kind: "harness_tool_execution", id: "different_execution" }));
  assert.equal(record.evidenceRef.kind, "harness_tool_execution");
  f.group.closeAdmission(required);
  assert.equal((await f.group.observeDrain(0)).blockers[0].operationId, unbound.operationId);
});

test("unknown is durable, immutable and remains a blocker after reopening SQLite", async t => {
  const f = await fixture(t);
  const operation = f.tracker.beginHostCall("mcp", "remote_call");
  f.tracker.launchHostEffect(operation, () => {});
  f.tracker.markUnknown(operation, "remote_stop_unconfirmed");
  f.group.closeAdmission(required);
  const blocked = await f.group.drain();
  assert.equal(blocked.reason, "unknown_outcome");
  assert.equal(blocked.blockers[0].durablyRecorded, true);
  const reopened = createSqliteRunStore(f.cwd);
  try { assert.equal(reopened.getHostOperation(operation.operationId).phase, "unknown_outcome"); }
  finally { reopened.close(); }
  f.tracker.markUnknown(operation, "remote_stop_unconfirmed");
  assert.throws(() => f.tracker.markUnknown(operation, "different_code"));
  assert.throws(() => f.tracker.settleNoStart(operation));
  assert.throws(() => f.tracker.settleFileFromStore(operation));
});

test("unknown write failure still blocks the in-memory barrier and exact retry can persist it", async t => {
  const f = await fixture(t);
  const operation = f.tracker.beginHostCall("media", "background_call");
  const original = f.store.settleHostOperation.bind(f.store);
  f.store.settleHostOperation = () => { throw new Error("database unavailable"); };
  try { assert.throws(() => f.tracker.markUnknown(operation, "producer_stop_unconfirmed"), /database unavailable|blocked.*persistence/i); }
  finally { f.store.settleHostOperation = original; }
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).blockers[0].durablyRecorded, false);
  f.tracker.markUnknown(operation, "producer_stop_unconfirmed");
  assert.equal((await f.group.drain()).blockers[0].durablyRecorded, true);
});

test("unknown read failure latches the exact blocker before durable retry", async t => {
  const f = await fixture(t);
  const operation = f.tracker.beginHostCall("media", "read_failure_call");
  const original = f.store.getHostOperation;
  let failReads = true;
  f.store.getHostOperation = (...args) => {
    if (failReads) throw new Error("database read unavailable");
    return original.call(f.store, ...args);
  };
  try {
    assert.throws(() => f.tracker.markUnknown(operation, "read_stop_unconfirmed"), /database read unavailable|blocked.*persistence/i);
    assert.equal(f.group.getSnapshot().operations[0].state, "blocked");
  } finally {
    failReads = false;
    f.store.getHostOperation = original;
  }
  const record = f.tracker.markUnknown(operation, "read_stop_unconfirmed");
  assert.equal(record.phase, "unknown_outcome");
  f.group.closeAdmission(required);
  const blocked = await f.group.drain();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockers[0].durablyRecorded, true);
});

test("direct group safe-proof attempts are rejected without a verified Core operation settlement", async t => {
  const f = await fixture(t);
  const operation = f.tracker.beginHostCall("command", "call_1");
  const ticket = f.group.getSnapshot().operations[0].ticket;
  assert.throws(() => f.group.settleHostCall(ticket, { schemaVersion: 1, source: f.source, operationId: operation.operationId,
    evidenceRef: "fake_evidence", settledAt: new Date().toISOString(), kind: "known_no_start" }), /unverified.*settlement/i);
  f.group.closeAdmission(required);
  assert.equal((await f.group.observeDrain(0)).status, "blocked");
});
