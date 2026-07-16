import { useEffect } from "react";
import { ExternalLink, Plug, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";
import type { PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { buildPluginTableRowView } from "../settings/plugin-manager-view-models.js";
import { PluginActionButton, type PluginActionHandlers } from "./PluginActionButton.js";

export function PluginDetailDrawer({
  plugin,
  busyPluginId,
  busyAction,
  handlers,
  onOpenMcpSettings,
  onClose,
}: {
  readonly plugin?: ManagedPluginView;
  readonly busyPluginId: string;
  readonly busyAction: PluginBusyAction | undefined;
  readonly handlers: PluginActionHandlers;
  readonly onOpenMcpSettings: () => void;
  readonly onClose: () => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const pluginId = plugin?.id;
  useEffect(() => {
    if (!pluginId) {
      return undefined;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && busyPluginId !== pluginId) {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busyPluginId, onClose, pluginId]);

  if (!plugin) {
    return null;
  }
  const view = buildPluginTableRowView(plugin, t);
  const busy = busyPluginId === plugin.id && busyAction !== undefined;

  return (
    <div className="plugin-detail-drawer" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) {
        onClose();
      }
    }}>
      <aside className="plugin-detail-panel" role="dialog" aria-modal="true" aria-labelledby="plugin-detail-title">
        <header className="plugin-detail-head">
          <div className="plugin-detail-title">
            <Plug size={17} />
            <div>
              <h2 id="plugin-detail-title">{plugin.displayName}</h2>
              <span className={`plugin-table-status ${view.statusTone}`}>
                <span className="plugin-table-status-dot" aria-hidden="true" />
                <span>{view.statusLabel}</span>
              </span>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label={t("Close")}>
            <X size={16} />
          </button>
        </header>

        <div className="plugin-detail-body">
          {view.failureReason ? (
            <div className="plugin-detail-failure" role="alert">
              <strong>{t("Failure reason")}</strong>
              <span>{view.failureReason}</span>
            </div>
          ) : null}

          <dl className="plugin-detail-fields">
            {view.detailFields.map((field) => (
              <div key={field.label}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>

          {view.hasLinkedMcp ? (
            <button className="secondary-button compact-button plugin-detail-mcp-link" type="button" onClick={() => {
              onClose();
              onOpenMcpSettings();
            }}>
              <ExternalLink size={14} />
              {t("Open MCP connection")}
            </button>
          ) : null}
        </div>

        {view.drawerActions.length > 0 ? (
          <footer className="plugin-detail-footer">
            {view.drawerActions.map((action) => (
              <PluginActionButton
                key={action.id}
                action={action}
                pluginId={plugin.id}
                busyPluginId={busyPluginId}
                busyAction={busyAction}
                handlers={handlers}
                presentation="drawer"
              />
            ))}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}
