import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ManagedPluginDescriptor,
  ManagedPluginHealthSnapshot,
  ManagedPluginRuntimeSnapshot,
  McpServer,
  RunStore,
} from "@ling-stack/core";
import { BUNDLED_CUA_DRIVER_PLUGIN_ID } from "../plugins/bundled-index.js";
import {
  createCuaDriverDescriptor,
  CUA_DRIVER_BUNDLED_LOGICAL_ENDPOINT,
  CUA_DRIVER_MCP_SERVER_ID,
  CUA_DRIVER_PLUGIN_ID,
} from "../plugins/presets.js";
import { isBundledEmbeddedCuaDriverRuntime } from "../plugins/cua-driver-runtime-mode.js";
import {
  CUA_DRIVER_REQUIRED_HEALTH_CHECK_NAMES,
  CUA_DRIVER_SUPPORTED_VERSIONS,
} from "../plugins/provider-health.js";

export function resolveEligibleCuaDriverProjectionServerIds(input: {
  readonly store: RunStore;
  readonly descriptors: readonly ManagedPluginDescriptor[];
  readonly runtimeSnapshot: ManagedPluginRuntimeSnapshot;
  readonly runId: string;
  readonly cwd: string;
  readonly now: string;
  readonly authorizedServerIds: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly cuaDriverRuntimeAuthority?: {
    readonly enabled: boolean;
    readonly workspaceCwd: string;
    readonly platform: NodeJS.Platform;
    readonly hasCurrentLease: () => boolean;
  };
}): readonly string[] {
  if (
    input.runtimeSnapshot.runId !== input.runId
    || input.runtimeSnapshot.cwd !== input.cwd
  ) {
    return [];
  }

  const provider = resolveManagedCuaDriverProvider({
    store: input.store,
    descriptors: input.descriptors,
    now: input.now,
    platform: input.platform,
    cuaDriverRuntimeAuthority: input.cuaDriverRuntimeAuthority,
  });
  if (!provider || !input.authorizedServerIds.includes(provider.server.id)) {
    return [];
  }

  const capability = input.runtimeSnapshot.capabilities.find(
    (candidate) => candidate.pluginId === provider.descriptor.id && candidate.status === "injectable",
  );
  if (
    !capability
  ) {
    return [];
  }
  if (
    provider.descriptor.id !== CUA_DRIVER_PLUGIN_ID
    && (
      capability.package?.pluginId !== provider.descriptor.id
      || capability.package.sourceKind !== provider.descriptor.sourceKind
      || capability.package.version !== provider.descriptor.version
      || capability.package.status !== "installed"
    )
  ) {
    return [];
  }
  const runtimeResource = capability.mcpServers.find(
    (candidate) => candidate.id === provider.server.id,
  );
  if (!runtimeResource?.present || runtimeResource.enabled !== true) {
    return [];
  }
  return [provider.server.id];
}

export function resolveManagedCuaDriverProvider(input: {
  readonly store: RunStore;
  readonly descriptors: readonly ManagedPluginDescriptor[];
  readonly now: string;
  readonly platform?: NodeJS.Platform;
  readonly cuaDriverRuntimeAuthority?: {
    readonly enabled: boolean;
    readonly workspaceCwd: string;
    readonly platform: NodeJS.Platform;
    readonly hasCurrentLease: () => boolean;
  };
}): { readonly descriptor: ManagedPluginDescriptor; readonly server: McpServer } | undefined {
  const bundledEmbedded = resolveBundledEmbeddedCuaDriverProvider(input);
  if (bundledEmbedded) {
    return bundledEmbedded;
  }

  const descriptor = input.descriptors.find(
    (candidate) => candidate.id === BUNDLED_CUA_DRIVER_PLUGIN_ID,
  );
  if (!descriptor || descriptor.sourceKind !== "bundled") {
    return undefined;
  }
  const contributionDescriptors = descriptor.contributions.filter(
    (contribution) => contribution.kind === "mcp-server",
  );
  if (contributionDescriptors.length !== 1) {
    return undefined;
  }
  const contributionDescriptor = contributionDescriptors[0];

  const record = input.store.getManagedPlugin(descriptor.id);
  const packageRecord = input.store.getManagedPluginPackage(descriptor.id);
  if (
    !record?.enabled
    || record.sourceKind !== descriptor.sourceKind
    || record.version !== descriptor.version
    || record.descriptor.id !== descriptor.id
    || record.descriptor.sourceKind !== descriptor.sourceKind
    || record.descriptor.version !== descriptor.version
    || packageRecord?.status !== "installed"
    || packageRecord.sourceKind !== descriptor.sourceKind
    || packageRecord.version !== descriptor.version
    || !existsSync(join(input.store.paths.pluginCacheDir, packageRecord.cacheRef))
  ) {
    return undefined;
  }
  const recordedContributionDescriptors = record.descriptor.contributions.filter(
    (contribution) => contribution.kind === "mcp-server",
  );
  if (
    recordedContributionDescriptors.length !== 1
    || recordedContributionDescriptors[0]?.id !== contributionDescriptor.id
  ) {
    return undefined;
  }

  const contribution = input.store.listManagedPluginContributions(descriptor.id).find(
    (candidate) => candidate.contributionKind === "mcp-server"
      && candidate.contributionId === contributionDescriptor.id,
  );
  if (
    !contribution?.enabled
    || contribution.linkedResourceId !== CUA_DRIVER_MCP_SERVER_ID
  ) {
    return undefined;
  }
  const owners = input.store.listManagedPluginContributions().filter(
    (candidate) => candidate.contributionKind === "mcp-server"
      && candidate.linkedResourceId === CUA_DRIVER_MCP_SERVER_ID,
  );
  if (
    owners.length !== 1
    || owners[0]?.pluginId !== descriptor.id
    || owners[0]?.contributionId !== contributionDescriptor.id
  ) {
    return undefined;
  }

  const server = input.store.getMcpServer(contribution.linkedResourceId);
  if (
    !server?.enabled
    || server.transport.type !== "stdio"
    || server.transport.args.length !== 1
    || server.transport.args[0] !== "mcp"
  ) {
    return undefined;
  }

  const pluginHealth = input.store.getManagedPluginHealthSnapshot(descriptor.id, input.now);
  const mcpHealth = input.store.getMcpStatusSnapshot(server.id, input.now);
  if (
    pluginHealth?.status !== "ready"
    || mcpHealth?.status !== "ready"
    || packageRecord.updatedAt > pluginHealth.checkedAt
    || contribution.updatedAt > pluginHealth.checkedAt
    || server.updatedAt > pluginHealth.checkedAt
    || server.updatedAt > mcpHealth.checkedAt
  ) {
    return undefined;
  }
  if (
    (input.platform ?? process.platform) === "win32"
    && !isApprovedWindowsProviderHealth(pluginHealth)
  ) {
    return undefined;
  }
  return { descriptor, server };
}

