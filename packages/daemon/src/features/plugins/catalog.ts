import type { LingExtensionRegistry } from "@ling-stack/plugin-sdk";
import type {
  ManagedPluginContributionKind,
  ManagedPluginContributionRecord,
  ManagedPluginDescriptor,
  ManagedPluginEvent,
  ManagedPluginHealthSnapshot,
  ManagedPluginRecord,
  ManagedPluginView,
  ManagedPluginStoreFacet,
  McpStoreFacet,
  RunStorePathsFacet,
  CuaDriverActivationStoreFacet,
  CuaDriverProviderState,
} from "@ling-stack/core";
import { isCuaDriverProviderState } from "@ling-stack/contracts";
import type { LockedComputerControlProjectionV1 } from "@ling-stack/contracts";
import type { McpBroker } from "../../context.js";
import {
  CUA_DRIVER_PLUGIN_ID,
  CUA_DRIVER_MCP_SERVER_ID,
  CUA_DRIVER_UNSUPPORTED_PLATFORM_MESSAGE,
  isCuaDriverPlatformSupported,
  listTrustedLocalPresetDescriptors,
} from "./presets.js";
import { BUNDLED_CUA_DRIVER_PLUGIN_ID } from "./bundled-index.js";
import { buildCuaDriverSetupView } from "./cua-driver.js";
import { readBundledCuaDriverSetupMetadata } from "./cua-driver-catalog-projection.js";
import { listBundledPackageDescriptors } from "./source-index.js";
import { buildManagedPluginRuntimePreview, toManagedPluginPackageView } from "./runtime-injection.js";
import { isBundledEmbeddedCuaDriverRuntime } from "./cua-driver-runtime-mode.js";
import { CHROME_BROWSER_PLUGIN_ID } from "@ling-stack/contracts";
import {
  buildChromeBrowserSetupView,
  createChromeBrowserDescriptor,
} from "./chrome-browser.js";

const sourceOrder = new Map([
  ["built-in", 0],
  ["bundled", 1],
  ["trusted-local-preset", 2],
]);

type ManagedPluginCatalogStore =
  ManagedPluginStoreFacet &
  McpStoreFacet &
  CuaDriverActivationStoreFacet &
  RunStorePathsFacet;

export function listManagedPluginViews(input: {
  readonly cwd: string;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly store: ManagedPluginCatalogStore;
  readonly now: string;
  readonly includeEvents?: boolean;
  readonly includeHidden?: boolean;
  readonly cuaDriverRuntimeAuthority: McpBroker["cuaDriverRuntimeAuthority"];
  readonly cuaDriverFeatureFlags?: {
    readonly bundledEmbedded: { readonly darwin: boolean; readonly win32: boolean };
    readonly packagedProvider: { readonly darwin: boolean; readonly win32: boolean };
  };
  readonly lockedControlProjection?: LockedComputerControlProjectionV1;
}): readonly ManagedPluginView[] {
  const descriptors = buildDescriptorMap(input.extensionRegistry, input.store);
  const records = new Map(input.store.listManagedPlugins({ limit: 500 }).map((record) => [record.id, record]));
  const contributionRecords = input.store.listManagedPluginContributions();
  const views = [...descriptors.values()].map((descriptor) =>
    createManagedPluginView({
      descriptor,
      record: records.get(descriptor.id),
      contributionRecords: contributionRecords.filter((record) => record.pluginId === descriptor.id),
      health: input.store.getManagedPluginHealthSnapshot(descriptor.id, input.now),
      events: input.includeEvents ? input.store.listManagedPluginEvents({ pluginId: descriptor.id, limit: 20 }) : undefined,
      store: input.store,
      cwd: input.cwd,
      now: input.now,
      cuaDriverRuntimeAuthority: input.cuaDriverRuntimeAuthority,
      cuaDriverFeatureFlags: input.cuaDriverFeatureFlags,
      lockedControlProjection: input.lockedControlProjection,
    }));
  return views
    .filter((view) => input.includeHidden || view.id !== BUNDLED_CUA_DRIVER_PLUGIN_ID)
    .sort(compareManagedPluginViews);
}

