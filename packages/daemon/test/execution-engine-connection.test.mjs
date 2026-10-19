import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { resolveUserConfigPaths } from "@ling-stack/core";
import { probeEngineConnection } from "../dist/features/execution-engines/connection-probe.js";
import { prepareNativeAuthHome } from "../dist/features/execution-engines/native-auth-home.js";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-engine-connection-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveUserConfigPaths({ userRootDir: root });
  const profile = { schemaVersion: 1, id: "fixture-profile", revision: 1, status: "configured",
    configuration: { engineId: "codex-app-server", executablePath: process.execPath, authProfileId: "fixture" },
    configurationFingerprint: "f".repeat(64), updatedAt: new Date().toISOString() };
  return { root, paths, profile };
}

function nativePeer(onLaunch, account = null) {
  return (file, args, options) => {
    assert.equal(file, realpathSync(process.execPath));
    assert.equal(options.shell, false);
    if (args[0] === "--version") return spawn(file, ["-e", 'console.log("codex-cli 0.114.0")'], options);
    assert.deepEqual(args, ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"',
      "-c", "check_for_update_on_startup=false"]);
    onLaunch?.(options);
    return spawn(file, ["-e", `
      const readline = require('node:readline');
      const methods = [];
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line); methods.push(message.method);
        if ('jsonrpc' in message) process.exit(71);
        if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {
          userAgent: 'private-native-identity', codexHome: process.env.CODEX_HOME,
          platformFamily: 'unix', platformOs: 'macos'
        } }));
        else if (message.method === 'account/read') {
          if (message.params.refreshToken !== false || methods.join(',') !== 'initialize,initialized,account/read') process.exit(72);
          console.log(JSON.stringify({ id: message.id, result: { account: ${JSON.stringify(account)}, requiresOpenaiAuth: true } }));
        } else if (message.method !== 'initialized') process.exit(73);
      });
      setInterval(() => {}, 1000);
    `], options);
  };
}

test("connection probe uses an isolated persistent native profile and completes only after child cleanup", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  let home, cwd, child;
  const launch = nativePeer((options) => {
    home = options.env.CODEX_HOME;
    cwd = options.cwd;
    assert.notEqual(options.env.HOME, home);
    assert.equal(options.env.HOME, cwd);
    assert.equal(home.startsWith(f.paths.stateDir + "/"), true);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.LING_STACK_HOME, undefined);
  }, { type: "chatgpt", email: "private@example.test", planType: "plus" });
  const result = await probeEngineConnection(f.profile, f.paths, { spawn: (file, args, options) => {
    const spawned = launch(file, args, options);
    if (args[0] === "app-server") child = spawned;
    return spawned;
  } });
  assert.equal(result.mode, "connection");
  assert.equal(result.status, "connected");
  assert.equal(result.connection, "connected");
  assert.equal(result.authentication, "configured_unverified");
  assert.equal(result.runtimeVersion, "0.114.0");
  assert.match(result.executableDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.profileRevision, 1);
  assert.ok(child.signalCode || child.exitCode !== null, "native child is reaped before success");
  assert.equal(existsSync(cwd), false);
  assert.equal(existsSync(home), true, "only the temporary cwd is removed");
  assert.equal(statSync(home).mode & 0o077, 0);
  for (const value of ["private@example.test", "private-native-identity", home]) assert.equal(JSON.stringify(result).includes(value), false);
  assert.equal("enabled" in result, false);
});

test("unsupported auth/platform and unresolved secrets do not start an installation or account process", async (t) => {
  const f = fixture(t);
  const noSpawn = () => { throw new Error("must not spawn"); };
  for (const [engineId, status] of [["claude-agent-sdk", "unsupported_auth"], ["openclaw-acp", "unsupported_auth"]]) {
    const result = await probeEngineConnection({ ...f.profile, configuration: { ...f.profile.configuration, engineId } }, f.paths, { spawn: noSpawn });
    assert.equal(result.status, status);
    assert.equal(result.authentication, "not_checked");
  }
  assert.equal((await probeEngineConnection(f.profile, f.paths, { spawn: noSpawn, platform: "win32" })).status, "unsupported_platform");
  assert.equal((await probeEngineConnection({ ...f.profile, configuration: { ...f.profile.configuration, secretRef: "env:OPENAI_API_KEY" } },
    f.paths, { spawn: noSpawn, platform: "darwin" })).status, "auth_required");
});

