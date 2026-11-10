import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";
import { EngineManagementAuthority, engineManagementCsrf } from "../dist/features/execution-engines/authority.js";
import { EngineManagementController } from "../dist/features/execution-engines/controller.js";
import { createDaemonServer } from "../dist/index.js";

const capability = "fixture-only-" + "x".repeat(40);
const origin = "http://127.0.0.1:5175";
const rootHeaders = { Origin: origin, Authorization: `Bearer ${capability}`, "X-Ling-Engine-Csrf": engineManagementCsrf(capability) };
const configuration = { engineId: "codex-app-server", executablePath: process.execPath, authProfileId: "native-fixture" };

async function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "ling-engine-management-"));
  const store = new ExecutionEngineProfileStore(resolveUserConfigPaths({ userRootDir: root }));
  let storeCalls = 0;
  const auth = new EngineManagementAuthority({ capability, allowedOrigins: [origin] });
  const controller = new EngineManagementController({ authority: auth, getStore: () => { storeCalls++; return store; }, ...overrides });
  const server = createServer(async (request, response) => {
    if (!await controller.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path = "", options = {}) {
    const response = await fetch(`${base}/execution-engines${path}`, options);
    const body = response.status === 204 ? undefined : await response.json();
    return { status: response.status, headers: response.headers, body };
  }
  function json(method, body, headers = rootHeaders) {
    return { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
  }
  return { request, json, store, storeCalls: () => storeCalls, auth };
}

test("write-only secret setup stores an opaque reference and preserves old keys across replacement", async (t) => {
  const values = new Map();
  const secretStore = { write: (ref, value) => values.set(ref, value), remove: (ref) => values.delete(ref) };
  const f = await fixture(t, { secretStore });
  const raw = "synthetic-only-key-'quoted'-$value";
  const path = "/codex-app-server/profile/secret";
  const first = await f.request(path, f.json("PUT", { expectedRevision: 0, configuration, secret: raw }));
  assert.equal(first.status, 200);
  const saved = first.body.profile;
  assert.match(saved.configuration.secretRef, /^keychain:ling-engine-[a-f0-9-]{36}$/);
  assert.equal(values.get(saved.configuration.secretRef), raw);
  assert.equal(JSON.stringify(first.body).includes(raw), false);
  assert.equal(JSON.stringify(f.store.list()).includes(raw), false);
  const second = await f.request(path, f.json("PUT", { expectedRevision: 1, configuration, secret: "second-synthetic-key" }));
  assert.equal(second.status, 200);
  assert.notEqual(second.body.profile.configuration.secretRef, saved.configuration.secretRef);
  assert.notEqual(second.body.profile.configuration.authProfileId, saved.configuration.authProfileId);
  assert.equal(values.get(saved.configuration.secretRef), raw, "never delete the previous secret as an implicit side effect");
  assert.equal(first.headers.get("cache-control"), "no-store");
});

test("secret setup rejects authority, ambiguous input and referenced profiles before OS storage", async (t) => {
  let writes = 0;
  const f = await fixture(t, { secretStore: { write() { writes++; }, remove() {} } });
  const path = "/codex-app-server/profile/secret";
  const body = { expectedRevision: 0, configuration, secret: "synthetic-only" };
  assert.equal((await f.request(path, f.json("PUT", body, { Origin: origin }))).status, 401);
  assert.equal((await f.request(path, f.json("PUT", body, { Origin: origin, Authorization: rootHeaders.Authorization }))).status, 403);
  for (const secret of ["", "   ", "a\nb", "x".repeat(2049), "密".repeat(1024), null]) {
    assert.equal((await f.request(path, f.json("PUT", { ...body, secret }))).status, 400);
  }
  assert.equal((await f.request(path, f.json("PUT", { ...body, configuration: { ...configuration, secretRef: "env:USER_KEY" } }))).status, 400);
  f.store.save(configuration, 0);
  assert.equal((await f.request(path, f.json("PUT", body))).status, 409);
  f.store.retainReference(configuration.engineId, 1, { workspaceId: "other", referenceId: "thread" });
  assert.equal((await f.request(path, f.json("PUT", { ...body, expectedRevision: 1 }))).body.error, "profile_in_use");
  assert.equal(writes, 0);
});

test("failed OS write compensates only its attempted entry, rolls back profile, and never echoes native errors", async (t) => {
  const removed = [];
  const f = await fixture(t, { secretStore: { write() { throw new Error("synthetic-secret-must-not-escape"); }, remove(ref) { removed.push(ref); } } });
  const result = await f.request("/codex-app-server/profile/secret", f.json("PUT", { expectedRevision: 0, configuration, secret: "synthetic-only" }));
  assert.equal(result.status, 500);
  assert.equal(result.body.error, "engine_secret_store_unavailable");
  assert.equal(f.store.get(configuration.engineId), undefined);
  assert.equal(removed.length, 1);
  assert.equal(JSON.stringify(result.body).includes("synthetic-secret"), false);
});

test("lost authority after OS preparation removes the attempted key and preserves the previous profile", async (t) => {
  const values = new Map();
  let invalidate;
  const f = await fixture(t, { secretStore: { write(ref, secret) { values.set(ref, secret); invalidate(); }, remove(ref) { values.delete(ref); } } });
  const previous = f.store.save(configuration, 0);
  invalidate = () => f.auth.close();
  const result = await f.request("/codex-app-server/profile/secret", f.json("PUT", { expectedRevision: 1, configuration, secret: "synthetic-only" }));
  assert.ok([401, 403].includes(result.status));
  assert.deepEqual(f.store.get(configuration.engineId), previous);
  assert.equal(values.size, 0);
});

test("simultaneous secret submissions commit once and cleanup failure is not reported as success", async (t) => {
  let writes = 0;
  const f = await fixture(t, { secretStore: { write() { writes++; }, remove() {} } });
  const body = { expectedRevision: 0, configuration, secret: "synthetic-only" };
  const results = await Promise.all([f.request("/codex-app-server/profile/secret", f.json("PUT", body)),
    f.request("/codex-app-server/profile/secret", f.json("PUT", body))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(writes, 1);
  const broken = await fixture(t, { secretStore: { write() { throw new Error("private-native-error"); }, remove() { throw new Error("private-native-error"); } } });
  const result = await broken.request("/codex-app-server/profile/secret", broken.json("PUT", body));
  assert.deepEqual(result.body, { error: "engine_secret_cleanup_failed" });
  assert.equal(broken.store.get(configuration.engineId), undefined);
});

test("denied management reads/writes never open the store and never use wildcard CORS", async (t) => {
  const f = await fixture(t);
  for (const headers of [{}, { Origin: origin }, { ...rootHeaders, Origin: "https://evil.example" }, { ...rootHeaders, "X-Forwarded-For": "127.0.0.1" }]) {
    const result = await f.request("", { headers });
    assert.ok([401, 403].includes(result.status));
    assert.notEqual(result.headers.get("access-control-allow-origin"), "*");
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
  const noCsrf = await f.request("/codex-app-server/profile", f.json("PUT", { expectedRevision: 0, configuration }, { Origin: origin, Authorization: rootHeaders.Authorization }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error, "engine_csrf_invalid");
  assert.equal(f.storeCalls(), 0);
  const preflight = await f.request("", { method: "OPTIONS", headers: { Origin: origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(f.storeCalls(), 0);
});

test("typed profile CRUD is revisioned, persists, and refuses secret/route spoofing", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.request("", { headers: rootHeaders })).body, { profiles: [] });
  const path = "/codex-app-server/profile";
  const save = await f.request(path, f.json("PUT", { expectedRevision: 0, configuration }));
  assert.equal(save.status, 200);
  assert.equal(save.body.profile.revision, 1);
  assert.deepEqual((await f.request(path, { headers: rootHeaders })).body, save.body);
  assert.equal((await f.request(path, f.json("PUT", { expectedRevision: 0, configuration }))).status, 409);
  const invalid = await f.request(path, f.json("PUT", { expectedRevision: 1, configuration: { ...configuration, apiKey: "do-not-echo-this" } }));
  assert.equal(invalid.status, 400);
  assert.equal(JSON.stringify(invalid.body).includes("do-not-echo-this"), false);
  assert.equal((await f.request("/kimi-acp/profile", f.json("PUT", { expectedRevision: 0, configuration }))).status, 400);
  assert.equal((await f.request(path, f.json("DELETE", { expectedRevision: 1 }))).status, 200);
  assert.equal(f.store.get("codex-app-server").status, "disconnected");
});

test("a referenced profile cannot be replaced or disconnected through HTTP", async (t) => {
  const f = await fixture(t);
  f.store.save(configuration, 0);
  f.store.retainReference(configuration.engineId, 1, { workspaceId: "archived", referenceId: "conversation" });
  for (const request of [f.json("DELETE", { expectedRevision: 1 }), f.json("PUT", { expectedRevision: 1, configuration: { ...configuration, authProfileId: "new-account" } })]) {
    const result = await f.request("/codex-app-server/profile", request);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, "profile_in_use");
  }
  assert.deepEqual(f.store.get(configuration.engineId).configuration, configuration);
});

test("one-use HTTP enrollment cannot mint another code or leak host authority", async (t) => {
  const f = await fixture(t);
  const created = await f.request("/enrollments", f.json("POST", { origin }));
  assert.equal(created.status, 200);
  const redeem = () => f.request("/session", f.json("POST", { code: created.body.code }, { Origin: origin }));
  const results = await Promise.all([redeem(), redeem()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
  const session = results.find((r) => r.status === 200).body;
  assert.equal(JSON.stringify(session).includes(capability), false);
  const headers = { Origin: origin, Authorization: `Bearer ${session.token}`, "X-Ling-Engine-Csrf": session.csrfToken };
  assert.equal((await f.request("", { headers })).status, 200);
  assert.equal((await f.request("/enrollments", f.json("POST", { origin }, headers))).status, 403);
  assert.equal((await f.request("/session", { method: "DELETE", headers })).status, 200);
  assert.equal((await f.request("", { headers })).status, 401);
});

test("oversized/malformed input and unknown routes return owned redacted errors", async (t) => {
  const f = await fixture(t);
  for (const body of ["{malformed", JSON.stringify({ configuration: "x".repeat(70_000) })]) {
    const result = await f.request("/codex-app-server/profile", { method: "PUT", headers: { ...rootHeaders, Origin: origin, "Content-Type": "application/json" }, body });
    assert.equal(result.status, 400);
    assert.equal(result.headers.get("access-control-allow-origin"), origin);
    assert.equal(result.body.error, "engine_request_invalid");
  }
  assert.equal((await f.request("/unknown", { headers: rootHeaders })).status, 404);
});

test("production Daemon dispatch keeps management outside wildcard CORS and health output", async () => {
  const root = mkdtempSync(join(tmpdir(), "ling-engine-daemon-"));
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "home");
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: root,
    channels: { autoRoute: false, intentSelector: false } }, {
    engineManagement: { allowedOrigins: [origin] }, remoteReplyDispatcher: null,
  });
  try {
    await daemon.start();
    const base = `http://127.0.0.1:${daemon.server.address().port}`;
    const denied = await fetch(`${base}/execution-engines`, { headers: { Origin: origin } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("access-control-allow-origin"), origin);
    const trusted = await fetch(`${base}/execution-engines`, { headers: {
      Origin: origin, Authorization: `Bearer ${daemon.engineManagement.capability}`,
    } });
    assert.equal(trusted.status, 200);
    assert.deepEqual(await trusted.json(), { profiles: [] });
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthText = await health.text();
    assert.equal(healthText.includes(daemon.engineManagement.capability), false);
    assert.equal(healthText.includes(daemon.engineManagement.csrfToken), false);
  } finally {
    await daemon.stop();
    if (previousHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("revocation while reading a mutation body prevents the eventual store write", async () => {
  const auth = new EngineManagementAuthority({ capability, allowedOrigins: [origin] });
  const session = auth.redeemEnrollment({ headers: { host: "127.0.0.1:17892", origin },
    socket: { remoteAddress: "127.0.0.1", localPort: 17892 } }, auth.createEnrollment(origin).code);
  let reading;
  const started = new Promise((resolve) => { reading = resolve; });
  let finish;
  const delayed = new Promise((resolve) => { finish = resolve; });
  const request = Readable.from((async function* () {
    reading();
    await delayed;
    yield JSON.stringify({ expectedRevision: 0, configuration });
  })());
  Object.assign(request, { url: "/execution-engines/codex-app-server/profile", method: "PUT",
    headers: { host: "127.0.0.1:17892", origin, authorization: `Bearer ${session.token}`,
      "content-type": "application/json", "x-ling-engine-csrf": session.csrfToken },
    socket: { remoteAddress: "127.0.0.1", localPort: 17892 } });
  let storeCalls = 0;
  const controller = new EngineManagementController({ authority: auth, getStore: () => { storeCalls++; throw new Error("must not open"); } });
  let status;
  let result;
  const response = { setHeader() {}, writeHead(value) { status = value; }, end(value) { result = JSON.parse(value); } };
  const handling = controller.handle(request, response);
  await started;
  auth.revokeSession(session.token);
  finish();
  await handling;
  assert.equal(storeCalls, 0);
  assert.equal(status, 401);
  assert.equal(result.error, "engine_authority_required");
});
