import { useEffect, useMemo, useRef, useState } from "react";
import { Clock3, FileText, Globe2, Puzzle, Search } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Field, Input, Switch, Tabs, TabsList, TabsTrigger } from "../../shared/ui/index.js";
import { CuaDriverInstallDrawer } from "./CuaDriverInstallDrawer.js";
import { PluginDetailDrawer } from "./PluginDetailDrawer.js";
import { buildPluginManagerCopy } from "./plugin-manager-copy.js";
import type { PluginActionHandlers, PluginManagerPageProps } from "./plugin-manager-types.js";
import { PluginUninstallDialog } from "./PluginUninstallDialog.js";
import { usePluginManagerController } from "./usePluginManagerController.js";
import { ChromeBrowserConnectDrawer } from "./ChromeBrowserConnectDrawer.js";

export type { PluginManagerPageProps } from "./plugin-manager-types.js";

export function PluginManagerPage(props: PluginManagerPageProps): React.JSX.Element {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<"installed" | "available">("installed");
  const [tabTouched, setTabTouched] = useState(false);
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
    onRollback: (pluginId) => controller.runMutation({
      pluginId,
      action: "refresh-package",
      owner,
      mutate: (request) => props.onRollback(pluginId, request),
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

  const catalogEntries = useMemo(() => {
    const query = controller.filters.query.trim().toLocaleLowerCase();
    return (props.catalog?.catalog.plugins ?? []).filter((entry) => !query
      || `${entry.displayName}\n${entry.description ?? entry.trustSummary}`.toLocaleLowerCase().includes(query));
  }, [controller.filters.query, props.catalog]);
  const installedPlugins = useMemo(
    () => new Map(props.plugins.filter((plugin) => plugin.package?.status === "installed").map((plugin) => [plugin.id, plugin])),
    [props.plugins],
  );
  const installedEntries = useMemo(
    () => catalogEntries.filter((entry) => installedPlugins.has(entry.pluginId)),
    [catalogEntries, installedPlugins],
  );
  const availableEntries = useMemo(
    () => catalogEntries.filter((entry) => !installedPlugins.has(entry.pluginId)),
    [catalogEntries, installedPlugins],
  );
  useEffect(() => {
    if (!tabTouched && props.plugins.length > 0 && installedEntries.length === 0) setActiveTab("available");
  }, [installedEntries.length, props.plugins.length, tabTouched]);
  const visibleEntries = activeTab === "installed" ? installedEntries : availableEntries;
  const catalogListRef = useRef<HTMLDivElement>(null);
  function handleCatalogScroll(event: React.UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 160
      && props.catalogHasMore
      && !props.catalogLoadingMore) {
      void props.onLoadMoreCatalog();
    }
  }
  return (
    <div className="plugin-manager-page">
      <section
        className="settings-plugin-manager plugin-manager-no-titlebar plugin-manager-marketplace-only"
        aria-label={t("Plugins")}
        data-retained-refresh={controller.retainedRefreshError ? "true" : undefined}
      >
        <section className="plugin-marketplace plugin-marketplace-view-official" aria-label={t("Official")}>
          <div className="plugin-marketplace-content">
            <div className="plugin-marketplace-toolbar">
              <Tabs
                value={activeTab}
                onValueChange={(value) => {
                  setTabTouched(true);
                  setActiveTab(value as "installed" | "available");
                }}
              >
                <TabsList aria-label={t("Plugin status")} className="plugin-marketplace-tabs" size="sm">
                  <TabsTrigger value="installed">{t("Installed")} <span>{installedEntries.length}</span></TabsTrigger>
                  <TabsTrigger value="available">{t("Not installed")} <span>{availableEntries.length}</span></TabsTrigger>
                </TabsList>
              </Tabs>
              <Field className="plugin-marketplace-search" label={t("Search plugins")}>
                <Input
                  aria-label={t("Search plugins")}
                  onChange={(event) => controller.setQuery(event.target.value)}
                  placeholder={t("Search plugins")}
                  prefix={<Search aria-hidden="true" />}
                  size="sm"
                  value={controller.filters.query}
                />
              </Field>
            </div>
            <div className="plugin-marketplace-list" onScroll={handleCatalogScroll} ref={catalogListRef}>
              {visibleEntries.map((entry) => {
                const installed = installedPlugins.get(entry.pluginId);
                const artifact = entry.artifacts.find((candidate) => candidate.channel === "stable") ?? entry.artifacts[0];
                const icon = entry.pluginId.includes("chrome")
                  ? <Globe2 />
                  : entry.pluginId.includes("office")
                    ? <FileText />
                    : entry.pluginId.includes("automation")
                      ? <Clock3 />
                      : <Puzzle />;
                const pendingToggle = installed
                  ? controller.pendingActionFor(installed.id, "row", "enable") ?? controller.pendingActionFor(installed.id, "row", "disable")
                  : undefined;
                const canToggle = installed
                  ? installed.status === "enabled" ? installed.actions.canDisable : installed.actions.canEnable
                  : false;
                return (
                  <article className="plugin-marketplace-row" key={entry.pluginId}>
                    <span className="plugin-marketplace-icon" aria-hidden="true">{icon}</span>
                    <div className="plugin-marketplace-copy">
                      <div className="plugin-marketplace-name"><strong>{entry.displayName}</strong></div>
                      <span>{entry.description ?? entry.trustSummary}</span>
                      <small>{entry.latestStableVersion} · {t("Available for this device")} · {formatArtifactSize(artifact?.sizeBytes)}</small>
                    </div>
                    {installed ? (
                      <div className="plugin-marketplace-toggle">
                        <Switch
                          aria-label={`${entry.displayName} ${installed.status === "enabled" ? t("Disable") : t("Enable")}`}
                          checked={installed.status === "enabled"}
                          disabled={!canToggle || Boolean(pendingToggle)}
                          loading={Boolean(pendingToggle)}
                          onCheckedChange={(checked) => void controller.runMutation({
                            pluginId: installed.id,
                            action: checked ? "enable" : "disable",
                            owner: "row",
                            mutate: (request) => checked
                              ? props.onEnable(installed.id, request)
                              : props.onDisable(installed.id, request),
                          })}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="plugin-marketplace-action plugin-marketplace-action-primary"
                        disabled={!artifact}
                        onClick={() => artifact && void props.onInstallRemote(entry.pluginId, {
                          owner: "row",
                          requestId: `catalog-install:${entry.pluginId}:${Date.now()}`,
                        }, artifact.version)}
                      >
                        {artifact ? t("Install") : t("Awaiting source")}
                      </button>
                    )}
                  </article>
                );
              })}
                  {!props.catalog && !props.catalogLoading ? (
                    <div className="plugin-marketplace-empty" role="status">
                      <strong>{props.catalogError ? t("Official plugin source unavailable") : t("No plugin source connected")}</strong>
                      <span>{props.catalogError ?? t("Connect the local service to load the official plugin list.")}</span>
                      <button type="button" onClick={props.onRefresh}>{t("Retry")}</button>
                    </div>
                  ) : null}
                  {props.catalogLoading ? (
                    <div className="plugin-marketplace-empty" role="status" aria-live="polite">
                      <span>{t("Loading official plugin source")}</span>
                    </div>
                  ) : null}
                  {props.catalogLoadingMore ? (
                    <div className="plugin-marketplace-load-more" role="status" aria-live="polite">
                      <span>{t("Loading more plugins")}</span>
                    </div>
                  ) : null}
            </div>
          </div>
        </section>
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

function formatArtifactSize(sizeBytes: number | undefined): string {
  if (!sizeBytes || !Number.isFinite(sizeBytes)) return "";
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(0)} MB`;
}
