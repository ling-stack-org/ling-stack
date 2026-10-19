import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

const now = "2026-09-09T04:20:00.000Z";
const actionFingerprint = "a".repeat(64), policyFingerprint = "b".repeat(64);
const readMethod = "fs/read_text_file", writeMethod = "fs/write_text_file";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-effects-"));
  const stores = [];
  const open = () => { const store = createSqliteRunStore(cwd); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) store.close(); await rm(cwd, { recursive: true, force: true }); });
  const store = open();
  const channel = store.createChannel({ name: "Host effects fixture", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Host effects", prompt: "Fixture" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "Host effects", objective: "Fixture" }, now);
  const selection = { engineId: "kimi-acp", profileId: "fixture-profile", profileRevision: 1,
    profileFingerprint: "c".repeat(64), configurationFingerprint: "d".repeat(64) };
  let count = 0;
  const reserve = () => {
    const id = `run_host_${++count}`;
    store.createRun({ id, cwd, taskId: task.id, channelId: channel.id, threadId: thread.id,
      providerName: "native", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
    const work = store.createWorkUnit({ id: `wu_${id}`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
      ownerType: "run", ownerId: id, idempotencyKey: id, createdByActor: "user", request: {}, linkedRunId: id,
      runnerId: selection.engineId, now });
    const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1,
      runtimeInstanceId: "host-runtime", runnerId: selection.engineId, now });
    store.linkRunToWorkUnit(id, work.id, now);
    const reservation = { runId: id, generation: 1, fence: toRuntimeAttemptFence(attempt), selection };
    assert.equal(store.transitionRunStatus({ runId: id, event: "runner_started", actor: "system", now }).ok, true);
    for (const event of ["claim", "runner_started"]) assert.equal(store.transitionWorkUnitStatus({ ...reservation.fence, event, actor: "system", now }).ok, true);
    store.updateWorkUnitAttemptStatus({ ...reservation.fence, status: "started", now });
    const entry = store.reserveNativeExecution(reservation, now);
    const key = { submissionId: entry.submission.id, fence: reservation.fence };
    store.bindNativeExecutionSession({ ...key, nativeSessionId: "host-session" }, now);
    store.beginNativeSubmission({ ...key, nativePromptRequestId: 1 }, now);
    store.acceptNativeSubmission({ ...key, nativePromptRequestId: 1 }, now);
    return { key, entry, reservation };
  };
  const { key, entry, reservation } = reserve();
  const payload = { type: "file_write", path: join(cwd, "sample.txt"), bytes: 5, preview: "after" };
  const createApproval = (overrides = {}) => store.createNativeApproval({ ...key, requestId: "native-permission", method: "session/request_permission",
    approval: { toolCallId: "native-write", actionType: "write", risk: "medium", title: "Write fixture file", payload,
      expiresAt: "2026-09-09T04:25:00.000Z" }, ...overrides }, now).approval;
  const approve = approval => {
    store.approveApprovalRequest(approval.id, {}, now);
    const approvalKey = { approvalId: approval.id, fence: key.fence };
    store.claimNativeApprovalReply(approvalKey, now);
    store.settleNativeApprovalReply({ ...approvalKey, outcome: "written" }, now);
  };
  const actionInput = authorization => ({ ...key, nativeSessionId: "host-session", toolCallId: "native-write",
    actionFingerprint, policyFingerprint, methods: [readMethod, writeMethod], authorization });
  const claimInput = (action, step, overrides = {}) => ({ actionId: action.id, fence: key.fence, step,
    requestId: `host-${step}`, operationFingerprint: String(step + 1).repeat(64), actionFingerprint, policyFingerprint, ...overrides });
  return { cwd, store, open, reserve, key, entry, reservation, payload, createApproval, approve, actionInput, claimInput };
}

async function terminalFixture(t, approvalSource) {
  const f = await fixture(t);
  const payload = { type: "bash", command: "printf fixture", cwd: f.cwd };
  const approval = approvalSource ? f.createApproval({ requestId: approvalSource === "host" ? "host-0" : "native-permission",
    method: approvalSource === "host" ? "terminal/create" : "session/request_permission",
    approval: { toolCallId: "terminal-tool", actionType: "execute", risk: "medium", title: "Terminal fixture", payload,
      expiresAt: "2026-09-09T04:25:00.000Z" } }) : undefined;
  if (approvalSource === "host") f.store.approveApprovalRequest(approval.id, {}, now);
  else if (approval) f.approve(approval);
  const action = f.store.reserveNativeHostAction({ ...f.actionInput(approval
    ? { kind: "approval", approvalId: approval.id, payload } : { kind: "policy" }),
  toolCallId: "terminal-tool", methods: ["terminal/create"] }, now).action;
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  const input = { operationId: operation.id, fence: f.key.fence, terminalId: "terminal-fixture" };
  const deliver = outcome => {
    if (approvalSource === "host") {
      f.store.claimNativeApprovalReply({ approvalId: approval.id, fence: f.key.fence }, now);
      f.store.settleNativeApprovalReply({ approvalId: approval.id, fence: f.key.fence, outcome }, now);
    }
    return f.store.observeNativeHostOperationReply({ operationId: operation.id, fence: f.key.fence,
      requestId: operation.requestId, method: "terminal/create", outcome }, now);
  };
  return { ...f, action, operation, input, approval, deliver };
}

test("a terminal handle is durable while the real command is running, not a completed effect", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction({ ...f.actionInput({ kind: "policy" }), methods: ["terminal/create"] }, now).action;
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); process.stdin.once('data', () => process.exit(7));"],
    { cwd: f.cwd, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  await once(child.stdout, "data");
  const input = { operationId: operation.id, fence: f.key.fence, terminalId: "terminal-fixture" };
  const started = f.store.recordNativeHostTerminalStart(input, now);
  assert.equal(child.exitCode, null);
  assert.equal(started.status, "claimed");
  assert.deepEqual(started.terminal, { terminalId: "terminal-fixture", startedAt: now });
  const reopened = f.open();
  assert.deepEqual(reopened.listNativeHostOperations(action.id), [started]);
  assert.equal(reopened.getNativeHostAction(action.id).status, "running");
  assert.equal(reopened.assertNativeHostTerminalReply({ ...input, kind: "create" }, now).status, "claimed");
  assert.throws(() => reopened.assertNativeHostTerminalReply({ ...input, kind: "output" }, now), { code: "native_host_operation_conflict" });
  assert.throws(() => reopened.finishNativeSubmission({ ...f.key, outcome: "completed" }, now), { code: "native_host_effect_unresolved" });
  reopened.observeNativeHostOperationReply({ operationId: operation.id, fence: f.key.fence,
    requestId: operation.requestId, method: "terminal/create", outcome: "written" }, now);
  assert.equal(reopened.assertNativeHostTerminalReply({ ...input, kind: "output" }, now).status, "claimed");
  assert.throws(() => reopened.assertNativeHostTerminalReply({ ...input, kind: "exit" }, now), { code: "native_host_operation_conflict" });
  child.stdin.end("finish");
  const [exitCode, signal] = await closed;
  assert.equal(exitCode, 7);
  const ended = reopened.settleNativeHostTerminalExit({ ...input, exit: { exitCode, signal } }, now);
  assert.equal(ended.status, "failed");
  assert.deepEqual(ended.terminal.exit, { exitCode: 7, signal: null });
  assert.equal(reopened.assertNativeHostTerminalReply({ ...input, kind: "exit" }, now).status, "failed");
  assert.equal(reopened.assertNativeHostTerminalReply({ ...input, kind: "output" }, now).status, "failed");
  assert.deepEqual(f.open().listNativeHostOperations(action.id), [ended]);
  assert.throws(() => reopened.claimNativeHostOperation(f.claimInput(action, 0), now), { code: "native_host_operation_conflict" });
  reopened.finishNativeSubmission({ ...f.key, outcome: "completed" }, now);
});

