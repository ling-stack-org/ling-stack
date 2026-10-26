import assert from "node:assert/strict";
import test from "node:test";
import { DesktopRuntime } from "../dist/main/desktop-runtime.js";
import { DesktopDaemonLifecycleError } from "../dist/main/daemon-lifecycle.js";

// Regression: E6-R03 — retain accepted Computer Use until the original Host
// supplies its real stop proof. Fixtures control barriers, not wall-clock waits.
// No packaged GUI, provider, model, tool or real Store is exercised here.
const baseUrl = "http://127.0.0.1:1";
const workspaceCwd = "/tmp/ling-r03-runtime-fixture";

test("owned draining/blocked synchronously fences admission without retiring the coordinator", async () => {
  const f = fixture();
  await f.runtime.ensureStarted();
  f.daemon.emit("draining");
  assert.deepEqual(f.events, ["coordinator.drain:daemon_status_draining"]);
  f.daemon.emit("blocked", "stop_blocked");
  await flush();
  assert.equal(f.runtime.cuaDriverCoordinator, f.coordinator);
  assert.equal(f.coordinator.shutdownCalls, 0);
  assert.equal(f.disposals(), 0);
  assert.equal(f.releases(), 0);
  await f.runtime.shutdown();
});

test("prepareShutdown is single-flight and keeps resources until original Host stop succeeds", async () => {
  const stop = deferred();
  const f = fixture({ stop: async () => { await stop.promise; } });
  await f.runtime.ensureStarted();
  const first = f.runtime.prepareShutdown();
  assert.deepEqual(f.events, ["coordinator.drain:desktop_quit"]);
  const pending = Array.from({ length: 8 }, () => f.runtime.prepareShutdown());
  assert.ok(pending.every(value => value === first));
  await flush();
  assert.equal(f.daemon.stopCalls, 1);
  assert.equal(f.coordinator.shutdownCalls, 0);
  assert.equal(f.disposals(), 0);
  assert.equal(f.releases(), 0);
  await assert.rejects(f.runtime.ensureStarted(), error => error?.code === "shutdown_requested");
  stop.resolve();
  await Promise.all([first, ...pending]);
  assert.equal(f.coordinator.shutdownCalls, 0, "preflight is not final resource cleanup");
  await f.runtime.shutdown();
  assert.deepEqual(f.events, [
    "coordinator.drain:desktop_quit", "daemon.stop.begin", "daemon.stop.end",
    "coordinator.shutdown", "platform.dispose", "continuation.release",
  ]);
  assert.equal(f.daemon.stopCalls, 1);
});

test("unconfirmed stop retains every owner and an explicit retry accepts late clean stop proof", async () => {
  const stopError = new DesktopDaemonLifecycleError("stop_unconfirmed", baseUrl);
  let clean = false;
  const f = fixture({ stop: async () => { if (!clean) throw stopError; } });
  await f.runtime.ensureStarted();
  await assert.rejects(f.runtime.shutdown(), error => error === stopError);
  assert.equal(f.runtime.cuaDriverCoordinator, f.coordinator);
  assert.equal(f.coordinator.shutdownCalls, 0);
  assert.equal(f.disposals(), 0);
  assert.equal(f.releases(), 0);
  await assert.rejects(f.runtime.restart(), error => error?.code === "shutdown_requested");
  assert.equal(f.daemon.restartCalls, 0);
  clean = true;
  f.daemon.emit("disconnected", undefined, false);
  await f.runtime.shutdown();
  assert.equal(f.daemon.stopCalls, 2, "explicit retry must recheck the original owner, not reuse a rejected preflight");
  assert.equal(f.coordinator.shutdownCalls, 1);
  assert.equal(f.disposals(), 1);
  assert.equal(f.releases(), 1);
});

test("owned drain during in-flight enable cannot turn authority loss into destructive cleanup", async () => {
  const enabling = deferred(), enabled = deferred();
  const f = fixture({ enable: async () => { enabling.resolve(); await enabled.promise; } });
  const starting = f.runtime.ensureStarted();
  await enabling.promise;
  f.daemon.cuaDriverAuthorityTuple = undefined;
  f.daemon.emit("draining");
  const rejected = assert.rejects(starting, error => error?.code === "shutdown_requested");
  enabled.resolve();
  await rejected;
  await flush();
  assert.equal(f.runtime.cuaDriverCoordinator, f.coordinator);
  assert.equal(f.coordinator.shutdownCalls, 0);
  await f.runtime.shutdown();
});

