import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { resolveUserConfigPaths } from "@ling-stack/core";
import { probeEngineConnection } from "../dist/features/execution-engines/connection-probe.js";
import { assertNativeLoginSupported, runEngineLogin } from "../dist/features/execution-engines/native-login.js";
import { captureClaudeAccountOperation } from "../dist/features/execution-engines/claude-connection.js";
import { EngineManagementFeature } from "../dist/features/execution-engines/feature.js";

const localOnly = { skip: process.platform === "win32", timeout: 10_000 };
const version = "2.1.156";
const key = "private-claude-key-fixture";

test("Claude public CLI probing adds no proprietary SDK or bundled CLI dependency", () => {
  const daemon = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.equal(daemon.dependencies["@anthropic-ai/claude-agent-sdk"], undefined);
  assert.equal(daemon.dependencies["@anthropic-ai/claude-code"], undefined);
  assert.equal(daemon.dependencies["@anthropic-ai/sdk"], "0.135.0");
  assert.equal((root.pnpm.ignoredOptionalDependencies ?? []).includes("@anthropic-ai/claude-agent-sdk-*"), false);
});

function fixture(t, scenario = "connected", ownCleanup = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-claude-probe-")));
  if (ownCleanup) t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "claude");
  writeFileSync(executable, "owned-native-fixture", { mode: 0o700 });
  const paths = resolveUserConfigPaths({ userRootDir: join(root, "ling") });
  const profile = { schemaVersion: 1, id: "claude-fixture", revision: 1, status: "configured",
    configuration: { engineId: "claude-agent-sdk", executablePath: executable, authProfileId: "fixture", secretRef: "env:CLAUDE_FIXTURE_KEY" },
    configurationFingerprint: "f".repeat(64), updatedAt: new Date().toISOString() };
  const commandsPath = join(root, "commands.jsonl"), descendantPath = join(root, "descendant.pid"), processes = [];
  let home;
  const launch = (file, args, options) => {
    assert.equal(file, executable);
    assert.equal(options.shell, false);
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.env.HOME, options.cwd);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(options.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(options.env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(options.env.CLAUDE_CONFIG_DIR.startsWith(options.cwd + "/"), true);
    assert.equal(options.env.CLAUDE_CODE_SIMPLE, "1");
    assert.equal(options.env.CLAUDE_AGENT_SDK_CLIENT_APP, undefined);
    let program;
    if (args[0] === "--version") {
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      assert.deepEqual(args, ["--version"]);
      program = `console.log('${scenario === "version" ? "2.1.1" : version} (Claude Code)');`;
    } else {
      assert.equal(options.env.ANTHROPIC_API_KEY, key);
      assert.equal(JSON.stringify(args).includes(key), false);
      assert.deepEqual(args, ["--bare", "--setting-sources=", "--settings",
        JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }), "--strict-mcp-config", "auth", "status", "--json"]);
      home = options.env.CLAUDE_CONFIG_DIR;
      program = `
        const fs = require('node:fs');
        const scenario = ${JSON.stringify(scenario)};
        fs.appendFileSync(${JSON.stringify(commandsPath)}, JSON.stringify({ operation: 'auth-status' }) + '\\n');
        if (scenario === 'pending') { setInterval(() => {}, 1000); return; }
        if (scenario === 'exit') { process.stderr.write('private-claude-error'); process.exitCode = 1; return; }
        if (scenario === 'signal') { process.kill(process.pid, 'SIGTERM'); return; }
        if (scenario === 'overflow') { process.stderr.write(Buffer.alloc(65537)); return; }
        if (scenario === 'stdout-overflow') { process.stdout.write(Buffer.alloc(65537)); return; }
        if (scenario === 'malformed') { console.log('private-invalid-json'); return; }
        if (scenario === 'utf8') { process.stdout.write(Buffer.from([0xff])); return; }
        let response = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' };
        if (scenario === 'source') response.apiKeySource = 'apiKeyHelper';
        if (scenario === 'oauth') response.authMethod = 'claude.ai';
        if (scenario === 'provider') response.apiProvider = 'bedrock';
        if (scenario === 'token-source') response.tokenSource = 'claude.ai';
        if (scenario === 'missing-source') delete response.apiKeySource;
        if (scenario === 'shape') delete response.loggedIn;
        if (scenario === 'wrong-types') response.loggedIn = 'true';
        if (scenario === 'bad-source-type') response.apiKeySource = {};
        if (scenario === 'null') response = null;
        if (scenario === 'array') response = [response];
        if (scenario === 'identity') Object.assign(response, { email: 'private-identity@example.invalid', orgId: 'private-org', orgName: 'private-name' });
        if (scenario === 'not-logged-in' || scenario === 'false-success') {
          response.loggedIn = false; response.authMethod = 'none'; delete response.apiKeySource;
          if (scenario === 'not-logged-in') process.exitCode = 1;
        }
        if (scenario === 'nonzero') process.exitCode = 1;
        if (scenario === 'error') { response = { error: 'private-native-error' }; process.exitCode = 1; }
        let output = JSON.stringify(response) + '\\n';
        if (scenario === 'trailing') output += 'private-partial';
        if (scenario === 'duplicate') output += JSON.stringify(response) + '\\n';
        process.stdout.write(output);
        if (scenario === 'descendant') {
          const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
            { stdio: ['ignore', process.stdout, process.stderr] });
          fs.writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid));
          child.unref();
        }
      `;
      // A module wrapper permits early return without adding an input listener or prompt protocol.
      program = `(function () { ${program} })();`;
    }
    const child = spawn(process.execPath, ["-e", program], options);
    processes.push({ child, root: options.cwd });
    if (args[0] !== "--version") child.once("exit", () => {
      if (scenario === "late-partial") child.stdout.emit("data", Buffer.from("private-late-partial"));
      if (scenario === "late-stderr") child.stderr.emit("data", Buffer.alloc(65537));
    });
    return child;
  };
  return { root, paths, profile, launch, processes, descendantPath, get home() { return home; },
    setScenario: value => { scenario = value; },
    commands: () => existsSync(commandsPath) ? readFileSync(commandsPath, "utf8").trim().split("\n").map(JSON.parse) : [],
    secretResolver: { resolve: () => ({ configured: true, value: key }) } };
}

