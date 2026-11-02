import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DesktopDaemonLifecycle } from "../dist/main/daemon-lifecycle.js";

// Regression: E6-R03 — stop observation must retain its owner, never authorize force-kill/restart.
// Found by /qa on 2026-10-26
// Report: output/e6-20260928/r03-daemon-restart-packaged-20261026/repair-status.md
// Value: protects=owned blocked/unconfirmed Host cannot be killed or replaced;
// fails_when=stop clears owner early, ignores FD5 or escalates after 3s;
// why_new=existing tests expect forced startup cleanup and never project Host stop facts;
// seam=existing spawnDaemon; no_claim=actual packaged GUI (controlled child/health).
function fixture(t, outcome, beforeReady) {
  const children = [], diagnostics = [], unexpected = [];
  let active, external = false;
  const workspace = "/tmp/ling-e6-r03-owned-observer";
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17991", daemonEntryPath: new URL("../package.json", import.meta.url).pathname,
    defaultWorkspaceCwd: workspace, shutdownTimeoutMs: 0,
    probePort: async () => "free",
    fetch: async () => {
      if (!external && (!active || active.exitCode !== null || active.signalCode !== null || active.stopping)) throw new Error("offline");
      await beforeReady?.();
      return new Response(JSON.stringify({ service: "ling-stack-daemon", defaultWorkspaceCwd: workspace }));
    },
    spawnDaemon: input => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 42000 + children.length, exitCode: null, signalCode: null, killSignals: [],
        stdio: [null, null, null, new PassThrough(), null, new PassThrough()], env: input.env });
      child.finish = (code, signal = null) => {
        child.exitCode = code; child.signalCode = signal;
        child.emit("exit", code, signal);
      };
      child.phase = phase => child.stdio[5].write(`${JSON.stringify({ schemaVersion: 1, pid: child.pid, phase })}\n`);
      child.kill = signal => {
        child.killSignals.push(signal);
        if (signal === "SIGKILL") { queueMicrotask(() => child.finish(null, signal)); return true; }
        child.stopping = true;
        if (outcome === "blocked") { child.phase("draining"); child.phase("blocked"); }
        if (outcome === "closed") {
          child.phase("draining"); child.stdio[5].end();
          queueMicrotask(() => child.finish(0));
        }
        return true;
      };
      children.push(child); active = child;
      return child;
    },
    onUnexpectedExit: value => unexpected.push(value),
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });
  t.after(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.finish(0);
      for (const io of child.stdio) io?.destroy();
    }
  });
  return { lifecycle, children, unexpected, diagnostics, reuseExternal: () => { external = true; } };
}

test("stop receipts distinguish unowned, confirmed clean stop, repeat and reused successor", async t => {
  const f = fixture(t, "closed");
  assert.deepEqual(await f.lifecycle.stopOwnedDaemon(), { kind: "not_owned" });
  await f.lifecycle.ensureStarted();
  const receipt = await f.lifecycle.stopOwnedDaemon();
  assert.deepEqual(receipt, { kind: "owned_stopped", pid: f.children[0].pid, code: 0, signal: null });
  assert.deepEqual(await f.lifecycle.stopOwnedDaemon(), receipt);
  f.reuseExternal();
  assert.equal((await f.lifecycle.ensureStarted()).ownedByDesktop, false);
  assert.deepEqual(await f.lifecycle.stopOwnedDaemon(), { kind: "not_owned" });
});

test("late clean exit retains actual stop receipt for explicit retry without a second signal", async t => {
  const f = fixture(t, "pending");
  await f.lifecycle.ensureStarted();
  await assert.rejects(f.lifecycle.stopOwnedDaemon(), error => error?.code === "stop_unconfirmed");
  f.children[0].finish(0);
  assert.deepEqual(await f.lifecycle.stopOwnedDaemon(), {
    kind: "owned_stopped", pid: f.children[0].pid, code: 0, signal: null,
  });
  assert.deepEqual(f.children[0].killSignals, ["SIGTERM"]);
});

