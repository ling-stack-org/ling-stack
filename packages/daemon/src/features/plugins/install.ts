import type {
  ManagedPluginDescriptor,
  ManagedPluginPackageRecord,
  ManagedPluginStoreFacet,
  McpStoreFacet,
  RunStorePathsFacet,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { McpBroker } from "../../context.js";
import type { SecretResolver } from "@ling-stack/core";
import { getBundledPluginPackage } from "./source-index.js";
import { materializeBundledPluginPackage } from "./package-cache.js";
import {
  createCuaDriverMcpServerInput,
  CUA_DRIVER_MCP_SERVER_ID,
  CUA_DRIVER_UNSUPPORTED_PLATFORM_MESSAGE,
  isCuaDriverPlatformSupported,
  resolveCuaDriverCommand,
  applyCuaDriverToolApprovalOverrides,
} from "./presets.js";
import { createPluginHealthSnapshot, ensureManagedPluginRecord } from "./catalog.js";
import { checkCuaDriverProviderHealth } from "./provider-health.js";

type ManagedPluginInstallStore =
  ManagedPluginStoreFacet &
  McpStoreFacet &
  RunStorePathsFacet;

export interface PluginInstallResult {
  readonly descriptor: ManagedPluginDescriptor;
  readonly packageRecord: ManagedPluginPackageRecord;
}

export async function installBundledPluginPackage(input: {
  readonly cwd: string;
  readonly store: ManagedPluginInstallStore;
  readonly pluginId: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly now: string;
}): Promise<PluginInstallResult> {
  const pluginPackage = getBundledPluginPackage(input.pluginId);
  if (!pluginPackage) {
    throw new HttpError(404, "plugin_package_not_found", `Plugin package not found: ${input.pluginId}`);
  }
  const descriptor = pluginPackage.validation.compiledDescriptor;
  if (!pluginPackage.validation.ok || !descriptor) {
    throw new HttpError(400, "plugin_package_invalid", "Plugin package validation failed.");
  }

  if (input.pluginId === "bundled:cua-driver") {
    validateCuaInstallEnvironment(input.store, descriptor, input.options, input.now);
  }

  const materialized = materializeBundledPluginPackage({
    paths: input.store.paths,
    pluginPackage,
    now: input.now,
  });
  const packageRecord = input.store.upsertManagedPluginPackage({
    pluginId: descriptor.id,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    status: "installed",
    cacheRef: materialized.cacheRef,
    packageHash: materialized.packageHash,
    manifestJson: JSON.stringify(materialized.loadedPackage.manifest),
    uninstalledAt: undefined,
  }, input.now);

  const record = ensureManagedPluginRecord({
    store: input.store,
    descriptor,
    enabled: input.store.getManagedPlugin(descriptor.id)?.enabled ?? false,
    now: input.now,
  });

  if (descriptor.id === "bundled:cua-driver") {
    linkCuaMcpServer({
      store: input.store,
      descriptor,
      enabled: record.enabled,
      options: input.options,
      now: input.now,
    });
  }

  input.store.appendManagedPluginEvent({
    pluginId: descriptor.id,
    type: "installed",
    actor: "local-user",
    message: "Plugin package installed.",
    data: {
      sourceKind: descriptor.sourceKind,
      version: descriptor.version,
      cacheRef: packageRecord.cacheRef,
      packageHash: packageRecord.packageHash,
    },
  }, input.now);

  return { descriptor, packageRecord };
}

export function uninstallManagedPluginPackage(input: {
  readonly store: ManagedPluginInstallStore;
  readonly descriptor: ManagedPluginDescriptor;
  readonly reason?: string;
  readonly now: string;
}): ManagedPluginPackageRecord | undefined {
  const packageRecord = input.store.markManagedPluginPackageUninstalled(input.descriptor.id, input.now);
  input.store.updateManagedPlugin(input.descriptor.id, {
    enabled: false,
    disabledReason: input.reason ?? "Plugin package uninstalled.",
  }, input.now);
  const contributions = input.store.listManagedPluginContributions(input.descriptor.id);
  input.store.replaceManagedPluginContributions(
    input.descriptor.id,
    contributions.map((contribution) => ({
      contributionKind: contribution.contributionKind,
      contributionId: contribution.contributionId,
      linkedResourceId: contribution.linkedResourceId,
      enabled: false,
    })),
    input.now,
  );
  for (const contribution of contributions) {
    if (contribution.contributionKind === "mcp-server" && contribution.linkedResourceId) {
      const server = input.store.getMcpServer(contribution.linkedResourceId);
      if (server) {
        input.store.updateMcpServer(server.id, { enabled: false }, input.now);
      }
    }
  }
  input.store.appendManagedPluginEvent({
    pluginId: input.descriptor.id,
    type: "uninstalled",
    actor: "local-user",
    message: input.reason ? `Plugin package uninstalled: ${input.reason}` : "Plugin package uninstalled.",
    data: { packageStatus: packageRecord?.status ?? "missing" },
  }, input.now);
  return packageRecord;
}

export async function refreshManagedPluginPackage(input: {
  readonly cwd: string;
  readonly store: ManagedPluginInstallStore;
  readonly pluginId: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly now: string;
}): Promise<PluginInstallResult> {
  const result = await installBundledPluginPackage(input);
  input.store.appendManagedPluginEvent({
    pluginId: result.descriptor.id,
    type: "package_refreshed",
    actor: "local-user",
    message: "Plugin package refreshed.",
    data: {
      cacheRef: result.packageRecord.cacheRef,
      packageHash: result.packageRecord.packageHash,
    },
  }, input.now);
  return result;
}

export async function checkInstalledPluginRuntimeDependencies(input: {
  readonly descriptor: ManagedPluginDescriptor;
  readonly store: ManagedPluginInstallStore;
  readonly mcpBroker: McpBroker;
  readonly secretResolver: SecretResolver;
  readonly now: string;
}): Promise<void> {
  if (input.descriptor.id !== "bundled:cua-driver") {
    return;
  }
  const server = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
  if (!server) {
    throw new HttpError(400, "plugin_linked_resource_missing", "Plugin linked MCP server is missing.");
  }
  const checked = await input.mcpBroker.checkServer(server, {
    secretResolver: input.secretResolver,
    now: () => input.now,
  });
  input.store.upsertMcpStatusSnapshot(checked.statusSnapshot, input.now);
  if (checked.statusSnapshot.status !== "ready") {
    throw new HttpError(
      400,
      checked.statusSnapshot.errorCode ?? "plugin_provider_unavailable",
      checked.statusSnapshot.message ?? "Cua Driver MCP server is not ready.",
    );
  }
  if (process.platform !== "win32") {
    return;
  }
  const listed = await input.mcpBroker.listTools(server, {
    secretResolver: input.secretResolver,
    now: () => input.now,
  });
  input.store.upsertMcpStatusSnapshot(listed.statusSnapshot, input.now);
  if (listed.statusSnapshot.status !== "ready") {
    throw new HttpError(
      400,
      listed.statusSnapshot.errorCode ?? "plugin_provider_unavailable",
      listed.statusSnapshot.message ?? "Cua Driver tools are not available.",
    );
  }
  const tools = applyCuaDriverToolApprovalOverrides(listed.tools);
  input.store.replaceMcpServerTools(server.id, tools, input.now);
  const providerHealth = await checkCuaDriverProviderHealth({
    server,
    mcpBroker: input.mcpBroker,
    secretResolver: input.secretResolver,
    now: input.now,
    availableToolNames: tools.map((tool) => tool.rawName),
  });
  if (!providerHealth.ok) {
    throw new HttpError(
      400,
      typeof providerHealth.details?.errorCode === "string"
        ? providerHealth.details.errorCode
        : "plugin_provider_health_failed",
      providerHealth.message,
    );
  }
}

function validateCuaInstallEnvironment(
  store: ManagedPluginInstallStore,
  descriptor: ManagedPluginDescriptor,
  options: Readonly<Record<string, unknown>>,
  now: string,
): void {
  if (!isCuaDriverPlatformSupported()) {
    ensureManagedPluginRecord({ store, descriptor, enabled: false, now });
    store.upsertManagedPluginHealthSnapshot(createPluginHealthSnapshot({
      pluginId: descriptor.id,
      now,
      status: "failed",
      message: CUA_DRIVER_UNSUPPORTED_PLATFORM_MESSAGE,
      details: { errorCode: "plugin_platform_blocked" },
    }), now);
    throw new HttpError(400, "plugin_platform_blocked", CUA_DRIVER_UNSUPPORTED_PLATFORM_MESSAGE);
  }
  const command = resolveCuaDriverCommand(options);
  if (!command.ok || !command.command) {
    ensureManagedPluginRecord({ store, descriptor, enabled: false, now });
    store.upsertManagedPluginHealthSnapshot(createPluginHealthSnapshot({
      pluginId: descriptor.id,
      now,
      status: "failed",
      message: command.message ?? "cua-driver binary was not found.",
      details: { errorCode: "plugin_binary_not_found" },
    }), now);
    throw new HttpError(400, "plugin_binary_not_found", command.message ?? "cua-driver binary was not found.");
  }
}

function linkCuaMcpServer(input: {
  readonly store: ManagedPluginInstallStore;
  readonly descriptor: ManagedPluginDescriptor;
  readonly enabled: boolean;
  readonly options: Readonly<Record<string, unknown>>;
  readonly now: string;
}): void {
  const command = resolveCuaDriverCommand(input.options);
  if (!command.ok || !command.command) {
    throw new HttpError(400, "plugin_binary_not_found", command.message ?? "cua-driver binary was not found.");
  }
  const mcpInput = createCuaDriverMcpServerInput(command.command, input.enabled);
  const existingServer = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
  const linkedServer = existingServer
    ? input.store.updateMcpServer(CUA_DRIVER_MCP_SERVER_ID, mcpInput, input.now) ?? existingServer
    : input.store.createMcpServer(mcpInput, input.now);
  input.store.replaceManagedPluginContributions(input.descriptor.id, [
    {
      contributionKind: "mcp-server",
      contributionId: CUA_DRIVER_MCP_SERVER_ID,
      linkedResourceId: linkedServer.id,
      enabled: input.enabled,
    },
  ], input.now);
  input.store.appendManagedPluginEvent({
    pluginId: input.descriptor.id,
    type: "contribution_linked",
    actor: "system",
    message: `Linked MCP server ${linkedServer.id}.`,
    data: { linkedResourceId: linkedServer.id },
  }, input.now);
}
