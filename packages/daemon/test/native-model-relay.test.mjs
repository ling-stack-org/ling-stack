import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import { openNativeModelRelay } from "../dist/runtime/adapters/native-model-relay.js";
import { preparePlatformNativeProcessLaunch } from "../dist/runtime/sandbox/native-process-launch.js";

async function upstream(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readFrame(reader) {
  const decoder = new TextDecoder(); let text = "";
  while (!text.endsWith("\n\n")) {
    const chunk = await reader.read(); assert.equal(chunk.done, false, "Stream ended before the complete frame");
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

async function readRemaining(reader) {
  const chunks = [];
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) return Buffer.concat(chunks).toString();
    chunks.push(Buffer.from(chunk.value));
  }
}

test("model relay streams the bound model using only host-owned credentials", { timeout: 5000 }, async t => {
  let received, finish;
  const end = new Promise(resolve => { finish = resolve; });
  const url = await upstream(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {');
    await new Promise(resolve => setImmediate(resolve));
    res.write('"delta":"First"}\n\n');
    await end;
    res.end('data: [DONE]\n\n');
  });
  t.after(() => finish());
  const relay = await openNativeModelRelay({ signal: new AbortController().signal,
    routes: [{ path: "/v1/chat/completions", upstreamUrl: `${url}/provider/chat/completions`, modelId: "test-model",
      headers: { authorization: "Bearer synthetic-host-secret" } }] });
  t.after(() => relay.close());
  const response = await fetch(`${relay.baseUrl}/v1/chat/completions`, { method: "POST",
    headers: { ...relay.headers, "content-type": "application/json", authorization: "Bearer attacker-value", cookie: "untrusted",
      "anthropic-beta": "unconfigured-feature" },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Hello" }], stream: true }) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal(await readFrame(reader), 'data: {"delta":"First"}\n\n');
  assert.equal(received.path, "/provider/chat/completions");
  assert.equal(received.headers.authorization, "Bearer synthetic-host-secret");
  assert.equal(received.headers.cookie, undefined);
  assert.equal(received.headers["anthropic-beta"], undefined);
  assert.equal(received.headers["x-ling-model-token"], undefined);
  assert.equal(received.body.model, "test-model");
  finish();
  assert.equal(await readRemaining(reader), 'data: [DONE]\n\n');
});

async function configured(t, handler, options = {}) {
  const url = await upstream(t, handler);
  const relay = await openNativeModelRelay({ signal: new AbortController().signal,
    routes: [{ path: "/v1/chat/completions", upstreamUrl: `${url}/chat/completions`, modelId: "test-model", headers: {} }], ...options });
  t.after(() => relay.close());
  const send = (patch = {}) => fetch(`${relay.baseUrl}/v1/chat/completions`, { method: "POST",
    headers: { ...relay.headers, "content-type": "application/json" },
    body: '{"model":"test-model","stream":true}', ...patch });
  return { relay, send, url };
}

test("Anthropic feature forwarding is bounded and cannot replace host authentication or route", async t => {
  const received = [];
  const url = await upstream(t, (req, res) => {
    received.push({ path: req.url, headers: req.headers });
    req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
  });
  const relay = await openNativeModelRelay({ signal: new AbortController().signal,
    routes: [{ path: "/v1/messages", upstreamUrl: `${url}/v1/messages`, modelId: "bound",
      headers: { "x-api-key": "host-key", "anthropic-beta": "host-feature" }, forwardAnthropicBeta: true }] });
  t.after(() => relay.close());
  const send = beta => fetch(`${relay.baseUrl}/v1/messages`, { method: "POST",
    headers: { ...relay.headers, "content-type": "application/json", "anthropic-beta": beta,
      "x-api-key": "child-key", "x-forwarded-host": "other", authorization: "child-auth" }, body: '{"model":"bound"}' });
  const first = await send("interleaved-thinking-2025-05-14, context-management-2025-06-27");
  assert.equal(first.status, 200); await first.text();
  assert.equal(received[0].path, "/v1/messages");
  assert.equal(received[0].headers["anthropic-beta"], "host-feature");
  assert.equal(received[0].headers["x-api-key"], "host-key");
  for (const name of ["x-ling-model-token", "x-forwarded-host", "authorization"]) assert.equal(received[0].headers[name], undefined);
  for (const beta of ["x".repeat(2049), "feature;route=other", "https://other.invalid/"]) {
    const response = await send(beta); assert.equal(response.status, 400); await response.text();
  }
  assert.equal(received.length, 1);
});

test("relay sends canonical JSON so duplicate model keys cannot change the bound upstream model", { timeout: 5000 }, async t => {
  let received;
  const f = await configured(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks).toString();
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
  });
  const response = await f.send({ body: '{"model":"other-model","model":"test-model","stream":true}' });
  assert.equal(response.status, 200); await response.text();
  assert.equal(received, '{"model":"test-model","stream":true}');
});

test("macOS permits only the model endpoint while direct upstream access stays blocked", { skip: process.platform !== "darwin", timeout: 10000 }, async t => {
  let calls = 0;
  const f = await configured(t, (_req, res) => {
    calls++; res.writeHead(200, { "content-type": "application/json" }); res.end('{"answer":"model-response"}');
  });
  let ipv6Calls = 0;
  const ipv6 = createServer((_req, res) => { ipv6Calls++; res.end("Other IPv6 service"); });
  ipv6.listen({ port: f.relay.port, host: "::1", ipv6Only: true }); await once(ipv6, "listening");
  t.after(() => new Promise(resolve => { ipv6.close(resolve); ipv6.closeAllConnections(); }));
  const ipv6Url = `http://[::1]:${f.relay.port}`;
  assert.equal(await (await fetch(ipv6Url)).text(), "Other IPv6 service");
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-model-sandbox-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace"), operationRoot = join(root, "operation"), nativeHome = join(root, "native");
  for (const path of [workspaceRoot, operationRoot, nativeHome]) await mkdir(path);
  const executable = join(operationRoot, "node"); await copyFile(process.execPath, executable);
  const launch = await preparePlatformNativeProcessLaunch({ workspaceRoot, operationRoot, nativeHome, executable,
    policyProfileId: "read_only", allowedWritePaths: [], modelRelayPort: f.relay.port });
  const script = `
    const [baseUrl, headers, upstream, ipv6] = process.argv.slice(1);
    const response = await fetch(baseUrl + "/v1/chat/completions", {
      method: "POST", headers: { ...JSON.parse(headers), "content-type": "application/json" },
      body: '{"model":"test-model"}', signal: AbortSignal.timeout(2000)
    });
    const model = await response.json();
    let blocked = true;
    for (const url of [upstream, ipv6]) {
      try { await fetch(url, { signal: AbortSignal.timeout(1000) }); blocked = false; }
      catch {}
    }
    process.stdout.write(JSON.stringify({ model, blocked }));
  `;
  const child = launch(executable, ["--input-type=module", "-e", script, f.relay.baseUrl, JSON.stringify(f.relay.headers), f.url, ipv6Url], {
    cwd: operationRoot, env: { HOME: operationRoot, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { model: { answer: "model-response" }, blocked: true });
  assert.equal(calls, 1, "Only the host relay, not the child, can reach the upstream");
  assert.equal(ipv6Calls, 1, "Same-port IPv6 service must not be accessible");
  await assert.rejects(preparePlatformNativeProcessLaunch({ workspaceRoot, operationRoot, nativeHome, executable,
    terminalCwd: workspaceRoot, policyProfileId: "read_only", allowedWritePaths: [], modelRelayPort: f.relay.port }),
  /native_process_boundary_invalid/);
  const terminalLaunch = await preparePlatformNativeProcessLaunch({ workspaceRoot, operationRoot, nativeHome, executable,
    terminalCwd: workspaceRoot, policyProfileId: "read_only", allowedWritePaths: [] });
  const terminal = terminalLaunch(executable, ["--input-type=module", "-e", `
    try { await fetch(process.argv[1], { signal: AbortSignal.timeout(1000) }); process.exit(1); }
    catch { process.stdout.write("network-denied"); }
  `, f.relay.baseUrl], { cwd: workspaceRoot, env: { HOME: operationRoot }, stdio: ["ignore", "pipe", "pipe"], shell: false });
  t.after(() => { if (terminal.exitCode === null) terminal.kill("SIGKILL"); });
  let terminalOutput = "";
  terminal.stdout.on("data", chunk => { terminalOutput += chunk; });
  assert.equal((await once(terminal, "close"))[0], 0);
  assert.equal(terminalOutput, "network-denied"); assert.equal(calls, 1);
});

test("relay rejects unauthorized, browser, mismatched-model and unlisted requests without upstream traffic", { timeout: 5000 }, async t => {
  let calls = 0;
  const f = await configured(t, (_req, res) => { calls++; res.end(); });
  for (const patch of [
    { headers: { "content-type": "application/json" } },
    { headers: { ...f.relay.headers, "content-type": "application/json", "x-ling-model-token": "x".repeat(64) } },
    { headers: { ...f.relay.headers, "content-type": "application/json", origin: "https://untrusted.example" } },
    { headers: { ...f.relay.headers, "content-type": "text/plain" } },
    { headers: { ...f.relay.headers, "content-type": "application/json", "content-encoding": "gzip" } },
    { method: "PUT" },
    { body: '{"model":"other-model"}' },
    { body: '{"messages":[]}' },
    { body: "[]" },
    { body: "bad-json" },
    { body: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) },
  ]) {
    const response = await f.send(patch);
    assert.ok([400, 401].includes(response.status), JSON.stringify(patch));
    assert.deepEqual(await response.json(), { error: { message: "Native model request failed" } });
  }
  for (const path of ["/v1/chat/completions?target=other", "/v1/models", "/v1/responses", "/other"]) {
    const response = await fetch(`${f.relay.baseUrl}${path}`, { method: "POST", headers: { ...f.relay.headers, "content-type": "application/json" },
      body: '{"model":"test-model"}' });
    assert.equal(response.status, 400); await response.text();
  }
  assert.equal(calls, 0);
});

test("relay never follows an upstream redirect or exposes its headers", { timeout: 5000 }, async t => {
  let redirected = 0, original = 0;
  const target = await upstream(t, (_req, res) => { redirected++; res.end(); });
  const f = await configured(t, (_req, res) => {
    original++; res.writeHead(307, { location: target, "set-cookie": "private", "content-type": "application/json" }); res.end('{}');
  });
  const response = await f.send();
  assert.equal(response.status, 502); assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("set-cookie"), null); await response.text();
  assert.equal(original, 1); assert.equal(redirected, 0);
});

test("relay snapshots routing and checks the owning execution before every forwarded request", { timeout: 5000 }, async t => {
  let current = true, calls = 0;
  const url = await upstream(t, (req, res) => {
    calls++; assert.equal(req.url, "/bound"); assert.equal(req.headers.authorization, "Bearer bound-key");
    res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
  });
  const route = { path: "/v1/chat/completions", upstreamUrl: `${url}/bound`, modelId: "test-model", headers: { authorization: "Bearer bound-key" } };
  const f = await configured(t, (_req, res) => res.end(), { routes: [route], assertCurrent() { if (!current) throw Error("owner-retired"); } });
  route.upstreamUrl = `${url}/replaced`; route.headers.authorization = "Bearer replaced-key"; route.modelId = "other-model";
  const first = await f.send(); assert.equal(first.status, 200); await first.text();
  current = false;
  const second = await f.send(); assert.equal(second.status, 502); await second.text();
  assert.equal(calls, 1);
});

test("relay resolves current host credentials for each validated model request", { timeout: 5000 }, async t => {
  const received = [];
  let resolves = 0;
  const f = await configured(t, (req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
    res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
  }, { async resolveHeaders(signal) {
    signal.throwIfAborted();
    await new Promise(resolve => setImmediate(resolve));
    return { authorization: `Bearer synthetic-token-${++resolves}` };
  } });
  const invalid = await f.send({ body: '{"model":"other-model"}' });
  assert.equal(invalid.status, 400); await invalid.text(); assert.equal(resolves, 0);
  for (let i = 0; i < 2; i++) {
    const response = await f.send({ headers: { ...f.relay.headers, "content-type": "application/json",
      authorization: "Bearer native-untrusted", cookie: "native-untrusted" } });
    assert.equal(response.status, 200); await response.text();
  }
  assert.deepEqual(received, [
    { path: "/chat/completions", authorization: "Bearer synthetic-token-1", cookie: undefined },
    { path: "/chat/completions", authorization: "Bearer synthetic-token-2", cookie: undefined },
  ]);
  assert.equal(resolves, 2);
});

test("relay rechecks the owner after asynchronous credentials and does not send stale requests", { timeout: 5000 }, async t => {
  let current = true, resolves = 0, calls = 0;
  const f = await configured(t, (_req, res) => {
    calls++; res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
  }, {
    assertCurrent() { if (!current) throw Error("synthetic-private-owner-revoked"); },
    async resolveHeaders() {
      resolves++; await new Promise(resolve => setImmediate(resolve)); current = false;
      return { authorization: "Bearer synthetic-retired-token" };
    },
  });
  const response = await f.send();
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { message: "Native model request failed" } });
  assert.equal(calls, 0); assert.equal(resolves, 1);
  const stale = await f.send(); assert.equal(stale.status, 502); await stale.text();
  assert.equal(resolves, 1, "Already-invalid ownership must not resolve credentials");
});

