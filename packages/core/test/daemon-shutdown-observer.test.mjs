import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { observeDaemonShutdown, DAEMON_SHUTDOWN_OBSERVER_MAX_BYTES } from "../dist/daemon-shutdown-observer.js";

const frame = (phase, extra = {}) => `${JSON.stringify({ schemaVersion: 1, pid: 42, phase, ...extra })}\n`;
function fixture(pid = 42) {
  const channel = new PassThrough(), phases = [], unavailable = [];
  const closed = once(channel, "close");
  const dispose = observeDaemonShutdown({ channel, pid,
    onPhase: value => phases.push(value), onUnavailable: value => unavailable.push(value) });
  return { channel, phases, unavailable, closed, dispose };
}

test("private shutdown observation streams ordered frames without needing HTTP or EOF", async () => {
  const f = fixture();
  const draining = Buffer.from(frame("draining"));
  for (const byte of draining) f.channel.write(Buffer.from([byte]));
  assert.deepEqual(f.phases, ["draining"]);
  f.channel.end(frame("blocked"));
  await f.closed;
  assert.deepEqual(f.phases, ["draining", "blocked"]);
  assert.deepEqual(f.unavailable, []);
  for (const event of ["data", "end", "close", "error"]) assert.equal(f.channel.listenerCount(event), 0);
});

for (const [kind, wire] of Object.entries({
  malformed: "not-json\n", empty: "\n", null: "null\n", array: "[]\n",
  wrongPid: frame("draining", { pid: 43 }), wrongVersion: frame("draining", { schemaVersion: 2 }),
  extraKey: frame("draining", { command: "must-not-escape" }), unknownPhase: frame("stopped"),
  reversed: frame("blocked"), duplicate: frame("draining") + frame("draining"),
  repeatedBlocked: frame("draining") + frame("blocked") + frame("blocked"),
  truncated: frame("draining").trimEnd(),
  oversized: "x".repeat(DAEMON_SHUTDOWN_OBSERVER_MAX_BYTES + 1),
})) test(`shutdown observer fails closed: ${kind}`, async () => {
  const f = fixture();
  f.channel.end(wire);
  await f.closed;
  assert.deepEqual(f.unavailable, ["daemon_shutdown_observer_invalid"]);
  assert.ok(!f.phases.includes("stopped"));
});

test("EOF before actual child exit is unavailable, never stopped", async () => {
  for (const wire of ["", frame("draining")]) {
    const f = fixture();
    f.channel.end(wire);
    await f.closed;
    assert.deepEqual(f.unavailable, ["daemon_shutdown_observer_unavailable"]);
    assert.deepEqual(f.phases, wire ? ["draining"] : []);
  }
});

test("invalid expected identities and lost or disposed channels cannot publish new phases", async () => {
  for (const pid of [0, -1, NaN, 1.5]) {
    const f = fixture(pid);
    await f.closed;
    assert.deepEqual(f.unavailable, ["daemon_shutdown_observer_invalid"]);
    assert.deepEqual(f.phases, []);
  }
  for (const kind of ["error", "close", "dispose"]) {
    const f = fixture();
    if (kind === "error") f.channel.destroy(new Error("private_io_detail"));
    if (kind === "close") f.channel.destroy();
    if (kind === "dispose") { f.channel.destroy(new Error("queued_private_error")); f.dispose(); f.dispose(); }
    await f.closed.catch(() => undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.phases, []);
    assert.deepEqual(f.unavailable, kind === "dispose" ? [] : ["daemon_shutdown_observer_unavailable"]);
    for (const event of ["data", "end", "close", "error"]) assert.equal(f.channel.listenerCount(event), 0);
  }
});

test("a failed callback is isolated, sanitized and disposes the reader", async () => {
  const channel = new PassThrough(), closed = once(channel, "close"), failures = [];
  observeDaemonShutdown({ channel, pid: 42,
    onPhase: () => { throw new Error("private_callback_detail"); },
    onUnavailable: code => { failures.push(code); throw new Error("failed_diagnostic"); } });
  channel.end(frame("draining"));
  await closed;
  assert.deepEqual(failures, ["daemon_shutdown_observer_unavailable"]);
});

test("actual inherited FD5 reporter binds PID and emits at most draining then blocked", { timeout: 5000 }, async t => {
  const moduleUrl = new URL("../dist/daemon-shutdown-observer.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { createDaemonShutdownReporter } from ${JSON.stringify(moduleUrl)};
    const reporter = createDaemonShutdownReporter({ fd: 5 });
    assert.throws(() => reporter.publish('blocked'), /observer_invalid/);
    reporter.publish('draining');
    assert.throws(() => reporter.publish('draining'), /observer_invalid/);
    reporter.publish('blocked');
    assert.throws(() => reporter.publish('blocked'), /observer_unavailable/);
  `], { stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe"] });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  });
  const phases = [], failures = [], ended = once(child.stdio[5], "close");
  observeDaemonShutdown({ channel: child.stdio[5], pid: child.pid,
    onPhase: phase => phases.push(phase), onUnavailable: code => failures.push(code) });
  assert.deepEqual(await exited, [0, null], output);
  await ended;
  assert.equal(output, "");
  assert.deepEqual(phases, ["draining", "blocked"]);
  assert.deepEqual(failures, []);
});

test("reporter rejects non-FD5 and regular-file handles without trusting stdout or files", () => {
  const moduleUrl = new URL("../dist/daemon-shutdown-observer.js", import.meta.url).href;
  // An ignored extra fd is closed/reusable by Node's own runtime; it is not a
  // stable non-pipe fixture. Inherit an actual read-only regular file at FD5.
  const regularFile = openSync(fileURLToPath(moduleUrl), "r");
  let result;
  try { result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { fstatSync } from 'node:fs';
    import { createDaemonShutdownReporter } from ${JSON.stringify(moduleUrl)};
    assert.equal(fstatSync(5).isFile(), true);
    for (const fd of [1, 2, 3, 4, 6, NaN]) {
      assert.throws(() => createDaemonShutdownReporter({ fd }), /observer_invalid/);
    }
    assert.throws(() => createDaemonShutdownReporter({ fd: 5 }), /observer_invalid/);
  `], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", regularFile] });
  } finally { closeSync(regularFile); }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
