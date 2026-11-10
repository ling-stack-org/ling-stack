import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpLiveClient } from "../dist/runtime/acp/live-client.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const file = { sessionId: "session-1", path: join(tmpdir(), "protocol-only.txt") };
const pending = () => new Promise(() => {});

function handler(overrides = {}) {
  return { receive() {}, execute: async () => ({ content: "safe result" }), beforeReply() {}, onReplyOutcome() {}, ...overrides };
}

function setup(t, options = {}, onMessage) {
  const output = new PassThrough();
  const wire = [];
  const abort = new AbortController();
  const send = (...values) => output.write(values.map(value => JSON.stringify(value) + "\n").join(""));
  const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
  const request = (id = "file-1", method = "fs/read_text_file", params = file) => ({ jsonrpc: "2.0", id, method, params });
  let promptId;
  const input = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString());
    wire.push(message);
    if (message.method === "initialize") result(message.id, { protocolVersion: 1,
      agentInfo: { name: "Kimi Code CLI", version: "fixture-1" }, agentCapabilities: { loadSession: true } });
    if (message.method === "session/new") result(message.id, { sessionId: "session-1" });
    if (message.method === "session/load") result(message.id, {});
    if (message.method === "session/prompt") promptId = message.id;
    if (message.method === "session/cancel") result(promptId, { stopReason: "cancelled" });
    onMessage?.(message, { send, result, promptId });
    if (options.writeComplete?.(message, callback) !== true) callback();
  } });
  const client = new AcpLiveClient({ input, output, signal: abort.signal, engineId: "kimi-acp", expectedVersion: "fixture-1",
    requestTimeoutMs: 1000, turnTimeoutMs: 4000, hostFileTimeoutMs: 1000,
    onSessionAccepted: async () => {}, onPromptSubmitting: async () => {}, onUpdate: async () => {}, onPermission: async () => "deny", ...options });
  t.after(async () => {
    client.close();
    if (options.closeError) await assert.rejects(client.closed, { code: options.closeError });
    else await client.closed;
  });
  return { client, wire, abort, send, request, result,
    async start() { await client.initialize(); await client.openSession({ cwd: tmpdir() });
      const handle = await client.startPrompt([{ type: "text", text: "Protocol fixture, no model." }]); await tick(); return handle; },
    finish: () => result(promptId, { stopReason: "end_turn" }),
    async reply(id = "file-1") {
      for (let i = 0; i < 100; i++) { const value = wire.find(item => item.id === id && !item.method); if (value) return value; await tick(); }
      assert.fail(`No reply for ${id}`);
    },
  };
}

test("ACP advertises only a complete installed host file port", async t => {
  const p = setup(t, { hostFiles: { readTextFile: handler() } });
  const active = await p.start();
  assert.deepEqual(p.wire[0].params.clientCapabilities, { fs: { readTextFile: true, writeTextFile: false } });
  p.send(p.request("write-1", "fs/write_text_file", { ...file, content: "must not write" }));
  assert.equal((await p.reply("write-1")).error.code, -32601);
  p.finish(); await active.completed;
  assert.throws(() => setup(t, { hostFiles: { readTextFile: { execute: async () => ({ content: "unchecked" }) } } }), { code: "invalid_input" });
});

test("ACP cancelled buffered file requests never invoke host execution", async t => {
  const calls = [];
  const p = setup(t, { hostFiles: { readTextFile: handler({ receive: () => calls.push("receive"),
    execute: async () => { calls.push("execute"); return { content: "private" }; } }) } });
  const active = await p.start();
  p.send(p.request(), { jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: "file-1" } });
  assert.equal((await p.reply()).error.code, -32800);
  assert.deepEqual(calls, ["receive"]);
  p.finish(); await active.completed;
});

for (const kind of ["terminal", "cancel", "close"]) test(`ACP ${kind} aborts a waiting file effect before it writes`, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-acp-cancel-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sentinel.txt");
  await writeFile(path, "original");
  const began = Promise.withResolvers();
  const decision = Promise.withResolvers();
  const settled = Promise.withResolvers();
  const outcomes = [];
  const p = setup(t, { hostFiles: { writeTextFile: handler({ execute: async (request, signal) => {
    began.resolve(signal);
    try { await decision.promise; signal.throwIfAborted(); await writeFile(request.params.path, request.params.content, { signal }); return {}; }
    finally { settled.resolve(); }
  }, onReplyOutcome: value => outcomes.push(value) }) } });
  const active = await p.start();
  p.send(p.request("file-1", "fs/write_text_file", { sessionId: "session-1", path, content: "changed" }));
  const signal = await began.promise;
  if (kind === "terminal") { p.finish(); await active.completed; }
  if (kind === "cancel") { await active.cancel(); await active.completed; }
  if (kind === "close") { p.client.close(); await assert.rejects(active.completed, { code: "cancelled" }); }
  assert.equal(signal.aborted, true);
  decision.resolve(); await settled.promise; await tick();
  assert.equal(await readFile(path, "utf8"), "original");
  assert.equal(p.wire.some(item => item.id === "file-1" && item.result), false);
  assert.deepEqual(outcomes.map(value => value.outcome), ["not_written"]);
});

