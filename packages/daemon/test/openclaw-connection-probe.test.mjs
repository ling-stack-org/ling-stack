import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { resolveUserConfigPaths } from "@ling-stack/core";
import { probeEngineConnection } from "../dist/features/execution-engines/connection-probe.js";
import { EngineManagementFeature } from "../dist/features/execution-engines/feature.js";

const localOnly = { skip: process.platform === "win32", timeout: 10_000 };
const version = "2026.9.8";
const token = "private-openclaw-fixture-token";

function fixture(t, { credentialType, scenario = "connected" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-openclaw-probe-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "openclaw");
  writeFileSync(executable, "owned-fixture-executable", { mode: 0o700 });
  const paths = resolveUserConfigPaths({ userRootDir: join(root, "ling") });
  const profile = { schemaVersion: 1, id: "openclaw-fixture", revision: 1, status: "configured",
    configuration: { engineId: "openclaw-acp", executablePath: executable, authProfileId: "fixture",
      secretRef: "env:OPENCLAW_FIXTURE_TOKEN", openclaw: { gatewayUrl: "wss://gateway.example.test", agentId: "existing-agent",
        ...(credentialType ? { credentialType } : {}) } },
    configurationFingerprint: "f".repeat(64), updatedAt: new Date().toISOString() };
  const methodsPath = join(root, "methods.jsonl");
  const processes = [];
  const credentialFiles = [];
  let authHome;
  const launch = (file, args, options) => {
    assert.equal(file, executable);
    assert.equal(options.shell, false);
    assert.equal(options.env.HOME, options.cwd);
    assert.equal(options.env.OPENCLAW_GATEWAY_TOKEN, undefined);
    assert.equal(options.env.OPENCLAW_GATEWAY_PASSWORD, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.OPENCLAW_NO_RESPAWN, "1", "owned probes must keep the ACP process in their process group");
    let program;
    if (args[0] === "--version") {
      assert.deepEqual(args, ["--version"]);
      assert.equal(options.env.OPENCLAW_STATE_DIR.startsWith(options.cwd + "/"), true);
      assert.equal(options.env.OPENCLAW_CONFIG_PATH, join(options.env.OPENCLAW_STATE_DIR, "openclaw.json"));
      program = `console.log('OpenClaw ${version} (cad71be)');`;
    }
    else {
      assert.deepEqual(args.slice(0, 3), ["acp", "--url", profile.configuration.openclaw.gatewayUrl]);
      assert.equal(args.length, 5);
      assert.equal(args[3], credentialType === "password" ? "--password-file" : "--token-file");
      assert.equal(readFileSync(args[4], "utf8"), token);
      assert.equal(statSync(args[4]).mode & 0o077, 0);
      assert.equal(args[4].startsWith(options.cwd + "/"), true);
      credentialFiles.push(args[4]);
      assert.equal(JSON.stringify(args).includes(token), false);
      assert.equal(JSON.stringify(options.env).includes(token), false);
      authHome = options.env.OPENCLAW_STATE_DIR;
      assert.equal(authHome.startsWith(paths.stateDir + "/"), true);
      assert.equal(options.env.OPENCLAW_HOME, options.cwd);
      assert.equal(options.env.OPENCLAW_CONFIG_PATH, join(authHome, "openclaw.json"));
      program = `
        const fs = require('node:fs');
        const scenario = ${JSON.stringify(scenario)};
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          fs.appendFileSync(${JSON.stringify(methodsPath)}, line + '\\n');
          const request = JSON.parse(line);
          if (request.method !== 'initialize') process.exit(71);
          const result = {
            protocolVersion: scenario === 'protocol' ? 0 : 1,
            agentInfo: { name: scenario === 'identity' ? 'another-agent' : 'openclaw-acp', version: scenario === 'version' ? '0.0.0' : '${version}' },
            agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} } }, authMethods: []
          };
          if (scenario === 'pending') return;
          if (scenario === 'exit') { process.stderr.write('private-fixture-auth-error'); process.exit(1); }
          if (scenario === 'malformed') { console.log('private-fixture-json'); return; }
          if (scenario === 'overflow') { process.stderr.write('private-fixture'.repeat(10000)); return; }
          if (scenario === 'auth-method') result.authMethods.push({ id: 'login', name: 'Login' });
          if (scenario === 'reverse') {
            console.log(JSON.stringify({ jsonrpc: '2.0', id: 'unsolicited', method: 'session/request_permission',
              params: { sessionId: 'private-fixture-session', toolCall: { toolCallId: 'private-fixture-call' }, options: [] } }));
          }
          console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        });
        setInterval(() => {}, 1000);
      `;
    }
    const child = spawn(process.execPath, ["-e", program], options);
    processes.push({ child, root: options.cwd });
    return child;
  };
  return { root, paths, profile, launch, processes, credentialFiles,
    setScenario: value => { scenario = value; },
    get home() { return authHome; },
    methods: () => existsSync(methodsPath) ? readFileSync(methodsPath, "utf8").trim().split("\n").map(JSON.parse) : [],
    secretResolver: { resolve: () => ({ configured: true, value: token }) } };
}

