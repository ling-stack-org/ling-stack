import assert from "node:assert/strict";
import test from "node:test";
import {
  captureCuaDriverActivationFence,
  commitCurrentCuaDriverActivation,
} from "../dist/features/plugins/cua-driver-activation-fence.js";
import { CuaDriverDesktopBridgeAuthority } from "../dist/features/computer-use/desktop-bridge-authority.js";
import { CuaDriverClientPool } from "../dist/features/plugins/cua-driver-client-pool.js";
import {
  CuaDriverLeaseRegistry,
  cuaDriverLeasePoolKey,
} from "../dist/features/plugins/cua-driver-lease.js";
import { CUA_DRIVER_LEASE_MAX_TTL_MS } from "@ling-stack/contracts";

const digest = "a".repeat(64);

function lease(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-a",
    desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-a",
    generation: 1,
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
    endpoint: "http://127.0.0.1:43123/mcp",
    providerVersion: "0.8.3",
    distributionRevision: "ling.1",
    integrationMode: "embedded-stdio",
    expiresAt: "2026-07-18T00:01:00.000Z",
    lockDigest: digest,
    providerSealDigest: "b".repeat(64),
    providerCatalogDigest: "c".repeat(64),
    platform: "darwin",
    architecture: "arm64",
    integrityCoverage: "standard",
    ...overrides,
  };
}

function fakeDeadlineScheduler() {
  const deadlines = [];
  return {
    deadlines,
    schedule(callback, delayMs) {
      const deadline = {
        callback,
        delayMs,
        canceled: false,
        fired: false,
        cancel() {
          deadline.canceled = true;
        },
        fire() {
          deadline.fired = true;
          callback();
        },
      };
      deadlines.push(deadline);
      return deadline;
    },
  };
}

test("lease registry fences old generations and old Desktop instances", () => {
  let now = "2026-07-18T00:00:00.000Z";
  const replaced = [];
  const registry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
    now: () => now,
    onReplaced: (oldLease, nextLease) => replaced.push([oldLease.generation, nextLease?.generation]),
  });
  assert.equal(registry.publish(lease()).accepted, true);
  assert.equal(registry.publish(lease({ generation: 1, endpoint: "http://127.0.0.1:43124/mcp" })).reason, "stale_generation");
  assert.equal(registry.publish(lease({ generation: 2 })).accepted, true);
  assert.equal(registry.publish(lease({ desktopInstanceId: "desktop-old", desktopInstanceEpoch: 1, bridgeConnectionId: "bridge-old", generation: 9 })).reason, "stale_instance");
  assert.equal(registry.publish(lease({ desktopInstanceId: "desktop-b", desktopInstanceEpoch: 2, bridgeConnectionId: "bridge-b", generation: 1 })).accepted, true);
  assert.deepEqual(replaced, [[1, 2], [2, 1]]);
  assert.equal(registry.revoke({
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-a",
    desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-a",
    generation: 2,
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
  }), false);
  assert.equal(registry.revoke({
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-b",
    desktopInstanceEpoch: 2,
    bridgeConnectionId: "bridge-b",
    generation: 1,
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
  }), true);
  now = "2026-07-20T00:00:00.000Z";
  assert.equal(registry.getCurrent(), undefined);
});

test("Desktop bridge authority forwards lease replacement and clear notifications", () => {
  const replaced = [];
  const authority = new CuaDriverDesktopBridgeAuthority({
    workspaceCwd: "/tmp/ling-workspace",
    daemonAuthorityEpoch: "authority-a",
    createConnectionId: () => "bridge-a",
    now: () => "2026-07-18T00:00:00.000Z",
    onLeaseReplaced: (previous, next) => replaced.push([previous.generation, next?.generation]),
  });
  const handshake = authority.issueAuthenticatedHandshake();
  const first = lease({ ...handshake });
  const second = lease({ ...handshake, generation: 2 });

  assert.equal(authority.publish(first).accepted, true);
  assert.equal(authority.publish(second).accepted, true);
  authority.clear();

  assert.deepEqual(replaced, [[1, 2], [2, undefined]]);
});

