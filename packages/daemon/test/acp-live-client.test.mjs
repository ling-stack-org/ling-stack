import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { AcpLiveClient } from "../dist/runtime/acp/live-client.js";
import { KimiActionPreparer } from "../dist/runtime/acp/kimi-action-preparation.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const configuration = { cwd: "/tmp/ling-acp-owned-workspace" };
const prompt = [{ type: "text", text: "Owned protocol fixture; no actual model." }];

function setup(t, options = {}, onMessage) {
  const output = new PassThrough();
  const wire = [];
  const events = [];
  const abort = new AbortController();
  const send = value => output.write(`${JSON.stringify(value)}\n`);
  const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
  const update = text => send({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  } });
  const permission = () => send({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: {
    sessionId: "session-1", toolCall: { toolCallId: "tool-1", title: "Fixture operation", kind: "execute" },
    options: [{ optionId: "once", kind: "allow_once", name: "Allow once" },
      { optionId: "always", kind: "allow_always", name: "Always" },
      { optionId: "deny", kind: "reject_once", name: "Deny" }],
  } });
  let promptId;
  const input = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString());
    wire.push(message);
    if (onMessage?.(message, { send, result, update, permission }) !== true) {
      if (message.method === "initialize") result(message.id, { protocolVersion: 1,
        agentInfo: { name: options.engineId === "openclaw-acp" ? "openclaw-acp" : "Kimi Code CLI", version: "fixture-1" },
        agentCapabilities: { loadSession: true }, authMethods: [] });
      if (message.method === "session/new") result(message.id, { sessionId: "session-1" });
      if (message.method === "session/load") result(message.id, {});
      if (message.method === "session/prompt") { promptId = message.id; update("before permission"); permission(); update("during permission"); }
      if (message.method === "session/cancel") { update("cancelled output"); result(promptId, { stopReason: "cancelled" }); }
      if (message.id === "permission-1" && !message.method && message.result?.outcome.outcome === "selected") {
        update("after permission"); result(promptId, { stopReason: "end_turn" });
      }
    }
    if (options.writeComplete?.(message, callback) !== true) callback();
  } });
  const client = new AcpLiveClient({ input, output, signal: abort.signal, engineId: "kimi-acp", expectedVersion: "fixture-1",
    requestTimeoutMs: 1000, turnTimeoutMs: 2000, hostTimeoutMs: 1000,
    onSessionAccepted: async () => {}, onPromptSubmitting: async () => {},
    onUpdate: async event => { events.push(event); }, onPermission: async () => "deny", ...options });
  t.after(async () => { client.close(); input.destroy(); output.destroy(); await client.closed; });
  return { client, abort, wire, events, input, output, send, result, update, permission };
}

test("ACP opt-in host files reserve before execution and return actual isolated contents", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-acp-host-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sample.txt");
  await writeFile(path, "before\n");
  const order = [];
  const hostFiles = {
    readTextFile: {
      receive: request => { order.push(`receive:${request.requestId}`); },
      execute: async (request, signal) => { signal.throwIfAborted(); order.push(`execute:${request.requestId}`);
        return { content: await readFile(request.params.path, "utf8") }; },
      beforeReply: request => { order.push(`reply:${request.requestId}`); },
      onReplyOutcome: result => { order.push(`${result.outcome}:${result.requestId}`); },
    },
    writeTextFile: {
      receive: request => { order.push(`receive:${request.requestId}`); },
      execute: async (request, signal) => { signal.throwIfAborted(); order.push(`execute:${request.requestId}`);
        await writeFile(request.params.path, request.params.content, { signal }); return {}; },
      beforeReply: request => { order.push(`reply:${request.requestId}`); },
      onReplyOutcome: result => { order.push(`${result.outcome}:${result.requestId}`); },
    },
  };
  let promptId;
  const p = setup(t, { hostFiles }, (message, peer) => {
    if (message.method === "session/prompt") {
      promptId = message.id;
      peer.send({ jsonrpc: "2.0", id: "write-1", method: "fs/write_text_file", params: { sessionId: "session-1", path, content: "after\n" } });
      return true;
    }
    if (message.id === "write-1" && !message.method) {
      setImmediate(() => peer.send({ jsonrpc: "2.0", id: "read-1", method: "fs/read_text_file", params: { sessionId: "session-1", path } })); return true;
    }
    if (message.id === "read-1" && !message.method) { setImmediate(() => peer.result(promptId, { stopReason: "end_turn" })); return true; }
  });
  await p.client.initialize(); await p.client.openSession({ cwd: root });
  await (await p.client.startPrompt(prompt)).completed;
  assert.deepEqual(p.wire.find(item => item.method === "initialize").params.clientCapabilities,
    { fs: { readTextFile: true, writeTextFile: true } });
  assert.deepEqual(p.wire.find(item => item.id === "read-1").result, { content: "after\n" });
  assert.equal(await readFile(path, "utf8"), "after\n");
  assert.deepEqual(order, ["receive:write-1", "execute:write-1", "reply:write-1", "written:write-1",
    "receive:read-1", "execute:read-1", "reply:read-1", "written:read-1"]);
});

