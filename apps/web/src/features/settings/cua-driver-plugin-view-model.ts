import type {
  CuaDriverLimitation,
  CuaDriverProviderState,
  ManagedPluginSetupView,
  ManagedPluginView,
} from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import type { PluginActionView, PluginDetailFieldView } from "./plugin-manager-view-models.js";

export interface BundledCuaDriverPluginView {
  readonly description: string;
  readonly statusLabel: string;
  readonly statusTone: "neutral" | "progress" | "warning" | "danger";
  readonly rowActions: readonly PluginActionView[];
  readonly detailFields: readonly PluginDetailFieldView[];
}

type BundledCuaDriverProviderViewState = CuaDriverProviderState | "invalid";

const CUA_DRIVER_PROVIDER_STATES = new Set<CuaDriverProviderState>([
  "included",
  "desktop_unavailable",
  "permission_required",
  "interactive_session_required",
  "platform_unavailable",
  "ready",
  "incompatible",
  "corrupt",
  "unsupported",
]);

/**
 * Build the product-facing view for the canonical Cua Driver row.
 *
 * The V2 distribution marker is the only switch. Gate-off and older daemon
 * responses therefore continue through the legacy external-local mapper.
 */
export function buildBundledCuaDriverPluginView(
  plugin: ManagedPluginView,
  t: SettingsTranslator,
): BundledCuaDriverPluginView | undefined {
  const setup = plugin.setup;
  if (plugin.id !== "trusted-local:cua-driver" || !isBundledCuaDriverSetupMarker(setup)) {
    return undefined;
  }
  const providerState = normalizedProviderState(setup);
  return {
    description: t("Controls macOS and Windows apps through the Cua Driver included with Ling."),
    ...providerStatus(providerState, t),
    rowActions: bundledRowActions(plugin, providerState, t),
    detailFields: bundledDetailFields(plugin, setup, providerState, t),
  };
}

function isBundledCuaDriverSetupMarker(
  setup: ManagedPluginSetupView | undefined,
): setup is ManagedPluginSetupView & {
  readonly schemaVersion: 2;
  readonly distribution: "bundled_embedded";
} {
  return setup?.schemaVersion === 2
    && setup.distribution === "bundled_embedded";
}

function normalizedProviderState(
  setup: ManagedPluginSetupView,
): BundledCuaDriverProviderViewState {
  return CUA_DRIVER_PROVIDER_STATES.has(setup.providerState as CuaDriverProviderState)
    && typeof setup.requestedEnabled === "boolean"
    && typeof setup.effectiveEnabled === "boolean"
    ? setup.providerState as CuaDriverProviderState
    : "invalid";
}

function providerStatus(
  state: BundledCuaDriverProviderViewState,
  t: SettingsTranslator,
): Pick<BundledCuaDriverPluginView, "statusLabel" | "statusTone"> {
  switch (state) {
    case "included":
      return { statusLabel: t("Included"), statusTone: "neutral" };
    case "desktop_unavailable":
      return { statusLabel: t("Desktop required"), statusTone: "warning" };
    case "permission_required":
      return { statusLabel: t("Permissions required"), statusTone: "warning" };
    case "interactive_session_required":
      return { statusLabel: t("Interactive session required"), statusTone: "warning" };
    case "platform_unavailable":
      return { statusLabel: t("Platform unavailable"), statusTone: "danger" };
    case "ready":
      return { statusLabel: t("Ready"), statusTone: "neutral" };
    case "incompatible":
      return { statusLabel: t("Update required"), statusTone: "danger" };
    case "corrupt":
      return { statusLabel: t("Repair required"), statusTone: "danger" };
    case "unsupported":
      return { statusLabel: t("Unavailable"), statusTone: "warning" };
    case "external_missing":
    case "external_detected":
    case "external_connected":
    case "invalid":
      // A bundled projection must never carry an external state. Keep the UI
      // fail-closed and direct the user to details if persistence is stale.
      return { statusLabel: t("Needs attention"), statusTone: "danger" };
  }
}