test("ACP terminal receipt overtakes a file request before SDK execution", async t => {
  let executed = 0;
  const p = setup(t, { hostFiles: { readTextFile: handler({ execute: async () => { executed++; return { content: "late" }; } }) } });
  const active = await p.start();
  const promptId = p.wire.find(item => item.method === "session/prompt").id;
  p.send(p.request(), { jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  await active.completed; await tick();
  assert.equal(executed, 0);
  assert.equal(p.wire.some(item => item.id === "file-1" && item.result), false);
});

test("ACP closed waits for a cancelled host operation to reap and settle", async t => {
  const began = Promise.withResolvers(), reaped = Promise.withResolvers(), settle = Promise.withResolvers();
  let settled = false;
  const p = setup(t, { hostFiles: { writeTextFile: handler({ execute: async (_request, signal) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    const kill = () => child.kill("SIGKILL");
    const closed = new Promise(resolve => child.once("close", resolve));
    signal.addEventListener("abort", kill, { once: true });
    began.resolve();
    try {
      if (signal.aborted) kill();
      await closed; reaped.resolve();
      await settle.promise;
      signal.throwIfAborted();
      return {};
    } finally { signal.removeEventListener("abort", kill); settled = true; }
  } }) } });
  const active = await p.start();
  p.send(p.request("file-1", "fs/write_text_file", { ...file, content: "fixture" }));
  await began.promise;
  p.client.close();
  await assert.rejects(active.completed, { code: "cancelled" });
  let closed = false;
  const closing = p.client.closed.then(() => { closed = true; });
  try {
    await reaped.promise; await tick();
    assert.equal(closed, false, "Connection close is not host effect cleanup completion");
    settle.resolve(); await closing;
    assert.equal(settled, true);
  } finally { settle.resolve(); await closing; }
});

for (const [name, params, code] of [
  ["foreign session", { ...file, sessionId: "other" }, "binding_mismatch"],
  ["relative path", { ...file, path: "relative.txt" }, "protocol_error"],
  ["NUL path", { ...file, path: file.path + "\0" }, "protocol_error"],
  ["zero line", { ...file, line: 0 }, "protocol_error"],
  ["negative limit", { ...file, limit: -1 }, "protocol_error"],
  ["string limit", { ...file, limit: "1" }, "protocol_error"],
  ["fractional line", { ...file, line: 1.5 }, "protocol_error"],
  ["overflow limit", { ...file, limit: 4294967296 }, "protocol_error"],
  ["unknown argument", { ...file, cwd: "/outside" }, "protocol_error"],
  ["malformed metadata", { ...file, _meta: "not a map" }, "protocol_error"],
]) test(`ACP rejects ${name} before host preparation or effect`, async t => {
  const calls = [];
  const p = setup(t, { hostFiles: { readTextFile: handler({ receive: () => calls.push("receive"), execute: async () => { calls.push("execute"); return { content: "unsafe" }; } }) } });
  const active = await p.start();
  p.send(p.request("file-1", "fs/read_text_file", params));
  await assert.rejects(active.completed, { code });
  assert.deepEqual(calls, []);
});

for (const phase of ["ready", "loaded", "completed"]) test(`ACP cannot execute a host file request in ${phase} state`, async t => {
  let calls = 0;
  const p = setup(t, { hostFiles: { readTextFile: handler({ receive: () => { calls++; } }) } });
  await p.client.initialize();
  if (phase !== "ready") await p.client.openSession({ cwd: tmpdir() }, "session-1");
  if (phase === "completed") { const active = await p.client.startPrompt([{ type: "text", text: "fixture" }]); await tick(); p.finish(); await active.completed; }
  p.send(p.request()); await p.client.closed;
  assert.equal(calls, 0);
  assert.equal(p.wire.some(item => item.id === "file-1" && item.result), false);
});

test("ACP immutable file snapshots preserve ranges and ignore metadata authority", async t => {
  const seen = [];
  const port = handler({ receive: request => { request.params.path = "/changed"; }, execute: async request => {
    seen.push(request); request.params.path = "/changed-again"; return { content: "line 2\nline 3\n" };
  }, beforeReply: request => seen.push(request) });
  const p = setup(t, { hostFiles: { readTextFile: port } });
  // Installed handler functions cannot be replaced after initialization.
  port.execute = async () => ({ content: "replaced" });
  const active = await p.start();
  p.send(p.request("file-1", "fs/read_text_file", { ...file, line: 2, limit: 2, _meta: { approved: true } }));
  assert.deepEqual((await p.reply()).result, { content: "line 2\nline 3\n" });
  assert.deepEqual(seen[1], { requestId: "file-1", params: { ...file, line: 2, limit: 2 } });
  p.finish(); await active.completed;
});

test("ACP zero-line limit remains an explicit empty read rather than an unbounded read", async t => {
  let received;
  const p = setup(t, { hostFiles: { readTextFile: handler({ execute: async request => {
    received = request.params; return { content: request.params.limit === 0 ? "" : "must not read" };
  } }) } });
  const active = await p.start(); p.send(p.request("file-1", "fs/read_text_file", { ...file, limit: 0 }));
  assert.deepEqual((await p.reply()).result, { content: "" });
  assert.deepEqual(received, { ...file, limit: 0 });
  p.finish(); await active.completed;
});

for (const phase of ["receive", "beforeReply"]) for (const failure of ["throw", "async", "close"]) {
  test(`ACP ${phase} ${failure} cannot deliver unchecked file data`, async t => {
    let executed = 0;
    let p;
    const port = handler({ execute: async () => { executed++; return { content: "hidden" }; }, [phase]: () => {
      if (failure === "throw") throw new Error("secret path");
      if (failure === "async") return Promise.resolve();
      p.client.close();
    } });
    p = setup(t, { hostFiles: { readTextFile: port } });
    const active = await p.start(); p.send(p.request());
    await assert.rejects(active.completed, { code: failure === "close" ? "cancelled" : "host_commit_failed" });
    assert.equal(executed, phase === "receive" ? 0 : 1);
    assert.equal(p.wire.some(item => item.id === "file-1" && item.result), false);
    assert.equal(JSON.stringify(p.wire).includes("secret path"), false);
  });
}

for (const [name, error, code] of [
  ["not found", RequestError.resourceNotFound("file:///private/key"), -32002],
  ["denied", new RequestError(-32000, "secret content", { private: "secret content" }), -32000],
  ["IO failed", new Error("/private/key: secret content"), -32603],
]) test(`ACP preserves safe ${name} errors without host details`, async t => {
  const p = setup(t, { hostFiles: { readTextFile: handler({ execute: async () => { throw error; } }) } });
  const active = await p.start(); p.send(p.request());
  const reply = await p.reply();
  assert.equal(reply.error.code, code);
  assert.equal(reply.error.data, undefined);
  assert.equal(JSON.stringify(reply).includes("private/key"), false);
  assert.equal(JSON.stringify(reply).includes("secret content"), false);
  p.finish(); await active.completed;
});

test("ACP host deadline aborts an uncooperative file callback without disclosing late data", async t => {
  const started = Promise.withResolvers();
  const p = setup(t, { hostFileTimeoutMs: 20, closeError: "host_cleanup_failed",
    hostFiles: { readTextFile: handler({ execute: async (_request, signal) => { started.resolve(signal); return pending(); } }) } });
  const active = await p.start(); p.send(p.request());
  const signal = await started.promise;
  await assert.rejects(active.completed, { code: "host_commit_failed" });
  assert.equal(signal.aborted, true);
  assert.equal(p.wire.some(item => item.id === "file-1" && item.result), false);
  await assert.rejects(p.client.closed, { code: "host_cleanup_failed" });
});

test("ACP write observation remains unknown when peer terminal precedes the local callback", async t => {
  const outcomes = [];
  const p = setup(t, { hostFiles: { readTextFile: handler({ onReplyOutcome: value => outcomes.push(value) }) } }, (message, peer) => {
    if (message.id === "file-1" && message.result) peer.result(peer.promptId, { stopReason: "end_turn" });
  });
  const active = await p.start(); p.send(p.request());
  await active.completed; await tick();
  assert.deepEqual(outcomes, [{ requestId: "file-1", method: "fs/read_text_file", outcome: "unknown" }]);
  assert.deepEqual((await p.reply()).result, { content: "safe result" });
});

test("ACP queued results cannot disclose file contents after request cancellation", async t => {
  const held = Promise.withResolvers();
  const produced = Promise.withResolvers();
  const outcomes = [];
  const p = setup(t, { writeComplete: (message, callback) => {
    if (message.id === "first" && message.result) { held.resolve(callback); return true; }
  }, hostFiles: { readTextFile: handler({ execute: async request => {
    if (request.requestId === "second") produced.resolve();
    return { content: request.requestId === "second" ? "private second result" : "first result" };
  }, onReplyOutcome: value => outcomes.push(value) }) } });
  const active = await p.start(); p.send(p.request("first"));
  const release = await held.promise;
  p.send(p.request("second")); await produced.promise; await tick();
  p.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: "second" } }); await tick();
  release();
  assert.equal((await p.reply("second")).error.code, -32800);
  assert.equal(JSON.stringify(p.wire).includes("private second result"), false);
  assert.equal(outcomes.find(value => value.requestId === "second").outcome, "not_written");
  p.finish(); await active.completed;
});

