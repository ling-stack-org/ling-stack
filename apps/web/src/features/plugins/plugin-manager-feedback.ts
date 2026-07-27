import type { Translate } from "../../i18n.js";
import type {
  PluginActionFailure,
  PluginActionId,
  PluginActionOwner,
} from "./plugin-manager-types.js";

export function buildPluginActionFailure(
  pluginId: string,
  action: PluginActionId,
  owner: PluginActionOwner,
  t: Translate,
): PluginActionFailure {
  return {
    pluginId,
    action,
    owner,
    message: `${pluginActionLabel(action, t)} · ${t("failed")}`,
  };
}

export function pluginActionLabel(action: PluginActionId, t: Translate): string {
  if (action === "apply") return t("Apply preset");
  if (action === "guide") return t("Installation guide");
  if (action === "install") return t("Install");
  if (action === "check") return t("Check");
  if (action === "enable") return t("Enable");
  if (action === "disable") return t("Disable");
  if (action === "details") return t("Details");
  if (action === "runtime-preview") return t("Runtime preview");
  if (action === "refresh-package") return t("Refresh package");
  if (action === "validate") return t("Validate package");
  return t("Uninstall");
}

export function pluginSnapshotFingerprint(plugin: unknown): string {
  return JSON.stringify(plugin ?? null);
}
