import { useWorkSummaryContext } from "./work-summary/WorkSummaryProvider.js";
import { useChannelPanelNavigation } from "./useChannelPanelNavigation.js";
import { ChannelWorkspaceOverlays } from "./ChannelWorkspaceOverlays.js";
import { ChannelWorkspaceHeader } from "./ChannelWorkspaceHeader.js";
import { useChannelWorkspaceEnvironment } from "./useChannelWorkspaceEnvironment.js";
import type { WorkspaceClientViewProps, ChannelSidePanelView } from "./workspace-client-view.types.js";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  CircleAlert,
  FileCheck2,
  GitBranch,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Workflow,
} from "lucide-react";

import type {
  ConversationProtocolAction,
  ConversationTimelineApprovalItem,
  ConversationTimelineProtocolEventItem,
} from "@ling-stack/conversation-ui-core";
import {
  artifactContentUrl,
  acceptProposedPlanArtifact,
  archiveProposedPlanArtifact,
  completeLingThreadGoal,
  convertProposedPlanToWorkflow,
  deleteLingThreadGoal,
  editConversationMessage,
  getLingThreadGoal,
  listLingThreadTurns,
  patchLingThreadGoal,
  putLingThreadGoal,
  refineProposedPlanArtifact,
  saveProposedPlanArtifact,
} from "../../api.js";
import {
  getChannelTeamMetricsProjection,
  listChannelCollaborationCards,
  listChannelTerminalReports,
} from "../../api/channels.js";
import { useI18n } from "../../i18n.js";
import { DesktopTitlebarSurface } from "../../app/DesktopTitlebarSurface.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { isChannelNotificationLevel } from "../../lib/channel-notifications.js";
import { buildInlineApprovalViews } from "../../lib/inline-approvals.js";
import type { ChannelActivityItem } from "../../lib/channel-activity.js";
import {
  type ChannelActivityDrilldownTarget,
} from "../../lib/channel-activity-drilldown.js";
import { type ChannelActivityTriageResult } from "../../lib/channel-activity-triage.js";
import {
  buildConversationWorkCellViewModel,
  groupRunsByThreadId,
  type ConversationWorkCellViewModel,
} from "../../lib/conversation-work-cell.js";
import { deriveSilentChannelReplyRunIds } from "../../lib/conversation-runtime-visibility.js";
import { buildConversationTurnProjection } from "../../lib/conversation-turn-projector.js";
import {
  buildCommittedContextSegmentLookup,
  channelTerminalReportItemRevisionSignature,
} from "../../lib/channel-conversation-items.js";
import { buildCollaborationTaskCardModel, type CollaborationTaskCardModel } from "../../lib/collaboration-task-card.js";
import {
  buildConversationContextSourceSummaryFromChannelSummary,
  type ConversationContextSourceGroup,
  type ConversationContextSourceSummary,
} from "../../lib/conversation-context-sources.js";
import {
  buildWorkflowProgressModel,
  workflowProgressToConversationWorkCell,
  type WorkflowProgressModel,
} from "../../lib/workflow-progress.js";
import { deriveChannelRuns } from "../../lib/channel-artifacts.js";


import { loadPreviewContent, type PreviewRequest } from "../../lib/previews.js";


import { inferPermissionPreset, workspaceAccessModeForPermissionPreset } from "../../lib/session-permissions.js";
import { useConversationPermissionSelection } from "../../shared/conversation/conversation-permission-selection.js";
import {
  channelFormPersistenceKey,
  channelToForm,
} from "../../lib/channels.js";
import {
  channelWorkCellDemoFixtureEnabled,
  createChannelWorkCellDemoFixture,
  resolveChannelWorkCellDemoPreview,
} from "../../lib/work-cell-demo-fixture.js";
import {
  isMediaProvider,
  providerDisplaySourceLabel,
  providerPreflightReady,
  providerRunPreflightBlocker,
} from "../../lib/providers.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import { IconButton, InlineFeedback, Spinner } from "../../shared/ui/index.js";
import {
  ConversationStatusStrip,
  useConversationSendLifecycle,
  type ConversationTimelineItemLocator,
  type DockPageKind,
} from "../../shared/conversation/index.js";
import {
  ConversationHeaderSearch,
  WorkspaceRightDock,
  type WorkspaceRightDockFileTarget,
  type WorkspaceRightDockReviewTarget,
} from "./right-dock/index.js";
import {
  ChannelEnvironmentCommitDialog,
} from "./ChannelEnvironmentCommitDialog.js";
import { ChannelActiveStatusIndicator } from "./ChannelActiveStatusIndicator.js";
import {
  ChannelEnvironmentPage,
  useChannelEnvironmentSummary,
} from "./ChannelEnvironmentSummary.js";
import { ChannelRenameDialog } from "./ChannelRenameDialog.js";
import { ChannelHeaderToolbar } from "./ChannelHeaderToolbar.js";
import { revealConversationTarget } from "./conversation-locate-pulse.js";
import { useChannelHeaderController } from "./useChannelHeaderController.js";
import { type WorkflowConversionDraft } from "./WorkflowConversionPreviewDialog.js";
import { ChannelGovernanceNotificationsPopover } from "./ChannelGovernanceNotificationsPopover.js";
import { useWorkspaceTerminalSession, WorkspaceTerminalPanel } from "./WorkspaceTerminalPanel.js";
import { useConversationPanelPresence } from "./useConversationPanelPresence.js";
import {
  NewTaskPanel,
  TaskDetailPanel,
} from "./ChannelTaskPanels.js";
import {
  ChannelApprovalDetailPanel,
  ChannelSourceDetailPanel,
  ConversationDetailOverlay,
  type ConversationDetailOverlayState,
  type SelectedSourceDetailState,
} from "./ChannelDetailOverlays.js";
import {
  ProgressPopover,
} from "./ChannelProgressPanels.js";
import { useChannelProgressSummary } from "./ChannelProgressSummary.js";
import { useChannelPlanHistory } from "./useChannelPlanHistory.js";
import {
  ChannelInspector,
  type ChannelInspectorMode,
} from "./ChannelInspectorPanels.js";
import type {
  ApprovalRequest,
  AiCouncil,
  Channel,
  ChannelContextSummary,
  ChannelFormState,
  ChannelMention,
  ChannelMessage,
  ChannelTeamMetricsProjection,
  ChannelExecutionProposal,
  ChannelWorkflowStep,
  ProposedPlanArtifact,
  RunSession,
  LingThreadGoal,
  LingTurn,
  LingTurnRun,
  Task,
  TerminalReportDto,
  TeammateChannelMembership,
} from "../../types.js";
import { ApprovalCard } from "../approvals/ApprovalCard.js";
import { RuntimeApprovalComposerGate } from "../approvals/RuntimeApprovalComposerGate.js";

import type { LocalTeammateDraft } from "../teammates/index.js";
import { ChannelTeamMetricsPanel } from "./ChannelTeamMetricsPanel.js";
import { channelLingAgentModelLabel } from "./channel-model-view-models.js";
import {
  ChannelTeammateManagerPanel,
  ChannelSettingsPanels,
  isLingAgentTeammate,
  type ChannelNotificationLevel,
} from "./ChannelSettingsPanels.js";
import { ChannelComposer } from "./ChannelComposer.js";
import { ChannelExecutionProposalComposerGate } from "./ChannelExecutionProposalComposerGate.js";
import { ChannelActivityWorkspace } from "./ChannelActivityWorkspace.js";
import { ChannelFeedLatestControl, ChannelFeedStatus } from "./ChannelFeedChrome.js";
import { useChannelRightDockController } from "./useChannelRightDockController.js";
import { useConversationSummaryLayout } from "./conversation-summary-layout.js";
import { proposedPlanActionPayload } from "./proposed-plan-action-payload.js";
import { useChannelBottomPanelResizeController } from "./useChannelBottomPanelResizeController.js";
import { useChannelMessageFeed } from "./ChannelMessageFeed.js";
import {
  LING_AGENT_AUTHOR_ID,
  createChannelMessageRenderers,
  messageAuthorLabel,
} from "./ChannelMessageRenderers.js";
import { useChannelRightDockContent } from "./ChannelRightDockContent.js";
import { useChannelActivityController } from "./useChannelActivityController.js";
import { useChannelWorkThreadsController } from "./useChannelWorkThreadsController.js";
import { useChannelComposerDraftController } from "./useChannelComposerDraftController.js";
import { useChannelComposerActionsController } from "./useChannelComposerActionsController.js";
import { useChannelGuidanceTargetController } from "./useChannelGuidanceTargetController.js";
import { useChannelThreadReplyController } from "./useChannelThreadReplyController.js";
import { useChannelComposerInputController } from "./useChannelComposerInputController.js";
import { useChannelComposerSnapshotController } from "./useChannelComposerSnapshotController.js";
import type { ChannelFeedbackEntry } from "./useChannelFeedbackController.js";
import { channelConversationScopeKey } from "../../shared/conversation/stream-error-ownership.js";
import { useChannelMessageFeedAssembly } from "./useChannelMessageFeedAssembly.js";
import { useChannelConversationBlockInteractions } from "./useChannelConversationBlockInteractions.js";
import { useChannelWorkspaceFeedback } from "./useChannelWorkspaceFeedback.js";


type ThreadTurnsLoadState =
  | { readonly status: "not_loaded" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly turns: readonly LingTurn[]; readonly runLinks: readonly LingTurnRun[] }
  | { readonly status: "error"; readonly errorMessage: string };

function channelSidePanelLabel(view: ChannelSidePanelView): string {
  if (view === "context") {
    return "Context";
  }
  if (view === "settings") {
    return "Settings";
  }
  return "Task detail";
}



function channelActivityVisibleInDefaultChat(item: ChannelActivityItem): boolean {
  return item.kind === "message" || item.kind === "summary";
}

interface ChannelTeamMetricsState {
  readonly channelId: string;
  readonly metrics: ChannelTeamMetricsProjection;
}

interface BranchConversationActivityScope {
  readonly threadId: string;
  readonly messageIds: ReadonlySet<string>;
  readonly runIds: ReadonlySet<string>;
  readonly taskIds: ReadonlySet<string>;
  readonly workflowIds: ReadonlySet<string>;
  readonly workflowStepIds: ReadonlySet<string>;
}

function latestTerminalReportMap(
  reports: readonly TerminalReportDto[],
  keyOf: (report: TerminalReportDto) => string,
): ReadonlyMap<string, TerminalReportDto> {
  const result = new Map<string, TerminalReportDto>();
  for (const report of [...reports].sort((left, right) => left.committedAt.localeCompare(right.committedAt))) {
    const key = keyOf(report);
    if (key) {
      result.set(key, report);
    }
  }
  return result;
}

function terminalReportResultItemId(report: TerminalReportDto): string {
  if ("resultItemId" in report && typeof report.resultItemId === "string" && report.resultItemId.length > 0) {
    return report.resultItemId;
  }
  return `result_terminal_report:${report.id}`;
}

function channelActivityItemBelongsToBranchConversation(
  item: ChannelActivityItem,
  scope: BranchConversationActivityScope,
): boolean {
  switch (item.kind) {
    case "message":
      return item.record.threadId === scope.threadId;
    case "run":
      return item.record.threadId === scope.threadId;
    case "task":
      return scope.taskIds.has(item.record.id);
    case "approval":
      return Boolean(
        (item.record.runId && scope.runIds.has(item.record.runId)) ||
        (item.record.taskId && scope.taskIds.has(item.record.taskId)),
      );
    case "state-transition":
      return (
        (item.record.entityType === "run" && scope.runIds.has(item.record.entityId)) ||
        (item.record.entityType === "task" && scope.taskIds.has(item.record.entityId)) ||
        (item.record.entityType === "workflow" && scope.workflowIds.has(item.record.entityId)) ||
        (item.record.entityType === "workflow_step" && scope.workflowStepIds.has(item.record.entityId))
      );
    case "workflow":
      return scope.workflowIds.has(item.record.id);
    case "workflow-step":
      return (
        scope.workflowIds.has(item.record.workflowId) ||
        Boolean(item.record.runId && scope.runIds.has(item.record.runId)) ||
        Boolean(item.record.metadata?.sourceMessageId && scope.messageIds.has(item.record.metadata.sourceMessageId))
      );
    case "summary":
      return (
        item.record.targetId === scope.threadId ||
        scope.messageIds.has(item.record.targetId) ||
        item.record.sourceMessageIds.some((messageId) => scope.messageIds.has(messageId))
      );
    default:
      return false;
  }
}