test("ACP completed file IO is not relabelled no-effect when its reply is cancelled", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-acp-file-effect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sentinel.txt");
  await writeFile(path, "before");
  const written = Promise.withResolvers();
  const release = Promise.withResolvers();
  const outcomes = [];
  const p = setup(t, { hostFiles: { writeTextFile: handler({ execute: async (request, signal) => {
    signal.throwIfAborted(); await writeFile(request.params.path, request.params.content, { signal });
    written.resolve(); await release.promise; return {};
  }, onReplyOutcome: value => outcomes.push(value) }) } });
  const active = await p.start(); p.send(p.request("file-1", "fs/write_text_file", { sessionId: "session-1", path, content: "after" }));
  await written.promise; await active.cancel(); await active.completed;
  release.resolve(); await tick();
  assert.equal(await readFile(path, "utf8"), "after");
  assert.deepEqual(outcomes.map(value => value.outcome), ["not_written"]);
  assert.equal(p.wire.some(value => value.id === "file-1" && value.result), false);
});

for (const [name, result, method] of [
  ["missing content", {}, "fs/read_text_file"],
  ["non-string content", { content: 3 }, "fs/read_text_file"],
  ["extra response data", { content: "x", private: "not public" }, "fs/read_text_file"],
  ["non-object write result", undefined, "fs/write_text_file"],
  ["extra write result", { content: "not public" }, "fs/write_text_file"],
]) test(`ACP rejects ${name} from a host port`, async t => {
  const port = handler({ execute: async () => result });
  const p = setup(t, { hostFiles: { readTextFile: port, writeTextFile: port } });
  const active = await p.start(); p.send(p.request("file-1", method, method === "fs/write_text_file" ? { ...file, content: "input" } : file));
  await assert.rejects(active.completed, { code: "host_commit_failed" });
  assert.equal(p.wire.some(value => value.id === "file-1" && value.result), false);
});