function assertClean(f) {
  for (const { child, root } of f.processes) {
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(existsSync(root), false);
  }
}

test("Claude public CLI checks auth status without a prompt, account session or model request", localOnly, async (t) => {
  const f = fixture(t);
  const result = await probeEngineConnection(f.profile, f.paths, { spawn: f.launch, secretResolver: f.secretResolver });
  assert.equal(result.status, "connected");
  assert.equal(result.connection, "connected");
  assert.equal(result.authentication, "configured_unverified");
  assert.equal(result.runtimeVersion, version);
  assert.equal(f.processes.length, 2);
  assert.deepEqual(f.commands().map(command => command.operation), ["auth-status"]);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assertClean(f);
});

test("Claude key setup adopts only after CLI cleanup and never offers subscription login", localOnly, async (t) => {
  const f = fixture(t);
  for (const method of ["chatgpt", "chatgptDeviceCode", "terminal"]) {
    assert.throws(() => assertNativeLoginSupported(f.profile, method), { code: "engine_login_method_unavailable" });
  }
  let adopted = 0;
  const result = await runEngineLogin(f.profile, f.paths, { method: "apiKey", signal: new AbortController().signal,
    spawn: f.launch, secretResolver: f.secretResolver, onChallenge: () => assert.fail("no login challenge for API key"),
    adopt: configuration => {
      assertClean(f);
      assert.notEqual(configuration.authProfileId, f.profile.configuration.authProfileId);
      assert.equal(configuration.secretRef, f.profile.configuration.secretRef);
      adopted++;
      return { ...f.profile, revision: 2, configuration };
    } });
  assert.equal(adopted, 1);
  assert.equal(result.revision, 2);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.deepEqual(f.commands().map(command => command.operation), ["auth-status"]);
});

