import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveSessionRunPolicy } from "../../core/dist/index.js";
import { createRunApprovalHandler } from "../dist/features/runs/approvals.js";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

const pause = Object.freeze({ kind: "user_input_required", requestId: "pause-file", requestVersion: 1 });

async function fixture(t, { decision = "allow", mode = "enforce" } = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-file-admission-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "file-admission-task", title: "File admission", prompt: "Write isolated files" };
  const f = createUnifiedExecFixture(t, cwd, task, "file-admission-run");
  const approvalPolicy = f.store.updateApprovalPolicy({
    toolDecisions: { write: decision, edit: decision, bash: decision }, allowedWritePaths: [cwd],
  }, new Date().toISOString());
  const effectivePolicySnapshot = resolveSessionRunPolicy({ workspacePolicy: approvalPolicy,
    authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot;
  const run = { ...f.run, requestSnapshot: { harnessFeatureSnapshot: { toolBroker: mode }, effectivePolicySnapshot } };
  const source = { runId: run.id, ...f.sourceFence };
  const tracker = new AttemptHostOperationTracker({ store: f.store, source });
  const controller = new AbortController();
  t.after(() => controller.abort());
  let onApproval;
  const handler = createRunApprovalHandler({ store: f.store, run, sourceFence: f.sourceFence,
    workUnitId: run.workUnitId, attemptId: f.sourceFence.attemptId, hostOperationTracker: tracker,
    approvalPolicy, effectivePolicySnapshot, signal: controller.signal, unifiedExecEnabled: true,
    appendAndMaybeStream(type, data) {
      const event = f.store.appendExecutionEvent(run.id, f.sourceFence, type, data);
      if (type === "approval_requested") onApproval?.(data.approvalId);
      return event;
    }, streamEnvelope() {},
  });
  const group = tracker.executorGroup;
  const request = (input = { path: "result.txt", content: "admitted result\n" }, toolCallId = "write-1", toolName = "write") =>
    ({ toolName, toolCallId, input, cwd, task });
  const record = (index = 0) => f.store.getHostOperation(group.getSnapshot().operations[index].ticket.id);
  const waitForApproval = (request) => {
    let resolveApproval;
    const created = new Promise(resolve => { resolveApproval = resolve; });
    onApproval = resolveApproval;
    const pending = handler(request);
    pending.catch(() => undefined);
    return { pending, created: Promise.race([created, pending.then(() => { throw new Error("Expected approval wait"); })]) };
  };
  return { ...f, cwd, run, source, tracker, group, handler, request, record, waitForApproval };
}

test("file callback synchronously reserves the captured operation before the approval queue's first await", async t => {
  const f = await fixture(t);
  const pending = f.handler(f.request());
  try {
    assert.equal(f.group.getSnapshot().operations.length, 1);
    assert.equal(f.record().phase, "admitted");
    assert.deepEqual(f.record().source, f.source);
    assert.equal(existsSync(join(f.cwd, "result.txt")), false);
  } finally { await pending.catch(() => undefined); }
});

test("automatic allow settles only the exact durable Broker receipt after the real guarded write", async t => {
  const f = await fixture(t);
  const result = await f.handler(f.request());
  assert.equal(result.approved, true);
  assert.equal(result.handledResult.isError, undefined);
  assert.equal(readFileSync(join(f.cwd, "result.txt"), "utf8"), "admitted result\n");
  const record = f.record();
  const execution = f.store.getHarnessToolExecution(record.evidenceRef.id);
  assert.equal(record.phase, "safe");
  assert.equal(record.settlementKind, "file_completed");
  assert.equal(record.evidenceRef.kind, "harness_tool_execution");
  assert.equal(execution.state, "succeeded");
  assert.equal(execution.toolCallId, "write-1");
  assert.equal(execution.attemptId, f.source.attemptId);
  f.group.closeAdmission(pause);
  assert.equal((await f.group.drain()).status, "settled");
});

test("native edit binds its actual write executor identity and settles the exact receipt", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.cwd, "result.txt"), "before\n", "utf8");
  const result = await f.handler(f.request({ path: "result.txt", oldText: "before", newText: "after" }, "native-edit", "edit"));
  assert.equal(result.handledResult.isError, undefined);
  assert.equal(readFileSync(join(f.cwd, "result.txt"), "utf8"), "after\n");
  assert.equal(f.record().settlementKind, "file_completed");
  const execution = f.store.getHarnessToolExecution(f.record().evidenceRef.id);
  assert.equal(execution.toolName, "edit");
  assert.equal(execution.executorKind, "write");
  assert.equal(execution.toolCallId, "native-edit");
});