test("ACP host response budget rejects oversized data before wire disclosure", async t => {
  const p = setup(t, { hostFiles: { readTextFile: handler({ execute: async () => ({ content: "x".repeat(16 * 1024 * 1024) }) }) } });
  const active = await p.start(); p.send(p.request());
  await assert.rejects(active.completed, { code: "output_limit" });
  assert.equal(p.wire.some(value => value.id === "file-1" && value.result), false);
});

test("ACP pending host file requests have an aggregate byte budget", async t => {
  let received = 0;
  const p = setup(t, { closeError: "host_cleanup_failed",
    hostFiles: { writeTextFile: handler({ receive: () => { received++; }, execute: pending }) } });
  const active = await p.start();
  for (let i = 0; i < 3; i++) {
    p.send(p.request(`file-${i}`, "fs/write_text_file", { ...file, content: "x".repeat(6 * 1024 * 1024) }));
    await tick();
  }
  await assert.rejects(active.completed, { code: "output_limit" });
  assert.equal(received, 2);
  await assert.rejects(p.client.closed, { code: "host_cleanup_failed" });
});

for (const behavior of ["throw", "async"]) test(`ACP ${behavior} delivery observer failure stops further host work`, async t => {
  const p = setup(t, { hostFiles: { readTextFile: handler({ onReplyOutcome: () => {
    if (behavior === "throw") throw new Error("private failure");
    return Promise.resolve();
  } }) } });
  const active = await p.start(); p.send(p.request());
  await assert.rejects(active.completed, { code: "host_commit_failed" });
  assert.equal(JSON.stringify(p.wire).includes("private failure"), false);
});

test("ACP file request ids cannot execute twice while still pending", async t => {
  let effects = 0;
  const p = setup(t, { closeError: "host_cleanup_failed",
    hostFiles: { readTextFile: handler({ execute: () => { effects++; return pending(); } }) } });
  const active = await p.start();
  p.send(p.request()); await tick();
  p.send(p.request());
  await assert.rejects(active.completed, { code: "protocol_error" });
  assert.equal(effects, 1);
  await assert.rejects(p.client.closed, { code: "host_cleanup_failed" });
});
