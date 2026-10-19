import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { AcpJournaledLifecycle, acpConfigurationFingerprint } from "../dist/runtime/acp/journaled-lifecycle.js";
import { KimiActionPreparer } from "../dist/runtime/acp/kimi-action-preparation.js";
import { KimiHostTerminals } from "../dist/runtime/acp/kimi-host-terminals.js";
import { NativeSecretRegistry } from "../dist/runtime/adapters/native-stream-redaction.js";

const native = { skip: process.platform !== "darwin", timeout: 8000 };
const now = () => new Date().toISOString();
async function until(get) {
  for (let i = 0; i < 400; i++) { const result = get(); if (result) return result; await delay(5); }
  assert.fail("Expected terminal lifecycle observation did not arrive");
}
async function live(f, terminalId) {
  for (let i = 0; i < 100; i++) {
    const id = `live-${i}`;
    f.use("output", terminalId, id);
    const response = await until(() => f.reply(id));
    assert.ok(response.result, JSON.stringify(response.error));
    if (response.result.output === "ready") return;
    await delay(10);
  }
  assert.fail("Expected live process output");
}

async function setup(t, options = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-kimi-host-terminal-")));
  await writeFile(join(cwd, "fixture-command"), options.script ?? "#!/bin/bash\nprintf approved >> result.txt\nprintf live\n/bin/sleep 0.1\nexit 7\n", { mode: 0o700 });
  const store = createSqliteRunStore(cwd);
  const actionIds = new Set();
  const reserveAction = store.reserveNativeHostAction.bind(store);
  store.reserveNativeHostAction = (...args) => { const saved = reserveAction(...args); actionIds.add(saved.action.id); return saved; };
  const channel = store.createChannel({ name: "Terminal fixture", boundPath: cwd }, now());
  const task = store.createTask({ channelId: channel.id, title: "Terminal", prompt: "Isolated command" }, now());
  const thread = store.createLingThread({ kind: "conversation", title: "Terminal", objective: "Isolated command" }, now());
  const run = store.createRun({ id: "run_host_terminal", cwd, taskId: task.id, channelId: channel.id, threadId: thread.id,
    providerName: "native", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now() });
  const work = store.createWorkUnit({ id: "wu_host_terminal", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
    ownerType: "run", ownerId: run.id, linkedRunId: run.id, runnerId: "kimi-acp", idempotencyKey: "terminal",
    createdByActor: "user", request: {}, now: now() });
  const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1, runnerId: "kimi-acp", runtimeInstanceId: "fixture", now: now() });
  const fence = toRuntimeAttemptFence(attempt);
  store.linkRunToWorkUnit(run.id, work.id, now());
  store.transitionRunStatus({ runId: run.id, event: "runner_started", actor: "system", now: now() });
  for (const event of ["claim", "runner_started"]) store.transitionWorkUnitStatus({ ...fence, event, actor: "system", now: now() });
  store.updateWorkUnitAttemptStatus({ ...fence, status: "started", now: now() });
  const target = { engineId: "kimi-acp", expectedVersion: "fixture" }, configuration = { cwd };
  const reserved = store.reserveNativeExecution({ runId: run.id, generation: 1, fence, selection: {
    engineId: "kimi-acp", profileId: "fixture", profileRevision: 1, profileFingerprint: "a".repeat(64),
    configurationFingerprint: acpConfigurationFingerprint(target, configuration),
  } }, now());
  const key = { submissionId: reserved.submission.id, fence };
  const abort = new AbortController(), output = new PassThrough(), wire = [], events = [], waits = [];
  const send = (...messages) => output.write(messages.map(value => JSON.stringify(value)).join("\n") + "\n");
  const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
  const update = value => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "terminal-session", update: value } });
  const command = options.command ?? "./fixture-command";
  const input = new Writable({ write(bytes, _encoding, done) {
    const value = JSON.parse(bytes.toString()); wire.push(value);
    if (value.method === "initialize") result(value.id, { protocolVersion: 1,
      agentInfo: { name: "Kimi Code CLI", version: "fixture" }, agentCapabilities: {}, authMethods: [] });
    if (value.method === "session/new") result(value.id, { sessionId: "terminal-session" });
    if (value.method === "session/cancel") result(wire.find(value => value.method === "session/prompt").id, { stopReason: "cancelled" });
    if (value.id === (options.replyWriteError === true ? "create" : options.replyWriteError) && value.result) {
      done(new Error("Fixture reply delivery failed")); return;
    }
    done();
  } });
  const policy = { toolDecisions: { bash: options.policy ?? "ask" }, allowedWritePaths: [cwd] };
  const lifecycle = new AcpJournaledLifecycle({ store, key, target, configuration, now,
    createActions: binding => new KimiActionPreparer({ cwd, sessionId: binding.sessionId, policy,
      terminalShell: { executable: "/bin/bash", platform: "posix" }, ...options.actionOptions }, options.secretRegistry),
    createHostTerminals: context => new KimiHostTerminals(context, { workspaceRoot: cwd,
      policyProfileId: "workspace_write", allowedWritePaths: [cwd], assertUnchanged: options.assertUnchanged }),
    output: { requireAssistantText: false }, secretRegistry: options.secretRegistry, onEvent: event => events.push(event),
    onApprovalWaitChanged: waiting => waits.push(waiting), approvalPollIntervalMs: 5,
    client: { input, output, signal: abort.signal, requestTimeoutMs: 2000, turnTimeoutMs: 10000 } });
  t.after(async () => {
    try {
      lifecycle.close();
      if (options.closeError) await assert.rejects(lifecycle.closed);
      else await lifecycle.closed;
    }
    finally { input.destroy(); output.destroy(); store.close(); await rm(cwd, { recursive: true, force: true }); }
  });
  await lifecycle.open();
  const handle = await lifecycle.startPrompt([{ type: "text", text: "Isolated real command; no native account/model" }]);
  void handle.completed.catch(() => {});
  await until(() => wire.find(value => value.method === "session/prompt"));
  const request = (method, id, params) => send({ jsonrpc: "2.0", method, id, params: { sessionId: "terminal-session", ...params } });
  return { cwd, store, key, run, work, abort, lifecycle, handle, wire, events, waits, update,
    operations: () => [...actionIds].flatMap(id => store.listNativeHostOperations(id)),
    tool: (rawInput = { command }, toolCallId = "1:bash") => update({ sessionUpdate: "tool_call", toolCallId,
      title: "Untrusted display", kind: "execute", status: "in_progress", rawInput }),
    create: (id = "create", extra = {}) => request("terminal/create", id, { command: "/bin/bash", cwd,
      args: ["-c", `cd '${cwd.replaceAll("'", "'\\''")}' && ${command}`],
      env: [{ name: "NO_COLOR", value: "1" }, { name: "TERM", value: "dumb" },
        { name: "GIT_TERMINAL_PROMPT", value: "0" }, { name: "SHELL", value: "/bin/bash" }], ...extra }),
    use: (method, terminalId, id = method) => request(`terminal/${method}`, id, { terminalId }),
    cancelRequest: requestId => send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId } }),
    permission: () => request("session/request_permission", "permission", { toolCall: { toolCallId: "1:bash", title: "Bash" }, options: [
      { optionId: "approve_once", kind: "allow_once", name: "Once" }, { optionId: "approve_always", kind: "allow_always", name: "Session" },
      { optionId: "reject", kind: "reject_once", name: "Reject" }] }),
    approvals: () => store.synchronizeNativeApprovalWait(key, now()).approvals,
    reply: id => wire.find(value => value.id === id && !value.method),
    finish: (toolCallId = "1:bash") => {
      if (toolCallId) update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
      result(wire.find(value => value.method === "session/prompt").id, { stopReason: "end_turn" });
    } };
}

