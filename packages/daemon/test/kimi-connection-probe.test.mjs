import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

const initialization = {
  protocolVersion: 1,
  agentInfo: { name: "Kimi Code CLI", version: "0.1.0-alpha.4" },
  agentCapabilities: { loadSession: true },
  authMethods: [{ id: "login", type: "terminal", name: "Login with Kimi account", args: ["--login"] }],
};

function peer(t, respond) {
  const output = new PassThrough();
  const messages = [];
  const input = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString());
    messages.push(message);
    callback();
    respond(message, output);
  } });
  t.after(() => { input.destroy(); output.destroy(); });
  return { input, output, messages };
}

async function inspect(p, signal = new AbortController().signal) {
  const { inspectKimiConnection } = await import("../dist/features/execution-engines/kimi-connection.js");
  return inspectKimiConnection({ input: p.input, output: p.output, signal, expectedVersion: "0.1.0-alpha.4" });
}

test("official ACP Kimi check verifies successor identity and configured auth without creating a session", async (t) => {
  const p = peer(t, (message, output) => {
    assert.equal(message.jsonrpc, "2.0");
    if (message.method === "initialize") {
      assert.equal(message.params.protocolVersion, 1);
      assert.deepEqual(message.params.clientCapabilities, {});
      output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: initialization }) + "\n");
    } else {
      assert.equal(message.method, "authenticate");
      assert.deepEqual(message.params, { methodId: "login" });
      output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\n");
    }
  });
  assert.deepEqual(await inspect(p), { connection: "connected", authentication: "configured_unverified" });
  assert.deepEqual(p.messages.map(message => message.method), ["initialize", "authenticate"]);
  assert.equal(p.input.destroyed, true);
  assert.equal(p.output.destroyed, true);
});

test("malformed native input fails without logging its private payload", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  t.mock.method(console, "warn", (...args) => logs.push(args));
  const p = peer(t, (message, output) => {
    output.write("private-broken-frame\n");
    output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      result: message.method === "initialize" ? initialization : {} }) + "\n");
  });
  await assert.rejects(inspect(p), { code: "protocol_error" });
  assert.deepEqual(logs, []);
  assert.equal(p.messages.length, 1);
});

test("ACP auth-required means a connected successor needing login, with no native error disclosure", async (t) => {
  const p = peer(t, (message, output) => output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
    ...(message.method === "initialize" ? { result: initialization }
      : { error: { code: -32000, message: "private-account-details", data: { token: "private-fixture-key" } } }),
  }) + "\n"));
  assert.deepEqual(await inspect(p), { connection: "connected", authentication: "required" });
  assert.deepEqual(p.messages.map(message => message.method), ["initialize", "authenticate"]);
});

for (const [name, response] of [
  ["legacy agent", { ...initialization, agentInfo: { name: "kimi-cli", version: "0.1.0-alpha.4" } }],
  ["version mismatch", { ...initialization, agentInfo: { name: "Kimi Code CLI", version: "0.1.0-alpha.5" } }],
  ["wrong protocol", { ...initialization, protocolVersion: 2 }],
  ["missing auth method", { ...initialization, authMethods: [] }],
  ["invalid capabilities", { ...initialization, agentCapabilities: false }],
]) {
  test(`Kimi check rejects ${name} before authentication`, async (t) => {
    const p = peer(t, (message, output) => output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response }) + "\n"));
    await assert.rejects(inspect(p), { code: "protocol_error" });
    assert.equal(p.messages.length, 1);
  });
}

for (const method of ["session/request_permission", "fs/read_text_file", "fs/write_text_file", "terminal/create", "_private_extension", "session/update"]) {
  test(`connection check never serves reverse ${method}`, async (t) => {
    const p = peer(t, (message, output) => {
      output.write(JSON.stringify({ jsonrpc: "2.0", method, params: { private: "fixture-key" },
        ...(method === "session/update" ? {} : { id: "native-request" }) }) + "\n");
      output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: initialization }) + "\n");
    });
    await assert.rejects(inspect(p), { code: "protocol_error" });
    assert.equal(p.messages.length, 1, "no approvals, host callbacks or subsequent auth requests");
  });
}

test("fragmented UTF-8 responses succeed without returning native metadata", async (t) => {
  const p = peer(t, (message, output) => {
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      result: message.method === "initialize" ? { ...initialization, _meta: { private: "\u4e2d\u6587" } } : {} }) + "\n");
    for (const byte of bytes) output.write(Buffer.from([byte]));
  });
  assert.deepEqual(await inspect(p), { connection: "connected", authentication: "configured_unverified" });
});

test("connection cancellation terminates pending ACP locally without a cooperative server", async (t) => {
  const abort = new AbortController();
  const p = peer(t, () => abort.abort());
  await assert.rejects(inspect(p, abort.signal), { code: "cancelled" });
  assert.equal(p.input.destroyed, true);
  assert.equal(p.output.destroyed, true);
});

test("oversized input is bounded even without a newline", async (t) => {
  const p = peer(t, (_message, output) => output.write(Buffer.alloc(65537, 65)));
  await assert.rejects(inspect(p), { code: "output_limit" });
});

test("native EOF while awaiting an ACP response is a process failure", async (t) => {
  const p = peer(t, (_message, output) => output.end());
  await assert.rejects(inspect(p), { code: "process_failed" });
});

test("an auth response cannot overtake a failed pending stdin write", async (t) => {
  const output = new PassThrough();
  const input = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString());
    output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      result: message.method === "initialize" ? initialization : {} }) + "\n");
    if (message.method === "authenticate") setImmediate(() => callback(new Error("private-write-failure")));
    else callback();
  } });
  t.after(() => { input.destroy(); output.destroy(); });
  await assert.rejects(inspect({ input, output }), { code: "process_failed" });
});

test("cancellation during native stream cleanup cannot publish configured auth", async (t) => {
  const abort = new AbortController();
  const output = new PassThrough();
  const input = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString());
    callback();
    output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      result: message.method === "initialize" ? initialization : {} }) + "\n");
  }, destroy(error, callback) { abort.abort(); callback(error); } });
  t.after(() => { input.destroy(); output.destroy(); });
  await assert.rejects(inspect({ input, output }, abort.signal), { code: "cancelled" });
});

test("stdin closure fails without waiting for a process-wide deadline", async (t) => {
  const p = peer(t, () => setImmediate(() => p.input.end()));
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 300);
  t.after(() => clearTimeout(timeout));
  await assert.rejects(inspect(p, abort.signal), { code: "process_failed" });
});

test("stream destruction failures cannot publish configured auth", async (t) => {
  const output = new PassThrough();
  const input = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString());
    callback();
    output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      result: message.method === "initialize" ? initialization : {} }) + "\n");
  }, destroy(_error, callback) { callback(new Error("private-cleanup-failure")); } });
  t.after(() => { input.destroy(); output.destroy(); });
  await assert.rejects(inspect({ input, output }), { code: "process_failed" });
});

test("a reverse request buffered in a separate chunk before completion invalidates the check", async (t) => {
  const p = peer(t, (message, output) => {
    output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      result: message.method === "initialize" ? initialization : {} }) + "\n");
    if (message.method === "authenticate") output.write(JSON.stringify({ jsonrpc: "2.0", id: 99,
      method: "terminal/create", params: { command: "private-never-execute" } }) + "\n");
  });
  await assert.rejects(inspect(p), { code: "protocol_error" });
  assert.deepEqual(p.messages.map(message => message.method), ["initialize", "authenticate"]);
});
