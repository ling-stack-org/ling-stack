import assert from "node:assert/strict";
import test from "node:test";
import { buildBundledCuaDriverView } from "../src/features/plugins/plugin-manager-bundled-cua-view-model.ts";
import { buildChromePluginView } from "../src/features/plugins/plugin-manager-chrome-view-model.ts";

const t = (value) => value;

test("Chrome built-in plugin distinguishes automatic Host and extension connection states", () => {
  const disabled = buildChromePluginView(chromePlugin({ status: "disabled" }), t);
  assert.equal(disabled?.primaryState.id, "disabled");
  assert.equal(disabled?.primaryAction?.id, "enable");

  const required = buildChromePluginView(chromePlugin({
    status: "enabled",
    setup: chromeSetup({ browserState: "extension_required", paired: false, connected: false }),
  }), t);
  assert.equal(required?.primaryState.id, "setup-missing");
  assert.equal(required?.primaryAction?.id, "connect-chrome");

  const hostMissing = buildChromePluginView(chromePlugin({
    status: "enabled",
    setup: chromeSetup({ browserState: "host_missing", paired: false, connected: false }),
  }), t);
  assert.equal(hostMissing?.primaryState.label, "Connection component missing");
  assert.equal(hostMissing?.primaryAction?.id, "repair-chrome-host");
  assert.equal(hostMissing?.showCheckAction, false);

  const waiting = buildChromePluginView(chromePlugin({
    status: "enabled",
    setup: chromeSetup({ browserState: "waiting_for_chrome", paired: true, connected: false }),
  }), t);
  assert.equal(waiting?.primaryState.id, "connecting");
  assert.equal(waiting?.showCheckAction, false);
  assert.deepEqual(waiting?.menuActions, []);

  const paused = buildChromePluginView(chromePlugin({
    status: "enabled",
    setup: chromeSetup({ browserState: "paused", paired: false, connected: false }),
  }), t);
  assert.equal(paused?.primaryState.label, "Paused");
  assert.equal(paused?.primaryAction?.label, "Resume in Chrome");

  const incompatible = buildChromePluginView(chromePlugin({
    status: "enabled",
    setup: chromeSetup({ browserState: "incompatible", paired: true, connected: false }),
  }), t);
  assert.equal(incompatible?.primaryState.id, "failed");
  assert.equal(incompatible?.primaryState.label, "Needs attention");
  assert.equal(incompatible?.primaryAction?.id, "connect-chrome");
  assert.equal(incompatible?.primaryAction?.label, "Update Chrome connection");
  assert.equal(incompatible?.showCheckAction, false);

  const ready = buildChromePluginView(chromePlugin({
    status: "enabled",
    setup: chromeSetup({ browserState: "ready", paired: true, connected: true }),
  }), t);
  assert.equal(ready?.primaryState.id, "ready");
  assert.equal(ready?.primaryAction, undefined);
  assert.equal(ready?.showDisableAction, true);
});

test("bundled Cua Driver maps every provider state without exposing installation guidance", () => {
  const cases = [
    ["included", "Included", "neutral", "Enable"],
    ["desktop_unavailable", "Desktop required", "warning", "Recovery steps"],
    ["permission_required", "Permissions required", "warning", "Review macOS permissions"],
    ["interactive_session_required", "Interactive session required", "warning", "Recovery steps"],
    ["platform_unavailable", "Platform unavailable", "danger", "Repair steps"],
    ["ready", "Ready", "success", undefined],
    ["incompatible", "Update required", "danger", "Repair steps"],
    ["corrupt", "Repair required", "danger", "Repair steps"],
    ["unsupported", "Unavailable", "warning", undefined],
  ];

  for (const [providerState, statusLabel, statusTone, primaryGuidance] of cases) {
    const requestedEnabled = providerState !== "included" && providerState !== "unsupported";
    const effectiveEnabled = providerState === "ready";
    const view = buildBundledCuaDriverView(plugin({
      providerState,
      requestedEnabled,
      effectiveEnabled,
      platform: providerState === "interactive_session_required" ? "win32" : "darwin",
    }, {
      canEnable: providerState === "included",
      canDisable: requestedEnabled,
    }), t);

    assert.ok(view, providerState);
    assert.equal(view.primaryState.label, statusLabel, providerState);
    assert.equal(view.primaryState.tone, statusTone, providerState);
    if (providerState === "included" || providerState === "unsupported") {
      assert.equal(view.showCheckAction, false, providerState);
    }
    assert.equal(view.primaryAction?.label, primaryGuidance, providerState);
  }
});

test("bundled Windows detail projects coverage, limitations, intent, and recovery guidance", () => {
  const view = buildBundledCuaDriverView(plugin({
    providerState: "ready",
    requestedEnabled: true,
    effectiveEnabled: true,
    platform: "win32",
    providerVersion: "0.8.3",
    providerDistributionRevision: "ling.1",
    integrity: "verified",
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
  }, {
    canEnable: false,
    canDisable: true,
  }), t);
  assert.ok(view);
  const fields = Object.fromEntries(view.overviewFields.map((field) => [field.label, field.value]));

  assert.equal(fields.Source, "Included with Ling");
  assert.equal(fields.Platform, "Windows");
  assert.equal(fields["Provider version"], "0.8.3 (Ling build 1)");
  assert.equal(fields.Requested, "Enabled status");
  assert.equal(fields["Effective readiness"], "Ready");
  assert.equal(fields.Integrity, "Verified");
  assert.equal(fields["Integrity coverage"], "Standard user apps");
  assert.equal(
    fields.Limitations,
    "Cannot send pixel input to elevated apps. · Cannot send input to UWP apps.",
  );
  assert.equal(fields["Local driver"], undefined);
});

