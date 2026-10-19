import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { loginCodexAccount } from "../dist/features/execution-engines/codex-login.js";

const home = "/fixture/new-auth-home";
const loginId = "90569017-265a-4efc-a355-fc4262704a5d";
const privateValue = "private-account-do-not-return";
const account = { type: "chatgpt", email: `${privateValue}@example.test`, planType: "plus" };

test("native browser login requires its matching completion and account read, not merely an opened challenge", async (t) => {
  const h = harness(t);
  await h.started;
  assert.deepEqual(h.sent.map((m) => m.method), ["initialize", "initialized", "account/read", "account/login/start"]);
  assert.deepEqual(h.sent[3].params, { type: "chatgpt" });
  h.reply({ id: 3, result: { type: "chatgpt", loginId, authUrl: "https://auth.openai.com/oauth/authorize?state=fixture" } });
  await tick();
  assert.deepEqual(h.challenges, [{ type: "browser", url: "https://auth.openai.com/oauth/authorize?state=fixture" }]);
  assert.equal(h.settled(), false);
  h.reply({ method: "account/updated", params: { authMode: "chatgpt", email: privateValue } });
  await tick();
  assert.equal(h.sent.length, 4);
  h.reply({ method: "account/login/completed", params: { loginId, success: true, error: null } });
  assert.deepEqual(h.sent[4], { id: 4, method: "account/read", params: { refreshToken: false } });
  assert.equal(h.settled(), false);
  h.reply({ id: 4, result: { account, requiresOpenaiAuth: true } });
  assert.deepEqual(await h.outcome, { value: { authentication: "login_completed" } });
});

test("contradictory successful login with a native error cannot read or adopt an account", async (t) => {
  const h = harness(t);
  await h.started;
  h.reply({ id: 3, result: { type: "chatgpt", loginId, authUrl: "https://auth.openai.com/oauth/authorize" } });
  h.reply({ method: "account/login/completed", params: { loginId, success: true, error: privateValue } });
  await tick();
  assert.equal(h.sent.some((m) => m.id === 4), false);
  assert.deepEqual(await h.outcome, { error: "protocol_error", message: "protocol_error" });
});