for (const ending of ["close", "abort", "client", "timeout"]) for (const late of ["resolve", "reject"])
  test(`relay settles while credentials are pending: ${ending}, late ${late}`,
  { timeout: 6000 }, async () => {
    // Run a non-cooperative credential callback out of process so a broken close cannot hang QA.
    const script = `
      import assert from 'node:assert/strict';
      import { createServer } from 'node:http'; import { once } from 'node:events';
      import { openNativeModelRelay } from ${JSON.stringify(new URL("../dist/runtime/adapters/native-model-relay.js", import.meta.url).href)};
      const ending = ${JSON.stringify(ending)}, late = ${JSON.stringify(late)}, owner = new AbortController(), client = new AbortController();
      let calls = 0, resolves = 0, entered, rejectCredential, resolveCredential, requestSignal;
      const started = new Promise(resolve => { entered = resolve; });
      const server = createServer((_req, res) => {
        calls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const relay = await openNativeModelRelay({ signal: owner.signal, timeoutMs: 200, maxConcurrentRequests: 1,
        routes: [{ path: '/model', upstreamUrl: 'http://127.0.0.1:' + server.address().port + '/model', modelId: 'bound', headers: {} }],
        resolveHeaders(signal) {
          if (++resolves > 1) return Promise.resolve({ authorization: 'Bearer next-valid-token' });
          requestSignal = signal; entered();
          return new Promise((resolve, reject) => { resolveCredential = resolve; rejectCredential = reject; });
        } });
      const send = signal => fetch(relay.baseUrl + '/model', { method: 'POST', signal,
        headers: { ...relay.headers, 'content-type': 'application/json' }, body: '{"model":"bound"}' });
      const pending = send(client.signal).then(async response => ({ status: response.status, body: await response.text() }),
        () => ({ rejected: true }));
      await started;
      const busy = await send(); assert.equal(busy.status, 503); await busy.text();
      if (ending === 'close') await relay.close();
      if (ending === 'abort') { owner.abort(); await relay.close(); }
      if (ending === 'client') client.abort();
      const settled = await pending;
      assert.ok(settled.rejected || settled.status === 502);
      if (!requestSignal.aborted) await once(requestSignal, 'abort');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 0);
      if (ending === 'client' || ending === 'timeout') {
        const next = await send(); assert.equal(next.status, 200); await next.text(); assert.equal(calls, 1);
      }
      if (late === 'reject') rejectCredential(Error('synthetic-late-credential-error'));
      else resolveCredential({ authorization: 'Bearer test-synthetic-late-credential' });
      await new Promise(resolve => setImmediate(resolve));
      await relay.close(); await relay.close();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      process.stdout.write(JSON.stringify({ calls, resolves, closed: true }));
    `;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 4000 });
    const continued = ending === "client" || ending === "timeout";
    assert.deepEqual(JSON.parse(result.stdout), { calls: continued ? 1 : 0, resolves: continued ? 2 : 1, closed: true });
    assert.equal(result.stderr, "");
  });