export function WorkspaceClientView({
  cwd,
  daemonHealthy,
  channelAutoRouteEnabled,
  providerLabel,
  userProfile,
  channels,
  selectedChannelId,
  selectedChannelBranchRootThreadId,
  channelCreateOpen,
  channelEditForm,
  tasks,
  taskForm,
  channelMessages,
  channelConversationItems,
  channelTurnContextAssignments,
  channelUserInputs,
  channelReasoningSummaries,
  channelContextCompactions,
  channelConversationRefreshToken,
  channelGeneratedMedia,
  memoryById,
  usedMemoryEvents,
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
  externalWorkCiTriage,
  externalWorkCiTriageLoading,
  durableWorkItems,
  durableWorkItemsLoading,
  selectedTaskId,
  providers,
  teammateTemplates,
  slashCommands,
  localTeammates,
  channelTeammateMemberships,
  channelTeammateMembershipsLoading,
  channelTeammateSavingId,
  channelTeammateError,
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
  externalActionDetails,
  approvalsLoading,
  resolvingApprovals,
  approvalErrors,
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
  cancellingRunIds,
  approvalPolicy,
  authorizationMode,
  permissionMode,
  permissionPreset,
  fullAccessConfirmed,
  activeTaskRunAction,
  runningWorkflowStepId,
  orchestratingWorkflowId,
  channelFeedbackEntries,
  onClearChannelFeedback,
  onChannelCreateOpenChange,
  onChannelEditFormChange,
  onTaskFormChange,
  onProviderSelect,
  onAddChannelTeammate,
  onRemoveChannelTeammate,
  onOpenTeammates,
  onRefreshChannels,
  onSaveChannel,
  onCreateTask,
  onCreateTaskFromSlashCommand,
  onSendMessage,
  onConfirmExecutionProposal,
  onCancelExecutionProposal,
  onUploadAttachments,
  onCreateLinkPreview,
  onDeleteAttachment,
  onSaveBrief,
  onSaveChannelProtocol,
  onRevertChannelProtocol,
  onSupersedeDecision,
  onRejectDecision,
  onCreateHandoffFromTask,
  onUpdateHandoffStatus,
  onStartWorkflowFromHandoff,
  onStartTemplateWorkflow,
  onOrchestrateWorkflow,
  onCancelWorkflow,
  onStartWorkflowStep,
  onRetryWorkflowStep,
  onUpdateWorkflowStepStatus,
  onCreateTaskFromContextSummary,
  onRunActivityTriageAction,
  onLoadOlderChannelMessages,
  onRefreshChannelMessages,
  onRefreshPendingChannelReply,
  onRefreshChannelActivity,
  onRefreshExternalWorkCiTriage,
  onRefreshWorkItems,
  onRefreshChannelProtocol,
  onRefreshChannelFiles,
  onMarkChannelGovernanceNotificationSeen,
  onDismissChannelGovernanceNotification,
  onRefreshAiCouncils,
  onRefreshChannelCouncil,
  onUpdateChannelCouncilPolicy,
  attachmentContentUrl,
  onRefreshTasks,
  onRefreshRunApprovals,
  onSelectTask,
  onCheckThenRunTask,
  onRunTask,
  permissionSelectionOwnerKey,
  onPermissionSelectionChange,
  onConfirmFullAccessSelection,
  onOpenSandboxSettings,
  onCancelActiveRun,
  onOpenRun,
  onOpenApprovals,
  onRefreshRuntime,
  onCancelWorkUnit,
  onRetryWorkUnit,
  onReconcileWorkUnit,
  onResolveApproval,
  onClaimWorkItem,
  onHeartbeatWorkItem,
  onReleaseWorkItem,
  onCompleteWorkItem,
  onFailWorkItem,
  busyWorkItemId,
  onOpenProviders,
  workspaceSettings,
  onWorkspaceSettingsPatch,
}: WorkspaceClientViewProps): React.JSX.Element {
  const { t } = useI18n();
  const panelNavigation = useChannelPanelNavigation(Boolean(selectedTaskId));
  const { createTaskOpen, setCreateTaskOpen, sidePanelView, setSidePanelView, sidePanelOpen, setSidePanelOpen, channelSettingsPageOpen, setChannelSettingsPageOpen, channelEnvironmentPageOpen, setChannelEnvironmentPageOpen, channelMoreOpen, setChannelMoreOpen, progressPopoverOpen, setProgressPopoverOpen, workspaceSettingsOpen, setWorkspaceSettingsOpen, teammateManagerOpen, setTeammateManagerOpen } = panelNavigation;
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const activeWorkspaceCwd = cwd.trim();
  const channelFeedbackMessage = (surface: ChannelFeedbackEntry["surface"], identity: string): string => (
    [...channelFeedbackEntries].reverse().find((entry) =>
      entry.workspaceCwd === activeWorkspaceCwd && entry.surface === surface && entry.identity === identity
    )?.message ?? ""
  );
  const selectedComposerError = channelFeedbackMessage(
    "composer",
    channelConversationScopeKey({
      workspaceCwd: activeWorkspaceCwd,
      channelId: selectedChannelId,
      branchRootThreadId: selectedChannelBranchRootThreadId,
    }),
  );
  const selectedTaskError = channelFeedbackMessage("task", selectedTaskId || selectedChannelId);
  const selectedProtocolError = channelFeedbackMessage("protocol", selectedChannelId);
  const selectedDockError = channelFeedbackMessage("dock", selectedChannelId);
  const workflowErrors = useMemo(() => Object.fromEntries(
    channelFeedbackEntries
      .filter((entry) => entry.workspaceCwd === activeWorkspaceCwd && entry.surface === "workflow")
      .map((entry) => [entry.identity, entry.message]),
  ), [activeWorkspaceCwd, channelFeedbackEntries]);
  const channelComposerOwnerKey = JSON.stringify([cwd.trim(), selectedChannelId, selectedChannelBranchRootThreadId ?? "root"]);
  const channelComposerOwnerRef = useRef({ key: channelComposerOwnerKey });
  if (channelComposerOwnerRef.current.key !== channelComposerOwnerKey) channelComposerOwnerRef.current = { key: channelComposerOwnerKey };
  const channelComposerOwner = channelComposerOwnerRef.current;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const [environmentCommitDialogOpen, setEnvironmentCommitDialogOpen] = useState(false);
  const [environmentCommitMessage, setEnvironmentCommitMessage] = useState("");
  const [environmentIncludeUnstaged, setEnvironmentIncludeUnstaged] = useState(true);
  const environmentCommitReturnFocusRef = useRef<HTMLElement | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [channelTerminalReports, setChannelTerminalReports] = useState<readonly TerminalReportDto[]>([]);
  const conversationTimelineItemLocatorRef = useRef<ConversationTimelineItemLocator | null>(null);
  const [conversationThreadTurnsByKey, setConversationThreadTurnsByKey] = useState<Readonly<Record<string, ThreadTurnsLoadState>>>({});
  const [channelRenameOpen, setChannelRenameOpen] = useState(false);
  const [channelRenameName, setChannelRenameName] = useState("");
  const [channelRenameSaving, setChannelRenameSaving] = useState(false);
  const [channelRenameError, setChannelRenameError] = useState("");
  const [governanceNotificationsOpen, setGovernanceNotificationsOpen] = useState(false);
  const [attentionProgressExpanded, setAttentionProgressExpanded] = useState(true);
  const [conversationDetailOverlay, setConversationDetailOverlay] = useState<ConversationDetailOverlayState | undefined>();
  const [selectedSourceDetail, setSelectedSourceDetail] = useState<SelectedSourceDetailState | undefined>();
  const [channelBottomPanelOpen, setChannelBottomPanelOpen] = useState(false);
  const { selectedChannelWorkspace, selectedChannelExecutionPath, channelGitStatusState } = useChannelWorkspaceEnvironment({
    cwd, selectedChannel, environmentOpen: channelEnvironmentPageOpen, summaryOpen: progressPopoverOpen,
  });
  const channelUtilityPageOpen = channelSettingsPageOpen || channelEnvironmentPageOpen;
  const channelBottomPanelIntentOpen = channelBottomPanelOpen && !channelUtilityPageOpen;
  const channelBottomPanelPresence = useConversationPanelPresence(channelBottomPanelIntentOpen, false);
  const channelBottomPanelVisible = channelBottomPanelPresence.rendered;
  const channelRightDockIntentOpen = !channelUtilityPageOpen && sidePanelOpen;
  const channelRightDock = useChannelRightDockController({
    initialOpen: Boolean(selectedTaskId),
    intentOpen: channelRightDockIntentOpen,
    resizeObserverKey: selectedChannelId,
  });
  const channelRightDockVisible = channelRightDock.visible;
  const channelRightDockExpanded = channelRightDock.expanded;
  const channelRightDockResizing = channelRightDock.resizing;
  const rightDockPageRequest = channelRightDock.pageRequest;
  const channelRightDockMotionUntilRef = channelRightDock.motionUntilRef;
  const taskWorkbenchWindowRef = channelRightDock.windowRef;
  const taskWorkbenchMainRef = channelRightDock.mainRef;
  const channelBottomPanelResize = useChannelBottomPanelResizeController({
    containerRef: taskWorkbenchWindowRef,
    resizeObserverKey: selectedChannelId ?? "",
  });


  const [inspectorMode, setInspectorMode] = useState<ChannelInspectorMode>("brief");
  const [briefDraft, setBriefDraft] = useState({
    objective: "",
    scope: "",
    acceptanceCriteria: "",
    openQuestions: "",
    risks: "",
  });
  const {
    messageDraft,
    setMessageDraft,
    pendingAttachments,
    setPendingAttachments,
    pendingLinkPreviews,
    setPendingLinkPreviews,
    messageMentions,
    setMessageMentions,
    mentionPicker,
    setMentionPicker,
    mentionActiveIndex,
    setMentionActiveIndex,
    slashPicker,
    setSlashPicker,
    slashActiveIndex,
    setSlashActiveIndex,
    composerDragActive,
    setComposerDragActive,
    composerBusy,
    setComposerBusy,
    sendState,
    setSendState,
    sendError,
    setSendError,
    composerFeedback,
    composerInputMinHeight,
    pendingChannelSendPreview,
    setPendingChannelSendPreview,
    composerInputRef,
    autoPreviewUrlsRef,
    attachmentPreviewUrlsRef,
    handleComposerResizePointerDown,
    handleComposerResizePointerMove,
    handleComposerResizePointerEnd,
    showComposerFeedback,
  } = useChannelComposerDraftController(selectedChannelId);
  const [activeChannelGoal, setActiveChannelGoal] = useState<LingThreadGoal | undefined>();
  const [channelGoalLoadingThreadId, setChannelGoalLoadingThreadId] = useState("");
  const [channelGoalBusy, setChannelGoalBusy] = useState(false);
  const [channelGoalExpanded, setChannelGoalExpanded] = useState(false);
  const [channelGoalError, setChannelGoalError] = useState("");
  const [channelPlanModeChipVisible, setChannelPlanModeChipVisible] = useState(false);
  const [channelGoalChipVisible, setChannelGoalChipVisible] = useState(false);
  const [proposedPlanActionBusyId, setProposedPlanActionBusyId] = useState("");
  const [workflowConversionPreviewPlan, setWorkflowConversionPreviewPlan] = useState<ProposedPlanArtifact | undefined>();
  const [pendingChannelTeammateId, setPendingChannelTeammateId] = useState("");
  const [pendingChannelCouncilId, setPendingChannelCouncilId] = useState("");
  const [channelNotificationLevel, setChannelNotificationLevel] = useState<ChannelNotificationLevel>("mentions");
  const [channelSettingsAutosaveRevision, setChannelSettingsAutosaveRevision] = useState(0);
  const [channelCollaborationCardsState, setChannelCollaborationCardsState] = useState<{
    readonly channelId: string;
    readonly signature: string;
    readonly status: "idle" | "loaded" | "error";
    readonly cards: readonly CollaborationTaskCardModel[];
  }>({ channelId: "", signature: "", status: "idle", cards: [] });
  const [channelTeamMetricsState, setChannelTeamMetricsState] = useState<ChannelTeamMetricsState | undefined>();
  const [channelTeamMetricsLoading, setChannelTeamMetricsLoading] = useState(false);
  const [channelTeamMetricsError, setChannelTeamMetricsError] = useState("");
  const [channelTeamMetricsRefreshKey, setChannelTeamMetricsRefreshKey] = useState(0);
  const [channelMessageFeedbackById, setChannelMessageFeedbackById] = useState<Record<string, "up" | "down">>({});
  const [editingChannelMessageId, setEditingChannelMessageId] = useState<string | undefined>();
  const [channelMessageEditSaving, setChannelMessageEditSaving] = useState(false);
  const [channelMessageEditError, setChannelMessageEditError] = useState("");
  const [channelReplacementRetryingMessageId, setChannelReplacementRetryingMessageId] = useState<string>();
  const [channelReplacementRetryError, setChannelReplacementRetryError] = useState("");
  const channelMoreRef = useRef<HTMLDivElement | null>(null);
  const channelMoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const teammateManagerButtonRef = useRef<HTMLButtonElement | null>(null);
  const teammateManagerPanelRef = useRef<HTMLElement | null>(null);
  const conversationThreadTurnLoadsRef = useRef(new Set<string>());
  const conversationThreadTurnRunSignaturesRef = useRef(new Map<string, string>());
  const messageFeedChannelIdRef = useRef(selectedChannelId);
  const channelSettingsAutosaveTimerRef = useRef<number | undefined>(undefined);
  const channelSettingsAutosaveInFlightRef = useRef(false);
  const channelSettingsAutosaveQueuedRef = useRef(false);
  const channelSettingsAutosaveRequestRef = useRef(0);
  const channelSettingsAutosaveLastSavedKeyRef = useRef("");
  const channelSettingsAutosaveLatestKeyRef = useRef("");
  const onSaveChannelRef = useRef(onSaveChannel);
  const workspaceSettingsRef = useRef(workspaceSettings);
  const onWorkspaceSettingsPatchRef = useRef(onWorkspaceSettingsPatch);
  const channelWorkspaceFeedback = useChannelWorkspaceFeedback({
    cwd,
    selectedChannelId,
    selectedChannelExecutionPath,
    selectedChannelWorkspace,
    channelEditForm,
    onChannelEditFormChange,
    onRefreshChannels,
    t,
  });

  useEffect(() => {
    onSaveChannelRef.current = onSaveChannel;
  }, [onSaveChannel]);

  useEffect(() => {
    workspaceSettingsRef.current = workspaceSettings;
  }, [workspaceSettings]);

  useEffect(() => {
    onWorkspaceSettingsPatchRef.current = onWorkspaceSettingsPatch;
  }, [onWorkspaceSettingsPatch]);

  const activeRun = activeRunId ? runById.get(activeRunId) : undefined;
  const selectedChannelFormKey = useMemo(
    () => selectedChannel ? channelFormPersistenceKey(channelToForm(selectedChannel, cwd)) : "",
    [cwd, selectedChannel],
  );
  const channelEditFormKey = useMemo(() => channelFormPersistenceKey(channelEditForm), [channelEditForm]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const taskChannelById = useMemo(() => new Map(tasks.map((task) => [task.id, task.channelId])), [tasks]);
  const channelWorkCellDemoFixture = useMemo(
    () => channelWorkCellDemoFixtureEnabled() ? createChannelWorkCellDemoFixture({ channelId: selectedChannelId, cwd }) : undefined,
    [cwd, selectedChannelId],
  );
  const channelMessagesForDisplay = useMemo(
    () => channelWorkCellDemoFixture ? [...channelMessages, ...channelWorkCellDemoFixture.channelMessages] : channelMessages,
    [channelMessages, channelWorkCellDemoFixture],
  );
  const channelConversationItemsForDisplay = useMemo(
    () => channelWorkCellDemoFixture
      ? [...channelConversationItems, ...channelWorkCellDemoFixture.conversationItems]
      : channelConversationItems,
    [channelConversationItems, channelWorkCellDemoFixture],
  );
  const visibleChannelMessageIds = useMemo(
    () => new Set(channelMessagesForDisplay.map((message) => message.id)),
    [channelMessagesForDisplay],
  );
  const latestEditableChannelMessageId = useMemo(() => [...channelMessagesForDisplay]
    .filter((message) => message.authorType === "local-user" && !message.pendingReplacement)
    .filter((message) => {
      if (message.threadSurfaceKind) {
        return selectedChannelBranchRootThreadId
          ? message.threadSurfaceKind === "branch" && message.threadId === selectedChannelBranchRootThreadId
          : message.threadSurfaceKind === "channel_root";
      }
      // Data-only legacy fixtures have no canonical topology metadata.
      return selectedChannelBranchRootThreadId
        ? message.threadId === selectedChannelBranchRootThreadId
        : !message.threadId;
    })
    .at(-1)?.id, [channelMessagesForDisplay, selectedChannelBranchRootThreadId]);
  const memoryByIdForDisplay = useMemo(() => {
    if (!channelWorkCellDemoFixture) {
      return memoryById;
    }
    const next = new Map(memoryById);
    for (const memory of channelWorkCellDemoFixture.memoryObjects) {
      next.set(memory.id, memory);
    }
    return next;
  }, [channelWorkCellDemoFixture, memoryById]);
  const usedMemoryEventsForDisplay = useMemo(
    () => channelWorkCellDemoFixture ? [...usedMemoryEvents, ...channelWorkCellDemoFixture.usedMemoryEvents] : usedMemoryEvents,
    [channelWorkCellDemoFixture, usedMemoryEvents],
  );
  const channelWorkflowsForDisplay = useMemo(
    () => channelWorkCellDemoFixture ? [...channelWorkflows, ...channelWorkCellDemoFixture.workflows] : channelWorkflows,
    [channelWorkCellDemoFixture, channelWorkflows],
  );
  const channelWorkflowStepsForDisplay = useMemo(
    () => channelWorkCellDemoFixture ? [...channelWorkflowSteps, ...channelWorkCellDemoFixture.workflowSteps] : channelWorkflowSteps,
    [channelWorkCellDemoFixture, channelWorkflowSteps],
  );
  const runsForDisplay = useMemo(
    () => channelWorkCellDemoFixture ? [...runs, ...channelWorkCellDemoFixture.runs] : runs,
    [channelWorkCellDemoFixture, runs],
  );
  const channelArtifactsByRunForDisplay = useMemo(
    () => channelWorkCellDemoFixture
      ? { ...channelArtifactsByRun, ...channelWorkCellDemoFixture.artifactsByRun }
      : channelArtifactsByRun,
    [channelArtifactsByRun, channelWorkCellDemoFixture],
  );
  const channelExecutionActionsForDisplay = useMemo(
    () => channelWorkCellDemoFixture ? [...channelExecutionActions, ...channelWorkCellDemoFixture.executionActions] : channelExecutionActions,
    [channelExecutionActions, channelWorkCellDemoFixture],
  );
  const terminalReportsForDisplay = useMemo(
    () => channelWorkCellDemoFixture
      ? [...channelTerminalReports, ...channelWorkCellDemoFixture.terminalReports]
      : channelTerminalReports,
    [channelTerminalReports, channelWorkCellDemoFixture],
  );
  const channelWorkCellPreviewLoader = useMemo(
    () => async (request: PreviewRequest) => {
      const demoPreview = channelWorkCellDemoFixture
        ? resolveChannelWorkCellDemoPreview({
          artifactsByRun: channelWorkCellDemoFixture.artifactsByRun,
          request,
        })
        : undefined;
      return demoPreview ?? loadPreviewContent(request);
    },
    [channelWorkCellDemoFixture],
  );
  const workflowStepById = useMemo(() => new Map(channelWorkflowStepsForDisplay.map((step) => [step.id, step])), [channelWorkflowStepsForDisplay]);
  const channelAttachmentById = useMemo(
    () => new Map(channelAttachments.map((attachment) => [attachment.id, attachment])),
    [channelAttachments],
  );
  const channelLinkPreviewById = useMemo(
    () => new Map(channelLinkPreviews.map((preview) => [preview.id, preview])),
    [channelLinkPreviews],
  );
  const channelRuns = useMemo(
    () => deriveChannelRuns(selectedChannelId, tasks, runsForDisplay, activeRun),
    [activeRun, runsForDisplay, selectedChannelId, tasks],
  );
  const selectedChannelTasks = useMemo(
    () => tasks.filter((task) => task.channelId === selectedChannelId),
    [selectedChannelId, tasks],
  );
  const selectedChannelWorkflows = useMemo(
    () => channelWorkflowsForDisplay.filter((workflow) => workflow.channelId === selectedChannelId),
    [channelWorkflowsForDisplay, selectedChannelId],
  );
  const selectedChannelWorkflowSteps = useMemo(
    () => channelWorkflowStepsForDisplay.filter((step) => step.channelId === selectedChannelId),
    [channelWorkflowStepsForDisplay, selectedChannelId],
  );
  const channelCollaborationCardRefreshSignature = useMemo(() => {
    const workflowsSignature = channelWorkflows
      .filter((workflow) => workflow.channelId === selectedChannelId)
      .map((workflow) => [workflow.id, workflow.status, workflow.updatedAt].join(":"))
      .join("|");
    const stepsSignature = channelWorkflowSteps
      .filter((step) => step.channelId === selectedChannelId)
      .map((step) => [step.id, step.workflowId, step.status, step.runId ?? "", step.blocker ?? "", step.resultSummary ?? "", step.updatedAt].join(":"))
      .join("|");
    const runsSignature = channelRuns
      .map((run) => [run.id, run.status, run.workflowStepId ?? "", run.updatedAt, run.startedAt ?? "", run.endedAt ?? ""].join(":"))
      .join("|");
    const approvalsSignature = approvals
      .filter((approval) => approval.channelId === selectedChannelId || channelRuns.some((run) => run.id === approval.runId))
      .map((approval) => [approval.id, approval.runId ?? "", approval.workflowStepId ?? "", approval.status, approval.resolvedAt ?? "", approval.expiresAt ?? "", approval.createdAt].join(":"))
      .join("|");
    return [workflowsSignature, stepsSignature, runsSignature, approvalsSignature].join("\n");
  }, [approvals, channelRuns, channelWorkflowSteps, channelWorkflows, selectedChannelId]);
  const committedAssistantItemRevisionSignature = useMemo(
    () => channelMessagesForDisplay
      .filter((message) => message.channelId === selectedChannelId && message.kind === "ai_reply" && message.status !== "pending")
      .map((message) => [message.id, message.revision ?? 1, message.status, message.updatedAt].join(":"))
      .join("|"),
    [channelMessagesForDisplay, selectedChannelId],
  );
  const committedTerminalReportItemRevisionSignature = useMemo(
    () => channelTerminalReportItemRevisionSignature(channelConversationItems, selectedChannelId),
    [channelConversationItems, selectedChannelId],
  );
  useEffect(() => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId) {
      setChannelTerminalReports([]);
      return;
    }
    let cancelled = false;
    void listChannelTerminalReports(workspaceCwd, selectedChannelId, { limit: 200 })
      .then((response) => {
        if (!cancelled) {
          setChannelTerminalReports(response.reports);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChannelTerminalReports([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channelCollaborationCardRefreshSignature, committedAssistantItemRevisionSignature, committedTerminalReportItemRevisionSignature, cwd, selectedChannelId]);
  useEffect(() => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId) {
      setChannelCollaborationCardsState({ channelId: "", signature: "", status: "idle", cards: [] });
      return;
    }
    let cancelled = false;
    void listChannelCollaborationCards(workspaceCwd, selectedChannelId, { limit: 100 })
      .then((response) => {
        if (cancelled) {
          return;
        }
        setChannelCollaborationCardsState({
          channelId: selectedChannelId,
          signature: channelCollaborationCardRefreshSignature,
          status: "loaded",
          cards: response.cards,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setChannelCollaborationCardsState({
          channelId: selectedChannelId,
          signature: channelCollaborationCardRefreshSignature,
          status: "error",
          cards: [],
        });
      });
    return () => {
      cancelled = true;
    };
  }, [channelCollaborationCardRefreshSignature, cwd, selectedChannelId]);
  const {
    activeWorkThreadId,
    setActiveWorkThreadId,
    visibleChannelWorkThreads,
    channelWorkThreadTreeRows,
    channelWorkThreadsLoading,
    channelWorkThreadError,
    channelWorkThreadSearch,
    setChannelWorkThreadSearch,
    channelWorkThreadSearchActive,
    channelDiscussionRootThread,
    forkingWorkThreadId,
    workThreadVisibilityId,
    workThreadConversationModeId,
    archiveConfirmWorkThreadId,
    setArchiveConfirmWorkThreadId,
    forkChannelWorkThread,
    forkChannelMainBranch,
    ensureChannelDiscussionRootThread,
    mutateChannelWorkThreadVisibility,
    updateChannelWorkThreadConversationMode,
  } = useChannelWorkThreadsController({
    cwd,
    selectedChannelId,
    channelRuns,
  });
  const channelWorkThreadTreeVisible = false;
  const channelRunsByThreadId = useMemo(() => groupRunsByThreadId(channelRuns), [channelRuns]);
  const terminalReportByWorkflowId = useMemo(
    () => latestTerminalReportMap(terminalReportsForDisplay.filter((report) => report.source.kind === "workflow"), (report) => report.source.id),
    [terminalReportsForDisplay],
  );
  const terminalReportByThreadId = useMemo(
    () => latestTerminalReportMap(terminalReportsForDisplay.filter((report) => Boolean(report.threadId)), (report) => report.threadId ?? ""),
    [terminalReportsForDisplay],
  );
  const terminalReportResultItemIds = useMemo(
    () => new Set(terminalReportsForDisplay.map(terminalReportResultItemId)),
    [terminalReportsForDisplay],
  );
  const channelContextSegmentIdByItemId = useMemo(
    () => new Map([
      ...buildCommittedContextSegmentLookup(channelConversationItems, channelTurnContextAssignments),
      ...(channelWorkCellDemoFixture?.contextSegmentIdByItemId ?? new Map()),
    ]),
    [channelConversationItems, channelTurnContextAssignments, channelWorkCellDemoFixture],
  );
  const visibleConversationThreadIds = useMemo(() => [...channelRunsByThreadId.keys()], [channelRunsByThreadId]);
  const visibleConversationThreadRunSignatures = useMemo(() => {
    const signatures = new Map<string, string>();
    for (const [threadId, threadRuns] of channelRunsByThreadId) {
      signatures.set(
        threadId,
        threadRuns
          .map((run) => [run.id, run.status, run.updatedAt, run.startedAt ?? "", run.endedAt ?? ""].join(":"))
          .join("|"),
      );
    }
    return signatures;
  }, [channelRunsByThreadId]);
  const conversationWorkCellByThreadId = useMemo(() => {
    const cells = new Map<string, NonNullable<ReturnType<typeof buildConversationWorkCellViewModel>>>();
    for (const [threadId] of channelRunsByThreadId) {
      const turnState = conversationThreadTurnsByKey[threadTurnsCacheKey(threadId)];
      const cell = buildConversationWorkCellViewModel({
        threadId,
        runs: channelRuns,
        turns: turnState?.status === "loaded" ? turnState.turns : undefined,
        turnRunLinks: turnState?.status === "loaded" ? turnState.runLinks : undefined,
        approvals,
        artifactsByRun: channelArtifactsByRunForDisplay,
        executionActions: channelExecutionActionsForDisplay,
        contextSegmentIdByItemId: channelContextSegmentIdByItemId,
        t,
        artifactHref: (artifact) => artifactContentUrl(artifact.id, cwd),
        terminalReport: terminalReportByThreadId.get(threadId),
      });
      if (cell) {
        cells.set(threadId, cell);
      }
    }
    return cells;
  }, [approvals, channelArtifactsByRunForDisplay, channelContextSegmentIdByItemId, channelExecutionActionsForDisplay, channelRuns, channelRunsByThreadId, conversationThreadTurnsByKey, cwd, t, terminalReportByThreadId]);
  const workflowProgressByWorkflowId = useMemo(() => {
    const cells = new Map<string, WorkflowProgressModel>();
    for (const workflow of channelWorkflowsForDisplay.filter((item) => item.channelId === selectedChannelId)) {
      const steps = channelWorkflowStepsForDisplay.filter((step) => step.workflowId === workflow.id);
      if (steps.length === 0) {
        continue;
      }
      cells.set(workflow.id, buildWorkflowProgressModel({
        workflow,
        steps,
        runs: channelRuns,
        approvals,
        artifactsByRun: channelArtifactsByRunForDisplay,
        executionActions: channelExecutionActionsForDisplay,
        contextSegmentIdByItemId: channelContextSegmentIdByItemId,
        t,
        artifactHref: (artifact) => artifactContentUrl(artifact.id, cwd),
        terminalReport: terminalReportByWorkflowId.get(workflow.id),
      }));
    }
    return cells;
  }, [approvals, channelArtifactsByRunForDisplay, channelContextSegmentIdByItemId, channelExecutionActionsForDisplay, channelRuns, channelWorkflowStepsForDisplay, channelWorkflowsForDisplay, cwd, selectedChannelId, t, terminalReportByWorkflowId]);
  const localCollaborationTaskCardByWorkflowId = useMemo(() => {
    const cards = new Map<string, CollaborationTaskCardModel>();
    for (const workflow of channelWorkflowsForDisplay.filter((item) => item.channelId === selectedChannelId)) {
      const card = buildCollaborationTaskCardModel({
        workflow,
        steps: channelWorkflowStepsForDisplay.filter((step) => step.workflowId === workflow.id),
        runs: channelRuns,
        approvals,
        t,
      });
      if (card) {
        cards.set(workflow.id, card);
      }
    }
    return cards;
  }, [approvals, channelRuns, channelWorkflowStepsForDisplay, channelWorkflowsForDisplay, selectedChannelId, t]);
  const collaborationTaskCardByWorkflowId = useMemo(() => {
    const cards = new Map(localCollaborationTaskCardByWorkflowId);
    if (
      channelCollaborationCardsState.status === "loaded" &&
      channelCollaborationCardsState.channelId === selectedChannelId &&
      channelCollaborationCardsState.signature === channelCollaborationCardRefreshSignature
    ) {
      for (const card of channelCollaborationCardsState.cards) {
        cards.set(card.workflowId, card);
      }
    }
    return cards;
  }, [channelCollaborationCardRefreshSignature, channelCollaborationCardsState, localCollaborationTaskCardByWorkflowId, selectedChannelId]);
  const conversationWorkCellByWorkflowId = useMemo(() => {
    const cells = new Map<string, ConversationWorkCellViewModel>();
    for (const [workflowId, progressModel] of workflowProgressByWorkflowId) {
      if (progressModel.conversationVisibility === "audit_only") {
        continue;
      }
      cells.set(workflowId, workflowProgressToConversationWorkCell(progressModel));
    }
    return cells;
  }, [workflowProgressByWorkflowId]);
  const workflowRepresentedRunIds = useMemo(() => {
    const runIds = new Set<string>();
    for (const model of workflowProgressByWorkflowId.values()) {
      for (const runId of model.runIds) {
        runIds.add(runId);
      }
    }
    return runIds;
  }, [workflowProgressByWorkflowId]);
  const latestRun = channelRuns[0];
  const {
    activityToolsOpen,
    setActivityToolsOpen,
    activitySearch,
    setActivitySearch,
    activityCategoryFilter,
    setActivityCategoryFilter,
    activityAttentionFilter,
    setActivityAttentionFilter,
    activeActivityViewId,
    activityFiltersExpanded,
    setActivityFiltersExpanded,
    setActivityDrilldownItemId,
    activityItems,
    filteredActivityItems,
    allActivitySavedViews,
    savedViewCounts,
    selectedActivitySavedView,
    activityCategoryCounts,
    activityAttentionCounts,
    activityFiltersActive,
    auditActivityVisible,
    activityDrilldown,
    customViewLimitReached,
    applyActivityView,
    saveActivityView,
    renameActivityView,
    deleteActivityView,
    clearActivityFilters,
    resetActivityForChannelSwitch,
  } = useChannelActivityController({
    cwd,
    selectedChannelId,
    channelMessages: channelMessagesForDisplay,
    channelAttachments,
    tasks,
    runs: runsForDisplay,
    approvals,
    channelStateTransitions,
    channelDecisions,
    channelHandoffs,
    channelContextSummaries,
    channelWorkflows: channelWorkflowsForDisplay,
    channelWorkflowSteps: channelWorkflowStepsForDisplay,
    latestRun,
    workspaceSettings,
    onWorkspaceSettingsPatch,
    t,
  });
  const channelHeader = useChannelHeaderController({
    channelId: selectedChannelId,
    onSearchChange: setActivitySearch,
  });
  const channelActivityToolsVisible =
    activityToolsOpen ||
    activityCategoryFilter !== "all" ||
    activityAttentionFilter !== "all";
  useEffect(() => {
    const workspaceCwd = cwd.trim();
    const visibleKeys = new Set(visibleConversationThreadIds.map((threadId) => threadTurnsCacheKey(threadId)));
    setConversationThreadTurnsByKey((current) => {
      const entries = Object.entries(current).filter(([key]) => visibleKeys.has(key));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
    if (!workspaceCwd) {
      return;
    }
    for (const threadId of visibleConversationThreadIds) {
      const cacheKey = threadTurnsCacheKey(threadId);
      const runSignature = visibleConversationThreadRunSignatures.get(threadId) ?? "";
      const lastRunSignature = conversationThreadTurnRunSignaturesRef.current.get(cacheKey);
      const currentState = conversationThreadTurnsByKey[cacheKey];
      const shouldRefresh = lastRunSignature !== runSignature || currentState === undefined || currentState.status === "not_loaded";
      if (!shouldRefresh || conversationThreadTurnLoadsRef.current.has(cacheKey)) {
        continue;
      }
      conversationThreadTurnRunSignaturesRef.current.set(cacheKey, runSignature);
      conversationThreadTurnLoadsRef.current.add(cacheKey);
      setConversationThreadTurnsByKey((current) => ({
        ...current,
        [cacheKey]: { status: "loading" },
      }));
      void listLingThreadTurns(workspaceCwd, threadId, { limit: 50 })
        .then((response) => {
          setConversationThreadTurnsByKey((current) => ({
            ...current,
            [cacheKey]: {
              status: "loaded",
              turns: response.turns,
              runLinks: response.runLinks,
            },
          }));
        })
        .catch((caught: unknown) => {
          const message = caught instanceof Error ? caught.message : String(caught);
          setConversationThreadTurnsByKey((current) => ({
            ...current,
            [cacheKey]: {
              status: "error",
              errorMessage: message || t("Evidence failed to load."),
            },
          }));
        })
        .finally(() => {
          conversationThreadTurnLoadsRef.current.delete(cacheKey);
        });
    }
  }, [conversationThreadTurnsByKey, cwd, t, visibleConversationThreadIds, visibleConversationThreadRunSignatures]);
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
  const inlineApprovalViews = useMemo(
    () =>
      buildInlineApprovalViews(approvals, {
        owner: { kind: "channel", channelId: selectedChannelId },
        runs,
        tasks,
        workUnits,
        workflowSteps: channelWorkflowSteps,
      }),
    [approvals, channelWorkflowSteps, runs, selectedChannelId, tasks, workUnits],
  );
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
  const fallbackConversationRun = activeRun && runCanBeStoppedInComposer(activeRun, workflowStepById)
    ? activeRun
    : channelRuns.find((candidate) => runCanBeStoppedInComposer(candidate, workflowStepById));
  const guidanceTeammateLabelById = useMemo(() => new Map([
    ...teammateTemplates.map((teammate) => [teammate.id, teammate.name] as const),
    ...localTeammates.map((teammate) => [teammate.id, teammate.displayName] as const),
  ]), [localTeammates, teammateTemplates]);
  const channelGuidanceTeammateLabel = useMemo(
    () => (teammateId: string | undefined) => teammateId
      ? guidanceTeammateLabelById.get(teammateId) ?? (teammateId === LING_AGENT_AUTHOR_ID ? t("Ling Agent") : t("AI teammate"))
      : t("AI teammate"),
    [guidanceTeammateLabelById, t],
  );
  const channelSendLifecycle = useConversationSendLifecycle(
    `channel:${selectedChannelId}:${selectedChannelBranchRootThreadId ?? "root"}`,
  );
  const channelActiveStatusStrip = providerBlocker && inlineApprovalViews.length === 0 ? (
    <ConversationStatusStrip
      className="channel-active-status-strip conversation-composer-status-strip attention"
      icon={<CircleAlert size={15} />}
      title={t("Provider needs attention")}
      description={providerBlocker}
      statusNode={<ChannelActiveStatusIndicator kind="provider-blocked" />}
      metaItems={[
        {
          id: "provider",
          label: t("Provider"),
          value: effectiveProvider
            ? providerDisplaySourceLabel(effectiveProvider.displayName, effectiveProvider.model)
            : t("No model selected"),
        },
      ]}
      actions={[
        {
          id: "open-settings",
          label: t("Settings"),
          icon: <SlidersHorizontal size={14} />,
          onClick: openChannelSettingsPage,
        },
      ]}
    />
  ) : null;

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
    setGovernanceNotificationsOpen(false);
  }, [selectedChannelId]);

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

  const silentChannelReplyRunIds = useMemo(
    () => deriveSilentChannelReplyRunIds({
      runs: channelRuns,
      workUnits,
      approvals,
      executionActions: channelExecutionActionsForDisplay,
      terminalReports: terminalReportsForDisplay,
    }),
    [approvals, channelExecutionActionsForDisplay, channelRuns, terminalReportsForDisplay, workUnits],
  );
  const conversationTurnProjection = useMemo(
    () => buildConversationTurnProjection({
      channelId: selectedChannelId,
      messages: channelMessagesForDisplay,
      conversationItems: channelConversationItemsForDisplay,
      proposals: channelExecutionProposals,
      intentDecisions: channelIntentDecisions,
      workflows: channelWorkflowsForDisplay,
      workflowSteps: channelWorkflowStepsForDisplay,
      runs: channelRuns,
      usedMemoryEvents: usedMemoryEventsForDisplay,
      operationCellByWorkflowId: conversationWorkCellByWorkflowId,
      operationCellByThreadId: conversationWorkCellByThreadId,
      lingAgentAuthorId: LING_AGENT_AUTHOR_ID,
      terminalReportResultItemIds,
      silentChannelReplyRunIds,
    }),
    [
      channelExecutionProposals,
      channelIntentDecisions,
      channelMessagesForDisplay,
      channelConversationItemsForDisplay,
      channelRuns,
      channelWorkflowStepsForDisplay,
      channelWorkflowsForDisplay,
      conversationWorkCellByThreadId,
      conversationWorkCellByWorkflowId,
      selectedChannelId,
      terminalReportResultItemIds,
      silentChannelReplyRunIds,
      usedMemoryEventsForDisplay,
    ],
  );
  useEffect(() => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId || !channelSettingsPageOpen) {
      return;
    }
    let cancelled = false;
    setChannelTeamMetricsLoading(true);
    setChannelTeamMetricsError("");
    void getChannelTeamMetricsProjection(workspaceCwd, selectedChannelId, { limit: 250 })
      .then((response) => {
        if (cancelled) {
          return;
        }
        setChannelTeamMetricsState({ channelId: response.channelId, metrics: response.metrics });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setChannelTeamMetricsError(error instanceof Error ? error.message : String(error));
        setChannelTeamMetricsState(undefined);
      })
      .finally(() => {
        if (!cancelled) {
          setChannelTeamMetricsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channelSettingsPageOpen, channelTeamMetricsRefreshKey, cwd, selectedChannelId]);
  const selectedChannelBranchActivityScope = useMemo<BranchConversationActivityScope | undefined>(() => {
    if (!selectedChannelBranchRootThreadId) {
      return undefined;
    }
    const messageIds = new Set(
      channelMessagesForDisplay
        .filter((message) => message.threadId === selectedChannelBranchRootThreadId)
        .map((message) => message.id),
    );
    const runIds = new Set(
      channelRuns
        .filter((run) => run.threadId === selectedChannelBranchRootThreadId)
        .map((run) => run.id),
    );
    const taskIds = new Set(
      tasks
        .filter((task) => task.currentRunId && runIds.has(task.currentRunId))
        .map((task) => task.id),
    );
    const workflowIds = new Set(
      channelWorkflowsForDisplay
        .filter((workflow) => workflow.metadata?.sourceMessageId && messageIds.has(workflow.metadata.sourceMessageId))
        .map((workflow) => workflow.id),
    );
    const workflowStepIds = new Set<string>();
    for (const step of channelWorkflowStepsForDisplay) {
      const belongsToBranch = (
        workflowIds.has(step.workflowId) ||
        Boolean(step.runId && runIds.has(step.runId)) ||
        Boolean(step.metadata?.sourceMessageId && messageIds.has(step.metadata.sourceMessageId))
      );
      if (belongsToBranch) {
        workflowStepIds.add(step.id);
        workflowIds.add(step.workflowId);
      }
    }
    return {
      threadId: selectedChannelBranchRootThreadId,
      messageIds,
      runIds,
      taskIds,
      workflowIds,
      workflowStepIds,
    };
  }, [channelMessagesForDisplay, channelRuns, channelWorkflowStepsForDisplay, channelWorkflowsForDisplay, selectedChannelBranchRootThreadId, tasks]);
  const visibleActivityItems = useMemo(
    () => {
      const baseItems = auditActivityVisible
        ? filteredActivityItems
        : filteredActivityItems.filter((item) =>
          channelActivityVisibleInDefaultChat(item) ||
          (item.kind === "workflow" && workflowProgressByWorkflowId.has(item.record.id)) ||
          (item.kind === "run" && Boolean(item.record.threadId && conversationWorkCellByThreadId.has(item.record.threadId)))
        );
      const scopedItems = selectedChannelBranchActivityScope
        ? baseItems.filter((item) => channelActivityItemBelongsToBranchConversation(item, selectedChannelBranchActivityScope))
        : baseItems;
      return activeWorkThreadId
        ? scopedItems.filter((item) => item.kind === "run" && item.record.threadId === activeWorkThreadId)
        : scopedItems;
    },
    [
      activeWorkThreadId,
      auditActivityVisible,
      conversationWorkCellByThreadId,
      filteredActivityItems,
      selectedChannelBranchActivityScope,
      workflowProgressByWorkflowId,
    ],
  );
  const renderableActivityItems = useMemo(
    () => visibleActivityItems.filter((item) => {
      if (!auditActivityVisible && conversationTurnProjection.hiddenActivityIds.has(item.id)) {
        return false;
      }
      if (!auditActivityVisible && item.kind === "workflow-step" && workflowProgressByWorkflowId.has(item.record.workflowId)) {
        return false;
      }
      if (!auditActivityVisible && item.kind === "run" && workflowRepresentedRunIds.has(item.record.id)) {
        return false;
      }
      if (!auditActivityVisible && item.kind === "run" && silentChannelReplyRunIds.has(item.record.id)) {
        return false;
      }
      if (item.kind !== "run" || !item.record.threadId) {
        return true;
      }
      const workCell = conversationWorkCellByThreadId.get(item.record.threadId);
      return !workCell || workCell.anchorRunId === item.record.id;
    }),
    [auditActivityVisible, conversationTurnProjection.hiddenActivityIds, conversationWorkCellByThreadId, silentChannelReplyRunIds, visibleActivityItems, workflowProgressByWorkflowId, workflowRepresentedRunIds],
  );
  const latestVisibleActivityItemId =
    renderableActivityItems.length > 0 ? renderableActivityItems[renderableActivityItems.length - 1]?.id ?? "" : "";
  const {
    conversationFeedBodyItems,
    messageFeedCanLoadOlder,
    messageFeedEmpty,
    messageFeedItems,
  } = useChannelMessageFeedAssembly({
    activeWorkThreadId,
    activityFiltersActive,
    auditActivityVisible,
    channelMessages: channelMessagesForDisplay,
    channelMessagesHasOlder,
    channelMessagesLoading,
    channelProtocolLoading,
    conversationTurns: conversationTurnProjection.turns,
    pendingChannelSendPreview,
    renderableActivityItems,
    selectedChannelBranchRootThreadId,
    selectedChannelId,
  });
  const messageFeedState = useChannelMessageFeed({
    items: messageFeedItems,
    conversationWorkCellByWorkflowId,
    conversationWorkCellByThreadId,
    canLoadOlder: messageFeedCanLoadOlder,
    loading: channelMessagesLoading,
    loadingOlder: channelMessagesLoadingOlder,
    protocolLoading: channelProtocolLoading,
    tailDependencyKey: latestVisibleActivityItemId,
    latestVisibleItemId: latestVisibleActivityItemId,
    renderableItemCount: renderableActivityItems.length,
    restoreBlockedUntilRef: channelRightDockMotionUntilRef,
    onLoadOlder: onLoadOlderChannelMessages,
  });
  const {
    conversationBlockActionMenuNode,
    conversationBlockFeedbackNode,
    closeConversationBlockActionMenu,
    handleMessageFeedContextMenu,
    handleMessageFeedKeyDown,
    handleMessageFeedPointerDown,
    handleMessageFeedPointerEnd,
    handleMessageFeedPointerMove,
  } = useChannelConversationBlockInteractions({
    scrollRef: messageFeedState.scrollRef,
    t,
  });
  const allTeammateOptions = useMemo(
    () => [
      ...teammateTemplates.map((template) => ({ id: template.id, label: template.name, kind: "ai-teammate" as const })),
      ...localTeammates
        .filter((teammate) => !teammate.disabled)
        .map((teammate) => ({ id: teammate.id, label: teammate.displayName, kind: "ai-teammate" as const })),
    ],
    [localTeammates, teammateTemplates],
  );
  const activeLocalTeammates = useMemo(
    () => localTeammates.filter((teammate) => !teammate.disabled),
    [localTeammates],
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
  const channelGuidanceTarget = useChannelGuidanceTargetController({
    selectedChannelId,
    conversationLineThreadId: selectedChannelBranchRootThreadId,
    channelMessages,
    channelRuns,
    workUnits,
    transientReplies: channelSendLifecycle.activeReplies,
    fallbackRun: fallbackConversationRun,
    messageMentions,
    teammateLabel: channelGuidanceTeammateLabel,
  });
  const activeConversationTarget = channelGuidanceTarget.activeTarget;
  const isCancellingRun = Boolean(activeConversationTarget && cancellingRunIds.includes(activeConversationTarget.activeReply.runId));
  const guidanceModeActive = channelGuidanceTarget.guidanceModeActive;
  const activeConversationSourceRunId = channelGuidanceTarget.sourceRunId;
  const threadReplyController = useChannelThreadReplyController({
    refreshToken: channelConversationRefreshToken,
    cwd,
    selectedChannelId,
    channelMessages,
    channelRuns,
    workUnits,
    transientReplies: channelSendLifecycle.activeReplies,
    teammateOptions,
    onSendMessage,
  });
  const channelComposerSnapshots = useChannelComposerSnapshotController({
    ownerKey: channelComposerOwnerKey,
    messageDraft,
    setMessageDraft,
    pendingAttachments,
    setPendingAttachments,
    pendingLinkPreviews,
    setPendingLinkPreviews,
    messageMentions,
    setMessageMentions,
    sendState,
    setSendState,
    sendError,
    setSendError,
    setMentionPicker,
    setMentionActiveIndex,
    threadReplySnapshot: threadReplyController.snapshot,
    restoreThreadReplySnapshot: threadReplyController.restoreSnapshot,
    autoPreviewUrlsRef,
    onChannelSwitch: () => {
      resetActivityForChannelSwitch();
      setPendingChannelTeammateId("");
      setChannelMoreOpen(false);
      setPendingChannelSendPreview(undefined);
      setAttentionProgressExpanded(true);
      setSidePanelView("context");
      setSidePanelOpen(false);
      setChannelSettingsPageOpen(false);
      setChannelEnvironmentPageOpen(false);
      setProgressPopoverOpen(false);
      setSelectedApprovalId("");
      setCreateTaskOpen(false);
      setChannelNotificationLevel("mentions");
      messageFeedState.reset();
    },
  });
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
  const [selectedExecutionProposalTarget, setSelectedExecutionProposalTarget] = useState<{
    readonly channelId: string;
    readonly proposalId: string;
  }>();
  const newestActionableExecutionProposal = [...channelExecutionProposals]
    .filter((proposal) =>
      proposal.channelId === selectedChannelId &&
      isActionableExecutionProposal(proposal)
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))[0];
  const explicitlySelectedExecutionProposal = selectedExecutionProposalTarget?.channelId === selectedChannelId
    ? channelExecutionProposals.find((proposal) =>
        proposal.channelId === selectedChannelId &&
        proposal.id === selectedExecutionProposalTarget.proposalId &&
        isActionableExecutionProposal(proposal)
      )
    : undefined;
  const selectedExecutionProposal = explicitlySelectedExecutionProposal ?? newestActionableExecutionProposal;

  function openExecutionProposal(proposal: ChannelExecutionProposal): void {
    setSelectedExecutionProposalTarget({ channelId: proposal.channelId, proposalId: proposal.id });
  }
  const channelRunsForFiles = channelRuns;

  useEffect(() => {
    channelSettingsAutosaveLatestKeyRef.current = channelEditFormKey;
  }, [channelEditFormKey]);

  useEffect(() => {
    if (channelSettingsAutosaveRevision === 0) {
      channelSettingsAutosaveLastSavedKeyRef.current = selectedChannelFormKey;
    }
  }, [channelSettingsAutosaveRevision, selectedChannelFormKey]);

  useEffect(() => {
    channelSettingsAutosaveRequestRef.current += 1;
    channelSettingsAutosaveLastSavedKeyRef.current = selectedChannelFormKey;
    channelSettingsAutosaveQueuedRef.current = false;
    setChannelSettingsAutosaveRevision(0);
    if (channelSettingsAutosaveTimerRef.current !== undefined) {
      globalThis.clearTimeout(channelSettingsAutosaveTimerRef.current);
      channelSettingsAutosaveTimerRef.current = undefined;
    }
  }, [cwd, selectedChannelId]);

  useEffect(() => {
    if (channelSettingsAutosaveRevision === 0 || !selectedChannelId) {
      return undefined;
    }
    if (channelEditFormKey === selectedChannelFormKey || channelEditFormKey === channelSettingsAutosaveLastSavedKeyRef.current) {
      return undefined;
    }

    if (channelSettingsAutosaveTimerRef.current !== undefined) {
      globalThis.clearTimeout(channelSettingsAutosaveTimerRef.current);
    }

    channelSettingsAutosaveTimerRef.current = globalThis.setTimeout(() => {
      const saveSnapshot = async (): Promise<void> => {
        if (channelSettingsAutosaveInFlightRef.current) {
          channelSettingsAutosaveQueuedRef.current = true;
          return;
        }

        const requestId = ++channelSettingsAutosaveRequestRef.current;
        const snapshotKey = channelEditFormKey;
        const snapshotForm = channelEditForm;
        channelSettingsAutosaveInFlightRef.current = true;
        try {
          await onSaveChannelRef.current(snapshotForm);
          if (requestId === channelSettingsAutosaveRequestRef.current) {
            channelSettingsAutosaveLastSavedKeyRef.current = snapshotKey;
          }
        } catch {
          // The next edit schedules another save attempt.
        } finally {
          channelSettingsAutosaveInFlightRef.current = false;
          if (requestId === channelSettingsAutosaveRequestRef.current) {
            const hasQueuedChange = channelSettingsAutosaveQueuedRef.current || channelSettingsAutosaveLatestKeyRef.current !== snapshotKey;
            channelSettingsAutosaveQueuedRef.current = false;
            if (hasQueuedChange) {
              setChannelSettingsAutosaveRevision((current) => current + 1);
            }
          }
        }
      };

      void saveSnapshot();
    }, 700);

    return () => {
      if (channelSettingsAutosaveTimerRef.current !== undefined) {
        globalThis.clearTimeout(channelSettingsAutosaveTimerRef.current);
        channelSettingsAutosaveTimerRef.current = undefined;
      }
    };
  }, [channelEditForm, channelEditFormKey, channelSettingsAutosaveRevision, selectedChannelFormKey, selectedChannelId]);

  const selectedChannelNotificationLevel = workspaceSettings?.channelNotifications?.[selectedChannelId];
  const workspaceSettingsLoaded = workspaceSettings !== undefined;

  useEffect(() => {
    const legacyNotificationLevel = readSavedChannelNotificationLevel(cwd, selectedChannelId);
    const hasSelectedChannel = selectedChannelId.trim().length > 0;
    const shouldMigrateNotification =
      workspaceSettingsLoaded &&
      hasSelectedChannel &&
      !isChannelNotificationLevel(selectedChannelNotificationLevel) &&
      legacyNotificationLevel !== undefined;
    const currentWorkspaceSettings = workspaceSettingsRef.current;

    setPendingChannelTeammateId("");
    setChannelNotificationLevel(
      isChannelNotificationLevel(selectedChannelNotificationLevel)
        ? selectedChannelNotificationLevel
        : legacyNotificationLevel ?? "mentions",
    );
    if (shouldMigrateNotification && currentWorkspaceSettings) {
      onWorkspaceSettingsPatchRef.current({
        channelNotifications: {
          ...(currentWorkspaceSettings.channelNotifications ?? {}),
          [selectedChannelId]: legacyNotificationLevel ?? "mentions",
        },
      });
    } else if (workspaceSettingsLoaded && hasSelectedChannel) {
      if (isChannelNotificationLevel(selectedChannelNotificationLevel)) {
        clearSavedChannelNotificationLevel(cwd, selectedChannelId);
      }
    }
    if (messageFeedChannelIdRef.current !== selectedChannelId) {
      messageFeedChannelIdRef.current = selectedChannelId;
      messageFeedState.reset();
    }
    closeConversationBlockActionMenu();
  }, [closeConversationBlockActionMenu, cwd, messageFeedState.reset, selectedChannelId, selectedChannelNotificationLevel, workspaceSettingsLoaded]);

  useEffect(() => {
    setBriefDraft({
      objective: channelBrief?.objective ?? "",
      scope: channelBrief?.scope ?? "",
      acceptanceCriteria: (channelBrief?.acceptanceCriteria ?? []).join("\n"),
      openQuestions: (channelBrief?.openQuestions ?? []).join("\n"),
      risks: (channelBrief?.risks ?? []).join("\n"),
    });
  }, [channelBrief]);

  const hasPendingReply = channelMessages.some((message) => message.kind === "ai_reply" && message.status === "pending");

  useEffect(() => {
    if (!selectedChannelId || !hasPendingReply) {
      return undefined;
    }
    const intervalId = globalThis.setInterval(() => {
      onRefreshPendingChannelReply();
    }, 1_000);
    return () => globalThis.clearInterval(intervalId);
  }, [hasPendingReply, onRefreshPendingChannelReply, selectedChannelId]);

  useEffect(() => {
    if (!selectedTaskId || !selectedTask) {
      return;
    }
    setCreateTaskOpen(false);
    setSidePanelView("task");
    setSidePanelOpen(true);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setProgressPopoverOpen(false);
  }, [selectedTask, selectedTaskId]);

  function selectTask(taskId: string): void {
    setCreateTaskOpen(false);
    setSidePanelView("task");
    setSidePanelOpen(true);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setProgressPopoverOpen(false);
    onSelectTask(taskId);
  }

  function openTaskFromActivity(taskId: string): void {
    setActivityToolsOpen(false);
    setChannelMoreOpen(false);
    selectTask(taskId);
  }

  function openRunInPanel(runId: string): void {
    const run = runById.get(runId);
    setActivityToolsOpen(false);
    setChannelMoreOpen(false);
    setProgressPopoverOpen(false);
    onRefreshChannelActivity();
    onRefreshChannelFiles();
    onRefreshTasks();
    if (run?.taskId && taskById.has(run.taskId)) {
      selectTask(run.taskId);
      return;
    }
    onOpenRun(runId);
  }

  function openProtocolFromActivity(mode: ChannelInspectorMode = "runtime"): void {
    setActivityToolsOpen(false);
    setChannelMoreOpen(false);
    setInspectorMode(mode);
    panelNavigation.prepareDock("context");
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setProgressPopoverOpen(false);
    if (mode === "runtime") {
      onRefreshRuntime();
    } else {
      onRefreshChannelProtocol();
    }
  }

  function revealReviewInConversation(): void {
    setActivityToolsOpen(false);
    setChannelMoreOpen(false);
    onSelectTask("");
    setSidePanelOpen(false);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setProgressPopoverOpen(channelHasProgressPopoverContent);
    setAttentionProgressExpanded(true);
    setCreateTaskOpen(false);
  }

  function revealConversationThreadFromActivity(threadId: string): void {
    setActivityToolsOpen(false);
    setChannelMoreOpen(false);
    setActivityDrilldownItemId("");
    onSelectTask("");
    setSidePanelOpen(false);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setProgressPopoverOpen(false);
    setCreateTaskOpen(false);
    setActiveWorkThreadId("");
    globalThis.setTimeout(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>(".conversation-work-cell"))
        .find((element) => element.dataset.threadId === threadId);
      if (target) {
        revealConversationTarget(target);
      }
    }, 80);
  }

  function revealRunFromActivity(runId: string): void {
    const run = runById.get(runId);
    if (run?.threadId && conversationWorkCellByThreadId.has(run.threadId)) {
      revealConversationThreadFromActivity(run.threadId);
      return;
    }
    revealReviewInConversation();
  }

  function revealTaskFromActivity(taskId: string): void {
    const task = taskById.get(taskId);
    const linkedRun = task?.currentRunId ? runById.get(task.currentRunId) : undefined;
    const latestTaskRun = [...channelRuns]
      .filter((run) => run.taskId === taskId)
      .sort((left, right) => compareRunActivity(right, left))[0];
    const run = linkedRun ?? latestTaskRun;
    if (run?.threadId && conversationWorkCellByThreadId.has(run.threadId)) {
      revealConversationThreadFromActivity(run.threadId);
      return;
    }
    revealReviewInConversation();
  }

  function openApprovalDetail(approval: ApprovalRequest | undefined): void {
    setSelectedApprovalId(approval?.id ?? "");
    setConversationDetailOverlay({ kind: "approval" });
    setSidePanelOpen(false);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setProgressPopoverOpen(false);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setTeammateManagerOpen(false);
  }

  function threadTurnsCacheKey(threadId: string): string {
    return `${cwd.trim()}::${threadId}`;
  }

  function openActivityDrilldownTarget(target: ChannelActivityDrilldownTarget): void {
    setActivityDrilldownItemId("");
    if (target.kind === "task") {
      revealTaskFromActivity(target.taskId);
      return;
    }
    if (target.kind === "run") {
      revealRunFromActivity(target.runId);
      return;
    }
    if (target.kind === "approval") {
      openApprovalDetail(pendingChannelApprovals.find((approval) => approval.runId === target.runId));
      return;
    }
    revealReviewInConversation();
  }

  function openActivityTriageResult(result: ChannelActivityTriageResult): void {
    setActivityDrilldownItemId("");
    if (result.kind === "task") {
      revealTaskFromActivity(result.task.id);
      return;
    }
    revealReviewInConversation();
  }

  async function invokeTimelineProtocolAction(
    item: ConversationTimelineProtocolEventItem | ConversationTimelineApprovalItem,
    action: ConversationProtocolAction,
  ): Promise<void> {
    const sourceRef = item.sourceRefs.find((ref) => ref.kind.startsWith("channel_"));
    const sourceKind = sourceRef?.kind.slice("channel_".length);
    const sourceId = sourceRef?.id;
    if (action === "open_details") {
      if (sourceKind && sourceId) {
        const activityKind = sourceKind === "state-transition" ? "transition" : sourceKind;
        setActivityDrilldownItemId(`${activityKind}:${sourceId}`);
      }
      return;
    }
    if (action === "open_source") {
      revealReviewInConversation();
      return;
    }
    if (action === "open_task" && sourceId) {
      revealTaskFromActivity(sourceId);
      return;
    }
    if (action === "open_run" && sourceId) {
      revealRunFromActivity(sourceId);
      return;
    }
    if (action === "open_approval") {
      openApprovalDetail(approvals.find((approval) => approval.id === item.approvalId));
      return;
    }
    if (action === "start_workflow" && sourceKind === "handoff" && sourceId) {
      const handoff = channelHandoffs.find((candidate) => candidate.id === sourceId);
      if (handoff) await onStartWorkflowFromHandoff(handoff);
      return;
    }
    if (action === "create_task" && sourceKind === "summary" && sourceId) {
      const summary = channelContextSummaries.find((candidate) => candidate.id === sourceId);
      if (summary) await onCreateTaskFromContextSummary(summary);
      return;
    }
    if (action === "advance_workflow" && sourceKind === "workflow" && sourceId) {
      const workflow = channelWorkflows.find((candidate) => candidate.id === sourceId);
      if (workflow) await onOrchestrateWorkflow(workflow);
      return;
    }
    if (action === "cancel_workflow" && sourceKind === "workflow" && sourceId) {
      const workflow = channelWorkflows.find((candidate) => candidate.id === sourceId);
      if (workflow) await onCancelWorkflow(workflow);
      return;
    }
    if (action === "retry_step" && sourceKind === "workflow-step" && sourceId) {
      const workflowStep = channelWorkflowSteps.find((candidate) => candidate.id === sourceId);
      if (workflowStep) await onRetryWorkflowStep(workflowStep);
      return;
    }
    if (action === "supersede_decision" && sourceKind === "decision" && sourceId) {
      const decision = channelDecisions.find((candidate) => candidate.id === sourceId);
      if (decision) await onSupersedeDecision(decision);
      return;
    }
    if (action === "reject_decision" && sourceKind === "decision" && sourceId) {
      const decision = channelDecisions.find((candidate) => candidate.id === sourceId);
      if (decision) await onRejectDecision(decision);
    }
  }

  function updateChannelNotificationLevel(level: ChannelNotificationLevel): void {
    setChannelNotificationLevel(level);
    clearSavedChannelNotificationLevel(cwd, selectedChannelId);
    onWorkspaceSettingsPatch({
      channelNotifications: {
        ...(workspaceSettings?.channelNotifications ?? {}),
        [selectedChannelId]: level,
      },
    });
  }

  function updateChannelSettingsEditForm(form: ChannelFormState): void {
    onChannelEditFormChange(form);
    setChannelSettingsAutosaveRevision((current) => current + 1);
  }

  async function saveChannelName(name: string): Promise<void> {
    if (!selectedChannelId) {
      return;
    }
    const nextForm = { ...channelEditForm, name: name.trim() };
    await onSaveChannel(nextForm);
    onChannelEditFormChange(nextForm);
  }

  function addSelectedChannelTeammate(): void {
    if (!pendingChannelTeammateId) {
      return;
    }
    const teammateId = pendingChannelTeammateId;
    setPendingChannelTeammateId("");
    void onAddChannelTeammate(teammateId).catch(() => undefined);
  }

  function addSelectedChannelCouncil(): void {
    if (!pendingChannelCouncilId || channelCouncilSaving) {
      return;
    }
    const councilId = pendingChannelCouncilId;
    const currentIds = channelCouncilPolicy?.attachedCouncilIds ?? [];
    const nextIds = currentIds.includes(councilId) ? currentIds : [...currentIds, councilId];
    setPendingChannelCouncilId("");
    void onUpdateChannelCouncilPolicy({
      attachedCouncilIds: nextIds,
      preferredCouncilId: channelCouncilPolicy?.preferredCouncilId ?? councilId,
    });
  }

  function removeChannelCouncil(councilId: string): void {
    if (channelCouncilSaving) {
      return;
    }
    const nextIds = (channelCouncilPolicy?.attachedCouncilIds ?? []).filter((id) => id !== councilId);
    void onUpdateChannelCouncilPolicy({
      attachedCouncilIds: nextIds,
      preferredCouncilId: channelCouncilPolicy?.preferredCouncilId === councilId ? (nextIds[0] ?? null) : (channelCouncilPolicy?.preferredCouncilId ?? null),
    });
  }

  function setPreferredChannelCouncil(councilId: string): void {
    if (channelCouncilSaving) {
      return;
    }
    const currentIds = channelCouncilPolicy?.attachedCouncilIds ?? [];
    void onUpdateChannelCouncilPolicy({
      attachedCouncilIds: currentIds.includes(councilId) ? currentIds : [...currentIds, councilId],
      preferredCouncilId: councilId,
    });
  }

  async function createTask(): Promise<void> {
    if (await onCreateTask()) {
      setCreateTaskOpen(false);
    }
  }

  function openCreateTaskPanel(): void {
    setCreateTaskOpen(true);
    setSidePanelView("task");
    setSidePanelOpen(true);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setActivityToolsOpen(false);
    setProgressPopoverOpen(false);
    setTeammateManagerOpen(false);
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
      error={channelFeedbackMessage("task", selectedChannelId)}
      onProviderSelect={onProviderSelect}
      onTaskFormChange={onTaskFormChange}
      onCreateTask={() => void createTask()}
      onCancel={() => setCreateTaskOpen(false)}
    />
  ) : selectedTask ? (
    <TaskDetailPanel
      cwd={cwd}
      task={selectedTask}
      channels={channels}
      attachments={channelAttachments}
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
      isCancellingRun={Boolean(selectedTask.currentRunId && cancellingRunIds.includes(selectedTask.currentRunId))}
      approvalPolicy={approvalPolicy}
      permissionMode={permissionMode}
      permissionPreset={permissionPreset}
      decisions={channelDecisions}
      contextSummaries={channelContextSummaries}
      workflows={channelWorkflows}
      workflowSteps={channelWorkflowSteps}
      operationError={selectedTaskError}
      onCreateHandoffFromTask={onCreateHandoffFromTask}
      onOpenHandoffs={() => openProtocolFromActivity("handoffs")}
      onCreateTaskFromContextSummary={onCreateTaskFromContextSummary}
      onCheckThenRunTask={onCheckThenRunTask}
      onRunTask={onRunTask}
      onOpenSandboxSettings={onOpenSandboxSettings}
      onCancelActiveRun={onCancelActiveRun}
      onOpenRun={openRunInPanel}
      onOpenApprovals={onOpenApprovals}
      onResolveApproval={onResolveApproval}
      onOpenProviders={onOpenProviders}
      attachmentContentUrl={attachmentContentUrl}
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

  const channelSettingsLoading = channelsLoading || channelTeammateMembershipsLoading || channelTeamMetricsLoading;
  const sidePanelLoading = sidePanelView === "task"
      ? tasksLoading
    : sidePanelView === "context"
      ? inspectorMode === "runtime" ? runtimeLoading : channelProtocolLoading
    : sidePanelView === "settings"
          ? channelSettingsLoading
          : channelMessagesLoading || channelProtocolLoading || channelActivityTransitionsLoading || durableWorkItemsLoading || tasksLoading;

  function refreshSidePanel(): void {
    if (sidePanelView === "task") {
      onRefreshTasks();
      onRefreshChannelActivity();
      onRefreshWorkItems();
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
    if (sidePanelView === "settings") {
      onRefreshChannels();
      onRefreshAiCouncils();
      onRefreshChannelCouncil();
      setChannelTeamMetricsRefreshKey((current) => current + 1);
      return;
    }
  }

  const {
    mentionPickerOptions,
    slashCommandPickerOptions,
    readyLinkPreviewIds,
    composerInputParts,
    composerFileRefs,
    composerSlashIntent,
    composerSlashCommandActive,
    composerSlashTargetLabel,
    composerHasSendableContent,
    assetOperationPending,
    pendingMessageAssetsVisible,
    focusComposerAt,
    updateMentionPicker,
    commitMention,
    commitSlashCommand,
    insertMentionTrigger,
    handleComposerTextChange,
    handleComposerKeyDown,
    handleComposerPasteFiles,
    handleComposerDragOver,
    handleComposerDragLeave,
    handleComposerDrop,
    attachFiles,
    removePendingAttachment,
    retryPendingAttachment,
    attachmentCleanupFailures,
    retryAttachmentCleanup,
    releaseAttachmentPreviews,
  } = useChannelComposerInputController({
    cwd,
    selectedChannelId,
    composerOwnerKey: channelComposerOwnerKey,
    guidanceModeActive,
    messageDraft,
    setMessageDraft,
    pendingAttachments,
    setPendingAttachments,
    pendingLinkPreviews,
    setPendingLinkPreviews,
    setMessageMentions,
    mentionPicker,
    setMentionPicker,
    mentionActiveIndex,
    setMentionActiveIndex,
    slashPicker,
    setSlashPicker,
    slashActiveIndex,
    setSlashActiveIndex,
    setComposerDragActive,
    setComposerBusy,
    setSendState,
    setSendError,
    composerInputRef,
    autoPreviewUrlsRef,
    attachmentPreviewUrlsRef,
    teammateOptions,
    slashCommands,
    onRevealPlanModeChip: () => setChannelPlanModeChipVisible(true),
    onRevealGoalChip: () => setChannelGoalChipVisible(true),
    onUploadAttachments,
    onCreateLinkPreview,
    t,
  });
  const localTeammateById = useMemo(
    () => new Map(activeLocalTeammates.map((teammate) => [teammate.id, teammate])),
    [activeLocalTeammates],
  );
  const allLocalTeammateById = useMemo(
    () => new Map(localTeammates.map((teammate) => [teammate.id, teammate])),
    [localTeammates],
  );
  const allLocalTeammateByName = useMemo(
    () => new Map(localTeammates.map((teammate) => [teammate.displayName.trim().toLowerCase(), teammate])),
    [localTeammates],
  );
  const channelTeammates = useMemo(
    () => {
      return channelTeammateMemberships.map((membership) => {
        const teammate = localTeammateById.get(membership.teammateId);
        return teammate ? { membership, teammate } : undefined;
      })
        .filter((item): item is { readonly membership: TeammateChannelMembership; readonly teammate: LocalTeammateDraft } => Boolean(item));
    },
    [channelTeammateMemberships, localTeammateById],
  );
  const workflowOwnerInferenceTeammates = useMemo(
    () => {
      const channelTeammateIdSet = new Set(channelTeammates.map(({ teammate }) => teammate.id));
      return [
        ...channelTeammates.map(({ teammate }) => ({
          id: teammate.id,
          displayName: teammate.displayName,
          roleKey: teammate.roleKey,
          description: teammate.description,
          channelMember: true,
        })),
        ...activeLocalTeammates
          .filter((teammate) => !channelTeammateIdSet.has(teammate.id))
          .map((teammate) => ({
            id: teammate.id,
            displayName: teammate.displayName,
            roleKey: teammate.roleKey,
            description: teammate.description,
            channelMember: false,
          })),
      ];
    },
    [activeLocalTeammates, channelTeammates],
  );
  const workflowOwnerInferenceHistorySteps = useMemo(
    () => channelWorkflowSteps
      .filter((step) => !selectedChannelId || step.channelId === selectedChannelId)
      .map((step) => ({
        title: step.title,
        prompt: step.prompt,
        toParticipantId: step.toParticipantId,
        toParticipantLabel: step.toParticipantLabel,
      })),
    [channelWorkflowSteps, selectedChannelId],
  );
  const visibleChannelHeaderTeammates = useMemo(
    () => channelTeammates.filter(({ teammate }) => !teammate.hidden),
    [channelTeammates],
  );
  const channelHeaderTeammates = useMemo(
    () => visibleChannelHeaderTeammates.slice(0, 4),
    [visibleChannelHeaderTeammates],
  );
  const channelHeaderTeammateCount = visibleChannelHeaderTeammates.length;
  const channelHeaderTeammateOverflow = Math.max(0, channelHeaderTeammateCount - channelHeaderTeammates.length);
  const availableChannelTeammates = useMemo(
    () => activeLocalTeammates.filter((teammate) => teammate.id !== LING_AGENT_AUTHOR_ID && !teammate.hidden && !channelTeammateIds.has(teammate.id)),
    [activeLocalTeammates, channelTeammateIds],
  );
  const activeAiCouncils = useMemo(
    () => aiCouncils.filter((council) => council.status === "active"),
    [aiCouncils],
  );
  const attachedCouncilIds = channelCouncilPolicy?.attachedCouncilIds ?? [];
  const attachedCouncilIdSet = useMemo(
    () => new Set(attachedCouncilIds),
    [attachedCouncilIds],
  );
  const aiCouncilById = useMemo(
    () => new Map(aiCouncils.map((council) => [council.id, council])),
    [aiCouncils],
  );
  const attachedAiCouncils = useMemo(
    () => attachedCouncilIds
      .map((councilId) => aiCouncilById.get(councilId))
      .filter((council): council is AiCouncil => council !== undefined),
    [aiCouncilById, attachedCouncilIds],
  );
  const availableAiCouncils = useMemo(
    () => activeAiCouncils.filter((council) => !attachedCouncilIdSet.has(council.id)),
    [activeAiCouncils, attachedCouncilIdSet],
  );
  const projectedCouncilSpecialists = useMemo(
    () => (channelEffectiveCouncil?.specialists ?? []).filter((specialist) =>
      specialist.sources.some((source) => source.kind === "council") && !isLingAgentTeammate(specialist.teammate),
    ),
    [channelEffectiveCouncil],
  );

  const activeChannelConversationThread = useMemo(
    () => selectedChannelBranchRootThreadId
      ? visibleChannelWorkThreads.find((thread) => thread.id === selectedChannelBranchRootThreadId) ?? channelDiscussionRootThread
      : channelDiscussionRootThread,
    [channelDiscussionRootThread, selectedChannelBranchRootThreadId, visibleChannelWorkThreads],
  );
  const channelPlanModeThreadId = activeChannelConversationThread?.id ?? selectedChannelBranchRootThreadId ?? "";
  const channelPlanModeActive = activeChannelConversationThread?.conversationMode.mode === "plan";
  const channelPlanModeBusy = Boolean(channelPlanModeThreadId && workThreadConversationModeId === channelPlanModeThreadId);

  useEffect(() => {
    const workspaceCwd = cwd.trim();
    const threadId = channelPlanModeThreadId;
    if (!workspaceCwd || !threadId) {
      setActiveChannelGoal(undefined);
      setChannelGoalError("");
      setChannelGoalLoadingThreadId("");
      return;
    }
    let cancelled = false;
    setChannelGoalLoadingThreadId(threadId);
    setChannelGoalError("");
    void getLingThreadGoal(workspaceCwd, threadId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setActiveChannelGoal(response.goal ?? undefined);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setActiveChannelGoal(undefined);
        setChannelGoalError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setChannelGoalLoadingThreadId("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, channelPlanModeThreadId]);

  const {
    proposedPlanArtifacts,
    proposedPlanArtifactsById,
    proposedPlanHistoryLoading,
    proposedPlanHistoryError,
    refreshProposedPlanHistory,
    rememberProposedPlanArtifact,
  } = useChannelPlanHistory({
    cwd,
    threadId: channelPlanModeThreadId,
    channelId: selectedChannelId,
  });

  useEffect(() => {
    setChannelPlanModeChipVisible(false);
    setChannelGoalChipVisible(false);
  }, [selectedChannelId]);

  async function setChannelPlanMode(active: boolean): Promise<void> {
    let threadId = channelPlanModeThreadId;
    if (!threadId && active) {
      threadId = (await ensureChannelDiscussionRootThread())?.id ?? "";
    }
    if (!threadId) {
      if (!active) {
        return;
      }
      const message = t("Plan Mode needs a saved Ling thread.");
      showComposerFeedback("error", message);
      throw new Error(message);
    }
    await updateChannelWorkThreadConversationMode(threadId, active ? "plan" : "default");
  }

  async function ensureChannelGoalThreadId(): Promise<string> {
    let threadId = channelPlanModeThreadId;
    if (!threadId) {
      threadId = (await ensureChannelDiscussionRootThread())?.id ?? "";
    }
    if (!threadId) {
      const message = t("Goal needs a saved Ling thread.");
      showComposerFeedback("error", message);
      throw new Error(message);
    }
    return threadId;
  }

  async function setChannelGoalObjective(objective: string, replaceExisting = true): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      throw new Error(t("Workspace cwd is required."));
    }
    const threadId = await ensureChannelGoalThreadId();
    setChannelGoalBusy(true);
    setChannelGoalError("");
    try {
      const response = await putLingThreadGoal(workspaceCwd, threadId, { objective, replaceExisting });
      setActiveChannelGoal(response.goal ?? undefined);
      setChannelGoalExpanded(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setChannelGoalError(message);
      throw error;
    } finally {
      setChannelGoalBusy(false);
    }
  }

  async function patchChannelGoal(input: { readonly status?: LingThreadGoal["status"]; readonly objective?: string; readonly blockedReason?: string | null }): Promise<void> {
    const workspaceCwd = cwd.trim();
    const threadId = await ensureChannelGoalThreadId();
    setChannelGoalBusy(true);
    setChannelGoalError("");
    try {
      const response = await patchLingThreadGoal(workspaceCwd, threadId, input);
      setActiveChannelGoal(response.goal ?? undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setChannelGoalError(message);
      throw error;
    } finally {
      setChannelGoalBusy(false);
    }
  }

  async function clearChannelGoal(): Promise<void> {
    const workspaceCwd = cwd.trim();
    const threadId = await ensureChannelGoalThreadId();
    setChannelGoalBusy(true);
    setChannelGoalError("");
    try {
      await deleteLingThreadGoal(workspaceCwd, threadId);
      setActiveChannelGoal(undefined);
      setChannelGoalExpanded(false);
      setChannelGoalChipVisible(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setChannelGoalError(message);
      throw error;
    } finally {
      setChannelGoalBusy(false);
    }
  }

  async function completeChannelGoal(reason?: string): Promise<void> {
    const workspaceCwd = cwd.trim();
    const threadId = await ensureChannelGoalThreadId();
    setChannelGoalBusy(true);
    setChannelGoalError("");
    try {
      const response = await completeLingThreadGoal(workspaceCwd, threadId, {
        actor: "local-user",
        reason: reason?.trim() || undefined,
        evidenceRefs: activeChannelGoal?.lastRunId ? [{ kind: "run", id: activeChannelGoal.lastRunId }] : undefined,
      });
      setActiveChannelGoal(response.goal ?? undefined);
      setChannelGoalExpanded(false);
      setChannelGoalChipVisible(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setChannelGoalError(message);
      throw error;
    } finally {
      setChannelGoalBusy(false);
    }
  }

  function openChannelGoalEditor(): void {
    const draft = activeChannelGoal ? `/goal edit ${activeChannelGoal.objective}` : "/goal ";
    setMessageDraft(draft);
    focusComposerAt(draft.length);
  }

  function continueChannelGoal(): void {
    if (!activeChannelGoal || channelGoalBusy) {
      return;
    }
    if (activeChannelGoal.status === "paused") {
      showComposerFeedback("error", t("Resume the goal before continuing."));
      return;
    }
    if (channelPlanModeActive) {
      showComposerFeedback("error", t("Exit Plan Mode before continuing a goal."));
      return;
    }
    void (async () => {
      setChannelGoalBusy(true);
      setChannelGoalError("");
      try {
        const threadId = await ensureChannelGoalThreadId();
        const body = t("Continue working toward goal: {objective}", { objective: activeChannelGoal.objective });
        const result = await onSendMessage({
          threadId,
          body,
          mentions: [],
          attachmentIds: [],
          linkPreviewIds: [],
          fileRefs: [],
          requestAiReply: true,
        });
        if (result.errorMessage) {
          if (result.errorOwner === "assistant-reply") return;
          throw new Error(result.errorMessage);
        }
        showComposerFeedback("success", t("Goal continuation queued"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setChannelGoalError(message);
        showComposerFeedback("error", message);
      } finally {
        setChannelGoalBusy(false);
      }
    })();
  }

  function pauseOrResumeChannelGoal(): void {
    if (!activeChannelGoal || channelGoalBusy) {
      return;
    }
    const paused = activeChannelGoal.status === "paused";
    void patchChannelGoal(paused ? { status: "active", blockedReason: null } : { status: "paused" })
      .then(() => {
        showComposerFeedback("success", paused ? t("Goal resumed") : t("Goal paused"));
      })
      .catch((error: unknown) => {
        showComposerFeedback("error", error instanceof Error ? error.message : String(error));
      });
  }

  function clearChannelGoalFromPanel(): void {
    void clearChannelGoal()
      .then(() => {
        showComposerFeedback("success", t("Goal cleared"));
      })
      .catch((error: unknown) => {
        showComposerFeedback("error", error instanceof Error ? error.message : String(error));
      });
  }

  function completeChannelGoalFromPanel(): void {
    void completeChannelGoal()
      .then(() => {
        showComposerFeedback("success", t("Goal completed"));
      })
      .catch((error: unknown) => {
        showComposerFeedback("error", error instanceof Error ? error.message : String(error));
      });
  }

  function clearComposerSessionCommandDraft(commandId: "goal" | "plan"): void {
    if (composerSlashIntent.kind !== "session_command" || composerSlashIntent.commandId !== commandId) {
      return;
    }
    setMessageDraft("");
    setMessageMentions([]);
    setMentionPicker(undefined);
    setMentionActiveIndex(0);
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    setSendState("idle");
    setSendError("");
  }

  function toggleChannelPlanModeFromComposer(): void {
    setChannelPlanModeChipVisible(true);
    void setChannelPlanMode(!channelPlanModeActive)
      .catch((error: unknown) => {
        showComposerFeedback("error", error instanceof Error ? error.message : String(error));
      });
  }

  function closeChannelPlanModeChip(): void {
    clearComposerSessionCommandDraft("plan");
    if (!channelPlanModeActive) {
      setChannelPlanModeChipVisible(false);
      return;
    }
    void setChannelPlanMode(false)
      .then(() => {
        setChannelPlanModeChipVisible(false);
      })
      .catch((error: unknown) => {
        showComposerFeedback("error", error instanceof Error ? error.message : String(error));
      });
  }

  function closeChannelGoalChip(): void {
    clearComposerSessionCommandDraft("goal");
    if (!activeChannelGoal) {
      setChannelGoalChipVisible(false);
      return;
    }
    void clearChannelGoal()
      .then(() => {
        setChannelGoalChipVisible(false);
      })
      .catch((error: unknown) => {
        showComposerFeedback("error", error instanceof Error ? error.message : String(error));
      });
  }

  function handleAcceptProposedPlan(plan: ProposedPlanArtifact): void {
    void runProposedPlanAction(plan, "accept");
  }

  function handleRefineProposedPlan(plan: ProposedPlanArtifact): void {
    void runProposedPlanAction(plan, "refine");
  }

  function handleSaveProposedPlan(plan: ProposedPlanArtifact): void {
    void runProposedPlanAction(plan, "save");
  }

  function handleConvertProposedPlan(plan: ProposedPlanArtifact): void {
    setWorkflowConversionPreviewPlan(plan);
  }

  function handleArchiveProposedPlan(plan: ProposedPlanArtifact): void {
    void runProposedPlanAction(plan, "archive");
  }

  async function runProposedPlanAction(plan: ProposedPlanArtifact, action: "accept" | "refine" | "save" | "convert" | "archive", actionInput: WorkflowConversionDraft = {}): Promise<void> {
    if (proposedPlanActionBusyId) {
      return;
    }
    setProposedPlanActionBusyId(plan.id);
    try {
      const threadId = plan.threadId || await ensureChannelGoalThreadId();
      const actionRequest = { ...actionInput, plan: proposedPlanActionPayload(plan), expectedRevision: plan.revision };
      if (action === "save") {
        const result = await saveProposedPlanArtifact(cwd, threadId, plan.id, actionRequest);
        rememberProposedPlanArtifact(result.plan);
        refreshProposedPlanHistory();
        showComposerFeedback("success", t("Plan saved"));
        return;
      }
      if (action === "archive") {
        const result = await archiveProposedPlanArtifact(cwd, threadId, plan.id, actionRequest);
        rememberProposedPlanArtifact(result.plan);
        refreshProposedPlanHistory();
        showComposerFeedback("success", t("Plan archived"));
        return;
      }
      if (action === "convert") {
        const result = await convertProposedPlanToWorkflow(cwd, threadId, plan.id, actionRequest);
        rememberProposedPlanArtifact(result.plan);
        onRefreshChannelActivity();
        refreshProposedPlanHistory();
        showComposerFeedback("success", t("Workflow draft created"));
        return;
      }
      let canonicalPlan: ProposedPlanArtifact;
      if (action === "accept") {
        const result = await acceptProposedPlanArtifact(cwd, threadId, plan.id, actionRequest);
        canonicalPlan = result.plan;
        rememberProposedPlanArtifact(result.plan);
        onRefreshTasks();
        refreshProposedPlanHistory();
        if (channelPlanModeActive) await setChannelPlanMode(false);
      } else {
        const result = await refineProposedPlanArtifact(cwd, threadId, plan.id, actionRequest);
        canonicalPlan = result.plan;
        rememberProposedPlanArtifact(result.plan);
        refreshProposedPlanHistory();
        if (!channelPlanModeActive) await setChannelPlanMode(true);
      }
      const body = action === "accept"
        ? `${t("Implement accepted plan: {title}", { title: canonicalPlan.title })}\n\n${canonicalPlan.bodyMarkdown}`
        : `${t("Refine this plan before implementation: {title}", { title: canonicalPlan.title })}\n\n${canonicalPlan.bodyMarkdown}`;
      const result = await onSendMessage({
        threadId,
        body,
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
        requestAiReply: action === "refine",
      });
      if (result.errorMessage) {
        if (result.errorOwner === "assistant-reply") return;
        throw new Error(result.errorMessage);
      }
      showComposerFeedback("success", action === "accept" ? t("Implementation task queued") : t("Plan refinement queued"));
    } catch (error) {
      showComposerFeedback("error", error instanceof Error ? error.message : String(error));
    } finally {
      setProposedPlanActionBusyId("");
    }
  }

  function openProposedPlanSource(plan: ProposedPlanArtifact): void {
    if (!plan.sourceMessageId) {
      showComposerFeedback("info", t("Source unavailable"));
      return;
    }
    const sourceTurn = conversationTurnProjection.turns.find((turn) =>
      turn.sourceMessageId === plan.sourceMessageId ||
      turn.coordinatorStartMessages.some((message) => message.id === plan.sourceMessageId) ||
      turn.coordinatorTerminalMessages.some((message) => message.id === plan.sourceMessageId)
    );
    const targetFeedItemIds = new Set([
      `message:user:${plan.sourceMessageId}`,
      `message:agent:${plan.sourceMessageId}`,
      `message:${plan.sourceMessageId}`,
      ...(sourceTurn ? [sourceTurn.id] : []),
    ]);
    const locator = conversationTimelineItemLocatorRef.current;
    if (!locator) {
      showComposerFeedback("info", t("Source unavailable"));
      return;
    }
    messageFeedState.onLocateIntent();
    void locator.revealFirstMatchingItem([...targetFeedItemIds], revealConversationTarget)
      .then((result) => {
        if (result === "not_found") {
          showComposerFeedback("info", t("Source message is not loaded."));
        } else if (result === "mount_failed") {
          showComposerFeedback("info", t("Source unavailable"));
        }
      })
      .catch(() => showComposerFeedback("info", t("Source unavailable")));
  }

  function closeWorkflowConversionPreview(): void {
    if (!proposedPlanActionBusyId) {
      setWorkflowConversionPreviewPlan(undefined);
    }
  }

  function confirmWorkflowConversionPreview(plan: ProposedPlanArtifact, draft?: WorkflowConversionDraft): void {
    void runProposedPlanAction(plan, "convert", draft)
      .then(() => {
        setWorkflowConversionPreviewPlan(undefined);
      });
  }

  const {
    runGuidanceLoading,
    runGuidanceSubmitting,
    runGuidanceError,
    runGuidanceItems,
    sendMessage,
    handleChannelComposerSubmit,
    dismissSendError,
  } = useChannelComposerActionsController({
    composerOwnerKey: channelComposerOwnerKey,
    cwd,
    selectedChannelId,
    selectedChannelBranchRootThreadId,
    selectedChannel,
    activeConversationTarget,
    activeConversationSourceRunId,
    visibleChannelMessageIds,
    sendLifecycle: channelSendLifecycle,
    isCancellingRun,
    composerHasSendableContent,
    assetOperationPending,
    messageDraft,
    setMessageDraft,
    messageMentions,
    setMessageMentions,
    pendingAttachments,
    setPendingAttachments,
    pendingLinkPreviews,
    setPendingLinkPreviews,
    composerInputParts,
    composerInputRef,
    sendState,
    setSendState,
    setSendError,
    setMentionPicker,
    setMentionActiveIndex,
    setPendingChannelSendPreview,
    autoPreviewUrlsRef,
    releaseAttachmentPreviews,
    teammateOptions,
    slashCommands,
    channelAttachmentById,
    channelLinkPreviewById,
    planModeActive: channelPlanModeActive,
    activeGoal: activeChannelGoal,
    messageFeedScrollToLatest: messageFeedState.scrollToLatest,
    focusComposerAt,
    showComposerFeedback,
    onCreateLinkPreview,
    onCreateTaskFromSlashCommand,
    onRevealPlanModeChip: () => setChannelPlanModeChipVisible(true),
    onRevealGoalChip: () => setChannelGoalChipVisible(true),
    onSetPlanMode: setChannelPlanMode,
    onSetGoalObjective: setChannelGoalObjective,
    onPatchGoal: patchChannelGoal,
    onCompleteGoal: completeChannelGoal,
    onClearGoal: clearChannelGoal,
    onSendMessage,
    isComposerCurrent: (ownerKey) => channelComposerOwnerRef.current === channelComposerOwner && ownerKey === channelComposerOwner.key,
    composerSnapshots: channelComposerSnapshots,
    onCancelActiveReply: (target) => {
      if (target.activeReply.workUnitId) {
        onCancelWorkUnit(target.activeReply.workUnitId);
        return;
      }
      if (target.run) onCancelActiveRun(target.run);
    },
    onRefreshChannelActivity,
    onRefreshTasks,
    onRefreshRunApprovals,
    onRefreshRuntime,
    t,
  });
  const channelComposerSubmitDisabled = composerHasSendableContent
    ? !selectedChannelId || composerBusy || assetOperationPending || Boolean(runGuidanceSubmitting)
    : !selectedChannelId || !activeConversationTarget || isCancellingRun;
  const composerSessionCommandActive = composerSlashIntent.kind === "session_command";
  const channelComposerSubmitLabel = activeConversationTarget && !composerHasSendableContent
    ? t("Stop reply")
    : composerSessionCommandActive
      ? sendState === "sending" ? t("Applying command...") : t("Apply command")
    : composerSlashCommandActive
      ? sendState === "sending" ? t("Creating task...") : t("Create task")
      : sendState === "sending" ? t("Sending...") : t("Send");
  const composerShortcutTitle = t("Enter sends. Shift+Enter inserts a newline. Esc closes menus.");
  const channelComposerSubmitTitle = activeConversationTarget && !composerHasSendableContent
    ? channelComposerSubmitLabel
    : t("{action} (Enter)", { action: channelComposerSubmitLabel });
  const composerDropZoneStyle = {
    "--composer-input-min-height": `${composerInputMinHeight}px`,
  } as CSSProperties;
  const localUserDisplayName = userProfile?.displayName.trim() || t("You");
  const channelComposerPermissionPreset = permissionPreset ?? inferPermissionPreset(permissionMode);

  function channelMessageEditSurface(message: ChannelMessage): "channel_root" | "channel_branch" | "topic_reply" {
    if (message.threadSurfaceKind) {
      if (message.threadSurfaceKind === "branch") return "channel_branch";
      if (message.threadSurfaceKind === "topic") return "topic_reply";
      return "channel_root";
    }
    if (selectedChannelBranchRootThreadId && message.threadId === selectedChannelBranchRootThreadId) return "channel_branch";
    return message.threadId ? "topic_reply" : "channel_root";
  }

  async function saveChannelMessageEdit(message: ChannelMessage, body: string): Promise<void> {
    if (!selectedChannelId || channelMessageEditSaving) {
      return;
    }
    setChannelMessageEditSaving(true);
    setChannelMessageEditError("");
    setChannelReplacementRetryError("");
    try {
      await editConversationMessage(cwd, {
        surface: channelMessageEditSurface(message),
        ownerId: selectedChannelId,
        messageId: message.id,
        expectedRevision: message.revision ?? 1,
        body,
        mentions: message.mentions,
        attachmentIds: message.attachmentIds,
        linkPreviewIds: message.linkPreviewIds,
        fileRefs: message.fileRefs,
        providerPresetId: taskRunProviderId || fallbackProviderId || undefined,
        permissionPreset: channelComposerPermissionPreset,
        idempotencyKey: `channel-message-edit:${message.id}:${crypto.randomUUID()}`,
      });
      setEditingChannelMessageId(undefined);
      await Promise.all([onRefreshChannelMessages(), onRefreshChannelActivity()]);
      await threadReplyController.refreshThread();
    } catch (error) {
      setChannelMessageEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelMessageEditSaving(false);
    }
  }

  async function retryChannelMessageReplacement(message: ChannelMessage): Promise<void> {
    const pending = message.pendingReplacement;
    if (!pending || !selectedChannelId || channelReplacementRetryingMessageId) {
      return;
    }
    setChannelReplacementRetryingMessageId(message.id);
    setChannelReplacementRetryError("");
    try {
      const result = await editConversationMessage(cwd, {
        surface: channelMessageEditSurface(message),
        ownerId: selectedChannelId,
        messageId: message.id,
        expectedRevision: message.revision ?? 1,
        body: message.body,
        mentions: message.mentions,
        attachmentIds: message.attachmentIds,
        linkPreviewIds: message.linkPreviewIds,
        fileRefs: message.fileRefs,
        providerPresetId: taskRunProviderId || fallbackProviderId || undefined,
        permissionPreset: channelComposerPermissionPreset,
        idempotencyKey: pending.idempotencyKey,
      });
      if (result.status === "replacement_pending") {
        setChannelReplacementRetryError(result.failureReason ?? pending.failureReason ?? "");
      }
      await Promise.all([onRefreshChannelMessages(), onRefreshChannelActivity()]);
      await threadReplyController.refreshThread();
    } catch (error) {
      setChannelReplacementRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelReplacementRetryingMessageId(undefined);
    }
  }

  const messageRenderers = createChannelMessageRenderers({
    runLifecycles: runById,
    contextSegmentIdByItemId: channelContextSegmentIdByItemId,
    allLocalTeammateById,
    allLocalTeammateByName,
    attachmentContentUrl,
    auditActivityVisible,
    generatedMedia: channelGeneratedMedia,
    channelAttachmentById,
    channelLinkPreviewById,
    channelMessageFeedbackById,
    channelConversationItems: channelConversationItemsForDisplay,
    channelUserInputs,
    channelReasoningSummaries,
    channelContextCompactions,
    channelWorkflows: channelWorkflowsForDisplay,
    terminalReports: terminalReportsForDisplay,
    conversationWorkCellByThreadId,
    conversationWorkCellByWorkflowId,
    composerGateApprovals: inlineApprovalViews,
    cwd,
    workspaceId: selectedChannel?.workspaceId,
    executionProposalsByMessageId,
    formatBytes,
    latestStatus,
    latestEditableMessageId: latestEditableChannelMessageId,
    editingMessageId: editingChannelMessageId,
    editSaving: channelMessageEditSaving,
    editError: channelMessageEditError,
    replacementRetryingMessageId: channelReplacementRetryingMessageId,
    replacementRetryError: channelReplacementRetryError,
    loadPreview: channelWorkCellPreviewLoader,
    localUserDisplayName,
    memoryById: memoryByIdForDisplay,
    proposedPlanArtifactsById,
    selectedChannelBranchRootThreadId,
    selectedChannelId,
    selectedChannelThreadId: activeChannelConversationThread?.id ?? "",
    teammateOptions,
    t,
    timelineItemLocatorRef: conversationTimelineItemLocatorRef,
    timelineScrollRef: messageFeedState.scrollRef,
    timelineViewRetainKeys: messageFeedState.viewRetainKeys,
    onTimelineDisclosureIntent: messageFeedState.onDisclosureIntent,
    usedMemoryEvents: usedMemoryEventsForDisplay,
    userProfile,
    workflowProgressByWorkflowId,
    workflowErrors,
    orchestratingWorkflowId,
    runningWorkflowStepId,
    onAcceptProposedPlan: handleAcceptProposedPlan,
    onConvertProposedPlan: handleConvertProposedPlan,
    onOpenExecutionProposal: openExecutionProposal,
    onOpenFileReference: () => openRightDockPage("files"),
    onOpenTerminalReportFile: (target) => openRightDockPage("files", target),
    onOpenReview: (target) => openRightDockPage("review", undefined, target),
    onOpenThreadForMessage: threadReplyController.openThreadForMessage,
    onInvokeProtocolAction: invokeTimelineProtocolAction,
    onRefineProposedPlan: handleRefineProposedPlan,
    onSaveProposedPlan: handleSaveProposedPlan,
    onToggleChannelMessageFeedback: toggleChannelMessageFeedback,
    onBeginMessageEdit: (messageId) => {
      setChannelMessageEditError("");
      setEditingChannelMessageId(messageId);
    },
    onCancelMessageEdit: () => {
      setChannelMessageEditError("");
      setEditingChannelMessageId(undefined);
    },
    onSaveMessageEdit: saveChannelMessageEdit,
    onRetryMessageReplacement: retryChannelMessageReplacement,
    planActionBusyId: proposedPlanActionBusyId,
  });
  const channelUnifiedTimelineNode = messageRenderers.renderUnifiedTimeline(messageFeedItems);

  function toggleChannelMessageFeedback(messageId: string, feedback: "up" | "down"): void {
    setChannelMessageFeedbackById((current) => {
      if (current[messageId] === feedback) {
        const next = { ...current };
        delete next[messageId];
        return next;
      }
      return { ...current, [messageId]: feedback };
    });
  }

  const channelComposerPermissionLocked = guidanceModeActive || sendState === "sending" || composerBusy || Boolean(runGuidanceSubmitting) || isCancellingRun;
  const selectChannelAuthorizationMode = useConversationPermissionSelection({
    ownerKey: permissionSelectionOwnerKey,
    authorizationMode,
    workspaceAccessMode: workspaceAccessModeForPermissionPreset(channelComposerPermissionPreset),
    defaultWorkspaceAccessMode: workspaceSettings?.defaultWorkspaceAccessMode ?? "workspace_write",
    disabled: channelComposerPermissionLocked,
    confirmFullAccess: onConfirmFullAccessSelection,
    onChange: onPermissionSelectionChange,
    onError: (error) => setSendError(error instanceof Error ? error.message : String(error)),
  });
  const channelComposer = (
    <ChannelComposer
      statusNode={channelActiveStatusStrip}
      guidanceModeActive={guidanceModeActive}
      replyTargetActive={Boolean(activeConversationTarget)}
      composerBusy={composerBusy}
      composerDragActive={composerDragActive}
      composerDropZoneStyle={composerDropZoneStyle}
      composerFeedback={composerFeedback}
      composerHasSendableContent={composerHasSendableContent}
      composerShortcutTitle={composerShortcutTitle}
      composerSlashCommandActive={composerSlashCommandActive}
      composerSlashTargetLabel={composerSlashTargetLabel}
      executableSlashCommandId={composerSlashIntent.kind !== "none" ? composerSlashIntent.commandId : undefined}
      dropZoneClassName={composerDragActive ? "active" : undefined}
      inputParts={composerInputParts}
      inputRef={composerInputRef}
      isCancellingRun={isCancellingRun}
      mentionActiveIndex={mentionActiveIndex}
      mentionPicker={mentionPicker}
      mentionPickerOptions={mentionPickerOptions}
      pendingAttachments={pendingAttachments}
      pendingMessageAssetsVisible={pendingMessageAssetsVisible}
      permissionLocked={channelComposerPermissionLocked}
      authorizationMode={authorizationMode}
      permissionPreset={channelComposerPermissionPreset}
      fullAccessConfirmed={fullAccessConfirmed}
      planModeActive={channelPlanModeActive}
      planModeBusy={channelPlanModeBusy}
      planModeChipVisible={channelPlanModeChipVisible}
      goal={activeChannelGoal}
      goalBusy={channelGoalBusy}
      goalLoading={Boolean(channelGoalLoadingThreadId)}
      goalError={channelGoalError}
      goalExpanded={channelGoalExpanded}
      goalChipVisible={channelGoalChipVisible}
      channelTeammateIds={channelTeammateIds}
      runGuidanceError={runGuidanceError}
      runGuidanceItems={runGuidanceItems}
      runGuidanceLoading={runGuidanceLoading}
      runGuidanceSubmitting={runGuidanceSubmitting}
      selectedChannelId={selectedChannelId}
      sendError={sendError || selectedComposerError}
      sendState={sendState}
      slashActiveIndex={slashActiveIndex}
      slashCommandPickerOptions={slashCommandPickerOptions}
      slashPicker={slashPicker}
      submitDisabled={channelComposerSubmitDisabled}
      submitLabel={channelComposerSubmitLabel}
      submitTitle={channelComposerSubmitTitle}
      value={messageDraft}
      onAttachFiles={attachFiles}
      onCommitMention={commitMention}
      onCommitSlashCommand={commitSlashCommand}
      onDismissSendError={() => {
        dismissSendError();
        onClearChannelFeedback(
          "composer",
          channelConversationScopeKey({
            workspaceCwd: activeWorkspaceCwd,
            channelId: selectedChannelId,
            branchRootThreadId: selectedChannelBranchRootThreadId,
          }),
          activeWorkspaceCwd,
        );
      }}
      onDragOver={handleComposerDragOver}
      onDragLeave={handleComposerDragLeave}
      onDrop={handleComposerDrop}
      onInputChange={handleComposerTextChange}
      onInputKeyDown={(event) => handleComposerKeyDown(event, {
        sendMessage,
      })}
      onInputPasteFiles={handleComposerPasteFiles}
      onInputSelect={updateMentionPicker}
      onInsertMentionTrigger={insertMentionTrigger}
      onAuthorizationModeChange={selectChannelAuthorizationMode}
      onTogglePlanMode={toggleChannelPlanModeFromComposer}
      onRevealPlanModeChip={() => setChannelPlanModeChipVisible(true)}
      onClosePlanModeChip={closeChannelPlanModeChip}
      onOpenGoalEditor={openChannelGoalEditor}
      onRevealGoalChip={() => setChannelGoalChipVisible(true)}
      onCloseGoalChip={closeChannelGoalChip}
      onGoalContinue={continueChannelGoal}
      onGoalPauseResume={pauseOrResumeChannelGoal}
      onGoalComplete={completeChannelGoalFromPanel}
      onGoalClear={clearChannelGoalFromPanel}
      onToggleGoalExpanded={() => setChannelGoalExpanded((expanded) => !expanded)}
      onRemovePendingAttachment={removePendingAttachment}
      onRetryPendingAttachment={retryPendingAttachment}
      attachmentCleanupFailures={attachmentCleanupFailures}
      onRetryAttachmentCleanup={retryAttachmentCleanup}
      onResizePointerCancel={handleComposerResizePointerEnd}
      onResizePointerDown={handleComposerResizePointerDown}
      onResizePointerMove={handleComposerResizePointerMove}
      onResizePointerUp={handleComposerResizePointerEnd}
      onRetrySend={() => {
        void sendMessage();
      }}
      onSubmit={handleChannelComposerSubmit}
    />
  );
  const channelComposerNode = inlineApprovalViews.length > 0 ? (
    <RuntimeApprovalComposerGate
      approvals={inlineApprovalViews}
      approvalErrors={approvalErrors}
      resolvingApprovals={resolvingApprovals}
      surface="channel"
      onResolve={onResolveApproval}
    />
  ) : selectedExecutionProposal ? (
    <ChannelExecutionProposalComposerGate
      assigneeLabel={teammateLabel(selectedExecutionProposal.assigneeTeammateId, teammateOptions, t("Deleted teammate"))}
      errorMessage={workflowErrors[selectedExecutionProposal.id]}
      proposal={selectedExecutionProposal}
      onAllow={onConfirmExecutionProposal}
      onDeny={onCancelExecutionProposal}
    />
  ) : channelComposer;

  const channelHasChatContent = channelMessagesForDisplay.length > 0 || channelContextSummaries.length > 0;
  const collaborationTaskCards = useMemo(
    () => [...collaborationTaskCardByWorkflowId.values()],
    [collaborationTaskCardByWorkflowId],
  );
  const channelProgressSummary = useChannelProgressSummary({
    collaborationCards: collaborationTaskCards,
    selectedTask,
    latestRun,
    pendingApprovalCount,
    selectedApproval,
    contextSummaries: channelContextSummaries,
    workflowSteps: channelWorkflowStepsForDisplay,
    runningWorkflowStepId,
    t,
    onOpenTask: selectTask,
    onOpenRun: openRunInPanel,
    onOpenApproval: openApprovalDetail,
  });
  const attentionProgressRows = channelProgressSummary.attentionRows;
  const activeProgressSourceSummary = channelProgressSummary.activeSourceSummary;
  const actionableGovernanceNotifications = useMemo(
    () => channelGovernanceNotifications
      .filter((notification) => notification.status !== "dismissed" && notification.status !== "resolved")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt)),
    [channelGovernanceNotifications],
  );
  const governanceNotificationCount = actionableGovernanceNotifications.length;
  useEffect(() => {
    if (governanceNotificationCount === 0) {
      setGovernanceNotificationsOpen(false);
    }
  }, [governanceNotificationCount]);
  function refreshChannelSettingsPage(): void {
    onRefreshChannels();
    onRefreshAiCouncils();
    onRefreshChannelCouncil();
    setChannelTeamMetricsRefreshKey((current) => current + 1);
  }

  function openChannelSettingsPage(): void {
    channelHeader.closeSearch();
    panelNavigation.openUtilityPage("settings");
    setConversationDetailOverlay(undefined);
    setActivityToolsOpen(false);
    onChannelCreateOpenChange(false);
    refreshChannelSettingsPage();
  }

  function closeChannelSettingsPage(): void {
    setChannelSettingsPageOpen(false);
  }

  function openChannelEnvironmentPage(): void {
    channelHeader.closeSearch();
    panelNavigation.openUtilityPage("environment");
    setConversationDetailOverlay(undefined);
    setActivityToolsOpen(false);
    onChannelCreateOpenChange(false);
  }

  function closeChannelEnvironmentPage(): void {
    setChannelEnvironmentPageOpen(false);
  }

  async function changeChannelEnvironmentWorkspacePath(path: string): Promise<void> {
    const nextPath = path.trim();
    if (!selectedChannelId || !nextPath) {
      return;
    }
    const previousForm = channelEditForm;
    const now = new Date().toISOString();
    const nextForm: ChannelFormState = {
      ...channelEditForm,
      boundPath: nextPath,
      workspaceBinding: {
        mode: "local",
        status: "ready",
        executionPath: nextPath,
        createdAt: channelEditForm.workspaceBinding?.createdAt ?? now,
        checkedAt: now,
        updatedAt: now,
      },
    };
    onChannelEditFormChange(nextForm);
    try {
      await onSaveChannel(nextForm);
    } catch (error) {
      onChannelEditFormChange(previousForm);
      throw error;
    }
  }

  function openEnvironmentCommitDialog(): void {
    environmentCommitReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setEnvironmentCommitDialogOpen(true);
    setProgressPopoverOpen(false);
    setChannelMoreOpen(false);
  }

  function closeEnvironmentCommitDialog(): void {
    const returnFocusTarget = environmentCommitReturnFocusRef.current;
    environmentCommitReturnFocusRef.current = null;
    setEnvironmentCommitDialogOpen(false);
    globalThis.requestAnimationFrame(() => returnFocusTarget?.focus({ preventScroll: true }));
  }

  function openChannelRenameDialog(): void {
    if (!selectedChannel) {
      return;
    }
    setChannelRenameName(selectedChannel.name);
    setChannelRenameError("");
    onClearChannelFeedback("workspace", selectedChannel.id, activeWorkspaceCwd);
    setChannelRenameOpen(true);
    setChannelMoreOpen(false);
    setConversationDetailOverlay(undefined);
    setProgressPopoverOpen(false);
    setActivityToolsOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
    onChannelCreateOpenChange(false);
  }

  function closeChannelRenameDialog(): void {
    if (channelRenameSaving) {
      return;
    }
    setChannelRenameError("");
    onClearChannelFeedback("workspace", selectedChannelId, activeWorkspaceCwd);
    setChannelRenameOpen(false);
  }

  async function submitChannelRename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextName = channelRenameName.trim();
    if (!selectedChannelId || !nextName || nextName === selectedChannel?.name || channelRenameSaving) {
      return;
    }

    const nextForm = {
      ...channelEditForm,
      name: nextName,
    };
    setChannelRenameSaving(true);
    setChannelRenameError("");
    onChannelEditFormChange(nextForm);
    try {
      await onSaveChannel(nextForm);
      setChannelRenameOpen(false);
    } catch (error) {
      setChannelRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelRenameSaving(false);
    }
  }

  function openRightDockPage(page: DockPageKind, workspaceFile?: WorkspaceRightDockFileTarget, workspaceReview?: WorkspaceRightDockReviewTarget): void {
    panelNavigation.prepareDock("context");
    setCreateTaskOpen(false);
    setConversationDetailOverlay(undefined);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
    channelRightDock.requestPage(page, workspaceFile, workspaceReview);
  }

  function openSidePanelView(view: ChannelSidePanelView): void {
    if (view === "settings") {
      openChannelSettingsPage();
      return;
    }
    panelNavigation.prepareDock(view);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setConversationDetailOverlay(undefined);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
    if (view === "context") {
      onRefreshChannelProtocol();
    } else {
      onRefreshTasks();
      onRefreshChannelActivity();
      onRefreshWorkItems();
    }
  }

  function closeChannelRightDock(): void {
    channelRightDock.close();
    setSidePanelOpen(false);
    setCreateTaskOpen(false);
  }

  function openSourceGroupInConversationDetail(group: ConversationContextSourceGroup, summary: ConversationContextSourceSummary): void {
    setSelectedSourceDetail({ summary, groupId: group.id });
    setConversationDetailOverlay({ kind: "sources" });
    setSidePanelOpen(false);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setProgressPopoverOpen(false);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
  }

  function openContextSummaryInConversationDetail(summary: ChannelContextSummary): void {
    setSelectedSourceDetail({
      summary: buildConversationContextSourceSummaryFromChannelSummary(summary, t),
    });
    setConversationDetailOverlay({ kind: "sources" });
    setSidePanelOpen(false);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setProgressPopoverOpen(false);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
  }

  const sidePanelTitle = createTaskOpen && sidePanelView === "task"
      ? t("New task")
      : t(channelSidePanelLabel(sidePanelView));
  const channelTeamMetricsPanel = channelTeamMetricsState?.channelId === selectedChannelId ? (
    <ChannelTeamMetricsPanel
      metrics={channelTeamMetricsState.metrics}
      labels={{
        title: t("Team metrics"),
        evidence: t("Evidence"),
        current: t("Current"),
        total: t("Total"),
        active: t("Active"),
        delayed: t("Delayed"),
        unavailable: t("Unavailable"),
        riskReview: t("Risk review"),
        risk: t("Risk"),
        warnings: t("Warnings"),
        failed: t("Failed"),
        critical: t("Critical"),
        learningQueue: t("Learning queue"),
        recommendation: t("Recommendation"),
        accepted: t("Accepted"),
        rejected: t("Rejected"),
        pending: t("Pending"),
        agentActivity: t("Agent activity"),
      }}
    />
  ) : channelTeamMetricsError ? (
    <section className="channel-settings-card channel-team-metrics-panel" aria-label={t("Team metrics")}>
      <InlineFeedback tone="danger">{t("Team metrics could not be loaded")}</InlineFeedback>
    </section>
  ) : channelTeamMetricsLoading ? (
    <section className="channel-settings-card channel-team-metrics-panel" aria-label={t("Team metrics")}>
      <Spinner label={t("Loading team metrics...")} size="sm" />
    </section>
  ) : null;
  const channelSettingsContent = (
    <ChannelSettingsPanels
      cwd={cwd}
      selectedChannelId={selectedChannelId}
      channelNotificationLevel={channelNotificationLevel}
      onUpdateChannelNotificationLevel={updateChannelNotificationLevel}
      channelTeammateMembershipsLoading={channelTeammateMembershipsLoading}
      channelTeammates={channelTeammates}
      localTeammates={localTeammates}
      availableChannelTeammates={availableChannelTeammates}
      pendingChannelTeammateId={pendingChannelTeammateId}
      channelTeammateSavingId={channelTeammateSavingId}
      channelTeammateError={channelTeammateError}
      onPendingChannelTeammateIdChange={setPendingChannelTeammateId}
      onAddSelectedChannelTeammate={addSelectedChannelTeammate}
      onRemoveChannelTeammate={onRemoveChannelTeammate}
      onOpenTeammates={onOpenTeammates}
      aiCouncils={aiCouncils}
      aiCouncilsLoading={aiCouncilsLoading}
      aiCouncilHealthReport={aiCouncilHealthReport}
      channelCouncilPolicy={channelCouncilPolicy}
      channelEffectiveCouncil={channelEffectiveCouncil}
      channelCouncilLoading={channelCouncilLoading}
      channelCouncilSaving={channelCouncilSaving}
      attachedAiCouncils={attachedAiCouncils}
      availableAiCouncils={availableAiCouncils}
      projectedCouncilSpecialists={projectedCouncilSpecialists}
      pendingChannelCouncilId={pendingChannelCouncilId}
      onPendingChannelCouncilIdChange={setPendingChannelCouncilId}
      onAddSelectedChannelCouncil={addSelectedChannelCouncil}
      onRemoveChannelCouncil={removeChannelCouncil}
      onSetPreferredChannelCouncil={setPreferredChannelCouncil}
      channelTeamMetricsPanel={channelTeamMetricsPanel}
      channelEditForm={channelEditForm}
      onChannelEditFormChange={updateChannelSettingsEditForm}
      onSaveChannelName={saveChannelName}
      onChangeChannelWorkspacePath={changeChannelEnvironmentWorkspacePath}
      providersLoading={providersLoading}
      providers={providers}
      taskReadyProviders={taskReadyProviders}
      setupChatProviders={setupChatProviders}
      selectedChannelWorkspace={selectedChannelWorkspace}
      selectedChannelExecutionPath={selectedChannelExecutionPath}
      channelWorkspaceBusyAction={channelWorkspaceFeedback.busyAction}
      channelWorkspaceExternalPath={channelWorkspaceFeedback.externalPath}
      channelWorkspaceError={channelWorkspaceFeedback.error}
      onChannelWorkspaceExternalPathChange={channelWorkspaceFeedback.onExternalPathChange}
      onCreateManagedChannelWorktree={channelWorkspaceFeedback.createManagedWorktree}
      onRefreshChannelWorkspace={channelWorkspaceFeedback.refreshWorkspace}
      onOpenChannelWorkspacePath={channelWorkspaceFeedback.openWorkspacePath}
      onHandoffChannelWorkspace={channelWorkspaceFeedback.handoffWorkspace}
    />
  );
  const channelContextDockContent = (
    <div className="channel-protocol-tab-content">
      <ChannelInspector
        cwd={cwd}
        mode={inspectorMode}
        onModeChange={setInspectorMode}
        channel={selectedChannel}
        protocol={channelCollaborationProtocol}
        protocolError={selectedProtocolError}
        teammates={teammateOptions}
        autoRouteEnabled={channelAutoRouteEnabled}
        brief={channelBrief}
        briefDraft={briefDraft}
        onBriefDraftChange={setBriefDraft}
        onSaveBrief={saveBrief}
        onSaveProtocol={onSaveChannelProtocol}
        onRevertProtocol={onRevertChannelProtocol}
        routeDecisions={channelMessageRouteDecisions}
        intentDecisions={channelIntentDecisions}
        decisions={channelDecisions}
        handoffs={channelHandoffs}
        contextSummaries={channelContextSummaries}
        workflows={channelWorkflows}
        workflowSteps={channelWorkflowSteps}
        workflowErrors={workflowErrors}
        artifactsByRun={channelArtifactsByRun}
        runtimeDiagnostics={runtimeDiagnostics}
        workUnits={workUnits}
        attachments={channelAttachments}
        linkPreviews={channelLinkPreviews}
        runningWorkflowStepId={runningWorkflowStepId}
        orchestratingWorkflowId={orchestratingWorkflowId}
        loading={channelProtocolLoading}
        runtimeLoading={runtimeLoading}
        runtimeActionWorkUnitId={runtimeActionWorkUnitId}
        selectedTask={selectedTask}
        onUpdateHandoffStatus={onUpdateHandoffStatus}
        onStartTemplateWorkflow={onStartTemplateWorkflow}
        onStartWorkflowStep={onStartWorkflowStep}
        onUpdateWorkflowStepStatus={onUpdateWorkflowStepStatus}
        onRefreshRuntime={onRefreshRuntime}
        onCancelWorkUnit={onCancelWorkUnit}
        onRetryWorkUnit={onRetryWorkUnit}
        onReconcileWorkUnit={onReconcileWorkUnit}
      />
    </div>
  );
  const sidePanelContent = sidePanelView === "context" ? channelContextDockContent : (
    <section
      className="task-detail-panel inline-task-detail-panel"
      aria-label={sidePanelTitle}
      data-ui2-channel-task={createTaskOpen ? "create" : "detail"}
    >
      {taskDetailContent}
    </section>
  );
  const channelRightDockContent = useChannelRightDockContent({
    selectedChannelId,
    approvals,
    runById,
    taskChannelById,
    channelRuns,
    channelMessages: channelMessagesForDisplay,
    channelAttachments,
    channelArtifactsByRun: channelArtifactsByRunForDisplay,
    channelTasks: selectedChannelTasks,
    channelWorkflows: selectedChannelWorkflows,
    channelWorkflowSteps: selectedChannelWorkflowSteps,
    attentionProgressRows,
    teamAttentionCount: channelTeamMetricsState?.channelId === selectedChannelId ? channelTeamMetricsState.metrics.attention.activeAgentCount : 0,
    teamMetricsPanel: channelTeamMetricsPanel,
    contextDockContent: channelContextDockContent,
    t,
  });
  const channelDockReviewItems = channelRightDockContent.reviewItems;
  const channelDockEvidenceGroups = channelRightDockContent.evidenceGroups;
  const channelDockFileItems = channelRightDockContent.fileItems;
  const workspaceTerminalSession = useWorkspaceTerminalSession(cwd.trim() || undefined);
  const channelEnvironmentSummary = useChannelEnvironmentSummary({
    cwd,
    workspace: selectedChannelWorkspace,
    executionPath: selectedChannelExecutionPath,
    gitStatusState: channelGitStatusState,
    reviewItems: channelDockReviewItems,
    evidenceGroups: channelDockEvidenceGroups,
    fileItems: channelDockFileItems,
    activeSourceSummary: activeProgressSourceSummary,
    t,
    onOpenReview: () => openRightDockPage("review"),
    onOpenEnvironment: openChannelEnvironmentPage,
    onOpenCommit: openEnvironmentCommitDialog,
  });
  const channelDockActivityCount = channelRightDockContent.activityCount;
  const channelDockActivityNode = channelRightDockContent.activityNode;
  const channelDockForcedDetail = sidePanelView === "task" ? {
    id: "channel-task-detail",
    title: sidePanelTitle,
    node: sidePanelContent,
  } : undefined;
  const conversationDetailOverlayNode = conversationDetailOverlay ? (
    <ConversationDetailOverlay
      title={conversationDetailOverlay.kind === "approval" ? t("Approval details") : t("Context sources")}
      icon={conversationDetailOverlay.kind === "approval" ? <ShieldCheck size={15} /> : <FileCheck2 size={15} />}
      onClose={() => setConversationDetailOverlay(undefined)}
    >
      {conversationDetailOverlay.kind === "approval" ? (
        <ChannelApprovalDetailPanel
          approval={selectedApproval}
          resolvingDecision={selectedApproval ? resolvingApprovals[selectedApproval.id] : undefined}
          onResolve={onResolveApproval}
          onOpenTask={openTaskFromActivity}
          onOpenRun={openRunInPanel}
        />
      ) : (
        <ChannelSourceDetailPanel
          detail={selectedSourceDetail}
          messages={channelMessagesForDisplay}
          decisions={channelDecisions}
        />
      )}
    </ConversationDetailOverlay>
  ) : null;
  const workSummary = useWorkSummaryContext();
  const channelHasProgressPopoverContent = Boolean(workSummary) || attentionProgressRows.length > 0 || channelEnvironmentSummary.popoverRows.length > 0;
  const progressPopoverVisible = progressPopoverOpen && !teammateManagerOpen && !channelUtilityPageOpen && channelHasProgressPopoverContent;
  const progressPopoverPlacementAvailable =
    !teammateManagerOpen &&
    !channelUtilityPageOpen &&
    channelHasProgressPopoverContent;
  const progressSummaryLayout = useConversationSummaryLayout({
    requestedOpen: progressPopoverVisible,
    allowOverlay: Boolean(workSummary),
    containerWidth: channelRightDock.containerWidth,
    dockVisible: channelRightDockVisible,
    dockWidth: channelRightDock.width,
  });
  const progressPopoverCanRender = progressSummaryLayout.visible;
  const progressPopoverPresence = useConversationPanelPresence(progressPopoverCanRender, false);
  const progressPopoverShouldRender = progressPopoverPresence.rendered
    && progressPopoverPlacementAvailable
    && progressSummaryLayout.visible;
  const progressPopoverMotionClass = progressPopoverPresence.expanded ? "is-popover-expanded" : "is-popover-collapsed";
  const progressPopoverNode = (
    <ProgressPopover
      onClose={() => setProgressPopoverOpen(false)}
      onOpenChanges={(reviewCwd) => openRightDockPage("review", undefined, { cwd: reviewCwd, baseline: "head" })}
      expanded={attentionProgressExpanded}
      onExpandedChange={setAttentionProgressExpanded}
      progressRows={attentionProgressRows}
      environmentSummary={channelEnvironmentSummary}
      sourceSummary={activeProgressSourceSummary}
      onOpenSourceGroup={openSourceGroupInConversationDetail}
    />
  );
  const taskWorkbenchWindowStyle = {
    ...channelRightDock.windowStyle,
    ...channelBottomPanelResize.panelStyle,
    ...progressSummaryLayout.style,
  } as CSSProperties;
  const taskWorkbenchMainStyle = {
    ...channelRightDock.mainStyle,
    ...progressSummaryLayout.style,
  } as CSSProperties;
  const taskWorkbenchTitlebarStyle = {
    "--channel-progress-popover-right": `${progressSummaryLayout.dockOffset}px`,
  } as CSSProperties;

  function toggleChannelTeammateManager(): void {
    const nextOpen = !teammateManagerOpen;
    setTeammateManagerOpen(nextOpen);
    if (nextOpen) {
      channelHeader.closeSearch();
      setChannelSettingsPageOpen(false);
      setChannelEnvironmentPageOpen(false);
      setProgressPopoverOpen(false);
    }
    setWorkspaceSettingsOpen(false);
    setActivityToolsOpen(false);
    setSidePanelOpen(false);
    onChannelCreateOpenChange(false);
  }

  return (
    <div
      ref={taskWorkbenchWindowRef}
      className={[
        "client-window task-workbench-window",
        `right-dock-motion-${channelRightDock.motionState}`,
        channelRightDockVisible ? "with-channel-side-panel" : "",
        channelRightDockVisible ? (channelRightDockExpanded ? "channel-right-dock-expanded" : "channel-right-dock-collapsed") : "",
        progressSummaryLayout.visible ? "with-channel-progress-popover" : "",
        channelBottomPanelVisible ? "with-channel-bottom-panel" : "",
        channelBottomPanelResize.resizing ? "is-resizing-channel-bottom-panel" : "",
      ].filter(Boolean).join(" ")}
      style={taskWorkbenchWindowStyle}
      aria-label={t("Workspace")}
    >
      <ChannelWorkspaceHeader
        channelName={selectedChannel?.name} channelSelected={Boolean(selectedChannelId)}
        channelSettingsPageOpen={channelSettingsPageOpen} channelEnvironmentPageOpen={channelEnvironmentPageOpen}
        searchOpen={channelHeader.searchOpen} channelMoreOpen={channelMoreOpen}
        channelMoreRef={channelMoreRef} channelMoreButtonRef={channelMoreButtonRef}
        sidePanelOpen={sidePanelOpen} sidePanelView={sidePanelView} activityToolsOpen={activityToolsOpen}
        style={taskWorkbenchTitlebarStyle} onCloseSearch={channelHeader.closeSearch} setChannelMoreOpen={setChannelMoreOpen}
        openChannelSettingsPage={openChannelSettingsPage} closeChannelSettingsPage={closeChannelSettingsPage}
        openChannelEnvironmentPage={openChannelEnvironmentPage} closeChannelEnvironmentPage={closeChannelEnvironmentPage}
        openChannelRenameDialog={openChannelRenameDialog} openSidePanelView={openSidePanelView}
        onOpenActivityFilters={() => {
          setActivityToolsOpen(true); setActivityFiltersExpanded(false); setChannelMoreOpen(false);
          setSidePanelOpen(false); setProgressPopoverOpen(false); setChannelSettingsPageOpen(false);
          setChannelEnvironmentPageOpen(false); setTeammateManagerOpen(false);
        }}
        searchNode={(<>        {channelHeader.searchOpen && !channelUtilityPageOpen ? (
          <ConversationHeaderSearch
            ariaLabel={t("Search channel activity")}
            className="channel-header-search"
            clearLabel={t("Clear search")}
            inputRef={channelHeader.searchInputRef}
            placeholder={t("Search activity")}
            value={activitySearch}
            onChange={setActivitySearch}
            onClear={channelHeader.clearSearch}
            onEscape={channelHeader.closeSearch}
          />
        ) : null}
</>)}
        toolbarNode={(<>        <ChannelHeaderToolbar
          ariaLabel={t("Workspace task toolbar")}
          settingsPageOpen={channelSettingsPageOpen}
          environmentPageOpen={channelEnvironmentPageOpen}
          searchActive={channelHeader.searchOpen}
          searchDisabled={!selectedChannelId}
          searchLabel={t("Search")}
          onToggleSearch={() => {
            if (!channelHeader.searchOpen) {
              setProgressPopoverOpen(false);
              setGovernanceNotificationsOpen(false);
              setChannelMoreOpen(false);
              setTeammateManagerOpen(false);
            }
            channelHeader.toggleSearch();
          }}
          teammateActionNode={channelHeaderTeammateCount > 0 ? (
            <button
              ref={teammateManagerButtonRef}
              className={teammateManagerOpen ? "channel-team-stack-button active" : "channel-team-stack-button"}
              type="button"
              aria-expanded={teammateManagerOpen}
              aria-label={t("{count} channel teammates", { count: channelHeaderTeammateCount })}
              title={t("{count} channel teammates", { count: channelHeaderTeammateCount })}
              onClick={toggleChannelTeammateManager}
              disabled={!selectedChannelId}
            >
              <span className="channel-team-stack" aria-hidden="true">
                {channelHeaderTeammates.map(({ teammate }) => (
                  <span key={teammate.id} className="channel-team-stack-avatar">
                    <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
                  </span>
                ))}
                {channelHeaderTeammateOverflow > 0 ? <span className="channel-team-stack-overflow">+{channelHeaderTeammateOverflow}</span> : null}
              </span>
            </button>
          ) : undefined}
          governanceActionNode={governanceNotificationCount > 0 ? (
            <ChannelGovernanceNotificationsPopover
              open={governanceNotificationsOpen}
              count={governanceNotificationCount}
              notifications={actionableGovernanceNotifications}
              loading={channelGovernanceNotificationsLoading}
              actionId={channelGovernanceNotificationActionId}
              onOpenChange={(nextOpen) => {
                setGovernanceNotificationsOpen(nextOpen);
                if (nextOpen) {
                  channelHeader.closeSearch();
                  setProgressPopoverOpen(false);
                  setChannelMoreOpen(false);
                  setActivityToolsOpen(false);
                  setTeammateManagerOpen(false);
                  setSidePanelOpen(false);
                  onChannelCreateOpenChange(false);
                }
              }}
              onMarkSeen={onMarkChannelGovernanceNotificationSeen}
              onDismiss={onDismissChannelGovernanceNotification}
            />
          ) : undefined}
          showEmptyTeammateAction={channelHeaderTeammateCount === 0}
          emptyTeammateActionRef={teammateManagerButtonRef}
          emptyTeammateActionActive={teammateManagerOpen}
          emptyTeammateActionDisabled={!selectedChannelId}
          emptyTeammateActionLabel={t("AI teammate management")}
          onToggleEmptyTeammateAction={toggleChannelTeammateManager}
          progressActive={progressSummaryLayout.visible}
          progressExpanded={progressSummaryLayout.visible && progressPopoverPresence.expanded}
          progressLabel={t("Summary")}
          onToggleProgress={() => {
            if (!channelHasProgressPopoverContent) {
              setProgressPopoverOpen(false);
              return;
            }
            setChannelSettingsPageOpen(false);
            channelHeader.closeSearch();
            setChannelEnvironmentPageOpen(false);
            setCreateTaskOpen(false);
            setChannelMoreOpen(false);
            setActivityToolsOpen(false);
            setTeammateManagerOpen(false);
            setProgressPopoverOpen((current) => !current);
          }}
          bottomPanelOpen={channelBottomPanelIntentOpen}
          bottomPanelDisabled={!cwd.trim()}
          bottomPanelLabel={t("Toggle bottom panel")}
          onToggleBottomPanel={() => {
            if (channelBottomPanelIntentOpen) {
              setChannelBottomPanelOpen(false);
              return;
            }
            setChannelSettingsPageOpen(false);
            setChannelEnvironmentPageOpen(false);
            setCreateTaskOpen(false);
            setChannelMoreOpen(false);
            setActivityToolsOpen(false);
            setTeammateManagerOpen(false);
            setChannelBottomPanelOpen(true);
          }}
          detailsOpen={channelRightDockExpanded}
          detailsDisabled={!channelRightDock.available}
          detailsLabel={channelRightDockExpanded ? t("Hide details") : t("Show details")}
          onToggleDetails={() => {
            if (!channelRightDock.available) return;
            if (channelRightDockIntentOpen) {
              closeChannelRightDock();
              return;
            }
            openSidePanelView(sidePanelView === "settings" ? "context" : sidePanelView);
          }}
        />
</>)}
        summaryNode={(<>        {progressPopoverShouldRender ? (
          <div className={`channel-progress-popover ${progressPopoverMotionClass}`} data-right-dock-motion={channelRightDock.motionState}>
            {progressPopoverNode}
          </div>
        ) : null}
</>)}
      />

      {teammateManagerOpen ? (
        <section ref={teammateManagerPanelRef} className="workbench-settings-panel channel-teammate-dock" aria-label={t("AI teammate management")}>
          <ChannelTeammateManagerPanel
            cwd={cwd}
            selectedChannelId={selectedChannelId}
            lingAgentModelLabel={channelLingAgentModelLabel(channelEditForm.defaultProviderPresetId, providers)}
            channelTeammateMembershipsLoading={channelTeammateMembershipsLoading}
            channelTeammates={channelTeammates}
            localTeammates={localTeammates}
            availableChannelTeammates={availableChannelTeammates}
            pendingChannelTeammateId={pendingChannelTeammateId}
            channelTeammateSavingId={channelTeammateSavingId}
            channelTeammateError={channelTeammateError}
            onPendingChannelTeammateIdChange={setPendingChannelTeammateId}
            onAddSelectedChannelTeammate={addSelectedChannelTeammate}
            onRemoveChannelTeammate={onRemoveChannelTeammate}
            onOpenTeammates={onOpenTeammates}
          />
        </section>
      ) : null}

      <ChannelWorkspaceOverlays
        rename={channelRenameOpen ? {
          value: channelRenameName, currentName: selectedChannel?.name ?? "", saving: channelRenameSaving,
          error: channelRenameError, onValueChange: (value) => { setChannelRenameName(value); setChannelRenameError(""); onClearChannelFeedback("workspace", selectedChannelId, activeWorkspaceCwd); },
          onSubmit: (event) => void submitChannelRename(event), onClose: closeChannelRenameDialog, returnFocusRef: channelMoreButtonRef,
        } : undefined}
        commit={environmentCommitDialogOpen ? {
          message: environmentCommitMessage, includeUnstaged: environmentIncludeUnstaged,
          disabledReason: channelEnvironmentSummary.commitAction?.disabledReason ?? t("Commit and push require a daemon Git action and approval policy. This first version is read-only."),
          onMessageChange: setEnvironmentCommitMessage, onIncludeUnstagedChange: setEnvironmentIncludeUnstaged, onClose: closeEnvironmentCommitDialog,
        } : undefined}
        conversion={workflowConversionPreviewPlan ? {
          plan: workflowConversionPreviewPlan, cwd: cwd.trim(), busy: proposedPlanActionBusyId === workflowConversionPreviewPlan.id,
          teammates: workflowOwnerInferenceTeammates, historicalWorkflowSteps: workflowOwnerInferenceHistorySteps,
          onConfirm: confirmWorkflowConversionPreview, onClose: closeWorkflowConversionPreview,
        } : undefined}
      />

      <div
        ref={taskWorkbenchMainRef}
        style={taskWorkbenchMainStyle}
        className={[
          "task-workbench-main",
          channelUtilityPageOpen ? "channel-settings-main" : "",
          channelEnvironmentPageOpen ? "channel-environment-main" : "",
          channelRightDockVisible ? "with-channel-side-panel" : "",
          channelRightDockVisible ? (channelRightDockExpanded ? "channel-right-dock-expanded" : "channel-right-dock-collapsed") : "",
          channelRightDockResizing ? "is-resizing-channel-side-panel" : "",
        ].filter(Boolean).join(" ")}
      >
        {channelSettingsPageOpen ? (
          <section className="channel-settings-page" aria-label={t("Channel settings")} data-ui2-channel-settings="true">
            {channelSettingsContent}
          </section>
        ) : channelEnvironmentPageOpen ? (
          <ChannelEnvironmentPage
            summary={channelEnvironmentSummary}
            workspacePickerCwd={cwd}
            onChangeWorkspacePath={changeChannelEnvironmentWorkspacePath}
            onOpenReview={() => openRightDockPage("review")}
            onOpenCommit={openEnvironmentCommitDialog}
          />
        ) : (
          <>
        <ChannelActivityWorkspace
          activityTools={channelActivityToolsVisible ? {
            search: activitySearch,
            categoryFilter: activityCategoryFilter,
            attentionFilter: activityAttentionFilter,
            savedViews: allActivitySavedViews,
            activeSavedViewId: activeActivityViewId,
            filtersExpanded: activityFiltersExpanded,
            savedViewCounts,
            selectedSavedView: selectedActivitySavedView,
            categoryCounts: activityCategoryCounts,
            attentionCounts: activityAttentionCounts,
            filtersActive: activityFiltersActive,
            customViewLimitReached,
            showSearch: !channelHeader.searchOpen,
            onSavedViewSelect: applyActivityView,
            onSaveView: saveActivityView,
            onRenameView: renameActivityView,
            onDeleteView: deleteActivityView,
            onFiltersExpandedChange: setActivityFiltersExpanded,
            onSearchChange: setActivitySearch,
            onCategoryFilterChange: setActivityCategoryFilter,
            onAttentionFilterChange: setActivityAttentionFilter,
            onClearFilters: clearActivityFilters,
            channel: selectedChannel,
            tasks,
            runs: runsForDisplay,
            approvals,
            workflowSteps: channelWorkflowStepsForDisplay,
            externalActionDetails,
            externalWorkCiTriage,
            artifactsByRun: channelArtifactsByRunForDisplay,
            durableWorkItems,
            workBoardLoading: tasksLoading || approvalsLoading || channelActivityTransitionsLoading || durableWorkItemsLoading,
            onOpenTask: openTaskFromActivity,
            onOpenRun: openRunInPanel,
            onOpenApproval: (approvalId) => openApprovalDetail(approvals.find((approval) => approval.id === approvalId)),
            onClaimWorkItem,
            onHeartbeatWorkItem,
            onReleaseWorkItem,
            onCompleteWorkItem,
            onFailWorkItem,
            busyWorkItemId,
            ciTriageLoading: externalWorkCiTriageLoading,
            cwd,
            onRefreshCiTriage: onRefreshExternalWorkCiTriage,
          } : undefined}
          workThreadTree={selectedChannelId && channelWorkThreadTreeVisible ? {
            selectedChannelId,
            activeWorkThreadId,
            visibleThreads: visibleChannelWorkThreads,
            rows: channelWorkThreadTreeRows,
            loading: channelWorkThreadsLoading,
            error: channelWorkThreadError,
            search: channelWorkThreadSearch,
            searchActive: channelWorkThreadSearchActive,
            rootThread: channelDiscussionRootThread,
            forkingWorkThreadId,
            workThreadVisibilityId,
            archiveConfirmWorkThreadId,
            onSearchChange: setChannelWorkThreadSearch,
            onSelectThread: setActiveWorkThreadId,
            onForkMainBranch: () => void forkChannelMainBranch(),
            onForkThread: (thread) => void forkChannelWorkThread(thread),
            onSetArchiveConfirmWorkThreadId: setArchiveConfirmWorkThreadId,
            onMutateThreadVisibility: (thread, action) => void mutateChannelWorkThreadVisibility(thread, action),
          } : undefined}
          messageFeed={{
            surfaceId: `channel:${selectedChannel?.id ?? "none"}:${activeWorkThreadId || "root"}`,
            state: messageFeedState,
            ariaLabel: t("Channel message feed"),
            loading: channelMessagesLoading || channelProtocolLoading,
            // Canonical questions can exist without legacy message/feed rows.
            empty: messageFeedEmpty && channelUnifiedTimelineNode === null,
            loadingLabel: t("Loading messages..."),
            emptyIcon: activeWorkThreadId ? <GitBranch /> : activityFiltersActive ? <Search /> : <MessageSquare />,
            emptyLabel: activeWorkThreadId
              ? t("No work recorded in this branch yet")
              : activityFiltersActive
                ? t("No activity matches these filters")
                : selectedChannel
                  ? t("No channel messages yet")
                  : t("Create a default channel to start the workspace loop."),
            onKeyDown: handleMessageFeedKeyDown,
            onPointerDown: handleMessageFeedPointerDown,
            onPointerMove: handleMessageFeedPointerMove,
            onPointerUp: handleMessageFeedPointerEnd,
            onPointerCancel: handleMessageFeedPointerEnd,
            onContextMenu: handleMessageFeedContextMenu,
            statusNode: (
              <ChannelFeedStatus
                loading={channelActivityTransitionsLoading}
                error={Boolean(channelActivityTransitionError)}
              />
            ),
            latestButtonNode: (
              <ChannelFeedLatestControl
                feedbackNode={conversationBlockFeedbackNode}
                visible={messageFeedState.latestButtonVisible}
                onActivate={messageFeedState.scrollToLatest}
              />
            ),
            unifiedTimelineNode: channelUnifiedTimelineNode,
          }}
          conversationBlockActionMenuNode={conversationBlockActionMenuNode}
          conversationDetailOverlayNode={conversationDetailOverlayNode}
          composerNode={channelComposerNode}
          threadReply={threadReplyController.activeThreadRoot ? {
            cwd,
            rootMessage: threadReplyController.activeThreadRoot,
            threadId: threadReplyController.resolvedThreadId,
            replies: threadReplyController.activeThreadMessages,
            conversationItems: threadReplyController.conversationItems,
            userInputs: threadReplyController.userInputs,
            reasoningSummaries: threadReplyController.reasoningSummaries,
            contextCompactions: threadReplyController.contextCompactions,
            teammates: teammateOptions,
            memoryById,
            usedMemoryEvents,
            draft: threadReplyController.draft,
            pending: threadReplyController.pending,
            loadError: threadReplyController.loadError,
            sendError: threadReplyController.sendError,
            error: threadReplyController.error,
            onDraftChange: threadReplyController.changeDraft,
            onSend: () => void threadReplyController.sendReply(),
            onClose: threadReplyController.closeThread,
            editingMessageId: editingChannelMessageId,
            editSaving: channelMessageEditSaving,
            editError: channelMessageEditError,
            replacementRetryingMessageId: channelReplacementRetryingMessageId,
            replacementRetryError: channelReplacementRetryError,
            onBeginMessageEdit: (messageId) => {
              setChannelMessageEditError("");
              setEditingChannelMessageId(messageId);
            },
            onCancelMessageEdit: () => {
              setChannelMessageEditError("");
              setEditingChannelMessageId(undefined);
            },
            onSaveMessageEdit: saveChannelMessageEdit,
            onRetryMessageReplacement: retryChannelMessageReplacement,
            onOpenFileReference: () => openRightDockPage("files"),
            messageAuthorLabel: (message, threadTeammates) =>
              messageAuthorLabel(message, threadTeammates, t("Deleted teammate"), t("You"), allLocalTeammateById),
          } : undefined}
          drilldown={activityDrilldown ? {
            drilldown: activityDrilldown,
            defaultTeammateId: selectedChannel?.defaultTeammateId,
            activeDecisionIds: channelDecisions.filter((decision) => decision.status === "active").map((decision) => decision.id),
            onClose: () => setActivityDrilldownItemId(""),
            onOpenTarget: openActivityDrilldownTarget,
            onRunTriageAction: onRunActivityTriageAction,
            onOpenTriageResult: openActivityTriageResult,
          } : undefined}
        />
        {channelRightDock.resizable ? (
          <button
            className="channel-side-panel-resize-handle"
            type="button"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("Resize workspace dock")}
            title={t("Drag to resize workspace dock")}
            tabIndex={channelRightDockExpanded ? 0 : -1}
            onPointerDown={channelRightDock.handleResizePointerDown}
            onPointerMove={channelRightDock.handleResizePointerMove}
            onPointerUp={channelRightDock.handleResizePointerEnd}
            onPointerCancel={channelRightDock.handleResizePointerEnd}
            onLostPointerCapture={channelRightDock.handleResizePointerEnd}
          />
        ) : null}
        {channelRightDockVisible ? (
          <div
            className="channel-side-panel-frame"
            data-computer-use-obstacle="true"
            data-computer-use-obstacle-kind="right-dock"
            aria-hidden={channelRightDockExpanded ? undefined : true}
          >
            <WorkspaceRightDock
              surface="channel"
              open={channelRightDockVisible}
              ariaLabel={t("Channel workspace dock")}
              className={`channel-side-panel ${channelRightDockExpanded ? "is-drawer-expanded" : "is-drawer-collapsed"}`}
              cwd={cwd.trim()}
              launcherTitle={t("Workspace tools")}
              launcherSubtitle={selectedChannel?.name ? `#${selectedChannel.name}` : undefined}
              reviewItems={channelDockReviewItems}
              evidenceGroups={channelDockEvidenceGroups}
              fileItems={channelDockFileItems}
              terminalSession={workspaceTerminalSession}
              proposedPlans={proposedPlanArtifacts}
              proposedPlansLoading={proposedPlanHistoryLoading}
              proposedPlansError={proposedPlanHistoryError}
              externalError={selectedDockError}
              currentPlanThreadId={channelPlanModeThreadId}
              planActionBusyId={proposedPlanActionBusyId}
              includeActivity
              activityNode={channelDockActivityNode}
              activityCount={channelDockActivityCount}
              forcedDetail={channelDockForcedDetail}
              pageRequest={rightDockPageRequest}
              onPageRequestConsumed={channelRightDock.consumePageRequest}
              onOpenPlanSource={openProposedPlanSource}
              onSavePlan={handleSaveProposedPlan}
              onRefinePlan={handleRefineProposedPlan}
              onAcceptPlan={handleAcceptProposedPlan}
              onConvertPlan={handleConvertProposedPlan}
              onArchivePlan={handleArchiveProposedPlan}
              actions={(
                <>
                  {sidePanelView !== "settings" ? (
                    <IconButton
                      icon={Plus}
                      label={t("New task")}
                      onClick={openCreateTaskPanel}
                      disabled={!selectedChannelId}
                      size="sm"
                    />
                  ) : null}
                </>
              )}
              onClose={closeChannelRightDock}
            />
          </div>
        ) : null}
          </>
        )}
      </div>
      {channelBottomPanelVisible ? (
        <WorkspaceTerminalPanel
          cwd={cwd.trim()}
          className="channel-bottom-terminal"
          session={workspaceTerminalSession}
          expanded={channelBottomPanelPresence.expanded}
          motionState={channelBottomPanelPresence.motionState}
          resizing={channelBottomPanelResize.resizing}
          resizeHandleNode={(
            <button
              className="channel-bottom-panel-resize-handle"
              type="button"
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("Resize terminal panel")}
              title={t("Drag to resize terminal panel")}
              onPointerDown={channelBottomPanelResize.handleResizePointerDown}
              onPointerMove={channelBottomPanelResize.handleResizePointerMove}
              onPointerUp={channelBottomPanelResize.handleResizePointerEnd}
              onPointerCancel={channelBottomPanelResize.handleResizePointerEnd}
              onLostPointerCapture={channelBottomPanelResize.handleResizePointerEnd}
            />
          )}
          onClose={() => setChannelBottomPanelOpen(false)}
        />
      ) : null}
    </div>
  );
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

function isActionableExecutionProposal(proposal: ChannelExecutionProposal): boolean {
  return proposal.status === "draft" || proposal.status === "blocked" || proposal.status === "run_failed";
}

function runCanBeStopped(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

function runCanBeStoppedInComposer(
  run: RunSession,
  workflowStepById: ReadonlyMap<string, ChannelWorkflowStep>,
): boolean {
  if (!runCanBeStopped(run)) {
    return false;
  }
  if (!run.workflowStepId) {
    return true;
  }
  const workflowStep = workflowStepById.get(run.workflowStepId);
  return !workflowStep || !workflowStepIsTerminal(workflowStep);
}

function workflowStepIsTerminal(step: ChannelWorkflowStep): boolean {
  return step.status === "succeeded" || step.status === "failed" || step.status === "skipped" || step.status === "cancelled";
}

function teammateLabel(
  teammateId: string | undefined,
  teammates: readonly ChannelMention[],
  fallback = "AI teammate",
  teammateById?: ReadonlyMap<string, { readonly displayName: string }>,
): string {
  if (!teammateId) {
    return fallback;
  }
  const teammate = teammateById?.get(teammateId);
  if (teammate) {
    return teammate.displayName;
  }
  return teammates.find((teammate) => teammate.id === teammateId)?.label ?? fallback;
}

function readSavedChannelNotificationLevel(cwd: string, channelId: string): ChannelNotificationLevel | undefined {
  try {
    const value = globalThis.localStorage?.getItem(channelNotificationStorageKey(cwd, channelId));
    return isChannelNotificationLevel(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function clearSavedChannelNotificationLevel(cwd: string, channelId: string): void {
  try {
    globalThis.localStorage?.removeItem(channelNotificationStorageKey(cwd, channelId));
  } catch {
    // Local notification preferences are best-effort browser state.
  }
}

function channelNotificationStorageKey(cwd: string, channelId: string): string {
  return `ling-stack.channelNotifications.${encodeURIComponent(cwd)}.${encodeURIComponent(channelId)}`;
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

function compareRunActivity(left: RunSession, right: RunSession): number {
  const leftTime = left.updatedAt || left.endedAt || left.startedAt || left.createdAt;
  const rightTime = right.updatedAt || right.endedAt || right.startedAt || right.createdAt;
  return leftTime.localeCompare(rightTime);
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
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
