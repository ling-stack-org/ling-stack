import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  Activity,
  Bell,
  BellOff,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Command,
  Database,
  FileCheck2,
  FileText,
  Hash,
  History,
  Image as ImageIcon,
  Info,
  Link2,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  UserPlus,
  Workflow,
  X,
} from "lucide-react";
import type { AiTeammateTemplate } from "@ling-stack/core";
import { useI18n } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { buildChannelActivityItems, type ChannelActivityAttention } from "../../lib/channel-activity.js";
import {
  buildChannelActivityDrilldownItem,
  type ChannelActivityDrilldownItem,
  type ChannelActivityDrilldownTarget,
} from "../../lib/channel-activity-drilldown.js";
import {
  buildChannelActivityTriageActions,
  buildChannelActivityTriageDraft,
  channelActivityTriageDraftIsValid,
  channelActivityTriageResultLabel,
  type ChannelActivityTriageAction,
  type ChannelActivityTriageActionKind,
  type ChannelActivityTriageDraft,
  type ChannelActivityTriageResult,
} from "../../lib/channel-activity-triage.js";
import {
  allChannelActivitySavedViewId,
  applyActivityViewFilter,
  buildAttentionQueueItems,
  builtinChannelActivitySavedViews,
  createCustomChannelActivitySavedView,
  maxCustomChannelActivitySavedViews,
  readCustomChannelActivitySavedViews,
  sanitizeSavedViewName,
  writeCustomChannelActivitySavedViews,
  type ChannelActivitySavedView,
  type ChannelActivityViewAttentionFilter,
  type ChannelActivityViewCategoryFilter,
  type ChannelActivityViewFilter,
  type ChannelAttentionQueueItem,
  type ChannelAttentionQueueTarget,
} from "../../lib/channel-activity-views.js";
import { deriveChannelRuns } from "../../lib/channel-artifacts.js";
import { formatDateTime } from "../../lib/formatting.js";
import { buildRunRepairHint, displayLinkedRunStatus, readRunWorkspaceCwd } from "../../lib/run-evidence.js";
import { defaultTools, riskyTools } from "../../lib/tools.js";
import {
  canUseProviderForRun,
  isMediaProvider,
  providerPreflightReady,
  providerRunPreflightBlocker,
} from "../../lib/providers.js";
import { ArtifactRow, AvatarInitial, MetaRow, RunRepairHintBanner, StatusBadge } from "../../shared/components/index.js";
import type {
  ApprovalRequest,
  Channel,
  ChannelAttachment,
  ChannelBrief,
  ChannelContextSummary,
  ChannelDecision,
  ChannelFormState,
  ChannelHandoff,
  ChannelHandoffStatus,
  ChannelLinkPreview,
  ChannelMention,
  ChannelMessage,
  ChannelExecutionProposal,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelWorkflowStepStartMode,
  ExternalWorkCiTriageView,
  ProviderPreset,
  ResourceLease,
  RunArtifact,
  RunSession,
  StateTransitionEvent,
  Task,
  TaskFormState,
  TaskRunActionState,
  TeammateChannelMembership,
  UpdateChannelBriefRequest,
} from "../../types.js";
import { CiTriageAuditPanel } from "../external-work/CiTriageAuditPanel.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { ChannelRuntimePolicyFields, ProviderPresetOptions } from "./WorkspaceControls.js";

type TaskFilter = "all" | "queued" | "running" | "review" | "done";
type ChannelTab = "activity" | "tasks" | "files" | "protocol";
type ActivityCategoryFilter = ChannelActivityViewCategoryFilter;
type ActivityAttentionFilter = ChannelActivityViewAttentionFilter;
type ComposerSendState = "idle" | "sending" | "failed";
type AiReplyState = "idle" | "replying" | "failed";
type PendingAssetState = "uploading" | "ready" | "blocked" | "failed";
type MessageBubbleTone = "chat" | "chat-blocked" | "system" | "work" | "approval" | "protocol" | "runtime";
type ChannelNotificationLevel = "all" | "mentions" | "muted";

interface PendingAttachmentItem {
  readonly localId: string;
  readonly fileName: string;
  readonly state: PendingAssetState;
  readonly attachment?: ChannelAttachment;
  readonly error?: string;
}

interface PendingLinkPreviewItem {
  readonly localId: string;
  readonly url: string;
  readonly state: PendingAssetState;
  readonly preview?: ChannelLinkPreview;
  readonly error?: string;
}

