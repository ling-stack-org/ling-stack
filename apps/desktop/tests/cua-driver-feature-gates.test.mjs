import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_CAPABILITIES,
  desktopBundledCuaDriverGateEnabled,
  desktopCuaDriverDaemonFeatureEnvironment,
  resolveDesktopCuaDriverFeatureFlags,
} from "../dist/main/cua-driver/feature-gates.js";

test("Desktop packaged Cua Driver gates default false on both platforms", () => {
  assert.deepEqual(DEFAULT_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_CAPABILITIES, {
    schemaVersion: 1,
    resourcesValidated: true,
    darwin: false,
    win32: false,
  });
  const flags = resolveDesktopCuaDriverFeatureFlags();
  assert.equal(desktopBundledCuaDriverGateEnabled(flags, "darwin"), false);
  assert.equal(desktopBundledCuaDriverGateEnabled(flags, "win32"), false);
  assert.deepEqual(desktopCuaDriverDaemonFeatureEnvironment(flags), {
    LING_STACK_CUA_DRIVER_BUNDLED_EMBEDDED_DARWIN: "0",
    LING_STACK_CUA_DRIVER_BUNDLED_EMBEDDED_WIN32: "0",
    LING_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_DARWIN: "0",
    LING_DESKTOP_CUA_DRIVER_PACKAGED_PROVIDER_WIN32: "0",
  });
});
test("Daemon runtime opt-in cannot bypass the Desktop package gate", () => {
  const daemonOnly = resolveDesktopCuaDriverFeatureFlags({
    daemonRuntime: { darwin: true, win32: true },
  });
  assert.equal(desktopBundledCuaDriverGateEnabled(daemonOnly, "darwin"), false);
  assert.equal(desktopBundledCuaDriverGateEnabled(daemonOnly, "win32"), false);

  const macOnly = resolveDesktopCuaDriverFeatureFlags({
    daemonRuntime: { darwin: true, win32: true },
    packagedProvider: {
      schemaVersion: 1,
      resourcesValidated: true,
      darwin: true,
      win32: false,
    },
  });
  assert.equal(desktopBundledCuaDriverGateEnabled(macOnly, "darwin"), true);
  assert.equal(desktopBundledCuaDriverGateEnabled(macOnly, "win32"), false);
});
