import assert from "node:assert/strict";
import test from "node:test";
import {
  CuaDriverDesktopCoordinator,
  classifyCuaDriverInitialReadiness,
  classifyCuaDriverPreSpawnFailure,
} from "../dist/main/cua-driver/coordinator.js";
import {
  CuaDriverPlatformIdentityVerificationError,
  CuaDriverProviderSealError,
} from "../dist/main/cua-driver/provider-seal.js";
import { CuaDriverInputFenceError } from "../dist/main/cua-driver/input-fence-client.js";
import { DEFAULT_CUA_DRIVER_FEATURE_FLAGS } from "@ling-stack/contracts";

test("coordinator keeps bundled gate closed and never falls through to PATH/external provider", async () => {
  let spawnCount = 0;
  let leaseCount = 0;
  const coordinator = new CuaDriverDesktopCoordinator({
    platform: "darwin",
    architecture: "arm64",
    resourcesPath: "/does/not/exist",
    userDataPath: "/does/not/exist/user-data",
    workspaceCwd: "/workspace",
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeContext: {
      bridgeToken: "bridge",
      daemonAuthorityEpoch: "authority",
      bridgeConnectionId: "bridge-1",
      desktopInstanceEpoch: 1,
      workspaceCwd: "/workspace",
    },
    featureFlags: DEFAULT_CUA_DRIVER_FEATURE_FLAGS,
    processLifecycle: {
      lifetimeBoundary: "test-fixture",
      spawn() {
        spawnCount += 1;
        throw new Error("must_not_spawn");
      },
      async terminate() {},
    },
    leaseClient: {
      async publish() {
        leaseCount += 1;
      },
      async revoke() {},
    },
  });
  const snapshot = await coordinator.enable();
  assert.equal(snapshot.lifecycle, "included");
  assert.equal(snapshot.providerState, "included");
  assert.equal(spawnCount, 0);
  assert.equal(leaseCount, 0);
  await coordinator.shutdown();
});

test("a session boundary raised before host composition remains latched through enable", async () => {
  const coordinator = createCoordinator();
  const enableStarted = deferred();
  const releaseEnable = deferred();
  let disableCount = 0;
  coordinator.enableInternal = async () => {
    coordinator.generation = 1;
    enableStarted.resolve();
    await releaseEnable.promise;
    coordinator.host = { generation: 1, async stop() {} };
    coordinator.proxy = { closeCallGate() {}, async close() {} };
    coordinator.leasePublisher = { async revoke() {} };
    return coordinator.publishSnapshot({
      lifecycle: "active",
      providerState: "desktop_unavailable",
      generation: 1,
    });
  };
  coordinator.beginDisable = async () => {
    disableCount += 1;
    coordinator.host = undefined;
    coordinator.proxy = undefined;
    coordinator.leasePublisher = undefined;
    coordinator.publishSnapshot({
      lifecycle: "disabled",
      providerState: "included",
      generation: 1,
      reason: "system_lock",
    });
  };

  const enabling = coordinator.enable();
  await enableStarted.promise;
  await coordinator.suspendForSystem("system_lock");
  assert.equal(coordinator.windowsSessionSuspended, true);
  assert.deepEqual(coordinator.pendingWindowsSessionSuspension, {
    reason: "system_lock",
    generation: 1,
  });

  releaseEnable.resolve();
  await enabling;
  await waitFor(() => disableCount === 1 && coordinator.sessionTransitionPromise === undefined);
  assert.equal(coordinator.windowsSessionSuspended, true);
  assert.equal(coordinator.snapshot.providerState, "interactive_session_required");
  assert.equal(coordinator.providerHost, undefined);
  await coordinator.shutdown();
});

test("retiring an enable-time candidate fences input before partial cleanup", async () => {
  const coordinator = createCoordinator();
  const order = [];
  coordinator.windowsSessionSuspended = true;
  coordinator.windowsSessionSuspensionReason = "system_lock";
  coordinator.generation = 2;
  coordinator.host = {
    generation: 2,
    async fenceInput() { order.push("fence"); },
    async stop() { order.push("host.stop"); },
  };
  coordinator.proxy = {
    closeCallGate() {},
    async close() { order.push("proxy.close"); },
  };
  coordinator.leasePublisher = {
    async revoke() { order.push("lease.revoke"); },
  };

  const snapshot = await coordinator.retainSuspendedGeneration(2);

  assert.equal(order[0], "fence");
  assert.deepEqual(new Set(order.slice(1)), new Set(["lease.revoke", "proxy.close", "host.stop"]));
  assert.equal(snapshot.providerState, "interactive_session_required");
  assert.equal(coordinator.providerHost, undefined);
  await coordinator.shutdown();
});

