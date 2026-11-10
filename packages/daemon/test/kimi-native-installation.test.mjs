import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { probeEngineInstallation } from "../dist/features/execution-engines/installation-probe.js";
import { probeEngineConnection } from "../dist/features/execution-engines/connection-probe.js";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-kimi-native-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "kimi");
  // Surrogate native bytes only. The launch fixture runs Node, not an installed Kimi/account.
  const bytes = Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1")]);
  writeFileSync(executable, bytes, { mode: 0o700 });
  mkdirSync(join(root, ".staging"));
  writeFileSync(join(root, ".staging", "staged.json"), "unchanged-staging");
  writeFileSync(join(root, "kimi.bak"), "unchanged-backup");
  const profile = { schemaVersion: 1, id: "kimi-fixture", revision: 1, status: "configured",
    configuration: { engineId: "kimi-acp", executablePath: executable, authProfileId: "fixture" },
    configurationFingerprint: "f".repeat(64), updatedAt: new Date().toISOString() };
  return { root, executable, bytes, profile };
}

test("Kimi version check executes a private independent copy, leaving installation staging and backup intact", async (t) => {
  const f = fixture(t);
  let copy, operationRoot;
  const result = await probeEngineInstallation(f.profile, { spawn: (file, args, options) => {
    copy = file;
    operationRoot = options.cwd;
    assert.notEqual(file, f.executable);
    assert.equal(file.startsWith(operationRoot + "/"), true);
    assert.deepEqual(readFileSync(file), f.bytes);
    assert.notEqual(statSync(file).ino, statSync(f.executable).ino);
    assert.equal(existsSync(join(dirname(file), ".staging")), false);
    assert.equal(existsSync(join(dirname(file), "kimi.bak")), false);
    assert.equal(options.env.HOME, operationRoot);
    assert.equal(options.env.KIMI_CODE_HOME.startsWith(operationRoot + "/"), true);
    assert.equal(options.env.KIMI_CODE_CACHE_DIR.startsWith(operationRoot + "/"), true);
    assert.equal(options.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
    assert.equal(options.env.KIMI_DISABLE_TELEMETRY, "1");
    assert.equal(options.env.KIMI_API_KEY, undefined);
    assert.deepEqual(args, ["--version"]);
    return spawn(process.execPath, ["-e", 'process.stdout.write("0.1.0-alpha.4\\n")'], options);
  } });
  assert.equal(result.status, "installed");
  assert.equal(result.runtimeVersion, "0.1.0-alpha.4");
  assert.equal(result.executableDigest, createHash("sha256").update(f.bytes).digest("hex"));
  assert.equal(existsSync(copy), false);
  assert.equal(existsSync(operationRoot), false);
  assert.deepEqual(readFileSync(f.executable), f.bytes);
  assert.equal(readFileSync(join(f.root, ".staging", "staged.json"), "utf8"), "unchanged-staging");
  assert.equal(readFileSync(join(f.root, "kimi.bak"), "utf8"), "unchanged-backup");
  assert.equal(result.authentication, "not_checked");
  assert.equal(result.connection, "not_checked");
});

test("Kimi connection uses an isolated snapshot and verified native copy, reaping the peer before success", { skip: process.platform !== "darwin" }, async (t) => {
  const f = fixture(t);
  const paths = resolveUserConfigPaths({ userRootDir: join(f.root, "ling-state") });
  const store = new ExecutionEngineProfileStore(paths);
  t.after(() => store.close());
  const profile = store.save(f.profile.configuration, 0);
  let child, home;
  const diagnostics = [];
  const operations = [];
  const result = await probeEngineConnection(profile, paths, { store, spawn: (file, args, options) => {
    const wrapped = file === "/usr/bin/sandbox-exec";
    const nativeFile = wrapped ? args[2] : file;
    const nativeArgs = wrapped ? args.slice(3) : args;
    assert.notEqual(nativeFile, f.executable);
    assert.deepEqual(readFileSync(nativeFile), f.bytes);
    assert.equal(options.shell, false);
    operations.push(options.cwd);
    if (nativeArgs[0] === "--version") return spawn(process.execPath, ["-e", 'console.log("0.1.0-alpha.4")'], options);
    assert.equal(wrapped, true);
    assert.deepEqual(nativeArgs, ["acp"]);
    home = options.env.KIMI_CODE_HOME;
    assert.equal(home.startsWith(paths.stateDir + "/"), false);
    assert.equal(options.env.KIMI_CODE_CACHE_DIR.startsWith(options.cwd + "/"), true);
    assert.equal(options.env.KIMI_DISABLE_TELEMETRY, "1");
    child = spawn(process.execPath, ["-e", `
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.method !== 'initialize' && request.method !== 'authenticate') process.exit(71);
        const result = request.method === 'initialize' ? {
          protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI', version: '0.1.0-alpha.4' },
          agentCapabilities: {}, authMethods: [{ id: 'login', type: 'terminal', name: 'Login', args: ['--login'] }]
        } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      });
      setInterval(() => {}, 1000);
    `], options);
    child.stderr.on("data", chunk => diagnostics.push(chunk.toString()));
    child.stdout.on("data", chunk => diagnostics.push({ wire: chunk.toString() }));
    child.stdout.on("error", error => diagnostics.push({ outputError: error.code }));
    child.stdin.on("error", error => diagnostics.push({ inputError: error.code }));
    return child;
  } });
  assert.equal(result.status, "connected", JSON.stringify({ result, operations: operations.length, launched: !!child, diagnostics }));
  assert.equal(result.authentication, "configured_unverified");
  assert.equal(diagnostics.some(value => value?.outputError || value?.inputError), false, "local cleanup cannot turn a good connection into ABORT_ERR");
  assert.equal(result.runtimeVersion, "0.1.0-alpha.4");
  assert.equal(result.executableDigest, createHash("sha256").update(f.bytes).digest("hex"));
  assert.equal(operations.length, 2);
  assert.ok(child.signalCode || child.exitCode !== null);
  for (const root of operations) assert.equal(existsSync(root), false);
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(store.getAuthProfileDirectory(profile)), true);
  assert.deepEqual(store.get("kimi-acp"), profile);
  assert.equal(JSON.stringify(result).includes(home), false);
  assert.equal("enabled" in result, false);
  assert.deepEqual(readFileSync(f.executable), f.bytes);
});

