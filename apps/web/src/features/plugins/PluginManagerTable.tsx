import { Loader2, Plug } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";
import type { PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { buildPluginTableRowView } from "../settings/plugin-manager-view-models.js";
import { PluginActionButton, type PluginActionHandlers } from "./PluginActionButton.js";

export function PluginManagerTable({
  plugins,
  isLoading,
  busyPluginId,
  busyAction,
  handlers,
}: {
  readonly plugins: readonly ManagedPluginView[];
  readonly isLoading: boolean;
  readonly busyPluginId: string;
  readonly busyAction: PluginBusyAction | undefined;
  readonly handlers: PluginActionHandlers;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="plugin-table" role="table" aria-label={t("Plugins")}>
      <div className="plugin-table-header" role="row">
        <span role="columnheader">{t("Plugin")}</span>
        <span role="columnheader">{t("Status")}</span>
        <span role="columnheader">{t("Actions")}</span>
      </div>
      <div className="plugin-table-body">
        {plugins.length === 0 ? (
          <div className="empty-state compact-empty plugin-table-empty">
            {isLoading ? <Loader2 className="spin" /> : <Plug />}
            <span>{isLoading ? t("Loading plugins...") : t("No managed plugins registered")}</span>
          </div>
        ) : plugins.map((plugin) => {
          const view = buildPluginTableRowView(plugin, t);
          return (
            <div className="plugin-table-row" role="row" key={plugin.id} data-plugin-id={plugin.id}>
              <div className="plugin-table-name" role="cell">
                <Plug size={16} />
                <div className="plugin-table-name-copy">
                  <strong title={plugin.displayName}>{plugin.displayName}</strong>
                  {view.description ? <small title={view.description}>{view.description}</small> : null}
                </div>
              </div>
              <div className={`plugin-table-status ${view.statusTone}`} role="cell">
                <span className="plugin-table-status-dot" aria-hidden="true" />
                <span>{view.statusLabel}</span>
              </div>
              <div className="plugin-table-actions" role="cell">
                {view.rowActions.map((action) => (
                  <PluginActionButton
                    key={action.id}
                    action={action}
                    pluginId={plugin.id}
                    busyPluginId={busyPluginId}
                    busyAction={busyAction}
                    handlers={handlers}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