test("ACP metadata is session-scoped state, never prompt acceptance or assistant output", async t => {
  let accepted = 0;
  const p = setup(t, { onPromptAccepted: () => { accepted++; } }, message => message.method === "session/prompt");
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await tick();
  const metadata = update => p.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update } });
  metadata({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact context" }] });
  metadata({ sessionUpdate: "session_info_update", title: "Native title", updatedAt: "2026-09-09T01:00:00Z", _meta: { private: "hidden" } });
  metadata({ sessionUpdate: "usage_update", used: 120, size: 32000, cost: { amount: 0.02, currency: "USD" } });
  await tick();
  assert.equal(accepted, 0);
  assert.deepEqual(p.events, []);
  assert.deepEqual(p.client.sessionMetadata, {
    title: "Native title", updatedAt: "2026-09-09T01:00:00Z",
    availableCommands: [{ name: "compact", description: "Compact context" }],
    usage: { used: 120, size: 32000, cost: { amount: 0.02, currency: "USD" } },
  });
  p.result(p.wire.find(message => message.method === "session/prompt").id, { stopReason: "end_turn" });
  await handle.completed;
  assert.equal(accepted, 1);
  metadata({ sessionUpdate: "session_info_update", title: null });
  await tick();
  assert.equal(p.client.sessionMetadata.title, null);
  const copied = p.client.sessionMetadata;
  copied.usage.used = 99;
  copied.availableCommands[0].name = "mutated";
  assert.equal(p.client.sessionMetadata.usage.used, 120);
  assert.equal(p.client.sessionMetadata.availableCommands[0].name, "compact");
});

for (const [name, update, code = "protocol_error"] of [
  ["negative context", { sessionUpdate: "usage_update", used: -1, size: 100 }],
  ["fractional context", { sessionUpdate: "usage_update", used: 1.5, size: 100 }],
  ["coerced size", { sessionUpdate: "usage_update", used: 1, size: "100" }],
  ["negative cost", { sessionUpdate: "usage_update", used: 1, size: 100, cost: { amount: -1, currency: "USD" } }],
  ["invalid currency", { sessionUpdate: "usage_update", used: 1, size: 100, cost: { amount: 1, currency: "usd" } }],
  ["coerced title", { sessionUpdate: "session_info_update", title: ["name"] }],
  ["invalid timestamp", { sessionUpdate: "session_info_update", updatedAt: "not-time" }],
  ["duplicate command", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "x", description: "a" }, { name: "x", description: "b" }] }],
  ["invalid input hint", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "x", description: "a", input: { hint: false } }] }],
  ["too many commands", { sessionUpdate: "available_commands_update", availableCommands: Array.from({ length: 257 }, (_, i) => ({ name: `command-${i}`, description: "a" })) }],
  ["large metadata", { sessionUpdate: "session_info_update", title: "x".repeat(128 * 1024) }, "output_limit"],
]) test(`ACP rejects ${name} metadata before accepting work`, async t => {
  let accepted = 0;
  const p = setup(t, { onPromptAccepted: () => { accepted++; } }, (message, peer) => {
    if (message.method !== "session/prompt") return;
    peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update } });
    return true;
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  await assert.rejects(async () => { await (await p.client.startPrompt(prompt)).completed; }, { code });
  assert.equal(accepted, 0);
  assert.deepEqual(p.events, []);
  assert.deepEqual(p.client.sessionMetadata, {});
});

test("ACP metadata cannot cross a bound session even though it is not prompt output", async t => {
  const p = setup(t, {}, (message, peer) => {
    if (message.method !== "session/prompt") return;
    peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other-session",
      update: { sessionUpdate: "usage_update", used: 1, size: 100 } } });
    return true;
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  await assert.rejects(async () => { await (await p.client.startPrompt(prompt)).completed; }, { code: "binding_mismatch" });
  assert.deepEqual(p.client.sessionMetadata, {});
});

test("native ACP persists the session before prompt and streams while one-time permission waits", { timeout: 5000 }, async t => {
  const committing = Promise.withResolvers();
  const commit = Promise.withResolvers();
  const asked = Promise.withResolvers();
  const decision = Promise.withResolvers();
  const p = setup(t, { onSessionAccepted: async binding => { committing.resolve(binding); await commit.promise; },
    onPermission: async request => { asked.resolve(request); return decision.promise; } });
  await p.client.initialize();
  const opening = p.client.openSession(configuration);
  assert.equal((await committing.promise).sessionId, "session-1");
  await assert.rejects(p.client.startPrompt(prompt), { code: "invalid_state" });
  assert.equal(p.wire.some(message => message.method === "session/prompt"), false);
  commit.resolve();
  assert.deepEqual(await opening, { sessionId: "session-1", configuration });
  const handle = await p.client.startPrompt(prompt);
  assert.equal((await asked.promise).params.toolCall.toolCallId, "tool-1");
  await tick();
  assert.deepEqual(p.events.map(event => event.update.content.text), ["before permission", "during permission"]);
  decision.resolve("approve_once");
  assert.equal((await handle.completed).stopReason, "end_turn");
  assert.deepEqual(p.wire.find(message => message.id === "permission-1").result, { outcome: { outcome: "selected", optionId: "once" } });
  assert.deepEqual(p.events.map(event => event.update.content.text), ["before permission", "during permission", "after permission"]);
  assert.deepEqual(p.wire.find(message => message.method === "initialize").params.clientCapabilities, {});
});