test("human approval retains the operation admitted before waiting and uses its same exact receipt", async t => {
  const f = await fixture(t, { decision: "ask" });
  const wait = f.waitForApproval(f.request());
  const approvalId = await wait.created;
  assert.equal(f.record().phase, "admitted");
  assert.equal(existsSync(join(f.cwd, "result.txt")), false);
  const operationId = f.record().operationId;
  f.store.approveApprovalRequest(approvalId, { reason: "Isolated file test" }, new Date().toISOString());
  const result = await wait.pending;
  assert.equal(result.handledResult.isError, undefined);
  assert.equal(f.record().operationId, operationId);
  assert.equal(f.record().settlementKind, "file_completed");
  assert.equal(f.store.getHarnessToolExecution(f.record().evidenceRef.id).approvalId, approvalId);
  assert.equal(readFileSync(join(f.cwd, "result.txt"), "utf8"), "admitted result\n");
});

for (const scenario of ["denied", "invalid"]) {
  test(`${scenario} file request is settled known-no-start without borrowing a tool result as proof`, async t => {
    const f = await fixture(t, { decision: scenario === "denied" ? "deny" : "allow" });
    const result = await f.handler(f.request(scenario === "invalid" ? { content: "missing path" } : undefined));
    assert.equal(result.approved, false);
    assert.equal(f.record().phase, "safe");
    assert.equal(f.record().settlementKind, "known_no_start");
    assert.equal(f.record().launchedAt, undefined);
    assert.equal(existsSync(join(f.cwd, "result.txt")), false);
  });
}

test("queued calls are already enrolled when admission closes and cannot write after their await", async t => {
  const f = await fixture(t);
  const first = f.handler(f.request(undefined, "queued-1"));
  const second = f.handler(f.request({ path: "second.txt", content: "second" }, "queued-2"));
  first.catch(() => undefined); second.catch(() => undefined);
  try {
    assert.equal(f.group.getSnapshot().operations.length, 2);
    f.group.closeAdmission(pause);
    await Promise.all([assert.rejects(first, /admission.*closed/i), assert.rejects(second, /admission.*closed/i)]);
    assert.equal(f.record(0).settlementKind, "known_no_start");
    assert.equal(f.record(1).settlementKind, "known_no_start");
    assert.equal((await f.group.drain()).status, "settled");
    assert.equal(existsSync(join(f.cwd, "result.txt")), false);
    assert.equal(existsSync(join(f.cwd, "second.txt")), false);
  } finally { await Promise.allSettled([first, second]); }
});

test("a new callback after close is rejected synchronously without creating a late member or file", async t => {
  const f = await fixture(t);
  f.group.closeAdmission(pause);
  assert.throws(() => f.handler(f.request()), /admission.*closed/i);
  assert.equal(f.group.getSnapshot().operations.length, 0);
  assert.equal(existsSync(join(f.cwd, "result.txt")), false);
});

test("required input arriving during approval wait closes the already-enrolled file operation before effects", async t => {
  const f = await fixture(t, { decision: "ask" });
  const wait = f.waitForApproval(f.request());
  const approvalId = await wait.created;
  const operationId = f.record().operationId;
  assert.equal(f.record().phase, "admitted");
  f.group.closeAdmission(pause);
  f.store.approveApprovalRequest(approvalId, { reason: "Approval does not reopen paused admission" }, new Date().toISOString());
  await assert.rejects(wait.pending, /admission.*closed/i);
  assert.equal(f.record().operationId, operationId);
  assert.equal(f.record().settlementKind, "known_no_start");
  assert.equal(existsSync(join(f.cwd, "result.txt")), false);
  assert.equal((await f.group.drain()).status, "settled");
});

