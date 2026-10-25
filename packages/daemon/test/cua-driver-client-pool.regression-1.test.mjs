import assert from "node:assert/strict";
import test from "node:test";
import { CuaDriverClientPool } from "../dist/features/plugins/cua-driver-client-pool.js";
import { CuaDriverDaemonActivationCoordinator } from "../dist/features/plugins/cua-driver-daemon-composition.js";
import { CuaDriverLeaseRegistry } from "../dist/features/plugins/cua-driver-lease.js";
import { createCuaDriverDescriptor } from "../dist/features/plugins/presets.js";

// Regression: R03 — lease retirement must not tear down accepted Host work during drain.
// Found by /qa on 2026-10-26
// Report: output/r03-host-lease-drain-20261026/qa-report.md
const lease = {
  schemaVersion: 1,
  providerId: "cua-driver",
  desktopInstanceId: "desktop-drain",
  desktopInstanceEpoch: 1,
  bridgeConnectionId: "bridge-drain",
  generation: 1,
  daemonAuthorityEpoch: "authority-drain",
  workspaceCwd: "/tmp/ling-host-lease-drain",
  endpoint: "http://127.0.0.1:43123/mcp",
  providerVersion: "0.8.3",
  distributionRevision: "ling.1",
  integrationMode: "embedded-stdio",
  expiresAt: "2026-10-26T00:01:00.000Z",
  lockDigest: "a".repeat(64),
  providerSealDigest: "b".repeat(64),
  providerCatalogDigest: "c".repeat(64),
  platform: "darwin",
  architecture: "arm64",
};

const tick = () => new Promise((resolve) => setImmediate(resolve));
const crossRetirementDeadline = () => new Promise((resolve) => setTimeout(resolve, 40));

for (const retirement of ["closeStale", "closeLease", "closeAll"]) {
  test(`Host drain defers ${retirement} without admitting new handles`, async () => {
    let connects = 0;
    let closes = 0;
    const pool = new CuaDriverClientPool({
      closeTimeoutMs: 10,
      factory: { connect: async () => {
        connects += 1;
        return { close() { closes += 1; } };
      } },
    });
    const handle = await pool.acquire(lease);
    pool.beginShutdown();
    await pool[retirement](retirement === "closeLease" ? lease : undefined);
    await crossRetirementDeadline();
    assert.equal(handle.signal.aborted, false);
    assert.equal(closes, 0);
    await assert.rejects(pool.acquire(lease), /cua_driver_client_pool_shutting_down/);
    assert.equal(connects, 1);
    handle.release();
    await pool.closeAll({ afterHostDrain: true });
    await pool.closeAll({ afterHostDrain: true });
    assert.equal(handle.signal.aborted, true);
    assert.equal(closes, 1);
    assert.equal(pool.size, 0);
    await assert.rejects(pool.acquire(lease), /cua_driver_client_pool_shutting_down/);
    assert.equal(connects, 1, "final cleanup must never reopen admission");
  });
}

test("Host drain interrupts an already waiting retirement without waiting on final shutdown", async () => {
  let closes = 0;
  const pool = new CuaDriverClientPool({
    closeTimeoutMs: 10,
    factory: { connect: async () => ({ close() { closes += 1; } }) },
  });
  const handle = await pool.acquire(lease);
  const retiring = pool.closeStale(undefined);
  assert.equal(pool.size, 0, "the retired entry has already left the live map");
  pool.beginShutdown();
  await retiring;
  await crossRetirementDeadline();
  assert.equal(handle.signal.aborted, false);
  assert.equal(closes, 0);
  handle.release();
  await pool.closeAll({ afterHostDrain: true });
  assert.equal(handle.signal.aborted, true);
  assert.equal(closes, 1, "final shutdown must include entries already removed from the live map");
});

test("Host drain rejects a late initialize but preserves its client until final shutdown", async () => {
  let resolveConnect;
  let connectSignal;
  let closes = 0;
  const pool = new CuaDriverClientPool({
    closeTimeoutMs: 10,
    factory: { connect: (_lease, signal) => {
      connectSignal = signal;
      return new Promise((resolve) => { resolveConnect = resolve; });
    } },
  });
  const acquiring = pool.acquire(lease);
  const rejected = assert.rejects(acquiring, /cua_driver_client_pool_shutting_down/);
  pool.beginShutdown();
  await pool.closeAll();
  resolveConnect({ close() { closes += 1; } });
  await rejected;
  await tick();
  assert.equal(connectSignal.aborted, false);
  assert.equal(closes, 0);
  await pool.closeAll({ afterHostDrain: true });
  assert.equal(connectSignal.aborted, true);
  assert.equal(closes, 1);
});

test("ordinary retirement remains bounded outside Host drain", async () => {
  let closes = 0;
  const pool = new CuaDriverClientPool({
    closeTimeoutMs: 10,
    factory: { connect: async () => ({ close() { closes += 1; } }) },
  });
  const handle = await pool.acquire(lease);
  await pool.closeStale(undefined);
  assert.equal(handle.signal.aborted, true);
  assert.equal(closes, 1);
  handle.release();
});

for (const failProjection of [false, true]) {
  test(`coordinator keeps durable retirement fenced during Host drain (projection failure=${failProjection})`, async () => {
    let coordinator;
    let fail = false;
    let invalidations = 0;
    let reconciles = 0;
    let closes = 0;
    const pool = new CuaDriverClientPool({
      closeTimeoutMs: 10,
      factory: { connect: async () => ({ close() { closes += 1; } }) },
    });
    const registry = new CuaDriverLeaseRegistry({
      daemonAuthorityEpoch: lease.daemonAuthorityEpoch,
      workspaceCwd: lease.workspaceCwd,
      now: () => "2026-10-26T00:00:00.000Z",
      onReplaced: (_previous, next) => coordinator?.handleLeaseChanged(next),
    });
    coordinator = new CuaDriverDaemonActivationCoordinator({
      workspaceCwd: lease.workspaceCwd,
      storeRegistry: { getStore: () => ({}) },
      descriptor: createCuaDriverDescriptor(),
      leaseRegistry: registry,
      activationService: {
        invalidateForLeaseChange() {
          invalidations += 1;
          return { committed: !fail };
        },
        async reconcileRequestedIntent() { reconciles += 1; },
      },
      clientPool: pool,
    });
    assert.equal(registry.publish(lease).accepted, true);
    coordinator.handleLeasePublished(lease);
    await tick();
    assert.equal(reconciles, 1);
    const handle = await pool.acquire(lease);
    coordinator.beginShutdown();
    fail = failProjection;
    registry.clear();
    await crossRetirementDeadline();
    assert.equal(registry.isCurrent(lease), false, "drain must not revive expired authority");
    assert.ok(invalidations >= 2, "durable retirement must still be attempted");
    assert.equal(reconciles, 1, "drain must not start a replacement activation");
    assert.equal(handle.signal.aborted, false);
    assert.equal(closes, 0);
    await assert.rejects(pool.acquire(lease), /cua_driver_client_pool_shutting_down/);
    handle.release();
    await coordinator.shutdown();
    assert.equal(handle.signal.aborted, true);
    assert.equal(closes, 1);
  });
}
