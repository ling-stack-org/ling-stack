import assert from "node:assert/strict";
import test from "node:test";
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
