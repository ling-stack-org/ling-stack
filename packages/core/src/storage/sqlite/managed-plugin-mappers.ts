import type { SQLOutputValue } from "node:sqlite";
import {
  type ManagedPluginContributionRecord,
  type ManagedPluginDescriptor,
  type ManagedPluginEvent,
  type ManagedPluginHealthSnapshot,
  type ManagedPluginPackageRecord,
  type ManagedPluginRecord,
  type ManagedPluginRuntimeSnapshot,
} from "../../plugin-manager-types.js";
import {
  omitUndefined,
  parseJson,
  parseNullableJson,
  readBoolean,
  readNullableString,
  readString,
} from "./helpers.js";

export function mapManagedPlugin(row: Record<string, SQLOutputValue>): ManagedPluginRecord {
  return omitUndefined({
    id: readString(row, "id"),
    sourceKind: readString(row, "source_kind") as ManagedPluginRecord["sourceKind"],
    version: readString(row, "version"),
    enabled: readBoolean(row, "enabled"),
    disabledReason: readNullableString(row, "disabled_reason"),
    descriptor: parseManagedPluginDescriptor(readString(row, "descriptor_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapManagedPluginContribution(row: Record<string, SQLOutputValue>): ManagedPluginContributionRecord {
  return omitUndefined({
    pluginId: readString(row, "plugin_id"),
    contributionKind: readString(row, "contribution_kind") as ManagedPluginContributionRecord["contributionKind"],
    contributionId: readString(row, "contribution_id"),
    linkedResourceId: readNullableString(row, "linked_resource_id"),
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapManagedPluginEvent(row: Record<string, SQLOutputValue>): ManagedPluginEvent {
  return omitUndefined({
    id: readString(row, "id"),
    pluginId: readString(row, "plugin_id"),
    type: readString(row, "type") as ManagedPluginEvent["type"],
    actor: readString(row, "actor") as ManagedPluginEvent["actor"],
    message: readNullableString(row, "message"),
    data: parseNullableJson(readNullableString(row, "data_json")),
    createdAt: readString(row, "created_at"),
  });
}

export function mapManagedPluginPackage(row: Record<string, SQLOutputValue>): ManagedPluginPackageRecord {
  return omitUndefined({
    pluginId: readString(row, "plugin_id"),
    sourceKind: readString(row, "source_kind") as ManagedPluginPackageRecord["sourceKind"],
    version: readString(row, "version"),
    status: readString(row, "status") as ManagedPluginPackageRecord["status"],
    cacheRef: readString(row, "cache_ref"),
    packageHash: readNullableString(row, "package_hash"),
    manifestJson: readString(row, "manifest_json"),
    installedAt: readString(row, "installed_at"),
    updatedAt: readString(row, "updated_at"),
    uninstalledAt: readNullableString(row, "uninstalled_at"),
  });
}

export function mapManagedPluginRuntimeSnapshot(row: Record<string, SQLOutputValue>): ManagedPluginRuntimeSnapshot {
  return omitUndefined({
    id: readString(row, "id"),
    runId: readNullableString(row, "run_id"),
    cwd: readString(row, "cwd"),
    pluginIds: parseJson(readString(row, "plugin_ids_json")) as ManagedPluginRuntimeSnapshot["pluginIds"],
    capabilities: parseJson(readString(row, "capabilities_json")) as ManagedPluginRuntimeSnapshot["capabilities"],
    policyOverlays: parseJson(readString(row, "policy_overlays_json")) as ManagedPluginRuntimeSnapshot["policyOverlays"],
    createdAt: readString(row, "created_at"),
  });
}

export function parseManagedPluginHealthSnapshot(value: string): ManagedPluginHealthSnapshot {
  return parseJson(value) as ManagedPluginHealthSnapshot;
}

function parseManagedPluginDescriptor(value: string): ManagedPluginDescriptor {
  return parseJson(value) as ManagedPluginDescriptor;
}
