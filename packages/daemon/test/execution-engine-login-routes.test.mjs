import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";
import { EngineManagementFeature } from "../dist/features/execution-engines/feature.js";

const origin = "http://127.0.0.1:5175";
const engineId = "codex-app-server";

test("HTTP login is owned by the initiating session, cancellable and mutually exclusive with probes and edits", { timeout: 10_000, skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const owner = await f.enroll(), other = await f.enroll();
  const start = await f.request(`/${engineId}/auth`, "POST", { expectedRevision: 1, method: "chatgptDeviceCode" }, owner);
  assert.equal(start.status, 202);
  assert.equal(start.body.status, "starting");
  const path = `/${engineId}/auth/${start.body.id}`;
  const waiting = await f.until(path, "waiting", owner);
  assert.deepEqual(waiting.challenge, { type: "device_code", url: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
  for (const method of ["GET", "DELETE"]) {
    const denied = await f.request(path, method, undefined, other);
    assert.equal(denied.status, 404);
    assert.equal(JSON.stringify(denied.body).includes("ABCD"), false);
  }
  for (const [suffix, method, body] of [
    ["auth", "POST", { expectedRevision: 1, method: "chatgptDeviceCode" }],
    ["probe", "POST", { expectedRevision: 1 }],
    ["profile", "DELETE", { expectedRevision: 1 }],
    ["profile", "PUT", { expectedRevision: 1, configuration: { ...f.configuration, authProfileId: "replacement" } }],
  ]) assert.equal((await f.request(`/${engineId}/${suffix}`, method, body, other)).status, 409);
  const cancelled = await f.request(path, "DELETE", undefined, owner);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(cancelled.body.challenge, undefined);
  assert.equal(existsSync(f.authHome()), false);
  assert.equal((await f.request(`/${engineId}/profile`)).body.profile.revision, 1);
  assert.equal(f.child().signalCode, "SIGKILL");
});

test("HTTP completion removes the challenge, increments the profile revision and never enables execution", { timeout: 10_000, skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const started = await f.request(`/${engineId}/auth`, "POST", { expectedRevision: 1, method: "chatgptDeviceCode" });
  const path = `/${engineId}/auth/${started.body.id}`;
  await f.until(path, "waiting");
  f.complete();
  const completed = await f.until(path, "completed");
  assert.equal(completed.profileRevision, 2);
  assert.equal(completed.challenge, undefined);
  assert.equal(completed.errorCode, undefined);
  const stored = (await f.request(`/${engineId}/profile`)).body.profile;
  assert.equal(stored.revision, 2);
  assert.notEqual(stored.configuration.authProfileId, "old-fixture");
  assert.equal("enabled" in stored, false);
  assert.equal(existsSync(f.authHome()), true);
  assert.equal(f.child().signalCode, "SIGKILL");
  assert.equal((await f.request(path, "DELETE")).body.status, "completed", "cancellation after the CAS cannot undo login");
  for (const result of [completed, stored, (await f.request()).body]) assert.equal(JSON.stringify(result).includes("ABCD-1234"), false);
});

test("revocation and host shutdown cancel a pending login without requiring status polling", { timeout: 10_000, skip: process.platform === "win32" }, async (t) => {
  for (const revoke of [true, false]) {
    const f = await fixture(t);
    const owner = revoke ? await f.enroll() : undefined;
    const started = await f.request(`/${engineId}/auth`, "POST", { expectedRevision: 1, method: "chatgptDeviceCode" }, owner);
    const path = `/${engineId}/auth/${started.body.id}`;
    await f.until(path, "waiting", owner);
    if (revoke) assert.equal((await f.request("/session", "DELETE", undefined, owner)).status, 200);
    else await f.feature.close();
    for (let attempt = 0; attempt < 100 && existsSync(f.authHome()); attempt++) await delay(20);
    assert.equal(existsSync(f.authHome()), false);
    assert.equal(f.child().signalCode, "SIGKILL");
    assert.equal((await f.request(path, "GET", undefined, owner)).status, 401);
  }
});

test("HTTP timeout clears challenges and malformed input cannot start a process", { timeout: 10_000, skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t, { login: { timeoutMs: 1200 } });
  for (const body of [
    { expectedRevision: 1, method: "apiKey", apiKey: "never-echo-this" },
    { expectedRevision: 1, method: "chatgptAuthTokens" },
    { expectedRevision: 0, method: "chatgptDeviceCode" },
  ]) {
    const response = await f.request(`/${engineId}/auth`, "POST", body);
    assert.ok([400, 409].includes(response.status));
    assert.equal(JSON.stringify(response.body).includes("never-echo-this"), false);
    assert.equal(f.child(), undefined);
  }
  assert.equal((await f.request(`/${engineId}/auth`, "POST", { expectedRevision: 1, method: "chatgpt" })).body.error, "engine_login_method_unavailable");
  const started = await f.request(`/${engineId}/auth`, "POST", { expectedRevision: 1, method: "chatgptDeviceCode" });
  const path = `/${engineId}/auth/${started.body.id}`;
  await f.until(path, "waiting");
  const timedOut = await f.until(path, "timed_out");
  assert.equal(timedOut.challenge, undefined);
  assert.equal(timedOut.errorCode, "engine_login_timed_out");
  assert.equal(existsSync(f.authHome()), false);
  assert.equal((await f.request(`/${engineId}/profile`)).body.profile.revision, 1);
});

test("concurrent profile references prevent adopting a completed native account", { timeout: 10_000, skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const store = new ExecutionEngineProfileStore(f.paths);
  t.after(() => store.close());
  const started = await f.request(`/${engineId}/auth`, "POST", { expectedRevision: 1, method: "chatgptDeviceCode" });
  const path = `/${engineId}/auth/${started.body.id}`;
  await f.until(path, "waiting");
  store.retainReference(engineId, 1, { workspaceId: "other-workspace", referenceId: "new-conversation" });
  f.complete();
  const failed = await f.until(path, "failed");
  assert.equal(failed.errorCode, "profile_in_use");
  assert.equal(failed.challenge, undefined);
  assert.equal(store.get(engineId).revision, 1);
  assert.equal(existsSync(f.authHome()), false);
});

test("a changed profile invalidates its pending challenge instead of showing stale login instructions", { timeout: 10_000, skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const store = new ExecutionEngineProfileStore(f.paths);
  t.after(() => store.close());
  const started = await f.request(`/${engineId}/auth`, "POST", { expectedRevision: 1, method: "chatgptDeviceCode" });
  const path = `/${engineId}/auth/${started.body.id}`;
  await f.until(path, "waiting");
  store.save({ ...f.configuration, authProfileId: "changed-by-owner" }, 1);
  const stale = await f.request(path);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "profile_revision_conflict");
  assert.equal(stale.body.challenge, undefined);
});

