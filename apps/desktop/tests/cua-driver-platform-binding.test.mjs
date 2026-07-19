import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CUA_DRIVER_FEATURE_FLAGS } from "@ling-stack/contracts";
import {
  CuaDriverDesktopCoordinator,
  CuaDriverPlatformBindingError,
  FAIL_CLOSED_DARWIN_CUA_DRIVER_PLATFORM_BINDING,
  FAIL_CLOSED_WIN32_CUA_DRIVER_PLATFORM_BINDING,
  normalizeCuaDriverPlatformBindingMetadata,
  selectCuaDriverPlatformBinding,
} from "../dist/main/cua-driver/index.js";

test("platform binding selects only the exact Darwin or Win32 adapter", () => {
  const darwin = selectCuaDriverPlatformBinding("darwin");
  const win32 = selectCuaDriverPlatformBinding("win32");

  assert.equal(darwin, FAIL_CLOSED_DARWIN_CUA_DRIVER_PLATFORM_BINDING);
  assert.equal(darwin.platform, "darwin");
  assert.equal(darwin.processLifecycle.lifetimeBoundary, "darwin-direct-child");
  assert.deepEqual(darwin.metadata, { limitations: [] });

  assert.equal(win32, FAIL_CLOSED_WIN32_CUA_DRIVER_PLATFORM_BINDING);
  assert.equal(win32.platform, "win32");
  assert.equal(win32.processLifecycle.lifetimeBoundary, "windows-job-object");
  assert.deepEqual(win32.metadata, {
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
  });
  assert.equal(Object.isFrozen(win32.metadata), true);
  assert.equal(Object.isFrozen(win32.metadata.limitations), true);

  assert.throws(
    () => selectCuaDriverPlatformBinding("darwin", {
      darwin: FAIL_CLOSED_WIN32_CUA_DRIVER_PLATFORM_BINDING,
    }),
    (error) => error instanceof CuaDriverPlatformBindingError
      && error.bindingCode === "platform_mismatch",
  );
});

test("unsupported host platforms fail closed instead of falling back to Darwin", () => {
  for (const platform of ["linux", "freebsd", "aix"]) {
    assert.throws(
      () => selectCuaDriverPlatformBinding(platform),
      (error) => error instanceof CuaDriverPlatformBindingError
        && error.bindingCode === "unsupported_platform"
        && error.platform === platform,
    );
  }
});

test("malformed binding availability fails closed before coordinator construction", () => {
  assert.throws(
    () => createCoordinator({
      platform: "darwin",
      architecture: "arm64",
      platformBinding: {
        ...FAIL_CLOSED_DARWIN_CUA_DRIVER_PLATFORM_BINDING,
        availability: { status: "unavailable", reason: "" },
      },
    }),
    (error) => error instanceof CuaDriverPlatformBindingError
      && error.bindingCode === "availability_invalid",
  );
});

test("binding dependencies cannot mix platform lifecycle or Windows-only members", () => {
  for (const platformBinding of [
    {
      ...FAIL_CLOSED_DARWIN_CUA_DRIVER_PLATFORM_BINDING,
      processLifecycle: FAIL_CLOSED_WIN32_CUA_DRIVER_PLATFORM_BINDING.processLifecycle,
    },
    {
      ...FAIL_CLOSED_DARWIN_CUA_DRIVER_PLATFORM_BINDING,
      windowsSessionRecoveryObserver: FAIL_CLOSED_WIN32_CUA_DRIVER_PLATFORM_BINDING.windowsSessionRecoveryObserver,
    },
    {
      ...FAIL_CLOSED_WIN32_CUA_DRIVER_PLATFORM_BINDING,
      stateRootProtector: undefined,
    },
  ]) {
    assert.throws(
      () => createCoordinator({
        platform: platformBinding.platform,
        architecture: platformBinding.platform === "darwin" ? "arm64" : "x86_64",
        platformBinding,
      }),
      (error) => error instanceof CuaDriverPlatformBindingError
        && error.bindingCode === "dependency_invalid",
    );
  }
});

