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

test("coordinator rejects a binding for a different platform before subscribing", () => {
  let subscribeCount = 0;
  assert.throws(
    () => createCoordinator({
      platform: "darwin",
      architecture: "arm64",
      platformBinding: createAvailableWin32Binding({
        subscribe() {
          subscribeCount += 1;
          return () => {};
        },
      }),
    }),
    (error) => error instanceof CuaDriverPlatformBindingError
      && error.bindingCode === "platform_mismatch"
      && error.platform === "darwin",
  );
  assert.equal(subscribeCount, 0);
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

test("an available Win32 binding fails closed when the session observer throws during subscribe", async () => {
  const telemetryEvents = [];
  const coordinator = createCoordinator({
    platform: "win32",
    architecture: "x86_64",
    platformBinding: createAvailableWin32Binding({
      subscribe() {
        throw new Error("fixture_subscribe_failed");
      },
    }),
    telemetry: {
      emit(level, event, fields) {
        telemetryEvents.push({ level, event, fields });
      },
    },
  });

  const snapshot = await coordinator.enable();
  assert.equal(snapshot.lifecycle, "failed");
  assert.equal(snapshot.providerState, "platform_unavailable");
  assert.equal(snapshot.reason, "windows_session_observer_unavailable");
  assert.equal(snapshot.generation, 0);
  assert.equal(coordinator.providerHost, undefined);
  assert.equal(coordinator.stopWindowsSessionRecoveryObserver, undefined);
  assert.deepEqual(telemetryEvents, [{
    level: "error",
    event: "cua_driver.coordinator.session_observer_failed",
    fields: { error: "fixture_subscribe_failed" },
  }]);

  const retriedSnapshot = await coordinator.enable();
  assert.equal(retriedSnapshot.lifecycle, "failed");
  assert.equal(retriedSnapshot.providerState, "platform_unavailable");
  assert.equal(retriedSnapshot.reason, "windows_session_observer_unavailable");
  assert.equal(retriedSnapshot.generation, 0);

  await coordinator.shutdown();
});

test("an available Win32 binding rejects a non-function observer disposer and keeps its listener inert", async () => {
  let capturedListener;
  const coordinator = createCoordinator({
    platform: "win32",
    architecture: "x86_64",
    platformBinding: createAvailableWin32Binding({
      subscribe(listener) {
        capturedListener = listener;
        return undefined;
      },
    }),
  });

  let forwardedHintCount = 0;
  coordinator.handleWindowsSessionRecoveryHint = () => {
    forwardedHintCount += 1;
  };
  capturedListener({ kind: "session_active" });
  await Promise.resolve();

  const snapshot = await coordinator.enable();
  assert.equal(snapshot.lifecycle, "failed");
  assert.equal(snapshot.providerState, "platform_unavailable");
  assert.equal(snapshot.reason, "windows_session_observer_unavailable");
  assert.equal(snapshot.generation, 0);
  assert.equal(coordinator.providerHost, undefined);
  assert.equal(coordinator.stopWindowsSessionRecoveryObserver, undefined);
  assert.equal(forwardedHintCount, 0);
  assert.equal(coordinator.windowsSessionResumeHintPending, false);
  assert.equal(coordinator.sessionTransitionPromise, undefined);

  await coordinator.shutdown();
});

test("an available Win32 binding activates a valid observer and unsubscribes it exactly once", async () => {
  let capturedListener;
  let unsubscribeCount = 0;
  const coordinator = createCoordinator({
    platform: "win32",
    architecture: "x86_64",
    platformBinding: createAvailableWin32Binding({
      subscribe(listener) {
        capturedListener = listener;
        return () => {
          unsubscribeCount += 1;
        };
      },
    }),
  });

  let forwardedHintCount = 0;
  coordinator.handleWindowsSessionRecoveryHint = () => {
    forwardedHintCount += 1;
  };
  assert.equal(typeof coordinator.stopWindowsSessionRecoveryObserver, "function");
  capturedListener({ kind: "session_active" });
  assert.equal(forwardedHintCount, 1);
  await coordinator.shutdown();
  assert.equal(unsubscribeCount, 1);

  capturedListener({ kind: "session_active" });
  await Promise.resolve();
  assert.equal(forwardedHintCount, 1);
  assert.equal(coordinator.windowsSessionResumeHintPending, false);
  assert.equal(coordinator.sessionTransitionPromise, undefined);
});

test("an available Darwin binding constructs without a Windows observer or Windows metadata", async () => {
  const platformBinding = {
    ...FAIL_CLOSED_DARWIN_CUA_DRIVER_PLATFORM_BINDING,
    availability: { status: "available" },
  };
  const coordinator = createCoordinator({
    platform: "darwin",
    architecture: "arm64",
    platformBinding,
  });

  assert.equal(platformBinding.windowsSessionRecoveryObserver, undefined);
  assert.equal(coordinator.stopWindowsSessionRecoveryObserver, undefined);
  assert.equal(coordinator.snapshot.lifecycle, "disabled");
  assert.equal(coordinator.snapshot.providerState, "included");
  assert.equal(coordinator.snapshot.integrityCoverage, undefined);
  assert.deepEqual(coordinator.snapshot.limitations, []);

  await coordinator.shutdown();
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

function createAvailableWin32Binding(windowsSessionRecoveryObserver) {
  return {
    ...FAIL_CLOSED_WIN32_CUA_DRIVER_PLATFORM_BINDING,
    availability: { status: "available" },
    windowsSessionRecoveryObserver,
  };
}