test("old stop receipt cannot apply to a new owned Host", async t => {
  const f = fixture(t, "closed");
  await f.lifecycle.ensureStarted();
  const first = await f.lifecycle.stopOwnedDaemon();
  await f.lifecycle.ensureStarted();
  const second = await f.lifecycle.stopOwnedDaemon();
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(second, { kind: "owned_stopped", pid: f.children[1].pid, code: 0, signal: null });
});

test("blocked original Host retains ownership and rejects ensure/restart without a successor", async t => {
  const f = fixture(t, "blocked");
  await f.lifecycle.ensureStarted();
  await assert.rejects(f.lifecycle.stopOwnedDaemon(), error => error?.code === "stop_blocked");
  const child = f.children[0];
  assert.equal(child.env.LING_STACK_SHUTDOWN_OBSERVER_FD, "5");
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(f.lifecycle.status.state, "blocked");
  assert.equal(f.lifecycle.status.ownedByDesktop, true);
  assert.equal(f.lifecycle.status.reason, "stop_blocked");
  await assert.rejects(f.lifecycle.ensureStarted(), error => error?.code === "stop_blocked");
  await assert.rejects(f.lifecycle.restart(), error => error?.code === "stop_blocked");
  await assert.rejects(f.lifecycle.stopOwnedDaemon(), error => error?.code === "stop_blocked");
  assert.equal(f.children.length, 1);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.deepEqual(f.unexpected, []);
});

test("observation timeout retains live child and cannot trigger SIGKILL or a successor", async t => {
  const f = fixture(t, "pending");
  await f.lifecycle.ensureStarted();
  await assert.rejects(f.lifecycle.stopOwnedDaemon(), error => error?.code === "stop_unconfirmed");
  const child = f.children[0];
  assert.equal(child.exitCode, null);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(f.lifecycle.status.ownedByDesktop, true);
  assert.equal(f.lifecycle.status.reason, "stop_unconfirmed");
  await assert.rejects(f.lifecycle.restart(), error => error?.code === "stop_unconfirmed");
  assert.equal(f.children.length, 1);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  child.finish(0);
  assert.equal(f.lifecycle.status.state, "disconnected");
  await f.lifecycle.ensureStarted();
  assert.equal(f.children.length, 2, "only actual clean exit allows an explicit successor");
});

test("externally signalled original Host projects phases without sending another signal", async t => {
  const f = fixture(t, "pending");
  await f.lifecycle.ensureStarted();
  const child = f.children[0];
  child.phase("draining");
  assert.equal(f.lifecycle.status.state, "draining");
  await assert.rejects(f.lifecycle.ensureStarted(), error => error?.code === "stop_unconfirmed");
  child.phase("blocked");
  await assert.rejects(f.lifecycle.restart(), error => error?.code === "stop_blocked");
  assert.deepEqual(child.killSignals, []);
  assert.deepEqual(f.unexpected, []);
});

test("pipe EOF before clean exit cannot prevent successful stop or trigger automatic recovery", async t => {
  const f = fixture(t, "closed");
  await f.lifecycle.ensureStarted();
  await f.lifecycle.stopOwnedDaemon();
  assert.deepEqual(f.children[0].killSignals, ["SIGTERM"]);
  assert.deepEqual(f.unexpected, []);
  assert.equal(f.lifecycle.status.state, "disconnected");
  await f.lifecycle.restart();
  assert.equal(f.children.length, 2);
});

test("nonzero/signal exit during stop remains unconfirmed and never invokes recovery", async t => {
  const f = fixture(t, "pending");
  await f.lifecycle.ensureStarted();
  const pending = f.lifecycle.stopOwnedDaemon();
  f.children[0].finish(null, "SIGKILL");
  await assert.rejects(pending, error => error?.code === "stop_unconfirmed");
  await assert.rejects(f.lifecycle.ensureStarted(), error => error?.code === "stop_unconfirmed");
  assert.equal(f.lifecycle.status.ownedByDesktop, true);
  assert.deepEqual(f.unexpected, []);
  assert.equal(f.children.length, 1);
});

