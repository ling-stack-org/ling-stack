import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { probeEngineInstallation, parseNativeRuntimeVersion, buildNativeProcessEnvironment } from "../dist/features/execution-engines/installation-probe.js";

const profile = { schemaVersion: 1, id: "fixture-profile", revision: 1, status: "configured",
  configuration: { engineId: "codex-app-server", executablePath: process.execPath, authProfileId: "fixture" },
  configurationFingerprint: "x".repeat(64), updatedAt: "2026-09-08T00:00:00Z" };

test("native version parsing recognizes each target and never returns raw output", () => {
  for (const [engine, output, expected] of [
    ["codex-app-server", "codex-cli 0.114.0", "0.114.0"],
    ["claude-agent-sdk", "2.1.2 (Claude Code)", "2.1.2"],
    ["kimi-acp", "1.2.3\n", "1.2.3"],
    ["openclaw-acp", "OpenClaw 2026.9.7", "2026.9.7"],
  ]) {
    assert.equal(parseNativeRuntimeVersion(engine, output), expected);
    assert.equal(parseNativeRuntimeVersion(engine, "v22.22.3"), undefined);
    assert.equal(parseNativeRuntimeVersion(engine, "secret-fixture"), undefined);
  }
});

test("Kimi successor version output is bare semver, not the retired CLI banner", () => {
  assert.equal(parseNativeRuntimeVersion("kimi-acp", "0.1.0-alpha.4+native.1\r\n"), "0.1.0-alpha.4+native.1");
  for (const value of ["kimi, version 1.2.3", "Kimi Code 1.2.3", "v1.2.3", "1.2.3\nprivate-output", "01.2.3"]) {
    assert.equal(parseNativeRuntimeVersion("kimi-acp", value), undefined);
  }
});

test("native process environment does not inherit management tokens or injection hooks", () => {
  const env = buildNativeProcessEnvironment({ PATH: "/bin", HOME: "/users/current", NODE_OPTIONS: "--require bad",
    LING_DESKTOP_BRIDGE_TOKEN: "secret", LING_MOBILE_ACCESS_MANAGEMENT_CAPABILITY: "secret", ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret", BASH_ENV: "bad", ENV: "bad", PYTHONPATH: "bad", SystemRoot: "C:\\Windows" }, "/fixture/probe");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/fixture/probe");
  assert.equal(env.USERPROFILE, "/fixture/probe");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(Object.values(env).includes("secret"), false);
  for (const name of ["NODE_OPTIONS", "BASH_ENV", "ENV", "PYTHONPATH"]) assert.equal(name in env, false);
});

test("version probe uses a real owned process, isolated home, bounded output and no execution readiness grant", async () => {
  let cwd;
  const result = await probeEngineInstallation(profile, { spawn: (file, args, options) => {
    assert.equal(file, process.execPath);
    assert.deepEqual(args, ["--version"]);
    assert.equal(options.shell, false);
    assert.equal(options.env.HOME, options.cwd);
    cwd = options.cwd;
    return spawn(file, ["-e", 'process.stdout.write("codex-cli 0.114.0\\nsecret-fixture")'], options);
  } });
  assert.equal(result.status, "installed");
  assert.equal(result.runtimeVersion, "0.114.0");
  assert.match(result.executableDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.authentication, "not_checked");
  assert.equal(result.connection, "not_checked");
  assert.equal(JSON.stringify(result).includes("secret-fixture"), false);
  assert.equal("enabled" in result, false);
  assert.equal(existsSync(cwd), false);
});

test("wrong or missing executables never claim the selected engine is installed", async () => {
  assert.equal((await probeEngineInstallation(profile)).status, "unexpected_runtime");
  assert.equal((await probeEngineInstallation({ ...profile, configuration: { ...profile.configuration, executablePath: "/missing-ling-test-executable" } })).status, "not_found");
});

test("timeout, cancellation and excess output end owned probe processes", async () => {
  const waiting = (file, _args, options) => spawn(file, ["-e", "setInterval(() => {}, 1000)"], options);
  const timed = await probeEngineInstallation(profile, { timeoutMs: 100, spawn: waiting });
  assert.equal(timed.status, "timed_out");
  const abort = new AbortController();
  const pending = probeEngineInstallation(profile, { signal: abort.signal, spawn: (file, args, options) => {
    const child = waiting(file, args, options);
    setTimeout(() => abort.abort(), 10);
    return child;
  } });
  assert.equal((await pending).status, "cancelled");
  const excess = await probeEngineInstallation(profile, { spawn: (file, _args, options) =>
    spawn(file, ["-e", 'process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000)'], options) });
  assert.equal(excess.status, "output_limit");
});

test("even a successful version check cleans up its process group descendants", { skip: process.platform === "win32" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ling-version-tree-"));
  const marker = join(root, "child.pid");
  t.after(() => {
    if (existsSync(marker)) { try { process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL"); } catch {} }
    rmSync(root, { recursive: true, force: true });
  });
  const result = await probeEngineInstallation(profile, { spawn: (file, _args, options) => spawn(file, ["-e", `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(child.pid));
    child.unref();
    console.log('codex-cli 0.114.0');
  `], options) });
  assert.equal(result.status, "installed");
  const pid = Number(readFileSync(marker, "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
  for (let i = 0; i < 100 && alive(); i++) await delay(10);
  assert.equal(alive(), false, "successful probe must not leave a background descendant running");
});

test("supervisor transport errors await owned process close before releasing the probe", async (t) => {
  let child, closed = false;
  t.after(async () => {
    if (child && !closed) {
      const done = new Promise(resolve => child.once("close", resolve));
      child.kill("SIGKILL");
      await done;
    }
  });
  const result = await probeEngineInstallation(profile, { spawn: (file, _args, options) => {
    child = spawn(file, ["-e", "setInterval(() => {}, 1000)"], options);
    child.once("close", () => { closed = true; });
    child.once("spawn", () => child.emit("error", new Error("engine_supervisor_protocol_error")));
    return child;
  } });
  assert.equal(result.status, "probe_failed");
  assert.equal(closed, true, "a transport failure is not proof the retained process has stopped");
});