test("approval cannot borrow a successor Attempt; stale settlement remains an explicit unknown blocker", async t => {
  const f = await fixture(t, { decision: "ask" });
  const wait = f.waitForApproval(f.request());
  const approvalId = await wait.created;
  f.store.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "successor", runnerId: "pi", status: "started", now: new Date().toISOString() });
  f.store.approveApprovalRequest(approvalId, { reason: "Does not extend source authority" }, new Date().toISOString());
  await assert.rejects(wait.pending, /stale|owner|attempt/i);
  assert.equal(f.record().phase, "unknown_outcome");
  assert.deepEqual(f.record().source, f.source);
  assert.equal(f.group.getSnapshot().operations[0].state, "blocked");
  assert.equal(existsSync(join(f.cwd, "result.txt")), false);
});

test("physical write followed by durable receipt failure cannot be relabelled known-no-start or safe", async t => {
  const f = await fixture(t);
  const finish = f.store.finishHarnessToolExecution;
  f.store.finishHarnessToolExecution = () => { throw new Error("injected file receipt failure"); };
  try { await assert.rejects(f.handler(f.request()), /injected file receipt failure/u); }
  finally { f.store.finishHarnessToolExecution = finish; }
  assert.equal(readFileSync(join(f.cwd, "result.txt"), "utf8"), "admitted result\n");
  assert.equal(f.record().phase, "unknown_outcome");
  assert.equal(f.record().code, "file_mutation_execution_unconfirmed");
  assert.equal(f.group.getSnapshot().operations[0].state, "blocked");
});

test("a thrown observer after real effect entry cannot turn a rolled-back admitted journal row into no-start", async t => {
  const f = await fixture(t);
  const launch = f.store.launchHostOperation;
  let effects = 0;
  f.store.launchHostOperation = (ticket, effect) => launch.call(f.store, ticket, () => {
    effect();
    effects++;
    throw new Error("observer failure after physical write");
  });
  try { await assert.rejects(f.handler(f.request()), /launch.*unknown|evidence.*invalid|settlement.*unconfirmed/i); }
  finally { f.store.launchHostOperation = launch; }
  assert.equal(effects, 1);
  assert.equal(f.record().launchedAt, undefined, "the transaction rolled back, not the historical physical effect");
  assert.equal(f.record().phase, "unknown_outcome");
  assert.equal(f.record().code, "file_mutation_execution_unconfirmed");
  assert.equal(f.group.getSnapshot().operations[0].state, "blocked");
  assert.equal(existsSync(join(f.cwd, "result.txt")), false, "same-operation cleanup restored the initial filesystem");
});

test("tracked file Broker mode off refuses physical effects instead of bypassing exact receipt requirements", async t => {
  const f = await fixture(t, { mode: "off" });
  const result = await f.handler(f.request());
  assert.equal(result.handledResult.isError, true);
  assert.match(result.handledResult.content[0].text, /host_file_broker_evidence_required/u);
  assert.equal(existsSync(join(f.cwd, "result.txt")), false);
  assert.equal(f.record().settlementKind, "known_no_start");
});

test("tracked shadow preparation failure never falls back to an unbound filesystem write", async t => {
  const f = await fixture(t, { mode: "shadow" });
  const prepare = f.store.prepareHarnessToolExecution;
  f.store.prepareHarnessToolExecution = () => { throw new Error("injected file Broker preparation failure"); };
  let result;
  try { result = await f.handler(f.request()); }
  finally { f.store.prepareHarnessToolExecution = prepare; }
  assert.equal(result.handledResult.isError, true);
  assert.equal(existsSync(join(f.cwd, "result.txt")), false);
  assert.equal(f.record().settlementKind, "known_no_start");
});
