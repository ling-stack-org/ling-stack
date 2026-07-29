import { isCuaDriverProviderState, type CuaDriverProviderState } from "@ling-stack/contracts";
import type { Translate } from "../../i18n.js";
import type { ManagedPluginSetupView, ManagedPluginView } from "../../types.js";
import type {
  PluginActionView,
  PluginDetailFieldView,
  PluginPrimaryStateView,
} from "./plugin-manager-types.js";

type BundledProviderState = CuaDriverProviderState | "invalid";
const BUNDLED_PROVIDER_STATES = new Set<CuaDriverProviderState>([
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

export interface BundledCuaDriverView {
  readonly description: string;
  readonly primaryState: PluginPrimaryStateView;
  readonly primaryAction?: PluginActionView;
  readonly checkActionLabel: string;
  readonly showCheckAction: boolean;
  readonly showDisableAction: boolean;
  readonly sourceVersion: string;
  readonly overviewFields: readonly PluginDetailFieldView[];
  readonly technicalFields: readonly PluginDetailFieldView[];
  readonly failureReason?: string;
  readonly repairHint?: string;
}

export function isBundledCuaDriver(plugin: ManagedPluginView): boolean {
  return plugin.id === "trusted-local:cua-driver"
    && plugin.setup?.schemaVersion === 2
    && plugin.setup.distribution === "bundled_embedded";
}

export function buildBundledCuaDriverView(
  plugin: ManagedPluginView,
  t: Translate,
): BundledCuaDriverView | undefined {
  if (!isBundledCuaDriver(plugin) || !plugin.setup) {
    return undefined;
  }
  const setup = plugin.setup;
  const state = normalizedProviderState(setup);
  const primaryState = providerStatus(state, t);
  const guidanceAction = guidanceActionFor(state, t);
  const primaryAction = plugin.actions.canEnable && state === "included"
    ? action("enable", t("Enable"))
    : guidanceAction
      ? action("details", guidanceAction)
      : undefined;
  const guidance = providerGuidance(state, setup.platform, t);
  const needsGuidance = !["included", "ready"].includes(state);
  return {
    description: t("Controls macOS and Windows apps through the Cua Driver included with Ling."),
    primaryState,
    primaryAction,
    checkActionLabel: t("Check again"),
    showCheckAction: plugin.actions.canCheck && state !== "included" && state !== "unsupported",
    showDisableAction: plugin.actions.canDisable,
    sourceVersion: `${t("Included with Ling")} · ${plugin.version}`,
    overviewFields: buildOverviewFields(setup, state, guidance, t),
    technicalFields: buildTechnicalFields(plugin, setup, state, t),
    failureReason: needsGuidance ? primaryState.label : undefined,
    repairHint: needsGuidance ? guidance : undefined,
  };
}

function normalizedProviderState(setup: ManagedPluginSetupView): BundledProviderState {
  return isCuaDriverProviderState(setup.providerState)
    && BUNDLED_PROVIDER_STATES.has(setup.providerState)
    && typeof setup.requestedEnabled === "boolean"
    && typeof setup.effectiveEnabled === "boolean"
    ? setup.providerState
    : "invalid";
}

function providerStatus(state: BundledProviderState, t: Translate): PluginPrimaryStateView {
  if (state === "included") return primaryState("included", t("Included"), "neutral");
  if (state === "desktop_unavailable") return primaryState("desktop-required", t("Desktop required"), "warning");
  if (state === "permission_required") return primaryState("permissions-required", t("Permissions required"), "warning");
  if (state === "interactive_session_required") {
    return primaryState("interactive-session-required", t("Interactive session required"), "warning");
  }
  if (state === "platform_unavailable") return primaryState("platform-blocked", t("Platform unavailable"), "danger");
  if (state === "ready") return primaryState("ready", t("Ready"), "success");
  if (state === "incompatible") return primaryState("provider-incompatible", t("Update required"), "danger");
  if (state === "corrupt") return primaryState("repair-required", t("Repair required"), "danger");
  if (state === "unsupported") return primaryState("platform-blocked", t("Unavailable"), "warning");
  return primaryState("failed", t("Needs attention"), "danger");
}

function guidanceActionFor(state: BundledProviderState, t: Translate): string | undefined {
  if (state === "permission_required") return t("Review macOS permissions");
  if (state === "desktop_unavailable" || state === "interactive_session_required") return t("Recovery steps");
  if (state === "platform_unavailable" || state === "incompatible" || state === "corrupt") return t("Repair steps");
  if (state === "invalid") {
    return t("Review state");
  }
  return undefined;
}

function providerGuidance(
  state: BundledProviderState,
  platform: ManagedPluginSetupView["platform"],
  t: Translate,
): string {
  if (state === "included") return t("Enable Cua Driver when you want Ling to control this computer.");
  if (state === "desktop_unavailable") return t("Open or restart Ling Desktop, then check again.");
  if (state === "permission_required") {
    return t("Grant Accessibility and Screen Recording to Ling Stack in macOS System Settings, then check again.");
  }
  if (state === "interactive_session_required") {
    return t("Return to an unlocked interactive Windows desktop, restart Ling if needed, then check again.");
  }
  if (state === "platform_unavailable") {
    return platform === "win32"
      ? t("Restart or update Ling and Windows. If the problem continues, inspect the support bundle.")
      : t("Restart or update Ling and macOS. If the problem continues, inspect the support bundle.");
  }
  if (state === "ready") return t("Cua Driver is ready. Disable it when you no longer want Computer Use available.");
  if (state === "incompatible") return t("Update or reinstall Ling Stack so the bundled Cua Driver matches this version.");
  if (state === "corrupt") return t("Reinstall Ling Stack. Do not install a separate Cua Driver to repair this copy.");
  if (state === "unsupported") return t("This Ling package does not include Cua Driver for the current platform.");
  return t("Restart Ling Stack. The bundled provider state is invalid.");
}

function buildOverviewFields(
  setup: ManagedPluginSetupView,
  state: BundledProviderState,
  guidance: string,
  t: Translate,
): readonly PluginDetailFieldView[] {
  const fields: PluginDetailFieldView[] = [
    { label: t("Source"), value: t("Included with Ling") },
  ];
  const providerVersion = providerVersionLabel(setup);
  if (providerVersion) fields.push({ label: t("Provider version"), value: providerVersion });
  fields.push(
    { label: t("Platform"), value: platformLabel(setup.platform, t) },
    { label: t("Requested"), value: booleanLabel(setup.requestedEnabled, t, "Enabled status", "Disabled") },
    { label: t("Effective readiness"), value: booleanLabel(setup.effectiveEnabled, t, "Ready", "Not ready") },
  );
  if (state !== "ready") fields.push({ label: t("Next step"), value: guidance });
  if (setup.integrity) fields.push({ label: t("Integrity"), value: integrityLabel(setup.integrity, t) });
  if (setup.integrityCoverage) {
    fields.push({
      label: t("Integrity coverage"),
      value: setup.integrityCoverage === "standard" ? t("Standard user apps") : "UIAccess",
    });
  }
  const limitations = (setup.limitations ?? []).map((limitation) => (
    limitation === "elevated_pixel_input"
      ? t("Cannot send pixel input to elevated apps.")
      : t("Cannot send input to UWP apps.")
  ));
  if (limitations.length) fields.push({ label: t("Limitations"), value: limitations.join(" · ") });
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
  return fields;
}

function buildTechnicalFields(
  plugin: ManagedPluginView,
  setup: ManagedPluginSetupView,
  state: BundledProviderState,
  t: Translate,
): readonly PluginDetailFieldView[] {
  const fields: PluginDetailFieldView[] = [
    { label: t("Plugin ID"), value: plugin.id },
    { label: t("Version"), value: plugin.version },
    { label: t("Provider state"), value: state },
  ];
  if (setup.checkedAt) fields.push({ label: t("Last checked"), value: setup.checkedAt });
  if (setup.providerDistributionRevision) {
    fields.push({ label: t("Distribution revision"), value: setup.providerDistributionRevision });
  }
  if (setup.externalOverride?.command) {
    fields.push({ label: t("External override"), value: setup.externalOverride.command });
  }
  return fields;
}

function providerVersionLabel(setup: ManagedPluginSetupView): string | undefined {
  if (setup.providerDisplayVersion) return setup.providerDisplayVersion;
  if (!setup.providerVersion) return undefined;
  const revision = /^ling\.(\d+)$/i.exec(setup.providerDistributionRevision ?? "");
  return revision ? `${setup.providerVersion} (Ling build ${revision[1]})` : setup.providerVersion;
}

function readinessValue(value: string, t: Translate): string {
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
  return labels[value] ?? t("Unknown");
}

function booleanLabel(
  value: boolean | undefined,
  t: Translate,
  yes: string,
  no: string,
): string {
  return typeof value === "boolean" ? t(value ? yes : no) : t("Unknown");
}

function platformLabel(platform: ManagedPluginSetupView["platform"], t: Translate): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return t("Unsupported");
}

function integrityLabel(value: NonNullable<ManagedPluginSetupView["integrity"]>, t: Translate): string {
  if (value === "verified") return t("Verified");
  if (value === "failed") return t("Failed");
  return t("Unknown");
}

function primaryState(
  id: PluginPrimaryStateView["id"],
  label: string,
  tone: PluginPrimaryStateView["tone"],
): PluginPrimaryStateView {
  return { id, label, tone };
}

function action(id: "enable" | "details", label: string): PluginActionView {
  return { id, label, tone: "primary" };
}