async function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-login-routes-")));
  let child, authHome;
  const paths = resolveUserConfigPaths({ userRootDir: root });
  const completeMarker = join(root, "complete");
  const feature = new EngineManagementFeature({ userPaths: paths, allowedOrigins: [origin],
    login: { timeoutMs: 5000, spawn: (file, args, nativeOptions) => {
      if (args[0] === "--version") return spawn(file, ["-e", 'console.log("codex-cli 0.114.0")'], nativeOptions);
      authHome = nativeOptions.env.CODEX_HOME;
      child = spawn(file, ["-e", `
        const send = value => console.log(JSON.stringify(value));
        const loginId = '90569017-265a-4efc-a355-fc4262704a5d';
        let started = false, completed = false;
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const m = JSON.parse(line);
          if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } });
          if (m.method === 'account/read') send({ id: m.id, result: { requiresOpenaiAuth: true, account: completed ? { type: 'chatgpt', email: 'private@example.test', planType: 'plus' } : null } });
          if (m.method === 'account/login/start') { started = true; send({ id: m.id, result: { type: m.params.type, loginId, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } }); }
          if (m.method === 'account/login/cancel') send({ id: m.id, result: { status: 'canceled' } });
        });
        setInterval(() => {
          if (started && !completed && require('node:fs').existsSync(${JSON.stringify(completeMarker)})) {
            completed = true;
            send({ method: 'account/login/completed', params: { loginId, success: true } });
            send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
          }
        }, 10);
      `], nativeOptions);
      return child;
    }, ...options.login },
  });
  const server = createServer(async (request, response) => { if (!await feature.handle(request, response)) { response.writeHead(404); response.end(); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await feature.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/execution-engines`;
  const rootCredentials = { token: feature.credentials.capability, csrfToken: feature.credentials.csrfToken };
  const request = async (path = "", method = "GET", body, credentials = rootCredentials) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin,
      ...(credentials ? { Authorization: `Bearer ${credentials.token}`, "X-Ling-Engine-Csrf": credentials.csrfToken } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(4000) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const configuration = { engineId, executablePath: process.execPath, authProfileId: "old-fixture" };
  assert.equal((await request(`/${engineId}/profile`, "PUT", { expectedRevision: 0, configuration })).status, 200);
  return { request, configuration, paths, child: () => child, authHome: () => authHome, feature,
    complete: () => writeFileSync(completeMarker, "complete-fixture-login"),
    enroll: async () => {
      const code = (await request("/enrollments", "POST", { origin })).body.code;
      return (await request("/session", "POST", { code }, null)).body;
    },
    until: async (path, status, credentials) => {
      const deadline = performance.now() + (options.login?.timeoutMs ?? 5000) + 1000;
      let last;
      while (performance.now() < deadline) {
        const current = await request(path, "GET", undefined, credentials);
        last = current.body;
        assert.equal(current.status, 200);
        if (current.body.status === status) return current.body;
        assert.equal(["failed", "cancelled", "timed_out"].includes(current.body.status), false, JSON.stringify(current.body));
        await delay(20);
      }
      assert.fail(`login did not reach ${status}: ${JSON.stringify(last)}`);
    },
  };
}
