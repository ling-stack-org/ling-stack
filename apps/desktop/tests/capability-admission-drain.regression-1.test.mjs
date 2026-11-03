import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { transform } from "esbuild";
import { OFFICE_DRIVER_PROTOCOL } from "@ling-stack/contracts";
import { HostCapabilityRuntime } from "../dist/main/host-capabilities/runtime.js";
import { OfficeDriverRuntime } from "../dist/main/office-driver/runtime.js";
import { HostCapabilityBridgeController } from "../../../packages/daemon/dist/features/runs/host-capability-bridge-controller.js";
import { OfficeDriverController } from "../../../packages/daemon/dist/features/office-documents/driver-controller.js";

// R03: forced Promise interleavings and virtual interval ticks only. These tests
// never start Electron, a native helper, an HTTP server, a real Store or model.
for (const kind of ["host", "office"]) {
  test(`${kind}: idle drain stops claims/availability but retains execution owners`, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fixture(t, kind);
    await f.runtime.start();
    const before = f.publications.length;
    assert.equal(typeof f.runtime.pauseNewClaims, "function");
    for (let i = 0; i < 8; i++) f.runtime.pauseNewClaims();
    assert.equal(f.claimSignals[0].aborted, true);
    await flush();
    t.mock.timers.tick(20_000);
    await flush();
    await f.runtime.start();
    assert.equal(f.claimSignals.length, 1);
    assert.equal(f.publications.length, before);
    assert.equal(f.clients(), 1);
    assert.equal(f.stops(), 0);
    assert.equal(f.previewCloses(), 0);
  });

  test(`${kind}: a claim returned after the drain fence cannot start an effect or fabricate a result`, async t => {
    const f = fixture(t, kind, { lateClaim: true });
    await f.runtime.start();
    assert.equal(typeof f.runtime.pauseNewClaims, "function");
    for (let i = 0; i < 8; i++) f.runtime.pauseNewClaims();
    f.claim.resolve(f.command);
    await flush();
    assert.equal(f.effects(), 0);
    assert.equal(f.completions.length, 0);
    assert.equal(f.claimSignals.length, 1);
    const late = f.diagnostics.filter(([event]) => event.endsWith(".claimed_not_started"));
    assert.equal(late.length, 1);
    assert.equal(late[0][1].commandId, "accepted-command");
    assert.equal(late[0][1].effectState, "not_started");
    assert.equal(late[0][1].hostState, "unknown");
    assert.equal(f.stops(), 0);
    assert.equal(f.previewCloses(), 0);
  });

  test(`${kind}: accepted execution keeps its lifetime signal and lease heartbeat across drain`, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fixture(t, kind, { deliver: true, holdEffect: true });
    await f.runtime.start();
    await f.effectEntered.promise;
    assert.equal(typeof f.runtime.pauseNewClaims, "function");
    f.runtime.pauseNewClaims();
    const before = f.publications.length;
    t.mock.timers.tick(15_000);
    await flush();
    assert.ok(f.publications.length > before, "the 12-second authority lease must not expire merely because claims paused");
    assert.equal(new Set(f.publications.map(value => value.generation)).size, 1);
    assert.ok(f.publicationSignals.slice(before).every(signal => !signal.aborted));
    assert.equal(f.stops(), 0);
    assert.equal(f.previewCloses(), 0);
    f.effect.resolve();
    await until(() => f.completions.length === 1);
    assert.equal(f.completions[0].ok, true);
    assert.equal(f.completionSignals[0].aborted, false);
    assert.notEqual(f.completionSignals[0], f.claimSignals[0]);
    assert.equal(f.claimSignals[0].aborted, true);
    await flush();
    const settled = f.publications.length;
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(f.publications.length, settled, "an idle paused runtime must stop renewing availability");
    assert.equal(f.claimSignals.length, 1);
    assert.equal(f.effects(), 1);
  });

  test(`${kind}: drain during result acknowledgement does not abort the accepted receipt`, async t => {
    const f = fixture(t, kind, { deliver: true, holdCompletion: true });
    await f.runtime.start();
    await f.completionEntered.promise;
    assert.equal(typeof f.runtime.pauseNewClaims, "function");
    f.runtime.pauseNewClaims();
    assert.equal(f.completionSignals[0].aborted, false);
    assert.equal(f.claimSignals[0].aborted, true);
    f.completion.resolve();
    await flush();
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].ok, true);
    assert.equal(f.effects(), 1);
    assert.equal(f.stops(), 0);
    assert.equal(f.previewCloses(), 0);
  });

  test(`${kind}: drain during startup cannot install a later claim loop or heartbeat`, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fixture(t, kind, { holdStartup: true });
    const starting = f.runtime.start();
    void starting.catch(() => undefined);
    await f.startEntered.promise;
    assert.equal(typeof f.runtime.pauseNewClaims, "function");
    f.runtime.pauseNewClaims();
    f.start.resolve();
    await starting;
    const before = f.publications.length;
    t.mock.timers.tick(20_000);
    await flush();
    assert.equal(f.claimSignals.length, 0);
    assert.equal(f.publications.length, before);
    assert.equal(f.stops(), 0);
    assert.equal(f.previewCloses(), 0);
  });

  test(`${kind}: explicit new-generation rebind works but a newer drain while rebinding wins`, async t => {
    const f = fixture(t, kind, { lateClaim: true });
    await f.runtime.start();
    f.runtime.pauseNewClaims();
    const rebinding = f.runtime.restart();
    f.runtime.pauseNewClaims();
    f.claim.resolve();
    await rebinding;
    assert.equal(f.clients(), 1, "a newer drain cannot be cleared by a stale rebind");
    await f.runtime.start();
    assert.equal(f.clients(), 1);
  });

  test(`${kind}: a fresh Host rebind can recover after a newer drain supersedes an earlier rebind`, async t => {
    const f = fixture(t, kind, { lateClaim: true });
    await f.runtime.start();
    const originalGeneration = f.publications[0].generation;
    f.runtime.pauseNewClaims();
    const supersededRebind = f.runtime.restart();
    f.runtime.pauseNewClaims();
    f.claim.resolve();
    await supersededRebind;
    await f.runtime.start();
    assert.equal(f.clients(), 1, "neither a superseded rebind nor plain start may clear the newer drain");
    assert.equal(f.effects(), 0);
    assert.equal(f.completions.length, 0);

    // The fixture now represents Main's explicit rebind after a separate,
    // successful fresh-Host handshake. It does not authorize restart while
    // the original Host's stop/effect state is unknown, or on connected alone.
    await f.runtime.restart();
    assert.equal(f.clients(), 2, "the caller's later authorized rebind must not remain permanently inactive");
    assert.equal(f.claimSignals.length, 2);
    assert.equal(f.claimSignals[1].aborted, false);
    assert.ok(f.publications.at(-1).generation > originalGeneration);
    assert.equal(f.effects(), 0, "rebind must not replay a command");
    assert.equal(f.completions.length, 0, "rebind must not fabricate a result");
  });

  test(`${kind}: fresh Host rebind can reopen the prior generation's paused claim loop`, async t => {
    const f = fixture(t, kind);
    await f.runtime.start();
    f.runtime.pauseNewClaims();
    await f.runtime.restart();
    assert.equal(f.clients(), 2);
    assert.equal(f.claimSignals.length, 2);
    assert.equal(f.claimSignals[1].aborted, false);
    assert.notEqual(f.publications[0].generation, f.publications.at(-1).generation);
  });

  test(`${kind}: a real in-memory controller accepts the retained receipt after its original 12s TTL`, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let clock = Date.now(), authority;
    const controller = kind === "host"
      ? new HostCapabilityBridgeController({ now: () => clock })
      : new OfficeDriverController({ now: () => clock });
    const effect = deferred(), entered = deferred();
    const transport = {
      async publishAvailability(value) {
        authority = { desktopInstanceId: value.desktopInstanceId, generation: value.generation };
        controller.publishAvailability(value);
      },
      async claim(signal) { return await controller.claim(authority, signal); },
      async begin(id) { controller.begin(authority, id); },
      async complete(result) { controller.complete(authority, result); },
    };
    const shared = { daemonBaseUrl: "http://127.0.0.1:1", bridgeToken: "fixture", desktopInstanceId: "ttl-fixture",
      daemonClientFactory: () => transport, now: () => clock };
    const runtime = kind === "host" ? new HostCapabilityRuntime({ ...shared,
      previewManager: {
        async launch() { entered.resolve(); await effect.promise; return { window: {}, close() {} }; },
        async close() {},
      },
    }) : new OfficeDriverRuntime({ ...shared, executablePath: "/unused", recoveryRoot: "/unused", platform: "darwin",
      helper: {
        async start() {}, async stop() {},
        async call(command) {
          if (command.method === "list_sessions") {
            entered.resolve(); await effect.promise;
            return { protocol: OFFICE_DRIVER_PROTOCOL, id: command.id, ok: true, result: [] };
          }
          return { protocol: OFFICE_DRIVER_PROTOCOL, id: command.id, ok: true, result: {
            helperVersion: "fixture", state: "limited", capabilities: ["excel:sessions"],
            officeInstalled: true, applicationRunning: true, permissionGranted: true,
          } };
        },
      },
    });
    t.after(async () => { effect.resolve(); controller.close(); await runtime.stop(); });
    await runtime.start();
    const execution = kind === "host" ? controller.executeOpenLocalTarget({
      path: "index.html", absolutePath: "/tmp/r03-fixture/index.html", workspaceRoot: "/tmp/r03-fixture",
      presentation: "interactive_html", runId: "run-1", attemptId: "attempt-1", toolCallId: "tool-1",
      approvalId: "approval-1", idempotencyKey: "ttl-fixture",
    }) : controller.execute({ method: "list_sessions", params: {}, idempotencyKey: "ttl-fixture" });
    void execution.catch(() => undefined);
    await entered.promise;
    runtime.pauseNewClaims();
    for (let i = 0; i < 3; i++) {
      clock += 5_000; t.mock.timers.tick(5_000); await flush();
    }
    assert.equal(controller.snapshot().connected, true, "the original controller authority must remain current after 15 seconds");
    effect.resolve();
    const result = await execution;
    if (kind === "host") assert.equal(result.status, "launched");
    else assert.deepEqual(result, []);
  });
}