test("terminal creation and exit cannot use the generic file result path", async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction({ ...f.actionInput({ kind: "policy" }), methods: ["terminal/create"] }, now).action;
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  const input = { operationId: operation.id, fence: f.key.fence, terminalId: "terminal-fixture" };
  for (const outcome of ["succeeded", "failed"]) assert.throws(() => f.store.settleNativeHostOperation({
    operationId: operation.id, fence: f.key.fence, outcome }, now), { code: "native_host_operation_conflict" });
  f.store.recordNativeHostTerminalStart(input, now);
  assert.throws(() => f.store.settleNativeHostOperation({ operationId: operation.id, fence: f.key.fence, outcome: "not_started" }, now),
    { code: "native_host_operation_conflict" });
  const ended = f.store.settleNativeHostTerminalExit({ ...input, exit: { exitCode: 0, signal: null } }, now);
  assert.throws(() => f.store.assertNativeHostOperationReply({ operationId: operation.id, fence: f.key.fence,
    resultFingerprint: ended.resultFingerprint }, now), { code: "native_host_operation_conflict" });
});

for (const approvalSource of ["host", "native"]) test(`${approvalSource} Bash approval owns terminal creation and subsequent output`, async t => {
  const f = await terminalFixture(t, approvalSource);
  f.store.recordNativeHostTerminalStart(f.input, now);
  assert.equal(f.store.assertNativeHostTerminalReply({ ...f.input, kind: "create" }, now).status, "claimed");
  f.deliver("written");
  assert.equal(f.open().assertNativeHostTerminalReply({ ...f.input, kind: "output" }, now).status, "claimed");
  assert.throws(() => f.store.assertNativeHostTerminalReply({ ...f.input, kind: "output" }, "2026-09-09T04:25:00.000Z"),
    { code: "native_approval_unavailable" });
  f.store.resolveNativeApprovalRequest({ approvalId: f.approval.id, fence: f.key.fence }, now);
  assert.throws(() => f.store.assertNativeHostTerminalReply({ ...f.input, kind: "output" }, now), { code: "native_approval_unavailable" });
  assert.equal(f.store.settleNativeHostTerminalExit({ ...f.input, exit: { exitCode: 0, signal: null } }, now).status, "succeeded");
});

for (const outcome of ["written", "not_written", "unknown"]) test(`terminal ${outcome} create delivery never settles the command or permits respawn`, async t => {
  const f = await terminalFixture(t);
  f.store.recordNativeHostTerminalStart(f.input, now);
  f.deliver(outcome);
  const reopened = f.open();
  assert.equal(reopened.listNativeHostOperations(f.action.id)[0].status, "claimed");
  assert.throws(() => reopened.claimNativeHostOperation(f.claimInput(f.action, 0), now), { code: "native_host_operation_conflict" });
  assert.throws(() => reopened.assertNativeHostTerminalReply({ ...f.input, kind: "create" }, now), { code: "native_host_operation_conflict" });
  assert.throws(() => reopened.finishNativeSubmission({ ...f.key, outcome: "completed" }, now), { code: "native_host_effect_unresolved" });
  if (outcome !== "written") assert.throws(() => reopened.assertNativeHostTerminalReply({ ...f.input, kind: "output" }, now),
    { code: "native_host_operation_conflict" });
  reopened.markNativeSubmissionUnknown(f.key, now);
  assert.equal(reopened.listNativeHostOperations(f.action.id)[0].status, "unknown");
  assert.equal(reopened.listNativeHostOperations(f.action.id)[0].terminal.terminalId, "terminal-fixture");
  assert.throws(() => reopened.assertNativeHostTerminalReply({ ...f.input, kind: "output" }, now), { code: "native_submission_conflict" });
  assert.throws(() => reopened.settleNativeHostTerminalExit({ ...f.input, exit: { exitCode: 0, signal: null } }, now),
    { code: "native_submission_conflict" });
  assert.throws(() => f.reserve(), { code: "native_session_busy" });
});

