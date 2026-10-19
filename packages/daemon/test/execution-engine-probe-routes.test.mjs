import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { resolveUserConfigPaths } from "@ling-stack/core";
import { EngineManagementFeature } from "../dist/features/execution-engines/feature.js";
import { prepareNativeAuthHome } from "../dist/features/execution-engines/native-auth-home.js";

const origin = "http://127.0.0.1:5175";
const engineId = "codex-app-server";

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ling-probe-routes-"));
  const paths = resolveUserConfigPaths({ userRootDir: root });
  const feature = new EngineManagementFeature({ userPaths: paths, allowedOrigins: [origin], secretResolver: options.secretResolver });
  const pending = new Set();
  const server = createServer((request, response) => {
    const handling = feature.handle(request, response);
    pending.add(handling);
    handling.finally(() => pending.delete(handling));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await feature.close();
    server.closeAllConnections();
    await Promise.allSettled([...pending]);
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/execution-engines`;
  const headers = { Origin: origin, Authorization: `Bearer ${feature.credentials.capability}`,
    "X-Ling-Engine-Csrf": feature.credentials.csrfToken, "Content-Type": "application/json" };
  async function request(path, method = "GET", body, options = {}) {
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), ...options });
    return { status: response.status, body: await response.json() };
  }
  async function save(executablePath, revision = 0, authProfileId = "fixture") {
    return request(`/${engineId}/profile`, "PUT", { expectedRevision: revision,
      configuration: { engineId, executablePath, authProfileId, ...(options.secretRef ? { secretRef: options.secretRef } : {}) } });
  }
  function probe(revision = 1, options = {}, mode) {
    return request(`/${engineId}/probe`, "POST", { expectedRevision: revision, ...(mode ? { mode } : {}) }, options);
  }
  async function startPendingProbe(options = {}) {
    const marker = join(root, "started");
    const release = join(root, "release");
    const executable = join(root, "fixture-runtime.cjs");
    writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nconst timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.stdout.write('codex-cli 0.114.0'); } }, 10);\n`, { mode: 0o700 });
    assert.equal((await save(executable)).status, 200);
    const abort = new AbortController();
    const result = probe(1, { ...options, signal: abort.signal }).catch((error) => error);
    await waitUntil(() => readPidFile(marker) !== undefined, "owned fixture process must publish its PID before racing the request");
    const pid = Number(readFileSync(marker, "utf8"));
    return { executable, abort, result, pid, release: () => writeFileSync(release, "finish") };
  }
  async function startPendingConnection(options = {}) {
    const marker = join(root, "account-read-pending");
    const release = join(root, "account-read-release");
    const executable = join(root, "pending-native.cjs");
    const methodsPath = join(root, "pending-native-methods.jsonl");
    writeFileSync(executable, `#!${process.execPath}
      const fs = require('node:fs');
      if (process.argv[2] === '--version') { console.log('codex-cli 0.114.0'); process.exit(0); }
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(methodsPath)}, JSON.stringify(message) + '\\n');
        if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {
          userAgent: 'fixture', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos'
        } }));
        if (message.method === 'account/read') {
          fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
          const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(release)})) {
              clearInterval(timer);
              console.log(JSON.stringify({ id: message.id, result: { account: ${JSON.stringify(options.account ?? null)}, requiresOpenaiAuth: true } }));
            }
          }, 10);
        }
      });
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });
    assert.equal((await save(executable)).status, 200);
    let authHome;
    if (options.nativeKey) {
      const profile = (await request(`/${engineId}/profile`)).body.profile;
      authHome = await prepareNativeAuthHome(paths, profile.configuration);
      writeFileSync(join(authHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: options.nativeKey }), { mode: 0o600 });
    }
    const abort = new AbortController();
    const result = probe(1, { ...options, signal: abort.signal }, "connection").catch((error) => error);
    await waitUntil(() => readPidFile(marker) !== undefined, "native account request must publish its PID before racing");
    return { abort, result, authHome, methodsPath, pid: Number(readFileSync(marker, "utf8")), release: () => writeFileSync(release, "finish") };
  }
  return { root, feature, headers, request, save, probe, startPendingProbe, startPendingConnection };
}

test("connection mode traverses the real management route without starting a native task or changing the profile", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const log = join(f.root, "native-wire.jsonl");
  const pidPath = join(f.root, "native.pid");
  const executable = join(f.root, "native.cjs");
  writeFileSync(executable, `#!${process.execPath}
    const fs = require('node:fs');
    if (process.argv[2] === '--version') { console.log('codex-cli 0.114.0'); process.exit(0); }
    fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
      const message = JSON.parse(line);
      if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {
        userAgent: 'private-native-value', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos'
      } }));
      if (message.method === 'account/read') console.log(JSON.stringify({ id: message.id, result: { account: null, requiresOpenaiAuth: true } }));
    });
    setInterval(() => {}, 1000);
  `, { mode: 0o700 });
  const saved = await f.save(executable);
  const result = await f.probe(1, {}, "connection");
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "connected");
  assert.equal(result.body.authentication, "required");
  assert.equal(result.body.mode, "connection");
  assert.equal(isAlive(Number(readFileSync(pidPath, "utf8"))), false);
  const wire = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(wire.map((message) => message.method), ["initialize", "initialized", "account/read"]);
  assert.deepEqual(wire[2].params, { refreshToken: false });
  assert.equal(JSON.stringify(result).includes("private-native-value"), false);
  assert.deepEqual(await f.request(`/${engineId}/profile`), saved);
  assert.equal((await f.probe()).body.connection, "not_checked", "old callers retain installation-only behavior");
  assert.equal((await f.probe(1, {}, "installation")).body.status, "installed");
});

test("connection mode does not widen request authority or accept arbitrary process options", async (t) => {
  const f = await fixture(t);
  await f.save(process.execPath);
  for (const mode of [null, false, {}, [], "", "login", "CONNECTION"]) {
    assert.equal((await f.request(`/${engineId}/probe`, "POST", { expectedRevision: 1, mode })).status, 400);
  }
  for (const headers of [{ Origin: origin }, { ...f.headers, "X-Ling-Engine-Csrf": "wrong" }]) {
    assert.ok([401, 403].includes((await f.probe(1, { headers }, "connection")).status));
  }
  assert.equal((await f.request(`/${engineId}/probe`, "POST", { expectedRevision: 1, mode: "connection", env: {} })).status, 400);
});

test("secret-backed connection HTTP enforces authority before resolution and preserves installation-only behavior", { skip: process.platform === "win32" }, async (t) => {
  const calls = [];
  const f = await fixture(t, { secretRef: "env:HTTP_PROBE_SECRET", secretResolver: { resolve(ref, purpose) {
    calls.push({ ref, purpose });
    return { ref, configured: false, status: { errorCode: "secret_access_denied", message: "private provider detail" } };
  } } });
  await f.save(process.execPath);
  for (const headers of [{ Origin: origin }, { ...f.headers, Origin: "https://wrong-origin.example" }, { ...f.headers, "X-Ling-Engine-Csrf": "wrong" }]) {
    assert.ok([401, 403].includes((await f.probe(1, { headers }, "connection")).status));
  }
  assert.equal((await f.probe(0, {}, "connection")).status, 409);
  const rawField = await f.request(`/${engineId}/probe`, "POST", { expectedRevision: 1, mode: "connection", apiKey: "private-raw-key" });
  assert.equal(rawField.status, 400);
  assert.equal(JSON.stringify(rawField).includes("private"), false);
  assert.deepEqual(calls, []);
  assert.equal((await f.probe()).body.status, "unexpected_runtime");
  assert.deepEqual(calls, [], "installation checks remain account-blind");
  const result = await f.probe(1, {}, "connection");
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "auth_required");
  assert.equal(result.body.errorCode, "engine_secret_access_denied");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(calls, [{ ref: "env:HTTP_PROBE_SECRET", purpose: "provider_api_key" }]);
});

test("secret-backed connection HTTP checks current credentials after the native child exits without changing profiles", { skip: process.platform === "win32" }, async (t) => {
  for (const scenario of ["match", "rotate", "revoke"]) {
    const firstKey = "sk-test-private-http-connection-fixture";
    let currentKey = firstKey;
    const calls = [];
    const f = await fixture(t, { secretRef: "env:HTTP_CURRENT_SECRET", secretResolver: { resolve(ref, purpose) {
      calls.push({ ref, purpose });
      return { ref, configured: Boolean(currentKey), value: currentKey };
    } } });
    const pending = await f.startPendingConnection({ nativeKey: firstKey, account: { type: "apiKey" } });
    const before = await f.request(`/${engineId}/profile`);
    const nativeBefore = readFileSync(join(pending.authHome, "auth.json"), "utf8");
    assert.equal(calls.length, 1);
    if (scenario === "rotate") currentKey = "sk-test-private-http-rotated-fixture";
    if (scenario === "revoke") currentKey = undefined;
    pending.release();
    const result = await pending.result;
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.status, scenario === "match" ? "connected" : "auth_required");
    assert.equal(result.body.authentication, scenario === "match" ? "configured_unverified" : "required");
    assert.equal(result.body.errorCode, scenario === "match" ? undefined : scenario === "rotate" ? "engine_secret_changed" : "engine_secret_missing");
    assert.equal(calls.length, 2);
    assert.equal(isAlive(pending.pid), false);
    assert.deepEqual(await f.request(`/${engineId}/profile`), before);
    assert.equal(readFileSync(join(pending.authHome, "auth.json"), "utf8"), nativeBefore);
    const wire = readFileSync(pending.methodsPath, "utf8");
    assert.deepEqual(wire.trim().split("\n").map((line) => JSON.parse(line).method), ["initialize", "initialized", "account/read"]);
    assert.equal(wire.includes(firstKey), false);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("native connection shares the busy fence and configuration changes cancel its account read", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const first = await f.startPendingConnection();
  assert.deepEqual(await f.probe(), { status: 409, body: { error: "engine_probe_busy" } });
  assert.deepEqual(await f.probe(1, {}, "connection"), { status: 409, body: { error: "engine_probe_busy" } });
  await f.save(process.execPath, 1, "new-account");
  assert.deepEqual(await first.result, { status: 409, body: { error: "profile_revision_conflict" } });
  assert.equal(isAlive(first.pid), false);
});

test("disconnect and host shutdown discard late native connection results", { skip: process.platform === "win32" }, async (t) => {
  for (const action of ["disconnect", "shutdown"]) {
    const f = await fixture(t);
    const first = await f.startPendingConnection();
    if (action === "disconnect") await f.request(`/${engineId}/profile`, "DELETE", { expectedRevision: 1 });
    else f.feature.close();
    assert.deepEqual(await first.result, action === "disconnect"
      ? { status: 409, body: { error: "profile_revision_conflict" } }
      : { status: 401, body: { error: "engine_authority_required" } });
    assert.equal(isAlive(first.pid), false);
  }
});

test("closing the native probe request reaps its account process before another probe", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const first = await f.startPendingConnection();
  first.abort.abort();
  assert.equal((await first.result).name, "AbortError");
  await waitUntil(() => !isAlive(first.pid), "closed native request must stop its owned child");
  first.release();
  assert.equal((await f.probe(1, {}, "connection")).body.status, "connected");
});

test("revoked browser authority cannot receive a successful native account check", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const enrollment = await f.request("/enrollments", "POST", { origin });
  const session = await f.request("/session", "POST", { code: enrollment.body.code }, { headers: { Origin: origin, "Content-Type": "application/json" } });
  const headers = { ...f.headers, Authorization: `Bearer ${session.body.token}`, "X-Ling-Engine-Csrf": session.body.csrfToken };
  const first = await f.startPendingConnection({ headers });
  await f.request("/session", "DELETE", undefined, { headers });
  await waitUntil(() => !isAlive(first.pid), "revocation must stop a blocked native check without any peer reply");
  assert.deepEqual(await first.result, { status: 401, body: { error: "engine_authority_required" } });
  assert.equal(isAlive(first.pid), false);
});

test("a second probe is a recoverable busy conflict, not a server failure", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const first = await f.startPendingProbe();
  try {
    const second = await f.probe();
    assert.equal(second.status, 409);
    assert.deepEqual(second.body, { error: "engine_probe_busy" });
  } finally {
    first.abort.abort();
    await first.result;
  }
});

test("probe requests validate authority, method, input and profile state before execution", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.probe()).status, 404);
  const saved = await f.save(process.execPath);
  assert.equal(saved.status, 200);
  for (const headers of [{ Origin: origin }, { ...f.headers, Origin: "https://evil.example" },
    { ...f.headers, "X-Ling-Engine-Csrf": "wrong" }, { ...f.headers, "X-Forwarded-Host": "127.0.0.1" }]) {
    assert.ok([401, 403].includes((await f.probe(1, { headers })).status));
  }
  assert.equal((await f.request(`/${engineId}/probe`)).status, 405);
  assert.equal((await f.probe("1")).status, 400);
  assert.equal((await f.probe(0)).status, 409);
  assert.equal((await f.request(`/${engineId}/probe`, "POST", { expectedRevision: 1, cwd: "/forged" })).status, 400);
  const result = await f.probe();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "unexpected_runtime");
  assert.equal(result.body.authentication, "not_checked");
  assert.equal(result.body.connection, "not_checked");
  assert.deepEqual(await f.request(`/${engineId}/profile`), saved, "probe must not enable or modify the profile");
  await f.request(`/${engineId}/profile`, "DELETE", { expectedRevision: 1 });
  assert.deepEqual(await f.probe(2), { status: 409, body: { error: "profile_unavailable" } });
});

test("configuration changes cancel the owned process and reject its stale result", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const first = await f.startPendingProbe();
  assert.equal((await f.save(process.execPath, 1, "replacement")).status, 200);
  assert.deepEqual(await first.result, { status: 409, body: { error: "profile_revision_conflict" } });
  assert.equal(isAlive(first.pid), false);
  const next = await f.probe(2);
  assert.equal(next.status, 200);
  assert.equal(next.body.profileRevision, 2);
});

test("disconnect cancels an in-flight probe without restoring the old profile", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const first = await f.startPendingProbe();
  assert.equal((await f.request(`/${engineId}/profile`, "DELETE", { expectedRevision: 1 })).status, 200);
  assert.deepEqual(await first.result, { status: 409, body: { error: "profile_revision_conflict" } });
  assert.equal(isAlive(first.pid), false);
  assert.equal((await f.request(`/${engineId}/profile`)).body.profile.status, "disconnected");
});

test("a no-op save or another engine's edit does not cancel the current probe", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const first = await f.startPendingProbe();
  assert.equal((await f.save(first.executable, 1)).body.profile.revision, 1);
  assert.equal((await f.request("/kimi-acp/profile", "PUT", { expectedRevision: 0,
    configuration: { engineId: "kimi-acp", executablePath: process.execPath, authProfileId: "other" } })).status, 200);
  first.release();
  const result = await first.result;
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "installed");
  assert.equal(result.body.profileRevision, 1);
});

test("closing the HTTP request terminates its process and releases the probe slot", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const first = await f.startPendingProbe();
  first.abort.abort();
  assert.equal((await first.result).name, "AbortError");
  await waitUntil(() => !isAlive(first.pid), "cancelled request must stop its owned child");
  first.release();
  const next = await f.probe();
  assert.equal(next.status, 200);
  assert.equal(next.body.status, "installed");
});

test("revoked browser authority cannot receive a late successful probe", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const enrolled = await f.request("/enrollments", "POST", { origin });
  const session = await f.request("/session", "POST", { code: enrolled.body.code }, { headers: { Origin: origin, "Content-Type": "application/json" } });
  const headers = { ...f.headers, Authorization: `Bearer ${session.body.token}`, "X-Ling-Engine-Csrf": session.body.csrfToken };
  const first = await f.startPendingProbe({ headers });
  assert.equal((await f.request("/session", "DELETE", undefined, { headers })).status, 200);
  await waitUntil(() => !isAlive(first.pid), "revocation must stop an installation check without any peer reply");
  assert.deepEqual(await first.result, { status: 401, body: { error: "engine_authority_required" } });
});

test("feature shutdown cancels probes and rejects their late results", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const first = await f.startPendingProbe();
  f.feature.close();
  assert.deepEqual(await first.result, { status: 401, body: { error: "engine_authority_required" } });
  assert.equal(isAlive(first.pid), false);
});

function isAlive(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "a probe PID must not be an empty marker interpreted as process group 0");
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function readPidFile(path) {
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8"));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function waitUntil(condition, message) {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), message);
}
