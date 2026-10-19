import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpLiveClient } from "../dist/runtime/acp/live-client.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const handler = execute => ({ receive() {}, execute, beforeReply() {}, onReplyOutcome() {} });
const createParams = { sessionId: "session-1", command: "fixture", args: ["literal argument"], cwd: tmpdir(), outputByteLimit: 64 };
function terminalPort(overrides = {}) {
  return { create: handler(async request => ({ terminalId: request.params.terminalId })),
    output: handler(async () => ({ output: "running", truncated: false })),
    waitForExit: handler(async () => ({ exitCode: 0 })), kill: handler(async () => ({})),
    release: handler(async () => ({})), async dispose() {}, ...overrides };
}

test("ACP terminal support is absent by default and partial ports cannot advertise it", async t => {
  const p = setup(t);
  const active = await p.start();
  assert.deepEqual(p.wire[0].params.clientCapabilities, {});
  p.request("absent", "terminal/create", createParams);
  assert.equal((await p.reply("absent")).error.code, -32601);
  p.finish(); await active.completed;
  for (const name of ["create", "output", "waitForExit", "kill", "release", "dispose"]) {
    assert.throws(() => setup(t, { hostTerminals: terminalPort({ [name]: undefined }) }), { code: "invalid_input" });
  }
});

for (const [name, patch] of [
  ["foreign session", { sessionId: "other" }], ["selected handle", { terminalId: "native-id" }],
  ["shell option", { shell: true }], ["NUL command", { command: "test\0" }], ["relative cwd", { cwd: "relative" }],
  ["invalid arguments", { args: [42] }], ["null arguments", { args: null }],
  ["invalid env", { env: [{ name: "A=B", value: "c" }] }], ["NUL env", { env: [{ name: "A", value: "\0" }] }],
  ["duplicate env", { env: [{ name: "A", value: "1" }, { name: "A", value: "2" }] }],
  ["negative output limit", { outputByteLimit: -1 }], ["fractional output limit", { outputByteLimit: 0.5 }],
  ["string output limit", { outputByteLimit: "10" }], ["invalid metadata", { _meta: true }],
]) test(`ACP rejects terminal ${name} before reserving or launching host work`, async t => {
  let effects = 0;
  const port = terminalPort({ create: { ...handler(async () => { effects++; return {}; }), receive() { effects++; } } });
  const p = setup(t, { hostTerminals: port }); const active = await p.start();
  p.request("invalid", "terminal/create", { ...createParams, ...patch });
  await assert.rejects(active.completed, { code: name === "foreign session" ? "binding_mismatch" : "protocol_error" });
  assert.equal(effects, 0);
});

test("ACP terminal snapshots ignore metadata and cannot be replaced after initialization", async t => {
  let captured;
  const create = handler(async request => { captured = request.params; return { terminalId: request.params.terminalId }; });
  const port = terminalPort({ create });
  const p = setup(t, { hostTerminals: port }); const active = await p.start();
  create.execute = async () => { throw new Error("replaced"); };
  const id = await p.create("create", { ...createParams, _meta: { approval: "always" },
    env: [{ name: "NO_COLOR", value: "1", _meta: { permission: "all" } }], outputByteLimit: 4294967295 });
  assert.deepEqual(captured, { ...createParams, terminalId: id, env: [{ name: "NO_COLOR", value: "1" }], outputByteLimit: 4 * 1024 * 1024 });
  p.finish(); await active.completed;
});

test("ACP retired prompt handles cannot be used by a new prompt in the same session", async t => {
  let reads = 0;
  const p = setup(t, { hostTerminals: terminalPort({ output: handler(async () => { reads++; return { output: "private", truncated: false }; }) }) });
  const first = await p.start(); const terminalId = await p.create(); p.finish(); await first.completed;
  const second = await p.next();
  p.request("foreign", "terminal/output", { sessionId: "session-1", terminalId });
  assert.equal((await p.reply("foreign")).error.code, -32002); assert.equal(reads, 0);
  p.finish(); await second.completed;
});

