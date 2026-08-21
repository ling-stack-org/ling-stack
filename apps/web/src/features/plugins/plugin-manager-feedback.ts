import type { Translate } from "../../i18n.js";
import type { PluginActionError, PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import type {
  PluginActionFailure,
  PluginActionId,
} from "./plugin-manager-types.js";

export function buildPluginActionFailure(
  error: PluginActionError,
  t: Translate,
): PluginActionFailure {
  return {
    pluginId: error.pluginId,
    action: error.action,
    owner: error.owner,
    message: `${pluginActionLabel(error.action, t)} · ${t("failed")}`,
    detail: error.message,
    retryAction: pluginRetryAction(error.action),
  };
}

function pluginRetryAction(action: PluginBusyAction): PluginActionId | undefined {
  if (action === "create" || action === "connect") return undefined;
  if (action === "repair-chrome-host") return "repair-chrome-host";
  if (action === "revoke") return "revoke-chrome";
  return action;
}

export function pluginActionLabel(action: PluginBusyAction, t: Translate): string {
  if (action === "create") return t("Add plugin");
  if (action === "apply") return t("Apply preset");
  if (action === "connect") return t("Recheck");
  if (action === "repair-chrome-host") return t("Repair connection");
  if (action === "revoke") return t("Remove Chrome access");
  if (action === "install") return t("Install");
  if (action === "check") return t("Check");
  if (action === "enable") return t("Enable");
  if (action === "disable") return t("Disable");
  if (action === "runtime-preview") return t("Runtime preview");
  if (action === "refresh-package") return t("Refresh package");
  if (action === "validate") return t("Validate package");
  return t("Uninstall");
}