test("wrong installation identity never starts the native connection", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const result = await probeEngineConnection(f.profile, f.paths, { platform: "darwin", spawn: (file, args, options) => {
    calls++;
    assert.deepEqual(args, ["--version"]);
    return spawn(file, args, options);
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, "unexpected_runtime");
  assert.equal(result.connection, "not_checked");
});

test("connection timeout and cancellation reap the process; diagnostic stderr cannot leak", { skip: process.platform === "win32" }, async (t) => {
  for (const scenario of ["timed_out", "cancelled", "output_limit", "protocol_error"]) {
    const f = fixture(t);
    const abort = new AbortController();
    let child;
    const result = await probeEngineConnection(f.profile, f.paths, { timeoutMs: 1500, signal: abort.signal,
      spawn: (file, args, options) => {
        if (args[0] === "--version") return spawn(file, ["-e", 'console.log("codex-cli 0.114.0")'], options);
        const action = scenario === "output_limit" ? 'process.stderr.write("private-value".repeat(8000));'
          : scenario === "protocol_error" ? 'process.stdout.write("private-invalid-json\\n");' : "";
        child = spawn(file, ["-e", `${action} setInterval(() => {}, 1000);`], options);
        if (scenario === "cancelled") setImmediate(() => abort.abort());
        return child;
      } });
    assert.equal(result.status, scenario);
    assert.equal(result.authentication, "not_checked");
    assert.ok(child.signalCode || child.exitCode !== null);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("auth profile directories cannot redirect a probe to another native home", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  mkdirSync(f.paths.stateDir);
  symlinkSync(outside, join(f.paths.stateDir, "execution-engines"));
  let launched = false;
  const result = await probeEngineConnection(f.profile, f.paths, { spawn: nativePeer(() => { launched = true; }) });
  assert.equal(result.status, "probe_failed");
  assert.equal(launched, false);
});

test("an executable changed during a successful handshake cannot return accepted connection evidence", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const executable = join(f.root, "selected-native.cjs");
  writeFileSync(executable, `#!${process.execPath}\nconsole.log('codex-cli 0.114.0');\n`, { mode: 0o700 });
  const profile = { ...f.profile, configuration: { ...f.profile.configuration, executablePath: executable } };
  const peer = nativePeer(() => appendFileSync(executable, "// changed during native startup\n"));
  const result = await probeEngineConnection(profile, f.paths, { spawn: (_file, args, options) => peer(realpathSync(process.execPath), args, options) });
  assert.equal(result.status, "probe_failed");
  assert.equal(result.connection, "not_checked");
  assert.equal(result.authentication, "not_checked");
});

test("secret-backed connection checks compare the selected private key without logging in or exposing it", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const secretRef = "env:LING_CONNECTION_FIXTURE";
  const key = "sk-test-private-probe-fixture-key";
  const profile = { ...f.profile, configuration: { ...f.profile.configuration, secretRef } };
  const home = await prepareNativeAuthHome(f.paths, profile.configuration);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key }), { mode: 0o600 });
  let reads = 0;
  const result = await probeEngineConnection(profile, f.paths, {
    secretResolver: { resolve(ref, purpose) {
      reads++;
      assert.equal(ref, secretRef);
      assert.equal(purpose, "provider_api_key");
      return { ref, configured: true, value: key };
    } },
    spawn: nativePeer((options) => {
      assert.equal(options.env.CODEX_HOME, home);
      assert.equal(JSON.stringify(options).includes(key), false);
    }, { type: "apiKey" }),
  });
  assert.equal(result.status, "connected");
  assert.equal(result.authentication, "configured_unverified");
  assert.equal(result.errorCode, undefined);
  assert.equal(reads, 2, "check current reference before launch and after native cleanup");
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(result.profileRevision, 1);
});

for (const slowRead of [1, 2]) {
  test(`connection secret read ${slowRead} crossing the monotonic deadline cannot succeed`, { skip: process.platform === "win32" }, async (t) => {
    const f = fixture(t);
    const profile = { ...f.profile, configuration: { ...f.profile.configuration, secretRef: "env:PROBE_DEADLINE_FIXTURE" } };
    const home = await prepareNativeAuthHome(f.paths, profile.configuration);
    writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "private-fixture" }), { mode: 0o600 });
    let elapsed = 0, reads = 0, launches = 0;
    t.mock.method(performance, "now", () => 1000 + elapsed);
    const peer = nativePeer(undefined, { type: "apiKey" });
    const result = await probeEngineConnection(profile, f.paths, { timeoutMs: 5000,
      secretResolver: { resolve(ref) {
        if (++reads === slowRead) elapsed = 8000;
        return { ref, configured: true, value: "private-fixture" };
      } },
      spawn: (...args) => { launches++; return peer(...args); },
    });
    assert.equal(result.status, "timed_out");
    assert.equal(result.authentication, "not_checked");
    if (slowRead === 1) assert.equal(launches, 0);
  });
}