test("ACP output cannot read an undisclosed terminal handle", async t => {
  const held = Promise.withResolvers(); let allocated, reads = 0;
  const p = setup(t, { writeComplete(message, callback) { if (message.id === "create-1") { held.resolve(callback); return true; } },
    hostTerminals: terminalPort({ create: handler(async request => { allocated = request.params.terminalId; return { terminalId: allocated }; }),
      output: handler(async () => { reads++; return { output: "private", truncated: false }; }) }) });
  const active = await p.start(); p.request("create-1", "terminal/create", createParams);
  const release = await held.promise;
  p.request("early", "terminal/output", { sessionId: "session-1", terminalId: allocated }); await tick();
  release(); assert.equal((await p.reply("early")).error.code, -32002); assert.equal(reads, 0);
  p.finish(); await active.completed;
});

for (const phase of ["receive", "beforeReply", "onReplyOutcome"]) for (const behavior of ["throw", "async"]) {
  test(`ACP terminal ${phase} ${behavior} fails without disclosing host error details`, async t => {
    const port = terminalPort();
    port.create[phase] = () => { if (behavior === "throw") throw new Error("private-key-secret"); return Promise.resolve(); };
    const p = setup(t, { hostTerminals: port }); const active = await p.start();
    p.request("create", "terminal/create", createParams);
    await assert.rejects(active.completed, { code: "host_commit_failed" });
    assert.equal(JSON.stringify(p.wire).includes("private-key-secret"), false);
  });
}

for (const result of [{}, { exitCode: 0, signal: "SIGTERM" }, { exitCode: -1 }, { signal: "private text" }, { exitCode: 0, extra: "secret" }]) {
  test(`ACP rejects invalid terminal exit ${JSON.stringify(result)}`, async t => {
    const p = setup(t, { hostTerminals: terminalPort({ waitForExit: handler(async () => result) }) });
    const active = await p.start(), terminalId = await p.create();
    p.request("wait", "terminal/wait_for_exit", { sessionId: "session-1", terminalId });
    await assert.rejects(active.completed, { code: "host_commit_failed" });
    assert.equal(p.wire.some(item => item.id === "wait" && item.result), false);
  });
}

test("ACP terminal executor errors retain safe categories without secrets", async t => {
  const p = setup(t, { hostTerminals: terminalPort({ create: handler(async () => {
    throw new RequestError(-32000, "private-key-secret", { path: "/private/file" });
  }) }) });
  const active = await p.start(); p.request("create", "terminal/create", createParams);
  const reply = await p.reply("create"); assert.equal(reply.error.code, -32000); assert.equal(reply.error.data, undefined);
  assert.equal(JSON.stringify(reply).includes("private"), false);
  p.finish(); await active.completed;
});

test("ACP queued terminal output is cancelled by release before disclosure", async t => {
  const held = Promise.withResolvers(), produced = Promise.withResolvers();
  const p = setup(t, { writeComplete(message, callback) { if (message.id === "first") { held.resolve(callback); return true; } },
    hostTerminals: terminalPort({ output: handler(async request => {
      if (request.requestId === "second") produced.resolve();
      return { output: request.requestId === "second" ? "private second output" : "first", truncated: false };
    }) }) });
  const active = await p.start(), terminalId = await p.create(); const params = { sessionId: "session-1", terminalId };
  p.request("first", "terminal/output", params); const release = await held.promise;
  p.request("second", "terminal/output", params); await produced.promise; await tick();
  p.request("release", "terminal/release", params); await tick(); await tick();
  release();
  assert.equal((await p.reply("second")).error.code, -32800);
  assert.equal(JSON.stringify(p.wire).includes("private second output"), false);
  assert.deepEqual((await p.reply("release")).result, {});
  p.finish(); await active.completed;
});

for (const ending of ["finish", "cancel", "close"]) test(`ACP ${ending} waits for actual owned terminal cleanup`, async t => {
  const spawned = Promise.withResolvers(), reaped = Promise.withResolvers(), allowSettlement = Promise.withResolvers();
  let child, closed, disposed = 0;
  const p = setup(t, { hostTerminals: terminalPort({ create: handler(async request => {
    child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    closed = new Promise(resolve => child.once("close", (exitCode, signal) => resolve({ exitCode, signal })));
    spawned.resolve(); return { terminalId: request.params.terminalId };
  }), dispose: async () => { disposed++; child.kill("SIGKILL"); await closed; reaped.resolve(); await allowSettlement.promise; } }) });
  t.after(() => { child?.kill("SIGKILL"); allowSettlement.resolve(); });
  const active = await p.start(); await p.create(); await spawned.promise;
  let completed = false;
  const completion = ending === "close" ? p.client.closed : active.completed;
  const watching = completion.then(() => { completed = true; });
  const failed = ending === "close" ? assert.rejects(active.completed, { code: "cancelled" }) : undefined;
  if (ending === "finish") p.finish();
  if (ending === "cancel") await active.cancel();
  if (ending === "close") p.client.close();
  await reaped.promise; await tick(); assert.equal(completed, false);
  allowSettlement.resolve(); await watching; await failed;
  assert.equal(disposed, 1); assert.equal((await closed).signal, "SIGKILL");
});