test("cancelling records a real terminal signal exit but cannot disclose new output", { timeout: 15000 }, async t => {
  const f = await terminalFixture(t, "host");
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000);"],
    { cwd: f.cwd, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  await once(child.stdout, "data");
  f.store.updateWorkUnitAttemptStatus({ ...f.key.fence, status: "cancelling", now });
  // Launch may have won the race before cancellation; recording it is not permission to disclose.
  f.store.recordNativeHostTerminalStart(f.input, now);
  assert.throws(() => f.store.assertNativeHostTerminalReply({ ...f.input, kind: "create" }, now), { code: "native_owner_mismatch" });
  child.kill("SIGTERM");
  const [exitCode, signal] = await closed;
  assert.equal(signal, "SIGTERM");
  const exited = f.store.settleNativeHostTerminalExit({ ...f.input, exit: { exitCode, signal } }, now);
  assert.equal(exited.status, "failed");
  assert.deepEqual(exited.terminal.exit, { exitCode: null, signal: "SIGTERM" });
  assert.throws(() => f.store.assertNativeHostTerminalReply({ ...f.input, kind: "output" }, now), { code: "native_owner_mismatch" });
  f.store.finishNativeSubmission({ ...f.key, outcome: "cancelled" }, now);
  assert.deepEqual(f.open().listNativeHostOperations(f.action.id), [exited]);
});

test("terminal start/exit identities are immutable and Attempt replacement cannot take over", async t => {
  const f = await terminalFixture(t);
  const started = f.store.recordNativeHostTerminalStart(f.input, now);
  assert.deepEqual(f.open().recordNativeHostTerminalStart(f.input, "2026-09-09T04:21:00.000Z"), started);
  for (const patch of [{ terminalId: "another" }, { operationId: "another" }]) {
    assert.throws(() => f.store.recordNativeHostTerminalStart({ ...f.input, ...patch }, now), { code: "native_host_operation_conflict" });
    assert.throws(() => f.store.assertNativeHostTerminalReply({ ...f.input, ...patch, kind: "create" }, now), { code: "native_host_operation_conflict" });
    assert.throws(() => f.store.settleNativeHostTerminalExit({ ...f.input, ...patch, exit: { exitCode: 0, signal: null } }, now),
      { code: "native_host_operation_conflict" });
  }
  f.store.createWorkUnitAttempt({ workUnitId: f.key.fence.workUnitId, attemptNumber: 2, runtimeInstanceId: "replacement", runnerId: "kimi-acp", now });
  assert.throws(() => f.store.recordNativeHostTerminalStart(f.input, now), { code: "native_owner_mismatch" });
  assert.throws(() => f.store.settleNativeHostTerminalExit({ ...f.input, exit: { exitCode: 0, signal: null } }, now), { code: "native_owner_mismatch" });
  assert.throws(() => f.store.assertNativeHostTerminalReply({ ...f.input, kind: "create" }, now), { code: "native_owner_mismatch" });
  assert.deepEqual(f.open().listNativeHostOperations(f.action.id), [started]);
});

test("terminal handles cannot be attached to file operations or reused by another command", async t => {
  const f = await terminalFixture(t);
  f.store.recordNativeHostTerminalStart(f.input, now);
  for (const method of ["fs/read_text_file", "terminal/create"]) {
    const action = f.store.reserveNativeHostAction({ ...f.actionInput({ kind: "policy" }), toolCallId: method, methods: [method] }, now).action;
    const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0, { requestId: method }), now);
    const input = { ...f.input, operationId: operation.id };
    assert.throws(() => f.store.recordNativeHostTerminalStart(input, now), { code: "native_host_operation_conflict" });
    assert.equal(f.store.listNativeHostOperations(action.id)[0].terminal, undefined);
  }
});

test("terminal completion requires a typed exit and records it once without changing the original timestamp", async t => {
  const f = await terminalFixture(t);
  const input = { ...f.input, exit: { exitCode: 0, signal: null } };
  assert.throws(() => f.store.settleNativeHostTerminalExit(input, now), { code: "native_host_operation_conflict" });
  f.store.recordNativeHostTerminalStart(f.input, now);
  for (const exit of [{}, { exitCode: null, signal: null }, { exitCode: 0, signal: "SIGTERM" }, { exitCode: -1, signal: null },
    { exitCode: NaN, signal: null }, { exitCode: 0.5, signal: null }, { exitCode: 2 ** 32, signal: null },
    { exitCode: null, signal: "arbitrary native error" }, { exitCode: 0, signal: null, secret: "redacted-fixture" }]) {
    assert.throws(() => f.store.settleNativeHostTerminalExit({ ...input, exit }, now), { code: "native_journal_invalid" });
    assert.equal(f.store.listNativeHostOperations(f.action.id)[0].status, "claimed");
  }
  const ended = f.store.settleNativeHostTerminalExit(input, now);
  assert.equal(ended.status, "succeeded");
  assert.deepEqual(f.open().settleNativeHostTerminalExit(input, "2026-09-09T04:21:00.000Z"), ended);
  assert.throws(() => f.store.settleNativeHostTerminalExit({ ...input, exit: { exitCode: 1, signal: null } }, now),
    { code: "native_host_operation_conflict" });
});

