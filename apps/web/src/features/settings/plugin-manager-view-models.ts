import { formatDateTime } from "../../lib/formatting.js";
import type { ManagedPluginView } from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";

export type PluginPrimaryActionId = "apply" | "install" | "enable";
export type PluginDetailActionId = "check" | "runtime-preview" | "refresh-package" | "validate" | "disable" | "uninstall";

export interface PluginActionView {
  readonly id: PluginPrimaryActionId | PluginDetailActionId;
  readonly label: string;
  readonly tone: "primary" | "secondary" | "danger";
}

export interface PluginFactView {
  readonly label: string;
  readonly value: string;
}

export interface PluginRowView {
  readonly sourceLabel: string;
  readonly readiness: string;
  readonly primaryAction?: PluginActionView;
  readonly detailActions: readonly PluginActionView[];
  readonly facts: readonly PluginFactView[];
  readonly contributionLabels: readonly string[];
  readonly warnings: readonly string[];
  readonly packageNotice?: string;
}

export function buildPluginRowView(plugin: ManagedPluginView, t: SettingsTranslator): PluginRowView {
  return {
    sourceLabel: pluginSourceLabel(plugin.sourceKind, t),
    readiness: pluginReadinessLabel(plugin, t),
    primaryAction: pluginPrimaryAction(plugin, t),
    detailActions: pluginDetailActions(plugin, t),
    facts: pluginFacts(plugin, t),
    contributionLabels: plugin.contributions.map((contribution) => {
      const link = contribution.linkedResourceId ? ` -> ${contribution.linkedResourceId}` : "";
      return `${contribution.kind}: ${contribution.label}${link}`;
    }),
    warnings: pluginDefaultWarnings(plugin, t),
    packageNotice: plugin.sourceKind === "bundled"
      ? plugin.package?.status === "installed"
        ? t("Bundled package installed for this workspace.")
        : t("Bundled package metadata only. Install before runtime injection.")
      : undefined,
  };
}

function pluginDefaultWarnings(plugin: ManagedPluginView, t: SettingsTranslator): readonly string[] {
  const warnings: string[] = [];
  if (plugin.disabledReason) {
    warnings.push(t("Plugin is disabled. Enable it when you need its tools."));
  }
  if (plugin.runtimePreview?.blockers.length) {
    warnings.push(t("Plugin needs attention. Open details to inspect availability."));
  }
  return warnings;
}

function pluginSourceLabel(sourceKind: ManagedPluginView["sourceKind"], t: SettingsTranslator): string {
  if (sourceKind === "built-in") {
    return t("Built-in");
  }
  if (sourceKind === "bundled") {
    return t("Bundled");
  }
  return t("Trusted local");
}

function pluginReadinessLabel(plugin: ManagedPluginView, t: SettingsTranslator): string {
  if (plugin.disabledReason || plugin.runtimePreview?.blockers.length) {
    return t("Needs attention");
  }
  if (plugin.actions.canInstall) {
    return t("Install package to use this plugin");
  }
  if (plugin.actions.canApplyPreset && !hasPresentLinkedResource(plugin)) {
    return t("Preset ready to apply");
  }
  if (plugin.actions.canEnable) {
    return t("Enable plugin to use linked capabilities");
  }
  if (plugin.actions.canApplyPreset && plugin.status !== "enabled") {
    return t("Preset ready to apply");
  }
  if (plugin.status === "enabled") {
    const linkedCount = plugin.linkedResources.filter((resource) => resource.present).length;
    return linkedCount > 0
      ? t("Ready with {count} linked resources", { count: linkedCount })
      : t("Enabled and ready");
  }
  if (plugin.package?.status === "installed") {
    return t("Package installed");
  }
  return t("Ready for setup");
}

function pluginPrimaryAction(plugin: ManagedPluginView, t: SettingsTranslator): PluginActionView | undefined {
  if (plugin.actions.canInstall) {
    return { id: "install", label: t("Install"), tone: "primary" };
  }
  if (plugin.actions.canApplyPreset && !hasPresentLinkedResource(plugin)) {
    return { id: "apply", label: t("Apply preset"), tone: "primary" };
  }
  if (plugin.actions.canEnable) {
    return { id: "enable", label: t("Enable"), tone: "primary" };
  }
  if (plugin.actions.canApplyPreset && plugin.status !== "enabled") {
    return { id: "apply", label: t("Apply preset"), tone: "primary" };
  }
  return undefined;
}