test("pre-spawn failure classification separates unavailable verification from invalid bytes", () => {
  assert.equal(
    classifyCuaDriverPreSpawnFailure(new CuaDriverPlatformIdentityVerificationError("unavailable")),
    "platform_unavailable",
  );
  assert.equal(
    classifyCuaDriverPreSpawnFailure(new CuaDriverPlatformIdentityVerificationError("invalid")),
    "artifact_invalid",
  );
  assert.equal(
    classifyCuaDriverPreSpawnFailure(new CuaDriverProviderSealError("provider_seal_executable_digest_mismatch")),
    "artifact_invalid",
  );
  assert.equal(
    classifyCuaDriverPreSpawnFailure(new CuaDriverProviderSealError("platform_identity_verifier_required")),
    "platform_unavailable",
  );
});

test("initial readiness retains only an expected host-permission wait", () => {
  assert.equal(
    classifyCuaDriverInitialReadiness({ ready: true, providerState: "ready" }),
    "open_call_gate",
  );
  assert.equal(
    classifyCuaDriverInitialReadiness({ ready: false, providerState: "permission_required" }),
    "retain_gated_session",
  );
  for (const providerState of ["interactive_session_required", "platform_unavailable"]) {
    assert.equal(
      classifyCuaDriverInitialReadiness({ ready: false, providerState }),
      "reject_initialize",
    );
  }
  assert.equal(
    classifyCuaDriverInitialReadiness({ ready: true, providerState: "permission_required" }),
    "reject_initialize",
    "an internally inconsistent readiness result must fail closed",
  );
});

test("enabled bundled mode fails closed when payload is missing instead of selecting external executable", async () => {
  const coordinator = new CuaDriverDesktopCoordinator({
    platform: "darwin",
    architecture: "arm64",
    resourcesPath: "/does/not/exist",
    userDataPath: "/does/not/exist/user-data",
    workspaceCwd: "/workspace",
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeContext: {
      bridgeToken: "bridge",
      daemonAuthorityEpoch: "authority",
      bridgeConnectionId: "bridge-1",
      desktopInstanceEpoch: 1,
      workspaceCwd: "/workspace",
    },
    featureFlags: {
      bundledEmbedded: { darwin: true, win32: false },
      packagedProvider: { darwin: true, win32: false },
    },
  });
  await assert.rejects(coordinator.enable(), /ENOENT|provider_lock/);
  assert.equal(coordinator.snapshot.providerState, "corrupt");
  await coordinator.shutdown();
});

test("Windows bundled gate requires an injected Job Object lifecycle before touching payload", async () => {
  const coordinator = new CuaDriverDesktopCoordinator({
    platform: "win32",
    architecture: "x86_64",
    resourcesPath: "/does/not/exist",
    userDataPath: "/does/not/exist/user-data",
    workspaceCwd: "/workspace",
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeContext: {
      bridgeToken: "bridge",
      daemonAuthorityEpoch: "authority",
      bridgeConnectionId: "bridge-1",
      desktopInstanceEpoch: 1,
      workspaceCwd: "/workspace",
    },
    featureFlags: {
      bundledEmbedded: { darwin: false, win32: true },
      packagedProvider: { darwin: false, win32: true },
    },
  });
  const snapshot = await coordinator.enable();
  assert.equal(snapshot.providerState, "platform_unavailable");
  assert.match(snapshot.reason, /job_object/);
  await coordinator.shutdown();
});

test("disable waits for an in-flight recovery enable and removes the recovered generation", async () => {
  const coordinator = createCoordinator();
  const recoveryStarted = deferred();
  const releaseRecovery = deferred();
  let revokeCount = 0;
  let proxyCloseCount = 0;
  let hostStopCount = 0;

  coordinator.requestedEnabled = true;
  coordinator.host = { generation: 1, async stop() {} };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "desktop_unavailable", generation: 1 };
  coordinator.enableInternal = async () => {
    recoveryStarted.resolve();
    await releaseRecovery.promise;
    coordinator.generation = 2;
    coordinator.leasePublisher = { async revoke() { revokeCount += 1; } };
    coordinator.proxy = {
      closeCallGate() {},
      async close() { proxyCloseCount += 1; },
    };
    coordinator.host = {
      generation: 2,
      async stop() { hostStopCount += 1; },
    };
    return coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 2 });
  };

  coordinator.scheduleRecovery("fixture_recovery", 1);
  await recoveryStarted.promise;
  const disabling = coordinator.disable("fixture_disable");
  await Promise.resolve();
  assert.equal(coordinator.enablePromise !== undefined, true);
  releaseRecovery.resolve();
  await disabling;
  await coordinator.recoveryPromise;

  assert.equal(coordinator.snapshot.lifecycle, "disabled");
  assert.equal(coordinator.snapshot.generation, 2);
  assert.equal(coordinator.requestedEnabled, false);
  assert.equal(coordinator.leasePublisher, undefined);
  assert.equal(coordinator.proxy, undefined);
  assert.equal(coordinator.providerHost, undefined);
  assert.equal(revokeCount, 1);
  assert.equal(proxyCloseCount, 1);
  assert.equal(hostStopCount, 1);
});

