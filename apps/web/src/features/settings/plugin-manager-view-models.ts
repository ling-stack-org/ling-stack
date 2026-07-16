import type { ManagedPluginView } from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";

export type PluginActionId =
  | "apply"
  | "guide"
  | "install"
  | "check"
  | "enable"
  | "disable"
  | "details"
  | "runtime-preview"
  | "refresh-package"
  | "validate"
  | "uninstall";

export interface PluginActionView {
  readonly id: PluginActionId;
  readonly label: string;
  readonly tone: "primary" | "secondary" | "danger";
}

export interface PluginDetailFieldView {
  readonly label: string;
  readonly value: string;
}

export interface PluginTableRowView {
  readonly description: string;
  readonly statusLabel: string;
  readonly statusTone: "neutral" | "progress" | "warning" | "danger";
  readonly rowActions: readonly PluginActionView[];
  readonly drawerActions: readonly PluginActionView[];
  readonly detailFields: readonly PluginDetailFieldView[];
  readonly failureReason?: string;
  readonly hasLinkedMcp: boolean;
}

export function buildPluginTableRowView(plugin: ManagedPluginView, t: SettingsTranslator): PluginTableRowView {
  return {
    description: pluginTableDescription(plugin, t),
    ...pluginTableStatus(plugin, t),
    rowActions: pluginRowActions(plugin, t),
    drawerActions: pluginDrawerActions(plugin, t),
    detailFields: pluginDetailFields(plugin, t),
    failureReason: pluginFailureReason(plugin),
    hasLinkedMcp: plugin.linkedResources.some((resource) => resource.kind === "mcp-server" && resource.present),
  };
}

function pluginTableDescription(plugin: ManagedPluginView, t: SettingsTranslator): string {
  if (plugin.id === "trusted-local:cua-driver") {
    return t("Controls macOS apps through the local Cua Driver.");
  }
  return plugin.description?.trim() ?? "";
}

function pluginTableStatus(
  plugin: ManagedPluginView,
  t: SettingsTranslator,
): Pick<PluginTableRowView, "statusLabel" | "statusTone"> {
  if (plugin.health?.status === "failed" || plugin.status === "blocked" || plugin.runtimePreview?.blockers.length) {
    return { statusLabel: t("Needs attention"), statusTone: "danger" };
  }
  if (plugin.setup?.state === "missing") {
    return { statusLabel: t("Not installed"), statusTone: "neutral" };
  }
  if (plugin.setup?.state === "detected") {
    return { statusLabel: t("Connecting"), statusTone: "progress" };
  }
  if (plugin.setup?.state === "connected") {
    return { statusLabel: t("Awaiting enable"), statusTone: "neutral" };
  }
  if (plugin.setup?.state === "ready") {
    return { statusLabel: t("Enabled status"), statusTone: "neutral" };
  }
  if (plugin.setup?.state === "unsupported") {
    return { statusLabel: t("Unavailable"), statusTone: "warning" };
  }
  if (plugin.status === "enabled") {
    return { statusLabel: t("Enabled status"), statusTone: "neutral" };
  }
  return { statusLabel: t("Awaiting enable"), statusTone: "neutral" };
}

function pluginRowActions(plugin: ManagedPluginView, t: SettingsTranslator): readonly PluginActionView[] {
  const actions: PluginActionView[] = [];
  if (plugin.setup?.state === "missing") {
    actions.push({ id: "guide", label: t("Installation guide"), tone: "primary" });
  } else if (plugin.actions.canInstall) {
    actions.push({ id: "install", label: t("Install"), tone: "primary" });
  } else if (!plugin.setup && plugin.actions.canApplyPreset && !hasPresentLinkedResource(plugin)) {
    actions.push({ id: "apply", label: t("Apply preset"), tone: "primary" });
  }

  const canCheckFromTable = plugin.actions.canCheck
    && plugin.setup?.state !== "missing"
    && plugin.setup?.state !== "detected"
    && plugin.setup?.state !== "unsupported";
  if (canCheckFromTable || (!plugin.setup && plugin.actions.canCheck)) {
    actions.push({ id: "check", label: t("Check"), tone: "secondary" });
  }
  if (plugin.actions.canEnable) {
    actions.push({ id: "enable", label: t("Enable"), tone: "primary" });
  }
  if (plugin.actions.canDisable) {
    actions.push({ id: "disable", label: t("Disable"), tone: "secondary" });
  }
  actions.push({ id: "details", label: t("Details"), tone: "secondary" });
  return actions;
}

function pluginDrawerActions(plugin: ManagedPluginView, t: SettingsTranslator): readonly PluginActionView[] {
  const actions: PluginActionView[] = [];
  if (plugin.actions.canRuntimePreview) {
    actions.push({ id: "runtime-preview", label: t("Runtime preview"), tone: "secondary" });
  }
  if (plugin.actions.canRefreshPackage) {
    actions.push({ id: "refresh-package", label: t("Refresh package"), tone: "secondary" });
  }
  if (plugin.sourceKind === "bundled") {
    actions.push({ id: "validate", label: t("Validate package"), tone: "secondary" });
  }
  if (plugin.actions.canUninstall) {
    actions.push({ id: "uninstall", label: t("Uninstall"), tone: "danger" });
  }
  return actions;
}

function pluginDetailFields(plugin: ManagedPluginView, t: SettingsTranslator): readonly PluginDetailFieldView[] {
  const fields: PluginDetailFieldView[] = [
    { label: t("Source"), value: pluginSourceLabel(plugin.sourceKind, t) },
    { label: t("Plugin ID"), value: plugin.id },
    { label: t("Version"), value: plugin.version },
  ];
  if (plugin.setup) {
    fields.push(
      { label: t("Local driver"), value: plugin.setup.detectedCommand ?? t("Not detected") },
      { label: t("MCP connection"), value: pluginMcpConnectionLabel(plugin, t) },
    );
  } else if (plugin.linkedResources.length > 0) {
    fields.push({ label: t("Linked resources"), value: linkedResourceLabel(plugin, t) });
  }
  if (plugin.package) {
    fields.push({ label: t("Package"), value: `${plugin.package.status} · ${plugin.package.version}` });
  }
  if (plugin.runtimePreview) {
    fields.push({ label: t("Runtime preview"), value: runtimePreviewStatusLabel(plugin.runtimePreview.status, t) });
  }
  return fields;
}

function pluginFailureReason(plugin: ManagedPluginView): string | undefined {
  if (plugin.health?.status === "failed" && plugin.health.message) {
    return plugin.health.message;
  }
  if (plugin.runtimePreview?.blockers[0]) {
    return plugin.runtimePreview.blockers[0];
  }
  if (plugin.status === "blocked") {
    return plugin.disabledReason ?? plugin.trustSummary;
  }
  return undefined;
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

function pluginMcpConnectionLabel(plugin: ManagedPluginView, t: SettingsTranslator): string {
  const linked = plugin.linkedResources.some((resource) => resource.kind === "mcp-server" && resource.present);
  if (!linked) {
    return t("Not connected");
  }
  return plugin.status === "enabled" ? t("Enabled status") : t("Connected, disabled");
}

function hasPresentLinkedResource(plugin: ManagedPluginView): boolean {
  return plugin.linkedResources.some((resource) => resource.present);
}

function linkedResourceLabel(plugin: ManagedPluginView, t: SettingsTranslator): string {
  return plugin.linkedResources
    .map((resource) => `${resource.displayName ?? resource.id}${resource.present ? "" : ` ${t("missing")}`}`)
    .join(", ");
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
