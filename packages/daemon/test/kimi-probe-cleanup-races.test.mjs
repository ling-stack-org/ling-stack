import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import * as filesystem from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";
import { buildNativeProcessEnvironment, killOwnedProbe } from "../dist/features/execution-engines/installation-probe.js";

const scenarios = [
  ["cancel", "cancelled"], ["deadline", "timed_out"], ["source", "auth_required"],
  ["profile", "probe_failed"], ["cleanup-error", "probe_failed"],
  ["unreaped", "probe_failed"],
];

if (process.argv[2] === "--cleanup-worker") {
  process.stdout.write(JSON.stringify(await runFixture(process.argv[3])));
} else {
  for (const [scenario, status] of scenarios) {
    test(`Kimi ${scenario} during final auth cleanup cannot publish a stale connection`,
      { skip: process.platform !== "darwin", timeout: 15_000 }, async () => {
        const { stdout } = await promisify(execFile)(process.execPath,
          [fileURLToPath(import.meta.url), "--cleanup-worker", scenario], { timeout: 12_000, maxBuffer: 64 * 1024 });
        const observation = JSON.parse(stdout);
        assert.equal(observation.injected, true, "the final awaited auth cleanup must have been reached");
        assert.equal(observation.closed, true);
        assert.equal(observation.removed, true);
        assert.equal(observation.rejected, false, "cleanup errors belong to the diagnostic response");
        assert.equal(observation.result.status, status);
        assert.equal(observation.result.connection, "not_checked");
        if (scenario === "unreaped") assert.equal(observation.retainedWhileRunning, true,
          "directory cleanup must not race a still-running native writer");
        if (scenario === "source") assert.equal(observation.result.errorCode, "engine_native_auth_invalid");
      });
  }
}

async function runFixture(scenario) {
  assert.ok(scenarios.some(([value]) => value === scenario));
  const root = await filesystem.realpath(await filesystem.mkdtemp(join(tmpdir(), "ling-kimi-cleanup-race-")));
  const paths = resolveUserConfigPaths({ userRootDir: join(root, "host") });
  const store = new ExecutionEngineProfileStore(paths);
  const executable = join(root, "kimi");
  await filesystem.writeFile(executable, Buffer.concat([Buffer.from("cffaedfe", "hex"),
    Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1")]), { mode: 0o700 });
  const profile = store.save({ engineId: "kimi-acp", executablePath: executable, authProfileId: "fixture", kimiLoginRegion: "global" }, 0);
  const { prepareNativeAuthHome } = await import("../dist/features/execution-engines/native-auth-home.js");
  const home = await prepareNativeAuthHome(paths, profile.configuration);
  const configPath = join(home, "config.toml");
  await filesystem.writeFile(configPath, "# synthetic configuration\n", { mode: 0o600 });
  const controller = new AbortController(), children = [], operationRoots = [];
  const exists = path => filesystem.lstat(path).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  const allRemoved = async () => {
    if (!authRoot) return false;
    for (const path of [authRoot, ...operationRoots]) if (await exists(path)) return false;
    return true;
  };
  let injected = false, authRoot, result, retainedWhileRunning, released = false, rejected = false;
  globalThis.__kimiProbeProcess = { buildNativeProcessEnvironment, killOwnedProbe: child => {
    if (scenario === "unreaped" && !released) { injected = true; return; }
    killOwnedProbe(child);
  } };
  // Place the race after real filesystem removal, before that asynchronous operation returns.
  globalThis.__kimiCleanupRace = async (method, path, options) => {
    await filesystem[method](path, options);
    if (injected || !basename(String(path)).startsWith("ling-kimi-probe-auth-")) return;
    injected = true;
    assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
    if (scenario === "cancel") controller.abort();
    if (scenario === "deadline") await delay(2600);
    if (scenario === "source") await filesystem.writeFile(configPath, "# changed by independent host writer\n");
    if (scenario === "profile") store.disconnect("kimi-acp", profile.revision);
    if (scenario === "cleanup-error") throw new Error("synthetic-cleanup-failure");
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (scenario === "unreaped" && specifier === "./installation-probe.js" && context.parentURL?.endsWith("/owned-native-process.js")) {
        return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(
          "export const { buildNativeProcessEnvironment, killOwnedProbe } = globalThis.__kimiProbeProcess;")}` };
      }
      if (specifier === "node:fs/promises" && context.parentURL?.endsWith("/kimi-probe-isolation.js")) {
        return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(
          'export * from "node:fs/promises"; export const rm = (...args) => globalThis.__kimiCleanupRace("rm", ...args);'
          + ' export const rmdir = (...args) => globalThis.__kimiCleanupRace("rmdir", ...args);')}` };
      }
      return next(specifier, context);
    },
  });
  try {
    const { probeEngineConnection } = await import("../dist/features/execution-engines/connection-probe.js");
    try {
      result = await probeEngineConnection(profile, paths, { store, signal: controller.signal, timeoutMs: 2500,
        spawn(file, args, settings) {
          operationRoots.push(settings.cwd);
          const native = file === "/usr/bin/sandbox-exec";
          if (native) authRoot = settings.env.KIMI_CODE_HOME;
          const program = native ? `
            require('node:readline').createInterface({input: process.stdin}).on('line', line => {
              const request = JSON.parse(line);
              const result = request.method === 'initialize' ? {protocolVersion:1, agentInfo:{name:'Kimi Code CLI',version:'0.1.0-alpha.4'},
                agentCapabilities:{},authMethods:[{id:'login',type:'terminal',name:'Login',args:['--login']}]} : {};
              console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
            }); setInterval(() => {},1000);
          ` : 'console.log("0.1.0-alpha.4")';
          const child = spawn(process.execPath, ["-e", program], settings);
          children.push(child);
          return child;
        },
      });
    } catch { rejected = true; }
    if (scenario === "unreaped") {
      retainedWhileRunning = children.some(child => child.exitCode === null && child.signalCode === null)
        && await exists(authRoot) && await exists(operationRoots.at(-1));
      released = true;
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close"); killOwnedProbe(child); await closed;
      }
      for (let i = 0; i < 100 && !(await allRemoved()); i++) await delay(10);
    }
    const removed = await allRemoved();
    return { result, injected, rejected, removed, retainedWhileRunning, closed: children.every(child => child.exitCode !== null || child.signalCode !== null) };
  } finally {
    hooks.deregister();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (authRoot) await filesystem.rm(authRoot, { recursive: true, force: true });
    for (const path of operationRoots) await filesystem.rm(path, { recursive: true, force: true });
    store.close();
    await filesystem.rm(root, { recursive: true, force: true });
  }
}
