import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComputerControlViewModel,
  resolveCuaDriverSurfaceMode,
  shouldHideCuaDriverInternalRows,
} from "../src/domains/computer-control/computer-control-view-model.ts";

const desktopCapability = {
  packagedBundledCapable: true,
  platform: "macos",
  async requestPermissions() { return { accepted: true }; },
  async openPermissionSettings() { return { accepted: true }; },
};

test("surface selector keeps bundled identities internal and preserves external mode", () => {
  const bundled = plugin({ distribution: "bundled_embedded" });
  const external = plugin({
    distribution: "external_local",
    providerState: "external_connected",
  });

  assert.equal(resolveCuaDriverSurfaceMode(desktopCapability, bundled), "computer_control");
  assert.equal(resolveCuaDriverSurfaceMode(undefined, bundled), "hidden_bundled");
  assert.equal(resolveCuaDriverSurfaceMode(desktopCapability, external), "legacy_external");
  assert.equal(resolveCuaDriverSurfaceMode(undefined, undefined), "none");
  assert.equal(shouldHideCuaDriverInternalRows("computer_control"), true);
  assert.equal(shouldHideCuaDriverInternalRows("hidden_bundled"), true);
  assert.equal(shouldHideCuaDriverInternalRows("legacy_external"), false);
});

test("switch truth, last checked, integrity, and permission action use authoritative fields only", () => {
  const healthCheckedAt = "2026-07-30T02:03:04.000Z";
  const candidate = plugin({
    providerState: "permission_required",
    requestedEnabled: true,
    effectiveEnabled: false,
    checkedAt: "2099-01-01T00:00:00.000Z",
    integrity: undefined,
    permissions: {
      accessibility: "unknown",
      screenRecording: "denied",
    },
  }, healthCheckedAt);
  const view = buildComputerControlViewModel({
    surfaceMode: "computer_control",
    plugin: candidate,
    loading: false,
    pendingActions: [],
    actionErrors: [],
    permissionPending: false,
  });

  assert.equal(view.kind, "bundled");
  assert.equal(view.checked, true);
  assert.equal(view.effectiveEnabled, false);
  assert.equal(view.lastCheckedAt, healthCheckedAt);
  assert.equal(view.integrity, "unknown");
  assert.deepEqual(view.primaryAction, {
    kind: "open_permission_settings",
    permission: "screen_recording",
  });
});

test("malformed bundled projection fails closed and never falls back to external setup", () => {
  const malformed = plugin({ requestedEnabled: undefined });
  const view = buildComputerControlViewModel({
    surfaceMode: resolveCuaDriverSurfaceMode(desktopCapability, malformed),
    plugin: malformed,
    loading: false,
    pendingActions: [],
    actionErrors: [],
    permissionPending: false,
  });
  assert.deepEqual(view, {
    kind: "error",
    error: "projection_invalid",
    checked: false,
    switchDisabled: true,
    primaryAction: { kind: "retry" },
  });
});

function plugin(setupOverrides = {}, healthCheckedAt) {
  return {
    id: "trusted-local:cua-driver",
    displayName: "Cua Driver",
    version: "1",
    sourceKind: "trusted-local-preset",
    status: "disabled",
    trustSummary: "Desktop-owned",
    contributions: [],
    linkedResources: [],
    ...(healthCheckedAt ? {
      health: {
        pluginId: "trusted-local:cua-driver",
        checkedAt: healthCheckedAt,
        expiresAt: "2026-07-30T02:08:04.000Z",
        status: "failed",
      },
    } : {}),
    setup: {
      kind: "local_binary",
      schemaVersion: 2,
      distribution: "bundled_embedded",
      platform: "darwin",
      providerState: "included",
      requestedEnabled: false,
      effectiveEnabled: false,
      state: "connected",
      checkedAt: "2026-07-30T01:00:00.000Z",
      limitations: [],
      ...setupOverrides,
    },
    actions: {
      canEnable: true,
      canDisable: false,
      canCheck: true,
      canApplyPreset: false,
      canInstall: false,
      canUninstall: false,
      canRefreshPackage: false,
      canRuntimePreview: false,
    },
  };
}