export function getManagedPluginView(input: {
  readonly pluginId: string;
  readonly cwd: string;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly store: ManagedPluginCatalogStore;
  readonly now: string;
  readonly includeEvents?: boolean;
  readonly cuaDriverRuntimeAuthority: McpBroker["cuaDriverRuntimeAuthority"];
  readonly cuaDriverFeatureFlags?: {
    readonly bundledEmbedded: { readonly darwin: boolean; readonly win32: boolean };
    readonly packagedProvider: { readonly darwin: boolean; readonly win32: boolean };
  };
  readonly lockedControlProjection?: LockedComputerControlProjectionV1;
}): ManagedPluginView | undefined {
  return listManagedPluginViews({ ...input, includeHidden: true }).find((plugin) => plugin.id === input.pluginId);
}

export function getManagedPluginDescriptor(
  extensionRegistry: LingExtensionRegistry,
  store: ManagedPluginStoreFacet,
  pluginId: string,
): ManagedPluginDescriptor | undefined {
  return buildDescriptorMap(extensionRegistry, store).get(pluginId);
}

export function ensureManagedPluginRecord(input: {
  readonly store: ManagedPluginStoreFacet;
  readonly descriptor: ManagedPluginDescriptor;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly now: string;
}): ManagedPluginRecord {
  return input.store.upsertManagedPlugin(
    {
      id: input.descriptor.id,
      sourceKind: input.descriptor.sourceKind,
      version: input.descriptor.version,
      enabled: input.enabled,
      disabledReason: input.disabledReason,
      descriptor: input.descriptor,
    },
    input.now,
  );
}

export function createPluginHealthSnapshot(input: {
  readonly pluginId: string;
  readonly now: string;
  readonly status: ManagedPluginHealthSnapshot["status"];
  readonly message?: string;
  readonly details?: unknown;
  readonly ttlMs?: number;
}): ManagedPluginHealthSnapshot {
  return {
    pluginId: input.pluginId,
    checkedAt: input.now,
    expiresAt: new Date(Date.parse(input.now) + (input.ttlMs ?? 5 * 60 * 1000)).toISOString(),
    status: input.status,
    message: input.message,
    details: input.details,
  };
}

function buildDescriptorMap(
  extensionRegistry: LingExtensionRegistry,
  store: ManagedPluginStoreFacet,
): Map<string, ManagedPluginDescriptor> {
  const descriptors = new Map<string, ManagedPluginDescriptor>();
  for (const descriptor of listProductManagedBuiltInPluginDescriptors(extensionRegistry)) {
    descriptors.set(descriptor.id, descriptor);
  }
  for (const descriptor of listBundledPackageDescriptors()) {
    descriptors.set(descriptor.id, descriptor);
  }
  for (const descriptor of listTrustedLocalPresetDescriptors()) {
    descriptors.set(descriptor.id, descriptor);
  }
  for (const record of store.listManagedPlugins({ limit: 500 })) {
    if (!descriptors.has(record.id) && shouldIncludePersistedManagedPluginRecord(record)) {
      descriptors.set(record.id, record.descriptor);
    }
  }
  return descriptors;
}

function listProductManagedBuiltInPluginDescriptors(
  extensionRegistry: LingExtensionRegistry,
): readonly ManagedPluginDescriptor[] {
  void extensionRegistry;
  return [createChromeBrowserDescriptor()];
}

function shouldIncludePersistedManagedPluginRecord(record: ManagedPluginRecord): boolean {
  return !isPlainBuiltInRuntimeExtensionRecord(record);
}

function isPlainBuiltInRuntimeExtensionRecord(record: ManagedPluginRecord): boolean {
  const contribution = record.descriptor.contributions[0];
  const runtimeExtensionKinds: readonly ManagedPluginContributionKind[] = [
    "tool",
    "runner",
    "provider",
    "channel-source",
    "skill-pack",
    "memory",
    "automation",
  ];
  return record.sourceKind === "built-in"
    && record.descriptor.contributions.length === 1
    && contribution !== undefined
    && runtimeExtensionKinds.includes(contribution.kind)
    && record.id.startsWith(`${contribution.kind}:`);
}

