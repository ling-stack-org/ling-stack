import assert from "node:assert/strict";
import test from "node:test";
import {
  CuaDriverDesktopCoordinator,
} from "../dist/main/cua-driver/coordinator.js";
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
