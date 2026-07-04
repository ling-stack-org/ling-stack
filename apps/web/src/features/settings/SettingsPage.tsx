import { type ReactNode, useState } from "react";
import { ArrowLeft } from "lucide-react";
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
  SessionPermissionMode,
  StartupStatusResponse,
  UserProfile,
  WorkspaceRuntimeSettings,
} from "../../types.js";
import { ExecutionPermissionsSettingsPanel } from "./ExecutionPermissionsSettingsPanel.js";
import { InterfacePreferencesSettingsPanel } from "./InterfacePreferencesSettingsPanel.js";
import { IntegrationsSettingsPanel } from "./IntegrationsSettingsPanel.js";
import { MaintenanceSettingsPanel } from "./MaintenanceSettingsPanel.js";
import { ProfileSettingsPanel } from "./ProfileSettingsPanel.js";
import { SettingsWorkspaceToolsPanel, type WorkspaceToolCounts } from "./SettingsWorkspaceToolsPanel.js";
import { SkillsSettingsPanel } from "./SkillsSettingsPanel.js";
import { useArchivedSettingsController } from "./useArchivedSettingsController.js";

type SettingsSectionId =
  | "overview"
  | "profile"
  | "interface-language"
  | "runtime-permissions"
  | "connections"
  | "skills"
  | "data-diagnostics";

