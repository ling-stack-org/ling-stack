import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { imageFixture, createPng, decodePng, assertFreshPng, assertPixelsClose } from "./support/native-image-fixtures.mjs";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { AcpJournaledLifecycle, acpConfigurationFingerprint } from "../dist/runtime/acp/journaled-lifecycle.js";
import { KimiActionPreparer } from "../dist/runtime/acp/kimi-action-preparation.js";
import { readNativeArtifactContent } from "../dist/runtime/adapters/native-artifact-files.js";
import { NativeSecretRegistry } from "../dist/runtime/adapters/native-stream-redaction.js";

const now = "2026-09-09T01:00:00.000Z";
const prompt = [{ type: "text", text: "Owned fixture; no model or command executes" }];
const tick = () => new Promise(resolve => setImmediate(resolve));
const hostHandler = execute => ({ receive() {}, execute, beforeReply() {}, onReplyOutcome() {} });
const terminalPort = (overrides = {}) => ({
  create: hostHandler(async request => ({ terminalId: request.params.terminalId })),
  output: hostHandler(async () => ({ output: "Running.", truncated: false })),
  waitForExit: hostHandler(async () => ({ exitCode: 0 })), kill: hostHandler(async () => ({})),
  release: hostHandler(async () => ({})), async dispose() {}, ...overrides,
});
const terminalPrompt = (message, peer) => {
  if (message.method === "session/prompt") { peer.message("Owned terminal fixture."); return true; }
};

async function setup(t, options = {}) {
  const target = { engineId: "kimi-acp", expectedVersion: "fixture", ...options.target };
  if (target.engineId === "openclaw-acp" && target.agentId === undefined) target.agentId = "fixture";
  const cwd = await mkdtemp(join(tmpdir(), "ling-acp-lifecycle-"));
  const store = createSqliteRunStore(cwd);
  const abort = new AbortController();
  const channel = store.createChannel({ name: "Native", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Native", prompt: "Synthetic" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "Native", objective: "Synthetic" }, now);
  const run = store.createRun({ id: "run_acp_lifecycle", cwd, taskId: task.id, channelId: channel.id, threadId: thread.id,
    providerName: "native", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const work = store.createWorkUnit({ id: "wu_acp_lifecycle", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
    ownerType: "run", ownerId: run.id, linkedRunId: run.id, runnerId: target.engineId, idempotencyKey: "first",
    createdByActor: "user", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1, runnerId: target.engineId, runtimeInstanceId: "owned", now });
  const fence = toRuntimeAttemptFence(attempt);
  store.linkRunToWorkUnit(run.id, work.id, now);
  store.transitionRunStatus({ runId: run.id, event: "runner_started", actor: "system", now });
  for (const event of ["claim", "runner_started"]) store.transitionWorkUnitStatus({ ...fence, event, actor: "system", now });
  store.updateWorkUnitAttemptStatus({ ...fence, status: "started", now });
  store.updateLingThread(thread.id, { status: "running", activeRunId: run.id, lastRunId: run.id }, now);
  const configuration = { cwd, ...options.configuration };
  const reserved = store.reserveNativeExecution({ runId: run.id, generation: 1, fence, selection: {
    engineId: target.engineId, profileId: "owned", profileRevision: 1, profileFingerprint: "a".repeat(64),
    configurationFingerprint: acpConfigurationFingerprint(target, configuration),
    ...options.selection,
  } }, now);
  const key = { submissionId: reserved.submission.id, fence };
  const output = new PassThrough();
  const wire = [];
  const events = [];
  const waits = [];
  const waiting = Promise.withResolvers();
  const live = Promise.withResolvers();
  const submitted = Promise.withResolvers();
  let promptId;
  const send = (...messages) => output.write(messages.map(message => JSON.stringify(message)).join("\n") + "\n");
  const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
  const update = value => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-session", update: value } });
  const message = text => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const tool = value => update({ sessionUpdate: "tool_call_update", toolCallId: "1:bash", ...value });
  const permission = () => send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: {
    sessionId: "native-session", toolCall: { toolCallId: "1:bash", title: "Bash" }, options: [
      { optionId: "approve_once", kind: "allow_once", name: "Once" },
      { optionId: "approve_always", kind: "allow_always", name: "Session" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ] } });
  const peer = { send, result, update, message, tool, permission, finish: stopReason => result(promptId, { stopReason }) };
  const input = new Writable({ write(bytes, _encoding, done) {
    const value = JSON.parse(bytes.toString()); wire.push(value);
    if (value.method === "session/prompt") { promptId = value.id; submitted.resolve(); }
    if (options.onWire?.(value, peer) !== true) {
      if (value.method === "initialize") result(value.id, { protocolVersion: 1,
        agentInfo: { name: target.engineId === "openclaw-acp" ? "openclaw-acp" : "Kimi Code CLI", version: "fixture" }, agentCapabilities: { loadSession: true }, authMethods: [] });
      if (value.method === "session/new") result(value.id, { sessionId: "native-session" });
      if (value.method === "session/load") result(value.id, {});
      if (value.method === "session/prompt") {
        message("Before approval. ");
        tool({ sessionUpdate: "tool_call", title: "Bash", kind: "execute", status: "in_progress", rawInput: { command: "whois example.com" } });
        permission(); message("Still streaming. ");
      }
      if (value.id === "permission" && value.result?.outcome?.outcome === "selected") {
        setImmediate(() => {
          tool({ status: "completed", content: [{ type: "content", content: { type: "text", text: "Synthetic result" } }] });
          message("Done."); peer.finish("end_turn");
        });
      }
      if (value.method === "session/cancel") { message("Cancelled."); peer.finish("cancelled"); }
    }
    done();
  } });
  let lifecycle;
  t.after(async () => {
    try {
      if (options.closeError) assert.throws(() => lifecycle?.close(), { code: options.closeError });
      else lifecycle?.close();
    } finally {
      try {
        if (options.closedError) await assert.rejects(lifecycle.closed, { code: options.closedError });
        else await lifecycle?.closed;
      } finally { input.destroy(); output.destroy(); store.close(); await rm(cwd, { recursive: true, force: true }); }
    }
  });
  const lifecycleOptions = { store, key, configuration, target, now: options.now ?? (() => now),
    secretRegistry: options.secretRegistry,
    assertCurrent: options.assertCurrent,
    assertResultCurrent: options.assertResultCurrent,
    createHostTerminals: options.createHostTerminals,
    createHostFiles: options.createHostFiles,
    createActions: binding => new KimiActionPreparer({ sessionId: binding.sessionId, cwd,
      policy: { toolDecisions: { bash: options.policy ?? "ask" }, allowedWritePaths: [cwd] } }),
    output: { requireAssistantText: true, ...options.output }, approvalPollIntervalMs: 5,
    onEvent: event => {
      events.push(event);
      assert.ok(store.listEvents(run.id).some(saved => saved.id === event.id), "event published before commit");
      if (event.type === "approval_requested") waiting.resolve(event.data.approvalId);
      if (event.type === "assistant_text_delta" && event.data.text.includes("Still streaming")) live.resolve();
      options.onEvent?.(event);
    }, onApprovalWaitChanged: value => waits.push(value),
    client: { input, output, signal: abort.signal, requestTimeoutMs: 1000, turnTimeoutMs: 2000, cancelTimeoutMs: 100,
      ...options.client } };
  lifecycle = new AcpJournaledLifecycle(lifecycleOptions);
  return { lifecycle, lifecycleOptions, store, run, work, fence, reserved, key, cwd, peer, wire, events, waits, waiting, live, submitted, abort, output,
    request: (id, method, params) => peer.send({ jsonrpc: "2.0", id, method, params }),
    async reply(id) {
      for (let i = 0; i < 100; i++) {
        const response = wire.find(message => message.id === id && !message.method);
        if (response) { await tick(); return response; }
        await tick();
      }
      assert.fail(`No reply for ${id}`);
    },
    async create() {
      await submitted.promise;
      this.request("create", "terminal/create", { sessionId: "native-session", command: "owned-fixture", cwd });
      return (await this.reply("create")).result.terminalId;
    },
  };
}

test("ACP rejects invalidated host credentials after initialize before creating a native session", async t => {
  let current = true;
  const f = await setup(t, {
    assertCurrent() { if (!current) throw new Error("engine_secret_changed"); },
    onWire(value, peer) {
      if (value.method !== "initialize") return;
      current = false;
      peer.result(value.id, { protocolVersion: 1,
        agentInfo: { name: "Kimi Code CLI", version: "fixture" },
        agentCapabilities: { loadSession: true }, authMethods: [] });
      return true;
    },
  });

  await assert.rejects(f.lifecycle.open(), { message: "engine_secret_changed" });

  assert.deepEqual(f.wire.map(value => value.method), ["initialize"]);
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "not_submitted");
  assert.equal(f.events.length, 0);
});

test("ACP lifecycle preserves live redaction through streaming, artifacts and SQLite reopen", { timeout: 6000 }, async t => {
  const secretRegistry = new NativeSecretRegistry(["initial phrase"]);
  const delivered = Promise.withResolvers();
  const f = await setup(t, { secretRegistry, output: { extraSecrets: ["static-credential"] },
    onWire(value, peer) {
      if (value.method === "session/prompt") { peer.message("Before initial ph"); return true; }
    },
    onEvent(event) { if (event.type === "assistant_text_delta") delivered.resolve(); },
  });
  await f.lifecycle.open();
  const active = await f.lifecycle.startPrompt(prompt);
  await delivered.promise;
  secretRegistry.register(["rotated-access", "rotated-refresh"]);
  f.peer.message("rase; rotated-access; static-credential. ");
  f.peer.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "rotated-refresh " } });
  f.peer.update({ sessionUpdate: "tool_call", toolCallId: "report", title: "Report", kind: "read", status: "completed",
    content: [{ type: "content", content: { type: "resource", resource: { uri: "file:///never-read-report",
      text: "rotated-access rotated-refresh static-credential" } } }] });
  f.peer.finish("end_turn");
  assert.equal((await active.completed).stopReason, "end_turn");
  f.lifecycle.close(); await f.lifecycle.closed;
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getNativeSubmission(f.key.submissionId).status, "completed");
    const events = reopened.listEvents(f.run.id);
    const text = events.filter(event => event.type === "assistant_text_delta").map(event => event.data.text).join("");
    assert.equal(text, "Before [REDACTED]; [REDACTED]; [REDACTED]. ");
    assert.equal(events.find(event => event.type === "message_end").data.text, text);
    for (const secret of ["initial phrase", "rotated-access", "rotated-refresh", "static-credential"]) {
      assert.equal(JSON.stringify(events).includes(secret), false, secret);
      assert.equal(JSON.stringify(f.events).includes(secret), false, secret);
    }
    const artifacts = reopened.listArtifacts(f.run.id);
    assert.equal(artifacts.length, 1);
    assert.equal(readNativeArtifactContent(reopened.paths.artifactsDir, artifacts[0]).toString(), "[REDACTED] [REDACTED] [REDACTED]");
    assert.deepEqual(reopened.listApprovalRequests({}), []);
  } finally { reopened.close(); }
});

