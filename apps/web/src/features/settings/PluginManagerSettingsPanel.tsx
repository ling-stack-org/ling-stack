import {
  Activity,
  CheckCircle2,
  Download,
  Eye,
  ExternalLink,
  Loader2,
  PackageCheck,
  Plug,
  Power,
  PowerOff,
  RefreshCw,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { MetaRow, StatusBadge } from "../../shared/components/index.js";
import type { ManagedPluginApplyPresetResponse, ManagedPluginRuntimePreviewResponse, ManagedPluginView } from "../../types.js";
import type { PluginActionNotice, PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { SettingsMetaLine } from "./SettingsSubnav.js";
import {
  buildPluginRowView,
  type PluginActionView,
} from "./plugin-manager-view-models.js";

export function PluginManagerSettingsPanel({
  plugins,
  isLoading,
  busyPluginId,
  busyAction,
  latestApplyResult,
  latestRuntimePreview,
  latestNotice,
  onRefresh,
  onApplyPreset,
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
  readonly cwd: string;
  readonly plugins: readonly ManagedPluginView[];
  readonly isLoading: boolean;
  readonly busyPluginId: string;
  readonly busyAction: PluginBusyAction | undefined;
  readonly latestApplyResult?: ManagedPluginApplyPresetResponse;
  readonly latestRuntimePreview?: ManagedPluginRuntimePreviewResponse;
  readonly latestNotice?: PluginActionNotice;
  readonly onRefresh: () => void;
  readonly onApplyPreset: (pluginId: string) => void;
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
  const enabledCount = plugins.filter((plugin) => plugin.status === "enabled").length;
  const trustedLocalCount = plugins.filter((plugin) => plugin.sourceKind === "trusted-local-preset").length;
  const linkedCount = plugins.reduce((count, plugin) => count + plugin.linkedResources.filter((resource) => resource.present).length, 0);

  return (
    <section className="settings-plugin-manager" aria-labelledby="settings-plugin-manager-title">
      <header className="settings-plugin-manager-head">
        <div>
          <h2 id="settings-plugin-manager-title">{t("Plugin Manager")}</h2>
        </div>
        <div className="settings-plugin-manager-actions">
          <button className="secondary-button compact-button" type="button" onClick={onOpenMcpSettings}>
            <ExternalLink size={15} />
            {t("MCP settings")}
          </button>
          <button className="icon-button" type="button" onClick={onRefresh} disabled={isLoading} aria-label={t("Refresh")}>
            <RefreshCw size={15} className={isLoading ? "spin" : undefined} />
          </button>
        </div>
      </header>

      <SettingsMetaLine
        label={t("Plugin stats")}
        items={[
          { label: "Total", value: plugins.length },
          { label: "Enabled", value: enabledCount },
          { label: "Trusted local", value: trustedLocalCount },
          { label: "Linked", value: linkedCount },
        ]}
      />

      {latestApplyResult ? (
        <div className="settings-plugin-apply-result">
          <CheckCircle2 size={16} />
          <span>
            {t("Latest preset result")}: {latestApplyResult.plugin.displayName}
            {` · ${latestApplyResult.tools.length} ${t("tools")}`}
          </span>
          {latestApplyResult.linkedMcpServer ? (
            <details className="settings-compact-details settings-interaction-details">
              <summary>{t("Preset details")}</summary>
              <span>{latestApplyResult.linkedMcpServer.id}</span>
            </details>
          ) : null}
        </div>
      ) : null}

      {latestNotice ? (
        <div className={`settings-plugin-action-notice ${latestNotice.tone}`} role="status" aria-live="polite">
          {latestNotice.tone === "success" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <span>{latestNotice.message}</span>
        </div>
      ) : null}

      {latestRuntimePreview ? (
        <div className={`settings-plugin-runtime-preview ${latestRuntimePreview.preview.status}`} role="status" aria-live="polite">
          <Eye size={16} />
          <span>
            {latestRuntimePreview.preview.blockers.length > 0 ? t("Runtime preview blocked.") : t("Runtime preview ready.")}
            {` ${latestRuntimePreview.plugin.displayName}`}
          </span>
          <details className="settings-compact-details settings-interaction-details">
            <summary>{t("Runtime preview details")}</summary>
            <span>
              {runtimePreviewStatusLabel(latestRuntimePreview.preview.status, t)}
              {latestRuntimePreview.preview.policyOverlays.length ? ` · ${latestRuntimePreview.preview.policyOverlays.length} ${t("policy overlays")}` : ""}
              {latestRuntimePreview.preview.blockers.length ? ` · ${latestRuntimePreview.preview.blockers[0]}` : ""}
            </span>
          </details>
        </div>
      ) : null}

      {plugins.length === 0 ? (
        <div className="empty-state compact-empty">
          {isLoading ? <Loader2 className="spin" /> : <Plug />}
          <span>{isLoading ? t("Loading plugins...") : t("No managed plugins registered")}</span>
        </div>
      ) : (
        <div className="settings-plugin-list" aria-label={t("Plugins")}>
          {plugins.map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              busyPluginId={busyPluginId}
              busyAction={busyAction}
              onApplyPreset={onApplyPreset}
              onCheck={onCheck}
              onValidatePackage={onValidatePackage}
              onInstall={onInstall}
              onUninstall={onUninstall}
              onRefreshPackage={onRefreshPackage}
              onRuntimePreview={onRuntimePreview}
              onEnable={onEnable}
              onDisable={onDisable}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PluginRow({
  plugin,
  busyPluginId,
  busyAction,
  onApplyPreset,
  onCheck,
  onValidatePackage,
  onInstall,
  onUninstall,
  onRefreshPackage,
  onRuntimePreview,
  onEnable,
  onDisable,
}: {
  readonly plugin: ManagedPluginView;
  readonly busyPluginId: string;
  readonly busyAction: PluginBusyAction | undefined;
  readonly onApplyPreset: (pluginId: string) => void;
  readonly onCheck: (pluginId: string) => void;
  readonly onValidatePackage: (pluginId: string) => void;
  readonly onInstall: (pluginId: string) => void;
  readonly onUninstall: (pluginId: string) => void;
  readonly onRefreshPackage: (pluginId: string) => void;
  readonly onRuntimePreview: (pluginId: string) => void;
  readonly onEnable: (pluginId: string) => void;
  readonly onDisable: (pluginId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const view = buildPluginRowView(plugin, t);

  return (
    <article className={`settings-plugin-row ${plugin.status}`}>
      <div className="settings-plugin-row-summary">
        <div className="settings-plugin-main">
          <div className="settings-plugin-title-line">
            <Plug size={17} />
            <strong>{plugin.displayName}</strong>
            <StatusBadge status={plugin.status} />
            <span className="settings-plugin-source">{view.sourceLabel}</span>
          </div>
          <span className="settings-plugin-readiness" title={view.readiness}>{view.readiness}</span>
          {view.warnings.length > 0 ? (
            <div className="settings-plugin-warning">
              <XCircle size={15} />
              <span>{view.warnings[0]}</span>
            </div>
          ) : null}
        </div>
        <div className="settings-plugin-row-actions">
          {view.primaryAction ? (
            <PluginActionButton
              action={view.primaryAction}
              pluginId={plugin.id}
              busyPluginId={busyPluginId}
              busyAction={busyAction}
              onApplyPreset={onApplyPreset}
              onCheck={onCheck}
              onValidatePackage={onValidatePackage}
              onInstall={onInstall}
              onUninstall={onUninstall}
              onRefreshPackage={onRefreshPackage}
              onRuntimePreview={onRuntimePreview}
              onEnable={onEnable}
              onDisable={onDisable}
            />
          ) : null}
        </div>
      </div>

      <details className="settings-plugin-details">
        <summary>{t("Details and diagnostics")}</summary>
        <div className="settings-plugin-detail-body">
          <div className="settings-plugin-meta-grid">
            {view.facts.map((fact) => (
              <MetaRow key={fact.label} label={fact.label} value={fact.value} compact />
            ))}
            <MetaRow label={t("Contributions")} value={String(plugin.contributions.length)} compact />
          </div>
          {view.packageNotice ? (
            <div className="settings-plugin-package-note">
              <PackageCheck size={15} />
              <span>{view.packageNotice}</span>
            </div>
          ) : null}
          {view.contributionLabels.length > 0 ? (
            <div className="settings-plugin-contributions" aria-label={t("Plugin contributions")}>
              {plugin.contributions.map((contribution, index) => (
                <span key={`${contribution.kind}:${contribution.id}`} className={contribution.enabled ? "settings-plugin-token" : "settings-plugin-token disabled"}>
                  {view.contributionLabels[index]}
                </span>
              ))}
            </div>
          ) : null}
          {view.detailActions.length > 0 ? (
            <div className="settings-plugin-detail-actions">
              {view.detailActions.map((action) => (
                <PluginActionButton
                  key={action.id}
                  action={action}
                  pluginId={plugin.id}
                  busyPluginId={busyPluginId}
                  busyAction={busyAction}
                  onApplyPreset={onApplyPreset}
                  onCheck={onCheck}
                  onValidatePackage={onValidatePackage}
                  onInstall={onInstall}
                  onUninstall={onUninstall}
                  onRefreshPackage={onRefreshPackage}
                  onRuntimePreview={onRuntimePreview}
                  onEnable={onEnable}
                  onDisable={onDisable}
                />
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </article>
  );
}

function PluginActionButton({
  action,
  pluginId,
  busyPluginId,
  busyAction,
  onApplyPreset,
  onCheck,
  onValidatePackage,
  onInstall,
  onUninstall,
  onRefreshPackage,
  onRuntimePreview,
  onEnable,
  onDisable,
}: {
  readonly action: PluginActionView;
  readonly pluginId: string;
  readonly busyPluginId: string;
  readonly busyAction: PluginBusyAction | undefined;
  readonly onApplyPreset: (pluginId: string) => void;
  readonly onCheck: (pluginId: string) => void;
  readonly onValidatePackage: (pluginId: string) => void;
  readonly onInstall: (pluginId: string) => void;
  readonly onUninstall: (pluginId: string) => void;
  readonly onRefreshPackage: (pluginId: string) => void;
  readonly onRuntimePreview: (pluginId: string) => void;
  readonly onEnable: (pluginId: string) => void;
  readonly onDisable: (pluginId: string) => void;
}): JSX.Element {
  const busy = isBusy(pluginId, busyPluginId, busyAction);
  const icon = busy ? <Loader2 className="spin" size={15} /> : pluginActionIcon(action.id);
  const className = action.tone === "primary"
    ? "secondary-button compact-button"
    : action.tone === "danger"
      ? "danger-ghost-button compact-button"
      : "ghost-button compact-button";
  return (
    <button className={className} type="button" onClick={() => runPluginAction(action.id, pluginId, {
      onApplyPreset,
      onCheck,
      onValidatePackage,
      onInstall,
      onUninstall,
      onRefreshPackage,
      onRuntimePreview,
      onEnable,
      onDisable,
    })} disabled={busy}>
      {icon}
      {action.label}
    </button>
  );
}

function pluginActionIcon(action: PluginActionView["id"]): JSX.Element {
  switch (action) {
    case "apply":
      return <Wrench size={15} />;
    case "check":
      return <Activity size={15} />;
    case "install":
      return <Download size={15} />;
    case "runtime-preview":
      return <Eye size={15} />;
    case "refresh-package":
      return <RefreshCw size={15} />;
    case "validate":
      return <ShieldCheck size={15} />;
    case "enable":
      return <Power size={15} />;
    case "disable":
    case "uninstall":
      return <PowerOff size={15} />;
  }
}

function runPluginAction(
  action: PluginActionView["id"],
  pluginId: string,
  handlers: {
    readonly onApplyPreset: (pluginId: string) => void;
    readonly onCheck: (pluginId: string) => void;
    readonly onValidatePackage: (pluginId: string) => void;
    readonly onInstall: (pluginId: string) => void;
    readonly onUninstall: (pluginId: string) => void;
    readonly onRefreshPackage: (pluginId: string) => void;
    readonly onRuntimePreview: (pluginId: string) => void;
    readonly onEnable: (pluginId: string) => void;
    readonly onDisable: (pluginId: string) => void;
  },
): void {
  switch (action) {
    case "apply":
      handlers.onApplyPreset(pluginId);
      return;
    case "check":
      handlers.onCheck(pluginId);
      return;
    case "validate":
      handlers.onValidatePackage(pluginId);
      return;
    case "install":
      handlers.onInstall(pluginId);
      return;
    case "uninstall":
      handlers.onUninstall(pluginId);
      return;
    case "refresh-package":
      handlers.onRefreshPackage(pluginId);
      return;
    case "runtime-preview":
      handlers.onRuntimePreview(pluginId);
      return;
    case "enable":
      handlers.onEnable(pluginId);
      return;
    case "disable":
      handlers.onDisable(pluginId);
      return;
  }
}

function isBusy(pluginId: string, busyPluginId: string, busyAction: PluginBusyAction | undefined): boolean {
  return busyAction !== undefined && busyPluginId === pluginId;
}

function runtimePreviewStatusLabel(status: string, t: (key: string) => string): string {
  if (status === "injectable") {
    return t("Runtime ready");
  }
  if (status === "blocked") {
    return t("Runtime blocked");
  }
  if (status === "disabled") {
    return t("Runtime disabled");
  }
  return status || t("Unknown");
}
