import type { Translate } from "../../i18n.js";

export interface PluginManagerCopy {
  readonly searchPlugins: string;
  readonly sourceFilter: string;
  readonly statusFilter: string;
  readonly noResults: string;
  readonly trustAndPermissions: string;
  readonly uninstallTitle: (name: string) => string;
  readonly uninstallConsequence: string;
  readonly uninstallRetained: string;
  readonly runtimeReady: string;
  readonly runtimeBlocked: string;
  readonly runtimeDisabled: string;
  readonly skillPacks: string;
  readonly apps: string;
  readonly hooks: string;
  readonly policyRules: (count: number) => string;
}

export function buildPluginManagerCopy(t: Translate): PluginManagerCopy {
  return {
    searchPlugins: t("Search plugins"),
    sourceFilter: t("Source filter"),
    statusFilter: t("Status filter"),
    noResults: t("No plugins match the current filters"),
    trustAndPermissions: t("Trust and permissions"),
    uninstallTitle: (name) => t("Uninstall {name}?", { name }),
    uninstallConsequence: t("This removes the installed package and disables its linked capabilities."),
    uninstallRetained: t("Plugin history and past run evidence are kept."),
    runtimeReady: t("Ready for new runs"),
    runtimeBlocked: t("Not ready for new runs"),
    runtimeDisabled: t("Enable this plugin before it can be used in new runs"),
    skillPacks: t("Skill packs"),
    apps: t("Apps"),
    hooks: t("Hooks"),
    policyRules: (count) => t("{count} policy rules", { count }),
  };
}
