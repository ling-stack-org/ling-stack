import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { initResourceWorkspace } from "./resource-workspace.mjs";
import { managedNodeArguments, runManagedNode } from "./run-managed.mjs";

async function fixture(t, mayClean = () => true) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gstack-supervisor-test-")));
  t.after(() => {
    assert.ok(mayClean(), `fixture consumer not observed absent; retained ${parent}`);
    return rm(parent, { recursive: true, force: true });
  });
  const root = join(parent, "managed");
  await initResourceWorkspace(process.env.LING_GSTACK_TEST_MOUNT
    ? { root, mountPath: process.env.LING_GSTACK_TEST_MOUNT } : { root, storageMode: "local-bounded" });
  return { root, additionalBytes: 1024 * 1024, onOutput: () => {} };
}

test("the managed test CLI enforces serial files and rejects injected node flags", () => {
  const args = managedNodeArguments("test", ["scripts/gstack/resource-workspace.test.mjs"]);
  assert.ok(args.includes("--test-concurrency=1"));
  assert.throws(() => managedNodeArguments("test", ["--test-concurrency=16"]), /test_path/);
  assert.throws(() => managedNodeArguments("unknown", []), /operation/);
  assert.throws(() => managedNodeArguments("resource", ["a", "b"]), /arguments/);
  assert.throws(() => managedNodeArguments("browser-archives", ["a", "b", "c", "ignored"]), /arguments/);
  assert.ok(managedNodeArguments("testsavant-model", [])[0].endsWith("collect-testsavant-model.mjs"));
  assert.throws(() => managedNodeArguments("testsavant-model", ["override"]), /arguments/);
  assert.throws(() => managedNodeArguments("executable", ["stage", "inspection", "output"]), /arguments/);
  assert.ok(managedNodeArguments("executable", ["stage", "inspection", "archives", "output", "sha256:fixture"])[0].endsWith("assemble-executable-bundle.mjs"));
  assert.ok(managedNodeArguments("browser-inputs", ["stage", "output", "hash"])[0].endsWith("collect-executable-browser-inputs.mjs"));
  assert.ok(managedNodeArguments("select-executable", ["root", "hash"])[0].endsWith("select-executable-bundle.mjs"));
  assert.ok(managedNodeArguments("reviewed-resource", ["source", "output", "parser", "hash"])[0].endsWith("rebuild-reviewed-resource-stage.mjs"));
  assert.throws(() => managedNodeArguments("reviewed-resource", ["source", "output"]), /arguments/);
});

test("real-resource test entrypoints refuse ungoverned invocation before reading inputs", () => {
  const env = { ...process.env, LING_GSTACK_PLATFORM_RESOURCE_STAGE: "/must-not-read-this-input" };
  delete env.LING_GSTACK_RESOURCE_ROOT;
  delete env.LING_GSTACK_RESOURCE_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "scripts/gstack/bundle-inventory-integration.test.mjs"], { env, encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /gstack_resource_lease_required/);
  assert.doesNotMatch(run.stdout + run.stderr, /ENOENT/);
});

test("supervision preserves real exit status, external tmp/cache, and removes only owned scratch", async t => {
  const options = await fixture(t);
  const leaseModule = new URL("./resource-workspace.mjs", import.meta.url).href;
  const script = `(async () => { const fs = require('fs'); const path = require('path');
    await (await import(${JSON.stringify(leaseModule)})).requireResourceLease();
    for (const name of ['TMPDIR', 'TEMP', 'TMP', 'BUN_INSTALL_CACHE_DIR']) {
      if (!process.env[name].startsWith(process.env.LING_GSTACK_RESOURCE_ROOT + path.sep)) process.exit(9);
    }
    fs.writeFileSync(path.join(process.env.TMPDIR, 'owned'), 'tiny fixture'); process.exit(3);
    })().catch(() => process.exit(8));`;
  const result = await runManagedNode({ ...options, args: ["-e", script] });
  assert.equal(result.exitCode, 3);
  assert.equal(result.reason, null);
  assert.deepEqual(await readdir(join(options.root, "runs")), []);
  assert.ok(!(await readdir(options.root)).includes(".heavy-operation.json"));
});