test("ACP journaled terminal factory receives the bound session and advertises its complete host port", async t => {
  let context;
  const f = await setup(t, { createHostTerminals: value => {
    context = value;
    return terminalPort();
  } });
  await f.lifecycle.open();
  assert.equal(f.wire[0].params.clientCapabilities.terminal, true);
  assert.equal(context.sessionId, "native-session");
  assert.equal(context.store, f.store);
  assert.deepEqual(context.key, f.key);
  assert.equal(context.now(), now);
  assert.ok(context.actions instanceof KimiActionPreparer);
  assert.equal(typeof context.findNativeApproval, "function");
  assert.equal(typeof context.waitForApproval, "function");
  assert.equal(f.store.getNativeExecutionBinding(f.reserved.binding.id).nativeSessionId, "native-session");
});

test("ACP journaled lifecycle leaves terminal capability absent without a factory", async t => {
  const f = await setup(t, { onWire: terminalPrompt });
  await f.lifecycle.open();
  const active = await f.lifecycle.startPrompt(prompt);
  assert.deepEqual(f.wire[0].params.clientCapabilities, {});
  f.request("unsupported", "terminal/create", { sessionId: "native-session", command: "owned-fixture", cwd: f.cwd });
  assert.equal((await f.reply("unsupported")).error.code, -32601);
  f.peer.finish("end_turn"); await active.completed;
});

test("ACP journaled factory preserves every terminal request and reply hook with the file action context", async t => {
  const calls = [], disposed = [], contexts = [];
  let terminalContext;
  const port = terminalPort({ dispose: async id => { disposed.push(id); } });
  for (const [name, handler] of Object.entries(port).filter(([name]) => name !== "dispose")) {
    const execute = handler.execute;
    for (const phase of ["receive", "beforeReply", "onReplyOutcome"]) handler[phase] = function(value, signal) {
      assert.equal(this, handler);
      if (signal) assert.equal(signal.aborted, false);
      calls.push({ name, phase, value });
    };
    handler.execute = async function(request, signal) {
      assert.equal(this, handler); assert.equal(signal.aborted, false);
      calls.push({ name, phase: "execute", value: request });
      return execute(request, signal);
    };
  }
  const f = await setup(t, { onWire: terminalPrompt,
    createHostFiles: { readTextFile: context => { contexts.push(context); return hostHandler(async () => ({ content: "File text." })); } },
    createHostTerminals: context => { terminalContext = context; contexts.push(context); return port; },
  });
  await f.lifecycle.open();
  assert.equal(contexts.length, 2); assert.equal(contexts[0], contexts[1]);
  assert.deepEqual(f.wire[0].params.clientCapabilities, { terminal: true, fs: { readTextFile: true, writeTextFile: false } });
  const active = await f.lifecycle.startPrompt(prompt);
  const terminalId = await f.create();
  assert.match(terminalId, /^[0-9a-f-]{36}$/);
  const params = { sessionId: "native-session", terminalId };
  for (const [name, method, expected] of [["output", "output", { output: "Running.", truncated: false }],
    ["waitForExit", "wait_for_exit", { exitCode: 0 }], ["kill", "kill", {}], ["release", "release", {}]]) {
    f.request(name, `terminal/${method}`, params);
    assert.deepEqual((await f.reply(name)).result, expected);
  }
  for (const name of ["create", "output", "waitForExit", "kill", "release"]) {
    const steps = calls.filter(call => call.name === name);
    assert.deepEqual(steps.map(call => call.phase), ["receive", "execute", "beforeReply", "onReplyOutcome"]);
    for (const call of steps.slice(0, 3)) {
      assert.equal(call.value.requestId, name); assert.equal(call.value.params.terminalId, terminalId);
      assert.equal(call.value.params.sessionId, terminalContext.sessionId);
    }
    assert.equal(steps[3].value.requestId, name); assert.equal(steps[3].value.outcome, "written");
  }
  f.request("file", "fs/read_text_file", { sessionId: "native-session", path: join(f.cwd, "owned.txt") });
  assert.deepEqual((await f.reply("file")).result, { content: "File text." });
  f.peer.finish("end_turn"); await active.completed;
  assert.deepEqual(disposed, [terminalId]);
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "completed");
});