test("Kimi host terminal approves once before real spawn and journals start separately from exit", native, async t => {
  const f = await setup(t);
  f.tool(); f.create();
  const saved = await until(() => f.approvals()[0]);
  assert.equal(saved.approval.status, "pending");
  await assert.rejects(access(join(f.cwd, "result.txt")), { code: "ENOENT" });
  f.store.approveApprovalRequest(saved.approval.id, {}, now());
  const terminalId = (await until(() => f.reply("create"))).result.terminalId;
  const started = f.operations()[0];
  assert.equal(started.status, "claimed"); assert.equal(started.terminal.terminalId, terminalId);
  assert.equal(started.terminal.exit, undefined); assert.equal(started.replyStatus, "written");
  f.use("wait_for_exit", terminalId);
  assert.deepEqual((await until(() => f.reply("wait_for_exit"))).result, { exitCode: 7 });
  f.use("output", terminalId);
  assert.deepEqual((await until(() => f.reply("output"))).result, { output: "live", truncated: false, exitStatus: { exitCode: 7 } });
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "approved");
  assert.equal(f.operations()[0].status, "failed");
  assert.deepEqual(f.operations()[0].terminal.exit, { exitCode: 7, signal: null });
  assert.deepEqual(f.waits, [true, false]);
  assert.equal(f.approvals().length, 1);
  f.use("release", terminalId);
  assert.deepEqual((await until(() => f.reply("release"))).result, {});
  f.finish(); await f.handle.completed;
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "completed");
});

