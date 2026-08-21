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
      menuActions: [],
      showCheckAction: true,
      showDisableAction: true,
    };
  }
  if (setup?.browserState === "incompatible") {
    return {
      description: t("Control Chrome with Ling."),
      primaryState: { id: "failed", label: t("Needs attention"), tone: "danger" },
      primaryAction: action("connect-chrome", t("Update Chrome connection")),
      menuActions: [],
      showCheckAction: false,
      showDisableAction: true,
    };
  }
  if (setup?.browserState === "host_missing") {
    return {
      description: t("Control Chrome with Ling."),
      primaryState: { id: "setup-missing", label: t("Connection component missing"), tone: "warning" },
      primaryAction: action("repair-chrome-host", t("Repair connection")),
      menuActions: [],
      showCheckAction: false,
      showDisableAction: true,
    };
  }
  if (setup?.browserState === "paused") {
    return {
      description: t("Control Chrome with Ling."),
      primaryState: { id: "stale", label: t("Paused"), tone: "neutral" },
      primaryAction: action("connect-chrome", t("Resume in Chrome")),
      menuActions: [],
      showCheckAction: false,
      showDisableAction: true,
    };
  }
  const waiting = Boolean(setup?.browserState === "waiting_for_chrome" && setup.paired);
  return {
    description: t("Control Chrome with Ling."),
    primaryState: waiting
      ? { id: "connecting", label: t("Waiting for Chrome"), tone: "info" }
      : { id: "setup-missing", label: t("Extension required"), tone: "warning" },
    primaryAction: action("connect-chrome", waiting ? t("Open Ling for Chrome") : t("Open Chrome Web Store")),
    menuActions: [],
    showCheckAction: false,
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