function createManagedPluginView(input: {
  readonly cwd: string;
  readonly descriptor: ManagedPluginDescriptor;
  readonly record?: ManagedPluginRecord;
  readonly contributionRecords: readonly ManagedPluginContributionRecord[];
  readonly health?: ManagedPluginHealthSnapshot;
  readonly events?: readonly ManagedPluginEvent[];
  readonly store: ManagedPluginCatalogStore;
  readonly now: string;
  readonly cuaDriverRuntimeAuthority: McpBroker["cuaDriverRuntimeAuthority"];
  readonly cuaDriverFeatureFlags?: {
    readonly bundledEmbedded: { readonly darwin: boolean; readonly win32: boolean };
    readonly packagedProvider: { readonly darwin: boolean; readonly win32: boolean };
  };
  readonly lockedControlProjection?: LockedComputerControlProjectionV1;
}): ManagedPluginView {
  const blocked = getDescriptorBlocker(input.descriptor);
  const cuaDriverServer = input.descriptor.id === CUA_DRIVER_PLUGIN_ID
    ? input.store.getMcpServer(CUA_DRIVER_MCP_SERVER_ID)
    : undefined;
  const bundledProjection = input.descriptor.id === CUA_DRIVER_PLUGIN_ID
    && isBundledProjectionEnabled(input.cuaDriverFeatureFlags, process.platform);
  const activationState = bundledProjection
    ? input.store.getCuaDriverActivationState(CUA_DRIVER_PLUGIN_ID)
    : undefined;
  const requestedEnabled = activationState?.requestedEnabled ?? false;
  const linkedCuaContribution = bundledProjection
    ? input.contributionRecords.find((record) =>
        record.contributionKind === "mcp-server"
        && record.linkedResourceId === CUA_DRIVER_MCP_SERVER_ID)
    : undefined;
  const liveBundledRuntime = bundledProjection
    && input.cuaDriverRuntimeAuthority?.platform === process.platform
    && isBundledEmbeddedCuaDriverRuntime(
      input.store,
      input.cuaDriverRuntimeAuthority,
      input.cwd,
    );
  const effectiveEnabled = bundledProjection
    && liveBundledRuntime
    && input.record?.enabled === true
    && cuaDriverServer?.enabled === true
    && linkedCuaContribution?.enabled === true;
  const bundledProviderState = bundledProjection
    ? resolveBundledProviderState({
        requestedEnabled,
        effectiveEnabled,
        liveBundledRuntime,
        health: input.health,
      })
    : undefined;
  const bundledSetupMetadata = bundledProjection
    ? readBundledCuaDriverSetupMetadata(input.health?.details, process.platform)
    : {};
  const setup = input.descriptor.id === CHROME_BROWSER_PLUGIN_ID
    ? buildChromeBrowserSetupView(input.health ?? createPluginHealthSnapshot({
        pluginId: CHROME_BROWSER_PLUGIN_ID,
        now: input.now,
        status: input.record?.enabled ? "failed" : "disabled",
        message: input.record?.enabled ? "Install or open Ling for Chrome. Connection is automatic." : "Chrome plugin is disabled.",
        details: {
          browserFamily: "chrome",
          browserState: "extension_required",
          paired: false,
          connected: false,
        },
      }))
    : input.descriptor.id === CUA_DRIVER_PLUGIN_ID
      ? buildCuaDriverSetupView({
        store: input.store,
        now: input.now,
        platform: process.platform,
        ...(bundledProjection
          ? {
              projection: {
                schemaVersion: 2 as const,
                distribution: "bundled_embedded" as const,
                providerState: bundledProviderState,
                requestedEnabled,
                effectiveEnabled,
                ...bundledSetupMetadata,
                ...(input.lockedControlProjection
                  ? { lockedControl: input.lockedControlProjection }
                  : {}),
              },
            }
          : {}),
        })
      : undefined;
  const recordEnabled = input.descriptor.id === CUA_DRIVER_PLUGIN_ID
    ? bundledProjection
      ? effectiveEnabled
      : setup?.state === "ready"
      ? true
      : input.record?.enabled === false
        ? false
        : undefined
    : input.record?.enabled;
  const status = blocked
    ? "blocked"
    : recordEnabled === true
      ? "enabled"
      : recordEnabled === false
        ? "disabled"
        : input.descriptor.defaultEnabled
          ? "enabled"
          : "available";
  const contributionRecordByKey = new Map(
    input.contributionRecords.map((record) => [`${record.contributionKind}:${record.contributionId}`, record]),
  );
  const contributions = input.descriptor.contributions.map((contribution) => {
    const record = contributionRecordByKey.get(`${contribution.kind}:${contribution.id}`);
    const linkedResourceId = record?.linkedResourceId
      ?? (cuaDriverServer && contribution.kind === "mcp-server" ? cuaDriverServer.id : undefined);
    const linkedResourcePresent = linkedResourceId ? isLinkedResourcePresent(input.store, contribution.kind, linkedResourceId) : undefined;
    return {
      ...contribution,
      linkedResourceId,
      linkedResourcePresent,
      enabled: bundledProjection && contribution.kind === "mcp-server"
        ? effectiveEnabled
        : record?.enabled ?? (input.descriptor.id === CUA_DRIVER_PLUGIN_ID ? setup?.state === "ready" : status === "enabled"),
    };
  });
  const linkedResources = input.contributionRecords
    .filter((record) => record.linkedResourceId)
    .map((record) => {
      const linked = resolveLinkedResource(input.store, record.contributionKind, record.linkedResourceId ?? "");
      return {
        kind: record.contributionKind,
        id: record.linkedResourceId ?? "",
        present: linked.present,
        enabled: bundledProjection && record.linkedResourceId === CUA_DRIVER_MCP_SERVER_ID
          ? effectiveEnabled
          : linked.enabled,
        displayName: linked.displayName,
      };
    });
  if (cuaDriverServer && !linkedResources.some((resource) => resource.id === cuaDriverServer.id)) {
    linkedResources.push({
      kind: "mcp-server",
      id: cuaDriverServer.id,
      present: true,
      enabled: bundledProjection ? effectiveEnabled : cuaDriverServer.enabled,
      displayName: cuaDriverServer.displayName,
    });
  }
  const packageRecord = input.store.getManagedPluginPackage(input.descriptor.id);
  const packageView = packageRecord ? toManagedPluginPackageView(packageRecord) : undefined;
  const runtimePreview = input.descriptor.sourceKind === "bundled"
    ? buildManagedPluginRuntimePreview({
        cwd: input.cwd,
        store: input.store,
        descriptor: input.descriptor,
        now: new Date().toISOString(),
      })
    : undefined;
  return {
    id: input.descriptor.id,
    displayName: input.descriptor.displayName,
    version: input.descriptor.version,
    sourceKind: input.descriptor.sourceKind,
    status,
    description: input.descriptor.description,
    homepageUrl: input.descriptor.homepageUrl,
    trustSummary: blocked ? blocked : input.descriptor.trustSummary,
    contributions,
    requiredSecrets: input.descriptor.requiredSecrets,
    defaultApprovals: input.descriptor.defaultApprovals,
    health: blocked && !input.health
      ? createPluginHealthSnapshot({
          pluginId: input.descriptor.id,
          now: new Date(0).toISOString(),
          status: "failed",
          message: blocked,
          ttlMs: 0,
        })
      : input.health,
    package: packageView,
    runtimePreview,
    setup,
    linkedResources,
    events: input.events,
    disabledReason: input.record?.disabledReason,
    actions: {
      canEnable: bundledProjection
        ? !blocked && !requestedEnabled
        : !blocked && status !== "enabled" && (input.descriptor.id !== CUA_DRIVER_PLUGIN_ID || setup?.state === "connected"),
      canDisable: bundledProjection ? requestedEnabled : status === "enabled",
      canCheck: input.descriptor.id === CUA_DRIVER_PLUGIN_ID || linkedResources.length > 0 || input.descriptor.sourceKind === "built-in" || input.descriptor.sourceKind === "bundled",
      canApplyPreset: !bundledProjection && !blocked && input.descriptor.id === CUA_DRIVER_PLUGIN_ID,
      canInstall: !blocked && input.descriptor.sourceKind === "bundled" && packageView?.status !== "installed",
      canUninstall: !blocked && input.descriptor.sourceKind === "bundled" && packageView?.status === "installed",
      canRefreshPackage: !blocked && input.descriptor.sourceKind === "bundled" && packageView?.status === "installed",
      canRuntimePreview: input.descriptor.sourceKind === "bundled",
    },
  };
}

