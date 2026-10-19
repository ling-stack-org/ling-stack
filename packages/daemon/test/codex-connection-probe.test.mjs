import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { inspectCodexConnection, NativeConnectionError } from "../dist/features/execution-engines/codex-connection.js";

const home = "/fixture/codex-home";
const privateText = "private-account-fixture-do-not-return";
const initialization = { userAgent: "codex-fixture", codexHome: home, platformFamily: "unix", platformOs: "macos" };
const accountResult = { account: null, requiresOpenaiAuth: true };

test("Codex connection checks handshake and account state without a task or token refresh", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent = [];
  input.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      sent.push(request);
      assert.equal(request.jsonrpc, undefined, "native Codex omits the jsonrpc header");
      if (request.method === "initialize") output.write(JSON.stringify({ id: request.id, result: {
        userAgent: "codex-test-secret-like-do-not-return", codexHome: "/fixture/codex-home", platformFamily: "unix", platformOs: "macos",
      } }) + "\n");
      if (request.method === "account/read") output.write(JSON.stringify({ id: request.id, result: { account: null, requiresOpenaiAuth: true } }) + "\n");
    }
  });
  const result = await inspectCodexConnection({ input, output, codexHome: "/fixture/codex-home", signal: AbortSignal.timeout(1000) });
  assert.deepEqual(result, { connection: "connected", authentication: "required" });
  assert.deepEqual(sent.map((message) => message.method), ["initialize", "initialized", "account/read"]);
  assert.deepEqual(sent[2].params, { refreshToken: false });
  assert.equal(sent[0].params.capabilities.experimentalApi, false);
});

test("Codex wire accepts byte-fragmented UTF-8 and coalesced notifications without returning native metadata", async (t) => {
  const unicodeHome = "/fixture/\u4f60\u597d/codex";
  const h = harness(t, { codexHome: unicodeHome });
  const initializationFrame = frame({ id: 1, result: { ...initialization, codexHome: unicodeHome, userAgent: "codex-\u4f60\u597d" } });
  for (const byte of initializationFrame) h.output.write(Buffer.from([byte]));
  h.output.write(Buffer.concat([
    frame({ method: "account/updated", params: { email: privateText } }),
    frame({ id: 2, result: { account: { type: "chatgpt", email: `${privateText}@example.test`, planType: "plus" }, requiresOpenaiAuth: true } }),
  ]));
  assert.deepEqual(await h.result(), { connection: "connected", authentication: "configured_unverified" });
  assert.deepEqual(h.sent.map((request) => request.method), ["initialize", "initialized", "account/read"]);
  h.released();
});

// Pinned schemas: openai/codex@16ff14c, schema/json/v1/InitializeResponse.json
// and schema/json/v2/GetAccountResponse.json. Account is optional; ChatGPT email may be null.
for (const [name, result, authentication] of [
  ["missing account", { requiresOpenaiAuth: true }, "required"],
  ["null account", accountResult, "required"],
  ["API key", { requiresOpenaiAuth: true, account: { type: "apiKey", key: privateText } }, "configured_unverified"],
  ["ChatGPT", { requiresOpenaiAuth: true, account: { type: "chatgpt", email: privateText, planType: "unknown" } }, "configured_unverified"],
  ["ChatGPT null email", { requiresOpenaiAuth: true, account: { type: "chatgpt", email: null, planType: "pro" } }, "configured_unverified"],
  ["Bedrock", { requiresOpenaiAuth: false, account: { type: "amazonBedrock", usesCodexManagedCredentials: false } }, "provider_managed"],
  ["Bedrock default credentials mode", { requiresOpenaiAuth: false, account: { type: "amazonBedrock" } }, "provider_managed"],
  ["provider without an account", { requiresOpenaiAuth: false, account: null }, "provider_managed"],
]) {
  test(`Codex account status: ${name} is projected without credentials or identity`, async (t) => {
    const h = harness(t);
    h.initialize();
    h.reply({ id: 2, result });
    assert.deepEqual(await h.result(), { connection: "connected", authentication });
    h.released();
  });
}