test("denying Kimi terminal approval never starts the command", native, async t => {
  const f = await setup(t); f.tool(); f.create();
  const saved = await until(() => f.approvals()[0]);
  f.store.denyApprovalRequest(saved.approval.id, {}, now());
  assert.ok((await until(() => f.reply("create"))).error);
  assert.deepEqual(f.operations(), []);
  await assert.rejects(access(join(f.cwd, "result.txt")), { code: "ENOENT" });
  f.finish(); await f.handle.completed;
});

for (const nativePermission of [false, true]) test(`Kimi terminal executes once across live secret registration (native=${nativePermission})`, native, async t => {
  const initial = "synthetic-terminal-initial-token";
  const secretRegistry = new NativeSecretRegistry([initial]);
  const f = await setup(t, { command: `./fixture-command ${initial}`, secretRegistry,
    assertUnchanged: () => secretRegistry.register(["synthetic-before-spawn-token"]) });
  f.tool(); if (nativePermission) f.permission(); else f.create();
  const saved = await until(() => f.approvals()[0]);
  assert.equal(JSON.stringify(saved).includes(initial), false);
  secretRegistry.register(["synthetic-terminal-rotated-token"]);
  f.store.approveApprovalRequest(saved.approval.id, {}, now());
  if (nativePermission) { await until(() => f.reply("permission")); f.create(); }
  const created = await until(() => f.reply("create"));
  assert.ok(created.result, JSON.stringify(created.error));
  const terminalId = created.result.terminalId;
  f.use("wait_for_exit", terminalId);
  assert.deepEqual((await until(() => f.reply("wait_for_exit"))).result, { exitCode: 7 });
  secretRegistry.register(["synthetic-after-exit-token"]);
  f.create("duplicate"); assert.ok((await until(() => f.reply("duplicate"))).error);
  assert.equal(f.approvals().length, 1); assert.equal(f.operations().length, 1);
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "approved");
  f.use("release", terminalId); assert.deepEqual((await until(() => f.reply("release"))).result, {});
  f.finish(); await f.handle.completed;
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getNativeApprovalCorrelation(saved.approval.id).replyStatus, "written");
    assert.equal(JSON.stringify(reopened.listApprovalRequests({ runId: "run_host_terminal" })).includes(initial), false);
  } finally { reopened.close(); }
});

test("a native once decision is reused for its terminal but cannot spawn the same action twice", native, async t => {
  const f = await setup(t, { policy: "allow" }); f.tool(); f.permission();
  const saved = await until(() => f.approvals()[0]);
  f.create(); await delay(20);
  assert.equal(f.reply("create"), undefined);
  f.store.approveApprovalRequest(saved.approval.id, {}, now());
  await until(() => f.reply("permission"));
  const terminalId = (await until(() => f.reply("create"))).result.terminalId;
  f.use("wait_for_exit", terminalId); await until(() => f.reply("wait_for_exit"));
  f.create("duplicate"); assert.ok((await until(() => f.reply("duplicate"))).error);
  assert.equal(f.approvals().length, 1); assert.equal(f.operations().length, 1);
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "approved");
  f.finish(); await f.handle.completed;
});

