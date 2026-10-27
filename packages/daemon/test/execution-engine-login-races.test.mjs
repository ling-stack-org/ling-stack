import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const cleanupCode = "engine_login_cleanup_failed";
const scenarios = ["normal-start", "early-completion", "cleanup-status", "manager-close", "feature-close"];

if (process.argv[2] === "--terminal-fixture") {
  process.stdout.write(JSON.stringify(await runTerminalFixture(process.argv[3])));
} else if (process.argv[2] === "--race-fixture") {
  process.stdout.write(JSON.stringify(await runFixture(process.argv[3], process.argv[4])));
} else {
  for (const target of ["src", "dist"]) {
    test(`native login ${target}: late cancellation preserves terminal states`, async () => {
      const { stdout } = await promisify(execFile)(process.execPath,
        [fileURLToPath(import.meta.url), "--terminal-fixture", target],
        { env: {}, timeout: 8000, maxBuffer: 64 * 1024 });
      assert.deepEqual(JSON.parse(stdout), [
        { status: "failed", errorCode: cleanupCode, active: false },
        { status: "timed_out", errorCode: "engine_login_timed_out", active: false },
        { status: "failed", errorCode: "engine_login_failed", active: false },
      ]);
    });
    for (const scenario of scenarios) {
      test(`native login ${target}: ${scenario}`, { timeout: 10_000 }, async () => {
        // Worker-local hooks and clocks cannot affect other suites; no native executable is launched.
        const { stdout } = await promisify(execFile)(process.execPath,
          [fileURLToPath(import.meta.url), "--race-fixture", target, scenario],
          { env: {}, timeout: 8000, maxBuffer: 64 * 1024 });
        const observation = JSON.parse(stdout);
        assert.equal(observation.startResponseDelivered, true);
        assert.equal(observation.transportClosed, true);
        assert.equal(observation.cwdRemoved, true);
        assert.equal(observation.oldHomeRemoved, false);
        if (scenario === "normal-start" || scenario === "early-completion") {
          assert.equal(observation.elapsedMs, 60, "account update follows the 30ms startup deadline but precedes the 1000ms total deadline");
          assert.equal(observation.accountUpdateDelivered, true);
          assert.equal(observation.challenges, scenario === "normal-start" ? 1 : 0);
          assert.equal(observation.errorCode, undefined);
          assert.equal(observation.adopted, true);
          assert.equal(observation.revision, 2);
          assert.equal(observation.homeRemovalAttempts, 0);
          assert.deepEqual(observation.methods, ["initialize", "initialized", "account/read", "account/login/start", "account/read"]);
        } else {
          assert.equal(observation.adopted, false);
          assert.equal(observation.homeRemovalAttempts, 1, "EACCES must be injected at unadopted auth-home removal");
          assert.equal(observation.newHomeExists, true);
          if (scenario === "cleanup-status") {
            assert.equal(observation.snapshot.challenge, undefined);
            assert.deepEqual({ status: observation.snapshot.status, errorCode: observation.snapshot.errorCode },
              { status: "failed", errorCode: cleanupCode });
            assert.equal(observation.relaunchCode, cleanupCode, "unresolved cleanup cannot be erased by a new login attempt");
          } else {
            if (scenario === "feature-close") assert.equal(observation.storeClosed, true);
            assert.deepEqual(observation.closeCodes, [cleanupCode, cleanupCode], "initial and repeated close must report the stable cleanup failure");
          }
        }
      });
    }
  }
}