test("a timed-out child and oversized output are terminal failures, not successful retries", async t => {
  const options = await fixture(t);
  const timedOut = await runManagedNode({ ...options, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 150 });
  assert.equal(timedOut.reason, "deadline_exceeded");
  assert.notEqual(timedOut.exitCode, 0);
  const output = await runManagedNode({ ...options, args: ["-e", "process.stdout.write('x'.repeat(2048))"], maxOutputBytes: 100 });
  assert.equal(output.reason, "output_budget_exceeded");
  assert.notEqual(output.exitCode, 0);
  assert.deepEqual(await readdir(join(options.root, "runs")), []);
});

test("cleanup requires a final absent group observation after KILL, not just sending the signal", { skip: process.platform === "win32" }, async t => {
  const options = await fixture(t);
  const kill = process.kill.bind(process), events = [];
  let pid, killed = false;
  t.mock.method(process, "kill", (target, signal) => {
    if (target !== -pid) return kill(target, signal);
    events.push(signal);
    if (signal === "SIGKILL") killed = true;
    if (signal === 0 && killed) throw Object.assign(new Error("group absent"), { code: "ESRCH" });
    return true;
  });
  const result = await runManagedNode({ ...options, args: ["-e", "console.log(process.pid)"],
    onOutput: bytes => { pid = Number(bytes.toString().trim()); } });
  assert.equal(result.reason, "descendant_leak");
  assert.ok(events.indexOf("SIGKILL") < events.lastIndexOf(0), JSON.stringify(events));
  assert.equal(result.settlement.processGroup.status, "absent");
  assert.equal(result.settlement.directChild.closed, true);
  assert.equal(result.leaseDisposition, "released");
  assert.deepEqual(await readdir(join(options.root, "runs")), []);
});

test("unknown post-KILL observation retains the lease and owned scratch with a failure receipt", { skip: process.platform === "win32" }, async t => {
  const options = await fixture(t);
  const kill = process.kill.bind(process);
  let pid, killed = false;
  t.mock.method(process, "kill", (target, signal) => {
    if (target !== -pid) return kill(target, signal);
    if (signal === "SIGKILL") killed = true;
    if (signal === 0 && killed) throw Object.assign(new Error("observation denied"), { code: "EPERM" });
    return true;
  });
  const result = await runManagedNode({ ...options, args: ["-e", "console.log(process.pid)"],
    onOutput: bytes => { pid = Number(bytes.toString().trim()); } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "descendant_leak");
  assert.deepEqual(result.settlement.processGroup, { status: "unknown", errorCode: "EPERM" });
  assert.equal(result.leaseDisposition, "retained");
  assert.equal((await readdir(join(options.root, "runs"))).length, 1);
  const lockName = (await readdir(dirname(options.root))).find(name => name.endsWith(".heavy-operation.json"));
  assert.ok(lockName);
  const lock = JSON.parse(await readFile(join(dirname(options.root), lockName), "utf8"));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.scratchPath, result.retainedScratchPath);
  assert.deepEqual(JSON.parse(await readFile(join(options.root, "last-run.json"), "utf8")), result);
});