test("relay deadline includes a blocking owner check before credential resolution", { timeout: 5000 }, async t => {
  let resolves = 0, calls = 0;
  const f = await configured(t, (_req, res) => {
    calls++; res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
  }, { timeoutMs: 40,
    assertCurrent() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); },
    async resolveHeaders() { resolves++; return { authorization: "Bearer test-synthetic-expired-request" }; },
  });
  const response = await f.send(); await response.text();
  assert.equal(resolves, 0, "An elapsed deadline must prevent even starting host credential refresh");
  assert.equal(response.status, 502); assert.equal(calls, 0);
});

test("relay rejects credentials that settle after a monotonic deadline before forwarding", { timeout: 5000 }, async t => {
  let calls = 0;
  const f = await configured(t, (_req, res) => {
    calls++; res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
  }, { timeoutMs: 40, async resolveHeaders() {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    return { authorization: "Bearer test-synthetic-too-late-token" };
  } });
  const response = await f.send();
  assert.equal(response.status, 502); await response.text(); assert.equal(calls, 0);
});

test("relay credential failures and malformed headers are private and never reach upstream", { timeout: 5000 }, async t => {
  let calls = 0, selected;
  const f = await configured(t, (_req, res) => {
    calls++; res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
  }, { maxConcurrentRequests: 1, resolveHeaders: () => selected() });
  const headers = [null, undefined, [], "secret", { authorization: 123 }, { authorization: "secret\r\nInjected: yes" },
    { "bad header": "secret" }, { Host: "other-host" }, { Cookie: "secret" }, { "x-forwarded-for": "other" },
    { "proxy-authorization": "secret" }, { "Content-Length": "0" }, { "X-Ling-Model-Token": "secret" },
    { connection: "upgrade" }, { "content-type": "text/plain" }];
  const failures = [() => { throw Error("synthetic-private-credential-error"); },
    () => Promise.reject(Error("synthetic-private-credential-error")), ...headers.map(value => async () => value)];
  for (selected of failures) {
    const response = await f.send();
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: { message: "Native model request failed" } });
    assert.equal(calls, 0);
  }
  selected = async () => ({ authorization: "Bearer test-synthetic-recovered-token" });
  const recovered = await f.send(); assert.equal(recovered.status, 200); await recovered.text(); assert.equal(calls, 1);
});