test("lease registry rejects malformed authority, workspace, expiry, and renewal inputs", () => {
  let now = "2026-07-18T00:00:00.000Z";
  const replaced = [];
  const registry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
    now: () => now,
    onReplaced: (oldLease, nextLease) => replaced.push([oldLease.generation, nextLease?.generation]),
  });
  assert.equal(registry.publish(null).reason, "invalid");
  assert.equal(registry.publish(lease({ daemonAuthorityEpoch: "authority-b" })).reason, "authority_mismatch");
  assert.equal(registry.publish(lease({ workspaceCwd: "/tmp/other" })).reason, "workspace_mismatch");
  assert.equal(registry.publish(lease({ expiresAt: "Fri, 17 Jul 2026 23:59:59 GMT" })).reason, "invalid");
  assert.equal(registry.publish(lease({ expiresAt: now })).reason, "expired");
  assert.equal(registry.publish(lease({
    expiresAt: new Date(Date.parse(now) + CUA_DRIVER_LEASE_MAX_TTL_MS + 1).toISOString(),
  })).reason, "ttl_exceeded");
  assert.equal(registry.publish(lease()).accepted, true);
  assert.equal(registry.renew(lease({ generation: 2 })).reason, "stale_generation");
  assert.equal(registry.renew(lease({
    expiresAt: new Date(Date.parse(now) + CUA_DRIVER_LEASE_MAX_TTL_MS + 1).toISOString(),
  })).reason, "ttl_exceeded");
  assert.equal(registry.renew(lease({ expiresAt: "2026-07-18T00:01:30.000Z" })).accepted, true);
  assert.equal(replaced.length, 0);
  assert.equal(registry.isCurrent(lease({ expiresAt: "2026-07-18T00:01:45.000Z" })), true);
  registry.clear();
  assert.deepEqual(replaced, [[1, undefined]]);
  assert.equal(registry.renew(lease()).reason, "expired");
});

test("lease registry actively expires the current lease using epoch time", () => {
  let now = "2026-07-17T20:00:00.000-04:00";
  const replaced = [];
  const scheduler = fakeDeadlineScheduler();
  const current = lease({ expiresAt: "2026-07-18T00:00:30.000Z" });
  const registry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
    now: () => now,
    scheduleDeadline: scheduler.schedule,
    onReplaced: (oldLease, nextLease) => {
      replaced.push([oldLease, nextLease]);
      throw new Error("observer failed");
    },
  });

  assert.equal(registry.publish(current).accepted, true);
  assert.equal(scheduler.deadlines.length, 1);
  assert.equal(scheduler.deadlines[0].delayMs, 30_000);

  now = "2026-07-17T20:00:30.000-04:00";
  assert.doesNotThrow(() => scheduler.deadlines[0].fire());
  assert.deepEqual(replaced, [[current, undefined]]);
  assert.equal(registry.getCurrent(), undefined);
  assert.equal(scheduler.deadlines.filter((deadline) => !deadline.canceled && !deadline.fired).length, 0);
});

test("renew replaces the deadline timer and stale timer callbacks cannot expire the lease", () => {
  let now = "2026-07-18T00:00:00.000Z";
  const replaced = [];
  const scheduler = fakeDeadlineScheduler();
  const initial = lease({ expiresAt: "2026-07-18T00:00:30.000Z" });
  const renewed = lease({ expiresAt: "2026-07-18T00:01:00.000Z" });
  const registry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
    now: () => now,
    scheduleDeadline: scheduler.schedule,
    onReplaced: (oldLease, nextLease) => replaced.push([oldLease, nextLease]),
  });

  assert.equal(registry.publish(initial).accepted, true);
  assert.equal(registry.renew(renewed).accepted, true);
  assert.equal(scheduler.deadlines.length, 2);
  assert.equal(scheduler.deadlines[0].canceled, true);
  assert.equal(scheduler.deadlines[1].delayMs, 60_000);

  now = "2026-07-18T00:00:30.000Z";
  scheduler.deadlines[0].fire();
  assert.equal(registry.getCurrent(), renewed);
  assert.deepEqual(replaced, []);

  registry.clear();
  assert.equal(scheduler.deadlines[1].canceled, true);
  assert.deepEqual(replaced, [[renewed, undefined]]);
});