test("OpenClaw checks the explicit existing bridge with initialize only and cleans credentials before publishing", localOnly, async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.profile);
  const result = await probeEngineConnection(f.profile, f.paths, { spawn: f.launch, secretResolver: f.secretResolver });
  assert.equal(result.status, "connected");
  assert.equal(result.connection, "connected");
  assert.equal(result.authentication, "provider_managed");
  assert.equal(result.runtimeVersion, version);
  assert.equal(result.profileRevision, 1);
  assert.deepEqual(f.methods().map(item => item.method), ["initialize"]);
  assert.deepEqual(f.methods()[0].params.clientCapabilities, {});
  assert.deepEqual(f.profile, before);
  assert.equal("enabled" in result, false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(f.processes.length, 2);
  for (const { child, root } of f.processes) {
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(existsSync(root), false);
  }
  for (const file of f.credentialFiles) assert.equal(existsSync(file), false);
  assert.equal(existsSync(f.home), true);
});

test("OpenClaw probe preserves its handshake outcome when local transport cleanup closes the bridge", localOnly, async (t) => {
  for (const [protocolVersion, expected] of [[1, "connected"], [2, "protocol_error"]]) {
    await t.test(expected, async (t) => {
      const f = fixture(t);
      const output = new PassThrough();
      let child, closed = false, inputClosed = false, probeRoot, credentialFile;
      const closeChild = () => {
        if (closed) return;
        closed = true;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      };
      const input = new Writable({
        write(chunk, _encoding, callback) {
          const request = JSON.parse(chunk.toString());
          assert.equal(request.method, "initialize");
          callback();
          output.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
            protocolVersion, agentInfo: { name: "openclaw-acp", version }, agentCapabilities: {}, authMethods: [],
          } }) + "\n");
        },
        destroy(error, callback) {
          // A child can exit on local stdin closure before its pipe finishes closing.
          queueMicrotask(closeChild);
          setImmediate(() => { inputClosed = true; callback(error); });
        },
      });
      child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, stderr: new PassThrough(),
        kill() { queueMicrotask(closeChild); return true; } });
      t.after(() => { input.destroy(); output.destroy(); child.stderr.destroy(); });
      const result = await probeEngineConnection(f.profile, f.paths, {
        secretResolver: f.secretResolver,
        spawn(file, args, options) {
          if (args[0] !== "acp") return f.launch(file, args, options);
          probeRoot = options.cwd;
          credentialFile = args[4];
          assert.equal(readFileSync(credentialFile, "utf8"), token);
          return child;
        },
      });
      assert.equal(result.status, expected);
      assert.equal(result.authentication, expected === "connected" ? "provider_managed" : "not_checked");
      assert.equal(closed, true, "publishing the outcome requires physical child close");
      assert.equal(inputClosed, true, "the original inspection must finish stream cleanup");
      assert.equal(input.destroyed && output.destroyed, true);
      assert.equal(existsSync(probeRoot), false);
      assert.equal(existsSync(credentialFile), false);
    });
  }
});

