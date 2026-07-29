import type { Translate } from "../../i18n.js";
import type { ManagedPluginLinkedResource, ManagedPluginView } from "../../types.js";
import { buildCuaHealthView } from "./plugin-manager-cua-view-model.js";
import { buildBundledCuaDriverView } from "./plugin-manager-bundled-cua-view-model.js";
import type { PluginManagerCopy } from "./plugin-manager-copy.js";
import type {
  PluginDetailFieldView,
  PluginDetailView,
  PluginResourceGroupView,
  PluginRuntimeView,
  PluginRowView,
} from "./plugin-manager-types.js";

export function buildPluginDetailView(
  plugin: ManagedPluginView,
  row: PluginRowView,
  copy: PluginManagerCopy,
  t: Translate,
): PluginDetailView {
  const cuaHealth = buildCuaHealthView(plugin, t);
  const bundledCua = buildBundledCuaDriverView(plugin, t);
  return {
    sourceVersion: bundledCua?.sourceVersion ?? `${row.sourceLabel} · ${plugin.version}`,
    description: row.description,
    overviewFields: bundledCua?.overviewFields ?? buildOverviewFields(plugin, row, t),
    failureReason: bundledCua?.failureReason ?? cuaHealth?.failureReason ?? genericFailureReason(plugin, t),
    repairHint: bundledCua?.repairHint ?? cuaHealth?.repairHint ?? genericRepairHint(plugin, t),
    capabilities: plugin.contributions.map((contribution) => ({
      id: contribution.id,
      label: contribution.label,
      kind: contribution.kind,
      enabled: contribution.enabled,
      capabilities: contribution.capabilities,
    })),
    capabilitySummary: String(plugin.contributions.length),
    trustSummary: plugin.trustSummary,
    trustFields: buildTrustFields(plugin, t),
    runtime: plugin.runtimePreview ? buildRuntimeView(plugin, copy, t) : undefined,
    technicalFields: bundledCua?.technicalFields
      ?? buildTechnicalFields(plugin, cuaHealth?.technicalFields ?? [], Boolean(cuaHealth), t),
    hasLinkedMcp: plugin.linkedResources.some((resource) => resource.kind === "mcp-server" && resource.present),
  };
}

function buildOverviewFields(
  plugin: ManagedPluginView,
  row: PluginRowView,
  t: Translate,
): readonly PluginDetailFieldView[] {
  const fields: PluginDetailFieldView[] = [
    { label: t("Source"), value: row.sourceLabel },
    { label: t("Version"), value: plugin.version },
    {
      label: t("Linked resources"),
      value: plugin.linkedResources.length ? String(plugin.linkedResources.length) : t("No linked resources"),
    },
  ];
  if (plugin.package) {
    fields.push({ label: t("Package"), value: plugin.package.status === "installed" ? t("Package installed") : t("Not installed") });
  }
  if (plugin.runtimePreview) {
    fields.push({ label: t("Runtime state"), value: runtimeStatusLabel(plugin.runtimePreview.status, t) });
  }
  return fields;
}

function buildTrustFields(plugin: ManagedPluginView, t: Translate): readonly PluginDetailFieldView[] {
  const fields: PluginDetailFieldView[] = [];
  for (const requirement of plugin.requiredSecrets ?? []) {
    fields.push({ label: requirement.label, value: requirement.required ? t("Required") : t("Optional") });
  }
  for (const approval of plugin.defaultApprovals ?? []) {
    fields.push({ label: approval.contributionId, value: approval.decision });
  }
  return fields;
}

function buildRuntimeView(plugin: ManagedPluginView, copy: PluginManagerCopy, t: Translate): PluginRuntimeView {
  const preview = plugin.runtimePreview;
  if (!preview) {
    return { statusLabel: t("Unknown"), tone: "neutral", summary: t("Not previewed"), groups: [] };
  }
  const groups: PluginResourceGroupView[] = [
    resourceGroup(t("MCP servers"), preview.mcpServers, t),
    resourceGroup(copy.skillPacks, preview.skillPacks, t),
    resourceGroup(copy.apps, preview.apps, t),
    resourceGroup(copy.hooks, preview.hooks, t),
  ].filter((group) => group.items.length > 0);
  if (preview.status === "injectable") {
    return {
      statusLabel: t("Runtime ready"),
      tone: "success",
      summary: copy.runtimeReady,
      groups,
      policySummary: preview.policyOverlays.length ? copy.policyRules(preview.policyOverlays.length) : undefined,
    };
  }
  if (preview.status === "disabled") {
    return {
      statusLabel: t("Runtime disabled"),
      tone: "neutral",
      summary: copy.runtimeDisabled,
      groups,
      policySummary: preview.policyOverlays.length ? copy.policyRules(preview.policyOverlays.length) : undefined,
    };
  }
  return {
    statusLabel: t("Runtime blocked"),
    tone: "danger",
    summary: copy.runtimeBlocked,
    blocker: productRuntimeBlocker(preview.blockers[0], t),
    groups,
    policySummary: preview.policyOverlays.length ? copy.policyRules(preview.policyOverlays.length) : undefined,
  };
}

