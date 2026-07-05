import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type UIEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ChevronUp,
  CircleAlert,
  Clock3,
  Command,
  FileCheck2,
  FileText,
  FolderOpen,
  GitBranch,
  Hash,
  History,
  Image as ImageIcon,
  Info,
  ListChecks,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelBottom,
  PanelBottomClose,
  PanelRightClose,
  PanelRightOpen,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Reply,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  ThumbsDown,
  ThumbsUp,
  UserPlus,
  Workflow,
} from "lucide-react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import type { AiTeammateTemplate } from "@ling-stack/core";
import {
  artifactContentUrl,
  acceptProposedPlanArtifact,
  archiveProposedPlanArtifact,
  completeLingThreadGoal,
  convertProposedPlanToWorkflow,
  deleteLingThreadGoal,
  getChannelWorkflowEvidence,
  getLingThreadEvidence,
  getLingThreadGoal,
  getLingTrace,
  listLingThreadTurns,
  listLingTraces,
  patchLingThreadGoal,
  putLingThreadGoal,
  refineProposedPlanArtifact,
  saveProposedPlanArtifact,
} from "../../api.js";
import {
  createChannelWorktree,
  getChannelWorkspaceGitStatus,
  getChannelTeamExpertsProjection,
  getChannelTeamMetricsProjection,
  handoffChannelWorkspace,
  listChannelCollaborationCards,
  refreshChannelWorkspace,
} from "../../api/channels.js";
import { useI18n, type Translate } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { buildInlineApprovalViews } from "../../lib/inline-approvals.js";
import type { ChannelActivityItem } from "../../lib/channel-activity.js";
import {
  type ChannelActivityDrilldownTarget,
} from "../../lib/channel-activity-drilldown.js";
import {
  type ChannelActivityTriageDraft,
  type ChannelActivityTriageResult,
} from "../../lib/channel-activity-triage.js";
import { buildConversationWorkCellDetailsFromThreadEvidence, buildConversationWorkCellViewModel, groupRunsByThreadId, type ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import { buildConversationTurnProjection } from "../../lib/conversation-turn-projector.js";
import { buildCollaborationTaskCardModel, type CollaborationTaskCardModel } from "../../lib/collaboration-task-card.js";
import {
  buildConversationContextSourceSummaryFromChannelSummary,
  type ConversationContextSourceGroup,
  type ConversationContextSourceSummary,
} from "../../lib/conversation-context-sources.js";
import { buildConversationWorkCellDetailsFromWorkflowEvidence, buildWorkflowProgressModel, workflowProgressToConversationWorkCell, type WorkflowProgressModel } from "../../lib/workflow-progress.js";
import { deriveChannelRuns } from "../../lib/channel-artifacts.js";
import { truncatePreview } from "../../lib/data.js";
import { formatDateTime } from "../../lib/formatting.js";
import { attachmentCanPreview, loadPreviewContent } from "../../lib/previews.js";
import {
  buildRunRepairHint,
  readRunWorkspaceCwd,
} from "../../lib/run-evidence.js";
import { defaultTools, riskyTools } from "../../lib/tools.js";
import {
  buildLocalEffectivePolicyPreview,
  formatToolDecisionGroups,
  inferPermissionPreset,
  permissionModeForPreset,
  permissionPresetDescription,
  permissionPresetLabel,
  permissionPresetOptions,
  sessionPermissionModeDescription,
  sessionPermissionModeLabel,
  summarizeEffectivePolicySnapshot,
} from "../../lib/session-permissions.js";
import {
  channelFormPersistenceKey,
  channelToForm,
} from "../../lib/channels.js";
import {
  canUseProviderForRun,
  isMediaProvider,
  providerPreflightReady,
  providerRunPreflightBlocker,
} from "../../lib/providers.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import {
  StatusBadge,
} from "../../shared/components/index.js";
import {
  ConversationStatusStrip,
  type DockPageKind,
  type ConversationWorkCellDetailsState,
} from "../../shared/conversation/index.js";
import {
  WorkspaceRightDock,
} from "./right-dock/index.js";
import { channelRightDockTransitionMs } from "./layout/channel-workspace-layout.js";
import {
  ChannelEnvironmentCommitDialog,
} from "./ChannelEnvironmentPage.js";
import {
  ChannelEnvironmentPage,
  useChannelEnvironmentSummary,
  type ChannelGitStatusLoadState,
} from "./ChannelEnvironmentSummary.js";
import { ChannelRenameDialog } from "./ChannelRenameDialog.js";
import { WorkflowConversionPreviewDrawer, type WorkflowConversionDraft } from "./WorkflowConversionPreviewDialog.js";
import { ChannelGovernanceNotificationsPopover } from "./ChannelGovernanceNotificationsPopover.js";
import { useWorkspaceTerminalSession, WorkspaceTerminalPanel } from "./WorkspaceTerminalPanel.js";
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
  ApprovalPolicy,
  AiCouncil,
  AiCouncilHealthReport,
  Channel,
  ChannelAttachment,
  ChannelBrief,
  ChannelCollaborationProtocolResponse,
  ChannelContextSummary,
  ChannelCouncilPolicy,
  ChannelDecision,
  ChannelFormState,
  ChannelHandoff,
  ChannelHandoffStatus,
  ChannelIntentDecision,
  ChannelLinkPreview,
  ChannelMention,
  ChannelMessage,
  ChannelMessageFileRef,
  ChannelMessageRouteDecision,
  ChannelTeamMetricsProjection,
  ChannelExecutionProposal,
  UpdateChannelExecutionProposalRequest,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelWorkflowStepStartMode,
  ChannelWorkspaceBinding,
  ChannelWorkspaceMode,
  ExecutionAction,
  GovernanceNotification,
  ExternalWorkActionView,
  ExternalWorkCiTriageView,
  FoldedExpertsReadModel,
  MemoryObject,
  ProviderPreset,
  ProposedPlanArtifact,
  ResourceLease,
  RuntimeDiagnosticsResponse,
  RunArtifact,
  RunSession,
  LingThread,
  LingThreadGoal,
  LingTurn,
  LingTurnRun,
  PermissionPreset,
  SessionPermissionMode,
  StateTransitionEvent,
  Task,
  TaskFormState,
  TaskRunActionState,
  TeammateChannelMembership,
  EffectiveChannelCouncilProjection,
  UpdateChannelCollaborationProtocolRequest,
  UpdateChannelBriefRequest,
  UpdateChannelCouncilPolicyRequest,
  UsedMemoryEvent,
  WorkItemView,
  WorkUnit,
  WorkspaceSettings,
  UpdateWorkspaceSettingsRequest,
  UserProfile,
} from "../../types.js";
import { ApprovalCard } from "../approvals/ApprovalCard.js";
import { InlineApprovalStrip } from "../approvals/InlineApprovalStrip.js";
import type { ApprovalResolution } from "../approvals/types.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { ChannelTeamMetricsPanel } from "./ChannelTeamMetricsPanel.js";
import {
  ChannelTeammateManagerPanel,
  ChannelSettingsPanels,
  channelWorkspaceModeIcon,
  isLingAgentTeammate,
  type ChannelSettingsAutosaveState,
  type ChannelNotificationLevel,
} from "./ChannelSettingsPanels.js";
import { ChannelComposer, type ChannelComposerInlineFeedback } from "./ChannelComposer.js";
import { ChannelActivityWorkspace } from "./ChannelActivityWorkspace.js";
import { useChannelRightDockController } from "./useChannelRightDockController.js";
import { useChannelBottomPanelResizeController } from "./useChannelBottomPanelResizeController.js";
import {
  conversationTurnRenderSignature,
  useChannelMessageFeed,
} from "./ChannelMessageFeed.js";
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
import { useChannelThreadReplyController } from "./useChannelThreadReplyController.js";
import { useChannelComposerInputController } from "./useChannelComposerInputController.js";
import { useChannelComposerSnapshotController } from "./useChannelComposerSnapshotController.js";
import { useChannelMessageFeedAssembly } from "./useChannelMessageFeedAssembly.js";
import { useChannelConversationBlockInteractions } from "./useChannelConversationBlockInteractions.js";

type ChannelSidePanelView = "context" | "settings" | "task";
type ChannelDrawerRootView = Extract<ChannelSidePanelView, "context">;

type ThreadTurnsLoadState =
  | { readonly status: "not_loaded" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly turns: readonly LingTurn[]; readonly runLinks: readonly LingTurnRun[] }
  | { readonly status: "error"; readonly errorMessage: string };

const channelSidePanelRootViews: readonly ChannelDrawerRootView[] = ["context"];
function channelSidePanelLabel(view: ChannelSidePanelView): string {
  if (view === "context") {
    return "Context";
  }
  if (view === "settings") {
    return "Settings";
  }
  return "Task detail";
}

function channelSidePanelIcon(view: ChannelSidePanelView, size: number): JSX.Element {
  if (view === "task") {
    return <SquareTerminal size={size} />;
  }
  if (view === "settings") {
    return <SlidersHorizontal size={size} />;
  }
  return <Workflow size={size} />;
}

function channelActivityVisibleInDefaultChat(item: ChannelActivityItem): boolean {
  return item.kind === "message" || item.kind === "summary";
}

interface ChannelTeamExpertsState {
  readonly channelId: string;
  readonly turnId: string;
  readonly experts: FoldedExpertsReadModel;
}

interface ChannelTeamExpertsTurnTarget {
  readonly turnId: string;
  readonly signature: string;
}

interface ChannelTeamMetricsState {
  readonly channelId: string;
  readonly metrics: ChannelTeamMetricsProjection;
}

interface WorkspaceTranscriptRenderContext {
  readonly detailsState: ConversationWorkCellDetailsState;
  readonly onLoadDetails?: (id: string) => void;
}