test("terminal start and exit writes roll back on failure without releasing their effect claim", async t => {
  const f = await terminalFixture(t), db = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_terminal_start BEFORE UPDATE OF terminal_id ON native_host_operations BEGIN SELECT RAISE(FAIL, 'injected_terminal_start'); END;");
  assert.throws(() => f.store.recordNativeHostTerminalStart(f.input, now), /injected_terminal_start/);
  assert.equal(f.open().listNativeHostOperations(f.action.id)[0].terminal, undefined);
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(f.action, 0), now), { code: "native_host_operation_conflict" });
  db.exec("DROP TRIGGER fail_terminal_start");
  const started = f.store.recordNativeHostTerminalStart(f.input, now);
  db.exec("CREATE TRIGGER fail_terminal_exit BEFORE UPDATE OF status ON native_host_actions WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(FAIL, 'injected_terminal_exit'); END;");
  assert.throws(() => f.store.settleNativeHostTerminalExit({ ...f.input, exit: { exitCode: 0, signal: null } }, now), /injected_terminal_exit/);
  assert.deepEqual(f.open().listNativeHostOperations(f.action.id), [started]);
  assert.equal(f.store.getNativeHostAction(f.action.id).status, "running");
  db.exec("DROP TRIGGER fail_terminal_exit");
  assert.equal(f.store.settleNativeHostTerminalExit({ ...f.input, exit: { exitCode: 0, signal: null } }, now).status, "succeeded");
});

for (const failMigration of [false, true]) test(`terminal migration preserves existing facts without inventing a process (failure=${failMigration})`, async t => {
  const f = await terminalFixture(t);
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action;
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0, { requestId: "legacy-file" }), now);
  const file = f.store.settleNativeHostOperation({ operationId: operation.id, fence: f.key.fence, outcome: "succeeded" }, now);
  f.store.close();
  const db = new DatabaseSync(f.store.paths.databasePath);
  try {
    db.exec("DROP INDEX native_host_terminal_identity; ALTER TABLE native_host_operations DROP COLUMN terminal_id; ALTER TABLE native_host_operations DROP COLUMN terminal_started_at; ALTER TABLE native_host_operations DROP COLUMN terminal_exit_json; DELETE FROM schema_migrations WHERE version = 173;");
    if (failMigration) {
      db.exec("CREATE TRIGGER fail_terminal_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 173 BEGIN SELECT RAISE(FAIL, 'injected_terminal_migration'); END;");
      assert.throws(() => f.open(), /injected_terminal_migration/);
      assert.equal(db.prepare("SELECT count(*) AS count FROM pragma_table_info('native_host_operations') WHERE name LIKE 'terminal_%'").get().count, 0);
      assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'native_host_terminal_identity'").get().count, 0);
      db.exec("DROP TRIGGER fail_terminal_migration");
    }
  } finally { db.close(); }
  const reopened = f.open();
  assert.deepEqual(reopened.listNativeHostOperations(f.action.id), [f.operation]);
  assert.deepEqual(reopened.listNativeHostOperations(action.id), [file]);
});

test("one approved host action owns its ordered read/write effects across SQLite reopen", async t => {
  const f = await fixture(t);
  const approval = f.createApproval();
  const input = f.actionInput({ kind: "approval", approvalId: approval.id, payload: f.payload });
  const saved = f.store.reserveNativeHostAction(input, now);
  assert.equal(saved.created, true);
  assert.equal(saved.action.status, "reserved");
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(saved.action, 0), now), { code: "native_approval_unavailable" });
  f.approve(approval);
  const reopened = f.open();
  assert.deepEqual(reopened.reserveNativeHostAction(input, now), { action: saved.action, created: false });
  await writeFile(f.payload.path, "before");
  const read = reopened.claimNativeHostOperation(f.claimInput(saved.action, 0), now);
  assert.equal(read.method, readMethod);
  assert.equal(await readFile(f.payload.path, "utf8"), "before");
  reopened.settleNativeHostOperation({ operationId: read.id, fence: f.key.fence, outcome: "succeeded" }, now);
  const write = f.store.claimNativeHostOperation(f.claimInput(saved.action, 1), now);
  await writeFile(f.payload.path, "after");
  f.store.settleNativeHostOperation({ operationId: write.id, fence: f.key.fence, outcome: "succeeded" }, now);
  assert.equal(f.open().getNativeHostAction(saved.action.id).status, "succeeded");
  assert.equal(await readFile(f.payload.path, "utf8"), "after");
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "written");
  assert.equal(f.store.synchronizeNativeApprovalWait(f.key, now).approvals.length, 1);
  assert.throws(() => reopened.claimNativeHostOperation(f.claimInput(saved.action, 0), now), { code: "native_host_operation_conflict" });
  assert.equal(f.store.listNativeHostOperations(saved.action.id).length, 2);
});