test("pre-spawn validation failure revokes the lease and remains corrupt without recovery", async () => {
  const coordinator = createCoordinator();
  let revokeCount = 0;
  let proxyCloseCount = 0;
  let hostStopCount = 0;
  coordinator.requestedEnabled = true;
  coordinator.generation = 4;
  coordinator.leasePublisher = { async revoke() { revokeCount += 1; } };
  coordinator.proxy = {
    closeCallGate() {},
    async close() { proxyCloseCount += 1; },
  };
  coordinator.host = {
    generation: 4,
    async stop() { hostStopCount += 1; },
  };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "desktop_unavailable", generation: 4 };

  coordinator.scheduleTerminalFailure("provider_pre_spawn_validation_failed", 4, "corrupt");
  await coordinator.recoveryPromise;

  assert.equal(coordinator.snapshot.lifecycle, "failed");
  assert.equal(coordinator.snapshot.providerState, "corrupt");
  assert.equal(coordinator.snapshot.reason, "provider_pre_spawn_validation_failed");
  assert.equal(coordinator.requestedEnabled, true);
  assert.equal(coordinator.leasePublisher, undefined);
  assert.equal(coordinator.proxy, undefined);
  assert.equal(coordinator.providerHost, undefined);
  assert.equal(revokeCount, 1);
  assert.equal(proxyCloseCount, 1);
  assert.equal(hostStopCount, 1);
});

test("readiness resets only the current generation recovery budget", () => {
  const coordinator = createCoordinator();
  coordinator.requestedEnabled = true;
  coordinator.recoveryAttempt = 3;
  coordinator.host = { generation: 8, async stop() {} };

  coordinator.resetRecoveryBudget(7);
  assert.equal(coordinator.recoveryAttempt, 3);
  coordinator.resetRecoveryBudget(8);
  assert.equal(coordinator.recoveryAttempt, 0);
});

test("an exhausted recovery budget tears down the active generation before retry", async () => {
  const coordinator = createCoordinator();
  let revokeCount = 0;
  let proxyCloseCount = 0;
  let hostStopCount = 0;
  coordinator.requestedEnabled = true;
  coordinator.recoveryAttempt = 3;
  coordinator.generation = 9;
  coordinator.leasePublisher = { async revoke() { revokeCount += 1; } };
  coordinator.proxy = {
    closeCallGate() {},
    async close() { proxyCloseCount += 1; },
  };
  coordinator.host = {
    generation: 9,
    async stop() { hostStopCount += 1; },
  };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "desktop_unavailable", generation: 9 };

  coordinator.scheduleRecovery("fourth_failure", 9);
  await coordinator.recoveryPromise;
  assert.equal(coordinator.snapshot.lifecycle, "failed");
  assert.equal(coordinator.snapshot.reason, "recovery_attempts_exhausted");
  assert.equal(coordinator.leasePublisher, undefined);
  assert.equal(coordinator.proxy, undefined);
  assert.equal(coordinator.providerHost, undefined);
  assert.equal(revokeCount, 1);
  assert.equal(proxyCloseCount, 1);
  assert.equal(hostStopCount, 1);

  coordinator.enableInternal = async () => {
    assert.equal(coordinator.leasePublisher, undefined);
    assert.equal(coordinator.proxy, undefined);
    assert.equal(coordinator.providerHost, undefined);
    coordinator.generation = 10;
    return coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 10 });
  };
  const retried = await coordinator.enable();
  assert.equal(retried.lifecycle, "active");
  assert.equal(retried.generation, 10);
  assert.equal(coordinator.recoveryAttempt, 0);
});

test("enable during recovery backoff joins the recovery-owned generation", async () => {
  const coordinator = createCoordinator();
  let enableCount = 0;
  let revokeCount = 0;
  let proxyCloseCount = 0;
  let hostStopCount = 0;
  coordinator.requestedEnabled = true;
  coordinator.generation = 1;
  coordinator.host = { generation: 1, async stop() {} };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "desktop_unavailable", generation: 1 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    coordinator.generation = 2;
    coordinator.leasePublisher = { async revoke() { revokeCount += 1; } };
    coordinator.proxy = {
      closeCallGate() {},
      async close() { proxyCloseCount += 1; },
    };
    coordinator.host = {
      generation: 2,
      async stop() { hostStopCount += 1; },
    };
    return coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 2 });
  };

  coordinator.scheduleRecovery("fixture_recovery", 1);
  const recovery = coordinator.recoveryPromise;
  await waitFor(() => coordinator.snapshot.lifecycle === "disabled");
  const enabled = await coordinator.enable();
  await recovery;

  assert.equal(enableCount, 1);
  assert.equal(enabled.generation, 2);
  assert.equal(coordinator.snapshot.generation, 2);
  await coordinator.disable("fixture_cleanup");
  assert.equal(revokeCount, 1);
  assert.equal(proxyCloseCount, 1);
  assert.equal(hostStopCount, 1);
});

