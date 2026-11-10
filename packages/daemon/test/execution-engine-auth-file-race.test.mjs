import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scenarios = [
  ["unchanged", "connected", undefined],
  ["before-final-open", "auth_required", "engine_secret_changed"],
  ["after-final-open", "auth_required", "engine_native_auth_invalid"],
];

if (process.argv[2] === "--auth-file-fixture") {
  process.stdout.write(JSON.stringify(await runFixture(process.argv[3], process.argv[4])));
} else {
  for (const target of ["src", "dist"]) {
    for (const [scenario, status, errorCode] of scenarios) {
      test(`auth file ${target}: ${scenario}`, { timeout: 10_000, skip: process.platform === "win32" }, async () => {
        const { stdout } = await promisify(execFile)(process.execPath,
          [fileURLToPath(import.meta.url), "--auth-file-fixture", target, scenario],
          { env: {}, timeout: 8000, maxBuffer: 64 * 1024 });
        const observation = JSON.parse(stdout);
        const replaced = scenario !== "unchanged";
        assert.equal(observation.replaced, replaced);
        assert.equal(observation.currentKeyMatches, !replaced);
        assert.equal(observation.currentInodeChanged, replaced);
        assert.equal(observation.replacementConsumed, replaced);
        assert.equal(observation.replacedAfterOpenBeforeStat, scenario === "after-final-open");
        assert.equal(observation.opens, 2, "the race occurs in the final auth-file check");
        assert.equal(observation.handlesClosed, 2);
        assert.equal(observation.childClosed, true);
        assert.equal(observation.killCalls, 1);
        assert.equal(observation.streamsDestroyed, true);
        assert.equal(observation.cwdRemoved, true);
        assert.equal(observation.authHomePreserved, true);
        assert.equal(observation.unrelatedPreserved, true);
        assert.deepEqual(observation.methods, ["initialize", "initialized", "account/read"]);
        assert.equal(observation.result.status, status, JSON.stringify(observation));
        assert.equal(observation.result.errorCode, errorCode);
        assert.equal(observation.result.authentication, replaced ? "required" : "configured_unverified");
        assert.equal(observation.result.connection, replaced ? "not_checked" : "connected");
        assert.equal(JSON.stringify(observation.result).includes("private-fixture"), false);
      });
    }
  }
}

