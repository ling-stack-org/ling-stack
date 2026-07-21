import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { listManagedPluginViews } from "../dist/features/plugins/catalog.js";
import { buildManagedPluginPolicyOverlays } from "../dist/features/plugins/policy-overlay.js";
import {
  createBundledCuaDriverLogicalMcpServerInput,
  createCuaDriverDescriptor,
} from "../dist/features/plugins/presets.js";

const now = "2026-07-20T00:00:00.000Z";
const pluginId = "trusted-local:cua-driver";
const serverId = "mcp_cua_driver";
const supportedPlatform = process.platform === "darwin" || process.platform === "win32";
const featureFlags = {
  bundledEmbedded: { darwin: true, win32: true },
  packagedProvider: { darwin: true, win32: true },
};

test("bundled Cua Driver catalog projects disabled, waiting, ready, and failed action states", {
  skip: !supportedPlatform,
}, async (t) => {
  const cases = [
    {
      name: "disabled",
      seed: { requestedEnabled: false, effectiveEnabled: false },
      expected: {
        status: "disabled",
        providerState: "included",
        setupState: "connected",
        canEnable: true,
        canDisable: false,
      },
    },
    {
      name: "requested-waiting",
      seed: {
        requestedEnabled: true,
        effectiveEnabled: false,
        providerState: "desktop_unavailable",
      },
      expected: {
        status: "disabled",
        providerState: "desktop_unavailable",
        setupState: "connected",
        canEnable: false,
        canDisable: true,
      },
    },
    {
      name: "ready",
      seed: {
        requestedEnabled: true,
        effectiveEnabled: true,
        providerState: "ready",
      },
      expected: {
        status: "enabled",
        providerState: "ready",
        setupState: "ready",
        canEnable: false,
        canDisable: true,
      },
    },
    {
      name: "failed",
      seed: {
        requestedEnabled: true,
        effectiveEnabled: false,
        providerState: "corrupt",
      },
      expected: {
        status: "disabled",
        providerState: "corrupt",
        setupState: "connected",
        canEnable: false,
        canDisable: true,
      },
    },
    ...[
      "permission_required",
      "interactive_session_required",
      "platform_unavailable",
      "incompatible",
    ].map((providerState) => ({
      name: providerState,
      seed: {
        requestedEnabled: true,
        effectiveEnabled: false,
        providerState,
      },
      expected: {
        status: "disabled",
        providerState,
        setupState: "connected",
        canEnable: false,
        canDisable: true,
      },
    })),
    {
      name: "stale-external-health",
      seed: {
        requestedEnabled: true,
        effectiveEnabled: false,
        providerState: "external_missing",
      },
      expected: {
        status: "disabled",
        providerState: "desktop_unavailable",
        setupState: "connected",
        canEnable: false,
        canDisable: true,
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `ling-cua-catalog-${fixture.name}-`));
      const store = createSqliteRunStore(cwd);
      try {
        seedCatalogState(store, fixture.seed);
        const plugin = listManagedPluginViews({
          cwd,
          extensionRegistry: {},
          store,
          now,
          cuaDriverRuntimeAuthority: runtimeAuthority(cwd),
          cuaDriverFeatureFlags: featureFlags,
        }).find((view) => view.id === pluginId);

        assert.ok(plugin);
        assert.equal(plugin.status, fixture.expected.status);
        assert.equal(plugin.setup?.schemaVersion, 2);
        assert.equal(plugin.setup?.distribution, "bundled_embedded");
        assert.equal(plugin.setup?.requestedEnabled, fixture.seed.requestedEnabled);
        assert.equal(plugin.setup?.effectiveEnabled, fixture.seed.effectiveEnabled);
        assert.equal(plugin.setup?.providerState, fixture.expected.providerState);
        assert.equal(plugin.setup?.state, fixture.expected.setupState);
        assert.equal(plugin.actions.canEnable, fixture.expected.canEnable);
        assert.equal(plugin.actions.canDisable, fixture.expected.canDisable);
        assert.equal(plugin.actions.canCheck, true);
        assert.equal(plugin.actions.canApplyPreset, false);
      } finally {
        store.close();
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});

test("bundled Cua Driver catalog hides every stale provider state without a current Desktop lease", {
  skip: !supportedPlatform,
}, async (t) => {
  for (const providerState of [
    "ready",
    "permission_required",
    "interactive_session_required",
    "platform_unavailable",
    "incompatible",
    "corrupt",
  ]) {
    await t.test(providerState, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `ling-cua-catalog-stale-${providerState}-`));
      const store = createSqliteRunStore(cwd);
      try {
        seedCatalogState(store, {
          requestedEnabled: true,
          effectiveEnabled: providerState === "ready",
          providerState,
        });
        const plugin = listManagedPluginViews({
          cwd,
          extensionRegistry: {},
          store,
          now,
          cuaDriverRuntimeAuthority: runtimeAuthority(cwd, false),
          cuaDriverFeatureFlags: featureFlags,
        }).find((view) => view.id === pluginId);

        assert.ok(plugin);
        assert.equal(plugin.status, "disabled");
        assert.equal(plugin.setup?.requestedEnabled, true);
        assert.equal(plugin.setup?.effectiveEnabled, false);
        assert.equal(plugin.setup?.providerState, "desktop_unavailable");
        assert.equal(plugin.setup?.state, "connected");
        assert.equal(
          plugin.contributions.find((contribution) => contribution.kind === "mcp-server")?.enabled,
          false,
        );
        assert.equal(
          plugin.linkedResources.find((resource) => resource.id === serverId)?.enabled,
          false,
        );
      } finally {
        store.close();
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});

test("bundled Cua Driver catalog projects bounded provider metadata and platform-valid limitations", {
  skip: !supportedPlatform,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-catalog-metadata-"));
  const store = createSqliteRunStore(cwd);
  try {
    seedCatalogState(store, {
      requestedEnabled: true,
      effectiveEnabled: true,
      providerState: "ready",
      healthDetails: {
        providerVersion: "0.8.3",
        providerDistributionRevision: "ling.1",
        providerSealDigest: "a".repeat(64),
        providerCatalogDigest: "b".repeat(64),
        integrityCoverage: "standard",
        limitations: ["elevated_pixel_input", "uwp_send_input"],
      },
    });
    const plugin = listManagedPluginViews({
      cwd,
      extensionRegistry: {},
      store,
      now,
      cuaDriverRuntimeAuthority: runtimeAuthority(cwd),
      cuaDriverFeatureFlags: featureFlags,
    }).find((view) => view.id === pluginId);

    assert.ok(plugin);
    assert.equal(plugin.setup?.providerVersion, "0.8.3");
    assert.equal(plugin.setup?.providerDistributionRevision, "ling.1");
    assert.equal(plugin.setup?.providerSealDigest, "a".repeat(64));
    assert.equal(plugin.setup?.providerCatalogDigest, "b".repeat(64));
    assert.equal(plugin.setup?.integrityCoverage, process.platform === "win32" ? "standard" : undefined);
    assert.deepEqual(
      plugin.setup?.limitations,
      process.platform === "win32" ? ["elevated_pixel_input", "uwp_send_input"] : [],
    );

    store.upsertManagedPluginHealthSnapshot({
      pluginId,
      checkedAt: "2026-07-20T00:01:00.000Z",
      expiresAt: "2026-07-20T01:01:00.000Z",
      status: "ready",
      details: {
        providerState: "ready",
        providerVersion: "x".repeat(129),
        providerDistributionRevision: "y".repeat(129),
        providerSealDigest: "A".repeat(64),
        providerCatalogDigest: "not-a-digest",
        integrityCoverage: "standard",
        limitations: ["elevated_pixel_input"],
      },
    }, "2026-07-20T00:01:00.000Z");
    const rejected = listManagedPluginViews({
      cwd,
      extensionRegistry: {},
      store,
      now: "2026-07-20T00:01:00.000Z",
      cuaDriverRuntimeAuthority: runtimeAuthority(cwd),
      cuaDriverFeatureFlags: featureFlags,
    }).find((view) => view.id === pluginId);
    assert.ok(rejected);
    assert.equal(rejected.setup?.providerVersion, undefined);
    assert.equal(rejected.setup?.providerDistributionRevision, undefined);
    assert.equal(rejected.setup?.providerSealDigest, undefined);
    assert.equal(rejected.setup?.providerCatalogDigest, undefined);
    assert.equal(rejected.setup?.integrityCoverage, undefined);
    assert.deepEqual(rejected.setup?.limitations, []);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("canonical bundled runtime applies the Cua deny overlay without changing external mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-catalog-policy-"));
  const store = createSqliteRunStore(cwd);
  try {
    const descriptor = createCuaDriverDescriptor();
    store.createMcpServer(createBundledCuaDriverLogicalMcpServerInput(), now);
    store.replaceMcpServerTools(serverId, [{
      rawName: "replay_trajectory",
      displayName: "Replay trajectory",
      inputSchema: { type: "object" },
      callableNamespace: serverId,
      callableName: "replay_trajectory",
      sideEffectLevel: "external",
      defaultApproval: "deny",
      enabled: true,
    }], now);

    const bundled = buildManagedPluginPolicyOverlays({
      store,
      descriptor,
      bundledEmbedded: true,
    });
    assert.equal(
      bundled.find((overlay) => overlay.targetId === `${serverId}:replay_trajectory`)?.defaultApproval,
      "deny",
    );
    assert.deepEqual(buildManagedPluginPolicyOverlays({
      store,
      descriptor,
      bundledEmbedded: false,
    }), []);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function seedCatalogState(store, seed) {
  if (!seed.requestedEnabled && !seed.effectiveEnabled && !seed.providerState) {
    return;
  }
  const descriptor = createCuaDriverDescriptor();
  store.upsertManagedPlugin({
    id: pluginId,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    enabled: seed.requestedEnabled,
    descriptor,
  }, now);
  const server = store.createMcpServer(createBundledCuaDriverLogicalMcpServerInput(), now);
  store.replaceManagedPluginContributions(pluginId, [{
    contributionKind: "mcp-server",
    contributionId: serverId,
    linkedResourceId: server.id,
    enabled: seed.effectiveEnabled,
  }], now);
  store.ensureCuaDriverActivationState(pluginId, now);
  if (seed.requestedEnabled !== seed.effectiveEnabled) {
    store.updateManagedPlugin(pluginId, { enabled: seed.effectiveEnabled }, now);
  }
  if (seed.effectiveEnabled) {
    store.updateMcpServer(serverId, { enabled: true }, now);
  }
  if (seed.providerState) {
    store.upsertManagedPluginHealthSnapshot({
      pluginId,
      checkedAt: now,
      expiresAt: "2026-07-20T01:00:00.000Z",
      status: seed.providerState === "ready" ? "ready" : "failed",
      details: { providerState: seed.providerState, ...seed.healthDetails },
    }, now);
  }
}

function runtimeAuthority(cwd, hasCurrentLease = true) {
  return {
    enabled: true,
    workspaceCwd: cwd,
    platform: process.platform,
    hasCurrentLease: () => hasCurrentLease,
  };
}
