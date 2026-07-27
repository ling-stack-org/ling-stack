import { useMemo } from "react";
import { useI18n } from "../../i18n.js";
import { CuaDriverInstallDrawer } from "./CuaDriverInstallDrawer.js";
import { PluginCreateDialog } from "./PluginCreateDialog.js";
import { PluginDetailDrawer } from "./PluginDetailDrawer.js";
import { PluginManagerHeader } from "./PluginManagerHeader.js";
import { PluginManagerTable } from "./PluginManagerTable.js";
import { buildPluginManagerCopy } from "./plugin-manager-copy.js";
import type { PluginActionHandlers, PluginManagerPageProps } from "./plugin-manager-types.js";
import { PluginUninstallDialog } from "./PluginUninstallDialog.js";
import { usePluginManagerController } from "./usePluginManagerController.js";

export type { PluginManagerPageProps } from "./plugin-manager-types.js";

export function PluginManagerPage(props: PluginManagerPageProps): JSX.Element {
  const { t } = useI18n();
  const copy = useMemo(() => buildPluginManagerCopy(t), [t]);
  const controller = usePluginManagerController({
    plugins: props.plugins,
    isLoading: props.isLoading,
    busyPluginId: props.busyPluginId,
    busyAction: props.busyAction,
    t,
  });
  const buildHandlers = (owner: "row" | "detail"): PluginActionHandlers => ({
    onApplyPreset: (pluginId) => controller.runMutation({
      pluginId,
      action: "apply",
      owner,
      mutate: () => props.onApplyPreset(pluginId),
    }),
    onOpenInstallGuide: controller.openGuide,
    onOpenDetails: controller.openDetails,
    onCheck: (pluginId) => controller.runMutation({
      pluginId,
      action: "check",
      owner,
      mutate: () => props.onCheck(pluginId),
    }),
    onValidatePackage: props.onValidatePackage,
    onInstall: (pluginId) => controller.runMutation({
      pluginId,
      action: "install",
      owner,
      mutate: () => props.onInstall(pluginId),
    }),
    onRequestUninstall: controller.requestUninstall,
    onRefreshPackage: (pluginId) => controller.runMutation({
      pluginId,
      action: "refresh-package",
      owner,
      mutate: () => props.onRefreshPackage(pluginId),
    }),
    onRuntimePreview: (pluginId) => controller.runMutation({
      pluginId,
      action: "runtime-preview",
      owner,
      mutate: () => props.onRuntimePreview(pluginId),
    }),
    onEnable: (pluginId) => controller.runMutation({
      pluginId,
      action: "enable",
      owner,
      mutate: () => props.onEnable(pluginId),
    }),
    onDisable: (pluginId) => controller.runMutation({
      pluginId,
      action: "disable",
      owner,
      mutate: () => props.onDisable(pluginId),
    }),
  });
  const rowHandlers = buildHandlers("row");
  const detailHandlers = buildHandlers("detail");
  const detailPlugin = props.plugins.find((plugin) => plugin.id === controller.detailPluginId);
  const detailRow = controller.rows.find((row) => row.id === controller.detailPluginId);
  const guidePlugin = props.plugins.find((plugin) => plugin.id === controller.guidePluginId);
  const uninstallPlugin = props.plugins.find((plugin) => plugin.id === controller.uninstallPluginId);

  return (
    <div className="plugin-manager-page">
      <section
        className="settings-plugin-manager"
        aria-labelledby="plugin-manager-title"
        data-retained-refresh={controller.retainedRefreshError ? "true" : undefined}
      >
        <PluginManagerHeader
          busyCreating={props.busyAction === "create"}
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
        busyAction={props.busyAction}
        busyPluginId={props.busyPluginId}
        copy={copy}
        actionFailure={detailPlugin ? controller.actionFailureFor(detailPlugin.id, "detail") : undefined}
        handlers={detailHandlers}
        onClose={controller.closeDetails}
        onOpenMcpSettings={props.onOpenMcpSettings}
        plugin={detailPlugin}
        row={detailRow}
      />
      <PluginCreateDialog
        busy={props.busyAction === "create"}
        onClose={controller.closeCreate}
        onCreate={props.onCreate}
        open={controller.createOpen}
      />
      <CuaDriverInstallDrawer
        busy={props.busyPluginId === controller.guidePluginId && props.busyAction === "connect"}
        onClose={controller.closeGuide}
        onConnect={props.onConnect}
        open={Boolean(controller.guidePluginId)}
        plugin={guidePlugin}
      />
      <PluginUninstallDialog
        busy={props.busyPluginId === controller.uninstallPluginId && props.busyAction === "uninstall"}
        copy={copy}
        onCancel={controller.cancelUninstall}
        onComplete={controller.completeUninstall}
        onUninstall={props.onUninstall}
        plugin={uninstallPlugin}
      />
    </div>
  );
}
