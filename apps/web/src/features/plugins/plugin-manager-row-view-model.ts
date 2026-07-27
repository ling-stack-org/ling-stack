import type { Translate } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";
import type { PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { buildCuaHealthView } from "./plugin-manager-cua-view-model.js";
import type {
  PluginActionFailure,
  PluginActionView,
  PluginPrimaryStateView,
  PluginRowView,
  PluginStatusFilter,
} from "./plugin-manager-types.js";

export function buildPluginRowView(
  plugin: ManagedPluginView,
  busyPluginId: string,
  busyAction: PluginBusyAction | undefined,
  now: string,
  t: Translate,
  actionFailure?: PluginActionFailure,
): PluginRowView {
  const settledPrimaryState = actionFailure
    ? { id: "failed", label: t("Needs attention"), tone: "danger" } satisfies PluginPrimaryStateView
    : deriveSettledState(plugin, now, t);
  const rowBusyAction = busyPluginId === plugin.id ? busyAction : undefined;
  const primaryState = rowBusyAction
    ? { id: "busy", label: busyStateLabel(rowBusyAction, t), tone: "info" } satisfies PluginPrimaryStateView
    : settledPrimaryState;
  const actions = deriveActions(plugin, settledPrimaryState, t, actionFailure);
  return {
    id: plugin.id,
    name: plugin.displayName,
    description: plugin.id === "trusted-local:cua-driver"
      ? t("Controls desktop apps through the local Cua Driver.")
      : plugin.description?.trim() ?? "",
    sourceKind: plugin.sourceKind,
    sourceLabel: pluginSourceLabel(plugin.sourceKind, t),
    settledPrimaryState,
    primaryState,
    filterGroup: stateFilterGroup(settledPrimaryState.id),
    primaryAction: actions.primaryAction,
    showCheckAction: plugin.actions.canCheck && actions.primaryAction?.id !== "check",
    showDisableAction: plugin.actions.canDisable
      && plugin.sourceKind === "trusted-local-preset"
      && actions.primaryAction?.id !== "disable",
    showDetailsAction: true,
    menuActions: actions.menuActions,
    busyAction: rowBusyAction,
    actionFailure,
  };
}

function deriveSettledState(plugin: ManagedPluginView, now: string, t: Translate): PluginPrimaryStateView {
  const cuaHealth = buildCuaHealthView(plugin, t);
  if (cuaHealth) return cuaHealth.primaryState;
  if (plugin.setup?.state === "unsupported") {
    return { id: "platform-blocked", label: t("Unavailable"), tone: "warning" };
  }
  if (plugin.health?.status === "failed" || plugin.status === "blocked" || hasRuntimeFailure(plugin)) {
    return { id: "failed", label: t("Needs attention"), tone: "danger" };
  }
  if (plugin.setup?.state === "missing") {
    return { id: "setup-missing", label: t("Not installed"), tone: "neutral" };
  }
  if (plugin.actions.canInstall || plugin.package?.status === "uninstalled") {
    return { id: "package-missing", label: t("Not installed"), tone: "neutral" };
  }
  if (plugin.setup?.state === "detected") {
    return { id: "connecting", label: t("Connecting"), tone: "info" };
  }
  if (isStale(plugin, now)) {
    return { id: "stale", label: t("Needs check"), tone: "warning" };
  }
  if (plugin.status === "enabled" && plugin.health?.status === "unknown" && plugin.actions.canCheck) {
    return { id: "needs-check", label: t("Needs check"), tone: "neutral" };
  }
  if (plugin.status === "available" || plugin.status === "disabled" || plugin.setup?.state === "connected") {
    return {
      id: "disabled",
      label: plugin.sourceKind === "trusted-local-preset" ? t("Awaiting enable") : t("Disabled"),
      tone: "neutral",
    };
  }
  if (plugin.status === "enabled" || plugin.setup?.state === "ready") {
    return { id: "ready", label: t("Enabled status"), tone: "success" };
  }
  return { id: "unknown", label: t("Unknown"), tone: "neutral" };
}

function deriveActions(
  plugin: ManagedPluginView,
  state: PluginPrimaryStateView,
  t: Translate,
  actionFailure?: PluginActionFailure,
): { readonly primaryAction?: PluginActionView; readonly menuActions: readonly PluginActionView[] } {
  const cuaHealth = buildCuaHealthView(plugin, t);
  let primaryAction: PluginActionView | undefined;
  if (actionFailure?.retryAction) {
    primaryAction = action(actionFailure.retryAction, t("Retry"), "primary");
  } else if (state.id === "setup-missing") {
    primaryAction = action("guide", t("Installation guide"), "primary");
  } else if (state.id === "package-missing" && plugin.actions.canInstall) {
    primaryAction = action("install", t("Install"), "primary");
  } else if (plugin.actions.canApplyPreset && !hasPresentLinkedResource(plugin) && !plugin.setup) {
    primaryAction = action("apply", t("Apply preset"), "primary");
  } else if (cuaHealth?.primaryAction === "check") {
    primaryAction = action("check", t("Recheck"), "primary");
  } else if (cuaHealth?.primaryAction === "details" || [
    "platform-blocked",
    "provider-incompatible",
    "restart-required",
    "failed",
  ].includes(state.id)) {
    primaryAction = action("details", t("View repair steps"), "primary");
  } else if ((state.id === "stale" || state.id === "needs-check") && plugin.actions.canCheck) {
    primaryAction = action("check", t("Check"), "primary");
  } else if (state.id === "disabled" && plugin.actions.canEnable) {
    primaryAction = action("enable", t("Enable"), "primary");
  }

  const menuActions: PluginActionView[] = [];
  if (plugin.actions.canDisable && plugin.sourceKind !== "trusted-local-preset") {
    menuActions.push(action("disable", t("Disable"), "secondary"));
  }
  if (plugin.sourceKind === "bundled") {
    menuActions.push(action("validate", t("Validate package"), "secondary"));
  }
  if (plugin.actions.canRefreshPackage) {
    menuActions.push(action("refresh-package", t("Refresh package"), "secondary"));
  }
  if (plugin.actions.canUninstall) {
    menuActions.push(action("uninstall", t("Uninstall"), "danger"));
  }
  return {
    primaryAction,
    menuActions: actionFailure
      ? menuActions.filter((candidate) => candidate.id !== actionFailure.retryAction)
      : menuActions,
  };
}

function action(id: PluginActionView["id"], label: string, tone: PluginActionView["tone"]): PluginActionView {
  return { id, label, tone };
}

function pluginSourceLabel(sourceKind: ManagedPluginView["sourceKind"], t: Translate): string {
  if (sourceKind === "built-in") return t("Built-in");
  if (sourceKind === "bundled") return t("Bundled");
  return t("Trusted local");
}

function isStale(plugin: ManagedPluginView, now: string): boolean {
  if (plugin.health?.status === "expired") return true;
  const expiresAt = plugin.health?.expiresAt ? Date.parse(plugin.health.expiresAt) : Number.NaN;
  const nowAt = Date.parse(now);
  return Number.isFinite(expiresAt) && Number.isFinite(nowAt) && expiresAt <= nowAt;
}

function hasRuntimeFailure(plugin: ManagedPluginView): boolean {
  return plugin.runtimePreview?.status === "blocked" && plugin.runtimePreview.blockers.some((blocker) => {
    const normalized = blocker.toLowerCase();
    return !normalized.includes("disabled") && !normalized.includes("not installed");
  });
}

function stateFilterGroup(state: PluginPrimaryStateView["id"]): Exclude<PluginStatusFilter, "all"> | "other" {
  if (["platform-blocked"].includes(state)) return "unavailable";
  if (["ready"].includes(state)) return "enabled";
  if (["disabled"].includes(state)) return "disabled";
  if ([
    "provider-incompatible",
    "restart-required",
    "provider-unavailable",
    "failed",
    "setup-missing",
    "package-missing",
    "stale",
    "needs-check",
  ].includes(state)) return "needs-action";
  return "other";
}

function busyStateLabel(actionId: PluginBusyAction, t: Translate): string {
  if (actionId === "check" || actionId === "connect") return t("Checking...");
  if (actionId === "enable") return t("Enable");
  if (actionId === "disable") return t("Disable");
  if (actionId === "install") return t("Install");
  if (actionId === "uninstall") return t("Uninstall");
  if (actionId === "runtime-preview") return t("Runtime preview");
  if (actionId === "refresh-package") return t("Refresh package");
  if (actionId === "validate") return t("Validate package");
  if (actionId === "apply") return t("Apply preset");
  return t("Loading");
}

function hasPresentLinkedResource(plugin: ManagedPluginView): boolean {
  return plugin.linkedResources.some((resource) => resource.present);
}