test("connection secret resolution failures are redacted and cannot launch even an installation check", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const profile = { ...f.profile, configuration: { ...f.profile.configuration, secretRef: "env:PROBE_MISSING_FIXTURE" } };
  for (const [resolve, errorCode] of [
    [() => ({ configured: false }), "engine_secret_missing"],
    ...["secret_access_denied", "secret_store_unavailable", "invalid_secret_ref"].map((errorCode) => [
      () => ({ configured: false, status: { errorCode, message: "private resolver message" } }), `engine_${errorCode}`,
    ]),
    [() => { throw new Error("private resolver exception"); }, "engine_secret_unavailable"],
    ...[" private-key", "private-key\n", "k".repeat(16 * 1024 + 1)].map((value) => [
      () => ({ configured: true, value }), "engine_secret_invalid",
    ]),
  ]) {
    let launches = 0;
    const result = await probeEngineConnection(profile, f.paths, { secretResolver: { resolve }, spawn: () => { launches++; throw new Error("forbidden"); } });
    assert.equal(result.status, "auth_required");
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.authentication, "required");
    assert.equal(result.connection, "not_checked");
    assert.equal(launches, 0);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("missing, mismatched or unsafe native auth files never launch an account probe", { skip: process.platform === "win32" }, async (t) => {
  for (const scenario of ["missing", "mismatch", "invalid-json", "invalid-utf8", "oversized", "directory", "symlink", "fifo", "wrong-mode"]) {
    const f = fixture(t);
    const key = "sk-test-private-file-fixture";
    const profile = { ...f.profile, configuration: { ...f.profile.configuration, secretRef: "env:PROBE_FILE_FIXTURE" } };
    const home = await prepareNativeAuthHome(f.paths, profile.configuration), path = join(home, "auth.json");
    const write = (value) => writeFileSync(path, value, { mode: 0o600 });
    if (scenario === "mismatch") write(JSON.stringify({ OPENAI_API_KEY: "old-private-fixture-key" }));
    if (scenario === "invalid-json") write("private broken JSON");
    if (scenario === "invalid-utf8") write(Buffer.from([0xff, 0xfe]));
    if (scenario === "oversized") write(JSON.stringify({ OPENAI_API_KEY: key, padding: " ".repeat(64 * 1024) }));
    if (scenario === "wrong-mode") write(JSON.stringify({ OPENAI_API_KEY: key, auth_mode: "chatgpt" }));
    if (scenario === "directory") mkdirSync(path);
    if (scenario === "fifo") execFileSync("mkfifo", [path]);
    if (scenario === "symlink") {
      const target = join(f.root, "unrelated-auth.json");
      writeFileSync(target, JSON.stringify({ OPENAI_API_KEY: key }));
      symlinkSync(target, path);
    }
    let launches = 0;
    const result = await probeEngineConnection(profile, f.paths, { timeoutMs: 3000,
      secretResolver: { resolve: (ref) => ({ ref, configured: true, value: key }) },
      spawn: nativePeer(() => { launches++; }, { type: "apiKey" }),
    });
    assert.equal(result.status, "auth_required", scenario);
    assert.equal(result.errorCode, scenario === "missing" ? "engine_native_auth_missing"
      : scenario === "mismatch" ? "engine_secret_changed" : "engine_native_auth_invalid", scenario);
    assert.equal(launches, 0, scenario);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("secret or native-file changes during a handshake cannot produce accepted credential evidence", { skip: process.platform === "win32" }, async (t) => {
  for (const scenario of ["rotate", "revoke", "file-change", "file-delete", "different-account"]) {
    const f = fixture(t);
    const key = "sk-test-private-rotation-fixture";
    let currentKey = key, child, cwd;
    const profile = { ...f.profile, configuration: { ...f.profile.configuration, secretRef: "env:PROBE_ROTATION_FIXTURE" } };
    const home = await prepareNativeAuthHome(f.paths, profile.configuration), path = join(home, "auth.json");
    const original = JSON.stringify({ OPENAI_API_KEY: key });
    writeFileSync(path, original, { mode: 0o600 });
    const peer = nativePeer((options) => {
      cwd = options.cwd;
      if (scenario === "rotate") currentKey = "sk-test-private-rotated-fixture";
      if (scenario === "revoke") currentKey = undefined;
      if (scenario === "file-change") writeFileSync(path, JSON.stringify({ OPENAI_API_KEY: "sk-test-private-changed-file" }));
      if (scenario === "file-delete") rmSync(path);
    }, scenario === "different-account" ? { type: "chatgpt", email: null, planType: "plus" } : { type: "apiKey" });
    const result = await probeEngineConnection(profile, f.paths, {
      secretResolver: { resolve: (ref) => ({ ref, configured: Boolean(currentKey), value: currentKey }) },
      spawn: (...args) => { const spawned = peer(...args); if (args[1][0] === "app-server") child = spawned; return spawned; },
    });
    assert.equal(result.status, "auth_required", scenario);
    assert.equal(result.errorCode, scenario === "revoke" ? "engine_secret_missing" : scenario === "file-delete" ? "engine_native_auth_missing"
      : scenario === "different-account" ? "engine_native_auth_mismatch" : "engine_secret_changed", scenario);
    assert.ok(child.signalCode || child.exitCode !== null);
    assert.equal(existsSync(cwd), false);
    assert.equal(existsSync(home), true);
    if (["rotate", "revoke", "different-account"].includes(scenario)) assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});