for (const missing of ["create", "output", "waitForExit", "kill", "release", "dispose", "receive"]) {
  test(`ACP journaled incomplete terminal factory (${missing}) rejects before prompt submission`, async t => {
    const port = terminalPort();
    if (missing === "receive") port.create.receive = undefined;
    else port[missing] = undefined;
    const f = await setup(t, { createHostTerminals: () => port });
    await assert.rejects(f.lifecycle.open(), { code: "invalid_input" });
    await assert.rejects(f.lifecycle.startPrompt(prompt), { code: "invalid_state" });
    assert.equal(f.wire.some(message => message.method === "session/prompt"), false);
    assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "not_submitted");
  });
}

test("ACP journaled terminal factory and methods cannot be replaced after their ownership is captured", async t => {
  let created = 0, disposed = 0;
  const port = terminalPort({ create: hostHandler(async request => { created++; return { terminalId: request.params.terminalId }; }),
    dispose: async () => { disposed++; } });
  const f = await setup(t, { onWire: terminalPrompt, createHostTerminals: () => port });
  f.lifecycleOptions.createHostTerminals = () => { throw new Error("replacement factory"); };
  await f.lifecycle.open();
  port.create.execute = async () => { throw new Error("replacement execute"); };
  port.output = hostHandler(async () => ({ output: "replacement output", truncated: false }));
  port.dispose = async () => { throw new Error("replacement dispose"); };
  const active = await f.lifecycle.startPrompt(prompt), terminalId = await f.create();
  f.request("output", "terminal/output", { sessionId: "native-session", terminalId });
  assert.equal((await f.reply("output")).result.output, "Running.");
  f.peer.finish("end_turn"); await active.completed;
  assert.equal(created, 1); assert.equal(disposed, 1);
});

test("ACP journaled terminal error replies preserve their pre-write hook and safe outcome", async t => {
  const codes = [], outcomes = [];
  const f = await setup(t, { onWire: terminalPrompt, createHostTerminals: () => terminalPort({ create: {
    ...hostHandler(async () => { throw new RequestError(-32000, "private failure"); }),
    beforeErrorReply(request, code) { codes.push({ requestId: request.requestId, code }); },
    onReplyOutcome(value) { outcomes.push(value); },
  } }) });
  await f.lifecycle.open(); const active = await f.lifecycle.startPrompt(prompt);
  await f.submitted.promise;
  f.request("create", "terminal/create", { sessionId: "native-session", command: "owned-fixture", cwd: f.cwd });
  const response = await f.reply("create");
  assert.equal(response.error.code, -32000); assert.equal(JSON.stringify(response).includes("private failure"), false);
  assert.deepEqual(codes, [{ requestId: "create", code: -32000 }]);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].outcome, "written");
  f.peer.finish("end_turn"); await active.completed;
});

for (const ending of ["finish", "cancel", "close"]) test(`ACP journaled ${ending} preserves the terminal exit journal until owned cleanup settles`, async t => {
  let context, action, operation, terminalId, disposed = 0;
  const f = await setup(t, { onWire: terminalPrompt, createHostTerminals: value => {
    context = value;
    return terminalPort({ create: {
      receive(request) {
        terminalId = request.params.terminalId;
        action = context.store.reserveNativeHostAction({ ...context.key, nativeSessionId: context.sessionId,
          toolCallId: "synthetic-terminal", actionFingerprint: "b".repeat(64), policyFingerprint: "c".repeat(64),
          methods: ["terminal/create"], authorization: { kind: "policy" } }, now).action;
      },
      async execute(request) {
        operation = context.store.claimNativeHostOperation({ actionId: action.id, fence: context.key.fence, step: 0,
          requestId: request.requestId, operationFingerprint: "d".repeat(64), actionFingerprint: action.actionFingerprint,
          policyFingerprint: action.policyFingerprint }, now);
        context.store.recordNativeHostTerminalStart({ operationId: operation.id, fence: context.key.fence, terminalId }, now);
        return { terminalId };
      },
      beforeReply() { context.store.assertNativeHostTerminalReply({ operationId: operation.id,
        fence: context.key.fence, terminalId, kind: "create" }, now); },
      onReplyOutcome(observation) { context.store.observeNativeHostOperationReply({ operationId: operation.id,
        fence: context.key.fence, requestId: observation.requestId, method: observation.method, outcome: observation.outcome }, now); },
    }, async dispose() {
      disposed++; await tick();
      assert.equal(context.store.getNativeSubmission(context.key.submissionId).status, "accepted");
      context.store.settleNativeHostTerminalExit({ operationId: operation.id, fence: context.key.fence,
        terminalId, exit: { exitCode: null, signal: "SIGKILL" } }, now);
    } });
  } });
  await f.lifecycle.open();
  const active = await f.lifecycle.startPrompt(prompt); await f.create();
  const closed = f.lifecycle.closed;
  if (ending === "finish") { f.peer.finish("end_turn"); await active.completed; }
  if (ending === "cancel") { await active.cancel(); await active.completed; }
  f.lifecycle.close(); f.lifecycle.close();
  await closed;
  if (ending === "close") await assert.rejects(active.completed, { code: "cancelled" });
  assert.equal(disposed, 1);
  const [ended] = f.store.listNativeHostOperations(action.id);
  assert.equal(ended.status, "failed");
  assert.deepEqual(ended.terminal.exit, { exitCode: null, signal: "SIGKILL" });
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, { finish: "completed", cancel: "cancelled", close: "unknown" }[ending]);
  assert.equal(f.events.some(event => event.type === "turn_end"), ending !== "close");
});

test("ACP terminal close cannot retire a replacement Attempt or hide its journal ownership error", async t => {
  let disposed = 0;
  const f = await setup(t, { onWire: terminalPrompt, closedError: "native_owner_mismatch",
    createHostTerminals: () => terminalPort({ async dispose() { await tick(); disposed++; } }),
  });
  await f.lifecycle.open();
  const active = await f.lifecycle.startPrompt(prompt); await f.create();
  const replacement = f.store.createWorkUnitAttempt({ workUnitId: f.work.id, attemptNumber: 2,
    runtimeInstanceId: "replacement", runnerId: "kimi-acp", now });
  const closed = f.lifecycle.closed;
  f.lifecycle.close(); f.lifecycle.close();
  await assert.rejects(closed, { code: "native_owner_mismatch" });
  await assert.rejects(active.completed, { code: "native_owner_mismatch" });
  assert.equal(disposed, 1);
  assert.equal(f.store.getWorkUnitAttempt(replacement.id).status, replacement.status);
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "accepted");
  assert.equal(f.events.some(event => event.type === "turn_end" || event.type === "message_end"), false);
});

