import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionEngineManagementClient } from "../dist/execution-engines.js";

const session = { token: "fixture-session", csrfToken: "fixture-csrf", expiresAt: "2099-01-01T00:00:00Z" };
const configuration = { engineId: "codex-app-server", executablePath: "/fixture/codex", authProfileId: "native" };
const operationId = "a3c5e7f9-1234-4567-89ab-123456789abc";
const loginOperation = { id: operationId, engineId: "codex-app-server", profileId: "fixture-profile", profileRevision: 2,
  expiresAt: "2099-01-01T00:00:00Z", status: "waiting",
  challenge: { type: "device_code", url: "https://auth.openai.com/codex/device", userCode: "fixture-code" } };

test("write-only secret save has its own authenticated no-store endpoint and keeps errors redacted", async () => {
  const calls = [];
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892", credentials: () => session,
    fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ error: "synthetic-key-should-not-echo" }), { status: 500 }); } });
  await assert.rejects(client.saveProfileWithSecret("codex-app-server", { expectedRevision: 0, configuration, secret: "synthetic-key" }),
    { message: "engine_operation_failed" });
  assert.equal(calls[0].url, "http://127.0.0.1:17892/execution-engines/codex-app-server/profile/secret");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(new Headers(calls[0].init.headers).get("x-ling-engine-csrf"), session.csrfToken);
  assert.equal(JSON.parse(calls[0].init.body).secret, "synthetic-key");
  assert.equal(JSON.stringify(client).includes("synthetic-key"), false);
});

