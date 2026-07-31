import { type ReactNode, useEffect, useState } from "react";
import type { ComputerControlController } from "../../domains/computer-control/use-computer-control-controller.js";
import { shouldHideCuaDriverInternalRows, CUA_DRIVER_MCP_SERVER_ID } from "../../domains/computer-control/computer-control-surface.js";
import type { McpBusyAction } from "../../domains/mcp/use-mcp-domain.js";
import { useI18n } from "../../i18n.js";
import type {
  AuthorizationMode,
  Channel,
  EffectiveConfigResponse,
  ExternalWorkStatusResponse,
  McpServer,
  McpServerFormState,
  McpTool,
  PermissionPreset,
  ResponseLanguagePreference,
  RunArtifact,
  RunEventEnvelope,
  RunSession,
  SessionPermissionMode,
  StartupStatusResponse,
  UserProfile,
  WorkspaceAccessMode,
} from "../../types.js";
import { McpToolsPage, type McpSettingsError } from "../mcp/McpToolsPage.js";
import { ArchivedSettingsPanel } from "./ArchivedSettingsPanel.js";
import { ExecutionPermissionsSettingsPanel } from "./ExecutionPermissionsSettingsPanel.js";
import { ExternalWorkSettingsPanel } from "./ExternalWorkSettingsPanel.js";
import { StartupDiagnosticsSettingsPanel } from "./MaintenanceSettingsPanel.js";
import { InterfacePreferencesSettingsPanel, PersonalSettingsPanel } from "./PersonalInterfaceSettingsPanel.js";
import { PersonalizationSettingsPanel } from "./PersonalizationSettingsPanel.js";
import { SettingsRunDiagnosticsPanel } from "./SettingsRunDiagnosticsPanel.js";
import { SettingsShell, type SettingsContentState, type SettingsShellGroup } from "./SettingsShell.js";
import { SettingsWorkspaceToolSurface } from "./SettingsWorkspaceToolSurface.js";
import { SkillLibrarySettingsPanel } from "./SkillLibrarySettingsPanel.js";
import {
  isWorkspaceToolSection,
  settingsSectionGroups,
  workspaceToolViewToSectionId,
  type SettingsSectionId,
  type SettingsWorkspaceToolView,
} from "./settings-shell-model.js";
import { useArchivedSettingsController } from "./useArchivedSettingsController.js";
import { ComputerControlSettingsPage } from "./computer-control/ComputerControlSettingsPage.js";
import { MobileAccessSettingsPage } from "./mobile-access/MobileAccessSettingsPage.js";

export type { SettingsSectionId } from "./settings-shell-model.js";