async function runFixture(target, scenario) {
  assert.ok(["src", "dist"].includes(target));
  assert.ok(scenarios.some(([candidate]) => candidate === scenario));
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "ling-auth-file-race-")));
  const extension = target === "src" ? "ts" : "js";
  const base = new URL(`../${target}/features/execution-engines/`, import.meta.url);
  const modules = new Map(["connection-probe", "owned-native-process", "codex-connection", "codex-auth-state", "native-secrets", "native-auth-home",
    "kimi-connection", "kimi-probe-isolation", "acp-connection", "openclaw-environment", "claude-environment", "windows-supervisor", "acp-probe-transport", "kimi-native-executable", "kimi-auth-state", "native-auth-file"]
    .map((name) => [`./${name}.js`, new URL(`${name}.${extension}`, base).href]));
  const connectionUrl = modules.get("./connection-probe.js");
  const authUrl = modules.get("./native-auth-file.js");
  const sourceUrls = new Set(modules.values());
  const key = "private-fixture-selected-key";
  const otherKey = "private-fixture-replaced-key";
  const executable = join(root, "fixture-executable");
  const executableBytes = Buffer.from("non-executable-fixture-payload");
  const digest = createHash("sha256").update(executableBytes).digest("hex");
  const methods = [], handles = [];
  const controller = new AbortController();
  let home, authPath, replacementPath, cwd, child;
  let opens = 0, replaced = false, replacedAfterOpenBeforeStat = false, childClosed = false, killCalls = 0;
  const closed = Promise.withResolvers();
  const replace = async () => {
    assert.equal(childClosed, true, "inject only after the account process has closed");
    assert.equal(await exists(cwd), false, "inject only after the temporary cwd is removed");
    await fs.rename(replacementPath, authPath);
    replaced = true;
  };
  globalThis.__lingAuthFileRace = {
    mkdtemp: async () => { cwd = await fs.mkdtemp(join(root, "cwd-")); return cwd; },
    open: async (path, flags) => {
      assert.equal(path, authPath);
      const index = ++opens;
      if (index === 2 && scenario === "before-final-open") await replace();
      const file = await fs.open(path, flags);
      const entry = { file, closed: false, stats: 0 };
      handles.push(entry);
      if (index === 2 && scenario === "after-final-open") {
        assert.equal(entry.stats, 0);
        await replace();
      }
      // Preserve the real FileHandle and filesystem metadata, while observing reader cleanup and ordering.
      return new Proxy(file, { get(target, property) {
        if (property === "stat") return (...args) => {
          if (index === 2 && entry.stats === 0 && scenario === "after-final-open") {
            replacedAfterOpenBeforeStat = replaced;
          }
          entry.stats++;
          return target.stat(...args);
        };
        if (property === "close") return async () => { await target.close(); entry.closed = true; };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
  };
  const connectionFs = 'export * from "node:fs/promises"; export const mkdtemp = globalThis.__lingAuthFileRace.mkdtemp;';
  const readerFs = 'export * from "node:fs/promises"; export const open = globalThis.__lingAuthFileRace.open;';
  const installation = `export const probeEngineInstallation = async () => ({status:"installed",executableDigest:"${digest}"});
    export const buildNativeProcessEnvironment = () => ({}); export const killOwnedProbe = child => child.kill();`;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (sourceUrls.has(context.parentURL) && modules.has(specifier)) return { url: modules.get(specifier), shortCircuit: true };
      let source;
      if (context.parentURL === connectionUrl && specifier === "node:fs/promises") source = connectionFs;
      if ([connectionUrl, modules.get("./owned-native-process.js")].includes(context.parentURL)
        && specifier === "./installation-probe.js") source = installation;
      if (context.parentURL === authUrl && specifier === "node:fs/promises") source = readerFs;
      if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (target === "src" && sourceUrls.has(url)) return { format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true };
      return next(url, context);
    },
  });
  try {
    const { prepareNativeAuthHome } = await import(modules.get("./native-auth-home.js"));
    const { probeEngineConnection } = await import(connectionUrl);
    const paths = { rootDir: root };
    const profile = { id: "fixture", revision: 1, status: "configured", configurationFingerprint: "f".repeat(64),
      configuration: { engineId: "codex-app-server", executablePath: executable, authProfileId: "fixture", secretRef: "env:AUTH_FILE_RACE_FIXTURE" } };
    home = await prepareNativeAuthHome(paths, profile.configuration);
    authPath = join(home, "auth.json");
    replacementPath = join(home, "replacement.json");
    await fs.writeFile(executable, executableBytes);
    await fs.writeFile(authPath, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key }), { mode: 0o600 });
    await fs.writeFile(replacementPath, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: otherKey }), { mode: 0o600 });
    const unrelated = join(root, "unrelated-fixture-state");
    await fs.writeFile(unrelated, "preserve-unrelated-state");
    const originalStat = await fs.lstat(authPath);
    const result = await probeEngineConnection(profile, paths, { platform: "darwin", signal: controller.signal,
      secretResolver: { resolve: (ref) => ({ ref, configured: true, value: key }) },
      spawn: (file, args, options) => {
        assert.equal(file, executable);
        assert.equal(args[0], "app-server");
        assert.equal(options.env.CODEX_HOME, home);
        assert.equal(options.cwd, cwd);
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({ write(chunk, _encoding, done) {
          const request = JSON.parse(chunk.toString());
          methods.push(request.method);
          done();
          setImmediate(() => {
            if (childClosed) return;
            if (request.method === "initialize") child.stdout.write(JSON.stringify({ id: request.id, result: {
              userAgent: "private-fixture-agent", codexHome: home, platformFamily: "unix", platformOs: "macos",
            } }) + "\n");
            if (request.method === "account/read") {
              assert.deepEqual(request.params, { refreshToken: false });
              child.stdout.write(JSON.stringify({ id: request.id, result: { requiresOpenaiAuth: true, account: { type: "apiKey" } } }) + "\n");
            }
          });
        } });
        child.kill = () => {
          if (killCalls++) return true;
          setImmediate(() => {
            childClosed = true;
            child.emit("close", null, "SIGKILL");
            child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
            closed.resolve();
          });
          return true;
        };
        return child;
      },
    });
    const currentStat = await fs.lstat(authPath);
    const currentAuth = JSON.parse(await fs.readFile(authPath, "utf8"));
    return { result, replaced, replacedAfterOpenBeforeStat, opens,
      currentKeyMatches: currentAuth.OPENAI_API_KEY === key,
      currentInodeChanged: currentStat.dev !== originalStat.dev || currentStat.ino !== originalStat.ino,
      replacementConsumed: !await exists(replacementPath),
      handlesClosed: handles.filter((entry) => entry.closed && entry.file.fd === -1).length,
      childClosed, killCalls, streamsDestroyed: Boolean(child?.stdin.destroyed && child?.stdout.destroyed && child?.stderr.destroyed),
      cwdRemoved: !await exists(cwd), authHomePreserved: await exists(home),
      unrelatedPreserved: await fs.readFile(unrelated, "utf8") === "preserve-unrelated-state", methods };
  } finally {
    controller.abort();
    if (child && !childClosed) { child.kill(); await closed.promise; }
    for (const entry of handles) if (!entry.closed) await entry.file.close();
    hooks.deregister();
    delete globalThis.__lingAuthFileRace;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function exists(path) {
  if (!path) return false;
  try { await fs.lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