test("a fresh-generation terminal event queued during recovery is not lost", async () => {
  const coordinator = createCoordinator();
  const stoppedGenerations = [];
  let enableCount = 0;
  coordinator.requestedEnabled = true;
  coordinator.generation = 1;
  coordinator.host = { generation: 1, async stop() { stoppedGenerations.push(1); } };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "desktop_unavailable", generation: 1 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    const generation = enableCount + 1;
    coordinator.generation = generation;
    coordinator.leasePublisher = { async revoke() {} };
    coordinator.proxy = { closeCallGate() {}, async close() {} };
    coordinator.host = { generation, async stop() { stoppedGenerations.push(generation); } };
    const snapshot = coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation });
    if (generation === 2) {
      coordinator.scheduleRecovery("g2_immediate_crash", 2);
    }
    return snapshot;
  };

  coordinator.scheduleRecovery("g1_crash", 1);
  await waitFor(() => coordinator.recoveryPromise === undefined && coordinator.snapshot.generation === 3);

  assert.equal(enableCount, 2);
  assert.deepEqual(stoppedGenerations, [1, 2]);
  assert.equal(coordinator.providerHost.generation, 3);
  await coordinator.disable("fixture_cleanup");
  assert.deepEqual(stoppedGenerations, [1, 2, 3]);
});

test("session suspension closes the call gate before fencing and retiring the generation", async () => {
  const order = [];
  const coordinator = createWindowsCoordinator({ subscribe() { return () => {}; } });
  coordinator.requestedEnabled = true;
  coordinator.generation = 4;
  coordinator.leasePublisher = { async revoke() { order.push("revoke"); } };
  coordinator.proxy = {
    closeCallGate() { order.push("gate"); },
    async close() { order.push("proxy-close"); },
  };
  coordinator.host = {
    generation: 4,
    async fenceInput() { order.push("fence"); },
    async terminateImmediately() { order.push("kill"); },
    async stop() { order.push("stop"); },
  };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 4 };

  coordinator.scheduleWindowsSessionSuspension("system_lock", 4);
  await waitFor(() => coordinator.sessionTransitionPromise === undefined);

  assert.deepEqual(order, ["gate", "fence", "gate", "revoke", "proxy-close", "stop"]);
  assert.equal(coordinator.snapshot.lifecycle, "included");
  await coordinator.shutdown();
});

test("missed input-fence acknowledgement kills before normal generation cleanup", async () => {
  const order = [];
  const coordinator = createWindowsCoordinator({ subscribe() { return () => {}; } });
  coordinator.requestedEnabled = true;
  coordinator.generation = 7;
  coordinator.leasePublisher = { async revoke() { order.push("revoke"); } };
  coordinator.proxy = {
    closeCallGate(reason) { order.push(`gate:${reason}`); },
    async close() { order.push("proxy-close"); },
  };
  coordinator.host = {
    generation: 7,
    async fenceInput() {
      order.push("fence");
      throw new CuaDriverInputFenceError("timeout");
    },
    async terminateImmediately(reason) { order.push(`kill:${reason}`); },
    async stop() { order.push("stop"); },
  };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 7 };

  coordinator.scheduleWindowsSessionSuspension("system_lock", 7);
  await waitFor(() => coordinator.sessionTransitionPromise === undefined);

  assert.deepEqual(order.slice(0, 4), [
    "gate:system_lock",
    "fence",
    "gate:locked_control_input_fence_timeout",
    "kill:locked_control_input_fence_timeout",
  ]);
  assert.ok(order.indexOf("kill:locked_control_input_fence_timeout") < order.indexOf("stop"));
  await coordinator.shutdown();
});