for (const ending of ["finish", "cancel", "close"]) test(`ACP journaled ${ending} waits for its terminal cleanup`, async t => {
  const cleaning = Promise.withResolvers(), allow = Promise.withResolvers();
  let disposed = 0;
  const f = await setup(t, { onWire: terminalPrompt, createHostTerminals: () => terminalPort({
    dispose: async () => { disposed++; cleaning.resolve(); await allow.promise; },
  }) });
  t.after(() => allow.resolve());
  await f.lifecycle.open(); const active = await f.lifecycle.startPrompt(prompt); await f.create();
  let settled = false;
  const completion = active.completed.finally(() => { settled = true; });
  const observed = ending === "close" ? assert.rejects(completion, { code: "cancelled" }) : completion;
  if (ending === "finish") f.peer.finish("end_turn");
  if (ending === "cancel") await active.cancel();
  if (ending === "close") f.lifecycle.close();
  await cleaning.promise; await tick();
  try { assert.equal(settled, false, "prompt cannot settle before its owned cleanup"); }
  finally { allow.resolve(); }
  await observed; f.lifecycle.close(); await f.lifecycle.closed;
  assert.equal(disposed, 1);
  assert.equal(f.events.some(event => event.type === "turn_end"), ending !== "close");
});

for (const ending of ["finish", "close"]) test(`ACP journaled ${ending} terminal cleanup failure rejects completion and suppresses successful output`, async t => {
  const f = await setup(t, { onWire: terminalPrompt, closedError: "host_cleanup_failed",
    createHostTerminals: () => terminalPort({ dispose: async () => { throw new Error("private cleanup failure"); } }),
  });
  await f.lifecycle.open(); const active = await f.lifecycle.startPrompt(prompt); await f.create();
  if (ending === "finish") f.peer.finish("end_turn");
  else f.lifecycle.close();
  await assert.rejects(active.completed, { code: "host_cleanup_failed" });
  await assert.rejects(f.lifecycle.closed, { code: "host_cleanup_failed" });
  assert.equal(f.events.some(event => event.type === "turn_end" || event.type === "message_end"), false);
  assert.equal(JSON.stringify(f.events).includes("private cleanup failure"), false);
});

test("ACP journaled lifecycle binds and actually negotiates the selected model before prompt submission", async t => {
  const models = currentValue => [{ id: "model", name: "Model", category: "model", type: "select", currentValue,
    options: [{ value: "first", name: "First" }, { value: "selected", name: "Selected" }] }];
  const f = await setup(t, { selection: { modelId: "selected" }, configuration: { modelId: "selected" }, onWire: (message, peer) => {
    if (message.method === "session/new") { peer.result(message.id, { sessionId: "native-session", configOptions: models("first") }); return true; }
    if (message.method === "session/set_config_option") { peer.result(message.id, { configOptions: models("selected") }); return true; }
    if (message.method === "session/prompt") { peer.message("Done."); peer.finish("end_turn"); return true; }
  } });
  await f.lifecycle.open();
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "reserved");
  assert.equal(f.store.getNativeExecutionBinding(f.reserved.binding.id).selection.modelId, "selected");
  assert.deepEqual(f.wire.find(message => message.method === "session/set_config_option").params,
    { sessionId: "native-session", configId: "model", value: "selected" });
  await (await f.lifecycle.startPrompt(prompt)).completed;
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "completed");
});

test("ACP configuration fingerprint distinguishes model, mode and thought level", () => {
  const target = { engineId: "kimi-acp", expectedVersion: "fixture" };
  const configuration = { cwd: "/tmp/owned" };
  const original = acpConfigurationFingerprint(target, configuration);
  assert.equal(original, "fa3880c8b623f64f6c3290244d732fb8f48d7b1d451d42d2059362fd550ed6e0", "cwd-only fingerprints remain compatible");
  for (const patch of [{ modelId: "selected" }, { modeId: "plan" }, { thoughtLevel: "high" }]) {
    assert.notEqual(acpConfigurationFingerprint(target, { ...configuration, ...patch }), original);
  }
  assert.equal(acpConfigurationFingerprint(target, { thoughtLevel: "high", modelId: "selected", ...configuration }),
    acpConfigurationFingerprint(target, { ...configuration, modelId: "selected", thoughtLevel: "high" }));
});

test("Kimi tool constraints bind the native identity and cannot leak into OpenClaw configuration", () => {
  const target = { engineId: "kimi-acp", expectedVersion: "fixture" }, configuration = { cwd: "/tmp/owned" };
  assert.notEqual(acpConfigurationFingerprint(target, configuration), acpConfigurationFingerprint(target, { ...configuration, allowedTools: [] }));
  assert.notEqual(acpConfigurationFingerprint(target, { ...configuration, allowedTools: [] }),
    acpConfigurationFingerprint(target, { ...configuration, allowedTools: ["read"] }));
  assert.equal(acpConfigurationFingerprint(target, { ...configuration, allowedTools: ["read", "bash"] }),
    acpConfigurationFingerprint(target, { ...configuration, allowedTools: ["bash", "read"] }));
  assert.throws(() => acpConfigurationFingerprint({ engineId: "openclaw-acp", expectedVersion: "fixture", agentId: "main" },
    { ...configuration, allowedTools: [] }), { code: "unsupported_capability" });
});

test("unavailable selected model settles the reserved attempt as not submitted without binding a native session", async t => {
  const f = await setup(t, { selection: { modelId: "missing" }, configuration: { modelId: "missing" } });
  await assert.rejects(f.lifecycle.open(), { code: "unsupported_capability" });
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "not_submitted");
  assert.equal(f.store.getNativeExecutionBinding(f.reserved.binding.id).nativeSessionId, undefined);
  assert.equal(f.wire.some(message => message.method === "session/prompt"), false);
});

test("ACP journaled prompt streams and waits for a persisted human approval", { timeout: 5000 }, async t => {
  const f = await setup(t);
  await f.lifecycle.open();
  const handle = await f.lifecycle.startPrompt(prompt);
  const approvalId = await f.waiting.promise; await f.live.promise;
  assert.equal(f.store.getRun(f.run.id).status, "waiting_for_approval");
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "accepted");
  assert.equal(f.store.getApprovalRequest(approvalId).payload.command, "whois example.com");
  assert.equal(f.wire.some(message => message.id === "permission"), false);
  f.store.approveApprovalRequest(approvalId, {}, now);
  assert.equal((await handle.completed).stopReason, "end_turn");
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "completed");
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).nativePromptRequestId, f.wire.find(message => message.method === "session/prompt").id);
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).nativeTurnId, undefined);
  assert.equal(f.store.getNativeApprovalCorrelation(approvalId).replyStatus, "written");
  assert.deepEqual(f.waits, [true, false]);
  assert.deepEqual(f.events.map(event => event.id), f.store.listEvents(f.run.id).map(event => event.id));
  assert.equal(f.events.filter(event => event.type === "assistant_text_delta").map(event => event.data.text).join(""), "Before approval. Still streaming. Done.");
  assert.equal(f.events.filter(event => event.type === "message_end").length, 1);
  assert.equal(f.events.at(-1).type, "turn_end");
  await assert.rejects(f.lifecycle.startPrompt(prompt), { code: "invalid_state" });
});

