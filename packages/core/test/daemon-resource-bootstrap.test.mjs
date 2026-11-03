import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DAEMON_RESOURCE_BOOTSTRAP_TIMEOUT_MS, readDaemonResourceBootstrap,
  writeDaemonResourceBootstrap } from "../dist/daemon-resource-bootstrap.js";
import { readExecutionEngineHostAuthority } from "../dist/execution-engine-host-authority.js";

test("resource readiness is a separate one-shot receipt from the owned child's private FD4", async () => {
  const moduleUrl = new URL("../dist/daemon-resource-bootstrap.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { writeDaemonResourceBootstrap } from ${JSON.stringify(moduleUrl)};
     writeDaemonResourceBootstrap({ fd: 4 });`], { stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"] });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  try {
    await readDaemonResourceBootstrap({ channel: child.stdio[4], pid: child.pid });
    assert.deepEqual(await exited, [0, null]);
    assert.equal(output, "");
    assert.equal(child.stdio[4].destroyed, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  }
});

test("bootstrap rejects malformed, oversized, extra-field, wrong-phase and wrong-child receipts", async () => {
  const valid = { schemaVersion: 1, phase: "resources_ready", pid: 42 };
  for (const body of ["not-json", "null", "x".repeat(1025), JSON.stringify({ ...valid, pid: 43 }),
    JSON.stringify({ ...valid, phase: "working" }), JSON.stringify({ ...valid, schemaVersion: 2 }),
    JSON.stringify({ ...valid, path: "/untrusted" }), JSON.stringify([valid]),
    `${JSON.stringify(valid)}${JSON.stringify(valid)}`]) {
    const channel = new PassThrough();
    const closed = new Promise(resolve => channel.once("close", resolve));
    const result = readDaemonResourceBootstrap({ channel, pid: 42 });
    channel.end(body);
    await assert.rejects(result, { code: "daemon_resource_bootstrap_invalid" });
    await closed;
    assert.equal(channel.destroyed, true);
    for (const event of ["data", "end", "error", "close"]) assert.equal(channel.listenerCount(event), 0);
  }
  for (const fd of [1, 2, 3, 5, NaN]) {
    assert.throws(() => writeDaemonResourceBootstrap({ fd }), { code: "daemon_resource_bootstrap_invalid" });
  }
});

test("resource pipe timeout is absolute and a receipt is accepted only at EOF", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const channel = new PassThrough();
  let settled = false;
  const pending = assert.rejects(readDaemonResourceBootstrap({ channel, pid: 42 }),
    { code: "daemon_resource_bootstrap_timeout" }).finally(() => { settled = true; });
  channel.write(JSON.stringify({ schemaVersion: 1, phase: "resources_ready", pid: 42 }));
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(DAEMON_RESOURCE_BOOTSTRAP_TIMEOUT_MS);
  await pending;
  assert.equal(channel.destroyed, true);
});

test("abort, pipe error and early close dispose resource and authority readers", async () => {
  for (const kind of ["abort", "preaborted", "error", "closed", "preclosed"]) {
    for (const read of [
      channelInput => readDaemonResourceBootstrap({ ...channelInput, pid: 42 }),
      channelInput => readExecutionEngineHostAuthority({ ...channelInput, pid: 42, baseUrl: "http://127.0.0.1:17991" }),
    ]) {
      const channel = new PassThrough();
      const closed = new Promise(resolve => channel.once("close", resolve));
      const abort = new AbortController();
      if (kind === "preaborted") abort.abort();
      if (kind === "preclosed") channel.destroy();
      const pending = assert.rejects(read({ channel, signal: abort.signal }), /unavailable/);
      if (kind === "abort") abort.abort();
      if (kind === "error") channel.destroy(new Error("raw fixture must not escape"));
      if (kind === "closed") channel.destroy();
      await pending;
      await closed;
      // A reader invoked by close itself removes its temporary error drain on
      // the next loop, after any already queued error/close notifications.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(channel.destroyed, true);
      for (const event of ["data", "end", "error", "close"]) assert.equal(channel.listenerCount(event), 0);
    }
  }
});

test("queued pipe errors racing abort or an already destroyed pipe never crash the host", () => {
  for (const moduleName of ["daemon-resource-bootstrap", "execution-engine-host-authority"]) {
    for (const kind of ["queued-error-abort", "pre-destroyed-error"]) {
      const moduleUrl = new URL(`../dist/${moduleName}.js`, import.meta.url).href;
      const readName = moduleName === "daemon-resource-bootstrap" ? "readDaemonResourceBootstrap" : "readExecutionEngineHostAuthority";
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { PassThrough } from 'node:stream';
        import { ${readName} as read } from ${JSON.stringify(moduleUrl)};
        const channel = new PassThrough(), abort = new AbortController();
        const closed = new Promise(resolve => channel.once('close', resolve));
        if (${JSON.stringify(kind)} === 'pre-destroyed-error') channel.destroy(new Error('queued_io_error'));
        const pending = read({ channel, pid: 42, baseUrl: 'http://127.0.0.1:17991', signal: abort.signal });
        if (${JSON.stringify(kind)} === 'queued-error-abort') {
          channel.destroy(new Error('queued_io_error'));
          abort.abort();
        }
        await assert.rejects(pending, /unavailable/);
        await closed;
        for (const event of ['data', 'end', 'error', 'close']) assert.equal(channel.listenerCount(event), 0);
      `], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `${moduleName}/${kind}: ${result.stderr}`);
    }
  }
});
