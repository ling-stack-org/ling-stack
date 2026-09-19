import { useMemo } from "react";
import { useI18n } from "../../i18n.js";
import { PLUGIN_DRAFT_ID } from "../../domains/plugins/use-plugins-domain.js";
import { CuaDriverInstallDrawer } from "./CuaDriverInstallDrawer.js";
import { PluginCreateDialog } from "./PluginCreateDialog.js";
import { PluginDetailDrawer } from "./PluginDetailDrawer.js";
import { PluginManagerHeader } from "./PluginManagerHeader.js";
import { PluginManagerTable } from "./PluginManagerTable.js";
import { buildPluginManagerCopy } from "./plugin-manager-copy.js";
import type { PluginActionHandlers, PluginManagerPageProps } from "./plugin-manager-types.js";
import { PluginUninstallDialog } from "./PluginUninstallDialog.js";
import { usePluginManagerController } from "./usePluginManagerController.js";
import { ChromeBrowserConnectDrawer } from "./ChromeBrowserConnectDrawer.js";

export type { PluginManagerPageProps } from "./plugin-manager-types.js";

export function PluginManagerPage(props: PluginManagerPageProps): React.JSX.Element {
  const { t } = useI18n();
  const copy = useMemo(() => buildPluginManagerCopy(t), [t]);
  const controller = usePluginManagerController({
    plugins: props.plugins,
    isLoading: props.isLoading,
    loadError: props.loadError,
    pendingActions: props.pendingActions,
    actionErrors: props.actionErrors,
    clearActionErrors: props.onClearActionErrors,
    t,
  });
  const buildHandlers = (owner: "row" | "detail"): PluginActionHandlers => ({
    onApplyPreset: (pluginId) => controller.runMutation({
      pluginId,
      action: "apply",
      owner,
      mutate: (request) => props.onApplyPreset(pluginId, request),
    }),
    onOpenInstallGuide: controller.openGuide,
    onOpenDetails: controller.openDetails,
    onCheck: (pluginId) => controller.runMutation({
      pluginId,
      action: "check",
      owner,
      mutate: (request) => props.onCheck(pluginId, request),
    }),
    onValidatePackage: (pluginId) => void controller.runMutation({
      pluginId,
      action: "validate",
      owner,
      mutate: (request) => props.onValidatePackage(pluginId, request),
    }),
    onInstall: (pluginId) => controller.runMutation({
      pluginId,
      action: "install",
      owner,
      mutate: (request) => props.onInstall(pluginId, request),
    }),
    onRequestUninstall: controller.requestUninstall,
    onRefreshPackage: (pluginId) => controller.runMutation({
      pluginId,
      action: "refresh-package",
      owner,
      mutate: (request) => props.onRefreshPackage(pluginId, request),
    }),
    onRuntimePreview: (pluginId) => controller.runMutation({
      pluginId,
      action: "runtime-preview",
      owner,
      mutate: (request) => props.onRuntimePreview(pluginId, request),
    }),
    onEnable: (pluginId) => controller.runMutation({
      pluginId,
      action: "enable",
      owner,
      mutate: (request) => props.onEnable(pluginId, request),
    }),
    onDisable: (pluginId) => controller.runMutation({
      pluginId,
      action: "disable",
      owner,
      mutate: (request) => props.onDisable(pluginId, request),
    }),
    onOpenChromeConnect: controller.openChromeConnect,
    onRepairChromeHost: (pluginId) => void controller.runMutation({
      pluginId,
      action: "repair-chrome-host",
      owner,
      mutate: (request) => props.onRepairChromeHost(pluginId, request),
    }),
    onRevokeChrome: (pluginId) => void controller.runMutation({
      pluginId,
      action: "revoke",
      owner,
      mutate: (request) => props.onRevokeChrome(pluginId, request),
    }),
  });
  const rowHandlers = buildHandlers("row");
  const detailHandlers = buildHandlers("detail");
  const detailPlugin = props.plugins.find((plugin) => plugin.id === controller.detailPluginId);
  const detailRow = controller.rows.find((row) => row.id === controller.detailPluginId);
  const guidePlugin = props.plugins.find((plugin) => plugin.id === controller.guidePluginId);
  const uninstallPlugin = props.plugins.find((plugin) => plugin.id === controller.uninstallPluginId);
  const chromeConnectPlugin = props.plugins.find((plugin) => plugin.id === controller.chromeConnectPluginId);
  const detailPending = detailPlugin ? controller.pendingActionFor(detailPlugin.id, "detail") : undefined;
  const guidePending = guidePlugin ? controller.pendingActionFor(guidePlugin.id, "guide", "connect") : undefined;
  const uninstallPending = uninstallPlugin
    ? controller.pendingActionFor(uninstallPlugin.id, "uninstall", "uninstall")
    : undefined;
  const chromeConnectPending = chromeConnectPlugin
    ? controller.pendingActionFor(chromeConnectPlugin.id, "chrome-connect")
    : undefined;

  return (
    <div className="plugin-manager-page">
      <section
        className="settings-plugin-manager"
        aria-labelledby="plugin-manager-title"
        data-retained-refresh={controller.retainedRefreshError ? "true" : undefined}
      >
        <PluginManagerHeader
          busyCreating={Boolean(controller.pendingActionFor(PLUGIN_DRAFT_ID, "create", "create"))}
          controller={controller}
          copy={copy}
          isLoading={props.isLoading}
          onRefresh={props.onRefresh}
          t={t}
        />
        <PluginManagerTable
          allRows={controller.rows}
          copy={copy}
          handlers={rowHandlers}
          hasActiveFilters={controller.hasActiveFilters}
          isLoading={props.isLoading}
          onAdd={controller.openCreate}
          onClearFilters={controller.clearFilters}
          rows={controller.visibleRows}
          t={t}
        />
      </section>
      <PluginDetailDrawer
        busyAction={detailPending?.action}
        busyPluginId={detailPending?.pluginId ?? ""}
        copy={copy}
        actionFailure={detailPlugin ? controller.actionFailureFor(detailPlugin.id, "detail") : undefined}
        handlers={detailHandlers}
        onClose={controller.closeDetails}
        onOpenMcpSettings={props.onOpenMcpSettings}
        plugin={detailPlugin}
        row={detailRow}
      />
      <PluginCreateDialog
        actionFailure={controller.actionFailureFor(PLUGIN_DRAFT_ID, "create", "create")}
        busy={Boolean(controller.pendingActionFor(PLUGIN_DRAFT_ID, "create", "create"))}
        onClose={controller.closeCreate}
        onCreate={(createInput) => controller.runMutation({
          pluginId: PLUGIN_DRAFT_ID,
          action: "create",
          owner: "create",
          mutate: (request) => props.onCreate(createInput, request),
        })}
        onDismissFailure={() => props.onClearActionErrors({
          pluginId: PLUGIN_DRAFT_ID,
          action: "create",
          owner: "create",
        })}
        open={controller.createOpen}
      />
      <CuaDriverInstallDrawer
        actionFailure={guidePlugin ? controller.actionFailureFor(guidePlugin.id, "guide", "connect") : undefined}
        busy={Boolean(guidePending)}
        onClose={controller.closeGuide}
        onConnect={(pluginId, command) => controller.runMutation({
          pluginId,
          action: "connect",
          owner: "guide",
          mutate: (request) => props.onConnect(pluginId, request, command),
        })}
        onDismissFailure={(pluginId) => props.onClearActionErrors({ pluginId, action: "connect", owner: "guide" })}
        open={Boolean(controller.guidePluginId)}
        plugin={guidePlugin}
      />
      <PluginUninstallDialog
        actionFailure={uninstallPlugin ? controller.actionFailureFor(uninstallPlugin.id, "uninstall", "uninstall") : undefined}
        busy={Boolean(uninstallPending)}
        copy={copy}
        onCancel={controller.cancelUninstall}
        onComplete={controller.completeUninstall}
        onUninstall={(pluginId) => void controller.runMutation({
          pluginId,
          action: "uninstall",
          owner: "uninstall",
          mutate: (request) => props.onUninstall(pluginId, request),
        })}
        plugin={uninstallPlugin}
      />
      <ChromeBrowserConnectDrawer
        actionFailure={chromeConnectPlugin ? controller.actionFailureFor(chromeConnectPlugin.id, "chrome-connect") : undefined}
        busy={Boolean(chromeConnectPending)}
        onClose={controller.closeChromeConnect}
        onRepairHost={(pluginId) => controller.runMutation({
          pluginId,
          action: "repair-chrome-host",
          owner: "chrome-connect",
          mutate: (request) => props.onRepairChromeHost(pluginId, request),
        })}
        open={Boolean(controller.chromeConnectPluginId)}
        plugin={chromeConnectPlugin}
      />
    </div>
  );
}