test("ACP rejected asynchronous result credentials leave the accepted submission unknown", async t => {
  const f = await setup(t, {
    async assertResultCurrent() { await tick(); throw new Error("engine_secret_changed"); },
    onWire(value, peer) {
      if (value.method !== "session/prompt") return;
      peer.message("Native finished."); peer.finish("end_turn"); return true;
    },
  });
  await f.lifecycle.open();

  await assert.rejects((await f.lifecycle.startPrompt(prompt)).completed, { message: "engine_secret_changed" });

  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getNativeSubmission(f.key.submissionId).status, "unknown");
    assert.equal(reopened.listEvents(f.run.id).some(event => event.type === "turn_end"), false);
  } finally { reopened.close(); }
  assert.equal(f.events.some(event => event.type === "turn_end"), false);
  assert.equal(f.wire.filter(value => value.method === "session/prompt").length, 1);
});

for (const terminals of [false, true]) test(`ACP close during pending result validation cannot publish completion (terminals=${terminals})`,
  { timeout: 5000 }, async t => {
    const validating = Promise.withResolvers(), validation = Promise.withResolvers();
    const f = await setup(t, {
      createHostTerminals: terminals ? () => terminalPort() : undefined,
      async assertResultCurrent() { validating.resolve(); await validation.promise; },
      onWire(value, peer) {
        if (value.method !== "session/prompt") return;
        peer.message("Native finished."); peer.finish("end_turn"); return true;
      },
    });
    await f.lifecycle.open();
    const handle = await f.lifecycle.startPrompt(prompt);
    await validating.promise;
    try {
      f.lifecycle.close();
      await f.lifecycle.closed;
      assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "unknown");
    } finally {
      validation.reject(new Error("engine_secret_changed"));
      await assert.rejects(handle.completed, { message: "engine_secret_changed" });
    }
    const reopened = createSqliteRunStore(f.cwd);
    try {
      assert.equal(reopened.getNativeSubmission(f.key.submissionId).status, "unknown");
      assert.equal(reopened.listEvents(f.run.id).some(event => event.type === "turn_end"), false);
    } finally { reopened.close(); }
    assert.equal(f.events.some(event => event.type === "turn_end"), false);
    assert.equal(f.wire.filter(value => value.method === "session/prompt").length, 1);
  });

test("ACP ownership invalidated during result validation cannot be restored by failure settlement", async t => {
  let current = true;
  const f = await setup(t, {
    assertCurrent() { if (!current) throw new Error("engine_secret_changed"); },
    async assertResultCurrent() { await tick(); current = false; },
    onWire(value, peer) {
      if (value.method !== "session/prompt") return;
      peer.message("Native finished."); peer.finish("end_turn"); return true;
    },
  });
  await f.lifecycle.open();

  await assert.rejects((await f.lifecycle.startPrompt(prompt)).completed, { message: "engine_secret_changed" });

  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getNativeSubmission(f.key.submissionId).status, "unknown");
    assert.equal(reopened.listEvents(f.run.id).some(event => event.type === "turn_end"), false);
  } finally { reopened.close(); }
  assert.equal(f.events.some(event => event.type === "turn_end"), false);
  assert.equal(f.wire.filter(value => value.method === "session/prompt").length, 1);
});

test("ACP later successful result validation cannot resurrect a submission closed while validation was pending", { timeout: 5000 }, async t => {
  const validating = Promise.withResolvers(), validation = Promise.withResolvers();
  const f = await setup(t, {
    async assertResultCurrent() { validating.resolve(); await validation.promise; },
    onWire(value, peer) {
      if (value.method !== "session/prompt") return;
      peer.message("Native finished."); peer.finish("end_turn"); return true;
    },
  });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startPrompt(prompt);
  await validating.promise;
  f.lifecycle.close();
  await f.lifecycle.closed;
  validation.resolve();
  await assert.rejects(handle.completed);
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "unknown");
  assert.equal(f.store.listEvents(f.run.id).some(event => event.type === "turn_end"), false);
  assert.equal(f.wire.filter(value => value.method === "session/prompt").length, 1);
});

test("ACP close freezes pending result authority before deferred terminal close settlement", { timeout: 5000 }, async t => {
  const validating = Promise.withResolvers(), validation = Promise.withResolvers();
  const f = await setup(t, {
    createHostTerminals: () => terminalPort(),
    async assertResultCurrent() { validating.resolve(); await validation.promise; },
    onWire(value, peer) {
      if (value.method !== "session/prompt") return;
      peer.message("Native finished."); peer.finish("end_turn"); return true;
    },
  });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startPrompt(prompt);
  await validating.promise;
  f.lifecycle.close();
  validation.resolve();
  await assert.rejects(handle.completed, { code: "invalid_state" });
  await f.lifecycle.closed;
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getNativeSubmission(f.key.submissionId).status, "unknown");
    assert.equal(reopened.listEvents(f.run.id).some(event => event.type === "turn_end"), false);
  } finally { reopened.close(); }
  assert.equal(f.wire.filter(value => value.method === "session/prompt").length, 1);
});

test("ACP verified async result remains committed when its terminal observer fails", async t => {
  let verified = false;
  const f = await setup(t, {
    async assertResultCurrent() { await tick(); verified = true; },
    onWire(value, peer) {
      if (value.method !== "session/prompt") return;
      peer.message("Native finished."); peer.finish("end_turn"); return true;
    },
    onEvent(event) {
      if (event.type === "turn_end") { assert.equal(verified, true); throw new Error("private observer failure"); }
    },
  });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startPrompt(prompt)).completed, { message: "private observer failure" });
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "completed");
  assert.equal(f.store.listEvents(f.run.id).filter(event => event.type === "turn_end").length, 1);
});

for (const failedEvent of ["assistant_text_delta", "turn_start"]) test(`ACP native terminal evidence survives a failed ${failedEvent} observer`, { timeout: 5000 }, async t => {
  const f = await setup(t, { onEvent: event => {
    if (event.type === failedEvent) throw new Error("private observer failure");
  }, onWire: (message, peer) => {
    if (message.method !== "session/prompt") return;
    if (failedEvent === "turn_start") { peer.finish("end_turn"); return true; }
    peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-session", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done. " } } } },
    { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return true;
  } });
  await f.lifecycle.open();
  await assert.rejects(async () => { await (await f.lifecycle.startPrompt(prompt)).completed; }, { code: "host_commit_failed" });
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "completed");
  assert.equal(f.events.some(event => event.type === "turn_end"), false);
});