interface ActiveMentionPicker {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

const taskFilters: readonly TaskFilter[] = ["all", "queued", "running", "review", "done"];
const channelPrimaryTabs: readonly ChannelTab[] = ["activity", "files"];
const channelUtilityTabs: readonly ChannelTab[] = ["tasks", "protocol"];
const activityCategoryFilters: readonly ActivityCategoryFilter[] = ["all", "message", "work", "approval", "protocol", "runtime"];
const activityAttentionFilters: readonly Exclude<ActivityAttentionFilter, "all">[] = ["needs_attention", "blocked", "failed", "pending"];
const channelNotificationLevels: readonly ChannelNotificationLevel[] = ["all", "mentions", "muted"];

function channelTabLabel(tab: ChannelTab): string {
  if (tab === "activity") {
    return "Chat";
  }
  if (tab === "tasks") {
    return "Tasks";
  }
  if (tab === "files") {
    return "Files";
  }
  return "Context";
}

function channelTabIcon(tab: ChannelTab, size: number): JSX.Element {
  if (tab === "activity") {
    return <MessageSquare size={size} />;
  }
  if (tab === "tasks") {
    return <SquareTerminal size={size} />;
  }
  if (tab === "files") {
    return <FileText size={size} />;
  }
  return <Workflow size={size} />;
}

export function WorkspaceClientView({
  cwd,
  daemonHealthy,
  providerLabel,
  channels,
  selectedChannelId,
  channelForm,
  tasks,
  taskForm,
  channelMessages,
  channelExecutionProposals,
  channelAttachments,
  channelLinkPreviews,
  channelArtifactsByRun,
  channelArtifactErrorsByRun,
  channelBrief,
  channelDecisions,
  channelHandoffs,
  channelContextSummaries,
  channelWorkflows,
  channelWorkflowSteps,
  channelStateTransitions,
  channelActivityTransitionsLoading,
  channelActivityTransitionError,
  externalWorkCiTriage,
  externalWorkCiTriageLoading,
  selectedTaskId,
  providers,
  teammateTemplates,
  localTeammates,
  channelTeammateMemberships,
  channelTeammateMembershipsLoading,
  channelTeammateSavingId,
  taskRunProviderId,
  fallbackProviderId,
  channelsLoading,
  tasksLoading,
  channelMessagesLoading,
  channelFilesLoading,
  channelRunArtifactsLoading,
  channelProtocolLoading,
  providersLoading,
  approvals,
  resourceLeases,
  runs,
  runById,
  activeRunId,
  latestStatus,
  isRunning,
  activeTaskRunAction,
  runningWorkflowStepId,
  errorMessage,
  onChannelFormChange,
  onTaskFormChange,
  onProviderSelect,
  onAddChannelTeammate,
  onRemoveChannelTeammate,
  onSetDefaultChannelTeammate,
  onOpenTeammates,
  onRefreshChannels,
  onCreateDefaultChannel,
  onCreateChannel,
  onCreateTask,
  onSendMessage,
  onConfirmExecutionProposal,
  onCancelExecutionProposal,
  onUploadAttachments,
  onCreateLinkPreview,
  onDeleteAttachment,
  onSaveBrief,
  onSupersedeDecision,
  onRejectDecision,
  onCreateHandoffFromTask,
  onUpdateHandoffStatus,
  onStartWorkflowFromHandoff,
  onStartWorkflowStep,
  onUpdateWorkflowStepStatus,
  onCreateTaskFromContextSummary,
  onRunActivityTriageAction,
  onRefreshChannelActivity,
  onRefreshExternalWorkCiTriage,
  onRefreshChannelProtocol,
  onRefreshChannelFiles,
  attachmentContentUrl,
  onRefreshTasks,
  onSelectTask,
  onCheckThenRunTask,
  onRunTask,
  onOpenRun,
  onOpenApprovals,
  onOpenProviders,
}: {
  readonly cwd: string;
  readonly daemonHealthy: boolean | undefined;
  readonly providerLabel: string;
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly channelForm: ChannelFormState;
  readonly tasks: readonly Task[];
  readonly taskForm: TaskFormState;
  readonly channelMessages: readonly ChannelMessage[];
  readonly channelExecutionProposals: readonly ChannelExecutionProposal[];
  readonly channelAttachments: readonly ChannelAttachment[];
  readonly channelLinkPreviews: readonly ChannelLinkPreview[];
  readonly channelArtifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly channelArtifactErrorsByRun: Readonly<Record<string, string>>;
  readonly channelBrief: ChannelBrief | undefined;
  readonly channelDecisions: readonly ChannelDecision[];
  readonly channelHandoffs: readonly ChannelHandoff[];
  readonly channelContextSummaries: readonly ChannelContextSummary[];
  readonly channelWorkflows: readonly ChannelWorkflow[];
  readonly channelWorkflowSteps: readonly ChannelWorkflowStep[];
  readonly channelStateTransitions: readonly StateTransitionEvent[];
  readonly channelActivityTransitionsLoading: boolean;
  readonly channelActivityTransitionError: string;
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly externalWorkCiTriageLoading: boolean;
  readonly selectedTaskId: string;
  readonly providers: readonly ProviderPreset[];
  readonly teammateTemplates: readonly AiTeammateTemplate[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly channelTeammateMemberships: readonly TeammateChannelMembership[];
  readonly channelTeammateMembershipsLoading: boolean;
  readonly channelTeammateSavingId: string;
  readonly taskRunProviderId: string;
  readonly fallbackProviderId: string;
  readonly channelsLoading: boolean;
  readonly tasksLoading: boolean;
  readonly channelMessagesLoading: boolean;
  readonly channelFilesLoading: boolean;
  readonly channelRunArtifactsLoading: boolean;
  readonly channelProtocolLoading: boolean;
  readonly providersLoading: boolean;
  readonly approvals: readonly ApprovalRequest[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly runs: readonly RunSession[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly isRunning: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly runningWorkflowStepId: string;
  readonly errorMessage: string;
  readonly onChannelFormChange: (form: ChannelFormState) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onAddChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onRemoveChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onSetDefaultChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onOpenTeammates: () => void;
  readonly onRefreshChannels: () => void;
  readonly onCreateDefaultChannel: () => void;
  readonly onCreateChannel: () => void;
  readonly onCreateTask: () => void;
  readonly onSendMessage: (input: {
    readonly threadId?: string;
    readonly body: string;
    readonly mentions: readonly ChannelMention[];
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
    readonly requestAiReply: boolean;
  }) => Promise<void>;
  readonly onConfirmExecutionProposal: (proposal: ChannelExecutionProposal) => void;
  readonly onCancelExecutionProposal: (proposal: ChannelExecutionProposal) => void;
  readonly onUploadAttachments: (files: readonly File[]) => Promise<readonly ChannelAttachment[]>;
  readonly onCreateLinkPreview: (url: string) => Promise<ChannelLinkPreview | undefined>;
  readonly onDeleteAttachment: (attachmentId: string) => void;
  readonly onSaveBrief: (input: UpdateChannelBriefRequest) => void;
  readonly onSupersedeDecision: (decision: ChannelDecision) => void;
  readonly onRejectDecision: (decision: ChannelDecision) => void;
  readonly onCreateHandoffFromTask: (task: Task) => void;
  readonly onUpdateHandoffStatus: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => void;
  readonly onStartWorkflowFromHandoff: (handoff: ChannelHandoff) => void;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => void;
  readonly onRunActivityTriageAction: (draft: ChannelActivityTriageDraft) => Promise<ChannelActivityTriageResult>;
  readonly onRefreshChannelActivity: () => void;
  readonly onRefreshExternalWorkCiTriage: () => void;
  readonly onRefreshChannelProtocol: () => void;
  readonly onRefreshChannelFiles: () => void;
  readonly attachmentContentUrl: (attachment: ChannelAttachment) => string;
  readonly onRefreshTasks: () => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const [activeTab, setActiveTab] = useState<ChannelTab>("activity");
  const [activitySearch, setActivitySearch] = useState("");
  const [activityCategoryFilter, setActivityCategoryFilter] = useState<ActivityCategoryFilter>("all");
  const [activityAttentionFilter, setActivityAttentionFilter] = useState<ActivityAttentionFilter>("all");
  const [activitySavedViews, setActivitySavedViews] = useState<readonly ChannelActivitySavedView[]>([]);
  const [activeActivityViewId, setActiveActivityViewId] = useState(allChannelActivitySavedViewId);
  const [activityFiltersExpanded, setActivityFiltersExpanded] = useState(false);
  const [attentionQueueExpanded, setAttentionQueueExpanded] = useState(false);
  const [activityDrilldownItemId, setActivityDrilldownItemId] = useState("");
  const [inspectorMode, setInspectorMode] = useState<"brief" | "decisions" | "handoffs" | "runtime">("brief");
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [teammateManagerOpen, setTeammateManagerOpen] = useState(false);
  const [briefDraft, setBriefDraft] = useState({
    objective: "",
    scope: "",
    acceptanceCriteria: "",
    openQuestions: "",
    risks: "",
  });
  const [messageDraft, setMessageDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachmentItem[]>([]);
  const [pendingLinkPreviews, setPendingLinkPreviews] = useState<readonly PendingLinkPreviewItem[]>([]);
  const [messageMentions, setMessageMentions] = useState<readonly ChannelMention[]>([]);
  const [mentionPicker, setMentionPicker] = useState<ActiveMentionPicker | undefined>();
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const [sendState, setSendState] = useState<ComposerSendState>("idle");
  const [sendError, setSendError] = useState("");
  const [aiReplyState, setAiReplyState] = useState<AiReplyState>("idle");
  const [activeThreadId, setActiveThreadId] = useState("");
  const [threadReplyDraft, setThreadReplyDraft] = useState("");
  const [threadReplyPending, setThreadReplyPending] = useState(false);
  const [threadReplyError, setThreadReplyError] = useState("");
  const [pendingChannelTeammateId, setPendingChannelTeammateId] = useState("");
  const [channelNotificationLevel, setChannelNotificationLevel] = useState<ChannelNotificationLevel>("mentions");
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autoPreviewUrlsRef = useRef(new Set<string>());
  const previousChannelIdRef = useRef(selectedChannelId);
  const pendingApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const readyProvider = providers.find(providerPreflightReady);
  const taskReadyProviders = providers.filter(providerPreflightReady);
  const setupChatProviders = providers.filter((provider) => !isMediaProvider(provider) && !providerPreflightReady(provider));
  const mediaProviders = providers.filter(isMediaProvider);
  const effectiveProviderId = (taskRunProviderId || selectedChannel?.defaultProviderPresetId || fallbackProviderId || readyProvider?.id) ?? "";
  const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const providerBlocker = providerRunPreflightBlocker(effectiveProvider, t);
  const activeLeaseCount = resourceLeases.filter((lease) => lease.status === "active").length;
  const taskActionPending = activeTaskRunAction !== undefined;
  const channelStatusText = selectedChannel
    ? t("{status} channel", {
      status: t(selectedChannel.status),
    })
    : t("No channel yet");
  const latestRun = activeRunId ? runById.get(activeRunId) : runs[0];
  const filteredTasks = useMemo(
    () =>
      tasks.filter((task) => {
        const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
        const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
        return taskMatchesFilter(taskFilter, task, linkedRunStatus);
      }),
    [activeRunId, latestStatus, runById, taskFilter, tasks],
  );
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        taskFilters.map((filter) => [
          filter,
          tasks.filter((task) => {
            const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
            const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
            return taskMatchesFilter(filter, task, linkedRunStatus);
          }).length,
        ]),
      ) as Record<TaskFilter, number>,
    [activeRunId, latestStatus, runById, tasks],
  );
  const activityItems = useMemo(
    () => buildChannelActivityItems({
      channelId: selectedChannelId,
      messages: channelMessages,
      tasks,
      runs,
      approvals,
      stateTransitions: channelStateTransitions,
      decisions: channelDecisions,
      handoffs: channelHandoffs,
      summaries: channelContextSummaries,
      workflows: channelWorkflows,
      workflowSteps: channelWorkflowSteps,
      extraRun: latestRun,
    }),
    [
      approvals,
      channelContextSummaries,
      channelDecisions,
      channelHandoffs,
      channelMessages,
      channelStateTransitions,
      channelWorkflowSteps,
      channelWorkflows,
      latestRun,
      runs,
      selectedChannelId,
      tasks,
    ],
  );
  const searchedActivityItems = useMemo(() => {
    const query = activitySearch.trim().toLowerCase();
    if (!query) {
      return activityItems;
    }
    return activityItems.filter((item) => item.searchText.includes(query));
  }, [activityItems, activitySearch]);
  const currentActivityViewFilter = useMemo(
    () => ({
      categoryFilter: activityCategoryFilter,
      attentionFilter: activityAttentionFilter,
      search: activitySearch,
    }) satisfies ChannelActivityViewFilter,
    [activityAttentionFilter, activityCategoryFilter, activitySearch],
  );
  const filteredActivityItems = useMemo(
    () => applyActivityViewFilter(activityItems, currentActivityViewFilter),
    [activityItems, currentActivityViewFilter],
  );
  const allActivitySavedViews = useMemo(
    () => [...builtinChannelActivitySavedViews, ...activitySavedViews],
    [activitySavedViews],
  );
  const savedViewCounts = useMemo(
    () =>
      Object.fromEntries(
        allActivitySavedViews.map((view) => [view.id, applyActivityViewFilter(activityItems, view.filter).length]),
      ) as Record<string, number>,
    [activityItems, allActivitySavedViews],
  );
  const selectedActivitySavedView = allActivitySavedViews.find((view) => view.id === activeActivityViewId);
  const activityCategoryCounts = useMemo(
    () =>
      Object.fromEntries(
        activityCategoryFilters.map((filter) => [
          filter,
          filter === "all"
            ? searchedActivityItems.length
            : searchedActivityItems.filter((item) => item.category === filter).length,
        ]),
      ) as Record<ActivityCategoryFilter, number>,
    [searchedActivityItems],
  );
  const activityAttentionCounts = useMemo(
    () =>
      ({
        needs_attention: searchedActivityItems.filter((item) => item.attention !== "none").length,
        blocked: searchedActivityItems.filter((item) => item.attention === "blocked").length,
        failed: searchedActivityItems.filter((item) => item.attention === "failed").length,
        pending: searchedActivityItems.filter((item) => item.attention === "pending").length,
      }) satisfies Record<Exclude<ActivityAttentionFilter, "all">, number>,
    [searchedActivityItems],
  );
  const activityFiltersActive = activitySearch.trim().length > 0 || activityCategoryFilter !== "all" || activityAttentionFilter !== "all";
  const attentionQueueItems = useMemo(() => buildAttentionQueueItems(activityItems), [activityItems]);
  const activityDrilldown = useMemo(() => {
    const item = activityItems.find((candidate) => candidate.id === activityDrilldownItemId);
    return item
      ? buildChannelActivityDrilldownItem({
        item,
        workflows: channelWorkflows,
        workflowSteps: channelWorkflowSteps,
        contextSummaries: channelContextSummaries,
        tasks,
      })
      : undefined;
  }, [activityDrilldownItemId, activityItems, channelContextSummaries, channelWorkflowSteps, channelWorkflows, tasks]);
  const activeThreadRoot = useMemo(
    () => channelMessages.find((message) => message.id === activeThreadId),
    [activeThreadId, channelMessages],
  );
  const activeThreadMessages = useMemo(
    () => activeThreadId ? channelMessages.filter((message) => message.threadId === activeThreadId) : [],
    [activeThreadId, channelMessages],
  );
  const executionProposalsByMessageId = useMemo(() => {
    const proposalsByMessageId = new Map<string, ChannelExecutionProposal[]>();
    for (const proposal of channelExecutionProposals) {
      if (proposal.status === "cancelled" || proposal.status === "superseded") {
        continue;
      }
      const existing = proposalsByMessageId.get(proposal.sourceMessageId) ?? [];
      existing.push(proposal);
      proposalsByMessageId.set(proposal.sourceMessageId, existing);
    }
    for (const proposals of proposalsByMessageId.values()) {
      proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return proposalsByMessageId;
  }, [channelExecutionProposals]);
  const channelRunsForFiles = useMemo(
    () => deriveChannelRuns(selectedChannelId, tasks, runs, latestRun),
    [latestRun, runs, selectedChannelId, tasks],
  );

  useEffect(() => {
    setActivitySavedViews(readCustomChannelActivitySavedViews(cwd, selectedChannelId));
    applyActivityView(builtinChannelActivitySavedViews[0]);
    setActivityFiltersExpanded(false);
    setAttentionQueueExpanded(false);
    setActivityDrilldownItemId("");
    setActiveThreadId("");
    setThreadReplyDraft("");
    setThreadReplyError("");
    setPendingChannelTeammateId("");
    setChannelNotificationLevel(readChannelNotificationLevel(cwd, selectedChannelId));
  }, [cwd, selectedChannelId]);

  useEffect(() => {
    if (!activityDrilldownItemId) {
      return undefined;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setActivityDrilldownItemId("");
      }
    }
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [activityDrilldownItemId]);

  useEffect(() => {
    setBriefDraft({
      objective: channelBrief?.objective ?? "",
      scope: channelBrief?.scope ?? "",
      acceptanceCriteria: (channelBrief?.acceptanceCriteria ?? []).join("\n"),
      openQuestions: (channelBrief?.openQuestions ?? []).join("\n"),
      risks: (channelBrief?.risks ?? []).join("\n"),
    });
  }, [channelBrief]);

  useEffect(() => {
    const previousChannelId = previousChannelIdRef.current;
    previousChannelIdRef.current = selectedChannelId;
    if (!previousChannelId || previousChannelId === selectedChannelId) {
      return;
    }
    setMessageDraft("");
    setMessageMentions([]);
    setMentionPicker(undefined);
    setMentionActiveIndex(0);
    setPendingAttachments([]);
    setPendingLinkPreviews([]);
    autoPreviewUrlsRef.current.clear();
    setSendState("idle");
    setSendError("");
    setAiReplyState("idle");
    setActivitySearch("");
    setActivityCategoryFilter("all");
    setActivityAttentionFilter("all");
    setActiveActivityViewId(allChannelActivitySavedViewId);
    setActivityFiltersExpanded(false);
    setAttentionQueueExpanded(false);
    setActivityDrilldownItemId("");
    setActiveThreadId("");
    setThreadReplyDraft("");
    setThreadReplyError("");
    setPendingChannelTeammateId("");
    setChannelNotificationLevel(readChannelNotificationLevel(cwd, selectedChannelId));
  }, [selectedChannelId]);

  useEffect(() => {
    if (activeTab === "files") {
      onRefreshChannelFiles();
    }
  }, [activeTab]);

  function selectTask(taskId: string): void {
    setCreateTaskOpen(false);
    onSelectTask(taskId);
  }

  function openTaskFromActivity(taskId: string): void {
    selectTask(taskId);
    setActiveTab("tasks");
  }

  function openProtocolFromActivity(mode: "brief" | "decisions" | "handoffs" | "runtime" = "runtime"): void {
    setInspectorMode(mode);
    setActiveTab("protocol");
  }

  function openAttentionQueueItem(item: ChannelAttentionQueueItem): void {
    openAttentionQueueTarget(item.target);
  }

  function openAttentionQueueItemDetails(item: ChannelAttentionQueueItem): void {
    setActivityDrilldownItemId(item.activityItemId);
  }

  function openActivityDetails(activityItemId: string): void {
    setActivityDrilldownItemId(activityItemId);
  }

  function openAttentionQueueTarget(target: ChannelAttentionQueueTarget): void {
    if (target.kind === "task") {
      openTaskFromActivity(target.taskId);
      return;
    }
    if (target.kind === "run") {
      onOpenRun(target.runId);
      return;
    }
    if (target.kind === "approval") {
      onOpenApprovals(target.runId);
      return;
    }
    openProtocolFromActivity(target.mode);
  }

  function openActivityDrilldownTarget(target: ChannelActivityDrilldownTarget): void {
    setActivityDrilldownItemId("");
    if (target.kind === "task") {
      openTaskFromActivity(target.taskId);
      return;
    }
    if (target.kind === "run") {
      onOpenRun(target.runId);
      return;
    }
    if (target.kind === "approval") {
      onOpenApprovals(target.runId);
      return;
    }
    openProtocolFromActivity(target.mode);
  }

  function openActivityTriageResult(result: ChannelActivityTriageResult): void {
    setActivityDrilldownItemId("");
    if (result.kind === "task") {
      openTaskFromActivity(result.task.id);
      return;
    }
    if (result.kind === "handoff") {
      openProtocolFromActivity("handoffs");
      return;
    }
    if (result.kind === "decision") {
      openProtocolFromActivity("decisions");
      return;
    }
    openProtocolFromActivity("brief");
  }

  function openThreadForMessage(message: ChannelMessage): void {
    setActiveThreadId(message.threadId ?? message.id);
    setThreadReplyError("");
    setActiveTab("activity");
  }

  function updateChannelNotificationLevel(level: ChannelNotificationLevel): void {
    setChannelNotificationLevel(level);
    writeChannelNotificationLevel(cwd, selectedChannelId, level);
  }

  function addSelectedChannelTeammate(): void {
    if (!pendingChannelTeammateId) {
      return;
    }
    const teammateId = pendingChannelTeammateId;
    setPendingChannelTeammateId("");
    void onAddChannelTeammate(teammateId);
  }

  function applyActivityView(view: ChannelActivitySavedView): void {
    setActiveActivityViewId(view.id);
    setActivitySearch(view.filter.search);
    setActivityCategoryFilter(view.filter.categoryFilter);
    setActivityAttentionFilter(view.filter.attentionFilter);
  }

  function persistActivitySavedViews(nextViews: readonly ChannelActivitySavedView[]): void {
    const cappedViews = nextViews.slice(0, maxCustomChannelActivitySavedViews);
    setActivitySavedViews(cappedViews);
    writeCustomChannelActivitySavedViews(cwd, selectedChannelId, cappedViews);
  }

  function saveActivityView(): void {
    if (activitySavedViews.length >= maxCustomChannelActivitySavedViews) {
      globalThis.alert?.(t("Custom saved views are limited to 8."));
      return;
    }
    const name = globalThis.prompt?.(t("Saved view name"), t("Custom view"));
    if (name === undefined || name === null) {
      return;
    }
    const view = createCustomChannelActivitySavedView(name, currentActivityViewFilter);
    persistActivitySavedViews([...activitySavedViews, view]);
    applyActivityView(view);
  }

  function renameActivityView(): void {
    if (!selectedActivitySavedView || selectedActivitySavedView.builtin) {
      return;
    }
    const name = globalThis.prompt?.(t("Rename saved view"), selectedActivitySavedView.name);
    if (name === undefined || name === null) {
      return;
    }
    const nextViews = activitySavedViews.map((view) =>
      view.id === selectedActivitySavedView.id
        ? { ...view, name: sanitizeSavedViewName(name), updatedAt: new Date().toISOString() }
        : view,
    );
    persistActivitySavedViews(nextViews);
  }

  function deleteActivityView(): void {
    if (!selectedActivitySavedView || selectedActivitySavedView.builtin) {
      return;
    }
    if (!globalThis.confirm?.(t("Delete saved view?"))) {
      return;
    }
    const nextViews = activitySavedViews.filter((view) => view.id !== selectedActivitySavedView.id);
    persistActivitySavedViews(nextViews);
    applyActivityView(builtinChannelActivitySavedViews[0]);
  }

  function createTask(): void {
    onCreateTask();
    setCreateTaskOpen(false);
  }

  function activityDetailsButton(activityItemId: string): JSX.Element {
    return (
      <button className="secondary-button compact-button" type="button" onClick={() => openActivityDetails(activityItemId)}>
        <Info size={14} />
        {t("Details")}
      </button>
    );
  }

  function activityActionRow(activityItemId: string, children?: ReactNode): JSX.Element {
    return (
      <div className="activity-action-row">
        {children}
        {activityDetailsButton(activityItemId)}
      </div>
    );
  }

  const taskDetailContent = createTaskOpen ? (
    <NewTaskPanel
      taskForm={taskForm}
      selectedChannel={selectedChannel}
      effectiveProviderId={effectiveProviderId}
      taskReadyProviders={taskReadyProviders}
      setupChatProviders={setupChatProviders}
      mediaProviders={mediaProviders}
      providersLoading={providersLoading}
      onProviderSelect={onProviderSelect}
      onTaskFormChange={onTaskFormChange}
      onCreateTask={createTask}
      onCancel={() => setCreateTaskOpen(false)}
    />
  ) : selectedTask ? (
    <TaskDetailPanel
      task={selectedTask}
      channels={channels}
      runById={runById}
      activeRunId={activeRunId}
      latestStatus={latestStatus}
      pendingApprovalCount={pendingApprovalCount}
      effectiveProvider={effectiveProvider}
      providerBlocker={providerBlocker}
      isRunning={isRunning}
      activeTaskRunAction={activeTaskRunAction}
      taskActionPending={taskActionPending}
      activeLeaseCount={activeLeaseCount}
      decisions={channelDecisions}
      contextSummaries={channelContextSummaries}
      workflows={channelWorkflows}
      workflowSteps={channelWorkflowSteps}
      onCreateHandoffFromTask={onCreateHandoffFromTask}
      onCreateTaskFromContextSummary={onCreateTaskFromContextSummary}
      onCheckThenRunTask={onCheckThenRunTask}
      onRunTask={onRunTask}
      onOpenRun={onOpenRun}
      onOpenApprovals={onOpenApprovals}
      onOpenProviders={onOpenProviders}
    />
  ) : (
    <div className="client-empty-state">
      <SquareTerminal />
      <span>{t("Select a task or create a new one")}</span>
    </div>
  );

  function saveBrief(): void {
    onSaveBrief({
      objective: briefDraft.objective,
      scope: briefDraft.scope,
      acceptanceCriteria: splitLines(briefDraft.acceptanceCriteria),
      openQuestions: splitLines(briefDraft.openQuestions),
      risks: splitLines(briefDraft.risks),
      decisionIds: channelDecisions.filter((decision) => decision.status === "active").map((decision) => decision.id),
      attachmentIds: channelBrief?.attachmentIds ?? [],
      linkPreviewIds: channelBrief?.linkPreviewIds ?? [],
      updatedBy: "local-user",
    });
  }

  const activeTabLoading = activeTab === "tasks"
    ? tasksLoading
    : activeTab === "protocol"
      ? channelProtocolLoading
      : activeTab === "files"
        ? channelFilesLoading || channelRunArtifactsLoading
        : channelMessagesLoading || channelProtocolLoading || channelActivityTransitionsLoading || externalWorkCiTriageLoading || channelsLoading;

  function refreshActiveTab(): void {
    if (activeTab === "tasks") {
      onRefreshTasks();
      return;
    }
    if (activeTab === "protocol") {
      onRefreshChannelProtocol();
      return;
    }
    if (activeTab === "files") {
      onRefreshChannelFiles();
      return;
    }
    onRefreshChannelActivity();
  }

  const allTeammateOptions = useMemo(
    () => [
      ...teammateTemplates.map((template) => ({ id: template.id, label: template.name, kind: "ai-teammate" as const })),
      ...localTeammates.map((teammate) => ({ id: teammate.id, label: teammate.displayName, kind: "ai-teammate" as const })),
    ],
    [localTeammates, teammateTemplates],
  );
  const channelTeammateIds = useMemo(
    () => new Set(channelTeammateMemberships.map((membership) => membership.teammateId)),
    [channelTeammateMemberships],
  );
  const teammateOptions = useMemo(
    () => [
      ...allTeammateOptions.filter((option) => channelTeammateIds.has(option.id)),
      ...allTeammateOptions.filter((option) => !channelTeammateIds.has(option.id)),
    ],
    [allTeammateOptions, channelTeammateIds],
  );
  const mentionPickerOptions = useMemo(
    () => {
      if (!mentionPicker) {
        return [];
      }
      const query = mentionPicker.query.trim().toLowerCase();
      return teammateOptions
        .filter((option) => {
          if (!query) {
            return true;
          }
          return option.label.toLowerCase().includes(query) || option.id.toLowerCase().includes(query);
        })
        .slice(0, 6);
    },
    [mentionPicker, teammateOptions],
  );
  const defaultTeammate = selectedChannel?.defaultTeammateId
    ? allTeammateOptions.find((teammate) => teammate.id === selectedChannel.defaultTeammateId)
    : undefined;
  const localTeammateById = useMemo(
    () => new Map(localTeammates.map((teammate) => [teammate.id, teammate])),
    [localTeammates],
  );
  const channelTeammates = useMemo(
    () => {
      const selectedChannelDefaultTeammateId = selectedChannel?.defaultTeammateId;
      return channelTeammateMemberships.map((membership) => {
        const teammate = localTeammateById.get(membership.teammateId);
        return teammate ? { membership, teammate, isDefault: selectedChannelDefaultTeammateId === teammate.id } : undefined;
      })
        .filter((item): item is { readonly membership: TeammateChannelMembership; readonly teammate: LocalTeammateDraft; readonly isDefault: boolean } => Boolean(item));
    },
    [channelTeammateMemberships, localTeammateById, selectedChannel?.defaultTeammateId],
  );
  const availableChannelTeammates = useMemo(
    () => localTeammates.filter((teammate) => !teammate.hidden && !channelTeammateIds.has(teammate.id)),
    [channelTeammateIds, localTeammates],
  );

  function updateMentionPicker(value: string, caret: number): void {
    const activeMention = findActiveMention(value, caret);
    setMentionPicker(activeMention);
    setMentionActiveIndex(0);
  }

  function focusComposerAt(caret: number): void {
    const focus = (): void => {
      const textarea = composerTextareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(caret, caret);
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(focus);
      return;
    }
    globalThis.setTimeout(focus, 0);
  }

  function commitMention(option: ChannelMention): void {
    const inserted = insertMentionToken(messageDraft, mentionPicker, option.label);
    setMessageDraft(inserted.value);
    setSendState("idle");
    setSendError("");
    setMessageMentions((current) => current.some((mention) => mention.id === option.id) ? current : [...current, option]);
    setMentionPicker(undefined);
    setMentionActiveIndex(0);
    focusComposerAt(inserted.caret);
  }

  function removeMessageMention(mentionId: string): void {
    setMessageMentions((current) => current.filter((mention) => mention.id !== mentionId));
  }

  function handleComposerTextChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    const value = event.currentTarget.value;
    setMessageDraft(value);
    setSendState("idle");
    setSendError("");
    updateMentionPicker(value, event.currentTarget.selectionStart ?? value.length);
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (!mentionPicker || mentionPickerOptions.length === 0) {
      if (event.key === "Escape") {
        setMentionPicker(undefined);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionActiveIndex((current) => (current + 1) % mentionPickerOptions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionActiveIndex((current) => (current - 1 + mentionPickerOptions.length) % mentionPickerOptions.length);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      commitMention(mentionPickerOptions[Math.min(mentionActiveIndex, mentionPickerOptions.length - 1)]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMentionPicker(undefined);
      setMentionActiveIndex(0);
    }
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    if (event.clipboardData.files.length === 0) {
      return;
    }
    event.preventDefault();
    void attachFiles(event.clipboardData.files);
  }

  function handleComposerDragOver(event: DragEvent<HTMLElement>): void {
    if (!Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setComposerDragActive(true);
  }

  function handleComposerDragLeave(event: DragEvent<HTMLElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setComposerDragActive(false);
  }

  function handleComposerDrop(event: DragEvent<HTMLElement>): void {
    if (event.dataTransfer.files.length === 0) {
      setComposerDragActive(false);
      return;
    }
    event.preventDefault();
    setComposerDragActive(false);
    void attachFiles(event.dataTransfer.files);
  }

  async function attachFiles(files: FileList | readonly File[]): Promise<void> {
    const selectedFiles = Array.from(files).slice(0, 10);
    if (selectedFiles.length === 0) {
      return;
    }
    const uploadItems = selectedFiles.map((file) => ({
      localId: createLocalId("attachment"),
      fileName: file.name,
      state: "uploading" as const,
    }));
    setPendingAttachments((current) => [...current, ...uploadItems]);
    setComposerBusy(true);
    try {
      const uploaded = await onUploadAttachments(selectedFiles);
      const uploadedByLocalId = new Map(uploadItems.map((item, index) => [item.localId, uploaded[index]]));
      setPendingAttachments((current) => current.map((item) => {
        const attachment = uploadedByLocalId.get(item.localId);
        if (attachment) {
          return { ...item, state: "ready", attachment };
        }
        if (uploadedByLocalId.has(item.localId)) {
          return { ...item, state: "failed", error: t("Upload failed") };
        }
        return item;
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingAttachments((current) => current.map((item) =>
        uploadItems.some((upload) => upload.localId === item.localId)
          ? { ...item, state: "failed", error: message }
          : item,
      ));
    } finally {
      setComposerBusy(false);
    }
  }

  async function addLinkPreview(rawUrl: string): Promise<void> {
    const url = rawUrl.trim();
    if (!url) {
      return;
    }
    const localId = createLocalId("link");
    setPendingLinkPreviews((current) => [
      ...current.filter((item) => item.url !== url && item.preview?.normalizedUrl !== url && item.preview?.url !== url),
      { localId, url, state: "uploading" },
    ]);
    setComposerBusy(true);
    try {
      const preview = await onCreateLinkPreview(url);
      if (preview) {
        setPendingLinkPreviews((current) => current.map((item) => item.localId === localId
          ? {
              ...item,
              state: preview.status === "ready" ? "ready" : preview.status === "blocked" ? "blocked" : "failed",
              preview,
              error: preview.errorMessage,
            }
          : item));
      } else {
        setPendingLinkPreviews((current) => current.map((item) => item.localId === localId
          ? { ...item, state: "failed", error: t("Preview failed") }
          : item));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingLinkPreviews((current) => current.map((item) => item.localId === localId
        ? { ...item, state: "failed", error: message }
        : item));
    } finally {
      setComposerBusy(false);
    }
  }

  async function sendMessage(): Promise<void> {
    if (!selectedChannelId || composerBusy || assetOperationPending || !composerHasSendableContent) {
      return;
    }
    const body = messageDraft.trim();
    const pastedUrls = extractUrls(body);
    const newPreviews: ChannelLinkPreview[] = [];
    const attachmentIds = pendingAttachments.flatMap((item) => item.attachment ? [item.attachment.id] : []);
    const pendingPreviewRecords = pendingLinkPreviews.flatMap((item) => item.preview ? [item.preview] : []);
    const shouldRequestAi = messageMentions.some((mention) => mention.kind === "ai-teammate");
    setComposerBusy(true);
    setSendState("sending");
    setSendError("");
    setAiReplyState(shouldRequestAi ? "replying" : "idle");
    try {
      for (const url of pastedUrls) {
        if (!pendingPreviewRecords.some((preview) => preview.normalizedUrl === url || preview.url === url)) {
          try {
            const preview = await onCreateLinkPreview(url);
            if (preview) {
              newPreviews.push(preview);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setPendingLinkPreviews((current) => [
              ...current,
              { localId: createLocalId("link"), url, state: "failed", error: message },
            ]);
          }
        }
      }
      const linkPreviews = [...pendingPreviewRecords, ...newPreviews];
      await onSendMessage({
        body,
        mentions: messageMentions,
        attachmentIds,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        requestAiReply: shouldRequestAi,
      });
      setMessageDraft("");
      setMessageMentions([]);
      setPendingAttachments([]);
      setPendingLinkPreviews([]);
      autoPreviewUrlsRef.current.clear();
      setSendState("idle");
      setSendError("");
      setAiReplyState("idle");
      setActiveTab("activity");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendState("failed");
      setSendError(message);
      setAiReplyState(shouldRequestAi ? "failed" : "idle");
    } finally {
      setComposerBusy(false);
    }
  }

  async function sendThreadReply(): Promise<void> {
    const body = threadReplyDraft.trim();
    if (!activeThreadId || !body || threadReplyPending) {
      return;
    }
    const mentions = findMentionsInText(body, teammateOptions);
    const shouldRequestAi = mentions.some((mention) => mention.kind === "ai-teammate");
    setThreadReplyPending(true);
    setThreadReplyError("");
    try {
      await onSendMessage({
        threadId: activeThreadId,
        body,
        mentions,
        attachmentIds: [],
        linkPreviewIds: [],
        requestAiReply: shouldRequestAi,
      });
      setThreadReplyDraft("");
    } catch (error) {
      setThreadReplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadReplyPending(false);
    }
  }

  function removePendingAttachment(localId: string): void {
    setPendingAttachments((current) => current.filter((item) => item.localId !== localId));
  }

  function removePendingLinkPreview(localId: string): void {
    const removed = pendingLinkPreviews.find((item) => item.localId === localId);
    if (removed) {
      autoPreviewUrlsRef.current.delete(removed.url);
      if (removed.preview) {
        autoPreviewUrlsRef.current.delete(removed.preview.url);
        autoPreviewUrlsRef.current.delete(removed.preview.normalizedUrl);
      }
    }
    setPendingLinkPreviews((current) => current.filter((item) => item.localId !== localId));
  }

  useEffect(() => {
    if (!selectedChannelId) {
      return undefined;
    }
    const knownPreviewUrls = new Set(
      pendingLinkPreviews.flatMap((item) => [
        item.url,
        item.preview?.url,
        item.preview?.normalizedUrl,
      ]).filter((item): item is string => Boolean(item)),
    );
    const nextUrl = extractUrls(messageDraft).find((url) => !knownPreviewUrls.has(url) && !autoPreviewUrlsRef.current.has(url));
    if (!nextUrl) {
      return undefined;
    }
    const timeoutId = globalThis.setTimeout(() => {
      autoPreviewUrlsRef.current.add(nextUrl);
      void addLinkPreview(nextUrl);
    }, 450);
    return () => globalThis.clearTimeout(timeoutId);
  }, [messageDraft, pendingLinkPreviews, selectedChannelId]);

  const readyAttachmentIds = pendingAttachments.flatMap((item) => item.attachment ? [item.attachment.id] : []);
  const readyLinkPreviewIds = pendingLinkPreviews.flatMap((item) => item.preview ? [item.preview.id] : []);
  const composerHasSendableContent = messageDraft.trim().length > 0 || readyAttachmentIds.length > 0 || readyLinkPreviewIds.length > 0;
  const assetOperationPending = pendingAttachments.some((item) => item.state === "uploading") || pendingLinkPreviews.some((item) => item.state === "uploading");
  const channelComposer = (
    <section className="composer-panel channel-composer" aria-label={t("Channel composer")}>
      <div className="composer-head">
        <span>
          <MessageSquare size={16} />
          {t("Discuss")}
        </span>
      </div>
      <div
        className={composerDragActive ? "composer-drop-zone active" : "composer-drop-zone"}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
      >
        <textarea
          ref={composerTextareaRef}
          value={messageDraft}
          rows={3}
          onChange={handleComposerTextChange}
          onKeyDown={handleComposerKeyDown}
          onPaste={handleComposerPaste}
          onSelect={(event) => updateMentionPicker(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
          placeholder={t("Message this channel or @ an AI teammate")}
          aria-describedby="channel-composer-smart-help"
        />
        {mentionPicker ? (
          <div className="mention-picker-popover" role="listbox" aria-label={t("Mention teammate")}>
            {mentionPickerOptions.length > 0 ? mentionPickerOptions.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={index === Math.min(mentionActiveIndex, mentionPickerOptions.length - 1)}
                className={index === Math.min(mentionActiveIndex, mentionPickerOptions.length - 1) ? "mention-suggestion active" : "mention-suggestion"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commitMention(option)}
              >
                <span>@{option.label}</span>
                {channelTeammateIds.has(option.id) ? <small>{t("Channel teammate")}</small> : <small>{t("Workspace teammate")}</small>}
              </button>
            )) : (
              <span className="mention-suggestion empty">{t("No matching teammates")}</span>
            )}
          </div>
        ) : null}
        {composerDragActive ? (
          <div className="composer-drop-hint">
            <FileText size={16} />
            <span>{t("Drop files to attach")}</span>
          </div>
        ) : null}
      </div>
      <div className="composer-primary-actions">
        <span id="channel-composer-smart-help" className="composer-smart-hint">
          {t("@ teammates, drop files, or paste links")}
        </span>
        <label className="icon-button composer-attach-button" aria-label={t("Attach files")} title={t("Attach files")}>
          <FileText size={15} />
          <input
            type="file"
            multiple
            hidden
            accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.log"
            onChange={(event) => {
              if (event.target.files) {
                void attachFiles(event.target.files);
              }
              event.target.value = "";
            }}
          />
        </label>
        <button className="primary-button" type="button" onClick={() => void sendMessage()} disabled={!selectedChannelId || composerBusy || assetOperationPending || !composerHasSendableContent}>
          {sendState === "sending" ? <Loader2 className="spin" size={15} /> : <Send size={15} />}
          {sendState === "sending" ? t("Sending...") : t("Send")}
        </button>
      </div>
      {pendingAttachments.length > 0 || pendingLinkPreviews.length > 0 || messageMentions.length > 0 ? (
        <div className="pending-assets" aria-label={t("Pending message assets")}>
          {messageMentions.map((mention) => (
            <span key={mention.id} className="pending-asset ready">
              @{mention.label}
              <small>{t("Mention")}</small>
              <button type="button" onClick={() => removeMessageMention(mention.id)} aria-label={t("Remove pending mention")}>
                <Trash2 size={12} />
              </button>
            </span>
          ))}
          {pendingAttachments.map((item) => (
            <span key={item.localId} className={`pending-asset ${item.state}`}>
              {item.state === "uploading" ? <Loader2 className="spin" size={12} /> : null}
              {item.fileName}
              <small>{t(pendingAssetLabel(item.state))}</small>
              <button type="button" onClick={() => removePendingAttachment(item.localId)} aria-label={t("Remove pending attachment")}>
                <Trash2 size={12} />
              </button>
            </span>
          ))}
          {pendingLinkPreviews.map((item) => (
            <span key={item.localId} className={`pending-asset ${item.state}`}>
              {item.state === "uploading" ? <Loader2 className="spin" size={12} /> : <Link2 size={12} />}
              {item.preview?.title ?? item.url}
              <small>{item.error ?? t(pendingPreviewLabel(item.state))}</small>
              <button type="button" onClick={() => removePendingLinkPreview(item.localId)} aria-label={t("Remove pending link preview")}>
                <Trash2 size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {sendState !== "idle" || aiReplyState !== "idle" ? (
        <div className="composer-status-list" aria-live="polite">
          {sendState === "sending" ? (
            <div className="composer-status-row loading">
              <Loader2 className="spin" size={14} />
              <span>{t("Sending message...")}</span>
            </div>
          ) : null}
          {aiReplyState === "replying" ? (
            <div className="composer-status-row loading">
              <Loader2 className="spin" size={14} />
              <span>{t("AI teammate is replying...")}</span>
            </div>
          ) : null}
          {sendState === "failed" ? (
            <div className="composer-status-row failed">
              <CircleAlert size={14} />
              <span>{t("Message failed")}{sendError ? `: ${sendError}` : ""}</span>
              <button className="secondary-button compact-button" type="button" onClick={() => {
                void sendMessage();
              }}>
                <RefreshCw size={13} />
                {t("Retry")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => {
                setSendState("idle");
                setSendError("");
                setAiReplyState("idle");
              }}>
                {t("Dismiss")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );

  const channelTeammateManager = (
    <section className="channel-settings-card channel-teammate-manager" aria-label={t("Channel teammates")}>
      <div className="channel-settings-section-head">
        <span>
          <UserPlus size={15} />
          <strong>{t("Members")}</strong>
        </span>
        <small>
          {channelTeammateMembershipsLoading
            ? t("Loading teammates...")
            : t("{count} teammates", { count: channelTeammates.length })}
        </small>
      </div>
      <div className="channel-teammate-add-row">
        <label className="field">
          <span>{t("Add teammate")}</span>
          <select
            value={pendingChannelTeammateId}
            disabled={!selectedChannelId || availableChannelTeammates.length === 0 || Boolean(channelTeammateSavingId)}
            onChange={(event) => setPendingChannelTeammateId(event.target.value)}
          >
            <option value="">{availableChannelTeammates.length > 0 ? t("Select teammate to add") : t("No teammates available")}</option>
            {availableChannelTeammates.map((teammate) => (
              <option key={teammate.id} value={teammate.id}>{teammate.displayName}</option>
            ))}
          </select>
        </label>
        <button className="primary-button compact-button" type="button" onClick={addSelectedChannelTeammate} disabled={!pendingChannelTeammateId || Boolean(channelTeammateSavingId)}>
          {channelTeammateSavingId === pendingChannelTeammateId ? <Loader2 className="spin" size={14} /> : <UserPlus size={14} />}
          {t("Add to channel")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={onOpenTeammates}>
          <Plus size={14} />
          {t("Open AI Teammates")}
        </button>
      </div>
      {channelTeammates.length === 0 ? (
        <div className="client-empty-state channel-teammate-empty">
          <MessageSquare size={18} />
          <span>{localTeammates.length === 0 ? t("Create a workspace teammate before assigning channel members.") : t("No teammates in this channel")}</span>
        </div>
      ) : (
        <div className="channel-teammate-list">
          {channelTeammates.map(({ isDefault, teammate }) => {
            const saving = channelTeammateSavingId === teammate.id;
            return (
              <article key={teammate.id} className="channel-teammate-row">
                <AvatarInitial label={teammate.displayName.slice(0, 1).toUpperCase() || "A"} tone={isDefault ? "teal" : "gray"} />
                <span>
                  <strong>{teammate.displayName}</strong>
                  <small>{teammate.modelLabel}</small>
                </span>
                {isDefault ? <span className="status-badge">{t("Default teammate")}</span> : null}
                <div className="channel-teammate-actions">
                  <button className="secondary-button compact-button" type="button" onClick={() => void onSetDefaultChannelTeammate(teammate.id)} disabled={saving || isDefault}>
                    {saving ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                    {isDefault ? t("Default teammate") : t("Set default")}
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => void onRemoveChannelTeammate(teammate.id)} disabled={saving}>
                    {saving ? <Loader2 className="spin" size={14} /> : <X size={14} />}
                    {t("Remove from channel")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  const channelNotificationPanel = (
    <section className="channel-settings-card channel-notification-panel" aria-label={t("Channel notifications")}>
      <div className="channel-settings-section-head">
        <span>
          {channelNotificationLevel === "muted" ? <BellOff size={15} /> : <Bell size={15} />}
          <strong>{t("Notifications")}</strong>
        </span>
        <small>{t(channelNotificationLevelLabel(channelNotificationLevel))}</small>
      </div>
      <div className="channel-notification-options" role="radiogroup" aria-label={t("Channel notifications")}>
        {channelNotificationLevels.map((level) => (
          <button
            key={level}
            className={channelNotificationLevel === level ? "channel-notification-option active" : "channel-notification-option"}
            type="button"
            role="radio"
            aria-checked={channelNotificationLevel === level}
            onClick={() => updateChannelNotificationLevel(level)}
          >
            <span>
              {level === "muted" ? <BellOff size={14} /> : <Bell size={14} />}
              <strong>{t(channelNotificationLevelLabel(level))}</strong>
            </span>
            <small>{t(channelNotificationLevelDescription(level))}</small>
          </button>
        ))}
      </div>
    </section>
  );

  return (
    <div className="client-window task-workbench-window" aria-label={t("Workspace")}>
      <header className="channel-header task-workbench-header">
        <div>
          <div className="channel-title-line">
            <Hash size={21} />
            <h1>{selectedChannel?.name ?? "Engineering"}</h1>
          </div>
          <p>{channelStatusText}</p>
        </div>
        <div className="channel-header-actions" aria-label={t("Workspace task toolbar")}>
          {daemonHealthy !== true ? (
            <span className="glass-chip attention">
              <Activity size={14} />
              {daemonHealthy === undefined ? t("Checking daemon") : t("Daemon offline")}
            </span>
          ) : null}
          {providerBlocker ? (
            <span className="glass-chip attention">
              <Command size={14} />
              {effectiveProvider?.displayName ?? providerLabel}
            </span>
          ) : null}
          <span className={selectedChannel?.defaultTeammateId ? "glass-chip ok" : "glass-chip attention"}>
            <MessageSquare size={14} />
            {defaultTeammate?.label ?? selectedChannel?.defaultTeammateId ?? t("No default teammate")}
          </span>
          {selectedChannel && selectedChannel.status !== "active" ? (
            <span className="glass-chip attention">
              <Workflow size={14} />
              {t(selectedChannel.status)}
            </span>
          ) : null}
          {pendingApprovalCount > 0 ? (
            <span className="glass-chip attention">
              <CheckCircle2 size={14} />
              {t("Pending approvals")} {pendingApprovalCount}
            </span>
          ) : null}
          {activeLeaseCount > 0 ? (
            <span className="glass-chip attention">
              <Clock3 size={14} />
              {t("{count} active leases", { count: activeLeaseCount })}
            </span>
          ) : null}
          <button
            className={teammateManagerOpen ? "secondary-button compact-button active task-toolbar-teammates" : "secondary-button compact-button task-toolbar-teammates"}
            type="button"
            aria-expanded={teammateManagerOpen}
            onClick={() => {
              setTeammateManagerOpen((current) => !current);
              setWorkspaceSettingsOpen(false);
            }}
            disabled={!selectedChannelId}
          >
            <UserPlus size={15} />
            {t("AI teammate management")}
          </button>
          <button
            className={workspaceSettingsOpen ? "secondary-button compact-button active task-toolbar-settings" : "secondary-button compact-button task-toolbar-settings"}
            type="button"
            aria-expanded={workspaceSettingsOpen}
            onClick={() => {
              setWorkspaceSettingsOpen((current) => !current);
              setTeammateManagerOpen(false);
            }}
          >
            <SlidersHorizontal size={15} />
            {t("Settings")}
          </button>
          <button
            className="primary-button compact-button task-toolbar-create"
            type="button"
            onClick={() => {
              setActiveTab("tasks");
              setCreateTaskOpen(true);
            }}
            disabled={!selectedChannelId}
          >
            <Plus size={15} />
            {t("New task")}
          </button>
        </div>
      </header>

      {teammateManagerOpen ? (
        <section className="workbench-settings-panel channel-teammate-dock" aria-label={t("AI teammate management")}>
          {channelTeammateManager}
        </section>
      ) : null}

      {workspaceSettingsOpen ? (
        <section className="workbench-settings-panel channel-options" aria-label={t("Advanced channel settings")}>
          {channelNotificationPanel}
          <section className="channel-settings-card channel-management-panel" aria-label={t("Channel management")}>
            <div className="channel-settings-section-head">
              <span>
                <SlidersHorizontal size={15} />
                <strong>{t("Channel management")}</strong>
              </span>
              <small>{t("Provider, path, and runtime")}</small>
            </div>
            <div className="channel-options-grid">
              <label className="field wide">
                <span>{t("Run provider")}</span>
                <select value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providersLoading || providers.length === 0}>
                  <option value="">{t("Select provider preset")}</option>
                  <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
                </select>
              </label>
              <label className="field wide">
                <span>{t("Name")}</span>
                <input value={channelForm.name} onChange={(event) => onChannelFormChange({ ...channelForm, name: event.target.value })} />
              </label>
              <label className="field wide">
                <span>{t("Execution path")}</span>
                <input value={channelForm.boundPath} onChange={(event) => onChannelFormChange({ ...channelForm, boundPath: event.target.value })} />
              </label>
              <label className="field wide">
                <span>{t("Default AI teammate")}</span>
                <select value={channelForm.defaultTeammateId} onChange={(event) => onChannelFormChange({ ...channelForm, defaultTeammateId: event.target.value })}>
                  <option value="">{t("No default teammate")}</option>
                  {teammateOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <ChannelRuntimePolicyFields form={channelForm} onChange={onChannelFormChange} />
              <div className="channel-option-actions">
                {channels.length === 0 ? (
                  <button className="secondary-button compact-button" type="button" onClick={onCreateDefaultChannel} disabled={channelsLoading || !readyProvider}>
                    <Plus size={14} />
                    {t("Create default")}
                  </button>
                ) : null}
                <button className="secondary-button compact-button" type="button" onClick={onRefreshChannels} disabled={channelsLoading}>
                  {channelsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  {t("Refresh channels")}
                </button>
                <button className="primary-button compact-button" type="button" onClick={onCreateChannel}>
                  <Plus size={14} />
                  {t("Create channel")}
                </button>
              </div>
            </div>
          </section>
        </section>
      ) : null}

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      <div className="task-workbench-main">
        <section
          className={[
            "panel",
            "task-list-panel",
            activeTab === "activity" ? "activity-tab-panel" : "",
            activeTab === "protocol" ? "protocol-tab-panel" : "",
          ].filter(Boolean).join(" ")}
          aria-label={t("Channel activity")}
        >
          <div className="channel-tabs-row">
            <div className="channel-tabs" role="tablist" aria-label={t("Channel tabs")}>
              {channelPrimaryTabs.map((tab) => (
                <button key={tab} type="button" className={activeTab === tab ? "channel-tab active" : "channel-tab"} onClick={() => setActiveTab(tab)}>
                  {channelTabIcon(tab, 14)}
                  {t(channelTabLabel(tab))}
                </button>
              ))}
            </div>
            <div className="channel-utility-tabs" aria-label={t("More channel views")}>
              {channelUtilityTabs.map((tab) => (
                <button key={tab} type="button" className={activeTab === tab ? "channel-tab channel-utility-tab active" : "channel-tab channel-utility-tab"} onClick={() => setActiveTab(tab)}>
                  {channelTabIcon(tab, 13)}
                  {t(channelTabLabel(tab))}
                </button>
              ))}
            </div>
            <button
              className="icon-button channel-tabs-refresh"
              type="button"
              onClick={refreshActiveTab}
              disabled={!selectedChannelId || activeTabLoading}
              aria-label={t("Refresh")}
            >
              {activeTabLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            </button>
          </div>

          {activeTab === "activity" ? (
            <div className="activity-shell">
              <details className="activity-ops-disclosure" open={activityFiltersActive || attentionQueueExpanded ? true : undefined}>
                <summary>
                  <span>
                    <SlidersHorizontal size={14} />
                    {t("Chat tools")}
                  </span>
                  <small>
                    {activityFiltersActive
                      ? t("Filters active")
                      : attentionQueueItems.length > 0
                        ? t("{count} items need attention", { count: attentionQueueItems.length })
                        : t("Search, filters, and attention")}
                  </small>
                </summary>
                <div className="activity-ops-panel">
                  <ActivityFilterToolbar
                    search={activitySearch}
                    categoryFilter={activityCategoryFilter}
                    attentionFilter={activityAttentionFilter}
                    savedViews={allActivitySavedViews}
                    activeSavedViewId={activeActivityViewId}
                    filtersExpanded={activityFiltersExpanded}
                    savedViewCounts={savedViewCounts}
                    selectedSavedView={selectedActivitySavedView}
                    categoryCounts={activityCategoryCounts}
                    attentionCounts={activityAttentionCounts}
                    clearDisabled={!activityFiltersActive}
                    customViewLimitReached={activitySavedViews.length >= maxCustomChannelActivitySavedViews}
                    onSavedViewSelect={applyActivityView}
                    onSaveView={saveActivityView}
                    onRenameView={renameActivityView}
                    onDeleteView={deleteActivityView}
                    onFiltersExpandedChange={setActivityFiltersExpanded}
                    onSearchChange={(value) => {
                      setActiveActivityViewId("");
                      setActivitySearch(value);
                    }}
                    onCategoryFilterChange={(filter) => {
                      setActiveActivityViewId("");
                      setActivityCategoryFilter(filter);
                    }}
                    onAttentionFilterChange={(filter) => {
                      setActiveActivityViewId("");
                      setActivityAttentionFilter(filter);
                    }}
                    onClear={() => {
                      applyActivityView(builtinChannelActivitySavedViews[0]);
                    }}
                  />
                  <AttentionQueue
                    items={attentionQueueItems}
                    expanded={attentionQueueExpanded}
                    onExpandedChange={setAttentionQueueExpanded}
                    onOpenItem={openAttentionQueueItem}
                    onOpenItemDetails={openAttentionQueueItemDetails}
                  />
                  <CiTriageAuditPanel
                    records={externalWorkCiTriage}
                    loading={externalWorkCiTriageLoading}
                    maxRecords={4}
                    cwd={cwd}
                    onRefresh={onRefreshExternalWorkCiTriage}
                    onSelectTask={openTaskFromActivity}
                    onOpenRun={onOpenRun}
                  />
                </div>
              </details>
              <div className={activeThreadRoot ? "activity-chat-layout with-thread" : "activity-chat-layout"}>
                <div className="activity-chat-main">
                  <div className="message-feed" aria-label={t("Channel message feed")}>
                  {channelMessagesLoading || channelProtocolLoading ? (
                    <div className="client-empty-state">
                      <Loader2 className="spin" />
                      <span>{t("Loading messages...")}</span>
                    </div>
                  ) : activityItems.length === 0 ? (
                    <MessageBubble
                      avatar={<AvatarInitial label="L" tone="orange" />}
                      author="Ling Stack"
                      time={t("Now")}
                      body={selectedChannel ? t("Default workspace is ready.") : t("Create a default channel to start the workspace loop.")}
                    />
                  ) : filteredActivityItems.length === 0 ? (
                    <div className="client-empty-state">
                      <Search />
                      <span>{t("No activity matches these filters")}</span>
                    </div>
                  ) : (
                    filteredActivityItems.map((item) => {
                      if (item.kind === "message") {
                        const message = item.record;
                        const plainChatMessage = message.kind === "message" || message.kind === "ai_reply";
                        const executionProposals = executionProposalsByMessageId.get(message.id) ?? [];
                        return (
                          <div key={item.id} className="message-group">
                            <MessageBubble
                              tone={message.status === "blocked" ? "chat-blocked" : plainChatMessage ? "chat" : "system"}
                              avatar={<AvatarInitial label={message.authorType === "ai-teammate" ? "A" : message.authorType === "system" ? "S" : "T"} tone={message.authorType === "ai-teammate" ? "teal" : message.authorType === "system" ? "violet" : undefined} />}
                              author={messageAuthorLabel(message, teammateOptions)}
                              tag={message.kind === "ai_reply" ? "AI" : message.kind === "task_link" ? "Task" : undefined}
                              time={formatDateTime(message.createdAt)}
                              body={message.body}
                              metaAction={plainChatMessage ? (
                                <button className="message-reply-button" type="button" onClick={() => openThreadForMessage(message)} aria-label={t("Reply in topic")} data-tooltip={t("Reply in topic")}>
                                  <Reply size={13} />
                                </button>
                              ) : undefined}
                              action={
                                plainChatMessage ? undefined : message.linkedTaskId ? (
                                  activityActionRow(item.id, <code>{message.linkedTaskId}</code>)
                                ) : activityActionRow(item.id)
                              }
                            />
                            {executionProposals.map((proposal) => (
                              <ChannelExecutionProposalCard
                                key={proposal.id}
                                proposal={proposal}
                                assigneeLabel={teammateLabel(proposal.assigneeTeammateId, teammateOptions)}
                                teammates={teammateOptions}
                                linkedRun={proposal.linkedRunId ? runById.get(proposal.linkedRunId) : undefined}
                                activeRunId={activeRunId}
                                latestStatus={latestStatus}
                                onConfirm={() => onConfirmExecutionProposal(proposal)}
                                onCancel={() => onCancelExecutionProposal(proposal)}
                                onOpenRun={onOpenRun}
                              />
                            ))}
                          </div>
                        );
                      }
                  if (item.kind === "decision") {
                    const decision = item.record;
                    return (
                      <MessageBubble
                        key={item.id}
                        tone="protocol"
                        avatar={<AvatarInitial label="D" tone="violet" />}
                        author={t("Decision log")}
                        tag={decision.status}
                        time={formatDateTime(decision.createdAt)}
                        body={`${decision.title}: ${decision.decision}`}
                        action={
                          activityActionRow(item.id, <>
                            <button className="secondary-button compact-button" type="button" onClick={() => onSupersedeDecision(decision)}>
                              <FileCheck2 size={14} />
                              {t("Supersede")}
                            </button>
                            <button className="secondary-button compact-button" type="button" onClick={() => onRejectDecision(decision)}>
                              <CircleAlert size={14} />
                              {t("Reject")}
                            </button>
                            <button className="secondary-button compact-button" type="button" onClick={() => openProtocolFromActivity("decisions")}>
                              <Workflow size={14} />
                              {t("Open context")}
                            </button>
                          </>)
                        }
                      />
                    );
                  }
                  if (item.kind === "handoff") {
                    const handoff = item.record;
                    const handoffWorkflow = channelWorkflows.find((workflow) => workflow.sourceHandoffId === handoff.id);
                    return (
                      <MessageBubble
                        key={item.id}
                        tone="protocol"
                        avatar={<AvatarInitial label="H" tone="teal" />}
                        author={t("Handoff")}
                        tag={handoff.status}
                        time={formatDateTime(handoff.createdAt)}
                        body={`${handoff.fromParticipantLabel} -> ${handoff.toParticipantLabel}: ${handoff.reason}`}
                        action={
                          activityActionRow(item.id, <>
                            <button className="secondary-button compact-button" type="button" onClick={() => onStartWorkflowFromHandoff(handoff)} disabled={Boolean(handoffWorkflow)}>
                              <Play size={14} />
                              {handoffWorkflow ? t("Workflow started") : t("Start workflow")}
                            </button>
                            <button className="secondary-button compact-button" type="button" onClick={() => onUpdateHandoffStatus(handoff, "accepted")}>
                              {t("Accept")}
                            </button>
                            <button className="secondary-button compact-button" type="button" onClick={() => onUpdateHandoffStatus(handoff, "completed")}>
                              {t("Complete")}
                            </button>
                            <button className="secondary-button compact-button" type="button" onClick={() => openProtocolFromActivity("handoffs")}>
                              <Workflow size={14} />
                              {t("Open context")}
                            </button>
                          </>)
                        }
                      />
                    );
                  }
                  if (item.kind === "workflow") {
                    const workflow = item.record;
                    const steps = channelWorkflowSteps.filter((step) => step.workflowId === workflow.id);
                    return (
                      <MessageBubble
                        key={item.id}
                        tone="runtime"
                        avatar={<AvatarInitial label="W" tone="violet" />}
                        author={t("Workflow")}
                        tag={workflow.status}
                        time={formatDateTime(workflow.updatedAt)}
                        body={`${workflow.title}: ${workflow.objective}`}
                        action={
                          activityActionRow(item.id, <>
                            <small>{t("{count} steps", { count: steps.length })}</small>
                            <button className="secondary-button compact-button" type="button" onClick={() => openProtocolFromActivity("runtime")}>
                              <Workflow size={14} />
                              {t("Open context")}
                            </button>
                          </>)
                        }
                      />
                    );
                  }
                  if (item.kind === "workflow-step") {
                    const step = item.record;
                    return (
                      <MessageBubble
                        key={item.id}
                        tone="runtime"
                        avatar={<AvatarInitial label="S" tone="teal" />}
                        author={t("Workflow step")}
                        tag={step.status}
                        time={formatDateTime(step.updatedAt)}
                        body={`${step.title}: ${step.prompt}`}
                        action={
                          step.blocker ? (
                            activityActionRow(item.id, <>
                              <div className="provider-run-notice compact">
                                <CircleAlert size={14} />
                                <span>{step.blocker}</span>
                              </div>
                              <button className="secondary-button compact-button" type="button" onClick={() => openProtocolFromActivity("runtime")}>
                                <Workflow size={14} />
                                {t("Open context")}
                              </button>
                            </>)
                          ) : step.taskId ? (
                            activityActionRow(item.id, <>
                              <code>{step.taskId}{step.runId ? ` / ${step.runId}` : ""}</code>
                              <button className="secondary-button compact-button" type="button" onClick={() => openProtocolFromActivity("runtime")}>
                                <Workflow size={14} />
                                {t("Open context")}
                              </button>
                            </>)
                          ) : (
                            activityActionRow(item.id, (
                              <button className="secondary-button compact-button" type="button" onClick={() => openProtocolFromActivity("runtime")}>
                                <Workflow size={14} />
                                {t("Open context")}
                              </button>
                            ))
                          )
                        }
                      />
                    );
                  }
                  if (item.kind === "task") {
                    const task = item.record;
                    return (
                      <MessageBubble
                        key={item.id}
                        tone="work"
                        avatar={<AvatarInitial label="T" tone="orange" />}
                        author={t("Task event")}
                        tag={task.status}
                        time={formatDateTime(task.updatedAt)}
                        body={t("Task {title} is {status}.", { title: task.title, status: task.status })}
                        action={
                          activityActionRow(item.id, (
                            <button className="secondary-button compact-button" type="button" onClick={() => openTaskFromActivity(task.id)}>
                              <SquareTerminal size={14} />
                              {t("Open task")}
                            </button>
                          ))
                        }
                      />
                    );
                  }
                  if (item.kind === "run") {
                    const run = item.record;
                    const taskTitle = item.task?.title ?? readRunTitle(run);
                    return (
                      <MessageBubble
                        key={item.id}
                        tone="work"
                        avatar={<AvatarInitial label="R" tone="violet" />}
                        author={t("Run event")}
                        tag={run.status}
                        time={formatDateTime(run.endedAt ?? run.startedAt ?? run.updatedAt)}
                        body={t("Run {runId} for {title} is {status}.", { runId: run.id, title: taskTitle, status: run.status })}
                        action={
                          activityActionRow(item.id, (
                            <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(run.id)}>
                              <History size={14} />
                              {t("Open run")}
                            </button>
                          ))
                        }
                      />
                    );
                  }
                  if (item.kind === "approval") {
                    const approval = item.record;
                    const approvalStatus = effectiveApprovalStatus(approval);
                    return (
                      <MessageBubble
                        key={item.id}
                        tone="approval"
                        avatar={<AvatarInitial label="A" tone="teal" />}
                        author={t("Approval event")}
                        tag={approvalStatus}
                        time={formatDateTime(approval.resolvedAt ?? approval.createdAt)}
                        body={t("{title} is {status}.", { title: approval.title, status: approvalStatus })}
                        action={
                          activityActionRow(item.id, (
                            <button className="secondary-button compact-button" type="button" onClick={() => onOpenApprovals(approval.runId)}>
                              <CheckCircle2 size={14} />
                              {t("Open approval")}
                            </button>
                          ))
                        }
                      />
                    );
                  }
                  if (item.kind === "state-transition") {
                    const transition = item.record;
                    return (
                      <MessageBubble
                        key={item.id}
                        tone="runtime"
                        avatar={<AvatarInitial label="S" tone="violet" />}
                        author={t("State change")}
                        tag={transition.entityType}
                        time={formatDateTime(transition.createdAt)}
                        body={t("{entityType} {entityId}: {fromStatus} -> {toStatus} via {event}.", {
                          entityType: transition.entityType,
                          entityId: transition.entityId,
                          fromStatus: transition.fromStatus,
                          toStatus: transition.toStatus,
                          event: transition.event,
                        })}
                        action={
                          activityActionRow(item.id, (
                            <button
                              className="secondary-button compact-button"
                              type="button"
                              onClick={() => {
                                if (transition.entityType === "task") {
                                  openTaskFromActivity(transition.entityId);
                                } else if (transition.entityType === "run") {
                                  onOpenRun(transition.entityId);
                                } else if (transition.entityType === "approval") {
                                  onOpenApprovals();
                                } else {
                                  openProtocolFromActivity("runtime");
                                }
                              }}
                            >
                              {transition.entityType === "task" ? <SquareTerminal size={14} /> : transition.entityType === "run" ? <History size={14} /> : <Workflow size={14} />}
                              {t("Open event")}
                            </button>
                          ))
                        }
                      />
                    );
                  }
                  const summary = item.record;
                  return (
                    <MessageBubble
                      key={item.id}
                      tone="protocol"
                      avatar={<AvatarInitial label="C" tone="orange" />}
                      author={t("Context summary")}
                      tag={summary.targetType}
                      time={formatDateTime(summary.updatedAt)}
                      body={summary.summary}
                      action={
                        activityActionRow(item.id, <>
                          <button className="secondary-button compact-button" type="button" onClick={() => onCreateTaskFromContextSummary(summary)}>
                            <Plus size={14} />
                            {t("Create task")}
                          </button>
                          <button className="secondary-button compact-button" type="button" onClick={() => openProtocolFromActivity("brief")}>
                            <Workflow size={14} />
                            {t("Open context")}
                          </button>
                        </>)
                      }
                    />
                  );
                    })
                  )}
                  {channelActivityTransitionsLoading ? (
                    <div className="activity-feed-status" role="status">
                      <Loader2 className="spin" size={14} />
                      <span>{t("Loading activity events...")}</span>
                    </div>
                  ) : null}
                  {channelActivityTransitionError ? (
                    <div className="activity-feed-status warning" role="status">
                      <CircleAlert size={14} />
                      <span>{t("Some activity changes could not be loaded")}</span>
                    </div>
                  ) : null}
                  </div>
                  {channelComposer}
                </div>
                {activeThreadRoot ? (
                  <ThreadReplyPanel
                    rootMessage={activeThreadRoot}
                    replies={activeThreadMessages}
                    teammates={teammateOptions}
                    draft={threadReplyDraft}
                    pending={threadReplyPending}
                    error={threadReplyError}
                    onDraftChange={(value) => {
                      setThreadReplyDraft(value);
                      setThreadReplyError("");
                    }}
                    onSend={() => void sendThreadReply()}
                    onClose={() => {
                      setActiveThreadId("");
                      setThreadReplyDraft("");
                      setThreadReplyError("");
                    }}
                  />
                ) : null}
              </div>
              {activityDrilldown ? (
                <ActivityDrilldownDrawer
                  drilldown={activityDrilldown}
                  defaultTeammateId={selectedChannel?.defaultTeammateId}
                  activeDecisionIds={channelDecisions.filter((decision) => decision.status === "active").map((decision) => decision.id)}
                  onClose={() => setActivityDrilldownItemId("")}
                  onOpenTarget={openActivityDrilldownTarget}
                  onRunTriageAction={onRunActivityTriageAction}
                  onOpenTriageResult={openActivityTriageResult}
                />
              ) : null}
            </div>
          ) : null}

          {activeTab === "files" ? (
            <ChannelFiles
              attachments={channelAttachments}
              linkPreviews={channelLinkPreviews}
              runs={channelRunsForFiles}
              tasks={tasks}
              artifactsByRun={channelArtifactsByRun}
              artifactErrorsByRun={channelArtifactErrorsByRun}
              loading={channelFilesLoading}
              runArtifactsLoading={channelRunArtifactsLoading}
              attachmentContentUrl={attachmentContentUrl}
              onDeleteAttachment={onDeleteAttachment}
            />
          ) : null}

          {activeTab === "tasks" ? (
            <div className="tasks-tab-layout">
              <div className="tasks-tab-list">
                <div className="task-filter-tabs" aria-label={t("Task filters")}>
                  {taskFilters.map((filter) => (
                    <button key={filter} className={taskFilter === filter ? "active" : ""} type="button" onClick={() => setTaskFilter(filter)}>
                      {t(taskFilterLabel(filter))}
                      <small>{filterCounts[filter]}</small>
                    </button>
                  ))}
                </div>
                <div className="workbench-task-list">
                  {filteredTasks.length === 0 ? (
                    <div className="client-empty-state">
                      {tasksLoading ? <Loader2 className="spin" /> : <SquareTerminal />}
                      <span>{tasksLoading ? t("Loading tasks...") : t("No tasks match this filter")}</span>
                    </div>
                  ) : (
                    filteredTasks.map((task) => {
                      const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
                      const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
                      return (
                        <button
                          key={task.id}
                          type="button"
                          className={task.id === selectedTask?.id && !createTaskOpen ? "client-task-card selected" : "client-task-card"}
                          onClick={() => selectTask(task.id)}
                        >
                          <span className="client-task-main">
                            <span>
                              <strong>{task.title}</strong>
                              <small>{task.prompt}</small>
                            </span>
                            <span className={`task-status ${task.status}`}>{t(task.status)}</span>
                          </span>
                          <span className="task-card-meta">
                            {task.currentRunId ? <StatusBadge status={linkedRunStatus} /> : <span className="status-badge queued">{t("Not run")}</span>}
                            <small>{formatDateTime(task.updatedAt)}</small>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
              <section className="task-detail-panel inline-task-detail-panel" aria-label={createTaskOpen ? t("New task") : t("Task detail")}>
                {taskDetailContent}
              </section>
            </div>
          ) : null}

          {activeTab === "protocol" ? (
            <div className="channel-protocol-tab-content">
              <ChannelInspector
                mode={inspectorMode}
                onModeChange={setInspectorMode}
                brief={channelBrief}
                briefDraft={briefDraft}
                onBriefDraftChange={setBriefDraft}
                onSaveBrief={saveBrief}
                decisions={channelDecisions}
                handoffs={channelHandoffs}
                contextSummaries={channelContextSummaries}
                workflows={channelWorkflows}
                workflowSteps={channelWorkflowSteps}
                attachments={channelAttachments}
                linkPreviews={channelLinkPreviews}
                runningWorkflowStepId={runningWorkflowStepId}
                loading={channelProtocolLoading}
                selectedTask={selectedTask}
                onSupersedeDecision={onSupersedeDecision}
                onRejectDecision={onRejectDecision}
                onUpdateHandoffStatus={onUpdateHandoffStatus}
                onStartWorkflowFromHandoff={onStartWorkflowFromHandoff}
                onStartWorkflowStep={onStartWorkflowStep}
                onUpdateWorkflowStepStatus={onUpdateWorkflowStepStatus}
                onCreateTaskFromContextSummary={onCreateTaskFromContextSummary}
              />
            </div>
          ) : null}

        </section>

      </div>
    </div>
  );
}

type ChannelInspectorMode = "brief" | "decisions" | "handoffs" | "runtime";

function ChannelInspector({
  mode,
  onModeChange,
  brief,
  briefDraft,
  onBriefDraftChange,
  onSaveBrief,
  decisions,
  handoffs,
  contextSummaries,
  workflows,
  workflowSteps,
  attachments,
  linkPreviews,
  runningWorkflowStepId,
  loading,
  selectedTask,
  onSupersedeDecision,
  onRejectDecision,
  onUpdateHandoffStatus,
  onStartWorkflowFromHandoff,
  onStartWorkflowStep,
  onUpdateWorkflowStepStatus,
  onCreateTaskFromContextSummary,
}: {
  readonly mode: ChannelInspectorMode;
  readonly onModeChange: (mode: ChannelInspectorMode) => void;
  readonly brief: ChannelBrief | undefined;
  readonly briefDraft: {
    readonly objective: string;
    readonly scope: string;
    readonly acceptanceCriteria: string;
    readonly openQuestions: string;
    readonly risks: string;
  };
  readonly onBriefDraftChange: (draft: {
    readonly objective: string;
    readonly scope: string;
    readonly acceptanceCriteria: string;
    readonly openQuestions: string;
    readonly risks: string;
  }) => void;
  readonly onSaveBrief: () => void;
  readonly decisions: readonly ChannelDecision[];
  readonly handoffs: readonly ChannelHandoff[];
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly attachments: readonly ChannelAttachment[];
  readonly linkPreviews: readonly ChannelLinkPreview[];
  readonly runningWorkflowStepId: string;
  readonly loading: boolean;
  readonly selectedTask: Task | undefined;
  readonly onSupersedeDecision: (decision: ChannelDecision) => void;
  readonly onRejectDecision: (decision: ChannelDecision) => void;
  readonly onUpdateHandoffStatus: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => void;
  readonly onStartWorkflowFromHandoff: (handoff: ChannelHandoff) => void;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => void;
}): JSX.Element {
  const { t } = useI18n();
  const activeDecisions = decisions.filter((decision) => decision.status === "active");
  const taskSummaries = selectedTask ? contextSummaries.filter((summary) => summary.targetType === "task" && summary.targetId === selectedTask.id) : [];
  const activeWorkflows = workflows.filter((workflow) => workflow.status !== "succeeded" && workflow.status !== "cancelled" && workflow.status !== "failed");
  return (
    <section className="channel-inspector" aria-label={t("Channel inspector")}>
      <div className="channel-inspector-tabs" role="tablist" aria-label={t("Channel inspector modes")}>
        {(["brief", "decisions", "handoffs", "runtime"] as const).map((item) => (
          <button key={item} type="button" className={mode === item ? "active" : ""} onClick={() => onModeChange(item)}>
            {item === "brief" ? t("Brief") : item === "decisions" ? t("Decisions") : item === "handoffs" ? t("Handoffs") : t("Runtime")}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="client-empty-state compact">
          <Loader2 className="spin" />
          <span>{t("Loading protocol...")}</span>
        </div>
      ) : null}
      {mode === "brief" ? (
        <div className="brief-editor">
          <label className="field wide">
            <span>{t("Objective")}</span>
            <textarea rows={2} value={briefDraft.objective} onChange={(event) => onBriefDraftChange({ ...briefDraft, objective: event.target.value })} />
          </label>
          <label className="field wide">
            <span>{t("Scope")}</span>
            <textarea rows={2} value={briefDraft.scope} onChange={(event) => onBriefDraftChange({ ...briefDraft, scope: event.target.value })} />
          </label>
          <label className="field wide">
            <span>{t("Acceptance criteria")}</span>
            <textarea rows={3} value={briefDraft.acceptanceCriteria} onChange={(event) => onBriefDraftChange({ ...briefDraft, acceptanceCriteria: event.target.value })} />
          </label>
          <label className="field wide">
            <span>{t("Open questions")}</span>
            <textarea rows={2} value={briefDraft.openQuestions} onChange={(event) => onBriefDraftChange({ ...briefDraft, openQuestions: event.target.value })} />
          </label>
          <label className="field wide">
            <span>{t("Risks")}</span>
            <textarea rows={2} value={briefDraft.risks} onChange={(event) => onBriefDraftChange({ ...briefDraft, risks: event.target.value })} />
          </label>
          <button className="primary-button compact-button" type="button" onClick={onSaveBrief}>
            <FileCheck2 size={14} />
            {t("Save brief")}
          </button>
        </div>
      ) : null}
      {mode === "decisions" ? (
        <ProtocolList
          emptyLabel={t("No decisions recorded")}
          items={decisions}
          renderItem={(decision) => (
            <div className="protocol-row" key={decision.id}>
              <span>
                <strong>{decision.title}</strong>
                <small>{decision.status} · {decision.decision}</small>
              </span>
              <div className="activity-action-row">
                <button className="secondary-button compact-button" type="button" onClick={() => onSupersedeDecision(decision)}>{t("Supersede")}</button>
                <button className="secondary-button compact-button" type="button" onClick={() => onRejectDecision(decision)}>{t("Reject")}</button>
              </div>
            </div>
          )}
        />
      ) : null}
      {mode === "handoffs" ? (
        <ProtocolList
          emptyLabel={t("No handoffs")}
          items={handoffs}
          renderItem={(handoff) => (
            <div className="protocol-row" key={handoff.id}>
              <span>
                <strong>{handoff.fromParticipantLabel} {"->"} {handoff.toParticipantLabel}</strong>
                <small>{handoff.status} · {handoff.reason}</small>
              </span>
              <div className="activity-action-row">
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={() => onStartWorkflowFromHandoff(handoff)}
                  disabled={workflows.some((workflow) => workflow.sourceHandoffId === handoff.id)}
                >
                  {workflows.some((workflow) => workflow.sourceHandoffId === handoff.id) ? t("Workflow started") : t("Start workflow")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={() => onUpdateHandoffStatus(handoff, "accepted")}>{t("Accept")}</button>
                <button className="secondary-button compact-button" type="button" onClick={() => onUpdateHandoffStatus(handoff, "completed")}>{t("Complete")}</button>
              </div>
            </div>
          )}
        />
      ) : null}
      {mode === "runtime" ? (
        <div className="runtime-protocol">
          <div className="task-strip-head">
            <span><Workflow size={15} /><strong>{t("Workflow queue")}</strong></span>
            <small>{activeWorkflows.length}</small>
          </div>
          <ProtocolList
            emptyLabel={t("No active workflows")}
            items={activeWorkflows}
            renderItem={(workflow) => (
              <WorkflowQueueCard
                key={workflow.id}
                workflow={workflow}
                steps={workflowSteps.filter((step) => step.workflowId === workflow.id)}
                brief={brief}
                decisions={activeDecisions}
                handoff={handoffs.find((handoff) => handoff.id === workflow.sourceHandoffId)}
                contextSummaries={contextSummaries}
                attachments={attachments}
                linkPreviews={linkPreviews}
                runningWorkflowStepId={runningWorkflowStepId}
                onStartWorkflowStep={onStartWorkflowStep}
                onUpdateWorkflowStepStatus={onUpdateWorkflowStepStatus}
              />
            )}
          />
          <div className="task-strip-head">
            <span><FileCheck2 size={15} /><strong>{t("Active decisions")}</strong></span>
            <small>{activeDecisions.length}</small>
          </div>
          <ProtocolList
            emptyLabel={t("No active decisions")}
            items={activeDecisions}
            renderItem={(decision) => (
              <div className="protocol-row compact" key={decision.id}>
                <strong>{decision.title}</strong>
                <small>{decision.decision}</small>
              </div>
            )}
          />
          <div className="task-strip-head">
            <span><FileText size={15} /><strong>{t("Task context")}</strong></span>
            <small>{taskSummaries.length}</small>
          </div>
          <ProtocolList
            emptyLabel={t("No context summary for this task")}
            items={taskSummaries}
            renderItem={(summary) => (
              <div className="protocol-row compact" key={summary.id}>
                <strong>{summary.targetId}</strong>
                <small>{summary.summary}</small>
                <button className="secondary-button compact-button" type="button" onClick={() => onCreateTaskFromContextSummary(summary)}>{t("Create task")}</button>
              </div>
            )}
          />
        </div>
      ) : null}
    </section>
  );
}

function ProtocolList<T>({
  emptyLabel,
  items,
  renderItem,
}: {
  readonly emptyLabel: string;
  readonly items: readonly T[];
  readonly renderItem: (item: T) => JSX.Element;
}): JSX.Element {
  if (items.length === 0) {
    return (
      <div className="client-empty-state compact">
        <FileText />
        <span>{emptyLabel}</span>
      </div>
    );
  }
  return <div className="protocol-list">{items.map(renderItem)}</div>;
}

function WorkflowQueueCard({
  workflow,
  steps,
  brief,
  decisions,
  handoff,
  contextSummaries,
  attachments,
  linkPreviews,
  runningWorkflowStepId,
  onStartWorkflowStep,
  onUpdateWorkflowStepStatus,
}: {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly brief: ChannelBrief | undefined;
  readonly decisions: readonly ChannelDecision[];
  readonly handoff: ChannelHandoff | undefined;
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly attachments: readonly ChannelAttachment[];
  readonly linkPreviews: readonly ChannelLinkPreview[];
  readonly runningWorkflowStepId: string;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
}): JSX.Element {
  const { t } = useI18n();
  const orderedSteps = [...steps].sort((left, right) => left.position - right.position);
  const workflowContextSummaries = contextSummaries.filter((summary) => orderedSteps.some((step) => step.contextSummaryId === summary.id));
  return (
    <div className="protocol-row workflow-queue-card">
      <div className="workflow-queue-head">
        <span>
          <strong>{workflow.title}</strong>
          <small>{workflow.status} · {workflow.objective}</small>
        </span>
        <StatusBadge status={workflow.status} />
      </div>
      <div className="context-packet">
        {brief?.objective ? <span>{t("Brief")}: {brief.objective}</span> : null}
        {handoff ? <span>{t("Source handoff")}: {handoff.fromParticipantLabel} {"->"} {handoff.toParticipantLabel}</span> : null}
        <span>{t("Active decisions")}: {decisions.length}</span>
        <span>{t("Context summaries")}: {workflowContextSummaries.length}</span>
        <span>{t("Attachments")}: {attachments.length}</span>
        <span>{t("Links")}: {linkPreviews.length}</span>
      </div>
      <div className="workflow-step-list">
        {orderedSteps.length === 0 ? (
          <div className="client-empty-state compact">
            <Workflow />
            <span>{t("No workflow steps")}</span>
          </div>
        ) : (
          orderedSteps.map((step) => (
            <WorkflowStepCard
              key={step.id}
              step={step}
              running={runningWorkflowStepId === step.id}
              contextSummary={contextSummaries.find((summary) => summary.id === step.contextSummaryId)}
              onStartWorkflowStep={onStartWorkflowStep}
              onUpdateWorkflowStepStatus={onUpdateWorkflowStepStatus}
            />
          ))
        )}
      </div>
    </div>
  );
}

function WorkflowStepCard({
  step,
  running,
  contextSummary,
  onStartWorkflowStep,
  onUpdateWorkflowStepStatus,
}: {
  readonly step: ChannelWorkflowStep;
  readonly running: boolean;
  readonly contextSummary: ChannelContextSummary | undefined;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
}): JSX.Element {
  const { t } = useI18n();
  const terminal = isWorkflowStepTerminal(step.status);
  const canStart = step.status === "queued" || step.status === "blocked";
  const canSkip = step.status === "queued";
  return (
    <article className="workflow-step-card compact">
      <div className="workflow-step-head">
        <span>
          <strong>{step.position}. {step.title}</strong>
          <small>{step.toParticipantLabel} · {step.prompt}</small>
        </span>
        <StatusBadge status={step.status} />
      </div>
      {contextSummary ? (
        <div className="context-packet muted">
          <span>{t("Context summary")}: {contextSummary.summary}</span>
        </div>
      ) : null}
      {step.blocker ? (
        <div className="provider-run-notice compact">
          <CircleAlert size={14} />
          <span>{step.blocker}</span>
        </div>
      ) : null}
      {step.taskId || step.runId || step.resultSummary ? (
        <div className="context-packet muted">
          {step.taskId ? <code>{step.taskId}</code> : null}
          {step.runId ? <code>{step.runId}</code> : null}
          {step.resultSummary ? <span>{step.resultSummary}</span> : null}
        </div>
      ) : null}
      <div className="activity-action-row">
        <button className="secondary-button compact-button" type="button" onClick={() => onStartWorkflowStep(step, "create_task")} disabled={!canStart || running}>
          {running ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
          {t("Start step")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onStartWorkflowStep(step, "create_and_run_task")} disabled={!canStart || running}>
          {running ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
          {t("Start + run")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onUpdateWorkflowStepStatus(step, "skipped")} disabled={!canSkip || running}>
          {t("Skip")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onUpdateWorkflowStepStatus(step, "cancelled")} disabled={terminal || running}>
          {t("Cancel")}
        </button>
      </div>
    </article>
  );
}

function NewTaskPanel({
  taskForm,
  selectedChannel,
  effectiveProviderId,
  taskReadyProviders,
  setupChatProviders,
  mediaProviders,
  providersLoading,
  onProviderSelect,
  onTaskFormChange,
  onCreateTask,
  onCancel,
}: {
  readonly taskForm: TaskFormState;
  readonly selectedChannel: Channel | undefined;
  readonly effectiveProviderId: string;
  readonly taskReadyProviders: readonly ProviderPreset[];
  readonly setupChatProviders: readonly ProviderPreset[];
  readonly mediaProviders: readonly ProviderPreset[];
  readonly providersLoading: boolean;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onCreateTask: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="task-create-panel">
      <div className="panel-title split">
        <span>
          <Plus size={17} />
          <h2>{t("New task")}</h2>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
      <label className="field wide">
        <span>{t("Run provider")}</span>
        <select value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providersLoading}>
          <option value="">{t("Select provider preset")}</option>
          <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
        </select>
      </label>
      <label className="field wide">
        <span>{t("Title")}</span>
        <input value={taskForm.title} onChange={(event) => onTaskFormChange({ ...taskForm, title: event.target.value })} />
      </label>
      <label className="field wide">
        <span>{t("Prompt")}</span>
        <textarea value={taskForm.prompt} rows={7} onChange={(event) => onTaskFormChange({ ...taskForm, prompt: event.target.value })} />
      </label>
      {mediaProviders.length > 0 ? (
        <div className="provider-run-notice neutral client-provider-notice">
          <Database size={16} />
          <span>{t("Media providers stay in Media Jobs and cannot run coding tasks.")}</span>
        </div>
      ) : null}
      <div className="composer-footer">
        <div className="tool-token-list" aria-label={t("Tool calls")}>
          {(selectedChannel?.allowedTools ?? defaultTools).map((tool) => (
            <span key={tool} className={riskyTools.includes(tool) ? "tool-token risky" : "tool-token"}>{tool}</span>
          ))}
        </div>
        <button className="primary-button" type="button" onClick={onCreateTask} disabled={!selectedChannel || !taskForm.prompt.trim()}>
          <Send size={15} />
          {t("Create task")}
        </button>
      </div>
    </div>
  );
}

function TaskDetailPanel({
  task,
  channels,
  runById,
  activeRunId,
  latestStatus,
  pendingApprovalCount,
  effectiveProvider,
  providerBlocker,
  isRunning,
  activeTaskRunAction,
  taskActionPending,
  activeLeaseCount,
  decisions,
  contextSummaries,
  workflows,
  workflowSteps,
  onCreateHandoffFromTask,
  onCreateTaskFromContextSummary,
  onCheckThenRunTask,
  onRunTask,
  onOpenRun,
  onOpenApprovals,
  onOpenProviders,
}: {
  readonly task: Task;
  readonly channels: readonly Channel[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly pendingApprovalCount: number;
  readonly effectiveProvider: ProviderPreset | undefined;
  readonly providerBlocker: string | undefined;
  readonly isRunning: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly taskActionPending: boolean;
  readonly activeLeaseCount: number;
  readonly decisions: readonly ChannelDecision[];
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly onCreateHandoffFromTask: (task: Task) => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
}): JSX.Element {
  const { t } = useI18n();
  const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
  const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
  const linkedRunSucceeded = linkedRunStatus === "succeeded";
  const repairHint = buildRunRepairHint(linkedRun, pendingApprovalCount, linkedRunStatus, "", t);
  const taskChannel = channels.find((channel) => channel.id === task.channelId);
  const taskChannelPaused = taskChannel?.status !== undefined && taskChannel.status !== "active";
  const blockedByLease = activeLeaseCount > 0 && (!linkedRun || linkedRun.status !== "running");
  const checkRunLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "check";
  const runLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "run";
  const taskActionsDisabled = isRunning || taskActionPending;
  const taskSummaries = contextSummaries.filter((summary) => summary.targetType === "task" && summary.targetId === task.id);
  const activeDecisions = decisions.filter((decision) => decision.status === "active");
  const sourceWorkflowStep = workflowSteps.find((step) => step.taskId === task.id);
  const sourceWorkflow = sourceWorkflowStep ? workflows.find((workflow) => workflow.id === sourceWorkflowStep.workflowId) : undefined;

  return (
    <article className="client-task-card task-detail selected" aria-label={t("Task detail")}>
      <div className="task-detail-head">
        <span className="client-task-kicker">{t("Task detail")}</span>
        <span className={`task-status ${task.status}`}>{t(task.status)}</span>
      </div>
      <div className="task-detail-copy">
        <h2>{task.title}</h2>
        <p>{task.prompt}</p>
      </div>
      <div className="task-detail-meta">
        <span>
          <Hash size={13} />
          {taskChannel?.name ?? task.channelId}
        </span>
        <span>
          <Command size={13} />
          {effectiveProvider?.displayName ?? t("No model selected")}
        </span>
        <span>
          <Clock3 size={13} />
          {formatDateTime(task.updatedAt)}
        </span>
      </div>
      {task.currentRunId ? (
        <div className={linkedRunSucceeded ? "task-run-link compact succeeded" : "task-run-link compact"}>
          <StatusBadge status={linkedRunStatus} />
          <span className="task-run-summary">
            {linkedRunSucceeded ? <strong>{t("Task complete")}</strong> : null}
            <span>{t("Latest run")}</span>
          </span>
          <button className={linkedRunSucceeded ? "primary-button compact-button" : "secondary-button compact-button"} type="button" onClick={() => onOpenRun(task.currentRunId ?? "")}>
            {linkedRunSucceeded ? <CheckCircle2 size={14} /> : <History size={14} />}
            {linkedRunSucceeded ? t("View result") : t("Open run")}
          </button>
        </div>
      ) : null}
      {task.currentRunId && repairHint ? (
        <RunRepairHintBanner
          hint={repairHint}
          runId={task.currentRunId}
          compact
          onOpenProviders={() => onOpenProviders(linkedRun)}
          onOpenApprovals={onOpenApprovals}
          onOpenRun={onOpenRun}
        />
      ) : null}
      {providerBlocker ? (
        <div className="provider-run-notice">
          <CircleAlert size={16} />
          <span>{providerBlocker}</span>
        </div>
      ) : null}
      {taskChannelPaused || blockedByLease ? (
        <div className="task-run-link compact">
          <StatusBadge status={taskChannelPaused ? (taskChannel?.status ?? "blocked") : "blocked"} />
          <span>{taskChannelPaused ? t("Channel is not active") : t("Active resource lock")}</span>
        </div>
      ) : null}
      {activeDecisions.length > 0 || taskSummaries.length > 0 ? (
        <div className="task-context-strip">
          {activeDecisions.slice(0, 3).map((decision) => (
            <span key={decision.id} className="glass-chip ok">
              <FileCheck2 size={13} />
              {decision.title}
            </span>
          ))}
          {taskSummaries.map((summary) => (
            <button key={summary.id} className="secondary-button compact-button" type="button" onClick={() => onCreateTaskFromContextSummary(summary)}>
              <FileText size={13} />
              {t("Context summary")}
            </button>
          ))}
        </div>
      ) : null}
      {sourceWorkflowStep ? (
        <div className="task-run-link compact">
          <StatusBadge status={sourceWorkflowStep.status} />
          <span>
            {t("Source workflow")}: {sourceWorkflow?.title ?? sourceWorkflowStep.workflowId} / {sourceWorkflowStep.title}
          </span>
        </div>
      ) : null}
      <div className="task-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => onCreateHandoffFromTask(task)}>
          <Workflow size={14} />
          {t("Create handoff")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(task)} disabled={taskActionsDisabled || !effectiveProvider || !canUseProviderForRun(effectiveProvider)}>
          {checkRunLoading ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          {t("Check & run")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onRunTask(task)} disabled={taskActionsDisabled || Boolean(providerBlocker) || taskChannelPaused}>
          {runLoading ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
          {t("Run")}
        </button>
      </div>
    </article>
  );
}

function MessageBubble({
  tone = "chat",
  avatar,
  author,
  tag,
  time,
  body,
  metaAction,
  action,
}: {
  readonly tone?: MessageBubbleTone;
  readonly avatar: JSX.Element;
  readonly author: string;
  readonly tag?: string;
  readonly time: string;
  readonly body: string;
  readonly metaAction?: JSX.Element;
  readonly action?: JSX.Element;
}): JSX.Element {
  const inlineAuthor = tone === "chat" || tone === "chat-blocked";
  return (
    <article className={`message-bubble message-bubble-${tone}${inlineAuthor ? " message-bubble-inline" : ""}`}>
      {inlineAuthor ? null : avatar}
      <div className="message-content">
        <div className="message-meta">
          {inlineAuthor ? avatar : null}
          <strong>{author}</strong>
          {tag ? <small>{tag}</small> : null}
          <time>{time}</time>
          {metaAction ? <span className="message-meta-action">{metaAction}</span> : null}
        </div>
        <p>{renderMessageBody(body)}</p>
        {action ? <div className="message-action">{action}</div> : null}
      </div>
    </article>
  );
}

function ChannelExecutionProposalCard({
  proposal,
  assigneeLabel,
  teammates,
  linkedRun,
  activeRunId,
  latestStatus,
  onConfirm,
  onCancel,
  onOpenRun,
}: {
  readonly proposal: ChannelExecutionProposal;
  readonly assigneeLabel: string;
  readonly teammates: readonly ChannelMention[];
  readonly linkedRun: RunSession | undefined;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onOpenRun: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const canStart = proposal.status === "draft" || proposal.status === "blocked" || proposal.status === "run_failed";
  const linkedRunStatus = proposal.linkedRunId
    ? displayLinkedRunStatus(proposal.linkedRunId, linkedRun, activeRunId, latestStatus)
    : "";
  const statusIcon = proposal.status === "accepted"
    ? <CheckCircle2 size={14} />
    : proposal.status === "blocked" || proposal.status === "run_failed"
      ? <CircleAlert size={14} />
      : <Play size={14} />;

  return (
    <div className={`channel-execution-proposal ${proposal.status}`} aria-label={t("Execution proposal")}>
      <div className="channel-proposal-head">
        <span>
          {statusIcon}
          <strong>{proposal.title}</strong>
        </span>
        <small>{t(executionProposalStatusLabel(proposal.status))}</small>
      </div>
      <p>{proposal.prompt}</p>
      <div className="channel-proposal-meta">
        <span>{t("Assignee")}: <strong>{assigneeLabel}</strong></span>
        {proposal.requiredTools.length > 0 ? <span>{t("Required tools")}: {proposal.requiredTools.join(", ")}</span> : null}
        {linkedRunStatus ? <StatusBadge status={linkedRunStatus} /> : null}
      </div>
      {proposal.acceptanceCriteria.length > 0 ? (
        <div className="channel-proposal-criteria">
          <strong>{t("Acceptance criteria")}</strong>
          <ul>
            {proposal.acceptanceCriteria.slice(0, 4).map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {proposal.riskSummary ? (
        <div className="channel-proposal-risk">
          <CircleAlert size={14} />
          <span>{proposal.riskSummary}</span>
        </div>
      ) : null}
      {proposal.errorMessage ? (
        <div className="channel-proposal-error">
          <CircleAlert size={14} />
          <span>{proposal.errorMessage}</span>
        </div>
      ) : null}
      {proposal.collaborationSteps.length > 0 ? (
        <details className="channel-proposal-collaboration">
          <summary>
            <span>
              <History size={14} />
              {t("Collaboration")}
            </span>
            <small>{proposal.collaborationSteps.length}</small>
          </summary>
          <ol>
            {proposal.collaborationSteps.map((step, index) => (
              <li key={`${step.teammateId}-${step.action}-${index}`}>
                <strong>{teammateLabel(step.teammateId, teammates)}</strong>
                <small>{t(proposalStepActionLabel(step.action))}</small>
                <span>{step.summary}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <div className="channel-proposal-actions">
        {canStart ? (
          <button className="primary-button compact-button" type="button" onClick={onConfirm}>
            <Play size={14} />
            {t("Start handling")}
          </button>
        ) : null}
        {proposal.linkedRunId ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(proposal.linkedRunId ?? "")}>
            <SquareTerminal size={14} />
            {t("Open run")}
          </button>
        ) : null}
        {proposal.status === "draft" ? (
          <button className="secondary-button compact-button" type="button" onClick={onCancel}>
            <X size={14} />
            {t("Cancel proposal")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ThreadReplyPanel({
  rootMessage,
  replies,
  teammates,
  draft,
  pending,
  error,
  onDraftChange,
  onSend,
  onClose,
}: {
  readonly rootMessage: ChannelMessage;
  readonly replies: readonly ChannelMessage[];
  readonly teammates: readonly ChannelMention[];
  readonly draft: string;
  readonly pending: boolean;
  readonly error: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const canSend = draft.trim().length > 0 && !pending;
  return (
    <aside className="thread-reply-panel" aria-label={t("Topic replies")}>
      <div className="thread-reply-head">
        <span>
          <Reply size={15} />
          <strong>{t("Topic replies")}</strong>
        </span>
        <button className="icon-button" type="button" onClick={onClose} aria-label={t("Close topic")}>
          <X size={14} />
        </button>
      </div>
      <div className="thread-root-message">
        <small>{t("Topic started by {author}", { author: messageAuthorLabel(rootMessage, teammates) })}</small>
        <p>{renderMessageBody(rootMessage.body)}</p>
      </div>
      <div className="thread-reply-list" aria-label={t("Replies")}>
        {replies.length === 0 ? (
          <div className="thread-empty-state">{t("No replies yet")}</div>
        ) : replies.map((reply) => (
          <article key={reply.id} className="thread-reply-item">
            <div className="thread-reply-meta">
              <strong>{messageAuthorLabel(reply, teammates)}</strong>
              {reply.kind === "ai_reply" ? <small>AI</small> : null}
              <time>{formatDateTime(reply.createdAt)}</time>
            </div>
            <p>{renderMessageBody(reply.body)}</p>
          </article>
        ))}
      </div>
      <div className="thread-reply-composer">
        <textarea
          value={draft}
          rows={3}
          onChange={(event) => onDraftChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={t("Reply in this topic")}
          aria-label={t("Topic reply input")}
        />
        {error ? (
          <div className="composer-status-row failed" role="alert">
            <CircleAlert size={14} />
            <span>{t("Message failed")}: {error}</span>
          </div>
        ) : null}
        <button className="primary-button compact-button" type="button" onClick={onSend} disabled={!canSend}>
          {pending ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
          {pending ? t("Sending...") : t("Send reply")}
        </button>
      </div>
    </aside>
  );
}

function renderMessageBody(body: string): ReactNode {
  return body.split(/(@[A-Za-z0-9][A-Za-z0-9_.-]*)/g).map((part, index) => {
    if (part.startsWith("@")) {
      return <span key={`${part}-${index}`} className="message-mention-token">{part}</span>;
    }
    return part;
  });
}

function ActivityFilterToolbar({
  search,
  categoryFilter,
  attentionFilter,
  savedViews,
  activeSavedViewId,
  filtersExpanded,
  savedViewCounts,
  selectedSavedView,
  categoryCounts,
  attentionCounts,
  clearDisabled,
  customViewLimitReached,
  onSavedViewSelect,
  onSaveView,
  onRenameView,
  onDeleteView,
  onFiltersExpandedChange,
  onSearchChange,
  onCategoryFilterChange,
  onAttentionFilterChange,
  onClear,
}: {
  readonly search: string;
  readonly categoryFilter: ActivityCategoryFilter;
  readonly attentionFilter: ActivityAttentionFilter;
  readonly savedViews: readonly ChannelActivitySavedView[];
  readonly activeSavedViewId: string;
  readonly filtersExpanded: boolean;
  readonly savedViewCounts: Readonly<Record<string, number>>;
  readonly selectedSavedView: ChannelActivitySavedView | undefined;
  readonly categoryCounts: Readonly<Record<ActivityCategoryFilter, number>>;
  readonly attentionCounts: Readonly<Record<Exclude<ActivityAttentionFilter, "all">, number>>;
  readonly clearDisabled: boolean;
  readonly customViewLimitReached: boolean;
  readonly onSavedViewSelect: (view: ChannelActivitySavedView) => void;
  readonly onSaveView: () => void;
  readonly onRenameView: () => void;
  readonly onDeleteView: () => void;
  readonly onFiltersExpandedChange: (expanded: boolean) => void;
  readonly onSearchChange: (value: string) => void;
  readonly onCategoryFilterChange: (filter: ActivityCategoryFilter) => void;
  readonly onAttentionFilterChange: (filter: ActivityAttentionFilter) => void;
  readonly onClear: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const selectedCustomView = selectedSavedView && !selectedSavedView.builtin;
  const filterSummaryParts = [
    categoryFilter !== "all" ? t(activityCategoryFilterLabel(categoryFilter)) : "",
    attentionFilter !== "all" ? t(activityAttentionFilterLabel(attentionFilter)) : "",
  ].filter(Boolean);
  const filterSummary = filterSummaryParts.length > 0 ? filterSummaryParts.join(" · ") : t("All activity");
  return (
    <div className="activity-filter-toolbar" aria-label={t("Activity filters")}>
      <div className="activity-view-control" aria-label={t("Saved views")}>
        <label className="activity-view-select">
          <span>{t("View")}</span>
          <select
            aria-label={t("Saved views")}
            value={activeSavedViewId}
            onChange={(event) => {
              const view = savedViews.find((candidate) => candidate.id === event.target.value);
              if (view) {
                onSavedViewSelect(view);
              }
            }}
          >
            {savedViews.map((view) => (
              <option key={view.id} value={view.id}>
                {savedViewLabel(view, t)} ({savedViewCounts[view.id] ?? 0})
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="activity-search-field">
        <Search size={14} />
        <input
          aria-label={t("Search activity")}
          placeholder={t("Search activity")}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>
      <button
        className={filtersExpanded ? "activity-filter-toggle active" : "activity-filter-toggle"}
        type="button"
        aria-expanded={filtersExpanded}
        aria-label={t("Filter activity")}
        onClick={() => onFiltersExpandedChange(!filtersExpanded)}
      >
        <SlidersHorizontal size={14} />
        <span>{t("Filters")}</span>
        <small>{filterSummary}</small>
      </button>
      <button className="secondary-button compact-button activity-clear-filter" type="button" onClick={onClear} disabled={clearDisabled}>
        <X size={13} />
        {t("Clear")}
      </button>
      {filtersExpanded ? (
        <div className="activity-filter-panel" aria-label={t("Filter panel")}>
          <div className="activity-saved-view-actions" aria-label={t("Saved view actions")}>
            <button className="secondary-button compact-button" type="button" onClick={onSaveView} disabled={customViewLimitReached}>
              <Plus size={13} />
              {t("Save view")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onRenameView} disabled={!selectedCustomView}>
              <FileText size={13} />
              {t("Rename")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onDeleteView} disabled={!selectedCustomView}>
              <Trash2 size={13} />
              {t("Delete view")}
            </button>
          </div>
          <div className="activity-filter-group activity-category-filters" aria-label={t("Activity categories")}>
            {activityCategoryFilters.map((filter) => (
              <button
                key={filter}
                type="button"
                className={categoryFilter === filter ? "activity-filter-chip active" : "activity-filter-chip"}
                aria-pressed={categoryFilter === filter}
                onClick={() => onCategoryFilterChange(filter)}
              >
                <span>{t(activityCategoryFilterLabel(filter))}</span>
                <small>{categoryCounts[filter]}</small>
              </button>
            ))}
          </div>
          <div className="activity-filter-group activity-attention-filters" aria-label={t("Activity attention filters")}>
            {activityAttentionFilters.map((filter) => (
              <button
                key={filter}
                type="button"
                className={attentionFilter === filter ? "activity-filter-chip active attention" : "activity-filter-chip attention"}
                aria-pressed={attentionFilter === filter}
                onClick={() => onAttentionFilterChange(attentionFilter === filter ? "all" : filter)}
              >
                <span>{t(activityAttentionFilterLabel(filter))}</span>
                <small>{attentionCounts[filter]}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AttentionQueue({
  items,
  expanded,
  onExpandedChange,
  onOpenItem,
  onOpenItemDetails,
}: {
  readonly items: readonly ChannelAttentionQueueItem[];
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onOpenItem: (item: ChannelAttentionQueueItem) => void;
  readonly onOpenItemDetails: (item: ChannelAttentionQueueItem) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const blockedCount = items.filter((item) => item.attention === "blocked").length;
  const failedCount = items.filter((item) => item.attention === "failed").length;
  const pendingCount = items.filter((item) => item.attention === "pending").length;
  const visibleItems = items.slice(0, 5);
  if (items.length === 0) {
    return null;
  }
  return (
    <section className="attention-queue compact" aria-label={t("Attention queue")}>
      <button
        className="attention-queue-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        <CircleAlert size={14} />
        <strong>{t("Attention")} · {items.length}</strong>
        <span>{items.length > 0 ? t("{count} items need attention", { count: items.length }) : t("No attention items")}</span>
        <span className="attention-queue-counts" aria-label={t("Attention counts")}>
          <small className="blocked">{t("Blocked")} {blockedCount}</small>
          <small className="failed">{t("Failed")} {failedCount}</small>
          <small className="pending">{t("Pending")} {pendingCount}</small>
        </span>
        <span className="attention-queue-toggle">{expanded ? t("Collapse") : t("Expand")}</span>
      </button>
      {expanded ? (
        <div className="attention-queue-list" aria-label={t("Top attention items")}>
          {visibleItems.map((item) => (
            <div
              key={item.id}
              className={`attention-queue-item ${item.attention}`}
            >
              <button className="attention-queue-item-open" type="button" onClick={() => onOpenItem(item)}>
                <span className="attention-queue-item-main">
                  <strong>{t(item.title)}</strong>
                  <small>{t(item.description)}</small>
                </span>
                <span className="attention-queue-item-meta">
                  <small>{t(activityAttentionDisplayLabel(item.attention))}</small>
                  <small>{t(attentionQueueTargetLabel(item.target))}</small>
                  <time>{formatDateTime(item.createdAt)}</time>
                </span>
              </button>
              <button className="secondary-button compact-button attention-queue-details" type="button" onClick={() => onOpenItemDetails(item)}>
                <Info size={13} />
                {t("Details")}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ActivityDrilldownDrawer({
  drilldown,
  defaultTeammateId,
  activeDecisionIds,
  onClose,
  onOpenTarget,
  onRunTriageAction,
  onOpenTriageResult,
}: {
  readonly drilldown: ChannelActivityDrilldownItem;
  readonly defaultTeammateId?: string;
  readonly activeDecisionIds: readonly string[];
  readonly onClose: () => void;
  readonly onOpenTarget: (target: ChannelActivityDrilldownTarget) => void;
  readonly onRunTriageAction: (draft: ChannelActivityTriageDraft) => Promise<ChannelActivityTriageResult>;
  readonly onOpenTriageResult: (result: ChannelActivityTriageResult) => void;
}): JSX.Element {
  const { t } = useI18n();
  const triageActions = useMemo(() => buildChannelActivityTriageActions(drilldown), [drilldown]);
  const [selectedTriageActionId, setSelectedTriageActionId] = useState<ChannelActivityTriageActionKind | "">("");
  const [triageDraft, setTriageDraft] = useState<ChannelActivityTriageDraft | undefined>();
  const [triagePending, setTriagePending] = useState(false);
  const [triageError, setTriageError] = useState("");
  const [triageResult, setTriageResult] = useState<ChannelActivityTriageResult | undefined>();
  const selectedTriageAction = triageActions.find((action) => action.id === selectedTriageActionId);

  useEffect(() => {
    setSelectedTriageActionId("");
    setTriageDraft(undefined);
    setTriagePending(false);
    setTriageError("");
    setTriageResult(undefined);
  }, [drilldown.id]);

  function selectTriageAction(action: ChannelActivityTriageAction): void {
    setSelectedTriageActionId(action.id);
    setTriageDraft(buildChannelActivityTriageDraft({
      drilldown,
      actionKind: action.id,
      defaultTeammateId,
      activeDecisionIds,
    }));
    setTriageError("");
    setTriageResult(undefined);
  }

  function updateTriageDraft(field: string, value: string): void {
    setTriageDraft((current) => current ? { ...current, [field]: value } as ChannelActivityTriageDraft : current);
  }

  async function submitTriageAction(): Promise<void> {
    if (!triageDraft || !channelActivityTriageDraftIsValid(triageDraft)) {
      return;
    }
    setTriagePending(true);
    setTriageError("");
    try {
      const result = await onRunTriageAction(triageDraft);
      setTriageResult(result);
    } catch (error) {
      setTriageError(error instanceof Error ? error.message : String(error));
    } finally {
      setTriagePending(false);
    }
  }

  return (
    <aside className="activity-drilldown-drawer" aria-label={t("Activity details")}>
      <div className="activity-drilldown-header">
        <span>
          <Info size={16} />
          <strong>{t("Activity details")}</strong>
        </span>
        <button className="icon-button" type="button" onClick={onClose} aria-label={t("Close details")}>
          <X size={15} />
        </button>
      </div>
      <div className="activity-drilldown-title">
        <small>{t(activityKindLabel(drilldown.kind))}</small>
        <h3>{t(drilldown.source.title)}</h3>
        <p>{t(drilldown.source.subtitle)}</p>
      </div>
      <section className="activity-drilldown-section">
        <h4>{t("Source summary")}</h4>
        <p>{drilldown.source.summary}</p>
      </section>
      <section className="activity-drilldown-section">
        <h4>{t("Actions")}</h4>
        {drilldown.targets.length === 0 ? (
          <p className="muted-text">{t("No direct target")}</p>
        ) : (
          <div className="activity-drilldown-actions">
            {drilldown.targets.map((target, index) => (
              <button
                key={`${target.kind}:${index}`}
                className="secondary-button compact-button"
                type="button"
                onClick={() => onOpenTarget(target)}
              >
                {drilldownTargetIcon(target)}
                {t(drilldownTargetLabel(target))}
              </button>
            ))}
          </div>
        )}
      </section>
      <details className="activity-drilldown-disclosure">
        <summary>
          <span>{t("Source metadata")}</span>
        </summary>
        <div className="activity-drilldown-badges" aria-label={t("Activity detail metadata")}>
          <span>{t("Category")}: {t(activityCategoryFilterLabel(drilldown.category))}</span>
          <span>{t("Attention")}: {t(activityAttentionLabel(drilldown.attention))}</span>
          <span>{t("Time")}: {formatDateTime(drilldown.createdAt)}</span>
          {drilldown.source.status ? <span>{t("Status")}: {drilldown.source.status}</span> : null}
        </div>
        <div className="activity-drilldown-field-grid">
          <MetaRow label={t("Source ID")} value={drilldown.source.sourceId} />
          <MetaRow label={t("Event type")} value={t(activityKindLabel(drilldown.kind))} />
          {drilldown.source.metadata.map((field) => (
            <MetaRow key={`${field.label}:${field.value}`} label={t(field.label)} value={field.value} />
          ))}
        </div>
      </details>
      <details className="activity-drilldown-disclosure">
        <summary>
          <span>{t("Related objects")}</span>
        </summary>
        {drilldown.source.relatedObjects.length === 0 ? (
          <p className="muted-text">{t("No related objects")}</p>
        ) : (
          <div className="activity-drilldown-related">
            {drilldown.source.relatedObjects.map((field) => (
              <span key={`${field.label}:${field.value}`}>
                <small>{t(field.label)}</small>
                {field.value}
              </span>
            ))}
          </div>
        )}
      </details>
      <details className="activity-drilldown-disclosure activity-triage-section" aria-label={t("Triage actions")}>
        <summary>
          <span>{t("Triage actions")}</span>
          {triageActions.length > 0 ? <small>{triageActions.length}</small> : null}
        </summary>
        {triageActions.length === 0 ? (
          <p className="muted-text">{t("No triage actions available")}</p>
        ) : (
          <>
            <div className="activity-triage-action-picker" role="tablist" aria-label={t("Triage action picker")}>
              {triageActions.map((action) => (
                <button
                  key={action.id}
                  className={selectedTriageActionId === action.id ? "active" : ""}
                  type="button"
                  onClick={() => selectTriageAction(action)}
                >
                  {triageActionIcon(action.id)}
                  <span>{t(action.label)}</span>
                </button>
              ))}
            </div>
            {selectedTriageAction ? (
              <p className="activity-triage-description">{t(selectedTriageAction.description)}</p>
            ) : (
              <p className="activity-triage-description">{t("Choose a triage action to continue.")}</p>
            )}
            {triageDraft ? (
              <ActivityTriageDraftForm
                draft={triageDraft}
                disabled={triagePending}
                onChange={updateTriageDraft}
              />
            ) : null}
            {triageError ? (
              <div className="activity-triage-error" role="alert">
                <CircleAlert size={14} />
                <span>{t("Triage action failed")}: {triageError}</span>
                <button className="secondary-button compact-button" type="button" onClick={() => void submitTriageAction()}>
                  {t("Retry")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={() => setTriageError("")}>
                  {t("Dismiss")}
                </button>
              </div>
            ) : null}
            {triageResult ? (
              <div className="activity-triage-result" role="status">
                <CheckCircle2 size={14} />
                <span>{t("Triage action created")}: {channelActivityTriageResultLabel(triageResult)}</span>
                <button className="secondary-button compact-button" type="button" onClick={() => onOpenTriageResult(triageResult)}>
                  {t(activityTriageResultTargetLabel(triageResult))}
                </button>
              </div>
            ) : null}
            {triageDraft ? (
              <button
                className="primary-button compact-button activity-triage-submit"
                type="button"
                onClick={() => void submitTriageAction()}
                disabled={triagePending || !channelActivityTriageDraftIsValid(triageDraft)}
              >
                {triagePending ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                {triagePending ? t("Creating...") : t("Run triage action")}
              </button>
            ) : null}
          </>
        )}
      </details>
    </aside>
  );
}

function ActivityTriageDraftForm({
  draft,
  disabled,
  onChange,
}: {
  readonly draft: ChannelActivityTriageDraft;
  readonly disabled: boolean;
  readonly onChange: (field: string, value: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  if (draft.actionKind === "follow_up_task") {
    return (
      <div className="activity-triage-form">
        <label className="field wide">
          <span>{t("Triage title")}</span>
          <input value={draft.title} disabled={disabled} onChange={(event) => onChange("title", event.target.value)} />
        </label>
        <label className="field wide">
          <span>{t("Triage prompt")}</span>
          <textarea rows={5} value={draft.prompt} disabled={disabled} onChange={(event) => onChange("prompt", event.target.value)} />
        </label>
      </div>
    );
  }
  if (draft.actionKind === "handoff") {
    return (
      <div className="activity-triage-form">
        <label className="field wide">
          <span>{t("Reason")}</span>
          <input value={draft.reason} disabled={disabled} onChange={(event) => onChange("reason", event.target.value)} />
        </label>
        <div className="activity-triage-two-up">
          <label className="field">
            <span>{t("To participant")}</span>
            <input value={draft.toParticipantId} disabled={disabled} onChange={(event) => onChange("toParticipantId", event.target.value)} />
          </label>
          <label className="field">
            <span>{t("Participant label")}</span>
            <input value={draft.toParticipantLabel} disabled={disabled} onChange={(event) => onChange("toParticipantLabel", event.target.value)} />
          </label>
        </div>
        <label className="field wide">
          <span>{t("Required input")}</span>
          <textarea rows={5} value={draft.requiredInput} disabled={disabled} onChange={(event) => onChange("requiredInput", event.target.value)} />
        </label>
        <label className="field wide">
          <span>{t("Expected output")}</span>
          <textarea rows={3} value={draft.expectedOutput} disabled={disabled} onChange={(event) => onChange("expectedOutput", event.target.value)} />
        </label>
      </div>
    );
  }
  if (draft.actionKind === "decision") {
    return (
      <div className="activity-triage-form">
        <label className="field wide">
          <span>{t("Triage title")}</span>
          <input value={draft.title} disabled={disabled} onChange={(event) => onChange("title", event.target.value)} />
        </label>
        <label className="field wide">
          <span>{t("Decision text")}</span>
          <textarea rows={4} value={draft.decision} disabled={disabled} onChange={(event) => onChange("decision", event.target.value)} />
        </label>
        <label className="field wide">
          <span>{t("Rationale")}</span>
          <textarea rows={3} value={draft.rationale} disabled={disabled} onChange={(event) => onChange("rationale", event.target.value)} />
        </label>
      </div>
    );
  }
  return (
    <div className="activity-triage-form">
      <label className="field wide">
        <span>{t("Summary")}</span>
        <textarea rows={5} value={draft.summary} disabled={disabled} onChange={(event) => onChange("summary", event.target.value)} />
      </label>
      <label className="field wide">
        <span>{t("Acceptance criteria")}</span>
        <textarea rows={3} value={draft.acceptanceCriteria} disabled={disabled} onChange={(event) => onChange("acceptanceCriteria", event.target.value)} />
      </label>
      <label className="field wide">
        <span>{t("Open questions")}</span>
        <textarea rows={3} value={draft.openQuestions} disabled={disabled} onChange={(event) => onChange("openQuestions", event.target.value)} />
      </label>
    </div>
  );
}

function taskFilterLabel(filter: TaskFilter): string {
  if (filter === "queued") {
    return "Queued";
  }
  if (filter === "running") {
    return "Running";
  }
  if (filter === "review") {
    return "Needs review";
  }
  if (filter === "done") {
    return "Done";
  }
  return "All";
}

function activityAttentionDisplayLabel(attention: Exclude<ChannelActivityAttention, "none">): string {
  if (attention === "blocked") {
    return "Blocked";
  }
  if (attention === "failed") {
    return "Failed";
  }
  return "Pending";
}

function attentionQueueTargetLabel(target: ChannelAttentionQueueTarget): string {
  if (target.kind === "task") {
    return "Task";
  }
  if (target.kind === "run") {
    return "Run";
  }
  if (target.kind === "approval") {
    return "Approval";
  }
  return "Context";
}

function activityKindLabel(kind: ChannelActivityDrilldownItem["kind"]): string {
  if (kind === "message") {
    return "Message";
  }
  if (kind === "decision") {
    return "Decision log";
  }
  if (kind === "handoff") {
    return "Handoff";
  }
  if (kind === "summary") {
    return "Context summary";
  }
  if (kind === "workflow") {
    return "Workflow";
  }
  if (kind === "workflow-step") {
    return "Workflow step";
  }
  if (kind === "task") {
    return "Task event";
  }
  if (kind === "run") {
    return "Run event";
  }
  if (kind === "approval") {
    return "Approval event";
  }
  return "State change";
}

function activityAttentionLabel(attention: ChannelActivityAttention): string {
  if (attention === "none") {
    return "None";
  }
  return activityAttentionDisplayLabel(attention);
}

function drilldownTargetLabel(target: ChannelActivityDrilldownTarget): string {
  if (target.kind === "task") {
    return "Open task";
  }
  if (target.kind === "run") {
    return "Open run";
  }
  if (target.kind === "approval") {
    return "Open approval";
  }
  return "Open context";
}

function drilldownTargetIcon(target: ChannelActivityDrilldownTarget): JSX.Element {
  if (target.kind === "task") {
    return <SquareTerminal size={14} />;
  }
  if (target.kind === "run") {
    return <History size={14} />;
  }
  if (target.kind === "approval") {
    return <CheckCircle2 size={14} />;
  }
  return <Workflow size={14} />;
}

function triageActionIcon(action: ChannelActivityTriageActionKind): JSX.Element {
  if (action === "follow_up_task") {
    return <SquareTerminal size={14} />;
  }
  if (action === "handoff") {
    return <Workflow size={14} />;
  }
  if (action === "decision") {
    return <FileCheck2 size={14} />;
  }
  return <FileText size={14} />;
}

function activityTriageResultTargetLabel(result: ChannelActivityTriageResult): string {
  return result.kind === "task" ? "Open in Tasks" : "Open in Context";
}

function activityCategoryFilterLabel(filter: ActivityCategoryFilter): string {
  if (filter === "message") {
    return "Messages";
  }
  if (filter === "work") {
    return "Work";
  }
  if (filter === "approval") {
    return "Approvals";
  }
  if (filter === "protocol") {
    return "Protocol";
  }
  if (filter === "runtime") {
    return "Runtime";
  }
  return "All";
}

function activityAttentionFilterLabel(filter: ActivityAttentionFilter): string {
  if (filter === "all") {
    return "All";
  }
  if (filter === "needs_attention") {
    return "Needs attention";
  }
  if (filter === "blocked") {
    return "Blocked";
  }
  if (filter === "failed") {
    return "Failed";
  }
  return "Pending";
}

function savedViewLabel(view: ChannelActivitySavedView, t: (key: string) => string): string {
  return view.builtin ? t(view.name) : view.name;
}

function taskMatchesFilter(filter: TaskFilter, task: Task, linkedRunStatus: string): boolean {
  if (filter === "queued") {
    return task.status === "todo";
  }
  if (filter === "running") {
    return task.status === "running" || task.status === "claimed" || linkedRunStatus === "running" || linkedRunStatus === "queued";
  }
  if (filter === "review") {
    return task.status === "failed" || task.status === "blocked" || task.status === "review" || linkedRunStatus === "failed" || linkedRunStatus === "waiting_for_approval";
  }
  if (filter === "done") {
    return task.status === "done" || linkedRunStatus === "succeeded";
  }
  return true;
}

function isWorkflowStepTerminal(status: ChannelWorkflowStep["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled";
}

function ChannelFiles({
  attachments,
  linkPreviews,
  runs,
  tasks,
  artifactsByRun,
  artifactErrorsByRun,
  loading,
  runArtifactsLoading,
  attachmentContentUrl,
  onDeleteAttachment,
}: {
  readonly attachments: readonly ChannelAttachment[];
  readonly linkPreviews: readonly ChannelLinkPreview[];
  readonly runs: readonly RunSession[];
  readonly tasks: readonly Task[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly artifactErrorsByRun: Readonly<Record<string, string>>;
  readonly loading: boolean;
  readonly runArtifactsLoading: boolean;
  readonly attachmentContentUrl: (attachment: ChannelAttachment) => string;
  readonly onDeleteAttachment: (attachmentId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const totalRunArtifactCount = runs.reduce((count, run) => count + (artifactsByRun[run.id]?.length ?? 0), 0);

  if (loading) {
    return (
      <div className="client-empty-state channel-files">
        <Loader2 className="spin" />
        <span>{t("Loading files...")}</span>
      </div>
    );
  }

  return (
    <section className="channel-files" aria-label={t("Files")}>
      <div className="file-section">
        <div className="task-strip-head">
          <span>
            <FileText size={16} />
            <strong>{t("Attachments")}</strong>
          </span>
        </div>
        {attachments.length === 0 ? (
          <div className="client-empty-state">
            <FileText />
            <span>{t("No attachments in this channel")}</span>
          </div>
        ) : (
          <div className="file-grid">
            {attachments.map((attachment) => (
              <article key={attachment.id} className="file-card">
                <span className="file-icon">{attachment.kind === "image" ? <ImageIcon size={18} /> : <FileText size={18} />}</span>
                <span>
                  <strong>{attachment.fileName}</strong>
                  <small>{attachment.kind} · {formatBytes(attachment.sizeBytes)}</small>
                </span>
                <a className="secondary-button compact-button" href={attachmentContentUrl(attachment)} target="_blank" rel="noreferrer">{t("Open")}</a>
                <button className="icon-button" type="button" onClick={() => onDeleteAttachment(attachment.id)} aria-label={t("Delete attachment")}>
                  <Trash2 size={14} />
                </button>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="file-section">
        <div className="task-strip-head">
          <span>
            <Link2 size={16} />
            <strong>{t("Links")}</strong>
          </span>
        </div>
        {linkPreviews.length === 0 ? (
          <div className="client-empty-state">
            <Link2 />
            <span>{t("No shared links in this channel")}</span>
          </div>
        ) : (
          <div className="file-grid">
            {linkPreviews.map((preview) => (
              <a key={preview.id} className={`link-card ${preview.status}`} href={preview.normalizedUrl} target="_blank" rel="noreferrer">
                <span>
                  <strong>{preview.title ?? preview.normalizedUrl}</strong>
                  <small>{preview.status === "ready" ? preview.description ?? preview.siteName ?? preview.normalizedUrl : preview.errorMessage}</small>
                </span>
                <span className={`task-status ${preview.status === "ready" ? "done" : "blocked"}`}>{preview.status}</span>
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="file-section run-artifact-section">
        <div className="task-strip-head">
          <span>
            <FileCheck2 size={16} />
            <strong>{t("Run artifacts")}</strong>
          </span>
          <small>{t("{count} artifacts", { count: totalRunArtifactCount })}</small>
        </div>
        {runArtifactsLoading ? (
          <div className="client-empty-state">
            <Loader2 className="spin" />
            <span>{t("Loading run artifacts...")}</span>
          </div>
        ) : runs.length === 0 ? (
          <div className="client-empty-state">
            <FileCheck2 />
            <span>{t("No run artifacts in this channel")}</span>
          </div>
        ) : (
          <div className="run-artifact-groups">
            {runs.map((run) => {
              const runArtifacts = artifactsByRun[run.id] ?? [];
              const task = taskById.get(run.taskId);
              const artifactError = artifactErrorsByRun[run.id];
              const artifactCwd = readRunWorkspaceCwd(run, run.cwd);
              return (
                <article key={run.id} className="run-artifact-group">
                  <div className="run-artifact-head">
                    <span>
                      <strong>{task?.title ?? run.taskId}</strong>
                      <small>{run.status} · {formatDateTime(run.updatedAt)}</small>
                    </span>
                    <StatusBadge status={run.status} />
                  </div>
                  <details className="json-details compact-json">
                    <summary>{t("Debug details")}</summary>
                    <div className="session-file-list compact">
                      <span>{t("Event log")}</span>
                      <code>{run.eventLogPath}</code>
                      <span>{t("Summary")}</span>
                      <code>{run.summaryPath ?? "-"}</code>
                    </div>
                  </details>
                  {artifactError ? (
                    <div className="artifact-empty-state error">
                      <span>{t("Could not load artifacts")}</span>
                      <small>{artifactError}</small>
                    </div>
                  ) : runArtifacts.length === 0 ? (
                    <div className="artifact-empty-state">
                      <span>{t("No artifacts recorded for this run")}</span>
                      <small>{t("Artifacts will appear here once the daemon records files under .ling-stack/artifacts.")}</small>
                    </div>
                  ) : (
                    <div className="artifact-list">
                      {runArtifacts.map((artifact) => (
                        <ArtifactRow artifact={artifact} cwd={artifactCwd} key={artifact.id} />
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function messageAuthorLabel(message: ChannelMessage, teammates: readonly ChannelMention[]): string {
  if (message.authorType === "system") {
    return "Ling Stack";
  }
  if (message.authorType === "ai-teammate") {
    return teammateLabel(message.authorId, teammates, "AI teammate");
  }
  return message.authorId ?? "Tian";
}

function teammateLabel(teammateId: string | undefined, teammates: readonly ChannelMention[], fallback = "AI teammate"): string {
  if (!teammateId) {
    return fallback;
  }
  return teammates.find((teammate) => teammate.id === teammateId)?.label ?? teammateId;
}

function executionProposalStatusLabel(status: ChannelExecutionProposal["status"]): string {
  if (status === "draft") {
    return "Ready for confirmation";
  }
  if (status === "accepted") {
    return "Accepted";
  }
  if (status === "blocked") {
    return "Proposal blocked";
  }
  if (status === "run_failed") {
    return "Run failed";
  }
  if (status === "superseded") {
    return "Superseded";
  }
  return "Cancelled";
}

function proposalStepActionLabel(action: ChannelExecutionProposal["collaborationSteps"][number]["action"]): string {
  if (action === "coordinated") {
    return "Coordinated";
  }
  if (action === "consulted") {
    return "Consulted";
  }
  if (action === "reviewed") {
    return "Reviewed";
  }
  return "Flagged risk";
}

function findMentionsInText(body: string, teammates: readonly ChannelMention[]): readonly ChannelMention[] {
  const tokens = new Set(
    Array.from(body.matchAll(/@([A-Za-z0-9][A-Za-z0-9_.-]*)/g), (match) => match[1].toLowerCase()),
  );
  if (tokens.size === 0) {
    return [];
  }
  return teammates.filter((teammate) => tokens.has(teammate.label.toLowerCase()) || tokens.has(teammate.id.toLowerCase()));
}

function channelNotificationLevelLabel(level: ChannelNotificationLevel): string {
  if (level === "all") {
    return "All activity";
  }
  if (level === "muted") {
    return "Muted";
  }
  return "Mentions and approvals";
}

function channelNotificationLevelDescription(level: ChannelNotificationLevel): string {
  if (level === "all") {
    return "Notify for messages, tasks, runs, files, and approvals.";
  }
  if (level === "muted") {
    return "Only critical approval blockers can surface.";
  }
  return "Notify for @mentions, approval requests, and blockers.";
}

function readChannelNotificationLevel(cwd: string, channelId: string): ChannelNotificationLevel {
  try {
    const value = globalThis.localStorage?.getItem(channelNotificationStorageKey(cwd, channelId));
    return isChannelNotificationLevel(value) ? value : "mentions";
  } catch {
    return "mentions";
  }
}

function writeChannelNotificationLevel(cwd: string, channelId: string, level: ChannelNotificationLevel): void {
  try {
    globalThis.localStorage?.setItem(channelNotificationStorageKey(cwd, channelId), level);
  } catch {
    // Local notification preferences are best-effort browser state.
  }
}

function channelNotificationStorageKey(cwd: string, channelId: string): string {
  return `ling-stack.channelNotifications.${encodeURIComponent(cwd)}.${encodeURIComponent(channelId)}`;
}

function isChannelNotificationLevel(value: string | null | undefined): value is ChannelNotificationLevel {
  return value === "all" || value === "mentions" || value === "muted";
}

function readRunTitle(run: RunSession): string {
  if (typeof run.taskSnapshot === "object" && run.taskSnapshot !== null && "title" in run.taskSnapshot) {
    const title = (run.taskSnapshot as { readonly title?: unknown }).title;
    if (typeof title === "string" && title.trim()) {
      return title;
    }
  }
  return run.taskId;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s)]+/g) ?? [];
  return [...new Set(matches.map((item) => item.replace(/[.,;!?]+$/, "")))];
}

function findActiveMention(value: string, caret: number): ActiveMentionPicker | undefined {
  const beforeCaret = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(beforeCaret);
  if (!match) {
    return undefined;
  }
  const query = match[2] ?? "";
  return {
    query,
    start: caret - query.length - 1,
    end: caret,
  };
}

function insertMentionToken(value: string, picker: ActiveMentionPicker | undefined, label: string): { readonly value: string; readonly caret: number } {
  const start = Math.max(0, Math.min(picker?.start ?? value.length, value.length));
  const end = Math.max(start, Math.min(picker?.end ?? value.length, value.length));
  const prefix = value.slice(0, start);
  const suffix = value.slice(end).replace(/^\s+/, "");
  const mention = `@${label}`;
  return {
    value: `${prefix}${mention}${suffix ? ` ${suffix}` : " "}`,
    caret: prefix.length + mention.length + 1,
  };
}

function pendingAssetLabel(state: PendingAssetState): string {
  if (state === "uploading") {
    return "Uploading";
  }
  if (state === "blocked") {
    return "Blocked";
  }
  if (state === "failed") {
    return "Failed";
  }
  return "Ready";
}

function pendingPreviewLabel(state: PendingAssetState): string {
  if (state === "uploading") {
    return "Fetching link preview...";
  }
  return pendingAssetLabel(state);
}

function createLocalId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomId}`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