function resourceGroup(
  label: string,
  resources: readonly ManagedPluginLinkedResource[],
  t: Translate,
): PluginResourceGroupView {
  return {
    label,
    items: resources.map((resource) => ({
      label: resource.displayName ?? resource.kind,
      value: resource.present === false ? t("missing") : resource.enabled === false ? t("Disabled") : t("Available"),
    })),
  };
}

function buildTechnicalFields(
  plugin: ManagedPluginView,
  cuaFields: readonly PluginDetailFieldView[],
  hasProductCuaFailure: boolean,
  t: Translate,
): readonly PluginDetailFieldView[] {
  const fields: PluginDetailFieldView[] = [
    { label: t("Plugin ID"), value: plugin.id },
    ...cuaFields,
  ];
  if (plugin.setup?.detectedCommand) fields.push({ label: t("Local driver"), value: plugin.setup.detectedCommand });
  if (plugin.health?.checkedAt) fields.push({ label: t("Last checked"), value: plugin.health.checkedAt });
  if (plugin.health?.expiresAt) fields.push({ label: t("Check expires"), value: plugin.health.expiresAt });
  if (plugin.health?.message && !hasProductCuaFailure) fields.push({ label: t("Failure detail"), value: plugin.health.message });
  if (plugin.package?.cacheRef) fields.push({ label: t("Storage reference"), value: plugin.package.cacheRef });
  if (plugin.package?.packageHash) fields.push({ label: t("Package checksum"), value: plugin.package.packageHash });
  if (plugin.package?.updatedAt) fields.push({ label: t("Updated"), value: plugin.package.updatedAt });
  for (const blocker of plugin.runtimePreview?.blockers ?? []) {
    fields.push({ label: t("Runtime issue"), value: blocker });
  }
  for (const contribution of plugin.contributions) {
    fields.push({
      label: contribution.label,
      value: [contribution.id, ...contribution.capabilities].join(" · "),
    });
  }
  for (const policy of plugin.runtimePreview?.policyOverlays ?? []) {
    fields.push({
      label: t("Policy details"),
      value: `${policy.targetKind}:${policy.targetId} · ${policy.defaultApproval} · ${policy.sideEffectLevel}`,
    });
  }
  return fields;
}

function genericFailureReason(plugin: ManagedPluginView, t: Translate): string | undefined {
  if (plugin.health?.status === "failed" || plugin.status === "blocked") {
    return t("Plugin needs attention. Open details to inspect availability.");
  }
  if (plugin.runtimePreview?.status === "blocked") {
    return t("Runtime preview has blockers. Open technical details to inspect.");
  }
  return undefined;
}

function genericRepairHint(plugin: ManagedPluginView, t: Translate): string | undefined {
  if (plugin.actions.canCheck && (plugin.health?.status === "failed" || plugin.status === "blocked")) {
    return t("Check again");
  }
  return undefined;
}

function productRuntimeBlocker(blocker: string | undefined, t: Translate): string {
  const normalized = blocker?.toLowerCase() ?? "";
  if (normalized.includes("disabled")) return t("Plugin is disabled. Enable it when you need its tools.");
  if (normalized.includes("not installed") || normalized.includes("package")) return t("Install package to use this plugin");
  return t("Runtime preview has blockers. Open technical details to inspect.");
}

function runtimeStatusLabel(status: string, t: Translate): string {
  if (status === "injectable") return t("Runtime ready");
  if (status === "blocked") return t("Runtime blocked");
  if (status === "disabled") return t("Runtime disabled");
  return t("Unknown");
}