test("Windows interactive-session suspension waits for a host hint without consuming crash retries", async () => {
  let emitSessionHint;
  let observerStopCount = 0;
  let enableCount = 0;
  let revokeCount = 0;
  let proxyCloseCount = 0;
  let hostStopCount = 0;
  const coordinator = createWindowsCoordinator({
    subscribe(listener) {
      emitSessionHint = listener;
      return () => {
        observerStopCount += 1;
      };
    },
  });
  coordinator.requestedEnabled = true;
  coordinator.generation = 4;
  coordinator.recoveryAttempt = 2;
  coordinator.leasePublisher = { async revoke() { revokeCount += 1; } };
  coordinator.proxy = {
    closeCallGate() {},
    async close() { proxyCloseCount += 1; },
  };
  coordinator.host = {
    generation: 4,
    async stop() { hostStopCount += 1; },
  };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 4 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    coordinator.generation = 5;
    coordinator.leasePublisher = { async revoke() { revokeCount += 1; } };
    coordinator.proxy = { closeCallGate() {}, async close() { proxyCloseCount += 1; } };
    coordinator.host = { generation: 5, async stop() { hostStopCount += 1; } };
    return coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 5 });
  };

  coordinator.scheduleWindowsSessionSuspension("windows_interactive_session_required", 4);
  await waitFor(() => coordinator.sessionTransitionPromise === undefined);
  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.equal(enableCount, 0);
  assert.equal(coordinator.recoveryAttempt, 2);
  assert.equal(coordinator.snapshot.lifecycle, "included");
  assert.equal(coordinator.snapshot.providerState, "interactive_session_required");
  assert.equal(coordinator.providerHost, undefined);
  assert.equal(revokeCount, 1);
  assert.equal(proxyCloseCount, 1);
  assert.equal(hostStopCount, 1);

  emitSessionHint({ kind: "unlock" });
  await waitFor(() => enableCount === 1 && coordinator.sessionTransitionPromise === undefined);
  assert.equal(coordinator.snapshot.generation, 5);
  assert.equal(coordinator.recoveryAttempt, 2);
  emitSessionHint({ kind: "session_active" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(enableCount, 1);

  await coordinator.shutdown();
  assert.equal(observerStopCount, 1);
});

test("Windows session-active hint received during suspension cleanup resumes exactly once", async () => {
  let emitSessionHint;
  const stopStarted = deferred();
  const releaseStop = deferred();
  let enableCount = 0;
  const coordinator = createWindowsCoordinator({
    subscribe(listener) {
      emitSessionHint = listener;
      return () => {};
    },
  });
  coordinator.requestedEnabled = true;
  coordinator.generation = 7;
  coordinator.leasePublisher = { async revoke() {} };
  coordinator.proxy = { closeCallGate() {}, async close() {} };
  coordinator.host = {
    generation: 7,
    async stop() {
      stopStarted.resolve();
      await releaseStop.promise;
    },
  };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 7 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    coordinator.generation = 8;
    coordinator.host = { generation: 8, async stop() {} };
    return coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 8 });
  };

  coordinator.scheduleWindowsSessionSuspension("windows_interactive_session_required", 7);
  await stopStarted.promise;
  emitSessionHint({ kind: "session_active" });
  emitSessionHint({ kind: "unlock" });
  await Promise.resolve();
  assert.equal(enableCount, 0);
  releaseStop.resolve();
  await waitFor(() => enableCount === 1 && coordinator.sessionTransitionPromise === undefined);
  assert.equal(coordinator.snapshot.generation, 8);

  await coordinator.shutdown();
});

test("a fresh generation that relocks during session resume is queued for immediate teardown", async () => {
  let emitSessionHint;
  const enableStarted = deferred();
  const releaseFreshGeneration = deferred();
  let revokeCount = 0;
  let proxyCloseCount = 0;
  let hostStopCount = 0;
  const coordinator = createWindowsCoordinator({
    subscribe(listener) {
      emitSessionHint = listener;
      return () => {};
    },
  });
  coordinator.requestedEnabled = true;
  coordinator.generation = 4;
  coordinator.leasePublisher = { async revoke() { revokeCount += 1; } };
  coordinator.proxy = { closeCallGate() {}, async close() { proxyCloseCount += 1; } };
  coordinator.host = { generation: 4, async stop() { hostStopCount += 1; } };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 4 };
  coordinator.enableInternal = async () => {
    enableStarted.resolve();
    await releaseFreshGeneration.promise;
    coordinator.generation = 5;
    coordinator.leasePublisher = { async revoke() { revokeCount += 1; } };
    coordinator.proxy = { closeCallGate() {}, async close() { proxyCloseCount += 1; } };
    coordinator.host = { generation: 5, async stop() { hostStopCount += 1; } };
    coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 5 });
    coordinator.scheduleWindowsSessionSuspension("windows_interactive_session_required", 5);
    return coordinator.snapshot;
  };

  coordinator.scheduleWindowsSessionSuspension("windows_interactive_session_required", 4);
  await waitFor(() => coordinator.sessionTransitionPromise === undefined);
  emitSessionHint({ kind: "unlock" });
  await enableStarted.promise;
  releaseFreshGeneration.resolve();
  await waitFor(() => coordinator.sessionTransitionPromise === undefined && coordinator.providerHost === undefined);

  assert.equal(coordinator.windowsSessionSuspended, true);
  assert.equal(coordinator.snapshot.lifecycle, "included");
  assert.equal(coordinator.snapshot.providerState, "interactive_session_required");
  assert.equal(coordinator.snapshot.generation, 5);
  assert.equal(coordinator.leasePublisher, undefined);
  assert.equal(coordinator.proxy, undefined);
  assert.equal(revokeCount, 2);
  assert.equal(proxyCloseCount, 2);
  assert.equal(hostStopCount, 2);

  await coordinator.shutdown();
});