test("office: an in-flight idle status response cannot publish or recover the helper after drain", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture(t, "office", { holdStatus: true });
  await f.runtime.start();
  const before = f.publications.length;
  t.mock.timers.tick(5_000);
  await f.statusEntered.promise;
  assert.equal(typeof f.runtime.pauseNewClaims, "function");
  f.runtime.pauseNewClaims();
  f.status.resolve();
  await flush();
  assert.equal(f.publications.length, before);
  assert.equal(f.stops(), 0);
  assert.equal(f.clients(), 1);
});

test("office: an in-flight idle status failure cannot trigger helper recovery after drain", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture(t, "office", { holdStatus: true });
  await f.runtime.start();
  const before = f.publications.length;
  t.mock.timers.tick(5_000);
  await f.statusEntered.promise;
  f.runtime.pauseNewClaims();
  f.status.reject(new Error("office_driver_helper_timeout"));
  await flush();
  assert.equal(f.publications.length, before);
  assert.equal(f.stops(), 0);
});

test("office: accepted failure after drain retains its error without starting helper recovery", async t => {
  const f = fixture(t, "office", { deliver: true, holdEffect: true });
  await f.runtime.start();
  await f.effectEntered.promise;
  assert.equal(typeof f.runtime.pauseNewClaims, "function");
  f.runtime.pauseNewClaims();
  f.effect.reject(new Error("office_driver_exited"));
  await until(() => f.completions.length === 1);
  assert.equal(f.completions[0].ok, false);
  assert.equal(f.completions[0].error.code, "office_driver_exited");
  assert.equal(f.completionSignals[0].aborted, false);
  assert.equal(f.stops(), 0);
});

