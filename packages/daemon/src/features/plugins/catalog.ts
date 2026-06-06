import type { LingExtensionMetadata, LingExtensionRegistry } from "@ling-stack/plugin-sdk";
import type {
  ManagedPluginContributionDescriptor,
  ManagedPluginContributionKind,
  ManagedPluginContributionRecord,
  ManagedPluginDescriptor,
  ManagedPluginEvent,
  ManagedPluginHealthSnapshot,
  ManagedPluginRecord,
  ManagedPluginView,
  RunStore,
} from "@ling-stack/core";
import { CUA_DRIVER_PLUGIN_ID, CUA_DRIVER_MCP_SERVER_ID, listTrustedLocalPresetDescriptors } from "./presets.js";
import { listBundledPackageDescriptors } from "./source-index.js";

const sourceOrder = new Map([
  ["built-in", 0],
  ["bundled", 1],
  ["trusted-local-preset", 2],
]);

export function listManagedPluginViews(input: {
  readonly extensionRegistry: LingExtensionRegistry;
  readonly store: RunStore;
  readonly now: string;
  readonly includeEvents?: boolean;
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
    }));
  return views.sort(compareManagedPluginViews);
}

export function getManagedPluginView(input: {
  readonly pluginId: string;
  readonly extensionRegistry: LingExtensionRegistry;
  readonly store: RunStore;
  readonly now: string;
  readonly includeEvents?: boolean;
}): ManagedPluginView | undefined {
  return listManagedPluginViews(input).find((plugin) => plugin.id === input.pluginId);
}

export function getManagedPluginDescriptor(
  extensionRegistry: LingExtensionRegistry,
  store: RunStore,
  pluginId: string,
): ManagedPluginDescriptor | undefined {
  return buildDescriptorMap(extensionRegistry, store).get(pluginId);
}

export function ensureManagedPluginRecord(input: {
  readonly store: RunStore;
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
  store: RunStore,
): Map<string, ManagedPluginDescriptor> {
  const descriptors = new Map<string, ManagedPluginDescriptor>();
  for (const extension of extensionRegistry.list()) {
    const descriptor = extensionToManagedPluginDescriptor(extension);
    descriptors.set(descriptor.id, descriptor);
  }
  for (const descriptor of listBundledPackageDescriptors()) {
    descriptors.set(descriptor.id, descriptor);
  }
  for (const descriptor of listTrustedLocalPresetDescriptors()) {
    descriptors.set(descriptor.id, descriptor);
  }
  for (const record of store.listManagedPlugins({ limit: 500 })) {
    if (!descriptors.has(record.id)) {
      descriptors.set(record.id, record.descriptor);
    }
  }
  return descriptors;
}

function extensionToManagedPluginDescriptor(extension: LingExtensionMetadata): ManagedPluginDescriptor {
  const contribution = extensionToContribution(extension);
  return {
    id: extension.manifest.id,
    displayName: extension.manifest.name,
    version: extension.manifest.version,
    sourceKind: "built-in",
    trustSummary: extension.manifest.trustLevel === "internal-isolated"
      ? "Built into Ling and isolated by its owning subsystem."
      : "Built into Ling and executed through existing daemon policy boundaries.",
    contributions: [contribution],
    requiredSecrets: extension.manifest.requiredSecrets?.map((ref) => ({
      ref,
      label: ref,
      required: true,
    })),
    defaultApprovals: extension.manifest.requiredApprovals?.flatMap((approval) =>
      (approval.tools ?? approval.actions ?? [extension.manifest.id]).map((contributionId) => ({
        contributionId,
        decision: approval.decision,
        reason: approval.reason,
      }))),
    defaultEnabled: true,
  };
}

function extensionToContribution(extension: LingExtensionMetadata): ManagedPluginContributionDescriptor {
  const base = {
    id: extension.manifest.id,
    label: extension.manifest.name,
    capabilities: extension.manifest.capabilities,
  };
  switch (extension.manifest.kind) {
    case "tool":
      return {
        ...base,
        kind: "tool",
        sideEffectLevel: "sideEffectLevel" in extension ? extension.sideEffectLevel : undefined,
        defaultApproval: "defaultApproval" in extension ? extension.defaultApproval : undefined,
      };
    case "skill-pack":
      return { ...base, kind: "skill-pack" };
    case "runner":
      return { ...base, kind: "runner" };
    case "provider":
      return { ...base, kind: "provider" };
    case "channel-source":
      return { ...base, kind: "channel-source" };
    case "memory":
      return { ...base, kind: "memory" };
    case "automation":
      return { ...base, kind: "automation" };
  }
}

function createManagedPluginView(input: {
  readonly descriptor: ManagedPluginDescriptor;
  readonly record?: ManagedPluginRecord;
  readonly contributionRecords: readonly ManagedPluginContributionRecord[];
  readonly health?: ManagedPluginHealthSnapshot;
  readonly events?: readonly ManagedPluginEvent[];
  readonly store: RunStore;
}): ManagedPluginView {
  const blocked = getDescriptorBlocker(input.descriptor);
  const recordEnabled = input.record?.enabled;
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
    const linkedResourcePresent = record?.linkedResourceId ? isLinkedResourcePresent(input.store, contribution.kind, record.linkedResourceId) : undefined;
    return {
      ...contribution,
      linkedResourceId: record?.linkedResourceId,
      linkedResourcePresent,
      enabled: record?.enabled ?? status === "enabled",
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
        enabled: linked.enabled,
        displayName: linked.displayName,
      };
    });

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
    linkedResources,
    events: input.events,
    disabledReason: input.record?.disabledReason,
    actions: {
      canEnable: !blocked && status !== "enabled",
      canDisable: status === "enabled",
      canCheck: input.descriptor.id === CUA_DRIVER_PLUGIN_ID || linkedResources.length > 0 || input.descriptor.sourceKind === "built-in" || input.descriptor.sourceKind === "bundled",
      canApplyPreset: !blocked && input.descriptor.id === CUA_DRIVER_PLUGIN_ID,
    },
  };
}

function getDescriptorBlocker(descriptor: ManagedPluginDescriptor): string | undefined {
  if (descriptor.id === CUA_DRIVER_PLUGIN_ID && process.platform !== "darwin") {
    return "Cua Driver is only supported on macOS.";
  }
  return undefined;
}

function resolveLinkedResource(
  store: RunStore,
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

function isLinkedResourcePresent(store: RunStore, kind: ManagedPluginContributionKind, linkedResourceId: string): boolean {
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
