import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
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
import {
  deleteChannel,
  deleteChannelBranch,
  listChannelBranches,
  listChannels,
  patchChannel,
  updateChannelBranch,
} from "../../api/channels.js";
import { LanguageSwitcher, useI18n, type Translate } from "../../i18n.js";
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
  ChannelBranch,
  ExternalWorkStatusResponse,
  EffectiveConfigResponse,
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
  ResponseLanguagePreference,
  StartupStatusResponse,
} from "../../types.js";
import { SkillLibrarySettingsPanel } from "./SkillLibrarySettingsPanel.js";
import { PluginManagerSettingsPanel } from "./PluginManagerSettingsPanel.js";
import type { PluginActionNotice, PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { McpToolsPage } from "../mcp/McpToolsPage.js";
import type { McpBusyAction } from "../../domains/mcp/use-mcp-domain.js";

type SettingsSection = "startup" | "external-work" | "interface" | "archived-items" | "runtime" | "approval-policy" | "skill-library" | "mcp" | "plugins" | "developer";

export function SettingsPage({
  cwd,
  policy,
  form,
  runners,
  runtimeSettings,
  runtimeSettingsForm,
  skillLibraryRefreshToken,
  effectiveConfig,
  startupStatus,
  workspaceResponseLanguage,
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
  startupStatusLoading,
  startupStatusAction,
  startupStatusError,
  externalWorkStatusLoading,
  externalWorkStatusAction,
  externalWorkSecretAction,
  externalWorkWorkflowAction,
  errorMessage,
  onFormChange,
  onPermissionModeChange,
  onRefresh,
  onSave,
  onWorkspaceResponseLanguageChange,
  onRefreshStartup,
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
  onOpenChannelProtocol,
  onRefreshMcp,
  onArchivedItemsChanged,
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
  readonly effectiveConfig: EffectiveConfigResponse | undefined;
  readonly startupStatus: StartupStatusResponse | undefined;
  readonly workspaceResponseLanguage: ResponseLanguagePreference;
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
  readonly startupStatusLoading: boolean;
  readonly startupStatusAction: "refresh" | undefined;
  readonly startupStatusError: string;
  readonly externalWorkStatusLoading: boolean;
  readonly externalWorkStatusAction: "poll" | "reconcile" | "start" | "stop" | undefined;
  readonly externalWorkSecretAction: "configure" | "delete" | undefined;
  readonly externalWorkWorkflowAction: "configure" | undefined;
  readonly errorMessage: string;
  readonly onFormChange: (form: ApprovalPolicyFormState) => void;
  readonly onPermissionModeChange: (mode: SessionPermissionMode) => void;
  readonly onRefresh: () => void;
  readonly onSave: () => void;
  readonly onWorkspaceResponseLanguageChange: (language: ResponseLanguagePreference) => void;
  readonly onRefreshStartup: () => void;
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
  readonly onOpenChannelProtocol: () => void;
  readonly onRefreshMcp: () => void;
  readonly onArchivedItemsChanged?: () => void | Promise<void>;
  readonly onCreateMcpServer: (form: McpServerFormState) => Promise<void>;
  readonly onUpdateMcpServer: (serverId: string, form: McpServerFormState) => Promise<void>;
  readonly onDeleteMcpServer: (serverId: string) => void;
  readonly onCheckMcpServer: (serverId: string) => boolean | Promise<boolean> | void | Promise<void>;
  readonly onSyncMcpTools: (serverId: string) => boolean | Promise<boolean> | void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const [externalWorkToken, setExternalWorkToken] = useState("");
  const [activeSection, setActiveSection] = useState<SettingsSection>("startup");
  const [workflowSourceKind, setWorkflowSourceKind] = useState<"github" | "linear">("github");
  const [workflowRepository, setWorkflowRepository] = useState("");
  const [workflowProjectSlug, setWorkflowProjectSlug] = useState("");
  const [archivedChannels, setArchivedChannels] = useState<readonly Channel[]>([]);
  const [archiveParentChannels, setArchiveParentChannels] = useState<readonly Channel[]>([]);
  const [archivedBranches, setArchivedBranches] = useState<readonly ChannelBranch[]>([]);
  const [archivedItemsLoading, setArchivedItemsLoading] = useState(false);
  const [archivedItemsError, setArchivedItemsError] = useState("");
  const [archivedItemAction, setArchivedItemAction] = useState("");
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

  useEffect(() => {
    if (activeSection === "archived-items") {
      void refreshArchivedItems();
    }
  }, [activeSection, cwd]);

  async function refreshArchivedItems(): Promise<void> {
    if (!cwd.trim()) {
      setArchivedChannels([]);
      setArchiveParentChannels([]);
      setArchivedBranches([]);
      return;
    }
    setArchivedItemsLoading(true);
    setArchivedItemsError("");
    try {
      const [activeChannelsResponse, archivedChannelsResponse] = await Promise.all([
        listChannels(cwd, { archived: false, limit: 500 }),
        listChannels(cwd, { archived: true, limit: 500 }),
      ]);
      const parentChannels = [...activeChannelsResponse.channels, ...archivedChannelsResponse.channels];
      const branchResponses = await Promise.all(
        parentChannels.map((channel) =>
          listChannelBranches(cwd, channel.id, { archived: true, limit: 500 })
            .catch(() => ({ cwd, channelId: channel.id, branches: [] as ChannelBranch[] })),
        ),
      );
      setArchivedChannels(archivedChannelsResponse.channels);
      setArchiveParentChannels(parentChannels);
      setArchivedBranches(branchResponses.flatMap((response) => response.branches));
    } catch (caught) {
      setArchivedItemsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setArchivedItemsLoading(false);
    }
  }

  async function restoreArchivedChannel(channelId: string): Promise<void> {
    await runArchivedItemAction(`channel:${channelId}:restore`, async () => {
      await patchChannel(cwd, channelId, { status: "active" });
      await refreshArchivedItems();
      await onArchivedItemsChanged?.();
    });
  }

  async function deleteArchivedChannel(channel: Channel): Promise<void> {
    if (!window.confirm(`${t("Delete channel")} ${channel.name}?\n${t("This cannot be undone")}`)) {
      return;
    }
    await runArchivedItemAction(`channel:${channel.id}:delete`, async () => {
      await deleteChannel(cwd, channel.id);
      await refreshArchivedItems();
      await onArchivedItemsChanged?.();
    });
  }

  async function restoreArchivedBranch(branch: ChannelBranch): Promise<void> {
    const parent = archiveParentChannels.find((channel) => channel.id === branch.channelId);
    await runArchivedItemAction(`branch:${branch.id}:restore`, async () => {
      if (parent?.status === "archived") {
        await patchChannel(cwd, branch.channelId, { status: "active" });
      }
      await updateChannelBranch(cwd, branch.channelId, branch.id, { status: "active" });
      await refreshArchivedItems();
      await onArchivedItemsChanged?.();
    });
  }

  async function deleteArchivedBranch(branch: ChannelBranch): Promise<void> {
    if (!window.confirm(`${t("Delete branch")} ${branch.name}?\n${t("This cannot be undone")}`)) {
      return;
    }
    await runArchivedItemAction(`branch:${branch.id}:delete`, async () => {
      await deleteChannelBranch(cwd, branch.channelId, branch.id);
      await refreshArchivedItems();
      await onArchivedItemsChanged?.();
    });
  }

  async function runArchivedItemAction(actionId: string, action: () => Promise<void>): Promise<void> {
    setArchivedItemAction(actionId);
    setArchivedItemsError("");
    try {
      await action();
    } catch (caught) {
      setArchivedItemsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setArchivedItemAction("");
    }
  }

  const archiveParentChannelById = new Map(archiveParentChannels.map((channel) => [channel.id, channel]));

  return (
    <div className="settings-layout">
      <nav className="settings-section-nav" aria-label={t("Settings sections")}>
        <button
          className={activeSection === "startup" ? "settings-section-item active" : "settings-section-item"}
          type="button"
          onClick={() => setActiveSection("startup")}
        >
          <span className="settings-section-icon"><Power size={16} /></span>
          <span>
            <strong>{t("Startup readiness")}</strong>
            <small>{startupStatus ? startupStatusLabel(startupStatus, t) : startupStatusLoading ? t("Loading") : t("not loaded")}</small>
          </span>
        </button>
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
          className={activeSection === "archived-items" ? "settings-section-item active" : "settings-section-item"}
          type="button"
          onClick={() => setActiveSection("archived-items")}
        >
          <span className="settings-section-icon"><Archive size={16} /></span>
          <span>
            <strong>{t("Archived items")}</strong>
            <small>{t("{count} recoverable", { count: archivedChannels.length + archivedBranches.length })}</small>
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
      {activeSection === "startup" ? (
      <section className="panel settings-panel startup-settings-panel" aria-labelledby="startup-settings-title">
        <div className="panel-title split">
          <span>
            <Power size={18} />
            <h2 id="startup-settings-title">{t("Startup readiness")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefreshStartup} disabled={startupStatusLoading}>
            {startupStatusAction === "refresh" || startupStatusLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        {startupStatusError ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {startupStatusError}
          </div>
        ) : null}

        <div className="startup-summary-grid">
          <MetaRow label={t("Workspace")} value={startupStatus?.cwd ?? cwd} compact />
          <MetaRow label={t("State")} value={startupStatus ? startupStatusLabel(startupStatus, t) : startupStatusLoading ? t("Loading") : t("not loaded")} compact />
          <MetaRow label={t("Attempt")} value={startupStatus?.startupAttemptId ?? "-"} compact />
          <MetaRow label={t("Effective config")} value={startupStatus?.effectiveConfigLoadedAt ? formatDateTime(startupStatus.effectiveConfigLoadedAt) : "-"} compact />
        </div>

        <div className="startup-phase-grid" aria-label={t("Startup phases")}>
          {STARTUP_REQUIRED_PHASES.map((phase) => (
            <StartupPhaseRow key={phase} phase={phase} status={startupStatus?.phases[phase] ?? "not_started"} required t={t} />
          ))}
        </div>

        <div className="startup-warmup-list" aria-label={t("Warmup phases")}>
          {STARTUP_OPTIONAL_PHASES.map((phase) => (
            <StartupPhaseRow key={phase} phase={phase} status={startupStatus?.phases[phase] ?? "not_started"} t={t} />
          ))}
        </div>

        {startupStatus?.diagnostics.length ? (
          <div className="startup-diagnostic-list">
            {startupStatus.diagnostics.slice(0, 8).map((diagnostic) => (
              <div key={`${diagnostic.phase}:${diagnostic.code}:${diagnostic.message}`} className={`startup-diagnostic ${diagnostic.level}`}>
                <div>
                  <strong>{diagnostic.phase} / {diagnostic.code}{diagnostic.count && diagnostic.count > 1 ? ` x${diagnostic.count}` : ""}</strong>
                  <span>{diagnostic.message}</span>
                </div>
                {diagnostic.nextAction ? <small>{diagnostic.nextAction}</small> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty startup-empty">
            {startupStatusLoading ? <Loader2 className="spin" /> : <ShieldCheck />}
            <span>{startupStatusLoading ? t("Loading startup status...") : t("No startup diagnostics")}</span>
          </div>
        )}
      </section>
      ) : null}

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
              <small>{configSourceLabel(effectiveConfig?.values.theme.source, t)}</small>
            </span>
            <ThemeSwitcher />
          </div>
          <div className="interface-preference-row">
            <span>
              <Languages size={16} />
              <strong>{t("Language")}</strong>
              <small>{configSourceLabel(effectiveConfig?.values.locale.source, t)}</small>
            </span>
            <LanguageSwitcher />
          </div>
          <div className="interface-preference-row">
            <span>
              <Bot size={16} />
              <strong>{t("AI response language")}</strong>
              <small>{configSourceLabel(effectiveConfig?.values.responseLanguage.source, t)}</small>
            </span>
            <select
              value={workspaceResponseLanguage}
              onChange={(event) => onWorkspaceResponseLanguageChange(event.target.value as ResponseLanguagePreference)}
              aria-label={t("AI response language")}
            >
              <option value="follow_user">{t("Follow user message")}</option>
              <option value="zh-CN">{t("Chinese")}</option>
              <option value="en-US">{t("English")}</option>
            </select>
          </div>
          <div className="interface-preference-row">
            <span>
              <ShieldCheck size={16} />
              <strong>{t("Channel protocol")}</strong>
              <small>{selectedChannel ? selectedChannel.name : t("No channel selected")}</small>
            </span>
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={onOpenChannelProtocol}
              disabled={!selectedChannel}
            >
              {t("Open editor")}
            </button>
          </div>
        </div>
      </section>
      ) : null}

      {activeSection === "archived-items" ? (
      <section className="panel settings-panel archived-items-settings-panel" aria-labelledby="archived-items-settings-title">
        <div className="panel-title split">
          <span>
            <Archive size={18} />
            <h2 id="archived-items-settings-title">{t("Archived channels and branches")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={() => void refreshArchivedItems()} disabled={archivedItemsLoading}>
            {archivedItemsLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        {archivedItemsError ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {archivedItemsError}
          </div>
        ) : null}

        <div className="archived-items-copy">
          {t("Restore returns an item to the channel drawer. Delete is permanent and requires confirmation.")}
        </div>

        <ArchivedItemGroup
          title={t("Channels")}
          countLabel={t("{count} archived", { count: archivedChannels.length })}
          emptyLabel={archivedItemsLoading ? t("Loading archived channels...") : t("No archived channels")}
        >
          {archivedChannels.map((channel) => (
            <div key={channel.id} className="archived-item-row">
              <div className="archived-item-main">
                <strong>{channel.name}</strong>
                <small>{t("Archived")} · {formatDateTime(channel.updatedAt)}</small>
              </div>
              <div className="archived-item-actions">
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={() => void restoreArchivedChannel(channel.id)}
                  disabled={archivedItemAction !== ""}
                >
                  {archivedItemAction === `channel:${channel.id}:restore` ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  {t("Restore")}
                </button>
                <button
                  className="ghost-button danger-ghost-button compact-button"
                  type="button"
                  onClick={() => void deleteArchivedChannel(channel)}
                  disabled={archivedItemAction !== ""}
                >
                  {archivedItemAction === `channel:${channel.id}:delete` ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
                  {t("Delete")}
                </button>
              </div>
            </div>
          ))}
        </ArchivedItemGroup>

        <ArchivedItemGroup
          title={t("Branches")}
          countLabel={t("{count} archived", { count: archivedBranches.length })}
          emptyLabel={archivedItemsLoading ? t("Loading archived branches...") : t("No archived branches")}
        >
          {archivedBranches.map((branch) => {
            const parent = archiveParentChannelById.get(branch.channelId);
            const parentArchived = parent?.status === "archived";
            return (
              <div key={branch.id} className="archived-item-row">
                <div className="archived-item-main">
                  <strong>{parent ? `${parent.name} / ${branch.name}` : branch.name}</strong>
                  <small>{parentArchived ? t("Parent channel archived") : t("Parent channel active")} · {formatDateTime(branch.archivedAt ?? branch.updatedAt)}</small>
                </div>
                <div className="archived-item-actions">
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={() => void restoreArchivedBranch(branch)}
                    disabled={archivedItemAction !== ""}
                  >
                    {archivedItemAction === `branch:${branch.id}:restore` ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                    {parentArchived ? t("Restore both") : t("Restore")}
                  </button>
                  <button
                    className="ghost-button danger-ghost-button compact-button"
                    type="button"
                    onClick={() => void deleteArchivedBranch(branch)}
                    disabled={archivedItemAction !== ""}
                  >
                    {archivedItemAction === `branch:${branch.id}:delete` ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
                    {t("Delete")}
                  </button>
                </div>
              </div>
            );
          })}
        </ArchivedItemGroup>
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

const STARTUP_REQUIRED_PHASES = [
  "process_config",
  "user_config",
  "workspace_store",
  "effective_config",
  "runtime_policy",
  "secret_resolver",
] as const;

const STARTUP_OPTIONAL_PHASES = [
  "provider_warmup",
  "automation_scheduler",
  "external_work_scheduler",
  "plugin_warmup",
] as const;

function StartupPhaseRow({
  phase,
  status,
  required,
  t,
}: {
  readonly phase: string;
  readonly status: string;
  readonly required?: boolean;
  readonly t: Translate;
}): JSX.Element {
  return (
    <div className={`startup-phase-row ${startupPhaseTone(status)}`}>
      <span>
        <strong>{phase}</strong>
        <small>{required ? t("Required") : t("Warmup")}</small>
      </span>
      <StatusBadge status={status} />
    </div>
  );
}

function startupStatusLabel(status: StartupStatusResponse, t: Translate): string {
  if (status.state === "ready") {
    return t("ready");
  }
  if (status.state === "degraded") {
    return t("degraded");
  }
  if (status.state === "failed") {
    return t("failed");
  }
  return t("starting");
}

function startupPhaseTone(status: string): string {
  if (status === "ready") {
    return "ready";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "degraded") {
    return "degraded";
  }
  return "loading";
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

function configSourceLabel(source: EffectiveConfigResponse["values"]["theme"]["source"] | undefined, t: Translate): string {
  if (source === "workspace") {
    return t("Workspace");
  }
  if (source === "user") {
    return t("User default");
  }
  if (source === "built_in") {
    return t("Built-in");
  }
  return t("Loading");
}

function ArchivedItemGroup({
  title,
  countLabel,
  emptyLabel,
  children,
}: {
  readonly title: string;
  readonly countLabel: string;
  readonly emptyLabel: string;
  readonly children: ReactNode;
}): JSX.Element {
  const hasItems = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="archived-item-group">
      <div className="archived-item-group-head">
        <strong>{title}</strong>
        <small>{countLabel}</small>
      </div>
      <div className="archived-item-list">
        {hasItems ? children : (
          <div className="empty-state compact-empty archived-item-empty">
            <Archive />
            <span>{emptyLabel}</span>
          </div>
        )}
      </div>
    </section>
  );
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