function hasPresentLinkedResource(plugin: ManagedPluginView): boolean {
  return plugin.linkedResources.some((resource) => resource.present);
}

function pluginDetailActions(plugin: ManagedPluginView, t: SettingsTranslator): readonly PluginActionView[] {
  const actions: PluginActionView[] = [];
  if (plugin.actions.canCheck) {
    actions.push({ id: "check", label: t("Check"), tone: "secondary" });
  }
  if (plugin.actions.canRuntimePreview) {
    actions.push({ id: "runtime-preview", label: t("Runtime preview"), tone: "secondary" });
  }
  if (plugin.actions.canRefreshPackage) {
    actions.push({ id: "refresh-package", label: t("Refresh package"), tone: "secondary" });
  }
  if (plugin.sourceKind === "bundled") {
    actions.push({ id: "validate", label: t("Validate package"), tone: "secondary" });
  }
  if (plugin.actions.canDisable) {
    actions.push({ id: "disable", label: t("Disable"), tone: "danger" });
  }
  if (plugin.actions.canUninstall) {
    actions.push({ id: "uninstall", label: t("Uninstall"), tone: "danger" });
  }
  return actions;
}

function pluginFacts(plugin: ManagedPluginView, t: SettingsTranslator): readonly PluginFactView[] {
  return [
    { label: t("Availability"), value: pluginReadinessLabel(plugin, t) },
    { label: t("Plugin ID"), value: plugin.id },
    { label: t("Version"), value: plugin.version },
    { label: t("Trust"), value: plugin.trustSummary },
    { label: t("Health"), value: healthLabel(plugin, t) },
    { label: t("Package"), value: packageLabel(plugin, t) },
    { label: t("Linked resources"), value: linkedResourceLabel(plugin, t) },
    { label: t("Runtime preview"), value: runtimePreviewLabel(plugin, t) },
    { label: t("Latest event"), value: latestEventLabel(plugin, t) },
  ];
}

function healthLabel(plugin: ManagedPluginView, t: SettingsTranslator): string {
  if (!plugin.health) {
    return t("Unknown");
  }
  const checked = formatDateTime(plugin.health.checkedAt);
  return plugin.health.message ? `${plugin.health.status} · ${checked} · ${plugin.health.message}` : `${plugin.health.status} · ${checked}`;
}

function packageLabel(plugin: ManagedPluginView, t: SettingsTranslator): string {
  if (!plugin.package) {
    return plugin.sourceKind === "bundled" ? t("Not installed") : t("No package");
  }
  const hash = plugin.package.packageHash ? plugin.package.packageHash.slice(0, 12) : t("No hash");
  return `${plugin.package.status} · ${plugin.package.version} · ${hash}`;
}

function linkedResourceLabel(plugin: ManagedPluginView, t: SettingsTranslator): string {
  if (plugin.linkedResources.length === 0) {
    return t("No linked resources");
  }
  return plugin.linkedResources.map((resource) => `${resource.id}${resource.present ? "" : ` ${t("missing")}`}`).join(", ");
}

function runtimePreviewLabel(plugin: ManagedPluginView, t: SettingsTranslator): string {
  if (!plugin.runtimePreview) {
    return t("Not previewed");
  }
  const overlays = plugin.runtimePreview.policyOverlays.length
    ? ` · ${plugin.runtimePreview.policyOverlays.length} ${t("policy overlays")}`
    : "";
  const blocker = plugin.runtimePreview.blockers[0] ? ` · ${plugin.runtimePreview.blockers[0]}` : "";
  return `${runtimePreviewStatusLabel(plugin.runtimePreview.status, t)}${overlays}${blocker}`;
}

function latestEventLabel(plugin: ManagedPluginView, t: SettingsTranslator): string {
  const latest = plugin.events?.[plugin.events.length - 1];
  if (!latest) {
    return t("No recent event");
  }
  return `${latest.type} · ${formatDateTime(latest.createdAt)}`;
}

function runtimePreviewStatusLabel(status: string, t: SettingsTranslator): string {
  if (status === "injectable") {
    return t("Runtime ready");
  }
  if (status === "blocked") {
    return t("Runtime blocked");
  }
  if (status === "disabled") {
    return t("Runtime disabled");
  }
  return status || t("Unknown");
}
