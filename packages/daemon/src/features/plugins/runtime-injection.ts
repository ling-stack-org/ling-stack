import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type LingStackRuntimePaths,
  type ManagedPluginDescriptor,
  type ManagedPluginLinkedResource,
  type ManagedPluginPackageRecord,
  type ManagedPluginPackageView,
  type ManagedPluginRuntimePreview,
  type ManagedPluginRuntimeSnapshot,
  type ManagedPluginStoreFacet,
  type McpStoreFacet,
  type RunStorePathsFacet,
  type CuaDriverActivationStoreFacet,
} from "@ling-stack/core";
import { buildManagedPluginPolicyOverlays } from "./policy-overlay.js";
import {
  isBundledEmbeddedCuaDriverRuntime,
  isBundledEmbeddedCuaDriverSelected,
} from "./cua-driver-runtime-mode.js";
import { BUNDLED_CUA_DRIVER_PLUGIN_ID } from "./bundled-index.js";
import { CUA_DRIVER_PLUGIN_ID } from "./presets.js";

type ManagedPluginRuntimeStore =
  ManagedPluginStoreFacet &
  McpStoreFacet &
  RunStorePathsFacet &
  CuaDriverActivationStoreFacet;

export function buildManagedPluginRuntimePreview(input: {
  readonly cwd: string;
  readonly store: ManagedPluginRuntimeStore;
  readonly descriptor: ManagedPluginDescriptor;
  readonly now: string;
  readonly cuaDriverRuntimeAuthority?: {
    readonly enabled: boolean;
    readonly workspaceCwd: string;
    readonly platform: NodeJS.Platform;
    readonly hasCurrentLease: () => boolean;
  };
}): ManagedPluginRuntimePreview {
  const record = input.store.getManagedPlugin(input.descriptor.id);
  const packageRecord = input.store.getManagedPluginPackage(input.descriptor.id);
  const bundledEmbedded = input.descriptor.id === CUA_DRIVER_PLUGIN_ID
    && input.cuaDriverRuntimeAuthority !== undefined
    && isBundledEmbeddedCuaDriverRuntime(
      input.store,
      input.cuaDriverRuntimeAuthority,
      input.store.paths.cwd,
    );
  const blockers: string[] = [];
  if (!record?.enabled) {
    blockers.push("Plugin is disabled.");
  }
  if (!bundledEmbedded && (!packageRecord || packageRecord.status !== "installed")) {
    blockers.push("Plugin package is not installed.");
  } else if (!bundledEmbedded && packageRecord && !cacheRefExists(input.store.paths, packageRecord.cacheRef)) {
    blockers.push("Installed plugin package cache is missing.");
  }
  const health = input.store.getManagedPluginHealthSnapshot(input.descriptor.id, input.now);
  if (
    (input.descriptor.id === "bundled:cua-driver" || bundledEmbedded)
    && health?.status !== "ready"
  ) {
    blockers.push(
      health?.message ?? "Cua Driver runtime health has not been verified.",
    );
  } else if (health?.status === "failed" || health?.status === "expired") {
    blockers.push(health.message ?? `Plugin health is ${health.status}.`);
  }

  const linkedResources = resolveLinkedResources(input.store, input.descriptor);
  for (const contribution of input.descriptor.contributions) {
    const linked = linkedResources.find((resource) => resource.kind === contribution.kind);
    if (contribution.kind === "mcp-server" && (!linked || !linked.present)) {
      blockers.push(`Linked MCP server is missing for ${contribution.id}.`);
    }
  }

  const status = !record?.enabled
    ? "disabled"
    : blockers.length > 0
      ? "blocked"
      : "injectable";
  const policyOverlays = status === "injectable"
    ? buildManagedPluginPolicyOverlays({
        store: input.store,
        descriptor: input.descriptor,
        bundledEmbedded,
      })
    : [];
  return {
    pluginId: input.descriptor.id,
    status,
    package: packageRecord ? toManagedPluginPackageView(packageRecord) : undefined,
    mcpServers: linkedResources.filter((resource) => resource.kind === "mcp-server"),
    skillPacks: linkedResources.filter((resource) => resource.kind === "skill-pack"),
    apps: [],
    hooks: [],
    policyOverlays,
    blockers,
  };
}