function resolveBundledEmbeddedCuaDriverProvider(input: {
  readonly store: RunStore;
  readonly now: string;
  readonly platform?: NodeJS.Platform;
  readonly cuaDriverRuntimeAuthority?: {
    readonly enabled: boolean;
    readonly workspaceCwd: string;
    readonly platform: NodeJS.Platform;
    readonly hasCurrentLease: () => boolean;
  };
}): { readonly descriptor: ManagedPluginDescriptor; readonly server: McpServer } | undefined {
  if (
    !input.cuaDriverRuntimeAuthority
    || (input.platform ?? input.cuaDriverRuntimeAuthority.platform) !== input.cuaDriverRuntimeAuthority.platform
    || !isBundledEmbeddedCuaDriverRuntime(
      input.store,
      input.cuaDriverRuntimeAuthority,
      input.store.paths.cwd,
    )
  ) {
    return undefined;
  }
  const descriptor = createCuaDriverDescriptor();
  const activation = input.store.getCuaDriverActivationState(descriptor.id);
  const record = input.store.getManagedPlugin(descriptor.id);
  if (
    !activation?.requestedEnabled
    || !record?.enabled
    || record.sourceKind !== descriptor.sourceKind
    || record.version !== descriptor.version
    || record.descriptor.id !== descriptor.id
    || record.descriptor.sourceKind !== descriptor.sourceKind
    || record.descriptor.version !== descriptor.version
  ) {
    return undefined;
  }

  const contribution = input.store.listManagedPluginContributions(descriptor.id).find(
    (candidate) => candidate.contributionKind === "mcp-server"
      && candidate.contributionId === CUA_DRIVER_MCP_SERVER_ID,
  );
  if (
    !contribution?.enabled
    || contribution.linkedResourceId !== CUA_DRIVER_MCP_SERVER_ID
  ) {
    return undefined;
  }
  const owners = input.store.listManagedPluginContributions().filter(
    (candidate) => candidate.contributionKind === "mcp-server"
      && candidate.linkedResourceId === CUA_DRIVER_MCP_SERVER_ID,
  );
  if (
    owners.length !== 1
    || owners[0]?.pluginId !== descriptor.id
    || owners[0]?.contributionId !== CUA_DRIVER_MCP_SERVER_ID
  ) {
    return undefined;
  }

  const server = input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID);
  if (
    !server?.enabled
    || server.transport.type !== "streamable-http"
    || server.transport.url !== CUA_DRIVER_BUNDLED_LOGICAL_ENDPOINT
  ) {
    return undefined;
  }
  const pluginHealth = input.store.getManagedPluginHealthSnapshot(descriptor.id, input.now);
  const mcpHealth = input.store.getMcpStatusSnapshot(server.id, input.now);
  if (
    pluginHealth?.status !== "ready"
    || mcpHealth?.status !== "ready"
    || readProviderState(pluginHealth) !== "ready"
    || activation.updatedAt > pluginHealth.checkedAt
    || contribution.updatedAt > pluginHealth.checkedAt
    || server.updatedAt > pluginHealth.checkedAt
    || server.updatedAt > mcpHealth.checkedAt
  ) {
    return undefined;
  }
  return { descriptor, server };
}

function readProviderState(health: ManagedPluginHealthSnapshot): string | undefined {
  return isRecord(health.details) && typeof health.details.providerState === "string"
    ? health.details.providerState
    : undefined;
}

function isApprovedWindowsProviderHealth(health: ManagedPluginHealthSnapshot): boolean {
  if (!isRecord(health.details)) {
    return false;
  }
  const version = typeof health.details.driverVersion === "string"
    ? health.details.driverVersion.trim()
    : "";
  const checks = Array.isArray(health.details.checks)
    ? health.details.checks.filter(isRecord)
    : [];
  const checksByName = new Map(checks.flatMap((check) =>
    typeof check.name === "string" && typeof check.status === "string"
      ? [[check.name, check.status] as const]
      : []
  ));
  return CUA_DRIVER_SUPPORTED_VERSIONS.some((supported) => supported === version)
    && health.details.platform === "win32"
    && health.details.overall === "ok"
    && checks.length === CUA_DRIVER_REQUIRED_HEALTH_CHECK_NAMES.length
    && checksByName.size === checks.length
    && CUA_DRIVER_REQUIRED_HEALTH_CHECK_NAMES.every(
      (name) => checksByName.get(name) === "pass",
    );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
