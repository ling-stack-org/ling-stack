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
} from "@ling-stack/core";
import { buildManagedPluginPolicyOverlays } from "./policy-overlay.js";

type ManagedPluginRuntimeStore =
  ManagedPluginStoreFacet &
  McpStoreFacet &
  RunStorePathsFacet;

export function buildManagedPluginRuntimePreview(input: {
  readonly cwd: string;
  readonly store: ManagedPluginRuntimeStore;
  readonly descriptor: ManagedPluginDescriptor;
  readonly now: string;
}): ManagedPluginRuntimePreview {
  const record = input.store.getManagedPlugin(input.descriptor.id);
  const packageRecord = input.store.getManagedPluginPackage(input.descriptor.id);
  const blockers: string[] = [];
  if (!record?.enabled) {
    blockers.push("Plugin is disabled.");
  }
  if (!packageRecord || packageRecord.status !== "installed") {
    blockers.push("Plugin package is not installed.");
  } else if (!cacheRefExists(input.store.paths, packageRecord.cacheRef)) {
    blockers.push("Installed plugin package cache is missing.");
  }
  const health = input.store.getManagedPluginHealthSnapshot(input.descriptor.id, input.now);
  if (input.descriptor.id === "bundled:cua-driver" && health?.status !== "ready") {
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
    ? buildManagedPluginPolicyOverlays({ store: input.store, descriptor: input.descriptor })
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
}): ManagedPluginRuntimeSnapshot {
  const capabilities = input.descriptors
    .map((descriptor) => buildManagedPluginRuntimePreview({
      cwd: input.cwd,
      store: input.store,
      descriptor,
      now: input.now,
    }))
    .filter((preview) => preview.status === "injectable");
  const policyOverlays = capabilities.flatMap((preview) =>
    preview.policyOverlays.map((overlay) => ({ ...overlay }))
  );
  const snapshot = input.store.createManagedPluginRuntimeSnapshot({
    runId: input.runId,
    cwd: input.cwd,
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