test("ACP cancellation during terminal creation disposes only after actual creation settles", async t => {
  const started = Promise.withResolvers(), allowCreate = Promise.withResolvers(); const order = [];
  const p = setup(t, { hostTerminals: terminalPort({ create: handler(async request => {
    started.resolve(); await allowCreate.promise; order.push("created"); return { terminalId: request.params.terminalId };
  }), dispose: async () => { order.push("disposed"); } }) });
  const active = await p.start(); p.request("create", "terminal/create", createParams); await started.promise;
  await active.cancel(); await tick(); assert.deepEqual(order, []);
  allowCreate.resolve(); await active.completed; assert.deepEqual(order, ["created", "disposed"]);
  assert.equal(p.wire.some(item => item.id === "create" && item.result), false);
});

for (const behavior of ["fail", "hang"]) test(`ACP terminal cleanup ${behavior} cannot report successful completion`, async t => {
  const p = setup(t, { closeError: "host_cleanup_failed", hostTerminals: terminalPort({ dispose: async () => {
    if (behavior === "fail") throw new Error("private failure"); await new Promise(() => {});
  } }) });
  const active = await p.start(); await p.create(); p.finish();
  await assert.rejects(active.completed, { code: "host_cleanup_failed" });
  await assert.rejects(p.client.closed, { code: "host_cleanup_failed" });
});

test("ACP reentrant close during handle retirement disposes the terminal once", async t => {
  const waiting = Promise.withResolvers(); let p, disposals = 0;
  p = setup(t, { hostTerminals: terminalPort({ waitForExit: handler(async (_request, signal) => {
    signal.addEventListener("abort", () => { p.client.close(); waiting.resolve(); }, { once: true });
    await waiting.promise; return { signal: "SIGKILL" };
  }), dispose: async () => { disposals++; } }) });
  const active = await p.start(), terminalId = await p.create();
  p.request("wait", "terminal/wait_for_exit", { sessionId: "session-1", terminalId }); await tick();
  p.request("release", "terminal/release", { sessionId: "session-1", terminalId });
  await assert.rejects(active.completed, { code: "cancelled" }); await p.client.closed;
  assert.equal(disposals, 1);
});

test("ACP cancelled wait does not kill its terminal or disclose a late exit", async t => {
  const waiting = Promise.withResolvers(), exit = Promise.withResolvers(); let disposed = 0;
  const p = setup(t, { hostTerminals: terminalPort({ waitForExit: handler(async (_request, signal) => {
    waiting.resolve(signal); return exit.promise;
  }), dispose: async () => { disposed++; } }) });
  const active = await p.start(), terminalId = await p.create(), params = { sessionId: "session-1", terminalId };
  p.request("wait", "terminal/wait_for_exit", params); const signal = await waiting.promise;
  p.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: "wait" } });
  assert.equal((await p.reply("wait")).error.code, -32800); assert.equal(signal.aborted, true); assert.equal(disposed, 0);
  p.request("output", "terminal/output", params); assert.equal((await p.reply("output")).result.output, "running");
  exit.resolve({ exitCode: 0 }); p.finish(); await active.completed; assert.equal(disposed, 1);
});

