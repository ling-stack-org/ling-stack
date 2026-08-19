import { CHROME_BROWSER_PLUGIN_ID } from "@ling-stack/contracts";
import type { Translate } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";
import type { PluginActionView, PluginPrimaryStateView } from "./plugin-manager-types.js";

export interface ChromePluginViewModel {
  readonly description: string;
  readonly primaryState: PluginPrimaryStateView;
  readonly primaryAction?: PluginActionView;
  readonly menuActions: readonly PluginActionView[];
  readonly showCheckAction: boolean;
  readonly showDisableAction: boolean;
}

export function buildChromePluginView(plugin: ManagedPluginView, t: Translate): ChromePluginViewModel | undefined {
  if (plugin.id !== CHROME_BROWSER_PLUGIN_ID) return undefined;
  const enabled = plugin.status === "enabled";
  const setup = plugin.setup;
  if (!enabled) {
    return {
      description: t("Control Chrome with Ling."),
      primaryState: { id: "disabled", label: t("Disabled"), tone: "neutral" },
      primaryAction: plugin.actions.canEnable ? action("enable", t("Enable")) : undefined,
      menuActions: [],
      showCheckAction: false,
      showDisableAction: false,
    };
  }
  if (setup?.browserState === "ready" && setup.connected) {
    return {
      description: t("Control Chrome with Ling."),
      primaryState: { id: "ready", label: t("Connected"), tone: "success" },
      menuActions: setup.paired ? [action("revoke-chrome", t("Remove Chrome access"), "danger")] : [],
      showCheckAction: true,
      showDisableAction: true,
    };
  }
  if (setup?.browserState === "incompatible") {
    return {
      description: t("Control Chrome with Ling."),
      primaryState: { id: "failed", label: t("Needs attention"), tone: "danger" },
      primaryAction: action("connect-chrome", t("Connect Chrome")),
      menuActions: setup.paired ? [action("revoke-chrome", t("Remove Chrome access"), "danger")] : [],
      showCheckAction: true,
      showDisableAction: true,
    };
  }
  const waiting = Boolean(setup?.browserState === "waiting_for_chrome" && setup.paired);
  return {
    description: t("Control Chrome with Ling."),
    primaryState: waiting
      ? { id: "connecting", label: t("Waiting for Chrome"), tone: "info" }
      : { id: "setup-missing", label: t("Extension required"), tone: "warning" },
    primaryAction: action("connect-chrome", t("Connect Chrome")),
    menuActions: setup?.paired ? [action("revoke-chrome", t("Remove Chrome access"), "danger")] : [],
    showCheckAction: waiting,
    showDisableAction: true,
  };
}

function action(
  id: PluginActionView["id"],
  label: string,
  tone: PluginActionView["tone"] = "primary",
): PluginActionView {
  return { id, label, tone };
}