for (const stopReason of ["end_turn", "cancelled"]) for (const effect of ["claimed", "unknown"]) {
  test(`ACP ${stopReason} with a ${effect} host effect remains durably unknown`, { timeout: 5000 }, async t => {
    const accepted = Promise.withResolvers();
    const f = await setup(t, { onWire: (message, peer) => {
      if (message.method === "session/prompt") { peer.message("Native started."); return true; }
    },
      onEvent: event => { if (event.type === "turn_start") accepted.resolve(); } });
    await f.lifecycle.open();
    const handle = await f.lifecycle.startPrompt(prompt);
    await accepted.promise;
    const identity = { actionFingerprint: "b".repeat(64), policyFingerprint: "c".repeat(64) };
    const action = f.store.reserveNativeHostAction({ ...f.key, ...identity, nativeSessionId: "native-session",
      toolCallId: "write-file", methods: ["fs/write_text_file"], authorization: { kind: "policy" } }, now).action;
    const operation = f.store.claimNativeHostOperation({ actionId: action.id, fence: f.fence, ...identity,
      step: 0, requestId: "write-rpc", operationFingerprint: "d".repeat(64) }, now);
    if (effect === "unknown") f.store.settleNativeHostOperation({ operationId: operation.id, fence: f.fence, outcome: "unknown" }, now);
    f.peer.message("Native finished.");
    f.peer.finish(stopReason);
    await assert.rejects(handle.completed, { code: "native_host_effect_unresolved" });
    const reopened = createSqliteRunStore(f.cwd);
    try {
      assert.equal(reopened.getNativeSubmission(f.key.submissionId).status, "unknown");
      assert.equal(reopened.getNativeHostAction(action.id).status, "unknown");
      assert.equal(reopened.listNativeHostOperations(action.id)[0].status, "unknown");
      assert.equal(reopened.listEvents(f.run.id).some(event => event.type === "turn_end" || event.type === "message_end"), false);
      assert.throws(() => reopened.beginNativeSubmission({ ...f.key, nativePromptRequestId: 99 }, now), { code: "native_submission_conflict" });
      assert.equal(reopened.listUnresolvedNativeSubmissions().find(item => item.id === f.key.submissionId).status, "unknown");
    } finally { reopened.close(); }
    assert.equal(f.events.some(event => event.type === "turn_end"), false);
    assert.equal(f.wire.filter(message => message.method === "session/prompt").length, 1);
  });
}

for (const decision of ["deny", "cancel", "disconnect", "expire"]) test(`ACP journaled ${decision} never sends a grant`, { timeout: 5000 }, async t => {
  let clock = now;
  const f = await setup(t, { now: () => clock });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startPrompt(prompt);
  const approvalId = await f.waiting.promise; await f.live.promise;
  if (decision === "deny") f.store.denyApprovalRequest(approvalId, {}, now);
  if (decision === "cancel") await handle.cancel();
  if (decision === "disconnect") f.output.destroy();
  if (decision === "expire") clock = "2026-09-09T01:06:00.000Z";
  if (decision === "disconnect" || decision === "expire") await assert.rejects(handle.completed);
  else assert.equal((await handle.completed).stopReason, decision === "cancel" ? "cancelled" : "end_turn");
  assert.equal(f.wire.some(message => message.result?.outcome?.optionId === "approve_once"), false);
  assert.equal(f.store.getApprovalRequest(approvalId).status, decision === "deny" ? "denied" : decision === "expire" ? "expired" : "cancelled");
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status,
    decision === "deny" ? "completed" : decision === "cancel" ? "cancelled" : "unknown");
  assert.equal(f.store.getNativeApprovalCorrelation(approvalId).replyStatus, decision === "deny" ? "written" : "not_written");
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getNativeSubmission(f.key.submissionId).status, f.store.getNativeSubmission(f.key.submissionId).status);
    assert.throws(() => reopened.beginNativeSubmission({ ...f.key, nativePromptRequestId: 77 }, now));
  } finally { reopened.close(); }
  assert.deepEqual(f.waits, [true, false]);
  assert.throws(() => new AcpJournaledLifecycle(f.lifecycleOptions), { code: "invalid_state" });
});

test("ACP target policy denial does not create a human approval or override bash=deny", { timeout: 5000 }, async t => {
  const f = await setup(t, { policy: "deny" });
  await f.lifecycle.open(); await (await f.lifecycle.startPrompt(prompt)).completed;
  assert.equal(f.wire.find(message => message.id === "permission").result.outcome.optionId, "reject");
  assert.equal(f.events.some(event => event.type === "approval_requested"), false);
  assert.deepEqual(f.waits, []);
});

test("ACP empty successful output is incompatible but preserves the native completed outcome", { timeout: 5000 }, async t => {
  const f = await setup(t, { onWire: (message, peer) => {
    if (message.method === "session/prompt") { peer.finish("end_turn"); return true; }
  } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startPrompt(prompt)).completed, { code: "empty_output" });
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "completed");
  assert.equal(f.events.some(event => event.type === "turn_end"), false);
});

test("ACP assistant attachments survive SQLite reopen and serving with no invented tool activity", { timeout: 5000 }, async t => {
  const png = imageFixture("png");
  const f = await setup(t, { output: { extraSecrets: ["fixture-secret"] }, onWire: (message, peer) => {
    if (message.method !== "session/prompt") return;
    peer.message("Attachments. ");
    for (const content of [
      { type: "image", mimeType: "image/png", data: png.toString("base64"), annotations: null, uri: null },
      { type: "resource", resource: { uri: "file:///not-authorized-to-read.txt", text: "Report fixture-secret", mimeType: null } },
      { type: "resource_link", uri: "https://127.0.0.1:1/never-fetch", name: "Reference", title: null },
    ]) peer.update({ sessionUpdate: "agent_message_chunk", content });
    peer.message("Done."); peer.finish("end_turn"); return true;
  } });
  await f.lifecycle.open();
  await (await f.lifecycle.startPrompt(prompt)).completed;
  const reopened = createSqliteRunStore(f.cwd);
  try {
    const artifacts = reopened.listArtifacts(f.run.id);
    assert.equal(artifacts.length, 2);
    const picture = artifacts.find(item => item.type === "image");
    const pixels = readNativeArtifactContent(reopened.paths.artifactsDir, picture);
    assertPixelsClose(decodePng(pixels).data.subarray(0, 4), [224, 59, 82, 255], 1, "sRGB reference");
    assertFreshPng(pixels);
    const report = artifacts.find(item => item.type === "file");
    assert.equal(readNativeArtifactContent(reopened.paths.artifactsDir, report).toString(), "Report [REDACTED]");
    const events = reopened.listEvents(f.run.id);
    assert.equal(events.some(event => event.type.startsWith("tool_")), false);
    const publications = events.filter(event => event.type === "artifact_created");
    assert.equal(publications.length, 2);
    assert.deepEqual(publications.map(event => event.data.itemId), ["assistant-content-1", "assistant-content-2"]);
    assert.ok(publications.every(event => event.data.role === "assistant" && !event.data.toolName && !event.data.toolCallId));
    assert.ok(artifacts.every(item => item.sealedPayload.nativeArtifact.sourceKind === "assistant"));
    const outputs = events.filter(event => event.data.nativeKind === "assistant_content");
    assert.equal(outputs[2].data.content[0].uri, "https://127.0.0.1:1/never-fetch");
    assert.deepEqual(events.find(event => event.type === "message_end").data.contentKinds, ["text", "image", "resource", "resource_link"]);
    assert.equal(JSON.stringify(events).includes(png.toString("base64")), false);
    assert.equal(JSON.stringify(events).includes("fixture-secret"), false);
  } finally { reopened.close(); }
});

