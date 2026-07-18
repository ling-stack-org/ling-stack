import assert from "node:assert/strict";
import test from "node:test";
import {
  captureCuaDriverActivationFence,
  commitCurrentCuaDriverActivation,
} from "../dist/features/plugins/cua-driver-activation-fence.js";
import { CuaDriverClientPool } from "../dist/features/plugins/cua-driver-client-pool.js";
import { CuaDriverLeaseRegistry, cuaDriverLeasePoolKey } from "../dist/features/plugins/cua-driver-lease.js";

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
    expiresAt: "2026-07-19T00:00:00.000Z",
    lockDigest: digest,
    providerSealDigest: "b".repeat(64),
    providerCatalogDigest: "c".repeat(64),
    platform: "darwin",
    architecture: "arm64",
    integrityCoverage: "standard",
    ...overrides,
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
  assert.equal(registry.publish(lease({ expiresAt: now })).reason, "expired");
  assert.equal(registry.publish(lease()).accepted, true);
  assert.equal(registry.renew(lease({ generation: 2 })).reason, "stale_generation");
  assert.equal(registry.renew(lease({ expiresAt: "2026-07-20T00:00:00.000Z" })).accepted, true);
  assert.equal(replaced.length, 0);
  assert.equal(registry.isCurrent(lease({ expiresAt: "2026-07-21T00:00:00.000Z" })), true);
  registry.clear();
  assert.deepEqual(replaced, [[1, undefined]]);
  assert.equal(registry.renew(lease()).reason, "expired");
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
  const closing = pool.closeAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, false);
  assert.equal(closes, 0);
  handle.release();
  await closing;
  assert.equal(aborted, true);
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
  const registry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd: "/tmp/ling-workspace",
    now: () => "2026-07-18T00:00:00.000Z",
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
});