function bundledRowActions(
  plugin: ManagedPluginView,
  state: BundledCuaDriverProviderViewState,
  t: SettingsTranslator,
): readonly PluginActionView[] {
  const actions: PluginActionView[] = [];
  if (state !== "invalid" && plugin.actions.canEnable) {
    actions.push({ id: "enable", label: t("Enable"), tone: "primary" });
  }

  const guidanceLabel = primaryGuidanceLabel(state, t);
  if (guidanceLabel) {
    actions.push({ id: "details", label: guidanceLabel, tone: "primary" });
  }
  if (plugin.actions.canCheck && state !== "included" && state !== "unsupported") {
    actions.push({ id: "check", label: t("Check again"), tone: "secondary" });
  }
  if (plugin.actions.canDisable) {
    actions.push({ id: "disable", label: t("Disable"), tone: "secondary" });
  }
  if (!guidanceLabel) {
    actions.push({ id: "details", label: t("Details"), tone: "secondary" });
  }
  return actions;
}

function primaryGuidanceLabel(
  state: BundledCuaDriverProviderViewState,
  t: SettingsTranslator,
): string | undefined {
  switch (state) {
    case "permission_required":
      return t("Review macOS permissions");
    case "desktop_unavailable":
    case "interactive_session_required":
      return t("Recovery steps");
    case "platform_unavailable":
    case "incompatible":
    case "corrupt":
      return t("Repair steps");
    case "external_missing":
    case "external_detected":
    case "external_connected":
    case "invalid":
      return t("Review state");
    case "included":
    case "ready":
    case "unsupported":
      return undefined;
  }
}

function bundledDetailFields(
  plugin: ManagedPluginView,
  setup: ManagedPluginSetupView,
  providerState: BundledCuaDriverProviderViewState,
  t: SettingsTranslator,
): readonly PluginDetailFieldView[] {
  const fields: PluginDetailFieldView[] = [
    { label: t("Source"), value: t("Included with Ling") },
    { label: t("Plugin ID"), value: plugin.id },
    { label: t("Version"), value: plugin.version },
    { label: t("Platform"), value: platformLabel(setup.platform, t) },
    { label: t("Requested"), value: booleanStateLabel(setup.requestedEnabled, t, "Enabled status", "Disabled") },
    { label: t("Effective readiness"), value: booleanStateLabel(setup.effectiveEnabled, t, "Ready", "Not ready") },
    { label: t("Next step"), value: providerGuidance(providerState, setup.platform, t) },
  ];

  const providerVersion = providerVersionLabel(setup);
  if (providerVersion) {
    fields.splice(3, 0, { label: t("Provider version"), value: providerVersion });
  }
  if (setup.integrity) {
    fields.push({ label: t("Integrity"), value: integrityLabel(setup.integrity, t) });
  }
  if (setup.integrityCoverage) {
    fields.push({
      label: t("Integrity coverage"),
      value: setup.integrityCoverage === "standard" ? t("Standard user apps") : "UIAccess",
    });
  }
  const limitations = limitationLabels(setup.limitations ?? [], t);
  if (limitations.length > 0) {
    fields.push({ label: t("Limitations"), value: limitations.join(" · ") });
  }
  if (setup.permissions) {
    fields.push(
      { label: t("Accessibility"), value: readinessValue(setup.permissions.accessibility, t) },
      { label: t("Screen Recording"), value: readinessValue(setup.permissions.screenRecording, t) },
    );
  }
  if (setup.windowsReadiness) {
    fields.push(
      { label: t("Interactive session"), value: readinessValue(setup.windowsReadiness.interactiveSession, t) },
      { label: t("Windows capture"), value: readinessValue(setup.windowsReadiness.wgcApi, t) },
      { label: t("UI Automation"), value: readinessValue(setup.windowsReadiness.uiaRuntime, t) },
    );
  }
  if (setup.externalOverride) {
    fields.push({ label: t("External override"), value: setup.externalOverride.command });
  }
  return fields;
}