test("ACP returned tool image and text bytes become owned artifacts without fetching native paths", { timeout: 5000 }, async t => {
  const png = createPng({ width: 2, height: 2, color: [255, 0, 0, 255] });
  const f = await setup(t, { output: { extraSecrets: ["fixture-secret"] }, onWire: (message, peer) => {
    if (message.id !== "permission" || !message.result) return;
    peer.tool({ status: "completed", content: [
      { type: "content", content: { type: "image", mimeType: "image/png", data: png.toString("base64") } },
      { type: "content", content: { type: "resource", resource: { uri: "file:///not-authorized-to-read.txt", text: "Report fixture-secret" } } },
    ] });
    peer.message("Done."); peer.finish("end_turn"); return true;
  } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startPrompt(prompt);
  f.store.approveApprovalRequest(await f.waiting.promise, {}, now);
  await handle.completed;
  const artifacts = f.store.listArtifacts(f.run.id);
  assert.equal(artifacts.length, 2);
  const image = artifacts.find(item => item.type === "image");
  assert.equal(decodePng(await readFile(image.path)).width, 2);
  assert.equal((await readFile(artifacts.find(item => item.type === "file").path, "utf8")).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(f.store.listEvents(f.run.id)).includes(png.toString("base64")), false);
  assert.equal(f.events.filter(event => event.type === "artifact_created").length, 2);
});

test("ACP journal persists diff previews, returned text artifacts and session usage without executing or renaming", { timeout: 5000 }, async t => {
  const f = await setup(t, { output: { extraSecrets: ["fixture-secret"] }, onWire: (message, peer) => {
    if (message.method !== "session/prompt") return;
    peer.update({ sessionUpdate: "session_info_update", title: "Do not rename Ling", _meta: { private: "fixture-secret" } });
    peer.update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Native command" }] });
    peer.tool({ sessionUpdate: "tool_call", title: "Edit", kind: "edit", status: "in_progress", content: [
      { type: "diff", path: "/not-authorized-to-read/config.txt", newText: "fixture-secret" },
    ] });
    peer.tool({ status: "completed", content: [
      { type: "content", content: { type: "resource", resource: { uri: "file:///not-authorized-to-read/report.txt", text: "Returned report" } } },
    ], rawOutput: "Never reveal fixture-secret raw output" });
    peer.message("Done.");
    peer.update({ sessionUpdate: "usage_update", used: 128, size: 32000 });
    peer.finish("end_turn");
    return true;
  } });
  await f.lifecycle.open();
  await (await f.lifecycle.startPrompt(prompt)).completed;
  const saved = f.store.listEvents(f.run.id);
  const usage = saved.find(event => event.type === "progress" && event.data.nativeKind === "session_usage");
  assert.ok(usage, "session context usage must be retained, not counted as turn billing");
  assert.deepEqual({ scope: usage.data.scope, used: usage.data.used, size: usage.data.size }, { scope: "session", used: 128, size: 32000 });
  const preview = saved.find(event => event.type === "tool_update");
  assert.deepEqual(preview.data.partialResult.content, [
    { type: "diff", path: "/not-authorized-to-read/config.txt", oldText: null, newText: "[REDACTED]" },
  ]);
  assert.equal(f.store.listArtifacts(f.run.id).length, 1, "only actually returned report bytes are an artifact");
  assert.equal(await readFile(f.store.listArtifacts(f.run.id)[0].path, "utf8"), "Returned report");
  assert.equal(f.store.getLingThread(f.run.threadId).title, "Native");
  assert.equal(JSON.stringify(saved).includes("raw output"), false);
  assert.equal(saved.find(event => event.type === "message_end").data.text, "Done.");
  assert.equal(f.store.listApprovalRequests({}).length, 0);
});

test("ACP rejects coerced plan state instead of persisting an invalid native plan", { timeout: 5000 }, async t => {
  const f = await setup(t, { onWire: (message, peer) => {
    if (message.method !== "session/prompt") return;
    peer.update({ sessionUpdate: "plan", entries: [{ content: "Invalid", priority: "high", status: ["pending"] }] });
    peer.message("Done."); peer.finish("end_turn"); return true;
  } });
  await f.lifecycle.open();
  await assert.rejects((await f.lifecycle.startPrompt(prompt)).completed, { code: "host_commit_failed" });
  assert.equal(f.events.some(event => event.type === "progress"), false);
});

test("ACP streamed secrets remain redacted across chunk boundaries and final text", { timeout: 5000 }, async t => {
  const f = await setup(t, { output: { extraSecrets: ["phrase with space"] }, onWire: (message, peer) => {
    if (message.method !== "session/prompt") return;
    peer.message("Public Bearer to"); peer.message("ken12345 and phrase wi"); peer.message("th space. Done.");
    peer.finish("end_turn"); return true;
  } });
  await f.lifecycle.open(); await (await f.lifecycle.startPrompt(prompt)).completed;
  const emitted = f.events.filter(event => event.type === "assistant_text_delta").map(event => event.data.text).join("");
  assert.equal(emitted.includes("token12345"), false);
  assert.equal(emitted.includes("phrase with space"), false);
  assert.equal(f.events.find(event => event.type === "message_end").data.text, emitted);
  assert.equal(JSON.stringify(f.store.listEvents(f.run.id)).includes("token12345"), false);
});

for (const decision of ["approve", "deny", "cancel"]) test(`owned Kimi-shaped peer and journaled lifecycle ${decision}`, { timeout: 6000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/acp-live-peer.mjs", import.meta.url))], {
    env: { LING_ACP_PEER_ENGINE: "kimi-acp", LING_ACP_PEER_JOURNALED: "true" }, stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const exited = once(child, "close");
  child.stderr.resume();
  t.after(async () => { child.kill(); await exited; });
  const streaming = Promise.withResolvers();
  const f = await setup(t, { target: { expectedVersion: "owned-peer-1" },
    onEvent: event => { if (event.type === "assistant_text_delta" && event.data.text.includes("during")) streaming.resolve(); },
    client: { input: child.stdin, output: child.stdout } });
  child.on("message", message => f.wire.push(message));
  await f.lifecycle.open();
  const handle = await f.lifecycle.startPrompt(prompt);
  const approvalId = await f.waiting.promise; await streaming.promise;
  assert.equal(f.store.getRun(f.run.id).status, "waiting_for_approval");
  if (decision === "cancel") await handle.cancel();
  else if (decision === "approve") f.store.approveApprovalRequest(approvalId, {}, now);
  else f.store.denyApprovalRequest(approvalId, {}, now);
  assert.equal((await handle.completed).stopReason, decision === "cancel" ? "cancelled" : "end_turn");
  f.lifecycle.close(); await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, decision === "cancel" ? "cancelled" : "completed");
  assert.equal(f.store.getNativeApprovalCorrelation(approvalId).replyStatus, decision === "cancel" ? "not_written" : "written");
  assert.equal(f.wire.some(message => message.result?.outcome?.optionId === "approve_once"), decision === "approve");
  assert.deepEqual(f.waits, [true, false]);
});

for (const engineId of ["kimi-acp", "openclaw-acp"]) test(`owned ${engineId} assistant attachments persist and serve without tool activity`, { timeout: 6000 }, async t => {
  const png = imageFixture("png");
  const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/acp-live-peer.mjs", import.meta.url))], {
    env: { LING_ACP_PEER_ENGINE: engineId, LING_ACP_PEER_OUTPUT: "assistant", LING_ACP_PEER_IMAGE: png.toString("base64") },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const exited = once(child, "close");
  child.stderr.resume();
  t.after(async () => { child.kill(); await exited; });
  const f = await setup(t, { target: { engineId, expectedVersion: "owned-peer-1" }, output: { extraSecrets: ["fixture-secret"] },
    client: { input: child.stdin, output: child.stdout } });
  child.on("message", message => f.wire.push(message));
  await f.lifecycle.open();
  await (await f.lifecycle.startPrompt(prompt)).completed;
  f.lifecycle.close(); await exited;
  assert.equal(child.exitCode, 0);
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getNativeSubmission(f.key.submissionId).status, "completed");
    const events = reopened.listEvents(f.run.id);
    assert.equal(events.some(event => event.type.startsWith("tool_")), false);
    assert.equal(events.filter(event => event.type === "artifact_created").length, 2);
    assert.deepEqual(events.filter(event => event.data.nativeKind === "assistant_content").map(event => event.data.itemId),
      ["assistant-content-1", "assistant-content-2", "assistant-content-3"]);
    const [report] = reopened.listArtifacts(f.run.id).filter(item => item.type === "file");
    assert.equal(readNativeArtifactContent(reopened.paths.artifactsDir, report).toString(), "Returned report [REDACTED]");
    const [picture] = reopened.listArtifacts(f.run.id).filter(item => item.type === "image");
    const pixels = readNativeArtifactContent(reopened.paths.artifactsDir, picture);
    assertPixelsClose(decodePng(pixels).data.subarray(0, 4), [224, 59, 82, 255], 1, "sRGB reference");
    assert.equal(decodePng(pixels).width, 3);
    assert.equal(decodePng(pixels).height, 2);
    assertFreshPng(pixels);
    assert.equal(events.find(event => event.type === "message_end").data.text, "Owned attachments. Completed.");
    assert.equal(JSON.stringify(events).includes("fixture-secret"), false);
    assert.equal(JSON.stringify(events).includes(png.toString("base64")), false);
    assert.deepEqual(f.wire.filter(message => message.method).map(message => message.method), ["initialize", "session/new", "session/prompt"]);
    assert.deepEqual(reopened.listApprovalRequests({}), []);
  } finally { reopened.close(); }
});

