import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { resolveEligibleCuaDriverProjectionServerIds } from "../dist/features/computer-use/provider-eligibility.js";
import { createManagedPluginRuntimeSnapshot } from "../dist/features/plugins/runtime-injection.js";
import { listBundledPackageDescriptors } from "../dist/features/plugins/source-index.js";
import {
  addLegacyCuaProviderOwner,
  approvedWindowsCuaHealthDetails,
  CUA_MCP_SERVER_ID,
  seedManagedCuaProvider,
} from "./computer-use-test-fixtures.mjs";

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
