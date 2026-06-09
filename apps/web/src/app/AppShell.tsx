import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
} from "lucide-react";
import {
  GSTACK_DEFAULT_SKILL_PACK_ID,
  getBuiltinSkillPack,
} from "@ling-stack/core/builtin-skill-packs";
import { useI18n } from "../i18n.js";
import type {
  ApprovalRequest,
  AiTeammate,
  ChannelAttachment,
  Channel,
  ChannelContextSummary,
  ChannelCreateFormState,
  ChannelDecision,
  ChannelFormState,
  ChannelHandoff,
  ChannelHandoffStatus,
  ChannelLinkPreview,
  ChannelMessage,
  ChannelExecutionProposal,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelWorkflowStepStartMode,
  ControlPlaneDomain,
  ExternalWorkActionView,
  MediaJob,
  ProviderCheckResult,
  ProviderFormState,
  ProviderPreset,
  ProviderTemplate,
  RunArtifact,
  RunEventEnvelope,
  RunFormState,
  RunSession,
  SessionPermissionMode,
  StateEntityType,
  Task,
  TaskEditFormState,
  TaskFormState,
  TaskRunActionState,
  UpdateChannelBriefRequest,
  WorkItemView,
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
import { SidebarNavigation, type SidebarNotification } from "../features/navigation/SidebarNavigation.js";
import type {
  LocalTeammateCreateInput,
  LocalTeammateDraft,
} from "../features/teammates/index.js";
import {
  LazyAutomationsPage as AutomationsPage,
  LazyAiTeammatesPage as AiTeammatesPage,
  LazyApprovalsPage as ApprovalsPage,
  LazyGlobalWorkBoardPage as GlobalWorkBoardPage,
  LazyMediaJobsPage as MediaJobsPage,
  LazyPageErrorBoundary,
  LazyProviderSettings as ProviderSettings,
  LazyRunHistory as RunHistory,
  LazySettingsPage as SettingsPage,
  LazyTeammateWorkspace as TeammateWorkspace,
  LazyThreadPage as ThreadPage,
  LazyWorkspaceClientView as WorkspaceClientView,
} from "./lazy-pages.js";
import {
  buildRunApprovalSummaries,
  effectiveApprovalStatus,
} from "../lib/approvals.js";
import { buildInlineApprovalViews } from "../lib/inline-approvals.js";
import {
  channelToForm,
  defaultChannelCreateForm,
  defaultChannelEditForm,
} from "../lib/channels.js";
import { deriveChannelRuns, deriveChannelTasks } from "../lib/channel-artifacts.js";
import { deriveSelectedChannelTeammateMemberships } from "../lib/channel-teammates.js";
import type { ChannelActivityTriageDraft, ChannelActivityTriageResult } from "../lib/channel-activity-triage.js";
import { readDataString } from "../lib/data.js";
import { titleFromPrompt } from "../lib/formatting.js";
import { getViteDefaultWorkspaceCwd, readInitialWorkspaceCwd, readSavedWorkspaceCwd, writeSavedWorkspaceCwd } from "../lib/local-storage.js";
import { getControlPlaneSnapshot } from "../api/control-plane.js";
import { routeExternalWork } from "../api/external-work.js";
import { claimWorkItem, heartbeatWorkItem, listWorkItems } from "../api/work-items.js";
import {
  controlPlaneStreamUrl,
  controlPlaneSummaryDomains,
  parseControlPlaneEventMessage,
} from "../lib/control-plane.js";
import {
  readRunProviderPresetId,
  readRunWorkspaceCwd,
} from "../lib/run-evidence.js";
import { useApprovalsDomain } from "../domains/approvals/use-approvals-domain.js";
import { useAutomationsDomain } from "../domains/automations/use-automations-domain.js";
import { useExternalWorkDomain } from "../domains/external-work/use-external-work-domain.js";
import { useMediaDomain } from "../domains/media/use-media-domain.js";
import { useMcpDomain } from "../domains/mcp/use-mcp-domain.js";
import { usePluginsDomain } from "../domains/plugins/use-plugins-domain.js";
import { useProvidersDomain } from "../domains/providers/use-providers-domain.js";
import { useRuntimeDomain } from "../domains/runtime/use-runtime-domain.js";
import { useRunCommandController } from "../domains/runs/use-run-command-controller.js";
import { useRunsDomain } from "../domains/runs/use-runs-domain.js";
import { useSettingsCommandController } from "../domains/settings/use-settings-command-controller.js";
import { useSettingsDomain } from "../domains/settings/use-settings-domain.js";
import { useTeammatesDomain } from "../domains/teammates/use-teammates-domain.js";
import { useWorkspaceCommandController } from "../domains/workspace/use-workspace-command-controller.js";
import {
  defaultTaskEditForm,
  defaultTaskForm,
  useWorkspaceDomain,
} from "../domains/workspace/use-workspace-domain.js";
import { defaultTools } from "../lib/tools.js";
import {
  canUseProviderForRun,
  customOpenAICompatibleForm,
  providerFormToTemplate,
  providerPreflightReady,
  providerRunBlockerLabel,
  providerRunPreflightBlocker,
  providerEffectiveBaseUrl,
} from "../lib/providers.js";
import { removeRecordKey } from "../lib/records.js";
import { inferPermissionPreset } from "../lib/session-permissions.js";
import { StatusBadge } from "../shared/components/index.js";

const builtinSkillPack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
const builtinTeammateTemplates = builtinSkillPack?.teammateTemplates ?? [];

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
  permissionMode: "balanced",
  permissionPreset: "custom",
};