for (const [name, result] of [
  ["wrong home", { ...initialization, codexHome: `${home}-other` }],
  ["relative home", { ...initialization, codexHome: "." }],
  ["missing home", { ...initialization, codexHome: undefined }],
  ["invalid user agent", { ...initialization, userAgent: `${privateText}\n` }],
  ["coerced platform family", { ...initialization, platformFamily: ["unix"] }],
  ["missing platform OS", { ...initialization, platformOs: undefined }],
]) {
  test(`Codex rejects initialize with ${name} before account/read`, async (t) => {
    const h = harness(t, { codexHome: name === "relative home" ? resolve(".") : home });
    h.reply({ id: 1, result });
    await h.error("protocol_error");
    assert.deepEqual(h.sent.map((request) => request.method), ["initialize"]);
    h.released();
  });
}

for (const [name, result] of [
  ["missing auth requirement", { account: null }],
  ["non-boolean auth requirement", { requiresOpenaiAuth: "true", account: null }],
  ["unknown account", { requiresOpenaiAuth: true, account: { type: "other", raw: privateText } }],
  ["coerced account type", { requiresOpenaiAuth: true, account: { type: ["apiKey"] } }],
  ["missing ChatGPT identity", { requiresOpenaiAuth: true, account: { type: "chatgpt" } }],
  ["invalid ChatGPT email", { requiresOpenaiAuth: true, account: { type: "chatgpt", email: 42, planType: "plus" } }],
  ["missing ChatGPT plan", { requiresOpenaiAuth: true, account: { type: "chatgpt", email: null } }],
  ["unknown ChatGPT plan", { requiresOpenaiAuth: true, account: { type: "chatgpt", email: null, planType: "not-a-plan" } }],
  ["invalid Bedrock credential flag", { requiresOpenaiAuth: false, account: { type: "amazonBedrock", usesCodexManagedCredentials: "false" } }],
]) {
  test(`Codex rejects ${name} without exposing native account data`, async (t) => {
    const h = harness(t);
    h.initialize();
    h.reply({ id: 2, result });
    await h.error("protocol_error");
    h.released();
  });
}

for (const [name, value] of [
  ["non-object", null],
  ["array", []],
  ["wrong response id", { id: 2, result: accountResult }],
  ["string response id", { id: "1", result: initialization }],
  ["server error", { id: 1, error: { code: -32000, message: privateText, data: { token: privateText } } }],
  ["result plus error", { id: 1, result: initialization, error: null }],
  ["non-string method", { id: 1, method: 42, result: initialization }],
  ["notification plus result", { method: "notice", result: initialization }],
]) {
  test(`Codex rejects malformed envelope: ${name}`, async (t) => {
    const h = harness(t);
    h.reply(value);
    await h.error("protocol_error");
    h.released();
  });
}

test("Codex rejects duplicate replies and invalid JSON or UTF-8", async (t) => {
  for (const bytes of [Buffer.from("not-json\n"), Buffer.from("\n"), Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d, 0x0a])]) {
    const h = harness(t);
    h.output.write(bytes);
    await h.error("protocol_error");
    h.released();
  }
  const h = harness(t);
  h.initialize();
  h.initialize();
  await h.error("protocol_error");
  h.released();
});

