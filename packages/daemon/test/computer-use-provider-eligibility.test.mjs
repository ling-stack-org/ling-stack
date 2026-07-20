import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import {
  resolveEligibleCuaDriverProjectionServerIds,
  resolveManagedCuaDriverProvider,
} from "../dist/features/computer-use/provider-eligibility.js";
import { createManagedPluginRuntimeSnapshot } from "../dist/features/plugins/runtime-injection.js";
import { listBundledPackageDescriptors } from "../dist/features/plugins/source-index.js";
import {
  createBundledCuaDriverLogicalMcpServerInput,
  createCuaDriverDescriptor,
} from "../dist/features/plugins/presets.js";
import {
  addLegacyCuaProviderOwner,
  approvedWindowsCuaHealthDetails,
  CUA_MCP_SERVER_ID,
  seedManagedCuaProvider,
} from "./computer-use-test-fixtures.mjs";

test("Cua projection eligibility accepts the canonical bundled lease runtime without a package-cache record", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-embedded-eligibility-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-07-21T00:00:00.000Z";
  try {
    const {
      descriptor,
      descriptors,
      server,
      cuaDriverRuntimeAuthority,
    } = seedReadyEmbeddedProvider(store, cwd, now);
    assert.equal(store.getManagedPluginPackage(descriptor.id), undefined);
    const runtimeSnapshot = createManagedPluginRuntimeSnapshot({
      cwd,
      runId: "run_embedded_provider",
      store,
      descriptors,
      now,
      cuaDriverRuntimeAuthority,
    });
    assert.deepEqual(
      runtimeSnapshot.capabilities.map((capability) => capability.pluginId),
      [descriptor.id],
    );
    assert.equal(runtimeSnapshot.capabilities[0].package, undefined);
    assert.deepEqual(resolveEligibleCuaDriverProjectionServerIds({
      store,
      descriptors,
      runtimeSnapshot,
      runId: "run_embedded_provider",
      cwd,
      now,
      authorizedServerIds: [server.id],
      cuaDriverRuntimeAuthority,
    }), [server.id]);
    assert.equal(
      resolveManagedCuaDriverProvider({
        store,
        descriptors,
        now,
        cuaDriverRuntimeAuthority,
      })?.descriptor.id,
      descriptor.id,
    );
    assert.equal(resolveManagedCuaDriverProvider({
      store,
      descriptors,
      now,
      platform: process.platform === "win32" ? "darwin" : "win32",
      cuaDriverRuntimeAuthority,
    }), undefined);
    const noLeaseAuthority = {
      ...cuaDriverRuntimeAuthority,
      hasCurrentLease: () => false,
    };
    assert.deepEqual(createManagedPluginRuntimeSnapshot({
      cwd,
      runId: "run_embedded_projection_pending",
      store,
      descriptors,
      now,
      cuaDriverRuntimeAuthority: noLeaseAuthority,
    }).capabilities, []);
    assert.equal(resolveManagedCuaDriverProvider({
      store,
      descriptors,
      now,
      cuaDriverRuntimeAuthority: noLeaseAuthority,
    }), undefined);

    store.updateMcpServer(server.id, {
      transport: {
        type: "stdio",
        command: "/tmp/external-cua-driver",
        args: ["mcp"],
        env: {},
        secretEnvRefs: {},
      },
    }, "2026-07-21T00:00:01.000Z");
    const externalSnapshot = createManagedPluginRuntimeSnapshot({
      cwd,
      runId: "run_external_not_embedded",
      store,
      descriptors,
      now: "2026-07-21T00:00:02.000Z",
      cuaDriverRuntimeAuthority,
    });
    assert.deepEqual(externalSnapshot.capabilities, []);
    assert.equal(
      resolveManagedCuaDriverProvider({
        store,
        descriptors,
        now: "2026-07-21T00:00:02.000Z",
        cuaDriverRuntimeAuthority,
      }),
      undefined,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bundled eligibility fails closed for every inconsistent durable activation projection", async (t) => {
  const now = "2026-07-21T00:00:00.000Z";
  const mutatedAt = "2026-07-21T00:00:01.000Z";
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const scenarios = [
    {
      name: "requested intent disabled",
      mutate({ store, descriptor, server }) {
        const state = store.getCuaDriverActivationState(descriptor.id);
        assert.ok(state);
        const disabled = store.commitCuaDriverActivation({
          pluginId: descriptor.id,
          mcpServerId: server.id,
          now: mutatedAt,
          expected: {
            requestedRevision: state.requestedRevision,
            activationEpoch: state.activationEpoch,
          },
          requestedEnabled: false,
          requestedRevision: state.requestedRevision + 1,
          activationEpoch: state.activationEpoch + 1,
          effectiveEnabled: false,
          pluginEnabled: false,
          contributionEnabled: false,
          mcpServerEnabled: false,
          tools: [],
          statusSnapshot: null,
          healthSnapshot: null,
          disabledReason: "disabled for eligibility test",
        });
        assert.equal(disabled.committed, true);
      },
    },
    {
      name: "managed plugin disabled",
      mutate({ store, descriptor }) {
        store.upsertManagedPlugin({
          id: descriptor.id,
          sourceKind: descriptor.sourceKind,
          version: descriptor.version,
          enabled: false,
          descriptor,
        }, mutatedAt);
      },
    },
    {
      name: "managed plugin identity mismatch",
      mutate({ store, descriptor }) {
        store.upsertManagedPlugin({
          id: descriptor.id,
          sourceKind: descriptor.sourceKind,
          version: "9.9.9",
          enabled: true,
          descriptor,
        }, mutatedAt);
      },
    },
    {
      name: "MCP contribution disabled",
      mutate({ store, descriptor, server }) {
        store.replaceManagedPluginContributions(descriptor.id, [{
          contributionKind: "mcp-server",
          contributionId: CUA_MCP_SERVER_ID,
          linkedResourceId: server.id,
          enabled: false,
        }], mutatedAt);
      },
    },
    {
      name: "MCP contribution linked to the wrong resource",
      mutate({ store, descriptor }) {
        store.replaceManagedPluginContributions(descriptor.id, [{
          contributionKind: "mcp-server",
          contributionId: CUA_MCP_SERVER_ID,
          enabled: true,
        }], mutatedAt);
      },
    },
    {
      name: "canonical MCP server has a conflicting owner",
      mutate({ store, descriptor, server }) {
        const conflictingDescriptor = {
          ...descriptor,
          id: "trusted-local:cua-driver-conflict",
          name: "Conflicting Cua Driver owner",
        };
        store.upsertManagedPlugin({
          id: conflictingDescriptor.id,
          sourceKind: conflictingDescriptor.sourceKind,
          version: conflictingDescriptor.version,
          enabled: true,
          descriptor: conflictingDescriptor,
        }, mutatedAt);
        store.replaceManagedPluginContributions(conflictingDescriptor.id, [{
          contributionKind: "mcp-server",
          contributionId: "mcp_cua_driver_conflict",
          linkedResourceId: server.id,
          enabled: true,
        }], mutatedAt);
      },
    },
    {
      name: "canonical MCP server disabled",
      mutate({ store, server }) {
        store.updateMcpServer(server.id, { enabled: false }, mutatedAt);
      },
    },
    {
      name: "plugin health is not ready",
      mutate({ store, descriptor }) {
        store.upsertManagedPluginHealthSnapshot({
          pluginId: descriptor.id,
          checkedAt: mutatedAt,
          expiresAt,
          status: "failed",
          details: { providerState: "failed" },
        }, mutatedAt);
      },
    },
    {
      name: "MCP health is not ready",
      mutate({ store, server }) {
        store.upsertMcpStatusSnapshot({
          ...readyMcpStatus(server.id, mutatedAt),
          status: "failed",
          toolCount: 0,
          errorCode: "forced_mcp_failure",
        }, mutatedAt);
      },
    },
    {
      name: "provider state disagrees with ready health",
      mutate({ store, descriptor }) {
        store.upsertManagedPluginHealthSnapshot({
          pluginId: descriptor.id,
          checkedAt: mutatedAt,
          expiresAt,
          status: "ready",
          details: { providerState: "permission_required" },
        }, mutatedAt);
      },
    },
    {
      name: "activation mutation is newer than otherwise-current readiness",
      mutate({ store, descriptor, server }) {
        const state = store.getCuaDriverActivationState(descriptor.id);
        assert.ok(state);
        const recommitted = store.commitCuaDriverActivation({
          pluginId: descriptor.id,
          mcpServerId: server.id,
          now: mutatedAt,
          expected: {
            requestedRevision: state.requestedRevision,
            activationEpoch: state.activationEpoch,
          },
          requestedEnabled: true,
          requestedRevision: state.requestedRevision,
          activationEpoch: state.activationEpoch + 1,
          effectiveEnabled: true,
          pluginEnabled: true,
          contributionEnabled: true,
          mcpServerEnabled: true,
          tools: [listWindowsTool()],
          statusSnapshot: readyMcpStatus(server.id, now),
          healthSnapshot: {
            pluginId: descriptor.id,
            checkedAt: now,
            expiresAt,
            status: "ready",
            details: { providerState: "ready" },
          },
          disabledReason: null,
        });
        assert.equal(recommitted.committed, true);
        store.replaceManagedPluginContributions(descriptor.id, [{
          contributionKind: "mcp-server",
          contributionId: CUA_MCP_SERVER_ID,
          linkedResourceId: server.id,
          enabled: true,
        }], now);
        store.updateMcpServer(server.id, {
          displayName: server.displayName,
        }, now);
      },
    },
    {
      name: "contribution mutation is newer than otherwise-current readiness",
      mutate({ store, descriptor, server }) {
        store.replaceManagedPluginContributions(descriptor.id, [{
          contributionKind: "mcp-server",
          contributionId: CUA_MCP_SERVER_ID,
          linkedResourceId: server.id,
          enabled: true,
        }], mutatedAt);
      },
    },
    {
      name: "server mutation is newer than readiness snapshots",
      mutate({ store, server }) {
        store.updateMcpServer(server.id, {
          displayName: "Cua Driver changed after readiness",
        }, mutatedAt);
      },
    },
    {
      name: "server mutation is newer only than MCP readiness",
      mutate({ store, descriptor, server }) {
        store.updateMcpServer(server.id, {
          displayName: "Cua Driver changed after MCP readiness",
        }, mutatedAt);
        store.upsertManagedPluginHealthSnapshot({
          pluginId: descriptor.id,
          checkedAt: mutatedAt,
          expiresAt,
          status: "ready",
          details: { providerState: "ready" },
        }, mutatedAt);
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cua-durable-inconsistency-"));
      const store = createSqliteRunStore(cwd);
      try {
        const fixture = seedReadyEmbeddedProvider(store, cwd, now);
        assert.equal(resolveManagedCuaDriverProvider({
          store,
          descriptors: fixture.descriptors,
          now,
          cuaDriverRuntimeAuthority: fixture.cuaDriverRuntimeAuthority,
        })?.descriptor.id, fixture.descriptor.id);

        scenario.mutate({ store, ...fixture });

        assert.equal(resolveManagedCuaDriverProvider({
          store,
          descriptors: fixture.descriptors,
          now: mutatedAt,
          cuaDriverRuntimeAuthority: fixture.cuaDriverRuntimeAuthority,
        }), undefined);
      } finally {
        store.close();
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
});

test("Cua projection eligibility requires the approved bundled package and exact Windows provider version", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-provider-eligibility-"));
  const store = createSqliteRunStore(cwd);
  const now = new Date().toISOString();
  try {
    seedManagedCuaProvider(store, {
      now,
      pluginHealthDetails: approvedWindowsCuaHealthDetails("0.8.3"),
    });
    const descriptors = listBundledPackageDescriptors();
    const approvedSnapshot = createManagedPluginRuntimeSnapshot({
      cwd,
      runId: "run_approved_provider",
      store,
      descriptors,
      now,
    });
    assert.deepEqual(resolveEligibleCuaDriverProjectionServerIds({
      store,
      descriptors,
      runtimeSnapshot: approvedSnapshot,
      runId: "run_approved_provider",
      cwd,
      now,
      authorizedServerIds: [CUA_MCP_SERVER_ID],
      platform: "win32",
    }), [CUA_MCP_SERVER_ID]);

    addLegacyCuaProviderOwner(store, { now });
    const sharedOwnerSnapshot = createManagedPluginRuntimeSnapshot({
      cwd,
      runId: "run_shared_provider_owner",
      store,
      descriptors,
      now,
    });
    assert.deepEqual(resolveEligibleCuaDriverProjectionServerIds({
      store,
      descriptors,
      runtimeSnapshot: sharedOwnerSnapshot,
      runId: "run_shared_provider_owner",
      cwd,
      now,
      authorizedServerIds: [CUA_MCP_SERVER_ID],
      platform: "win32",
    }), []);
    store.replaceManagedPluginContributions("trusted-local:cua-driver", [], now);

    const expiresAt = new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();
    store.upsertManagedPluginHealthSnapshot({
      pluginId: "bundled:cua-driver",
      status: "ready",
      checkedAt: now,
      expiresAt,
      details: approvedWindowsCuaHealthDetails("0.8.4"),
    }, now);
    const unapprovedProviderSnapshot = createManagedPluginRuntimeSnapshot({
      cwd,
      runId: "run_unapproved_provider",
      store,
      descriptors,
      now,
    });
    assert.deepEqual(resolveEligibleCuaDriverProjectionServerIds({
      store,
      descriptors,
      runtimeSnapshot: unapprovedProviderSnapshot,
      runId: "run_unapproved_provider",
      cwd,
      now,
      authorizedServerIds: [CUA_MCP_SERVER_ID],
      platform: "win32",
    }), []);

    const packageRecord = store.getManagedPluginPackage("bundled:cua-driver");
    assert.ok(packageRecord);
    store.upsertManagedPluginPackage({
      pluginId: packageRecord.pluginId,
      sourceKind: packageRecord.sourceKind,
      version: "9.9.9",
      status: "installed",
      cacheRef: packageRecord.cacheRef,
      packageHash: packageRecord.packageHash,
      manifestJson: packageRecord.manifestJson,
      installedAt: packageRecord.installedAt,
    }, now);
    store.upsertManagedPluginHealthSnapshot({
      pluginId: "bundled:cua-driver",
      status: "ready",
      checkedAt: now,
      expiresAt,
      details: approvedWindowsCuaHealthDetails("0.8.3"),
    }, now);
    const unapprovedPackageSnapshot = createManagedPluginRuntimeSnapshot({
      cwd,
      runId: "run_unapproved_package",
      store,
      descriptors,
      now,
    });
    assert.deepEqual(resolveEligibleCuaDriverProjectionServerIds({
      store,
      descriptors,
      runtimeSnapshot: unapprovedPackageSnapshot,
      runId: "run_unapproved_package",
      cwd,
      now,
      authorizedServerIds: [CUA_MCP_SERVER_ID],
      platform: "win32",
    }), []);

    store.upsertManagedPluginPackage({
      pluginId: packageRecord.pluginId,
      sourceKind: packageRecord.sourceKind,
      version: packageRecord.version,
      status: "installed",
      cacheRef: packageRecord.cacheRef,
      packageHash: packageRecord.packageHash,
      manifestJson: packageRecord.manifestJson,
      installedAt: packageRecord.installedAt,
    }, now);
    store.updateMcpServer(CUA_MCP_SERVER_ID, {
      displayName: "Cua Driver mutated after health check",
    }, new Date(Date.parse(now) + 1).toISOString());
    const staleNow = new Date(Date.parse(now) + 2).toISOString();
    store.upsertMcpStatusSnapshot({
      serverId: CUA_MCP_SERVER_ID,
      status: "ready",
      authStatus: { kind: "not_required", refs: [], missingRefs: [] },
      missingSecretRefs: [],
      checkedAt: staleNow,
      expiresAt: new Date(Date.parse(staleNow) + 10 * 60 * 1000).toISOString(),
      toolCount: 0,
    }, staleNow);
    const staleHealthSnapshot = createManagedPluginRuntimeSnapshot({
      cwd,
      runId: "run_stale_health",
      store,
      descriptors,
      now: staleNow,
    });
    assert.deepEqual(resolveEligibleCuaDriverProjectionServerIds({
      store,
      descriptors,
      runtimeSnapshot: staleHealthSnapshot,
      runId: "run_stale_health",
      cwd,
      now: staleNow,
      authorizedServerIds: [CUA_MCP_SERVER_ID],
      platform: "win32",
    }), []);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function seedReadyEmbeddedProvider(store, cwd, now) {
  const descriptor = createCuaDriverDescriptor();
  store.upsertManagedPlugin({
    id: descriptor.id,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    enabled: false,
    descriptor,
  }, now);
  const server = store.createMcpServer(createBundledCuaDriverLogicalMcpServerInput(), now);
  store.replaceManagedPluginContributions(descriptor.id, [{
    contributionKind: "mcp-server",
    contributionId: CUA_MCP_SERVER_ID,
    linkedResourceId: server.id,
    enabled: false,
  }], now);
  const state = store.ensureCuaDriverActivationState(descriptor.id, now);
  const ready = store.commitCuaDriverActivation({
    pluginId: descriptor.id,
    mcpServerId: server.id,
    now,
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
    tools: [listWindowsTool()],
    statusSnapshot: readyMcpStatus(server.id, now),
    healthSnapshot: {
      pluginId: descriptor.id,
      checkedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      status: "ready",
      details: { providerState: "ready" },
    },
    disabledReason: null,
  });
  assert.equal(ready.committed, true);
  return {
    descriptor,
    descriptors: [...listBundledPackageDescriptors(), descriptor],
    server,
    cuaDriverRuntimeAuthority: {
      enabled: true,
      workspaceCwd: cwd,
      platform: process.platform,
      hasCurrentLease: () => true,
    },
  };
}

function listWindowsTool() {
  return {
    rawName: "list_windows",
    displayName: "List windows",
    inputSchema: { type: "object" },
    callableNamespace: CUA_MCP_SERVER_ID,
    callableName: "list_windows",
    sideEffectLevel: "read",
    defaultApproval: "allow",
    enabled: true,
  };
}

function readyMcpStatus(serverId, now) {
  return {
    serverId,
    checkedAt: now,
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "ready",
    toolCount: 1,
    missingSecretRefs: [],
    authStatus: { kind: "not_required", refs: [], missingRefs: [] },
  };
}