for (const outcome of ["written", "not_written", "unknown"]) test(`each host step persists its own ${outcome} reply observation across reopen`, async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action;
  for (const step of [0, 1]) {
    const operation = f.store.claimNativeHostOperation(f.claimInput(action, step), now);
    assert.equal(operation.replyStatus, "unknown");
    assert.equal(operation.replyObservedAt, undefined);
    f.store.settleNativeHostOperation({ operationId: operation.id, fence: f.key.fence, outcome: "succeeded" }, now);
    const observed = { operationId: operation.id, fence: f.key.fence, requestId: operation.requestId,
      method: operation.method, outcome: step === 0 ? "written" : outcome };
    const result = f.store.observeNativeHostOperationReply(observed, now);
    assert.equal(result.replyStatus, observed.outcome);
    assert.equal(result.replyObservedAt, now);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(f.open().observeNativeHostOperationReply(observed, "2026-09-09T04:21:00.000Z"), result);
    assert.throws(() => f.store.observeNativeHostOperationReply({ ...observed,
      outcome: observed.outcome === "written" ? "unknown" : "written" }, now), { code: "native_host_operation_conflict" });
    assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, step), now), { code: "native_host_operation_conflict" });
  }
  assert.deepEqual(f.open().listNativeHostOperations(action.id).map(item => [item.status, item.replyStatus]),
    [["succeeded", "written"], ["succeeded", outcome]]);
});

test("reply observations require the original Attempt, typed request id and method", async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action;
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0, { requestId: 1 }), now);
  const input = { operationId: operation.id, fence: f.key.fence, requestId: 1, method: readMethod, outcome: "written" };
  for (const patch of [{ requestId: "1" }, { method: writeMethod }, { operationId: "other-operation" }]) {
    assert.throws(() => f.store.observeNativeHostOperationReply({ ...input, ...patch }, now), { code: "native_host_operation_conflict" });
  }
  assert.throws(() => f.store.observeNativeHostOperationReply({ ...input,
    fence: { ...f.key.fence, fencingToken: "other-owner" } }, now), { code: "native_owner_mismatch" });
  for (const patch of [{ outcome: "pending" }, { requestId: null }, { surprise: true }]) {
    assert.throws(() => f.store.observeNativeHostOperationReply({ ...input, ...patch }, now), { code: "native_journal_invalid" });
  }
  assert.equal(f.open().listNativeHostOperations(action.id)[0].replyObservedAt, undefined);
  f.store.observeNativeHostOperationReply(input, now);
  assert.equal(f.open().listNativeHostOperations(action.id)[0].status, "claimed", "A sent error/result is not proof of the file effect");
  assert.throws(() => f.store.finishNativeSubmission({ ...f.key, outcome: "completed" }, now), { code: "native_host_effect_unresolved" });
});

for (const unknownEffect of [false, true]) test(`late reply observations do not restore retired execution (unknown effect=${unknownEffect})`, async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction({ ...f.actionInput({ kind: "policy" }), methods: [writeMethod] }, now).action;
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  if (!unknownEffect) f.store.settleNativeHostOperation({ operationId: operation.id, fence: f.key.fence, outcome: "succeeded" }, now);
  if (unknownEffect) f.store.markNativeSubmissionUnknown(f.key, now);
  else f.store.finishNativeSubmission({ ...f.key, outcome: "completed" }, now);
  f.store.updateWorkUnitAttemptStatus({ ...f.key.fence, status: "cancelling", now });
  const before = f.store.getNativeSubmission(f.key.submissionId);
  const result = f.open().observeNativeHostOperationReply({ operationId: operation.id, fence: f.key.fence,
    requestId: operation.requestId, method: writeMethod, outcome: "written" }, now);
  assert.equal(result.status, unknownEffect ? "unknown" : "succeeded");
  assert.deepEqual(f.store.getNativeSubmission(f.key.submissionId), before);
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, 0), now), { code: "native_owner_mismatch" });
});

for (const mode of ["policy", "approval"]) test(`host reply validation reuses the core ${mode} ownership and result checks`, async t => {
  const f = await fixture(t);
  const approval = mode === "approval" ? f.createApproval() : undefined;
  if (approval) f.approve(approval);
  const action = f.store.reserveNativeHostAction(f.actionInput(approval
    ? { kind: "approval", approvalId: approval.id, payload: f.payload } : { kind: "policy" }), now).action;
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  const input = { operationId: operation.id, fence: f.key.fence, resultFingerprint: "f".repeat(64) };
  assert.throws(() => f.store.assertNativeHostOperationReply(input, now), { code: "native_host_operation_conflict" });
  f.store.settleNativeHostOperation({ operationId: operation.id, fence: f.key.fence,
    outcome: "succeeded", resultFingerprint: input.resultFingerprint }, now);
  const reopened = f.open();
  assert.equal(reopened.assertNativeHostOperationReply(input, now).status, "succeeded");
  assert.throws(() => reopened.assertNativeHostOperationReply({ ...input, resultFingerprint: "e".repeat(64) }, now),
    { code: "native_host_operation_conflict" });
  f.store.updateWorkUnitAttemptStatus({ ...f.key.fence, status: "cancelling", now });
  assert.throws(() => reopened.assertNativeHostOperationReply(input, now), { code: "native_owner_mismatch" });
  assert.equal(reopened.listNativeHostOperations(action.id)[0].status, "succeeded");
});

for (const terminal of ["completed", "cancelled", "failed", "output"]) test(`unfinished host effects cannot be released by native ${terminal}`, async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action;
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  const finish = () => terminal === "output" ? f.store.appendNativeRunEvents({ ...f.key, nativeSessionId: "host-session", nativePromptRequestId: 1,
    firstSequence: 1, terminal: "completed", events: [{ type: "turn_end", data: {} }] }, now)
    : f.store.finishNativeSubmission({ ...f.key, outcome: terminal }, now);
  assert.throws(finish, { code: "native_host_effect_unresolved" });
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "accepted");
  assert.deepEqual(f.store.listEvents(f.reservation.runId), []);
  f.store.markNativeSubmissionUnknown(f.key, now);
  assert.equal(f.open().getNativeHostAction(action.id).status, "unknown");
  assert.equal(f.open().listNativeHostOperations(action.id)[0].status, "unknown");
  assert.equal(f.store.listNativeHostOperations(action.id)[0].id, operation.id);
  assert.throws(() => f.reserve(), { code: "native_session_busy" });
});