test("a policy-allowed Kimi terminal executes without fabricating an approval", native, async t => {
  const f = await setup(t, { policy: "allow", command: "printf policy" }); f.tool(); f.create();
  const terminalId = (await until(() => f.reply("create"))).result.terminalId;
  f.use("wait_for_exit", terminalId); assert.deepEqual((await until(() => f.reply("wait_for_exit"))).result, { exitCode: 0 });
  assert.deepEqual(f.approvals(), []); assert.deepEqual(f.waits, []);
  f.use("output", terminalId); assert.equal((await until(() => f.reply("output"))).result.output, "policy");
  f.finish(); await f.handle.completed;
});

test("released Kimi terminals reclaim quota for more than 64 sequential commands", { ...native, timeout: 20000 }, async t => {
  const f = await setup(t, { policy: "allow", command: "printf serial" });
  for (let i = 0; i < 66; i++) {
    const toolCallId = `${i}:bash`, createId = `create-${i}`, releaseId = `release-${i}`;
    f.tool({ command: "printf serial" }, toolCallId); f.create(createId);
    const response = await until(() => f.reply(createId));
    assert.ok(response.result, `Command ${i + 1}: ${JSON.stringify(response.error)}`);
    f.use("wait_for_exit", response.result.terminalId, `exit-${i}`);
    assert.deepEqual((await until(() => f.reply(`exit-${i}`))).result, { exitCode: 0 });
    f.use("output", response.result.terminalId, `output-${i}`);
    assert.deepEqual((await until(() => f.reply(`output-${i}`))).result,
      { output: "serial", truncated: false, exitStatus: { exitCode: 0 } });
    f.use("release", response.result.terminalId, releaseId);
    assert.deepEqual((await until(() => f.reply(releaseId))).result, {});
    f.update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
  }
  assert.equal(f.operations().length, 66);
  for (const operation of f.operations()) {
    assert.equal(operation.status, "succeeded");
    assert.deepEqual(operation.terminal.exit, { exitCode: 0, signal: null });
  }
  f.use("output", f.operations()[0].terminal.terminalId, "released-output");
  assert.equal((await until(() => f.reply("released-output"))).error.code, -32002);
  f.finish(null); await f.handle.completed;
});

for (const denied of [true, false]) {
  test(`never-started Kimi terminals reclaim quota after ${denied ? "denial" : "pre-spawn failure"}`, native, async t => {
    const f = await setup(t, { policy: denied ? "ask" : "allow", command: "printf unused",
      assertUnchanged: denied ? undefined : () => { throw new Error("Changed profile"); } });
    for (let i = 0; i < 66; i++) {
      const toolCallId = `${i}:bash`, id = `no-spawn-${i}`;
      f.tool({ command: "printf unused" }, toolCallId); f.create(id);
      if (denied) {
        const approval = await until(() => f.approvals().find(item => item.approval.toolCallId === toolCallId));
        f.store.denyApprovalRequest(approval.approval.id, {}, now());
      }
      assert.ok((await until(() => f.reply(id))).error);
      f.update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
    }
    assert.deepEqual(f.operations(), []);
    f.finish(null); await f.handle.completed;
  });
}

for (const mode of ["policy", "plan", "wrong-command", "wrong-shell", "wrong-env", "ambiguous"]) {
  test(`Kimi terminal ${mode} cannot start or create a permissive approval`, native, async t => {
    const f = await setup(t, { policy: mode === "policy" ? "deny" : "ask", command: "touch forbidden",
      actionOptions: mode === "plan" ? { effectivePolicySnapshot: { conversationMode: "plan" } } : {} });
    f.tool();
    if (mode === "ambiguous") f.tool({ command: "touch forbidden" }, "2:bash");
    f.create("create", mode === "wrong-command" ? { args: ["-c", `cd '${f.cwd}' && touch substituted`] }
      : mode === "wrong-shell" ? { command: "/bin/sh" } : mode === "wrong-env" ? { env: [] } : {});
    assert.ok((await until(() => f.reply("create"))).error);
    assert.deepEqual(f.approvals(), []); assert.deepEqual(f.operations(), []);
    await assert.rejects(access(join(f.cwd, "forbidden")), { code: "ENOENT" });
    if (mode === "ambiguous") f.update({ sessionUpdate: "tool_call_update", toolCallId: "2:bash", status: "failed" });
    f.finish(); await f.handle.completed;
  });
}