const settingsSectionGroups: readonly {
  readonly heading?: string;
  readonly items: readonly { readonly id: SettingsSectionId; readonly label: string; readonly description: string }[];
}[] = [
  {
    items: [
      {
        id: "overview",
        label: "Configuration overview",
        description: "Workspace setup, work controls, and default authorization",
      },
    ],
  },
  {
    heading: "Personal",
    items: [
      {
        id: "profile",
        label: "User profile",
        description: "Avatar, display name, handle, and local profile overview",
      },
    ],
  },
  {
    heading: "Preferences",
    items: [
      {
        id: "interface-language",
        label: "Interface and language",
        description: "Theme, app language, and AI response language",
      },
    ],
  },
  {
    heading: "Workspace",
    items: [
      {
        id: "runtime-permissions",
        label: "Runtime and permissions",
        description: "Default authorization, tool policy, and execution runners",
      },
      {
        id: "connections",
        label: "Connections",
        description: "Work intake, tool servers, and plugin bundles",
      },
      {
        id: "skills",
        label: "Skills",
        description: "Skill policy and workspace skill library",
      },
    ],
  },
  {
    heading: "Maintenance",
    items: [
      {
        id: "data-diagnostics",
        label: "Data and diagnostics",
        description: "Archived data, system health, and support diagnostics",
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
  workspaceToolCounts,
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
  readonly workspaceToolCounts: WorkspaceToolCounts;
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
  readonly onCloseWorkspaceTool?: () => void;
  readonly onBackToApplication?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("overview");
  const activeSectionGroup = settingsSectionGroups.find((group) => group.items.some((item) => item.id === activeSection));
  const activeSectionItem = activeSectionGroup?.items.find((item) => item.id === activeSection) ?? settingsSectionGroups[0]?.items[0];
  const workspaceToolDetailOpen = activeSection === "overview" && workspaceToolDetail !== undefined && workspaceToolDetail !== null;
  const archivedController = useArchivedSettingsController({
    cwd,
    enabled: activeSection === "data-diagnostics",
    onChanged: onArchivedItemsChanged,
  });

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
            {group.items.map((item) => (
              <button
                key={item.id}
                className={activeSection === item.id ? "settings-section-item active" : "settings-section-item"}
                type="button"
                onClick={() => {
                  setActiveSection(item.id);
                  onCloseWorkspaceTool?.();
                }}
                title={t(item.description)}
                aria-current={activeSection === item.id ? "page" : undefined}
              >
                <span>{t(item.label)}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="settings-content-stack">
        {activeSectionItem && !workspaceToolDetailOpen ? (
          <header className="settings-section-head settings-page-section-head">
            <span>{t(activeSectionGroup?.heading ?? "Settings")}</span>
            <h2>{t(activeSectionItem.label)}</h2>
            <p>{t(activeSectionItem.description)}</p>
          </header>
        ) : null}

        {workspaceToolDetailOpen ? workspaceToolDetail : null}

        {activeSection === "overview" && !workspaceToolDetailOpen ? (
          <SettingsWorkspaceToolsPanel
            counts={workspaceToolCounts}
            defaultPermissionMode={workspaceDefaultPermissionMode}
            defaultPermissionPreset={workspaceDefaultPermissionPreset}
            onOpenProviders={onOpenProviders}
            onOpenTeammates={onOpenTeammates}
            onOpenCouncils={onOpenCouncils}
            onOpenWorkBoard={onOpenWorkBoard}
            onOpenApprovalPolicy={() => setActiveSection("runtime-permissions")}
          />
        ) : null}

        {activeSection === "profile" ? (
          <ProfileSettingsPanel
            cwd={cwd}
            onProfileChange={onProfileChange}
          />
        ) : null}

        {activeSection === "interface-language" ? (
          <InterfacePreferencesSettingsPanel
            effectiveConfig={effectiveConfig}
            workspaceResponseLanguage={workspaceResponseLanguage}
            onWorkspaceResponseLanguageChange={onWorkspaceResponseLanguageChange}
          />
        ) : null}

        {activeSection === "runtime-permissions" ? (
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

        {activeSection === "connections" ? (
          <IntegrationsSettingsPanel
            cwd={cwd}
            selectedChannel={selectedChannel}
            externalWorkStatus={externalWorkStatus}
            externalWorkStatusLoading={externalWorkStatusLoading}
            externalWorkStatusAction={externalWorkStatusAction}
            externalWorkSecretAction={externalWorkSecretAction}
            externalWorkWorkflowAction={externalWorkWorkflowAction}
            mcpServers={mcpServers}
            mcpTools={mcpTools}
            mcpLoading={mcpLoading}
            mcpBusyServerId={mcpBusyServerId}
            mcpBusyAction={mcpBusyAction}
            plugins={plugins}
            pluginsLoading={pluginsLoading}
            pluginBusyId={pluginBusyId}
            pluginBusyAction={pluginBusyAction}
            latestPluginApplyResult={latestPluginApplyResult}
            latestPluginRuntimePreview={latestPluginRuntimePreview}
            latestPluginNotice={latestPluginNotice}
            errorMessage={errorMessage}
            onRefreshExternalWork={onRefreshExternalWork}
            onExternalWorkAction={onExternalWorkAction}
            onConfigureExternalWorkWorkflow={onConfigureExternalWorkWorkflow}
            onConfigureExternalWorkSecret={onConfigureExternalWorkSecret}
            onDeleteExternalWorkSecret={onDeleteExternalWorkSecret}
            onOpenExternalWorkRecords={onOpenExternalWorkRecords}
            onOpenExternalWorkTriage={onOpenExternalWorkTriage}
            onRefreshMcp={onRefreshMcp}
            onCreateMcpServer={onCreateMcpServer}
            onUpdateMcpServer={onUpdateMcpServer}
            onDeleteMcpServer={onDeleteMcpServer}
            onCheckMcpServer={onCheckMcpServer}
            onSyncMcpTools={onSyncMcpTools}
            onRefreshPlugins={onRefreshPlugins}
            onApplyPluginPreset={onApplyPluginPreset}
            onCheckPlugin={onCheckPlugin}
            onValidatePluginPackage={onValidatePluginPackage}
            onInstallPlugin={onInstallPlugin}
            onUninstallPlugin={onUninstallPlugin}
            onRefreshPluginPackage={onRefreshPluginPackage}
            onPreviewPluginRuntime={onPreviewPluginRuntime}
            onEnablePlugin={onEnablePlugin}
            onDisablePlugin={onDisablePlugin}
          />
        ) : null}

        {activeSection === "skills" ? <SkillsSettingsPanel cwd={cwd} skillLibraryRefreshToken={skillLibraryRefreshToken} /> : null}

        {activeSection === "data-diagnostics" ? (
          <MaintenanceSettingsPanel
            cwd={cwd}
            archivedState={archivedController.state}
            archivedActions={archivedController.actions}
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
