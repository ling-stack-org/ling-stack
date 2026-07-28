import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import {
  CuaDriverDaemonActivationCoordinator,
  CuaDriverLeaseRegistry,
  createDaemonServer,
} from "../dist/index.js";
import {
  createBundledCuaDriverLogicalMcpServerInput,
  createCuaDriverDescriptor,
  createCuaDriverMcpServerInput,
} from "../dist/features/plugins/presets.js";

const supportedPlatform = process.platform === "darwin" || process.platform === "win32";
const desktopToken = "desktop-composition-token-0123456789";
const bridgeHeader = "X-Ling-Desktop-Bridge-Token";

test("bundled daemon resets persisted effective state before listening", {
  skip: !supportedPlatform,
}, async () => {
  const fixture = await daemonFixture({ seedReady: true });
  try {
    assert.equal(fixture.store.getMcpServer("mcp_cua_driver").enabled, true);
    assert.equal(fixture.store.listMcpTools({ serverId: "mcp_cua_driver" }).length, 1);

    await fixture.daemon.start();

    const state = fixture.store.getCuaDriverActivationState("trusted-local:cua-driver");
    assert.equal(state.requestedEnabled, true);
    assert.equal(state.requestedRevision, 1);
    assert.equal(state.activationEpoch, 2);
    assert.equal(fixture.store.getManagedPlugin("trusted-local:cua-driver").enabled, false);
    assert.equal(fixture.store.getMcpServer("mcp_cua_driver").enabled, false);
    assert.equal(fixture.store.listMcpTools({ serverId: "mcp_cua_driver" }).length, 0);
    assert.equal(
      fixture.store.getManagedPluginHealthSnapshot("trusted-local:cua-driver").details.providerState,
      "desktop_unavailable",
    );
  } finally {
    await fixture.close();
  }
});

test("startup reset failure rejects before the daemon binds its port", {
  skip: !supportedPlatform,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-startup-reset-fail-"));
  const store = createSqliteRunStore(cwd);
  const failingStore = new Proxy(store, {
    get(target, property) {
      if (property === "commitCuaDriverActivation") {
        return () => ({ committed: false });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const daemon = createDaemonServer(
    bundledConfig(cwd),
    {
      desktopBridgeToken: desktopToken,
      computerUseRouteToken: desktopToken,
      storeFactory: () => failingStore,
      cuaDriverLeaseClientFactory: fakeLeaseFactory(),
    },
  );
  try {
    await assert.rejects(daemon.start(), /cua_driver_startup_reset_stale/);
    assert.equal(daemon.server.address(), null);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("lease publication rejects authority and retries after a durable projection failure", async () => {
  let invalidations = 0;
  let reconciles = 0;
  let closeStaleCalls = 0;
  let closeAllCalls = 0;
  const workspaceCwd = "/tmp/ling-cua-projection-retry";
  const leaseRegistry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-retry",
    workspaceCwd,
  });
  const coordinator = new CuaDriverDaemonActivationCoordinator({
    workspaceCwd,
    storeRegistry: { getStore: () => ({}) },
    descriptor: createCuaDriverDescriptor(),
    leaseRegistry,
    activationService: {
      invalidateForLeaseChange() {
        invalidations += 1;
        if (invalidations === 1) throw new Error("fixture projection write failed");
        return { committed: true };
      },
      async reconcileRequestedIntent() {
        reconciles += 1;
      },
    },
    clientPool: {
      async closeStale() { closeStaleCalls += 1; },
      async closeAll() { closeAllCalls += 1; },
    },
  });
  const currentLease = lease({
    desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-retry",
    daemonAuthorityEpoch: "authority-retry",
  }, workspaceCwd);

  assert.equal(leaseRegistry.publish(currentLease).accepted, true);
  assert.equal(coordinator.handleLeasePublished(currentLease), false);
  assert.equal(leaseRegistry.getCurrent(), undefined);

  assert.equal(leaseRegistry.publish(currentLease).accepted, true);
  assert.equal(coordinator.handleLeasePublished(currentLease), true);
  await waitFor(() => reconciles === 1);

  assert.equal(invalidations, 3);
  assert.equal(closeStaleCalls, 1);
  assert.equal(closeAllCalls, 1);
});

test("availability projection is sequence-fenced and reprojects only the current report", () => {
  const workspaceCwd = "/tmp/ling-cua-availability-sequence";
  const leaseRegistry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-availability",
    workspaceCwd,
  });
  let currentAvailability = availability({
    workspaceCwd,
    daemonAuthorityEpoch: "authority-availability",
    sequence: 1,
  });
  const projected = [];
  const coordinator = new CuaDriverDaemonActivationCoordinator({
    workspaceCwd,
    storeRegistry: { getStore: () => ({}) },
    descriptor: createCuaDriverDescriptor(),
    leaseRegistry,
    getDesktopAvailability: () => currentAvailability,
    activationService: {
      invalidateForLeaseChange(input) {
        projected.push(input.availability);
        return { committed: true };
      },
      async reconcileRequestedIntent() {},
    },
    clientPool: {
      async closeStale() {},
      async closeAll() {},
    },
  });

  assert.equal(coordinator.handleAvailabilityPublished(currentAvailability), true);
  assert.equal(coordinator.handleAvailabilityPublished(currentAvailability), true);
  assert.equal(projected.length, 1, "same sequence is a harmless route retry");

  const stale = { ...currentAvailability, sequence: 0 };
  assert.equal(coordinator.handleAvailabilityPublished(stale), false);
  assert.equal(projected.length, 1);

  currentAvailability = { ...currentAvailability, sequence: 2, providerState: "permission_required" };
  assert.equal(coordinator.handleAvailabilityPublished(currentAvailability), true);
  assert.equal(projected.length, 2);
  assert.equal(projected[1].providerState, "permission_required");
});

test("failed retirement projection cannot let a same-generation renewal bypass the fence", async () => {
  const workspaceCwd = "/tmp/ling-cua-retirement-retry";
  const leaseRegistry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-retirement",
    workspaceCwd,
  });
  let invalidations = 0;
  let reconciles = 0;
  const coordinator = new CuaDriverDaemonActivationCoordinator({
    workspaceCwd,
    storeRegistry: { getStore: () => ({}) },
    descriptor: createCuaDriverDescriptor(),
    leaseRegistry,
    activationService: {
      invalidateForLeaseChange() {
        invalidations += 1;
        return { committed: invalidations !== 2 && invalidations !== 3 };
      },
      async reconcileRequestedIntent() { reconciles += 1; },
    },
    clientPool: {
      async closeStale() {},
      async closeAll() {},
    },
  });
  const currentLease = lease({
    desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-retirement",
    daemonAuthorityEpoch: "authority-retirement",
  }, workspaceCwd);

  assert.equal(leaseRegistry.publish(currentLease).accepted, true);
  assert.equal(coordinator.handleLeasePublished(currentLease), true);
  await waitFor(() => reconciles === 1);

  leaseRegistry.clear();
  assert.equal(coordinator.handleLeaseChanged(undefined), false);
  assert.equal(invalidations, 3);

  const renewed = {
    ...currentLease,
    expiresAt: new Date(Date.parse(currentLease.expiresAt) + 30_000).toISOString(),
  };
  assert.equal(leaseRegistry.publish(renewed).accepted, true);
  assert.equal(coordinator.handleLeasePublished(renewed), true);
  await waitFor(() => reconciles === 2);
  assert.equal(invalidations, 4, "same-generation recovery must run a fresh durable fence");
});

test("lease retirement retries its durable projection after storage recovers", async () => {
  const workspaceCwd = "/tmp/ling-cua-retirement-background-retry";
  let coordinator;
  let failProjection = false;
  let invalidations = 0;
  let reconciles = 0;
  let closeAllCalls = 0;
  const leaseRegistry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-background-retry",
    workspaceCwd,
    onReplaced: (_previous, next) => {
      coordinator?.handleLeaseChanged(next);
    },
  });
  coordinator = new CuaDriverDaemonActivationCoordinator({
    workspaceCwd,
    storeRegistry: { getStore: () => ({}) },
    descriptor: createCuaDriverDescriptor(),
    leaseRegistry,
    activationService: {
      invalidateForLeaseChange() {
        invalidations += 1;
        return { committed: !failProjection };
      },
      async reconcileRequestedIntent() { reconciles += 1; },
    },
    clientPool: {
      async closeStale() {},
      async closeAll() { closeAllCalls += 1; },
    },
  });
  const currentLease = lease({
    desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-background-retry",
    daemonAuthorityEpoch: "authority-background-retry",
  }, workspaceCwd);

  try {
    assert.equal(leaseRegistry.publish(currentLease).accepted, true);
    assert.equal(coordinator.handleLeasePublished(currentLease), true);
    await waitFor(() => reconciles === 1);

    failProjection = true;
    leaseRegistry.clear();
    assert.equal(leaseRegistry.getCurrent(), undefined);
    assert.equal(invalidations, 3, "retirement performs the synchronous attempt plus post-clear retry");

    failProjection = false;
    await waitFor(() => invalidations >= 4);
    assert.ok(closeAllCalls >= 1);
  } finally {
    await coordinator.shutdown();
  }
});