test("placeholder bindings map to platform_unavailable before payload paths are touched", async () => {
  for (const [platform, architecture, binding] of [
    ["darwin", "arm64", FAIL_CLOSED_DARWIN_CUA_DRIVER_PLATFORM_BINDING],
    ["win32", "x86_64", FAIL_CLOSED_WIN32_CUA_DRIVER_PLATFORM_BINDING],
  ]) {
    const coordinator = createCoordinator({ platform, architecture, platformBinding: binding });
    assert.deepEqual(coordinator.snapshot.limitations, binding.metadata.limitations);
    assert.equal(coordinator.snapshot.integrityCoverage, binding.metadata.integrityCoverage);
    const snapshot = await coordinator.enable();
    assert.equal(snapshot.lifecycle, "failed");
    assert.equal(snapshot.providerState, "platform_unavailable");
    assert.equal(snapshot.reason, `${platform}_platform_adapter_not_installed`);
    assert.equal(snapshot.generation, 0);
    assert.deepEqual(snapshot.limitations, binding.metadata.limitations);
    assert.equal(snapshot.integrityCoverage, binding.metadata.integrityCoverage);
    await coordinator.shutdown();
  }
});

test("a coherent platform binding cannot be mixed with fine-grained dependency overrides", () => {
  assert.throws(
    () => createCoordinator({
      platform: "darwin",
      architecture: "arm64",
      platformBinding: FAIL_CLOSED_DARWIN_CUA_DRIVER_PLATFORM_BINDING,
      readinessController: {
        async check(context) {
          return {
            generation: context.generation,
            childInstanceNonce: context.childInstanceNonce,
            ready: false,
            providerState: "platform_unavailable",
          };
        },
        invalidate() {},
      },
    }),
    (error) => error instanceof CuaDriverPlatformBindingError
      && error.bindingCode === "mixed_dependency_overrides",
  );
});

test("platform metadata is cloned, frozen, deduplicated and canonically ordered", () => {
  const source = {
    integrityCoverage: "standard",
    limitations: ["uwp_send_input", "elevated_pixel_input", "uwp_send_input"],
  };
  const normalized = normalizeCuaDriverPlatformBindingMetadata(source, "win32");
  source.limitations.length = 0;

  assert.deepEqual(normalized, {
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.limitations), true);
});

test("platform metadata rejects cross-platform and incomplete capability tuples", () => {
  for (const [platform, metadata] of [
    ["darwin", { integrityCoverage: "standard", limitations: [] }],
    ["darwin", { limitations: ["elevated_pixel_input", "uwp_send_input"] }],
    ["win32", { integrityCoverage: "standard", limitations: [] }],
    ["win32", { integrityCoverage: "standard", limitations: ["elevated_pixel_input"] }],
    ["win32", { integrityCoverage: "uiaccess", limitations: ["elevated_pixel_input", "uwp_send_input"] }],
  ]) {
    assert.throws(
      () => normalizeCuaDriverPlatformBindingMetadata(metadata, platform),
      (error) => error instanceof CuaDriverPlatformBindingError
        && error.bindingCode === "metadata_invalid",
    );
  }
  assert.deepEqual(
    normalizeCuaDriverPlatformBindingMetadata({ limitations: [] }, "darwin"),
    { limitations: [] },
  );
});

function createCoordinator(overrides) {
  return new CuaDriverDesktopCoordinator({
    platform: "darwin",
    architecture: "arm64",
    resourcesPath: "/path-that-must-not-be-touched",
    userDataPath: "/path-that-must-not-be-touched/user-data",
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
      ...DEFAULT_CUA_DRIVER_FEATURE_FLAGS,
      bundledEmbedded: { darwin: true, win32: true },
      packagedProvider: { darwin: true, win32: true },
    },
    ...overrides,
  });
}