test("synchronous status reentry joins the original stop before another state event", async t => {
  const f = fixture(t, "pending");
  await f.lifecycle.ensureStarted();
  let count = 0, reentered;
  f.lifecycle.onStatusChanged(status => {
    if (status.state === "draining" && ++count === 1) {
      reentered = f.lifecycle.stopOwnedDaemon();
    }
  });
  await assert.rejects(f.lifecycle.stopOwnedDaemon(), error => error?.code === "stop_unconfirmed");
  await assert.rejects(reentered, error => error?.code === "stop_unconfirmed");
  assert.equal(count, 1);
  assert.deepEqual(f.children[0].killSignals, ["SIGTERM"]);
});

test("startup ready cannot overwrite an original Host draining event", async t => {
  let release, entered;
  const readiness = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, "pending", async () => { entered(); await gate; });
  const starting = f.lifecycle.ensureStarted();
  await readiness;
  f.children[0].phase("draining");
  release();
  await assert.rejects(starting, error => error?.code === "stop_unconfirmed");
  assert.equal(f.lifecycle.status.state, "draining");
  assert.deepEqual(f.children[0].killSignals, []);
  assert.equal(f.children.length, 1);
});

test("throwing status observer cannot prevent original Host stop or hide its result from other observers", async t => {
  const f = fixture(t, "closed");
  await f.lifecycle.ensureStarted();
  const states = [];
  const unsubscribe = f.lifecycle.onStatusChanged(() => { throw new Error("observer_failed"); });
  const stopRecording = f.lifecycle.onStatusChanged(status => { states.push(status.state); });
  try {
    await f.lifecycle.stopOwnedDaemon();
    assert.deepEqual(f.children[0].killSignals, ["SIGTERM"]);
    assert.equal(f.children[0].exitCode, 0);
    assert.ok(states.includes("draining"));
    assert.ok(states.includes("disconnected"));
    assert.ok(f.diagnostics.some(value => value.event === "daemon.status_observer_failed"));
  } finally { unsubscribe(); stopRecording(); }
});

test("throwing timeout observer cannot crash the process or turn unconfirmed stop into success", async t => {
  const f = fixture(t, "pending");
  await f.lifecycle.ensureStarted();
  const unsubscribe = f.lifecycle.onStatusChanged(status => {
    if (status.state === "blocked") throw new Error("timeout_observer_failed");
  });
  try {
    await assert.rejects(f.lifecycle.stopOwnedDaemon(), error => error?.code === "stop_unconfirmed");
    assert.equal(f.lifecycle.status.ownedByDesktop, true);
    assert.equal(f.children[0].exitCode, null);
    assert.deepEqual(f.children[0].killSignals, ["SIGTERM"]);
  } finally { unsubscribe(); }
});

for (const outcome of ["error", "abnormal_exit"]) {
  test(`startup ${outcome} after FD5 draining retains the stop classification`, async t => {
    let entered;
    const readiness = new Promise(resolve => { entered = resolve; });
    const f = fixture(t, "pending", async () => { entered(); await new Promise(() => {}); });
    const starting = f.lifecycle.ensureStarted();
    const rejected = assert.rejects(starting, error => error?.code === "stop_unconfirmed");
    await readiness;
    f.children[0].phase("draining");
    if (outcome === "error") f.children[0].emit("error", new Error("late_child_error"));
    else f.children[0].finish(1);
    await rejected;
    assert.equal(f.lifecycle.status.ownedByDesktop, true);
    assert.equal(f.lifecycle.status.reason, "stop_unconfirmed");
    assert.deepEqual(f.unexpected, []);
    assert.equal(f.children.length, 1);
  });
}