test("Claude key setup preserves old profile on cancellation, rotation, rejected source and failed adoption", localOnly, async (t) => {
  for (const scenario of ["cancel", "rotate", "revoke", "source", "adopt"]) {
    const f = fixture(t, scenario === "cancel" ? "pending" : scenario === "source" ? "source" : "connected");
    const original = structuredClone(f.profile), abort = new AbortController();
    let reads = 0, adoptions = 0;
    const expected = scenario === "cancel" ? "engine_login_cancelled" : scenario === "rotate" ? "engine_secret_changed"
      : scenario === "revoke" ? "engine_secret_missing" : scenario === "source" ? "engine_native_auth_mismatch" : "profile_revision_conflict";
    await assert.rejects(() => runEngineLogin(f.profile, f.paths, { method: "apiKey", signal: abort.signal,
      secretResolver: { resolve: () => ({ configured: !(++reads > 1 && scenario === "revoke"), value: reads > 1 && scenario === "rotate" ? "private-rotated" : key }) },
      onChallenge: () => assert.fail("no challenge"),
      spawn: (...args) => { const child = f.launch(...args); if (scenario === "cancel" && args[1][0] !== "--version") setTimeout(() => abort.abort(), 60); return child; },
      adopt: () => { adoptions++; throw new Error("profile_revision_conflict"); },
    }), { message: expected });
    assert.equal(adoptions, scenario === "adopt" ? 1 : 0);
    assert.deepEqual(f.profile, original);
    assertClean(f);
  }
});