for (const started of [false, true]) test(`native terminal retires unclaimed remaining host steps without inventing effects (started=${started})`, async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action;
  if (started) {
    const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
    f.store.settleNativeHostOperation({ operationId: operation.id, fence: f.key.fence, outcome: "succeeded" }, now);
  }
  f.store.finishNativeSubmission({ ...f.key, outcome: "cancelled" }, now);
  assert.equal(f.open().getNativeHostAction(action.id).status, "cancelled");
  assert.deepEqual(f.store.listNativeHostOperations(action.id).map(item => item.status), started ? ["succeeded"] : []);
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, started ? 1 : 0), now), { code: "native_submission_conflict" });
});

test("a host-originated approval authorizes read then write without a second approval record", async t => {
  const f = await fixture(t);
  const approval = f.createApproval({ requestId: "host-0", method: readMethod });
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "approval", approvalId: approval.id, payload: f.payload }), now).action;
  f.store.approveApprovalRequest(approval.id, {}, now);
  const read = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  f.store.settleNativeHostOperation({ operationId: read.id, fence: f.key.fence, outcome: "succeeded" }, now);
  assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "pending");
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, 1), now), { code: "native_approval_unavailable" });
  f.store.claimNativeApprovalReply({ approvalId: approval.id, fence: f.key.fence }, now);
  f.store.settleNativeApprovalReply({ approvalId: approval.id, fence: f.key.fence, outcome: "written" }, now);
  const write = f.store.claimNativeHostOperation(f.claimInput(action, 1), now);
  f.store.settleNativeHostOperation({ operationId: write.id, fence: f.key.fence, outcome: "succeeded" }, now);
  assert.equal(f.store.synchronizeNativeApprovalWait(f.key, now).approvals.length, 1);
  f.store.finishNativeSubmission({ ...f.key, outcome: "completed" }, now);
  assert.equal(f.open().getNativeHostAction(action.id).status, "succeeded");
});

test("host-originated approval cannot be borrowed by another initial file request", async t => {
  const f = await fixture(t);
  const approval = f.createApproval({ requestId: 1, method: readMethod });
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "approval", approvalId: approval.id, payload: f.payload }), now).action;
  f.store.approveApprovalRequest(approval.id, {}, now);
  for (const requestId of ["1", 2]) assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, 0, { requestId }), now),
    { code: "native_approval_unavailable" });
  assert.deepEqual(f.store.listNativeHostOperations(action.id), []);
  assert.equal(f.store.claimNativeHostOperation(f.claimInput(action, 0, { requestId: 1 }), now).requestId, 1);
});

for (const outcome of ["succeeded", "failed", "not_started", "unknown"]) test(`host ${outcome} is durable and never yields a new effect claim`, async t => {
  const f = await fixture(t);
  const input = { ...f.actionInput({ kind: "policy" }), methods: [writeMethod] };
  const action = f.store.reserveNativeHostAction(input, now).action;
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  const settlement = { operationId: operation.id, fence: f.key.fence, outcome, resultFingerprint: "e".repeat(64) };
  const saved = f.store.settleNativeHostOperation(settlement, now);
  assert.deepEqual(f.open().settleNativeHostOperation(settlement, now), saved);
  assert.equal(saved.status, outcome);
  assert.throws(() => f.open().claimNativeHostOperation(f.claimInput(action, 0), now), { code: "native_host_operation_conflict" });
  assert.throws(() => f.store.settleNativeHostOperation({ ...settlement, resultFingerprint: "f".repeat(64) }, now), { code: "native_host_operation_conflict" });
  assert.equal(f.store.synchronizeNativeApprovalWait(f.key, now).approvals.length, 0);
  if (outcome === "unknown") assert.throws(() => f.store.finishNativeSubmission({ ...f.key, outcome: "completed" }, now), { code: "native_host_effect_unresolved" });
  else f.store.finishNativeSubmission({ ...f.key, outcome: "completed" }, now);
});

for (const state of ["pending", "denied", "expired", "reply_pending", "reply_claimed", "reply_unknown", "reply_not_written", "resolved"]) {
  test(`${state} approval cannot authorize a host effect`, async t => {
    const f = await fixture(t), approval = f.createApproval();
    const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "approval", approvalId: approval.id, payload: f.payload }), now).action;
    if (state === "denied") f.store.denyApprovalRequest(approval.id, {}, now);
    if (!["pending", "denied"].includes(state)) f.store.approveApprovalRequest(approval.id, {}, now);
    if (!["pending", "denied", "reply_pending"].includes(state)) {
      f.store.claimNativeApprovalReply({ approvalId: approval.id, fence: f.key.fence }, now);
      if (state !== "reply_claimed") f.store.settleNativeApprovalReply({ approvalId: approval.id, fence: f.key.fence,
        outcome: state === "reply_unknown" ? "unknown" : state === "reply_not_written" ? "not_written" : "written" }, now);
    }
    if (state === "resolved") f.store.resolveNativeApprovalRequest({ approvalId: approval.id, fence: f.key.fence }, now);
    assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, 0), state === "expired" ? "2026-09-09T04:25:00.000Z" : now),
      { code: "native_approval_unavailable" });
    assert.deepEqual(f.store.listNativeHostOperations(action.id), []);
  });
}

