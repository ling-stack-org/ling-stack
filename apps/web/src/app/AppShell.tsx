import { WorkSummaryProvider } from "../features/workspace/work-summary/WorkSummaryProvider.js";
import { DaemonObservationProvider, useDaemonObservationState, DaemonObservationDeferredError } from "../shared/conversation/observation/daemon-observation.js";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import {
  GSTACK_DEFAULT_SKILL_PACK_ID,
  getBuiltinSkillPack,
} from "@ling-stack/core/builtin-skill-packs";
import { isSupportedLocale } from "@ling-stack/localization";
import { projectConversationDetailTimeline } from "../domains/conversations/canonical-transcript-snapshot.js";
import { liveNarrationWorkflowIds } from "../lib/workflow-narration-refresh.js";
import { useI18n } from "../i18n.js";
import { useTheme } from "../theme.js";
import { useLingToast } from "../shared/ui/index.js";
import type {
  Channel,
  ChannelBranch,
  ChannelCollaborationProtocolResponse,
  ChannelMessage,
  DaemonFeatureFlags,
  ExternalWorkActionView,
  MediaJob,
  RunArtifact,
  RunEventEnvelope,
  RunFormState,
  ResponseLanguagePreference,
  SessionPermissionMode,
  StartupStatusResponse,
  Task,
  TaskRunActionState,
  UserProfile,
  WorkspaceAccessMode,
} from "../types.js";
import {
  channelSidebarTarget,
  readTeammateSidebarTarget,
  teammateSidebarTarget,
  viewDescription,
  viewTitle,
  type SidebarTarget,
  type SelectedEntity,
  type ViewId,
} from "./view-types.js";
import type { DomainEvent } from "./domain-events.js";
import type { ApprovalResolution } from "../features/approvals/types.js";
import { PageInspector } from "../features/inspector/PageInspector.js";
import { SidebarNavigation, type SidebarRecentConversation } from "../features/navigation/SidebarNavigation.js";
import { SidebarCompactRail } from "../features/navigation/SidebarCompactRail.js";
import { ChannelCreateDialog, type ChannelCreateProjectOption } from "../features/workspace/ChannelCreateDialog.js";
import { useChannelFeedbackController } from "../features/workspace/useChannelFeedbackController.js";
import { ConversationHome, type ConversationHomeMessage } from "../features/workspace/ConversationHome.js";
import { homeMessageFromTranscript } from "../features/workspace/normal-conversation-transcript-message.js";
import {
  LazyAutomationsPage as AutomationsPage,
  LazyAiTeammatesPage as AiTeammatesPage,
  LazyApprovalsPage as ApprovalsPage,
  LazyCouncilWorkspacePage as CouncilWorkspacePage,
  LazyGlobalWorkBoardPage as GlobalWorkBoardPage,
  LazyMediaJobsPage as MediaJobsPage,
  LazyMediaProductionWorkspace as MediaProductionWorkspace,
  LazyPageErrorBoundary,
  LazyPluginManagerPage as PluginManagerPage,
  LazyProfilePage as ProfilePage,
  LazyProviderSettings as ProviderSettings,
  LazyRunHistory as RunHistory,
  LazySettingsPage as SettingsPage,
  LazyTeammateWorkspace as TeammateWorkspace,
  LazyThreadPage as ThreadPage,
  LazyWorkspaceClientView as WorkspaceClientView,
} from "./lazy-pages.js";
import type { SettingsSectionId } from "../features/settings/SettingsPage.js";
import type { WorkBoardOpenIntent, WorkBoardScope } from "../features/work-board/work-board-types.js";
import { selectDefaultTeammateProvider } from "../features/teammates/teammate-create-defaults.js";
import { TeammateCreateDrawer } from "../features/teammates/TeammateCreateDrawer.js";
import {
  buildRunApprovalSummaries,
  effectiveApprovalStatus,
} from "../lib/approvals.js";
import { buildInlineApprovalViews } from "../lib/inline-approvals.js";
import { approvalRecoveryNotice } from "../lib/approval-recovery.js";
import {
  channelToForm,
  defaultChannelCreateForm,
  defaultChannelEditForm,
} from "../lib/channels.js";
import { deriveChannelRuns } from "../lib/channel-artifacts.js";
import { deriveSelectedChannelTeammateMemberships } from "../lib/channel-teammates.js";
import { readDataString } from "../lib/data.js";
import { getStartupStatus, refreshStartupStatus } from "../api/startup.js";
import { getUserProfile } from "../api/profile.js";
import {
  clearSavedWorkspaceCwd,
  getViteDefaultWorkspaceCwd,
  readInitialWorkspaceCwd,
  readSavedWorkspaceCwd,
} from "../lib/local-storage.js";
import {
  readRunWorkspaceCwd,
} from "../lib/run-evidence.js";
import { useApprovalsDomain } from "../domains/approvals/use-approvals-domain.js";
import { useAutomationsDomain } from "../domains/automations/use-automations-domain.js";
import { DesktopComputerUseBridge } from "./DesktopComputerUseBridge.js";
import { AppPresentationSurfaceBridge } from "./AppPresentationSurfaceBridge.js";
import { AppConnectionStatus } from "./AppConnectionStatus.js";
import { useDesktopDaemonStatus } from "./use-desktop-daemon-status.js";
import { AppShellOverlayBoundary } from "./AppShellOverlayBoundary.js";
import { DesktopWindowChrome } from "./DesktopWindowChrome.js";
import { DesktopTitlebarProvider, DesktopTitlebarSurface } from "./DesktopTitlebarSurface.js";
import { FullAccessConfirmationDialog } from "./FullAccessConfirmationDialog.js";
import { FirstRunDialog, useFirstRunController } from "../features/first-run/index.js";
import { useConversationDomain } from "../domains/conversations/use-conversation-domain.js";
import { useExternalWorkDomain } from "../domains/external-work/use-external-work-domain.js";
import { useMediaDomain } from "../domains/media/use-media-domain.js";
import { useMcpDomain } from "../domains/mcp/use-mcp-domain.js";
import { usePluginsDomain } from "../domains/plugins/use-plugins-domain.js";
import { useComputerControlController } from "../domains/computer-control/use-computer-control-controller.js";
import {
  CUA_DRIVER_PLUGIN_ID,
  shouldHideCuaDriverInternalRows,
} from "../domains/computer-control/computer-control-surface.js";
import { useProvidersDomain } from "../domains/providers/use-providers-domain.js";
import type { ProviderSetupIntent } from "../features/providers/provider-workbench-view-models.js";
import { useRuntimeDomain } from "../domains/runtime/use-runtime-domain.js";
import { useRunCommandController } from "../domains/runs/use-run-command-controller.js";
import { useRunsDomain } from "../domains/runs/use-runs-domain.js";
import { useSettingsCommandController } from "../domains/settings/use-settings-command-controller.js";
import { useSettingsDomain } from "../domains/settings/use-settings-domain.js";
import { useTeammatesDomain } from "../domains/teammates/use-teammates-domain.js";
import { useDurableWorkItemsDomain } from "../domains/work-items/use-durable-work-items-domain.js";
import { useWorkspaceCommandController } from "../domains/workspace/use-workspace-command-controller.js";
import {
  defaultTaskEditForm,
  defaultTaskForm,
  useWorkspaceDomain,
} from "../domains/workspace/use-workspace-domain.js";
import { defaultTools } from "../lib/tools.js";
import {
  canUseConversationProvider,
  providerPreflightReady,
  providerRunPreflightBlocker,
  providerModelRouteLabel,
  sortProvidersForWorkbench,
} from "../lib/providers.js";
import { removeRecordKey } from "../lib/records.js";
import { permissionPresetForWorkspaceAccessMode, workspaceAccessModeForPermissionPreset } from "../lib/session-permissions.js";
import { authorizationAndAccessToLegacyPermission, resolveWorkspaceAccessMode } from "../lib/conversation-authorization.js";
import { StatusBadge } from "../shared/components/index.js";
import { CurrentSessionHeaderCapabilityProvider } from "../shared/current-session/CurrentSessionHeaderCapability.js";
import { useFocusRevalidationToken } from "../shared/hooks/use-focus-revalidation-token.js";
import {
  aiTeammateToLocalDraft,
  buildChannelUnreadState,
  buildChannelTransitionEntities,
  latestChannelMessageTimestamp,
  selectDesktopComputerUseConversation,
  type ChannelUnreadState,
} from "./app-shell-selectors.js";
import {
  buildSidebarChannelNotifications,
  buildSidebarConversationApprovalCounts,
  buildSidebarTeammateNotifications,
  conversationThreadHasActiveWork,
  projectSidebarConversationStatus,
} from "./sidebar-status-projections.js";
import { useAppNavigationController } from "./use-app-navigation-controller.js";
import { useFullAccessConfirmationController } from "./useFullAccessConfirmationController.js";
import {
  channelFullAccessScope,
  fullAccessPolicyRevision,
  fullAccessRunScope,
  normalConversationFullAccessScope,
  teammateFullAccessScope,
} from "./full-access-confirmation-scopes.js";
import { useChannelActionsController } from "./use-channel-actions-controller.js";
import { useChannelWorkflowController } from "./use-channel-workflow-controller.js";
import { useControlPlaneInvalidation } from "./use-control-plane-invalidation.js";
import { useProviderUsageController } from "./use-provider-usage-controller.js";
import { useSlashCommandRegistry } from "./use-slash-command-registry.js";
import { useTaskRunController } from "./use-task-run-controller.js";
import { useWorkspaceSettingsController } from "./use-workspace-settings-controller.js";
import { useDesktopNavigationIntents } from "./use-desktop-navigation-intents.js";
import { useAppNarrowViewport } from "./use-app-viewport-state.js";
import { useShellErrorFeedback } from "./use-shell-error-feedback.js";
import { useNotificationBridge } from "../domains/notifications/use-notification-bridge.js";
import { buildSidebarObjectContextSeeds } from "./sidebar-object-context.js";
import { useSidebarObjectContexts } from "./use-sidebar-object-contexts.js";
import {
  acknowledgeSidebarConversationFailure,
  hasAcknowledgedSidebarConversationFailure,
  readSidebarFailureReadState,
  writeSidebarFailureReadState,
} from "./sidebar-failure-read-state.js";

const builtinSkillPack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
const builtinTeammateTemplates = builtinSkillPack?.teammateTemplates ?? [];
const builtinSlashCommandSkills = builtinSkillPack?.skills ?? [];

const defaultForm: RunFormState = {
  cwd: "",
  providerPresetId: "",
  taskId: `task-${new Date().toISOString().slice(0, 10)}`,
  title: "Inspect Ling Stack workspace",
  prompt: "Inspect the current project structure, give next implementation advice, and do not modify files.",
  provider: "local-relay",
  model: "gpt-5.5",
  baseUrl: "http://127.0.0.1:8317/v1",
  apiKey: "",
  api: "openai-completions",
  tools: defaultTools,
  authorizationMode: "smart",
  workspaceAccessMode: "workspace_write",
  permissionMode: "balanced",
  permissionPreset: "custom",
};

type SettingsReturnTarget = {
  readonly activeView: ViewId;
  readonly activeSidebarTarget: SidebarTarget;
  readonly selectedChannelId: string;
  readonly selectedChannelBranchId: string;
  readonly selectedTaskId: string;
  readonly taskRunProviderId: string;
  readonly threadPageTargetId: string;
};

type SettingsWorkspaceToolView = "" | "providers" | "teammates" | "councils";

function isSettingsWorkspaceToolView(view: ViewId): view is Exclude<SettingsWorkspaceToolView, ""> {
  return view === "providers" || view === "teammates" || view === "councils";
}