export function SettingsPage({
  cwd,
  computerControl,
  skillLibraryRefreshToken,
  effectiveConfig,
  startupStatus,
  workspaceResponseLanguage,
  selectedChannel,
  externalWorkStatus,
  externalWorkError,
  mcpServers,
  mcpTools,
  mcpLoading,
  mcpBusyServerId,
  mcpBusyAction,
  mcpError,
  initialSection,
  workspaceDefaultAuthorizationMode,
  workspaceDefaultWorkspaceAccessMode,
  workspaceDefaultPermissionMode,
  workspaceDefaultPermissionPreset,
  startupStatusLoading,
  startupStatusAction,
  startupStatusError,
  externalWorkStatusLoading,
  externalWorkStatusAction,
  externalWorkSecretAction,
  externalWorkWorkflowAction,
  runArtifacts,
  runEvents,
  runsError,
  selectedRun,
  onWorkspaceDefaultAuthorizationChange,
  onWorkspaceDefaultWorkspaceAccessChange,
  onWorkspaceResponseLanguageChange,
  onRefreshStartup,
  onRefreshExternalWork,
  onExternalWorkAction,
  onConfigureExternalWorkWorkflow,
  onConfigureExternalWorkSecret,
  onDeleteExternalWorkSecret,
  onOpenRunDiagnostics,
  onCloseRunDiagnostics,
  onRefreshRunDiagnostics,
  onSelectRunDiagnostics,
  onOpenFullRunDiagnostics,
  onRefreshMcp,
  onClearMcpError,
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
  workspaceToolDetail,
  workspaceToolView,
  runDiagnosticsRunId,
  runs,
  runsLoading,
  onCloseWorkspaceTool,
  onBackToApplication,
}: {
  readonly cwd: string;
  readonly computerControl: ComputerControlController;
  readonly skillLibraryRefreshToken: number;
  readonly effectiveConfig: EffectiveConfigResponse | undefined;
  readonly startupStatus: StartupStatusResponse | undefined;
  readonly workspaceResponseLanguage: ResponseLanguagePreference;
  readonly selectedChannel: Channel | undefined;
  readonly externalWorkStatus: ExternalWorkStatusResponse | undefined;
  readonly externalWorkError?: {
    readonly kind: "background" | "credential" | "poll" | "reconcile" | "status" | "triage" | "workflow";
    readonly message: string;
  };
  readonly mcpServers: readonly McpServer[];
  readonly mcpTools: readonly McpTool[];
  readonly mcpLoading: boolean;
  readonly mcpBusyServerId: string;
  readonly mcpBusyAction: McpBusyAction | undefined;
  readonly mcpError?: McpSettingsError;
  readonly initialSection?: SettingsSectionId;
  readonly workspaceDefaultAuthorizationMode?: AuthorizationMode;
  readonly workspaceDefaultWorkspaceAccessMode?: WorkspaceAccessMode;
  readonly workspaceDefaultPermissionMode?: SessionPermissionMode;
  readonly workspaceDefaultPermissionPreset?: PermissionPreset;
  readonly startupStatusLoading: boolean;
  readonly startupStatusAction: "refresh" | undefined;
  readonly startupStatusError: string;
  readonly externalWorkStatusLoading: boolean;
  readonly externalWorkStatusAction: "poll" | "reconcile" | "start" | "stop" | undefined;
  readonly externalWorkSecretAction: "configure" | "delete" | undefined;
  readonly externalWorkWorkflowAction: "configure" | undefined;
  readonly runArtifacts: readonly RunArtifact[];
  readonly runEvents: readonly RunEventEnvelope[];
  readonly runsError: string;
  readonly selectedRun: RunSession | undefined;
  readonly onWorkspaceDefaultAuthorizationChange: (mode: AuthorizationMode) => void;
  readonly onWorkspaceDefaultWorkspaceAccessChange: (mode: WorkspaceAccessMode) => void;
  readonly onWorkspaceResponseLanguageChange: (language: ResponseLanguagePreference) => void;
  readonly onRefreshStartup: () => void;
  readonly onRefreshExternalWork: () => void;
  readonly onExternalWorkAction: (action: "poll" | "reconcile" | "start" | "stop") => Promise<boolean>;
  readonly onConfigureExternalWorkWorkflow: (input: {
    readonly sourceKind: "github" | "linear";
    readonly repository?: string;
    readonly projectSlug?: string;
  }) => Promise<boolean>;
  readonly onConfigureExternalWorkSecret: (token: string) => Promise<boolean>;
  readonly onDeleteExternalWorkSecret: () => Promise<boolean>;
  readonly onOpenRunDiagnostics: () => void;
  readonly onCloseRunDiagnostics: () => void;
  readonly onRefreshRunDiagnostics: () => void;
  readonly onSelectRunDiagnostics: (runId: string) => void;
  readonly onOpenFullRunDiagnostics: (runId?: string) => void;
  readonly onRefreshMcp: () => void;
  readonly onClearMcpError: () => void;
  readonly onArchivedItemsChanged?: () => void | Promise<void>;
  readonly onCreateMcpServer: (form: McpServerFormState) => Promise<void>;
  readonly onUpdateMcpServer: (serverId: string, form: McpServerFormState) => Promise<void>;
  readonly onDeleteMcpServer: (serverId: string) => Promise<boolean>;
  readonly onCheckMcpServer: (serverId: string) => Promise<boolean>;
  readonly onSyncMcpTools: (serverId: string) => Promise<boolean>;
  readonly onProfileChange?: (profile: UserProfile) => void;
  readonly onOpenProviders: () => void;
  readonly onOpenTeammates: () => void;
  readonly onOpenCouncils: () => void;
  readonly workspaceToolDetail?: ReactNode;
  readonly workspaceToolView?: SettingsWorkspaceToolView;
  readonly runDiagnosticsRunId?: string;
  readonly runs: readonly RunSession[];
  readonly runsLoading: boolean;
  readonly onCloseWorkspaceTool?: () => void;
  readonly onBackToApplication?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection ?? "personal-profile");
  const computerControlVisible = computerControl.surfaceMode === "computer_control";
  const mobileAccessVisible = Boolean(window.lingDesktop?.mobileAccess);
  useEffect(() => {
    if (!computerControlVisible && activeSection === "computer-control") {
      setActiveSection("personal-profile");
    }
  }, [activeSection, computerControlVisible]);
  useEffect(() => {
    if (!mobileAccessVisible && activeSection === "mobile-access") {
      setActiveSection("personal-profile");
    }
  }, [activeSection, mobileAccessVisible]);
  const runDiagnosticsOpen = runDiagnosticsRunId !== undefined;
  const workspaceToolSection = workspaceToolViewToSectionId(workspaceToolView);
  const activeWorkspaceToolView = workspaceToolView && workspaceToolSection && workspaceToolDetail !== undefined && workspaceToolDetail !== null
    ? workspaceToolView
    : undefined;
  const workspaceToolDetailOpen = !runDiagnosticsOpen && activeWorkspaceToolView !== undefined;
  const visibleActiveSection = runDiagnosticsOpen
    ? "startup-diagnostics"
    : workspaceToolDetailOpen && workspaceToolSection
      ? workspaceToolSection
      : isWorkspaceToolSection(activeSection)
        ? "personal-profile"
        : activeSection === "computer-control" && !computerControlVisible
          ? "personal-profile"
          : activeSection === "mobile-access" && !mobileAccessVisible
            ? "personal-profile"
          : activeSection;
  const contentStackClassName = [
    "settings-content-stack",
    workspaceToolDetailOpen
      ? "settings-content-stack--workspace-tool"
      : !runDiagnosticsOpen
        ? `settings-content-stack--${visibleActiveSection}`
        : "",
  ].filter(Boolean).join(" ");
  const contentState: SettingsContentState = runDiagnosticsOpen
    ? "run-diagnostics"
    : workspaceToolDetailOpen
      ? "workspace-tool"
      : "section";
  const shellGroups: readonly SettingsShellGroup[] = settingsSectionGroups.map((group) => ({
    heading: t(group.heading),
    items: group.items.map((item) => ({
      id: item.id,
      label: t(item.label),
      title: t(item.pageTitle ?? item.label),
      icon: item.icon,
      hidden: item.pending === true,
      ...(item.id === "computer-control" ? { hidden: !computerControlVisible } : {}),
      ...(item.id === "mobile-access" ? { hidden: !mobileAccessVisible } : {}),
    })),
  }));
  const workspaceToolDefinition = workspaceToolSection
    ? settingsSectionGroups.flatMap((group) => group.items).find((item) => item.id === workspaceToolSection)
    : undefined;
  const workspaceToolLabel = workspaceToolDefinition
    ? t(workspaceToolDefinition.pageTitle ?? workspaceToolDefinition.label)
    : "";
  const archivedController = useArchivedSettingsController({
    cwd,
    enabled: visibleActiveSection === "archived-items",
    onChanged: onArchivedItemsChanged,
  });
  const hideCuaInternals = shouldHideCuaDriverInternalRows(computerControl.surfaceMode);
  const visibleMcpServers = hideCuaInternals
    ? mcpServers.filter((server) => server.id !== CUA_DRIVER_MCP_SERVER_ID)
    : mcpServers;
  const visibleMcpTools = hideCuaInternals
    ? mcpTools.filter((tool) => tool.serverId !== CUA_DRIVER_MCP_SERVER_ID)
    : mcpTools;

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
    onCloseWorkspaceTool?.();
  };

  return (
    <SettingsShell
      activeSection={visibleActiveSection}
      backLabel={t("Back to app")}
      contentClassName={contentStackClassName}
      contentLabel={t("Settings")}
      contentState={contentState}
      groups={shellGroups}
      navigationLabel={t("Settings sections")}
      onBack={onBackToApplication}
      onSelectSection={selectSettingsSection}
    >
        {runDiagnosticsOpen ? (
          <SettingsRunDiagnosticsPanel
            artifacts={runArtifacts}
            events={runEvents}
            runs={runs}
            selectedRunId={runDiagnosticsRunId ?? ""}
            selectedRun={selectedRun}
            isLoading={runsLoading}
            errorMessage={runsError}
            onRefresh={onRefreshRunDiagnostics}
            onSelectRun={onSelectRunDiagnostics}
            onOpenFullDiagnostics={onOpenFullRunDiagnostics}
            onClose={onCloseRunDiagnostics}
          />
        ) : null}

        {workspaceToolDetailOpen && activeWorkspaceToolView ? (
          <SettingsWorkspaceToolSurface label={workspaceToolLabel} view={activeWorkspaceToolView}>
            {workspaceToolDetail}
          </SettingsWorkspaceToolSurface>
        ) : null}

        {visibleActiveSection === "personal-profile" && !workspaceToolDetailOpen ? (
          <PersonalSettingsPanel cwd={cwd} onProfileChange={onProfileChange} />
        ) : null}

        {visibleActiveSection === "personalization" && !workspaceToolDetailOpen ? <PersonalizationSettingsPanel cwd={cwd} /> : null}

        {visibleActiveSection === "interface-preferences" && !workspaceToolDetailOpen ? (
          <InterfacePreferencesSettingsPanel
            workspaceResponseLanguage={workspaceResponseLanguage}
            onWorkspaceResponseLanguageChange={onWorkspaceResponseLanguageChange}
          />
        ) : null}

        {visibleActiveSection === "computer-control" && !workspaceToolDetailOpen ? (
          <ComputerControlSettingsPage controller={computerControl} />
        ) : null}

        {visibleActiveSection === "mobile-access" && !workspaceToolDetailOpen ? <MobileAccessSettingsPage /> : null}

        {visibleActiveSection === "approval-strategy" && !workspaceToolDetailOpen ? (
          <ExecutionPermissionsSettingsPanel
            workspaceDefaultAuthorizationMode={workspaceDefaultAuthorizationMode}
            workspaceDefaultWorkspaceAccessMode={workspaceDefaultWorkspaceAccessMode}
            workspaceDefaultPermissionMode={workspaceDefaultPermissionMode}
            workspaceDefaultPermissionPreset={workspaceDefaultPermissionPreset}
            onWorkspaceDefaultAuthorizationChange={onWorkspaceDefaultAuthorizationChange}
            onWorkspaceDefaultWorkspaceAccessChange={onWorkspaceDefaultWorkspaceAccessChange}
          />
        ) : null}

        {visibleActiveSection === "external-work" && !workspaceToolDetailOpen ? (
          <ExternalWorkSettingsPanel
            error={externalWorkError}
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
          />
        ) : null}

        {visibleActiveSection === "mcp-tools" && !workspaceToolDetailOpen ? (
          <McpToolsPage
            servers={visibleMcpServers}
            tools={visibleMcpTools}
            isLoading={mcpLoading}
            busyServerId={hideCuaInternals && mcpBusyServerId === CUA_DRIVER_MCP_SERVER_ID ? "" : mcpBusyServerId}
            busyAction={hideCuaInternals && mcpBusyServerId === CUA_DRIVER_MCP_SERVER_ID ? undefined : mcpBusyAction}
            error={hideCuaInternals && mcpBusyServerId === CUA_DRIVER_MCP_SERVER_ID ? undefined : mcpError}
            cwd={cwd}
            onRefresh={onRefreshMcp}
            onClearError={onClearMcpError}
            onCreate={onCreateMcpServer}
            onUpdate={onUpdateMcpServer}
            onDelete={onDeleteMcpServer}
            onCheck={onCheckMcpServer}
            onSyncTools={onSyncMcpTools}
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
            effectiveConfig={effectiveConfig}
            startupStatus={startupStatus}
            startupStatusLoading={startupStatusLoading}
            startupStatusAction={startupStatusAction}
            startupStatusError={startupStatusError}
            onRefreshStartup={onRefreshStartup}
            onOpenRunDiagnostics={onOpenRunDiagnostics}
          />
        ) : null}
    </SettingsShell>
  );
}
