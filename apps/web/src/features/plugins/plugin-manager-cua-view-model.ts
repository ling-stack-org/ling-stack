import type { Translate } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";
import type { PluginDetailFieldView, PluginPrimaryStateView } from "./plugin-manager-types.js";

export type CuaRepairAction = "check" | "details";

export interface CuaHealthView {
  readonly primaryState: PluginPrimaryStateView;
  readonly primaryAction: CuaRepairAction;
  readonly failureReason: string;
  readonly repairHint: string;
  readonly technicalFields: readonly PluginDetailFieldView[];
}

export function isCuaDriver(plugin: ManagedPluginView): boolean {
  return plugin.id === "trusted-local:cua-driver" || plugin.id === "bundled:cua-driver";
}

export function buildCuaHealthView(plugin: ManagedPluginView, t: Translate): CuaHealthView | undefined {
  if (!isCuaDriver(plugin) || plugin.health?.status !== "failed") {
    return undefined;
  }
  const details = readRecord(plugin.health.details);
  const code = readString(details?.errorCode);
  const technicalFields = buildCuaTechnicalFields(details, t);
  if (code === "plugin_provider_unavailable") {
    return {
      primaryState: { id: "provider-unavailable", label: t("Unable to connect"), tone: "danger" },
      primaryAction: "check",
      failureReason: t("Cua Driver could not be reached."),
      repairHint: t("Make sure Cua Driver is running in an interactive desktop session, then check again."),
      technicalFields,
    };
  }
  if (code === "plugin_provider_incompatible") {
    return {
      primaryState: { id: "provider-incompatible", label: t("Update required"), tone: "warning" },
      primaryAction: "details",
      failureReason: t("This Cua Driver version is not compatible."),
      repairHint: t("Update Cua Driver to a supported version, then check again."),
      technicalFields,
    };
  }
  if (code === "plugin_platform_blocked") {
    return {
      primaryState: { id: "platform-blocked", label: t("Unavailable"), tone: "warning" },
      primaryAction: "details",
      failureReason: t("Cua Driver is not available on this platform."),
      repairHint: t("Use a supported macOS or Windows desktop client."),
      technicalFields,
    };
  }
  if (code === "plugin_restart_required") {
    return {
      primaryState: { id: "restart-required", label: t("Restart required"), tone: "warning" },
      primaryAction: "details",
      failureReason: t("Cua Driver must restart before Computer Use is available."),
      repairHint: t("Restart Cua Driver, then check again."),
      technicalFields,
    };
  }
  return {
    primaryState: { id: "failed", label: t("Needs attention"), tone: "danger" },
    primaryAction: "details",
    failureReason: t("Windows desktop access is not ready."),
    repairHint: t("Review the failed provider checks, fix the affected capability, then check again."),
    technicalFields,
  };
}

function buildCuaTechnicalFields(
  details: Record<string, unknown> | undefined,
  t: Translate,
): readonly PluginDetailFieldView[] {
  if (!details) return [];
  const fields: PluginDetailFieldView[] = [];
  addTechnicalField(fields, t("Error code"), details.errorCode);
  addTechnicalField(fields, t("Platform"), details.platform);
  addTechnicalField(fields, t("Driver version"), details.driverVersion);
  addTechnicalField(fields, t("Supported versions"), details.supportedDriverVersions);
  addTechnicalField(fields, t("Missing tools"), details.missingTools);
  addTechnicalField(fields, t("Required checks"), details.requiredChecks);
  const checks = readArray(details.checks)
    ?.map((check) => readRecord(check))
    .filter((check): check is Record<string, unknown> => Boolean(check))
    .map((check) => [readString(check.name), readString(check.status)].filter(Boolean).join(": "))
    .filter(Boolean);
  addTechnicalField(fields, t("Provider checks"), checks);
  return fields;
}

function addTechnicalField(fields: PluginDetailFieldView[], label: string, value: unknown): void {
  const formatted = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).join(", ")
    : typeof value === "string" ? value.trim() : "";
  if (formatted) fields.push({ label, value: formatted });
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