test("an already queued system suspension cannot retire a Host-draining coordinator", async () => {
  const enabling = deferred(), enabled = deferred();
  const f = fixture({ enable: async () => { enabling.resolve(); await enabled.promise; } });
  const starting = f.runtime.ensureStarted();
  await enabling.promise;
  const suspension = f.runtime.suspendComputerControlForSystem("system_lock");
  f.daemon.emit("draining");
  const rejected = assert.rejects(starting, error => error?.code === "shutdown_requested");
  enabled.resolve();
  await Promise.all([rejected, suspension]);
  assert.equal(f.coordinator.suspensions, 0);
  assert.equal(f.coordinator.shutdownCalls, 0);
  await f.runtime.shutdown();
});

test("restart waits for real original stop and old coordinator cleanup before starting a successor", async () => {
  const stop = deferred(), cleanup = deferred();
  const f = fixture({ stop: async () => { await stop.promise; }, cleanup: async () => { await cleanup.promise; } });
  await f.runtime.ensureStarted();
  const restarting = f.runtime.restart();
  await flush();
  assert.deepEqual(f.events, ["coordinator.drain:daemon_restart", "daemon.stop.begin"]);
  assert.equal(f.daemon.restartCalls, 0);
  assert.equal(f.coordinator.shutdownCalls, 0);
  stop.resolve();
  await flush();
  assert.equal(f.coordinator.shutdownCalls, 1);
  assert.equal(f.daemon.restartCalls, 0);
  cleanup.resolve();
  await restarting;
  assert.deepEqual(f.events.slice(0, 5), [
    "coordinator.drain:daemon_restart", "daemon.stop.begin", "daemon.stop.end",
    "coordinator.shutdown", "daemon.restart",
  ]);
  await f.runtime.shutdown();
});

test("blocked restart retains transport and cannot call daemon restart", async () => {
  const stopError = new DesktopDaemonLifecycleError("stop_blocked", baseUrl);
  let blocked = true;
  const f = fixture({ stop: async () => { if (blocked) throw stopError; } });
  await f.runtime.ensureStarted();
  await assert.rejects(f.runtime.restart(), error => error === stopError);
  assert.equal(f.runtime.cuaDriverCoordinator, f.coordinator);
  assert.equal(f.coordinator.shutdownCalls, 0);
  assert.equal(f.daemon.restartCalls, 0);
  blocked = false;
  await f.runtime.shutdown();
});

test("ordinary cleanup failure keeps its original error and never starts a successor", async () => {
  const cleanupError = new Error("fixture_cleanup_failed");
  let fail = true;
  const f = fixture({ cleanup: async () => { if (fail) throw cleanupError; } });
  await f.runtime.ensureStarted();
  await assert.rejects(f.runtime.restart(), error => error === cleanupError);
  assert.equal(f.daemon.stopCalls, 1);
  assert.equal(f.daemon.restartCalls, 0);
  assert.equal(f.runtime.cuaDriverCoordinator, f.coordinator);
  fail = false;
  await f.runtime.shutdown();
});

test("an unknown stop rejection remains typed missing proof and cannot enter ordinary cleanup", async () => {
  const cause = new Error("fixture_stop_transport_failed");
  let fail = true;
  const f = fixture({ stop: async () => { if (fail) throw cause; } });
  await f.runtime.ensureStarted();
  await assert.rejects(f.runtime.shutdown(), error => error instanceof DesktopDaemonLifecycleError && error.code === "stop_unconfirmed");
  assert.equal(f.coordinator.shutdownCalls, 0);
  assert.equal(f.disposals(), 0);
  assert.equal(f.releases(), 0);
  fail = false;
  await f.runtime.shutdown();
});

