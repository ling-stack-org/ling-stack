import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { resolveUserConfigPaths } from "@ling-stack/core";
import { EngineManagementFeature } from "../dist/features/execution-engines/feature.js";

const origin = "http://127.0.0.1:5175";
const engineId = "kimi-acp";
const runtimeVersion = "0.1.0-alpha.4";
const localOnly = { skip: process.platform !== "darwin", timeout: 15_000 };

async function fixture(t, scenario = "configured") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-kimi-routes-")));
  const paths = resolveUserConfigPaths({ userRootDir: join(root, "host") });
  const executable = join(root, "kimi");
  // Native-image surrogate with an injected owned Node peer; never an installed Kimi runtime.
  const bytes = Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1")]);
  writeFileSync(executable, bytes, { mode: 0o700 });
  mkdirSync(join(root, ".staging"));
  writeFileSync(join(root, ".staging", "pending"), "preserve-staging");
  writeFileSync(join(root, "kimi.bak"), "preserve-backup");
  const methodsPath = join(root, "fixture-methods.jsonl");
  const releasePath = join(root, "fixture-release");
  const processes = [];
  let authHome;
  const feature = new EngineManagementFeature({ userPaths: paths, allowedOrigins: [origin],
    probe: { timeoutMs: 5000, spawn: (file, args, options) => {
      const wrapped = file === "/usr/bin/sandbox-exec";
      const copy = wrapped ? args[2] : file;
      const nativeArgs = wrapped ? args.slice(3) : args;
      assert.notEqual(copy, executable);
      assert.equal(copy.startsWith(options.cwd + "/"), true);
      assert.deepEqual(readFileSync(copy), bytes);
      assert.notEqual(statSync(copy).ino, statSync(executable).ino);
      assert.equal(existsSync(join(dirname(copy), ".staging")), false);
      assert.equal(existsSync(join(dirname(copy), "kimi.bak")), false);
      assert.equal(options.shell, false);
      assert.equal(options.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
      assert.equal(options.env.KIMI_DISABLE_TELEMETRY, "1");
      assert.equal(options.env.KIMI_API_KEY, undefined);
      assert.equal(options.env.KIMI_MODEL_API_KEY, undefined);
      assert.equal(options.env.KIMI_CODE_CACHE_DIR.startsWith(options.cwd + "/"), true);
      let program;
      if (nativeArgs[0] === "--version") {
        assert.deepEqual(nativeArgs, ["--version"]);
        program = `console.log(${JSON.stringify(runtimeVersion)});`;
      } else {
        assert.equal(wrapped, true);
        assert.deepEqual(nativeArgs, ["acp"]);
        authHome = options.env.KIMI_CODE_HOME;
        assert.equal(authHome.startsWith(paths.stateDir + "/"), false);
        assert.equal(existsSync(authHome), true);
        program = `
          const fs = require('node:fs');
          const scenario = ${JSON.stringify(scenario)};
          const answer = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
          require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
            const request = JSON.parse(line);
            fs.appendFileSync(${JSON.stringify(methodsPath)}, line + '\\n');
            if (request.method === 'initialize') {
              answer(request.id, { protocolVersion: 1,
                agentInfo: { name: 'Kimi Code CLI', version: scenario === 'wrong-version' ? '99.0.0' : ${JSON.stringify(runtimeVersion)} },
                agentCapabilities: {}, authMethods: [{ id: 'login', type: 'terminal', name: 'Login', args: ['--login'] }] });
            } else if (request.method === 'authenticate') {
              if (scenario === 'required') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
                error: { code: -32000, message: 'private-fixture-account', data: { token: 'private-fixture-token' } } }) + '\\n');
              else if (scenario === 'malformed') process.stdout.write('private-fixture-invalid-json\\n');
              else if (scenario === 'pending') {
                const timer = setInterval(() => {
                  if (fs.existsSync(${JSON.stringify(releasePath)})) { clearInterval(timer); answer(request.id, {}); }
                }, 10);
              } else answer(request.id, {});
            } else process.exit(81);
          });
          setInterval(() => {}, 1000);
        `;
      }
      const child = spawn(process.execPath, ["-e", program], options);
      processes.push({ child, cwd: options.cwd, copy });
      return child;
    } },
  });
  const pending = new Set();
  const server = createServer((request, response) => {
    const handling = feature.handle(request, response);
    pending.add(handling);
    handling.finally(() => pending.delete(handling));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await feature.close();
    server.closeAllConnections();
    await Promise.allSettled([...pending]);
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/execution-engines`;
  const headers = { Origin: origin, Authorization: `Bearer ${feature.credentials.capability}`,
    "X-Ling-Engine-Csrf": feature.credentials.csrfToken, "Content-Type": "application/json" };
  async function request(path, method = "GET", body, options = {}) {
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), ...options });
    return { status: response.status, body: await response.json() };
  }
  function save(revision = 0, authProfileId = "fixture") {
    return request(`/${engineId}/profile`, "PUT", { expectedRevision: revision,
      configuration: { engineId, executablePath: executable, authProfileId } });
  }
  function probe(revision = 1, options = {}, mode = "connection") {
    return request(`/${engineId}/probe`, "POST", { expectedRevision: revision, ...(mode ? { mode } : {}) }, options);
  }
  async function enroll() {
    const enrollment = await request("/enrollments", "POST", { origin });
    const session = await request("/session", "POST", { code: enrollment.body.code },
      { headers: { Origin: origin, "Content-Type": "application/json" } });
    assert.equal(session.status, 200);
    return { ...headers, Authorization: `Bearer ${session.body.token}`, "X-Ling-Engine-Csrf": session.body.csrfToken };
  }
  function methods() {
    return existsSync(methodsPath) ? readFileSync(methodsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  }
  function assertClean() {
    assert.ok(processes.length > 0, "the owned peer must actually run");
    for (const { child, cwd, copy } of processes) {
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.equal(existsSync(cwd), false);
      assert.equal(existsSync(copy), false);
    }
    assert.deepEqual(readFileSync(executable), bytes);
    assert.equal(readFileSync(join(root, ".staging", "pending"), "utf8"), "preserve-staging");
    assert.equal(readFileSync(join(root, "kimi.bak"), "utf8"), "preserve-backup");
    if (authHome) assert.equal(existsSync(authHome), false);
  }
  return { feature, request, save, probe, headers, enroll, methods, processes, assertClean,
    release: () => writeFileSync(releasePath, "ready"), digest: createHash("sha256").update(bytes).digest("hex") };
}

test("Kimi HTTP setup is passive; an explicit check traverses ACP and preserves the saved profile", localOnly, async (t) => {
  const f = await fixture(t);
  const saved = await f.save();
  assert.equal(saved.status, 200);
  assert.deepEqual(await f.request(`/${engineId}/profile`), saved);
  assert.equal((await f.request("")).body.profiles.length, 1);
  assert.equal(f.processes.length, 0);
  const result = await f.probe();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "connected", JSON.stringify(result));
  assert.equal(result.body.authentication, "configured_unverified");
  assert.equal(result.body.runtimeVersion, runtimeVersion);
  assert.equal(result.body.executableDigest, f.digest);
  assert.equal(result.body.profileRevision, saved.body.profile.revision);
  assert.equal(result.body.configurationFingerprint, saved.body.profile.configurationFingerprint);
  assert.deepEqual(f.methods().map(item => item.method), ["initialize", "authenticate"]);
  assert.deepEqual(f.methods()[0].params.clientCapabilities, {});
  assert.deepEqual(f.methods()[1].params, { methodId: "login" });
  assert.equal("enabled" in result.body, false);
  assert.deepEqual(await f.request(`/${engineId}/profile`), saved);
  f.assertClean();
});

for (const [scenario, status, authentication] of [
  ["required", "connected", "required"],
  ["wrong-version", "protocol_error", "not_checked"],
  ["malformed", "protocol_error", "not_checked"],
]) {
  test(`Kimi HTTP ${scenario} returns a redacted diagnostic without enabling or changing the profile`, localOnly, async (t) => {
    const f = await fixture(t, scenario);
    const saved = await f.save();
    const result = await f.probe();
    assert.equal(result.status, 200);
    assert.equal(result.body.status, status);
    assert.equal(result.body.authentication, authentication);
    assert.equal(JSON.stringify(result).includes("private-fixture"), false);
    assert.deepEqual(f.methods().map(item => item.method), scenario === "wrong-version" ? ["initialize"] : ["initialize", "authenticate"]);
    assert.deepEqual(await f.request(`/${engineId}/profile`), saved);
    f.assertClean();
  });
}

test("Kimi HTTP installation-only compatibility never performs an account check", localOnly, async (t) => {
  const f = await fixture(t);
  await f.save();
  for (const mode of [undefined, "installation"]) {
    const result = await f.probe(1, {}, mode ?? "");
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "installed");
    assert.equal(result.body.authentication, "not_checked");
    assert.equal(result.body.connection, "not_checked");
    assert.deepEqual(f.methods(), []);
  }
  assert.equal(f.processes.length, 2);
  f.assertClean();
});

test("Kimi HTTP authority, revision and process-option validation precede every launch", localOnly, async (t) => {
  const f = await fixture(t);
  await f.save();
  for (const headers of [{ Origin: origin }, { ...f.headers, Origin: "https://invalid.example" },
    { ...f.headers, "X-Ling-Engine-Csrf": "wrong" }, { ...f.headers, "X-Forwarded-Host": "127.0.0.1" }]) {
    assert.ok([401, 403].includes((await f.probe(1, { headers })).status));
  }
  assert.equal((await f.probe(0)).status, 409);
  for (const extra of [{ spawn: "fake" }, { platform: "linux" }, { timeoutMs: 1000000 }, { cwd: "/tmp" },
    { env: { KIMI_API_KEY: "private-fixture-key" } }, { args: ["--login"] }, { mode: "login" }]) {
    const result = await f.request(`/${engineId}/probe`, "POST", { expectedRevision: 1, mode: "connection", ...extra });
    assert.equal(result.status, 400);
    assert.equal(JSON.stringify(result).includes("private-fixture"), false);
  }
  assert.equal(f.processes.length, 0);
});

for (const action of ["edit", "disconnect", "revoke", "http-close", "shutdown"]) {
  test(`Kimi HTTP ${action} cancels a blocked native check without a cooperative peer`, localOnly, async (t) => {
    const f = await fixture(t, "pending");
    await f.save();
    const headers = action === "revoke" ? await f.enroll() : f.headers;
    const abort = new AbortController();
    const pending = f.probe(1, { headers, signal: abort.signal }).catch(error => error);
    await waitUntil(() => f.methods().some(item => item.method === "authenticate"), "the peer must reach authentication before cancellation");
    assert.deepEqual(await f.probe(), { status: 409, body: { error: "engine_probe_busy" } });
    assert.deepEqual(await f.probe(1, {}, "installation"), { status: 409, body: { error: "engine_probe_busy" } });
    if (action === "edit") assert.equal((await f.save(1, "other-account")).status, 200);
    if (action === "disconnect") assert.equal((await f.request(`/${engineId}/profile`, "DELETE", { expectedRevision: 1 })).status, 200);
    if (action === "revoke") assert.equal((await f.request("/session", "DELETE", undefined, { headers })).status, 200);
    if (action === "http-close") abort.abort();
    if (action === "shutdown") await f.feature.close();
    await waitUntil(() => f.processes.every(({ child, cwd }) => (child.exitCode !== null || child.signalCode !== null) && !existsSync(cwd)),
      "authorization/request/configuration cancellation must reap the peer and remove its copy");
    const result = await pending;
    if (action === "http-close") assert.equal(result.name, "AbortError");
    else assert.deepEqual(result, action === "edit" || action === "disconnect"
      ? { status: 409, body: { error: "profile_revision_conflict" } }
      : { status: 401, body: { error: "engine_authority_required" } });
    f.assertClean();
    if (action !== "disconnect" && action !== "shutdown") {
      f.release();
      const retry = await f.probe(action === "edit" ? 2 : 1);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.status, "connected", "a cancelled check must release its busy slot for authorized retry");
      f.assertClean();
    }
  });
}

test("another browser session's revocation and no-op profile saves do not cancel an authorized Kimi check", localOnly, async (t) => {
  const f = await fixture(t, "pending");
  await f.save();
  const headers = await f.enroll();
  const pending = f.probe();
  await waitUntil(() => f.methods().some(item => item.method === "authenticate"), "the host-owned check must be pending");
  assert.equal((await f.request("/session", "DELETE", undefined, { headers })).status, 200);
  assert.equal((await f.save(1)).body.profile.revision, 1);
  assert.equal(f.processes[1].child.exitCode, null);
  assert.equal(f.processes[1].child.signalCode, null);
  f.release();
  const result = await pending;
  assert.equal(result.body.status, "connected");
  f.assertClean();
});

async function waitUntil(condition, message) {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), message);
}