test("replacing a lease cancels its old deadline before notifying observers", () => {
  const scheduler = fakeDeadlineScheduler();
  const replacementObservations = [];
  const registry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
    now: () => "2026-07-18T00:00:00.000Z",
    scheduleDeadline: scheduler.schedule,
    onReplaced: (oldLease, nextLease) => replacementObservations.push({
      oldLease,
      nextLease,
      oldDeadlineCanceled: scheduler.deadlines[0].canceled,
    }),
  });
  const initial = lease();
  const replacement = lease({ generation: 2 });

  assert.equal(registry.publish(initial).accepted, true);
  assert.equal(registry.publish(replacement).accepted, true);
  assert.equal(scheduler.deadlines.length, 2);
  assert.equal(scheduler.deadlines[0].canceled, true);
  assert.deepEqual(replacementObservations, [{
    oldLease: initial,
    nextLease: replacement,
    oldDeadlineCanceled: true,
  }]);

  registry.clear();
  assert.equal(scheduler.deadlines[1].canceled, true);
});

test("deadline scheduler failure clears the current lease and notifies its observer once", () => {
  const scheduler = fakeDeadlineScheduler();
  let scheduleCalls = 0;
  const replaced = [];
  const registry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
    now: () => "2026-07-18T00:00:00.000Z",
    scheduleDeadline: (callback, delayMs) => {
      scheduleCalls += 1;
      if (scheduleCalls === 2) {
        throw new Error("timer unavailable");
      }
      return scheduler.schedule(callback, delayMs);
    },
    onReplaced: (oldLease, nextLease) => replaced.push([oldLease, nextLease]),
  });
  const initial = lease();

  assert.equal(registry.publish(initial).accepted, true);
  assert.deepEqual(registry.publish(lease({ generation: 2 })), {
    accepted: false,
    reason: "deadline_unavailable",
  });
  assert.equal(scheduler.deadlines[0].canceled, true);
  assert.equal(registry.getCurrent(), undefined);
  assert.deepEqual(replaced, [[initial, undefined]]);

  const unavailable = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
    now: () => "2026-07-18T00:00:00.000Z",
    scheduleDeadline: () => { throw new Error("timer unavailable"); },
    onReplaced: (oldLease, nextLease) => replaced.push([oldLease, nextLease]),
  });
  assert.deepEqual(unavailable.publish(initial), {
    accepted: false,
    reason: "deadline_unavailable",
  });
  assert.equal(unavailable.getCurrent(), undefined);
  assert.deepEqual(replaced, [[initial, undefined]]);
});

test("pool shares one client per lease key and closes stale generations", async () => {
  let connects = 0;
  let closes = 0;
  const pool = new CuaDriverClientPool({
    factory: {
      connect: async () => {
        connects += 1;
        return { close: () => { closes += 1; } };
      },
    },
  });
  const first = lease();
  const second = lease({ generation: 2 });
  const a = await pool.acquire(first);
  const b = await pool.acquire(first);
  assert.equal(a.client, b.client);
  assert.equal(connects, 1);
  a.release();
  b.release();
  await pool.closeStale(second);
  assert.equal(closes, 1);
  const c = await pool.acquire(second);
  assert.notEqual(c.client, a.client);
  c.release();
  await pool.closeAll();
  assert.equal(closes, 2);
  assert.notEqual(cuaDriverLeasePoolKey(first), cuaDriverLeasePoolKey(second));
});

test("pool removes a failed connection so the same lease can retry", async () => {
  let attempts = 0;
  const pool = new CuaDriverClientPool({
    factory: {
      connect: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("initialize failed");
        return { close: () => undefined };
      },
    },
  });
  await assert.rejects(pool.acquire(lease()), /initialize failed/);
  assert.equal(pool.size, 0);
  const handle = await pool.acquire(lease());
  assert.equal(attempts, 2);
  handle.release();
  await pool.closeAll();
});