test("a late engine authority response cannot authorize new work after Host drain", async () => {
  const result = deferred();
  const f = fixture();
  f.daemon.getExecutionEngineAuthority = async () => result.promise;
  await f.runtime.ensureStarted();
  const authority = f.runtime.getExecutionEngineAuthority();
  f.daemon.emit("draining");
  const rejected = assert.rejects(authority, error => error?.code === "shutdown_requested");
  result.resolve({ fixture: true });
  await rejected;
  await assert.rejects(f.runtime.getExecutionEngineAuthority(), error => error?.code === "shutdown_requested");
  await f.runtime.shutdown();
});

// R03-OBS: Host lifecycle admission is independent of the optional CUA feature.
test("disabled Computer Use still fences execution authority on owned Host drain", async () => {
  const f = fixture({ featureFlags: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } } });
  f.daemon.getExecutionEngineAuthority = async () => ({ fixture: true });
  f.daemon.emit("draining");
  await assert.rejects(f.runtime.getExecutionEngineAuthority(), error => error?.code === "shutdown_requested");
  await f.runtime.shutdown();
});

test("a failed preflight retains the continuation heartbeat until confirmed cleanup", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let fail = true;
  const f = fixture({ stop: async () => { if (fail) throw new DesktopDaemonLifecycleError("stop_blocked", baseUrl); } });
  await f.runtime.ensureStarted();
  const before = f.publications();
  await assert.rejects(f.runtime.prepareShutdown(), error => error?.code === "stop_blocked");
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(f.publications(), before + 1);
  assert.equal(f.releases(), 0);
  fail = false;
  await f.runtime.shutdown();
  const final = f.publications();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(f.publications(), final);
});

function fixture(options = {}) {
  const events = [], listeners = new Set();
  let disposed = 0, released = 0, published = 0;
  const makeAuthority = epoch => Object.freeze({ daemonAuthorityEpoch: "fixture", bridgeConnectionId: `bridge-${epoch}`,
    desktopInstanceEpoch: epoch, workspaceCwd, readinessDetailsV1: false });
  const daemon = {
    status: { state: "connected", baseUrl, ownedByDesktop: true },
    cuaDriverAuthorityTuple: makeAuthority(1), stopCalls: 0, restartCalls: 0,
    async ensureStarted() { return this.status; },
    async stopOwnedDaemon() {
      this.stopCalls++; events.push("daemon.stop.begin");
      await options.stop?.();
      events.push("daemon.stop.end");
    },
    async restart() {
      this.restartCalls++; events.push("daemon.restart");
      this.cuaDriverAuthorityTuple = makeAuthority(1 + this.restartCalls);
      this.status = { state: "connected", baseUrl, ownedByDesktop: true };
      return this.status;
    },
    onStatusChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(state, reason, ownedByDesktop = true) {
      this.status = { state, baseUrl, ownedByDesktop, ...(reason ? { reason } : {}) };
      for (const listener of listeners) listener(this.status);
    },
  };
  const coordinator = {
    shutdownCalls: 0, suspensions: 0,
    async enable() { await options.enable?.(); return { lifecycle: "active", providerState: "desktop_unavailable", generation: 1 }; },
    beginHostDrain(reason) { if (!this.draining) { this.draining = true; events.push(`coordinator.drain:${reason}`); } },
    closeCallGateForSecurityBoundary() {},
    async suspendForSystem() { this.suspensions++; },
    async shutdown() { this.shutdownCalls++; events.push("coordinator.shutdown"); await options.cleanup?.(); },
  };
  const runtime = new DesktopRuntime({
    daemon, daemonBaseUrl: baseUrl, bridgeToken: "fixture", workspaceCwd,
    resourcesRoot: "/tmp/ling-r03-runtime-resources", userDataPath: "/tmp/ling-r03-runtime-data",
    platform: "darwin", architecture: "arm64", readSystemSessionLocked: async () => false,
    featureFlags: options.featureFlags ?? { bundledEmbedded: { darwin: true, win32: false }, packagedProvider: { darwin: true, win32: false } },
    coordinatorFactory: () => coordinator,
    platformOwner: { platform: "darwin", async start() {}, async dispose() { disposed++; events.push("platform.dispose"); } },
    lockedTaskContinuationClient: {
      async publish() { published++; }, async release() { released++; events.push("continuation.release"); },
    },
  });
  return { runtime, daemon, coordinator, events, disposals: () => disposed, releases: () => released, publications: () => published };
}

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
