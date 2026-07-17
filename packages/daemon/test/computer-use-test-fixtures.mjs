import { createSqliteRunStore } from "@ling-stack/core";
import { materializeBundledPluginPackage } from "../dist/features/plugins/package-cache.js";
import { getBundledPluginPackage } from "../dist/features/plugins/source-index.js";
import { createCuaDriverDescriptor } from "../dist/features/plugins/presets.js";

export const BUNDLED_CUA_PLUGIN_ID = "bundled:cua-driver";
export const CUA_MCP_SERVER_ID = "mcp_cua_driver";

export function createCapturedStoreFactory() {
  const capture = { store: undefined };
  return {
    capture,
    storeFactory: (cwd) => {
      const store = createSqliteRunStore(cwd);
      capture.store = store;
      return store;
    },
  };
}

export function seedManagedCuaProvider(store, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();
  const pluginPackage = getBundledPluginPackage(BUNDLED_CUA_PLUGIN_ID);
  const descriptor = pluginPackage?.validation.compiledDescriptor;
  if (!pluginPackage || !descriptor) {
    throw new Error("Bundled Cua Driver package is unavailable in the test fixture.");
  }
  const materialized = materializeBundledPluginPackage({
    paths: store.paths,
    pluginPackage,
    now,
  });
  store.upsertManagedPluginPackage({
    pluginId: descriptor.id,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    status: "installed",
    cacheRef: materialized.cacheRef,
    packageHash: materialized.packageHash,
    manifestJson: JSON.stringify(materialized.loadedPackage.manifest),
  }, now);
  store.upsertManagedPlugin({
    id: descriptor.id,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    enabled: options.pluginEnabled !== false,
    descriptor,
  }, now);
  const server = store.getMcpServer(CUA_MCP_SERVER_ID)
    ?? store.createMcpServer({
      id: CUA_MCP_SERVER_ID,
      displayName: "Cua Driver",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["mcp"],
        env: {},
        secretEnvRefs: {},
      },
      enabled: options.serverEnabled !== false,
      required: false,
    }, now);
  const contributionDescriptor = descriptor.contributions.find(
    (candidate) => candidate.kind === "mcp-server",
  );
  if (!contributionDescriptor) {
    throw new Error("Bundled Cua Driver descriptor has no MCP contribution.");
  }
  store.replaceManagedPluginContributions(descriptor.id, [
    {
      contributionKind: "mcp-server",
      contributionId: contributionDescriptor.id,
      linkedResourceId: options.linked === false ? undefined : server.id,
      enabled: options.contributionEnabled !== false,
    },
  ], now);
  store.upsertMcpStatusSnapshot({
    serverId: server.id,
    status: options.mcpHealthStatus ?? "ready",
    authStatus: { kind: "not_required", refs: [], missingRefs: [] },
    missingSecretRefs: [],
    checkedAt: now,
    expiresAt,
    toolCount: options.tools?.length ?? 0,
  }, now);
  store.upsertManagedPluginHealthSnapshot({
    pluginId: descriptor.id,
    status: options.pluginHealthStatus ?? "ready",
    checkedAt: now,
    expiresAt,
    details: options.pluginHealthDetails ?? {
      mcpStatus: options.mcpHealthStatus ?? "ready",
      toolCount: options.tools?.length ?? 0,
    },
  }, now);
  if (options.tools) {
    store.replaceMcpServerTools(server.id, options.tools, now);
  }
  return { descriptor, server, now };
}

export function addLegacyCuaProviderOwner(store, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const descriptor = createCuaDriverDescriptor();
  const server = store.getMcpServer(CUA_MCP_SERVER_ID);
  if (!server) {
    throw new Error("Cua Driver MCP server must exist before adding the legacy owner.");
  }
  store.upsertManagedPlugin({
    id: descriptor.id,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    enabled: options.enabled === true,
    descriptor,
  }, now);
  store.replaceManagedPluginContributions(descriptor.id, [{
    contributionKind: "mcp-server",
    contributionId: CUA_MCP_SERVER_ID,
    linkedResourceId: server.id,
    enabled: options.enabled === true,
  }], now);
  return { descriptor, server };
}