for (const end of ["cancel", "terminal"]) test(`ACP buffered ${end} prevents a terminal from launching`, async t => {
  let launches = 0;
  const p = setup(t, { hostTerminals: terminalPort({ create: handler(async request => {
    launches++; return { terminalId: request.params.terminalId };
  }) }) });
  const active = await p.start();
  const create = { jsonrpc: "2.0", id: "create", method: "terminal/create", params: createParams };
  const promptId = p.wire.find(message => message.method === "session/prompt").id;
  p.send(create, end === "cancel" ? { jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: "create" } }
    : { jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  if (end === "cancel") { assert.equal((await p.reply("create")).error.code, -32800); p.finish(); }
  await active.completed; assert.equal(launches, 0);
});

for (const exitCode of [0, 7]) test(`ACP preserves actual command output and exit ${exitCode}`, async t => {
  let child, exited, actualOutput = "";
  const ready = Promise.withResolvers();
  const p = setup(t, { hostTerminals: terminalPort({ create: handler(async request => {
    child = spawn(process.execPath, ["-e", `process.stdout.write("actual child output"); process.exitCode=${exitCode};`], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", bytes => { actualOutput += bytes.toString(); });
    exited = new Promise(resolve => child.once("close", (code, signal) => resolve(signal ? { signal } : { exitCode: code })));
    ready.resolve(); return { terminalId: request.params.terminalId };
  }), output: handler(async () => ({ output: actualOutput, truncated: false, exitStatus: await exited })),
    waitForExit: handler(async () => exited), dispose: async () => { if (child.exitCode === null) child.kill("SIGKILL"); await exited; } }) });
  const active = await p.start(), terminalId = await p.create(), params = { sessionId: "session-1", terminalId };
  await ready.promise; await exited;
  p.request("wait", "terminal/wait_for_exit", params); assert.deepEqual((await p.reply("wait")).result, { exitCode });
  p.request("output", "terminal/output", params);
  assert.deepEqual((await p.reply("output")).result, { output: "actual child output", truncated: false, exitStatus: { exitCode } });
  p.request("release", "terminal/release", params); assert.deepEqual((await p.reply("release")).result, {});
  p.finish(); await active.completed;
});

test("ACP kill preserves its actual signal exit until release", async t => {
  let child, exited;
  const p = setup(t, { hostTerminals: terminalPort({ create: handler(async request => {
    child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    exited = new Promise(resolve => child.once("close", (exitCode, signal) => resolve({ exitCode, signal })));
    return { terminalId: request.params.terminalId };
  }), kill: handler(async () => { child.kill("SIGTERM"); await exited; return {}; }),
    waitForExit: handler(async () => exited), dispose: async () => { child.kill("SIGKILL"); await exited; } }) });
  const active = await p.start(), terminalId = await p.create(), params = { sessionId: "session-1", terminalId };
  p.request("kill", "terminal/kill", params); await exited;
  assert.deepEqual((await p.reply("kill")).result, {});
  p.request("wait", "terminal/wait_for_exit", params);
  assert.deepEqual((await p.reply("wait")).result, { exitCode: null, signal: "SIGTERM" });
  p.finish(); await active.completed;
});

test("ACP failed prompt completion waits for its terminal cleanup as well as closed", async t => {
  const cleaning = Promise.withResolvers(), allow = Promise.withResolvers();
  const p = setup(t, { hostTerminals: terminalPort({ dispose: async () => { cleaning.resolve(); await allow.promise; } }) });
  t.after(() => allow.resolve());
  const active = await p.start(); await p.create();
  let settled = false;
  const completion = active.completed.catch(error => { settled = true; throw error; });
  void completion.catch(() => {});
  p.client.close(); await cleaning.promise; await tick();
  try { assert.equal(settled, false, "Rejected completion must not precede actual terminal cleanup"); }
  finally { allow.resolve(); }
  await assert.rejects(completion, { code: "cancelled" }); await p.client.closed;
});

test("ACP cancelled waits retain actual execution quota until they settle", async t => {
  const exit = Promise.withResolvers(); let executions = 0;
  const p = setup(t, { hostTerminals: terminalPort({ waitForExit: handler(async () => { executions++; return exit.promise; }),
    dispose: async () => { exit.resolve({ signal: "SIGKILL" }); } }) });
  const active = await p.start(), terminalId = await p.create();
  for (let i = 0; i < 64; i++) {
    const id = `wait-${i}`;
    p.request(id, "terminal/wait_for_exit", { sessionId: "session-1", terminalId }); await tick();
    p.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: id } });
    assert.equal((await p.reply(id)).error.code, -32800);
  }
  p.request("overflow", "terminal/wait_for_exit", { sessionId: "session-1", terminalId });
  await assert.rejects(active.completed, { code: "output_limit" }); assert.equal(executions, 64);
});