async function runTerminalFixture(target) {
  const extension = target === "src" ? "ts" : "js";
  const base = new URL(`../${target}/features/execution-engines/`, import.meta.url);
  const managerUrl = new URL(`login-manager.${extension}`, base).href;
  const authorityUrl = new URL(`authority.${extension}`, base).href;
  const requestUrl = new URL(`../../shared/request.${extension}`, base).href;
  const urls = new Set([managerUrl, authorityUrl, requestUrl]);
  class LoginError extends Error { constructor(code) { super(code); this.code = code; } }
  globalThis.__lingTerminalRace = { LoginError };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === managerUrl) {
        if (specifier === "./authority.js") return { url: authorityUrl, shortCircuit: true };
        if (specifier === "./installation-probe.js") return { url: new URL("../dist/features/execution-engines/installation-probe.js", import.meta.url).href, shortCircuit: true };
        if (specifier === "./native-login.js") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(
          "export const EngineLoginError = globalThis.__lingTerminalRace.LoginError; "
          + "export const assertNativeLoginSupported = () => {}; "
          + "export const runEngineLogin = () => globalThis.__lingTerminalRace.pending.promise;")}` };
      }
      if (context.parentURL === authorityUrl && specifier === "../../shared/request.js") return { url: requestUrl, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (target === "src" && urls.has(url)) return { format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true };
      return next(url, context);
    },
  });
  try {
    const { EngineLoginManager } = await import(managerUrl);
    const { EngineManagementAuthority } = await import(authorityUrl);
    const results = [];
    for (const code of [cleanupCode, "engine_login_timed_out", "engine_login_failed"]) {
      const authority = new EngineManagementAuthority({ capability: "fixture-capability-0000000000000000000", allowedOrigins: [] });
      const profile = { id: "fixture", revision: 1, status: "configured", configuration: { engineId: "codex-app-server" } };
      const manager = new EngineLoginManager({ authority, getStore: () => ({ get: () => profile, listReferences: () => [] }),
        userPaths: {}, isProbing: () => false });
      const pending = Promise.withResolvers();
      globalThis.__lingTerminalRace.pending = pending;
      const operation = manager.start("codex-app-server", 1, "chatgptDeviceCode", { kind: "host" });
      pending.reject(new LoginError(code));
      const snapshot = await new Promise((resolve, reject) => queueMicrotask(() => {
        manager.cancel("codex-app-server", operation.id, { kind: "host" }).then(resolve, reject);
      }));
      results.push({ status: snapshot.status, errorCode: snapshot.errorCode, active: manager.isActive("codex-app-server") });
      if (code === cleanupCode) await assert.rejects(manager.close(), { code });
      else await manager.close();
      authority.close();
    }
    return results;
  } finally {
    hooks.deregister();
    delete globalThis.__lingTerminalRace;
  }
}

async function runFixture(target, scenario) {
  assert.ok(["src", "dist"].includes(target));
  assert.ok(scenarios.includes(scenario));
  const startup = scenario === "normal-start" || scenario === "early-completion";
  const extension = target === "src" ? "ts" : "js";
  const base = new URL(`../${target}/features/execution-engines/`, import.meta.url);
  const modules = new Map(["native-login", "native-secrets", "codex-login", "codex-connection", "login-manager", "authority", "feature", "controller",
    "claude-environment", "windows-supervisor", "kimi-auth-state", "native-auth-file", "kimi-native-executable", "kimi-terminal-login",
    "engine-secret-store", "secret-profile", "engine-scanner", "managed-engine-installer"]
    .map((name) => [`./${name}.js`, new URL(`${name}.${extension}`, base).href]));
  const requestUrl = new URL(`../../shared/request.${extension}`, base).href;
  const realUrls = new Set([...modules.values(), requestUrl]);
  const nativeUrl = modules.get("./native-login.js");
  const cwd = resolve("ling-login-race-fixture", "cwd");
  const home = resolve("ling-login-race-fixture", "new-auth");
  const oldHome = resolve("ling-login-race-fixture", "old-auth");
  let profile = { id: "fixture", revision: 1, status: "configured", configuration: {
    engineId: "codex-app-server", executablePath: resolve("ling-login-race-fixture", "codex"), authProfileId: "old-fixture",
  } };
  const observation = { methods: [], challenges: 0, startResponseDelivered: false, transportClosed: false,
    cwdRemoved: false, oldHomeRemoved: false, adopted: false, newHomeExists: false, homeRemovalAttempts: 0, storeClosed: false };
  const started = Promise.withResolvers();
  const controller = new AbortController();
  let authority, manager, feature;
  const save = (configuration, revision) => {
    assert.equal(revision, 1);
    assert.equal(observation.transportClosed, true);
    assert.equal(observation.cwdRemoved, true);
    observation.adopted = true;
    profile = { ...profile, configuration, revision: 2 };
    return profile;
  };
  class FixtureStore {
    get() { return profile; }
    listReferences() { return []; }
    save(configuration, revision) { return save(configuration, revision); }
    close() { observation.storeClosed = true; }
  }
  globalThis.__lingLoginRace = {
    FixtureStore,
    realpath: async (path) => path,
    mkdtemp: async () => cwd,
    rm: async (path) => {
      if (path === cwd) observation.cwdRemoved = true;
      else if (path === oldHome) { observation.oldHomeRemoved = true; assert.fail("must not remove existing account"); }
      else {
        assert.equal(path, home);
        observation.homeRemovalAttempts++;
        if (!startup) throw Object.assign(new Error("private-fixture-removal-denied"), { code: "EACCES" });
        observation.newHomeExists = false;
      }
    },
    prepareHome: async () => { observation.newHomeExists = true; return home; },
    capture: async (_file, _cwd, codexHome, signal, _spawn, operation) => {
      const output = new PassThrough();
      const loginId = "90569017-265a-4efc-a355-fc4262704a5d";
      const send = (message) => output.write(`${JSON.stringify(message)}\n`);
      const complete = () => send({ method: "account/login/completed", params: { loginId, success: true } });
      const input = new Writable({ write(chunk, _encoding, done) {
        const message = JSON.parse(chunk.toString());
        observation.methods.push(message.method);
        done();
        setImmediate(() => {
          if (output.destroyed) return;
          if (message.id === 1) send({ id: 1, result: { userAgent: "fixture", codexHome, platformFamily: "unix", platformOs: "macos" } });
          else if (message.id === 2) send({ id: 2, result: { account: null, requiresOpenaiAuth: true } });
          else if (message.id === 3) {
            if (scenario === "early-completion") complete();
            send({ id: 3, result: { type: "chatgptDeviceCode", loginId,
              verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } });
            observation.startResponseDelivered = true;
            started.resolve();
          } else if (message.id === 4) send({ id: 4, result: {
            requiresOpenaiAuth: true, account: { type: "chatgpt", email: null, planType: "plus" },
          } });
          else if (message.id === 5) send({ id: 5, result: { status: "canceled" } });
        });
      } });
      const pending = operation({ input, output, codexHome, signal });
      // Attach immediately so an abort during a controlled clock advance is never unhandled.
      pending.catch(() => undefined);
      try {
        if (startup) {
          await started.promise;
          mock.timers.tick(60);
          observation.elapsedMs = 60;
          if (scenario === "normal-start") complete();
          send({ method: "account/updated", params: { authMode: "chatgpt" } });
          observation.accountUpdateDelivered = true;
        }
        return await pending;
      } finally {
        observation.transportClosed = true;
        input.destroy();
        output.destroy();
      }
    },
  };
  const mocks = {
    "../../runtime/runner-settings.js": "export const loadWorkspaceRuntimeSettings = () => { throw new Error('unexpected-runner-settings'); };",
    "../../runtime/runner-acceptance-store.js": "export class RunnerAcceptanceStore { read() { throw new Error('unexpected-acceptance-read'); } }",
    "@ling-stack/core": "export const ExecutionEngineProfileStore = globalThis.__lingLoginRace.FixtureStore; "
      + "export class ExecutionEngineProfileError extends Error { constructor(code) { super(code); this.code = code; } } "
      + "export const isExternalExecutionEngineId = id => id === 'codex-app-server'; "
      + "export const assertProfileRevision = revision => { if (revision !== 1) throw new ExecutionEngineProfileError('profile_invalid'); }; "
      + "export const parseExecutionEngineProfileConfiguration = value => value;",
    "./connection-probe.js": "export const executableDigest = async () => 'fixture-digest'; "
      + "export const captureCodexAccountOperation = globalThis.__lingLoginRace.capture; "
      + "export const captureKimiAccountOperation = () => { throw new Error('unexpected-kimi-operation'); }; "
      + "export const probeEngineConnection = () => { throw new Error('unexpected-probe'); };",
    "./installation-probe.js": "export class EngineProbeBusyError extends Error {} "
      + "export const probeEngineInstallation = async () => ({status:'installed',executableDigest:'fixture-digest'});",
    "./native-auth-home.js": "export const prepareNativeAuthHome = globalThis.__lingLoginRace.prepareHome;",
    "./run-target-dispatcher.js": "export const createExecutionEngineRunTargetDispatcher = () => ({ "
      + "dispatch: () => { throw new Error('unexpected-native-dispatch'); } });",
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (realUrls.has(context.parentURL)) {
        if (context.parentURL === modules.get("./kimi-terminal-login.js") && specifier === "./installation-probe.js") {
          return { url: new URL("../dist/features/execution-engines/installation-probe.js", import.meta.url).href, shortCircuit: true };
        }
        if (context.parentURL === nativeUrl && specifier === "node:fs/promises") {
          return { url: `data:text/javascript,${encodeURIComponent("export const {realpath,mkdtemp,rm} = globalThis.__lingLoginRace;")}`, shortCircuit: true };
        }
        if (modules.has(specifier)) return { url: modules.get(specifier), shortCircuit: true };
        if (specifier === "../../shared/request.js") return { url: requestUrl, shortCircuit: true };
        if (Object.hasOwn(mocks, specifier)) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (target === "src" && realUrls.has(url)) return { format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true };
      return next(url, context);
    },
  });
  const processOptions = { platform: "darwin", timeoutMs: 1000, startupTimeoutMs: 30,
    spawn: () => { throw new Error("native-process-forbidden"); } };
  const closeCode = async (owner) => {
    try { await owner.close(); return null; }
    catch (error) { return error.code ?? error.message; }
  };
  try {
    if (startup) {
      const { runEngineLogin } = await import(nativeUrl);
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const updated = await runEngineLogin(profile, {}, { ...processOptions, method: "chatgptDeviceCode", signal: controller.signal,
          onChallenge: () => observation.challenges++, adopt: (configuration) => save(configuration, 1) });
        observation.revision = updated.revision;
      } catch (error) { observation.errorCode = error.code ?? error.message; }
    } else if (scenario === "feature-close") {
      const { EngineManagementFeature } = await import(modules.get("./feature.js"));
      feature = new EngineManagementFeature({ userPaths: {}, allowedOrigins: [], login: { ...processOptions, startupTimeoutMs: 1000 } });
      const result = await startThroughFeature(feature);
      assert.equal(result.status, 202, JSON.stringify(result.body));
      await started.promise;
      observation.closeCodes = [await closeCode(feature), await closeCode(feature)];
    } else {
      const { EngineManagementAuthority } = await import(modules.get("./authority.js"));
      const { EngineLoginManager } = await import(modules.get("./login-manager.js"));
      authority = new EngineManagementAuthority({ capability: "fixture-capability-0000000000000000000", allowedOrigins: [] });
      manager = new EngineLoginManager({ authority, getStore: () => new FixtureStore(), userPaths: {}, isProbing: () => false,
        process: { ...processOptions, startupTimeoutMs: 1000 } });
      const owner = { kind: "host" };
      const operation = manager.start("codex-app-server", 1, "chatgptDeviceCode", owner);
      await started.promise;
      assert.equal(manager.get("codex-app-server", operation.id, owner).status, "waiting");
      if (scenario === "cleanup-status") {
        observation.snapshot = await manager.cancel("codex-app-server", operation.id, owner);
        assert.deepEqual(manager.get("codex-app-server", operation.id, owner), observation.snapshot);
        try { manager.start("codex-app-server", 1, "chatgptDeviceCode", owner); }
        catch (error) { observation.relaunchCode = error.code; }
      }
      observation.closeCodes = [await closeCode(manager), await closeCode(manager)];
    }
    return observation;
  } finally {
    controller.abort();
    if (manager) await closeCode(manager);
    if (feature) await closeCode(feature);
    authority?.close();
    mock.timers.reset();
    hooks.deregister();
    delete globalThis.__lingLoginRace;
  }
}

async function startThroughFeature(feature) {
  const body = Buffer.from(JSON.stringify({ expectedRevision: 1, method: "chatgptDeviceCode" }));
  const request = Readable.from([body]);
  Object.assign(request, { method: "POST", url: "/execution-engines/codex-app-server/auth",
    socket: { remoteAddress: "127.0.0.1", localPort: 17892 },
    headers: { host: "127.0.0.1:17892", origin: "http://127.0.0.1:17892", "content-type": "application/json",
      "content-length": String(body.length), authorization: `Bearer ${feature.credentials.capability}`,
      "x-ling-engine-csrf": feature.credentials.csrfToken } });
  const response = new EventEmitter();
  const result = {};
  response.setHeader = () => {};
  response.writeHead = (status) => { result.status = status; };
  response.end = (text) => {
    result.body = JSON.parse(text);
    response.writableEnded = response.writableFinished = true;
    response.emit("finish");
  };
  assert.equal(await feature.handle(request, response), true);
  return result;
}