for (const scenario of ["identity", "version", "protocol", "auth-method", "reverse", "malformed", "overflow", "exit", "pending"]) {
  test(`OpenClaw ${scenario} cannot certify a connection and leaves no owned process or credential file`, localOnly, async (t) => {
    const f = fixture(t, { scenario });
    const result = await probeEngineConnection(f.profile, f.paths, { spawn: f.launch, secretResolver: f.secretResolver, timeoutMs: 1500 });
    const expected = scenario === "pending" ? "timed_out" : scenario === "overflow" ? "output_limit"
      : scenario === "exit" ? "probe_failed" : "protocol_error";
    assert.equal(result.status, expected);
    assert.equal(result.authentication, "not_checked");
    assert.equal(result.connection, "not_checked");
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.deepEqual(f.methods().map(item => item.method), ["initialize"]);
    for (const { child, root } of f.processes) {
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.equal(existsSync(root), false);
    }
    for (const file of f.credentialFiles) assert.equal(existsSync(file), false);
  });
}

test("OpenClaw cancellation reaps an unresponsive bridge and preserves the saved profile", localOnly, async (t) => {
  const f = fixture(t, { scenario: "pending" });
  const abort = new AbortController();
  const result = await probeEngineConnection(f.profile, f.paths, { secretResolver: f.secretResolver, signal: abort.signal,
    spawn: (file, args, options) => {
      const child = f.launch(file, args, options);
      if (args[0] === "acp") setTimeout(() => abort.abort(), 75);
      return child;
    } });
  assert.equal(result.status, "cancelled");
  for (const { child, root } of f.processes) {
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(existsSync(root), false);
  }
  assert.equal(f.profile.revision, 1);
});

test("OpenClaw secret rotation after initialization invalidates the result without exposing either credential", localOnly, async (t) => {
  const f = fixture(t);
  let reads = 0;
  const result = await probeEngineConnection(f.profile, f.paths, { spawn: f.launch,
    secretResolver: { resolve: () => ({ configured: true, value: ++reads === 1 ? token : "private-rotated-key" }) } });
  assert.equal(reads, 2);
  assert.equal(result.status, "auth_required");
  assert.equal(result.errorCode, "engine_secret_changed");
  assert.equal(JSON.stringify(result).includes("private"), false);
  for (const file of f.credentialFiles) assert.equal(existsSync(file), false);
});

test("OpenClaw missing or revoked auth and unsupported platform cannot launch any native process", async (t) => {
  const f = fixture(t);
  const noSpawn = () => { assert.fail("must not launch"); };
  assert.equal((await probeEngineConnection({ ...f.profile, configuration: { ...f.profile.configuration, secretRef: undefined } },
    f.paths, { spawn: noSpawn, platform: "darwin" })).status, "unsupported_auth");
  assert.equal((await probeEngineConnection(f.profile, f.paths, { spawn: noSpawn, platform: "darwin",
    secretResolver: { resolve: () => ({ configured: false }) } })).status, "auth_required");
  assert.equal((await probeEngineConnection(f.profile, f.paths, { spawn: noSpawn, platform: "win32" })).status, "unsupported_platform");
  assert.equal(f.processes.length, 0);
});

test("OpenClaw password profiles use the official password file option without changing the saved account", localOnly, async (t) => {
  const f = fixture(t, { credentialType: "password" });
  const result = await probeEngineConnection(f.profile, f.paths, { spawn: f.launch, secretResolver: f.secretResolver });
  assert.equal(result.status, "connected");
  assert.equal(result.authentication, "provider_managed");
  assert.deepEqual(f.methods().map(item => item.method), ["initialize"]);
  for (const file of f.credentialFiles) assert.equal(existsSync(file), false);
  assert.equal(f.profile.configuration.openclaw.credentialType, "password");
});