interface BranchConversationActivityScope {
  readonly threadId: string;
  readonly messageIds: ReadonlySet<string>;
  readonly runIds: ReadonlySet<string>;
  readonly taskIds: ReadonlySet<string>;
  readonly workflowIds: ReadonlySet<string>;
  readonly workflowStepIds: ReadonlySet<string>;
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
  approvalPolicy,
  permissionMode,
  permissionPreset,
  activeTaskRunAction,
  runningWorkflowStepId,
  orchestratingWorkflowId,
  errorMessage,
  onChannelCreateOpenChange,
  onChannelEditFormChange,
  onTaskFormChange,
  onProviderSelect,
  onAddChannelTeammate,
  onRemoveChannelTeammate,
  onSetDefaultChannelTeammate,
  onOpenTeammates,
  onRefreshChannels,
  onSaveChannel,
  onCreateTask,
  onCreateTaskFromSlashCommand,
  onSendMessage,
  onConfirmExecutionProposal,
  onCancelExecutionProposal,
  onUpdateExecutionProposal,
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
  onRefreshChannelActivity,
  onRefreshExternalWorkCiTriage,
  onRefreshWorkItems,
  onRefreshChannelProtocol,
  onRefreshChannelFiles,
  onRefreshChannelGovernanceNotifications,
  onMarkChannelGovernanceNotificationSeen,
  onDismissChannelGovernanceNotification,
  onRefreshAiCouncils,
  onRefreshChannelCouncil,
  onUpdateChannelCouncilPolicy,
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
  onClaimWorkItem,
  onHeartbeatWorkItem,
  onReleaseWorkItem,
  onCompleteWorkItem,
  onFailWorkItem,
  busyWorkItemId,
  onOpenProviders,
  workspaceSettings,
  onWorkspaceSettingsPatch,
}: {
  readonly cwd: string;
  readonly daemonHealthy: boolean | undefined;
  readonly channelAutoRouteEnabled: boolean;
  readonly providerLabel: string;
  readonly userProfile?: UserProfile;
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly selectedChannelBranchRootThreadId?: string;
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
  readonly channelExecutionActions: readonly ExecutionAction[];
  readonly channelExecutionActionError: string;
  readonly channelBrief: ChannelBrief | undefined;
  readonly channelCollaborationProtocol: ChannelCollaborationProtocolResponse | undefined;
  readonly channelDecisions: readonly ChannelDecision[];
  readonly channelIntentDecisions: readonly ChannelIntentDecision[];
  readonly channelMessageRouteDecisions: readonly ChannelMessageRouteDecision[];
  readonly channelHandoffs: readonly ChannelHandoff[];
  readonly channelContextSummaries: readonly ChannelContextSummary[];
  readonly channelWorkflows: readonly ChannelWorkflow[];
  readonly channelWorkflowSteps: readonly ChannelWorkflowStep[];
  readonly channelStateTransitions: readonly StateTransitionEvent[];
  readonly channelActivityTransitionsLoading: boolean;
  readonly channelActivityTransitionError: string;
  readonly channelGovernanceNotifications: readonly GovernanceNotification[];
  readonly channelGovernanceNotificationsLoading: boolean;
  readonly channelGovernanceNotificationActionId: string;
  readonly aiCouncils: readonly AiCouncil[];
  readonly aiCouncilHealthReport: AiCouncilHealthReport | undefined;
  readonly aiCouncilsLoading: boolean;
  readonly channelCouncilPolicy: ChannelCouncilPolicy | undefined;
  readonly channelEffectiveCouncil: EffectiveChannelCouncilProjection | undefined;
  readonly channelCouncilLoading: boolean;
  readonly channelCouncilSaving: boolean;
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly externalWorkCiTriageLoading: boolean;
  readonly durableWorkItems: readonly WorkItemView[];
  readonly durableWorkItemsLoading: boolean;
  readonly selectedTaskId: string;
  readonly providers: readonly ProviderPreset[];
  readonly teammateTemplates: readonly AiTeammateTemplate[];
  readonly slashCommands: readonly ComposerSlashCommandOption[];
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
  readonly externalActionDetails: Readonly<Record<string, ExternalWorkActionView>>;
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
  readonly approvalPolicy: ApprovalPolicy | undefined;
  readonly permissionMode: SessionPermissionMode;
  readonly permissionPreset?: PermissionPreset;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly runningWorkflowStepId: string;
  readonly orchestratingWorkflowId: string;
  readonly errorMessage: string;
  readonly onChannelCreateOpenChange: (open: boolean) => void;
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onAddChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onRemoveChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onSetDefaultChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onOpenTeammates: () => void;
  readonly onRefreshChannels: () => void;
  readonly onSaveChannel: (formOverride?: ChannelFormState) => void | Promise<void>;
  readonly onCreateTask: () => void;
  readonly onCreateTaskFromSlashCommand: (input: {
    readonly title: string;
    readonly prompt: string;
    readonly assigneeTeammateId?: string;
    readonly requestedSkillId: string;
    readonly attachmentIds?: readonly string[];
  }) => Promise<void>;
  readonly onSendMessage: (input: {
    readonly threadId?: string;
    readonly body: string;
    readonly mentions: readonly ChannelMention[];
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
    readonly fileRefs: readonly ChannelMessageFileRef[];
    readonly requestAiReply: boolean;
  }) => Promise<void>;
  readonly onConfirmExecutionProposal: (proposal: ChannelExecutionProposal) => void;
  readonly onCancelExecutionProposal: (proposal: ChannelExecutionProposal) => void;
  readonly onUpdateExecutionProposal: (
    proposal: ChannelExecutionProposal,
    input: UpdateChannelExecutionProposalRequest,
  ) => Promise<ChannelExecutionProposal | undefined>;
  readonly onUploadAttachments: (files: readonly File[]) => Promise<readonly ChannelAttachment[]>;
  readonly onCreateLinkPreview: (url: string) => Promise<ChannelLinkPreview | undefined>;
  readonly onDeleteAttachment: (attachmentId: string) => void;
  readonly onSaveBrief: (input: UpdateChannelBriefRequest) => void;
  readonly onSaveChannelProtocol: (input: UpdateChannelCollaborationProtocolRequest) => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly onRevertChannelProtocol: () => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly onSupersedeDecision: (decision: ChannelDecision) => void;
  readonly onRejectDecision: (decision: ChannelDecision) => void;
  readonly onCreateHandoffFromTask: (task: Task) => Promise<ChannelHandoff | undefined>;
  readonly onUpdateHandoffStatus: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => void;
  readonly onStartWorkflowFromHandoff: (handoff: ChannelHandoff) => void;
  readonly onStartTemplateWorkflow: () => void;
  readonly onOrchestrateWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onCancelWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onRetryWorkflowStep: (step: ChannelWorkflowStep) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => void;
  readonly onRunActivityTriageAction: (draft: ChannelActivityTriageDraft) => Promise<ChannelActivityTriageResult>;
  readonly onLoadOlderChannelMessages: () => void;
  readonly onRefreshChannelMessages: () => void;
  readonly onRefreshChannelActivity: () => void;
  readonly onRefreshExternalWorkCiTriage: () => void;
  readonly onRefreshWorkItems: () => void;
  readonly onRefreshChannelProtocol: () => void;
  readonly onRefreshChannelFiles: () => void;
  readonly onRefreshChannelGovernanceNotifications: () => void;
  readonly onMarkChannelGovernanceNotificationSeen: (notificationId: string) => void;
  readonly onDismissChannelGovernanceNotification: (notificationId: string) => void;
  readonly onRefreshAiCouncils: () => void;
  readonly onRefreshChannelCouncil: () => void;
  readonly onUpdateChannelCouncilPolicy: (input: UpdateChannelCouncilPolicyRequest) => Promise<void>;
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
  readonly onClaimWorkItem: (workItemId: string) => void;
  readonly onHeartbeatWorkItem: (workItemId: string, claimToken: string) => void;
  readonly onReleaseWorkItem: (workItemId: string, claimToken: string) => void;
  readonly onCompleteWorkItem: (workItemId: string, claimToken: string) => void;
  readonly onFailWorkItem: (workItemId: string, claimToken: string) => void;
  readonly busyWorkItemId: string;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly workspaceSettings: WorkspaceSettings | undefined;
  readonly onWorkspaceSettingsPatch: (patch: UpdateWorkspaceSettingsRequest) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedChannelWorkspace = selectedChannel ? resolveChannelWorkspaceBinding(selectedChannel, cwd) : undefined;
  const selectedChannelExecutionPath = selectedChannel && selectedChannelWorkspace ? resolveChannelWorkspaceExecutionPath(selectedChannelWorkspace, selectedChannel, cwd) : "";
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const [sidePanelView, setSidePanelView] = useState<ChannelSidePanelView>(() => selectedTaskId ? "task" : "context");
  const [sidePanelOpen, setSidePanelOpen] = useState(() => Boolean(selectedTaskId));
  const [channelSettingsPageOpen, setChannelSettingsPageOpen] = useState(false);
  const [channelEnvironmentPageOpen, setChannelEnvironmentPageOpen] = useState(false);
  const [environmentCommitDialogOpen, setEnvironmentCommitDialogOpen] = useState(false);
  const [environmentCommitMessage, setEnvironmentCommitMessage] = useState("");
  const [environmentIncludeUnstaged, setEnvironmentIncludeUnstaged] = useState(true);
  const [channelGitStatusState, setChannelGitStatusState] = useState<ChannelGitStatusLoadState>({ status: "idle" });
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [conversationWorkCellDetailsByKey, setConversationWorkCellDetailsByKey] = useState<Readonly<Record<string, ConversationWorkCellDetailsState>>>({});
  const [conversationThreadTurnsByKey, setConversationThreadTurnsByKey] = useState<Readonly<Record<string, ThreadTurnsLoadState>>>({});
  const [channelMoreOpen, setChannelMoreOpen] = useState(false);
  const [channelRenameOpen, setChannelRenameOpen] = useState(false);
  const [channelRenameName, setChannelRenameName] = useState("");
  const [channelRenameSaving, setChannelRenameSaving] = useState(false);
  const [progressPopoverOpen, setProgressPopoverOpen] = useState(false);
  const [progressPopoverRendered, setProgressPopoverRendered] = useState(false);
  const [progressPopoverExpanded, setProgressPopoverExpanded] = useState(false);
  const progressPopoverOpenFrameRef = useRef<number | undefined>();
  const [governanceNotificationsOpen, setGovernanceNotificationsOpen] = useState(false);
  const [attentionProgressExpanded, setAttentionProgressExpanded] = useState(true);
  const [conversationDetailOverlay, setConversationDetailOverlay] = useState<ConversationDetailOverlayState | undefined>();
  const [selectedSourceDetail, setSelectedSourceDetail] = useState<SelectedSourceDetailState | undefined>();
  const [channelBottomPanelOpen, setChannelBottomPanelOpen] = useState(false);
  const channelUtilityPageOpen = channelSettingsPageOpen || channelEnvironmentPageOpen;
  const channelBottomPanelVisible = channelBottomPanelOpen && !channelUtilityPageOpen;
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
  const progressPopoverCanFitMainLayout = channelRightDock.progressPopoverCanFitMainLayout;
  const progressPopoverCanUseMainLayout = channelRightDock.progressPopoverCanUseMainLayout;

  useEffect(() => {
    const channelId = selectedChannelId ?? "";
    const executionPath = selectedChannelExecutionPath.trim();
    if (!channelId || !executionPath || selectedChannelWorkspace?.status !== "ready") {
      setChannelGitStatusState({ status: "idle" });
      return;
    }

    let cancelled = false;
    const requestKey = `${channelId}:${executionPath}`;
    setChannelGitStatusState({ status: "loading", requestKey });
    getChannelWorkspaceGitStatus(cwd, channelId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setChannelGitStatusState({
          status: "loaded",
          requestKey,
          statusValue: response.gitStatus,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setChannelGitStatusState({
          status: "error",
          requestKey,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    channelEnvironmentPageOpen,
    cwd,
    progressPopoverOpen,
    selectedChannelExecutionPath,
    selectedChannelId,
    selectedChannelWorkspace?.status,
    selectedChannelWorkspace?.updatedAt,
  ]);
  const [inspectorMode, setInspectorMode] = useState<ChannelInspectorMode>("brief");
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [teammateManagerOpen, setTeammateManagerOpen] = useState(false);
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
  } = useChannelComposerDraftController();
  const [conversationBackgroundToast, setConversationBackgroundToast] = useState<ChannelComposerInlineFeedback | undefined>();
  const [activeChannelGoal, setActiveChannelGoal] = useState<LingThreadGoal | undefined>();
  const [channelGoalLoadingThreadId, setChannelGoalLoadingThreadId] = useState("");
  const [channelGoalBusy, setChannelGoalBusy] = useState(false);
  const [channelGoalExpanded, setChannelGoalExpanded] = useState(false);
  const [channelGoalError, setChannelGoalError] = useState("");
  const [proposedPlanActionBusyId, setProposedPlanActionBusyId] = useState("");
  const [workflowConversionPreviewPlan, setWorkflowConversionPreviewPlan] = useState<ProposedPlanArtifact | undefined>();
  const [pendingChannelTeammateId, setPendingChannelTeammateId] = useState("");
  const [pendingChannelCouncilId, setPendingChannelCouncilId] = useState("");
  const [channelNotificationLevel, setChannelNotificationLevel] = useState<ChannelNotificationLevel>("mentions");
  const [channelSettingsAutosaveState, setChannelSettingsAutosaveState] = useState<ChannelSettingsAutosaveState>("idle");
  const [channelSettingsAutosaveRevision, setChannelSettingsAutosaveRevision] = useState(0);
  const [channelWorkspaceBusyAction, setChannelWorkspaceBusyAction] = useState("");
  const [channelWorkspaceExternalPath, setChannelWorkspaceExternalPath] = useState("");
  const [channelWorkspaceNotice, setChannelWorkspaceNotice] = useState("");
  const [channelWorkspaceError, setChannelWorkspaceError] = useState("");
  const [channelCollaborationCardsState, setChannelCollaborationCardsState] = useState<{
    readonly channelId: string;
    readonly signature: string;
    readonly status: "idle" | "loaded" | "error";
    readonly cards: readonly CollaborationTaskCardModel[];
  }>({ channelId: "", signature: "", status: "idle", cards: [] });
  const [channelTeamExpertsByTurn, setChannelTeamExpertsByTurn] = useState<Readonly<Record<string, ChannelTeamExpertsState>>>({});
  const [channelTeamExpertsExpandedByTurn, setChannelTeamExpertsExpandedByTurn] = useState<Readonly<Record<string, boolean>>>({});
  const [channelTeamMetricsState, setChannelTeamMetricsState] = useState<ChannelTeamMetricsState | undefined>();
  const [channelTeamMetricsLoading, setChannelTeamMetricsLoading] = useState(false);
  const [channelTeamMetricsError, setChannelTeamMetricsError] = useState("");
  const [channelTeamMetricsRefreshKey, setChannelTeamMetricsRefreshKey] = useState(0);
  const [channelMessageFeedbackById, setChannelMessageFeedbackById] = useState<Record<string, "up" | "down">>({});
  const conversationBackgroundToastTimeoutRef = useRef<number | undefined>();
  const channelMoreRef = useRef<HTMLDivElement | null>(null);
  const governanceNotificationsRef = useRef<HTMLDivElement | null>(null);
  const teammateManagerButtonRef = useRef<HTMLButtonElement | null>(null);
  const teammateManagerPanelRef = useRef<HTMLElement | null>(null);
  const conversationWorkCellEvidenceLoadsRef = useRef(new Set<string>());
  const conversationThreadTurnLoadsRef = useRef(new Set<string>());
  const conversationThreadTurnRunSignaturesRef = useRef(new Map<string, string>());
  const channelWorkspaceExternalPathChannelIdRef = useRef(selectedChannelId);
  const channelSettingsAutosaveTimerRef = useRef<number | undefined>();
  const channelSettingsAutosaveInFlightRef = useRef(false);
  const channelSettingsAutosaveQueuedRef = useRef(false);
  const channelSettingsAutosaveRequestRef = useRef(0);
  const channelSettingsAutosaveLastSavedKeyRef = useRef("");
  const channelSettingsAutosaveLatestKeyRef = useRef("");
  const onSaveChannelRef = useRef(onSaveChannel);
  const workspaceSettingsRef = useRef(workspaceSettings);
  const onWorkspaceSettingsPatchRef = useRef(onWorkspaceSettingsPatch);

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
  const workflowStepById = useMemo(() => new Map(channelWorkflowSteps.map((step) => [step.id, step])), [channelWorkflowSteps]);
  const channelAttachmentById = useMemo(
    () => new Map(channelAttachments.map((attachment) => [attachment.id, attachment])),
    [channelAttachments],
  );
  const channelLinkPreviewById = useMemo(
    () => new Map(channelLinkPreviews.map((preview) => [preview.id, preview])),
    [channelLinkPreviews],
  );
  const channelRuns = useMemo(
    () => deriveChannelRuns(selectedChannelId, tasks, runs, activeRun),
    [activeRun, runs, selectedChannelId, tasks],
  );
  const selectedChannelTasks = useMemo(
    () => tasks.filter((task) => task.channelId === selectedChannelId),
    [selectedChannelId, tasks],
  );
  const selectedChannelWorkflows = useMemo(
    () => channelWorkflows.filter((workflow) => workflow.channelId === selectedChannelId),
    [channelWorkflows, selectedChannelId],
  );
  const selectedChannelWorkflowSteps = useMemo(
    () => channelWorkflowSteps.filter((step) => step.channelId === selectedChannelId),
    [channelWorkflowSteps, selectedChannelId],
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
        artifactsByRun: channelArtifactsByRun,
        executionActions: channelExecutionActions,
        t,
        artifactHref: (artifact) => artifactContentUrl(artifact.id, cwd),
      });
      if (cell) {
        cells.set(threadId, cell);
      }
    }
    return cells;
  }, [approvals, channelArtifactsByRun, channelExecutionActions, channelRuns, channelRunsByThreadId, conversationThreadTurnsByKey, cwd, t]);
  const workflowProgressByWorkflowId = useMemo(() => {
    const cells = new Map<string, WorkflowProgressModel>();
    for (const workflow of channelWorkflows.filter((item) => item.channelId === selectedChannelId)) {
      const steps = channelWorkflowSteps.filter((step) => step.workflowId === workflow.id);
      if (steps.length === 0) {
        continue;
      }
      cells.set(workflow.id, buildWorkflowProgressModel({
        workflow,
        steps,
        runs: channelRuns,
        approvals,
        artifactsByRun: channelArtifactsByRun,
        executionActions: channelExecutionActions,
        t,
        artifactHref: (artifact) => artifactContentUrl(artifact.id, cwd),
      }));
    }
    return cells;
  }, [approvals, channelArtifactsByRun, channelExecutionActions, channelRuns, channelWorkflowSteps, channelWorkflows, cwd, selectedChannelId, t]);
  const localCollaborationTaskCardByWorkflowId = useMemo(() => {
    const cards = new Map<string, CollaborationTaskCardModel>();
    for (const workflow of channelWorkflows.filter((item) => item.channelId === selectedChannelId)) {
      const card = buildCollaborationTaskCardModel({
        workflow,
        steps: channelWorkflowSteps.filter((step) => step.workflowId === workflow.id),
        runs: channelRuns,
        approvals,
        t,
      });
      if (card) {
        cards.set(workflow.id, card);
      }
    }
    return cards;
  }, [approvals, channelRuns, channelWorkflowSteps, channelWorkflows, selectedChannelId, t]);
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
  const selectedChannelTaskIds = useMemo(
    () => tasks.filter((task) => task.channelId === selectedChannelId).map((task) => task.id),
    [selectedChannelId, tasks],
  );
  const blockedWorkflowStepIds = useMemo(
    () => channelWorkflowSteps
      .filter((step) => step.channelId === selectedChannelId && (step.status === "waiting_for_approval" || step.status === "blocked"))
      .map((step) => step.id),
    [channelWorkflowSteps, selectedChannelId],
  );
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
    channelMessages,
    tasks,
    runs,
    approvals,
    channelStateTransitions,
    channelDecisions,
    channelHandoffs,
    channelContextSummaries,
    channelWorkflows,
    channelWorkflowSteps,
    latestRun,
    workspaceSettings,
    onWorkspaceSettingsPatch,
    t,
  });
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
  useEffect(() => {
    conversationWorkCellEvidenceLoadsRef.current.clear();
    setConversationWorkCellDetailsByKey((current) => Object.keys(current).length === 0 ? current : {});
  }, [approvals, channelArtifactsByRun, channelWorkflowSteps, channelWorkflows, conversationWorkCellByThreadId, cwd, runs]);
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
        activeChannelId: selectedChannelId,
        activeRunId,
        visibleRunIds: channelRuns.map((item) => item.id),
        visibleTaskIds: selectedChannelTaskIds,
        blockedWorkflowStepIds,
      }),
    [activeRunId, approvals, blockedWorkflowStepIds, channelRuns, selectedChannelId, selectedChannelTaskIds],
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
  const activeConversationRun = activeRun && runCanBeStoppedInComposer(activeRun, workflowStepById)
    ? activeRun
    : channelRuns.find((candidate) => runCanBeStoppedInComposer(candidate, workflowStepById));
  const activeConversationRunHasWorkflowStep = Boolean(activeConversationRun?.workflowStepId);
  const activeConversationSourceRunId = activeConversationRun ? activeConversationRun.parentRunId ?? activeConversationRun.id : "";
  const activeConversationTask = activeConversationRun?.taskId ? taskById.get(activeConversationRun.taskId) : undefined;
  const channelActiveStatusStrip = activeConversationRun && !activeConversationRunHasWorkflowStep ? (
    <ConversationStatusStrip
      className="channel-active-status-strip"
      icon={<Workflow size={15} />}
      title={t("Run in progress")}
      description={activeConversationTask ? t("Run for {title} is {status}.", { title: activeConversationTask.title, status: activeConversationRun.status }) : t("Run is still running.")}
      statusNode={<StatusBadge status={activeConversationRun.status} />}
      metaItems={[
        { id: "provider", label: t("Provider"), value: effectiveProvider?.displayName ?? t("No model selected") },
        { id: "approvals", label: t("Approvals"), value: pendingApprovalCount },
      ]}
      actions={[
        {
          id: "open-run",
          label: t("Open run"),
          icon: <SquareTerminal size={14} />,
          onClick: () => openRunInPanel(activeConversationRun.id),
        },
        {
          id: "stop-run",
          label: isCancellingRun ? t("Stopping") : t("Stop"),
          icon: isCancellingRun ? <Loader2 className="spin" size={14} /> : <Square size={14} />,
          danger: true,
          disabled: isCancellingRun,
          onClick: () => onCancelActiveRun(activeConversationRun),
        },
      ]}
    />
  ) : pendingApprovalCount > 0 && inlineApprovalViews.length === 0 ? (
    <ConversationStatusStrip
      className="channel-active-status-strip attention"
      icon={<ShieldCheck size={15} />}
      title={t("Pending approvals")}
      description={selectedApproval?.title ?? t("Approval request")}
      statusNode={<StatusBadge status="waiting_for_approval" />}
      metaItems={[
        { id: "approvals", label: t("Approvals"), value: pendingApprovalCount },
      ]}
      actions={[
        {
          id: "open-approval",
          label: t("Open approval"),
          icon: <ShieldCheck size={14} />,
          onClick: () => openApprovalDetail(selectedApproval),
        },
      ]}
    />
  ) : providerBlocker && inlineApprovalViews.length === 0 ? (
    <ConversationStatusStrip
      className="channel-active-status-strip attention"
      icon={<CircleAlert size={15} />}
      title={t("Provider needs attention")}
      description={providerBlocker}
      statusNode={<StatusBadge status="blocked" />}
      metaItems={[
        { id: "provider", label: t("Provider"), value: effectiveProvider?.displayName ?? t("No model selected") },
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
    if (!governanceNotificationsOpen) {
      return undefined;
    }
    function handlePointerDown(event: MouseEvent): void {
      const target = event.target;
      if (target instanceof Node && governanceNotificationsRef.current?.contains(target)) {
        return;
      }
      setGovernanceNotificationsOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setGovernanceNotificationsOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [governanceNotificationsOpen]);

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

  const conversationTurnProjection = useMemo(
    () => buildConversationTurnProjection({
      channelId: selectedChannelId,
      messages: channelMessages,
      proposals: channelExecutionProposals,
      intentDecisions: channelIntentDecisions,
      workflows: channelWorkflows,
      workflowSteps: channelWorkflowSteps,
      runs: channelRuns,
      usedMemoryEvents,
      operationCellByWorkflowId: conversationWorkCellByWorkflowId,
      operationCellByThreadId: conversationWorkCellByThreadId,
      lingAgentAuthorId: LING_AGENT_AUTHOR_ID,
    }),
    [
      channelExecutionProposals,
      channelIntentDecisions,
      channelMessages,
      channelRuns,
      channelWorkflowSteps,
      channelWorkflows,
      conversationWorkCellByThreadId,
      conversationWorkCellByWorkflowId,
      selectedChannelId,
      usedMemoryEvents,
    ],
  );
  const channelTeamExpertsTurnTargets = useMemo<readonly ChannelTeamExpertsTurnTarget[]>(
    () => conversationTurnProjection.turns
      .filter((turn) => turn.blocks.length > 0)
      .map((turn) => ({
        turnId: turn.sourceMessage.id,
        signature: conversationTurnRenderSignature(turn),
      })),
    [conversationTurnProjection.turns],
  );
  const channelTeamExpertsRequestSignature = useMemo(
    () => channelTeamExpertsTurnTargets.map((turn) => `${turn.turnId}:${turn.signature}`).join("\n"),
    [channelTeamExpertsTurnTargets],
  );
  useEffect(() => {
    setChannelTeamExpertsExpandedByTurn({});
  }, [selectedChannelId]);
  useEffect(() => {
    const activeTurnIds = new Set(channelTeamExpertsTurnTargets.map((turn) => turn.turnId));
    setChannelTeamExpertsExpandedByTurn((current) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [turnId, expanded] of Object.entries(current)) {
        if (activeTurnIds.has(turnId)) {
          next[turnId] = expanded;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [channelTeamExpertsRequestSignature, channelTeamExpertsTurnTargets]);
  useEffect(() => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId || channelTeamExpertsTurnTargets.length === 0) {
      setChannelTeamExpertsByTurn({});
      return;
    }
    let cancelled = false;
    void Promise.all(channelTeamExpertsTurnTargets.map(async ({ turnId }) => {
      try {
        const response = await getChannelTeamExpertsProjection(workspaceCwd, selectedChannelId, turnId, { includeExpired: true, limit: 8 });
        return {
          turnId,
          state: {
            channelId: response.channelId,
            turnId: response.turnId,
            experts: response.experts,
          },
        };
      } catch {
        return { turnId, state: undefined };
      }
    }))
      .then((results) => {
        if (cancelled) {
          return;
        }
        const next: Record<string, ChannelTeamExpertsState> = {};
        for (const result of results) {
          if (result.state) {
            next[result.turnId] = result.state;
          }
        }
        setChannelTeamExpertsByTurn(next);
      });
    return () => {
      cancelled = true;
    };
  }, [channelTeamExpertsRequestSignature, channelTeamExpertsTurnTargets, cwd, selectedChannelId]);
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
      channelMessages
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
      channelWorkflows
        .filter((workflow) => workflow.metadata?.sourceMessageId && messageIds.has(workflow.metadata.sourceMessageId))
        .map((workflow) => workflow.id),
    );
    const workflowStepIds = new Set<string>();
    for (const step of channelWorkflowSteps) {
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
  }, [channelMessages, channelRuns, channelWorkflowSteps, channelWorkflows, selectedChannelBranchRootThreadId, tasks]);
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
      if (item.kind !== "run" || !item.record.threadId) {
        return true;
      }
      const workCell = conversationWorkCellByThreadId.get(item.record.threadId);
      return !workCell || workCell.anchorRunId === item.record.id;
    }),
    [auditActivityVisible, conversationTurnProjection.hiddenActivityIds, conversationWorkCellByThreadId, visibleActivityItems, workflowProgressByWorkflowId, workflowRepresentedRunIds],
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
    channelMessages,
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
    t,
    onBackgroundToast: showConversationBackgroundToast,
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
  const threadReplyController = useChannelThreadReplyController({
    channelMessages,
    teammateOptions,
    onSendMessage,
  });
  useChannelComposerSnapshotController({
    selectedChannelId,
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
      setEnvironmentCommitDialogOpen(false);
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
  const channelRunsForFiles = channelRuns;

  useEffect(() => {
    channelSettingsAutosaveLatestKeyRef.current = channelEditFormKey;
  }, [channelEditFormKey]);

  useEffect(() => {
    if (channelSettingsAutosaveRevision === 0) {
      channelSettingsAutosaveLastSavedKeyRef.current = selectedChannelFormKey;
      setChannelSettingsAutosaveState("idle");
    }
  }, [channelSettingsAutosaveRevision, selectedChannelFormKey]);

  useEffect(() => {
    channelSettingsAutosaveRequestRef.current += 1;
    channelSettingsAutosaveLastSavedKeyRef.current = selectedChannelFormKey;
    channelSettingsAutosaveQueuedRef.current = false;
    setChannelSettingsAutosaveRevision(0);
    setChannelSettingsAutosaveState("idle");
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
      setChannelSettingsAutosaveState("saved");
      return undefined;
    }

    setChannelSettingsAutosaveState("saving");
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
            setChannelSettingsAutosaveState(channelSettingsAutosaveLatestKeyRef.current === snapshotKey ? "saved" : "saving");
          }
        } catch {
          if (requestId === channelSettingsAutosaveRequestRef.current) {
            setChannelSettingsAutosaveState("error");
          }
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
    messageFeedState.reset();
    setConversationBackgroundToast(undefined);
    closeConversationBlockActionMenu();
  }, [closeConversationBlockActionMenu, cwd, messageFeedState.reset, selectedChannelId, selectedChannelNotificationLevel, workspaceSettingsLoaded]);

  useEffect(() => {
    const channelChanged = channelWorkspaceExternalPathChannelIdRef.current !== selectedChannelId;
    channelWorkspaceExternalPathChannelIdRef.current = selectedChannelId;
    if (selectedChannelWorkspace?.mode === "external_path" && selectedChannelWorkspace.executionPath) {
      setChannelWorkspaceExternalPath(selectedChannelWorkspace.executionPath);
    } else if (channelChanged) {
      setChannelWorkspaceExternalPath("");
    }
    setChannelWorkspaceNotice("");
    setChannelWorkspaceError("");
    setChannelWorkspaceBusyAction("");
  }, [selectedChannelId, selectedChannelWorkspace?.mode, selectedChannelWorkspace?.executionPath]);

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
    const hasPendingReply = channelMessages.some((message) => message.kind === "ai_reply" && message.status === "pending");
    if (!selectedChannelId || !hasPendingReply) {
      return undefined;
    }
    const intervalId = globalThis.setInterval(() => {
      onRefreshChannelMessages();
      onRefreshChannelActivity();
      onRefreshWorkItems();
    }, 1_000);
    return () => globalThis.clearInterval(intervalId);
  }, [channelMessages, onRefreshChannelActivity, onRefreshChannelMessages, onRefreshWorkItems, selectedChannelId]);

  useEffect(() => {
    if (!selectedTaskId || !selectedTask) {
      return;
    }
    setCreateTaskOpen(false);
    setSidePanelView("task");
    setSidePanelOpen(true);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setEnvironmentCommitDialogOpen(false);
    setProgressPopoverOpen(false);
  }, [selectedTask, selectedTaskId]);

  function selectTask(taskId: string): void {
    setCreateTaskOpen(false);
    setSidePanelView("task");
    setSidePanelOpen(true);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setEnvironmentCommitDialogOpen(false);
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
    setSidePanelView("context");
    setSidePanelOpen(true);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setEnvironmentCommitDialogOpen(false);
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
    setEnvironmentCommitDialogOpen(false);
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
    setEnvironmentCommitDialogOpen(false);
    setProgressPopoverOpen(false);
    setCreateTaskOpen(false);
    setActiveWorkThreadId("");
    globalThis.setTimeout(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>(".conversation-work-cell"))
        .find((element) => element.dataset.threadId === threadId);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      target?.classList.add("conversation-work-cell-locate-pulse");
      if (target) {
        globalThis.setTimeout(() => target.classList.remove("conversation-work-cell-locate-pulse"), 1400);
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
    setEnvironmentCommitDialogOpen(false);
    setProgressPopoverOpen(false);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setTeammateManagerOpen(false);
  }

  function conversationWorkCellDetailsCacheKey(threadId: string): string {
    const workCell = conversationWorkCellByThreadId.get(threadId);
    return `${cwd.trim()}::${workCell?.id ?? threadId}`;
  }

  function workflowWorkCellDetailsCacheKey(workflowId: string): string {
    const normalizedWorkflowId = workflowIdFromWorkCellThreadId(workflowId);
    const model = workflowProgressByWorkflowId.get(normalizedWorkflowId);
    return `${cwd.trim()}::${model?.id ?? `workflow-progress:${normalizedWorkflowId}`}`;
  }

  function threadTurnsCacheKey(threadId: string): string {
    return `${cwd.trim()}::${threadId}`;
  }

  function loadConversationWorkCellDetails(threadId: string): void {
    const cacheKey = conversationWorkCellDetailsCacheKey(threadId);
    const workCell = conversationWorkCellByThreadId.get(threadId);
    const existing = conversationWorkCellDetailsByKey[cacheKey];
    if (existing?.status === "loading" || existing?.status === "loaded" || existing?.status === "empty" || conversationWorkCellEvidenceLoadsRef.current.has(cacheKey)) {
      return;
    }

    conversationWorkCellEvidenceLoadsRef.current.add(cacheKey);
    setConversationWorkCellDetailsByKey((current) => ({
      ...current,
      [cacheKey]: { status: "loading" },
    }));

    const workspaceCwd = cwd.trim();
    const traceDetailPromise = listLingTraces(workspaceCwd, { threadId, limit: 1 })
      .then((response) => response.traces[0] ? getLingTrace(workspaceCwd, response.traces[0].id) : undefined)
      .catch(() => undefined);

    void Promise.all([
      getLingThreadEvidence(workspaceCwd, threadId),
      traceDetailPromise,
    ])
      .then(([evidence, trace]) => {
        const details = buildConversationWorkCellDetailsFromThreadEvidence({
          threadId,
          evidence,
          trace,
          runIds: workCell?.turnId ? workCell.runIds : undefined,
          t,
          artifactHref: (artifact) => artifactContentUrl(artifact.id, cwd),
        });
        const hasEvidence = details.evidenceLinks.length > 0 || details.groups.some((group) => group.rows.length > 0);
        setConversationWorkCellDetailsByKey((current) => ({
          ...current,
          [cacheKey]: {
            status: hasEvidence ? "loaded" : "empty",
            groups: details.groups,
            evidenceLinks: details.evidenceLinks,
          },
        }));
      })
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        setConversationWorkCellDetailsByKey((current) => ({
          ...current,
          [cacheKey]: {
            status: "error",
            errorMessage: message || t("Evidence failed to load."),
          },
        }));
      })
      .finally(() => {
        conversationWorkCellEvidenceLoadsRef.current.delete(cacheKey);
      });
  }

  function loadWorkflowWorkCellDetails(workflowIdOrThreadId: string, options: { readonly force?: boolean } = {}): void {
    const workflowId = workflowIdFromWorkCellThreadId(workflowIdOrThreadId);
    if (!workflowId) {
      return;
    }
    const cacheKey = workflowWorkCellDetailsCacheKey(workflowId);
    const existing = conversationWorkCellDetailsByKey[cacheKey];
    if (!options.force && (existing?.status === "loading" || existing?.status === "loaded" || existing?.status === "empty" || conversationWorkCellEvidenceLoadsRef.current.has(cacheKey))) {
      return;
    }

    conversationWorkCellEvidenceLoadsRef.current.add(cacheKey);
    setConversationWorkCellDetailsByKey((current) => ({
      ...current,
      [cacheKey]: { status: "loading" },
    }));

    void getChannelWorkflowEvidence(cwd.trim(), workflowId)
      .then((evidence) => {
        const details = buildConversationWorkCellDetailsFromWorkflowEvidence({
          evidence,
          t,
          artifactHref: (artifact) => artifactContentUrl(artifact.id, cwd),
        });
        const hasEvidence = details.evidenceLinks.length > 0 || details.groups.some((group) => group.rows.length > 0);
        setConversationWorkCellDetailsByKey((current) => ({
          ...current,
          [cacheKey]: {
            status: hasEvidence ? "loaded" : "empty",
            groups: details.groups,
            evidenceLinks: details.evidenceLinks,
          },
        }));
      })
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        setConversationWorkCellDetailsByKey((current) => ({
          ...current,
          [cacheKey]: {
            status: "error",
            errorMessage: message || t("Evidence failed to load."),
          },
        }));
      })
      .finally(() => {
        conversationWorkCellEvidenceLoadsRef.current.delete(cacheKey);
      });
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

  async function runChannelWorkspaceAction(
    action: string,
    operation: () => Promise<{ readonly binding: ChannelWorkspaceBinding }>,
    successMessage: string,
  ): Promise<void> {
    if (!selectedChannelId || channelWorkspaceBusyAction) {
      return;
    }
    setChannelWorkspaceBusyAction(action);
    setChannelWorkspaceNotice("");
    setChannelWorkspaceError("");
    try {
      const response = await operation();
      onChannelEditFormChange({ ...channelEditForm, workspaceBinding: response.binding });
      setChannelWorkspaceNotice(successMessage);
      onRefreshChannels();
    } catch (caught: unknown) {
      setChannelWorkspaceError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChannelWorkspaceBusyAction("");
    }
  }

  function onCreateManagedChannelWorktree(): void {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId) {
      return;
    }
    void runChannelWorkspaceAction(
      "create-worktree",
      () => createChannelWorktree(workspaceCwd, selectedChannelId),
      t("Managed worktree is ready."),
    );
  }

  function onRefreshChannelWorkspace(): void {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId) {
      return;
    }
    void runChannelWorkspaceAction(
      "refresh",
      () => refreshChannelWorkspace(workspaceCwd, selectedChannelId),
      t("Workspace status refreshed."),
    );
  }

  function onHandoffChannelWorkspace(mode: ChannelWorkspaceMode): void {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId) {
      return;
    }
    const executionPath = mode === "external_path" ? channelWorkspaceExternalPath.trim() : undefined;
    if (mode === "external_path" && !executionPath) {
      setChannelWorkspaceError(t("Enter an external workspace path."));
      return;
    }
    void runChannelWorkspaceAction(
      `handoff-${mode}`,
      () => handoffChannelWorkspace(workspaceCwd, selectedChannelId, { mode, executionPath }),
      mode === "local" ? t("Channel handed off to Local.") : mode === "managed_worktree" ? t("Channel handed off to Worktree.") : t("Channel handed off to External path."),
    );
  }

  function onOpenChannelWorkspacePath(): void {
    if (!selectedChannelExecutionPath) {
      return;
    }
    try {
      globalThis.open?.(`file://${selectedChannelExecutionPath}`, "_blank", "noopener");
      setChannelWorkspaceNotice(t("Opening workspace path."));
    } catch {
      void globalThis.navigator?.clipboard?.writeText(selectedChannelExecutionPath);
      setChannelWorkspaceNotice(t("Workspace path copied."));
    }
  }

  function addSelectedChannelTeammate(): void {
    if (!pendingChannelTeammateId) {
      return;
    }
    const teammateId = pendingChannelTeammateId;
    setPendingChannelTeammateId("");
    void onAddChannelTeammate(teammateId);
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

  function createTask(): void {
    onCreateTask();
    setCreateTaskOpen(false);
  }

  function openCreateTaskPanel(): void {
    setCreateTaskOpen(true);
    setSidePanelView("task");
    setSidePanelOpen(true);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setEnvironmentCommitDialogOpen(false);
    setActivityToolsOpen(false);
    setProgressPopoverOpen(false);
    setTeammateManagerOpen(false);
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
      isCancellingRun={isCancellingRun}
      approvalPolicy={approvalPolicy}
      permissionMode={permissionMode}
      permissionPreset={permissionPreset}
      decisions={channelDecisions}
      contextSummaries={channelContextSummaries}
      workflows={channelWorkflows}
      workflowSteps={channelWorkflowSteps}
      onCreateHandoffFromTask={onCreateHandoffFromTask}
      onOpenHandoffs={() => openProtocolFromActivity("handoffs")}
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
    handleComposerPaste,
    handleComposerDragOver,
    handleComposerDragLeave,
    handleComposerDrop,
    attachFiles,
    removePendingAttachment,
  } = useChannelComposerInputController({
    cwd,
    selectedChannelId,
    activeConversationRun,
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
  const channelExpertTeammateByKey = useMemo(
    () => {
      const map = new Map<string, LocalTeammateDraft>();
      for (const { teammate } of channelTeammates) {
        indexChannelExpertTeammate(map, teammate);
      }
      for (const teammate of localTeammates) {
        indexChannelExpertTeammate(map, teammate);
      }
      return map;
    },
    [channelTeammates, localTeammates],
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

  function showConversationBackgroundToast(feedback: ChannelComposerInlineFeedback): void {
    if (conversationBackgroundToastTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(conversationBackgroundToastTimeoutRef.current);
    }
    setConversationBackgroundToast(feedback);
    conversationBackgroundToastTimeoutRef.current = globalThis.setTimeout(() => {
      setConversationBackgroundToast(undefined);
      conversationBackgroundToastTimeoutRef.current = undefined;
    }, 4_200);
  }

  useEffect(() => () => {
    if (conversationBackgroundToastTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(conversationBackgroundToastTimeoutRef.current);
    }
  }, []);

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
        await onSendMessage({
          threadId,
          body,
          mentions: [],
          attachmentIds: [],
          linkPreviewIds: [],
          fileRefs: [],
          requestAiReply: true,
        });
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
      if (action === "accept" && channelPlanModeActive) {
        await setChannelPlanMode(false);
      }
      if (action === "refine" && !channelPlanModeActive) {
        await setChannelPlanMode(true);
      }
      const actionRequest = { plan: proposedPlanActionPayload(plan), ...actionInput };
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
      const body = action === "accept"
        ? `${t("Implement accepted plan: {title}", { title: plan.title })}\n\n${plan.bodyMarkdown}`
        : `${t("Refine this plan before implementation: {title}", { title: plan.title })}\n\n${plan.bodyMarkdown}`;
      if (action === "accept") {
        const result = await acceptProposedPlanArtifact(cwd, threadId, plan.id, actionRequest);
        rememberProposedPlanArtifact(result.plan);
        onRefreshTasks();
        refreshProposedPlanHistory();
      } else {
        const result = await refineProposedPlanArtifact(cwd, threadId, plan.id, actionRequest);
        rememberProposedPlanArtifact(result.plan);
        refreshProposedPlanHistory();
      }
      await onSendMessage({
        threadId,
        body,
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
        requestAiReply: action === "refine",
      });
      showComposerFeedback("success", action === "accept" ? t("Implementation task queued") : t("Plan refinement queued"));
    } catch (error) {
      showComposerFeedback("error", error instanceof Error ? error.message : String(error));
    } finally {
      setProposedPlanActionBusyId("");
    }
  }

  function proposedPlanActionPayload(plan: ProposedPlanArtifact) {
    return {
      id: plan.id,
      threadId: plan.threadId,
      channelId: plan.channelId ?? null,
      goalId: plan.goalId ?? null,
      sourceAgentId: plan.sourceAgentId ?? null,
      ownerAgentId: plan.ownerAgentId ?? null,
      sourceTurnId: plan.sourceTurnId ?? null,
      sourceMessageId: plan.sourceMessageId ?? null,
      sourceRunId: plan.sourceRunId ?? null,
      parentPlanId: plan.parentPlanId ?? null,
      supersededByPlanId: plan.supersededByPlanId ?? null,
      planGroupId: plan.planGroupId ?? null,
      version: plan.version ?? null,
      title: plan.title,
      bodyMarkdown: plan.bodyMarkdown,
      status: plan.status,
    };
  }

  function openProposedPlanSource(plan: ProposedPlanArtifact): void {
    if (!plan.sourceMessageId) {
      showComposerFeedback("info", t("Source unavailable"));
      return;
    }
    const targetFeedItemId = `message:${plan.sourceMessageId}`;
    const target = Array.from(document.querySelectorAll<HTMLElement>(".message-feed-virtual-row"))
      .find((element) => element.dataset.feedItemId === targetFeedItemId);
    if (!target) {
      showComposerFeedback("info", t("Source message is not loaded."));
      return;
    }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("conversation-work-cell-locate-pulse");
    globalThis.setTimeout(() => target.classList.remove("conversation-work-cell-locate-pulse"), 1400);
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
    openRunGuidanceInterventions,
    submitChannelRunGuidanceFromDraft,
    sendMessage,
    handleChannelComposerSubmit,
    dismissSendError,
  } = useChannelComposerActionsController({
    cwd,
    selectedChannelId,
    selectedChannelBranchRootThreadId,
    selectedChannel,
    activeConversationRun,
    activeConversationSourceRunId,
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
    composerFileRefs,
    readyLinkPreviewIds,
    composerBusy,
    setComposerBusy,
    sendState,
    setSendState,
    setSendError,
    setMentionPicker,
    setMentionActiveIndex,
    setPendingChannelSendPreview,
    autoPreviewUrlsRef,
    attachmentPreviewUrlsRef,
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
    onSetPlanMode: setChannelPlanMode,
    onSetGoalObjective: setChannelGoalObjective,
    onPatchGoal: patchChannelGoal,
    onCompleteGoal: completeChannelGoal,
    onClearGoal: clearChannelGoal,
    onSendMessage,
    onCancelActiveRun,
    onRefreshChannelActivity,
    onRefreshTasks,
    onRefreshRuntime,
    onRefreshRunApprovals,
    t,
  });
  const channelComposerSubmitDisabled = activeConversationRun
    ? !selectedChannelId || isCancellingRun || Boolean(runGuidanceSubmitting) || (composerHasSendableContent && (composerBusy || assetOperationPending))
    : !selectedChannelId || composerBusy || assetOperationPending || !composerHasSendableContent;
  const composerSessionCommandActive = composerSlashIntent.kind === "session_command";
  const channelComposerSubmitLabel = activeConversationRun
    ? composerHasSendableContent
      ? runGuidanceSubmitting === "queue_followup" ? t("Queueing guidance...") : t("Queue guidance")
      : isCancellingRun ? t("Stopping run...") : t("Stop run")
    : composerSessionCommandActive
      ? sendState === "sending" ? t("Applying command...") : t("Apply command")
    : composerSlashCommandActive
      ? sendState === "sending" ? t("Creating task...") : t("Create task")
      : sendState === "sending" ? t("Sending...") : t("Send");
  const composerShortcutTitle = activeConversationRun
    ? t("Enter queues guidance. Shift+Enter inserts a newline. Esc closes menus.")
    : t("Enter sends. Shift+Enter inserts a newline. Esc closes menus.");
  const channelComposerSubmitTitle = activeConversationRun && !composerHasSendableContent
    ? channelComposerSubmitLabel
    : t("{action} (Enter)", { action: channelComposerSubmitLabel });
  const composerDropZoneStyle = {
    "--composer-input-min-height": `${composerInputMinHeight}px`,
  } as CSSProperties;
  const localUserDisplayName = userProfile?.displayName.trim() || t("You");
  const messageRenderers = createChannelMessageRenderers({
    activeRunId,
    allLocalTeammateById,
    allLocalTeammateByName,
    approvals,
    attachmentContentUrl,
    auditActivityVisible,
    channelArtifactsByRun,
    channelAttachmentById,
    channelMessageFeedbackById,
    channelMessagesLoadingOlder,
    channelTeamExpertsByTurn,
    channelTeamExpertsExpandedByTurn,
    channelWorkflowSteps,
    channelWorkflows,
    conversationWorkCellByThreadId,
    conversationWorkCellByWorkflowId,
    conversationWorkCellDetailsByKey,
    cwd,
    executionProposalsByMessageId,
    formatBytes,
    latestStatus,
    localUserDisplayName,
    memoryById,
    orchestratingWorkflowId,
    proposedPlanArtifactsById,
    runningWorkflowStepId,
    runById,
    selectedChannelBranchRootThreadId,
    selectedChannelId,
    teammateOptions,
    t,
    usedMemoryEvents,
    userProfile,
    workflowProgressByWorkflowId,
    activityActionRow,
    conversationWorkCellDetailsCacheKey,
    onCancelExecutionProposal,
    onCancelWorkflow,
    onConfirmExecutionProposal,
    onCreateTaskFromContextSummary,
    onAcceptProposedPlan: handleAcceptProposedPlan,
    onConvertProposedPlan: handleConvertProposedPlan,
    onLoadConversationWorkCellDetails: loadConversationWorkCellDetails,
    onLoadWorkflowWorkCellDetails: loadWorkflowWorkCellDetails,
    onOpenApprovalDetail: openApprovalDetail,
    onOpenContextSummaryInConversationDetail: openContextSummaryInConversationDetail,
    onOpenRun: openRunInPanel,
    onOpenThreadForMessage: threadReplyController.openThreadForMessage,
    onOrchestrateWorkflow,
    onRejectDecision,
    onRefineProposedPlan: handleRefineProposedPlan,
    onSaveProposedPlan: handleSaveProposedPlan,
    onRetryWorkflowStep,
    onRevealReviewInConversation: revealReviewInConversation,
    onRevealRunFromActivity: revealRunFromActivity,
    onRevealTaskFromActivity: revealTaskFromActivity,
    onStartWorkflowFromHandoff,
    onSupersedeDecision,
    onToggleChannelMessageFeedback: toggleChannelMessageFeedback,
    onToggleChannelTeamExpertsExpanded: toggleChannelTeamExpertsExpanded,
    onUpdateExecutionProposal,
    onUpdateHandoffStatus,
    readRunTitle,
    resolveExpertTeammate: (agentId) => channelExpertTeammateByKey.get(normalizeChannelExpertTeammateKey(agentId)),
    planActionBusyId: proposedPlanActionBusyId,
    workflowWorkCellDetailsCacheKey,
  });

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

  function toggleChannelTeamExpertsExpanded(turnId: string): void {
    setChannelTeamExpertsExpandedByTurn((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? false),
    }));
  }

  const channelComposerPermissionPreset = permissionPreset ?? inferPermissionPreset(permissionMode);
  const channelComposerPermissionLocked = Boolean(activeConversationRun) || sendState === "sending" || composerBusy || Boolean(runGuidanceSubmitting) || isCancellingRun;
  const channelComposer = (
    <ChannelComposer
      statusNode={channelActiveStatusStrip}
      activeRun={Boolean(activeConversationRun)}
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
      inlineApprovalViews={inlineApprovalViews}
      isCancellingRun={isCancellingRun}
      mentionActiveIndex={mentionActiveIndex}
      mentionPicker={mentionPicker}
      mentionPickerOptions={mentionPickerOptions}
      pendingAttachments={pendingAttachments}
      pendingMessageAssetsVisible={pendingMessageAssetsVisible}
      permissionLocked={channelComposerPermissionLocked}
      permissionPreset={channelComposerPermissionPreset}
      planModeActive={channelPlanModeActive}
      planModeBusy={channelPlanModeBusy}
      goal={activeChannelGoal}
      goalBusy={channelGoalBusy}
      goalLoading={Boolean(channelGoalLoadingThreadId)}
      goalError={channelGoalError}
      goalExpanded={channelGoalExpanded}
      channelTeammateIds={channelTeammateIds}
      resolvingApprovals={resolvingApprovals}
      runGuidanceError={runGuidanceError}
      runGuidanceItems={runGuidanceItems}
      runGuidanceLoading={runGuidanceLoading}
      runGuidanceSubmitting={runGuidanceSubmitting}
      selectedChannelId={selectedChannelId}
      sendError={sendError}
      sendState={sendState}
      showGuidance={Boolean(activeConversationRun) || openRunGuidanceInterventions.length > 0}
      slashActiveIndex={slashActiveIndex}
      slashCommandPickerOptions={slashCommandPickerOptions}
      slashPicker={slashPicker}
      submitDisabled={channelComposerSubmitDisabled}
      submitLabel={channelComposerSubmitLabel}
      submitTitle={channelComposerSubmitTitle}
      value={messageDraft}
      formatBytes={formatBytes}
      onAttachFiles={attachFiles}
      onCommitMention={commitMention}
      onCommitSlashCommand={commitSlashCommand}
      onDismissSendError={dismissSendError}
      onDragOver={handleComposerDragOver}
      onDragLeave={handleComposerDragLeave}
      onDrop={handleComposerDrop}
      onInputChange={handleComposerTextChange}
      onInputKeyDown={(event) => handleComposerKeyDown(event, {
        submitChannelRunGuidanceFromDraft,
        sendMessage,
      })}
      onInputPaste={handleComposerPaste}
      onInputSelect={updateMentionPicker}
      onInsertMentionTrigger={insertMentionTrigger}
      onOpenApproval={(approvalId) => openApprovalDetail(approvals.find((approval) => approval.id === approvalId))}
      onPermissionPresetChange={(preset) => onPermissionModeChange(permissionModeForPreset(preset))}
      onTogglePlanMode={() => {
        void setChannelPlanMode(!channelPlanModeActive)
          .then(() => {
            showComposerFeedback("success", channelPlanModeActive ? t("Plan Mode disabled") : t("Plan Mode enabled"));
          })
          .catch((error: unknown) => {
            showComposerFeedback("error", error instanceof Error ? error.message : String(error));
          });
      }}
      onOpenGoalEditor={openChannelGoalEditor}
      onGoalContinue={continueChannelGoal}
      onGoalPauseResume={pauseOrResumeChannelGoal}
      onGoalComplete={completeChannelGoalFromPanel}
      onGoalClear={clearChannelGoalFromPanel}
      onToggleGoalExpanded={() => setChannelGoalExpanded((expanded) => !expanded)}
      onRemovePendingAttachment={removePendingAttachment}
      onResizePointerCancel={handleComposerResizePointerEnd}
      onResizePointerDown={handleComposerResizePointerDown}
      onResizePointerMove={handleComposerResizePointerMove}
      onResizePointerUp={handleComposerResizePointerEnd}
      onResolveApproval={onResolveApproval}
      onRetrySend={() => {
        void sendMessage();
      }}
      onSubmit={handleChannelComposerSubmit}
    />
  );

  const channelHasChatContent = channelMessages.length > 0 || channelContextSummaries.length > 0;
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
    workflowSteps: channelWorkflowSteps,
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
  const unreadGovernanceNotificationCount = actionableGovernanceNotifications.filter((notification) => notification.status === "unread").length;
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
    setChannelSettingsPageOpen(true);
    setChannelEnvironmentPageOpen(false);
    setEnvironmentCommitDialogOpen(false);
    setSidePanelOpen(false);
    setCreateTaskOpen(false);
    setConversationDetailOverlay(undefined);
    setProgressPopoverOpen(false);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
    onChannelCreateOpenChange(false);
    refreshChannelSettingsPage();
  }

  function closeChannelSettingsPage(): void {
    setChannelSettingsPageOpen(false);
  }

  function openChannelEnvironmentPage(): void {
    setChannelEnvironmentPageOpen(true);
    setChannelSettingsPageOpen(false);
    setEnvironmentCommitDialogOpen(false);
    setSidePanelOpen(false);
    setCreateTaskOpen(false);
    setConversationDetailOverlay(undefined);
    setProgressPopoverOpen(false);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
    onChannelCreateOpenChange(false);
  }

  function closeChannelEnvironmentPage(): void {
    setChannelEnvironmentPageOpen(false);
  }

  function openEnvironmentCommitDialog(): void {
    setEnvironmentCommitDialogOpen(true);
    setProgressPopoverOpen(false);
    setChannelMoreOpen(false);
  }

  function closeEnvironmentCommitDialog(): void {
    setEnvironmentCommitDialogOpen(false);
  }

  function openChannelRenameDialog(): void {
    if (!selectedChannel) {
      return;
    }
    setChannelRenameName(selectedChannel.name);
    setChannelRenameOpen(true);
    setChannelMoreOpen(false);
    setEnvironmentCommitDialogOpen(false);
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
    onChannelEditFormChange(nextForm);
    try {
      await onSaveChannel(nextForm);
      setChannelRenameOpen(false);
    } catch {
      // saveChannelEdit already publishes the user-facing error message.
    } finally {
      setChannelRenameSaving(false);
    }
  }

  function openRightDockPage(page: DockPageKind): void {
    setSidePanelView("context");
    setSidePanelOpen(true);
    setCreateTaskOpen(false);
    setConversationDetailOverlay(undefined);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setEnvironmentCommitDialogOpen(false);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    if (!progressPopoverCanFitMainLayout) {
      setProgressPopoverOpen(false);
    }
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
    channelRightDock.requestPage(page);
  }

  function openSidePanelView(view: ChannelSidePanelView): void {
    if (view === "settings") {
      openChannelSettingsPage();
      return;
    }
    setSidePanelView(view);
    setSidePanelOpen(true);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    setEnvironmentCommitDialogOpen(false);
    setConversationDetailOverlay(undefined);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    if (!progressPopoverCanFitMainLayout) {
      setProgressPopoverOpen(false);
    }
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
    setEnvironmentCommitDialogOpen(false);
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
    setEnvironmentCommitDialogOpen(false);
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
        subtitle: t("Read-only team activity and evidence"),
        evidence: t("Evidence"),
        visibleEvidence: t("visible evidence"),
        teamEvidence: t("team evidence"),
        health: t("Health"),
        active: t("Active"),
        delayed: t("Delayed"),
        unavailable: t("Unavailable"),
        riskReview: t("Risk review"),
        learningQueue: t("Learning queue"),
        agentActivity: t("Agent activity"),
        noAgentActivity: t("No agent evidence yet"),
      }}
    />
  ) : channelTeamMetricsError ? (
    <section className="channel-settings-card channel-team-metrics-panel" aria-label={t("Team metrics")}>
      <div className="inline-error compact">
        <CircleAlert size={14} />
        {t("Team metrics could not be loaded")}
      </div>
    </section>
  ) : channelTeamMetricsLoading ? (
    <section className="channel-settings-card channel-team-metrics-panel" aria-label={t("Team metrics")}>
      <div className="activity-feed-status" role="status">
        <Loader2 className="spin" size={14} />
        <span>{t("Loading team metrics...")}</span>
      </div>
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
      onRefreshAiCouncils={onRefreshAiCouncils}
      onRefreshChannelCouncil={onRefreshChannelCouncil}
      channelTeamMetricsPanel={channelTeamMetricsPanel}
      channelEditForm={channelEditForm}
      channelSettingsAutosaveState={channelSettingsAutosaveState}
      onChannelEditFormChange={updateChannelSettingsEditForm}
      providersLoading={providersLoading}
      providers={providers}
      taskReadyProviders={taskReadyProviders}
      setupChatProviders={setupChatProviders}
      selectedChannelWorkspace={selectedChannelWorkspace}
      selectedChannelExecutionPath={selectedChannelExecutionPath}
      channelWorkspaceBusyAction={channelWorkspaceBusyAction}
      channelWorkspaceExternalPath={channelWorkspaceExternalPath}
      channelWorkspaceNotice={channelWorkspaceNotice}
      channelWorkspaceError={channelWorkspaceError}
      onChannelWorkspaceExternalPathChange={setChannelWorkspaceExternalPath}
      onCreateManagedChannelWorktree={onCreateManagedChannelWorktree}
      onRefreshChannelWorkspace={onRefreshChannelWorkspace}
      onOpenChannelWorkspacePath={onOpenChannelWorkspacePath}
      onHandoffChannelWorkspace={onHandoffChannelWorkspace}
      channelsLoading={channelsLoading}
      onRefreshChannels={onRefreshChannels}
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
        onSupersedeDecision={onSupersedeDecision}
        onRejectDecision={onRejectDecision}
        onUpdateHandoffStatus={onUpdateHandoffStatus}
        onStartWorkflowFromHandoff={onStartWorkflowFromHandoff}
        onStartTemplateWorkflow={onStartTemplateWorkflow}
        onOrchestrateWorkflow={onOrchestrateWorkflow}
        onCancelWorkflow={onCancelWorkflow}
        onStartWorkflowStep={onStartWorkflowStep}
        onRetryWorkflowStep={onRetryWorkflowStep}
        onUpdateWorkflowStepStatus={onUpdateWorkflowStepStatus}
        onCreateTaskFromContextSummary={onCreateTaskFromContextSummary}
        onRefreshRuntime={onRefreshRuntime}
        onCancelWorkUnit={onCancelWorkUnit}
        onRetryWorkUnit={onRetryWorkUnit}
        onReconcileWorkUnit={onReconcileWorkUnit}
      />
    </div>
  );
  const sidePanelContent = sidePanelView === "context" ? channelContextDockContent : (
    <section className="task-detail-panel inline-task-detail-panel" aria-label={sidePanelTitle}>
      {taskDetailContent}
    </section>
  );
  const channelRightDockContent = useChannelRightDockContent({
    selectedChannelId,
    approvals,
    runById,
    taskChannelById,
    channelRuns,
    channelMessages,
    channelAttachments,
    channelArtifactsByRun,
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
          messages={channelMessages}
          decisions={channelDecisions}
        />
      )}
    </ConversationDetailOverlay>
  ) : null;
  const channelHasProgressPopoverContent = attentionProgressRows.length > 0 || channelEnvironmentSummary.popoverRows.length > 0;
  const progressPopoverVisible = progressPopoverOpen && !teammateManagerOpen && !channelUtilityPageOpen && channelHasProgressPopoverContent;
  const progressPopoverPlacementAvailable =
    !teammateManagerOpen &&
    !channelUtilityPageOpen &&
    channelHasProgressPopoverContent &&
    (!channelRightDockVisible || progressPopoverCanUseMainLayout);
  const progressPopoverCanRender =
    progressPopoverVisible && (!channelRightDockVisible || progressPopoverCanUseMainLayout);
  const progressPopoverShouldRender = progressPopoverRendered && progressPopoverPlacementAvailable;
  const progressPopoverInMainLayout = progressPopoverShouldRender && progressPopoverCanUseMainLayout;
  const progressPopoverMotionClass = progressPopoverExpanded ? "is-popover-expanded" : "is-popover-collapsed";
  useEffect(() => {
    if (progressPopoverCanRender) {
      if (!progressPopoverRendered) {
        setProgressPopoverExpanded(false);
        setProgressPopoverRendered(true);
        return undefined;
      }

      const firstFrameId = globalThis.requestAnimationFrame(() => {
        const secondFrameId = globalThis.requestAnimationFrame(() => {
          progressPopoverOpenFrameRef.current = undefined;
          setProgressPopoverExpanded(true);
        });
        progressPopoverOpenFrameRef.current = secondFrameId;
      });
      progressPopoverOpenFrameRef.current = firstFrameId;
      return () => {
        const frameId = progressPopoverOpenFrameRef.current;
        if (frameId !== undefined) {
          globalThis.cancelAnimationFrame(frameId);
          progressPopoverOpenFrameRef.current = undefined;
        }
      };
    }

    const frameId = progressPopoverOpenFrameRef.current;
    if (frameId !== undefined) {
      globalThis.cancelAnimationFrame(frameId);
      progressPopoverOpenFrameRef.current = undefined;
    }
    setProgressPopoverExpanded(false);
    if (!progressPopoverRendered) {
      return undefined;
    }
    const timeoutId = globalThis.setTimeout(() => {
      setProgressPopoverRendered(false);
    }, channelRightDockTransitionMs);
    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [progressPopoverCanRender, progressPopoverRendered]);
  const progressPopoverNode = (
    <ProgressPopover
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
  } as CSSProperties;
  const taskWorkbenchMainStyle = channelRightDock.mainStyle;

  function toggleChannelTeammateManager(): void {
    const nextOpen = !teammateManagerOpen;
    setTeammateManagerOpen(nextOpen);
    if (nextOpen) {
      setChannelSettingsPageOpen(false);
      setChannelEnvironmentPageOpen(false);
      setEnvironmentCommitDialogOpen(false);
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
        channelRightDockVisible ? "with-channel-side-panel" : "",
        channelRightDockVisible ? (channelRightDockExpanded ? "channel-right-dock-expanded" : "channel-right-dock-collapsed") : "",
        progressPopoverCanRender && !progressPopoverInMainLayout ? "with-channel-progress-popover" : "",
        channelBottomPanelVisible ? "with-channel-bottom-panel" : "",
        channelBottomPanelResize.resizing ? "is-resizing-channel-bottom-panel" : "",
      ].filter(Boolean).join(" ")}
      style={taskWorkbenchWindowStyle}
      aria-label={t("Workspace")}
    >
      <header className={channelUtilityPageOpen ? "channel-header task-workbench-header settings-page-header" : "channel-header task-workbench-header"}>
        <div className="channel-title-area">
          {channelSettingsPageOpen ? (
            <div className="channel-settings-header-line">
              <button className="channel-settings-top-back" type="button" onClick={closeChannelSettingsPage}>
                <ArrowLeft size={16} />
                {t("Back to channel")}
              </button>
              <div className="channel-settings-header-title">
                <span>
                  <SlidersHorizontal size={17} />
                  <strong>{t("Channel settings")}</strong>
                </span>
                <small>{selectedChannel?.name ? `#${selectedChannel.name}` : t("No channel selected")}</small>
              </div>
            </div>
          ) : channelEnvironmentPageOpen ? (
            <div className="channel-settings-header-line">
              <button className="channel-settings-top-back" type="button" onClick={closeChannelEnvironmentPage}>
                <ArrowLeft size={16} />
                {t("Back to channel")}
              </button>
              <div className="channel-settings-header-title">
                <span>
                  <Command size={17} />
                  <strong>{t("Environment")}</strong>
                </span>
                <small>{selectedChannel?.name ? `#${selectedChannel.name}` : t("No channel selected")}</small>
              </div>
            </div>
          ) : (
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
                    <button
                      className={channelSettingsPageOpen ? "channel-more-item active" : "channel-more-item"}
                      type="button"
                      role="menuitem"
                      onClick={openChannelSettingsPage}
                    >
                      <SlidersHorizontal size={15} />
                      <span>{t("Settings")}</span>
                    </button>
                    <button
                      className="channel-more-item"
                      type="button"
                      role="menuitem"
                      onClick={openChannelRenameDialog}
                      disabled={!selectedChannelId}
                    >
                      <PencilLine size={15} />
                      <span>{t("Rename channel")}</span>
                    </button>
                    <button
                      className={channelEnvironmentPageOpen ? "channel-more-item active" : "channel-more-item"}
                      type="button"
                      role="menuitem"
                      onClick={openChannelEnvironmentPage}
                    >
                      <Command size={15} />
                      <span>{t("Environment")}</span>
                    </button>
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
                        setProgressPopoverOpen(false);
                        setChannelSettingsPageOpen(false);
                        setChannelEnvironmentPageOpen(false);
                        setEnvironmentCommitDialogOpen(false);
                        setTeammateManagerOpen(false);
                      }}
                    >
                      <SlidersHorizontal size={15} />
                      <span>{t("Filter channel events")}</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
        <div className="channel-header-actions" aria-label={t("Workspace task toolbar")}>
          {channelSettingsPageOpen ? (
            <button className="secondary-button compact-button channel-settings-refresh-button" type="button" onClick={refreshChannelSettingsPage} disabled={!selectedChannelId || channelSettingsLoading}>
              {channelSettingsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {t("Refresh")}
            </button>
          ) : channelEnvironmentPageOpen ? null : (
            <>
          {channelHeaderTeammateCount > 0 ? (
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
          ) : null}
          {governanceNotificationCount > 0 ? (
            <div className="channel-governance-wrap" ref={governanceNotificationsRef}>
              <button
                className={governanceNotificationsOpen ? "channel-governance-button active" : "channel-governance-button"}
                type="button"
                aria-expanded={governanceNotificationsOpen}
                title={t("Review queue")}
                onClick={() => {
                  const nextOpen = !governanceNotificationsOpen;
                  setGovernanceNotificationsOpen(nextOpen);
                  if (nextOpen) {
                    setProgressPopoverOpen(false);
                    setChannelMoreOpen(false);
                    setActivityToolsOpen(false);
                    setTeammateManagerOpen(false);
                    setSidePanelOpen(false);
                    onChannelCreateOpenChange(false);
                  }
                }}
                disabled={channelGovernanceNotificationsLoading}
              >
                {channelGovernanceNotificationsLoading ? <Loader2 className="spin" size={14} /> : <ShieldCheck size={14} />}
                <span>{t("Review")}</span>
                <strong>{governanceNotificationCount}</strong>
                {unreadGovernanceNotificationCount > 0 ? <small>{unreadGovernanceNotificationCount}</small> : null}
              </button>
              {governanceNotificationsOpen ? (
                <ChannelGovernanceNotificationsPopover
                  notifications={actionableGovernanceNotifications}
                  loading={channelGovernanceNotificationsLoading}
                  actionId={channelGovernanceNotificationActionId}
                  onRefresh={onRefreshChannelGovernanceNotifications}
                  onMarkSeen={onMarkChannelGovernanceNotificationSeen}
                  onDismiss={onDismissChannelGovernanceNotification}
                />
              ) : null}
            </div>
          ) : null}
          {channelHeaderTeammateCount === 0 ? (
            <button
              ref={teammateManagerButtonRef}
              className={teammateManagerOpen ? "icon-button active task-toolbar-teammates" : "icon-button task-toolbar-teammates"}
              type="button"
              aria-expanded={teammateManagerOpen}
              aria-label={t("AI teammate management")}
              title={t("AI teammate management")}
              onClick={toggleChannelTeammateManager}
              disabled={!selectedChannelId}
            >
              <UserPlus size={15} />
            </button>
          ) : null}
          <button
            className={progressPopoverRendered ? "icon-button active task-toolbar-progress" : "icon-button task-toolbar-progress"}
            type="button"
            aria-label={t("Progress")}
            title={t("Progress")}
            onClick={() => {
              if (!channelHasProgressPopoverContent) {
                setProgressPopoverOpen(false);
                return;
              }
              setChannelSettingsPageOpen(false);
              setChannelEnvironmentPageOpen(false);
              setEnvironmentCommitDialogOpen(false);
              setCreateTaskOpen(false);
              setChannelMoreOpen(false);
              setActivityToolsOpen(false);
              setTeammateManagerOpen(false);
              setProgressPopoverOpen((current) => !current);
            }}
          >
            <ListChecks size={15} />
          </button>
          <button
            className={channelBottomPanelVisible ? "icon-button active task-toolbar-bottom-panel" : "icon-button task-toolbar-bottom-panel"}
            type="button"
            aria-expanded={channelBottomPanelVisible}
            aria-label={t("Toggle bottom panel")}
            title={t("Toggle bottom panel")}
            onClick={() => {
              if (channelBottomPanelVisible) {
                setChannelBottomPanelOpen(false);
                return;
              }
              setChannelSettingsPageOpen(false);
              setChannelEnvironmentPageOpen(false);
              setEnvironmentCommitDialogOpen(false);
              setCreateTaskOpen(false);
              setChannelMoreOpen(false);
              setActivityToolsOpen(false);
              setTeammateManagerOpen(false);
              setProgressPopoverOpen(false);
              setChannelBottomPanelOpen(true);
            }}
            disabled={!cwd.trim()}
          >
            {channelBottomPanelVisible ? <PanelBottomClose size={15} /> : <PanelBottom size={15} />}
          </button>
          <button
            className={channelRightDockIntentOpen ? "icon-button active task-toolbar-panel" : "icon-button task-toolbar-panel"}
            type="button"
            aria-expanded={channelRightDockIntentOpen}
            aria-label={channelRightDockIntentOpen ? t("Hide details") : t("Show details")}
            title={channelRightDockIntentOpen ? t("Hide details") : t("Show details")}
            onClick={() => {
              if (channelRightDockIntentOpen) {
                closeChannelRightDock();
                return;
              }
              openSidePanelView(sidePanelView === "settings" ? "context" : sidePanelView);
            }}
          >
            {channelRightDockIntentOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
            </>
          )}
        </div>
        {progressPopoverShouldRender && !progressPopoverInMainLayout ? (
          <div className={`channel-progress-popover ${progressPopoverMotionClass}`}>
            {progressPopoverNode}
          </div>
        ) : null}
      </header>

      {teammateManagerOpen ? (
        <section ref={teammateManagerPanelRef} className="workbench-settings-panel channel-teammate-dock" aria-label={t("AI teammate management")}>
          <ChannelTeammateManagerPanel
            cwd={cwd}
            selectedChannelId={selectedChannelId}
            channelTeammateMembershipsLoading={channelTeammateMembershipsLoading}
            channelTeammates={channelTeammates}
            localTeammates={localTeammates}
            availableChannelTeammates={availableChannelTeammates}
            pendingChannelTeammateId={pendingChannelTeammateId}
            channelTeammateSavingId={channelTeammateSavingId}
            onPendingChannelTeammateIdChange={setPendingChannelTeammateId}
            onAddSelectedChannelTeammate={addSelectedChannelTeammate}
            onRemoveChannelTeammate={onRemoveChannelTeammate}
            onOpenTeammates={onOpenTeammates}
          />
        </section>
      ) : null}

      {channelRenameOpen ? (
        <ChannelRenameDialog
          value={channelRenameName}
          currentName={selectedChannel?.name ?? ""}
          saving={channelRenameSaving}
          onValueChange={setChannelRenameName}
          onSubmit={(event) => void submitChannelRename(event)}
          onClose={closeChannelRenameDialog}
        />
      ) : null}

      {environmentCommitDialogOpen ? (
        <ChannelEnvironmentCommitDialog
          message={environmentCommitMessage}
          includeUnstaged={environmentIncludeUnstaged}
          disabledReason={channelEnvironmentSummary.commitAction?.disabledReason ?? t("Commit and push require a daemon Git action and approval policy. This first version is read-only.")}
          onMessageChange={setEnvironmentCommitMessage}
          onIncludeUnstagedChange={setEnvironmentIncludeUnstaged}
          onClose={closeEnvironmentCommitDialog}
        />
      ) : null}

      {workflowConversionPreviewPlan ? (
        <WorkflowConversionPreviewDrawer
          plan={workflowConversionPreviewPlan}
          cwd={cwd.trim()}
          busy={proposedPlanActionBusyId === workflowConversionPreviewPlan.id}
          teammates={workflowOwnerInferenceTeammates}
          historicalWorkflowSteps={workflowOwnerInferenceHistorySteps}
          onConfirm={confirmWorkflowConversionPreview}
          onClose={closeWorkflowConversionPreview}
        />
      ) : null}

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      <div
        ref={taskWorkbenchMainRef}
        style={taskWorkbenchMainStyle}
        className={[
          "task-workbench-main",
          channelUtilityPageOpen ? "channel-settings-main" : "",
          channelEnvironmentPageOpen ? "channel-environment-main" : "",
          channelRightDockVisible ? "with-channel-side-panel" : "",
          channelRightDockVisible ? (channelRightDockExpanded ? "channel-right-dock-expanded" : "channel-right-dock-collapsed") : "",
          progressPopoverInMainLayout ? "with-channel-progress-panel" : "",
          progressPopoverInMainLayout ? (progressPopoverExpanded ? "progress-panel-expanded" : "progress-panel-collapsed") : "",
          channelRightDockResizing ? "is-resizing-channel-side-panel" : "",
        ].filter(Boolean).join(" ")}
      >
        {channelSettingsPageOpen ? (
          <section className="channel-settings-page" aria-label={t("Channel settings")}>
            {channelSettingsContent}
          </section>
        ) : channelEnvironmentPageOpen ? (
          <ChannelEnvironmentPage
            summary={channelEnvironmentSummary}
            channelName={selectedChannel?.name}
            onOpenReview={() => openRightDockPage("review")}
            onOpenCommit={openEnvironmentCommitDialog}
          />
        ) : (
          <>
        <ChannelActivityWorkspace
          activityTools={auditActivityVisible ? {
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
            runs,
            approvals,
            workflowSteps: channelWorkflowSteps,
            externalActionDetails,
            externalWorkCiTriage,
            artifactsByRun: channelArtifactsByRun,
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
            empty: messageFeedEmpty,
            loadingLabel: t("Loading messages..."),
            emptyIcon: activeWorkThreadId ? <GitBranch /> : activityFiltersActive ? <Search /> : <MessageSquare />,
            emptyLabel: activeWorkThreadId
              ? t("No work recorded in this branch yet")
              : activityFiltersActive
                ? t("No activity matches these filters")
                : selectedChannel
                  ? t("No channel messages yet")
                  : t("Create a default channel to start the workspace loop."),
            title: t("Alt+Up/Down focuses adjacent blocks. Ctrl+Shift+C copies the focused block."),
            items: messageFeedItems,
            renderItem: messageRenderers.renderMessageFeedItem,
            onKeyDown: handleMessageFeedKeyDown,
            onPointerDown: handleMessageFeedPointerDown,
            onPointerMove: handleMessageFeedPointerMove,
            onPointerUp: handleMessageFeedPointerEnd,
            onPointerCancel: handleMessageFeedPointerEnd,
            onContextMenu: handleMessageFeedContextMenu,
            statusNode: (
              <>
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
              </>
            ),
            latestButtonNode: (
              <>
                {conversationBackgroundToast ? (
                  <button
                    key={conversationBackgroundToast.id}
                    className={`conversation-background-toast ${conversationBackgroundToast.tone}`}
                    type="button"
                    onClick={messageFeedState.scrollToLatest}
                    aria-label={`${conversationBackgroundToast.message}. ${t("Jump to latest")}`}
                  >
                    <span role="status" aria-live="polite">{conversationBackgroundToast.message}</span>
                    <small>{t("Jump to latest")}</small>
                  </button>
                ) : null}
                {conversationBlockFeedbackNode}
                {messageFeedState.latestButtonVisible ? (
                  <button
                    className="message-feed-latest-button"
                    type="button"
                    onClick={messageFeedState.scrollToLatest}
                    aria-label={t("Jump to latest message")}
                  >
                    <ArrowDown size={22} />
                  </button>
                ) : null}
              </>
            ),
          }}
          conversationBlockActionMenuNode={conversationBlockActionMenuNode}
          conversationDetailOverlayNode={conversationDetailOverlayNode}
          composerNode={channelComposer}
          threadReply={threadReplyController.activeThreadRoot ? {
            cwd,
            rootMessage: threadReplyController.activeThreadRoot,
            replies: threadReplyController.activeThreadMessages,
            teammates: teammateOptions,
            memoryById,
            usedMemoryEvents,
            draft: threadReplyController.draft,
            pending: threadReplyController.pending,
            error: threadReplyController.error,
            onDraftChange: threadReplyController.changeDraft,
            onSend: () => void threadReplyController.sendReply(),
            onClose: threadReplyController.closeThread,
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
        {progressPopoverInMainLayout ? (
          <aside className={`channel-progress-popover channel-progress-panel ${progressPopoverMotionClass}`} aria-label={t("Progress")}>
            {progressPopoverNode}
          </aside>
        ) : null}
        {channelRightDockVisible ? (
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
                    <button
                      className="icon-button"
                      type="button"
                      onClick={openCreateTaskPanel}
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

function workflowIdFromWorkCellThreadId(value: string): string {
  return value.startsWith("workflow:") ? value.slice("workflow:".length) : value;
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

function indexChannelExpertTeammate(map: Map<string, LocalTeammateDraft>, teammate: LocalTeammateDraft): void {
  const aliases = [
    teammate.id,
    teammate.displayName,
    teammate.roleKey,
    teammate.systemRole,
  ];
  for (const alias of aliases) {
    const key = normalizeChannelExpertTeammateKey(alias);
    if (key && !map.has(key)) {
      map.set(key, teammate);
    }
  }
}

function normalizeChannelExpertTeammateKey(value: string | undefined): string {
  return value?.trim().replace(/^@+/, "").toLowerCase() ?? "";
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

function isChannelNotificationLevel(value: string | null | undefined): value is ChannelNotificationLevel {
  return value === "all" || value === "mentions" || value === "muted";
}

function resolveChannelWorkspaceBinding(channel: Channel, cwd: string): ChannelWorkspaceBinding {
  return channel.workspaceBinding ?? {
    mode: "local",
    status: "ready",
    executionPath: channel.boundPath || cwd,
    updatedAt: channel.updatedAt,
  };
}

function resolveChannelWorkspaceExecutionPath(binding: ChannelWorkspaceBinding, channel: Channel, cwd: string): string {
  if (binding.mode === "managed_worktree" && binding.worktreePath) {
    return binding.worktreePath;
  }
  if (binding.mode === "external_path" && binding.executionPath) {
    return binding.executionPath;
  }
  return binding.executionPath || channel.boundPath || cwd;
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