async function httpFixture(t, scenario = "connected") {
  const f = fixture(t, scenario, false);
  const origin = "http://127.0.0.1:5175";
  const feature = new EngineManagementFeature({ userPaths: f.paths, allowedOrigins: [origin], secretResolver: f.secretResolver,
    probe: { spawn: f.launch, timeoutMs: 5000 }, login: { spawn: f.launch, timeoutMs: 5000 } });
  const handling = new Set();
  const server = createServer((request, response) => {
    const promise = feature.handle(request, response);
    handling.add(promise);
    promise.finally(() => handling.delete(promise));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await feature.close(); server.closeAllConnections(); await Promise.allSettled([...handling]);
    await new Promise(resolve => server.close(resolve));
    rmSync(f.root, { recursive: true, force: true });
  });
  const headers = { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${feature.credentials.capability}`,
    "X-Ling-Engine-Csrf": feature.credentials.csrfToken };
  async function request(path, method = "GET", body, requestHeaders = headers) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/execution-engines${path}`,
      { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const save = (revision = 0, configuration = f.profile.configuration) => request("/claude-agent-sdk/profile", "PUT", { expectedRevision: revision, configuration });
  const probe = (revision = 1, headers) => request("/claude-agent-sdk/probe", "POST", { expectedRevision: revision, mode: "connection" }, headers);
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

test("Claude HTTP profiles stay passive until explicit authorized connection/key setup", localOnly, async (t) => {
  const f = await httpFixture(t);
  const saved = await f.save();
  assert.equal(saved.status, 200);
  assert.deepEqual(await f.request("/claude-agent-sdk/profile"), saved);
  assert.equal((await f.request("")).body.profiles.length, 1);
  assert.equal((await f.probe(0)).status, 409);
  assert.equal((await f.probe(1, { Origin: f.headers.Origin })).status, 401);
  assert.equal((await f.request("/claude-agent-sdk/auth", "POST", { expectedRevision: 1, method: "chatgpt" })).status, 409);
  assert.equal((await f.request("/claude-agent-sdk/auth", "POST", { expectedRevision: 1, method: "apiKey", apiKey: key })).status, 400);
  assert.equal(f.processes.length, 0);
  assert.equal((await f.probe()).body.status, "connected");
  const started = await f.request("/claude-agent-sdk/auth", "POST", { expectedRevision: 1, method: "apiKey" });
  assert.equal(started.status, 202);
  let terminal;
  const deadline = Date.now() + 3000;
  do {
    terminal = await f.request(`/claude-agent-sdk/auth/${started.body.id}`);
    if (!["starting", "waiting"].includes(terminal.body.status)) break;
    await delay(15);
  } while (Date.now() < deadline);
  assert.equal(terminal.body.status, "completed");
  assert.equal(terminal.body.authentication, "configured_unverified");
  assert.equal((await f.request("/claude-agent-sdk/profile")).body.profile.revision, 2);
  assert.equal(JSON.stringify(terminal).includes("private"), false);
  assertClean(f);
});

test("Claude checks do not inherit global provider authentication or local CLI configuration", localOnly, async (t) => {
  const inherited = { ANTHROPIC_API_KEY: "private-global-key", ANTHROPIC_AUTH_TOKEN: "private-global-token",
    CLAUDE_CODE_OAUTH_TOKEN: "private-global-oauth", ANTHROPIC_BASE_URL: "https://private.invalid", NODE_OPTIONS: "--private-node-option", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: "/private/global/claude" };
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const f = fixture(t);
  assert.equal((await probeEngineConnection(f.profile, f.paths, { spawn: f.launch, secretResolver: f.secretResolver })).status, "connected");
  assertClean(f);
});

test("Claude HTTP editing a busy profile cancels its CLI process before retry", localOnly, async (t) => {
  const f = await httpFixture(t, "pending");
  assert.equal((await f.save()).status, 200);
  const checking = f.probe();
  await waitFor(() => f.commands().length === 1);
  assert.equal((await f.probe()).status, 409);
  assert.equal((await f.save(1, { ...f.profile.configuration, authProfileId: "new" })).status, 200);
  assert.equal((await checking).status, 409);
  assertClean(f);
  f.setScenario("connected");
  assert.equal((await f.probe(2)).body.status, "connected");
  assertClean(f);
});

test("Claude HTTP revoked Web authority reaps its pending CLI process before diagnostic completion", localOnly, async (t) => {
  const f = await httpFixture(t, "pending");
  assert.equal((await f.save()).status, 200);
  const browser = await f.enroll();
  const checking = f.probe(1, browser);
  await waitFor(() => f.commands().length === 1);
  assert.equal((await f.request("/session", "DELETE", undefined, browser)).status, 200);
  assert.equal((await checking).status, 401);
  assertClean(f);
  f.setScenario("connected");
  assert.equal((await f.probe()).body.status, "connected");
  assertClean(f);
});

for (const scenario of ["source", "oauth", "provider", "token-source", "missing-source", "not-logged-in", "false-success", "shape",
  "wrong-types", "bad-source-type", "null", "array", "error", "nonzero", "signal", "trailing", "duplicate", "malformed", "utf8",
  "late-partial", "late-stderr", "overflow", "stdout-overflow", "pending", "exit"]) {
  test(`Claude ${scenario} cannot publish successful connection evidence`, localOnly, async (t) => {
    const f = fixture(t, scenario);
    const result = await probeEngineConnection(f.profile, f.paths, { spawn: f.launch, secretResolver: f.secretResolver, timeoutMs: 1500 });
    assert.equal(result.status, ["source", "oauth", "provider", "token-source", "missing-source", "not-logged-in", "false-success"].includes(scenario) ? "auth_required"
      : ["overflow", "stdout-overflow", "late-stderr"].includes(scenario) ? "output_limit" : scenario === "pending" ? "timed_out"
      : ["error", "exit", "nonzero", "signal"].includes(scenario) ? "probe_failed" : "protocol_error");
    assert.equal(result.connection, "not_checked");
    assert.equal(JSON.stringify(result).includes("private"), false);
    assertClean(f);
  });
}

test("Claude discards unneeded identity metadata from its public diagnostic", localOnly, async (t) => {
  const f = fixture(t, "identity");
  const result = await probeEngineConnection(f.profile, f.paths, { spawn: f.launch, secretResolver: f.secretResolver });
  assert.equal(result.status, "connected");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(f.commands().map(command => command.operation), ["auth-status"]);
  assertClean(f);
});

test("Claude requires explicit supported auth and compatible runtime; no implicit subscription login", localOnly, async (t) => {
  const f = fixture(t, "version");
  const noSpawn = () => assert.fail("must not launch");
  assert.equal((await probeEngineConnection({ ...f.profile, configuration: { ...f.profile.configuration, secretRef: undefined } }, f.paths,
    { spawn: noSpawn, platform: "darwin" })).status, "unsupported_auth");
  assert.equal((await probeEngineConnection(f.profile, f.paths, { spawn: noSpawn, platform: "win32" })).status, "unsupported_platform");
  assert.equal((await probeEngineConnection(f.profile, f.paths, { spawn: noSpawn, secretResolver: { resolve: () => ({ configured: false }) } })).status, "auth_required");
  assert.equal((await probeEngineConnection(f.profile, f.paths, { spawn: f.launch, secretResolver: f.secretResolver })).status, "unexpected_runtime");
  assert.equal(f.processes.length, 1);
  assertClean(f);
});

test("Claude current-key rotation and cancellation invalidate the owned check", localOnly, async (t) => {
  for (const scenario of ["rotate", "cancel"]) {
    const f = fixture(t, scenario === "cancel" ? "pending" : "connected");
    const abort = new AbortController();
    let reads = 0;
    const result = await probeEngineConnection(f.profile, f.paths, { signal: abort.signal,
      secretResolver: { resolve: () => ({ configured: true, value: scenario === "rotate" && ++reads > 1 ? "private-rotated" : key }) },
      spawn: (...args) => { const child = f.launch(...args); if (scenario === "cancel" && args[1][0] !== "--version") setTimeout(() => abort.abort(), 60); return child; } });
    assert.equal(result.status, scenario === "rotate" ? "auth_required" : "cancelled");
    assert.equal(JSON.stringify(result).includes("private"), false);
    assertClean(f);
  }
});


test("Claude key setup rejects an unsupported CLI version before auth status or adoption", localOnly, async (t) => {
  const f = fixture(t, "version");
  await assert.rejects(() => runEngineLogin(f.profile, f.paths, { method: "apiKey", signal: new AbortController().signal,
    spawn: f.launch, secretResolver: f.secretResolver, onChallenge: () => assert.fail("no challenge"),
    adopt: () => assert.fail("unsupported runtime must not adopt") }), { message: "engine_installation_unexpected_runtime" });
  assert.deepEqual(f.commands(), []);
  assert.equal(f.processes.length, 1);
  assertClean(f);
});

test("Claude cleanup failure vetoes a result when the owned child never closes", localOnly, async (t) => {
  const f = fixture(t), abort = new AbortController();
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let kills = 0;
  child.kill = () => { kills++; return true; };
  const operation = captureClaudeAccountOperation(f.profile.configuration.executablePath, f.root, key, abort.signal, () => child);
  abort.abort();
  await assert.rejects(operation, { code: "cleanup_failed" });
  assert.ok(kills >= 2);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});


test("Claude waits for normal close before accepting a successful diagnostic", localOnly, async (t) => {
  const f = fixture(t), child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => true;
  let settled = false;
  const operation = captureClaudeAccountOperation(f.profile.configuration.executablePath, f.root, key, new AbortController().signal, () => child);
  void operation.then(() => { settled = true; }, () => { settled = true; });
  child.stdout.emit("data", Buffer.from(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" })));
  child.emit("exit", 0, null);
  await delay(25);
  assert.equal(settled, false);
  child.emit("close", 0, null);
  assert.deepEqual(await operation, { connection: "connected", authentication: "configured_unverified" });
});

test("Claude reaps an owned descendant that outlives its successful diagnostic leader", localOnly, async (t) => {
  const f = fixture(t, "descendant");
  const result = await probeEngineConnection(f.profile, f.paths, { spawn: f.launch, secretResolver: f.secretResolver });
  assert.equal(result.status, "connected");
  const pid = Number(readFileSync(f.descendantPath, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
  });
  assertClean(f);
});
