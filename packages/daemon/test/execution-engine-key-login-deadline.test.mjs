import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (process.argv[2] === "--deadline-fixture") {
  process.stdout.write(JSON.stringify(await runFixture(process.argv[3])));
} else {
  for (const target of ["src", "dist"]) {
    test(`key login ${target}: final secret resolution crossing the total deadline cannot adopt`, { timeout: 10_000 }, async () => {
      const { stdout } = await promisify(execFile)(process.execPath,
        [fileURLToPath(import.meta.url), "--deadline-fixture", target],
        { env: {}, timeout: 8000, maxBuffer: 64 * 1024 });
      const observation = JSON.parse(stdout);
      assert.equal(observation.resolves, 2);
      assert.equal(observation.elapsedMs, 80);
      assert.equal(observation.transportClosed, true);
      assert.equal(observation.cwdRemoved, true);
      assert.equal(observation.externalAborted, false, "this is the total deadline, not caller cancellation");
      assert.equal(observation.oldHome, "old-fixture-account");
      assert.equal(observation.errorCode, "engine_login_timed_out", JSON.stringify(observation));
      assert.equal(observation.adopted, false);
      assert.equal(observation.newHomeExists, false);
      assert.equal(observation.newHomeRemovals, 1);
    });
  }
}

async function runFixture(target) {
  assert.ok(["src", "dist"].includes(target));
  const extension = target === "src" ? "ts" : "js";
  const base = new URL(`../${target}/features/execution-engines/`, import.meta.url);
  const nativeUrl = new URL(`native-login.${extension}`, base).href;
  const dependencies = new Map(["codex-connection", "native-secrets", "claude-environment", "windows-supervisor", "kimi-auth-state", "native-auth-file", "kimi-native-executable", "kimi-terminal-login"]
    .map(name => [`./${name}.js`, new URL(`${name}.${extension}`, base).href]));
  const sourceUrls = new Set([nativeUrl, ...dependencies.values()]);
  const cwd = resolve("key-deadline-fixture", "cwd");
  const home = resolve("key-deadline-fixture", "new-home");
  const oldHome = resolve("key-deadline-fixture", "old-home");
  const directories = new Map([[oldHome, "old-fixture-account"]]);
  const controller = new AbortController();
  const observation = { resolves: 0, elapsedMs: 0, transportClosed: false, cwdRemoved: false,
    adopted: false, newHomeRemovals: 0 };
  globalThis.__lingKeyDeadline = {
    realpath: async (path) => path,
    mkdtemp: async () => { directories.set(cwd, "fixture-cwd"); return cwd; },
    rm: async (path) => {
      assert.notEqual(path, oldHome, "existing account must never enter attempted-generation cleanup");
      assert.ok(path === cwd || path === home);
      if (path === cwd) observation.cwdRemoved = true;
      if (path === home) observation.newHomeRemovals++;
      directories.delete(path);
    },
    prepareHome: async () => { directories.set(home, "new-fixture-account"); return home; },
    capture: async (_file, _cwd, codexHome, signal, _spawn, operation) => {
      try { return await operation({ codexHome, signal }); }
      finally { observation.transportClosed = true; }
    },
  };
  const mocks = {
    "node:fs/promises": "export const {realpath,mkdtemp,rm} = globalThis.__lingKeyDeadline;",
    "./native-auth-home.js": "export const prepareNativeAuthHome = globalThis.__lingKeyDeadline.prepareHome;",
    "./installation-probe.js": "export const probeEngineInstallation = async () => ({status:'installed',executableDigest:'fixture'});",
    "./connection-probe.js": "export const executableDigest = async () => 'fixture'; export const captureCodexAccountOperation = globalThis.__lingKeyDeadline.capture; "
      + "export const captureKimiAccountOperation = () => { throw new Error('unexpected-kimi-operation'); };",
    "./codex-login.js": "export const loginCodexAccount = async options => { options.onStarted?.(); return {authentication:'configured_unverified'}; };",
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === dependencies.get("./kimi-terminal-login.js") && specifier === "./installation-probe.js") {
        return { url: new URL("../dist/features/execution-engines/installation-probe.js", import.meta.url).href, shortCircuit: true };
      }
      if (sourceUrls.has(context.parentURL) && dependencies.has(specifier)) return { url: dependencies.get(specifier), shortCircuit: true };
      if (context.parentURL === nativeUrl) {
        if (Object.hasOwn(mocks, specifier)) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (target === "src" && sourceUrls.has(url)) return { format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true };
      return next(url, context);
    },
  });
  try {
    const { runEngineLogin } = await import(nativeUrl);
    // Advancing only the monotonic clock models a synchronous read that blocks timer callbacks.
    mock.method(performance, "now", () => 1000 + observation.elapsedMs);
    const profile = { id: "fixture", revision: 1, status: "configured", configuration: {
      engineId: "codex-app-server", executablePath: resolve("key-deadline-fixture", "codex"),
      authProfileId: "old-home", secretRef: "env:KEY_DEADLINE_FIXTURE",
    } };
    try {
      await runEngineLogin(profile, {}, { method: "apiKey", platform: "darwin", signal: controller.signal,
        timeoutMs: 30, startupTimeoutMs: 1000,
        secretResolver: {
          status: (ref) => ({ ref, kind: "env", configured: true }),
          resolve: (ref) => {
            observation.resolves++;
            if (observation.resolves === 2) {
              assert.equal(observation.transportClosed, true);
              assert.equal(observation.cwdRemoved, true);
              observation.elapsedMs = 80;
            }
            return { ref, configured: true, value: "private-deadline-fixture-key" };
          },
        },
        onChallenge: () => assert.fail("API-key setup must not issue a challenge"),
        adopt: (configuration) => { observation.adopted = true; return { ...profile, configuration, revision: 2 }; },
        spawn: () => { throw new Error("real-process-forbidden"); },
      });
    } catch (error) { observation.errorCode = error.code ?? error.message; }
    return { ...observation, externalAborted: controller.signal.aborted,
      oldHome: directories.get(oldHome), newHomeExists: directories.has(home) };
  } finally {
    controller.abort();
    mock.restoreAll();
    hooks.deregister();
    delete globalThis.__lingKeyDeadline;
  }
}
