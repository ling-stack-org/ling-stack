import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scenarios = [
  ["stderr overflow during cleanup", "late-stderr-cap", "output_limit"],
  ["stderr error during cleanup", "late-stream-error", "probe_failed"],
  ["abort during the final executable stat", "abort-final-stat", "cancelled"],
  ["abort during temporary-directory removal", "abort-final-rm", "cancelled"],
];

if (process.argv[2] === "--race-fixture") {
  const observation = await runFixture(process.argv[3], process.argv[4]);
  process.stdout.write(JSON.stringify(observation));
} else {
  for (const target of ["src", "dist"]) {
    for (const [name, scenario, expectedStatus] of scenarios) {
      test(`Codex connection ${target}: ${name} cannot publish success`, { timeout: 10_000 }, async () => {
        // A fresh Node worker isolates the module cache, hooks and fixture globals from every other test.
        const { stdout } = await promisify(execFile)(process.execPath,
          [fileURLToPath(import.meta.url), "--race-fixture", target, scenario],
          { env: {}, timeout: 8000, maxBuffer: 64 * 1024 });
        const observation = JSON.parse(stdout);
        assert.equal(observation.injected, true, "the intended race must have occurred");
        assert.equal(observation.childClosed, true, "the probe must await its owned child's close");
        assert.equal(observation.removed, true, "temporary cwd cleanup must finish");
        assert.equal(observation.signalAborted, scenario.startsWith("abort-"));
        assert.deepEqual(observation.methods, ["initialize", "initialized", "account/read"]);
        assert.equal(JSON.stringify(observation.result).includes("private-fixture"), false);
        assert.equal(observation.result.status, expectedStatus);
        assert.equal(observation.result.connection, "not_checked");
        assert.equal(observation.result.authentication, "not_checked");
      });
    }
  }
}

async function runFixture(target, scenario) {
  assert.ok(["src", "dist"].includes(target));
  assert.ok(scenarios.some(([, candidate]) => candidate === scenario));
  const extension = target === "src" ? "ts" : "js";
  const base = new URL(`../${target}/features/execution-engines/`, import.meta.url);
  const connectionUrl = new URL(`connection-probe.${extension}`, base).href;
  const dependencies = new Map(["owned-native-process", "codex-connection", "native-secrets", "codex-auth-state", "kimi-connection",
    "acp-connection", "openclaw-environment", "claude-environment", "windows-supervisor", "acp-probe-transport", "kimi-native-executable", "kimi-auth-state", "native-auth-file", "kimi-probe-isolation"].map((name) => [`./${name}.js`, new URL(`${name}.${extension}`, base).href]));
  const sourceUrls = new Set([connectionUrl, ...dependencies.values()]);
  const controller = new AbortController();
  const payload = Buffer.from("fixture-executable");
  const digest = createHash("sha256").update(payload).digest("hex");
  const methods = [];
  let injected = false;
  let childClosed = false;
  let finalDigestRead = false;
  let removed = false;
  let child;

  globalThis.__lingConnectionRace = {
    createReadStream: () => Readable.from((async function* () {
      yield payload;
      if (childClosed) finalDigestRead = true;
    })()),
    realpath: async (path) => path,
    mkdtemp: async () => "/fixture/cwd",
    rm: async () => {
      if (scenario === "abort-final-rm") {
        injected = true;
        controller.abort();
      }
      removed = true;
    },
    stat: async () => {
      // The read stream has ended, so aborting here cannot be caught by its signal handler.
      if (finalDigestRead && scenario === "abort-final-stat") {
        injected = true;
        controller.abort();
      }
      return { isFile: () => true, size: payload.length, dev: 1, ino: 1, mtimeMs: 1 };
    },
    installation: async () => ({ status: "installed", runtimeVersion: "0.114.0", executableDigest: digest }),
  };
  const mocks = {
    "node:fs": "export const createReadStream = globalThis.__lingConnectionRace.createReadStream;",
    "node:fs/promises": "export const { mkdtemp, realpath, rm, stat } = globalThis.__lingConnectionRace;",
    "./native-auth-home.js": 'export const prepareNativeAuthHome = async () => "/fixture/auth";',
    "./installation-probe.js": "export const probeEngineInstallation = globalThis.__lingConnectionRace.installation; "
      + "export const buildNativeProcessEnvironment = () => ({}); export const killOwnedProbe = child => child.kill();",
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (sourceUrls.has(context.parentURL) && dependencies.has(specifier)) {
        return { url: dependencies.get(specifier), shortCircuit: true };
      }
      if (context.parentURL === connectionUrl
        || (context.parentURL === dependencies.get("./owned-native-process.js") && specifier === "./installation-probe.js")) {
        if (Object.hasOwn(mocks, specifier)) {
          return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (target === "src" && sourceUrls.has(url)) {
        return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true };
      }
      return next(url, context);
    },
  });
  try {
    const { probeEngineConnection } = await import(connectionUrl);
    const profile = { schemaVersion: 1, id: "fixture", revision: 1, status: "configured", configurationFingerprint: "f".repeat(64),
      updatedAt: "2026-09-08T00:00:00Z", configuration: {
        engineId: "codex-app-server", executablePath: "/fixture/codex", authProfileId: "fixture",
      } };
    const result = await probeEngineConnection(profile, {}, {
      signal: controller.signal, platform: "darwin", spawn: () => {
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({ write(chunk, _encoding, done) {
          const request = JSON.parse(chunk.toString());
          methods.push(request.method);
          done();
          setImmediate(() => {
            if (request.method === "initialize") child.stdout.write(JSON.stringify({ id: 1, result: {
              userAgent: "private-fixture", codexHome: "/fixture/auth", platformFamily: "unix", platformOs: "macos",
            } }) + "\n");
            if (request.method === "account/read") child.stdout.write(JSON.stringify({ id: 2, result: {
              account: null, requiresOpenaiAuth: true,
            } }) + "\n");
          });
        } });
        let stopping = false;
        child.kill = () => {
          if (stopping) return true;
          stopping = true;
          setImmediate(() => {
            if (scenario === "late-stderr-cap") {
              injected = true;
              child.stderr.write(Buffer.alloc(65537));
            }
            if (scenario === "late-stream-error") {
              injected = true;
              child.stderr.emit("error", new Error("private-fixture"));
            }
            childClosed = true;
            child.emit("close", null, "SIGKILL");
          });
          return true;
        };
        return child;
      },
    });
    return { result, injected, childClosed, removed, methods, signalAborted: controller.signal.aborted };
  } finally {
    hooks.deregister();
    delete globalThis.__lingConnectionRace;
    controller.abort();
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
  }
}