test("explicit restart waits for session-suspension cleanup before creating one fresh generation", async () => {
  const stopStarted = deferred();
  const releaseStop = deferred();
  let enableCount = 0;
  const coordinator = createWindowsCoordinator({
    subscribe() {
      return () => {};
    },
  });
  coordinator.requestedEnabled = true;
  coordinator.generation = 7;
  coordinator.leasePublisher = { async revoke() {} };
  coordinator.proxy = { closeCallGate() {}, async close() {} };
  coordinator.host = {
    generation: 7,
    async stop() {
      stopStarted.resolve();
      await releaseStop.promise;
    },
  };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 7 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    coordinator.generation = 8;
    coordinator.leasePublisher = { async revoke() {} };
    coordinator.proxy = { closeCallGate() {}, async close() {} };
    coordinator.host = { generation: 8, async stop() {} };
    return coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 8 });
  };

  coordinator.scheduleWindowsSessionSuspension("session0", 7);
  await stopStarted.promise;
  const restarting = coordinator.restart("manual_restart");
  releaseStop.resolve();
  const restarted = await restarting;

  assert.equal(enableCount, 1);
  assert.equal(restarted.lifecycle, "active");
  assert.equal(restarted.generation, 8);
  assert.equal(coordinator.requestedEnabled, true);
  assert.equal(coordinator.providerHost.generation, 8);

  await coordinator.shutdown();
});

test("concurrent disable then enable honors the last intent across session cleanup", async () => {
  const stopStarted = deferred();
  const releaseStop = deferred();
  let enableCount = 0;
  const coordinator = createWindowsCoordinator({
    subscribe() {
      return () => {};
    },
  });
  coordinator.requestedEnabled = true;
  coordinator.generation = 7;
  coordinator.leasePublisher = { async revoke() {} };
  coordinator.proxy = { closeCallGate() {}, async close() {} };
  coordinator.host = {
    generation: 7,
    async stop() {
      stopStarted.resolve();
      await releaseStop.promise;
    },
  };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 7 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    coordinator.generation = 8;
    coordinator.leasePublisher = { async revoke() {} };
    coordinator.proxy = { closeCallGate() {}, async close() {} };
    coordinator.host = { generation: 8, async stop() {} };
    return coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 8 });
  };

  coordinator.scheduleWindowsSessionSuspension("session0", 7);
  await stopStarted.promise;
  const disabling = coordinator.disable("manual_disable");
  const enabling = coordinator.enable();
  releaseStop.resolve();
  await disabling;
  const enabled = await enabling;

  assert.equal(enableCount, 1);
  assert.equal(enabled.lifecycle, "active");
  assert.equal(enabled.generation, 8);
  assert.equal(coordinator.requestedEnabled, true);
  assert.equal(coordinator.providerHost.generation, 8);

  await coordinator.shutdown();
});

test("disable enable disable intent revisions prevent an old enable continuation from winning", async () => {
  const stopStarted = deferred();
  const releaseStop = deferred();
  let enableCount = 0;
  const coordinator = createWindowsCoordinator({
    subscribe() {
      return () => {};
    },
  });
  coordinator.requestedEnabled = true;
  coordinator.generation = 7;
  coordinator.leasePublisher = { async revoke() {} };
  coordinator.proxy = { closeCallGate() {}, async close() {} };
  coordinator.host = {
    generation: 7,
    async stop() {
      stopStarted.resolve();
      await releaseStop.promise;
    },
  };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 7 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    coordinator.generation = 8;
    return coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 8 });
  };

  coordinator.scheduleWindowsSessionSuspension("session0", 7);
  await stopStarted.promise;
  const firstDisable = coordinator.disable("first_disable");
  const staleEnable = coordinator.enable();
  const lastDisable = coordinator.disable("last_disable");
  releaseStop.resolve();
  await Promise.all([firstDisable, lastDisable]);
  await assert.rejects(staleEnable, /cua_driver_enable_superseded/);

  assert.equal(enableCount, 0);
  assert.equal(coordinator.requestedEnabled, false);
  assert.equal(coordinator.snapshot.lifecycle, "disabled");
  assert.equal(coordinator.providerHost, undefined);

  await coordinator.shutdown();
});