test("substituted approval payload, tool or operation kind cannot reserve an authorized host action", async t => {
  const f = await fixture(t), approval = f.createApproval();
  const input = f.actionInput({ kind: "approval", approvalId: approval.id, payload: f.payload });
  for (const patch of [{ toolCallId: "another-tool" }, { methods: ["terminal/create"] }, { methods: [readMethod] },
    { authorization: { kind: "approval", approvalId: approval.id, payload: { ...f.payload, preview: "unapproved content" } } }]) {
    assert.throws(() => f.store.reserveNativeHostAction({ ...input, ...patch }, now), { code: "native_approval_unavailable" });
  }
  const action = f.store.reserveNativeHostAction(input, now).action;
  for (const patch of [{ actionFingerprint: "f".repeat(64) }, { policyFingerprint: "f".repeat(64) }, { methods: [writeMethod] }, { authorization: { kind: "policy" } }]) {
    assert.throws(() => f.store.reserveNativeHostAction({ ...input, ...patch }, now), { code: "native_host_operation_conflict" });
  }
  assert.equal(f.open().getNativeHostAction(action.id).status, "reserved");
});

for (const change of ["action", "policy", "step", "owner"]) test(`changed ${change} identity cannot claim a prepared effect`, async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action;
  const patch = change === "action" ? { actionFingerprint: "f".repeat(64) } : change === "policy" ? { policyFingerprint: "f".repeat(64) }
    : change === "step" ? { step: 1 } : { fence: { ...f.key.fence, fencingToken: "substitute" } };
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, 0, patch), now),
    { code: change === "owner" ? "native_owner_mismatch" : "native_host_operation_conflict" });
  assert.deepEqual(f.store.listNativeHostOperations(action.id), []);
});

test("host effect request ids cannot be recycled across different native tools in one submission", async t => {
  const f = await fixture(t);
  const first = f.store.reserveNativeHostAction({ ...f.actionInput({ kind: "policy" }), methods: [writeMethod] }, now).action;
  const second = f.store.reserveNativeHostAction({ ...f.actionInput({ kind: "policy" }), methods: [writeMethod], toolCallId: "another" }, now).action;
  const one = f.store.claimNativeHostOperation(f.claimInput(first, 0), now);
  f.store.settleNativeHostOperation({ operationId: one.id, fence: f.key.fence, outcome: "succeeded" }, now);
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(second, 0), now), { code: "native_host_operation_conflict" });
  assert.equal(f.store.claimNativeHostOperation(f.claimInput(second, 0, { requestId: 0 }), now).requestId, 0);
});

for (const stage of ["claimed", "failed", "unknown"]) test(`a ${stage} preliminary read cannot advance to the write`, async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action;
  const read = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  if (stage !== "claimed") f.store.settleNativeHostOperation({ operationId: read.id, fence: f.key.fence, outcome: stage }, now);
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, 1), now), { code: "native_host_operation_conflict" });
  assert.equal(f.store.listNativeHostOperations(action.id).length, 1);
});

test("cancellation blocks new effects but permits recording the already owned operation result", async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action;
  const read = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  f.store.updateWorkUnitAttemptStatus({ ...f.key.fence, status: "cancelling", now });
  f.store.settleNativeHostOperation({ operationId: read.id, fence: f.key.fence, outcome: "succeeded" }, now);
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, 1), now), { code: "native_owner_mismatch" });
  f.store.finishNativeSubmission({ ...f.key, outcome: "cancelled" }, now);
  assert.equal(f.store.getNativeHostAction(action.id).status, "cancelled");
});

test("a replaced Attempt cannot claim or settle the former owner's host effects", async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action;
  const read = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  f.store.createWorkUnitAttempt({ workUnitId: f.key.fence.workUnitId, attemptNumber: 2, runtimeInstanceId: "replacement", runnerId: "kimi-acp", now });
  assert.throws(() => f.store.settleNativeHostOperation({ operationId: read.id, fence: f.key.fence, outcome: "succeeded" }, now), { code: "native_owner_mismatch" });
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, 1), now), { code: "native_owner_mismatch" });
  assert.equal(f.open().listNativeHostOperations(action.id)[0].status, "claimed");
});

test("host claim and settlement transactions roll back without a reusable partial permit", async t => {
  const f = await fixture(t), db = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => db.close());
  const action = f.store.reserveNativeHostAction({ ...f.actionInput({ kind: "policy" }), methods: [writeMethod] }, now).action;
  db.exec("CREATE TRIGGER fail_host_claim BEFORE UPDATE OF status ON native_host_actions WHEN NEW.status = 'running' BEGIN SELECT RAISE(FAIL, 'injected_host_claim'); END;");
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, 0), now), /injected_host_claim/);
  assert.deepEqual(f.open().listNativeHostOperations(action.id), []);
  assert.equal(f.store.getNativeHostAction(action.id).status, "reserved");
  db.exec("DROP TRIGGER fail_host_claim");
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  db.exec("CREATE TRIGGER fail_host_settle BEFORE UPDATE OF status ON native_host_actions WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(FAIL, 'injected_host_settle'); END;");
  assert.throws(() => f.store.settleNativeHostOperation({ operationId: operation.id, fence: f.key.fence, outcome: "succeeded" }, now), /injected_host_settle/);
  assert.equal(f.open().listNativeHostOperations(action.id)[0].status, "claimed");
  assert.throws(() => f.store.claimNativeHostOperation(f.claimInput(action, 0), now), { code: "native_host_operation_conflict" });
  db.exec("DROP TRIGGER fail_host_settle");
  f.store.settleNativeHostOperation({ operationId: operation.id, fence: f.key.fence, outcome: "succeeded" }, now);
});

