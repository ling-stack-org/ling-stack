import assert from "node:assert/strict";
import test from "node:test";
import {
  CuaDriverDesktopCoordinator,
  classifyCuaDriverPreSpawnFailure,
} from "../dist/main/cua-driver/coordinator.js";
import {
  CuaDriverPlatformIdentityVerificationError,
  CuaDriverProviderSealError,
} from "../dist/main/cua-driver/provider-seal.js";
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
