import { type ReactNode, useState } from "react";
import {
  Archive,
  ArrowLeft,
  BookOpen,
  Bot,
  Box,
  Brain,
  Database,
  GitBranch,
  Kanban,
  Palette,
  PlugZap,
  Shield,
  SlidersHorizontal,
  UserCircle,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { RuntimeSettingsFormState } from "../../domains/settings/use-settings-domain.js";
import type { McpBusyAction } from "../../domains/mcp/use-mcp-domain.js";
import type { PluginActionNotice, PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { useI18n } from "../../i18n.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyFormState,
  Channel,
  EffectiveConfigResponse,
  ExternalWorkStatusResponse,
  ManagedPluginApplyPresetResponse,
  ManagedPluginRuntimePreviewResponse,
  ManagedPluginView,
  McpServer,
  McpServerFormState,
  McpTool,
  PermissionPreset,
  ResponseLanguagePreference,
  RunnerListItem,
  RunSession,
  SessionPermissionMode,
  StartupStatusResponse,
  UserProfile,
  WorkspaceRuntimeSettings,
} from "../../types.js";
import { McpToolsPage } from "../mcp/McpToolsPage.js";
import { ArchivedSettingsPanel } from "./ArchivedSettingsPanel.js";
import { ExecutionPermissionsSettingsPanel } from "./ExecutionPermissionsSettingsPanel.js";
import { ExternalWorkSettingsPanel } from "./ExternalWorkSettingsPanel.js";
import { StartupDiagnosticsSettingsPanel } from "./MaintenanceSettingsPanel.js";
import { InterfacePreferencesSettingsPanel, PersonalSettingsPanel } from "./PersonalInterfaceSettingsPanel.js";
import { PersonalizationSettingsPanel } from "./PersonalizationSettingsPanel.js";
import { PluginManagerSettingsPanel } from "./PluginManagerSettingsPanel.js";
import { SettingsRunDiagnosticsPanel } from "./SettingsRunDiagnosticsPanel.js";
import { SkillLibrarySettingsPanel } from "./SkillLibrarySettingsPanel.js";
import { useArchivedSettingsController } from "./useArchivedSettingsController.js";

type SettingsSectionId =
  | "model-workbench"
  | "ai-teammates"
  | "ai-councils"
  | "work-board"
  | "approval-strategy"
  | "personal-profile"
  | "personalization"
  | "interface-preferences"
  | "external-work"
  | "mcp-tools"
  | "plugin-manager"
  | "skill-library"
  | "archived-items"
  | "startup-diagnostics";

type SettingsWorkspaceToolView = "" | "providers" | "teammates" | "councils" | "work_board";

type SettingsSectionItem = {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly pageTitle?: string;
  readonly description?: string;
  readonly icon: LucideIcon;
};

const settingsSectionGroups: readonly {
  readonly heading?: string;
  readonly items: readonly SettingsSectionItem[];
}[] = [
  {
    heading: "Workspace tools",
    items: [
      {
        id: "model-workbench",
        label: "Model Workbench",
        icon: Box,
      },
      {
        id: "ai-teammates",
        label: "Teammate Management",
        icon: Bot,
      },
      {
        id: "ai-councils",
        pageTitle: "Council Workspace",
        label: "Council Workspace",
        icon: Brain,
      },
      {
        id: "work-board",
        label: "Work Board",
        icon: Kanban,
      },
      {
        id: "approval-strategy",
        label: "Default authorization",
        icon: Shield,
      },
    ],
  },
  {
    heading: "Workspace",
    items: [
      {
        id: "personal-profile",
        label: "Profile",
        icon: UserCircle,
      },
      {
        id: "personalization",
        label: "Personalization",
        description: "Ling tone and skill generation policy",
        icon: SlidersHorizontal,
      },
      {
        id: "interface-preferences",
        label: "Interface preferences",
        icon: Palette,
      },
      {
        id: "external-work",
        label: "External work",
        icon: GitBranch,
      },
      {
        id: "mcp-tools",
        label: "MCP tool servers",
        icon: Wrench,
      },
      {
        id: "plugin-manager",
        label: "Plugin Manager",
        icon: PlugZap,
      },
      {
        id: "skill-library",
        label: "Skill library",
        description: "Inspect reusable skill definitions, source health, and workspace skills.",
        icon: BookOpen,
      },
    ],
  },
  {
    heading: "Maintenance",
    items: [
      {
        id: "archived-items",
        label: "Archived items",
        icon: Archive,
      },
      {
        id: "startup-diagnostics",
        label: "Startup and diagnostics",
        icon: Database,
      },
    ],
  },
];

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
  workspaceDefaultPermissionMode,
  workspaceDefaultPermissionPreset,
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
  onWorkspaceDefaultPermissionChange,
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
  onCloseRunDiagnostics,
  onSelectRunDiagnostics,
  onOpenFullRunDiagnostics,
  onRefreshMcp,
  onArchivedItemsChanged,
  onCreateMcpServer,
  onUpdateMcpServer,
  onDeleteMcpServer,
  onCheckMcpServer,
  onSyncMcpTools,
  onProfileChange,
  onOpenProviders,
  onOpenTeammates,
  onOpenCouncils,
  onOpenWorkBoard,
  workspaceToolDetail,
  workspaceToolView,
  runDiagnosticsRunId,
  runs,
  runsLoading,
  onCloseWorkspaceTool,
  onBackToApplication,
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
  readonly workspaceDefaultPermissionMode?: SessionPermissionMode;
  readonly workspaceDefaultPermissionPreset?: PermissionPreset;
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
  readonly onWorkspaceDefaultPermissionChange: (mode: SessionPermissionMode, preset: PermissionPreset) => void;
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
  readonly onCloseRunDiagnostics: () => void;
  readonly onSelectRunDiagnostics: (runId: string) => void;
  readonly onOpenFullRunDiagnostics: (runId?: string) => void;
  readonly onRefreshMcp: () => void;
  readonly onArchivedItemsChanged?: () => void | Promise<void>;
  readonly onCreateMcpServer: (form: McpServerFormState) => Promise<void>;
  readonly onUpdateMcpServer: (serverId: string, form: McpServerFormState) => Promise<void>;
  readonly onDeleteMcpServer: (serverId: string) => void;
  readonly onCheckMcpServer: (serverId: string) => boolean | Promise<boolean> | void | Promise<void>;
  readonly onSyncMcpTools: (serverId: string) => boolean | Promise<boolean> | void | Promise<void>;
  readonly onProfileChange?: (profile: UserProfile) => void;
  readonly onOpenProviders: () => void;
  readonly onOpenTeammates: () => void;
  readonly onOpenCouncils: () => void;
  readonly onOpenWorkBoard: () => void;
  readonly workspaceToolDetail?: ReactNode;
  readonly workspaceToolView?: SettingsWorkspaceToolView;
  readonly runDiagnosticsRunId?: string;
  readonly runs: readonly RunSession[];
  readonly runsLoading: boolean;
  readonly onCloseWorkspaceTool?: () => void;
  readonly onBackToApplication?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("personal-profile");
  const runDiagnosticsOpen = runDiagnosticsRunId !== undefined;
  const workspaceToolDetailOpen = !runDiagnosticsOpen && workspaceToolDetail !== undefined && workspaceToolDetail !== null;
  const workspaceToolSection = workspaceToolViewToSectionId(workspaceToolView);
  const visibleActiveSection = runDiagnosticsOpen
    ? "startup-diagnostics"
    : workspaceToolDetailOpen && workspaceToolSection
      ? workspaceToolSection
      : isWorkspaceToolSection(activeSection)
        ? "personal-profile"
        : activeSection;
  const archivedController = useArchivedSettingsController({
    cwd,
    enabled: visibleActiveSection === "archived-items",
    onChanged: onArchivedItemsChanged,
  });

  const selectSettingsSection = (sectionId: SettingsSectionId): void => {
    setActiveSection(sectionId);
    onCloseRunDiagnostics();
    if (sectionId === "model-workbench") {
      onOpenProviders();
      return;
    }
    if (sectionId === "ai-teammates") {
      onOpenTeammates();
      return;
    }
    if (sectionId === "ai-councils") {
      onOpenCouncils();
      return;
    }
    if (sectionId === "work-board") {
      onOpenWorkBoard();
      return;
    }
    onCloseWorkspaceTool?.();
  };

  return (
    <div className="settings-layout">
      <nav className="settings-section-nav" aria-label={t("Settings sections")}>
        {onBackToApplication ? (
          <button className="settings-app-return-button" type="button" onClick={onBackToApplication}>
            <ArrowLeft size={17} />
            <span>{t("Back to app")}</span>
          </button>
        ) : null}
        {settingsSectionGroups.map((group, groupIndex) => (
          <div key={group.heading ?? `primary-${groupIndex}`} className="settings-section-group">
            {group.heading ? <span className="settings-section-group-label">{t(group.heading)}</span> : null}
            {group.items.map((item) => {
              const SectionIcon = item.icon;
              return (
                <button
                  key={item.id}
                  className={visibleActiveSection === item.id ? "settings-section-item active" : "settings-section-item"}
                  type="button"
                  onClick={() => {
                    selectSettingsSection(item.id);
                  }}
                  title={t(item.pageTitle ?? item.label)}
                  aria-current={visibleActiveSection === item.id ? "page" : undefined}
                >
                  <SectionIcon className="settings-section-icon" size={16} strokeWidth={2} aria-hidden="true" />
                  <span>{t(item.label)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="settings-content-stack">
        {runDiagnosticsOpen ? (
          <SettingsRunDiagnosticsPanel
            runs={runs}
            selectedRunId={runDiagnosticsRunId ?? ""}
            isLoading={runsLoading}
            errorMessage={errorMessage}
            onRefresh={onOpenRunDiagnostics}
            onSelectRun={onSelectRunDiagnostics}
            onOpenFullDiagnostics={onOpenFullRunDiagnostics}
            onClose={onCloseRunDiagnostics}
          />
        ) : null}

        {workspaceToolDetailOpen ? workspaceToolDetail : null}

        {visibleActiveSection === "personal-profile" && !workspaceToolDetailOpen ? (
          <PersonalSettingsPanel cwd={cwd} onProfileChange={onProfileChange} />
        ) : null}

        {visibleActiveSection === "personalization" && !workspaceToolDetailOpen ? <PersonalizationSettingsPanel cwd={cwd} /> : null}

        {visibleActiveSection === "interface-preferences" && !workspaceToolDetailOpen ? (
          <InterfacePreferencesSettingsPanel
            effectiveConfig={effectiveConfig}
            workspaceResponseLanguage={workspaceResponseLanguage}
            onWorkspaceResponseLanguageChange={onWorkspaceResponseLanguageChange}
          />
        ) : null}

        {visibleActiveSection === "approval-strategy" && !workspaceToolDetailOpen ? (
          <ExecutionPermissionsSettingsPanel
            policy={policy}
            form={form}
            runners={runners}
            runtimeSettings={runtimeSettings}
            runtimeSettingsForm={runtimeSettingsForm}
            selectedChannel={selectedChannel}
            workspaceDefaultPermissionMode={workspaceDefaultPermissionMode}
            workspaceDefaultPermissionPreset={workspaceDefaultPermissionPreset}
            permissionMode={permissionMode}
            permissionPreset={permissionPreset}
            isLoading={isLoading}
            runtimeSettingsLoading={runtimeSettingsLoading}
            runtimeSettingsAction={runtimeSettingsAction}
            runtimeSettingsError={runtimeSettingsError}
            errorMessage={errorMessage}
            onFormChange={onFormChange}
            onPermissionModeChange={onPermissionModeChange}
            onWorkspaceDefaultPermissionChange={onWorkspaceDefaultPermissionChange}
            onRefresh={onRefresh}
            onSave={onSave}
            onRuntimeSettingsFormChange={onRuntimeSettingsFormChange}
            onToggleAllowedRunner={onToggleAllowedRunner}
            onRefreshRuntimeSettings={onRefreshRuntimeSettings}
            onSaveRuntimeSettings={onSaveRuntimeSettings}
          />
        ) : null}

        {visibleActiveSection === "external-work" && !workspaceToolDetailOpen ? (
          <ExternalWorkSettingsPanel
            selectedChannel={selectedChannel}
            externalWorkStatus={externalWorkStatus}
            externalWorkStatusLoading={externalWorkStatusLoading}
            externalWorkStatusAction={externalWorkStatusAction}
            externalWorkSecretAction={externalWorkSecretAction}
            externalWorkWorkflowAction={externalWorkWorkflowAction}
            onRefreshExternalWork={onRefreshExternalWork}
            onExternalWorkAction={onExternalWorkAction}
            onConfigureExternalWorkWorkflow={onConfigureExternalWorkWorkflow}
            onConfigureExternalWorkSecret={onConfigureExternalWorkSecret}
            onDeleteExternalWorkSecret={onDeleteExternalWorkSecret}
            onOpenExternalWorkRecords={onOpenExternalWorkRecords}
            onOpenExternalWorkTriage={onOpenExternalWorkTriage}
          />
        ) : null}

        {visibleActiveSection === "mcp-tools" && !workspaceToolDetailOpen ? (
          <div className="settings-section-stack">
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
          </div>
        ) : null}

        {visibleActiveSection === "plugin-manager" && !workspaceToolDetailOpen ? (
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
              setActiveSection("mcp-tools");
            }}
          />
        ) : null}

        {visibleActiveSection === "skill-library" && !workspaceToolDetailOpen ? (
          <SkillLibrarySettingsPanel cwd={cwd} refreshToken={skillLibraryRefreshToken} />
        ) : null}

        {visibleActiveSection === "archived-items" && !workspaceToolDetailOpen ? (
          <ArchivedSettingsPanel state={archivedController.state} actions={archivedController.actions} />
        ) : null}

        {visibleActiveSection === "startup-diagnostics" && !workspaceToolDetailOpen && !runDiagnosticsOpen ? (
          <StartupDiagnosticsSettingsPanel
            cwd={cwd}
            startupStatus={startupStatus}
            startupStatusLoading={startupStatusLoading}
            startupStatusAction={startupStatusAction}
            startupStatusError={startupStatusError}
            onRefreshStartup={onRefreshStartup}
            onOpenRunDiagnostics={onOpenRunDiagnostics}
          />
        ) : null}
      </div>
    </div>
  );
}

function workspaceToolViewToSectionId(view: SettingsWorkspaceToolView | undefined): SettingsSectionId | undefined {
  if (view === "providers") {
    return "model-workbench";
  }
  if (view === "teammates") {
    return "ai-teammates";
  }
  if (view === "councils") {
    return "ai-councils";
  }
  if (view === "work_board") {
    return "work-board";
  }
  return undefined;
}

function isWorkspaceToolSection(sectionId: SettingsSectionId): boolean {
  return sectionId === "model-workbench" || sectionId === "ai-teammates" || sectionId === "ai-councils" || sectionId === "work-board";
}