test("legacy scripts and non-SEA executables cannot be launched as a relocated Kimi native runtime", async (t) => {
  const f = fixture(t);
  for (const bytes of [Buffer.from("#!/bin/sh\necho 1.2.3\n"), Buffer.from("cffaedfe00000000", "hex")]) {
    writeFileSync(f.executable, bytes);
    let spawned = false;
    const result = await probeEngineInstallation(f.profile, { spawn: () => { spawned = true; throw new Error("unexpected launch"); } });
    assert.equal(result.status, "unexpected_runtime");
    assert.equal(spawned, false);
    assert.deepEqual(readFileSync(f.executable), bytes);
  }
});

test("a self-modified Kimi copy cannot certify the original installation", async (t) => {
  const f = fixture(t);
  let copy;
  const result = await probeEngineInstallation(f.profile, { spawn: (file, _args, options) => {
    copy = file;
    writeFileSync(file, Buffer.concat([f.bytes, Buffer.from("changed")]));
    return spawn(process.execPath, ["-e", 'console.log("0.1.0-alpha.4")'], options);
  } });
  assert.equal(result.status, "probe_failed");
  assert.equal(existsSync(copy), false);
  assert.deepEqual(readFileSync(f.executable), f.bytes);
});

for (const scenario of ["timed_out", "cancelled", "output_limit", "protocol_error", "probe_failed"]) {
  test(`Kimi process check ${scenario} keeps the installation intact and reaps its private process`, { skip: process.platform !== "darwin" }, async (t) => {
    const f = fixture(t);
    const abort = new AbortController();
    const paths = resolveUserConfigPaths({ userRootDir: join(f.root, "ling-state") });
    const store = new ExecutionEngineProfileStore(paths);
    t.after(() => store.close());
    const profile = store.save(f.profile.configuration, 0);
    let child, operationRoot;
    const result = await probeEngineConnection(profile, paths, { store, signal: abort.signal, timeoutMs: 1500,
      spawn: (_file, args, options) => {
        if (args[0] === "--version") return spawn(process.execPath, ["-e", 'console.log("0.1.0-alpha.4")'], options);
        operationRoot = options.cwd;
        const action = scenario === "output_limit" ? 'process.stderr.write("private".repeat(20000));'
          : scenario === "protocol_error" ? 'console.log("private-invalid-json");'
          : scenario === "probe_failed" ? "process.exit(2);" : "";
        child = spawn(process.execPath, ["-e", action + "setInterval(() => {}, 1000);"], options);
        if (scenario === "cancelled") setImmediate(() => abort.abort());
        return child;
      } });
    assert.equal(result.status, scenario);
    assert.ok(child.signalCode || child.exitCode !== null);
    assert.equal(existsSync(operationRoot), false);
    assert.deepEqual(readFileSync(f.executable), f.bytes);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(result.authentication, "not_checked");
  });
}

test("incomplete Kimi key setup and unsupported Windows supervision do not launch a diagnostic process", async (t) => {
  const f = fixture(t);
  const paths = resolveUserConfigPaths({ userRootDir: join(f.root, "ling-state") });
  const noSpawn = () => { throw new Error("unexpected launch"); };
  const keyed = { ...f.profile, configuration: { ...f.profile.configuration, secretRef: "env:PRIVATE_FIXTURE" } };
  assert.equal((await probeEngineConnection(keyed, paths, { spawn: noSpawn, platform: "darwin" })).status, "unsupported_auth");
  assert.equal((await probeEngineConnection(f.profile, paths, { spawn: noSpawn, platform: "win32" })).status, "unsupported_platform");
});
