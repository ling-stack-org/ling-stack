import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
  Activity,
  ArrowDown,
  AtSign,
  Bell,
  BellOff,
  ChevronDown,
  ChevronUp,
  Check,
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
  ListChecks,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  UserPlus,
  Workflow,
  X,
} from "lucide-react";
import type { AiTeammateTemplate } from "@ling-stack/core";
import { useI18n, type Translate } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { buildChannelActivityItems, type ChannelActivityAttention, type ChannelActivityItem } from "../../lib/channel-activity.js";
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
import { truncatePreview } from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import { buildRunRepairHint, displayLinkedRunStatus, readRunWorkspaceCwd } from "../../lib/run-evidence.js";
import { defaultTools, riskyTools } from "../../lib/tools.js";
import {
  sessionPermissionModeDescription,
  sessionPermissionModeLabel,
  sessionPermissionModeOptions,
} from "../../lib/session-permissions.js";
import {
  canUseProviderForRun,
  isMediaProvider,
  providerPreflightReady,
  providerRunPreflightBlocker,
} from "../../lib/providers.js";
import { CiTriageAuditPanel } from "../external-work/CiTriageAuditPanel.js";
import {
  ArtifactRow,
  AvatarInitial,
  MetaRow,
  RunRepairHintBanner,
  StatusBadge,
  UsedMemorySummary,
  filterUsedMemoryEventsByResponse,
} from "../../shared/components/index.js";
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
  MemoryObject,
  ProviderPreset,
  ResourceLease,
  RuntimeDiagnosticsResponse,
  RunArtifact,
  RunSession,
  SessionPermissionMode,
  StateTransitionEvent,
  Task,
  TaskFormState,
  TaskRunActionState,
  TeammateChannelMembership,
  UpdateChannelBriefRequest,
  UsedMemoryEvent,
  WorkUnit,
} from "../../types.js";
import { ApprovalCard, type ApprovalResolution } from "../approvals/index.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { ChannelRuntimePolicyFields, ProviderPresetOptions } from "./WorkspaceControls.js";

type ChannelSidePanelView = "progress" | "files" | "context" | "settings" | "task" | "approval";
type ChannelDrawerRootView = Extract<ChannelSidePanelView, "progress" | "files" | "context" | "settings">;
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
  readonly sizeBytes: number;
  readonly state: PendingAssetState;
  readonly previewUrl?: string;
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

const channelSidePanelRootViews: readonly ChannelDrawerRootView[] = ["progress", "files", "context", "settings"];
const activityCategoryFilters: readonly ActivityCategoryFilter[] = ["all", "message", "work", "approval", "protocol", "runtime"];
const activityAttentionFilters: readonly Exclude<ActivityAttentionFilter, "all">[] = ["needs_attention", "blocked", "failed", "pending"];
const channelNotificationLevels: readonly ChannelNotificationLevel[] = ["all", "mentions", "muted"];

function channelSidePanelLabel(view: ChannelSidePanelView): string {
  if (view === "progress") {
    return "Progress";
  }
  if (view === "files") {
    return "Files";
  }
  if (view === "context") {
    return "Context";
  }
  if (view === "settings") {
    return "Settings";
  }
  if (view === "approval") {
    return "Approval details";
  }
  return "Task detail";
}

function channelSidePanelIcon(view: ChannelSidePanelView, size: number): JSX.Element {
  if (view === "progress") {
    return <ListChecks size={size} />;
  }
  if (view === "task") {
    return <SquareTerminal size={size} />;
  }
  if (view === "files") {
    return <FileText size={size} />;
  }
  if (view === "approval") {
    return <ShieldCheck size={size} />;
  }
  if (view === "settings") {
    return <SlidersHorizontal size={size} />;
  }
  return <Workflow size={size} />;
}

function channelActivityVisibleInDefaultChat(item: ChannelActivityItem): boolean {
  return item.kind === "message" || item.kind === "summary";
}

type MessageFeedItem =
  | { readonly id: "older-channel-messages"; readonly kind: "older-loader" }
  | { readonly id: string; readonly kind: "activity"; readonly item: ChannelActivityItem };

