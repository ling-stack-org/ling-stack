import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { withOwnedNativeProcess } from "../dist/features/execution-engines/owned-native-process.js";
import { killOwnedProbe } from "../dist/features/execution-engines/installation-probe.js";

async function fixture(t, script) {
  const root = await mkdtemp(join(tmpdir(), "ling-owned-process-test-"));
  const children = [];
  t.after(async () => {
    for (const { child, closed } of children) { killOwnedProbe(child); await closed; }
    await rm(root, { recursive: true, force: true });
  });
  return { children, options: { executable: process.execPath, args: ["-e", script], root, environment: {},
    signal: new AbortController().signal, launch: (...args) => {
      const child = spawn(...args);
      const closed = new Promise(resolve => child.once("close", resolve));
      children.push({ child, closed });
      return child;
    } } };
}

test("owned process returns operation output only after closing its child", { timeout: 5000 }, async t => {
  const f = await fixture(t, 'process.stdout.write("ready"); setInterval(() => {}, 1000)');
  const value = await withOwnedNativeProcess(f.options, async ({ output }) => (await once(output, "data"))[0].toString());
  assert.equal(value, "ready");
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
});

test("owned process cancels an operation that ignores its abort signal", { timeout: 5000 }, async t => {
  const f = await fixture(t, 'process.stdout.write("ready"); setInterval(() => {}, 1000)');
  const abort = new AbortController();
  const start = performance.now();
  await assert.rejects(withOwnedNativeProcess({ ...f.options, signal: abort.signal }, async ({ output }) => {
    await once(output, "data");
    abort.abort();
    await new Promise(() => {});
  }), { code: "cancelled" });
  assert.ok(performance.now() - start < 2500);
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
});

test("cancelled owned process retains the original callback lifetime until it drains", { timeout: 5000 }, async t => {
  const f = await fixture(t, 'process.stdout.write("ready"); setInterval(() => {}, 1000)');
  const abort = new AbortController();
  let release, lifetime, drained = false;
  const held = new Promise(resolve => { release = resolve; });
  try {
    await assert.rejects(withOwnedNativeProcess({ ...f.options, signal: abort.signal,
      onLocalLifetime(value) { lifetime = value; void value.then(() => { drained = true; }); },
    }, async ({ output }) => { await once(output, "data"); abort.abort(); await held; }), { code: "cancelled" });
    assert.ok(lifetime instanceof Promise);
    assert.equal(drained, false, "process cancellation cannot end an enrolled callback");
  } finally { release(); }
  await lifetime;
  assert.equal(drained, true);
});

for (const stream of ["stdout", "stderr"]) test(`owned process bounds ${stream} even when the operation ignores output`, { timeout: 5000 }, async t => {
  const f = await fixture(t, `process.${stream}.write(Buffer.alloc(4096)); setInterval(() => {}, 1000)`);
  await assert.rejects(withOwnedNativeProcess({ ...f.options,
    ...(stream === "stdout" ? { maxOutputBytes: 1024 } : { maxStderrBytes: 1024 }) }, () => new Promise(() => {})),
  { code: "output_limit" });
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
});

test("early process exit cannot leave an uncooperative operation pending", { timeout: 5000 }, async t => {
  const f = await fixture(t, "process.exit(23)");
  await assert.rejects(withOwnedNativeProcess(f.options, () => new Promise(() => {})), { code: "process_failed" });
  assert.equal(f.children[0].child.exitCode, 23);
});

test("spawn failure is bounded and redacted without an unhandled child error", { timeout: 5000 }, async t => {
  const f = await fixture(t, "");
  await assert.rejects(withOwnedNativeProcess({ ...f.options, executable: join(f.options.root, "missing") }, () => new Promise(() => {})),
    { code: "process_failed", message: "process_failed" });
});

test("operation failure still reaps the owned child", { timeout: 5000 }, async t => {
  const f = await fixture(t, "setInterval(() => {}, 1000)");
  await assert.rejects(withOwnedNativeProcess(f.options, async () => { throw new Error("owned-operation-failure"); }),
    { message: "owned-operation-failure" });
  assert.ok(f.children[0].child.signalCode || f.children[0].child.exitCode !== null);
});

test("failure to close the process tree is never reported as successful execution", { timeout: 5000 }, async t => {
  const f = await fixture(t, "");
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true });
  await assert.rejects(withOwnedNativeProcess({ ...f.options, launch: () => child }, async () => "native-result"),
    { code: "cleanup_failed" });
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
});

test("owned Unix process cleanup terminates descendants in the same process group", {
  timeout: 5000, skip: process.platform === "win32" ? "Windows Job Object coverage runs on a Windows host" : false,
}, async t => {
  const f = await fixture(t, `const {spawn} = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
    process.stdout.write(String(child.pid)); setInterval(() => {}, 1000);`);
  const pid = await withOwnedNativeProcess(f.options, async ({ output }) => Number((await once(output, "data"))[0].toString()));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  const deadline = performance.now() + 2500;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal(error.code, "ESRCH"); break; }
    assert.ok(performance.now() < deadline, "Owned descendant survived process cleanup");
    await delay(10);
  }
});