test("ACP receipt finalizes Kimi command context before a blocked output observer and permission", { timeout: 5000 }, async t => {
  const released = Promise.withResolvers();
  const asked = Promise.withResolvers();
  const localConfiguration = { cwd: tmpdir() };
  const actions = new KimiActionPreparer({ sessionId: "session-1", cwd: localConfiguration.cwd,
    policy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [localConfiguration.cwd] } });
  const delivered = [];
  const p = setup(t, { onUpdateReceived: update => { actions.receive(update); },
    onUpdate: async update => { await released.promise; delivered.push(update); },
    onPermission: async request => { asked.resolve(actions.prepare(request)); return "deny"; },
  }, (message, peer) => {
    if (message.id === "permission-1" && !message.method) return true;
    if (message.method !== "session/prompt") return;
    peer.update("slow earlier output");
    peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: {
      sessionUpdate: "tool_call", toolCallId: "1:tool", title: "Bash", kind: "execute", status: "pending" } } });
    peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: {
      sessionUpdate: "tool_call_update", toolCallId: "1:tool", title: "Running a lookup", kind: "execute", status: "in_progress",
      rawInput: { command: "whois example.com" } } } });
    peer.send({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: {
      sessionId: "session-1", toolCall: { toolCallId: "1:tool", title: "Bash" }, options: [
        { optionId: "approve_once", name: "Once", kind: "allow_once" },
        { optionId: "approve_always", name: "Session", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ] } });
    return true;
  });
  await p.client.initialize(); await p.client.openSession(localConfiguration);
  const handle = await p.client.startPrompt(prompt);
  const prepared = await asked.promise;
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.approval.payload.command, "whois example.com");
  assert.deepEqual(delivered, []);
  released.resolve();
  p.result(p.wire.find(message => message.method === "session/prompt").id, { stopReason: "end_turn" });
  assert.equal((await handle.completed).stopReason, "end_turn");
});

test("ACP anchors permission context before later input in the same received batch", async t => {
  const actions = new KimiActionPreparer({ sessionId: "session-1", cwd: tmpdir(),
    policy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [tmpdir()] } });
  const seen = [];
  const p = setup(t, { onUpdateReceived: update => { actions.receive(update); },
    onPermissionReceived: request => { seen.push(["received", actions.prepare(request).approval.payload.command]); },
    onPermission: async request => { seen.push(["dispatched", actions.prepare(request).approval.payload.command]); return "deny"; },
  }, (message, peer) => {
    if (message.id === "permission-1" && !message.method) {
      peer.result(p.wire.find(item => item.method === "session/prompt").id, { stopReason: "end_turn" }); return true;
    }
    if (message.method !== "session/prompt") return;
    const update = command => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: {
      sessionUpdate: command === "whois first.example" ? "tool_call" : "tool_call_update", toolCallId: "1:bash",
      title: "Bash", kind: "execute", status: "in_progress", rawInput: { command } } } });
    const request = { jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: {
      sessionId: "session-1", toolCall: { toolCallId: "1:bash", title: "Bash" }, options: [
        { optionId: "approve_once", name: "Once", kind: "allow_once" },
        { optionId: "approve_always", name: "Session", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ] } };
    p.output.write([update("whois first.example"), request, update("whois later.example")].map(value => JSON.stringify(value)).join("\n") + "\n");
    return true;
  });
  await p.client.initialize(); await p.client.openSession({ cwd: tmpdir() });
  const handle = await p.client.startPrompt(prompt); await handle.completed;
  assert.deepEqual(seen, [["received", "whois first.example"], ["dispatched", "whois later.example"]]);
});

for (const mode of ["throw", "async", "close"]) test(`ACP ${mode} permission receipt commit cannot dispatch a grant`, async t => {
  let asked = 0;
  const observed = [];
  const p = setup(t, { onPermissionReceived: () => {
    if (mode === "throw") throw new Error("private persistence failure");
    if (mode === "async") return Promise.resolve();
    p.client.close();
  }, onPermission: async () => { asked++; return "approve_once"; },
  onPermissionReplyOutcome: value => observed.push(value) });
  await p.client.initialize(); await p.client.openSession(configuration);
  await assert.rejects(async () => { await (await p.client.startPrompt(prompt)).completed; },
    { code: mode === "close" ? "cancelled" : "host_commit_failed" });
  assert.equal(asked, 0);
  assert.deepEqual(observed, [{ requestId: "permission-1", outcome: "not_written" }]);
  assert.equal(p.wire.some(message => message.result?.outcome?.optionId === "once"), false);
});

test("ACP permission receipt mutation cannot replace the SDK decision or reply claim", async t => {
  let asked;
  let claimed;
  const p = setup(t, { onPermissionReceived: request => {
    request.params.toolCall.toolCallId = "different"; request.params.options[0].optionId = "always";
  }, onPermission: async request => { asked = request; return "approve_once"; },
  onPermissionReplySending: request => { claimed = request; } });
  await p.client.initialize(); await p.client.openSession(configuration);
  await (await p.client.startPrompt(prompt)).completed;
  assert.equal(asked.params.toolCall.toolCallId, "tool-1");
  assert.equal(asked.params.options[0].optionId, "once");
  assert.deepEqual(claimed, asked);
  assert.equal(p.wire.find(message => message.id === "permission-1").result.outcome.optionId, "once");
});

for (const mode of ["throw", "async", "close"]) test(`ACP ${mode} receipt commit cannot proceed to output or permission`, async t => {
  let asked = 0;
  const p = setup(t, { onUpdateReceived: () => {
    if (mode === "throw") throw new Error("private host failure");
    if (mode === "async") return Promise.resolve();
    p.client.close();
  }, onPermission: async () => { asked++; return "approve_once"; } });
  await p.client.initialize(); await p.client.openSession(configuration);
  await assert.rejects(async () => { const handle = await p.client.startPrompt(prompt); await handle.completed; },
    { code: mode === "close" ? "cancelled" : "host_commit_failed" });
  assert.equal(asked, 0);
  assert.deepEqual(p.events, []);
  assert.equal(p.wire.some(message => message.result?.outcome?.optionId === "once"), false);
});