test("relay snapshots its credential callback and merges only host headers case-insensitively", { timeout: 5000 }, async t => {
  const received = [];
  const url = await upstream(t, (req, res) => {
    received.push({ authorization: req.headers.authorization, project: req.headers["x-project"] });
    res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
  });
  const options = { signal: new AbortController().signal,
    routes: [{ path: "/model", upstreamUrl: `${url}/model`, modelId: "bound", headers: { Authorization: "Bearer old", "X-Project": "fixed" } }],
    async resolveHeaders() { return { AUTHORIZATION: "Bearer synthetic-refreshed" }; },
  };
  const relay = await openNativeModelRelay(options);
  t.after(() => relay.close());
  options.resolveHeaders = async () => ({ authorization: "Bearer replaced-callback" });
  const response = await fetch(`${relay.baseUrl}/model`, { method: "POST", headers: { ...relay.headers,
    "content-type": "application/json", Authorization: "Bearer native-untrusted" }, body: '{"model":"bound"}' });
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(received, [{ authorization: "Bearer synthetic-refreshed", project: "fixed" }]);
});

test("relay enforces its request body budget before forwarding", { timeout: 5000 }, async t => {
  let calls = 0;
  const f = await configured(t, (_req, res) => { calls++; res.end(); }, { maxRequestBytes: 64 });
  const response = await f.send({ body: JSON.stringify({ model: "test-model", message: "x".repeat(64) }) });
  assert.equal(response.status, 413); await response.text(); assert.equal(calls, 0);
});