test("platform-unavailable guidance names the actual host operating system", () => {
  const darwin = buildBundledCuaDriverView(plugin({
    providerState: "platform_unavailable",
    requestedEnabled: true,
    effectiveEnabled: false,
    platform: "darwin",
  }, { canDisable: true }), t);
  const win32 = buildBundledCuaDriverView(plugin({
    providerState: "platform_unavailable",
    requestedEnabled: true,
    effectiveEnabled: false,
    platform: "win32",
  }, { canDisable: true }), t);

  assert.equal(
    darwin?.overviewFields.find((field) => field.label === "Next step")?.value,
    "Restart or update Ling and macOS. If the problem continues, inspect the support bundle.",
  );
  assert.equal(
    win32?.overviewFields.find((field) => field.label === "Next step")?.value,
    "Restart or update Ling and Windows. If the problem continues, inspect the support bundle.",
  );
});

test("gate-off and external-local Cua Driver do not enter the bundled mapper", () => {
  assert.equal(buildBundledCuaDriverView(externalPlugin(), t), undefined);
  assert.equal(buildBundledCuaDriverView({
    ...plugin({
      providerState: "included",
      requestedEnabled: false,
      effectiveEnabled: false,
      platform: "darwin",
    }, {}),
    id: "trusted-local:not-cua-driver",
  }, t), undefined);
});

test("malformed bundled V2 setup never falls back to external installation actions", () => {
  const malformed = plugin({
    state: "missing",
    providerState: "not_a_real_state",
    requestedEnabled: undefined,
    effectiveEnabled: undefined,
    platform: "darwin",
    guide: {
      documentationUrl: "https://cua.ai/docs/cua-driver",
      installCommand: "install-cua-driver",
      supportsCustomCommand: true,
    },
  }, {
    canEnable: true,
    canDisable: true,
    canInstall: true,
    canApplyPreset: true,
  });

  const bundled = buildBundledCuaDriverView(malformed, t);
  assert.ok(bundled);
  assert.equal(bundled.primaryState.label, "Needs attention");
  assert.equal(bundled.primaryState.tone, "danger");
  assert.equal(
    bundled.overviewFields.find((field) => field.label === "Next step")?.value,
    "Restart Ling Stack. The bundled provider state is invalid.",
  );
  assert.notEqual(bundled.primaryAction?.id, "enable");

});

test("bundled external provider states normalize to invalid and suppress enable", () => {
  for (const providerState of ["external_missing", "external_detected", "external_connected"]) {
    const bundled = buildBundledCuaDriverView(plugin({
      providerState,
      requestedEnabled: false,
      effectiveEnabled: false,
      platform: "darwin",
    }, {
      canEnable: true,
    }), t);

    assert.ok(bundled);
    assert.equal(bundled.primaryState.label, "Needs attention");
    assert.equal(
      bundled.overviewFields.find((field) => field.label === "Next step")?.value,
      "Restart Ling Stack. The bundled provider state is invalid.",
    );
    assert.notEqual(bundled.primaryAction?.id, "enable");
  }
});

function plugin(setupOverrides, actionOverrides) {
  const effectiveEnabled = setupOverrides.effectiveEnabled;
  return {
    id: "trusted-local:cua-driver",
    displayName: "Cua Driver",
    version: "1.0.0",
    sourceKind: "trusted-local-preset",
    status: effectiveEnabled ? "enabled" : "disabled",
    trustSummary: "Desktop-owned embedded provider.",
    contributions: [],
    linkedResources: [],
    setup: {
      kind: "local_binary",
      schemaVersion: 2,
      distribution: "bundled_embedded",
      state: effectiveEnabled ? "ready" : "connected",
      checkedAt: "2026-07-21T00:00:00.000Z",
      limitations: [],
      ...setupOverrides,
    },
    actions: {
      canEnable: false,
      canDisable: false,
      canCheck: true,
      canApplyPreset: false,
      canInstall: false,
      canUninstall: false,
      canRefreshPackage: false,
      canRuntimePreview: false,
      ...actionOverrides,
    },
  };
}

function externalPlugin() {
  return {
    id: "trusted-local:cua-driver",
    displayName: "Cua Driver",
    version: "1.0.0",
    sourceKind: "trusted-local-preset",
    status: "available",
    trustSummary: "External local provider.",
    contributions: [],
    linkedResources: [],
    setup: {
      kind: "local_binary",
      state: "missing",
      checkedAt: "2026-07-21T00:00:00.000Z",
      guide: {
        documentationUrl: "https://cua.ai/docs/cua-driver",
        installCommand: "install-cua-driver",
        supportsCustomCommand: true,
      },
    },
    actions: {
      canEnable: false,
      canDisable: false,
      canCheck: true,
      canApplyPreset: true,
      canInstall: false,
      canUninstall: false,
      canRefreshPackage: false,
      canRuntimePreview: false,
    },
  };
}

function chromePlugin(overrides = {}) {
  return {
    id: "built-in:chrome",
    displayName: "Chrome",
    version: "0.1.0",
    sourceKind: "built-in",
    status: "disabled",
    trustSummary: "Uses an explicitly paired extension.",
    contributions: [],
    linkedResources: [],
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
    ...overrides,
  };
}

function chromeSetup(overrides = {}) {
  return {
    kind: "browser_extension",
    state: "missing",
    checkedAt: "2026-08-17T00:00:00.000Z",
    browserFamily: "chrome",
    browserState: "extension_required",
    paired: false,
    connected: false,
    ...overrides,
  };
}