test("ACP receipt context excludes replay/idle and mutations cannot replace delivered output", async t => {
  const receipts = [];
  const p = setup(t, { onUpdateReceived: event => { receipts.push(event.update.content.text); event.update.content.text = "mutated callback"; } },
    (message, peer) => {
      if (message.method !== "session/load") return;
      peer.update("replayed"); peer.result(message.id, {}); return true;
    });
  await p.client.initialize(); await p.client.openSession(configuration, "session-1");
  p.update("idle"); await tick();
  assert.deepEqual(receipts, []);
  const handle = await p.client.startPrompt(prompt); await handle.completed;
  assert.deepEqual(receipts, ["before permission", "during permission", "after permission"]);
  assert.deepEqual(p.events.map(event => event.update.content.text), ["replayed", "idle", ...receipts]);
});

test("ACP claims a permission reply before its bytes and observes one successful write", { timeout: 5000 }, async t => {
  const claims = [];
  const observations = [];
  const p = setup(t, { onPermission: async () => "approve_once",
    onPermissionReplySending: (request, response) => {
      assert.equal(p.wire.some(message => message.id === "permission-1"), false);
      claims.push(structuredClone({ request, response }));
      response.outcome.optionId = "always";
      request.params.options[0].optionId = "always";
    },
    onPermissionReplyOutcome: observation => { observations.push(observation); },
  }, (message, peer) => {
    if (message.id !== "permission-1" || message.method) return;
    setImmediate(() => peer.result(p.wire.find(item => item.method === "session/prompt").id, { stopReason: "end_turn" }));
    return true;
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await handle.completed;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].request.requestId, "permission-1");
  assert.deepEqual(claims[0].response, { outcome: { outcome: "selected", optionId: "once" } });
  assert.deepEqual(observations, [{ requestId: "permission-1", outcome: "written" }]);
  assert.equal(p.wire.find(message => message.id === "permission-1").result.outcome.optionId, "once");
  p.client.close(); await tick();
  assert.equal(observations.length, 1);
});