test("device-code login returns only the official verification challenge", async (t) => {
  const h = harness(t, { method: "chatgptDeviceCode" });
  await h.started;
  h.reply({ id: 3, result: { type: "chatgptDeviceCode", loginId, verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234", token: privateValue } });
  assert.deepEqual(h.challenges, [{ type: "device_code", url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }]);
  h.reply({ method: "account/login/completed", params: { loginId, success: true } });
  assert.equal(h.sent.some((m) => m.id === 4), false, "completion precedes native account-cache reload");
  h.reply({ method: "account/updated", params: { authMode: "chatgpt" } });
  h.reply({ id: 4, result: { account, requiresOpenaiAuth: true } });
  assert.deepEqual(await h.outcome, { value: { authentication: "login_completed" } });
});

test("API-key setup reads saved auth after the native response without needing a challenge or ChatGPT update", async (t) => {
  const h = harness(t, { method: "apiKey", apiKey: "fixture-key-not-for-output" });
  await h.started;
  assert.deepEqual(h.sent[3].params, { type: "apiKey", apiKey: "fixture-key-not-for-output" });
  h.reply({ id: 3, result: { type: "apiKey" } });
  assert.deepEqual(h.sent[4], { id: 4, method: "account/read", params: { refreshToken: false } });
  h.reply({ method: "account/login/completed", params: { loginId: null, success: true, error: null } });
  h.reply({ method: "account/updated", params: { authMode: "apikey", planType: null } });
  h.reply({ id: 4, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } });
  assert.deepEqual(await h.outcome, { value: { authentication: "configured_unverified" } });
  assert.deepEqual(h.challenges, []);
});

test("API-key setup rejects missing or malformed keys before touching native streams", async (t) => {
  for (const apiKey of [undefined, null, 42, "", " trailing ", "line\nbreak", "x".repeat(16385)]) {
    const h = harness(t, { method: "apiKey", apiKey });
    assert.deepEqual(await h.outcome, { error: "login_failed", message: "login_failed" });
    assert.equal(h.sent.length, 0);
  }
});

test("API-key setup does not accept the wrong account or failed native setup", async (t) => {
  for (const scenario of ["native-error", "wrong-type", "no-account", "provider-managed", "completion-failed"]) {
    const h = harness(t, { method: "apiKey", apiKey: "private-fixture-api-key" });
    await h.started;
    if (scenario === "native-error") h.reply({ id: 3, error: { code: -1, message: "private-fixture-api-key" } });
    else {
      h.reply({ id: 3, result: { type: "apiKey" } });
      if (scenario === "completion-failed") h.reply({ method: "account/login/completed", params: { loginId: null, success: false, error: privateValue } });
      else h.reply({ id: 4, result: { account: scenario === "wrong-type" ? account : scenario === "no-account" ? null : { type: "apiKey" },
        requiresOpenaiAuth: scenario !== "provider-managed" } });
    }
    assert.deepEqual(await h.outcome, { error: "login_failed", message: "login_failed" });
    assert.equal(h.challenges.length, 0);
  }
});

test("API-key cancellation never invents a native login id and ignores late completion", async (t) => {
  for (const stage of ["start", "account"]) {
    const h = harness(t, { method: "apiKey", apiKey: "private-fixture-api-key" });
    await h.started;
    if (stage === "account") h.reply({ id: 3, result: { type: "apiKey" } });
    h.controller.abort();
    h.reply({ method: "account/login/completed", params: { loginId: null, success: true } });
    assert.deepEqual(await h.outcome, { error: "cancelled", message: "cancelled" });
    assert.equal(h.sent.some((m) => m.method === "account/login/cancel"), false);
  }
});

for (const authUrl of ["javascript:alert(1)", "https://evil.test/oauth", "https://auth.openai.com.evil.test/", "https://user:pass@auth.openai.com/",
  "https://auth.openai.com:444/", "http://auth.openai.com/", "https://auth.openai.com/#token", "https://auth.openai.com/\\evil",
  "https://auth.openai.com/?redirect_uri=https%3A%2F%2Fevil.test%2Fauth%2Fcallback"]) {
  test(`unsafe login challenge is never exposed: ${authUrl}`, async (t) => {
    const h = harness(t);
    await h.started;
    h.reply({ id: 3, result: { type: "chatgpt", loginId, authUrl } });
    assert.deepEqual(await h.outcome, { error: "protocol_error", message: "protocol_error" });
    assert.equal(h.challenges.length, 0);
  });
}

test("unrelated completion, wrong account and remote failure cannot certify login", async (t) => {
  for (const scenario of ["other-id", "null-id", "remote-error", "no-account", "wrong-account", "unknown-plan"]) {
    const h = harness(t);
    await h.started;
    h.reply({ id: 3, result: { type: "chatgpt", loginId, authUrl: "https://auth.openai.com/oauth/authorize" } });
    h.reply({ method: "account/updated", params: { authMode: "chatgpt" } });
    h.reply({ method: "account/login/completed", params: { loginId: scenario === "other-id" ? "other" : scenario === "null-id" ? null : loginId,
      success: scenario !== "remote-error", error: scenario === "remote-error" ? privateValue : null } });
    if (["no-account", "wrong-account", "unknown-plan"].includes(scenario)) h.reply({ id: 4, result: { requiresOpenaiAuth: true,
      account: scenario === "no-account" ? null : scenario === "wrong-account" ? { type: "apiKey" } : { ...account, planType: "not-real" } } });
    const code = scenario.endsWith("id") ? "protocol_error" : "login_failed";
    assert.deepEqual(await h.outcome, { error: code, message: code });
  }
});

test("cancellation sends the matching native id, ignores late success and has a bounded missing-reply path", { timeout: 2000 }, async (t) => {
  for (const acknowledge of [true, false]) {
    const h = harness(t);
    await h.started;
    h.reply({ id: 3, result: { type: "chatgpt", loginId, authUrl: "https://auth.openai.com/oauth/authorize" } });
    h.controller.abort();
    assert.deepEqual(h.sent[4], { id: 5, method: "account/login/cancel", params: { loginId } });
    h.reply({ method: "account/login/completed", params: { loginId, success: true, error: null } });
    if (acknowledge) h.reply({ id: 5, result: { status: "notFound" } });
    assert.deepEqual(await h.outcome, { error: "cancelled", message: "cancelled" });
    assert.equal(h.sent.some((m) => m.id === 4), false);
    assert.equal(h.output.listenerCount("data"), 0);
  }
});

test("pending login denies unsolicited tool requests and malformed or oversized output", async (t) => {
  for (const data of [
    `${JSON.stringify({ id: 9, method: "item/commandExecution/requestApproval", params: { command: privateValue } })}\n`,
    "invalid-json\n", Buffer.from([0xc3, 0x28, 10]), Buffer.alloc(65537, 32),
  ]) {
    const h = harness(t);
    await h.started;
    h.output.write(data);
    const code = data.length > 65536 ? "output_limit" : "protocol_error";
    assert.deepEqual(await h.outcome, { error: code, message: code });
    assert.equal(h.sent.length, 4, "no tool authorization or echo is sent");
  }
});

test("login stream failure and pending write failure are redacted and cannot finish successfully", async (t) => {
  for (const scenario of ["eof", "write-error"]) {
    let writeDone;
    const h = harness(t, { onWrite(message, done) { if (scenario === "write-error" && message.id === 4) writeDone = done; else done(); } });
    await h.started;
    h.reply({ id: 3, result: { type: "chatgpt", loginId, authUrl: "https://auth.openai.com/oauth/authorize" } });
    if (scenario === "eof") h.output.end();
    else {
      h.reply({ method: "account/updated", params: { authMode: "chatgpt" } });
      h.reply({ method: "account/login/completed", params: { loginId, success: true } });
      h.reply({ id: 4, result: { account, requiresOpenaiAuth: true } });
      writeDone(new Error(privateValue));
    }
    assert.deepEqual(await h.outcome, { error: "process_failed", message: "process_failed" });
    await tick();
    assert.equal(h.input.listenerCount("error"), 0);
  }
});

test("a completion before the login-start response is correlated without publishing a stale challenge", async (t) => {
  let starts = 0;
  const h = harness(t, { onStarted: () => { starts++; } });
  await h.started;
  h.reply({ method: "account/login/completed", params: { loginId, success: true } });
  h.reply({ method: "account/updated", params: { authMode: "chatgpt" } });
  h.reply({ id: 3, result: { type: "chatgpt", loginId, authUrl: "https://auth.openai.com/oauth/authorize" } });
  assert.equal(starts, 1, "a valid start response ends startup even when no challenge needs displaying");
  assert.equal(h.challenges.length, 0);
  assert.deepEqual(h.sent[4], { id: 4, method: "account/read", params: { refreshToken: false } });
  h.reply({ id: 4, result: { account, requiresOpenaiAuth: true } });
  assert.deepEqual(await h.outcome, { value: { authentication: "login_completed" } });
});

function harness(t, options = {}) {
  const sent = [], challenges = [];
  const output = new PassThrough();
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  const reply = (message) => output.write(`${JSON.stringify(message)}\n`);
  const input = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString());
    sent.push(message);
    if (options.onWrite) options.onWrite(message, done); else done();
    if (message.method === "initialize") setImmediate(() => reply({ id: 1, result: {
      userAgent: privateValue, codexHome: home, platformFamily: "unix", platformOs: "macos",
    } }));
    if (message.id === 2) setImmediate(() => reply({ id: 2, result: { account: null, requiresOpenaiAuth: true } }));
    if (message.method === "account/login/start") started();
  } });
  const controller = new AbortController();
  let settled = false;
  const outcome = loginCodexAccount({ input, output, codexHome: home, signal: controller.signal,
    method: options.method ?? "chatgpt", apiKey: options.apiKey, onStarted: options.onStarted, onChallenge: (challenge) => challenges.push(challenge), cancelTimeoutMs: 20,
  }).then((value) => ({ value }), (error) => ({ error: error.code, message: error.message })).finally(() => { settled = true; });
  t.after(async () => { controller.abort(); await outcome; input.destroy(); output.destroy(); });
  return { sent, challenges, input, output, controller, reply, outcome, started: start, settled: () => settled };
}