test("a transient fresh-generation resume failure returns to hint-waiting without spending crash budget", async () => {
  let emitSessionHint;
  let enableCount = 0;
  const coordinator = createWindowsCoordinator({
    subscribe(listener) {
      emitSessionHint = listener;
      return () => {};
    },
  });
  coordinator.requestedEnabled = true;
  coordinator.requestedRevision = 3;
  coordinator.recoveryAttempt = 2;
  coordinator.generation = 7;
  coordinator.leasePublisher = { async revoke() {} };
  coordinator.proxy = { closeCallGate() {}, async close() {} };
  coordinator.host = { generation: 7, async stop() {} };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 7 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    coordinator.generation += 1;
    if (enableCount === 1) {
      coordinator.publishSnapshot({
        lifecycle: "failed",
        providerState: "desktop_unavailable",
        generation: coordinator.generation,
        reason: "transient_resume_failure",
      });
      throw new Error("transient_resume_failure");
    }
    coordinator.leasePublisher = { async revoke() {} };
    coordinator.proxy = { closeCallGate() {}, async close() {} };
    coordinator.host = { generation: coordinator.generation, async stop() {} };
    return coordinator.publishSnapshot({
      lifecycle: "active",
      providerState: "desktop_unavailable",
      generation: coordinator.generation,
    });
  };

  coordinator.scheduleWindowsSessionSuspension("session0", 7);
  await waitFor(() => coordinator.sessionTransitionPromise === undefined);
  emitSessionHint({ kind: "unlock" });
  await waitFor(() => enableCount === 1 && coordinator.sessionTransitionPromise === undefined);

  assert.equal(coordinator.windowsSessionSuspended, true);
  assert.equal(coordinator.snapshot.lifecycle, "included");
  assert.equal(coordinator.snapshot.providerState, "interactive_session_required");
  assert.equal(coordinator.recoveryAttempt, 2);

  emitSessionHint({ kind: "session_active" });
  await waitFor(() => enableCount === 2 && coordinator.sessionTransitionPromise === undefined);
  assert.equal(coordinator.windowsSessionSuspended, false);
  assert.equal(coordinator.snapshot.lifecycle, "active");
  assert.equal(coordinator.snapshot.generation, 9);
  assert.equal(coordinator.recoveryAttempt, 2);

  await coordinator.shutdown();
});

test("duplicate enable after an unlock hint joins the same fresh-generation resume", async () => {
  let emitSessionHint;
  let enableCount = 0;
  const coordinator = createWindowsCoordinator({
    subscribe(listener) {
      emitSessionHint = listener;
      return () => {};
    },
  });
  coordinator.requestedEnabled = true;
  coordinator.requestedRevision = 11;
  coordinator.generation = 7;
  coordinator.leasePublisher = { async revoke() {} };
  coordinator.proxy = { closeCallGate() {}, async close() {} };
  coordinator.host = { generation: 7, async stop() {} };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 7 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    coordinator.generation = 8;
    coordinator.leasePublisher = { async revoke() {} };
    coordinator.proxy = { closeCallGate() {}, async close() {} };
    coordinator.host = { generation: 8, async stop() {} };
    return coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 8 });
  };

  coordinator.scheduleWindowsSessionSuspension("session0", 7);
  await waitFor(() => coordinator.sessionTransitionPromise === undefined);
  emitSessionHint({ kind: "unlock" });
  const duplicateEnable = coordinator.enable();
  const enabled = await duplicateEnable;

  assert.equal(enableCount, 1);
  assert.equal(enabled.lifecycle, "active");
  assert.equal(enabled.generation, 8);
  assert.equal(coordinator.windowsSessionSuspended, false);
  assert.equal(coordinator.providerHost.generation, 8);

  await coordinator.shutdown();
});