test("lease route returns 503 and clears the accepted lease when projection CAS cannot commit", {
  skip: !supportedPlatform,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-projection-cas-fail-"));
  const store = createSqliteRunStore(cwd);
  let failProjection = false;
  const guardedStore = new Proxy(store, {
    get(target, property) {
      if (property === "commitCuaDriverActivation" && failProjection) {
        return () => ({
          committed: false,
          state: target.getCuaDriverActivationState("trusted-local:cua-driver"),
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const daemon = createDaemonServer(bundledConfig(cwd), {
    desktopBridgeToken: desktopToken,
    computerUseRouteToken: desktopToken,
    storeFactory: () => guardedStore,
    cuaDriverLeaseClientFactory: fakeLeaseFactory(),
  });
  let started = false;
  try {
    await daemon.start();
    started = true;
    const authority = await handshake(daemon);
    const currentLease = lease(authority, cwd);

    failProjection = true;
    const rejected = await putLease(daemon, currentLease);
    assert.equal(rejected.status, 503);
    assert.equal(
      (await rejected.json()).error,
      "cua_driver_activation_projection_unavailable",
    );

    failProjection = false;
    const enableWithoutLease = await pluginAction(
      daemon,
      cwd,
      "trusted-local:cua-driver",
      "enable",
    );
    assert.equal(enableWithoutLease.status, 202);
    assert.equal((await enableWithoutLease.json()).error, "cua_desktop_lease_unavailable");

    assert.equal((await putLease(daemon, currentLease)).status, 200);
    await waitFor(() => store.getMcpServer("mcp_cua_driver")?.enabled === true);
  } finally {
    failProjection = false;
    if (started) await daemon.stop();
    else store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("lease revoke returns 503 until its durable projection can be retried", {
  skip: !supportedPlatform,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-revoke-projection-cas-fail-"));
  const store = createSqliteRunStore(cwd);
  let failProjection = false;
  const guardedStore = new Proxy(store, {
    get(target, property) {
      if (property === "commitCuaDriverActivation" && failProjection) {
        return () => ({
          committed: false,
          state: target.getCuaDriverActivationState("trusted-local:cua-driver"),
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const daemon = createDaemonServer(bundledConfig(cwd), {
    desktopBridgeToken: desktopToken,
    computerUseRouteToken: desktopToken,
    storeFactory: () => guardedStore,
    cuaDriverLeaseClientFactory: fakeLeaseFactory(),
  });
  let started = false;
  try {
    await daemon.start();
    started = true;
    const authority = await handshake(daemon);
    const currentLease = lease(authority, cwd);
    const enable = await pluginAction(
      daemon,
      cwd,
      "trusted-local:cua-driver",
      "enable",
    );
    assert.equal(enable.status, 202);
    assert.equal((await enable.json()).error, "cua_desktop_lease_unavailable");
    assert.equal((await putLease(daemon, currentLease)).status, 200);
    await waitFor(() => store.getMcpServer("mcp_cua_driver")?.enabled === true);

    failProjection = true;
    const failed = await deleteLease(daemon, currentLease);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), {
      revoked: true,
      error: "cua_driver_activation_projection_unavailable",
      message: "The lease was revoked, but the daemon could not clear stale Cua Driver activation state.",
    });
    assert.equal(store.getMcpServer("mcp_cua_driver").enabled, true);
    assert.equal(store.listMcpTools({ serverId: "mcp_cua_driver" }).length, 1);

    failProjection = false;
    const recovered = await deleteLease(daemon, currentLease);
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).revoked, true);
    assert.equal(store.getMcpServer("mcp_cua_driver").enabled, false);
    assert.equal(store.listMcpTools({ serverId: "mcp_cua_driver" }).length, 0);
  } finally {
    failProjection = false;
    if (started) await daemon.stop();
    else store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("availability route atomically revokes the live lease and clears SQLite effective state", {
  skip: !supportedPlatform,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-availability-sqlite-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer(bundledConfig(cwd), {
    desktopBridgeToken: desktopToken,
    computerUseRouteToken: desktopToken,
    storeFactory: () => store,
    cuaDriverLeaseClientFactory: fakeLeaseFactory(),
  });
  let started = false;
  try {
    await daemon.start();
    started = true;
    const authority = await handshake(daemon);
    const currentLease = lease(authority, cwd);

    const requested = await pluginAction(
      daemon,
      cwd,
      "trusted-local:cua-driver",
      "enable",
    );
    assert.equal(requested.status, 202);
    assert.equal((await requested.json()).error, "cua_desktop_lease_unavailable");
    assert.equal((await putLease(daemon, currentLease)).status, 200);
    await waitFor(() => store.getMcpServer("mcp_cua_driver")?.enabled === true);
    assert.equal(store.getManagedPlugin("trusted-local:cua-driver").enabled, true);
    assert.equal(store.listManagedPluginContributions("trusted-local:cua-driver")[0].enabled, true);
    assert.equal(store.listMcpTools({ serverId: "mcp_cua_driver" }).length, 1);

    const unavailable = desktopAvailability(authority, cwd, {
      generation: currentLease.generation,
      providerState: "corrupt",
      reason: "provider_seal_mismatch",
    });
    const response = await putAvailability(daemon, unavailable);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      accepted: true,
      desktopInstanceEpoch: authority.desktopInstanceEpoch,
      generation: currentLease.generation,
      sequence: 1,
      providerState: "corrupt",
    });

    const state = store.getCuaDriverActivationState("trusted-local:cua-driver");
    assert.equal(state.requestedEnabled, true);
    assert.equal(store.getManagedPlugin("trusted-local:cua-driver").enabled, false);
    assert.equal(store.listManagedPluginContributions("trusted-local:cua-driver")[0].enabled, false);
    assert.equal(store.getMcpServer("mcp_cua_driver").enabled, false);
    assert.deepEqual(store.listMcpTools({ serverId: "mcp_cua_driver" }), []);
    const health = store.getManagedPluginHealthSnapshot("trusted-local:cua-driver");
    assert.equal(health.details.providerState, "corrupt");
    assert.equal(health.details.errorCode, "cua_embedded_artifact_invalid");
    assert.equal(health.details.reason, "provider_seal_mismatch");
  } finally {
    if (started) await daemon.stop();
    else store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("availability route retries the identical authenticated report after SQLite projection recovers", {
  skip: !supportedPlatform,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-availability-retry-"));
  const store = createSqliteRunStore(cwd);
  let failProjection = false;
  const guardedStore = new Proxy(store, {
    get(target, property) {
      if (property === "commitCuaDriverActivation" && failProjection) {
        return () => ({
          committed: false,
          state: target.getCuaDriverActivationState("trusted-local:cua-driver"),
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const daemon = createDaemonServer(bundledConfig(cwd), {
    desktopBridgeToken: desktopToken,
    computerUseRouteToken: desktopToken,
    storeFactory: () => guardedStore,
    cuaDriverLeaseClientFactory: fakeLeaseFactory(),
  });
  let started = false;
  try {
    await daemon.start();
    started = true;
    const authority = await handshake(daemon);
    const report = desktopAvailability(authority, cwd, {
      providerState: "permission_required",
      reason: "darwin_accessibility_permission_required",
    });
    await pluginAction(daemon, cwd, "trusted-local:cua-driver", "enable");

    failProjection = true;
    const failed = await putAvailability(daemon, report);
    assert.equal(failed.status, 503);
    assert.equal(
      (await failed.json()).error,
      "cua_driver_activation_projection_unavailable",
    );

    failProjection = false;
    const retried = await putAvailability(daemon, report);
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).providerState, "permission_required");
    assert.equal(
      store.getManagedPluginHealthSnapshot("trusted-local:cua-driver").details.errorCode,
      "cua_embedded_permission_required",
    );
  } finally {
    failProjection = false;
    if (started) await daemon.stop();
    else store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gate-off lease publication leaves the enabled external Cua projection untouched", {
  skip: !supportedPlatform,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-gate-off-external-"));
  const store = createSqliteRunStore(cwd);
  seedExternalReadyState(store);
  const stats = { connects: [], closes: 0 };
  const daemon = createDaemonServer(
    externalConfig(cwd),
    {
      desktopBridgeToken: desktopToken,
      computerUseRouteToken: desktopToken,
      storeFactory: () => store,
      cuaDriverLeaseClientFactory: fakeLeaseFactory(stats),
    },
  );
  let started = false;
  try {
    await daemon.start();
    started = true;
    const authority = await handshake(daemon);
    assert.equal((await putLease(daemon, lease(authority, cwd))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const plugin = store.getManagedPlugin("trusted-local:cua-driver");
    const server = store.getMcpServer("mcp_cua_driver");
    const contribution = store.listManagedPluginContributions("trusted-local:cua-driver")[0];
    assert.equal(plugin.enabled, true);
    assert.equal(server.enabled, true);
    assert.equal(server.transport.type, "stdio");
    assert.equal(contribution.enabled, true);
    assert.equal(store.listMcpTools({ serverId: server.id }).length, 1);
    assert.equal(store.getCuaDriverActivationState("trusted-local:cua-driver"), undefined);
    assert.equal(stats.connects.length, 0);
    assert.equal(stats.closes, 0);
  } finally {
    if (started) {
      await daemon.stop();
    } else {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("gate-off restart quarantines and ignores a persisted bundled projection", {
  skip: !supportedPlatform,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-on-off-restart-"));
  const persistedStore = createSqliteRunStore(cwd);
  seedReadyState(persistedStore);
  assert.equal(persistedStore.getMcpServer("mcp_cua_driver").enabled, true);
  assert.equal(persistedStore.listMcpTools({ serverId: "mcp_cua_driver" }).length, 1);
  assert.equal(persistedStore.getMcpStatusSnapshot("mcp_cua_driver").status, "ready");
  persistedStore.close();

  let secondStore;
  let secondDaemon;
  try {
    secondStore = createSqliteRunStore(cwd);
    assert.equal(secondStore.getCuaDriverActivationState("trusted-local:cua-driver").requestedEnabled, true);
    assert.equal(secondStore.getMcpServer("mcp_cua_driver").enabled, true);
    assert.equal(secondStore.getMcpStatusSnapshot("mcp_cua_driver").status, "ready");

    secondDaemon = createDaemonServer(externalConfig(cwd), {
      desktopBridgeToken: desktopToken,
      computerUseRouteToken: desktopToken,
      storeFactory: () => secondStore,
      cuaDriverLeaseClientFactory: fakeLeaseFactory(),
    });
    await secondDaemon.start();

    const staleServer = secondStore.getMcpServer("mcp_cua_driver");
    assert.equal(staleServer.transport.type, "streamable-http");
    assert.equal(staleServer.enabled, false);
    assert.equal(secondStore.listMcpTools({ serverId: "mcp_cua_driver" }).length, 0);
    assert.notEqual(secondStore.getMcpStatusSnapshot("mcp_cua_driver").status, "ready");
    assert.equal(
      secondStore.getManagedPluginHealthSnapshot("trusted-local:cua-driver").details.providerState,
      "desktop_unavailable",
    );

    const previewResponse = await pluginRuntimePreview(
      secondDaemon,
      cwd,
      "trusted-local:cua-driver",
    );
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).preview;
    assert.notEqual(preview.status, "injectable");
    assert.ok(preview.blockers.includes("Plugin package is not installed."));

    const viewResponse = await pluginView(secondDaemon, cwd, "trusted-local:cua-driver");
    assert.equal(viewResponse.status, 200);
    assert.notEqual((await viewResponse.json()).plugin.setup?.distribution, "bundled_embedded");
  } finally {
    if (secondDaemon?.server.listening) {
      await secondDaemon.stop();
    } else {
      secondStore?.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("enable retains intent, first lease reconciles once, renewal is inert, and revoke fences immediately", {
  skip: !supportedPlatform,
}, async () => {
  const fixture = await daemonFixture();
  await fixture.daemon.start();
  try {
    const enable = await pluginAction(fixture.daemon, fixture.cwd, "trusted-local:cua-driver", "enable");
    assert.equal(enable.status, 202);
    const enableBody = await enable.json();
    assert.equal(enableBody.error, "cua_desktop_lease_unavailable");
    assert.equal(enableBody.plugin.setup.requestedEnabled, true);
    assert.equal(enableBody.plugin.setup.effectiveEnabled, false);
    assert.equal(enableBody.plugin.setup.providerState, "desktop_unavailable");
    assert.equal(enableBody.plugin.actions.canEnable, false);
    assert.equal(enableBody.plugin.actions.canDisable, true);
    assert.equal(enableBody.plugin.actions.canApplyPreset, false);

    const authority = await handshake(fixture.daemon);
    const firstLease = lease(authority, fixture.cwd);
    const published = await putLease(fixture.daemon, firstLease);
    assert.equal(published.status, 200);
    await waitFor(() => fixture.store.getMcpServer("mcp_cua_driver")?.enabled === true);
    assert.equal(fixture.connects.length, 1);
    assert.equal(fixture.store.listMcpTools({ serverId: "mcp_cua_driver" }).length, 1);
    const readyEpoch = fixture.store.getCuaDriverActivationState("trusted-local:cua-driver").activationEpoch;

    const renewed = await putLease(fixture.daemon, {
      ...firstLease,
      expiresAt: new Date(Date.parse(firstLease.expiresAt) + 30_000).toISOString(),
    });
    assert.equal(renewed.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fixture.connects.length, 1);
    assert.equal(
      fixture.store.getCuaDriverActivationState("trusted-local:cua-driver").activationEpoch,
      readyEpoch,
    );

    const genericSync = await fetch(
      daemonUrl(fixture.daemon, `/mcp/servers/mcp_cua_driver/sync-tools?cwd=${encodeURIComponent(fixture.cwd)}`),
      { method: "POST" },
    );
    assert.equal(genericSync.status, 409);
    assert.equal((await genericSync.json()).error, "cua_driver_activation_route_required");

    const revoked = await deleteLease(fixture.daemon, firstLease);
    assert.equal(revoked.status, 200);
    assert.equal(fixture.store.getMcpServer("mcp_cua_driver").enabled, false);
    assert.equal(fixture.store.listMcpTools({ serverId: "mcp_cua_driver" }).length, 0);
    assert.equal(
      fixture.store.getManagedPluginHealthSnapshot("trusted-local:cua-driver").details.providerState,
      "desktop_unavailable",
    );
    await waitFor(() => fixture.closes === 1);
  } finally {
    await fixture.close();
  }
});

test("first lease publish responds before retained-intent activation readiness completes", {
  skip: !supportedPlatform,
}, async () => {
  const checkStarted = deferred();
  const releaseCheck = deferred();
  const fixture = await daemonFixture({
    leaseClientOptions: {
      async check(currentServer, checkedAt) {
        checkStarted.resolve();
        await releaseCheck.promise;
        return { statusSnapshot: readyStatus(currentServer.id, checkedAt, 0) };
      },
    },
  });
  await fixture.daemon.start();
  try {
    const enable = await pluginAction(
      fixture.daemon,
      fixture.cwd,
      "trusted-local:cua-driver",
      "enable",
    );
    assert.equal(enable.status, 202);

    const authority = await handshake(fixture.daemon);
    const firstLease = lease(authority, fixture.cwd);
    const publishing = putLease(fixture.daemon, firstLease);
    await checkStarted.promise;

    const published = await settleWithin(publishing, 1_000);
    assert.ok(published, "lease PUT must not wait for provider readiness");
    assert.equal(published.status, 200);
    assert.equal(fixture.store.getMcpServer("mcp_cua_driver").enabled, false);

    releaseCheck.resolve();
    await waitFor(() => fixture.store.getMcpServer("mcp_cua_driver")?.enabled === true);
  } finally {
    releaseCheck.resolve();
    await fixture.close();
  }
});

for (const retirement of ["expiry", "revoke"]) {
  test(`${retirement} aborts a hung generation operation and closes its client once`, {
    skip: !supportedPlatform,
  }, async () => {
    const checkStarted = deferred();
    const checkAborted = deferred();
    const deadline = retirement === "expiry" ? manualDeadlineScheduler() : undefined;
    const fixture = await daemonFixture({
      leaseScheduleDeadline: deadline?.schedule,
      leaseClientOptions: {
        check(currentServer, checkedAt, signal) {
          checkStarted.resolve();
          return rejectWhenAborted(signal, checkAborted).then(() => ({
            statusSnapshot: readyStatus(currentServer.id, checkedAt, 0),
          }));
        },
      },
    });
    await fixture.daemon.start();
    try {
      const enable = await pluginAction(
        fixture.daemon,
        fixture.cwd,
        "trusted-local:cua-driver",
        "enable",
      );
      assert.equal(enable.status, 202);

      const authority = await handshake(fixture.daemon);
      const currentLease = lease(authority, fixture.cwd);
      const published = await putLease(fixture.daemon, currentLease);
      assert.equal(published.status, 200);
      await checkStarted.promise;

      if (retirement === "expiry") {
        deadline.fire();
      } else {
        const revoked = await deleteLease(fixture.daemon, currentLease);
        assert.equal(revoked.status, 200);
      }

      await settleWithinRequired(checkAborted.promise, 2_000, `${retirement} did not abort the active generation`);
      await waitFor(() => fixture.closes === 1);
      assert.equal(fixture.store.getMcpServer("mcp_cua_driver").enabled, false);
      assert.equal(fixture.store.listMcpTools({ serverId: "mcp_cua_driver" }).length, 0);
      assert.equal(
        fixture.store.getManagedPluginHealthSnapshot("trusted-local:cua-driver").details.providerState,
        "desktop_unavailable",
      );
    } finally {
      await fixture.close();
    }
  });
}

test("daemon shutdown closes one active bundled lease client exactly once", {
  skip: !supportedPlatform,
}, async () => {
  const fixture = await daemonFixture();
  let closed = false;
  await fixture.daemon.start();
  try {
    const enable = await pluginAction(
      fixture.daemon,
      fixture.cwd,
      "trusted-local:cua-driver",
      "enable",
    );
    assert.equal(enable.status, 202);
    const authority = await handshake(fixture.daemon);
    const currentLease = lease(authority, fixture.cwd);
    assert.equal((await putLease(fixture.daemon, currentLease)).status, 200);
    await waitFor(() => fixture.store.getMcpServer("mcp_cua_driver")?.enabled === true);

    await fixture.close();
    closed = true;
    assert.equal(fixture.closes, 1);
  } finally {
    if (!closed) {
      await fixture.close();
    }
  }
});

test("daemon restart aborts in-flight activation and keeps tools hidden until a fresh lease is ready", {
  skip: !supportedPlatform,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-daemon-restart-race-"));
  const firstStore = createSqliteRunStore(cwd);
  const checkStarted = deferred();
  const checkAborted = deferred();
  const firstStats = { connects: [], closes: 0 };
  const firstDaemon = createDaemonServer(bundledConfig(cwd), {
    desktopBridgeToken: desktopToken,
    computerUseRouteToken: desktopToken,
    storeFactory: () => firstStore,
    cuaDriverLeaseClientFactory: fakeLeaseFactory(firstStats, {
      check(currentServer, checkedAt, signal) {
        checkStarted.resolve();
        return rejectWhenAborted(signal, checkAborted).then(() => ({
          statusSnapshot: readyStatus(currentServer.id, checkedAt, 0),
        }));
      },
    }),
  });
  let firstStarted = false;
  let firstStopped = false;
  let secondDaemon;
  let secondStore;
  try {
    await firstDaemon.start();
    firstStarted = true;
    assert.equal(
      (await pluginAction(firstDaemon, cwd, "trusted-local:cua-driver", "enable")).status,
      202,
    );
    const firstAuthority = await handshake(firstDaemon);
    assert.equal((await putLease(firstDaemon, lease(firstAuthority, cwd))).status, 200);
    await checkStarted.promise;

    await firstDaemon.stop();
    firstStarted = false;
    firstStopped = true;
    await settleWithinRequired(
      checkAborted.promise,
      2_000,
      "daemon shutdown did not abort the in-flight activation",
    );
    assert.equal(firstStats.closes, 1);

    secondStore = createSqliteRunStore(cwd);
    const secondStats = { connects: [], closes: 0 };
    secondDaemon = createDaemonServer(bundledConfig(cwd), {
      desktopBridgeToken: desktopToken,
      computerUseRouteToken: desktopToken,
      storeFactory: () => secondStore,
      cuaDriverLeaseClientFactory: fakeLeaseFactory(secondStats),
    });
    await secondDaemon.start();

    const resetState = secondStore.getCuaDriverActivationState("trusted-local:cua-driver");
    assert.equal(resetState.requestedEnabled, true);
    assert.equal(secondStore.getMcpServer("mcp_cua_driver").enabled, false);
    assert.equal(secondStore.listMcpTools({ serverId: "mcp_cua_driver" }).length, 0);
    assert.equal(
      secondStore.getManagedPluginHealthSnapshot("trusted-local:cua-driver").details.providerState,
      "desktop_unavailable",
    );

    const secondAuthority = await handshake(secondDaemon);
    assert.equal((await putLease(secondDaemon, lease(secondAuthority, cwd))).status, 200);
    await waitFor(() => secondStore.getMcpServer("mcp_cua_driver")?.enabled === true);
    assert.equal(secondStats.connects.length, 1);
    assert.equal(secondStore.listMcpTools({ serverId: "mcp_cua_driver" }).length, 1);
  } finally {
    if (firstStarted) {
      await firstDaemon.stop();
    } else if (!firstStopped) {
      firstStore.close();
    }
    if (secondDaemon?.server.listening) {
      await secondDaemon.stop();
    } else {
      secondStore?.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("missing Desktop bridge token does not block daemon startup and bundled activation stays fail-closed", {
  skip: !supportedPlatform,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-missing-desktop-token-"));
  const previousToken = process.env.LING_DESKTOP_BRIDGE_TOKEN;
  delete process.env.LING_DESKTOP_BRIDGE_TOKEN;
  const daemon = createDaemonServer(bundledConfig(cwd), {
    computerUseRouteToken: "computer-use-route-only-token",
  });
  let started = false;
  try {
    await daemon.start();
    started = true;

    const enable = await pluginAction(
      daemon,
      cwd,
      "trusted-local:cua-driver",
      "enable",
    );
    assert.equal(enable.status, 202);
    const enableBody = await enable.json();
    assert.equal(enableBody.error, "cua_desktop_lease_unavailable");
    assert.equal(enableBody.plugin.setup.requestedEnabled, true);
    assert.equal(enableBody.plugin.setup.effectiveEnabled, false);

    const leaseRoute = await fetch(
      daemonUrl(daemon, `/desktop/capabilities/cua-driver/lease?cwd=${encodeURIComponent(cwd)}`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", [bridgeHeader]: desktopToken },
        body: JSON.stringify({}),
      },
    );
    assert.equal(leaseRoute.status, 503);
    assert.equal((await leaseRoute.json()).error, "desktop_bridge_unavailable");
  } finally {
    if (started) {
      await daemon.stop();
    }
    if (previousToken === undefined) delete process.env.LING_DESKTOP_BRIDGE_TOKEN;
    else process.env.LING_DESKTOP_BRIDGE_TOKEN = previousToken;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bundled plugin routes reject other workspaces and every hidden compatibility action", {
  skip: !supportedPlatform,
}, async () => {
  const fixture = await daemonFixture();
  await fixture.daemon.start();
  const otherCwd = await mkdtemp(join(tmpdir(), "ling-cua-other-workspace-"));
  try {
    const wrongWorkspace = await pluginAction(
      fixture.daemon,
      otherCwd,
      "trusted-local:cua-driver",
      "enable",
    );
    assert.equal(wrongWorkspace.status, 409);
    assert.equal((await wrongWorkspace.json()).error, "cua_driver_workspace_mismatch");

    for (const action of ["check", "install", "uninstall", "refresh-package"]) {
      const hidden = await pluginAction(
        fixture.daemon,
        fixture.cwd,
        "bundled:cua-driver",
        action,
      );
      assert.equal(hidden.status, 409, action);
      assert.equal(
        (await hidden.json()).error,
        "cua_driver_compatibility_record_hidden",
        action,
      );
    }
  } finally {
    await fixture.close();
    await rm(otherCwd, { recursive: true, force: true });
  }
});

test("gate-on canonical Cua Driver rejects package mutators and keeps its read-only view", {
  skip: !supportedPlatform,
}, async () => {
  const fixture = await daemonFixture();
  await fixture.daemon.start();
  try {
    const view = await pluginView(
      fixture.daemon,
      fixture.cwd,
      "trusted-local:cua-driver",
    );
    assert.equal(view.status, 200);

    for (const action of [
      "connect",
      "apply-preset",
      "validate-package",
      "install",
      "uninstall",
      "refresh-package",
      "runtime-preview",
    ]) {
      const response = await pluginAction(
        fixture.daemon,
        fixture.cwd,
        "trusted-local:cua-driver",
        action,
      );
      assert.equal(response.status, 409, action);
      assert.equal(
        (await response.json()).error,
        "cua_driver_bundled_action_forbidden",
        action,
      );
    }
  } finally {
    await fixture.close();
  }
});

for (const operation of ["enable", "check"]) {
  test(`canonical uninstall cannot race an in-flight bundled ${operation} into publishing tools`, {
    skip: !supportedPlatform,
  }, async () => {
    const checkStarted = deferred();
    const releaseCheck = deferred();
    let checkCalls = 0;
    const fixture = await daemonFixture({
      leaseClientOptions: {
        async check(currentServer, checkedAt) {
          checkCalls += 1;
          if (operation === "enable" || checkCalls > 1) {
            checkStarted.resolve();
            await releaseCheck.promise;
          }
          return { statusSnapshot: readyStatus(currentServer.id, checkedAt, 0) };
        },
      },
    });
    await fixture.daemon.start();
    let inFlightCheck;
    try {
      assert.equal(
        (await pluginAction(
          fixture.daemon,
          fixture.cwd,
          "trusted-local:cua-driver",
          "enable",
        )).status,
        202,
      );
      const authority = await handshake(fixture.daemon);
      assert.equal((await putLease(fixture.daemon, lease(authority, fixture.cwd))).status, 200);

      if (operation === "check") {
        await waitFor(() => fixture.store.getMcpServer("mcp_cua_driver")?.enabled === true);
        inFlightCheck = pluginAction(
          fixture.daemon,
          fixture.cwd,
          "trusted-local:cua-driver",
          "check",
        );
      }
      await checkStarted.promise;

      const uninstall = await pluginAction(
        fixture.daemon,
        fixture.cwd,
        "trusted-local:cua-driver",
        "uninstall",
      );
      assert.equal(uninstall.status, 409);
      assert.equal(
        (await uninstall.json()).error,
        "cua_driver_bundled_action_forbidden",
      );

      const disabled = await pluginAction(
        fixture.daemon,
        fixture.cwd,
        "trusted-local:cua-driver",
        "disable",
      );
      assert.equal(disabled.status, 200);
      releaseCheck.resolve();
      if (inFlightCheck) {
        assert.equal((await inFlightCheck).status, 409);
      }
      await waitFor(() => fixture.store.getMcpServer("mcp_cua_driver")?.enabled === false);
      assert.equal(fixture.store.listMcpTools({ serverId: "mcp_cua_driver" }).length, 0);
      assert.equal(
        fixture.store.getCuaDriverActivationState("trusted-local:cua-driver").requestedEnabled,
        false,
      );
    } finally {
      releaseCheck.resolve();
      await fixture.close();
    }
  });
}

async function daemonFixture(input = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-daemon-composition-"));
  const store = createSqliteRunStore(cwd);
  if (input.seedReady) {
    seedReadyState(store);
  }
  const stats = { connects: [], closes: 0 };
  const daemon = createDaemonServer(
    bundledConfig(cwd),
    {
      desktopBridgeToken: desktopToken,
      computerUseRouteToken: desktopToken,
      storeFactory: () => store,
      cuaDriverLeaseClientFactory: fakeLeaseFactory(stats, input.leaseClientOptions),
      cuaDriverLeaseScheduleDeadline: input.leaseScheduleDeadline,
    },
  );
  let stopped = false;
  return {
    cwd,
    store,
    daemon,
    connects: stats.connects,
    get closes() { return stats.closes; },
    async close() {
      if (!stopped && daemon.server.listening) {
        stopped = true;
        await daemon.stop();
      } else if (!stopped) {
        stopped = true;
        store.close();
      }
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function fakeLeaseFactory(stats = { connects: [], closes: 0 }, options = {}) {
  return {
    async connect(currentLease) {
      stats.connects.push(currentLease);
      return {
        async check(currentServer, checkedAt, signal) {
          if (options.check) return options.check(currentServer, checkedAt, signal);
          return { statusSnapshot: readyStatus(currentServer.id, checkedAt, 0) };
        },
        async checkHealth(currentServer, checkedAt, signal) {
          if (options.checkHealth) return options.checkHealth(currentServer, checkedAt, signal);
          return { statusSnapshot: readyStatus(currentServer.id, checkedAt, 0) };
        },
        async listTools(currentServer, checkedAt, signal) {
          if (options.listTools) return options.listTools(currentServer, checkedAt, signal);
          return {
            statusSnapshot: readyStatus(currentServer.id, checkedAt, 1),
            tools: [toolInput()],
          };
        },
        async callTool(currentServer, toolName, input, signal) {
          if (options.callTool) return options.callTool(currentServer, toolName, input, signal);
          return { content: [{ type: "text", text: "ok" }] };
        },
        async close() { stats.closes += 1; },
      };
    },
  };
}

function seedReadyState(store) {
  const descriptor = createCuaDriverDescriptor();
  const checkedAt = new Date().toISOString();
  store.upsertManagedPlugin({
    id: descriptor.id,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    enabled: false,
    descriptor,
  }, checkedAt);
  const server = store.createMcpServer(createBundledCuaDriverLogicalMcpServerInput(), checkedAt);
  store.replaceManagedPluginContributions(descriptor.id, [{
    contributionKind: "mcp-server",
    contributionId: server.id,
    linkedResourceId: server.id,
    enabled: false,
  }], checkedAt);
  const state = store.ensureCuaDriverActivationState(descriptor.id, checkedAt);
  const result = store.commitCuaDriverActivation({
    pluginId: descriptor.id,
    mcpServerId: server.id,
    now: checkedAt,
    expected: {
      requestedRevision: state.requestedRevision,
      activationEpoch: state.activationEpoch,
    },
    requestedEnabled: true,
    requestedRevision: state.requestedRevision + 1,
    activationEpoch: state.activationEpoch + 1,
    effectiveEnabled: true,
    pluginEnabled: true,
    contributionEnabled: true,
    mcpServerEnabled: true,
    tools: [toolInput()],
    statusSnapshot: readyStatus(server.id, checkedAt, 1),
    healthSnapshot: {
      pluginId: descriptor.id,
      checkedAt,
      expiresAt: new Date(Date.parse(checkedAt) + 300_000).toISOString(),
      status: "ready",
      message: "ready",
      details: { providerState: "ready" },
    },
    disabledReason: null,
  });
  assert.equal(result.committed, true);
}

function seedExternalReadyState(store) {
  const descriptor = createCuaDriverDescriptor();
  const checkedAt = new Date().toISOString();
  store.upsertManagedPlugin({
    id: descriptor.id,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    enabled: true,
    descriptor,
  }, checkedAt);
  const server = store.createMcpServer(
    createCuaDriverMcpServerInput("/tmp/ling-external-cua-driver", true),
    checkedAt,
  );
  store.replaceManagedPluginContributions(descriptor.id, [{
    contributionKind: "mcp-server",
    contributionId: server.id,
    linkedResourceId: server.id,
    enabled: true,
  }], checkedAt);
  store.replaceMcpServerTools(server.id, [toolInput()], checkedAt);
}

function bundledConfig(cwd) {
  const darwin = process.platform === "darwin";
  const win32 = process.platform === "win32";
  return {
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    cuaDriver: {
      bundledEmbedded: { darwin, win32 },
      packagedProvider: { darwin, win32 },
    },
  };
}

function externalConfig(cwd) {
  return {
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    cuaDriver: {
      bundledEmbedded: { darwin: false, win32: false },
      packagedProvider: { darwin: false, win32: false },
    },
  };
}

async function handshake(daemon) {
  const response = await fetch(
    daemonUrl(daemon, "/computer-use/desktop-bridge/handshake"),
    { headers: { [bridgeHeader]: desktopToken } },
  );
  assert.equal(response.status, 200);
  return response.json();
}

function availability(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-availability",
    desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-availability",
    daemonAuthorityEpoch: "authority-availability",
    workspaceCwd: "/tmp/ling-cua-availability-sequence",
    generation: 1,
    sequence: 1,
    platform: "darwin",
    providerState: "platform_unavailable",
    reason: "darwin_platform_unavailable",
    limitations: [],
    ...overrides,
  };
}

function desktopAvailability(authority, cwd, overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-composition",
    desktopInstanceEpoch: authority.desktopInstanceEpoch,
    bridgeConnectionId: authority.bridgeConnectionId,
    daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
    workspaceCwd: cwd,
    generation: 1,
    sequence: 1,
    platform: process.platform,
    providerState: "platform_unavailable",
    reason: "platform_unavailable",
    ...(process.platform === "win32"
      ? {
          integrityCoverage: "standard",
          limitations: ["elevated_pixel_input", "uwp_send_input"],
        }
      : { limitations: [] }),
    ...overrides,
  };
}

function lease(authority, cwd, overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-composition",
    desktopInstanceEpoch: authority.desktopInstanceEpoch,
    bridgeConnectionId: authority.bridgeConnectionId,
    generation: 1,
    daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
    workspaceCwd: cwd,
    endpoint: "http://127.0.0.1:43123/mcp",
    providerVersion: "0.8.3",
    distributionRevision: "ling.1",
    integrationMode: "embedded-stdio",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lockDigest: "a".repeat(64),
    providerSealDigest: "b".repeat(64),
    ...(process.platform === "win32" ? { providerCatalogDigest: "c".repeat(64) } : {}),
    platform: process.platform,
    architecture: process.arch === "x64" ? "x86_64" : "arm64",
    ...(process.platform === "win32" ? { integrityCoverage: "standard" } : {}),
    ...overrides,
  };
}

function pluginAction(daemon, cwd, pluginId, action, body = {}) {
  return fetch(
    daemonUrl(daemon, `/plugins/${encodeURIComponent(pluginId)}/${action}?cwd=${encodeURIComponent(cwd)}`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function pluginView(daemon, cwd, pluginId) {
  return fetch(
    daemonUrl(daemon, `/plugins/${encodeURIComponent(pluginId)}?cwd=${encodeURIComponent(cwd)}`),
  );
}

function pluginRuntimePreview(daemon, cwd, pluginId) {
  return fetch(
    daemonUrl(daemon, `/plugins/${encodeURIComponent(pluginId)}/runtime-preview?cwd=${encodeURIComponent(cwd)}`),
  );
}

function putLease(daemon, value) {
  return fetch(
    daemonUrl(daemon, `/desktop/capabilities/cua-driver/lease?cwd=${encodeURIComponent(value.workspaceCwd)}`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", [bridgeHeader]: desktopToken },
      body: JSON.stringify(value),
    },
  );
}

function putAvailability(daemon, value) {
  return fetch(
    daemonUrl(daemon, `/desktop/capabilities/cua-driver/availability?cwd=${encodeURIComponent(value.workspaceCwd)}`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", [bridgeHeader]: desktopToken },
      body: JSON.stringify(value),
    },
  );
}

function deleteLease(daemon, value) {
  return fetch(
    daemonUrl(
      daemon,
      `/desktop/capabilities/cua-driver/lease/${value.desktopInstanceEpoch}/${value.generation}?cwd=${encodeURIComponent(value.workspaceCwd)}`,
    ),
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json", [bridgeHeader]: desktopToken },
      body: JSON.stringify({
        schemaVersion: 1,
        providerId: value.providerId,
        desktopInstanceId: value.desktopInstanceId,
        desktopInstanceEpoch: value.desktopInstanceEpoch,
        bridgeConnectionId: value.bridgeConnectionId,
        generation: value.generation,
        daemonAuthorityEpoch: value.daemonAuthorityEpoch,
        workspaceCwd: value.workspaceCwd,
      }),
    },
  );
}

function daemonUrl(daemon, pathname) {
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}${pathname}`;
}

function readyStatus(serverId, checkedAt, toolCount) {
  return {
    serverId,
    checkedAt,
    expiresAt: new Date(Date.parse(checkedAt) + 300_000).toISOString(),
    status: "ready",
    toolCount,
    missingSecretRefs: [],
    authStatus: { kind: "not_required", refs: [], missingRefs: [] },
  };
}

function toolInput() {
  return {
    rawName: "list_windows",
    displayName: "List windows",
    inputSchema: { type: "object" },
    callableNamespace: "mcp_cua_driver",
    callableName: "list_windows",
    sideEffectLevel: "read",
    defaultApproval: "allow",
    enabled: true,
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for Cua Driver daemon composition state");
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function manualDeadlineScheduler() {
  let scheduled;
  return {
    schedule(callback) {
      const entry = { callback, cancelled: false };
      scheduled = entry;
      return {
        cancel() {
          entry.cancelled = true;
          if (scheduled === entry) scheduled = undefined;
        },
      };
    },
    fire() {
      const entry = scheduled;
      assert.ok(entry && !entry.cancelled, "lease deadline was not armed");
      scheduled = undefined;
      entry.callback();
    },
  };
}

function rejectWhenAborted(signal, observed) {
  return new Promise((_, reject) => {
    const abort = () => {
      observed.resolve();
      reject(new Error("fixture generation aborted"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function settleWithinRequired(promise, timeoutMs, message) {
  const marker = Symbol("timeout");
  let timer;
  const result = await Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(marker), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.notEqual(result, marker, message);
}