for (const failMigration of [false, true]) test(`host reply migration preserves effect facts without inventing delivery (failure=${failMigration})`, async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action;
  const operation = f.store.claimNativeHostOperation(f.claimInput(action, 0), now);
  const before = f.store.settleNativeHostOperation({ operationId: operation.id, fence: f.key.fence, outcome: "succeeded" }, now);
  f.store.close();
  const db = new DatabaseSync(f.store.paths.databasePath);
  try {
    db.exec("ALTER TABLE native_host_operations DROP COLUMN reply_status; ALTER TABLE native_host_operations DROP COLUMN reply_observed_at; DELETE FROM schema_migrations WHERE version = 172");
    if (failMigration) {
      db.exec("CREATE TRIGGER fail_reply_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 172 BEGIN SELECT RAISE(FAIL, 'injected_reply_migration'); END;");
      assert.throws(() => f.open(), /injected_reply_migration/);
      assert.equal(db.prepare("SELECT count(*) AS count FROM pragma_table_info('native_host_operations') WHERE name IN ('reply_status', 'reply_observed_at')").get().count, 0);
      assert.equal(db.prepare("SELECT status FROM native_host_operations WHERE id = ?").get(operation.id).status, "succeeded");
      db.exec("DROP TRIGGER fail_reply_migration");
    }
  } finally { db.close(); }
  assert.deepEqual(f.open().listNativeHostOperations(action.id), [before]);
});

for (const failMigration of [false, true]) test(`host effect migration preserves prior native rows and rolls back atomically (failure=${failMigration})`, async t => {
  const f = await fixture(t), approval = f.createApproval();
  const before = f.store.getNativeSubmission(f.key.submissionId);
  f.store.close();
  const db = new DatabaseSync(f.store.paths.databasePath);
  try {
    db.exec("DROP TABLE native_host_operations; DROP TABLE native_host_actions; DELETE FROM schema_migrations WHERE version IN (171, 172, 173)");
    if (failMigration) {
      db.exec("CREATE TRIGGER fail_host_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 171 BEGIN SELECT RAISE(FAIL, 'injected_host_migration'); END;");
      assert.throws(() => f.open(), /injected_host_migration/);
      assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('native_host_actions', 'native_host_operations')").get().count, 0);
      db.exec("DROP TRIGGER fail_host_migration");
    }
  } finally { db.close(); }
  const reopened = f.open();
  assert.deepEqual(reopened.getNativeSubmission(f.key.submissionId), before);
  assert.deepEqual(reopened.getApprovalRequest(approval.id), approval);
  assert.equal(reopened.reserveNativeHostAction(f.actionInput({ kind: "policy" }), now).action.status, "reserved");
});

for (const kind of ["write", "terminal"]) test(`concurrent reopened owners receive one permit and produce one actual ${kind} effect`, { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const action = f.store.reserveNativeHostAction({ ...f.actionInput({ kind: "policy" }), methods: [kind === "write" ? writeMethod : "terminal/create"] }, now).action;
  const path = join(f.cwd, "one-effect.txt"); await writeFile(path, "");
  const start = new SharedArrayBuffer(4);
  const workers = Array.from({ length: 2 }, () => new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {createSqliteRunStore}=await import(workerData.module);
      const store=createSqliteRunStore(workerData.cwd);parentPort.postMessage({ready:true});
      Atomics.wait(new Int32Array(workerData.start),0,0);
      try{const result=store.claimNativeHostOperation(workerData.input,workerData.now);
        if(workerData.kind==='terminal') {
          const child=require('node:child_process').spawn(process.execPath,['-e',"require('node:fs').appendFileSync(process.argv[1], 'one\\\\n')",workerData.path],{stdio:'ignore'});
          const closed=require('node:events').once(child,'close');
          await require('node:events').once(child,'spawn');
          const key={operationId:result.id,fence:workerData.input.fence,terminalId:'concurrent-terminal'};
          store.recordNativeHostTerminalStart(key,workerData.now);
          const [exitCode,signal]=await closed;
          store.settleNativeHostTerminalExit({...key,exit:{exitCode,signal}},workerData.now);
        } else require('node:fs').appendFileSync(workerData.path,'one\\n');
        parentPort.postMessage({id:result.id});}
      catch(error){parentPort.postMessage({error:error.code??error.message});}
      finally{store.close();}})();
  `, { eval: true, workerData: { cwd: f.cwd, path, kind, input: f.claimInput(action, 0), now, start, module: new URL("../dist/index.js", import.meta.url).href } }));
  const ready = workers.map(() => Promise.withResolvers()), results = workers.map(() => Promise.withResolvers());
  workers.forEach((worker, index) => {
    worker.on("message", message => message.ready ? ready[index].resolve() : results[index].resolve(message));
    worker.on("error", error => { ready[index].reject(error); results[index].reject(error); });
    t.after(() => worker.terminate());
  });
  await Promise.all(ready.map(item => item.promise));
  Atomics.store(new Int32Array(start), 0, 1); Atomics.notify(new Int32Array(start), 0);
  const outcomes = await Promise.all(results.map(item => item.promise));
  assert.equal(outcomes.filter(item => item.id).length, 1);
  assert.deepEqual(outcomes.filter(item => item.error).map(item => item.error), ["native_host_operation_conflict"]);
  assert.equal(await readFile(path, "utf8"), "one\n");
  assert.equal(f.open().listNativeHostOperations(action.id).length, 1);
  if (kind === "terminal") assert.deepEqual(f.store.listNativeHostOperations(action.id)[0].terminal.exit, { exitCode: 0, signal: null });
});