test("login start, status and cancel use fixed authenticated routes without a cancel body", async () => {
  const calls = [];
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892", origin: "http://127.0.0.1:17892",
    credentials: () => session, fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(loginOperation));
    } });
  assert.deepEqual(await client.startLogin("codex-app-server", 2, "chatgptDeviceCode"), loginOperation);
  assert.deepEqual(await client.getLogin("codex-app-server", operationId), loginOperation);
  assert.deepEqual(await client.cancelLogin("codex-app-server", operationId), loginOperation);
  await client.startLogin("codex-app-server", 2, "chatgpt");
  assert.deepEqual(calls.map(({ url, init }) => [url, init.method]), [
    ["http://127.0.0.1:17892/execution-engines/codex-app-server/auth", "POST"],
    [`http://127.0.0.1:17892/execution-engines/codex-app-server/auth/${operationId}`, "GET"],
    [`http://127.0.0.1:17892/execution-engines/codex-app-server/auth/${operationId}`, "DELETE"],
    ["http://127.0.0.1:17892/execution-engines/codex-app-server/auth", "POST"],
  ]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { expectedRevision: 2, method: "chatgptDeviceCode" });
  assert.deepEqual(JSON.parse(calls[3].init.body), { expectedRevision: 2, method: "chatgpt" });
  for (const { url, init } of calls) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${session.token}`);
    assert.equal(headers.get("origin"), "http://127.0.0.1:17892");
    assert.equal(headers.get("x-ling-engine-csrf"), init.method === "GET" ? null : session.csrfToken);
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "omit");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(url.includes(session.token), false);
    assert.equal(url.includes(loginOperation.challenge.userCode), false);
    if (init.method !== "POST") {
      assert.equal(init.body, undefined);
      assert.equal(headers.get("content-type"), null);
    }
  }
  assert.equal(JSON.stringify(client).includes(loginOperation.challenge.userCode), false);
});

test("invalid login ids, methods and revisions are rejected before credentials or network access", async () => {
  let credentials = 0;
  let requests = 0;
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892",
    credentials: () => { credentials++; return session; }, fetch: async () => { requests++; return new Response("{}"); } });
  for (const id of [undefined, null, 42, {}, [operationId], "", "not-a-uuid", operationId.replaceAll("-", ""),
    ` ${operationId}`, `${operationId}\n`, `${operationId}/../profile`, `${operationId}?code=private`, `${operationId}%2f`]) {
    await assert.rejects(client.getLogin("codex-app-server", id), { code: "engine_request_invalid" });
    await assert.rejects(client.cancelLogin("codex-app-server", id), { code: "engine_request_invalid" });
  }
  for (const engineId of ["../../health", "other", null, ["codex-app-server"]]) {
    await assert.rejects(client.startLogin(engineId, 2, "chatgptDeviceCode"), { code: "engine_request_invalid" });
    await assert.rejects(client.getLogin(engineId, operationId), { code: "engine_request_invalid" });
    await assert.rejects(client.cancelLogin(engineId, operationId), { code: "engine_request_invalid" });
  }
  for (const method of [undefined, null, {}, ["chatgpt"], "", "api_key", "chatgptAuthTokens", "device_code", "CHATGPT"]) {
    await assert.rejects(client.startLogin("codex-app-server", 2, method), { code: "engine_request_invalid" });
  }
  for (const revision of [undefined, null, "2", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.startLogin("codex-app-server", revision, "chatgptDeviceCode"), { code: "engine_request_invalid" });
  }
  assert.equal(credentials, 0);
  assert.equal(requests, 0);
});

test("API-key login sends only the method and saved profile revision, never a key", async () => {
  const calls = [];
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892", credentials: () => session,
    fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ...loginOperation, status: "starting", challenge: undefined })); } });
  assert.equal((await client.startLogin("codex-app-server", 2, "apiKey")).status, "starting");
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { expectedRevision: 2, method: "apiKey" });
  assert.equal(calls[0].url, "http://127.0.0.1:17892/execution-engines/codex-app-server/auth");
});

test("login requires authority and propagates browser refusal without retry or fallback", async () => {
  let requests = 0;
  const fetch = async () => { requests++; return new Response('{"error":"engine_login_browser_unsupported"}', { status: 409 }); };
  const unauthenticated = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892", fetch });
  await assert.rejects(unauthenticated.startLogin("codex-app-server", 2, "chatgptDeviceCode"), { code: "engine_authority_required" });
  await assert.rejects(unauthenticated.getLogin("codex-app-server", operationId), { code: "engine_authority_required" });
  await assert.rejects(unauthenticated.cancelLogin("codex-app-server", operationId), { code: "engine_authority_required" });
  assert.equal(requests, 0);
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892", fetch, credentials: () => session });
  await assert.rejects(client.startLogin("codex-app-server", 2, "chatgpt"), { code: "engine_login_browser_unsupported" });
  assert.equal(requests, 1);
});

test("Kimi terminal login carries only typed intent and keeps human output out of later requests", async () => {
  const calls = [];
  const operation = { ...loginOperation, engineId: "kimi-acp", challenge: { type: "terminal", text: "fixture-login-code" } };
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892", credentials: () => session,
    fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(operation)); } });
  assert.deepEqual(await client.startLogin("kimi-acp", 2, "terminal"), operation);
  assert.deepEqual(await client.getLogin("kimi-acp", operationId), operation);
  await client.cancelLogin("kimi-acp", operationId);
  assert.deepEqual(JSON.parse(calls[0].init.body), { expectedRevision: 2, method: "terminal" });
  assert.equal(JSON.stringify(calls).includes("fixture-login-code"), false);
  assert.equal(JSON.stringify(client).includes("fixture-login-code"), false);
});

test("connection and installation probes use explicit distinct payloads with cancellable scoped requests", async () => {
  const calls = [];
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892", credentials: () => session,
    fetch: async (url, init) => { calls.push({ url, init }); return new Response('{"status":"connected"}'); } });
  const abort = new AbortController();
  await client.probeProfile("codex-app-server", 2);
  assert.deepEqual(await client.probeConnection("codex-app-server", 2, abort.signal), { status: "connected" });
  assert.deepEqual(JSON.parse(calls[0].init.body), { expectedRevision: 2 });
  assert.deepEqual(JSON.parse(calls[1].init.body), { expectedRevision: 2, mode: "connection" });
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(new Headers(calls[1].init.headers).get("x-ling-engine-csrf"), session.csrfToken);
  abort.abort();
  assert.equal(calls[1].init.signal.aborted, true);
  await assert.rejects(client.probeConnection("../../health", 2), { code: "engine_request_invalid" });
  assert.equal(calls.length, 2);
});

test("connection credential recovery is returned as diagnostic state, not an authenticated or enabled engine", async () => {
  const diagnostic = { mode: "connection", profileId: "fixture", profileRevision: 2, status: "auth_required",
    authentication: "required", connection: "not_checked", errorCode: "engine_secret_changed" };
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892", credentials: () => session,
    fetch: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), { expectedRevision: 2, mode: "connection" });
      return new Response(JSON.stringify(diagnostic));
    } });
  assert.deepEqual(await client.probeConnection("codex-app-server", 2), diagnostic);
});

test("engine client enrolls once and contains credentials to fixed management paths", async () => {
  const calls = [];
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://127.0.0.1:17892", fetch: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(url.endsWith("/session") && init.method === "POST" ? session : { profiles: [] }), { status: 200 });
  } });
  await assert.rejects(client.listProfiles(), { code: "engine_authority_required" });
  assert.equal(calls.length, 0);
  await client.enroll("one-use-code");
  await client.listProfiles();
  await client.saveProfile("codex-app-server", { expectedRevision: 0, configuration });
  await client.disconnectProfile("codex-app-server", 1);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), null);
  assert.deepEqual(JSON.parse(calls[0].init.body), { code: "one-use-code" });
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), `Bearer ${session.token}`);
  assert.equal(new Headers(calls[1].init.headers).get("x-ling-engine-csrf"), null);
  assert.equal(new Headers(calls[2].init.headers).get("x-ling-engine-csrf"), session.csrfToken);
  assert.equal(calls[3].init.method, "DELETE");
  assert.deepEqual(JSON.parse(calls[3].init.body), { expectedRevision: 1 });
  for (const { url, init } of calls) {
    assert.equal(init.redirect, "error");
    assert.equal(url.includes(session.token), false);
    assert.equal(url.includes("one-use-code"), false);
  }
  assert.equal(JSON.stringify(client).includes(session.token), false);
});

test("remote/noncanonical URLs and traversal ids never receive engine credentials", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return new Response("{}"); };
  for (const baseUrl of ["https://remote.example", "http://user:password@localhost:17891", "http://localhost:17891/path", "http://localhost:17891/?token=secret"]) {
    assert.throws(() => new ExecutionEngineManagementClient({ baseUrl, fetch }), { code: "engine_host_must_be_local" });
  }
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://localhost:17891", fetch, credentials: () => session });
  await assert.rejects(client.getProfile("../../health"), { code: "engine_request_invalid" });
  assert.equal(calls, 0);
});

test("expiry/revocation clear browser memory and leave no automatic credential replay", async () => {
  let now = 0;
  let fail = false;
  let calls = 0;
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://localhost:17891", now: () => now, fetch: async (_url, init) => {
    calls++;
    if (fail) return new Response('{"error":"engine_authority_required"}', { status: 401 });
    return new Response(JSON.stringify(init.method === "POST" ? { ...session, expiresAt: new Date(1000).toISOString() } : {}));
  } });
  await client.enroll("code");
  now = 1000;
  await assert.rejects(client.listProfiles(), { code: "engine_authority_required" });
  assert.equal(calls, 1);
  now = 0;
  await client.enroll("code2");
  fail = true;
  await assert.rejects(client.listProfiles(), { code: "engine_authority_required" });
  const before = calls;
  await assert.rejects(client.listProfiles(), { code: "engine_authority_required" });
  assert.equal(calls, before);
});

test("disconnect returns the server result and explicit revocation removes local access", async () => {
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://localhost:17891", fetch: async (url, init) =>
    new Response(JSON.stringify(url.endsWith("/session") && init.method === "POST" ? session : { profile: { status: "disconnected" } })) });
  await client.enroll("code");
  assert.equal((await client.disconnectProfile("codex-app-server", 1)).profile.status, "disconnected");
  await client.revokeSession();
  await assert.rejects(client.listProfiles(), { code: "engine_authority_required" });
});

test("a late enrollment response cannot restore access after the user forgets the session", async () => {
  let resolve;
  const response = new Promise((done) => { resolve = done; });
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://localhost:17891", fetch: async () => (await response).clone() });
  const enrollment = client.enroll("code");
  client.forgetSession();
  resolve(new Response(JSON.stringify(session)));
  await enrollment;
  await assert.rejects(client.listProfiles(), { code: "engine_authority_required" });
});

test("an old request failing authorization does not clear a newly enrolled session", async () => {
  let resolve;
  const response = new Promise((done) => { resolve = done; });
  let lists = 0;
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://localhost:17891", fetch: async (url, init) => {
    if (url.endsWith("/session")) return new Response(JSON.stringify({ ...session, token: JSON.parse(init.body).code }));
    if (++lists === 1) return response;
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer second");
    return new Response('{"profiles":[]}');
  } });
  await client.enroll("first");
  const stale = client.listProfiles();
  await client.enroll("second");
  resolve(new Response('{"error":"engine_authority_required"}', { status: 401 }));
  await assert.rejects(stale, { code: "engine_authority_required" });
  assert.deepEqual(await client.listProfiles(), { profiles: [] });
});

test("an expired session can be replaced by a fresh enrollment", async () => {
  let now = 0;
  const client = new ExecutionEngineManagementClient({ baseUrl: "http://localhost:17891", now: () => now,
    fetch: async (url) => new Response(JSON.stringify(url.endsWith("/session")
      ? { ...session, expiresAt: new Date(now + 1000).toISOString() } : { profiles: [] })) });
  await client.enroll("first");
  now = 1000;
  await client.enroll("second");
  assert.deepEqual(await client.listProfiles(), { profiles: [] });
});

test("a delayed login challenge cannot cross browser logout, reenrollment, expiry or host authority replacement", async () => {
  for (const scenario of ["forget", "reenroll", "expiry", "host-replaced"]) {
    let now = 0, finishBody, bodyStarted;
    const body = new Promise((resolve) => { finishBody = resolve; });
    const started = new Promise((resolve) => { bodyStarted = resolve; });
    let hostCredentials = session;
    const client = new ExecutionEngineManagementClient({ baseUrl: "http://localhost:17891", now: () => now,
      ...(scenario === "host-replaced" ? { credentials: () => hostCredentials } : {}),
      fetch: async (url, init) => url.endsWith("/session")
        ? new Response(JSON.stringify({ ...session, token: JSON.parse(init.body).code, expiresAt: new Date(1000).toISOString() }))
        : { ok: true, json: async () => { bodyStarted(); return body; } },
    });
    if (scenario !== "host-replaced") await client.enroll("first");
    const challenge = client.getLogin("codex-app-server", "90569017-265a-4efc-a355-fc4262704a5d");
    await started;
    if (scenario === "forget") client.forgetSession();
    if (scenario === "reenroll") await client.enroll("second");
    if (scenario === "expiry") now = 1000;
    if (scenario === "host-replaced") hostCredentials = { ...session, token: "new-host" };
    finishBody({ status: "waiting", challenge: { type: "device_code", url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } });
    await assert.rejects(challenge, { code: "engine_authority_required" });
  }
});