test("ACP terminal output also respects the escaped JSON frame budget", async t => {
  const p = setup(t, { frameBytes: 512,
    hostTerminals: terminalPort({ output: handler(async () => ({ output: "\x1b".repeat(150) + "你好", truncated: false })) }) });
  const active = await p.start(), terminalId = await p.create("create", { ...createParams, outputByteLimit: 4096 });
  p.request("output", "terminal/output", { sessionId: "session-1", terminalId });
  const reply = await p.reply("output");
  assert.equal(reply.result.truncated, true); assert.equal(reply.result.output.endsWith("你好"), true);
  assert.ok(Buffer.byteLength(JSON.stringify(reply) + "\n") <= 512);
  p.finish(); await active.completed;
});

test("ACP cancelled terminal requests retain input bytes until actual settlement", async t => {
  const finish = Promise.withResolvers(); let creations = 0;
  const p = setup(t, { hostTerminals: terminalPort({ create: handler(async request => {
    creations++; await finish.promise; return { terminalId: request.params.terminalId };
  }) }) });
  const active = await p.start();
  for (let i = 0; i < 2; i++) {
    const id = `create-${i}`;
    p.request(id, "terminal/create", { ...createParams, args: ["x".repeat(6 * 1024 * 1024)] }); await tick();
    p.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: id } });
    assert.equal((await p.reply(id)).error.code, -32800);
  }
  p.request("overflow", "terminal/create", { ...createParams, args: ["x".repeat(6 * 1024 * 1024)] });
  await tick(); finish.resolve();
  await assert.rejects(active.completed, { code: "output_limit" }); assert.equal(creations, 2);
});

test("ACP request cancellation cannot discard an unsettled operation deadline", async t => {
  const waiting = Promise.withResolvers(), finish = Promise.withResolvers();
  const p = setup(t, { hostTerminalTimeoutMs: 30, hostTerminals: terminalPort({ waitForExit: handler(async () => {
    waiting.resolve(); return finish.promise;
  }), dispose: async () => { finish.resolve({ signal: "SIGKILL" }); } }) });
  const active = await p.start(), terminalId = await p.create();
  p.request("wait", "terminal/wait_for_exit", { sessionId: "session-1", terminalId }); await waiting.promise;
  p.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: "wait" } });
  assert.equal((await p.reply("wait")).error.code, -32800);
  await assert.rejects(active.completed, { code: "host_commit_failed" });
});

