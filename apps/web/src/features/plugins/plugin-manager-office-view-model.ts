import type { Translate } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";
import type {
  PluginActionView,
  PluginDetailFieldView,
  PluginPrimaryStateView,
} from "./plugin-manager-types.js";

const OFFICE_PLUGIN_ID = "built-in:office-documents";

export interface OfficePluginView {
  readonly name: string;
  readonly description: string;
  readonly trustSummary: string;
  readonly capabilityLabels: Readonly<Record<string, string>>;
  readonly primaryState: PluginPrimaryStateView;
  readonly primaryAction?: PluginActionView;
  readonly menuActions: readonly PluginActionView[];
  readonly showCheckAction: boolean;
  readonly overviewFields: readonly PluginDetailFieldView[];
  readonly failureReason?: string;
  readonly repairHint?: string;
  readonly technicalFields: readonly PluginDetailFieldView[];
}

export function buildOfficePluginView(plugin: ManagedPluginView, t: Translate): OfficePluginView | undefined {
  if (plugin.id !== OFFICE_PLUGIN_ID || plugin.setup?.kind !== "office_documents") return undefined;
  const state = plugin.setup.officeState ?? "desktop_required";
  const notInstalled = plugin.status === "available" || state === "not_installed";
  const disabled = !notInstalled && (plugin.status !== "enabled" || state === "disabled");
  const primaryState = notInstalled
    ? { id: "package-missing", label: t("Not installed"), tone: "neutral" } satisfies PluginPrimaryStateView
    : disabled
      ? { id: "disabled", label: t("Disabled"), tone: "neutral" } satisfies PluginPrimaryStateView
      : officePrimaryState(state, t);
  const primaryAction = notInstalled && plugin.actions.canEnable
    ? action("enable", t("Install"), "primary")
    : disabled && plugin.actions.canEnable
      ? action("enable", t("Enable"), "primary")
    : state === "driver_error" && plugin.actions.canCheck
      ? action("check", t("Check again"), "primary")
      : ["office_missing", "permission_required", "application_not_running"].includes(state)
        ? action("details", t("Details"), "primary")
        : undefined;
  const menuActions = !disabled && plugin.actions.canDisable
    ? [action("disable", t("Disable"), "secondary")]
    : [];
  return {
    name: t("Office Documents"),
    description: t("Create and edit XLSX, DOCX, and PPTX files locally. Live Excel control is available in Ling Desktop."),
    trustSummary: t("Office file processing and live control run locally. Content returned to the conversation follows the selected model's data path."),
    capabilityLabels: Object.fromEntries(plugin.contributions.map((contribution) => [contribution.id, t(contribution.label)])),
    primaryState,
    primaryAction,
    menuActions,
    showCheckAction: !notInstalled && !disabled && plugin.actions.canCheck && primaryAction?.id !== "check",
    overviewFields: officeOverviewFields(plugin, state, t),
    ...officeGuidance(state, t),
    technicalFields: officeTechnicalFields(plugin, t),
  };
}

function officePrimaryState(state: string, t: Translate): PluginPrimaryStateView {
  if (state === "ready") return { id: "ready", label: t("Ready"), tone: "success" };
  if (state === "limited") return { id: "ready", label: t("Ready with platform limits"), tone: "success" };
  if (state === "desktop_required") return { id: "ready", label: t("File tools ready"), tone: "success" };
  if (state === "permission_required") return { id: "permissions-required", label: t("Automation permission required"), tone: "warning" };
  if (state === "office_missing") return { id: "provider-unavailable", label: t("Excel not detected"), tone: "warning" };
  if (state === "application_not_running") return { id: "provider-unavailable", label: t("Open Excel for live control"), tone: "neutral" };
  return { id: "repair-required", label: t("Driver needs repair"), tone: "danger" };
}

function officeOverviewFields(plugin: ManagedPluginView, state: string, t: Translate): readonly PluginDetailFieldView[] {
  const liveState = state === "ready" ? t("Ready")
    : state === "limited" ? t("Ready with platform limits")
    : state === "office_missing" ? t("Excel not detected")
    : state === "permission_required" ? t("Automation permission required")
    : state === "application_not_running" ? t("Open Excel for live control")
    : state === "driver_error" ? t("Driver needs repair")
    : t("Requires Ling Desktop");
  return [
    { label: t("File tools"), value: t("Available") },
    { label: t("Live Excel"), value: liveState },
    { label: t("File processing"), value: t("Runs locally") },
  ];
}

function officeGuidance(state: string, t: Translate): Pick<OfficePluginView, "failureReason" | "repairHint"> {
  if (state === "office_missing") return {
    failureReason: t("Microsoft Excel was not detected. File tools remain available."),
    repairHint: t("Install and license Microsoft Excel separately to use live workbook control."),
  };
  if (state === "permission_required") return {
    failureReason: t("macOS has not allowed Ling to control Microsoft Excel."),
    repairHint: t("Enable Ling in System Settings > Privacy & Security > Automation."),
  };
  if (state === "application_not_running") return {
    failureReason: t("Microsoft Excel is not running. File tools remain available."),
    repairHint: t("Open Excel to work with an open workbook."),
  };
  if (state === "driver_error") return {
    failureReason: t("The native Excel driver could not start. File tools remain available."),
    repairHint: t("Restart Ling, then check again."),
  };
  return {};
}

function officeTechnicalFields(plugin: ManagedPluginView, t: Translate): readonly PluginDetailFieldView[] {
  const setup = plugin.setup;
  const fields: PluginDetailFieldView[] = [{ label: t("Plugin ID"), value: plugin.id }];
  if (setup?.officePlatform) fields.push({ label: t("Platform"), value: setup.officePlatform === "darwin" ? "macOS" : "Windows" });
  if (typeof setup?.officeInstalled === "boolean") fields.push({ label: t("Excel installed"), value: setup.officeInstalled ? t("Yes") : t("No") });
  if (typeof setup?.officeApplicationRunning === "boolean") fields.push({ label: t("Excel running"), value: setup.officeApplicationRunning ? t("Yes") : t("No") });
  if (typeof setup?.officePermissionGranted === "boolean") fields.push({ label: t("Automation permission"), value: setup.officePermissionGranted ? t("Granted") : t("Not granted") });
  if (setup?.officeHelperVersion) fields.push({ label: t("Native helper"), value: setup.officeHelperVersion });
  if (setup?.officeCapabilities?.length) fields.push({ label: t("Live capabilities"), value: setup.officeCapabilities.join(" · ") });
  return fields;
}

function action(id: PluginActionView["id"], label: string, tone: PluginActionView["tone"]): PluginActionView {
  return { id, label, tone };
}