test("changed tool revision while Kimi approval waits cannot execute the approved old command", native, async t => {
  const f = await setup(t); f.tool(); f.create();
  const saved = await until(() => f.approvals()[0]);
  f.update({ sessionUpdate: "tool_call_update", toolCallId: "1:bash", rawInput: { command: "touch substituted" } });
  f.store.approveApprovalRequest(saved.approval.id, {}, now());
  assert.ok((await until(() => f.reply("create"))).error);
  assert.deepEqual(f.operations(), []);
  await assert.rejects(access(join(f.cwd, "result.txt")), { code: "ENOENT" });
  f.finish(); await f.handle.completed;
});

test("Kimi terminal checks the execution profile after async platform preparation and before claiming spawn", native, async t => {
  let checks = 0;
  const f = await setup(t, { policy: "allow", assertUnchanged: () => { checks++; throw new Error("profile changed"); } });
  f.tool(); f.create();
  assert.ok((await until(() => f.reply("create"))).error); assert.equal(checks, 1);
  assert.deepEqual(f.operations(), []);
  await assert.rejects(access(join(f.cwd, "result.txt")), { code: "ENOENT" });
  f.finish(); await f.handle.completed;
});

const liveScript = '#!/bin/bash\nprintf "%s" "$$" > pid.txt\nprintf ready\n/bin/sleep 30\n';
test("cancelled Kimi exit waits reclaim request quota without killing the terminal", native, async t => {
  const f = await setup(t, { policy: "allow", script: liveScript }); f.tool(); f.create();
  const terminalId = (await until(() => f.reply("create"))).result.terminalId;
  await live(f, terminalId);
  const pid = Number(await readFile(join(f.cwd, "pid.txt"), "utf8"));
  for (let i = 0; i < 66; i++) {
    const id = `cancel-wait-${i}`;
    f.use("wait_for_exit", terminalId, id);
    await delay(5);
    f.cancelRequest(id);
    assert.equal((await until(() => f.reply(id))).error.code, -32800);
  }
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal(f.operations()[0].terminal.exit, undefined);
  f.use("output", terminalId);
  assert.equal((await until(() => f.reply("output"))).result.output, "ready");
  f.use("kill", terminalId); assert.deepEqual((await until(() => f.reply("kill"))).result, {});
  f.use("wait_for_exit", terminalId, "final-exit");
  assert.deepEqual((await until(() => f.reply("final-exit"))).result, { signal: "SIGKILL" });
  assert.deepEqual(f.operations()[0].terminal.exit, { exitCode: null, signal: "SIGKILL" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  f.use("release", terminalId); assert.deepEqual((await until(() => f.reply("release"))).result, {});
  f.finish(); await f.handle.completed;
});

for (const mode of ["kill", "release", "finish", "cancel", "close"]) {
  test(`Kimi terminal ${mode} reaps the real process and saves exit before ending its submission`, native, async t => {
    const f = await setup(t, { policy: "allow", script: liveScript }); f.tool(); f.create();
    const terminalId = (await until(() => f.reply("create"))).result.terminalId;
    await live(f, terminalId);
    const pid = Number(await readFile(join(f.cwd, "pid.txt"), "utf8"));
    if (mode === "kill" || mode === "release") {
      f.use(mode, terminalId); assert.deepEqual((await until(() => f.reply(mode))).result, {});
      f.finish(); await f.handle.completed;
    } else if (mode === "finish") { f.finish(); await f.handle.completed; }
    else if (mode === "cancel") { await f.handle.cancel(); await f.handle.completed; }
    else { f.lifecycle.close(); await assert.rejects(f.handle.completed); await f.lifecycle.closed; }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(f.operations()[0].terminal.exit, { exitCode: null, signal: "SIGKILL" });
    assert.equal(f.operations()[0].status, "failed");
    assert.equal(f.store.getNativeSubmission(f.key.submissionId).status,
      mode === "close" ? "unknown" : mode === "cancel" ? "cancelled" : "completed");
  });
}

test("failed Kimi create reply preserves an uncertain delivery and reaps its started terminal", native, async t => {
  const f = await setup(t, { policy: "allow", script: liveScript, replyWriteError: true });
  f.tool(); f.create();
  await assert.rejects(f.handle.completed); await f.lifecycle.closed;
  assert.equal(f.operations()[0].replyStatus, "unknown");
  assert.deepEqual(f.operations()[0].terminal.exit, { exitCode: null, signal: "SIGKILL" });
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "unknown");
});

test("failed Kimi release reply does not undo owned cleanup or its observed exit", native, async t => {
  const f = await setup(t, { policy: "allow", script: liveScript, replyWriteError: "release" });
  f.tool(); f.create();
  const terminalId = (await until(() => f.reply("create"))).result.terminalId;
  await live(f, terminalId);
  const pid = Number(await readFile(join(f.cwd, "pid.txt"), "utf8"));
  f.use("release", terminalId);
  await assert.rejects(f.handle.completed); await f.lifecycle.closed;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(f.operations()[0].replyStatus, "written");
  assert.deepEqual(f.operations()[0].terminal.exit, { exitCode: null, signal: "SIGKILL" });
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "unknown");
});