for (const engineId of ["kimi-acp", "openclaw-acp"]) test(`owned ${engineId} protocol peer persists rich output across SQLite reopen`, { timeout: 6000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/acp-live-peer.mjs", import.meta.url))], {
    env: { LING_ACP_PEER_ENGINE: engineId, LING_ACP_PEER_OUTPUT: "rich" }, stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const exited = once(child, "close");
  child.stderr.resume();
  t.after(async () => { child.kill(); await exited; });
  const f = await setup(t, { target: { engineId, expectedVersion: "owned-peer-1" }, output: { extraSecrets: ["fixture-secret"] },
    client: { input: child.stdin, output: child.stdout } });
  await f.lifecycle.open();
  await (await f.lifecycle.startPrompt(prompt)).completed;
  f.lifecycle.close(); await exited;
  assert.equal(child.exitCode, 0);
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getNativeSubmission(f.key.submissionId).status, "completed");
    const events = reopened.listEvents(f.run.id);
    assert.equal(events.filter(event => event.type === "tool_start").length, 1);
    assert.equal(events.filter(event => event.type === "tool_end").length, 1);
    assert.equal(events.find(event => event.type === "tool_update").data.partialResult.content[0].newText, "[REDACTED]");
    assert.equal(events.find(event => event.data.nativeKind === "session_usage").data.used, 256);
    assert.equal(events.find(event => event.type === "message_end").data.text, "Owned output completed.");
    assert.equal(events.filter(event => event.type === "artifact_created").length, 1);
    const artifacts = reopened.listArtifacts(f.run.id);
    assert.equal(artifacts.length, 1);
    assert.equal(await readFile(artifacts[0].path, "utf8"), "Returned report [REDACTED]");
    assert.equal(JSON.stringify(events).includes("fixture-secret"), false);
  } finally { reopened.close(); }
});

test("ACP lifecycle rejects identity drift and cannot silently discard a selected model", async t => {
  const f = await setup(t);
  assert.throws(() => new AcpJournaledLifecycle({ ...f.lifecycleOptions, configuration: { cwd: tmpdir() } }), { code: "binding_mismatch" });
  assert.throws(() => new AcpJournaledLifecycle({ ...f.lifecycleOptions, target: { engineId: "openclaw-acp", expectedVersion: "fixture" } }), { code: "binding_mismatch" });
  await assert.rejects(setup(t, { selection: { modelId: "unverified-model" } }), { code: "binding_mismatch" });
  assert.deepEqual(f.wire, []);
});

for (const streamed of [false, true]) test(`OpenClaw cancellation cannot certify remote stop (prior activity=${streamed})`, async t => {
  const seen = Promise.withResolvers();
  const f = await setup(t, { target: { engineId: "openclaw-acp" }, onWire(message, peer) {
    if (message.method !== "session/prompt") return;
    if (streamed) peer.message("Remote activity observed.");
    else peer.finish("cancelled");
    return true;
  }, onEvent(event) { if (event.type === "assistant_text_delta") seen.resolve(); } });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startPrompt(prompt);
  if (streamed) { await seen.promise; await handle.cancel(); }
  await assert.rejects(handle.completed, { code: "submission_uncertain", outcome: "unknown" });
  f.lifecycle.close(); await f.lifecycle.closed;
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.equal(reopened.getNativeSubmission(f.key.submissionId).status, "unknown");
    assert.equal(reopened.getNativeExecutionBinding(f.reserved.binding.id).openclawSession.acceptedAt, streamed ? now : undefined);
    assert.equal(reopened.listEvents(f.run.id).some(event => event.type === "turn_end"), false);
    assert.throws(() => reopened.prepareNativeOpenClawSession({ ...f.key, agentId: "fixture" }, now), { code: "native_submission_conflict" });
    assert.equal(f.wire.filter(value => value.method === "session/prompt").length, 1);
  } finally { reopened.close(); }
});

test("OpenClaw ownership lost during initialize cannot create a remote session", { timeout: 5000 }, async t => {
  const initialized = Promise.withResolvers();
  let initializeId;
  const f = await setup(t, { target: { engineId: "openclaw-acp" }, closeError: "native_owner_mismatch",
    onWire(message) {
      if (message.method !== "initialize") return;
      initializeId = message.id; initialized.resolve(); return true;
    } });
  const opening = f.lifecycle.open();
  await initialized.promise;
  f.store.createWorkUnitAttempt({ workUnitId: f.work.id, attemptNumber: 2, runtimeInstanceId: "replacement", runnerId: "openclaw-acp", now });
  f.peer.result(initializeId, { protocolVersion: 1, agentInfo: { name: "openclaw-acp", version: "fixture" },
    agentCapabilities: { loadSession: true }, authMethods: [] });
  await assert.rejects(opening, { code: "native_owner_mismatch" });
  assert.deepEqual(f.wire.filter(value => value.method).map(value => value.method), ["initialize"]);
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "reserved");
});

test("ACP stale Attempt cannot release an approved decision or mutate the replacement", { timeout: 5000 }, async t => {
  const f = await setup(t, { closeError: "native_owner_mismatch" });
  await f.lifecycle.open();
  const handle = await f.lifecycle.startPrompt(prompt);
  const id = await f.waiting.promise; await f.live.promise;
  const replacement = f.store.createWorkUnitAttempt({ workUnitId: f.work.id, attemptNumber: 2, runtimeInstanceId: "replacement", runnerId: "kimi-acp", now });
  f.store.approveApprovalRequest(id, {}, now);
  await assert.rejects(handle.completed, { code: "native_owner_mismatch" });
  assert.equal(f.wire.some(message => message.result?.outcome?.optionId === "approve_once"), false);
  assert.equal(f.store.getWorkUnitAttempt(replacement.id).status, replacement.status);
  assert.equal(f.store.getNativeSubmission(f.key.submissionId).status, "accepted");
  assert.deepEqual(f.waits, [true, false]);
});