for (const ending of ["close", "abort", "client", "timeout"]) test(`relay ${ending} cancels an in-flight upstream and returns capacity`,
  { timeout: 8000 }, async t => {
    const abort = new AbortController();
    let sawRequest, sawClose, calls = 0;
    const arrived = new Promise(resolve => { sawRequest = resolve; });
    const closed = new Promise(resolve => { sawClose = resolve; });
    const f = await configured(t, (_req, res) => {
      calls++;
      if (calls > 1) { res.writeHead(200, { "content-type": "application/json" }); res.end('{}'); return; }
      res.once("close", sawClose);
      sawRequest();
    }, { signal: abort.signal, maxConcurrentRequests: 1, ...(ending === "timeout" ? { timeoutMs: 500 } : {}) });
    const clientAbort = new AbortController();
    const first = f.send({ signal: clientAbort.signal });
    const settled = first.then(response => response.text().then(() => ({ status: response.status })), () => ({ rejected: true }));
    await arrived;
    const busy = await f.send(); assert.equal(busy.status, 503); await busy.text(); assert.equal(calls, 1);
    if (ending === "close") await f.relay.close();
    else if (ending === "abort") abort.abort();
    else if (ending === "client") clientAbort.abort();
    const result = await settled;
    assert.ok(result.rejected || result.status === 502);
    await closed;
    if (ending === "client" || ending === "timeout") {
      const next = await f.send(); assert.equal(next.status, 200); await next.text(); assert.equal(calls, 2);
    } else {
      await f.relay.close(); await f.relay.close();
      await assert.rejects(f.send()); assert.equal(calls, 1);
    }
  });