async function httpFixture(t, options) {
  let feature, server;
  const handling = new Set();
  t.after(async () => {
    await feature?.close();
    if (server?.listening) {
      server.closeAllConnections();
      await Promise.allSettled([...handling]);
      await new Promise(resolve => server.close(resolve));
    }
  });
  const f = fixture(t, options);
  const origin = "http://127.0.0.1:5175";
  feature = new EngineManagementFeature({ userPaths: f.paths, allowedOrigins: [origin], secretResolver: f.secretResolver,
    probe: { spawn: f.launch, timeoutMs: 5000 } });
  server = createServer((request, response) => {
    const pending = feature.handle(request, response);
    handling.add(pending);
    pending.finally(() => handling.delete(pending));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/execution-engines`;
  const headers = { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${feature.credentials.capability}`,
    "X-Ling-Engine-Csrf": feature.credentials.csrfToken };
  async function request(path, method = "GET", body, requestHeaders = headers) {
    const response = await fetch(url + path, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const save = (revision = 0, configuration = f.profile.configuration) => request("/openclaw-acp/profile", "PUT", { expectedRevision: revision, configuration });
  const probe = (revision = 1, requestHeaders) => request("/openclaw-acp/probe", "POST", { expectedRevision: revision, mode: "connection" }, requestHeaders);
  async function enroll() {
    const code = await request("/enrollments", "POST", { origin });
    const session = await request("/session", "POST", { code: code.body.code }, { Origin: origin, "Content-Type": "application/json" });
    assert.equal(session.status, 200);
    return { ...headers, Authorization: `Bearer ${session.body.token}`, "X-Ling-Engine-Csrf": session.body.csrfToken };
  }
  return { ...f, request, headers, save, probe, enroll };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), "expected owned process state before deadline");
}

function assertClean(f) {
  assert.ok(f.processes.length > 0);
  for (const { child, root } of f.processes) {
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(existsSync(root), false);
  }
  for (const file of f.credentialFiles) assert.equal(existsSync(file), false);
}

test("OpenClaw HTTP management stays passive until an authorized explicit connection check", localOnly, async (t) => {
  const f = await httpFixture(t, { credentialType: "password" });
  const saved = await f.save();
  assert.equal(saved.status, 200);
  assert.deepEqual(await f.request("/openclaw-acp/profile"), saved);
  assert.equal((await f.request("")).body.profiles.length, 1);
  assert.equal(f.processes.length, 0);
  assert.equal((await f.probe(0)).status, 409);
  assert.equal((await f.probe(1, { Origin: f.headers.Origin, "Content-Type": "application/json" })).status, 401);
  assert.equal((await f.request("/openclaw-acp/probe", "POST", { expectedRevision: 1, mode: "connection", command: "gateway start" })).status, 400);
  assert.equal(f.processes.length, 0);
  const result = await f.probe();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "connected");
  assert.equal(result.body.authentication, "provider_managed");
  assert.equal(result.body.profileRevision, saved.body.profile.revision);
  assert.equal(result.body.configurationFingerprint, saved.body.profile.configurationFingerprint);
  assert.equal(JSON.stringify(result.body).includes(token), false);
  assert.deepEqual(await f.request("/openclaw-acp/profile"), saved);
  assert.deepEqual(f.methods().map(item => item.method), ["initialize"]);
  assertClean(f);
});

test("OpenClaw HTTP profile edit cancels a busy bridge and permits a new revision check", localOnly, async (t) => {
  const f = await httpFixture(t, { scenario: "pending" });
  const saved = await f.save();
  assert.equal(saved.status, 200);
  const checking = f.probe();
  await waitFor(() => f.methods().length === 1);
  assert.equal((await f.probe()).status, 409);
  const updated = await f.save(1, { ...f.profile.configuration, authProfileId: "second" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.profile.revision, 2);
  assert.equal((await checking).status, 409);
  assertClean(f);
  f.setScenario("connected");
  assert.equal((await f.probe(2)).body.status, "connected");
  assertClean(f);
});

test("OpenClaw HTTP revoked Web authority reaps the pending bridge without a native reply", localOnly, async (t) => {
  const f = await httpFixture(t, { scenario: "pending" });
  assert.equal((await f.save()).status, 200);
  const browser = await f.enroll();
  const checking = f.probe(1, browser);
  await waitFor(() => f.methods().length === 1);
  assert.equal((await f.request("/session", "DELETE", undefined, browser)).status, 200);
  await waitFor(() => f.processes.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
  assert.equal((await checking).status, 401);
  assertClean(f);
  f.setScenario("connected");
  assert.equal((await f.probe()).body.status, "connected");
  assertClean(f);
});
