import { useEffect, useState } from "react";
import {
  Bot,
  CircleAlert,
  Database,
  GitBranch,
  KeyRound,
  Languages,
  Library,
  Loader2,
  Palette,
  Play,
  Power,
  PowerOff,
  Plug,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { LanguageSwitcher, useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  buildLocalEffectivePolicyPreview,
  formatToolDecisionGroups,
  inferPermissionPreset,
  permissionModeForPreset,
  permissionPresetDescription,
  permissionPresetLabel,
  permissionPresetOptions,
  summarizeEffectivePolicySnapshot,
} from "../../lib/session-permissions.js";
import { allTools, riskyTools } from "../../lib/tools.js";
import { MetaRow, StatusBadge } from "../../shared/components/index.js";
import { ThemeSwitcher } from "../../theme.js";
import type { RuntimeSettingsFormState } from "../../domains/settings/use-settings-domain.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyFormState,
  ApprovalToolDecision,
  Channel,
  ExternalWorkStatusResponse,
  PermissionPreset,
  RunnerListItem,
  SessionPermissionMode,
  WorkspaceRuntimeSettings,
  McpServer,
  McpServerFormState,
  McpTool,
  ManagedPluginApplyPresetResponse,
  ManagedPluginRuntimePreviewResponse,
  ManagedPluginView,
} from "../../types.js";
import { SkillLibrarySettingsPanel } from "./SkillLibrarySettingsPanel.js";
import { PluginManagerSettingsPanel } from "./PluginManagerSettingsPanel.js";
import type { PluginActionNotice, PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { McpToolsPage } from "../mcp/McpToolsPage.js";
import type { McpBusyAction } from "../../domains/mcp/use-mcp-domain.js";

type SettingsSection = "external-work" | "interface" | "runtime" | "approval-policy" | "skill-library" | "mcp" | "plugins" | "developer";

export function SettingsPage({
  cwd,
  policy,
  form,
  runners,
  runtimeSettings,
  runtimeSettingsForm,
  skillLibraryRefreshToken,
  selectedChannel,
  externalWorkStatus,
  mcpServers,
  mcpTools,
  mcpLoading,
  mcpBusyServerId,
  mcpBusyAction,
  plugins,
  pluginsLoading,
  pluginBusyId,
  pluginBusyAction,
  latestPluginApplyResult,
  latestPluginRuntimePreview,
  latestPluginNotice,
  permissionMode,
  permissionPreset,
  isLoading,
  runtimeSettingsLoading,
  runtimeSettingsAction,
  runtimeSettingsError,
  externalWorkStatusLoading,
  externalWorkStatusAction,
  externalWorkSecretAction,
  externalWorkWorkflowAction,
  errorMessage,
  onFormChange,
  onPermissionModeChange,
  onRefresh,
  onSave,
  onRuntimeSettingsFormChange,
  onToggleAllowedRunner,
  onRefreshRuntimeSettings,
  onSaveRuntimeSettings,
  onRefreshExternalWork,
  onRefreshPlugins,
  onApplyPluginPreset,
  onCheckPlugin,
  onValidatePluginPackage,
  onInstallPlugin,
  onUninstallPlugin,
  onRefreshPluginPackage,
  onPreviewPluginRuntime,
  onEnablePlugin,
  onDisablePlugin,
  onExternalWorkAction,
  onConfigureExternalWorkWorkflow,
  onConfigureExternalWorkSecret,
  onDeleteExternalWorkSecret,
  onOpenExternalWorkRecords,
  onOpenExternalWorkTriage,
  onOpenRunDiagnostics,
  onRefreshMcp,
  onCreateMcpServer,
  onUpdateMcpServer,
  onDeleteMcpServer,
  onCheckMcpServer,
  onSyncMcpTools,
}: {
  readonly cwd: string;
  readonly policy: ApprovalPolicy | undefined;
  readonly form: ApprovalPolicyFormState;
  readonly runners: readonly RunnerListItem[];
  readonly runtimeSettings: WorkspaceRuntimeSettings | undefined;
  readonly runtimeSettingsForm: RuntimeSettingsFormState;
  readonly skillLibraryRefreshToken: number;
  readonly selectedChannel: Channel | undefined;
  readonly externalWorkStatus: ExternalWorkStatusResponse | undefined;
  readonly mcpServers: readonly McpServer[];
  readonly mcpTools: readonly McpTool[];
  readonly mcpLoading: boolean;
  readonly mcpBusyServerId: string;
  readonly mcpBusyAction: McpBusyAction | undefined;
  readonly plugins: readonly ManagedPluginView[];
  readonly pluginsLoading: boolean;
  readonly pluginBusyId: string;
  readonly pluginBusyAction: PluginBusyAction | undefined;
  readonly latestPluginApplyResult?: ManagedPluginApplyPresetResponse;
  readonly latestPluginRuntimePreview?: ManagedPluginRuntimePreviewResponse;
  readonly latestPluginNotice?: PluginActionNotice;
  readonly permissionMode: SessionPermissionMode;
  readonly permissionPreset?: PermissionPreset;
  readonly isLoading: boolean;
  readonly runtimeSettingsLoading: boolean;
  readonly runtimeSettingsAction: "save" | undefined;
  readonly runtimeSettingsError: string;
  readonly externalWorkStatusLoading: boolean;
  readonly externalWorkStatusAction: "poll" | "reconcile" | "start" | "stop" | undefined;
  readonly externalWorkSecretAction: "configure" | "delete" | undefined;
  readonly externalWorkWorkflowAction: "configure" | undefined;
  readonly errorMessage: string;
  readonly onFormChange: (form: ApprovalPolicyFormState) => void;
  readonly onPermissionModeChange: (mode: SessionPermissionMode) => void;
  readonly onRefresh: () => void;
  readonly onSave: () => void;
  readonly onRuntimeSettingsFormChange: (form: RuntimeSettingsFormState) => void;
  readonly onToggleAllowedRunner: (runnerId: string, allowed: boolean) => void;
  readonly onRefreshRuntimeSettings: () => void;
  readonly onSaveRuntimeSettings: () => void;
  readonly onRefreshExternalWork: () => void;
  readonly onRefreshPlugins: () => void;
  readonly onApplyPluginPreset: (pluginId: string) => void;
  readonly onCheckPlugin: (pluginId: string) => void;
  readonly onValidatePluginPackage: (pluginId: string) => void;
  readonly onInstallPlugin: (pluginId: string) => void;
  readonly onUninstallPlugin: (pluginId: string) => void;
  readonly onRefreshPluginPackage: (pluginId: string) => void;
  readonly onPreviewPluginRuntime: (pluginId: string) => void;
  readonly onEnablePlugin: (pluginId: string) => void;
  readonly onDisablePlugin: (pluginId: string) => void;
  readonly onExternalWorkAction: (action: "poll" | "reconcile" | "start" | "stop") => void;
  readonly onConfigureExternalWorkWorkflow: (input: {
    readonly sourceKind: "github" | "linear";
    readonly repository?: string;
    readonly projectSlug?: string;
  }) => Promise<void>;
  readonly onConfigureExternalWorkSecret: (token: string) => Promise<void>;
  readonly onDeleteExternalWorkSecret: () => Promise<void>;
  readonly onOpenExternalWorkRecords: () => void;
  readonly onOpenExternalWorkTriage: () => void;
  readonly onOpenRunDiagnostics: () => void;
  readonly onRefreshMcp: () => void;
  readonly onCreateMcpServer: (form: McpServerFormState) => Promise<void>;
  readonly onUpdateMcpServer: (serverId: string, form: McpServerFormState) => Promise<void>;
  readonly onDeleteMcpServer: (serverId: string) => void;
  readonly onCheckMcpServer: (serverId: string) => boolean | Promise<boolean> | void | Promise<void>;
  readonly onSyncMcpTools: (serverId: string) => boolean | Promise<boolean> | void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const [externalWorkToken, setExternalWorkToken] = useState("");
  const [activeSection, setActiveSection] = useState<SettingsSection>("external-work");
  const [workflowSourceKind, setWorkflowSourceKind] = useState<"github" | "linear">("github");
  const [workflowRepository, setWorkflowRepository] = useState("");
  const [workflowProjectSlug, setWorkflowProjectSlug] = useState("");
  const secretRef = externalWorkStatus?.secret.ref ?? externalWorkStatus?.workflow.secretRef;
  const canConfigureSecret = Boolean(externalWorkStatus?.workflow.valid && externalWorkStatus.workflow.sourceKind !== "unknown");
  const canRemoveSecret = Boolean(secretRef?.startsWith("keychain:"));
  const sourceLabel = externalWorkStatus?.workflow.sourceKind === "linear" ? "Linear" : "GitHub";
  const secretBusy = externalWorkSecretAction !== undefined;
  const workflowBusy = externalWorkWorkflowAction !== undefined;
  const shouldShowWorkflowSetup = Boolean(selectedChannel && (!externalWorkStatus?.workflow.valid || externalWorkStatus.workflow.sourceKind === "unknown"));
  const normalizedWorkflowRepository = normalizeGitHubRepositoryInput(workflowRepository);
  const workflowTargetReady = workflowSourceKind === "github"
    ? normalizedWorkflowRepository !== undefined
    : workflowProjectSlug.trim().length > 0;
  const enabledRunners = runners.filter((runner) => runner.status === "enabled");
  const resolvedPermissionPreset = permissionPreset ?? inferPermissionPreset(permissionMode);
  const policyPreview = buildLocalEffectivePolicyPreview({
    policy,
    form,
    mode: permissionMode,
    channelBoundPath: selectedChannel?.boundPath,
  });
  const policyPreviewRows = [
    ...summarizeEffectivePolicySnapshot(policyPreview, t),
    ...formatToolDecisionGroups(policyPreview, t),
  ];

  useEffect(() => {
    const sourceKind = externalWorkStatus?.workflow.sourceKind;
    if (sourceKind === "github" || sourceKind === "linear") {
      setWorkflowSourceKind(sourceKind);
    }
    if (externalWorkStatus?.workflow.repository) {
      setWorkflowRepository(externalWorkStatus.workflow.repository);
    }
    if (externalWorkStatus?.workflow.projectSlug) {
      setWorkflowProjectSlug(externalWorkStatus.workflow.projectSlug);
    }
  }, [
    externalWorkStatus?.workflow.sourceKind,
    externalWorkStatus?.workflow.repository,
    externalWorkStatus?.workflow.projectSlug,
  ]);

  return (
    <div className="settings-layout">
      <nav className="settings-section-nav" aria-label={t("Settings sections")}>
        <button
          className={activeSection === "external-work" ? "settings-section-item active" : "settings-section-item"}
          type="button"
          onClick={() => setActiveSection("external-work")}
        >
          <span className="settings-section-icon"><GitBranch size={16} /></span>
          <span>
            <strong>{t("External work")}</strong>
            <small>{workflowStatusLabel(externalWorkStatus)}</small>
          </span>
        </button>
        <button
          className={activeSection === "interface" ? "settings-section-item active" : "settings-section-item"}
          type="button"
          onClick={() => setActiveSection("interface")}
        >
          <span className="settings-section-icon"><Palette size={16} /></span>
          <span>
            <strong>{t("Interface preferences")}</strong>
            <small>{t("Theme and language")}</small>
          </span>
        </button>
        <button
          className={activeSection === "runtime" ? "settings-section-item active" : "settings-section-item"}
          type="button"
          onClick={() => setActiveSection("runtime")}
        >
          <span className="settings-section-icon"><Bot size={16} /></span>
          <span>
            <strong>{t("Runtime runners")}</strong>
            <small>{runtimeSettings?.defaultRunnerId ?? t("Runner policy")}</small>
          </span>
        </button>
        <button
          className={activeSection === "approval-policy" ? "settings-section-item active" : "settings-section-item"}
          type="button"
          onClick={() => setActiveSection("approval-policy")}
        >
          <span className="settings-section-icon"><ShieldCheck size={16} /></span>
          <span>
            <strong>{t("Approval policy")}</strong>
            <small>{t("Tool permissions")}</small>
          </span>
        </button>
        <button
          className={activeSection === "skill-library" ? "settings-section-item active" : "settings-section-item"}
          type="button"
          onClick={() => setActiveSection("skill-library")}
        >
          <span className="settings-section-icon"><Library size={16} /></span>
          <span>
            <strong>{t("Skill Library")}</strong>
            <small>{t("Skill definitions and imports")}</small>
          </span>
        </button>
        <button
          className={activeSection === "mcp" ? "settings-section-item active" : "settings-section-item"}
          type="button"
          onClick={() => setActiveSection("mcp")}
        >
          <span className="settings-section-icon"><Wrench size={16} /></span>
          <span>
            <strong>{t("MCP tool servers")}</strong>
            <small>{t("{count} servers", { count: mcpServers.length })}</small>
          </span>
        </button>
        <button
          className={activeSection === "plugins" ? "settings-section-item active" : "settings-section-item"}
          type="button"
          onClick={() => setActiveSection("plugins")}
        >
          <span className="settings-section-icon"><Plug size={16} /></span>
          <span>
            <strong>{t("Plugins")}</strong>
            <small>{t("Managed capabilities")}</small>
          </span>
        </button>
        <button
          className={activeSection === "developer" ? "settings-section-item active" : "settings-section-item"}
          type="button"
          onClick={() => setActiveSection("developer")}
        >
          <span className="settings-section-icon"><Database size={16} /></span>
          <span>
            <strong>{t("Developer")}</strong>
            <small>{t("Diagnostics and raw records")}</small>
          </span>
        </button>
      </nav>

      <div className="settings-content-stack">
      {activeSection === "interface" ? (
      <section className="panel settings-panel interface-settings-panel" aria-labelledby="interface-settings-title">
        <div className="panel-title">
          <Palette size={18} />
          <h2 id="interface-settings-title">{t("Interface preferences")}</h2>
        </div>
        <div className="interface-preference-grid">
          <div className="interface-preference-row">
            <span>
              <Palette size={16} />
              <strong>{t("Theme")}</strong>
            </span>
            <ThemeSwitcher />
          </div>
          <div className="interface-preference-row">
            <span>
              <Languages size={16} />
              <strong>{t("Language")}</strong>
            </span>
            <LanguageSwitcher />
          </div>
        </div>
      </section>
      ) : null}

      {activeSection === "external-work" ? (
      <section className="panel settings-panel external-work-settings-panel" aria-labelledby="external-work-settings-title">
        <div className="panel-title split">
          <span>
            <GitBranch size={18} />
            <h2 id="external-work-settings-title">{t("External work")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefreshExternalWork} disabled={externalWorkStatusLoading || !selectedChannel}>
            {externalWorkStatusLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        {!selectedChannel ? (
          <div className="empty-state compact-empty">
            <GitBranch />
            <span>{t("Select a channel to inspect external work setup.")}</span>
          </div>
        ) : (
          <>
            <div className="external-work-status-grid">
              <MetaRow label={t("Channel")} value={`${selectedChannel.name} (${selectedChannel.id})`} compact />
              <MetaRow label={t("Bound path")} value={selectedChannel.boundPath ?? t("not set")} compact />
              <MetaRow label={t("Workflow")} value={externalWorkStatus?.workflow.path ?? "WORKFLOW.md"} compact />
              <MetaRow label={t("Workflow status")} value={workflowStatusLabel(externalWorkStatus)} compact />
              <MetaRow label={t("Source")} value={externalWorkStatus?.workflow.sourceKind ?? "unknown"} compact />
              <MetaRow label={t("Target")} value={externalWorkTargetLabel(externalWorkStatus)} compact />
              <MetaRow label={t("Token")} value={externalWorkStatus?.secret.status ?? "not_required"} compact />
              <MetaRow label={t("Background")} value={externalWorkStatus?.background.status ?? "not_configured"} compact />
            </div>

            {!selectedChannel.boundPath ? (
              <div className="inline-warning">
                <CircleAlert size={16} />
                {t("External work is easiest to operate from a channel bound path. Bind this channel to the repository root before enabling polling.")}
              </div>
            ) : null}

            {externalWorkStatus?.workflow.error ? (
              <div className="inline-error">
                <CircleAlert size={17} />
                {externalWorkStatus.workflow.error}
              </div>
            ) : null}

            {externalWorkStatus?.secret.message ? (
              <div className="inline-warning">
                <ShieldCheck size={16} />
                {externalWorkStatus.secret.message}
              </div>
            ) : null}

            {shouldShowWorkflowSetup ? (
              <div className="external-work-workflow-box">
                <div>
                  <strong>{t("Create WORKFLOW.md")}</strong>
                  <small>{t("Create a minimal local workflow before saving the token. This does not contact GitHub or Linear.")}</small>
                </div>
                <div className="external-work-workflow-form">
                  <label className="field">
                    <span>{t("Source")}</span>
                    <select
                      value={workflowSourceKind}
                      onChange={(event) => setWorkflowSourceKind(event.target.value === "linear" ? "linear" : "github")}
                      disabled={workflowBusy}
                    >
                      <option value="github">{t("GitHub")}</option>
                      <option value="linear">{t("Linear")}</option>
                    </select>
                  </label>
                  {workflowSourceKind === "github" ? (
                    <label className="field">
                      <span>{t("Repository")}</span>
                      <input
                        value={workflowRepository}
                        onChange={(event) => setWorkflowRepository(event.target.value)}
                        placeholder={t("owner/repo or GitHub URL")}
                        disabled={workflowBusy}
                      />
                    </label>
                  ) : (
                    <label className="field">
                      <span>{t("Project slug")}</span>
                      <input
                        value={workflowProjectSlug}
                        onChange={(event) => setWorkflowProjectSlug(event.target.value)}
                        placeholder={t("linear-project")}
                        disabled={workflowBusy}
                      />
                    </label>
                  )}
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void onConfigureExternalWorkWorkflow({
                      sourceKind: workflowSourceKind,
                      repository: workflowSourceKind === "github" ? normalizedWorkflowRepository : undefined,
                      projectSlug: workflowSourceKind === "linear" ? workflowProjectSlug.trim() : undefined,
                    })}
                    disabled={!workflowTargetReady || workflowBusy}
                  >
                    {workflowBusy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                    {externalWorkStatus?.workflow.exists ? t("Repair WORKFLOW.md") : t("Create WORKFLOW.md")}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="external-work-secret-box">
              <div>
                <strong>{t("External token")}</strong>
                <small>
                  {canConfigureSecret
                    ? t("Saved to system Keychain; token value is never shown in Ling.")
                    : t("Create a valid WORKFLOW.md before saving an external token.")}
                </small>
              </div>
              <MetaRow label={t("Secret ref")} value={secretRef ?? t("not configured")} compact />
              <div className="external-work-secret-form">
                <label className="field">
                  <span>{t("Token")}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={externalWorkToken}
                    onChange={(event) => setExternalWorkToken(event.target.value)}
                    placeholder={t(`Paste ${sourceLabel} token`)}
                    disabled={!canConfigureSecret || secretBusy}
                  />
                </label>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    const token = externalWorkToken;
                    setExternalWorkToken("");
                    void onConfigureExternalWorkSecret(token);
                  }}
                  disabled={!canConfigureSecret || !externalWorkToken.trim() || secretBusy}
                >
                  {externalWorkSecretAction === "configure" ? <Loader2 className="spin" size={16} /> : <KeyRound size={16} />}
                  {t(`Save ${sourceLabel} token`)}
                </button>
                {canRemoveSecret ? (
                  <button
                    className="ghost-button danger-ghost-button"
                    type="button"
                    onClick={() => void onDeleteExternalWorkSecret()}
                    disabled={secretBusy}
                  >
                    {externalWorkSecretAction === "delete" ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                    {t("Remove token")}
                  </button>
                ) : null}
              </div>
            </div>

            <div className="external-work-counts">
              <span>{t("External work")}: {externalWorkStatus?.records.externalWork.total ?? 0}</span>
              <span>{t("Ready")}: {externalWorkStatus?.records.externalWork.ready ?? 0}</span>
              <span>{t("CI triage")}: {externalWorkStatus?.records.ciTriage.total ?? 0}</span>
              <span>{t("Actions")}: {externalWorkStatus?.records.actions.total ?? 0}</span>
              <span>{t("Waiting")}: {externalWorkStatus?.records.actions.waitingForApproval ?? 0}</span>
            </div>

            <div className="action-row wrap">
              <button
                className="secondary-button"
                type="button"
                onClick={() => onExternalWorkAction("poll")}
                disabled={!externalWorkStatus?.workflow.valid || externalWorkStatusAction !== undefined}
              >
                {externalWorkStatusAction === "poll" ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                {t("Poll once")}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => onExternalWorkAction("reconcile")}
                disabled={!externalWorkStatus || externalWorkStatusAction !== undefined}
              >
                {externalWorkStatusAction === "reconcile" ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                {t("Reconcile")}
              </button>
              {externalWorkStatus?.workflow.sourceKind === "github" && externalWorkStatus.background.status !== "running" ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onExternalWorkAction("start")}
                  disabled={!externalWorkStatus.workflow.valid || externalWorkStatusAction !== undefined}
                >
                  {externalWorkStatusAction === "start" ? <Loader2 className="spin" size={16} /> : <Power size={16} />}
                  {t("Start background")}
                </button>
              ) : null}
              {externalWorkStatus?.background.status === "running" ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onExternalWorkAction("stop")}
                  disabled={externalWorkStatusAction !== undefined}
                >
                  {externalWorkStatusAction === "stop" ? <Loader2 className="spin" size={16} /> : <PowerOff size={16} />}
                  {t("Stop background")}
                </button>
              ) : null}
              <button className="ghost-button" type="button" onClick={onOpenExternalWorkRecords} disabled={!externalWorkStatus}>
                <Database size={16} />
                {t("View records")}
              </button>
              <button className="ghost-button" type="button" onClick={onOpenExternalWorkTriage} disabled={!externalWorkStatus}>
                <ShieldCheck size={16} />
                {t("View CI triage")}
              </button>
            </div>
          </>
        )}
      </section>
      ) : null}

      {activeSection === "runtime" ? (
      <section className="panel settings-panel runtime-runner-settings-panel" aria-labelledby="runtime-runner-settings-title">
        <div className="panel-title split">
          <span>
            <Bot size={18} />
            <h2 id="runtime-runner-settings-title">{t("Runtime runners")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefreshRuntimeSettings} disabled={runtimeSettingsLoading}>
            {runtimeSettingsLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        {runtimeSettingsError ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {runtimeSettingsError}
          </div>
        ) : null}

        <div className="external-work-status-grid">
          <MetaRow label={t("Default runner")} value={runtimeSettings?.defaultRunnerId ?? "-"} compact />
          <MetaRow label={t("Allowed runners")} value={runtimeSettings?.allowedRunnerIds.join(", ") || "-"} compact />
          <MetaRow label={t("Explicit fallback")} value={runtimeSettings?.explicitRunnerFallback ?? "-"} compact />
          <MetaRow label={t("Implicit fallback")} value={runtimeSettings?.implicitRunnerFallback ?? "-"} compact />
          <MetaRow label={t("Updated")} value={runtimeSettings ? formatDateTime(runtimeSettings.updatedAt) : "-"} compact />
        </div>

        <div className="policy-tool-grid" aria-label={t("Runner settings")}>
          <label className="policy-tool-row">
            <span>{t("Default runner")}</span>
            <select
              value={runtimeSettingsForm.defaultRunnerId}
              onChange={(event) => onRuntimeSettingsFormChange({ ...runtimeSettingsForm, defaultRunnerId: event.target.value })}
              disabled={runtimeSettingsLoading || runtimeSettingsAction !== undefined || enabledRunners.length === 0}
            >
              {enabledRunners.map((runner) => (
                <option key={runner.id} value={runner.id}>{runner.displayName} ({runner.id})</option>
              ))}
            </select>
          </label>
          <label className="policy-tool-row">
            <span>{t("Explicit fallback")}</span>
            <select
              value={runtimeSettingsForm.explicitRunnerFallback}
              onChange={(event) => onRuntimeSettingsFormChange({
                ...runtimeSettingsForm,
                explicitRunnerFallback: event.target.value as RuntimeSettingsFormState["explicitRunnerFallback"],
              })}
              disabled={runtimeSettingsAction !== undefined}
            >
              <option value="disabled">{t("Disabled")}</option>
              <option value="allow_to_default">{t("Allow to default")}</option>
            </select>
          </label>
          <label className="policy-tool-row">
            <span>{t("Implicit fallback")}</span>
            <select
              value={runtimeSettingsForm.implicitRunnerFallback}
              onChange={(event) => onRuntimeSettingsFormChange({
                ...runtimeSettingsForm,
                implicitRunnerFallback: event.target.value as RuntimeSettingsFormState["implicitRunnerFallback"],
              })}
              disabled={runtimeSettingsAction !== undefined}
            >
              <option value="disabled">{t("Disabled")}</option>
              <option value="allow_to_default">{t("Allow to default")}</option>
            </select>
          </label>
        </div>

        <div className="runtime-list">
          {runners.length === 0 ? (
            <div className="empty-state compact-empty">
              {runtimeSettingsLoading ? <Loader2 className="spin" /> : <Bot />}
              <span>{runtimeSettingsLoading ? t("Loading runners...") : t("No runners registered")}</span>
            </div>
          ) : (
            runners.map((runner) => (
              <label key={runner.id} className="runtime-list-row">
                <input
                  type="checkbox"
                  checked={runtimeSettingsForm.allowedRunnerIds.includes(runner.id)}
                  onChange={(event) => onToggleAllowedRunner(runner.id, event.target.checked)}
                  disabled={runner.status !== "enabled" || runtimeSettingsAction !== undefined}
                />
                <StatusBadge status={runner.status} />
                <span>{runner.displayName}</span>
                <small>
                  {runner.id}
                  {runner.featureFlag ? ` · ${runner.featureFlag}` : ""}
                  {runner.disabledReason ? ` · ${runner.disabledReason}` : ""}
                </small>
              </label>
            ))
          )}
        </div>

        <div className="action-row">
          <button
            className="primary-button"
            type="button"
            onClick={onSaveRuntimeSettings}
            disabled={runtimeSettingsAction !== undefined || runtimeSettingsLoading || enabledRunners.length === 0}
          >
            {runtimeSettingsAction === "save" ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            {t("Save runtime settings")}
          </button>
        </div>
      </section>
      ) : null}

      {activeSection === "approval-policy" ? (
      <section className="panel settings-panel" aria-labelledby="settings-title">
      <div className="panel-title split">
        <span>
          <Settings size={18} />
          <h2 id="settings-title">{t("Approval policy")}</h2>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          {t("Refresh")}
        </button>
      </div>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      <div className="permission-preset-card-grid" aria-label={t("Permission preset")}>
        {permissionPresetOptions.map((preset) => (
          <button
            key={preset}
            className={resolvedPermissionPreset === preset ? "permission-preset-card active" : "permission-preset-card"}
            type="button"
            onClick={() => onPermissionModeChange(permissionModeForPreset(preset))}
            aria-pressed={resolvedPermissionPreset === preset}
          >
            <strong>{permissionPresetLabel(preset, t)}</strong>
            <small>{permissionPresetDescription(preset, t)}</small>
          </button>
        ))}
      </div>

      <div className="permission-preview-card" aria-label={t("Effective permissions")}>
        <div>
          <strong>{t("Effective permissions")}</strong>
          <small>{t("This preview follows the selected preset and approval policy form. Save policy to apply advanced policy edits.")}</small>
        </div>
        <div className="permission-preview-list">
          {policyPreviewRows.map((row) => (
            <span key={row}>{row}</span>
          ))}
        </div>
      </div>

      <div className="policy-meta">
        <MetaRow label={t("Updated")} value={policy ? formatDateTime(policy.updatedAt) : "-"} compact />
        <MetaRow label={t("Selected preset")} value={permissionPresetLabel(resolvedPermissionPreset, t)} compact />
      </div>

      <details className="advanced-settings" open={resolvedPermissionPreset === "custom"}>
        <summary>{t("Advanced workspace policy")}</summary>
        <div className="policy-tool-grid" aria-label={t("Tool approval decisions")}>
          {allTools.map((tool) => (
            <label key={tool} className={`policy-tool-row${riskyTools.includes(tool) ? " risky" : ""}`}>
              <span>{tool}</span>
              <select
                value={form.toolDecisions[tool]}
                onChange={(event) => {
                  onPermissionModeChange(permissionModeForPreset("custom"));
                  onFormChange({
                    ...form,
                    toolDecisions: {
                      ...form.toolDecisions,
                      [tool]: event.target.value as ApprovalToolDecision,
                    },
                  });
                }}
              >
                <option value="allow">{t("Allow")}</option>
                <option value="ask">{t("Ask")}</option>
                <option value="deny">{t("Deny")}</option>
              </select>
            </label>
          ))}
        </div>
        <label className="field wide">
          <span>{t("Allowed write paths")}</span>
          <textarea
            value={form.allowedWritePathsText}
            onChange={(event) => {
              onPermissionModeChange(permissionModeForPreset("custom"));
              onFormChange({ ...form, allowedWritePathsText: event.target.value });
            }}
          />
        </label>
      </details>

      <div className="action-row">
        <button className="primary-button" type="button" onClick={onSave} disabled={isLoading}>
          {isLoading ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          {t("Save policy")}
        </button>
      </div>
      </section>
      ) : null}
      {activeSection === "skill-library" ? <SkillLibrarySettingsPanel cwd={cwd} refreshToken={skillLibraryRefreshToken} /> : null}
      {activeSection === "mcp" ? (
        <McpToolsPage
          servers={mcpServers}
          tools={mcpTools}
          isLoading={mcpLoading}
          busyServerId={mcpBusyServerId}
          busyAction={mcpBusyAction}
          errorMessage={errorMessage}
          cwd={cwd}
          onRefresh={onRefreshMcp}
          onCreate={onCreateMcpServer}
          onUpdate={onUpdateMcpServer}
          onDelete={onDeleteMcpServer}
          onCheck={onCheckMcpServer}
          onSyncTools={onSyncMcpTools}
        />
      ) : null}
      {activeSection === "plugins" ? (
        <PluginManagerSettingsPanel
          cwd={cwd}
          plugins={plugins}
          isLoading={pluginsLoading}
          busyPluginId={pluginBusyId}
          busyAction={pluginBusyAction}
          latestApplyResult={latestPluginApplyResult}
          latestRuntimePreview={latestPluginRuntimePreview}
          latestNotice={latestPluginNotice}
          onRefresh={onRefreshPlugins}
          onApplyPreset={onApplyPluginPreset}
          onCheck={onCheckPlugin}
          onValidatePackage={onValidatePluginPackage}
          onInstall={onInstallPlugin}
          onUninstall={onUninstallPlugin}
          onRefreshPackage={onRefreshPluginPackage}
          onRuntimePreview={onPreviewPluginRuntime}
          onEnable={onEnablePlugin}
          onDisable={onDisablePlugin}
          onOpenMcpSettings={() => {
            onRefreshMcp();
            setActiveSection("mcp");
          }}
        />
      ) : null}
      {activeSection === "developer" ? (
        <section className="panel settings-panel developer-settings-panel" aria-labelledby="developer-settings-title">
          <div className="panel-title">
            <Database size={18} />
            <h2 id="developer-settings-title">{t("Developer")}</h2>
          </div>
          <div className="external-work-secret-box">
            <div>
              <strong>{t("Run Diagnostics")}</strong>
              <small>{t("Inspect raw runs, events, artifacts, approvals, shell snapshots, and thread bindings for support debugging.")}</small>
            </div>
            <button className="secondary-button" type="button" onClick={onOpenRunDiagnostics}>
              <Database size={16} />
              {t("Open Run Diagnostics")}
            </button>
          </div>
        </section>
      ) : null}
      </div>
    </div>
  );
}

function workflowStatusLabel(status: ExternalWorkStatusResponse | undefined): string {
  if (!status) {
    return "not loaded";
  }
  if (!status.workflow.exists) {
    return "missing";
  }
  return status.workflow.valid ? "valid" : "invalid";
}

function externalWorkTargetLabel(status: ExternalWorkStatusResponse | undefined): string {
  if (!status) {
    return "not configured";
  }
  return status.workflow.repository ?? status.workflow.projectSlug ?? "not configured";
}

function normalizeGitHubRepositoryInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (url.hostname !== "github.com") {
        return undefined;
      }
      const [owner, repo] = url.pathname.split("/").filter(Boolean);
      candidate = owner && repo ? `${owner}/${repo}` : "";
    } catch {
      return undefined;
    }
  } else if (candidate.startsWith("git@github.com:")) {
    candidate = candidate.slice("git@github.com:".length);
  } else if (candidate.startsWith("github.com/")) {
    candidate = candidate.slice("github.com/".length);
  }

  candidate = candidate.replace(/\.git$/i, "").replace(/\/+$/g, "");
  const [owner, repo, ...extra] = candidate.split("/");
  if (!owner || !repo || extra.length > 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return undefined;
  }
  return `${owner}/${repo}`;
}