export function AppShell(): React.JSX.Element {
  const { locale, setLocale, t } = useI18n();
  const { preference: themePreference, setLegacyPreference: setThemePreference } = useTheme();
  const { dismissToast, showToast } = useLingToast();
  const fullAccessConfirmation = useFullAccessConfirmationController();
  const narrowViewport = useAppNarrowViewport();
  const desktopPlatform = typeof window === "undefined" ? undefined : window.lingDesktop?.platform;
  const desktopHosted = typeof window !== "undefined" && Boolean(window.lingDesktop);
  const initialWorkspaceCwd = desktopHosted ? "" : readInitialWorkspaceCwd();
  const [form, setForm] = useState<RunFormState>(() => ({
    ...defaultForm,
    cwd: initialWorkspaceCwd,
    title: t(defaultForm.title),
    prompt: t(defaultForm.prompt),
  }));
  const [activeView, setActiveView] = useState<ViewId>("workspace");
  const [activeSidebarTarget, setActiveSidebarTarget] = useState<SidebarTarget>("workspace");
  const [workBoardOpenIntent, setWorkBoardOpenIntent] = useState<WorkBoardOpenIntent>({
    requestId: 0,
    scope: "actionable",
  });
  const [settingsWorkspaceToolView, setSettingsWorkspaceToolView] = useState<SettingsWorkspaceToolView>("");
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSectionId | undefined>();
  const [settingsRunDiagnosticsRunId, setSettingsRunDiagnosticsRunId] = useState<string | undefined>();
  const [desktopTeammateConversationId, setDesktopTeammateConversationId] = useState<string | undefined>();
  const [teammateSettingsOpenRequest, setTeammateSettingsOpenRequest] = useState<{
    readonly teammateId: string;
    readonly requestId: number;
  }>();
  const [providerSetupIntent, setProviderSetupIntent] = useState<ProviderSetupIntent | "">("");
  const settingsReturnTargetRef = useRef<SettingsReturnTarget | undefined>(undefined);
  const [channelSidebarOpen, setChannelSidebarOpen] = useState(() => !narrowViewport);
  const [selectedChannelBranchId, setSelectedChannelBranchId] = useState("");
  const [daemonHealthy, setDaemonHealthy] = useState<boolean | undefined>();
  const desktopDaemonStatus = useDesktopDaemonStatus();
  const [daemonHealthRefreshing, setDaemonHealthRefreshing] = useState(false);
  const [daemonFeatures, setDaemonFeatures] = useState<DaemonFeatureFlags>({
    channels: { autoRoute: false },
    transports: { providerWebSocketFallback: false, localWebSocketRpc: false },
  });
  const [channelUnreadById, setChannelUnreadById] = useState<Readonly<Record<string, ChannelUnreadState>>>({});
  const [sidebarFailureReadState, setSidebarFailureReadState] = useState(readSidebarFailureReadState);
  const channelSeenMessageAtRef = useRef<Record<string, string>>({});
  const [runningWorkflowStepId, setRunningWorkflowStepId] = useState("");
  const [orchestratingWorkflowId, setOrchestratingWorkflowId] = useState("");
  const [taskRepairRunId, setTaskRepairRunId] = useState("");
  const [approvalRepairRunId, setApprovalRepairRunId] = useState("");
  const [startupStatus, setStartupStatus] = useState<StartupStatusResponse | undefined>();
  const [startupStatusLoading, setStartupStatusLoading] = useState(false);
  const [startupStatusAction, setStartupStatusAction] = useState<"refresh" | undefined>();
  const [startupStatusError, setStartupStatusError] = useState("");
  const [userProfile, setUserProfile] = useState<UserProfile | undefined>();
  const [threadPageTargetId, setThreadPageTargetId] = useState("");
  const [activeTaskRunAction, setActiveTaskRunAction] = useState<TaskRunActionState | undefined>();
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const channelFeedback = useChannelFeedbackController();
  const [skillLibraryRefreshToken, setSkillLibraryRefreshToken] = useState(0);
  const [teammateConversationRefreshToken, setTeammateConversationRefreshToken] = useState(0);
  const [teammateCreateOpen, setTeammateCreateOpen] = useState(false);
  const workspaceTimelineLoadRef = useRef("");
  const channelEditFormSyncKeyRef = useRef("");
  const workspaceDefaultProviderPresetIdRef = useRef<string | undefined>(undefined);
  const workspaceDefaultProviderAssignmentPendingRef = useRef("");
  useEffect(() => {
    if (narrowViewport) setChannelSidebarOpen(false);
  }, [narrowViewport]);
  useEffect(() => {
    writeSidebarFailureReadState(sidebarFailureReadState);
  }, [sidebarFailureReadState]);
  const {
    buildRerunRequest,
    buildRunRequest,
    buildTaskRunRequest,
    daemonBaseUrl,
  } = useRunCommandController();
  const daemonObservation = useDaemonObservationState(desktopDaemonStatus, daemonBaseUrl, form.cwd);
  const daemonObservationRef = useRef(daemonObservation);
  daemonObservationRef.current = daemonObservation;
  const focusRevalidationToken = useFocusRevalidationToken({ enabled: daemonHealthy === true && !daemonObservation.paused });
  const { getDaemonHealth } = useSettingsCommandController();
  const slashCommands = useSlashCommandRegistry({
    workspaceCwd: form.cwd.trim(),
    refreshToken: skillLibraryRefreshToken,
    fallbackSkills: builtinSlashCommandSkills,
  });
  const {
    cancelChannelWorkflow,
    channelAttachmentContentUrl,
    confirmChannelExecutionProposalWorkflow,
    createChannelWorkflowFromTemplate,
    deleteTask,
    orchestrateChannelWorkflow,
    retryChannelWorkflowStep,
    startChannelWorkflowStep,
    updateChannel,
    updateChannelExecutionProposal,
    updateChannelWorkflowStep,
    updateTask,
    updateTaskStatus,
  } = useWorkspaceCommandController();
  const workspaceDomain = useWorkspaceDomain({
    cwd: form.cwd.trim(),
    observation: daemonObservation,
    initialWorkspaceCwd,
    selectedChannelBranchId,
    translate: t,
    reportFeedback: channelFeedback.report,
    clearFeedback: channelFeedback.clear,
    onChannelMessagesLoaded: updateChannelMessageReadState,
  });
  const {
    channels,
    channelBranches,
    channelsLoading,
    selectedChannelId,
    channelForm,
    channelCreateOpen,
    channelEditForm,
    tasks,
    tasksLoading,
    taskForm,
    selectedTaskId,
    taskEditForm,
    taskRunProviderId,
    channelMessages,
    channelConversationItems,
    channelTurnContextAssignments,
    channelUserInputs,
    channelReasoningSummaries,
    channelContextCompactions,
    channelConversationRefreshToken,
    channelGeneratedMedia,
    memoryObjects,
    usedMemoryEvents,
    channelMessagesHasOlder,
    channelMessagesLoadingOlder,
    channelExecutionProposals,
    channelAttachments,
    channelLinkPreviews,
    channelArtifactsByRun,
    channelArtifactErrorsByRun,
    channelExecutionActions,
    channelExecutionActionError,
    channelBrief,
    channelCollaborationProtocol,
    channelDecisions,
    channelIntentDecisions,
    channelMessageRouteDecisions,
    channelHandoffs,
    channelContextSummaries,
    channelWorkflows,
    channelWorkflowSteps,
    channelMessagesLoading,
    channelFilesLoading,
    channelRunArtifactsLoading,
    channelProtocolLoading,
    channelStateTransitions,
    channelActivityTransitionsLoading,
    channelActivityTransitionError,
    channelGovernanceNotifications,
    channelGovernanceNotificationsLoading,
    channelGovernanceNotificationActionId,
    aiCouncils,
    aiCouncilHealthReport,
    aiCouncilsLoading,
    channelCouncilPolicy,
    channelEffectiveCouncil,
    channelCouncilLoading,
    channelCouncilSaving,
  } = workspaceDomain.state;
  const {
    setChannels,
    setChannelBranches,
    setSelectedChannelId,
    setChannelForm,
    setChannelCreateOpen,
    setChannelEditForm,
    setTasks,
    setSelectedTaskId,
    setTaskForm,
    setTaskEditForm,
    setTaskRunProviderId,
    setChannelMessages,
    setChannelConversationItems,
    setChannelExecutionProposals,
    setChannelAttachments,
    setChannelLinkPreviews,
    setChannelFilesLoading,
    setChannelBrief,
    setChannelCollaborationProtocol,
    setChannelDecisions,
    setChannelHandoffs,
    setChannelContextSummaries,
    setChannelWorkflows,
    setChannelWorkflowSteps,
    refreshChannels,
    refreshTasks,
    refreshChannelMessages,
    loadOlderChannelMessages,
    refreshChannelExecutionProposals,
    upsertChannelExecutionProposal,
    refreshChannelFiles,
    refreshChannelRunArtifacts,
    refreshChannelExecutionActions,
    refreshChannelActivityTransitions,
    refreshChannelGovernanceNotifications,
    markChannelGovernanceNotificationSeen,
    dismissChannelGovernanceNotification,
    refreshAiCouncils,
    refreshSelectedChannelCouncil,
    updateSelectedChannelCouncilPolicy,
    refreshChannelMessageRouteDecisions,
    refreshChannelIntentDecisions,
    refreshChannelProtocol,
    refreshUsedMemoryAudit,
    resetSelectedChannelActivity,
    resetForCwd: resetWorkspaceForCwd,
  } = workspaceDomain.actions;
  const selectedChannelIdRef = useRef(selectedChannelId);
  selectedChannelIdRef.current = selectedChannelId;
  const selectedChannelBranch = useMemo(
    () => channelBranches.find((branch) =>
      branch.id === selectedChannelBranchId &&
      branch.channelId === selectedChannelId &&
      branch.status !== "archived"
    ),
    [channelBranches, selectedChannelBranchId, selectedChannelId],
  );
  const selectedChannelBranchRootThreadId = selectedChannelBranch?.rootThreadId;
  const selectedChannelMessageThreadId = selectedChannelBranchId
    ? selectedChannelBranchRootThreadId ?? `missing-channel-branch-thread:${selectedChannelBranchId}`
    : undefined;
  const conversationDomain = useConversationDomain({
    cwd: form.cwd.trim(),
    observation: daemonObservation,
    translate: t,
  });
  const {
    conversationThreads,
    conversationThreadsLoading,
    selectedConversationThreadId,
    selectedConversationDetail,
    conversationIdentity,
    conversationStreamBusy,
    conversationSidebarError,
    conversationSurfaceError,
    conversationComposerError,
  } = conversationDomain.state;
  const {
    refreshConversationThreads,
    refreshSelectedConversation,
    openNewConversation,
    selectConversationThread,
    archiveConversationThread,
    archiveAllConversationThreads,
    sendConversationMessage,
  } = conversationDomain.actions;
  useDesktopNavigationIntents(Boolean(form.cwd.trim()), openConversationThread);
  const automationsDomain = useAutomationsDomain({
    cwd: form.cwd.trim(),
    channels,
    selectedChannelId,
    translate: t,
  });
  const {
    automations,
    automationRuns,
    automationDrafts,
    templates: automationTemplates,
    selectedAutomationId,
    selectedDraftId,
    previewByAutomationId,
    draftPreviewById,
    loading: automationsLoading,
    refreshing: automationsRefreshing,
    createAction: automationCreateAction,
    automationActionById,
    draftActionById,
    refreshError: automationsRefreshError,
    createError: automationCreateError,
    schedulerError: automationSchedulerError,
    automationErrorById,
    draftErrorById,
    schedulers: automationSchedulers,
    schedulerAction,
  } = automationsDomain.state;
  const {
    setSelectedAutomationId,
    setSelectedDraftId,
    refreshAutomations,
    createAutomationDefinition,
    createChatDraft,
    updateDraft,
    previewDraft,
    confirmDraft,
    discardDraft,
    previewAutomationById,
    runAutomationById,
    archiveAutomationById,
    setAutomationStatusById,
    setAutomationScheduleById,
    setAutomationTargetById,
    startScheduler,
    stopScheduler,
    resetForCwd: resetAutomationsForCwd,
  } = automationsDomain.actions;
  const { clearProviderUsage } = useProviderUsageController({
    form,
    taskRunProviderId,
    channels,
    setForm,
    setTaskRunProviderId,
    setChannels,
    setChannelEditForm,
    updateChannel,
    refreshChannels,
    getWorkspaceDefaultProviderPresetId: () => workspaceSettings?.defaultProviderPresetId ?? "",
    clearWorkspaceDefaultProvider: async () => {
      await patchWorkspaceSettings({ defaultProviderPresetId: null });
    },
  });
  const providersDomain = useProvidersDomain({
    cwd: form.cwd.trim(),
    translate: t,
    clearSelectedProvider: (providerId) => {
      if (form.providerPresetId === providerId) {
        setForm((current) => ({ ...current, providerPresetId: "" }));
      }
    },
    clearProviderUsage,
    onRunnableChatProviderReady: async (provider) => {
      if (workspaceDefaultProviderPresetIdRef.current || workspaceDefaultProviderAssignmentPendingRef.current) return;
      workspaceDefaultProviderAssignmentPendingRef.current = provider.id;
      try {
        const updatedSettings = await patchWorkspaceSettings({ defaultProviderPresetId: provider.id });
        if (updatedSettings?.defaultProviderPresetId === provider.id) {
          workspaceDefaultProviderPresetIdRef.current = provider.id;
        }
      } finally {
        if (workspaceDefaultProviderAssignmentPendingRef.current === provider.id) {
          workspaceDefaultProviderAssignmentPendingRef.current = "";
        }
      }
    },
  });
  const {
    providers,
    providerTemplates,
    providersLoaded,
    providersLoading,
    providerForm,
    editingProviderId,
    selectedProviderTemplateId,
    providerCheck,
    providerCheckTargetId,
    providerCheckScope,
    checkingProviderIds,
    providerBatchResult,
    providerOperationWarning,
    providerRepairRunId,
  } = providersDomain.state;
  const {
    setProviderForm,
    setProviderRepairRunId,
    refreshProviders,
    refreshProviderTemplates,
    checkProviderForRun,
    saveProviderWithPreflight,
    importModelsFromProviderForm,
    removeProvider,
    runProviderCheck,
    runProviderBatchCheck,
    editProvider,
    selectProviderTemplate,
    startNewProviderFromTemplate,
    toggleProviderEnabled,
    clearProviderCheckFeedback,
    resetForCwd: resetProvidersForCwd,
  } = providersDomain.actions;
  const teammatesDomain = useTeammatesDomain({
    cwd: form.cwd.trim(),
    builtinTeammateTemplates,
    t,
    refreshChannels,
    closeTeammateIfActive: (teammateId) => {
      if (activeSidebarTarget === teammateSidebarTarget(teammateId)) {
        openSettingsWorkspaceTool("teammates");
      }
    },
  });
  const {
    aiTeammates,
    aiTeammatesLoading,
    teammateChannelMembershipsByTeammate,
    teammateChannelMembershipsLoading,
    channelTeammateSavingId,
    listErrorMessage: teammateListErrorMessage,
    actionErrorMessagesByTeammateId: teammateActionErrorMessagesById,
    channelRelationErrorByChannelId: teammateChannelRelationErrorByChannelId,
  } = teammatesDomain.state;
  const {
    refreshAiTeammates,
    addAiTeammate,
    removeAiTeammate,
    hardDeleteAiTeammateAndRefresh,
    updateAiTeammateSettings,
    upsertAiTeammate,
    toggleAiTeammatePinned,
    toggleAiTeammateHidden,
    archiveAiTeammate,
    addChannelTeammate,
    removeChannelTeammate,
    setDefaultChannelTeammate,
    resetForCwd: resetTeammatesForCwd,
  } = teammatesDomain.actions;
  const approvalsDomain = useApprovalsDomain({
    cwd: form.cwd.trim(),
    emitEvent: handleDomainEvent,
  });
  const {
    approvals,
    selectedApprovalId,
    resolvingApprovals,
    approvalErrors,
    externalActionDetails,
    externalActionBusy,
    isLoading: approvalsLoading,
  } = approvalsDomain.state;
  const {
    setSelectedApprovalId,
    refreshApprovals,
    refreshExternalActionDetailsByIds,
    upsertApproval: upsertApprovalRecord,
    resolveApproval,
    executeExternalAction,
    cancelExternalAction,
  } = approvalsDomain.actions;
  const mediaDomain = useMediaDomain({
    cwd: form.cwd.trim(),
    translate: t,
    providers,
    upsertApproval: upsertApprovalRecord,
    refreshApprovals: (cwd) => refreshApprovals(cwd),
  });
  const {
    mediaJobs,
    mediaJobArtifacts,
    mediaJobsLoading,
    runningMediaJobId,
    mediaJobForm,
    selectedMediaJobId,
  } = mediaDomain.state;
  const {
    setMediaJobForm,
    setSelectedMediaJobId,
    refreshMediaJobs,
    saveMediaJob,
    executeMediaJob,
    resetForCwd: resetMediaForCwd,
  } = mediaDomain.actions;
  const mcpDomain = useMcpDomain({
    cwd: form.cwd.trim(),
    translate: t,
  });
  const {
    mcpServers,
    mcpTools,
    mcpLoading,
    mcpBusyServerId,
    mcpBusyAction,
  } = mcpDomain.state;
  const {
    refreshMcp,
    addMcpServer,
    saveMcpServer,
    runMcpServerCheck,
    syncMcpTools,
    removeMcpServer,
    resetForCwd: resetMcpForCwd,
  } = mcpDomain.actions;
  const pluginsDomain = usePluginsDomain({
    cwd: form.cwd.trim(),
    translate: t,
    notify: (notice) => showToast({
      message: notice.message,
      tone: notice.tone,
      scope: `plugin:${notice.pluginId}:${notice.action}:${notice.owner}`,
    }),
  });
  const computerControl = useComputerControlController({ plugins: pluginsDomain });
  useNotificationBridge({ cwd: form.cwd.trim() });
  const {
    plugins,
    pluginsLoading,
    pluginPendingActions,
    pluginActionErrors,
  } = pluginsDomain.state;
  const pluginsLoadError = pluginsDomain.error?.scope === "load" ? pluginsDomain.error.message : "";
  const {
    refreshPlugins,
    createPlugin,
    applyPluginPreset,
    connectPlugin,
    checkPlugin,
    validatePackage,
    installPlugin,
    uninstallPlugin,
    refreshPluginPackage,
    previewPluginRuntime,
    enablePlugin,
    disablePlugin,
    repairChromeHost,
    revokeChromeAccess,
    clearPluginActionErrors,
    resetForCwd: resetPluginsForCwd,
  } = pluginsDomain.actions;
  const hideCuaDriverInternalRows = shouldHideCuaDriverInternalRows(computerControl.surfaceMode);
  const pluginManagerPlugins = hideCuaDriverInternalRows
    ? plugins.filter((plugin) => plugin.id !== CUA_DRIVER_PLUGIN_ID)
    : plugins;
  const pluginManagerPendingActions = hideCuaDriverInternalRows
    ? pluginPendingActions.filter((action) => action.pluginId !== CUA_DRIVER_PLUGIN_ID)
    : pluginPendingActions;
  const pluginManagerActionErrors = hideCuaDriverInternalRows
    ? pluginActionErrors.filter((action) => action.pluginId !== CUA_DRIVER_PLUGIN_ID)
    : pluginActionErrors;
  const externalWorkDomain = useExternalWorkDomain({
    cwd: form.cwd.trim(),
    selectedChannelId,
  });
  const {
    externalWorkCiTriage,
    externalWorkCiTriageLoading,
    externalWorkStatus,
    externalWorkStatusLoading,
    externalWorkStatusAction,
    externalWorkSecretAction,
    externalWorkWorkflowAction,
  } = externalWorkDomain.state;
  const externalWorkError = externalWorkDomain.error;
  const {
    refreshExternalWorkCiTriage,
    refreshExternalWorkStatus,
    configureExternalWorkWorkflowAction,
    runExternalWorkStatusAction,
    configureExternalWorkSecretAction,
    deleteExternalWorkSecretAction,
    resetSelectedChannel: resetExternalWorkSelectedChannel,
    resetForCwd: resetExternalWorkForCwd,
  } = externalWorkDomain.actions;
  const durableWorkItemsDomain = useDurableWorkItemsDomain({
    cwd: form.cwd.trim(),
    refreshExternalActionDetailsByIds,
    refreshExternalWorkCiTriage,
    refreshExternalWorkStatus,
    refreshChannelProtocol,
    refreshApprovals,
  });
  const {
    durableWorkItems,
    durableWorkItemsLoading,
    busyByWorkItemId,
    failureByWorkItemId,
    blockerByWorkItemId,
    routingByExternalWorkId,
    busyWorkItemId,
    routingExternalWorkId,
  } = durableWorkItemsDomain.state;
  const {
    refreshWorkItems,
    claimDurableWorkItem,
    heartbeatDurableWorkItem,
    releaseDurableWorkItem,
    completeDurableWorkItem,
    failDurableWorkItem,
    routeExternalWorkToChannel,
    resetForCwd: resetDurableWorkItemsForCwd,
  } = durableWorkItemsDomain.actions;
  const runtimeDomain = useRuntimeDomain({
    cwd: form.cwd.trim(),
    observation: daemonObservation,
    onWorkUnitActionComplete: async (workUnitId, action) => {
      if (action === "cancel" && run?.workUnitId === workUnitId) {
        abortCurrentRun();
        setIsRunning(false);
      }
      await Promise.all([refreshRuns(), refreshHealth()]);
    },
  });
  const {
    stateTransitions,
    resourceLeases,
    runtimeDiagnostics,
    workUnits,
    selectedWorkUnitDetail,
    runtimeLoading,
    runtimeActionWorkUnitId,
  } = runtimeDomain.state;
  const runtimeError = runtimeDomain.error;
  const {
    setSelectedWorkUnitDetail,
    refreshRuntimeState,
    runWorkUnitAction,
    resetForCwd: resetRuntimeForCwd,
  } = runtimeDomain.actions;
  const settingsDomain = useSettingsDomain({
    cwd: form.cwd.trim(),
  });
  const {
    approvalPolicy,
    approvalPolicyForm,
    approvalPolicyLoading,
  } = settingsDomain.state;
  const {
    refreshApprovalPolicy,
    refreshRuntimeSettings,
    resetForCwd: resetSettingsForCwd,
  } = settingsDomain.actions;
  const runsDomain = useRunsDomain({
    cwd: form.cwd.trim(),
    observation: daemonObservation,
    confirmFullAccessRunIfNeeded,
    setSelectedWorkUnitDetail,
    refreshApprovals,
    refreshRuntimeState,
    refreshHealth,
    refreshUsedMemoryAudit,
    readRunWorkspaceCwd,
  });
  const {
    runs,
    selectedRunId: activeRunId,
    lookupRunId,
    selectedRun: run,
    events,
    artifacts,
    assistantText,
    latestStatus,
    isRunning,
    isLoading: runsLoading,
    isRunLoading,
    cancellingRunId,
    cancellingRunIds,
  } = runsDomain.state;
  const {
    setLookupRunId,
    setIsRunning,
    loadRun,
    refreshRunList: refreshRuns,
    runWithRequest,
    streamRunRequest,
    abortCurrentRun,
    cancelRunOrWorkUnit,
  } = runsDomain.actions;
  const {
    workspaceSettings,
    effectiveConfig,
    error: workspaceSettingsError,
    updateWorkspaceCwd,
    updateInterfaceLocale,
    patchWorkspaceSettings,
  } = useWorkspaceSettingsController({
    daemonHealthy,
    form,
    setForm,
    locale,
    setLocale,
    themePreference,
    setThemePreference,
    setChannelForm,
    resetForCwd: (cwd) => {
      channelFeedback.reset();
      resetWorkspaceForCwd(cwd);
      resetProvidersForCwd();
      resetTeammatesForCwd();
      resetAutomationsForCwd();
      resetMediaForCwd();
      resetMcpForCwd();
      resetPluginsForCwd();
      resetExternalWorkForCwd();
      resetRuntimeForCwd();
      resetSettingsForCwd();
      resetDurableWorkItemsForCwd();
      setStartupStatus(undefined);
      setStartupStatusError("");
      setStartupStatusAction(undefined);
    },
  });
  workspaceDefaultProviderPresetIdRef.current = workspaceSettings?.defaultProviderPresetId;
  const currentFullAccessPolicyRevision = useMemo(() => fullAccessPolicyRevision({
    defaultAuthorizationMode: workspaceSettings?.defaultAuthorizationMode ?? form.authorizationMode,
    defaultWorkspaceAccessMode: workspaceSettings?.defaultWorkspaceAccessMode ?? form.workspaceAccessMode,
    defaultPermissionMode: workspaceSettings?.defaultPermissionMode ?? form.permissionMode,
    defaultPermissionPreset: workspaceSettings?.defaultPermissionPreset ?? form.permissionPreset,
    approvalPolicyUpdatedAt: approvalPolicy?.updatedAt,
  }), [
    approvalPolicy?.updatedAt,
    form.authorizationMode,
    form.permissionMode,
    form.permissionPreset,
    form.workspaceAccessMode,
    workspaceSettings?.defaultAuthorizationMode,
    workspaceSettings?.defaultPermissionMode,
    workspaceSettings?.defaultPermissionPreset,
    workspaceSettings?.defaultWorkspaceAccessMode,
  ]);

  async function loadStartupStatus(workspaceCwd = form.cwd.trim()): Promise<void> {
    if (!workspaceCwd) {
      setStartupStatus(undefined);
      setStartupStatusError("");
      return;
    }
    setStartupStatusLoading(true);
    setStartupStatusError("");
    try {
      const response = await getStartupStatus(workspaceCwd);
      setStartupStatus(response);
    } catch (caught) {
      setStartupStatus(undefined);
      setStartupStatusError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStartupStatusLoading(false);
    }
  }

  async function refreshStartupDiagnostics(workspaceCwd = form.cwd.trim()): Promise<void> {
    if (!workspaceCwd) {
      return;
    }
    setStartupStatusAction("refresh");
    setStartupStatusLoading(true);
    setStartupStatusError("");
    try {
      const response = await refreshStartupStatus(workspaceCwd);
      setStartupStatus(response);
    } catch (caught) {
      setStartupStatusError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStartupStatusAction(undefined);
      setStartupStatusLoading(false);
    }
  }

  useEffect(() => {
    const workspaceCwd = form.cwd.trim();
    if (daemonHealthy !== true || !workspaceCwd) {
      setStartupStatus(undefined);
      setStartupStatusError("");
      return;
    }
    void loadStartupStatus(workspaceCwd);
  }, [daemonHealthy, form.cwd]);

  useEffect(() => {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd) {
      setUserProfile(undefined);
      return;
    }
    let cancelled = false;
    void getUserProfile(workspaceCwd)
      .then((response) => {
        if (!cancelled) {
          setUserProfile(response.profile);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUserProfile(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [form.cwd]);

  function markChannelRead(channelId: string): void {
    setChannelUnreadById((current) => current[channelId] ? removeRecordKey(current, channelId) : current);
  }

  function updateChannelMessageReadState(channelId: string, messages: readonly ChannelMessage[]): void {
    const latestMessageAt = latestChannelMessageTimestamp(messages);
    if (!latestMessageAt) {
      return;
    }
    if (channelId === selectedChannelId) {
      channelSeenMessageAtRef.current[channelId] = latestMessageAt;
      markChannelRead(channelId);
      return;
    }

    const seenAt = channelSeenMessageAtRef.current[channelId];
    const nextUnread = buildChannelUnreadState(messages, seenAt);
    if (nextUnread) {
      setChannelUnreadById((current) => {
        const previous = current[channelId];
        const next = {
          unread: previous?.unread === true || nextUnread.unread,
          mentioned: previous?.mentioned === true || nextUnread.mentioned,
        };
        return previous?.unread === next.unread && previous.mentioned === next.mentioned
          ? current
          : { ...current, [channelId]: next };
      });
    }
  }

  function openChannelCreatePanel(): void {
    const workspaceCwd = form.cwd.trim();
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    setChannelForm((current) => ({
      ...defaultChannelCreateForm,
      ...current,
      name: "",
      status: "active",
      boundPath: selectedChannel?.boundPath || workspaceCwd || current.boundPath,
      defaultProviderPresetId: selectedChannel?.defaultProviderPresetId || workspaceDefaultProviderPresetId || current.defaultProviderPresetId,
      defaultTeammateId: "",
      selectedTeammateIds: [],
      defaultResponderTeammateId: "",
      allowedTools: selectedChannel?.allowedTools.length ? selectedChannel.allowedTools : defaultChannelCreateForm.allowedTools,
      runtimePolicy: selectedChannel?.runtimePolicy ?? defaultChannelCreateForm.runtimePolicy,
    }));
    setChannelCreateOpen(true);
    setActiveView("workspace");
    setActiveSidebarTarget(selectedChannelId ? channelSidebarTarget(selectedChannelId) : "workspace");
  }

  const activePendingApprovals = useMemo(
    () => approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending" && approval.runId === activeRunId),
    [approvals, activeRunId],
  );
  const activeRunApprovals = useMemo(
    () => buildRunApprovalSummaries(events, approvals, activeRunId),
    [approvals, activeRunId, events],
  );
  const runById = useMemo(() => {
    const items = new Map(runs.map((item) => [item.id, item]));
    if (run) {
      const listedRun = items.get(run.id);
      if (!listedRun || run.updatedAt.localeCompare(listedRun.updatedAt) > 0) {
        items.set(run.id, run);
      }
    }
    return items;
  }, [run, runs]);
  const sidebarRuns = useMemo(() => [...runById.values()], [runById]);
  const sidebarObjectContextSeeds = useMemo(() => buildSidebarObjectContextSeeds({
    channels,
    conversationThreads,
    runs: sidebarRuns,
    teammates: aiTeammates,
    workspaceCwd: form.cwd.trim(),
  }), [aiTeammates, channels, conversationThreads, form.cwd, sidebarRuns]);
  const sidebarObjectContexts = useSidebarObjectContexts(sidebarObjectContextSeeds);
  const sidebarChannelNotifications = useMemo(
    () => buildSidebarChannelNotifications({
      approvals,
      channels,
      channelUnreadById,
      notificationLevels: workspaceSettings?.channelNotifications ?? {},
      runs: [...runs, ...(run ? [run] : [])],
      selectedChannelId,
      tasks,
      workUnits,
      workflowSteps: channelWorkflowSteps,
    }),
    [approvals, channelWorkflowSteps, channels, channelUnreadById, run, runs, selectedChannelId, tasks, workUnits, workspaceSettings?.channelNotifications],
  );
  const sidebarTeammateNotifications = useMemo(
    () => buildSidebarTeammateNotifications({
      approvals,
      runs: [...runs, ...(run ? [run] : [])],
      tasks,
      teammates: aiTeammates,
      workUnits,
    }),
    [aiTeammates, approvals, run, runs, tasks, workUnits],
  );
  const sidebarConversationApprovalCounts = useMemo(
    () => buildSidebarConversationApprovalCounts(approvals, sidebarRuns, workUnits),
    [approvals, sidebarRuns, workUnits],
  );
  useEffect(() => {
    if (activeView !== "workspace" || selectedChannelId || !selectedConversationThreadId) return;
    const selectedThread = conversationThreads.find((thread) => thread.id === selectedConversationThreadId);
    if (!selectedThread || (selectedThread.status !== "failed" && selectedThread.status !== "blocked")) return;
    setSidebarFailureReadState((current) => acknowledgeSidebarConversationFailure(
      current,
      form.cwd,
      selectedThread.id,
      selectedThread.updatedAt,
    ));
  }, [activeView, conversationThreads, form.cwd, selectedChannelId, selectedConversationThreadId]);
  const recentConversations = useMemo<readonly SidebarRecentConversation[]>(() => {
    return conversationThreads
      .map((thread) => ({
        id: thread.id,
        label: thread.title || t("Conversation"),
        primaryStatus: projectSidebarConversationStatus(
          thread.status,
          conversationThreadHasActiveWork(
            thread,
            selectedConversationThreadId,
            conversationStreamBusy,
          ),
          (sidebarConversationApprovalCounts.get(thread.id) ?? 0) > 0,
          hasAcknowledgedSidebarConversationFailure(
            sidebarFailureReadState,
            form.cwd,
            thread.id,
            thread.updatedAt,
          ),
        ),
        updatedAt: thread.metadata?.lastActivityAt ?? thread.updatedAt,
      }) satisfies SidebarRecentConversation)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 5);
  }, [conversationStreamBusy, conversationThreads, form.cwd, selectedConversationThreadId, sidebarConversationApprovalCounts, sidebarFailureReadState, t]);
  const conversationChatProviders = useMemo(
    () => providers.filter(canUseConversationProvider),
    [providers],
  );
  const workspaceDefaultProviderPresetId = workspaceSettings?.defaultProviderPresetId ?? form.providerPresetId;
  const sortedConversationProviders = useMemo(
    () => sortProvidersForWorkbench(conversationChatProviders, workspaceDefaultProviderPresetId),
    [conversationChatProviders, workspaceDefaultProviderPresetId],
  );
  const configuredConversationDefaultProvider = conversationChatProviders.find((provider) => provider.id === workspaceDefaultProviderPresetId);
  const defaultConversationProviderPresetId = configuredConversationDefaultProvider?.id || sortedConversationProviders[0]?.id || "";
  const conversationModelOptions = useMemo(
    () => sortProvidersForWorkbench(conversationChatProviders, defaultConversationProviderPresetId)
      .map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        label: providerModelRouteLabel(provider, providerTemplates),
        model: provider.model,
        providerId: provider.providerId,
        enabled: provider.enabled,
        runnable: providerPreflightReady(provider),
        blocker: providerRunPreflightBlocker(provider, t),
        thinkingModes: provider.thinkingModes ?? [],
      })),
    [conversationChatProviders, defaultConversationProviderPresetId, providerTemplates],
  );
  const defaultConversationProvider = conversationModelOptions.find((option) => option.id === defaultConversationProviderPresetId);
  const firstRunController = useFirstRunController({
    daemonHealthy,
    hasReadyProvider: conversationChatProviders.some(providerPreflightReady),
    providersLoaded,
    workspaceCwd: form.cwd,
    onOpenModelWorkbench: () => openSettingsWorkspaceTool("providers"),
  });
  const defaultConversationProviderLabel = defaultConversationProvider
    ? defaultConversationProvider.label
    : t("No chat model selected");
  const selectedConversationMessages = useMemo<readonly ConversationHomeMessage[]>(
    () => (selectedConversationDetail?.messages ?? []).map(homeMessageFromTranscript),
    [selectedConversationDetail],
  );
  const activeConversationRun = useMemo(
    () => [...(selectedConversationDetail?.runs ?? [])].reverse().find((candidate) =>
      candidate.status === "queued" || candidate.status === "running" || candidate.status === "waiting_for_approval"
    ),
    [selectedConversationDetail?.runs],
  );
  const normalConversationInlineApprovalViews = useMemo(
    () => selectedConversationDetail ? buildInlineApprovalViews(
      [
        ...(selectedConversationDetail?.approvals ?? []),
        ...approvals,
      ],
      {
        owner: { kind: "normal_conversation", threadId: selectedConversationDetail.thread.id },
        runs: sidebarRuns,
        tasks,
        workUnits,
        workflowSteps: channelWorkflowSteps,
      },
    ) : [],
    [approvals, channelWorkflowSteps, selectedConversationDetail, sidebarRuns, tasks, workUnits],
  );
  const selectedConversationProjectPath = selectedConversationDetail?.defaults.projectPath ?? "";
  const selectedConversationProjectLabel = selectedConversationProjectPath
    ? summarizeConversationProjectPath(selectedConversationProjectPath)
    : "";
  const localTeammates = useMemo(
    () => aiTeammates.map((teammate) => aiTeammateToLocalDraft(
      teammate,
      providers,
      teammateChannelMembershipsByTeammate[teammate.id]?.map((membership) => membership.channelId) ?? [],
      workspaceSettings?.defaultProviderPresetId,
    )),
    [aiTeammates, providers, teammateChannelMembershipsByTeammate, workspaceSettings?.defaultProviderPresetId],
  );
  const teammateCreateModelReady = useMemo(
    () => Boolean(selectDefaultTeammateProvider(providers, workspaceDefaultProviderPresetId)),
    [providers, workspaceDefaultProviderPresetId],
  );
  const selectedChannelTeammateMemberships = useMemo(() => {
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    return deriveSelectedChannelTeammateMemberships({
      channel: selectedChannel,
      teammates: aiTeammates,
      membershipsByTeammate: teammateChannelMembershipsByTeammate,
    });
  }, [aiTeammates, channels, selectedChannelId, teammateChannelMembershipsByTeammate]);
  const activeTeammateId = readTeammateSidebarTarget(activeSidebarTarget);
  const selectedAiTeammate = activeTeammateId ? aiTeammates.find((teammate) => teammate.id === activeTeammateId) : undefined;
  const normalConversationConfirmationScope = useMemo(() => normalConversationFullAccessScope({
    workspaceCwd: form.cwd,
    conversationIdentity,
    policyRevision: currentFullAccessPolicyRevision,
  }), [conversationIdentity, currentFullAccessPolicyRevision, form.cwd]);
  const channelConversationFullAccessScope = useMemo(() => channelFullAccessScope({
    channel: channels.find((item) => item.id === selectedChannelId),
    channelId: selectedChannelId,
    branchId: selectedChannelBranchId,
    workspaceCwd: form.cwd,
    policyRevision: currentFullAccessPolicyRevision,
  }), [channels, currentFullAccessPolicyRevision, form.cwd, selectedChannelBranchId, selectedChannelId]);
  const teammateConversationFullAccessScope = useMemo(() => teammateFullAccessScope({
    workspaceCwd: form.cwd,
    teammateId: selectedAiTeammate?.id,
    policyRevision: currentFullAccessPolicyRevision,
  }), [currentFullAccessPolicyRevision, form.cwd, selectedAiTeammate?.id]);
  const selectedWorkspaceTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId),
    [selectedTaskId, tasks],
  );
  const channelRunsForArtifacts = useMemo(
    () => deriveChannelRuns(selectedChannelId, tasks, runs, run),
    [run, runs, selectedChannelId, tasks],
  );
  const approvalRefreshOwnerRef = useRef({ cwd: form.cwd.trim(), channelId: selectedChannelId });
  if (approvalRefreshOwnerRef.current.cwd !== form.cwd.trim() || approvalRefreshOwnerRef.current.channelId !== selectedChannelId) {
    // Replace the identity, including when the user later returns to this scope.
    approvalRefreshOwnerRef.current = { cwd: form.cwd.trim(), channelId: selectedChannelId };
  }
  const approvalRefreshOwner = approvalRefreshOwnerRef.current;
  const channelRunArtifactsKey = useMemo(
    () => channelRunsForArtifacts.map((item) => `${item.id}:${item.updatedAt}`).join("|"),
    [channelRunsForArtifacts],
  );
  const hasLiveWorkflowTimeline = liveNarrationWorkflowIds(channelWorkflowSteps, channelRunsForArtifacts, selectedChannelId).length > 0;
  const inlineApprovalIds = useMemo(() => {
    if (!selectedChannelId) {
      return new Set<string>();
    }
    return new Set(
      buildInlineApprovalViews(approvals, {
        owner: { kind: "channel", channelId: selectedChannelId },
        runs: sidebarRuns,
        tasks,
        workUnits,
        workflowSteps: channelWorkflowSteps,
      }).map((item) => item.approval.id),
    );
  }, [approvals, channelWorkflowSteps, selectedChannelId, sidebarRuns, tasks, workUnits]);
  const channelTransitionEntityKey = useMemo(
    () => buildChannelTransitionEntities(selectedChannelId, tasks, channelRunsForArtifacts, channelWorkflows, channelWorkflowSteps)
      .map((item) => `${item.entityType}:${item.entityId}:${item.updatedAt}`)
      .join("|"),
    [channelRunsForArtifacts, channelWorkflowSteps, channelWorkflows, selectedChannelId, tasks],
  );
  const selectedEntity = useMemo<SelectedEntity>(() => {
    if (activeView === "providers") {
      return { type: "provider", id: editingProviderId || form.providerPresetId || providers[0]?.id || "" };
    }
    if (activeView === "media") {
      return { type: "mediaJob", id: selectedMediaJobId || mediaJobs[0]?.id || "" };
    }
    if (activeView === "approvals") {
      return { type: "approval", id: selectedApprovalId || approvals[0]?.id || "" };
    }
    if (activeView === "runs" && activeRunId) {
      return { type: "run", id: activeRunId };
    }
    if (activeView === "workspace" && selectedWorkspaceTask) {
      return { type: "task", id: selectedWorkspaceTask.id };
    }
    return { type: "workspace" };
  }, [
    activeRunId,
    activeView,
    approvals,
    editingProviderId,
    form.providerPresetId,
    mediaJobs,
    providers,
    selectedApprovalId,
    selectedMediaJobId,
    selectedWorkspaceTask,
  ]);
  const workspaceTimelineRunId = useMemo(() => {
    if (isRunning && activeRunId) {
      return activeRunId;
    }
    return selectedWorkspaceTask?.currentRunId || activeRunId || runs[0]?.id || "";
  }, [activeRunId, isRunning, runs, selectedWorkspaceTask]);
  const providerRepairRun = providerRepairRunId ? runById.get(providerRepairRunId) : undefined;
  const taskRepairRun = taskRepairRunId ? runById.get(taskRepairRunId) : undefined;
  const approvalRepairRun = approvalRepairRunId ? runById.get(approvalRepairRunId) : undefined;
  const memoryById = useMemo(() => new Map(memoryObjects.map((item) => [item.id, item])), [memoryObjects]);
  const {
    removeTask,
    moveTaskToReview,
    saveTaskEdit,
    confirmChannelExecutionProposal,
    cancelChannelExecutionProposal,
    runPersistedTask,
    checkThenRunPersistedTask,
    runUpdatedTaskFromRepair,
    checkThenRunUpdatedTaskFromRepair,
    rerunRun,
    applyProviderToRun,
    clearProviderFromRun,
  } = useTaskRunController({
    form,
    taskEditForm,
    taskRunProviderId,
    selectedChannelId,
    selectedTaskId,
    channels,
    aiTeammates,
    providers,
    providerTemplates,
    setForm,
    setTaskRepairRunId,
    setTaskRunProviderId,
    setActiveTaskRunAction,
    setSelectedTaskId,
    setTasks,
    setChannels,
    setChannelEditForm,
    setChannelWorkflows,
    setChannelWorkflowSteps,
    reportTaskError: (identity, message) => channelFeedback.report({ workspaceCwd: form.cwd.trim(), surface: "task", identity, scope: "mutation", message }),
    clearTaskError: (identity) => channelFeedback.clear("task", identity, form.cwd.trim()),
    reportWorkflowError: (identity, message) => channelFeedback.report({ workspaceCwd: form.cwd.trim(), surface: "workflow", identity, scope: "mutation", message }),
    clearWorkflowError: (identity) => channelFeedback.clear("workflow", identity, form.cwd.trim()),
    reportWorkspaceError: (identity, message) => channelFeedback.report({ workspaceCwd: form.cwd.trim(), surface: "workspace", identity, scope: "mutation", message }),
    clearWorkspaceError: (identity) => channelFeedback.clear("workspace", identity, form.cwd.trim()),
    patchWorkspaceSettings,
    t,
    buildRerunRequest,
    buildTaskRunRequest,
    runWithRequest,
    checkProviderForRun,
    confirmChannelExecutionProposalWorkflow,
    deleteTask,
    updateChannel,
    updateChannelExecutionProposal,
    updateTask,
    updateTaskStatus,
    upsertChannelExecutionProposal,
    refreshChannels,
    refreshTasks,
    refreshRuns,
    refreshChannelProtocol,
    refreshChannelExecutionProposals,
    refreshUsedMemoryAudit,
  });
  const {
    error: navigationRepairError,
    openPlainView,
    openRunDiagnosticsView,
    selectWorkspaceChannel,
    selectWorkspaceChannelBranch,
    selectAiTeammate,
    openTaskFromWorkBoard,
    openApprovalsFromWorkspace,
    openProvidersFromRun,
    openTaskFromRun,
  } = useAppNavigationController({
    activeRunId,
    formCwd: form.cwd.trim(),
    selectedChannelId,
    tasks,
    durableWorkItems,
    setActiveView,
    setActiveSidebarTarget,
    setApprovalRepairRunId,
    setChannelCreateOpen,
    setSelectedChannelBranchId,
    setSelectedChannelId,
    setSelectedTaskId,
    setTaskRepairRunId,
    setTaskRunProviderId,
    setThreadPageTargetId,
    markChannelRead,
    loadRun,
    refreshApprovals,
    refreshTasks,
    handleDomainEvent,
  });

  function activateSettingsView(): void {
    setChannelCreateOpen(false);
    setActiveView("settings");
    setActiveSidebarTarget("settings");
  }

  function clearSettingsWorkspaceToolView(): void {
    setSettingsWorkspaceToolView("");
  }

  function closeSettingsRunDiagnostics(): void {
    setSettingsRunDiagnosticsRunId(undefined);
  }

  function openSettingsView(): void {
    clearSettingsWorkspaceToolView();
    closeSettingsRunDiagnostics();
    setSettingsInitialSection(undefined);
    if (activeView !== "settings") {
      settingsReturnTargetRef.current = {
        activeView,
        activeSidebarTarget,
        selectedChannelId,
        selectedChannelBranchId,
        selectedTaskId,
        taskRunProviderId,
        threadPageTargetId,
      };
    }
    activateSettingsView();
  }

  function returnFromSettingsView(): void {
    const target = settingsReturnTargetRef.current;
    settingsReturnTargetRef.current = undefined;
    clearSettingsWorkspaceToolView();
    closeSettingsRunDiagnostics();
    setSettingsInitialSection(undefined);
    if (!target || target.activeView === "settings") {
      setActiveView("workspace");
      setActiveSidebarTarget("workspace");
      return;
    }
    setSelectedChannelId(target.selectedChannelId);
    setSelectedChannelBranchId(target.selectedChannelBranchId);
    setSelectedTaskId(target.selectedTaskId);
    setTaskRunProviderId(target.taskRunProviderId);
    setThreadPageTargetId(target.threadPageTargetId);
    setActiveView(target.activeView);
    setActiveSidebarTarget(target.activeSidebarTarget);
  }

  function openPlainViewWithoutSettingsReturn(view: ViewId): void {
    clearSettingsWorkspaceToolView();
    closeSettingsRunDiagnostics();
    if (view === "settings") {
      openSettingsView();
      return;
    }
    openPlainView(view);
  }

  function openConversationHome(): void {
    clearSettingsWorkspaceToolView();
    setThreadPageTargetId("");
    setChannelCreateOpen(false);
    setSelectedChannelBranchId("");
    setSelectedChannelId("");
    setSelectedTaskId("");
    setTaskRunProviderId("");
    openNewConversation();
    setActiveView("workspace");
    setActiveSidebarTarget("workspace");
  }

  function openAiTeammateSettings(teammateId: string): void {
    clearSettingsWorkspaceToolView();
    closeSettingsRunDiagnostics();
    setTeammateSettingsOpenRequest((current) => ({
      teammateId,
      requestId: (current?.requestId ?? 0) + 1,
    }));
    selectAiTeammate(teammateId);
  }

  async function openConversationThread(
    conversationId: string,
    isCurrentIntent: () => boolean = () => true,
  ): Promise<boolean> {
    if (!isCurrentIntent()) {
      return false;
    }
    settingsReturnTargetRef.current = undefined;
    clearSettingsWorkspaceToolView();
    closeSettingsRunDiagnostics();
    setSettingsInitialSection(undefined);
    setProviderSetupIntent("");
    setDesktopTeammateConversationId(undefined);
    setTeammateCreateOpen(false);
    setThreadPageTargetId("");
    setChannelCreateOpen(false);
    setSelectedChannelBranchId("");
    setSelectedChannelId("");
    setSelectedTaskId("");
    setTaskRunProviderId("");
    setActiveView("workspace");
    setActiveSidebarTarget("workspace");
    const opened = await selectConversationThread(conversationId, undefined, isCurrentIntent);
    if (!opened || !isCurrentIntent()) {
      return false;
    }
    window.lingDesktop?.computerUse.reportSelectedDeckOwner({
      surfaceKind: "normal_conversation",
      ownerId: conversationId,
    });
    return true;
  }

  function selectRecentConversation(conversation: SidebarRecentConversation): void {
    void openConversationThread(conversation.id);
  }

  async function refreshArchivedSidebarItems(): Promise<void> {
    await Promise.all([
      refreshChannels(),
      refreshConversationThreads(),
      refreshAiTeammates(),
    ]);
  }

  function rememberSettingsReturnTarget(): void {
    if (activeView !== "settings") {
      settingsReturnTargetRef.current = {
        activeView,
        activeSidebarTarget,
        selectedChannelId,
        selectedChannelBranchId,
        selectedTaskId,
        taskRunProviderId,
        threadPageTargetId,
      };
    }
  }

  function openSettingsWorkspaceTool(view: SettingsWorkspaceToolView, setupIntent: ProviderSetupIntent | "" = ""): void {
    if (!view) {
      return;
    }
    rememberSettingsReturnTarget();
    closeSettingsRunDiagnostics();
    setSettingsInitialSection(undefined);
    setSettingsWorkspaceToolView(view);
    if (view === "providers") {
      setProviderSetupIntent(setupIntent);
      void Promise.all([
        refreshProviderTemplates(),
        refreshProviders(),
      ]);
    } else {
      setProviderSetupIntent("");
    }
    if (view === "teammates") {
      void Promise.all([
        refreshAiTeammates(),
        refreshAiCouncils(),
        refreshChannels(),
        refreshProviders(),
        refreshMcp(),
      ]);
    }
    if (view === "councils") {
      void Promise.all([
        refreshAiTeammates(),
        refreshAiCouncils(),
        refreshChannels(),
      ]);
    }
    activateSettingsView();
  }

  function openWorkBoard(scope: WorkBoardScope = "actionable", itemId: string = ""): void {
    clearSettingsWorkspaceToolView();
    closeSettingsRunDiagnostics();
    setWorkBoardOpenIntent((current) => ({
      requestId: current.requestId + 1,
      scope,
      itemId: itemId || undefined,
    }));
    openPlainView("work_board");
  }

  function openTaskInWorkBoard(task: Task): void {
    const terminal = task.status === "done" || task.status === "failed" || task.status === "cancelled";
    setSelectedChannelId(task.channelId);
    openWorkBoard(terminal ? "history" : "global", `task:${task.id}`);
  }

  function openSettingsSection(sectionId: SettingsSectionId): void {
    rememberSettingsReturnTarget();
    clearSettingsWorkspaceToolView();
    closeSettingsRunDiagnostics();
    setSettingsInitialSection(sectionId);
    activateSettingsView();
  }

  function openSettingsRunDiagnostics(runId?: string): void {
    rememberSettingsReturnTarget();
    const targetRunId = runId || activeRunId || runs[0]?.id || "";
    setSettingsWorkspaceToolView("");
    setSettingsInitialSection(undefined);
    setSettingsRunDiagnosticsRunId(targetRunId);
    activateSettingsView();
    runsDomain.clearError();
    void refreshRuns();
    loadSettingsRunDiagnosticsDetail(targetRunId);
  }

  function selectSettingsRunDiagnostics(runId: string): void {
    runsDomain.clearError();
    setSettingsRunDiagnosticsRunId(runId);
    loadSettingsRunDiagnosticsDetail(runId);
  }

  function refreshSettingsRunDiagnostics(): void {
    runsDomain.clearError();
    void refreshRuns();
    loadSettingsRunDiagnosticsDetail(settingsRunDiagnosticsRunId || activeRunId || runs[0]?.id || "");
  }

  function loadSettingsRunDiagnosticsDetail(runId: string): void {
    if (!runId) return;
    void loadRun(runId, form.cwd.trim()).catch(() => undefined);
    void refreshApprovals(form.cwd.trim(), runId);
  }

  function openFullRunDiagnosticsFromSettings(runId?: string): void {
    const targetRunId = runId || settingsRunDiagnosticsRunId || activeRunId || runs[0]?.id || "";
    closeSettingsRunDiagnostics();
    clearSettingsWorkspaceToolView();
    if (targetRunId) {
      void selectRun(targetRunId);
    }
    openRunDiagnosticsView();
  }

  function openTeammateCreatePanel(): void {
    setTeammateCreateOpen(true);
  }

  const {
    saveChannel,
    saveDefaultChannel,
    saveChannelEdit,
    saveChannelBranch,
    archiveSidebarChannel,
    archiveSidebarChannelBranch,
    removeChannel,
    saveTask,
    createTaskFromSlashCommand,
    sendChannelMessage,
    uploadChannelFiles,
    addChannelLinkPreview,
    removeChannelAttachment,
    saveChannelBrief,
    saveChannelProtocolPatch,
    revertChannelProtocolSettings,
    supersedeChannelDecision,
    rejectChannelDecision,
    createHandoffFromTask,
    updateHandoffStatusValue,
    startWorkflowFromHandoff,
    createTaskFromContextSummary,
    runActivityTriageAction,
  } = useChannelActionsController({
    form,
    observation: daemonObservation,
    setForm,
    channels,
    channelForm,
    channelEditForm,
    taskForm,
    providers,
    providerTemplates,
    selectedChannelId,
    selectedChannelMessageThreadId,
    selectedChannelBranchRootThreadId,
    activeSidebarTarget,
    channelDecisions,
    setActiveView,
    setActiveSidebarTarget,
    setSelectedChannelId,
    setSelectedChannelBranchId,
    setSelectedTaskId,
    setTaskRunProviderId,
    setChannelCreateOpen,
    setChannelForm,
    setChannelEditForm,
    setChannels,
    setChannelBranches,
    setTaskForm,
    setTasks,
    setChannelMessages,
    setChannelConversationItems,
    setChannelExecutionProposals,
    setChannelAttachments,
    setChannelLinkPreviews,
    setChannelFilesLoading,
    setChannelBrief,
    setChannelCollaborationProtocol,
    setChannelDecisions,
    setChannelHandoffs,
    setChannelContextSummaries,
    setChannelWorkflows,
    setChannelWorkflowSteps,
    reportFeedback: channelFeedback.report,
    clearFeedback: channelFeedback.clear,
    t,
    addChannelTeammate,
    setDefaultChannelTeammate,
    refreshChannels,
    refreshTasks,
    refreshChannelMessages,
    refreshChannelExecutionProposals,
    refreshChannelFiles,
    refreshChannelProtocol,
    refreshExternalWorkCiTriage,
    refreshUsedMemoryAudit,
    refreshChannelMessageRouteDecisions,
    refreshChannelIntentDecisions,
    refreshRuns,
    refreshRuntimeState,
    refreshChannelActivity,
  });
  const {
    startAutoplanWorkflow,
    orchestrateWorkflowAction,
    cancelWorkflowAction,
    retryWorkflowStepAction,
    startWorkflowStepAction,
    updateWorkflowStepStatus,
  } = useChannelWorkflowController({
    form,
    channels,
    providers,
    selectedChannelId,
    taskRunProviderId,
    channelBrief,
    channelWorkflows,
    daemonBaseUrl,
    setOrchestratingWorkflowId,
    setRunningWorkflowStepId,
    setChannelWorkflows,
    setChannelWorkflowSteps,
    setSelectedTaskId,
    setTasks,
    reportWorkflowError: (identity, message, scope = "mutation") => channelFeedback.report({ workspaceCwd: form.cwd.trim(), surface: "workflow", identity, scope, message }),
    clearWorkflowError: (identity) => channelFeedback.clear("workflow", identity, form.cwd.trim()),
    createChannelWorkflowFromTemplate,
    orchestrateChannelWorkflow,
    cancelChannelWorkflow,
    retryChannelWorkflowStep,
    startChannelWorkflowStep,
    updateChannelWorkflowStep,
    streamRunRequest,
    upsertApprovalRecord,
    refreshTasks,
    refreshChannelProtocol,
    refreshRuntimeState,
    emitDomainEvent: handleDomainEvent,
  });
  const controlPlaneInvalidation = useControlPlaneInvalidation({
    daemonBaseUrl,
    daemonHealthy,
    observation: daemonObservation,
    localWebSocketRpcEnabled: daemonFeatures.transports?.localWebSocketRpc === true,
    workspaceCwd: form.cwd.trim(),
    selectedChannelId,
    selectedTeammateId: activeView === "teammates" ? selectedAiTeammate?.id ?? "" : "",
    channelRunsForArtifacts,
    setSkillLibraryRefreshToken,
    refreshRuns,
    refreshConversationThreads,
    refreshSelectedConversation,
    refreshRuntimeState,
    refreshApprovals,
    refreshApprovalPolicy,
    refreshProviders,
    refreshMcp,
    refreshPlugins,
    refreshRuntimeSettings,
    refreshAiTeammates,
    refreshUsedMemoryAudit,
    refreshChannelRunArtifacts,
    refreshChannelExecutionActions,
    refreshChannelActivity,
    refreshSelectedChannelConversation: () => selectedChannelId
      ? refreshChannelMessages(selectedChannelId, selectedChannelMessageThreadId)
      : Promise.resolve(),
    invalidateSelectedTeammateConversation: () => {
      setTeammateConversationRefreshToken((current) => current + 1);
    },
  });
  const shellErrorFeedbackItems = useMemo(() => [
    {
      key: "runtime",
      error: runtimeError,
      surface: activeView,
      visible: activeView === "workspace",
    },
    {
      key: "workspace-settings",
      error: workspaceSettingsError,
      surface: activeView,
      visible: activeView === "settings" || activeView === "workspace",
    },
    {
      key: "control-plane",
      error: controlPlaneInvalidation.error,
      surface: activeView,
      visible: true,
    },
    {
      key: "navigation-repair",
      error: navigationRepairError,
      surface: activeView,
      visible: Boolean(navigationRepairError && (
        (activeView === "runs" && (run?.id === navigationRepairError.objectId || activeRunId === navigationRepairError.objectId))
        || (activeView === "workspace" && taskRepairRunId === navigationRepairError.objectId)
      )),
    },
  ], [
    activeRunId,
    activeView,
    controlPlaneInvalidation.error,
    navigationRepairError,
    run?.id,
    runtimeError,
    taskRepairRunId,
    workspaceSettingsError,
  ]);
  useShellErrorFeedback({ dismissToast, items: shellErrorFeedbackItems, showToast });

  useEffect(() => {
    void refreshProviderTemplates();
    void refreshProviders();
    void refreshAiTeammates();
  }, []);

  useEffect(() => {
    // Retry invalidated startup reads from the next live observation. Once
    // healthy, cwd changes must not reapply the Host's default workspace.
    if (daemonObservation.paused || daemonHealthy === true) return;
    void refreshHealth();
  }, [daemonObservation.epoch, daemonObservation.paused]);

  useEffect(() => {
    const cwd = form.cwd.trim();
    if (!cwd || daemonHealthy !== true || daemonObservation.paused || daemonObservation.workspaceCwd !== cwd) return;
    // Health may change cwd before React commits the new observation. Hydrate
    // guarded workspace reads from that committed owner, never the old render.
    void refreshChannels(cwd);
    void refreshAiCouncils(cwd);
    void refreshUsedMemoryAudit(cwd);
  }, [form.cwd, daemonHealthy, daemonObservation.epoch, daemonObservation.paused]);

  useEffect(() => {
    if (activeView === "workspace") {
      void refreshChannels();
      void refreshConversationThreads();
      if (!selectedChannelId) void refreshSelectedConversation();
      void refreshRuns();
      void refreshApprovals();
      void refreshExternalWorkCiTriage();
      void refreshUsedMemoryAudit();
      void refreshWorkItems();
    }
    if (activeView === "work_board") {
      void refreshChannels();
      void refreshTasks();
      void refreshRuns();
      void refreshApprovals();
      void refreshExternalWorkCiTriage();
      void refreshWorkItems();
    }
    if (activeView === "plugins") {
      void refreshPlugins();
    }
    if (activeView === "runs") {
      void refreshRuns();
      void refreshUsedMemoryAudit();
    }
    if (activeView === "providers") {
      void refreshProviderTemplates();
      void refreshProviders();
    }
    if (activeView === "teammates") {
      void refreshAiTeammates();
      void refreshAiCouncils();
      void refreshChannels();
      void refreshProviders();
      void refreshMcp();
      void refreshApprovalPolicy();
    }
    if (activeView === "councils") {
      void refreshAiTeammates();
      void refreshAiCouncils();
      void refreshChannels();
    }
    if (activeView === "media") {
      void refreshProviders();
      void refreshMediaJobs();
    }
    if (activeView === "automations") {
      void refreshAutomations();
    }
    if (activeView === "approvals") {
      void refreshApprovals();
    }
    if (activeView === "settings") {
      void refreshApprovalPolicy();
      void refreshRuntimeSettings();
      void refreshExternalWorkStatus();
      void refreshMcp();
      void refreshPlugins();
      if (settingsWorkspaceToolView === "providers") {
        void refreshProviderTemplates();
        void refreshProviders();
      }
      if (settingsWorkspaceToolView === "teammates") {
        void refreshAiTeammates();
        void refreshChannels();
      }
      if (settingsWorkspaceToolView === "councils") {
        if (focusRevalidationToken === 0) {
          void refreshAiCouncils();
          void refreshAiTeammates();
        }
      }
    }
  }, [activeView, focusRevalidationToken]);

  useEffect(() => {
    if (selectedChannelId) {
      void refreshTasks(selectedChannelId);
      void refreshChannelMessages(selectedChannelId, selectedChannelMessageThreadId);
      void refreshChannelExecutionProposals(selectedChannelId);
      void refreshChannelFiles(selectedChannelId);
      void refreshChannelProtocol(selectedChannelId);
      void refreshChannelGovernanceNotifications(selectedChannelId);
      void refreshSelectedChannelCouncil(selectedChannelId);
      void refreshExternalWorkCiTriage(form.cwd.trim(), selectedChannelId);
      void refreshWorkItems(form.cwd.trim());
      if (activeView === "settings") {
        void refreshExternalWorkStatus(form.cwd.trim(), selectedChannelId);
      }
    } else {
      resetSelectedChannelActivity();
      resetExternalWorkSelectedChannel();
      setSelectedTaskId("");
    }
  }, [focusRevalidationToken, selectedChannelId, selectedChannelMessageThreadId]);

  useEffect(() => {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd) {
      return;
    }
    void refreshAiCouncils(workspaceCwd);
    void refreshConversationThreads(workspaceCwd);
  }, [form.cwd]);

  useEffect(() => {
    if (!selectedChannelBranchId) {
      return;
    }
    if (channelsLoading) {
      return;
    }
    if (!channelBranches.some((branch) => branch.id === selectedChannelBranchId && branch.status !== "archived")) {
      setSelectedChannelBranchId("");
    }
  }, [channelBranches, channelsLoading, selectedChannelBranchId]);

  useEffect(() => {
    if (activeView !== "workspace" || daemonObservation.paused) {
      return;
    }
    void refreshChannelRunArtifacts(form.cwd.trim(), selectedChannelId, channelRunsForArtifacts);
  }, [activeView, channelRunArtifactsKey, form.cwd, selectedChannelId, daemonObservation.paused]);

  useEffect(() => {
    if (activeView !== "workspace" || daemonObservation.paused) {
      return;
    }
    void refreshChannelExecutionActions(form.cwd.trim(), selectedChannelId, channelRunsForArtifacts);
  }, [activeView, channelRunArtifactsKey, form.cwd, selectedChannelId, daemonObservation.paused]);

  useEffect(() => {
    const cwd = form.cwd.trim();
    const hasActiveVisibleRun = channelRunsForArtifacts.some((candidate) =>
      candidate.status === "queued" || candidate.status === "running" || candidate.status === "waiting_for_approval",
    );
    if (daemonObservation.paused || activeView !== "workspace" || !cwd || !selectedChannelId || (!hasActiveVisibleRun && !hasLiveWorkflowTimeline)) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !daemonObservationRef.current.paused) {
        void refreshChannelExecutionActions(cwd, selectedChannelId, channelRunsForArtifacts);
      }
    }, 750);
    return () => window.clearInterval(interval);
  }, [activeView, channelRunArtifactsKey, form.cwd, selectedChannelId, hasLiveWorkflowTimeline, daemonObservation.paused]);

  useEffect(() => {
    if (activeView !== "workspace") {
      return;
    }
    void refreshChannelActivityTransitions(form.cwd.trim(), selectedChannelId, channelRunsForArtifacts);
  }, [activeView, channelTransitionEntityKey, form.cwd, selectedChannelId]);

  useEffect(() => {
    const cwd = form.cwd.trim();
    if (daemonObservationRef.current.paused || activeView !== "workspace" || isRunning || !workspaceTimelineRunId || !cwd) {
      return;
    }

    const loadKey = `${cwd}::${workspaceTimelineRunId}::${daemonObservation.epoch}`;
    if (workspaceTimelineLoadRef.current === loadKey) {
      return;
    }

    workspaceTimelineLoadRef.current = loadKey;
    void loadRun(workspaceTimelineRunId, cwd).catch(() => undefined);
  }, [activeView, form.cwd, isRunning, workspaceTimelineRunId, daemonObservation.epoch, daemonObservation.paused]);

  useEffect(() => {
    const syncKey = `${form.cwd}::${selectedChannelId}`;
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    if (!selectedChannel) {
      if (!selectedChannelId) {
        channelEditFormSyncKeyRef.current = "";
      }
      setChannelEditForm(defaultChannelEditForm);
      return;
    }
    if (channelEditFormSyncKeyRef.current === syncKey) {
      return;
    }
    channelEditFormSyncKeyRef.current = syncKey;
    setChannelEditForm(channelToForm(selectedChannel, form.cwd));
  }, [channels, form.cwd, selectedChannelId]);

  useEffect(() => {
    const selectedTask = tasks.find((task) => task.id === selectedTaskId);
    if (!selectedTask) {
      setTaskEditForm(defaultTaskEditForm);
      return;
    }
    setTaskEditForm({
      title: selectedTask.title,
      prompt: selectedTask.prompt,
      status: selectedTask.status,
    });
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    if (selectedApprovalId && approvals.some((approval) => approval.id === selectedApprovalId)) {
      return;
    }
    setSelectedApprovalId(approvals[0]?.id ?? "");
  }, [approvals, selectedApprovalId]);

  async function refreshHealth(): Promise<void> {
    const observationEpoch = daemonObservationRef.current.epoch;
    setDaemonHealthRefreshing(true);
    try {
      const health = await getDaemonHealth();
      if (daemonObservationRef.current.epoch !== observationEpoch) return;
      setDaemonHealthy(health.ok);
      setDaemonFeatures(health.features ?? {
        channels: { autoRoute: false },
        transports: { providerWebSocketFallback: false, localWebSocketRpc: false },
      });
      const viteDefaultWorkspaceCwd = getViteDefaultWorkspaceCwd();
      const defaultWorkspaceCwd = health.defaultWorkspaceCwd?.trim() || viteDefaultWorkspaceCwd;
      const savedWorkspaceCwd = readSavedWorkspaceCwd();
      const canApplyDaemonDefault =
        desktopHosted ||
        (!savedWorkspaceCwd && (!form.cwd.trim() || form.cwd.trim() === viteDefaultWorkspaceCwd));
      if (health.ok && defaultWorkspaceCwd && canApplyDaemonDefault) {
        if (desktopHosted) {
          if (savedWorkspaceCwd) {
            clearSavedWorkspaceCwd();
          }
          if (daemonObservationRef.current.workspaceCwd !== defaultWorkspaceCwd) {
            updateWorkspaceCwd(defaultWorkspaceCwd);
          }
        } else {
          setForm((current) =>
            current.cwd.trim() && current.cwd.trim() !== viteDefaultWorkspaceCwd
              ? current
              : { ...current, cwd: defaultWorkspaceCwd },
          );
          setChannelForm((current) =>
            current.boundPath.trim() && current.boundPath.trim() !== viteDefaultWorkspaceCwd
              ? current
              : { ...current, boundPath: defaultWorkspaceCwd },
          );
        }
        void Promise.all([
          refreshProviders(defaultWorkspaceCwd),
          refreshAiTeammates(defaultWorkspaceCwd),
          refreshMcp(defaultWorkspaceCwd),
          refreshRuns(defaultWorkspaceCwd),
          refreshApprovals(defaultWorkspaceCwd),
          refreshRuntimeState(defaultWorkspaceCwd),
          refreshWorkItems(defaultWorkspaceCwd),
          loadStartupStatus(defaultWorkspaceCwd),
        ]).catch(() => undefined);
      }
    } catch {
      if (daemonObservationRef.current.epoch !== observationEpoch) return;
      setDaemonHealthy(false);
      setDaemonFeatures({
        channels: { autoRoute: false },
        transports: { providerWebSocketFallback: false, localWebSocketRpc: false },
      });
    } finally {
      setDaemonHealthRefreshing(false);
    }
  }

  async function startRun(): Promise<void> {
    await runWithRequest(buildRunRequest(form), form.cwd.trim());
  }

  async function confirmFullAccessRunIfNeeded(requestBody: unknown): Promise<unknown | undefined> {
    const workspaceAccessMode = readRequestWorkspaceAccessMode(requestBody);
    if (workspaceAccessMode !== "full_access" && (workspaceAccessMode !== undefined || readRequestPermissionMode(requestBody) !== "full_access")) {
      return requestBody;
    }
    const permissionConfirmation = await fullAccessConfirmation.request(fullAccessRunScope({
      requestBody,
      fallbackWorkspaceCwd: form.cwd,
      selectedChannelId,
      selectedChannelBranchId,
      policyRevision: currentFullAccessPolicyRevision,
    }));
    if (!permissionConfirmation) {
      return undefined;
    }
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
      return requestBody;
    }
    return {
      ...requestBody,
      permissionConfirmation,
    };
  }

  async function refreshChannelActivity(): Promise<void> {
    if (daemonObservationRef.current.paused) throw new DaemonObservationDeferredError();
    const channelId = selectedChannelId;
    if (!channelId) {
      return;
    }

    try {
      await Promise.all([
        refreshChannels(),
        refreshTasks(channelId),
        refreshChannelMessages(channelId, selectedChannelMessageThreadId),
        refreshChannelExecutionProposals(channelId),
        refreshChannelFiles(channelId),
        refreshChannelRunArtifacts(form.cwd.trim(), channelId, channelRunsForArtifacts),
        refreshChannelExecutionActions(form.cwd.trim(), channelId, channelRunsForArtifacts),
        refreshChannelProtocol(channelId),
        refreshChannelGovernanceNotifications(channelId),
        refreshSelectedChannelCouncil(channelId),
        refreshRuns(),
        refreshApprovals(),
        refreshExternalWorkCiTriage(form.cwd.trim(), channelId),
        refreshUsedMemoryAudit(),
      ]);
      await refreshChannelActivityTransitions(form.cwd.trim(), channelId, channelRunsForArtifacts);
    } catch {
      // Each child refresh keeps its failure with its own channel or domain owner.
    }
  }

  async function refreshApprovalDependents(workspaceCwd: string, event: {
    readonly runId?: string;
    readonly mediaJobId?: string;
    readonly externalWorkActionId?: string;
    readonly channelId?: string;
  }): Promise<void> {
    const owner = approvalRefreshOwner;
    const observationEpoch = daemonObservationRef.current.epoch;
    const isCurrent = () => approvalRefreshOwnerRef.current === owner && owner.cwd === workspaceCwd
      && !daemonObservationRef.current.paused && daemonObservationRef.current.epoch === observationEpoch;
    if (!isCurrent()) return;
    await refreshConversationThreads(workspaceCwd);
    if (!isCurrent()) return;
    window.setTimeout(() => {
      if (isCurrent()) void refreshConversationThreads(workspaceCwd);
    }, 750);
    if (event.runId && selectedConversationDetail?.runs.some((run) => run.id === event.runId)) {
      await refreshSelectedConversation(workspaceCwd);
      if (!isCurrent()) return;
    }
    if (event.externalWorkActionId) {
      await refreshExternalActionDetailsByIds(workspaceCwd, [event.externalWorkActionId]);
      if (!isCurrent()) return;
    }
    const isDiagnosticRun = event.runId && (event.runId === activeRunId || event.runId === lookupRunId || event.runId === approvalRepairRunId);
    if (isDiagnosticRun) {
      try {
        await Promise.all([loadRun(event.runId, workspaceCwd), refreshRuns(workspaceCwd)]);
      } catch (error) {
        // Approval acceptance is already a fact; deferring its observation is
        // not an approval failure. Real read/HTTP errors keep their owner.
        if (error instanceof DaemonObservationDeferredError) return;
        throw error;
      }
      if (!isCurrent()) return;
      window.setTimeout(() => {
        if (!isCurrent()) return;
        void loadRun(event.runId, workspaceCwd).catch(() => undefined);
        void refreshRuns(workspaceCwd);
        void refreshApprovals(workspaceCwd, event.runId);
      }, 750);
    }
    if (event.mediaJobId) await refreshMediaJobs(workspaceCwd);
    if (!isCurrent()) return;
    const channelId = selectedChannelId && (event.channelId
      ? event.channelId === selectedChannelId
      : channelRunsForArtifacts.some(candidate => candidate.id === event.runId)) ? selectedChannelId : undefined;
    if (channelId) {
      // Do not call refreshChannelActivity: it also refreshes approval receipts.
      await Promise.all([
        ...(isDiagnosticRun ? [] : [refreshRuns(workspaceCwd)]),
        refreshTasks(channelId),
        refreshChannelMessages(channelId, selectedChannelMessageThreadId),
        refreshChannelProtocol(channelId),
        refreshChannelFiles(channelId),
        refreshChannelRunArtifacts(workspaceCwd, channelId, channelRunsForArtifacts),
        refreshChannelExecutionActions(workspaceCwd, channelId, channelRunsForArtifacts),
        refreshChannelActivityTransitions(workspaceCwd, channelId, channelRunsForArtifacts),
      ]);
    }
  }

  async function handleDomainEvent(event: DomainEvent): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    switch (event.type) {
      case "view.openRequested":
        if (isSettingsWorkspaceToolView(event.view)) {
          openSettingsWorkspaceTool(event.view);
          return;
        }
        setActiveView(event.view);
        setActiveSidebarTarget(event.target ?? event.view);
        return;

      case "approval.recoveryChanged": {
        if (event.cwd !== workspaceCwd) return;
        const scope = `approval:${event.approvalId}:postcommit`;
        const notice = approvalRecoveryNotice(event.recoveryState);
        if (notice) {
          showToast({
            message: t(notice.message),
            scope,
            tone: notice.tone,
            durationMs: notice.tone === "warning" ? 15_000 : 3_000,
          });
        } else {
          dismissToast(scope);
          // Recovery completion may arrive without SSE. Refresh the owning
          // views, not the receipt observer itself, to avoid recursive lookups.
          if (event.runId || event.mediaJobId || event.externalWorkActionId || event.channelId) {
            await refreshApprovalDependents(workspaceCwd, event);
          }
        }
        return;
      }

      case "approval.resolved":
        await refreshApprovals(workspaceCwd, event.runId);
        await refreshApprovalDependents(workspaceCwd, event);
        return;

      case "provider.repairRequested": {
        const provider = event.providerPresetId ? providers.find((item) => item.id === event.providerPresetId) : undefined;
        if (event.sourceRunId) {
          setProviderRepairRunId(event.sourceRunId);
        }
        if (provider) {
          editProvider(provider);
        }
        if (event.sourceRunId) {
          clearSettingsWorkspaceToolView();
          setActiveView("providers");
          setActiveSidebarTarget("providers");
        } else {
          setProviderRepairRunId("");
          openSettingsWorkspaceTool("providers");
        }
        return;
      }

      case "workflow.advanced":
      case "workflow.cancelled":
      case "workflowStep.retried":
      case "workflowStep.updated":
        await Promise.all([
          refreshChannelProtocol(event.channelId),
          event.type === "workflowStep.updated" ? Promise.resolve() : refreshTasks(event.channelId),
          refreshRuns(workspaceCwd),
          refreshApprovals(workspaceCwd),
          refreshRuntimeState(workspaceCwd),
        ]);
        return;

      default:
        return;
    }
  }

  async function selectRun(runId: string): Promise<void> {
    await loadRun(runId);
    void refreshApprovals(form.cwd.trim(), runId);
  }

  async function openRunFromWorkspace(runId: string): Promise<void> {
    await selectRun(runId);
    openRunDiagnosticsView();
  }

  const settingsWorkspaceToolDetail =
    settingsWorkspaceToolView === "providers" ? (
      <ProviderSettings
        cwd={form.cwd}
        providers={providers}
        templates={providerTemplates}
        form={providerForm}
        editingProviderId={editingProviderId}
        isLoading={providersLoading}
        checkingProviderIds={checkingProviderIds}
        errorMessage={providersDomain.error?.message ?? ""}
        checkResult={providerCheck}
        checkedProviderId={providerCheckTargetId}
        checkScope={providerCheckScope}
        batchResult={providerBatchResult}
        operationWarning={providerOperationWarning}
        selectedTemplateId={selectedProviderTemplateId}
        repairRun={providerRepairRun}
        isRunning={isRunning}
        setupIntent={providerSetupIntent}
        onSetupIntentConsumed={() => setProviderSetupIntent("")}
        onFormChange={setProviderForm}
        onTemplateSelect={selectProviderTemplate}
        onNew={startNewProviderFromTemplate}
        onSave={saveProviderWithPreflight}
        onImportModels={importModelsFromProviderForm}
        onRefresh={() => void refreshProviders()}
        onEdit={editProvider}
        onDelete={(providerId) => void removeProvider(providerId)}
        onCheck={(providerId) => void runProviderCheck(providerId)}
        onCheckBatch={runProviderBatchCheck}
        onToggleEnabled={(provider, enabled) => void toggleProviderEnabled(provider, enabled)}
        onRerun={(sourceRun) => void rerunRun(sourceRun)}
        onOpenRun={(runId) => {
          openSettingsRunDiagnostics(runId);
        }}
        onClearCheckFeedback={clearProviderCheckFeedback}
        onClearRepair={() => setProviderRepairRunId("")}
        settingsToolMode
        workspaceSettings={workspaceSettings}
        onPatchWorkspaceSettings={(patch) => patchWorkspaceSettings(patch, { errorOwner: "caller" })}
      />
    ) : settingsWorkspaceToolView === "teammates" ? (
      <AiTeammatesPage
        cwd={form.cwd}
        skillPack={builtinSkillPack}
        providers={providers}
        channels={channels}
        localTeammates={localTeammates}
        isLoading={aiTeammatesLoading}
        loadErrorMessage={teammateListErrorMessage || undefined}
        actionErrorMessagesByTeammateId={teammateActionErrorMessagesById}
        defaultProviderId={workspaceDefaultProviderPresetId}
        onCreateTeammate={addAiTeammate}
        onRemoveTeammate={(teammateId) => void removeAiTeammate(teammateId).catch(() => undefined)}
        onToggleTeammatePinned={(teammateId) => void toggleAiTeammatePinned(teammateId).catch(() => undefined)}
        onToggleTeammateHidden={(teammateId) => void toggleAiTeammateHidden(teammateId).catch(() => undefined)}
        onEditTeammate={openAiTeammateSettings}
        onOpenTeammate={(teammateId) => {
          clearSettingsWorkspaceToolView();
          closeSettingsRunDiagnostics();
          selectAiTeammate(teammateId);
        }}
        onOpenCouncils={() => {
          openSettingsWorkspaceTool("councils");
        }}
        onOpenProviders={() => openSettingsWorkspaceTool("providers")}
        onRefresh={() => void refreshAiTeammates(form.cwd.trim())}
        settingsToolMode
      />
    ) : settingsWorkspaceToolView === "councils" ? (
      <CouncilWorkspacePage
        cwd={form.cwd}
        aiCouncils={aiCouncils}
        aiCouncilHealthReport={aiCouncilHealthReport}
        aiCouncilsLoading={aiCouncilsLoading}
        channels={channels}
        teammates={aiTeammates}
        onRefresh={() => refreshAiCouncils()}
        onOpenAiTeammates={() => openSettingsWorkspaceTool("teammates")}
        onOpenChannel={(channelId) => {
          clearSettingsWorkspaceToolView();
          closeSettingsRunDiagnostics();
          selectWorkspaceChannel(channelId);
        }}
        settingsToolMode
      />
    ) : undefined;

  const settingsFullscreen = activeView === "settings";
  const showInspector = !["workspace", "providers", "plugins", "teammates", "councils", "threads", "automations", "approvals", "work_board", "media", "profile", "settings"].includes(activeView);
  const selectedChannelForRun = channels.find((channel) => channel.id === selectedChannelId);
  const selectedProviderIdForRun =
    taskRunProviderId || selectedChannelForRun?.defaultProviderPresetId || workspaceDefaultProviderPresetId || "";
  const navigationActiveSidebarTarget =
    activeView === "workspace" && selectedChannelId ? channelSidebarTarget(selectedChannelId) : activeSidebarTarget;
  const navigationSelectedRecentConversationId = recentConversations.some((conversation) => conversation.id === conversationIdentity)
    ? conversationIdentity
    : selectedConversationThreadId;
  const openSidebarView = (view: ViewId): void => {
    if (view === "workspace") {
      openConversationHome();
      return;
    }
    if (view === "work_board") {
      openWorkBoard();
      return;
    }
    openPlainViewWithoutSettingsReturn(view);
  };
  const shellClassName = [
    "app-shell",
    "channel-drawer-shell",
    "desktop-window-shell",
    activeView === "workspace" ? "channel-daylight-shell" : "",
    settingsFullscreen ? "settings-fullscreen-shell" : "",
    !channelSidebarOpen ? "channel-sidebar-collapsed" : "",
    showInspector && inspectorCollapsed ? "inspector-collapsed" : "",
    showInspector ? "" : "inspector-hidden",
    desktopPlatform === "macos" ? "desktop-macos" : "",
    desktopPlatform === "windows" ? "desktop-windows" : "",
    desktopHosted ? "" : "desktop-web",
  ].filter(Boolean).join(" ");
  const workspaceSurfaceRef = useRef<HTMLElement>(null);
  const desktopSelectedConversationId = selectDesktopComputerUseConversation({
    activeView,
    selectedChannelId,
    selectedChannelBranchRootThreadId,
    selectedConversationThreadId,
    selectedAiTeammateId: selectedAiTeammate?.id,
    teammateDirectThreadId: desktopTeammateConversationId,
  });
  const desktopComputerUseSurfaceKind = desktopSelectedConversationId
    ? activeView === "teammates"
      ? "teammate_direct"
      : selectedChannelId
        ? "channel"
        : "normal_conversation"
    : undefined;
  return (
    <DaemonObservationProvider value={daemonObservation}>
    <DesktopTitlebarProvider>
    <AppShellOverlayBoundary className={shellClassName}>
      <DesktopWindowChrome
        hideSidebarLabel={t("Hide navigation")}
        onSidebarOpenChange={setChannelSidebarOpen}
        showSidebarLabel={t("Show navigation")}
        sidebarOpen={channelSidebarOpen}
        sidebarToggleVisible={!settingsFullscreen}
      />
      <AppPresentationSurfaceBridge
        activeView={activeView}
        hasSelectedChannel={Boolean(selectedChannelId)}
        hasSelectedConversation={Boolean(selectedConversationThreadId)}
        hasSelectedTeammate={Boolean(selectedAiTeammate)}
      />
      <AppConnectionStatus
        desktopStatus={desktopDaemonStatus}
        offline={daemonHealthy === false}
        refreshing={daemonHealthRefreshing}
        onRetry={() => void refreshHealth()}
      />
      {!settingsFullscreen && channelSidebarOpen ? (
      <SidebarNavigation
        activeSidebarTarget={navigationActiveSidebarTarget}
        channels={channels}
        channelBranches={channelBranches}
        selectedChannelBranchId={selectedChannelBranchId}
        teammates={aiTeammates}
        cwd={form.cwd}
        channelsInitialLoading={channelsLoading && channels.length === 0}
        teammatesInitialLoading={aiTeammatesLoading && aiTeammates.length === 0}
        stale={daemonHealthy === false}
        channelNotifications={sidebarChannelNotifications}
        teammateNotifications={sidebarTeammateNotifications}
        objectContexts={sidebarObjectContexts}
        recentConversations={recentConversations}
        recentConversationsInitialLoading={conversationThreadsLoading && recentConversations.length === 0}
        recentConversationActionError={conversationSidebarError}
        selectedRecentConversationId={activeView === "workspace" && !selectedChannelId ? navigationSelectedRecentConversationId : ""}
        onOpenView={openSidebarView}
        onOpenConversationHome={openConversationHome}
        onCreateChannel={openChannelCreatePanel}
        onCreateTeammate={openTeammateCreatePanel}
        teammateCreateModelReady={teammateCreateModelReady}
        onOpenTeammateModelWorkbench={() => openSettingsWorkspaceTool("providers")}
        onCreateChannelBranch={(channelId, name) => void saveChannelBranch(channelId, name)}
        onArchiveChannel={(channelId) => void archiveSidebarChannel(channelId)}
        onArchiveChannelBranch={(channelId, branchId) => void archiveSidebarChannelBranch(channelId, branchId)}
        onArchiveTeammate={(teammateId) => void archiveAiTeammate(teammateId).catch(() => undefined)}
        onArchiveRecentConversation={(conversation) => void archiveConversationThread(conversation.id)}
        onArchiveAllRecentConversations={archiveAllConversationThreads}
        onSelectChannel={(channelId) => {
          clearSettingsWorkspaceToolView();
          selectWorkspaceChannel(channelId);
          if (narrowViewport) setChannelSidebarOpen(false);
        }}
        onSelectChannelBranch={(channelId, branchId) => {
          clearSettingsWorkspaceToolView();
          selectWorkspaceChannelBranch(channelId, branchId);
          if (narrowViewport) setChannelSidebarOpen(false);
        }}
        onSelectTeammate={(teammateId) => {
          clearSettingsWorkspaceToolView();
          selectAiTeammate(teammateId);
          if (narrowViewport) setChannelSidebarOpen(false);
        }}
        onSelectRecentConversation={selectRecentConversation}
        channelDrawer
      />
      ) : !settingsFullscreen ? (
        <SidebarCompactRail
          activeSidebarTarget={navigationActiveSidebarTarget}
          selectedRecentConversationId={activeView === "workspace" && !selectedChannelId ? navigationSelectedRecentConversationId : ""}
          onExpand={() => setChannelSidebarOpen(true)}
          onOpenConversationHome={openConversationHome}
          onOpenView={openSidebarView}
        />
      ) : null}
      <section
        ref={workspaceSurfaceRef}
        className={
          activeView === "workspace"
            ? "workspace workspace-client-surface"
            : activeView === "teammates" && selectedAiTeammate
              ? "workspace workspace-teammate-private-surface"
            : activeView === "teammates" && !selectedAiTeammate
              ? "workspace workspace-teammates-surface"
              : activeView === "councils"
                ? "workspace workspace-councils-surface"
              : activeView === "providers"
                ? "workspace workspace-provider-surface"
              : activeView === "plugins"
                ? "workspace workspace-plugins-surface"
              : activeView === "automations"
                ? "workspace workspace-automations-surface"
              : activeView === "media"
                ? "workspace workspace-generation-surface"
              : activeView === "settings"
                ? "workspace workspace-settings-surface"
              : "workspace"
        }
      >
        <CurrentSessionHeaderCapabilityProvider>
          <WorkSummaryProvider key={form.cwd} cwd={form.cwd} onOpenSession={(session) => {
            clearSettingsWorkspaceToolView();
            if (session.surface === "conversation" && session.threadId) { void openConversationThread(session.threadId); }
            else if (session.surface === "teammate" && session.teammateId) { selectAiTeammate(session.teammateId); }
            else if (session.threadId) {
              setThreadPageTargetId(session.threadId);
              setActiveView("threads"); setActiveSidebarTarget("threads");
            } else if (session.channelId) { selectWorkspaceChannel(session.channelId); }
          }}>

          <DesktopComputerUseBridge
            selectedConversationId={desktopSelectedConversationId}
            surfaceKind={desktopComputerUseSurfaceKind}
            hostRef={workspaceSurfaceRef}
          />
          <LazyPageErrorBoundary
            resetKey={`${activeView}:${selectedAiTeammate?.id ?? ""}`}
            title={t("Page failed to load")}
            retryLabel={t("Reload")}
          >
            <Suspense fallback={<div className="client-empty-state"><span>{t("Loading")}</span></div>}>
            {activeView === "workspace" ? (
              selectedChannelId ? (
                <WorkspaceClientView
            cwd={form.cwd}
            daemonHealthy={daemonHealthy}
            channelAutoRouteEnabled={daemonFeatures.channels.autoRoute}
            providerLabel={`${form.provider}/${form.model}`}
            userProfile={userProfile}
            channels={channels}
            selectedChannelId={selectedChannelId}
            selectedChannelBranchRootThreadId={selectedChannelBranchRootThreadId}
            channelCreateOpen={channelCreateOpen}
            channelEditForm={channelEditForm}
            tasks={tasks}
            taskForm={taskForm}
            channelMessages={channelMessages}
            channelConversationItems={channelConversationItems}
            channelTurnContextAssignments={channelTurnContextAssignments}
            channelUserInputs={channelUserInputs}
            channelReasoningSummaries={channelReasoningSummaries}
            channelContextCompactions={channelContextCompactions}
            channelConversationRefreshToken={channelConversationRefreshToken}
            channelGeneratedMedia={channelGeneratedMedia}
            memoryById={memoryById}
            usedMemoryEvents={usedMemoryEvents}
            channelExecutionProposals={channelExecutionProposals}
            channelAttachments={channelAttachments}
            channelLinkPreviews={channelLinkPreviews}
            channelArtifactsByRun={channelArtifactsByRun}
            channelArtifactErrorsByRun={channelArtifactErrorsByRun}
            channelExecutionActions={channelExecutionActions}
            channelExecutionActionError={channelExecutionActionError}
            channelBrief={channelBrief}
            channelCollaborationProtocol={channelCollaborationProtocol}
            channelDecisions={channelDecisions}
            channelIntentDecisions={channelIntentDecisions}
            channelMessageRouteDecisions={channelMessageRouteDecisions}
            channelHandoffs={channelHandoffs}
            channelContextSummaries={channelContextSummaries}
            channelWorkflows={channelWorkflows}
            channelWorkflowSteps={channelWorkflowSteps}
            channelStateTransitions={channelStateTransitions}
            channelActivityTransitionsLoading={channelActivityTransitionsLoading}
            channelActivityTransitionError={channelActivityTransitionError}
            channelGovernanceNotifications={channelGovernanceNotifications}
            channelGovernanceNotificationsLoading={channelGovernanceNotificationsLoading}
            channelGovernanceNotificationActionId={channelGovernanceNotificationActionId}
            aiCouncils={aiCouncils}
            aiCouncilHealthReport={aiCouncilHealthReport}
            aiCouncilsLoading={aiCouncilsLoading}
            channelCouncilPolicy={channelCouncilPolicy}
            channelEffectiveCouncil={channelEffectiveCouncil}
            channelCouncilLoading={channelCouncilLoading}
            channelCouncilSaving={channelCouncilSaving}
            externalWorkCiTriage={externalWorkCiTriage}
            externalWorkCiTriageLoading={externalWorkCiTriageLoading}
            durableWorkItems={durableWorkItems}
            durableWorkItemsLoading={durableWorkItemsLoading}
            selectedTaskId={selectedTaskId}
            providers={providers}
            teammateTemplates={aiTeammates.length > 0 ? [] : builtinTeammateTemplates}
            slashCommands={slashCommands}
            localTeammates={localTeammates}
            channelTeammateMemberships={selectedChannelTeammateMemberships}
            channelTeammateMembershipsLoading={teammateChannelMembershipsLoading}
            channelTeammateSavingId={channelTeammateSavingId}
            channelTeammateError={teammateChannelRelationErrorByChannelId[selectedChannelId]}
            taskRunProviderId={taskRunProviderId}
            fallbackProviderId={workspaceDefaultProviderPresetId}
            channelsLoading={channelsLoading}
            tasksLoading={tasksLoading}
            channelMessagesLoading={channelMessagesLoading}
            channelMessagesHasOlder={channelMessagesHasOlder}
            channelMessagesLoadingOlder={channelMessagesLoadingOlder}
            channelFilesLoading={channelFilesLoading}
            channelRunArtifactsLoading={channelRunArtifactsLoading}
            channelProtocolLoading={channelProtocolLoading}
            providersLoading={providersLoading}
            approvals={approvals}
            externalActionDetails={externalActionDetails}
            approvalsLoading={approvalsLoading}
            resolvingApprovals={resolvingApprovals}
            approvalErrors={approvalErrors}
            resourceLeases={resourceLeases}
            runtimeDiagnostics={runtimeDiagnostics}
            workUnits={workUnits}
            runtimeLoading={runtimeLoading}
            runtimeActionWorkUnitId={runtimeActionWorkUnitId}
            runs={runs}
            runById={runById}
            activeRunId={activeRunId}
            latestStatus={latestStatus}
            isRunning={isRunning}
            cancellingRunIds={cancellingRunIds}
            approvalPolicy={approvalPolicy}
            authorizationMode={form.authorizationMode}
            permissionMode={form.permissionMode}
            permissionPreset={permissionPresetForWorkspaceAccessMode(form.workspaceAccessMode)}
            fullAccessConfirmed={fullAccessConfirmation.isConfirmed(channelConversationFullAccessScope)}
            activeTaskRunAction={activeTaskRunAction}
            runningWorkflowStepId={runningWorkflowStepId}
            orchestratingWorkflowId={orchestratingWorkflowId}
            channelFeedbackEntries={channelFeedback.entries}
            onClearChannelFeedback={channelFeedback.clear}
            onChannelCreateOpenChange={setChannelCreateOpen}
            onChannelEditFormChange={setChannelEditForm}
            onTaskFormChange={setTaskForm}
            onProviderSelect={(providerId) => {
              setTaskRunProviderId(providerId);
              const provider = providers.find((item) => item.id === providerId);
              if (provider) {
                void applyProviderToRun(provider, { scope: "channel" });
              }
            }}
            onAddChannelTeammate={(teammateId) => addChannelTeammate(selectedChannelId, teammateId)}
            onRemoveChannelTeammate={(teammateId) => removeChannelTeammate(selectedChannelId, teammateId)}
            onOpenTeammates={() => openSettingsWorkspaceTool("teammates")}
            onRefreshChannels={() => void refreshChannels()}
            onSaveChannel={(formOverride) => selectedChannelId ? saveChannelEdit(selectedChannelId, formOverride) : undefined}
            onCreateTask={saveTask}
            onCreateTaskFromSlashCommand={createTaskFromSlashCommand}
            onSendMessage={sendChannelMessage}
            onConfirmExecutionProposal={confirmChannelExecutionProposal}
            onCancelExecutionProposal={cancelChannelExecutionProposal}
            onUploadAttachments={(files) => uploadChannelFiles(files)}
            onCreateLinkPreview={(url) => addChannelLinkPreview(url)}
            onDeleteAttachment={(attachmentId) => void removeChannelAttachment(attachmentId)}
            onSaveBrief={(input) => void saveChannelBrief(input)}
            onSaveChannelProtocol={saveChannelProtocolPatch}
            onRevertChannelProtocol={revertChannelProtocolSettings}
            onSupersedeDecision={supersedeChannelDecision}
            onRejectDecision={rejectChannelDecision}
            onCreateHandoffFromTask={createHandoffFromTask}
            onUpdateHandoffStatus={(handoff, status) => void updateHandoffStatusValue(handoff, status)}
            onStartWorkflowFromHandoff={startWorkflowFromHandoff}
            onStartTemplateWorkflow={() => void startAutoplanWorkflow()}
            onOrchestrateWorkflow={orchestrateWorkflowAction}
            onCancelWorkflow={cancelWorkflowAction}
            onStartWorkflowStep={(step, mode) => void startWorkflowStepAction(step, mode)}
            onRetryWorkflowStep={retryWorkflowStepAction}
            onUpdateWorkflowStepStatus={(step, status) => void updateWorkflowStepStatus(step, status)}
            onCreateTaskFromContextSummary={createTaskFromContextSummary}
            onRunActivityTriageAction={runActivityTriageAction}
            onLoadOlderChannelMessages={() => void loadOlderChannelMessages(selectedChannelId, selectedChannelMessageThreadId)}
            onRefreshChannelMessages={() => void Promise.all([
              refreshChannelMessages(selectedChannelId, selectedChannelMessageThreadId),
              refreshChannelMessageRouteDecisions(),
              refreshChannelIntentDecisions(),
              refreshChannelExecutionProposals(),
              refreshChannelGovernanceNotifications(),
              refreshUsedMemoryAudit(form.cwd.trim()),
            ])}
            onRefreshPendingChannelReply={() => void refreshChannelMessages(
              selectedChannelId,
              selectedChannelMessageThreadId,
              { silent: true },
            )}
            onRefreshChannelActivity={refreshChannelActivity}
            onRefreshExternalWorkCiTriage={() => void refreshExternalWorkCiTriage()}
            onRefreshWorkItems={() => void refreshWorkItems()}
            onRefreshChannelProtocol={() => void refreshChannelProtocol()}
            onRefreshChannelFiles={() => void Promise.all([refreshChannelFiles(), refreshChannelRunArtifacts()])}
            onMarkChannelGovernanceNotificationSeen={(notificationId) => void markChannelGovernanceNotificationSeen(notificationId)}
            onDismissChannelGovernanceNotification={(notificationId) => void dismissChannelGovernanceNotification(notificationId)}
            onRefreshAiCouncils={() => void refreshAiCouncils()}
            onRefreshChannelCouncil={() => void refreshSelectedChannelCouncil()}
            onUpdateChannelCouncilPolicy={(input) => updateSelectedChannelCouncilPolicy(input)}
            attachmentContentUrl={(attachment) => channelAttachmentContentUrl(attachment, form.cwd.trim())}
            onRefreshTasks={() => void refreshTasks()}
            onRefreshRunApprovals={() => void refreshApprovals(form.cwd.trim(), activeRunId || undefined)}
            onSelectTask={setSelectedTaskId}
            onCheckThenRunTask={(task) => void checkThenRunPersistedTask(task)}
            onRunTask={(task) => void runPersistedTask(task)}
            onAuthorizationModeChange={(authorizationMode) => {
              setForm((current) => {
                const legacy = authorizationAndAccessToLegacyPermission(authorizationMode, current.workspaceAccessMode);
                return {
                  ...current,
                  authorizationMode,
                  permissionMode: legacy.permissionMode,
                  permissionPreset: legacy.permissionPreset,
                };
              });
            }}
            onPermissionModeChange={async (permissionMode) => {
              if (permissionMode === "full_access") {
                const confirmation = await fullAccessConfirmation.request(channelConversationFullAccessScope);
                if (!confirmation) return;
              }
              setForm((current) => {
              const workspaceAccessMode = workspaceAccessModeForPermissionPreset(permissionMode === "full_access"
                ? "full_access"
                : permissionMode === "ask_everything"
                  ? "read_only"
                  : "workspace_collaboration");
              const legacy = authorizationAndAccessToLegacyPermission(current.authorizationMode, workspaceAccessMode);
              return {
                ...current,
                workspaceAccessMode,
                permissionMode: legacy.permissionMode,
                permissionPreset: legacy.permissionPreset,
              };
              });
            }}
            onCancelActiveRun={(targetRun) => void cancelRunOrWorkUnit(targetRun)}
            onOpenRun={(runId) => void openRunFromWorkspace(runId)}
            onOpenApprovals={(runId) => openApprovalsFromWorkspace(runId)}
            onRefreshRuntime={() => void refreshRuntimeState()}
            onCancelWorkUnit={(workUnitId) => void runWorkUnitAction(workUnitId, "cancel")}
            onRetryWorkUnit={(workUnitId) => void runWorkUnitAction(workUnitId, "retry")}
            onReconcileWorkUnit={(workUnitId) => void runWorkUnitAction(workUnitId, "reconcile")}
            onResolveApproval={(approvalId, decision, reason, proposedRuleFingerprint) => void resolveApproval(
              approvalId,
              decision,
              reason,
              proposedRuleFingerprint,
            )}
            onClaimWorkItem={(workItemId) => void claimDurableWorkItem(workItemId)}
            onHeartbeatWorkItem={(workItemId, claimToken) => void heartbeatDurableWorkItem(workItemId, claimToken)}
            onReleaseWorkItem={(workItemId, claimToken) => void releaseDurableWorkItem(workItemId, claimToken)}
            onCompleteWorkItem={(workItemId, claimToken) => void completeDurableWorkItem(workItemId, claimToken)}
            onFailWorkItem={(workItemId, claimToken) => void failDurableWorkItem(workItemId, claimToken)}
            busyWorkItemId={busyWorkItemId}
            onOpenProviders={(sourceRun) => {
              if (sourceRun) {
                clearSettingsWorkspaceToolView();
                openProvidersFromRun(sourceRun);
                return;
              }
              openSettingsWorkspaceTool("providers");
            }}
            workspaceSettings={workspaceSettings}
            onWorkspaceSettingsPatch={patchWorkspaceSettings}
              />
              ) : (
                <ConversationHome
                  executionSelectionRevision={JSON.stringify([settingsDomain.state.runtimeSettings?.updatedAt, approvalPolicy])}
                  conversationTitle={selectedConversationDetail?.thread.title ?? ""}
                  initialMessages={selectedConversationMessages}
                  initialProjectPath={selectedConversationProjectPath}
                  initialProjectLabel={selectedConversationProjectLabel}
                  initialProviderPresetId={selectedConversationDetail?.defaults.providerPresetId ?? ""}
                  initialThinkingLevel={selectedConversationDetail?.defaults.thinkingLevel ?? "off"}
                  initialReasoningSummary={selectedConversationDetail?.defaults.reasoningSummary ?? workspaceSettings?.defaultReasoningSummary ?? "auto"}
                  initialAuthorizationMode={selectedConversationDetail?.defaults.authorizationMode ?? workspaceSettings?.defaultAuthorizationMode}
                  initialWorkspaceAccessMode={selectedConversationDetail?.defaults.workspaceAccessMode ?? workspaceSettings?.defaultWorkspaceAccessMode}
                  defaultWorkspaceAccessMode={resolveWorkspaceAccessMode(workspaceSettings?.defaultWorkspaceAccessMode, workspaceSettings?.defaultPermissionMode, workspaceSettings?.defaultPermissionPreset)}
                  initialPermissionMode={selectedConversationDetail?.defaults.permissionMode ?? workspaceSettings?.defaultPermissionMode}
                  initialPermissionPreset={selectedConversationDetail?.defaults.permissionPreset ?? workspaceSettings?.defaultPermissionPreset}
                  detailContext={selectedConversationDetail ? {
                    threadId: selectedConversationDetail.thread.id,
                    conversationItems: selectedConversationDetail.conversationItems,
                    runLinks: selectedConversationDetail.runLinks,
                    turns: selectedConversationDetail.turns,
                    runs: selectedConversationDetail.runs,
                    executionActions: selectedConversationDetail.executionActions,
                    approvals: selectedConversationDetail.approvals,
                    interventions: selectedConversationDetail.interventions,
                    terminalReports: selectedConversationDetail.terminalReports,
                    artifacts: selectedConversationDetail.artifacts,
                    plans: selectedConversationDetail.plans,
                    compactionCheckpoints: selectedConversationDetail.compactionCheckpoints,
                    contextSnapshots: selectedConversationDetail.contextSnapshots,
                    contextSummaries: selectedConversationDetail.contextSummaries,
                    generatedMedia: selectedConversationDetail.generatedMedia,
                    timelineProjection: projectConversationDetailTimeline(selectedConversationDetail),
                  } : undefined}
                  inlineApprovalViews={normalConversationInlineApprovalViews}
                  resolvingApprovals={resolvingApprovals}
                  approvalErrors={approvalErrors}
                  conversationIdentity={conversationIdentity}
                  defaultProviderLabel={defaultConversationProviderLabel}
                  defaultProviderPresetId={defaultConversationProviderPresetId}
                  modelOptions={conversationModelOptions}
                  slashCommands={slashCommands}
                  workspaceCwd={form.cwd}
                  conversationErrorMessage={conversationSurfaceError || conversationComposerError}
                  sending={conversationStreamBusy}
                  activeRun={activeConversationRun}
                  stopping={Boolean(activeConversationRun && cancellingRunIds.includes(activeConversationRun.id))}
                  onOpenRun={(runId) => void openRunFromWorkspace(runId)}
                  onOpenModelWorkbench={() => openSettingsWorkspaceTool("providers")}
                  fullAccessConfirmed={fullAccessConfirmation.isConfirmed(normalConversationConfirmationScope)}
                  onConfirmFullAccess={() => fullAccessConfirmation.request(normalConversationConfirmationScope)}
                  onConfirmFullAccessSelection={() => fullAccessConfirmation.request(normalConversationConfirmationScope)}
                  onFullAccessConversationBound={(threadId) => fullAccessConfirmation.bind(
                    normalConversationConfirmationScope,
                    {
                      ...normalConversationConfirmationScope,
                      conversationId: `conversation:${threadId}`,
                    },
                  )}
                  onRefreshConversation={() => Promise.all([
                    refreshConversationThreads(form.cwd.trim()),
                    refreshSelectedConversation(form.cwd.trim()),
                  ]).then(() => undefined)}
                  onStopConversation={(target) => {
                    const targetRun = selectedConversationDetail?.runs.find((run) => run.id === target.runId);
                    if (targetRun) {
                      void cancelRunOrWorkUnit(targetRun);
                      return;
                    }
                    if (target.workUnitId) void runWorkUnitAction(target.workUnitId, "cancel");
                  }}
                  onResolveApproval={(approvalId, decision, reason, proposedRuleFingerprint) => void resolveApproval(
                    approvalId,
                    decision,
                    reason,
                    proposedRuleFingerprint,
                  )}
                  onSendConversation={async (input) => {
                    await sendConversationMessage({
                      message: input.message,
                      attachmentIds: input.attachmentIds,
                      fileRefs: input.fileRefs,
                      projectPath: input.project.projectPath,
                      providerPresetId: input.model.executionBinding ? undefined : input.model.providerPresetId || defaultConversationProviderPresetId,
                      executionBinding: input.model.executionBinding,
                      thinkingLevel: input.model.thinkingLevel,
                      reasoningSummary: input.model.reasoningSummary,
                      authorizationMode: input.authorization.authorizationMode,
                      workspaceAccessMode: input.authorization.workspaceAccessMode,
                      permissionMode: input.authorization.permissionMode,
                      permissionPreset: input.authorization.permissionPreset,
                      permissionConfirmation: input.authorization.permissionConfirmation,
                      responseLanguage: resolveConversationResponseLanguage(
                        workspaceSettings?.responseLanguage ?? effectiveConfig?.values.responseLanguage.value,
                      ),
                    }, {
                      onReady: (event) => input.replaceMessages([
                        homeMessageFromTranscript(event.userMessage),
                        homeMessageFromTranscript(event.assistantMessage),
                      ]),
                      onMessageAccepted: input.onMessageAccepted,
                      onSubmissionUnknown: input.onSubmissionUnknown,
                      onSubmissionRecovered: input.onSubmissionRecovered,
                      onReplyLinked: input.onReplyLinked,
                      onRunEvent: (event) => {
                        if (event.assistantMessage) {
                          input.upsertMessage(homeMessageFromTranscript(event.assistantMessage));
                        }
                      },
                      onDone: (event) => input.upsertMessage(homeMessageFromTranscript(event.assistantMessage)),
                      onBlocked: (event) => {
                        if (event.assistantMessage) {
                          input.upsertMessage(homeMessageFromTranscript(event.assistantMessage));
                        }
                        if (event.error) {
                          input.failMessage(event.error);
                        }
                      },
                      onError: (message) => input.failMessage(message),
                      onThreadBound: input.onThreadBound,
                      shouldCommit: input.shouldCommit,
                    });
                  }}
                />
              )
            ) : (
              <>
                {activeView === "providers" || activeView === "plugins" || activeView === "automations" || activeView === "profile" || activeView === "media" || activeView === "teammates" || activeView === "councils" || activeView === "settings" ? null : (
                  <DesktopTitlebarSurface>
                  <div className="workspace-head" data-desktop-window-drag-region="true">
                    <div>
                      <h1>{selectedAiTeammate ? selectedAiTeammate.displayName : t(viewTitle(activeView))}</h1>
                      <p>{selectedAiTeammate ? selectedAiTeammate.description : t(viewDescription(activeView))}</p>
                    </div>
                    <StatusBadge status={latestStatus} />
                  </div>
                  </DesktopTitlebarSurface>
                )}
                {activeView === "teammates" && selectedAiTeammate ? (
                  <TeammateWorkspace
                cwd={form.cwd}
                teammate={selectedAiTeammate}
                userProfile={userProfile}
                providers={providers}
                workspaceDefaultProviderPresetId={workspaceSettings?.defaultProviderPresetId}
                channels={channels}
                runs={runs}
                workUnits={workUnits}
                skillPack={builtinSkillPack}
                onUpdateTeammate={updateAiTeammateSettings}
                onTeammateUpdated={upsertAiTeammate}
                onDisableTeammate={removeAiTeammate}
                onHardDeleteTeammate={hardDeleteAiTeammateAndRefresh}
                onOpenProviders={() => openSettingsWorkspaceTool("providers")}
                onOpenSkillLibrary={() => openSettingsSection("skill-library")}
                onOpenAuthorizationSettings={() => openSettingsSection("approval-strategy")}
                onRefreshTeammates={() => refreshAiTeammates(form.cwd.trim())}
                onRefreshChannels={() => refreshChannels()}
                onTaskCreated={(task) => {
                  if (task.channelId === selectedChannelIdRef.current) {
                    setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
                  }
                }}
                onOpenRun={(runId) => void openRunFromWorkspace(runId)}
                onOpenTaskInWorkBoard={(task) => {
                  setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
                  openTaskInWorkBoard(task);
                }}
                onOpenWorkBoard={() => openWorkBoard("mine")}
                defaultAuthorizationMode={workspaceSettings?.defaultAuthorizationMode}
                defaultWorkspaceAccessMode={workspaceSettings?.defaultWorkspaceAccessMode}
                workspaceDefaultsAvailable={workspaceSettings !== undefined}
                onDirectConversationChange={setDesktopTeammateConversationId}
                fullAccessConfirmed={fullAccessConfirmation.isConfirmed(teammateConversationFullAccessScope)}
                onConfirmFullAccess={() => fullAccessConfirmation.request(teammateConversationFullAccessScope)}
                onConfirmFullAccessSelection={() => fullAccessConfirmation.request(teammateConversationFullAccessScope)}
                defaultPermissionMode={workspaceSettings?.defaultPermissionMode}
                defaultPermissionPreset={workspaceSettings?.defaultPermissionPreset}
                workspacePolicy={approvalPolicy}
                workspacePolicyLoading={approvalPolicyLoading}
                workspacePolicyError={settingsDomain.error?.scope === "load" ? settingsDomain.error.message : undefined}
                onRefreshWorkspacePolicy={() => void refreshApprovalPolicy()}
                approvalErrors={approvalErrors}
                resolvingApprovals={resolvingApprovals}
                onResolveApproval={resolveApproval}
                settingsOpenRequest={teammateSettingsOpenRequest}
                conversationRefreshToken={teammateConversationRefreshToken}
                onSettingsOpenRequestConsumed={(requestId) => {
                  setTeammateSettingsOpenRequest((current) => current?.requestId === requestId ? undefined : current);
                }}
                  />
                ) : activeView === "teammates" ? (
                  <AiTeammatesPage
                    cwd={form.cwd}
                    skillPack={builtinSkillPack}
                    providers={providers}
                    channels={channels}
                    localTeammates={localTeammates}
                    isLoading={aiTeammatesLoading}
                    loadErrorMessage={teammateListErrorMessage || undefined}
                    actionErrorMessagesByTeammateId={teammateActionErrorMessagesById}
                    defaultProviderId={workspaceDefaultProviderPresetId}
                    onCreateTeammate={addAiTeammate}
                    onRemoveTeammate={(teammateId) => void removeAiTeammate(teammateId).catch(() => undefined)}
                    onToggleTeammatePinned={(teammateId) => void toggleAiTeammatePinned(teammateId).catch(() => undefined)}
                    onToggleTeammateHidden={(teammateId) => void toggleAiTeammateHidden(teammateId).catch(() => undefined)}
                    onEditTeammate={openAiTeammateSettings}
                    onOpenTeammate={selectAiTeammate}
                    onOpenCouncils={() => openSettingsWorkspaceTool("councils")}
                    onOpenProviders={() => openSettingsWorkspaceTool("providers")}
                    onRefresh={() => void refreshAiTeammates(form.cwd.trim())}
                  />
                ) : activeView === "councils" ? (
                  <CouncilWorkspacePage
                    cwd={form.cwd}
                    aiCouncils={aiCouncils}
                    aiCouncilHealthReport={aiCouncilHealthReport}
                    aiCouncilsLoading={aiCouncilsLoading}
                    channels={channels}
                    teammates={aiTeammates}
                    onRefresh={() => refreshAiCouncils()}
                    onOpenAiTeammates={() => openSettingsWorkspaceTool("teammates")}
                    onOpenChannel={selectWorkspaceChannel}
                  />
                ) : activeView === "runs" ? (
                  <RunHistory
                cwd={form.cwd}
                runs={runs}
                selectedRunId={activeRunId}
                selectedRun={run}
                memoryById={memoryById}
                usedMemoryEvents={usedMemoryEvents}
                events={events}
                artifacts={artifacts}
                resourceLeases={resourceLeases}
                stateTransitions={stateTransitions}
                workUnitDetail={selectedWorkUnitDetail}
                assistantText={assistantText}
                approvals={activeRunApprovals}
                resolvingApprovals={resolvingApprovals}
                isRunning={isRunning}
                cancellingRunId={cancellingRunId}
                errorMessage={runsDomain.error?.message ?? ""}
                onRefresh={() => void refreshRuns()}
                onRefreshSelected={() => void loadRun(activeRunId || lookupRunId)}
                onRerun={(sourceRun) => void rerunRun(sourceRun)}
                onCancelRun={(sourceRun) => void cancelRunOrWorkUnit(sourceRun)}
                onResolveApproval={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
                onOpenProviders={(sourceRun) => {
                  clearSettingsWorkspaceToolView();
                  openProvidersFromRun(sourceRun);
                }}
                onOpenApprovals={(runId) => openApprovalsFromWorkspace(runId)}
                onEditTask={(sourceRun) => void openTaskFromRun(sourceRun)}
                onSelect={(runId) => void selectRun(runId)}
                  />
                ) : activeView === "threads" ? (
                  <ThreadPage
                cwd={form.cwd}
                isRunning={isRunning}
                initialThreadId={threadPageTargetId}
                onRefreshRuns={() => void refreshRuns()}
                onSelectRun={(runId) => {
                  openRunDiagnosticsView();
                  void selectRun(runId);
                }}
                  />
                ) : activeView === "automations" ? (
                  <AutomationsPage
                cwd={form.cwd}
                channels={channels}
                providers={providers}
                automations={automations}
                automationRuns={automationRuns}
                automationDrafts={automationDrafts}
                templates={automationTemplates}
                schedulers={automationSchedulers}
                schedulerAction={schedulerAction}
                selectedAutomationId={selectedAutomationId}
                selectedDraftId={selectedDraftId}
                previewByAutomationId={previewByAutomationId}
                draftPreviewById={draftPreviewById}
                isLoading={automationsLoading}
                isRefreshing={automationsRefreshing}
                createAction={automationCreateAction}
                automationActionById={automationActionById}
                draftActionById={draftActionById}
                refreshError={automationsRefreshError}
                createError={automationCreateError}
                schedulerError={automationSchedulerError}
                automationErrorById={automationErrorById}
                draftErrorById={draftErrorById}
                onRefresh={refreshAutomations}
                onCreateAutomation={createAutomationDefinition}
                onCreateChatDraft={createChatDraft}
                onStartScheduler={startScheduler}
                onStopScheduler={stopScheduler}
                onSelectAutomation={setSelectedAutomationId}
                onSelectDraft={setSelectedDraftId}
                onUpdateDraft={updateDraft}
                onPreviewDraft={previewDraft}
                onConfirmDraft={confirmDraft}
                onDiscardDraft={discardDraft}
                onPreview={previewAutomationById}
                onRun={runAutomationById}
                onArchive={archiveAutomationById}
                onSetStatus={setAutomationStatusById}
                onSetSchedule={setAutomationScheduleById}
                onSetTarget={setAutomationTargetById}
                onOpenRun={(runId) => {
                  clearSettingsWorkspaceToolView();
                  void openRunFromWorkspace(runId);
                }}
                onOpenThread={(threadId) => {
                  setThreadPageTargetId(threadId);
                  setActiveView("threads");
                  setActiveSidebarTarget("threads");
                }}
                  />
                ) : activeView === "providers" ? (
                  <ProviderSettings
                cwd={form.cwd}
                providers={providers}
                templates={providerTemplates}
                form={providerForm}
                editingProviderId={editingProviderId}
                isLoading={providersLoading}
                checkingProviderIds={checkingProviderIds}
                errorMessage={providersDomain.error?.message ?? ""}
                checkResult={providerCheck}
                checkedProviderId={providerCheckTargetId}
                checkScope={providerCheckScope}
                batchResult={providerBatchResult}
                operationWarning={providerOperationWarning}
                selectedTemplateId={selectedProviderTemplateId}
                repairRun={providerRepairRun}
                isRunning={isRunning}
                setupIntent={providerSetupIntent}
                onSetupIntentConsumed={() => setProviderSetupIntent("")}
                onFormChange={setProviderForm}
                onTemplateSelect={selectProviderTemplate}
                onNew={startNewProviderFromTemplate}
                onSave={saveProviderWithPreflight}
                onImportModels={importModelsFromProviderForm}
                onRefresh={() => void refreshProviders()}
                onEdit={editProvider}
                onDelete={(providerId) => void removeProvider(providerId)}
                onCheck={(providerId) => void runProviderCheck(providerId)}
                onCheckBatch={runProviderBatchCheck}
                onToggleEnabled={(provider, enabled) => void toggleProviderEnabled(provider, enabled)}
                onRerun={(sourceRun) => void rerunRun(sourceRun)}
                onOpenRun={(runId) => {
                  clearSettingsWorkspaceToolView();
                  void openRunFromWorkspace(runId);
                }}
                onClearCheckFeedback={clearProviderCheckFeedback}
                onClearRepair={() => setProviderRepairRunId("")}
                workspaceSettings={workspaceSettings}
                onPatchWorkspaceSettings={(patch) => patchWorkspaceSettings(patch, { errorOwner: "caller" })}
                  />
                ) : activeView === "plugins" ? (
                  <PluginManagerPage
                    plugins={pluginManagerPlugins}
                    isLoading={pluginsLoading}
                    loadError={pluginsLoadError}
                    pendingActions={pluginManagerPendingActions}
                    actionErrors={pluginManagerActionErrors}
                    onRefresh={() => void refreshPlugins()}
                    onCreate={createPlugin}
                    onApplyPreset={applyPluginPreset}
                    onConnect={connectPlugin}
                    onCheck={checkPlugin}
                    onValidatePackage={validatePackage}
                    onInstall={installPlugin}
                    onUninstall={uninstallPlugin}
                    onRefreshPackage={refreshPluginPackage}
                    onRuntimePreview={previewPluginRuntime}
                    onEnable={enablePlugin}
                    onDisable={disablePlugin}
                    onRepairChromeHost={repairChromeHost}
                    onRevokeChrome={revokeChromeAccess}
                    onClearActionErrors={clearPluginActionErrors}
                    onOpenMcpSettings={() => {
                      void refreshMcp();
                      openSettingsSection("mcp-tools");
                    }}
                  />
                ) : activeView === "work_board" ? (
                  <GlobalWorkBoardPage
                    channels={channels}
                    tasks={tasks}
                    runs={runs}
                    approvals={approvals}
                    workflowSteps={channelWorkflowSteps}
                    externalActionDetails={externalActionDetails}
                    externalWorkCiTriage={externalWorkCiTriage}
                    artifactsByRun={channelArtifactsByRun}
                    durableWorkItems={durableWorkItems}
                    workspaceCwd={form.cwd.trim()}
                    onRefresh={async () => {
                      await Promise.all([
                        refreshTasks(),
                        refreshRuns(),
                        refreshApprovals(),
                        refreshExternalWorkCiTriage(),
                        refreshWorkItems(),
                      ]);
                    }}
                    onOpenTask={(taskId) => {
                      clearSettingsWorkspaceToolView();
                      void openTaskFromWorkBoard(taskId);
                    }}
                    onOpenRun={(runId) => {
                      clearSettingsWorkspaceToolView();
                      void openRunFromWorkspace(runId);
                    }}
                    onOpenApproval={(approvalId) => {
                      clearSettingsWorkspaceToolView();
                      setSelectedApprovalId(approvalId);
                      openPlainView("approvals");
                    }}
                    onOpenChannel={(channelId) => {
                      clearSettingsWorkspaceToolView();
                      selectWorkspaceChannel(channelId);
                    }}
                    onRouteExternalWork={routeExternalWorkToChannel}
                    onClaimWorkItem={claimDurableWorkItem}
                    onHeartbeatWorkItem={heartbeatDurableWorkItem}
                    onReleaseWorkItem={releaseDurableWorkItem}
                    onCompleteWorkItem={completeDurableWorkItem}
                    onFailWorkItem={failDurableWorkItem}
                    busyByWorkItemId={busyByWorkItemId}
                    failureByWorkItemId={failureByWorkItemId}
                    blockerByWorkItemId={blockerByWorkItemId}
                    routingByExternalWorkId={routingByExternalWorkId}
                    routingExternalWorkId={routingExternalWorkId}
                    busyWorkItemId={busyWorkItemId}
                    openIntent={workBoardOpenIntent}
                  />
                ) : activeView === "media" ? (
                  <MediaProductionWorkspace
                    cwd={form.cwd}
                    providers={providers}
                    mediaJobs={mediaJobs}
                    mediaArtifactsByJob={mediaJobArtifacts}
                    onJobsChanged={() => void refreshMediaJobs()}
                    onOpenMediaJob={(jobId) => setSelectedMediaJobId(jobId)}
                    onConfigureVideoModel={() => openSettingsWorkspaceTool("providers", "video_generation")}
                    jobsPanel={({ jobContext, hostActions }) => (
                      <MediaJobsPage
                        cwd={form.cwd}
                        providers={providers}
                        jobs={mediaJobs}
                        artifactsByJob={mediaJobArtifacts}
                        form={mediaJobForm}
                        selectedJobId={selectedMediaJobId}
                        isLoading={mediaJobsLoading}
                        runningJobId={runningMediaJobId}
                        approvals={approvals}
                        domainState={mediaDomain.state}
                        domainActions={mediaDomain.actions}
                        onFormChange={setMediaJobForm}
                        onRefresh={refreshMediaJobs}
                        onCreate={saveMediaJob}
                        onSelectJob={setSelectedMediaJobId}
                        onRun={executeMediaJob}
                        onOpenProviders={() => openSettingsWorkspaceTool("providers", "generation")}
                        onOpenProviderRepair={(_providerPresetId, operation) => openSettingsWorkspaceTool(
                          "providers",
                          operation === "video_generate" ? "video_generation" : "generation",
                        )}
                        onOpenApproval={(approvalId) => {
                          setSelectedApprovalId(approvalId);
                          openPlainView("approvals");
                        }}
                        onRefreshApprovals={() => refreshApprovals(form.cwd.trim())}
                        jobContext={jobContext}
                        hostActions={hostActions}
                      />
                    )}
                  />
                ) : activeView === "profile" ? (
                  <ProfilePage cwd={form.cwd} onProfileChange={setUserProfile} />
                ) : activeView === "settings" ? (
                  <SettingsPage
                    cwd={form.cwd}
                    computerControl={computerControl}
                    skillLibraryRefreshToken={skillLibraryRefreshToken}
                    effectiveConfig={effectiveConfig}
                    startupStatus={startupStatus}
                    workspaceResponseLanguage={workspaceSettings?.responseLanguage ?? effectiveConfig?.values.responseLanguage.value ?? "follow_user"}
                    selectedChannel={channels.find((channel) => channel.id === selectedChannelId)}
                    externalWorkStatus={externalWorkStatus}
                    externalWorkError={externalWorkError ? {
                      kind: externalWorkError.kind,
                      message: externalWorkError.message,
                    } : undefined}
                    mcpServers={mcpServers}
                    mcpTools={mcpTools}
                    mcpLoading={mcpLoading}
                    mcpBusyServerId={mcpBusyServerId}
                    mcpBusyAction={mcpBusyAction}
                    mcpError={mcpDomain.error}
                    initialSection={settingsInitialSection}
                    onBackToApplication={returnFromSettingsView}
                    workspaceDefaultAuthorizationMode={workspaceSettings?.defaultAuthorizationMode}
                    workspaceDefaultWorkspaceAccessMode={workspaceSettings?.defaultWorkspaceAccessMode}
                    workspaceDefaultPermissionMode={workspaceSettings?.defaultPermissionMode}
                    workspaceDefaultPermissionPreset={workspaceSettings?.defaultPermissionPreset}
                    startupStatusLoading={startupStatusLoading}
                    startupStatusAction={startupStatusAction}
                    startupStatusError={startupStatusError}
                    externalWorkStatusLoading={externalWorkStatusLoading}
                    externalWorkStatusAction={externalWorkStatusAction}
                    externalWorkSecretAction={externalWorkSecretAction}
                    externalWorkWorkflowAction={externalWorkWorkflowAction}
                    runArtifacts={artifacts}
                    runEvents={events}
                    runsError={runsDomain.error?.message ?? ""}
                    selectedRun={run}
                    onWorkspaceDefaultAuthorizationChange={(defaultAuthorizationMode) => patchWorkspaceSettings({ defaultAuthorizationMode })}
                    onWorkspaceDefaultWorkspaceAccessChange={(defaultWorkspaceAccessMode) => patchWorkspaceSettings({ defaultWorkspaceAccessMode })}
                    onProductLanguageChange={updateInterfaceLocale}
                    onWorkspaceResponseLanguageChange={(responseLanguage) => patchWorkspaceSettings({ responseLanguage })}
                    onRefreshStartup={() => void refreshStartupDiagnostics()}
                    onRefreshExternalWork={() => void refreshExternalWorkStatus()}
                    onExternalWorkAction={runExternalWorkStatusAction}
                    onConfigureExternalWorkWorkflow={(input) => configureExternalWorkWorkflowAction(input)}
                    onConfigureExternalWorkSecret={(token) => configureExternalWorkSecretAction(token)}
                    onDeleteExternalWorkSecret={() => deleteExternalWorkSecretAction()}
                    onOpenRunDiagnostics={() => {
                      openSettingsRunDiagnostics();
                    }}
                    onCloseRunDiagnostics={closeSettingsRunDiagnostics}
                    onRefreshRunDiagnostics={refreshSettingsRunDiagnostics}
                    onSelectRunDiagnostics={selectSettingsRunDiagnostics}
                    onOpenFullRunDiagnostics={(runId) => openFullRunDiagnosticsFromSettings(runId)}
                    onRefreshMcp={() => void refreshMcp()}
                    onClearMcpError={mcpDomain.clearError}
                    onArchivedItemsChanged={() => refreshArchivedSidebarItems()}
                    onCreateMcpServer={addMcpServer}
                    onUpdateMcpServer={saveMcpServer}
                    onDeleteMcpServer={removeMcpServer}
                    onCheckMcpServer={runMcpServerCheck}
                    onSyncMcpTools={syncMcpTools}
                    onProfileChange={setUserProfile}
                    onOpenProviders={() => openSettingsWorkspaceTool("providers")}
                    onOpenTeammates={() => openSettingsWorkspaceTool("teammates")}
                    onOpenCouncils={() => openSettingsWorkspaceTool("councils")}
                    workspaceToolDetail={settingsWorkspaceToolDetail}
                    workspaceToolView={settingsWorkspaceToolView}
                    runDiagnosticsRunId={settingsRunDiagnosticsRunId}
                    runs={runs}
                    runsLoading={runsLoading}
                    onCloseWorkspaceTool={clearSettingsWorkspaceToolView}
                  />
                ) : (
                  <ApprovalsPage
                cwd={form.cwd}
                approvals={approvals}
                repairRunId={approvalRepairRunId}
                repairRun={approvalRepairRun}
                selectedApprovalId={selectedApprovalId}
                externalActionDetails={externalActionDetails}
                externalActionBusy={externalActionBusy}
                isLoading={approvalsLoading}
                resolvingApprovals={resolvingApprovals}
                errorMessage={approvalsDomain.error?.message ?? ""}
                approvalErrors={approvalErrors}
                onRefresh={() => void refreshApprovals()}
                onSelectApproval={setSelectedApprovalId}
                onRefreshRepair={(runId) => {
                  void refreshApprovals(form.cwd.trim(), runId);
                  void loadRun(runId, form.cwd.trim());
                }}
                onResolve={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
                onExecuteExternalAction={(actionId) => void executeExternalAction(actionId)}
                onCancelExternalAction={(actionId) => void cancelExternalAction(actionId, "Cancelled from Web Inbox")}
                onOpenRun={(runId) => {
                  clearSettingsWorkspaceToolView();
                  void openRunFromWorkspace(runId);
                }}
                onOpenWorkBoard={(scope) => {
                  openWorkBoard(scope ?? "actionable");
                }}
                onClearRepair={() => setApprovalRepairRunId("")}
                channels={channels}
                onRouteExternalWork={(externalWorkId, channelId) => void routeExternalWorkToChannel(externalWorkId, channelId)}
                routingExternalWorkId={routingExternalWorkId}
                inlineApprovalIds={inlineApprovalIds}
                  />
                )}
              </>
            )}
            </Suspense>
          </LazyPageErrorBoundary>
          </WorkSummaryProvider>
        </CurrentSessionHeaderCapabilityProvider>
      </section>
      {showInspector ? (
        <aside className={inspectorCollapsed ? "right-panel collapsed" : "right-panel"} aria-label={t("Inspector")}>
          <button
            className="inspector-toggle"
            type="button"
            onClick={() => setInspectorCollapsed((current) => !current)}
            aria-label={inspectorCollapsed ? t("Show inspector") : t("Hide inspector")}
          >
            {inspectorCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
          </button>
          {!inspectorCollapsed ? (
            <PageInspector
              activeView={activeView}
              selectedEntity={selectedEntity}
              selectedTask={selectedWorkspaceTask}
              selectedRun={run}
              activeRunId={activeRunId}
              lookupRunId={lookupRunId}
              events={events}
              artifacts={artifacts}
              assistantText={assistantText}
              isRunning={isRunning}
              isRunLoading={isRunLoading}
              runErrorMessage={runsDomain.error?.message ?? ""}
              pendingApprovals={activePendingApprovals}
              resolvingApprovals={resolvingApprovals}
              providers={providers}
              selectedProviderId={selectedProviderIdForRun}
              editingProviderId={editingProviderId}
              providerCheck={providerCheck}
              checkedProviderId={providerCheckTargetId}
              mediaJobs={mediaJobs}
              selectedMediaJobId={selectedMediaJobId}
              mediaJobArtifacts={mediaJobArtifacts}
              approvals={approvals}
              selectedApprovalId={selectedApprovalId}
              externalActionDetails={externalActionDetails}
              externalActionBusy={externalActionBusy}
              externalWorkCiTriage={externalWorkCiTriage}
              externalWorkCiTriageLoading={externalWorkCiTriageLoading}
              externalWorkStatus={externalWorkStatus}
              approvalPolicy={approvalPolicy}
              approvalPolicyForm={approvalPolicyForm}
              cwd={form.cwd}
              onLookupRunIdChange={setLookupRunId}
              onLoadRun={() => loadRun().catch(() => undefined)}
              onResolveApproval={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
              onExecuteExternalAction={(actionId) => void executeExternalAction(actionId)}
              onCancelExternalAction={(actionId) => void cancelExternalAction(actionId, "Cancelled from Web Inspector")}
            />
          ) : null}
        </aside>
      ) : null}
      {channelCreateOpen ? (
        <ChannelCreateDialog
          cwd={form.cwd}
          form={channelForm}
          projectOptions={buildChannelCreateProjectOptions(form.cwd, channels)}
          providers={providers}
          providersLoading={providersLoading}
          defaultProviderId={workspaceDefaultProviderPresetId}
          teammates={localTeammates}
          creating={channelsLoading}
          errorMessage={channelFeedback.message("create-dialog", "draft", form.cwd.trim()) ?? ""}
          onFormChange={(nextForm) => {
            channelFeedback.clear("create-dialog", "draft", form.cwd.trim());
            setChannelForm(nextForm);
          }}
          onCreateChannel={saveChannel}
          onOpenProviders={() => openSettingsWorkspaceTool("providers")}
          onClose={() => {
            channelFeedback.clear("create-dialog", "draft", form.cwd.trim());
            setChannelCreateOpen(false);
          }}
        />
      ) : null}
      {teammateCreateOpen && builtinTeammateTemplates.length > 0 ? (
        <TeammateCreateDrawer
          open={teammateCreateOpen}
          templates={builtinTeammateTemplates}
          providers={providers}
          channels={channels}
          defaultProviderId={workspaceDefaultProviderPresetId}
          onCreate={addAiTeammate}
          onClose={() => setTeammateCreateOpen(false)}
          onOpenCreated={selectAiTeammate}
          onOpenProviders={() => openSettingsWorkspaceTool("providers")}
        />
      ) : null}
      <FirstRunDialog controller={firstRunController} />
      <FullAccessConfirmationDialog
        open={fullAccessConfirmation.open}
        returnFocusTarget={fullAccessConfirmation.returnFocusTarget}
        onCancel={fullAccessConfirmation.cancel}
        onConfirm={fullAccessConfirmation.confirm}
      />
    </AppShellOverlayBoundary>
    </DesktopTitlebarProvider>
    </DaemonObservationProvider>
  );
}

function buildChannelCreateProjectOptions(
  workspaceCwd: string,
  channels: readonly Channel[],
): readonly ChannelCreateProjectOption[] {
  const paths = [
    workspaceCwd.trim(),
    ...channels.map((channel) => channel.boundPath?.trim() ?? ""),
  ].filter((path): path is string => Boolean(path));
  const seen = new Set<string>();
  return paths.flatMap((path) => {
    if (seen.has(path)) {
      return [];
    }
    seen.add(path);
    return [{
      path,
      label: summarizeConversationProjectPath(path),
    }];
  });
}

function readRequestPermissionMode(requestBody: unknown): SessionPermissionMode | undefined {
  if (!requestBody || typeof requestBody !== "object") {
    return undefined;
  }
  const value = (requestBody as { readonly permissionMode?: unknown }).permissionMode;
  return value === "ask_everything" || value === "balanced" || value === "workspace_write" || value === "full_access" || value === "custom"
    ? value
    : undefined;
}

function readRequestWorkspaceAccessMode(requestBody: unknown): WorkspaceAccessMode | undefined {
  if (!requestBody || typeof requestBody !== "object") {
    return undefined;
  }
  const value = (requestBody as { readonly workspaceAccessMode?: unknown }).workspaceAccessMode;
  return value === "read_only" || value === "workspace_write" || value === "full_access" ? value : undefined;
}

function summarizeConversationProjectPath(path: string): string {
  const normalizedPath = path.replace(/[\\/]+$/u, "");
  return normalizedPath.split(/[\\/]/u).filter(Boolean).at(-1) || path;
}

function resolveConversationResponseLanguage(
  preference: ResponseLanguagePreference | undefined,
): ResponseLanguagePreference {
  if (preference === "follow_user" || isSupportedLocale(preference)) {
    return preference;
  }
  return "follow_user";
}