test("ACP closed cleanup failure does not leave deadlines pinning the host process", async () => {
  const clientUrl = new URL("../dist/runtime/acp/live-client.js", import.meta.url).href;
  const script = `
    import { PassThrough, Writable } from "node:stream";
    import { AcpLiveClient } from ${JSON.stringify(clientUrl)};
    const output = new PassThrough(), started = Promise.withResolvers();
    const send = value => output.write(JSON.stringify(value) + "\\n");
    const input = new Writable({ write(bytes, encoding, callback) {
      const message = JSON.parse(bytes.toString());
      if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "fixture" }, agentCapabilities: {} } });
      if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session" } });
      if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: "read", method: "fs/read_text_file",
        params: { sessionId: "session", path: "/tmp/no-file-read" } });
      callback();
    } });
    const client = new AcpLiveClient({ input, output, signal: new AbortController().signal,
      engineId: "kimi-acp", expectedVersion: "fixture", hostFileTimeoutMs: 60000,
      onSessionAccepted: async () => {}, onPromptSubmitting: async () => {}, onUpdate: async () => {}, onPermission: async () => "deny",
      hostFiles: { readTextFile: { receive() {}, beforeReply() {}, onReplyOutcome() {},
        execute: async () => { started.resolve(); return new Promise(() => {}); } } } });
    await client.initialize(); await client.openSession({ cwd: "/tmp" });
    const active = await client.startPrompt([{ type: "text", text: "No native engine or file effects." }]);
    await started.promise; client.close(); await active.completed.catch(() => {});
    try { await client.closed; process.exitCode = 1; }
    catch (error) { if (error.code !== "host_cleanup_failed") process.exitCode = 2; else process.stdout.write("cleanup_failed_observed"); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", bytes => { output += bytes.toString(); });
  child.stderr.on("data", bytes => { errors += bytes.toString(); });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 6000);
  const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(deadline);
  assert.deepEqual(result, { code: 0, signal: null }, errors);
  assert.equal(output, "cleanup_failed_observed");
});
function setup(t, options = {}, onMessage) {
  const wire = [], output = new PassThrough(), abort = new AbortController();
  let promptId;
  const send = (...values) => output.write(values.map(value => JSON.stringify(value) + "\n").join(""));
  const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
  const request = (id, method, params) => send({ jsonrpc: "2.0", id, method, params });
  const input = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString()); wire.push(message);
    if (message.method === "initialize") result(message.id, { protocolVersion: 1,
      agentInfo: { name: "Kimi Code CLI", version: "fixture-1" }, agentCapabilities: {} });
    if (message.method === "session/new") result(message.id, { sessionId: "session-1" });
    if (message.method === "session/prompt") promptId = message.id;
    if (message.method === "session/cancel") result(promptId, { stopReason: "cancelled" });
    onMessage?.(message, { result, promptId });
    if (options.writeComplete?.(message, callback) !== true) callback();
  } });
  const client = new AcpLiveClient({ input, output, signal: abort.signal, engineId: "kimi-acp", expectedVersion: "fixture-1",
    requestTimeoutMs: 1000, turnTimeoutMs: 4000, hostTerminalTimeoutMs: 1000,
    onSessionAccepted: async () => {}, onPromptSubmitting: async () => {}, onUpdate: async () => {},
    onPermission: async () => "deny", ...options });
  t.after(async () => { client.close(); if (options.closeError) await assert.rejects(client.closed, { code: options.closeError }); else await client.closed; });
  return { client, wire, send, result, request, abort,
    async start() { await client.initialize(); await client.openSession({ cwd: tmpdir() }); return this.next(); },
    async next() { const active = await client.startPrompt([{ type: "text", text: "Owned protocol fixture, no model." }]); await tick(); return active; },
    finish() { result(promptId, { stopReason: "end_turn" }); },
    async reply(id) { for (let i = 0; i < 100; i++) {
      const reply = wire.find(item => item.id === id && !item.method); if (reply) return reply; await tick();
    } assert.fail(`No reply for ${id}`); },
    async create(id = "create-1", params = createParams) { request(id, "terminal/create", params); return (await this.reply(id)).result.terminalId; },
  };
}

test("ACP complete terminal port creates, polls, waits, kills and releases one host-owned handle", async t => {
  const effects = [], disposed = [];
  const hostTerminals = terminalPort({
    create: handler(async ({ params }) => { effects.push(params); return { terminalId: params.terminalId }; }),
    dispose: async id => { disposed.push(id); },
  });
  const p = setup(t, { hostTerminals });
  const active = await p.start();
  assert.deepEqual(p.wire[0].params.clientCapabilities, { terminal: true });
  const terminalId = await p.create();
  assert.equal(typeof terminalId, "string");
  assert.deepEqual(effects, [{ ...createParams, terminalId }]);
  const params = { sessionId: "session-1", terminalId };
  for (const [method, expected] of [["output", { output: "running", truncated: false }],
    ["wait_for_exit", { exitCode: 0 }], ["kill", {}], ["release", {}]]) {
    p.request(method, `terminal/${method}`, params);
    assert.deepEqual((await p.reply(method)).result, expected);
  }
  p.request("stale", "terminal/output", params);
  assert.equal((await p.reply("stale")).error.code, -32002);
  p.finish(); await active.completed;
  assert.deepEqual(disposed, [terminalId]);
});

for (const [limit, expected] of [[0, ""], [1, ""], [3, "好"], [5, "好"], [6, "你好"], [7, "你好"], [10, "你好"]]) {
  test(`ACP output keeps a UTF-8 character boundary at ${limit} bytes`, async t => {
    const p = setup(t, { hostTerminals: terminalPort({ output: handler(async () => ({ output: "你好", truncated: false })) }) });
    const active = await p.start();
    const terminalId = await p.create("create", { ...createParams, outputByteLimit: limit });
    p.request("output", "terminal/output", { sessionId: "session-1", terminalId });
    assert.deepEqual((await p.reply("output")).result, { output: expected, truncated: limit < 6 });
    p.finish(); await active.completed;
  });
}