test("relay stops an oversized stream without forwarding the excess bytes", { timeout: 5000 }, async t => {
  let continueStream;
  const continuation = new Promise(resolve => { continueStream = resolve; });
  t.after(() => continueStream());
  const f = await configured(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: first\n\n");
    await continuation; res.end("x".repeat(100));
  }, { maxResponseBytes: 32 });
  const response = await f.send(); const reader = response.body.getReader();
  const first = await readFrame(reader); assert.equal(first, "data: first\n\n");
  let delivered = Buffer.byteLength(first);
  continueStream();
  await assert.rejects(async () => {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) return;
      delivered += chunk.value.byteLength;
    }
  });
  assert.ok(delivered <= 32, `Delivered ${delivered} bytes past a 32-byte budget`);
});

test("separate executions cannot reuse another relay token", { timeout: 5000 }, async t => {
  let calls = 0;
  const handler = (_req, res) => { calls++; res.writeHead(200, { "content-type": "application/json" }); res.end('{}'); };
  const a = await configured(t, handler), b = await configured(t, handler);
  assert.notDeepEqual(a.relay.headers, b.relay.headers);
  const response = await b.send({ headers: { ...a.relay.headers, "content-type": "application/json" } });
  assert.equal(response.status, 401); await response.text(); assert.equal(calls, 0);
});

test("an exact model-in-path route rejects attempts to override its model in the body", { timeout: 5000 }, async t => {
  let calls = 0;
  const url = await upstream(t, (req, res) => {
    calls++; assert.equal(req.url, "/v1beta/models/bound:streamGenerateContent?alt=sse");
    res.writeHead(200, { "content-type": "application/json" }); res.end('{}');
  });
  const f = await configured(t, (_req, res) => res.end(), {
    routes: [{ path: "/v1/chat/completions", upstreamUrl: `${url}/v1beta/models/bound:streamGenerateContent?alt=sse`,
      headers: { "x-goog-api-key": "synthetic-key" } }],
  });
  const valid = await f.send({ body: '{"contents":[]}' });
  assert.equal(valid.status, 200); await valid.text();
  const invalid = await f.send({ body: '{"model":"other-model","contents":[]}' });
  assert.equal(invalid.status, 400); await invalid.text(); assert.equal(calls, 1);
});