function providerVersionLabel(setup: ManagedPluginSetupView): string | undefined {
  if (setup.providerDisplayVersion) {
    return setup.providerDisplayVersion;
  }
  if (!setup.providerVersion) {
    return undefined;
  }
  const revisionMatch = /^ling\.(\d+)$/i.exec(setup.providerDistributionRevision ?? "");
  return revisionMatch
    ? `${setup.providerVersion} (Ling build ${revisionMatch[1]})`
    : setup.providerVersion;
}

function providerGuidance(
  state: BundledCuaDriverProviderViewState,
  platform: ManagedPluginSetupView["platform"],
  t: SettingsTranslator,
): string {
  switch (state) {
    case "included":
      return t("Enable Cua Driver when you want Ling to control this computer.");
    case "desktop_unavailable":
      return t("Open or restart Ling Desktop, then check again.");
    case "permission_required":
      return t("Grant Accessibility and Screen Recording to Ling Stack in macOS System Settings, then check again.");
    case "interactive_session_required":
      return t("Return to an unlocked interactive Windows desktop, restart Ling if needed, then check again.");
    case "platform_unavailable":
      return platform === "win32"
        ? t("Restart or update Ling and Windows. If the problem continues, inspect the support bundle.")
        : t("Restart or update Ling and macOS. If the problem continues, inspect the support bundle.");
    case "ready":
      return t("Cua Driver is ready. Disable it when you no longer want Computer Use available.");
    case "incompatible":
      return t("Update or reinstall Ling Stack so the bundled Cua Driver matches this version.");
    case "corrupt":
      return t("Reinstall Ling Stack. Do not install a separate Cua Driver to repair this copy.");
    case "unsupported":
      return t("This Ling package does not include Cua Driver for the current platform.");
    case "external_missing":
    case "external_detected":
    case "external_connected":
      return t("Restart Ling Stack. The bundled provider reported an invalid external state.");
    case "invalid":
      return t("Restart Ling Stack. The bundled provider state is invalid.");
  }
}

function booleanStateLabel(
  value: boolean | undefined,
  t: SettingsTranslator,
  trueLabel: string,
  falseLabel: string,
): string {
  return typeof value === "boolean"
    ? t(value ? trueLabel : falseLabel)
    : t("Unknown");
}

function platformLabel(platform: ManagedPluginSetupView["platform"], t: SettingsTranslator): string {
  if (platform === "darwin") {
    return "macOS";
  }
  if (platform === "win32") {
    return "Windows";
  }
  return t("Unsupported");
}

function integrityLabel(
  integrity: NonNullable<ManagedPluginSetupView["integrity"]>,
  t: SettingsTranslator,
): string {
  if (integrity === "verified") {
    return t("Verified");
  }
  if (integrity === "failed") {
    return t("Failed");
  }
  return t("Unknown");
}

function limitationLabels(
  limitations: readonly CuaDriverLimitation[],
  t: SettingsTranslator,
): readonly string[] {
  return limitations.map((limitation) => {
    switch (limitation) {
      case "elevated_pixel_input":
        return t("Cannot send pixel input to elevated apps.");
      case "uwp_send_input":
        return t("Cannot send input to UWP apps.");
      default:
        return limitation;
    }
  });
}

function readinessValue(value: string, t: SettingsTranslator): string {
  const labels: Readonly<Record<string, string>> = {
    granted: t("Granted"),
    denied: t("Denied"),
    prompt: t("Not granted"),
    ready: t("Ready"),
    locked: t("Locked"),
    session_zero: t("Session 0"),
    supported: t("Supported"),
    unsupported: t("Unsupported"),
    available: t("Available"),
    unavailable: t("Unavailable"),
    not_required: t("Not required"),
    invalid: t("Invalid"),
    unknown: t("Unknown"),
  };
  return labels[value] ?? value;
}
