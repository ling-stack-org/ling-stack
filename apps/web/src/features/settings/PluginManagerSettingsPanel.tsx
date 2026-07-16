import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../i18n.js";
import type { ManagedPluginCreateRequest, ManagedPluginView } from "../../types.js";
import type { PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { CuaDriverInstallDrawer } from "../plugins/CuaDriverInstallDrawer.js";
import { PluginDetailDrawer } from "../plugins/PluginDetailDrawer.js";
import { type PluginActionHandlers } from "../plugins/PluginActionButton.js";
import { PluginManagerTable } from "../plugins/PluginManagerTable.js";
import { PluginCreateDrawer } from "../plugins/PluginCreateDrawer.js";

export function PluginManagerSettingsPanel({
  plugins,
  isLoading,
  busyPluginId,
  busyAction,
  onRefresh,
  onCreate,
  onApplyPreset,
  onConnect,
  onCheck,
  onValidatePackage,
  onInstall,
  onUninstall,
  onRefreshPackage,
  onRuntimePreview,
  onEnable,
  onDisable,
  onOpenMcpSettings,
}: {
  readonly plugins: readonly ManagedPluginView[];
  readonly isLoading: boolean;
  readonly busyPluginId: string;
  readonly busyAction: PluginBusyAction | undefined;
  readonly onRefresh: () => void;
  readonly onCreate: (input: ManagedPluginCreateRequest) => Promise<ManagedPluginView | undefined>;
  readonly onApplyPreset: (pluginId: string) => void;
  readonly onConnect: (pluginId: string, command?: string) => Promise<ManagedPluginView | undefined>;
  readonly onCheck: (pluginId: string) => void;
  readonly onValidatePackage: (pluginId: string) => void;
  readonly onInstall: (pluginId: string) => void;
  readonly onUninstall: (pluginId: string) => void;
  readonly onRefreshPackage: (pluginId: string) => void;
  readonly onRuntimePreview: (pluginId: string) => void;
  readonly onEnable: (pluginId: string) => void;
  readonly onDisable: (pluginId: string) => void;
  readonly onOpenMcpSettings: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [installGuidePluginId, setInstallGuidePluginId] = useState("");
  const [detailPluginId, setDetailPluginId] = useState("");
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const handlers: PluginActionHandlers = {
    onApplyPreset,
    onOpenInstallGuide: (pluginId) => {
      setDetailPluginId("");
      setInstallGuidePluginId(pluginId);
    },
    onOpenDetails: (pluginId) => {
      setInstallGuidePluginId("");
      setDetailPluginId(pluginId);
    },
    onCheck,
    onValidatePackage,
    onInstall,
    onUninstall,
    onRefreshPackage,
    onRuntimePreview,
    onEnable,
    onDisable,
  };

  return (
    <section className="settings-plugin-manager" aria-labelledby="settings-plugin-manager-title">
      <header className="settings-plugin-manager-head">
        <h2 id="settings-plugin-manager-title">{t("Plugin Manager")}</h2>
        <div className="settings-plugin-manager-actions">
          <button className="icon-button" type="button" onClick={onRefresh} disabled={isLoading} aria-label={t("Refresh")}>
            <RefreshCw size={15} className={isLoading ? "spin" : undefined} />
          </button>
          <button className="primary-button compact-button plugin-add-button" type="button" onClick={() => setCreateDrawerOpen(true)} disabled={busyAction === "create"}>
            <Plus size={15} />
            {t("Add plugin")}
          </button>
        </div>
      </header>

      <PluginManagerTable
        plugins={plugins}
        isLoading={isLoading}
        busyPluginId={busyPluginId}
        busyAction={busyAction}
        handlers={handlers}
      />

      <PluginDetailDrawer
        plugin={plugins.find((plugin) => plugin.id === detailPluginId)}
        busyPluginId={busyPluginId}
        busyAction={busyAction}
        handlers={handlers}
        onOpenMcpSettings={onOpenMcpSettings}
        onClose={() => setDetailPluginId("")}
      />

      <PluginCreateDrawer
        open={createDrawerOpen}
        busy={busyAction === "create"}
        onCreate={onCreate}
        onClose={() => setCreateDrawerOpen(false)}
      />

      <CuaDriverInstallDrawer
        open={Boolean(installGuidePluginId)}
        plugin={plugins.find((plugin) => plugin.id === installGuidePluginId)}
        busy={busyPluginId === installGuidePluginId && busyAction === "connect"}
        onConnect={onConnect}
        onClose={() => setInstallGuidePluginId("")}
      />
    </section>
  );
}