test("relay rejects tunnelling, upgrades and oversized chunked bodies without contacting upstream", { timeout: 5000 }, async t => {
  let calls = 0;
  const f = await configured(t, (_req, res) => { calls++; res.end(); }, { maxRequestBytes: 64 });
  for (const headers of [{ connection: "upgrade", upgrade: "websocket" }, {}]) {
    const client = request(f.relay.baseUrl, { method: Object.keys(headers).length ? "GET" : "CONNECT", headers });
    const error = once(client, "error"); client.end();
    assert.ok((await error)[0] instanceof Error);
  }
  const client = request(`${f.relay.baseUrl}/v1/chat/completions`, { method: "POST", headers: {
    ...f.relay.headers, "content-type": "application/json", "transfer-encoding": "chunked",
  } });
  const rejected = once(client, "response").then(([response]) => {
    assert.equal(response.statusCode, 502); response.resume();
  }, error => assert.equal(error.code, "ECONNRESET"));
  client.end(JSON.stringify({ model: "test-model", prompt: "x".repeat(65) }));
  await rejected; assert.equal(calls, 0);
});

test("relay closes a stalled body read when its execution is aborted", { timeout: 5000 }, async t => {
  let calls = 0;
  const abort = new AbortController();
  const f = await configured(t, (_req, res) => { calls++; res.end(); }, { signal: abort.signal, maxConcurrentRequests: 1 });
  const client = request(`${f.relay.baseUrl}/v1/chat/completions`, { method: "POST", headers: {
    ...f.relay.headers, "content-type": "application/json", "content-length": 50,
  } });
  const failed = once(client, "error");
  client.write('{"model":'); await once(client, "socket");
  const capacity = await f.send(); assert.equal(capacity.status, 503); await capacity.text();
  abort.abort(); await f.relay.close();
  assert.ok((await failed)[0] instanceof Error); assert.equal(calls, 0);
});

test("native model endpoint rejects invalid launch ports", { skip: process.platform !== "darwin" }, async () => {
  for (const port of [0, -1, 65536, 1.5, "80", NaN, Infinity]) {
    await assert.rejects(preparePlatformNativeProcessLaunch({ modelRelayPort: port,
      policyProfileId: "read_only", allowedWritePaths: [] }), /native_process_boundary_invalid/);
  }
});

test("an upstream protocol upgrade is rejected without stranding capacity or close", { timeout: 5000 }, async () => {
  // Isolate this cleanup regression so a stranded relay cannot hang the test runner.
  const script = `
    import { createServer } from 'node:http'; import { once } from 'node:events';
    import { openNativeModelRelay } from ${JSON.stringify(new URL("../dist/runtime/adapters/native-model-relay.js", import.meta.url).href)};
    let calls = 0;
    const server = createServer((_req, res) => {
      if (++calls === 1) res.writeHead(101, { connection: 'upgrade', upgrade: 'unexpected' });
      else res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const relay = await openNativeModelRelay({ signal: new AbortController().signal, timeoutMs: 100, maxConcurrentRequests: 1,
      routes: [{ path: '/model', upstreamUrl: 'http://127.0.0.1:' + server.address().port + '/model', modelId: 'bound', headers: {} }] });
    const statuses = [];
    for (let i = 0; i < 2; i++) {
      const response = await fetch(relay.baseUrl + '/model', { method: 'POST',
        headers: { ...relay.headers, 'content-type': 'application/json' }, body: '{"model":"bound"}' });
      statuses.push(response.status); await response.text();
    }
    await relay.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    process.stdout.write(JSON.stringify({ statuses, calls, closed: true }));
  `;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 2000 });
  assert.deepEqual(JSON.parse(result.stdout), { statuses: [502, 200], calls: 2, closed: true });
});