function buildContextTaskPrompt(summary: ChannelContextSummary, decisions: readonly ChannelDecision[]): string {
  const activeDecisions = decisions.filter((decision) => summary.decisionIds.includes(decision.id) && decision.status === "active");
  const decisionText = activeDecisions.length > 0
    ? `\n\nActive decisions:\n${activeDecisions.map((decision) => `- ${decision.title}: ${decision.decision}`).join("\n")}`
    : "";
  const criteriaText = summary.acceptanceCriteria.length > 0
    ? `\n\nAcceptance criteria:\n${summary.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
    : "";
  const questionText = summary.openQuestions.length > 0
    ? `\n\nOpen questions:\n${summary.openQuestions.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `Context summary:\n${summary.summary}${decisionText}${criteriaText}${questionText}`;
}

function splitTextLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function AppShell(): JSX.Element {
  const { t } = useI18n();
  const initialWorkspaceCwd = readInitialWorkspaceCwd();
  const [form, setForm] = useState<RunFormState>(() => ({
    ...defaultForm,
    cwd: initialWorkspaceCwd,
    title: t(defaultForm.title),
    prompt: t(defaultForm.prompt),
  }));
  const [activeView, setActiveView] = useState<ViewId>("workspace");
  const [activeSidebarTarget, setActiveSidebarTarget] = useState<SidebarTarget>("workspace");
  const [channelSidebarOpen, setChannelSidebarOpen] = useState(true);
  const [daemonHealthy, setDaemonHealthy] = useState<boolean | undefined>();
  const [channelUnreadById, setChannelUnreadById] = useState<Readonly<Record<string, boolean>>>({});
  const channelSeenMessageAtRef = useRef<Record<string, string>>({});
  const [runningWorkflowStepId, setRunningWorkflowStepId] = useState("");
  const [orchestratingWorkflowId, setOrchestratingWorkflowId] = useState("");
  const [taskRepairRunId, setTaskRepairRunId] = useState("");
  const [approvalRepairRunId, setApprovalRepairRunId] = useState("");
  const [routingExternalWorkId, setRoutingExternalWorkId] = useState("");
  const [durableWorkItems, setDurableWorkItems] = useState<readonly WorkItemView[]>([]);
  const [durableWorkItemsLoading, setDurableWorkItemsLoading] = useState(false);
  const [busyWorkItemId, setBusyWorkItemId] = useState("");
  const [threadPageTargetId, setThreadPageTargetId] = useState("");
  const [fullAccessConfirmOpen, setFullAccessConfirmOpen] = useState(false);
  const [activeTaskRunAction, setActiveTaskRunAction] = useState<TaskRunActionState | undefined>();
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [skillLibraryRefreshToken, setSkillLibraryRefreshToken] = useState(0);
  const fullAccessConfirmResolveRef = useRef<((approved: boolean) => void) | undefined>(undefined);
  const workspaceTimelineLoadRef = useRef("");
  const channelEditFormSyncKeyRef = useRef("");
  const controlPlaneInvalidationRef = useRef<(domains: readonly ControlPlaneDomain[]) => void>(() => undefined);
  const {
    buildRerunRequest,
    buildRunRequest,
    buildTaskRunRequest,
    daemonBaseUrl,
  } = useRunCommandController();
  const { getDaemonHealth } = useSettingsCommandController();
  const {
    cancelChannelWorkflow,
    channelAttachmentContentUrl,
    createChannel,
    createChannelContextSummary,
    createChannelDecision,
    createChannelHandoff,
    createChannelLinkPreview,
    createChannelMessage,
    createChannelWorkflowFromHandoff,
    createChannelWorkflowFromTemplate,
    createTask,
    deleteChannel,
    deleteChannelAttachment,
    deleteTask,
    orchestrateChannelWorkflow,
    retryChannelWorkflowStep,
    startChannelWorkflowStep,
    updateChannel,
    updateChannelBrief,
    updateChannelContextSummary,
    updateChannelDecision,
    updateChannelExecutionProposal,
    updateChannelHandoff,
    updateChannelWorkflowStep,
    updateTask,
    updateTaskStatus,
    uploadChannelAttachment,
  } = useWorkspaceCommandController();
  const workspaceDomain = useWorkspaceDomain({
    cwd: form.cwd.trim(),
    initialWorkspaceCwd,
    translate: t,
    setErrorMessage,
    onChannelMessagesLoaded: updateChannelMessageReadState,
  });
  const {
    channels,
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
    memoryObjects,
    usedMemoryEvents,
    channelMessagesHasOlder,
    channelMessagesLoadingOlder,
    channelExecutionProposals,
    channelAttachments,
    channelLinkPreviews,
    channelArtifactsByRun,
    channelArtifactErrorsByRun,
    channelBrief,
    channelDecisions,
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
  } = workspaceDomain.state;
  const {
    setChannels,
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
    setChannelExecutionProposals,
    setChannelAttachments,
    setChannelLinkPreviews,
    setChannelFilesLoading,
    setChannelBrief,
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
    refreshChannelActivityTransitions,
    refreshChannelMessageRouteDecisions,
    refreshChannelProtocol,
    refreshUsedMemoryAudit,
    resetSelectedChannelActivity,
    resetForCwd: resetWorkspaceForCwd,
  } = workspaceDomain.actions;
  const automationsDomain = useAutomationsDomain({
    cwd: form.cwd.trim(),
    channels,
    selectedChannelId,
    translate: t,
    setErrorMessage,
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
    mutatingAutomationId,
    mutatingDraftId,
    schedulers: automationSchedulers,
    schedulerAction: automationSchedulerAction,
  } = automationsDomain.state;
  const {
    setSelectedAutomationId,
    setSelectedDraftId,
    refreshAutomations,
    createFromTemplate: createAutomationFromTemplate,
    createManualDraft,
    createChatDraft,
    updateDraft,
    previewDraft,
    confirmDraft,
    discardDraft,
    previewSelectedAutomation,
    runSelectedAutomation,
    archiveSelectedAutomation,
    setSelectedStatus,
    setSelectedSchedule,
    startScheduler: startAutomationSchedulerAction,
    stopScheduler: stopAutomationSchedulerAction,
    resetForCwd: resetAutomationsForCwd,
  } = automationsDomain.actions;
  const providersDomain = useProvidersDomain({
    cwd: form.cwd.trim(),
    translate: t,
    setErrorMessage,
    applyProviderToRun,
    clearSelectedProvider: (providerId) => {
      if (form.providerPresetId === providerId) {
        setForm((current) => ({ ...current, providerPresetId: "" }));
      }
    },
    clearProviderUsage: async (providerId) => {
      const workspaceCwd = form.cwd.trim();
      if (taskRunProviderId === providerId) {
        setTaskRunProviderId("");
      }
      if (form.providerPresetId === providerId) {
        setForm((current) => ({ ...current, providerPresetId: "" }));
      }

      const channelsUsingProvider = channels.filter((channel) => channel.defaultProviderPresetId === providerId);
      if (!workspaceCwd || channelsUsingProvider.length === 0) {
        return;
      }

      setChannels((current) =>
        current.map((channel) =>
          channel.defaultProviderPresetId === providerId ? { ...channel, defaultProviderPresetId: undefined } : channel,
        ),
      );
      setChannelEditForm((current) =>
        current.defaultProviderPresetId === providerId ? { ...current, defaultProviderPresetId: "" } : current,
      );
      await Promise.all(
        channelsUsingProvider.map((channel) =>
          updateChannel(workspaceCwd, channel.id, {
            ...channelToForm(channel, workspaceCwd),
            defaultProviderPresetId: "",
          }),
        ),
      );
      await refreshChannels(workspaceCwd);
    },
  });
  const {
    providers,
    providerTemplates,
    providersLoading,
    providerForm,
    editingProviderId,
    selectedProviderTemplateId,
    providerCheck,
    providerCheckTargetId,
    providerCheckScope,
    checkingProviderIds,
    providerBatchResult,
    providerSaveMessage,
    providerSaveMessageTone,
    providerRepairRunId,
  } = providersDomain.state;
  const {
    setProviderForm,
    setProviderRepairRunId,
    refreshProviders,
    refreshProviderTemplates,
    checkProviderForRun,
    saveProviderWithPreflight,
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
    setErrorMessage,
    refreshChannels,
    openTeammate: (teammateId) => {
      setActiveView("teammates");
      setActiveSidebarTarget(teammateSidebarTarget(teammateId));
    },
    closeTeammateIfActive: (teammateId) => {
      if (activeSidebarTarget === teammateSidebarTarget(teammateId)) {
        openPlainView("teammates");
      }
    },
  });
  const {
    aiTeammates,
    aiTeammatesLoading,
    teammateChannelMembershipsByTeammate,
    teammateChannelMembershipsLoading,
    channelTeammateSavingId,
  } = teammatesDomain.state;
  const {
    refreshAiTeammates,
    addAiTeammate,
    removeAiTeammate,
    hardDeleteAiTeammateAndRefresh,
    updateAiTeammateSettings,
    toggleAiTeammatePinned,
    toggleAiTeammateHidden,
    addChannelTeammate,
    removeChannelTeammate,
    setDefaultChannelTeammate,
    resetForCwd: resetTeammatesForCwd,
  } = teammatesDomain.actions;
  const approvalsDomain = useApprovalsDomain({
    cwd: form.cwd.trim(),
    emitEvent: handleDomainEvent,
    setErrorMessage,
  });
  const {
    approvals,
    selectedApprovalId,
    resolvingApprovals,
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
    setErrorMessage,
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
    setErrorMessage,
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
    setErrorMessage,
  });
  const {
    plugins,
    pluginsLoading,
    pluginBusyId,
    pluginBusyAction,
    latestApplyResult: latestPluginApplyResult,
    latestRuntimePreview: latestPluginRuntimePreview,
    latestNotice: latestPluginNotice,
  } = pluginsDomain.state;
  const {
    refreshPlugins,
    applyPluginPreset,
    checkPlugin,
    validatePackage,
    installPlugin,
    uninstallPlugin,
    refreshPluginPackage,
    previewPluginRuntime,
    enablePlugin,
    disablePlugin,
    resetForCwd: resetPluginsForCwd,
  } = pluginsDomain.actions;
  const externalWorkDomain = useExternalWorkDomain({
    cwd: form.cwd.trim(),
    selectedChannelId,
    setErrorMessage,
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
  const runtimeDomain = useRuntimeDomain({
    cwd: form.cwd.trim(),
    setErrorMessage,
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
  const {
    setSelectedWorkUnitDetail,
    refreshRuntimeState,
    runWorkUnitAction,
    resetForCwd: resetRuntimeForCwd,
  } = runtimeDomain.actions;
  const settingsDomain = useSettingsDomain({
    cwd: form.cwd.trim(),
    setErrorMessage,
  });
  const {
    approvalPolicy,
    approvalPolicyForm,
    approvalPolicyLoading,
    runners,
    runtimeSettings,
    runtimeSettingsForm,
    runtimeSettingsLoading,
    runtimeSettingsAction,
    runtimeSettingsError,
  } = settingsDomain.state;
  const {
    setApprovalPolicyForm,
    refreshApprovalPolicy,
    saveApprovalPolicy,
    setRuntimeSettingsForm,
    toggleAllowedRunner,
    refreshRuntimeSettings,
    saveRuntimeSettings,
    resetForCwd: resetSettingsForCwd,
  } = settingsDomain.actions;
  const runsDomain = useRunsDomain({
    cwd: form.cwd.trim(),
    confirmFullAccessRunIfNeeded,
    setSelectedWorkUnitDetail,
    setErrorMessage,
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
    cancellingRunId,
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

  function openPlainView(view: ViewId): void {
    if (view === "approvals") {
      setApprovalRepairRunId("");
    }
    setThreadPageTargetId("");
    setChannelCreateOpen(false);
    setActiveView(view);
    setActiveSidebarTarget(view);
  }

  function openRunDiagnosticsView(): void {
    setThreadPageTargetId("");
    setChannelCreateOpen(false);
    setActiveView("runs");
    setActiveSidebarTarget("settings");
  }

  function selectWorkspaceChannel(channelId: string): void {
    setChannelCreateOpen(false);
    markChannelRead(channelId);
    setSelectedChannelId(channelId);
    setTaskRunProviderId("");
    setActiveView("workspace");
    setActiveSidebarTarget(channelSidebarTarget(channelId));
  }

  function selectAiTeammate(teammateId: string): void {
    setChannelCreateOpen(false);
    setActiveView("teammates");
    setActiveSidebarTarget(teammateSidebarTarget(teammateId));
  }

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
    if (!seenAt || latestMessageAt > seenAt) {
      setChannelUnreadById((current) => current[channelId] ? current : { ...current, [channelId]: true });
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
      defaultProviderPresetId: selectedChannel?.defaultProviderPresetId || form.providerPresetId || current.defaultProviderPresetId,
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
      items.set(run.id, run);
    }
    return items;
  }, [run, runs]);
  const sidebarChannelNotifications = useMemo(
    () => buildSidebarChannelNotifications(
      approvals,
      [...runs, ...(run ? [run] : [])],
      tasks,
      selectedChannelId,
      channelUnreadById,
    ),
    [approvals, channelUnreadById, run, runs, selectedChannelId, tasks],
  );
  const sidebarTeammateNotifications = useMemo(
    () => buildSidebarTeammateNotifications(approvals, tasks),
    [approvals, tasks],
  );
  const localTeammates = useMemo(
    () => aiTeammates.map((teammate) => aiTeammateToLocalDraft(teammate, providers)),
    [aiTeammates, providers],
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
  const selectedWorkspaceTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId),
    [selectedTaskId, tasks],
  );
  const channelRunsForArtifacts = useMemo(
    () => deriveChannelRuns(selectedChannelId, tasks, runs, run),
    [run, runs, selectedChannelId, tasks],
  );
  const channelRunArtifactsKey = useMemo(
    () => channelRunsForArtifacts.map((item) => `${item.id}:${item.updatedAt}`).join("|"),
    [channelRunsForArtifacts],
  );
  const inlineApprovalIds = useMemo(() => {
    const channelTaskIds = tasks.filter((task) => task.channelId === selectedChannelId).map((task) => task.id);
    const blockedWorkflowStepIds = channelWorkflowSteps
      .filter((step) => step.channelId === selectedChannelId && (step.status === "waiting_for_approval" || step.status === "blocked"))
      .map((step) => step.id);
    return new Set(
      buildInlineApprovalViews(approvals, {
        activeChannelId: selectedChannelId,
        activeRunId,
        visibleRunIds: channelRunsForArtifacts.map((item) => item.id),
        visibleTaskIds: channelTaskIds,
        blockedWorkflowStepIds,
      }).map((item) => item.approval.id),
    );
  }, [activeRunId, approvals, channelRunsForArtifacts, channelWorkflowSteps, selectedChannelId, tasks]);
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
  controlPlaneInvalidationRef.current = (domains) => {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd) {
      return;
    }
    const changed = new Set(domains);
    const refreshes: Promise<unknown>[] = [];
    if (changed.has("runs")) {
      refreshes.push(refreshRuns(workspaceCwd));
      if (selectedChannelId) {
        refreshes.push(refreshChannelActivity());
        refreshes.push(refreshRuntimeState(workspaceCwd));
      }
    }
    if (changed.has("work_units")) {
      refreshes.push(refreshRuntimeState(workspaceCwd));
    }
    if (changed.has("approvals")) {
      refreshes.push(refreshApprovals(workspaceCwd));
      refreshes.push(refreshApprovalPolicy());
    }
    if (changed.has("providers")) {
      refreshes.push(refreshProviders(workspaceCwd));
    }
    if (changed.has("mcp")) {
      refreshes.push(refreshMcp(workspaceCwd));
    }
    if (changed.has("runners")) {
      refreshes.push(refreshRuntimeSettings());
    }
    if (changed.has("teammates")) {
      refreshes.push(refreshAiTeammates(workspaceCwd));
    }
    if (changed.has("memory")) {
      refreshes.push(refreshUsedMemoryAudit(workspaceCwd));
    }
    if (changed.has("skills")) {
      setSkillLibraryRefreshToken((current) => current + 1);
    }
    if (changed.has("artifacts") && selectedChannelId) {
      refreshes.push(refreshChannelRunArtifacts(workspaceCwd, selectedChannelId, channelRunsForArtifacts));
    }
    if (refreshes.length > 0) {
      void Promise.all(refreshes).catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });
    }
  };

  useEffect(() => {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd || daemonHealthy !== true) {
      return undefined;
    }
    let closed = false;
    let source: EventSource | undefined;
    let retryTimer: number | undefined;
    let flushTimer: number | undefined;
    let latestSeq = 0;
    const pendingDomains = new Set<ControlPlaneDomain>();
    const flushDomains = (): void => {
      flushTimer = undefined;
      if (pendingDomains.size === 0) {
        return;
      }
      const domains = [...pendingDomains];
      pendingDomains.clear();
      controlPlaneInvalidationRef.current(domains);
    };
    const enqueueDomain = (domain: ControlPlaneDomain): void => {
      pendingDomains.add(domain);
      if (flushTimer !== undefined) {
        return;
      }
      flushTimer = window.setTimeout(flushDomains, 150);
    };
    const openStream = async (): Promise<void> => {
      const snapshot = await getControlPlaneSnapshot(workspaceCwd, ["runs"]).catch(() => undefined);
      if (closed) {
        return;
      }
      latestSeq = snapshot?.latestEventSeq ?? 0;
      source = new EventSource(controlPlaneStreamUrl(daemonBaseUrl, workspaceCwd, {
        afterSeq: latestSeq,
        domains: controlPlaneSummaryDomains,
      }));
      source.addEventListener("control_plane_event", (message) => {
        const event = parseControlPlaneEventMessage((message as MessageEvent<string>).data);
        if (!event || event.seq <= latestSeq) {
          return;
        }
        latestSeq = event.seq;
        enqueueDomain(event.domain);
      });
      source.addEventListener("error", () => {
        source?.close();
        if (closed || retryTimer !== undefined) {
          return;
        }
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          void openStream();
        }, 2_000);
      });
    };
    void openStream();
    return () => {
      closed = true;
      source?.close();
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
      if (flushTimer !== undefined) {
        window.clearTimeout(flushTimer);
      }
    };
  }, [daemonBaseUrl, daemonHealthy, form.cwd]);

  useEffect(() => {
    void refreshHealth();
    void refreshProviderTemplates();
    void refreshProviders();
    void refreshAiTeammates();
  }, []);

  useEffect(() => {
    if (activeView === "workspace") {
      void refreshChannels();
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
      void refreshChannels();
      void refreshProviders();
      void refreshMcp();
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
    }
  }, [activeView]);

  useEffect(() => {
    if (selectedChannelId) {
      void refreshTasks(selectedChannelId);
      void refreshChannelMessages(selectedChannelId);
      void refreshChannelExecutionProposals(selectedChannelId);
      void refreshChannelFiles(selectedChannelId);
      void refreshChannelProtocol(selectedChannelId);
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
  }, [selectedChannelId]);

  useEffect(() => {
    if (activeView !== "workspace") {
      return;
    }
    void refreshChannelRunArtifacts(form.cwd.trim(), selectedChannelId, channelRunsForArtifacts);
  }, [activeView, channelRunArtifactsKey, form.cwd, selectedChannelId]);

  useEffect(() => {
    if (activeView !== "workspace") {
      return;
    }
    void refreshChannelActivityTransitions(form.cwd.trim(), selectedChannelId, channelRunsForArtifacts);
  }, [activeView, channelTransitionEntityKey, form.cwd, selectedChannelId]);

  useEffect(() => {
    const cwd = form.cwd.trim();
    if (activeView !== "workspace" || isRunning || !workspaceTimelineRunId || !cwd) {
      return;
    }

    const loadKey = `${cwd}::${workspaceTimelineRunId}`;
    if (workspaceTimelineLoadRef.current === loadKey) {
      return;
    }
    if (run?.id === workspaceTimelineRunId && events.length > 0) {
      workspaceTimelineLoadRef.current = loadKey;
      return;
    }

    workspaceTimelineLoadRef.current = loadKey;
    void loadRun(workspaceTimelineRunId, cwd);
  }, [activeView, events.length, form.cwd, isRunning, run?.id, workspaceTimelineRunId]);

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

  function updateWorkspaceCwd(cwd: string): void {
    const previousCwd = form.cwd;
    writeSavedWorkspaceCwd(cwd);
    setForm({ ...form, cwd });
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
    setDurableWorkItems([]);
    setBusyWorkItemId("");
    setChannelForm((current) => ({
      ...current,
      boundPath: current.boundPath === previousCwd || !current.boundPath ? cwd : current.boundPath,
    }));
  }

  async function refreshHealth(): Promise<void> {
    try {
      const health = await getDaemonHealth();
      setDaemonHealthy(health.ok);
      const viteDefaultWorkspaceCwd = getViteDefaultWorkspaceCwd();
      const defaultWorkspaceCwd = health.defaultWorkspaceCwd?.trim() || viteDefaultWorkspaceCwd;
      const canApplyDaemonDefault =
        !readSavedWorkspaceCwd() &&
        (!form.cwd.trim() || form.cwd.trim() === viteDefaultWorkspaceCwd);
      if (health.ok && defaultWorkspaceCwd && canApplyDaemonDefault) {
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
        void Promise.all([
          refreshProviders(defaultWorkspaceCwd),
          refreshChannels(defaultWorkspaceCwd),
          refreshAiTeammates(defaultWorkspaceCwd),
          refreshMcp(defaultWorkspaceCwd),
          refreshRuns(defaultWorkspaceCwd),
          refreshApprovals(defaultWorkspaceCwd),
          refreshRuntimeState(defaultWorkspaceCwd),
          refreshUsedMemoryAudit(defaultWorkspaceCwd),
          refreshWorkItems(defaultWorkspaceCwd),
        ]).catch((error: unknown) => {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        });
      }
    } catch {
      setDaemonHealthy(false);
    }
  }

  async function startRun(): Promise<void> {
    await runWithRequest(buildRunRequest(form), form.cwd.trim());
  }

  async function confirmFullAccessRunIfNeeded(requestBody: unknown): Promise<unknown | undefined> {
    if (readRequestPermissionMode(requestBody) !== "full_access") {
      return requestBody;
    }
    setFullAccessConfirmOpen(true);
    const confirmed = await new Promise<boolean>((resolve) => {
      fullAccessConfirmResolveRef.current = resolve;
    });
    if (!confirmed) {
      return undefined;
    }
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
      return requestBody;
    }
    return {
      ...requestBody,
      permissionConfirmation: {
        mode: "full_access",
        confirmed: true,
        confirmedAt: new Date().toISOString(),
        reason: "user_confirmed_full_access",
      },
    };
  }

  function resolveFullAccessConfirmation(approved: boolean): void {
    setFullAccessConfirmOpen(false);
    fullAccessConfirmResolveRef.current?.(approved);
    fullAccessConfirmResolveRef.current = undefined;
  }

  async function refreshChannelActivity(): Promise<void> {
    const channelId = selectedChannelId;
    if (!channelId) {
      return;
    }

    await Promise.all([
      refreshChannels(),
      refreshTasks(channelId),
      refreshChannelMessages(channelId),
      refreshChannelExecutionProposals(channelId),
      refreshChannelFiles(channelId),
      refreshChannelRunArtifacts(form.cwd.trim(), channelId, channelRunsForArtifacts),
      refreshChannelProtocol(channelId),
      refreshRuns(),
      refreshApprovals(),
      refreshExternalWorkCiTriage(form.cwd.trim(), channelId),
      refreshUsedMemoryAudit(),
    ]);
    void refreshChannelActivityTransitions(form.cwd.trim(), channelId, channelRunsForArtifacts);
  }

  async function refreshWorkItems(cwd = form.cwd.trim()): Promise<void> {
    if (!cwd) {
      setDurableWorkItems([]);
      return;
    }
    setDurableWorkItemsLoading(true);
    try {
      const response = await listWorkItems(cwd);
      setDurableWorkItems(response.workItems);
    } catch (caught) {
      setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDurableWorkItemsLoading(false);
    }
  }

  async function claimDurableWorkItem(workItemId: string): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd || !workItemId || busyWorkItemId) {
      return;
    }
    setBusyWorkItemId(workItemId);
    try {
      const response = await claimWorkItem(workspaceCwd, workItemId, {
        ownerId: "web-user",
        leaseMs: 5 * 60_000,
      });
      setDurableWorkItems((current) => [response.workItem, ...current.filter((item) => item.id !== response.workItem.id)]);
      if (response.blocker) {
        setErrorMessage(response.blocker.message);
      } else {
        setErrorMessage("");
      }
    } catch (caught) {
      setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyWorkItemId("");
    }
  }

  async function heartbeatDurableWorkItem(workItemId: string, claimToken: string): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd || !workItemId || !claimToken || busyWorkItemId) {
      return;
    }
    setBusyWorkItemId(workItemId);
    try {
      const response = await heartbeatWorkItem(workspaceCwd, workItemId, {
        claimToken,
        leaseMs: 5 * 60_000,
      });
      setDurableWorkItems((current) => [response.workItem, ...current.filter((item) => item.id !== response.workItem.id)]);
      setErrorMessage("");
    } catch (caught) {
      setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyWorkItemId("");
    }
  }

  async function routeExternalWorkToChannel(externalWorkId: string, channelId: string): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd || !externalWorkId || !channelId || routingExternalWorkId) {
      return;
    }
    setRoutingExternalWorkId(externalWorkId);
    try {
      setErrorMessage("");
      const response = await routeExternalWork(workspaceCwd, externalWorkId, { channelId });
      const actionIds = response.actions.map((item) => item.action.id);
      await Promise.all([
        refreshExternalActionDetailsByIds(workspaceCwd, actionIds),
        refreshExternalWorkCiTriage(workspaceCwd, channelId),
        refreshExternalWorkStatus(workspaceCwd, channelId),
        refreshChannelProtocol(channelId),
        refreshApprovals(workspaceCwd),
        refreshWorkItems(workspaceCwd),
      ]);
    } catch (caught) {
      setErrorMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRoutingExternalWorkId("");
    }
  }

  function buildChannelCreatePayload(input: ChannelCreateFormState): ChannelFormState {
    const defaultTeammateId = input.defaultResponderTeammateId || input.defaultTeammateId;
    return {
      name: input.name,
      status: input.status,
      boundPath: input.boundPath,
      defaultProviderPresetId: input.defaultProviderPresetId,
      defaultTeammateId,
      autoReplyMode: input.autoReplyMode,
      allowedTools: input.allowedTools,
      runtimePolicy: input.runtimePolicy,
    };
  }

  function selectedCreateTeammateIds(input: ChannelCreateFormState): readonly string[] {
    const ids = new Set(input.selectedTeammateIds.filter(Boolean));
    if (input.defaultResponderTeammateId) {
      ids.add(input.defaultResponderTeammateId);
    }
    return [...ids];
  }

  async function applyCreatedChannelTeammates(channelId: string, input: ChannelCreateFormState): Promise<void> {
    const defaultTeammateId = input.defaultResponderTeammateId || input.defaultTeammateId;
    const teammateIds = selectedCreateTeammateIds(input);
    if (defaultTeammateId) {
      await setDefaultChannelTeammate(channelId, defaultTeammateId);
    }
    for (const teammateId of teammateIds) {
      if (teammateId !== defaultTeammateId) {
        await addChannelTeammate(channelId, teammateId);
      }
    }
  }

  async function saveChannel(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("本地工作区未就绪");
      return;
    }
    if (!channelForm.name.trim()) {
      setErrorMessage("请输入 channel name");
      return;
    }

    try {
      setErrorMessage("");
      const response = await createChannel(form.cwd.trim(), buildChannelCreatePayload(channelForm));
      await applyCreatedChannelTeammates(response.channel.id, channelForm);
      setSelectedChannelId(response.channel.id);
      setActiveSidebarTarget(channelSidebarTarget(response.channel.id));
      setChannelCreateOpen(false);
      setChannelForm((current) => ({
        ...current,
        name: "",
        defaultProviderPresetId: (current.defaultProviderPresetId || response.channel.defaultProviderPresetId) ?? "",
        selectedTeammateIds: [],
        defaultResponderTeammateId: "",
        defaultTeammateId: "",
      }));
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function saveDefaultChannel(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("本地工作区未就绪");
      return;
    }

    const readyProvider = providers.find(providerPreflightReady);
    try {
      setErrorMessage("");
      const response = await createChannel(form.cwd.trim(), {
        name: channelForm.name.trim() || "Engineering",
        status: channelForm.status,
        boundPath: channelForm.boundPath.trim() || form.cwd.trim(),
        defaultProviderPresetId: readyProvider?.id ?? channelForm.defaultProviderPresetId,
        defaultTeammateId: channelForm.defaultResponderTeammateId || channelForm.defaultTeammateId,
        autoReplyMode: channelForm.autoReplyMode,
        allowedTools: channelForm.allowedTools.length > 0 ? channelForm.allowedTools : defaultTools,
        runtimePolicy: channelForm.runtimePolicy,
      });
      await applyCreatedChannelTeammates(response.channel.id, channelForm);
      setSelectedChannelId(response.channel.id);
      setActiveSidebarTarget(channelSidebarTarget(response.channel.id));
      setChannelCreateOpen(false);
      setTaskRunProviderId("");
      if (readyProvider) {
        setForm((current) => ({
          ...current,
          providerPresetId: readyProvider.id,
          provider: readyProvider.providerId,
          model: readyProvider.model,
          baseUrl: providerEffectiveBaseUrl(readyProvider, providerTemplates),
          api: readyProvider.api,
        }));
      }
      setChannelForm((current) => ({
        ...current,
        name: "",
        boundPath: current.boundPath || form.cwd.trim(),
        defaultProviderPresetId: readyProvider?.id ?? current.defaultProviderPresetId,
        defaultTeammateId: "",
        selectedTeammateIds: [],
        defaultResponderTeammateId: "",
      }));
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function saveChannelEdit(channelId: string): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("本地工作区未就绪");
      return;
    }
    if (!channelEditForm.name.trim()) {
      setErrorMessage("请输入 channel name");
      return;
    }
    if (channelEditForm.allowedTools.length === 0) {
      setErrorMessage("请至少选择一个 allowed tool");
      return;
    }

    try {
      setErrorMessage("");
      const response = await updateChannel(form.cwd.trim(), channelId, channelEditForm);
      setSelectedChannelId(response.channel.id);
      setTaskRunProviderId("");
      setChannelEditForm(channelToForm(response.channel, form.cwd));
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function removeChannel(channelId: string): Promise<void> {
    try {
      setErrorMessage("");
      await deleteChannel(form.cwd.trim(), channelId);
      if (selectedChannelId === channelId) {
        setSelectedChannelId("");
      }
      if (activeSidebarTarget === channelSidebarTarget(channelId)) {
        setActiveSidebarTarget("workspace");
      }
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveTask(): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    if (!taskForm.prompt.trim()) {
      setErrorMessage("请输入 task prompt");
      return;
    }

    try {
      setErrorMessage("");
      const response = await createTask(form.cwd.trim(), selectedChannelId, {
        title: taskForm.title.trim() || titleFromPrompt(taskForm.prompt),
        prompt: taskForm.prompt,
        assigneeTeammateId: taskForm.assigneeTeammateId || channels.find((channel) => channel.id === selectedChannelId)?.defaultTeammateId,
      });
      setSelectedTaskId(response.task.id);
      setTaskForm(defaultTaskForm);
      await refreshTasks(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendChannelMessage(input: {
    readonly threadId?: string;
    readonly body: string;
    readonly mentions: readonly { readonly id: string; readonly label: string; readonly kind: "ai-teammate" | "local-user" | "channel" }[];
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
    readonly requestAiReply: boolean;
  }): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    const firstAiMention = input.mentions.find((mention) => mention.kind === "ai-teammate");
    const providerPresetId = resolveChannelMessageProviderPresetId(
      selectedChannel,
      firstAiMention?.id || selectedChannel?.defaultTeammateId,
    );
    try {
      setErrorMessage("");
      const response = await createChannelMessage(form.cwd.trim(), selectedChannelId, {
        threadId: input.threadId,
        body: input.body,
        mentions: input.mentions,
        attachmentIds: input.attachmentIds,
        linkPreviewIds: input.linkPreviewIds,
        requestAiReply: input.requestAiReply,
        providerPresetId: providerPresetId || undefined,
        teammateId: firstAiMention?.id || selectedChannel?.defaultTeammateId,
      });
      setChannelMessages((current) => [
        ...current,
        response.message,
        ...(response.aiReply ? [response.aiReply] : []),
      ]);
      if (response.aiReply) {
        await refreshChannelExecutionProposals(selectedChannelId);
        await refreshUsedMemoryAudit(form.cwd.trim());
      }
      await refreshChannelMessageRouteDecisions(selectedChannelId);
      await refreshChannelFiles(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function uploadChannelFiles(files: readonly File[]): Promise<readonly ChannelAttachment[]> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return [];
    }
    if (files.length === 0) {
      return [];
    }

    setChannelFilesLoading(true);
    try {
      setErrorMessage("");
      const responses = await Promise.all(files.map((file) => uploadChannelAttachment(form.cwd.trim(), selectedChannelId, file)));
      const uploaded = responses.map((response) => response.attachment);
      setChannelAttachments((current) => [...uploaded, ...current]);
      return uploaded;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setChannelFilesLoading(false);
    }
  }

  async function addChannelLinkPreview(url: string): Promise<ChannelLinkPreview | undefined> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return undefined;
    }
    try {
      setErrorMessage("");
      const response = await createChannelLinkPreview(form.cwd.trim(), selectedChannelId, { url });
      setChannelLinkPreviews((current) => [
        response.linkPreview,
        ...current.filter((preview) => preview.id !== response.linkPreview.id),
      ]);
      return response.linkPreview;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function removeChannelAttachment(attachmentId: string): Promise<void> {
    try {
      setErrorMessage("");
      await deleteChannelAttachment(form.cwd.trim(), attachmentId);
      setChannelAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveChannelBrief(input: UpdateChannelBriefRequest): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    try {
      setErrorMessage("");
      const response = await updateChannelBrief(form.cwd.trim(), selectedChannelId, input);
      setChannelBrief(response.brief);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function supersedeChannelDecision(decision: ChannelDecision): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    try {
      setErrorMessage("");
      await createChannelDecision(form.cwd.trim(), selectedChannelId, {
        title: `${decision.title} update`,
        decision: decision.decision,
        rationale: "Supersedes the previous active decision.",
        alternatives: decision.alternatives,
        supersedesDecisionId: decision.id,
        createdBy: "local-user",
      });
      await refreshChannelProtocol(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function rejectChannelDecision(decision: ChannelDecision): Promise<void> {
    try {
      setErrorMessage("");
      const response = await updateChannelDecision(form.cwd.trim(), decision.id, { status: "rejected" });
      setChannelDecisions((current) => current.map((item) => item.id === response.decision.id ? response.decision : item));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function createHandoffFromTask(task: Task): Promise<ChannelHandoff | undefined> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return undefined;
    }
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    const teammateId = task.assigneeTeammateId ?? selectedChannel?.defaultTeammateId ?? "engineer";
    try {
      setErrorMessage("");
      const response = await createChannelHandoff(form.cwd.trim(), selectedChannelId, {
        sourceTaskId: task.id,
        fromParticipantId: "local-user",
        fromParticipantLabel: "Tian",
        toParticipantId: teammateId,
        toParticipantLabel: teammateId,
        reason: task.title,
        requiredInput: task.prompt,
        expectedOutput: "Complete or report blocker for this task.",
        createdBy: "local-user",
      });
      setChannelHandoffs((current) => [response.handoff, ...current]);
      return response.handoff;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  async function updateHandoffStatusValue(handoff: ChannelHandoff, status: ChannelHandoffStatus): Promise<void> {
    try {
      setErrorMessage("");
      const response = await updateChannelHandoff(form.cwd.trim(), handoff.id, { status });
      setChannelHandoffs((current) => current.map((item) => item.id === response.handoff.id ? response.handoff : item));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function startWorkflowFromHandoff(handoff: ChannelHandoff): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }

    try {
      setErrorMessage("");
      const response = await createChannelWorkflowFromHandoff(form.cwd.trim(), handoff.id, {
        title: `${handoff.reason || "Handoff"} workflow`,
        objective: handoff.expectedOutput || handoff.requiredInput || handoff.reason,
        createdBy: "local-user",
      });
      setChannelWorkflows((current) => [response.workflow, ...current.filter((item) => item.id !== response.workflow.id)]);
      const createdStep = response.workflowStep;
      if (createdStep) {
        setChannelWorkflowSteps((current) => [createdStep, ...current.filter((item) => item.id !== createdStep.id)]);
      }
      await refreshChannelProtocol(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function startAutoplanWorkflow(): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd || !selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }

    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    const providerPresetId = taskRunProviderId || selectedChannel?.defaultProviderPresetId || form.providerPresetId || providers.find(providerPreflightReady)?.id;
    const objective = (channelBrief?.objective || selectedChannel?.name || "Run the built-in autoplan-lite workflow.").trim();
    setOrchestratingWorkflowId("new:autoplan-lite");
    try {
      setErrorMessage("");
      const response = await createChannelWorkflowFromTemplate(workspaceCwd, selectedChannelId, {
        templateId: "autoplan-lite",
        title: `${selectedChannel?.name ?? "Channel"} autoplan`,
        objective,
        createdBy: "local-user",
        providerPresetId: providerPresetId || undefined,
        autoStart: true,
      });
      setChannelWorkflows((current) => [response.workflow, ...current.filter((item) => item.id !== response.workflow.id)]);
      setChannelWorkflowSteps((current) => mergeWorkflowSteps(current, response.workflowSteps));
      await orchestrateWorkflowById(response.workflow.id, response.workflow.channelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setOrchestratingWorkflowId((current) => current === "new:autoplan-lite" ? "" : current);
    }
  }

  async function handleDomainEvent(event: DomainEvent): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    switch (event.type) {
      case "view.openRequested":
        setActiveView(event.view);
        setActiveSidebarTarget(event.target ?? event.view);
        return;

      case "approval.resolved":
        await refreshApprovals(workspaceCwd, event.runId);
        if (event.externalWorkActionId) {
          await refreshExternalActionDetailsByIds(workspaceCwd, [event.externalWorkActionId]);
        }
        if (event.runId && (event.runId === activeRunId || event.runId === lookupRunId || event.runId === approvalRepairRunId)) {
          await Promise.all([loadRun(event.runId, workspaceCwd), refreshRuns(workspaceCwd)]);
          window.setTimeout(() => {
            void loadRun(event.runId, workspaceCwd);
            void refreshRuns(workspaceCwd);
            void refreshApprovals(workspaceCwd, event.runId);
          }, 750);
        }
        if (event.mediaJobId) {
          await refreshMediaJobs(workspaceCwd);
        }
        return;

      case "provider.repairRequested": {
        const provider = event.providerPresetId ? providers.find((item) => item.id === event.providerPresetId) : undefined;
        if (event.sourceRunId) {
          setProviderRepairRunId(event.sourceRunId);
        }
        if (provider) {
          editProvider(provider);
        }
        setActiveView("providers");
        setActiveSidebarTarget("providers");
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

  async function orchestrateWorkflowById(workflowId: string, channelId?: string): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd) {
      setErrorMessage("本地工作区未就绪");
      return;
    }

    setOrchestratingWorkflowId(workflowId);
    try {
      setErrorMessage("");
      const result = await orchestrateChannelWorkflow(workspaceCwd, workflowId);
      setChannelWorkflows((current) => [result.workflow, ...current.filter((item) => item.id !== result.workflow.id)]);
      const workflowStep = "workflowStep" in result ? result.workflowStep : undefined;
      if (workflowStep) {
        setChannelWorkflowSteps((current) => mergeWorkflowSteps(current, [workflowStep]));
      }
      if ("approval" in result && result.approval) {
        upsertApprovalRecord(result.approval);
      }
      if (result.status === "blocked" || result.status === "failed") {
        setErrorMessage(result.blocker);
      } else if (result.status === "idle" && result.reason) {
        setErrorMessage(result.reason);
      }
      await handleDomainEvent({
        type: "workflow.advanced",
        workflowId,
        channelId: channelId ?? selectedChannelId,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setOrchestratingWorkflowId((current) => current === workflowId ? "" : current);
    }
  }

  async function orchestrateWorkflowAction(workflow: ChannelWorkflow): Promise<void> {
    await orchestrateWorkflowById(workflow.id, workflow.channelId);
  }

  async function cancelWorkflowAction(workflow: ChannelWorkflow): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd) {
      setErrorMessage("本地工作区未就绪");
      return;
    }

    setOrchestratingWorkflowId(workflow.id);
    try {
      setErrorMessage("");
      const response = await cancelChannelWorkflow(workspaceCwd, workflow.id);
      setChannelWorkflows((current) => [response.workflow, ...current.filter((item) => item.id !== response.workflow.id)]);
      setChannelWorkflowSteps((current) => mergeWorkflowSteps(current, response.workflowSteps));
      await handleDomainEvent({
        type: "workflow.cancelled",
        workflowId: workflow.id,
        channelId: workflow.channelId,
        runIds: [],
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setOrchestratingWorkflowId((current) => current === workflow.id ? "" : current);
    }
  }

  async function retryWorkflowStepAction(step: ChannelWorkflowStep): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd) {
      setErrorMessage("本地工作区未就绪");
      return;
    }

    setRunningWorkflowStepId(step.id);
    try {
      setErrorMessage("");
      const result = await retryChannelWorkflowStep(workspaceCwd, step.id);
      setChannelWorkflows((current) => [result.workflow, ...current.filter((item) => item.id !== result.workflow.id)]);
      const workflowStep = "workflowStep" in result ? result.workflowStep : undefined;
      if (workflowStep) {
        setChannelWorkflowSteps((current) => mergeWorkflowSteps(current, [workflowStep]));
      }
      if ("approval" in result && result.approval) {
        upsertApprovalRecord(result.approval);
      }
      if (result.status === "blocked" || result.status === "failed") {
        setErrorMessage(result.blocker);
      } else if (result.status === "idle" && result.reason) {
        setErrorMessage(result.reason);
      }
      await handleDomainEvent({
        type: "workflowStep.retried",
        workflowId: step.workflowId,
        workflowStepId: step.id,
        channelId: step.channelId,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunningWorkflowStepId((current) => current === step.id ? "" : current);
    }
  }

  async function startWorkflowStepAction(step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd) {
      setErrorMessage("本地工作区未就绪");
      return;
    }
    const workflow = channelWorkflows.find((item) => item.id === step.workflowId);
    const channel = workflow ? channels.find((item) => item.id === workflow.channelId) : channels.find((item) => item.id === step.channelId);
    const providerPresetId = taskRunProviderId || channel?.defaultProviderPresetId || form.providerPresetId || providers.find(providerPreflightReady)?.id;
    const request = {
      mode,
      providerPresetId,
      assigneeTeammateId: step.toParticipantId,
    };

    setRunningWorkflowStepId(step.id);
    try {
      setErrorMessage("");
      if (mode === "create_task") {
        const response = await startChannelWorkflowStep(workspaceCwd, step.id, request);
        if (response.workflow) {
          setChannelWorkflows((current) => current.map((item) => item.id === response.workflow?.id ? response.workflow : item));
        }
        setChannelWorkflowSteps((current) => current.map((item) => item.id === response.workflowStep.id ? response.workflowStep : item));
        const createdTask = response.task;
        if (createdTask) {
          setSelectedTaskId(createdTask.id);
          setTasks((current) => [createdTask, ...current.filter((item) => item.id !== createdTask.id)]);
        }
        if (response.blocker) {
          setErrorMessage(response.blocker);
        }
        await Promise.all([refreshTasks(step.channelId), refreshChannelProtocol(step.channelId), refreshRuntimeState(workspaceCwd)]);
        return;
      }

      const url = `${daemonBaseUrl}/workflow-steps/${encodeURIComponent(step.id)}/start?cwd=${encodeURIComponent(workspaceCwd)}`;
      await streamRunRequest(url, request, workspaceCwd, async () => {
        await Promise.all([
          refreshTasks(step.channelId),
          refreshChannelProtocol(step.channelId),
        ]);
      });
      await Promise.all([refreshTasks(step.channelId), refreshChannelProtocol(step.channelId), refreshRuntimeState(workspaceCwd)]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunningWorkflowStepId((current) => current === step.id ? "" : current);
    }
  }

  async function updateWorkflowStepStatus(step: ChannelWorkflowStep, status: "skipped" | "cancelled"): Promise<void> {
    try {
      setErrorMessage("");
      const response = await updateChannelWorkflowStep(form.cwd.trim(), step.id, { status });
      setChannelWorkflowSteps((current) => current.map((item) => item.id === response.workflowStep.id ? response.workflowStep : item));
      if (response.workflow) {
        setChannelWorkflows((current) => current.map((item) => item.id === response.workflow?.id ? response.workflow : item));
      }
      await handleDomainEvent({
        type: "workflowStep.updated",
        workflowId: step.workflowId,
        workflowStepId: step.id,
        channelId: step.channelId,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function createTaskFromContextSummary(summary: ChannelContextSummary): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    try {
      setErrorMessage("");
      const response = await createTask(form.cwd.trim(), selectedChannelId, {
        title: titleFromPrompt(summary.summary),
        prompt: buildContextTaskPrompt(summary, channelDecisions),
        assigneeTeammateId: selectedChannel?.defaultTeammateId,
      });
      setSelectedTaskId("");
      setTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)]);
      await refreshTasks(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function runActivityTriageAction(draft: ChannelActivityTriageDraft): Promise<ChannelActivityTriageResult> {
    if (!selectedChannelId) {
      const error = new Error("请先选择 channel");
      setErrorMessage(error.message);
      throw error;
    }
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    const sourceRefs = draft.sourceRefs;
    try {
      setErrorMessage("");
      if (draft.actionKind === "follow_up_task") {
        const response = await createTask(form.cwd.trim(), selectedChannelId, {
          title: draft.title.trim(),
          prompt: draft.prompt,
          assigneeTeammateId: draft.assigneeTeammateId || selectedChannel?.defaultTeammateId,
        });
        setSelectedTaskId(response.task.id);
        setTasks((current) => [response.task, ...current.filter((task) => task.id !== response.task.id)]);
        return { kind: "task", task: response.task };
      }

      if (draft.actionKind === "handoff") {
        const response = await createChannelHandoff(form.cwd.trim(), selectedChannelId, {
          ...(sourceRefs.sourceMessageId ? { sourceMessageId: sourceRefs.sourceMessageId } : {}),
          ...(sourceRefs.sourceTaskId ? { sourceTaskId: sourceRefs.sourceTaskId } : {}),
          ...(sourceRefs.sourceRunId ? { sourceRunId: sourceRefs.sourceRunId } : {}),
          fromParticipantId: "local-user",
          fromParticipantLabel: "Tian",
          toParticipantId: draft.toParticipantId.trim(),
          toParticipantLabel: draft.toParticipantLabel.trim(),
          reason: draft.reason.trim(),
          requiredInput: draft.requiredInput,
          expectedOutput: draft.expectedOutput,
          createdBy: "local-user",
        });
        setChannelHandoffs((current) => [response.handoff, ...current.filter((handoff) => handoff.id !== response.handoff.id)]);
        return { kind: "handoff", handoff: response.handoff };
      }

      if (draft.actionKind === "decision") {
        const response = await createChannelDecision(form.cwd.trim(), selectedChannelId, {
          ...(sourceRefs.sourceMessageId ? { sourceMessageId: sourceRefs.sourceMessageId } : {}),
          ...(sourceRefs.sourceTaskId ? { sourceTaskId: sourceRefs.sourceTaskId } : {}),
          ...(sourceRefs.sourceRunId ? { sourceRunId: sourceRefs.sourceRunId } : {}),
          title: draft.title.trim(),
          decision: draft.decision,
          rationale: draft.rationale,
          alternatives: [],
          createdBy: "local-user",
        });
        setChannelDecisions((current) => [response.decision, ...current.filter((decision) => decision.id !== response.decision.id)]);
        return { kind: "decision", decision: response.decision };
      }

      const response = await createChannelContextSummary(form.cwd.trim(), selectedChannelId, {
        targetType: sourceRefs.contextTargetType,
        targetId: sourceRefs.contextTargetId,
        sourceMessageIds: sourceRefs.sourceMessageIds,
        decisionIds: draft.decisionIds,
        summary: draft.summary,
        acceptanceCriteria: splitTextLines(draft.acceptanceCriteria),
        openQuestions: splitTextLines(draft.openQuestions),
        authorType: "local-user",
        authorId: "local-user",
      });
      setChannelContextSummaries((current) => [
        response.contextSummary,
        ...current.filter((summary) => summary.id !== response.contextSummary.id),
      ]);
      return { kind: "context_summary", contextSummary: response.contextSummary };
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function removeTask(taskId: string): Promise<void> {
    try {
      setErrorMessage("");
      await deleteTask(form.cwd.trim(), taskId);
      if (selectedTaskId === taskId) {
        setSelectedTaskId("");
      }
      await refreshTasks();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function moveTaskToReview(taskId: string): Promise<void> {
    try {
      setErrorMessage("");
      await updateTaskStatus(form.cwd.trim(), taskId, "review");
      await refreshTasks();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveTaskEdit(taskId: string): Promise<Task | undefined> {
    if (!taskEditForm.title.trim()) {
      setErrorMessage("请输入 task title");
      return undefined;
    }
    if (!taskEditForm.prompt.trim()) {
      setErrorMessage("请输入 task prompt");
      return undefined;
    }

    try {
      setErrorMessage("");
      const response = await updateTask(form.cwd.trim(), taskId, {
        ...taskEditForm,
        title: taskEditForm.title.trim(),
        prompt: taskEditForm.prompt.trim(),
      });
      await refreshTasks();
      return response.task;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  function resolveTaskRunProviderPresetId(channel: Channel | undefined): string {
    return taskRunProviderId || channel?.defaultProviderPresetId || form.providerPresetId || providers.find(providerPreflightReady)?.id || "";
  }

  function resolveChannelMessageProviderPresetId(channel: Channel | undefined, teammateId: string | undefined): string {
    const teammateProviderPresetId = findAiTeammateByReference(teammateId)?.providerPresetId;
    return teammateProviderPresetId || taskRunProviderId || channel?.defaultProviderPresetId || form.providerPresetId || providers.find(providerPreflightReady)?.id || "";
  }

  function findAiTeammateByReference(teammateId: string | undefined): AiTeammate | undefined {
    if (!teammateId) {
      return undefined;
    }
    return aiTeammates.find((teammate) => teammate.id === teammateId || teammate.templateId === teammateId);
  }

  async function markChannelExecutionProposal(
    proposal: ChannelExecutionProposal,
    input: Parameters<typeof updateChannelExecutionProposal>[2],
  ): Promise<ChannelExecutionProposal | undefined> {
    try {
      const response = await updateChannelExecutionProposal(form.cwd.trim(), proposal.id, input);
      upsertChannelExecutionProposal(response.proposal);
      return response.proposal;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  async function blockChannelExecutionProposal(proposal: ChannelExecutionProposal, message: string): Promise<void> {
    setErrorMessage(message);
    await markChannelExecutionProposal(proposal, { status: "blocked", errorMessage: message });
  }

  async function confirmChannelExecutionProposal(proposal: ChannelExecutionProposal): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd) {
      setErrorMessage(t("Local workspace is not ready."));
      return;
    }
    if (isRunning) {
      setErrorMessage(t("A run is already active. Wait for it to finish before starting another proposal."));
      return;
    }

    const channel = channels.find((item) => item.id === proposal.channelId);
    if (!channel) {
      await blockChannelExecutionProposal(proposal, t("Task channel not found."));
      return;
    }
    if (channel.status !== "active") {
      await blockChannelExecutionProposal(proposal, t("Channel is {status}; resume it before starting a new run.", { status: t(channel.status) }));
      return;
    }

    const assignee = findAiTeammateByReference(proposal.assigneeTeammateId);
    if (!assignee) {
      await blockChannelExecutionProposal(proposal, t("Assignee teammate not found. Add the teammate to this workspace before starting."));
      return;
    }
    const providerPresetId = assignee.providerPresetId;
    if (!providerPresetId) {
      await blockChannelExecutionProposal(proposal, t("Assignee teammate has no provider configured. Open AI teammate management and assign a runnable provider."));
      return;
    }
    const provider = providers.find((item) => item.id === providerPresetId);
    const providerBlocker = providerRunPreflightBlocker(provider, t);
    if (providerBlocker) {
      await blockChannelExecutionProposal(proposal, providerBlocker);
      return;
    }

    let taskToRun = proposal.linkedTaskId ? tasks.find((task) => task.id === proposal.linkedTaskId) : undefined;
    try {
      setErrorMessage("");
      if (!taskToRun) {
        const taskResponse = await createTask(workspaceCwd, proposal.channelId, {
          title: proposal.title.trim() || titleFromPrompt(proposal.prompt),
          prompt: proposal.prompt,
          assigneeTeammateId: proposal.assigneeTeammateId,
        });
        taskToRun = taskResponse.task;
        setSelectedTaskId(taskResponse.task.id);
        setTasks((current) => [taskResponse.task, ...current.filter((task) => task.id !== taskResponse.task.id)]);
      } else {
        setSelectedTaskId(taskToRun.id);
      }
      const confirmedTask = taskToRun;

      await markChannelExecutionProposal(proposal, {
        status: "accepted",
        linkedTaskId: confirmedTask.id,
        errorMessage: null,
      });

      let linkedRunId = "";
      const runStarted = await runPersistedTask(confirmedTask, {
        providerPresetIdOverride: providerPresetId,
        toolsOverride: assignee.allowedTools,
        approvalProfileOverride: assignee.approvalProfile,
        afterRunLoaded: async (runId) => {
          linkedRunId = runId;
          await markChannelExecutionProposal(proposal, {
            status: "accepted",
            linkedTaskId: confirmedTask.id,
            linkedRunId: runId,
            errorMessage: null,
          });
        },
      });

      if (!runStarted) {
        await markChannelExecutionProposal(proposal, {
          status: "run_failed",
          linkedTaskId: confirmedTask.id,
          errorMessage: t("Run failed to start."),
        });
      } else if (!linkedRunId) {
        await markChannelExecutionProposal(proposal, {
          status: "run_failed",
          linkedTaskId: confirmedTask.id,
          errorMessage: t("Proposal run did not return a run id."),
        });
      }

      await Promise.all([
        refreshTasks(proposal.channelId),
        refreshRuns(workspaceCwd),
        refreshChannelExecutionProposals(proposal.channelId),
        refreshUsedMemoryAudit(workspaceCwd),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      await markChannelExecutionProposal(proposal, {
        status: "run_failed",
        linkedTaskId: taskToRun?.id ?? proposal.linkedTaskId ?? null,
        errorMessage: message,
      });
    }
  }

  async function cancelChannelExecutionProposal(proposal: ChannelExecutionProposal): Promise<void> {
    await markChannelExecutionProposal(proposal, { status: "cancelled" });
  }

  async function runPersistedTask(
    task: Task,
    options: {
      readonly skipPreflight?: boolean;
      readonly action?: TaskRunActionState["action"];
      readonly providerPresetIdOverride?: string;
      readonly toolsOverride?: readonly Channel["allowedTools"][number][];
      readonly approvalProfileOverride?: AiTeammate["approvalProfile"];
      readonly afterRunLoaded?: (runId: string) => Promise<void>;
    } = {},
  ): Promise<boolean> {
    const action = options.action ?? "run";
    setActiveTaskRunAction({ taskId: task.id, action });
    try {
      const channel = channels.find((item) => item.id === task.channelId);
      if (!channel) {
        setErrorMessage(t("Task channel not found."));
        return false;
      }
      if (channel.status !== "active") {
        setErrorMessage(t("Channel is {status}; resume it before starting a new run.", { status: t(channel.status) }));
        return false;
      }
      const providerPresetId = options.providerPresetIdOverride || resolveTaskRunProviderPresetId(channel);
      if (!providerPresetId) {
        setErrorMessage(t("No provider preset is selected for this task run."));
        return false;
      }
      const provider = providers.find((item) => item.id === providerPresetId);
      if (!provider || !canUseProviderForRun(provider)) {
        setErrorMessage(provider
          ? t("Provider preset is not runnable: {reason}", { reason: providerRunBlockerLabel(provider, t) })
          : t("Provider preset not found"));
        return false;
      }
      if (!options.skipPreflight) {
        const blocker = providerRunPreflightBlocker(provider, t);
        if (blocker) {
          setErrorMessage(blocker);
          return false;
        }
      }

      const runCwd = form.cwd.trim();
      await runWithRequest(buildTaskRunRequest(runCwd, task, channel, providerPresetId, {
        tools: options.toolsOverride,
        approvalProfile: options.approvalProfileOverride,
        permissionPreset: form.permissionPreset,
        permissionMode: form.permissionMode,
      }), runCwd, async (runId) => {
        await refreshTasks(task.channelId);
        await options.afterRunLoaded?.(runId);
      });
      return true;
    } finally {
      setActiveTaskRunAction((current) =>
        current?.taskId === task.id && current.action === action ? undefined : current,
      );
    }
  }

  async function checkThenRunPersistedTask(task: Task): Promise<boolean> {
    setActiveTaskRunAction({ taskId: task.id, action: "check" });
    const channel = channels.find((item) => item.id === task.channelId);
    const providerPresetId = resolveTaskRunProviderPresetId(channel);
    const provider = providerPresetId ? providers.find((item) => item.id === providerPresetId) : undefined;
    if (!provider) {
      setErrorMessage(providerPresetId ? t("Provider preset not found") : t("No provider preset is selected for this task run."));
      setActiveTaskRunAction(undefined);
      return false;
    }
    if (!(await checkProviderForRun(provider))) {
      setActiveTaskRunAction(undefined);
      return false;
    }
    return await runPersistedTask(task, { skipPreflight: true, action: "check" });
  }

  async function runUpdatedTaskFromRepair(task: Task): Promise<void> {
    const updatedTask = await saveTaskEdit(task.id);
    if (!updatedTask) {
      return;
    }
    if (await runPersistedTask(updatedTask)) {
      setTaskRepairRunId("");
    }
  }

  async function checkThenRunUpdatedTaskFromRepair(task: Task): Promise<void> {
    const updatedTask = await saveTaskEdit(task.id);
    if (!updatedTask) {
      return;
    }
    if (await checkThenRunPersistedTask(updatedTask)) {
      setTaskRepairRunId("");
    }
  }

  async function rerunRun(sourceRun: RunSession): Promise<void> {
    try {
      const workspaceCwd = readRunWorkspaceCwd(sourceRun, form.cwd.trim());
      await runWithRequest(buildRerunRequest(sourceRun), workspaceCwd);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function applyProviderToRun(provider: ProviderPreset): Promise<void> {
    setTaskRunProviderId(provider.id);
    setForm((current) => ({
      ...current,
      providerPresetId: provider.id,
      provider: provider.providerId,
      model: provider.model,
      baseUrl: providerEffectiveBaseUrl(provider, providerTemplates),
      api: provider.api,
    }));

    const workspaceCwd = form.cwd.trim();
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    if (!workspaceCwd || !selectedChannel) {
      return;
    }

    const nextChannelForm = {
      ...channelToForm(selectedChannel, workspaceCwd),
      defaultProviderPresetId: provider.id,
    };
    setChannels((current) =>
      current.map((channel) =>
        channel.id === selectedChannel.id ? { ...channel, defaultProviderPresetId: provider.id } : channel
      )
    );
    setChannelEditForm((current) =>
      selectedChannelId === selectedChannel.id ? { ...current, defaultProviderPresetId: provider.id } : current
    );
    try {
      await updateChannel(workspaceCwd, selectedChannel.id, nextChannelForm);
      await refreshChannels(workspaceCwd);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      await refreshChannels(workspaceCwd);
    }
  }

  async function clearProviderFromRun(): Promise<void> {
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    setForm((current) => ({
      ...current,
      providerPresetId: "",
    }));
    setTaskRunProviderId("");
    if (!selectedChannel?.defaultProviderPresetId || !form.cwd.trim()) {
      return;
    }

    const clearedChannelForm = {
      ...channelToForm(selectedChannel, form.cwd),
      defaultProviderPresetId: "",
    };
    setChannels((current) =>
      current.map((channel) =>
        channel.id === selectedChannel.id ? { ...channel, defaultProviderPresetId: undefined } : channel
      )
    );
    setChannelEditForm((current) =>
      selectedChannelId === selectedChannel.id ? { ...current, defaultProviderPresetId: "" } : current
    );
    try {
      await updateChannel(form.cwd.trim(), selectedChannel.id, clearedChannelForm);
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      await refreshChannels();
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

  function openTaskFromWorkBoard(taskId: string): void {
    const task = tasks.find((item) => item.id === taskId);
    if (task?.channelId) {
      setSelectedChannelId(task.channelId);
      setActiveSidebarTarget(channelSidebarTarget(task.channelId));
    }
    setSelectedTaskId(taskId);
    setActiveView("workspace");
  }

  function openApprovalsFromWorkspace(runId?: string): void {
    const targetRunId = runId || activeRunId || "";
    setApprovalRepairRunId(targetRunId);
    if (targetRunId) {
      void loadRun(targetRunId, form.cwd.trim());
    }
    void refreshApprovals(form.cwd.trim(), targetRunId || undefined);
    setActiveView("approvals");
    setActiveSidebarTarget("approvals");
  }

  function openProvidersFromRun(runToRepair?: RunSession): void {
    void handleDomainEvent({
      type: "provider.repairRequested",
      providerPresetId: runToRepair ? readRunProviderPresetId(runToRepair) : undefined,
      sourceRunId: runToRepair?.id,
    });
  }

  async function openTaskFromRun(runToRepair: RunSession): Promise<void> {
    if (!runToRepair.channelId || !runToRepair.taskId) {
      setErrorMessage("This run is not linked to an editable channel task.");
      return;
    }

    setErrorMessage("");
    setTaskRepairRunId(runToRepair.id);
    setSelectedChannelId(runToRepair.channelId);
    setSelectedTaskId(runToRepair.taskId);
    setTaskRunProviderId("");
    setActiveView("workspace");
    setActiveSidebarTarget(channelSidebarTarget(runToRepair.channelId));
    await refreshTasks(runToRepair.channelId);
    setSelectedTaskId(runToRepair.taskId);
  }

  const showInspector = !["workspace", "providers", "teammates", "runs", "threads", "automations", "approvals", "work_board", "media", "settings"].includes(activeView);
  const selectedChannelForRun = channels.find((channel) => channel.id === selectedChannelId);
  const selectedProviderIdForRun =
    taskRunProviderId || form.providerPresetId || selectedChannelForRun?.defaultProviderPresetId || "";
  const navigationActiveSidebarTarget =
    activeView === "workspace" && selectedChannelId ? channelSidebarTarget(selectedChannelId) : activeSidebarTarget;
  const shellClassName = [
    "app-shell",
    "channel-drawer-shell",
    activeView === "workspace" ? "channel-daylight-shell" : "",
    !channelSidebarOpen ? "channel-sidebar-collapsed" : "",
    showInspector && inspectorCollapsed ? "inspector-collapsed" : "",
    showInspector ? "" : "inspector-hidden",
  ].filter(Boolean).join(" ");

  return (
    <main className={shellClassName}>
      <SidebarNavigation
        activeSidebarTarget={navigationActiveSidebarTarget}
        channels={channels}
        teammates={aiTeammates}
        approvals={approvals}
        channelNotifications={sidebarChannelNotifications}
        teammateNotifications={sidebarTeammateNotifications}
        onOpenView={openPlainView}
        onCreateChannel={openChannelCreatePanel}
        onSelectChannel={selectWorkspaceChannel}
        onSelectTeammate={selectAiTeammate}
        channelDrawer
        channelDrawerOpen={channelSidebarOpen}
        onChannelDrawerOpenChange={setChannelSidebarOpen}
      />
      <section
        className={
          activeView === "workspace"
            ? "workspace workspace-client-surface"
            : activeView === "teammates" && selectedAiTeammate
              ? "workspace workspace-teammate-private-surface"
            : activeView === "teammates" && !selectedAiTeammate
              ? "workspace workspace-teammates-surface"
              : activeView === "providers"
                ? "workspace workspace-provider-surface"
              : "workspace"
        }
      >
        <LazyPageErrorBoundary
          resetKey={`${activeView}:${selectedAiTeammate?.id ?? ""}`}
          title={t("Page failed to load")}
          retryLabel={t("Reload")}
        >
          <Suspense fallback={<div className="client-empty-state"><span>{t("Loading")}</span></div>}>
            {activeView === "workspace" ? (
              <WorkspaceClientView
            cwd={form.cwd}
            daemonHealthy={daemonHealthy}
            providerLabel={`${form.provider}/${form.model}`}
            channels={channels}
            selectedChannelId={selectedChannelId}
            channelForm={channelForm}
            channelCreateOpen={channelCreateOpen}
            channelEditForm={channelEditForm}
            tasks={tasks}
            taskForm={taskForm}
            channelMessages={channelMessages}
            memoryById={memoryById}
            usedMemoryEvents={usedMemoryEvents}
            channelExecutionProposals={channelExecutionProposals}
            channelAttachments={channelAttachments}
            channelLinkPreviews={channelLinkPreviews}
            channelArtifactsByRun={channelArtifactsByRun}
            channelArtifactErrorsByRun={channelArtifactErrorsByRun}
            channelBrief={channelBrief}
            channelDecisions={channelDecisions}
            channelMessageRouteDecisions={channelMessageRouteDecisions}
            channelHandoffs={channelHandoffs}
            channelContextSummaries={channelContextSummaries}
            channelWorkflows={channelWorkflows}
            channelWorkflowSteps={channelWorkflowSteps}
            channelStateTransitions={channelStateTransitions}
            channelActivityTransitionsLoading={channelActivityTransitionsLoading}
            channelActivityTransitionError={channelActivityTransitionError}
            externalWorkCiTriage={externalWorkCiTriage}
            externalWorkCiTriageLoading={externalWorkCiTriageLoading}
            durableWorkItems={durableWorkItems}
            durableWorkItemsLoading={durableWorkItemsLoading}
            selectedTaskId={selectedTaskId}
            providers={providers}
            teammateTemplates={aiTeammates.length > 0 ? [] : builtinTeammateTemplates}
            localTeammates={localTeammates}
            channelTeammateMemberships={selectedChannelTeammateMemberships}
            channelTeammateMembershipsLoading={teammateChannelMembershipsLoading}
            channelTeammateSavingId={channelTeammateSavingId}
            taskRunProviderId={taskRunProviderId}
            fallbackProviderId={form.providerPresetId}
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
            isCancellingRun={Boolean(cancellingRunId)}
            approvalPolicy={approvalPolicy}
            permissionMode={form.permissionMode}
            permissionPreset={form.permissionPreset}
            activeTaskRunAction={activeTaskRunAction}
            runningWorkflowStepId={runningWorkflowStepId}
            orchestratingWorkflowId={orchestratingWorkflowId}
            errorMessage={errorMessage}
            onChannelFormChange={setChannelForm}
            onChannelCreateOpenChange={setChannelCreateOpen}
            onChannelEditFormChange={setChannelEditForm}
            onTaskFormChange={setTaskForm}
            onProviderSelect={(providerId) => {
              setTaskRunProviderId(providerId);
              const provider = providers.find((item) => item.id === providerId);
              if (provider) {
                void applyProviderToRun(provider);
              }
            }}
            onAddChannelTeammate={(teammateId) => addChannelTeammate(selectedChannelId, teammateId)}
            onRemoveChannelTeammate={(teammateId) => removeChannelTeammate(selectedChannelId, teammateId)}
            onSetDefaultChannelTeammate={(teammateId) => setDefaultChannelTeammate(selectedChannelId, teammateId)}
            onOpenTeammates={() => openPlainView("teammates")}
            onRefreshChannels={() => void refreshChannels()}
            onCreateChannel={() => void saveChannel()}
            onSaveChannel={() => selectedChannelId ? void saveChannelEdit(selectedChannelId) : undefined}
            onCreateTask={() => void saveTask()}
            onSendMessage={sendChannelMessage}
            onConfirmExecutionProposal={(proposal) => void confirmChannelExecutionProposal(proposal)}
            onCancelExecutionProposal={(proposal) => void cancelChannelExecutionProposal(proposal)}
            onUploadAttachments={(files) => uploadChannelFiles(files)}
            onCreateLinkPreview={(url) => addChannelLinkPreview(url)}
            onDeleteAttachment={(attachmentId) => void removeChannelAttachment(attachmentId)}
            onSaveBrief={(input) => void saveChannelBrief(input)}
            onSupersedeDecision={(decision) => void supersedeChannelDecision(decision)}
            onRejectDecision={(decision) => void rejectChannelDecision(decision)}
            onCreateHandoffFromTask={createHandoffFromTask}
            onUpdateHandoffStatus={(handoff, status) => void updateHandoffStatusValue(handoff, status)}
            onStartWorkflowFromHandoff={(handoff) => void startWorkflowFromHandoff(handoff)}
            onStartTemplateWorkflow={() => void startAutoplanWorkflow()}
            onOrchestrateWorkflow={(workflow) => void orchestrateWorkflowAction(workflow)}
            onCancelWorkflow={(workflow) => void cancelWorkflowAction(workflow)}
            onStartWorkflowStep={(step, mode) => void startWorkflowStepAction(step, mode)}
            onRetryWorkflowStep={(step) => void retryWorkflowStepAction(step)}
            onUpdateWorkflowStepStatus={(step, status) => void updateWorkflowStepStatus(step, status)}
            onCreateTaskFromContextSummary={(summary) => void createTaskFromContextSummary(summary)}
            onRunActivityTriageAction={runActivityTriageAction}
            onLoadOlderChannelMessages={loadOlderChannelMessages}
            onRefreshChannelMessages={() => void Promise.all([
              refreshChannelMessages(),
              refreshChannelMessageRouteDecisions(),
              refreshChannelExecutionProposals(),
              refreshUsedMemoryAudit(form.cwd.trim()),
            ])}
            onRefreshChannelActivity={() => void refreshChannelActivity()}
            onRefreshExternalWorkCiTriage={() => void refreshExternalWorkCiTriage()}
            onRefreshWorkItems={() => void refreshWorkItems()}
            onRefreshChannelProtocol={() => void refreshChannelProtocol()}
            onRefreshChannelFiles={() => void Promise.all([refreshChannelFiles(), refreshChannelRunArtifacts()])}
            attachmentContentUrl={(attachment) => channelAttachmentContentUrl(attachment, form.cwd.trim())}
            onRefreshTasks={() => void refreshTasks()}
            onSelectTask={setSelectedTaskId}
            onCheckThenRunTask={(task) => void checkThenRunPersistedTask(task)}
            onRunTask={(task) => void runPersistedTask(task)}
            onPermissionModeChange={(permissionMode) => setForm((current) => ({ ...current, permissionMode, permissionPreset: inferPermissionPreset(permissionMode) }))}
            onCancelActiveRun={(targetRun) => void cancelRunOrWorkUnit(targetRun)}
            onOpenRun={(runId) => void openRunFromWorkspace(runId)}
            onOpenApprovals={(runId) => openApprovalsFromWorkspace(runId)}
            onRefreshRunApprovals={() => void refreshApprovals(form.cwd.trim(), activeRunId || undefined)}
            onRefreshRuntime={() => void refreshRuntimeState()}
            onCancelWorkUnit={(workUnitId) => void runWorkUnitAction(workUnitId, "cancel")}
            onRetryWorkUnit={(workUnitId) => void runWorkUnitAction(workUnitId, "retry")}
            onReconcileWorkUnit={(workUnitId) => void runWorkUnitAction(workUnitId, "reconcile")}
            onResolveApproval={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
            onClaimWorkItem={(workItemId) => void claimDurableWorkItem(workItemId)}
            onHeartbeatWorkItem={(workItemId, claimToken) => void heartbeatDurableWorkItem(workItemId, claimToken)}
            busyWorkItemId={busyWorkItemId}
            onOpenProviders={(sourceRun) => sourceRun ? openProvidersFromRun(sourceRun) : openPlainView("providers")}
              />
            ) : (
              <>
                {activeView === "providers" || (activeView === "teammates" && selectedAiTeammate) ? null : (
                  <div className="workspace-head">
                    <div>
                      <h1>{selectedAiTeammate ? selectedAiTeammate.displayName : t(viewTitle(activeView))}</h1>
                      <p>{selectedAiTeammate ? selectedAiTeammate.description : t(viewDescription(activeView))}</p>
                    </div>
                    {activeView === "teammates" ? (
                      <span className="status-badge succeeded">{selectedAiTeammate ? selectedAiTeammate.status : aiTeammatesLoading ? t("Loading") : GSTACK_DEFAULT_SKILL_PACK_ID}</span>
                    ) : activeView === "automations" || activeView === "settings" ? null : (
                      <StatusBadge status={latestStatus} />
                    )}
                  </div>
                )}
                {activeView === "teammates" && selectedAiTeammate ? (
                  <TeammateWorkspace
                cwd={form.cwd}
                teammate={selectedAiTeammate}
                providers={providers}
                channels={channels}
                skillPack={builtinSkillPack}
                onUpdateTeammate={updateAiTeammateSettings}
                onDisableTeammate={removeAiTeammate}
                onHardDeleteTeammate={hardDeleteAiTeammateAndRefresh}
                onOpenProviders={() => openPlainView("providers")}
                onRefreshTeammates={() => refreshAiTeammates(form.cwd.trim())}
                onRefreshChannels={() => refreshChannels()}
                onRefreshTasks={(channelId) => refreshTasks(channelId)}
                  />
                ) : activeView === "teammates" ? (
                  <AiTeammatesPage
                skillPack={builtinSkillPack}
                providers={providers}
                channels={channels}
                localTeammates={localTeammates}
                onCreateTeammate={(input) => void addAiTeammate(input)}
                onRemoveTeammate={(teammateId) => void removeAiTeammate(teammateId)}
                onToggleTeammatePinned={(teammateId) => void toggleAiTeammatePinned(teammateId)}
                onToggleTeammateHidden={(teammateId) => void toggleAiTeammateHidden(teammateId)}
                onOpenProviders={() => openPlainView("providers")}
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
                approvalsLoading={approvalsLoading}
                resolvingApprovals={resolvingApprovals}
                isLoading={runsLoading}
                isRunning={isRunning}
                cancellingRunId={cancellingRunId}
                errorMessage={errorMessage}
                onRefresh={() => void refreshRuns()}
                onRefreshSelected={() => void loadRun(activeRunId || lookupRunId)}
                onRefreshApprovals={() => void refreshApprovals(form.cwd.trim(), activeRunId || undefined)}
                onRerun={(sourceRun) => void rerunRun(sourceRun)}
                onCancelRun={(sourceRun) => void cancelRunOrWorkUnit(sourceRun)}
                onResolveApproval={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
                onOpenProviders={(sourceRun) => openProvidersFromRun(sourceRun)}
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
                automations={automations}
                automationRuns={automationRuns}
                automationDrafts={automationDrafts}
                templates={automationTemplates}
                selectedAutomationId={selectedAutomationId}
                selectedDraftId={selectedDraftId}
                previewByAutomationId={previewByAutomationId}
                draftPreviewById={draftPreviewById}
                isLoading={automationsLoading}
                mutatingAutomationId={mutatingAutomationId}
                mutatingDraftId={mutatingDraftId}
                schedulers={automationSchedulers}
                schedulerAction={automationSchedulerAction}
                onRefresh={() => void refreshAutomations()}
                onStartScheduler={() => void startAutomationSchedulerAction()}
                onStopScheduler={() => void stopAutomationSchedulerAction()}
                onCreateFromTemplate={createAutomationFromTemplate}
                onCreateManualDraft={createManualDraft}
                onCreateChatDraft={createChatDraft}
                onSelectAutomation={setSelectedAutomationId}
                onSelectDraft={setSelectedDraftId}
                onUpdateDraft={updateDraft}
                onPreviewDraft={previewDraft}
                onConfirmDraft={confirmDraft}
                onDiscardDraft={discardDraft}
                onPreview={() => void previewSelectedAutomation()}
                onRun={() => void runSelectedAutomation()}
                onArchive={() => void archiveSelectedAutomation()}
                onSetStatus={(status) => void setSelectedStatus(status)}
                onSetSchedule={(trigger) => void setSelectedSchedule(trigger)}
                onOpenRun={(runId) => void openRunFromWorkspace(runId)}
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
                errorMessage={errorMessage}
                checkResult={providerCheck}
                checkedProviderId={providerCheckTargetId}
                checkScope={providerCheckScope}
                batchResult={providerBatchResult}
                successMessage={providerSaveMessage}
                successMessageTone={providerSaveMessageTone}
                selectedProviderId={selectedProviderIdForRun}
                selectedTemplateId={selectedProviderTemplateId}
                repairRun={providerRepairRun}
                isRunning={isRunning}
                onFormChange={setProviderForm}
                onTemplateSelect={selectProviderTemplate}
                onNew={() => {
                  const customTemplate = providerFormToTemplate(customOpenAICompatibleForm);
                  startNewProviderFromTemplate(customTemplate);
                }}
                onSave={saveProviderWithPreflight}
                onRefresh={() => void refreshProviders()}
                onEdit={editProvider}
                onDelete={(providerId) => void removeProvider(providerId)}
                onCheck={(providerId) => void runProviderCheck(providerId)}
                onCheckBatch={() => void runProviderBatchCheck()}
                onUse={applyProviderToRun}
                onStopUse={clearProviderFromRun}
                onToggleEnabled={(provider, enabled) => void toggleProviderEnabled(provider, enabled)}
                onRerun={(sourceRun) => void rerunRun(sourceRun)}
                onOpenRun={(runId) => void openRunFromWorkspace(runId)}
                onClearCheckFeedback={clearProviderCheckFeedback}
                onClearRepair={() => setProviderRepairRunId("")}
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
                    onRefresh={() => {
                      void Promise.all([
                        refreshTasks(),
                        refreshRuns(),
                        refreshApprovals(),
                        refreshExternalWorkCiTriage(),
                        refreshWorkItems(),
                      ]);
                    }}
                    onOpenTask={openTaskFromWorkBoard}
                    onOpenRun={(runId) => void openRunFromWorkspace(runId)}
                    onOpenApproval={(approvalId) => {
                      setSelectedApprovalId(approvalId);
                      openPlainView("approvals");
                    }}
                    onOpenChannel={selectWorkspaceChannel}
                    onRouteExternalWork={(externalWorkId, channelId) => void routeExternalWorkToChannel(externalWorkId, channelId)}
                    onClaimWorkItem={(workItemId) => void claimDurableWorkItem(workItemId)}
                    onHeartbeatWorkItem={(workItemId, claimToken) => void heartbeatDurableWorkItem(workItemId, claimToken)}
                    routingExternalWorkId={routingExternalWorkId}
                    busyWorkItemId={busyWorkItemId}
                  />
                ) : activeView === "media" ? (
                  <MediaJobsPage
                cwd={form.cwd}
                providers={providers}
                jobs={mediaJobs}
                artifactsByJob={mediaJobArtifacts}
                form={mediaJobForm}
                selectedJobId={selectedMediaJobId}
                isLoading={mediaJobsLoading}
                runningJobId={runningMediaJobId}
                errorMessage={errorMessage}
                onFormChange={setMediaJobForm}
                onRefresh={() => void refreshMediaJobs()}
                onCreate={() => void saveMediaJob()}
                onSelectJob={setSelectedMediaJobId}
                onRun={(jobId) => void executeMediaJob(jobId)}
                onOpenProviders={() => openPlainView("providers")}
                  />
                ) : activeView === "settings" ? (
                  <SettingsPage
                    cwd={form.cwd}
                    policy={approvalPolicy}
                    form={approvalPolicyForm}
                    runners={runners}
                    runtimeSettings={runtimeSettings}
                    runtimeSettingsForm={runtimeSettingsForm}
                    skillLibraryRefreshToken={skillLibraryRefreshToken}
                    selectedChannel={channels.find((channel) => channel.id === selectedChannelId)}
                    externalWorkStatus={externalWorkStatus}
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
                    permissionMode={form.permissionMode}
                    permissionPreset={form.permissionPreset}
                    isLoading={approvalPolicyLoading}
                    runtimeSettingsLoading={runtimeSettingsLoading}
                    runtimeSettingsAction={runtimeSettingsAction}
                    runtimeSettingsError={runtimeSettingsError}
                    externalWorkStatusLoading={externalWorkStatusLoading}
                    externalWorkStatusAction={externalWorkStatusAction}
                    externalWorkSecretAction={externalWorkSecretAction}
                    externalWorkWorkflowAction={externalWorkWorkflowAction}
                    errorMessage={errorMessage}
                    onFormChange={setApprovalPolicyForm}
                    onPermissionModeChange={(permissionMode) => setForm((current) => ({ ...current, permissionMode, permissionPreset: inferPermissionPreset(permissionMode) }))}
                    onRefresh={() => void refreshApprovalPolicy()}
                    onSave={() => void saveApprovalPolicy()}
                    onRuntimeSettingsFormChange={setRuntimeSettingsForm}
                    onToggleAllowedRunner={toggleAllowedRunner}
                    onRefreshRuntimeSettings={() => void refreshRuntimeSettings()}
                    onSaveRuntimeSettings={() => void saveRuntimeSettings()}
                    onRefreshExternalWork={() => void refreshExternalWorkStatus()}
                    onRefreshPlugins={() => void refreshPlugins()}
                    onApplyPluginPreset={(pluginId) => void applyPluginPreset(pluginId)}
                    onCheckPlugin={(pluginId) => void checkPlugin(pluginId)}
                    onValidatePluginPackage={(pluginId) => void validatePackage(pluginId)}
                    onInstallPlugin={(pluginId) => void installPlugin(pluginId)}
                    onUninstallPlugin={(pluginId) => void uninstallPlugin(pluginId)}
                    onRefreshPluginPackage={(pluginId) => void refreshPluginPackage(pluginId)}
                    onPreviewPluginRuntime={(pluginId) => void previewPluginRuntime(pluginId)}
                    onEnablePlugin={(pluginId) => void enablePlugin(pluginId)}
                    onDisablePlugin={(pluginId) => void disablePlugin(pluginId)}
                    onExternalWorkAction={(action) => void runExternalWorkStatusAction(action)}
                    onConfigureExternalWorkWorkflow={(input) => configureExternalWorkWorkflowAction(input)}
                    onConfigureExternalWorkSecret={(token) => configureExternalWorkSecretAction(token)}
                    onDeleteExternalWorkSecret={() => deleteExternalWorkSecretAction()}
                    onOpenRunDiagnostics={() => {
                      openRunDiagnosticsView();
                    }}
                    onRefreshMcp={() => void refreshMcp()}
                    onCreateMcpServer={addMcpServer}
                    onUpdateMcpServer={saveMcpServer}
                    onDeleteMcpServer={(serverId) => void removeMcpServer(serverId)}
                    onCheckMcpServer={runMcpServerCheck}
                    onSyncMcpTools={syncMcpTools}
                    onOpenExternalWorkRecords={() => {
                      if (selectedChannelId) {
                        setActiveView("workspace");
                        setActiveSidebarTarget(channelSidebarTarget(selectedChannelId));
                      }
                    }}
                    onOpenExternalWorkTriage={() => {
                      if (selectedChannelId) {
                        setActiveView("workspace");
                        setActiveSidebarTarget(channelSidebarTarget(selectedChannelId));
                      }
                    }}
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
                errorMessage={errorMessage}
                onRefresh={() => void refreshApprovals()}
                onSelectApproval={setSelectedApprovalId}
                onRefreshRepair={(runId) => {
                  void refreshApprovals(form.cwd.trim(), runId);
                  void loadRun(runId, form.cwd.trim());
                }}
                onResolve={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
                onExecuteExternalAction={(actionId) => void executeExternalAction(actionId)}
                onCancelExternalAction={(actionId) => void cancelExternalAction(actionId, "Cancelled from Web Inbox")}
                onOpenRun={(runId) => void openRunFromWorkspace(runId)}
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
              assistantText={assistantText}
              errorMessage={errorMessage}
              isRunning={isRunning}
              pendingApprovals={activePendingApprovals}
              approvalsLoading={approvalsLoading}
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
              onLoadRun={() => void loadRun()}
              onRefreshApprovals={() => void refreshApprovals(form.cwd.trim(), activeRunId || undefined)}
              onResolveApproval={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
              onExecuteExternalAction={(actionId) => void executeExternalAction(actionId)}
              onCancelExternalAction={(actionId) => void cancelExternalAction(actionId, "Cancelled from Web Inspector")}
            />
          ) : null}
        </aside>
      ) : null}
      {fullAccessConfirmOpen ? (
        <div className="provider-sheet-backdrop" role="presentation">
          <section className="provider-form-panel provider-sheet session-permission-confirm-sheet" role="dialog" aria-modal="true" aria-label={t("Confirm full access")}>
            <header className="provider-sheet-header panel-title split">
              <span>
                <ShieldCheck size={18} />
                <h2>{t("Confirm full access")}</h2>
              </span>
              <button className="secondary-button compact-button" type="button" onClick={() => resolveFullAccessConfirmation(false)}>
                {t("Cancel")}
              </button>
            </header>
            <div className="provider-sheet-body session-permission-confirm-body">
              <p>{t("Full access can read and write outside the workspace and use network or tool actions allowed by this session.")}</p>
              <p>{t("Use it only for trusted workspaces. Denied tools in workspace policy still stay blocked.")}</p>
            </div>
            <footer className="provider-sheet-footer">
              <div className="action-row">
                <button className="secondary-button" type="button" onClick={() => resolveFullAccessConfirmation(false)}>
                  {t("Cancel")}
                </button>
                <button className="primary-button danger" type="button" onClick={() => resolveFullAccessConfirmation(true)}>
                  {t("Start with full access")}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function aiTeammateToLocalDraft(teammate: AiTeammate, providers: readonly ProviderPreset[]): LocalTeammateDraft {
  const provider = teammate.providerPresetId ? providers.find((item) => item.id === teammate.providerPresetId) : undefined;
  return {
    id: teammate.id,
    templateId: teammate.templateId,
    displayName: teammate.displayName,
    description: teammate.description,
    providerPresetId: teammate.providerPresetId,
    modelLabel: provider ? `${provider.displayName} / ${provider.model}` : "No model selected",
    channelIds: [],
    memorySources: [],
    pinned: teammate.pinned,
    hidden: teammate.hidden,
    disabled: teammate.status === "disabled",
    createdAt: teammate.createdAt,
  };
}

function buildSidebarChannelNotifications(
  approvals: readonly ApprovalRequest[],
  runs: readonly RunSession[],
  tasks: readonly Task[],
  selectedChannelId: string,
  channelUnreadById: Readonly<Record<string, boolean>>,
): Readonly<Record<string, SidebarNotification>> {
  const runById = new Map(runs.map((item) => [item.id, item]));
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  const unread = new Set<string>();

  for (const approval of approvals) {
    if (effectiveApprovalStatus(approval) !== "pending") {
      continue;
    }
    const channelId = approval.channelId
      ?? (approval.runId ? runById.get(approval.runId)?.channelId : undefined)
      ?? (approval.taskId ? taskById.get(approval.taskId)?.channelId : undefined);
    if (channelId && channelId !== selectedChannelId) {
      unread.add(channelId);
    }
  }

  for (const [channelId, hasUnread] of Object.entries(channelUnreadById)) {
    if (hasUnread && channelId !== selectedChannelId) {
      unread.add(channelId);
    }
  }

  return Object.fromEntries([...unread].map((channelId) => [channelId, { unread: true }]));
}

function latestChannelMessageTimestamp(messages: readonly ChannelMessage[]): string {
  return messages.reduce((latest, message) => message.updatedAt > latest ? message.updatedAt : latest, "");
}

function buildSidebarTeammateNotifications(
  approvals: readonly ApprovalRequest[],
  tasks: readonly Task[],
): Readonly<Record<string, SidebarNotification>> {
  const taskById = new Map(tasks.map((item) => [item.id, item]));
  const counts = new Map<string, number>();

  for (const approval of approvals) {
    if (effectiveApprovalStatus(approval) !== "pending" || !approval.taskId) {
      continue;
    }
    const assigneeTeammateId = taskById.get(approval.taskId)?.assigneeTeammateId;
    if (assigneeTeammateId) {
      counts.set(assigneeTeammateId, (counts.get(assigneeTeammateId) ?? 0) + 1);
    }
  }

  return Object.fromEntries([...counts.entries()].map(([teammateId, count]) => [teammateId, { count }]));
}

function mergeWorkflowSteps(
  current: readonly ChannelWorkflowStep[],
  next: readonly ChannelWorkflowStep[],
): readonly ChannelWorkflowStep[] {
  const byId = new Map(current.map((step) => [step.id, step]));
  for (const step of next) {
    byId.set(step.id, step);
  }
  return [...byId.values()].sort((left, right) => {
    const workflowOrder = right.updatedAt.localeCompare(left.updatedAt);
    return workflowOrder !== 0 ? workflowOrder : left.position - right.position;
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

interface ChannelTransitionEntity {
  readonly entityType: StateEntityType;
  readonly entityId: string;
  readonly updatedAt: string;
}

function buildChannelTransitionEntities(
  channelId: string,
  tasks: readonly Task[],
  runs: readonly RunSession[],
  workflows: readonly ChannelWorkflow[],
  workflowSteps: readonly ChannelWorkflowStep[],
): readonly ChannelTransitionEntity[] {
  if (!channelId) {
    return [];
  }

  const channelTasks = deriveChannelTasks(channelId, tasks);
  const channelTaskIds = new Set(channelTasks.map((task) => task.id));
  const items: ChannelTransitionEntity[] = [
    ...channelTasks.map((task) => ({ entityType: "task" as const, entityId: task.id, updatedAt: task.updatedAt })),
    ...runs
      .filter((run) => run.channelId === channelId || channelTaskIds.has(run.taskId))
      .map((run) => ({ entityType: "run" as const, entityId: run.id, updatedAt: run.updatedAt })),
    ...workflows
      .filter((workflow) => workflow.channelId === channelId)
      .map((workflow) => ({ entityType: "workflow" as const, entityId: workflow.id, updatedAt: workflow.updatedAt })),
    ...workflowSteps
      .filter((step) => step.channelId === channelId)
      .map((step) => ({ entityType: "workflow_step" as const, entityId: step.id, updatedAt: step.updatedAt })),
  ];

  const deduped = new Map<string, ChannelTransitionEntity>();
  for (const item of items) {
    deduped.set(`${item.entityType}:${item.entityId}`, item);
  }

  return [...deduped.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20);
}