test("ACP terminal overtaking a pending reply write records unknown and ignores its late callback", { timeout: 5000 }, async t => {
  const observations = [];
  let finishWrite;
  const p = setup(t, { onPermission: async () => "approve_once",
    writeComplete: (message, callback) => { if (message.id === "permission-1") { finishWrite = callback; return true; } },
    onPermissionReplyOutcome: observation => observations.push(observation),
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await handle.completed;
  assert.deepEqual(observations, [{ requestId: "permission-1", outcome: "unknown" }]);
  finishWrite(); await tick();
  assert.equal(observations.length, 1);
});

test("ACP bounds a stalled permission write and records unknown once", { timeout: 5000 }, async t => {
  const observations = [];
  let finishWrite;
  const p = setup(t, { writeTimeoutMs: 20, turnTimeoutMs: 1000, onPermission: async () => "approve_once",
    writeComplete: (message, callback) => { if (message.id === "permission-1") { finishWrite = callback; return true; } },
    onPermissionReplyOutcome: observation => observations.push(observation),
  }, message => message.id === "permission-1" && !message.method);
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await assert.rejects(handle.completed, { code: "timeout", outcome: "unknown" });
  assert.deepEqual(observations, [{ requestId: "permission-1", outcome: "unknown" }]);
  finishWrite(); await tick();
  assert.equal(observations.length, 1);
});

test("ACP rejects an asynchronous delivery observer before advancing later replies", { timeout: 5000 }, async t => {
  const observations = [];
  const p = setup(t, { onPermission: async () => "approve_once",
    onPermissionReplyOutcome: async observation => { observations.push(observation); },
  }, (message, peer) => {
    if (message.method !== "session/prompt") return message.id === "permission-1" && !message.method;
    peer.permission();
    peer.send({ jsonrpc: "2.0", id: "permission-2", method: "session/request_permission", params: {
      sessionId: "session-1", toolCall: { toolCallId: "tool-2", title: "Second" },
      options: [{ kind: "allow_once", optionId: "once", name: "Once" }],
    } });
    return true;
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await assert.rejects(handle.completed, { code: "host_commit_failed", outcome: "unknown" });
  assert.equal(p.wire.some(message => message.id === "permission-2" && !message.method), false);
  assert.deepEqual(observations.map(item => item.outcome), ["written", "not_written"]);
});

for (const action of ["throw", "close", "cancel", "async"]) test(`ACP pre-write ${action} never releases the selected grant`, { timeout: 5000 }, async t => {
  const asked = Promise.withResolvers();
  const decision = Promise.withResolvers();
  const observations = [];
  let handle;
  let cancelling;
  const p = setup(t, {
    onPermission: async () => { asked.resolve(); return decision.promise; },
    onPermissionReplySending: () => {
      if (action === "throw") throw new Error("private-approval-journal-path");
      if (action === "async") return Promise.resolve();
      if (action === "close") p.client.close();
      if (action === "cancel") cancelling = handle.cancel();
    },
    onPermissionReplyOutcome: observation => observations.push(observation),
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  handle = await p.client.startPrompt(prompt);
  await asked.promise; decision.resolve("approve_once");
  if (action === "cancel") { assert.equal((await handle.completed).stopReason, "cancelled"); await cancelling; }
  else await assert.rejects(handle.completed, { code: action === "close" ? "cancelled" : "host_commit_failed", outcome: "unknown" });
  assert.equal(p.wire.some(message => message.result?.outcome?.optionId === "once"), false);
  assert.deepEqual(observations, [{ requestId: "permission-1", outcome: "not_written" }]);
});

for (const action of ["close", "error", "throw"]) test(`ACP invoked reply ${action} records unknown without claiming successful delivery`, { timeout: 5000 }, async t => {
  const invoked = Promise.withResolvers();
  const observations = [];
  let finishWrite;
  const p = setup(t, { onPermission: async () => "approve_once",
    writeComplete: (message, callback) => {
      if (message.id !== "permission-1") return;
      invoked.resolve(); finishWrite = callback;
      if (action === "error") callback(new Error("private-native-write-error"));
      if (action === "throw") throw new Error("private-native-write-error");
      return true;
    },
    onPermissionReplyOutcome: observation => observations.push(observation),
  }, message => message.id === "permission-1" && !message.method);
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await invoked.promise;
  if (action === "close") p.client.close();
  await assert.rejects(handle.completed, error => error.outcome === "unknown" && !error.message.includes("private"));
  assert.deepEqual(observations, [{ requestId: "permission-1", outcome: "unknown" }]);
  if (action === "close") { finishWrite(); await tick(); assert.equal(observations.length, 1); }
});

test("ACP cancellation observes a pending reply even when its decision never settles", { timeout: 5000 }, async t => {
  const asked = Promise.withResolvers();
  const observations = [];
  const p = setup(t, { onPermission: async () => { asked.resolve(); return new Promise(() => {}); },
    onPermissionReplySending: () => assert.fail("unresolved decision cannot claim"),
    onPermissionReplyOutcome: observation => observations.push(observation),
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await asked.promise;
  const cancelling = handle.cancel();
  assert.deepEqual(observations, [{ requestId: "permission-1", outcome: "not_written" }]);
  await cancelling; await handle.completed;
  assert.equal(observations.length, 1);
});

test("ACP binary tool decisions cannot arbitrarily choose between native plan options", { timeout: 5000 }, async t => {
  const observations = [];
  const claims = [];
  const replied = Promise.withResolvers();
  const p = setup(t, { onPermission: async () => "approve_once",
    onPermissionReplySending: value => claims.push(value),
    onPermissionReplyOutcome: value => observations.push(value),
  }, (message, peer) => {
    if (message.method === "session/prompt") {
      peer.send({ jsonrpc: "2.0", id: "plan-1", method: "session/request_permission", params: {
        sessionId: "session-1", toolCall: { toolCallId: "plan-1", title: "Plan" },
        options: [{ kind: "allow_once", optionId: "plan_opt_0", name: "A" }, { kind: "allow_once", optionId: "plan_opt_1", name: "B" }],
      } });
      return true;
    }
    if (message.id === "plan-1" && !message.method) {
      replied.resolve(message);
      peer.result(p.wire.find(item => item.method === "session/prompt").id, { stopReason: "cancelled" });
      return true;
    }
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  assert.deepEqual((await replied.promise).result, { outcome: { outcome: "cancelled" } });
  await handle.completed;
  assert.deepEqual(claims, []);
  assert.deepEqual(observations, [{ requestId: "plan-1", outcome: "not_written" }]);
});

test("ACP exposes the actual SDK prompt id before write and commits native acceptance before host output", { timeout: 5000 }, async t => {
  const sent = [];
  const accepted = [];
  const p = setup(t, {
    onPromptSending: value => {
      assert.equal(p.wire.some(message => message.method === "session/prompt"), false);
      sent.push(structuredClone(value));
      value.binding.sessionId = "cannot-rewrite-native-binding";
    },
    onPromptAccepted: value => {
      assert.equal(p.wire.some(message => message.method === "session/prompt"), true);
      accepted.push(structuredClone(value));
    },
    onUpdate: async () => { assert.equal(accepted.length, 1); },
    onPermission: async () => { assert.equal(accepted.length, 1); return "approve_once"; },
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await handle.completed;
  const wire = p.wire.find(message => message.method === "session/prompt");
  const expected = { requestId: wire.id, binding: { sessionId: "session-1", configuration } };
  assert.deepEqual(sent, [expected]);
  assert.deepEqual(accepted, [expected]);
  assert.equal(wire.params.sessionId, "session-1");
});

test("ACP synchronous pre-send persistence failure writes no prompt and never claims acceptance", { timeout: 5000 }, async t => {
  const p = setup(t, {
    onPromptSending: () => { throw new Error("private-journal-path"); },
    onPromptAccepted: () => assert.fail("cannot accept an unsent prompt"),
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await assert.rejects(handle.completed, { code: "host_commit_failed", outcome: "not_submitted", message: "host_commit_failed" });
  assert.equal(p.wire.some(message => message.method === "session/prompt"), false);
});

for (const source of ["permission", "result"]) test(`ACP accepts the first native ${source} without requiring an output chunk`, { timeout: 5000 }, async t => {
  const accepted = [];
  let promptId;
  const p = setup(t, { onPromptAccepted: value => accepted.push(value), onPermission: async () => {
    assert.equal(accepted.length, 1); return "approve_once";
  } }, (message, peer) => {
    if (message.method === "session/prompt") {
      promptId = message.id;
      if (source === "permission") peer.permission(); else peer.result(message.id, { stopReason: "end_turn" });
      return true;
    }
    if (message.id === "permission-1" && !message.method) { peer.result(promptId, { stopReason: "end_turn" }); return true; }
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  assert.equal((await handle.completed).stopReason, "end_turn");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].requestId, promptId);
});

test("ACP idle updates and a successful write without native activity do not establish acceptance", { timeout: 5000 }, async t => {
  const accepted = [];
  const p = setup(t, { onPromptAccepted: value => accepted.push(value) }, message => message.method === "session/prompt");
  await p.client.initialize(); await p.client.openSession(configuration);
  p.update("idle update"); await tick();
  const handle = await p.client.startPrompt(prompt);
  await tick();
  assert.equal(p.wire.filter(message => message.method === "session/prompt").length, 1);
  assert.deepEqual(accepted, []);
  p.output.end();
  await assert.rejects(handle.completed, error => error.outcome === "unknown");
  await assert.rejects(p.client.startPrompt(prompt));
  assert.equal(p.wire.filter(message => message.method === "session/prompt").length, 1);
});

test("ACP failed acceptance persistence stops output and permission delivery", { timeout: 5000 }, async t => {
  const p = setup(t, {
    onPromptAccepted: () => { throw new Error("private-native-journal-path"); },
    onUpdate: async () => assert.fail("output before durable acceptance"),
    onPermission: async () => assert.fail("permission before durable acceptance"),
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await assert.rejects(handle.completed, { code: "host_commit_failed", outcome: "unknown", message: "host_commit_failed" });
  assert.equal(p.wire.some(message => message.result?.outcome?.optionId === "once"), false);
});

for (const mode of ["close", "async"]) test(`ACP rejects ${mode} during the synchronous send boundary`, { timeout: 5000 }, async t => {
  const p = setup(t, { onPromptSending: () => mode === "close" ? p.client.close() : Promise.resolve() });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await assert.rejects(handle.completed, error => error.outcome === "not_submitted");
  assert.equal(p.wire.some(message => message.method === "session/prompt"), false);
});

test("native ACP cancel retires the pending grant and drains final output before completion", { timeout: 5000 }, async t => {
  const asked = Promise.withResolvers();
  const decision = Promise.withResolvers();
  let permissionSignal;
  const p = setup(t, { onPermission: async (_request, signal) => { permissionSignal = signal; asked.resolve(); return decision.promise; } });
  await p.client.initialize();
  await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await asked.promise;
  await handle.cancel();
  assert.equal(permissionSignal.aborted, true);
  assert.equal((await handle.completed).stopReason, "cancelled");
  decision.resolve("approve_once");
  await tick();
  assert.equal(p.wire.some(message => message.result?.outcome?.optionId === "once"), false);
  assert.deepEqual(p.wire.find(message => message.id === "permission-1").result, { outcome: { outcome: "cancelled" } });
  assert.equal(p.events.at(-1).update.content.text, "cancelled output");
});

test("failed host session persistence is redacted and no prompt can be submitted", { timeout: 5000 }, async t => {
  const p = setup(t, { onSessionAccepted: async () => { throw new Error("secret-private-database-location"); } });
  await p.client.initialize();
  await assert.rejects(p.client.openSession(configuration), { code: "host_commit_failed", message: "host_commit_failed", outcome: "not_submitted" });
  await assert.rejects(p.client.startPrompt(prompt));
  assert.equal(p.wire.some(message => message.method === "session/prompt"), false);
});

test("unnegotiated media and malformed prompt blocks are rejected before submission", { timeout: 5000 }, async t => {
  const p = setup(t);
  await p.client.initialize();
  await p.client.openSession(configuration);
  for (const content of [[{ type: "text", text: 42 }], [{ type: "injected", text: "bad" }],
    [{ type: "image", data: "fixture", mimeType: "image/png" }], [{ type: "audio", data: "fixture", mimeType: "audio/wav" }]]) {
    await assert.rejects(p.client.startPrompt(content), error => ["invalid_input", "unsupported_capability"].includes(error.code));
  }
  assert.equal(p.wire.some(message => message.method === "session/prompt"), false);
});

test("a grant already queued behind a pending write becomes cancelled before it reaches stdin", { timeout: 5000 }, async t => {
  const asked = Promise.withResolvers();
  const observations = [];
  let finishWrite;
  const p = setup(t, {
    writeComplete: (message, callback) => { if (message.method === "session/prompt") { finishWrite = callback; return true; } },
    onPermission: async () => { asked.resolve(); return "approve_once"; },
    onPermissionReplySending: () => assert.fail("retired queued grant cannot claim"),
    onPermissionReplyOutcome: value => observations.push(value),
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await asked.promise; await tick();
  assert.equal(p.wire.some(message => message.id === "permission-1"), false);
  const cancelling = handle.cancel();
  assert.deepEqual(observations, [{ requestId: "permission-1", outcome: "not_written" }]);
  finishWrite();
  await cancelling;
  assert.equal((await handle.completed).stopReason, "cancelled");
  assert.deepEqual(p.wire.find(message => message.id === "permission-1").result.outcome, { outcome: "cancelled" });
});

test("native completion also retires a queued permission before slow output delivery finishes", { timeout: 5000 }, async t => {
  const asked = Promise.withResolvers();
  const observed = Promise.withResolvers();
  const releaseOutput = Promise.withResolvers();
  let finishWrite;
  const p = setup(t, {
    writeComplete: (message, callback) => { if (message.method === "session/prompt") { finishWrite = callback; return true; } },
    onPermission: async () => { asked.resolve(); return "approve_once"; },
    onUpdate: async () => { observed.resolve(); await releaseOutput.promise; },
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await asked.promise; await observed.promise; await tick();
  p.result(p.wire.find(message => message.method === "session/prompt").id, { stopReason: "end_turn" });
  await tick(); finishWrite(); await tick();
  assert.deepEqual(p.wire.find(message => message.id === "permission-1").result.outcome, { outcome: "cancelled" });
  let completed = false;
  void handle.completed.then(() => { completed = true; });
  await tick(); assert.equal(completed, false);
  releaseOutput.resolve();
  assert.equal((await handle.completed).stopReason, "end_turn");
});

test("supported load receives replay updates after binding commit but never submits a prompt", { timeout: 5000 }, async t => {
  const p = setup(t, {}, (message, peer) => {
    if (message.method !== "session/load") return;
    peer.update("historical output"); peer.result(message.id, {}); return true;
  });
  await p.client.initialize();
  assert.deepEqual(await p.client.openSession(configuration, "session-1"), { sessionId: "session-1", configuration });
  assert.equal(p.events[0].update.content.text, "historical output");
  assert.equal(p.wire.some(message => ["session/prompt", "session/new"].includes(message.method)), false);
});

test("missing load capability does not fall back to new session or replay", { timeout: 5000 }, async t => {
  const p = setup(t, {}, (message, peer) => {
    if (message.method !== "initialize") return;
    peer.result(message.id, { protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "fixture-1" }, agentCapabilities: {} }); return true;
  });
  await p.client.initialize();
  await assert.rejects(p.client.openSession(configuration, "session-1"), { code: "unsupported_capability" });
  assert.deepEqual(p.wire.map(message => message.method), ["initialize"]);
});

test("a lost prompt result fences unknown execution and forbids retry", { timeout: 5000 }, async t => {
  const p = setup(t, {}, message => {
    if (message.method === "session/prompt") { p.output.end(); return true; }
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await assert.rejects(handle.completed, error => error.outcome === "unknown");
  await assert.rejects(p.client.startPrompt(prompt));
  assert.equal(p.wire.filter(message => message.method === "session/prompt").length, 1);
});

test("concurrent prompts are rejected, explicit subsequent prompts preserve the binding", { timeout: 5000 }, async t => {
  const asked = Promise.withResolvers();
  const decision = Promise.withResolvers();
  let first = true;
  const p = setup(t, { onPermission: async () => { asked.resolve(); if (first) { first = false; return decision.promise; } return "deny"; } });
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await asked.promise;
  await assert.rejects(p.client.startPrompt(prompt), { code: "invalid_state" });
  decision.resolve("deny"); await handle.completed;
  assert.equal((await (await p.client.startPrompt(prompt)).completed).stopReason, "end_turn");
  assert.equal(p.wire.filter(message => message.method === "session/new").length, 1);
  assert.deepEqual(p.wire.filter(message => message.method === "session/prompt").map(message => message.params.sessionId), ["session-1", "session-1"]);
});

test("native always-allow is never selected when one-time permission is absent", { timeout: 5000 }, async t => {
  const p = setup(t, { onPermission: async () => "approve_once" }, (message, peer) => {
    if (message.method === "session/prompt") {
      peer.send({ jsonrpc: "2.0", method: "session/request_permission", id: "permission-1", params: {
        sessionId: "session-1", toolCall: { toolCallId: "tool-1", title: "Fixture" },
        options: [{ optionId: "always", name: "Always", kind: "allow_always" }],
      } }); return true;
    }
    if (message.id === "permission-1") { peer.result(p.wire.find(message => message.method === "session/prompt").id, { stopReason: "end_turn" }); return true; }
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  await (await p.client.startPrompt(prompt)).completed;
  assert.deepEqual(p.wire.find(message => message.id === "permission-1").result.outcome, { outcome: "cancelled" });
});

test("mutating callback data cannot substitute the approved native option", { timeout: 5000 }, async t => {
  const p = setup(t, { onPermission: async request => { request.params.options[0].optionId = "always"; return "approve_once"; } });
  await p.client.initialize(); await p.client.openSession(configuration);
  await (await p.client.startPrompt(prompt)).completed;
  assert.equal(p.wire.find(message => message.id === "permission-1").result.outcome.optionId, "once");
});

for (const method of ["session/update", "session/request_permission"]) test(`cross-session ${method} fails without delivering content or permission`, { timeout: 5000 }, async t => {
  let approvals = 0;
  const p = setup(t, { onPermission: async () => { approvals++; return "approve_once"; } }, (message, peer) => {
    if (message.method !== "session/prompt") return;
    peer.send({ jsonrpc: "2.0", method, ...(method === "session/request_permission" ? { id: "wrong-session" } : {}), params: {
      sessionId: "other-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "private" } },
      toolCall: { toolCallId: "tool-1", title: "Private" }, options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
    } }); return true;
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  await assert.rejects((await p.client.startPrompt(prompt)).completed, { code: "binding_mismatch" });
  assert.equal(approvals, 0); assert.equal(p.events.length, 0);
});

for (const name of ["Kimi CLI", "unknown", "openclaw-acp"]) test(`Kimi live identity rejects ${name}`, { timeout: 5000 }, async t => {
  const p = setup(t, {}, (message, peer) => {
    if (message.method !== "initialize") return;
    peer.result(message.id, { protocolVersion: 1, agentInfo: { name, version: "fixture-1" }, agentCapabilities: {} }); return true;
  });
  await assert.rejects(p.client.initialize(), { code: "binding_mismatch" });
  assert.equal(p.wire.length, 1);
});

for (const malformed of ["secret-native-banner\n", "[{\"private\":\"secret\"}]\n", "{\"jsonrpc\":\"2.0\",\"id\":9876,\"result\":{\"secret\":true}}\n",
  Buffer.from([0xff, 10])]) test("malformed native frames fail without SDK console payload logging", { timeout: 5000 }, async t => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  const p = setup(t, {}, message => {
    if (message.method !== "initialize") return;
    p.output.write(malformed); return true;
  });
  await assert.rejects(p.client.initialize(), { code: "protocol_error", message: "protocol_error" });
  assert.deepEqual(logged, []);
});

test("a duplicate buffered result invalidates the batch before session persistence", { timeout: 5000 }, async t => {
  let commits = 0;
  const p = setup(t, { onSessionAccepted: async () => { commits++; } }, message => {
    if (message.method !== "session/new") return;
    const result = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
    p.output.write(`${result}\n${result}\n`); return true;
  });
  await p.client.initialize();
  await assert.rejects(p.client.openSession(configuration), { code: "protocol_error" });
  assert.equal(commits, 0);
});

test("cancel without terminal evidence times out as unknown, not successfully stopped", { timeout: 5000 }, async t => {
  const p = setup(t, { cancelTimeoutMs: 20, onPermission: async () => new Promise(() => {}) }, message => message.method === "session/cancel");
  await p.client.initialize(); await p.client.openSession(configuration);
  const handle = await p.client.startPrompt(prompt);
  await tick(); await handle.cancel();
  await assert.rejects(handle.completed, { code: "submission_uncertain", outcome: "unknown" });
});

test("a malformed load response cannot be normalized into successful session binding", { timeout: 5000 }, async t => {
  let commits = 0;
  const p = setup(t, { onSessionAccepted: async () => { commits++; } }, (message, peer) => {
    if (message.method === "session/load") { peer.result(message.id, null); return true; }
  });
  await p.client.initialize();
  await assert.rejects(p.client.openSession(configuration, "session-1"), { code: "protocol_error" });
  assert.equal(commits, 0);
});

test("session updates cannot masquerade as reverse requests", { timeout: 5000 }, async t => {
  const p = setup(t, {}, (message, peer) => {
    if (message.method !== "session/prompt") return;
    peer.send({ jsonrpc: "2.0", id: "not-a-notification", method: "session/update", params: {
      sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong frame" } },
    } }); peer.result(message.id, { stopReason: "end_turn" }); return true;
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  await assert.rejects((await p.client.startPrompt(prompt)).completed, { code: "protocol_error" });
  assert.equal(p.events.length, 0);
});

test("native frame and pending update queues are bounded", { timeout: 5000 }, async t => {
  await t.test("oversize frame", async t => {
    const p = setup(t, { frameBytes: 512 }, message => {
      if (message.method !== "initialize") return;
      p.output.write("x".repeat(513)); return true;
    });
    await assert.rejects(p.client.initialize(), { code: "output_limit" });
  });
  await t.test("slow consumer", async t => {
    const p = setup(t, { onUpdate: async () => new Promise(() => {}) }, (message, peer) => {
      if (message.method !== "session/prompt") return;
      for (let index = 0; index < 129; index++) peer.update(`pending-${index}`);
      return true;
    });
    await p.client.initialize(); await p.client.openSession(configuration);
    await assert.rejects((await p.client.startPrompt(prompt)).completed, { code: "output_limit" });
  });
});

test("host delivery failure cannot claim the native output was delivered", { timeout: 5000 }, async t => {
  const p = setup(t, { onUpdate: async () => { throw new Error("private-host-error"); } });
  await p.client.initialize(); await p.client.openSession(configuration);
  await assert.rejects((await p.client.startPrompt(prompt)).completed, { code: "host_commit_failed", message: "host_commit_failed" });
});

test("connection and host deadlines terminate unresponsive operations", { timeout: 5000 }, async t => {
  await t.test("initialize timeout", async t => {
    const p = setup(t, { requestTimeoutMs: 20 }, message => message.method === "initialize");
    await assert.rejects(p.client.initialize(), { code: "timeout", outcome: "not_submitted" });
  });
  await t.test("host persistence timeout", async t => {
    const p = setup(t, { hostTimeoutMs: 20, onSessionAccepted: async () => new Promise(() => {}) });
    await p.client.initialize();
    await assert.rejects(p.client.openSession(configuration), { code: "host_commit_failed", outcome: "not_submitted" });
    assert.equal(p.wire.some(message => message.method === "session/prompt"), false);
  });
});

test("malformed reverse permission is rejected with a redacted SDK error, never granted", { timeout: 5000 }, async t => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  let asked = false;
  const p = setup(t, { onPermission: async () => { asked = true; return "approve_once"; } }, (message, peer) => {
    if (message.method === "session/prompt") {
      peer.send({ jsonrpc: "2.0", id: "bad-permission", method: "session/request_permission", params: {
        sessionId: "session-1", toolCall: "secret-invalid-payload", options: "secret-invalid-options",
      } }); return true;
    }
    if (message.id === "bad-permission") { peer.result(p.wire.find(message => message.method === "session/prompt").id, { stopReason: "refusal" }); return true; }
  });
  await p.client.initialize(); await p.client.openSession(configuration);
  assert.equal((await (await p.client.startPrompt(prompt)).completed).stopReason, "refusal");
  assert.equal(asked, false); assert.deepEqual(logs, []);
  const reply = p.wire.find(message => message.id === "bad-permission");
  assert.equal(reply.error.message, "Native ACP request failed.");
  assert.equal(JSON.stringify(reply).includes("secret"), false);
});

test("an oversized outgoing prompt rejected before stdin is not an unknown submission", { timeout: 5000 }, async t => {
  const p = setup(t, { frameBytes: 512 });
  await p.client.initialize(); await p.client.openSession(configuration);
  await assert.rejects((await p.client.startPrompt([{ type: "text", text: "x".repeat(1024) }])).completed,
    error => error.outcome === "not_submitted");
  assert.equal(p.wire.some(message => message.method === "session/prompt"), false);
});