function resolveBundledProviderState(input: {
  readonly requestedEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly liveBundledRuntime: boolean;
  readonly health?: ManagedPluginHealthSnapshot;
}): CuaDriverProviderState {
  if (!input.requestedEnabled) {
    return "included";
  }
  if (!input.liveBundledRuntime) {
    return "desktop_unavailable";
  }
  const details = input.health?.details;
  const observed = details
    && typeof details === "object"
    && !Array.isArray(details)
    && "providerState" in details
    && isCuaDriverProviderState(details.providerState)
      ? details.providerState
      : undefined;
  if (input.effectiveEnabled) {
    return observed === "ready" ? "ready" : "desktop_unavailable";
  }
  switch (observed) {
    case "desktop_unavailable":
    case "permission_required":
    case "interactive_session_required":
    case "platform_unavailable":
    case "incompatible":
    case "corrupt":
      return observed;
    default:
      // Stale external or disabled-only health must never leak into the
      // bundled distribution. Startup reset normally replaces it, but the
      // catalog remains fail-closed if persistence is inconsistent.
      return "desktop_unavailable";
  }
}

function isBundledProjectionEnabled(
  flags: {
    readonly bundledEmbedded: { readonly darwin: boolean; readonly win32: boolean };
    readonly packagedProvider: { readonly darwin: boolean; readonly win32: boolean };
  } | undefined,
  platform: NodeJS.Platform,
): boolean {
  return platform === "darwin"
    ? flags?.bundledEmbedded.darwin === true && flags.packagedProvider.darwin === true
    : platform === "win32"
      ? flags?.bundledEmbedded.win32 === true && flags.packagedProvider.win32 === true
      : false;
}