test("Kimi release disposes the real process resources even when exit journaling fails", native, async t => {
  const f = await setup(t, { policy: "allow", closeError: true,
    script: liveScript.replace("printf ready", 'printf "%s" "$HOME" > operation-home.txt\nprintf ready') });
  f.tool(); f.create();
  const terminalId = (await until(() => f.reply("create"))).result.terminalId;
  await live(f, terminalId);
  const pid = Number(await readFile(join(f.cwd, "pid.txt"), "utf8"));
  const operationHome = await readFile(join(f.cwd, "operation-home.txt"), "utf8");
  await access(operationHome);
  f.store.settleNativeHostTerminalExit = () => { throw new Error("Exit journal unavailable"); };
  f.use("release", terminalId);
  assert.ok((await until(() => f.reply("release"))).error);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(access(operationHome), { code: "ENOENT" });
  assert.equal(f.operations()[0].terminal.exit, undefined);
  f.lifecycle.close(); await assert.rejects(f.handle.completed); await assert.rejects(f.lifecycle.closed);
});

test("closing Kimi while terminal approval is pending cannot start a command", native, async t => {
  const f = await setup(t); f.tool(); f.create();
  await until(() => f.approvals()[0]);
  f.lifecycle.close(); await assert.rejects(f.handle.completed); await f.lifecycle.closed;
  assert.deepEqual(f.operations(), []);
  await assert.rejects(access(join(f.cwd, "result.txt")), { code: "ENOENT" });
});

test("a replaced Kimi Attempt cannot write an exit into its replacement but still reaps the owned command", native, async t => {
  const f = await setup(t, { policy: "allow", script: liveScript, closeError: true }); f.tool(); f.create();
  const terminalId = (await until(() => f.reply("create"))).result.terminalId;
  await live(f, terminalId);
  const pid = Number(await readFile(join(f.cwd, "pid.txt"), "utf8"));
  const replacement = f.store.createWorkUnitAttempt({ workUnitId: f.work.id, attemptNumber: 2,
    runnerId: "kimi-acp", runtimeInstanceId: "replacement", now: now() });
  f.lifecycle.close();
  await assert.rejects(f.handle.completed); await assert.rejects(f.lifecycle.closed);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(f.operations()[0].terminal.exit, undefined);
  assert.deepEqual(f.store.getWorkUnitAttempt(replacement.id), replacement);
});