test("host: paused accepted acknowledgement failures retain the existing bounded result behavior", async t => {
  const f = fixture(t, "host", { deliver: true, holdEffect: true, rejectCompletions: true });
  await f.runtime.start();
  await f.effectEntered.promise;
  assert.equal(typeof f.runtime.pauseNewClaims, "function");
  f.runtime.pauseNewClaims();
  f.effect.resolve();
  await until(() => f.completions.length === 6);
  await flush();
  assert.deepEqual(f.completions.map(result => result.ok), [true, true, true, false, false, false]);
  assert.ok(f.completions.slice(3).every(result => result.error.code === "host_capability_daemon_request_failed"));
  assert.ok(f.completionSignals.every(signal => !signal.aborted));
  assert.equal(f.claimSignals.length, 1);
  assert.equal(f.launchCloses(), 1);
  assert.equal(f.previewCloses(), 0);
});

test("Main subscribes capability admission outside renderer IPC and only owned drain closes it", async () => {
  const source = await readFile(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.ok(/desktopRuntime\.onStatusChanged\(pauseDesktopCapabilityNewClaims\)/u.test(source));
  const begin = source.indexOf("function pauseDesktopCapabilityNewClaims(");
  assert.ok(begin > 0);
  const end = source.indexOf("\nasync function restartDesktopCapabilityRuntimes", begin);
  assert.ok(end > begin);
  const compiled = await transform(source.slice(begin, end), { loader: "ts", format: "cjs" });
  const calls = [];
  const context = vm.createContext({
    hostCapabilityRuntime: { pauseNewClaims() { calls.push("host"); } },
    officeDriverRuntime: { pauseNewClaims() { calls.push("office"); } },
  });
  const pause = vm.runInContext(`${compiled.code}\npauseDesktopCapabilityNewClaims;`, context);
  for (const state of ["connected", "disconnected", "checking", "starting"]) pause({ state, ownedByDesktop: true });
  for (const state of ["draining", "blocked"]) pause({ state, ownedByDesktop: false });
  assert.deepEqual(calls, []);
  pause({ state: "draining", ownedByDesktop: true });
  assert.deepEqual(calls, ["host", "office"], "the admission fence must be synchronous");
  pause({ state: "blocked", ownedByDesktop: true });
  assert.deepEqual(calls, ["host", "office", "host", "office"]);
  pause({ state: "connected", ownedByDesktop: true });
  assert.deepEqual(calls, ["host", "office", "host", "office"], "connected alone must not reopen a drain fence");
});

function fixture(t, kind, options = {}) {
  const claim = deferred(), effect = deferred(), completion = deferred(), start = deferred(), status = deferred();
  const effectEntered = deferred(), completionEntered = deferred(), startEntered = deferred(), statusEntered = deferred();
  const publications = [], publicationSignals = [], claimSignals = [], completions = [], completionSignals = [], diagnostics = [];
  let clients = 0, stops = 0, previewCloses = 0, launchCloses = 0, effects = 0, statusCalls = 0;
  const command = kind === "host" ? {
    protocol: "ling-host-capability-bridge/v1", id: "accepted-command", capabilityId: "host.open_local_target",
    path: "index.html", absolutePath: "/tmp/r03-fixture/index.html", workspaceRoot: "/tmp/r03-fixture",
    presentation: "interactive_html", runId: "run-1", attemptId: "attempt-1", toolCallId: "tool-1",
    approvalId: "approval-1", deadlineAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "fixture-1",
  } : {
    protocol: OFFICE_DRIVER_PROTOCOL, id: "accepted-command", method: "driver_status", params: {},
    deadlineAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "fixture-1",
  };
  const helperStatus = { helperVersion: "fixture", state: "limited", capabilities: ["excel:sessions"],
    officeInstalled: true, applicationRunning: true, permissionGranted: true };
  const transport = {
    async publishAvailability(value, signal) {
      publications.push(value); publicationSignals.push(signal);
      if (kind === "host" && options.holdStartup && publications.length === 1) {
        startEntered.resolve(); await start.promise;
      }
    },
    async claim(signal) {
      claimSignals.push(signal);
      if (claimSignals.length === 1 && options.deliver) return command;
      if (claimSignals.length === 1 && options.lateClaim) return await claim.promise;
      if (signal.aborted) return undefined;
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      return undefined;
    },
    async begin(_id, signal) { assert.equal(signal.aborted, false); },
    async complete(result, signal) {
      completions.push(result); completionSignals.push(signal); completionEntered.resolve();
      if (options.holdCompletion) await completion.promise;
      if (options.rejectCompletions) throw new Error("host_capability_daemon_request_failed");
    },
  };
  const shared = { daemonBaseUrl: "http://127.0.0.1:1", bridgeToken: "fixture", desktopInstanceId: "fixture",
    daemonClientFactory: () => { clients++; return transport; },
    onDiagnostic: (...event) => diagnostics.push(event) };
  const runtime = kind === "host" ? new HostCapabilityRuntime({ ...shared, heartbeatMs: 4_000, errorBackoffMs: 1,
    previewManager: {
      async launch() {
        effects++; effectEntered.resolve(); if (options.holdEffect) await effect.promise;
        return { window: {}, close() { launchCloses++; } };
      },
      async close() { previewCloses++; },
    },
  }) : new OfficeDriverRuntime({ ...shared, platform: "darwin", executablePath: "/unused", recoveryRoot: "/unused",
    helper: {
      async start() { if (options.holdStartup) { startEntered.resolve(); await start.promise; } },
      async stop() { stops++; },
      async call(value) {
        if (value.id === command.id) {
          effects++; effectEntered.resolve(); if (options.holdEffect) await effect.promise;
        } else {
          statusCalls++;
          if (options.holdStatus && statusCalls > 1) { statusEntered.resolve(); await status.promise; }
        }
        return { protocol: OFFICE_DRIVER_PROTOCOL, id: value.id, ok: true, result: helperStatus };
      },
    },
  });
  t.after(async () => {
    claim.resolve(); effect.resolve(); completion.resolve(); start.resolve(); status.resolve();
    await runtime.stop();
  });
  return { runtime, command, publications, publicationSignals, claimSignals, completions, completionSignals, diagnostics,
    claim, effect, completion, start, status, effectEntered, completionEntered, startEntered, statusEntered,
    clients: () => clients, stops: () => stops, previewCloses: () => previewCloses, launchCloses: () => launchCloses, effects: () => effects };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

async function flush() { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); }
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail("Fixture did not reach the expected capability result");
}