function getDescriptorBlocker(descriptor: ManagedPluginDescriptor): string | undefined {
  if (descriptor.id === CUA_DRIVER_PLUGIN_ID && !isCuaDriverPlatformSupported()) {
    return CUA_DRIVER_UNSUPPORTED_PLATFORM_MESSAGE;
  }
  return undefined;
}

function resolveLinkedResource(
  store: McpStoreFacet,
  kind: ManagedPluginContributionKind,
  linkedResourceId: string,
): { readonly present: boolean; readonly enabled?: boolean; readonly displayName?: string } {
  if (kind === "mcp-server") {
    const server = store.getMcpServer(linkedResourceId);
    return {
      present: Boolean(server),
      enabled: server?.enabled,
      displayName: server?.displayName,
    };
  }
  return { present: true };
}

function isLinkedResourcePresent(store: McpStoreFacet, kind: ManagedPluginContributionKind, linkedResourceId: string): boolean {
  return resolveLinkedResource(store, kind, linkedResourceId).present;
}

function compareManagedPluginViews(left: ManagedPluginView, right: ManagedPluginView): number {
  const leftOrder = sourceOrder.get(left.sourceKind) ?? 99;
  const rightOrder = sourceOrder.get(right.sourceKind) ?? 99;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  const byName = left.displayName.localeCompare(right.displayName);
  return byName === 0 ? left.id.localeCompare(right.id) : byName;
}