test("an output sink failure is supervised instead of throwing from an unhandled data listener", async t => {
  const options = await fixture(t);
  const result = await runManagedNode({ ...options, args: ["-e", "console.log('fixture'); setInterval(() => {}, 1000)"],
    onOutput: () => { throw new Error("fixture output sink failed"); } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "output_handler_failed");
  assert.match(result.outputError, /fixture output sink failed/);
  assert.equal(result.settlement.directChild.closed, true);
});

test("an async output sink rejection is awaited and does not escape supervision", async t => {
  const options = await fixture(t);
  const result = await runManagedNode({ ...options, args: ["-e", "console.log('fixture'); setInterval(() => {}, 1000)"],
    onOutput: async () => { throw new Error("fixture async sink failed"); } });
  assert.equal(result.reason, "output_handler_failed");
  assert.match(result.outputError, /fixture async sink failed/);
  assert.equal(result.outputSettlement, "settled");
  assert.equal(result.settlement.directChild.closed, true);
});

test("the command receipt hashes the admitted argv snapshot, not a later caller mutation", async t => {
  const options = await fixture(t), args = ["-e", "console.log('fixture')"];
  const checksum = createHash("sha256").update(JSON.stringify(args)).digest("hex");
  const result = await runManagedNode({ ...options, args, onOutput: () => { args[1] = "mutated after spawn"; } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.commandChecksum, checksum);
  assert.equal(args[1], "mutated after spawn");
});

test("a still-present group after KILL is never cleaned or reported as settled", { skip: process.platform === "win32" }, async t => {
  const options = await fixture(t), kill = process.kill.bind(process);
  let pid, probes = 0;
  t.mock.method(process, "kill", (target, signal) => {
    if (target !== -pid) return kill(target, signal);
    if (signal === 0) probes++;
    return true;
  });
  const result = await runManagedNode({ ...options, args: ["-e", "console.log(process.pid)"],
    onOutput: bytes => { pid = Number(bytes.toString().trim()); } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "descendant_leak");
  assert.deepEqual(result.settlement.processGroup, { status: "present" });
  assert.equal(result.leaseDisposition, "retained");
  assert.ok(probes > 2);
  assert.equal((await readdir(join(options.root, "runs"))).length, 1);
});

test("real same-group descendants are killed and actually observed absent before release", { skip: process.platform === "win32" }, async t => {
  const options = await fixture(t);
  let descendant;
  const worker = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";
  const leader = `const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {stdio: ['ignore', 'pipe', 'ignore']});
    child.stdout.once('data', () => { console.log(child.pid); child.unref(); process.exit(0); });`;
  try {
    const result = await runManagedNode({ ...options, args: ["-e", leader],
      onOutput: bytes => { descendant = Number(bytes.toString().trim()); } });
    assert.ok(Number.isSafeInteger(descendant) && descendant > 1);
    assert.equal(result.reason, "descendant_leak");
    assert.equal(result.settlement.directChild.closed, true);
    assert.equal(result.settlement.processGroup.status, "absent", JSON.stringify(result));
    assert.equal(result.leaseDisposition, "released");
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
  } finally {
    if (Number.isSafeInteger(descendant) && descendant > 1) {
      try { process.kill(descendant, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
});

test("a pre-spawn argument exception releases only its unused lease and preserves the original error", async t => {
  const options = await fixture(t);
  await assert.rejects(runManagedNode({ ...options, args: ["\0"] }), { code: "ERR_INVALID_ARG_VALUE" });
  assert.deepEqual(await readdir(join(options.root, "runs")), []);
  const receipt = JSON.parse(await readFile(join(options.root, "last-run.json"), "utf8"));
  assert.equal(receipt.reason, "supervision_failed");
  assert.deepEqual(receipt.settlement.processGroup, { status: "not_started" });
  assert.equal(receipt.leaseDisposition, "release_authorized");
});

test("argv cannot select spawn's options overload or bypass the detached/stdio policy", async t => {
  const options = await fixture(t);
  for (const args of [{}, 3, [null], [Symbol("invalid")]]) {
    await assert.rejects(runManagedNode({ ...options, args }), /gstack_managed_argv_invalid/);
  }
  assert.deepEqual(await readdir(join(options.root, "runs")), []);
});

test("an escaped pipe holder cannot hang cancellation or authorize deleting its scratch", { skip: process.platform === "win32" }, async t => {
  let cleanupSafe = false, escaped;
  const options = await fixture(t, () => cleanupSafe);
  const worker = "console.log(JSON.stringify({escaped: process.pid})); setInterval(() => {}, 1000)";
  const leader = `const {spawn} = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {detached: true, stdio: ['ignore', 1, 2]}).unref();
    setInterval(() => {}, 1000);`;
  let output = "";
  try {
    const result = await runManagedNode({ ...options, args: ["-e", leader], timeoutMs: 5000,
      onOutput: bytes => {
        output += bytes.toString();
        if (!escaped && output.includes("\n")) {
          escaped = JSON.parse(output.trim()).escaped;
          // Force the ordering via the owned supervisor's cancellation handler,
          // not a sleep or an OS signal to the test runner/another application.
          process.emit("SIGTERM");
        }
      } });
    assert.ok(Number.isSafeInteger(escaped) && escaped > 1);
    assert.equal(result.reason, "cancelled");
    assert.equal(result.settlement.directChild.closed, false);
    assert.equal(result.settlement.processGroup.status, "absent");
    assert.equal(result.leaseDisposition, "retained");
    assert.equal((await readdir(join(options.root, "runs"))).length, 1);
  } finally {
    if (Number.isSafeInteger(escaped) && escaped > 1) {
      try { process.kill(escaped, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
      for (let probe = 0; probe < 100; probe++) {
        try { process.kill(escaped, 0); }
        catch (error) {
          if (error.code !== "ESRCH") throw error;
          cleanupSafe = true; break;
        }
        await delay(20);
      }
    }
  }
});

test("a real default stdout EPIPE becomes a supervised failure, not a crashed owner", { skip: process.platform === "win32" }, async t => {
  let cleanupSafe = false;
  const options = await fixture(t, () => cleanupSafe);
  const pidFile = join(options.root, "epipe-worker-pid");
  const moduleUrl = new URL("./run-managed.mjs", import.meta.url).href;
  const worker = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), {mode: 0o600});
    process.stdout.on('error', () => {}); console.log('fixture-ready');
    setInterval(() => process.stdout.write('x'.repeat(65536)), 20);`;
  const controllerScript = `import {runManagedNode} from ${JSON.stringify(moduleUrl)};
    const result = await runManagedNode({root: ${JSON.stringify(options.root)}, additionalBytes: 1048576,
      args: ['-e', ${JSON.stringify(worker)}], timeoutMs: 5000});
    console.error(JSON.stringify(result)); process.exitCode = result.exitCode;`;
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.NODE_TEST_CONTEXT;
  const controller = spawn(process.execPath, ["--input-type=module", "-e", controllerScript],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "", forcedStop = false;
  controller.stdout.once("data", () => controller.stdout.destroy());
  controller.stderr.on("data", bytes => { stderr += bytes.toString(); });
  const guard = setTimeout(() => { forcedStop = true; controller.kill("SIGKILL"); }, 10_000);
  try {
    const terminal = await new Promise((resolve, reject) => {
      controller.once("error", reject);
      controller.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(forcedStop, false, stderr);
    assert.deepEqual(terminal, { code: 1, signal: null });
    const result = JSON.parse(stderr.trim());
    assert.equal(result.reason, "output_handler_failed");
    assert.match(result.outputError, /EPIPE|broken pipe/);
    assert.equal(result.outputSettlement, "settled");
    assert.equal(result.settlement.directChild.closed, true);
    assert.equal(result.settlement.processGroup.status, "absent");
    assert.equal(result.leaseDisposition, "released");
  } finally {
    clearTimeout(guard);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    for (let probe = 0; probe < 100; probe++) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code !== "ESRCH") throw error;
        cleanupSafe = true; break;
      }
      await delay(20);
    }
  }
});

test("the real CLI finalizer exits nonzero when an open downstream pipe never reads", { skip: process.platform === "win32" }, async t => {
  let cleanupSafe = false;
  const options = await fixture(t, () => cleanupSafe);
  const pidFile = join(options.root, "paused-worker-pid");
  const moduleUrl = new URL("./run-managed.mjs", import.meta.url).href;
  const worker = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), {mode: 0o600});
    process.stdout.write('x'.repeat(2 * 1024 * 1024)); console.error('fixture-paused-ready');
    setInterval(() => {}, 1000);`;
  const controllerScript = `import {runManagedNode, finishManagedCli} from ${JSON.stringify(moduleUrl)};
    finishManagedCli(await runManagedNode({root: ${JSON.stringify(options.root)}, additionalBytes: 1048576,
      args: ['-e', ${JSON.stringify(worker)}], timeoutMs: 5000}));`;
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.NODE_TEST_CONTEXT;
  const controller = spawn(process.execPath, ["--input-type=module", "-e", controllerScript],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  // Intentionally do not consume stdout and do not close it. This is distinct
  // from EPIPE: queued writes can keep a CLI alive after the API has returned.
  let stderr = "", cancelled = false, forcedStop = false;
  controller.stderr.on("data", bytes => {
    stderr += bytes.toString();
    if (!cancelled && stderr.includes("fixture-paused-ready")) {
      cancelled = true; controller.kill("SIGTERM");
    }
  });
  const guard = setTimeout(() => { forcedStop = true; controller.kill("SIGKILL"); }, 12_000);
  try {
    const terminal = await new Promise((resolve, reject) => {
      controller.once("error", reject);
      controller.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(forcedStop, false, stderr);
    assert.equal(cancelled, true, stderr);
    assert.deepEqual(terminal, { code: 1, signal: null });
    const result = JSON.parse(stderr.trim().split("\n").at(-1));
    assert.equal(result.reason, "cancelled");
    assert.equal(result.outputSettlement, "unverified");
    assert.equal(result.settlement.processGroup.status, "absent");
    assert.equal(result.leaseDisposition, "released");
    assert.equal(JSON.parse(await readFile(join(options.root, "last-run.json"), "utf8")).leaseDisposition, "release_authorized");
  } finally {
    clearTimeout(guard);
    controller.stdout.destroy();
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    for (let probe = 0; probe < 100; probe++) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code !== "ESRCH") throw error;
        cleanupSafe = true; break;
      }
      await delay(20);
    }
  }
});