export function WorkspaceClientView({
  cwd,
  daemonHealthy,
  providerLabel,
  channels,
  selectedChannelId,
  channelForm,
  channelCreateOpen,
  channelEditForm,
  tasks,
  taskForm,
  channelMessages,
  memoryById,
  usedMemoryEvents,
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
  channelMessagesHasOlder,
  channelMessagesLoadingOlder,
  channelFilesLoading,
  channelRunArtifactsLoading,
  channelProtocolLoading,
  providersLoading,
  approvals,
  approvalsLoading,
  resolvingApprovals,
  resourceLeases,
  runtimeDiagnostics,
  workUnits,
  runtimeLoading,
  runtimeActionWorkUnitId,
  runs,
  runById,
  activeRunId,
  latestStatus,
  isRunning,
  isCancellingRun,
  permissionMode,
  activeTaskRunAction,
  runningWorkflowStepId,
  errorMessage,
  onChannelFormChange,
  onChannelCreateOpenChange,
  onChannelEditFormChange,
  onTaskFormChange,
  onProviderSelect,
  onAddChannelTeammate,
  onRemoveChannelTeammate,
  onSetDefaultChannelTeammate,
  onOpenTeammates,
  onRefreshChannels,
  onCreateChannel,
  onSaveChannel,
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
  onLoadOlderChannelMessages,
  onRefreshChannelActivity,
  onRefreshExternalWorkCiTriage,
  onRefreshChannelProtocol,
  onRefreshChannelFiles,
  attachmentContentUrl,
  onRefreshTasks,
  onSelectTask,
  onCheckThenRunTask,
  onRunTask,
  onPermissionModeChange,
  onCancelActiveRun,
  onOpenRun,
  onOpenApprovals,
  onRefreshRunApprovals,
  onRefreshRuntime,
  onCancelWorkUnit,
  onRetryWorkUnit,
  onReconcileWorkUnit,
  onResolveApproval,
  onOpenProviders,
}: {
  readonly cwd: string;
  readonly daemonHealthy: boolean | undefined;
  readonly providerLabel: string;
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly channelForm: ChannelFormState;
  readonly channelCreateOpen: boolean;
  readonly channelEditForm: ChannelFormState;
  readonly tasks: readonly Task[];
  readonly taskForm: TaskFormState;
  readonly channelMessages: readonly ChannelMessage[];
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
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
  readonly channelMessagesHasOlder: boolean;
  readonly channelMessagesLoadingOlder: boolean;
  readonly channelFilesLoading: boolean;
  readonly channelRunArtifactsLoading: boolean;
  readonly channelProtocolLoading: boolean;
  readonly providersLoading: boolean;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly resourceLeases: readonly ResourceLease[];
  readonly runtimeDiagnostics: RuntimeDiagnosticsResponse | undefined;
  readonly workUnits: readonly WorkUnit[];
  readonly runtimeLoading: boolean;
  readonly runtimeActionWorkUnitId: string;
  readonly runs: readonly RunSession[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly isRunning: boolean;
  readonly isCancellingRun: boolean;
  readonly permissionMode: SessionPermissionMode;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly runningWorkflowStepId: string;
  readonly errorMessage: string;
  readonly onChannelFormChange: (form: ChannelFormState) => void;
  readonly onChannelCreateOpenChange: (open: boolean) => void;
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onAddChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onRemoveChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onSetDefaultChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onOpenTeammates: () => void;
  readonly onRefreshChannels: () => void;
  readonly onCreateChannel: () => void;
  readonly onSaveChannel: () => void;
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
  readonly onLoadOlderChannelMessages: () => void;
  readonly onRefreshChannelActivity: () => void;
  readonly onRefreshExternalWorkCiTriage: () => void;
  readonly onRefreshChannelProtocol: () => void;
  readonly onRefreshChannelFiles: () => void;
  readonly attachmentContentUrl: (attachment: ChannelAttachment) => string;
  readonly onRefreshTasks: () => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onPermissionModeChange: (mode: SessionPermissionMode) => void;
  readonly onCancelActiveRun: (run?: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onRefreshRunApprovals: () => void;
  readonly onRefreshRuntime: () => void;
  readonly onCancelWorkUnit: (workUnitId: string) => void;
  readonly onRetryWorkUnit: (workUnitId: string) => void;
  readonly onReconcileWorkUnit: (workUnitId: string) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const [sidePanelView, setSidePanelView] = useState<ChannelSidePanelView>(() => selectedTaskId ? "task" : "progress");
  const [sidePanelOpen, setSidePanelOpen] = useState(() => Boolean(selectedTaskId));
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [channelMoreOpen, setChannelMoreOpen] = useState(false);
  const [attentionQueueOpen, setAttentionQueueOpen] = useState(true);
  const [attentionProgressExpanded, setAttentionProgressExpanded] = useState(true);
  const [activityToolsOpen, setActivityToolsOpen] = useState(false);
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
  const [messageFeedLatestButtonVisible, setMessageFeedLatestButtonVisible] = useState(false);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageFeedRef = useRef<HTMLDivElement | null>(null);
  const messageFeedPinnedToLatestRef = useRef(true);
  const messageFeedOlderLoadArmedRef = useRef(true);
  const messageFeedOlderLoadSnapshotRef = useRef<{ readonly anchorId: string; readonly anchorOffset: number } | undefined>();
  const channelMoreRef = useRef<HTMLDivElement | null>(null);
  const teammateManagerButtonRef = useRef<HTMLButtonElement | null>(null);
  const teammateManagerPanelRef = useRef<HTMLElement | null>(null);
  const autoPreviewUrlsRef = useRef(new Set<string>());
  const attachmentPreviewUrlsRef = useRef(new Set<string>());
  const previousChannelIdRef = useRef(selectedChannelId);
  const activeRun = activeRunId ? runById.get(activeRunId) : undefined;
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const taskChannelById = useMemo(() => new Map(tasks.map((task) => [task.id, task.channelId])), [tasks]);
  const channelRuns = useMemo(
    () => deriveChannelRuns(selectedChannelId, tasks, runs, activeRun),
    [activeRun, runs, selectedChannelId, tasks],
  );
  const latestRun = channelRuns[0];
  const pendingChannelApprovals = useMemo(() => {
    return approvals.filter((approval) => {
      if (effectiveApprovalStatus(approval) !== "pending") {
        return false;
      }
      const approvalChannelId = approval.channelId
        ?? (approval.runId ? runById.get(approval.runId)?.channelId : undefined)
        ?? (approval.taskId ? taskChannelById.get(approval.taskId) : undefined);
      return approvalChannelId === selectedChannelId;
    });
  }, [approvals, runById, selectedChannelId, taskChannelById]);
  const pendingApprovalCount = pendingChannelApprovals.length;
  const selectedApproval = selectedApprovalId
    ? approvals.find((approval) => approval.id === selectedApprovalId)
    : pendingChannelApprovals[0];
  const readyProvider = providers.find(providerPreflightReady);
  const taskReadyProviders = providers.filter(providerPreflightReady);
  const setupChatProviders = providers.filter((provider) => !isMediaProvider(provider) && !providerPreflightReady(provider));
  const mediaProviders = providers.filter(isMediaProvider);
  const effectiveProviderId = (taskRunProviderId || selectedChannel?.defaultProviderPresetId || fallbackProviderId || readyProvider?.id) ?? "";
  const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const providerBlocker = providerRunPreflightBlocker(effectiveProvider, t);
  const activeLeaseCount = resourceLeases.filter((lease) => lease.status === "active").length;
  const taskActionPending = activeTaskRunAction !== undefined;

  useEffect(() => {
    if (!channelCreateOpen) {
      return;
    }
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
    setActivityToolsOpen(false);
  }, [channelCreateOpen]);

  useEffect(() => {
    if (!channelMoreOpen) {
      return undefined;
    }
    function handlePointerDown(event: MouseEvent): void {
      const target = event.target;
      if (target instanceof Node && channelMoreRef.current?.contains(target)) {
        return;
      }
      setChannelMoreOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setChannelMoreOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [channelMoreOpen]);

  useEffect(() => {
    if (!teammateManagerOpen) {
      return undefined;
    }
    function isInsideTeammateManager(target: EventTarget | null): boolean {
      return Boolean(
        target instanceof Node &&
          (teammateManagerPanelRef.current?.contains(target) || teammateManagerButtonRef.current?.contains(target)),
      );
    }
    function handleOutsidePointer(event: PointerEvent | MouseEvent): void {
      const target = event.target;
      if (isInsideTeammateManager(target)) {
        return;
      }
      setTeammateManagerOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setTeammateManagerOpen(false);
      }
    }
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    document.addEventListener("mousedown", handleOutsidePointer, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      document.removeEventListener("mousedown", handleOutsidePointer, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [teammateManagerOpen]);

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
  const auditActivityVisible = activityToolsOpen || activityFiltersActive;
  const visibleActivityItems = useMemo(
    () => auditActivityVisible ? filteredActivityItems : filteredActivityItems.filter(channelActivityVisibleInDefaultChat),
    [auditActivityVisible, filteredActivityItems],
  );
  const latestVisibleActivityItemId =
    visibleActivityItems.length > 0 ? visibleActivityItems[visibleActivityItems.length - 1]?.id ?? "" : "";
  const messageFeedCanLoadOlder =
    channelMessagesHasOlder && !activityFiltersActive && visibleActivityItems.length > 0;
  const messageFeedItems = useMemo<readonly MessageFeedItem[]>(
    () => [
      ...(messageFeedCanLoadOlder ? [{ id: "older-channel-messages", kind: "older-loader" } satisfies MessageFeedItem] : []),
      ...visibleActivityItems.map((item) => ({ id: item.id, kind: "activity" as const, item })),
    ],
    [messageFeedCanLoadOlder, visibleActivityItems],
  );
  const messageFeedEmpty = !channelMessagesLoading && !channelProtocolLoading && visibleActivityItems.length === 0;
  const messageFeedVirtualizer = useVirtualizer({
    count: messageFeedItems.length,
    getScrollElement: () => messageFeedRef.current,
    estimateSize: (index) => messageFeedItems[index]?.kind === "older-loader" ? 48 : 128,
    overscan: 10,
    getItemKey: (index) => messageFeedItems[index]?.id ?? index,
  });
  const messageFeedVirtualRows = messageFeedVirtualizer.getVirtualItems();
  const firstMessageFeedVirtualIndex = messageFeedVirtualRows[0]?.index ?? -1;
  useEffect(() => {
    if (
      firstMessageFeedVirtualIndex !== 0 ||
      !messageFeedCanLoadOlder ||
      channelMessagesLoading ||
      channelMessagesLoadingOlder ||
      channelProtocolLoading ||
      messageFeedPinnedToLatestRef.current ||
      !messageFeedOlderLoadArmedRef.current ||
      messageFeedOlderLoadSnapshotRef.current
    ) {
      return;
    }
    const feed = messageFeedRef.current;
    if (feed) {
      const anchorRow = messageFeedVirtualRows.find((virtualRow) => messageFeedItems[virtualRow.index]?.kind === "activity");
      const anchorItem = anchorRow ? messageFeedItems[anchorRow.index] : undefined;
      if (anchorRow && anchorItem?.kind === "activity") {
        messageFeedOlderLoadSnapshotRef.current = {
          anchorId: anchorItem.id,
          anchorOffset: anchorRow.start - feed.scrollTop,
        };
      } else {
        const fallbackAnchor = messageFeedItems.find((item) => item.kind === "activity");
        if (fallbackAnchor?.kind === "activity") {
          messageFeedOlderLoadSnapshotRef.current = {
            anchorId: fallbackAnchor.id,
            anchorOffset: 48,
          };
        }
      }
    }
    messageFeedOlderLoadArmedRef.current = false;
    void onLoadOlderChannelMessages();
  }, [
    channelMessagesLoading,
    channelMessagesLoadingOlder,
    channelProtocolLoading,
    firstMessageFeedVirtualIndex,
    messageFeedCanLoadOlder,
    messageFeedItems,
    onLoadOlderChannelMessages,
  ]);
  useEffect(() => {
    if (channelMessagesLoadingOlder) {
      return;
    }
    const snapshot = messageFeedOlderLoadSnapshotRef.current;
    const feed = messageFeedRef.current;
    if (!snapshot || !feed) {
      return;
    }
    const anchorIndex = messageFeedItems.findIndex((item) => item.id === snapshot.anchorId);
    if (anchorIndex < 0) {
      messageFeedOlderLoadSnapshotRef.current = undefined;
      return;
    }
    messageFeedVirtualizer.scrollToIndex(anchorIndex, { align: "start" });
    const frameIds: number[] = [];
    const finishRestore = (): void => {
      messageFeedOlderLoadSnapshotRef.current = undefined;
      messageFeedPinnedToLatestRef.current = false;
      setMessageFeedLatestButtonVisible(feed.scrollHeight > feed.clientHeight);
    };
    const scheduleRestore = (attempt: number): void => {
      messageFeedVirtualizer.scrollToIndex(anchorIndex, { align: "start" });
      const frameId = globalThis.requestAnimationFrame(() => {
        const anchorElement = Array.from(feed.querySelectorAll<HTMLElement>("[data-feed-item-id]"))
          .find((element) => element.dataset.feedItemId === snapshot.anchorId);
        if (anchorElement) {
          const feedTop = feed.getBoundingClientRect().top;
          const anchorTop = anchorElement.getBoundingClientRect().top;
          feed.scrollTop += anchorTop - feedTop - snapshot.anchorOffset;
          finishRestore();
          return;
        }
        if (attempt < 8) {
          scheduleRestore(attempt + 1);
          return;
        }
        finishRestore();
      });
      frameIds.push(frameId);
    };
    scheduleRestore(0);
    return () => {
      frameIds.forEach((frameId) => globalThis.cancelAnimationFrame(frameId));
    };
  }, [channelMessagesLoadingOlder, messageFeedItems, messageFeedVirtualizer]);
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
  const channelRunsForFiles = channelRuns;

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
    messageFeedPinnedToLatestRef.current = true;
    messageFeedOlderLoadArmedRef.current = true;
    messageFeedOlderLoadSnapshotRef.current = undefined;
    setMessageFeedLatestButtonVisible(false);
  }, [cwd, selectedChannelId]);

  useEffect(() => {
    if (channelMessagesLoading || channelProtocolLoading || !messageFeedPinnedToLatestRef.current) {
      return undefined;
    }
    const feed = messageFeedRef.current;
    if (!feed) {
      return undefined;
    }
    const frameIds: number[] = [];
    const scrollToLatest = (attempt: number): void => {
      if (messageFeedItems.length > 0) {
        messageFeedVirtualizer.scrollToIndex(messageFeedItems.length - 1, { align: "end" });
      } else {
        feed.scrollTop = feed.scrollHeight;
      }
      messageFeedPinnedToLatestRef.current = true;
      setMessageFeedLatestButtonVisible(false);
      if (attempt < 4) {
        const frameId = globalThis.requestAnimationFrame(() => scrollToLatest(attempt + 1));
        frameIds.push(frameId);
      }
    };
    const frameId = globalThis.requestAnimationFrame(() => scrollToLatest(0));
    frameIds.push(frameId);
    return () => {
      frameIds.forEach((scheduledFrameId) => globalThis.cancelAnimationFrame(scheduledFrameId));
    };
  }, [
    channelMessagesLoading,
    channelProtocolLoading,
    latestVisibleActivityItemId,
    messageFeedItems.length,
    selectedChannelId,
    visibleActivityItems.length,
  ]);

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
    revokePendingAttachmentPreviews(pendingAttachments);
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
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setAttentionProgressExpanded(true);
    setSidePanelView("progress");
    setSidePanelOpen(false);
    setSelectedApprovalId("");
    setCreateTaskOpen(false);
    setChannelNotificationLevel(readChannelNotificationLevel(cwd, selectedChannelId));
    messageFeedPinnedToLatestRef.current = true;
    messageFeedOlderLoadArmedRef.current = true;
    messageFeedOlderLoadSnapshotRef.current = undefined;
    setMessageFeedLatestButtonVisible(false);
  }, [selectedChannelId]);

  useEffect(() => {
    if (sidePanelOpen && sidePanelView === "files") {
      onRefreshChannelFiles();
    }
  }, [sidePanelOpen, sidePanelView]);

  useEffect(() => {
    if (!selectedTaskId || !selectedTask) {
      return;
    }
    setCreateTaskOpen(false);
    setSidePanelView("task");
    setSidePanelOpen(true);
  }, [selectedTask, selectedTaskId]);

  function selectTask(taskId: string): void {
    setCreateTaskOpen(false);
    setSidePanelView("task");
    setSidePanelOpen(true);
    onSelectTask(taskId);
  }

  function handleMessageFeedScroll(): void {
    const feed = messageFeedRef.current;
    if (!feed) {
      return;
    }
    const maxScrollTop = feed.scrollHeight - feed.clientHeight;
    const pinnedToLatest = maxScrollTop <= 0 || maxScrollTop - feed.scrollTop <= 24;
    if (feed.scrollTop > 80) {
      messageFeedOlderLoadArmedRef.current = true;
    }
    messageFeedPinnedToLatestRef.current = pinnedToLatest;
    setMessageFeedLatestButtonVisible((visible) => {
      const nextVisible = !pinnedToLatest && maxScrollTop > 0;
      return visible === nextVisible ? visible : nextVisible;
    });
  }

  function scrollMessageFeedToLatest(): void {
    const feed = messageFeedRef.current;
    if (!feed) {
      return;
    }
    if (messageFeedItems.length > 0) {
      messageFeedVirtualizer.scrollToIndex(messageFeedItems.length - 1, { align: "end" });
    } else {
      feed.scrollTop = feed.scrollHeight;
    }
    messageFeedPinnedToLatestRef.current = true;
    setMessageFeedLatestButtonVisible(false);
  }

  function openTaskFromActivity(taskId: string): void {
    setActivityToolsOpen(false);
    setChannelMoreOpen(false);
    selectTask(taskId);
  }

  function openRunInPanel(runId: string): void {
    const run = runById.get(runId);
    if (run?.taskId && taskById.has(run.taskId)) {
      selectTask(run.taskId);
      return;
    }
    onOpenRun(runId);
  }

  function openProtocolFromActivity(mode: "brief" | "decisions" | "handoffs" | "runtime" = "runtime"): void {
    setActivityToolsOpen(false);
    setChannelMoreOpen(false);
    setInspectorMode(mode);
    setSidePanelView("context");
    setSidePanelOpen(true);
    if (mode === "runtime") {
      onRefreshRuntime();
    } else {
      onRefreshChannelProtocol();
    }
  }

  function openProgressPanel(): void {
    setSidePanelView("progress");
    setSidePanelOpen(true);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setTeammateManagerOpen(false);
  }

  function openApprovalInPanel(approval: ApprovalRequest | undefined): void {
    if (!approval) {
      onOpenApprovals();
      return;
    }
    setSelectedApprovalId(approval.id);
    setSidePanelView("approval");
    setSidePanelOpen(true);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setTeammateManagerOpen(false);
  }

  function openAttentionQueueItem(item: ChannelAttentionQueueItem): void {
    openAttentionQueueTarget(item.target);
  }

  function openAttentionQueueTarget(target: ChannelAttentionQueueTarget): void {
    if (target.kind === "task") {
      openTaskFromActivity(target.taskId);
      return;
    }
    if (target.kind === "run") {
      openRunInPanel(target.runId);
      return;
    }
    if (target.kind === "approval") {
      openApprovalInPanel(pendingChannelApprovals.find((approval) => approval.runId === target.runId));
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
      openRunInPanel(target.runId);
      return;
    }
    if (target.kind === "approval") {
      openApprovalInPanel(pendingChannelApprovals.find((approval) => approval.runId === target.runId));
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

  function activityActionRow(activityItemId: string, children?: ReactNode): JSX.Element {
    return (
      <div className="activity-action-row">
        {children}
        {auditActivityVisible ? (
          <button className="secondary-button compact-button" type="button" onClick={() => setActivityDrilldownItemId(activityItemId)}>
            <Info size={14} />
            {t("Details")}
          </button>
        ) : null}
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
      approvals={approvals}
      approvalsLoading={approvalsLoading}
      resolvingApprovals={resolvingApprovals}
      effectiveProvider={effectiveProvider}
      providerBlocker={providerBlocker}
      isRunning={isRunning}
      activeTaskRunAction={activeTaskRunAction}
      taskActionPending={taskActionPending}
      activeLeaseCount={activeLeaseCount}
      isCancellingRun={isCancellingRun}
      permissionMode={permissionMode}
      decisions={channelDecisions}
      contextSummaries={channelContextSummaries}
      workflows={channelWorkflows}
      workflowSteps={channelWorkflowSteps}
      onCreateHandoffFromTask={onCreateHandoffFromTask}
      onCreateTaskFromContextSummary={onCreateTaskFromContextSummary}
      onCheckThenRunTask={onCheckThenRunTask}
      onRunTask={onRunTask}
      onPermissionModeChange={onPermissionModeChange}
      onCancelActiveRun={onCancelActiveRun}
      onOpenRun={openRunInPanel}
      onOpenApprovals={onOpenApprovals}
      onRefreshRunApprovals={onRefreshRunApprovals}
      onResolveApproval={onResolveApproval}
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

  const sidePanelLoading = sidePanelView === "task"
    ? tasksLoading
    : sidePanelView === "context"
      ? inspectorMode === "runtime" ? runtimeLoading : channelProtocolLoading
      : sidePanelView === "files"
        ? channelFilesLoading || channelRunArtifactsLoading
        : sidePanelView === "settings"
          ? channelsLoading || channelTeammateMembershipsLoading
          : sidePanelView === "approval"
            ? approvalsLoading
            : channelMessagesLoading || channelProtocolLoading || channelActivityTransitionsLoading || externalWorkCiTriageLoading || tasksLoading;

  function refreshSidePanel(): void {
    if (sidePanelView === "task" || sidePanelView === "progress") {
      onRefreshTasks();
      onRefreshChannelActivity();
      return;
    }
    if (sidePanelView === "context") {
      if (inspectorMode === "runtime") {
        onRefreshRuntime();
      } else {
        onRefreshChannelProtocol();
      }
      return;
    }
    if (sidePanelView === "files") {
      onRefreshChannelFiles();
      return;
    }
    if (sidePanelView === "settings") {
      onRefreshChannels();
      return;
    }
    onRefreshRunApprovals();
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
    const textarea = composerTextareaRef.current;
    const liveValue = textarea?.value ?? messageDraft;
    const liveCaret = textarea?.selectionStart ?? liveValue.length;
    const livePicker = findActiveMention(liveValue, liveCaret);
    const endOfDraftPicker = findActiveMention(liveValue, liveValue.length);
    const picker = chooseMostSpecificMentionPicker([mentionPicker, livePicker, endOfDraftPicker]);
    const inserted = insertMentionToken(liveValue, picker, option.label);
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

  function insertMentionTrigger(): void {
    const textarea = composerTextareaRef.current;
    const start = textarea?.selectionStart ?? messageDraft.length;
    const end = textarea?.selectionEnd ?? start;
    const before = messageDraft.slice(0, start);
    const after = messageDraft.slice(end);
    const insert = before.endsWith("@") ? "" : before.length === 0 || /\s$/.test(before) ? "@" : " @";
    const nextDraft = `${before}${insert}${after}`;
    const nextCursor = before.length + insert.length;
    setMessageDraft(nextDraft);
    updateMentionPicker(nextDraft, nextCursor);
    globalThis.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function handleComposerTextChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    const value = event.currentTarget.value;
    setMessageDraft(value);
    setMessageMentions((current) => mergeMentions(
      current.filter((mention) => mentionTokenExistsInText(value, mention)),
      findMentionsInText(value, teammateOptions),
    ));
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

  function revokePendingAttachmentPreview(item: PendingAttachmentItem | undefined): void {
    if (!item?.previewUrl || !attachmentPreviewUrlsRef.current.has(item.previewUrl)) {
      return;
    }
    revokeObjectUrl(item.previewUrl);
    attachmentPreviewUrlsRef.current.delete(item.previewUrl);
  }

  function revokePendingAttachmentPreviews(items: readonly PendingAttachmentItem[]): void {
    for (const item of items) {
      revokePendingAttachmentPreview(item);
    }
  }

  async function attachFiles(files: FileList | readonly File[]): Promise<void> {
    const selectedFiles = Array.from(files).slice(0, 10);
    if (selectedFiles.length === 0) {
      return;
    }
    const uploadItems = selectedFiles.map((file) => {
      const previewUrl = createAttachmentPreviewUrl(file);
      if (previewUrl) {
        attachmentPreviewUrlsRef.current.add(previewUrl);
      }
      return {
        localId: createLocalId("attachment"),
        fileName: file.name,
        sizeBytes: file.size,
        state: "uploading" as const,
        previewUrl,
      };
    });
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
      revokePendingAttachmentPreviews(pendingAttachments);
      setMessageDraft("");
      setMessageMentions([]);
      setPendingAttachments([]);
      setPendingLinkPreviews([]);
      autoPreviewUrlsRef.current.clear();
      setSendState("idle");
      setSendError("");
      setAiReplyState("idle");
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
    setPendingAttachments((current) => {
      const removed = current.find((item) => item.localId === localId);
      revokePendingAttachmentPreview(removed);
      return current.filter((item) => item.localId !== localId);
    });
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

  useEffect(() => () => {
    for (const previewUrl of attachmentPreviewUrlsRef.current) {
      revokeObjectUrl(previewUrl);
    }
    attachmentPreviewUrlsRef.current.clear();
  }, []);

  const readyAttachmentIds = pendingAttachments.flatMap((item) => item.attachment ? [item.attachment.id] : []);
  const readyLinkPreviewIds = pendingLinkPreviews.flatMap((item) => item.preview ? [item.preview.id] : []);
  const composerHasSendableContent = messageDraft.trim().length > 0 || readyAttachmentIds.length > 0 || readyLinkPreviewIds.length > 0;
  const assetOperationPending = pendingAttachments.some((item) => item.state === "uploading") || pendingLinkPreviews.some((item) => item.state === "uploading");
  const pendingMessageAssetsVisible = pendingAttachments.length > 0 || pendingLinkPreviews.length > 0 || messageMentions.length > 0;

  function renderMessageFeedActivityItem(item: ChannelActivityItem): ReactNode {
    if (item.kind === "message") {
      const message = item.record;
      const plainChatMessage = message.kind === "message" || message.kind === "ai_reply";
      const executionProposals = executionProposalsByMessageId.get(message.id) ?? [];
      const messageUsedMemoryEvents = filterUsedMemoryEventsByResponse(usedMemoryEvents, message.id);
      const usedMemorySummary = messageUsedMemoryEvents.length > 0 ? (
        <UsedMemorySummary compact events={messageUsedMemoryEvents} memoryById={memoryById} />
      ) : undefined;
      const nonChatAction = message.linkedTaskId
        ? activityActionRow(item.id, <code>{message.linkedTaskId}</code>)
        : activityActionRow(item.id);
      return (
        <div className="message-group">
          <MessageBubble
            tone={message.status === "blocked" ? "chat-blocked" : plainChatMessage ? "chat" : "system"}
            side={plainChatMessage && message.authorType === "local-user" ? "end" : "start"}
            avatar={<AvatarInitial label={message.authorType === "ai-teammate" ? "A" : message.authorType === "system" ? "S" : "T"} tone={message.authorType === "ai-teammate" ? "teal" : message.authorType === "system" ? "violet" : undefined} />}
            author={messageAuthorLabel(message, teammateOptions)}
            tag={message.kind === "ai_reply" ? "AI" : message.kind === "task_link" ? "Task" : undefined}
            time={formatDateTime(message.createdAt)}
            body={message.body}
            metaAction={plainChatMessage ? (
              <button className="message-reply-button" type="button" onClick={() => openThreadForMessage(message)} aria-label={t("Reply in topic")} data-tooltip={t("Reply in topic")}>
                <Reply size={11} />
              </button>
            ) : undefined}
            action={plainChatMessage ? usedMemorySummary : nonChatAction}
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
              onOpenRun={openRunInPanel}
            />
          ))}
        </div>
      );
    }
    if (item.kind === "decision") {
      const decision = item.record;
      return (
        <MessageBubble
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
                <span>{t("Task linked")}</span>
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
          tone="work"
          avatar={<AvatarInitial label="R" tone="violet" />}
          author={t("Run event")}
          tag={run.status}
          time={formatDateTime(run.endedAt ?? run.startedAt ?? run.updatedAt)}
          body={t("Run for {title} is {status}.", { title: taskTitle, status: run.status })}
          action={
            activityActionRow(item.id, (
              <button className="secondary-button compact-button" type="button" onClick={() => openRunInPanel(run.id)}>
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
          tone="approval"
          avatar={<AvatarInitial label="A" tone="teal" />}
          author={t("Approval event")}
          tag={approvalStatus}
          time={formatDateTime(approval.resolvedAt ?? approval.createdAt)}
          body={t("{title} is {status}.", { title: approval.title, status: approvalStatus })}
          action={
            activityActionRow(item.id, (
              <button className="secondary-button compact-button" type="button" onClick={() => openApprovalInPanel(approval)}>
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
                    openRunInPanel(transition.entityId);
                  } else if (transition.entityType === "approval") {
                    openApprovalInPanel(approvals.find((approval) => approval.id === transition.entityId));
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
  }

  function renderMessageFeedItem(feedItem: MessageFeedItem | undefined): ReactNode {
    if (!feedItem) {
      return null;
    }
    if (feedItem.kind === "older-loader") {
      return (
        <div className="message-feed-loader-row" role="status">
          {channelMessagesLoadingOlder ? <Loader2 className="spin" size={14} /> : <ChevronUp size={14} />}
          <span>{channelMessagesLoadingOlder ? t("Loading earlier messages...") : t("Scroll up to load earlier messages")}</span>
        </div>
      );
    }
    return renderMessageFeedActivityItem(feedItem.item);
  }

  const channelComposer = (
    <section className="composer-panel channel-composer" aria-label={t("Channel composer")}>
      <div
        className={composerDragActive ? "composer-drop-zone active" : "composer-drop-zone"}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
      >
        {pendingMessageAssetsVisible ? (
          <div className="pending-assets composer-preview-strip" aria-label={t("Pending message assets")}>
            {pendingAttachments.map((item) => (
              <div key={item.localId} className={`composer-preview-card ${item.previewUrl ? "image" : "file"} ${item.state}`}>
                {item.previewUrl ? (
                  <img className="composer-preview-thumbnail" src={item.previewUrl} alt={item.fileName} />
                ) : (
                  <span className="composer-preview-file-icon" aria-hidden="true">
                    <FileText size={17} />
                  </span>
                )}
                <span className="composer-preview-body">
                  <strong title={item.fileName}>{item.fileName}</strong>
                  <small>{item.error ?? `${t(pendingAssetLabel(item.state))} · ${formatBytes(item.attachment?.sizeBytes ?? item.sizeBytes)}`}</small>
                </span>
                {item.state === "uploading" ? <Loader2 className="composer-preview-state-icon spin" size={13} /> : null}
                <button className="composer-preview-remove" type="button" onClick={() => removePendingAttachment(item.localId)} aria-label={t("Remove pending attachment")}>
                  <X size={13} />
                </button>
              </div>
            ))}
            {pendingLinkPreviews.map((item) => (
              <div key={item.localId} className={`composer-preview-card link ${item.state}`}>
                <span className="composer-preview-file-icon" aria-hidden="true">
                  {item.state === "uploading" ? <Loader2 className="spin" size={15} /> : <Link2 size={16} />}
                </span>
                <span className="composer-preview-body">
                  <strong title={item.preview?.title ?? item.url}>{item.preview?.title ?? item.url}</strong>
                  <small>{item.error ?? t(pendingPreviewLabel(item.state))}</small>
                </span>
                <button className="composer-preview-remove" type="button" onClick={() => removePendingLinkPreview(item.localId)} aria-label={t("Remove pending link preview")}>
                  <X size={13} />
                </button>
              </div>
            ))}
            {messageMentions.map((mention) => (
              <span key={mention.id} className="pending-asset composer-preview-mention ready">
                @{mention.label}
                <small>{t("Mention")}</small>
                <button type="button" onClick={() => removeMessageMention(mention.id)} aria-label={t("Remove pending mention")}>
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={composerTextareaRef}
          value={messageDraft}
          rows={3}
          onChange={handleComposerTextChange}
          onKeyDown={handleComposerKeyDown}
          onPaste={handleComposerPaste}
          onSelect={(event) => updateMentionPicker(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
          placeholder={t("Message this channel or @ an AI teammate")}
          aria-label={t("Message this channel or @ an AI teammate")}
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
        <div className="composer-tool-row" aria-label={t("Message tools")}>
          <label className="icon-button composer-tool-button composer-attach-button" aria-label={t("Attach files")} title={t("Attach files")}>
            <Plus size={17} />
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
          <button className="icon-button composer-tool-button" type="button" onClick={insertMentionTrigger} disabled={!selectedChannelId || composerBusy} aria-label={t("Mention teammate")} title={t("Mention teammate")}>
            <AtSign size={16} />
          </button>
        </div>
        <button className="primary-button composer-send-button" type="button" onClick={() => void sendMessage()} disabled={!selectedChannelId || composerBusy || assetOperationPending || !composerHasSendableContent} aria-label={sendState === "sending" ? t("Sending...") : t("Send")} title={sendState === "sending" ? t("Sending...") : t("Send")}>
          {sendState === "sending" ? <Loader2 className="spin" size={15} /> : <Send size={15} />}
        </button>
      </div>
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
        <div>
          <strong>{t("Current channel teammates")}</strong>
          <small>
            {channelTeammateMembershipsLoading
              ? t("Loading teammates...")
              : t("{count} teammates collaborate in this channel. Manage add, remove, and default response teammates here.", { count: channelTeammates.length })}
          </small>
        </div>
      </div>
      {channelTeammates.length === 0 ? (
        <div className="client-empty-state channel-teammate-empty">
          <MessageSquare size={18} />
          <span>{localTeammates.length === 0 ? t("Create a workspace teammate before assigning channel members.") : t("No teammates in this channel")}</span>
        </div>
      ) : (
        <div className="channel-teammate-list" role="list">
          {channelTeammates.map(({ isDefault, teammate }) => {
            const saving = channelTeammateSavingId === teammate.id;
            return (
              <article key={teammate.id} className={isDefault ? "channel-teammate-chip default" : "channel-teammate-chip"} role="listitem">
                <button
                  className="channel-teammate-chip-main"
                  type="button"
                  aria-pressed={isDefault}
                  title={isDefault ? t("Default teammate") : t("Set default")}
                  onClick={() => {
                    if (!saving && !isDefault) {
                      void onSetDefaultChannelTeammate(teammate.id);
                    }
                  }}
                  disabled={saving}
                >
                  <AvatarInitial label={teammate.displayName.slice(0, 1).toUpperCase() || "A"} tone={isDefault ? "teal" : "gray"} />
                  <strong>{teammate.displayName}</strong>
                </button>
                <button className="channel-teammate-remove-button" type="button" aria-label={t("Remove from channel")} title={t("Remove from channel")} onClick={() => void onRemoveChannelTeammate(teammate.id)} disabled={saving}>
                  {saving ? <Loader2 className="spin" size={13} /> : <X size={13} />}
                </button>
              </article>
            );
          })}
        </div>
      )}
      <div className="channel-teammate-add-row">
        <label className="channel-teammate-select">
          <select
            aria-label={t("Add teammate")}
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
          {t("Add")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={onOpenTeammates}>
          <Plus size={14} />
          {t("Open AI Teammates")}
        </button>
      </div>
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

  const channelHasChatContent = channelMessages.length > 0 || channelContextSummaries.length > 0;
  const attentionProgressItems = channelHasChatContent
    ? [
        selectedTask ? `${selectedTask.title} · ${t(selectedTask.status)}` : "",
        latestRun ? `${t("Latest run")} · ${t(latestRun.status)}` : "",
        pendingApprovalCount > 0 ? t("{count} pending approvals", { count: pendingApprovalCount }) : t("Waiting for proposal confirmation"),
      ].filter(Boolean)
    : [];

  function openSidePanelView(view: ChannelDrawerRootView): void {
    setSidePanelView(view);
    setSidePanelOpen(true);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
    if (view === "files") {
      onRefreshChannelFiles();
    } else if (view === "context") {
      onRefreshChannelProtocol();
    } else if (view === "settings") {
      onRefreshChannels();
    } else {
      onRefreshTasks();
      onRefreshChannelActivity();
    }
  }

  const channelManagementPanel = (
    <section className="channel-settings-card channel-management-panel" aria-label={t("Channel management")}>
      <div className="channel-settings-section-head">
        <span>
          <SlidersHorizontal size={15} />
          <strong>{t("Current channel")}</strong>
        </span>
        <small>{t("Provider, path, and runtime")}</small>
      </div>
      <div className="channel-options-grid">
        <label className="field wide">
          <span>{t("Run provider")}</span>
          <select value={channelEditForm.defaultProviderPresetId} onChange={(event) => onChannelEditFormChange({ ...channelEditForm, defaultProviderPresetId: event.target.value })} disabled={providersLoading || providers.length === 0 || !selectedChannelId}>
            <option value="">{t("Select provider preset")}</option>
            <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
          </select>
        </label>
        <label className="field wide">
          <span>{t("Name")}</span>
          <input value={channelEditForm.name} onChange={(event) => onChannelEditFormChange({ ...channelEditForm, name: event.target.value })} disabled={!selectedChannelId} />
        </label>
        <label className="field wide">
          <span>{t("Execution path")}</span>
          <input value={channelEditForm.boundPath} onChange={(event) => onChannelEditFormChange({ ...channelEditForm, boundPath: event.target.value })} disabled={!selectedChannelId} />
        </label>
        <label className="field wide">
          <span>{t("Default AI teammate")}</span>
          <select value={channelEditForm.defaultTeammateId} onChange={(event) => onChannelEditFormChange({ ...channelEditForm, defaultTeammateId: event.target.value })} disabled={!selectedChannelId}>
            <option value="">{t("No default teammate")}</option>
            {teammateOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <ChannelRuntimePolicyFields form={channelEditForm} onChange={onChannelEditFormChange} />
        <div className="channel-option-actions">
          <button className="secondary-button compact-button" type="button" onClick={onRefreshChannels} disabled={channelsLoading}>
            {channelsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
            {t("Refresh channels")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={onSaveChannel} disabled={!selectedChannelId}>
            <FileCheck2 size={14} />
            {t("Save channel")}
          </button>
        </div>
      </div>
    </section>
  );

  const sidePanelTitle = createTaskOpen && sidePanelView === "task" ? t("New task") : t(channelSidePanelLabel(sidePanelView));
  const sidePanelContent = sidePanelView === "progress" ? (
    <ChannelProgressPanel
      selectedTask={selectedTask}
      latestRun={latestRun}
      pendingApprovals={pendingChannelApprovals}
      attentionItems={attentionQueueItems}
      proposals={channelExecutionProposals}
      teammates={teammateOptions}
      externalWorkCiTriage={externalWorkCiTriage}
      externalWorkCiTriageLoading={externalWorkCiTriageLoading}
      channelHasChatContent={channelHasChatContent}
      onOpenTask={openTaskFromActivity}
      onOpenRun={openRunInPanel}
      onOpenApproval={openApprovalInPanel}
      onOpenContext={() => openProtocolFromActivity("runtime")}
      onRefreshExternalWorkCiTriage={onRefreshExternalWorkCiTriage}
    />
  ) : sidePanelView === "files" ? (
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
  ) : sidePanelView === "context" ? (
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
        runtimeDiagnostics={runtimeDiagnostics}
        workUnits={workUnits}
        attachments={channelAttachments}
        linkPreviews={channelLinkPreviews}
        runningWorkflowStepId={runningWorkflowStepId}
        loading={channelProtocolLoading}
        runtimeLoading={runtimeLoading}
        runtimeActionWorkUnitId={runtimeActionWorkUnitId}
        selectedTask={selectedTask}
        onSupersedeDecision={onSupersedeDecision}
        onRejectDecision={onRejectDecision}
        onUpdateHandoffStatus={onUpdateHandoffStatus}
        onStartWorkflowFromHandoff={onStartWorkflowFromHandoff}
        onStartWorkflowStep={onStartWorkflowStep}
        onUpdateWorkflowStepStatus={onUpdateWorkflowStepStatus}
        onCreateTaskFromContextSummary={onCreateTaskFromContextSummary}
        onRefreshRuntime={onRefreshRuntime}
        onCancelWorkUnit={onCancelWorkUnit}
        onRetryWorkUnit={onRetryWorkUnit}
        onReconcileWorkUnit={onReconcileWorkUnit}
      />
    </div>
  ) : sidePanelView === "settings" ? (
    <div className="channel-settings-stack">
      {channelNotificationPanel}
      {channelTeammateManager}
      {channelManagementPanel}
    </div>
  ) : sidePanelView === "approval" ? (
    <ChannelApprovalDetailPanel
      approval={selectedApproval}
      resolvingDecision={selectedApproval ? resolvingApprovals[selectedApproval.id] : undefined}
      onResolve={onResolveApproval}
      onOpenTask={openTaskFromActivity}
      onOpenRun={openRunInPanel}
    />
  ) : (
    <section className="task-detail-panel inline-task-detail-panel" aria-label={sidePanelTitle}>
      {taskDetailContent}
    </section>
  );
  const attentionQueueVisible = attentionQueueOpen && !teammateManagerOpen && !sidePanelOpen && (activityToolsOpen || channelHasChatContent) && attentionQueueItems.length > 0;

  return (
    <div className="client-window task-workbench-window" aria-label={t("Workspace")}>
      <header className="channel-header task-workbench-header">
        <div className="channel-title-area">
          <div className="channel-title-line">
            <span className="channel-title-icon" aria-hidden="true">#</span>
            <h1>{selectedChannel?.name ?? "Engineering"}</h1>
            <div className="channel-more-wrap" ref={channelMoreRef}>
              <button
                className={channelMoreOpen ? "icon-button channel-more-button active" : "icon-button channel-more-button"}
                type="button"
                aria-expanded={channelMoreOpen}
                aria-label={t("More channel views")}
                title={t("More channel views")}
                onClick={() => setChannelMoreOpen((current) => !current)}
              >
                <MoreHorizontal size={17} />
              </button>
              {channelMoreOpen ? (
                <div className="channel-more-menu" role="menu" aria-label={t("More channel views")}>
	                  {channelSidePanelRootViews.map((view) => (
	                    <button
	                      key={view}
	                      className={sidePanelOpen && sidePanelView === view ? "channel-more-item active" : "channel-more-item"}
                      type="button"
                      role="menuitem"
                      onClick={() => openSidePanelView(view)}
                    >
                      {channelSidePanelIcon(view, 15)}
	                      <span>{t(channelSidePanelLabel(view))}</span>
	                    </button>
	                  ))}
	                  <button
	                    className={activityToolsOpen ? "channel-more-item active" : "channel-more-item"}
	                    type="button"
	                    role="menuitem"
	                    onClick={() => {
	                      setActivityToolsOpen(true);
	                      setActivityFiltersExpanded(false);
	                      setChannelMoreOpen(false);
	                      setSidePanelOpen(false);
	                      setTeammateManagerOpen(false);
	                    }}
	                  >
	                    <SlidersHorizontal size={15} />
	                    <span>{t("Activity filters")}</span>
	                  </button>
	                </div>
	              ) : null}
	            </div>
	          </div>
	        </div>
        <div className="channel-header-actions" aria-label={t("Workspace task toolbar")}>
          <button
            ref={teammateManagerButtonRef}
            className={teammateManagerOpen ? "icon-button active task-toolbar-teammates" : "icon-button task-toolbar-teammates"}
            type="button"
            aria-expanded={teammateManagerOpen}
            aria-label={t("AI teammate management")}
            title={t("AI teammate management")}
            onClick={() => {
              const nextOpen = !teammateManagerOpen;
              setTeammateManagerOpen(nextOpen);
              if (nextOpen) {
                setAttentionQueueOpen(false);
              }
              setWorkspaceSettingsOpen(false);
              setActivityToolsOpen(false);
              setSidePanelOpen(false);
              onChannelCreateOpenChange(false);
            }}
            disabled={!selectedChannelId}
          >
            <UserPlus size={15} />
          </button>
          <button
            className={sidePanelOpen && sidePanelView === "settings" ? "icon-button active task-toolbar-settings" : "icon-button task-toolbar-settings"}
            type="button"
            aria-expanded={sidePanelOpen && sidePanelView === "settings"}
            aria-label={t("Settings")}
            title={t("Settings")}
            onClick={() => {
              openSidePanelView("settings");
              onChannelCreateOpenChange(false);
            }}
          >
            <SlidersHorizontal size={15} />
          </button>
          <button
            className={attentionQueueVisible || (sidePanelOpen && sidePanelView === "progress") ? "icon-button active task-toolbar-attention" : "icon-button task-toolbar-attention"}
            type="button"
            aria-label={t("Attention queue")}
            title={t("Attention queue")}
            onClick={() => {
              if (sidePanelOpen || attentionQueueItems.length === 0) {
                openProgressPanel();
                return;
              }
              setAttentionQueueOpen((current) => !current);
            }}
          >
            <ListChecks size={15} />
          </button>
          <button
            className={sidePanelOpen ? "icon-button active task-toolbar-panel" : "icon-button task-toolbar-panel"}
            type="button"
            aria-expanded={sidePanelOpen}
            aria-label={sidePanelOpen ? t("Hide details") : t("Show details")}
            title={sidePanelOpen ? t("Hide details") : t("Show details")}
            onClick={() => {
              if (sidePanelOpen) {
                setSidePanelOpen(false);
                setCreateTaskOpen(false);
                return;
              }
              setSidePanelOpen(true);
              setActivityToolsOpen(false);
            }}
          >
            {sidePanelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        </div>
        {attentionQueueVisible ? (
          <div className="channel-attention-popover">
            <AttentionQueue
              items={attentionQueueItems}
              expanded={attentionProgressExpanded}
              onExpandedChange={setAttentionProgressExpanded}
              progressItems={attentionProgressItems}
              onOpenItem={openAttentionQueueItem}
            />
          </div>
        ) : null}
      </header>

      {teammateManagerOpen ? (
        <section ref={teammateManagerPanelRef} className="workbench-settings-panel channel-teammate-dock" aria-label={t("AI teammate management")}>
          {channelTeammateManager}
        </section>
      ) : null}

      {channelCreateOpen ? (
        <section className="workbench-settings-panel channel-options" aria-label={t("New channel")}>
          <section className="channel-settings-card channel-management-panel">
            <div className="channel-settings-section-head">
              <span>
                <Plus size={15} />
                <strong>{t("New channel")}</strong>
              </span>
              <small>{t("Create or select a channel first.")}</small>
            </div>
            <div className="channel-options-grid">
              <label className="field wide">
                <span>{t("Run provider")}</span>
                <select value={channelForm.defaultProviderPresetId} onChange={(event) => onChannelFormChange({ ...channelForm, defaultProviderPresetId: event.target.value })} disabled={providersLoading || providers.length === 0}>
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
                <button className="primary-button compact-button" type="button" onClick={onCreateChannel} disabled={channelsLoading}>
                  <Plus size={14} />
                  {t("Create channel")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={() => onChannelCreateOpenChange(false)}>
                  {t("Cancel")}
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

      <div
        className={[
          "task-workbench-main",
          sidePanelOpen ? "with-channel-side-panel" : "",
          attentionQueueVisible ? "attention-open" : "",
        ].filter(Boolean).join(" ")}
      >
        <section className="panel task-list-panel activity-tab-panel channel-chat-panel" aria-label={t("Channel activity")}>
          <div className="activity-shell">
	              <div className={activeThreadRoot ? "activity-chat-layout with-thread" : "activity-chat-layout"}>
	                <div className="activity-chat-main">
                  {auditActivityVisible ? (
                    <div className="channel-activity-tools">
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
                        onSearchChange={setActivitySearch}
                        onCategoryFilterChange={setActivityCategoryFilter}
                        onAttentionFilterChange={setActivityAttentionFilter}
                        onClear={() => {
                          setActivitySearch("");
                          setActivityCategoryFilter("all");
                          setActivityAttentionFilter("all");
                          setActiveActivityViewId(allChannelActivitySavedViewId);
                        }}
                      />
                      <CiTriageAuditPanel
                        records={externalWorkCiTriage}
                        loading={externalWorkCiTriageLoading}
                        compact
                        maxRecords={3}
                        cwd={cwd}
                        onRefresh={onRefreshExternalWorkCiTriage}
                        onSelectTask={openTaskFromActivity}
                        onOpenRun={openRunInPanel}
                      />
                    </div>
                  ) : null}
	                  <div className="message-feed-wrap">
	                    <div
	                      ref={messageFeedRef}
	                      className={messageFeedEmpty ? "message-feed message-feed-empty" : "message-feed"}
                      aria-label={t("Channel message feed")}
                      onScroll={handleMessageFeedScroll}
                    >
                  {channelMessagesLoading || channelProtocolLoading ? (
                    <div className="client-empty-state">
                      <Loader2 className="spin" />
                      <span>{t("Loading messages...")}</span>
                    </div>
                  ) : visibleActivityItems.length === 0 ? (
                    <div className="client-empty-state message-feed-empty-state">
                      {activityFiltersActive ? <Search /> : <MessageSquare />}
                      <span>{activityFiltersActive ? t("No activity matches these filters") : selectedChannel ? t("No channel messages yet") : t("Create a default channel to start the workspace loop.")}</span>
                    </div>
                  ) : (
                    <div
                      className="message-feed-virtualizer"
                      style={{ height: `${messageFeedVirtualizer.getTotalSize()}px` }}
                    >
                      {messageFeedVirtualRows.map((virtualRow) => (
                        <MessageFeedVirtualRow
                          key={virtualRow.key}
                          feedItem={messageFeedItems[virtualRow.index]}
                          measureElement={messageFeedVirtualizer.measureElement}
                          virtualRow={virtualRow}
                        >
                          {renderMessageFeedItem(messageFeedItems[virtualRow.index])}
                        </MessageFeedVirtualRow>
                      ))}
                    </div>
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
                    {messageFeedLatestButtonVisible ? (
                      <button
                        className="message-feed-latest-button"
                        type="button"
                        onClick={scrollMessageFeedToLatest}
                        aria-label={t("Jump to latest message")}
                      >
                        <ArrowDown size={22} />
                      </button>
                    ) : null}
                  </div>
                  {channelComposer}
                </div>
                {activeThreadRoot ? (
                  <ThreadReplyPanel
                    rootMessage={activeThreadRoot}
                    replies={activeThreadMessages}
                    teammates={teammateOptions}
                    memoryById={memoryById}
                    usedMemoryEvents={usedMemoryEvents}
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
        </section>
        {sidePanelOpen ? (
          <aside className="channel-side-panel" aria-label={sidePanelTitle}>
            <div className="channel-side-panel-head">
              <span className="channel-side-panel-title">
                {channelSidePanelIcon(sidePanelView, 16)}
                <strong>{sidePanelTitle}</strong>
	              </span>
	              <div className="channel-side-panel-actions">
	                {(sidePanelView === "progress" || sidePanelView === "task") ? (
	                  <button
	                    className="icon-button"
	                    type="button"
	                    onClick={() => {
	                      setCreateTaskOpen(true);
	                      setSidePanelView("task");
	                      setSidePanelOpen(true);
	                      setActivityToolsOpen(false);
	                      setAttentionQueueOpen(false);
	                      setTeammateManagerOpen(false);
	                    }}
	                    disabled={!selectedChannelId}
	                    aria-label={t("New task")}
	                    title={t("New task")}
	                  >
	                    <Plus size={15} />
	                  </button>
	                ) : null}
	                <button className="icon-button" type="button" onClick={refreshSidePanel} disabled={sidePanelLoading || !selectedChannelId} aria-label={t("Refresh")} title={t("Refresh")}>
	                  {sidePanelLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
	                </button>
	              </div>
            </div>
            <div className="channel-side-panel-nav" aria-label={t("Channel drawer pages")}>
              {channelSidePanelRootViews.map((view) => (
                <button
                  key={view}
                  className={sidePanelView === view ? "channel-side-panel-nav-item active" : "channel-side-panel-nav-item"}
                  type="button"
                  onClick={() => openSidePanelView(view)}
                  aria-label={t(channelSidePanelLabel(view))}
                  title={t(channelSidePanelLabel(view))}
                >
                  {channelSidePanelIcon(view, 16)}
                </button>
              ))}
            </div>
            <div className="channel-side-panel-body">
              {sidePanelContent}
            </div>
          </aside>
        ) : null}
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
  runtimeDiagnostics,
  workUnits,
  attachments,
  linkPreviews,
  runningWorkflowStepId,
  loading,
  runtimeLoading,
  runtimeActionWorkUnitId,
  selectedTask,
  onSupersedeDecision,
  onRejectDecision,
  onUpdateHandoffStatus,
  onStartWorkflowFromHandoff,
  onStartWorkflowStep,
  onUpdateWorkflowStepStatus,
  onCreateTaskFromContextSummary,
  onRefreshRuntime,
  onCancelWorkUnit,
  onRetryWorkUnit,
  onReconcileWorkUnit,
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
  readonly runtimeDiagnostics: RuntimeDiagnosticsResponse | undefined;
  readonly workUnits: readonly WorkUnit[];
  readonly attachments: readonly ChannelAttachment[];
  readonly linkPreviews: readonly ChannelLinkPreview[];
  readonly runningWorkflowStepId: string;
  readonly loading: boolean;
  readonly runtimeLoading: boolean;
  readonly runtimeActionWorkUnitId: string;
  readonly selectedTask: Task | undefined;
  readonly onSupersedeDecision: (decision: ChannelDecision) => void;
  readonly onRejectDecision: (decision: ChannelDecision) => void;
  readonly onUpdateHandoffStatus: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => void;
  readonly onStartWorkflowFromHandoff: (handoff: ChannelHandoff) => void;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => void;
  readonly onRefreshRuntime: () => void;
  readonly onCancelWorkUnit: (workUnitId: string) => void;
  readonly onRetryWorkUnit: (workUnitId: string) => void;
  readonly onReconcileWorkUnit: (workUnitId: string) => void;
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
      {(mode === "runtime" ? runtimeLoading : loading) ? (
        <div className="client-empty-state compact">
          <Loader2 className="spin" />
          <span>{mode === "runtime" ? t("Loading runtime...") : t("Loading protocol...")}</span>
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
          <RuntimeDiagnosticsPanel
            diagnostics={runtimeDiagnostics}
            workUnits={workUnits}
            loading={runtimeLoading}
            actionWorkUnitId={runtimeActionWorkUnitId}
            onRefresh={onRefreshRuntime}
            onCancelWorkUnit={onCancelWorkUnit}
            onRetryWorkUnit={onRetryWorkUnit}
            onReconcileWorkUnit={onReconcileWorkUnit}
          />
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

function RuntimeDiagnosticsPanel({
  diagnostics,
  workUnits,
  loading,
  actionWorkUnitId,
  onRefresh,
  onCancelWorkUnit,
  onRetryWorkUnit,
  onReconcileWorkUnit,
}: {
  readonly diagnostics: RuntimeDiagnosticsResponse | undefined;
  readonly workUnits: readonly WorkUnit[];
  readonly loading: boolean;
  readonly actionWorkUnitId: string;
  readonly onRefresh: () => void;
  readonly onCancelWorkUnit: (workUnitId: string) => void;
  readonly onRetryWorkUnit: (workUnitId: string) => void;
  readonly onReconcileWorkUnit: (workUnitId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const active = diagnostics?.active ?? workUnits.filter(isActiveWorkUnit);
  const queued = diagnostics?.queued ?? workUnits.filter((unit) => unit.status === "queued");
  const stuck = diagnostics?.stuck ?? [];
  const stale = diagnostics?.stale ?? workUnits.filter((unit) => unit.status === "stale");
  const leases = diagnostics?.leases ?? [];
  const semaphoreSlots = diagnostics?.semaphoreSlots ?? [];
  const visibleUnits = uniqueWorkUnits([...stuck, ...active, ...queued, ...stale, ...workUnits]).slice(0, 8);

  return (
    <section className="runtime-diagnostics-panel" aria-label={t("Runtime diagnostics")}>
      <div className="task-strip-head">
        <span><Activity size={15} /><strong>{t("Runtime supervisor")}</strong></span>
        <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {t("Refresh")}
        </button>
      </div>

      {diagnostics ? (
        <div className="run-evidence-grid runtime-supervisor-meta">
          <MetaRow label={t("Runtime")} value={diagnostics.runtime.runtimeInstanceId} compact />
          <MetaRow label={t("PID")} value={String(diagnostics.runtime.pid)} compact />
          <MetaRow label={t("Status")} value={diagnostics.runtime.status} compact />
          <MetaRow label={t("Started")} value={formatDateTime(diagnostics.runtime.startedAt)} compact />
        </div>
      ) : (
        <div className="provider-run-notice compact">
          <CircleAlert size={14} />
          <span>{t("Runtime diagnostics are unavailable.")}</span>
        </div>
      )}

      <div className="runtime-kpi-grid">
        <div>
          <span>{t("Active")}</span>
          <strong>{active.length}</strong>
        </div>
        <div>
          <span>{t("Queued")}</span>
          <strong>{queued.length}</strong>
        </div>
        <div>
          <span>{t("Stuck")}</span>
          <strong>{stuck.length}</strong>
        </div>
        <div>
          <span>{t("Stale")}</span>
          <strong>{stale.length}</strong>
        </div>
      </div>

      <div className="task-strip-head">
        <span><Workflow size={15} /><strong>{t("Work units")}</strong></span>
        <small>{visibleUnits.length}</small>
      </div>
      <ProtocolList
        emptyLabel={t("No work units recorded")}
        items={visibleUnits}
        renderItem={(unit) => (
          <WorkUnitDiagnosticsRow
            key={unit.id}
            workUnit={unit}
            busy={actionWorkUnitId === unit.id}
            onCancel={onCancelWorkUnit}
            onRetry={onRetryWorkUnit}
            onReconcile={onReconcileWorkUnit}
          />
        )}
      />

      <div className="task-strip-head">
        <span><ShieldCheck size={15} /><strong>{t("Held leases")}</strong></span>
        <small>{leases.length}</small>
      </div>
      <ProtocolList
        emptyLabel={t("No held leases")}
        items={leases.slice(0, 6)}
        renderItem={(lease) => (
          <div className="protocol-row compact runtime-resource-row" key={lease.id}>
            <span>
              <strong>{lease.resourceType}: {truncatePreview(lease.resourceKey, 42)}</strong>
              <small>{lease.workUnitId ?? lease.ownerId} · {t("renewed")} {formatAge(lease.lastRenewedAt ?? lease.acquiredAt)}</small>
            </span>
            <StatusBadge status={lease.status} />
          </div>
        )}
      />

      <div className="task-strip-head">
        <span><SlidersHorizontal size={15} /><strong>{t("Semaphores")}</strong></span>
        <small>{semaphoreSlots.length}</small>
      </div>
      <ProtocolList
        emptyLabel={t("No semaphore slots")}
        items={semaphoreSlots.slice(0, 6)}
        renderItem={(slot) => (
          <div className="protocol-row compact runtime-resource-row" key={slot.id}>
            <span>
              <strong>{slot.resourceType}: {truncatePreview(slot.resourceKey, 42)}</strong>
              <small>{slot.workUnitId} · {t("renewed")} {formatAge(slot.lastRenewedAt)}</small>
            </span>
            <StatusBadge status={slot.status} />
          </div>
        )}
      />
    </section>
  );
}

function WorkUnitDiagnosticsRow({
  workUnit,
  busy,
  onCancel,
  onRetry,
  onReconcile,
}: {
  readonly workUnit: WorkUnit;
  readonly busy: boolean;
  readonly onCancel: (workUnitId: string) => void;
  readonly onRetry: (workUnitId: string) => void;
  readonly onReconcile: (workUnitId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const canCancel = ["queued", "claimed", "running", "waiting_for_approval"].includes(workUnit.status);
  const canRetry = workUnit.status === "failed" || workUnit.status === "stale";
  const canReconcile = ["claimed", "running", "waiting_for_approval", "cancelling", "stale"].includes(workUnit.status);
  return (
    <div className="protocol-row runtime-work-unit-row">
      <span>
        <strong>{workUnit.kind} · {workUnit.id}</strong>
        <small>
          {workUnit.ownerType}:{workUnit.ownerId}
          {workUnit.linkedRunId ? ` · run:${workUnit.linkedRunId}` : ""}
        </small>
        <small>
          {t("Last event")} {formatAge(workUnit.lastEventAt)}
          {" · "}
          {t("Last heartbeat")} {formatAge(workUnit.lastHeartbeatAt)}
        </small>
        {workUnit.errorMessage ? <small className="error-text">{workUnit.errorMessage}</small> : null}
      </span>
      <StatusBadge status={workUnit.status} />
      <div className="activity-action-row">
        {canCancel ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onCancel(workUnit.id)} disabled={busy}>
            {busy ? <Loader2 className="spin" size={13} /> : <X size={13} />}
            {t("Cancel")}
          </button>
        ) : null}
        {canRetry ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onRetry(workUnit.id)} disabled={busy}>
            {busy ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
            {t("Retry")}
          </button>
        ) : null}
        {canReconcile ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onReconcile(workUnit.id)} disabled={busy}>
            {busy ? <Loader2 className="spin" size={13} /> : <FileCheck2 size={13} />}
            {t("Reconcile")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function isActiveWorkUnit(workUnit: WorkUnit): boolean {
  return ["claimed", "running", "waiting_for_approval", "cancelling"].includes(workUnit.status);
}

function uniqueWorkUnits(workUnits: readonly WorkUnit[]): readonly WorkUnit[] {
  const byId = new Map<string, WorkUnit>();
  for (const unit of workUnits) {
    byId.set(unit.id, unit);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function formatAge(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) {
    return "-";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
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
          {step.taskId ? <span>{t("Task linked")}</span> : null}
          {step.runId ? <span>{t("Run linked")}</span> : null}
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

function ChannelProgressPanel({
  selectedTask,
  latestRun,
  pendingApprovals,
  attentionItems,
  proposals,
  teammates,
  externalWorkCiTriage,
  externalWorkCiTriageLoading,
  channelHasChatContent,
  onOpenTask,
  onOpenRun,
  onOpenApproval,
  onOpenContext,
  onRefreshExternalWorkCiTriage,
}: {
  readonly selectedTask: Task | undefined;
  readonly latestRun: RunSession | undefined;
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly attentionItems: readonly ChannelAttentionQueueItem[];
  readonly proposals: readonly ChannelExecutionProposal[];
  readonly teammates: readonly ChannelMention[];
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly externalWorkCiTriageLoading: boolean;
  readonly channelHasChatContent: boolean;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApproval: (approval: ApprovalRequest | undefined) => void;
  readonly onOpenContext: () => void;
  readonly onRefreshExternalWorkCiTriage: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const activeProposals = proposals.filter((proposal) => proposal.status !== "cancelled" && proposal.status !== "superseded");
  const collaborationRows = activeProposals
    .flatMap((proposal) =>
      proposal.collaborationSteps.slice(0, 2).map((step) => ({
        id: `${proposal.id}:${step.teammateId}:${step.action}:${step.summary}`,
        title: proposal.title,
        teammate: teammateLabel(step.teammateId, teammates),
        summary: step.summary.trim() || t(proposalStepActionLabel(step.action)),
      })),
    )
    .slice(0, 4);
  const visibleAttentionItems = attentionItems.slice(0, 5);
  const hasProgress = Boolean(
    selectedTask ||
      latestRun ||
      pendingApprovals.length > 0 ||
      visibleAttentionItems.length > 0 ||
      collaborationRows.length > 0 ||
      externalWorkCiTriage.length > 0,
  );

  if (!hasProgress) {
    return (
      <section className="channel-progress-panel empty" aria-label={t("Progress")}>
        <div className="client-empty-state channel-progress-empty">
          <ListChecks />
          <span>{channelHasChatContent ? t("No progress yet") : t("No channel progress yet")}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="channel-progress-panel" aria-label={t("Progress")}>
      <div className="channel-progress-summary-grid">
        {selectedTask ? (
          <button className="channel-progress-card" type="button" onClick={() => onOpenTask(selectedTask.id)}>
            <span>
              <SquareTerminal size={15} />
              <strong>{t("Current task")}</strong>
            </span>
            <p>{selectedTask.title}</p>
            <StatusBadge status={selectedTask.status} />
          </button>
        ) : null}
        {latestRun ? (
          <button className="channel-progress-card" type="button" onClick={() => onOpenRun(latestRun.id)}>
            <span>
              <Activity size={15} />
              <strong>{t("Latest run")}</strong>
            </span>
            <p>{readRunTitle(latestRun)}</p>
            <StatusBadge status={latestRun.status} />
          </button>
        ) : null}
        {pendingApprovals.length > 0 ? (
          <button className="channel-progress-card attention" type="button" onClick={() => onOpenApproval(pendingApprovals[0])}>
            <span>
              <ShieldCheck size={15} />
              <strong>{t("Pending approval")}</strong>
            </span>
            <p>{pendingApprovals[0]?.title ?? t("Approval request")}</p>
            <small>{t("{count} pending approvals", { count: pendingApprovals.length })}</small>
          </button>
        ) : null}
      </div>

      {visibleAttentionItems.length > 0 ? (
        <section className="channel-progress-section">
          <div className="task-strip-head">
            <span>
              <ListChecks size={15} />
              <strong>{t("Attention")}</strong>
            </span>
            <small>{visibleAttentionItems.length}</small>
          </div>
          <div className="channel-progress-list">
            {visibleAttentionItems.map((item) => (
              <button key={item.id} className={`channel-progress-row ${item.attention}`} type="button" onClick={() => openProgressTarget(item.target, onOpenTask, onOpenRun, onOpenApproval, onOpenContext, pendingApprovals)}>
                <span>
                  <strong>{t(item.title)}</strong>
                  <small>{t(item.description)}</small>
                </span>
                <small>{t(activityAttentionDisplayLabel(item.attention))}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {collaborationRows.length > 0 ? (
        <section className="channel-progress-section">
          <div className="task-strip-head">
            <span>
              <History size={15} />
              <strong>{t("Collaboration")}</strong>
            </span>
            <small>{collaborationRows.length}</small>
          </div>
          <div className="channel-progress-list">
            {collaborationRows.map((row) => (
              <div key={row.id} className="channel-progress-row passive">
                <span>
                  <strong>{row.teammate}</strong>
                  <small>{row.title}</small>
                </span>
                <p>{row.summary}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {pendingApprovals.length > 0 ? (
        <section className="channel-progress-section">
          <div className="task-strip-head">
            <span>
              <ShieldCheck size={15} />
              <strong>{t("Approvals")}</strong>
            </span>
            <small>{pendingApprovals.length}</small>
          </div>
          <div className="channel-progress-list">
            {pendingApprovals.map((approval) => (
              <button key={approval.id} className="channel-progress-row pending" type="button" onClick={() => onOpenApproval(approval)}>
                <span>
                  <strong>{approval.title}</strong>
                  <small>{approval.description}</small>
                </span>
                <small>{approval.risk}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {externalWorkCiTriage.length > 0 || externalWorkCiTriageLoading ? (
        <section className="channel-progress-section">
          <div className="task-strip-head">
            <span>
              <FileCheck2 size={15} />
              <strong>{t("CI triage")}</strong>
            </span>
            <button className="icon-button" type="button" onClick={onRefreshExternalWorkCiTriage} disabled={externalWorkCiTriageLoading} aria-label={t("Refresh CI triage")} title={t("Refresh CI triage")}>
              {externalWorkCiTriageLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
            </button>
          </div>
          <div className="channel-progress-list">
            {externalWorkCiTriage.slice(0, 3).map((record) => (
              <button
                key={record.triage.id}
                className="channel-progress-row"
                type="button"
                onClick={() => {
                  if (record.task) {
                    onOpenTask(record.task.id);
                    return;
                  }
                  if (record.run) {
                    onOpenRun(record.run.id);
                  }
                }}
              >
                <span>
                  <strong>{record.externalWork?.item.title ?? t("CI triage")}</strong>
                  <small>{record.triage.failure.workflowName ?? record.triage.failure.checkName}</small>
                </span>
                <small>{record.triage.failure.conclusion}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function openProgressTarget(
  target: ChannelAttentionQueueTarget,
  onOpenTask: (taskId: string) => void,
  onOpenRun: (runId: string) => void,
  onOpenApproval: (approval: ApprovalRequest | undefined) => void,
  onOpenContext: () => void,
  pendingApprovals: readonly ApprovalRequest[],
): void {
  if (target.kind === "task") {
    onOpenTask(target.taskId);
    return;
  }
  if (target.kind === "run") {
    onOpenRun(target.runId);
    return;
  }
  if (target.kind === "approval") {
    onOpenApproval(pendingApprovals.find((approval) => approval.runId === target.runId));
    return;
  }
  onOpenContext();
}

function ChannelApprovalDetailPanel({
  approval,
  resolvingDecision,
  onResolve,
  onOpenTask,
  onOpenRun,
}: {
  readonly approval: ApprovalRequest | undefined;
  readonly resolvingDecision: ApprovalResolution | undefined;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [decisionReason, setDecisionReason] = useState("");
  const [confirmDecision, setConfirmDecision] = useState<ApprovalResolution | undefined>();

  useEffect(() => {
    setDecisionReason("");
    setConfirmDecision(undefined);
  }, [approval?.id]);

  if (!approval) {
    return (
      <section className="channel-approval-detail-panel empty" aria-label={t("Approval details")}>
        <div className="client-empty-state">
          <ShieldCheck />
          <span>{t("No pending approval")}</span>
        </div>
      </section>
    );
  }

  const currentApproval = approval;
  const effectiveStatus = effectiveApprovalStatus(currentApproval);
  const isResolving = Boolean(resolvingDecision);
  const requiresReason = currentApproval.risk === "high" || currentApproval.risk === "critical";
  const trimmedReason = decisionReason.trim();

  function submitDecision(decision: ApprovalResolution): void {
    if (isResolving || effectiveStatus !== "pending") {
      return;
    }
    if (decision === "approve" && requiresReason && (confirmDecision !== "approve" || !trimmedReason)) {
      setConfirmDecision("approve");
      return;
    }
    setConfirmDecision(undefined);
    onResolve(currentApproval.id, decision, trimmedReason || undefined);
  }

  return (
    <section className="channel-approval-detail-panel" aria-label={t("Approval details")}>
      <div className="channel-approval-hero">
        <span>
          <ShieldCheck size={17} />
          <strong>{t("Approval request")}</strong>
        </span>
        <h3>{currentApproval.title}</h3>
        <p>{currentApproval.description}</p>
        <div className="channel-approval-badges">
          <span className={`approval-state ${effectiveStatus}`}>{effectiveStatus}</span>
          <span className={`approval-risk ${currentApproval.risk}`}>{currentApproval.risk}</span>
          <span>{currentApproval.actionType}</span>
        </div>
      </div>

      <div className="channel-approval-links">
        {currentApproval.taskId ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenTask(currentApproval.taskId ?? "")}>
            <SquareTerminal size={14} />
            {t("Open linked task")}
          </button>
        ) : null}
        {currentApproval.runId ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(currentApproval.runId ?? "")}>
            <Activity size={14} />
            {t("Open linked run")}
          </button>
        ) : null}
      </div>

      {currentApproval.decisionReason ? (
        <div className="channel-approval-note">
          <strong>{t("Decision reason")}</strong>
          <p>{currentApproval.decisionReason}</p>
        </div>
      ) : null}

      {effectiveStatus === "pending" ? (
        <div className="channel-approval-decision-panel">
          <label className="approval-reason-field">
            <span>{t("Decision reason")}</span>
            <textarea
              value={decisionReason}
              rows={3}
              placeholder={requiresReason ? t("Required before approving high-risk requests") : t("Optional note for the audit log")}
              disabled={isResolving}
              onChange={(event) => setDecisionReason(event.target.value)}
            />
          </label>
          {confirmDecision === "approve" && requiresReason && !trimmedReason ? (
            <p className="approval-reason-error">{t("High-risk approvals need a decision reason.")}</p>
          ) : null}
          <div className="channel-approval-actions">
            <button className="primary-button compact-button" type="button" onClick={() => submitDecision("approve")} disabled={isResolving}>
              {resolvingDecision === "approve" ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              {resolvingDecision === "approve" ? t("Approving") : confirmDecision === "approve" ? t("Confirm approve") : t("Approve")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => submitDecision("deny")} disabled={isResolving}>
              {resolvingDecision === "deny" ? <Loader2 className="spin" size={14} /> : <X size={14} />}
              {resolvingDecision === "deny" ? t("Denying") : t("Deny")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
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
  approvals,
  approvalsLoading,
  resolvingApprovals,
  effectiveProvider,
  providerBlocker,
  isRunning,
  activeTaskRunAction,
  taskActionPending,
  activeLeaseCount,
  isCancellingRun,
  permissionMode,
  decisions,
  contextSummaries,
  workflows,
  workflowSteps,
  onCreateHandoffFromTask,
  onCreateTaskFromContextSummary,
  onCheckThenRunTask,
  onRunTask,
  onPermissionModeChange,
  onCancelActiveRun,
  onOpenRun,
  onOpenApprovals,
  onRefreshRunApprovals,
  onResolveApproval,
  onOpenProviders,
}: {
  readonly task: Task;
  readonly channels: readonly Channel[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly pendingApprovalCount: number;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly effectiveProvider: ProviderPreset | undefined;
  readonly providerBlocker: string | undefined;
  readonly isRunning: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly taskActionPending: boolean;
  readonly activeLeaseCount: number;
  readonly isCancellingRun: boolean;
  readonly permissionMode: SessionPermissionMode;
  readonly decisions: readonly ChannelDecision[];
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly onCreateHandoffFromTask: (task: Task) => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onPermissionModeChange: (mode: SessionPermissionMode) => void;
  readonly onCancelActiveRun: (run?: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onRefreshRunApprovals: () => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
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
  const linkedRunCancellable = Boolean(linkedRun && runCanBeStopped(linkedRun));
  const stopLinkedRun = (): void => {
    if (linkedRun) {
      onCancelActiveRun(linkedRun);
    }
  };
  const taskSummaries = contextSummaries.filter((summary) => summary.targetType === "task" && summary.targetId === task.id);
  const activeDecisions = decisions.filter((decision) => decision.status === "active");
  const sourceWorkflowStep = workflowSteps.find((step) => step.taskId === task.id);
  const sourceWorkflow = sourceWorkflowStep ? workflows.find((workflow) => workflow.id === sourceWorkflowStep.workflowId) : undefined;
  const timelineRunId = activeRunId || task.currentRunId || "";
  const pendingRunApprovals = approvals.filter((approval) => {
    if (effectiveApprovalStatus(approval) !== "pending") {
      return false;
    }
    return timelineRunId ? approval.runId === timelineRunId : approval.taskId === task.id;
  });

  return (
    <article className="client-task-card task-detail selected" aria-label={t("Task detail")}>
      <div className="task-detail-head">
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
          {linkedRunCancellable ? (
            <button className="secondary-button danger compact-button" type="button" onClick={stopLinkedRun} disabled={isCancellingRun}>
              {isCancellingRun ? <Loader2 className="spin" size={14} /> : <Square size={13} />}
              {isCancellingRun ? t("Stopping") : t("Stop")}
            </button>
          ) : null}
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
      <label className="session-permission-control">
        <span>
          <ShieldCheck size={14} />
          {t("Permission mode")}
        </span>
        <select
          aria-label={t("Permission mode")}
          value={permissionMode}
          onChange={(event) => onPermissionModeChange(event.target.value as SessionPermissionMode)}
          disabled={isRunning || taskActionPending}
        >
          {sessionPermissionModeOptions.map((mode) => (
            <option key={mode} value={mode}>{sessionPermissionModeLabel(mode, t)}</option>
          ))}
        </select>
        <small>{sessionPermissionModeDescription(permissionMode, t)}</small>
      </label>
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
      {pendingRunApprovals.length > 0 ? (
        <div className="inline-approval-panel task-approval-panel" aria-live="polite">
          <div className="inline-approval-head">
            <span>
              <ShieldCheck size={16} />
              {t("Pending approval")}
            </span>
            <button className="secondary-button compact-button" type="button" onClick={onRefreshRunApprovals} disabled={approvalsLoading}>
              {approvalsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {t("Refresh")}
            </button>
          </div>
          <div className="inline-approval-list">
            {pendingRunApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                compact
                resolvingDecision={resolvingApprovals[approval.id]}
                onResolve={onResolveApproval}
              />
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function MessageFeedVirtualRow({
  children,
  feedItem,
  measureElement,
  virtualRow,
}: {
  readonly children: ReactNode;
  readonly feedItem: MessageFeedItem | undefined;
  readonly measureElement: (node: HTMLDivElement | null) => void;
  readonly virtualRow: VirtualItem;
}): JSX.Element {
  return (
    <div
      ref={measureElement}
      className="message-feed-virtual-row"
      data-feed-item-id={feedItem?.id}
      data-feed-item-kind={feedItem?.kind}
      data-index={virtualRow.index}
      style={{
        transform: `translateY(${virtualRow.start}px)`,
      }}
    >
      {children}
    </div>
  );
}

function runCanBeStopped(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

function MessageBubble({
  tone = "chat",
  side = "start",
  avatar,
  author,
  tag,
  time,
  body,
  metaAction,
  action,
}: {
  readonly tone?: MessageBubbleTone;
  readonly side?: "start" | "end";
  readonly avatar: JSX.Element;
  readonly author: string;
  readonly tag?: string;
  readonly time: string;
  readonly body: string;
  readonly metaAction?: JSX.Element;
  readonly action?: JSX.Element;
}): JSX.Element {
  const inlineAuthor = tone === "chat" || tone === "chat-blocked";
  const sideClass = inlineAuthor ? side === "end" ? " message-bubble-own" : " message-bubble-peer" : "";
  const ownMessage = inlineAuthor && side === "end";
  const peerMessage = inlineAuthor && side === "start";
  const showTime = !inlineAuthor && time.length > 0;
  return (
    <article className={`message-bubble message-bubble-${tone}${inlineAuthor ? " message-bubble-inline" : ""}${sideClass}`}>
      {!inlineAuthor || peerMessage ? avatar : null}
      <div className={metaAction ? "message-content has-floating-action" : "message-content"}>
        {ownMessage ? (
          metaAction ? <span className="message-meta-action">{metaAction}</span> : null
        ) : (
          <div className={metaAction ? "message-meta has-meta-action" : "message-meta"}>
            <strong>{author}</strong>
            {tag ? <small>{tag}</small> : null}
            {showTime ? <time>{time}</time> : null}
            {metaAction ? <span className="message-meta-action">{metaAction}</span> : null}
          </div>
        )}
        <p>{renderMessageBody(body)}</p>
        {action ? <div className="message-action">{action}</div> : null}
      </div>
      {inlineAuthor && side === "end" ? avatar : null}
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
  const collaborationSummary = proposalCollaborationSummary(proposal, teammates, t);
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
            <span className="channel-proposal-collaboration-summary">
              <History size={14} />
              <strong>{t("Collaboration {count} records", { count: proposal.collaborationSteps.length })}</strong>
              {collaborationSummary ? (
                <>
                  <span aria-hidden="true">·</span>
                  <small>{collaborationSummary}</small>
                </>
              ) : null}
            </span>
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
  memoryById,
  usedMemoryEvents,
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
  readonly memoryById: ReadonlyMap<string, MemoryObject>;
  readonly usedMemoryEvents: readonly UsedMemoryEvent[];
  readonly draft: string;
  readonly pending: boolean;
  readonly error: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const canSend = draft.trim().length > 0 && !pending;
  const rootMessageIsOwn = rootMessage.authorType === "local-user";
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
        {rootMessageIsOwn ? null : (
          <small>{t("Topic started by {author}", { author: messageAuthorLabel(rootMessage, teammates) })}</small>
        )}
        <p>{renderMessageBody(rootMessage.body)}</p>
        <UsedMemorySummary
          compact
          events={filterUsedMemoryEventsByResponse(usedMemoryEvents, rootMessage.id)}
          memoryById={memoryById}
        />
      </div>
      <div className="thread-reply-list" aria-label={t("Replies")}>
        {replies.length === 0 ? (
          <div className="thread-empty-state">{t("No replies yet")}</div>
        ) : replies.map((reply) => {
          const replyIsOwn = reply.authorType === "local-user";
          return (
            <article key={reply.id} className={replyIsOwn ? "thread-reply-item thread-reply-own" : "thread-reply-item"}>
              {replyIsOwn ? null : (
                <div className="thread-reply-meta">
                  <strong>{messageAuthorLabel(reply, teammates)}</strong>
                  {reply.kind === "ai_reply" ? <small>AI</small> : null}
                </div>
              )}
              <p>{renderMessageBody(reply.body)}</p>
              <UsedMemorySummary
                compact
                events={filterUsedMemoryEventsByResponse(usedMemoryEvents, reply.id)}
                memoryById={memoryById}
              />
            </article>
          );
        })}
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
  progressItems,
  onOpenItem,
}: {
  readonly items: readonly ChannelAttentionQueueItem[];
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly progressItems: readonly string[];
  readonly onOpenItem: (item: ChannelAttentionQueueItem) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const blockedCount = items.filter((item) => item.attention === "blocked").length;
  const failedCount = items.filter((item) => item.attention === "failed").length;
  const pendingCount = items.filter((item) => item.attention === "pending").length;
  const visibleItems = items.slice(0, 5);
  return (
    <section className="attention-queue compact" aria-label={t("Attention queue")}>
      {progressItems.length > 0 ? (
        <div className="attention-progress-preview">
          <div className="attention-progress-head">
            <strong>{t("Progress")}</strong>
            <button
              className="icon-button attention-progress-toggle"
              type="button"
              aria-expanded={expanded}
              onClick={() => onExpandedChange(!expanded)}
              aria-label={expanded ? t("Collapse") : t("Expand")}
              title={expanded ? t("Collapse") : t("Expand")}
            >
              {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          </div>
          {expanded ? (
            <div className="attention-progress-list" aria-label={t("Progress")}>
              {progressItems.slice(0, 3).map((item, index) => (
                <span key={`${item}:${index}`}>
                  {index < progressItems.length - 1 ? <CheckCircle2 size={14} /> : <Clock3 size={14} />}
                  <small>{item}</small>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="attention-queue-head">
        <strong>{t("Attention")}</strong>
        <small>{items.length}</small>
      </div>
      <div className="attention-queue-counts" aria-label={t("Attention counts")}>
        <small className="blocked">{t("Blocked")} {blockedCount}</small>
        <small className="failed">{t("Failed")} {failedCount}</small>
        <small className="pending">{t("Pending")} {pendingCount}</small>
      </div>
      <div className="attention-queue-list" aria-label={t("Top attention items")}>
        {visibleItems.length === 0 ? (
          <div className="client-empty-state compact attention-empty-state">
            <ListChecks size={16} />
            <span>{t("No attention items")}</span>
          </div>
        ) : visibleItems.map((item) => (
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
              </span>
            </button>
          </div>
        ))}
      </div>
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

function activityAttentionDisplayLabel(attention: Exclude<ChannelActivityAttention, "none">): string {
  if (attention === "blocked") {
    return "Blocked";
  }
  if (attention === "failed") {
    return "Failed";
  }
  return "Pending";
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

function proposalCollaborationSummary(
  proposal: ChannelExecutionProposal,
  teammates: readonly ChannelMention[],
  t: Translate,
): string {
  return proposal.collaborationSteps
    .slice(0, 2)
    .map((step) => {
      const teammate = teammateLabel(step.teammateId, teammates);
      const summary = step.summary.trim() || t(proposalStepActionLabel(step.action));
      return `${teammate} ${summary}`;
    })
    .join(" · ");
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

function mergeMentions(
  current: readonly ChannelMention[],
  detected: readonly ChannelMention[],
): readonly ChannelMention[] {
  const seen = new Set<string>();
  return [...current, ...detected].filter((mention) => {
    if (seen.has(mention.id)) {
      return false;
    }
    seen.add(mention.id);
    return true;
  });
}

function mentionTokenExistsInText(body: string, mention: ChannelMention): boolean {
  return [mention.label, mention.id].some((token) => {
    const escaped = escapeRegExp(token.trim());
    if (!escaped) {
      return false;
    }
    return new RegExp(`(^|\\s)@${escaped}(?=$|\\s|[.,!?;:，。！？；：)])`, "i").test(body);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function chooseMostSpecificMentionPicker(candidates: readonly (ActiveMentionPicker | undefined)[]): ActiveMentionPicker | undefined {
  return candidates
    .filter((candidate): candidate is ActiveMentionPicker => Boolean(candidate))
    .sort((left, right) => (right.end - right.start) - (left.end - left.start))[0];
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

function createAttachmentPreviewUrl(file: File): string | undefined {
  if (!isPreviewableImageFile(file)) {
    return undefined;
  }
  return globalThis.URL.createObjectURL(file);
}

function revokeObjectUrl(previewUrl: string): void {
  globalThis.URL.revokeObjectURL(previewUrl);
}

function isPreviewableImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(gif|jpe?g|png|webp)$/i.test(file.name);
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