test("Codex denies unsolicited requests without granting tool, approval or login authority", async (t) => {
  for (const id of [77, "approval-1"]) {
    const h = harness(t);
    h.reply({ id, method: "item/commandExecution/requestApproval", params: { command: privateText } });
    await h.error("protocol_error");
    assert.deepEqual(h.sent[1], { id, error: { code: -32601, message: "Requests are not supported during connection checks." } });
    assert.equal(h.sent.length, 2);
    h.released();
  }
  for (const id of [null, {}, [], 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness(t);
    h.reply({ id, method: "account/login/start", params: { token: privateText } });
    await h.error("protocol_error");
    assert.equal(h.sent.length, 1, "malformed request ids must not be reflected into a reply");
    h.released();
  }
});

test("Codex pre-abort neither writes nor drains buffered native output", async (t) => {
  const output = new PassThrough();
  output.write(frame({ id: 1, result: initialization }));
  const length = output.readableLength;
  const controller = new AbortController();
  controller.abort(new Error(privateText));
  const h = harness(t, { output, controller });
  await h.error("cancelled");
  await tick();
  assert.equal(h.sent.length, 0);
  assert.equal(output.readableLength, length);
  assert.equal(output.readableFlowing, null);
  h.released();
});

test("Codex abort in either stage removes listeners and ignores late replies", async (t) => {
  for (const stage of ["initialize", "account"]) {
    const h = harness(t);
    if (stage === "account") h.initialize();
    const count = h.sent.length;
    h.controller.abort(new Error(privateText));
    await h.error("cancelled");
    h.reply({ id: stage === "initialize" ? 1 : 2, result: stage === "initialize" ? initialization : accountResult });
    assert.equal(h.sent.length, count);
    h.released();
  }
});

test("Codex enforces its cumulative byte cap across notifications and partial lines", async (t) => {
  const init = frame({ id: 1, result: initialization });
  const account = frame({ id: 2, result: accountResult });
  const notice = (padding) => frame({ method: "notice", params: { padding } });
  const padding = "x".repeat(64 * 1024 - init.length - account.length - notice("").length);
  const h = harness(t);
  h.output.write(Buffer.concat([notice(padding), init, account]));
  assert.deepEqual(await h.result(), { connection: "connected", authentication: "required" });
  h.released();
  for (const chunks of [
    [Buffer.alloc(64 * 1024, 32), Buffer.from("x")],
    [notice(padding + "\u00e9"), init, account],
  ]) {
    const limited = harness(t);
    for (const chunk of chunks) limited.output.write(chunk);
    await limited.error("output_limit");
    limited.released();
  }
});

test("Codex handles encoded Readables and rejects object-mode chunks without throwing from data events", async (t) => {
  const output = new PassThrough();
  output.setEncoding("utf8");
  const h = harness(t, { output });
  assert.doesNotThrow(() => h.initialize());
  h.reply({ id: 2, result: accountResult });
  assert.deepEqual(await h.result(), { connection: "connected", authentication: "required" });
  h.released();
  const malformed = harness(t, { output: new PassThrough({ objectMode: true }) });
  assert.doesNotThrow(() => malformed.output.write({ token: privateText }));
  await malformed.error("protocol_error");
  malformed.released();
});

test("Codex EOF, close and stream errors fail closed in both stages", async (t) => {
  for (const stage of ["initialize", "account"]) {
    for (const fail of [
      (h) => h.output.end(),
      (h) => h.output.end('{"id":2,"result":'),
      (h) => h.output.destroy(),
      (h) => h.output.destroy(new Error(privateText)),
      (h) => h.input.destroy(new Error(privateText)),
      (h) => h.input.destroy(),
      (h) => h.input.end(),
    ]) {
      const h = harness(t);
      if (stage === "account") h.initialize();
      fail(h);
      await h.error("process_failed");
      h.released();
    }
  }
});

test("Codex refuses already closed streams without trying to initialize", async (t) => {
  const input = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  input.end();
  await tick();
  let attempts = 0;
  const write = input.write.bind(input);
  input.write = (...args) => { attempts++; return write(...args); };
  const h = harness(t, { input });
  await h.error("process_failed");
  assert.equal(attempts, 0);
  h.released();
  const output = new PassThrough();
  output.destroy();
  const closed = harness(t, { output });
  await closed.error("process_failed");
  assert.equal(closed.sent.length, 0);
  closed.released();
});

test("Codex synchronous write exceptions are redacted process failures with listener cleanup", async (t) => {
  for (const failingMethod of ["initialize", "initialized", "account/read"]) {
    const h = harness(t, { beforeProbe(input) {
      const write = input.write.bind(input);
      input.write = (chunk, ...args) => {
        if (JSON.parse(chunk).method === failingMethod) throw new Error(privateText);
        return write(chunk, ...args);
      };
    } });
    if (failingMethod !== "initialize") h.initialize();
    await h.error("process_failed");
    h.released();
  }
});

test("Codex asynchronous write errors remain handled through the stream error event", async (t) => {
  for (const failingMethod of ["initialize", "initialized", "account/read"]) {
    const h = harness(t, { write(request, done) {
      if (request.method === failingMethod) setImmediate(() => done(new Error(privateText)));
      else done();
    } });
    if (failingMethod !== "initialize") h.initialize();
    await h.error("process_failed");
    await tick();
    assert.equal(h.unguardedInputErrors.length, 0, "write callbacks must not remove the only error handler before Node emits error");
    h.released();
  }
});

test("Codex does not report success before a pending account/read write fails", async (t) => {
  let completeWrite;
  const h = harness(t, { write(request, done) {
    if (request.method === "account/read") completeWrite = done;
    else done();
  } });
  h.initialize();
  h.reply({ id: 2, result: accountResult });
  completeWrite(new Error(privateText));
  await h.error("process_failed");
  await tick();
  assert.equal(h.unguardedInputErrors.length, 0);
  h.released();
});

test("Codex rejects duplicate account replies while its write is still pending", async (t) => {
  let completeWrite;
  const h = harness(t, { write(request, done) {
    if (request.method === "account/read") completeWrite = done;
    else done();
  } });
  h.initialize();
  h.reply({ id: 2, result: accountResult });
  h.reply({ id: 2, result: { account: null, requiresOpenaiAuth: false } });
  completeWrite();
  await h.error("protocol_error");
  h.released();
});

test("Codex cancellation retains only the guard needed by an outstanding write, then releases it", async (t) => {
  let completeWrite;
  const h = harness(t, { write(_request, done) { completeWrite = done; } });
  h.controller.abort();
  await h.error("cancelled");
  completeWrite(new Error(privateText));
  await tick();
  assert.equal(h.unguardedInputErrors.length, 0);
  h.released();
});

function frame(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

test("secret-backed Codex checks require an API-key account and cannot accept other native auth", async (t) => {
  for (const result of [
    { requiresOpenaiAuth: true, account: null },
    { requiresOpenaiAuth: true, account: { type: "chatgpt", email: null, planType: "plus" } },
    { requiresOpenaiAuth: false, account: { type: "apiKey" } },
    { requiresOpenaiAuth: false, account: { type: "amazonBedrock" } },
  ]) {
    const h = harness(t, { expectedAuthentication: "apiKey" });
    h.initialize();
    h.reply({ id: 2, result });
    await h.error("auth_required");
    h.released();
  }
});

function harness(t, options = {}) {
  const sent = [];
  const input = options.input ?? new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString());
    sent.push(request);
    if (options.write) options.write(request, done);
    else done();
  } });
  const output = options.output ?? new PassThrough();
  const controller = options.controller ?? new AbortController();
  const unguardedInputErrors = [];
  // Observe rather than crash the test process if the probe drops its error handler too early.
  input.on("error", (error) => { if (input.listenerCount("error") === 1) unguardedInputErrors.push(error); });
  output.on("error", () => {});
  options.beforeProbe?.(input);
  const baseline = [
    ...["error", "finish", "close"].map((name) => [input, name, input.listeners(name)]),
    ...["data", "error", "end", "close"].map((name) => [output, name, output.listeners(name)]),
    [controller.signal, "abort", getEventListeners(controller.signal, "abort")],
  ];
  const outcome = inspectCodexConnection({ input, output, codexHome: options.codexHome ?? home, signal: controller.signal,
    expectedAuthentication: options.expectedAuthentication })
    .then((result) => ({ result }), (error) => ({ error }));
  t.after(() => { controller.abort(); input.destroy(); output.destroy(); });
  const wait = async () => {
    let timer;
    try {
      return await Promise.race([outcome, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Codex probe did not settle after terminal event")), 1000);
      })]);
    } finally { clearTimeout(timer); }
  };
  return {
    input, output, controller, sent, unguardedInputErrors,
    reply: (value) => output.write(frame(value)),
    initialize: () => output.write(frame({ id: 1, result: initialization })),
    result: async () => {
      const value = await wait();
      await tick();
      assert.equal(value.error, undefined);
      assert.equal(JSON.stringify(value.result).includes(privateText), false);
      return value.result;
    },
    error: async (code) => {
      const value = await wait();
      await tick();
      assert.ok(value.error instanceof NativeConnectionError, "only typed, redacted errors may leave the wire probe");
      assert.equal(value.error.code, code);
      assert.equal(value.error.message, code);
      assert.equal(JSON.stringify(value.error).includes(privateText), false);
    },
    released: () => {
      for (const [target, name, listeners] of baseline) assert.deepEqual(getEventListeners(target, name), listeners, `${name} listeners must return to their baseline`);
    },
  };
}