export function createManagedPluginRuntimeSnapshot(input: {
  readonly cwd: string;
  readonly runId?: string;
  readonly store: ManagedPluginRuntimeStore;
  readonly descriptors: readonly ManagedPluginDescriptor[];
  readonly now: string;
  readonly cuaDriverRuntimeAuthority?: {
    readonly enabled: boolean;
    readonly workspaceCwd: string;
    readonly platform: NodeJS.Platform;
    readonly hasCurrentLease: () => boolean;
  };
}): ManagedPluginRuntimeSnapshot {
  const capabilities = input.descriptors
    .map((descriptor) => buildManagedPluginRuntimePreview({
      cwd: input.cwd,
      store: input.store,
      descriptor,
      now: input.now,
      cuaDriverRuntimeAuthority: input.cuaDriverRuntimeAuthority,
    }))
    .filter((preview) => preview.status === "injectable");
  const policyOverlays = capabilities.flatMap((preview) =>
    preview.policyOverlays.map((overlay) => ({ ...overlay }))
  );
  const selectedPluginIds = new Set(capabilities.map((preview) => preview.pluginId));
  if (
    input.cuaDriverRuntimeAuthority
    && isBundledEmbeddedCuaDriverSelected(
      input.cuaDriverRuntimeAuthority,
      input.store.paths.cwd,
    )
    && input.descriptors.some((descriptor) => descriptor.id === BUNDLED_CUA_DRIVER_PLUGIN_ID)
  ) {
    // Preserve package selection in the run snapshot even when the current
    // Desktop lease blocks injection. Do not mark every disabled descriptor
    // as selected merely because it exists in the bundled source index.
    selectedPluginIds.add(BUNDLED_CUA_DRIVER_PLUGIN_ID);
  }
  const pluginIds = [...new Set(
    input.descriptors
      .map((descriptor) => descriptor.id)
      .filter((pluginId) => selectedPluginIds.has(pluginId)),
  )];
  const snapshot = input.store.createManagedPluginRuntimeSnapshot({
    runId: input.runId,
    cwd: input.cwd,
    pluginIds,
    capabilities,
    policyOverlays,
    createdAt: input.now,
  });
  return snapshot;
}

export function toManagedPluginPackageView(packageRecord: ManagedPluginPackageRecord): ManagedPluginPackageView {
  return {
    pluginId: packageRecord.pluginId,
    sourceKind: packageRecord.sourceKind,
    version: packageRecord.version,
    status: packageRecord.status,
    cacheRef: packageRecord.cacheRef,
    packageHash: packageRecord.packageHash,
    installedAt: packageRecord.installedAt,
    updatedAt: packageRecord.updatedAt,
    uninstalledAt: packageRecord.uninstalledAt,
  };
}

function cacheRefExists(paths: LingStackRuntimePaths, cacheRef: string): boolean {
  return existsSync(join(paths.pluginCacheDir, cacheRef));
}

function resolveLinkedResources(store: ManagedPluginRuntimeStore, descriptor: ManagedPluginDescriptor): ManagedPluginLinkedResource[] {
  const records = store.listManagedPluginContributions(descriptor.id);
  return records.map((record) => {
    if (record.contributionKind === "mcp-server" && record.linkedResourceId) {
      const server = store.getMcpServer(record.linkedResourceId);
      return {
        kind: record.contributionKind,
        id: record.linkedResourceId,
        present: Boolean(server),
        enabled: server?.enabled,
        displayName: server?.displayName,
      };
    }
    return {
      kind: record.contributionKind,
      id: record.linkedResourceId ?? record.contributionId,
      present: Boolean(record.linkedResourceId),
      enabled: record.enabled,
    };
  });
}