test("a permanent platform failure after unlock is not mislabeled as another session wait", async () => {
  let emitSessionHint;
  let enableCount = 0;
  const coordinator = createWindowsCoordinator({
    subscribe(listener) {
      emitSessionHint = listener;
      return () => {};
    },
  });
  coordinator.requestedEnabled = true;
  coordinator.requestedRevision = 5;
  coordinator.generation = 7;
  coordinator.leasePublisher = { async revoke() {} };
  coordinator.proxy = { closeCallGate() {}, async close() {} };
  coordinator.host = { generation: 7, async stop() {} };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 7 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    coordinator.generation = 8;
    return coordinator.publishSnapshot({
      lifecycle: "failed",
      providerState: "platform_unavailable",
      generation: 8,
      reason: "windows_provider_job_object_lifecycle_required",
    });
  };

  coordinator.scheduleWindowsSessionSuspension("session0", 7);
  await waitFor(() => coordinator.sessionTransitionPromise === undefined);
  emitSessionHint({ kind: "unlock" });
  await waitFor(() => enableCount === 1 && coordinator.sessionTransitionPromise === undefined);

  assert.equal(coordinator.windowsSessionSuspended, false);
  assert.equal(coordinator.snapshot.lifecycle, "failed");
  assert.equal(coordinator.snapshot.providerState, "platform_unavailable");
  assert.equal(coordinator.snapshot.reason, "windows_provider_job_object_lifecycle_required");
  emitSessionHint({ kind: "session_active" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(enableCount, 1);

  await coordinator.shutdown();
});

test("a session-active hint received after relock survives a transient G+1 resume failure", async () => {
  let emitSessionHint;
  let enableCount = 0;
  const coordinator = createWindowsCoordinator({
    subscribe(listener) {
      emitSessionHint = listener;
      return () => {};
    },
  });
  coordinator.requestedEnabled = true;
  coordinator.requestedRevision = 6;
  coordinator.generation = 4;
  coordinator.leasePublisher = { async revoke() {} };
  coordinator.proxy = { closeCallGate() {}, async close() {} };
  coordinator.host = { generation: 4, async stop() {} };
  coordinator.snapshotValue = { lifecycle: "active", providerState: "ready", generation: 4 };
  coordinator.enableInternal = async () => {
    enableCount += 1;
    coordinator.generation += 1;
    if (enableCount === 1) {
      coordinator.leasePublisher = { async revoke() {} };
      coordinator.proxy = { closeCallGate() {}, async close() {} };
      coordinator.host = { generation: 5, async stop() {} };
      coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 5 });
      coordinator.scheduleWindowsSessionSuspension("relock", 5);
      emitSessionHint({ kind: "session_active" });
      coordinator.leasePublisher = undefined;
      coordinator.proxy = undefined;
      coordinator.host = undefined;
      coordinator.publishSnapshot({
        lifecycle: "failed",
        providerState: "desktop_unavailable",
        generation: 5,
        reason: "transient_resume_failure",
      });
      throw new Error("transient_resume_failure");
    }
    coordinator.leasePublisher = { async revoke() {} };
    coordinator.proxy = { closeCallGate() {}, async close() {} };
    coordinator.host = { generation: 6, async stop() {} };
    return coordinator.publishSnapshot({ lifecycle: "active", providerState: "desktop_unavailable", generation: 6 });
  };

  coordinator.scheduleWindowsSessionSuspension("session0", 4);
  await waitFor(() => coordinator.sessionTransitionPromise === undefined);
  emitSessionHint({ kind: "unlock" });
  await waitFor(() => enableCount === 2 && coordinator.sessionTransitionPromise === undefined);

  assert.equal(coordinator.windowsSessionSuspended, false);
  assert.equal(coordinator.windowsSessionResumeHintPending, false);
  assert.equal(coordinator.snapshot.lifecycle, "active");
  assert.equal(coordinator.snapshot.generation, 6);
  assert.equal(coordinator.providerHost.generation, 6);

  await coordinator.shutdown();
});

function createCoordinator() {
  return new CuaDriverDesktopCoordinator({
    platform: "darwin",
    architecture: "arm64",
    resourcesPath: "/does/not/exist",
    userDataPath: "/does/not/exist/user-data",
    workspaceCwd: "/workspace",
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeContext: {
      bridgeToken: "bridge",
      daemonAuthorityEpoch: "authority",
      bridgeConnectionId: "bridge-1",
      desktopInstanceEpoch: 1,
      workspaceCwd: "/workspace",
    },
    featureFlags: {
      bundledEmbedded: { darwin: true, win32: false },
      packagedProvider: { darwin: true, win32: false },
    },
  });
}

function createWindowsCoordinator(windowsSessionRecoveryObserver) {
  return new CuaDriverDesktopCoordinator({
    platform: "win32",
    architecture: "x86_64",
    resourcesPath: "/does/not/exist",
    userDataPath: "/does/not/exist/user-data",
    workspaceCwd: "/workspace",
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeContext: {
      bridgeToken: "bridge",
      daemonAuthorityEpoch: "authority",
      bridgeConnectionId: "bridge-1",
      desktopInstanceEpoch: 1,
      workspaceCwd: "/workspace",
    },
    featureFlags: {
      bundledEmbedded: { darwin: false, win32: true },
      packagedProvider: { darwin: false, win32: true },
    },
    processLifecycle: {
      lifetimeBoundary: "test-fixture",
      spawn() {
        throw new Error("not_used");
      },
      async terminate() {},
    },
    windowsSessionRecoveryObserver,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition_not_reached");
}
