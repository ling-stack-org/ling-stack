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
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow, StatusBadge } from "../../shared/components/index.js";
import type { ManagedPluginApplyPresetResponse, ManagedPluginRuntimePreviewResponse, ManagedPluginView } from "../../types.js";
import type { PluginActionNotice, PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";

export function PluginManagerSettingsPanel({
  cwd,
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
          <p>{t("Managed capability bundles and trusted local presets")}</p>
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

      <div className="settings-plugin-stats" aria-label={t("Plugin stats")}>
        <span><small>{t("Total")}</small><strong>{plugins.length}</strong></span>
        <span><small>{t("Enabled")}</small><strong>{enabledCount}</strong></span>
        <span><small>{t("Trusted local")}</small><strong>{trustedLocalCount}</strong></span>
        <span><small>{t("Linked")}</small><strong>{linkedCount}</strong></span>
      </div>

      {latestApplyResult ? (
        <div className="settings-plugin-apply-result">
          <CheckCircle2 size={16} />
          <span>
            {t("Latest preset result")}: {latestApplyResult.plugin.displayName}
            {latestApplyResult.linkedMcpServer ? ` · ${latestApplyResult.linkedMcpServer.id}` : ""}
            {` · ${latestApplyResult.tools.length} ${t("tools")}`}
          </span>
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
            {t("Runtime preview")}: {latestRuntimePreview.plugin.displayName} · {latestRuntimePreview.preview.status}
            {latestRuntimePreview.preview.policyOverlays.length ? ` · ${latestRuntimePreview.preview.policyOverlays.length} ${t("policy overlays")}` : ""}
            {latestRuntimePreview.preview.blockers.length ? ` · ${latestRuntimePreview.preview.blockers[0]}` : ""}
          </span>
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
            <article key={plugin.id} className={`settings-plugin-row ${plugin.status}`}>
              <div className="settings-plugin-main">
                <div className="settings-plugin-title-line">
                  <Plug size={17} />
                  <strong>{plugin.displayName}</strong>
                  <StatusBadge status={plugin.status} />
                  <span className="settings-plugin-source">{sourceLabel(plugin.sourceKind)}</span>
                </div>
                <div className="settings-plugin-meta-line">
                  <span>{plugin.id}</span>
                  <span>{plugin.version}</span>
                  <span>{plugin.trustSummary}</span>
                </div>
                <div className="settings-plugin-meta-grid">
                  <MetaRow label={t("Health")} value={healthLabel(plugin)} compact />
                  <MetaRow label={t("Package")} value={packageLabel(plugin)} compact />
                  <MetaRow label={t("Contributions")} value={String(plugin.contributions.length)} compact />
                  <MetaRow label={t("Linked resources")} value={linkedResourceLabel(plugin)} compact />
                  <MetaRow label={t("Latest event")} value={latestEventLabel(plugin)} compact />
                </div>
                {plugin.disabledReason ? (
                  <div className="settings-plugin-warning">
                    <XCircle size={15} />
                    <span>{plugin.disabledReason}</span>
                  </div>
                ) : null}
                {plugin.sourceKind === "bundled" ? (
                  <div className="settings-plugin-package-note">
                    <PackageCheck size={15} />
                    <span>{plugin.package?.status === "installed" ? t("Bundled package installed for this workspace.") : t("Bundled package metadata only. Install before runtime injection.")}</span>
                  </div>
                ) : null}
                {plugin.runtimePreview?.blockers.length ? (
                  <div className="settings-plugin-warning">
                    <XCircle size={15} />
                    <span>{plugin.runtimePreview.blockers[0]}</span>
                  </div>
                ) : null}
                <div className="settings-plugin-contributions">
                  {plugin.contributions.map((contribution) => (
                    <span key={`${contribution.kind}:${contribution.id}`} className={contribution.enabled ? "settings-plugin-token" : "settings-plugin-token disabled"}>
                      {contribution.kind}: {contribution.label}
                      {contribution.linkedResourceId ? ` -> ${contribution.linkedResourceId}` : ""}
                    </span>
                  ))}
                </div>
              </div>
              <div className="settings-plugin-row-actions">
                {plugin.actions.canApplyPreset ? (
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={() => onApplyPreset(plugin.id)}
                    disabled={isBusy(plugin.id, busyPluginId, busyAction)}
                  >
                    {busyPluginId === plugin.id && busyAction === "apply" ? <Loader2 className="spin" size={15} /> : <Wrench size={15} />}
                    {t("Apply preset")}
                  </button>
                ) : null}
                {plugin.actions.canCheck ? (
                  <button
                    className="ghost-button compact-button"
                    type="button"
                    onClick={() => onCheck(plugin.id)}
                    disabled={isBusy(plugin.id, busyPluginId, busyAction)}
                  >
                    {busyPluginId === plugin.id && busyAction === "check" ? <Loader2 className="spin" size={15} /> : <Activity size={15} />}
                    {t("Check")}
                  </button>
                ) : null}
                {plugin.actions.canInstall ? (
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={() => onInstall(plugin.id)}
                    disabled={isBusy(plugin.id, busyPluginId, busyAction)}
                  >
                    {busyPluginId === plugin.id && busyAction === "install" ? <Loader2 className="spin" size={15} /> : <Download size={15} />}
                    {t("Install")}
                  </button>
                ) : null}
                {plugin.actions.canRuntimePreview ? (
                  <button
                    className="ghost-button compact-button"
                    type="button"
                    onClick={() => onRuntimePreview(plugin.id)}
                    disabled={isBusy(plugin.id, busyPluginId, busyAction)}
                  >
                    {busyPluginId === plugin.id && busyAction === "runtime-preview" ? <Loader2 className="spin" size={15} /> : <Eye size={15} />}
                    {t("Runtime preview")}
                  </button>
                ) : null}
                {plugin.actions.canRefreshPackage ? (
                  <button
                    className="ghost-button compact-button"
                    type="button"
                    onClick={() => onRefreshPackage(plugin.id)}
                    disabled={isBusy(plugin.id, busyPluginId, busyAction)}
                  >
                    {busyPluginId === plugin.id && busyAction === "refresh-package" ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                    {t("Refresh package")}
                  </button>
                ) : null}
                {plugin.sourceKind === "bundled" ? (
                  <button
                    className="ghost-button compact-button"
                    type="button"
                    onClick={() => onValidatePackage(plugin.id)}
                    disabled={isBusy(plugin.id, busyPluginId, busyAction)}
                  >
                    {busyPluginId === plugin.id && busyAction === "validate" ? <Loader2 className="spin" size={15} /> : <ShieldCheck size={15} />}
                    {t("Validate package")}
                  </button>
                ) : null}
                {plugin.actions.canEnable ? (
                  <button
                    className="ghost-button compact-button"
                    type="button"
                    onClick={() => onEnable(plugin.id)}
                    disabled={isBusy(plugin.id, busyPluginId, busyAction)}
                  >
                    {busyPluginId === plugin.id && busyAction === "enable" ? <Loader2 className="spin" size={15} /> : <Power size={15} />}
                    {t("Enable")}
                  </button>
                ) : null}
                {plugin.actions.canDisable ? (
                  <button
                    className="danger-ghost-button compact-button"
                    type="button"
                    onClick={() => onDisable(plugin.id)}
                    disabled={isBusy(plugin.id, busyPluginId, busyAction)}
                  >
                    {busyPluginId === plugin.id && busyAction === "disable" ? <Loader2 className="spin" size={15} /> : <PowerOff size={15} />}
                    {t("Disable")}
                  </button>
                ) : null}
                {plugin.actions.canUninstall ? (
                  <button
                    className="danger-ghost-button compact-button"
                    type="button"
                    onClick={() => onUninstall(plugin.id)}
                    disabled={isBusy(plugin.id, busyPluginId, busyAction)}
                  >
                    {busyPluginId === plugin.id && busyAction === "uninstall" ? <Loader2 className="spin" size={15} /> : <PowerOff size={15} />}
                    {t("Uninstall")}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      <footer className="settings-plugin-audit-note">
        <ShieldCheck size={15} />
        <span>{cwd}</span>
      </footer>
    </section>
  );
}

function isBusy(pluginId: string, busyPluginId: string, busyAction: PluginBusyAction | undefined): boolean {
  return busyAction !== undefined && busyPluginId === pluginId;
}

function sourceLabel(sourceKind: ManagedPluginView["sourceKind"]): string {
  switch (sourceKind) {
    case "built-in":
      return "built-in";
    case "bundled":
      return "bundled";
    case "trusted-local-preset":
      return "trusted local";
  }
}

function healthLabel(plugin: ManagedPluginView): string {
  if (!plugin.health) {
    return "unknown";
  }
  const checked = formatDateTime(plugin.health.checkedAt);
  return plugin.health.message ? `${plugin.health.status} · ${checked} · ${plugin.health.message}` : `${plugin.health.status} · ${checked}`;
}

function packageLabel(plugin: ManagedPluginView): string {
  if (!plugin.package) {
    return plugin.sourceKind === "bundled" ? "not installed" : "n/a";
  }
  const hash = plugin.package.packageHash ? plugin.package.packageHash.slice(0, 12) : "no hash";
  return `${plugin.package.status} · ${plugin.package.version} · ${hash}`;
}

function linkedResourceLabel(plugin: ManagedPluginView): string {
  if (plugin.linkedResources.length === 0) {
    return "none";
  }
  return plugin.linkedResources.map((resource) => `${resource.id}${resource.present ? "" : " missing"}`).join(", ");
}

function latestEventLabel(plugin: ManagedPluginView): string {
  const latest = plugin.events?.[plugin.events.length - 1];
  if (!latest) {
    return "none";
  }
  return `${latest.type} · ${formatDateTime(latest.createdAt)}`;
}