test("pool close is bounded when a provider never completes initialize", async () => {
  let aborted = false;
  const pool = new CuaDriverClientPool({
    closeTimeoutMs: 10,
    factory: {
      connect: (_lease, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
      }),
    },
  });
  const acquiring = pool.acquire(lease());
  await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  await pool.closeAll();
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 250);
  await assert.rejects(acquiring, /aborted|stale/);
});

test("pool drains active operations before aborting and closes the client exactly once", async () => {
  let aborted = false;
  let closes = 0;
  const pool = new CuaDriverClientPool({
    closeTimeoutMs: 50,
    factory: {
      connect: async (_lease, signal) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        return { close: () => { closes += 1; } };
      },
    },
  });
  const handle = await pool.acquire(lease());
  assert.equal(handle.signal.aborted, false);
  const closing = pool.closeAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, false);
  assert.equal(closes, 0);
  handle.release();
  await closing;
  assert.equal(aborted, true);
  assert.equal(handle.signal.aborted, true);
  assert.equal(closes, 1);
});

test("pool close stays bounded when connect ignores abort and closes a late client exactly once", async () => {
  let resolveConnect;
  let closes = 0;
  const pool = new CuaDriverClientPool({
    closeTimeoutMs: 10,
    factory: {
      connect: () => new Promise((resolve) => { resolveConnect = resolve; }),
    },
  });
  const acquiring = pool.acquire(lease());
  await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  await pool.closeAll();
  assert.ok(Date.now() - started < 250);
  resolveConnect({ close: () => { closes += 1; } });
  await assert.rejects(acquiring, /stale/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
});

test("activation finalizer rechecks the current lease and durable fence before committing", () => {
  let liveNow = "2026-07-18T00:00:00.000Z";
  const registry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
    now: () => liveNow,
  });
  const firstLease = lease();
  assert.equal(registry.publish(firstLease).accepted, true);
  let state = {
    pluginId: "trusted-local:cua-driver",
    requestedEnabled: true,
    requestedRevision: 4,
    activationEpoch: 7,
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
  const token = captureCuaDriverActivationFence(firstLease, state);
  const committedInputs = [];
  const store = {
    getCuaDriverActivationState: () => state,
    commitCuaDriverActivation: (input) => {
      committedInputs.push(input);
      return { committed: true, state };
    },
  };
  const projection = {
    pluginId: state.pluginId,
    mcpServerId: "mcp_cua_driver",
    now: "2026-07-18T00:00:00.000Z",
    requestedEnabled: true,
    requestedRevision: 4,
    activationEpoch: 7,
    effectiveEnabled: false,
    pluginEnabled: false,
    contributionEnabled: false,
    mcpServerEnabled: false,
    tools: [],
    statusSnapshot: null,
  };

  assert.equal(commitCurrentCuaDriverActivation({ store, leaseRegistry: registry, token, projection }).committed, true);
  assert.deepEqual(committedInputs[0].expected, { requestedRevision: 4, activationEpoch: 7 });

  state = { ...state, requestedRevision: 5 };
  assert.equal(commitCurrentCuaDriverActivation({ store, leaseRegistry: registry, token, projection }).committed, false);
  assert.equal(committedInputs.length, 1);

  state = { ...state, requestedRevision: 4 };
  assert.equal(registry.publish(lease({ generation: 2 })).accepted, true);
  assert.equal(commitCurrentCuaDriverActivation({ store, leaseRegistry: registry, token, projection }).committed, false);
  assert.equal(committedInputs.length, 1);

  const currentLease = lease({ generation: 2 });
  const currentToken = captureCuaDriverActivationFence(currentLease, state);
  liveNow = currentLease.expiresAt;
  assert.equal(
    commitCurrentCuaDriverActivation({
      store,
      leaseRegistry: registry,
      token: currentToken,
      projection: { ...projection, now: "2026-07-18T00:00:00.000Z" },
    }).committed,
    false,
    "a stale projection timestamp must not keep an expired lease current",
  );
  assert.equal(committedInputs.length, 1);
});
