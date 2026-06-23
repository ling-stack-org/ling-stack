import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type UIEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  Archive,
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
  Copy,
  Database,
  FileCheck2,
  FileText,
  FolderOpen,
  GitBranch,
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
  Pin,
  PinOff,
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
  UsersRound,
  Workflow,
  X,
} from "lucide-react";
import { LingDaemonError } from "@ling-stack/api-client";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import type { AiTeammateTemplate } from "@ling-stack/core";
import { archiveLingThread, artifactContentUrl, cancelRunIntervention, createLingThread, createRunIntervention, forkLingThread, getChannelWorkflowEvidence, getLingThreadEvidence, getLingTrace, listLingThreads, listLingThreadTurns, listLingTraces, listRunInterventions, pinLingThread, promoteRunIntervention, unpinLingThread } from "../../api.js";
import { createChannelWorktree, handoffChannelWorkspace, listChannelCollaborationCards, refreshChannelWorkspace } from "../../api/channels.js";
import { useI18n, type Translate } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { buildInlineApprovalViews } from "../../lib/inline-approvals.js";
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
  aiCouncilBoundaryLabels,
  aiCouncilCapacityLabel,
  aiCouncilHealthLabels,
  aiCouncilRoutingModeLabel,
} from "../../lib/ai-councils.js";
import { buildConversationWorkCellDetailsFromThreadEvidence, buildConversationWorkCellViewModel, groupRunsByThreadId, type ConversationAgentActivitySpan, type ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import { buildConversationTurnProjection, type ConversationTranscriptBlock, type ConversationTurnViewModel } from "../../lib/conversation-turn-projector.js";
import { buildCollaborationProgressProjection, type CollaborationProgressProjectionIcon, type CollaborationProgressProjectionItem, type CollaborationProgressProjectionTone } from "../../lib/collaboration-progress-projection.js";
import { buildCollaborationTaskCardModel, type CollaborationTaskCardModel } from "../../lib/collaboration-task-card.js";
import {
  buildConversationContextSourceSummaryFromChannelSummary,
  buildConversationContextSourceSummaryFromInspect,
  buildConversationContextSourceSummaryFromPacket,
  conversationContextSourceSummaryLabel,
  type ConversationContextSourceGroup,
  type ConversationContextSourceRefLike,
  type ConversationContextSourceSummary,
} from "../../lib/conversation-context-sources.js";
import { buildConversationWorkCellDetailsFromWorkflowEvidence, buildWorkflowProgressModel, workflowProgressToConversationWorkCell, type WorkflowProgressModel } from "../../lib/workflow-progress.js";
import {
  allChannelActivitySavedViewId,
  applyActivityViewFilter,
  builtinChannelActivitySavedViews,
  clearCustomChannelActivitySavedViews,
  createCustomChannelActivitySavedView,
  maxCustomChannelActivitySavedViews,
  parseCustomChannelActivitySavedViewsValue,
  readCustomChannelActivitySavedViews,
  sanitizeSavedViewName,
  type ChannelActivitySavedView,
  type ChannelActivityViewAttentionFilter,
  type ChannelActivityViewCategoryFilter,
  type ChannelActivityViewFilter,
} from "../../lib/channel-activity-views.js";
import { deriveChannelRuns } from "../../lib/channel-artifacts.js";
import { truncatePreview } from "../../lib/data.js";
import { formatDateTime, titleFromPrompt } from "../../lib/formatting.js";
import { attachmentCanPreview } from "../../lib/previews.js";
import {
  buildRunRepairHint,
  displayLinkedRunStatus,
  readRunWorkspaceCwd,
  readTaskPrompt,
  readTaskTitle,
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
  canUseProviderForRun,
  isMediaProvider,
  providerPreflightReady,
  providerRunPreflightBlocker,
} from "../../lib/providers.js";
import { CiTriageAuditPanel } from "../external-work/CiTriageAuditPanel.js";
import { TeammateAvatarView } from "../teammates/TeammateAvatarView.js";
import {
  ArtifactRow,
  AvatarInitial,
  MetaRow,
  RunRepairHintBanner,
  StatusBadge,
  TokenizedComposerInput,
  UsedMemorySummary,
  UserProfileAvatar,
  composerWorkspaceFileParts,
  createAttachmentPreviewUrl,
  createLocalComposerAssetId,
  filterUsedMemoryEventsByResponse,
  parseComposerInputParts,
  parseComposerSlashIntent,
  pendingAssetLabel,
  revokeObjectUrl,
  revokePendingAttachmentPreview,
  revokePendingAttachmentPreviews,
  serializeComposerInputParts,
  type ComposerSlashIntent,
  type TokenizedComposerInputHandle,
  type PendingAssetState,
  type PendingAttachmentItem,
} from "../../shared/components/index.js";
import { ConversationAttachmentStrip, ConversationEvidenceBundlePanel, ConversationGuidanceStrip, ConversationStatusStrip, ConversationVirtualFeed, ConversationWorkCell, FileRefChip, MessageBodyRenderer, MessageBubble, MessageFooterActions, MessageRow, RightDrawer, type ConversationGuidanceItem, type ConversationWorkCellDetailsState } from "../../shared/conversation/index.js";
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
  ChannelCreateFormState,
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
  ChannelExecutionProposal,
  UpdateChannelExecutionProposalRequest,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelWorkflowStepContextPacket,
  ChannelWorkflowStepStartMode,
  ChannelWorkspaceBinding,
  ChannelWorkspaceMode,
  ExecutionAction,
  GovernanceNotification,
  WorkflowContextInspectSummary,
  ExternalWorkActionView,
  ExternalWorkCiTriageView,
  MemoryObject,
  ProviderPreset,
  ResourceLease,
  RuntimeDiagnosticsResponse,
  RunArtifact,
  RunIntervention,
  RunSession,
  LingThread,
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
  WorkflowEvidenceDiagnostic,
  WorkItemView,
  WorkUnit,
  WorkspaceSettings,
  UpdateWorkspaceSettingsRequest,
  UserProfile,
} from "../../types.js";
import { ApprovalCard } from "../approvals/ApprovalCard.js";
import { InlineApprovalStrip } from "../approvals/InlineApprovalStrip.js";
import { ChannelWorkBoard } from "../work-board/ChannelWorkBoard.js";
import type { ApprovalResolution } from "../approvals/types.js";
import { approvalProfileText } from "../teammates/helpers.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { ChannelRuntimePolicyFields, ProviderPresetOptions } from "./WorkspaceControls.js";

type ChannelSidePanelView = "files" | "review" | "context" | "settings" | "task" | "approval" | "sources";
type ChannelDrawerRootView = Extract<ChannelSidePanelView, "files" | "review" | "settings">;
type ActivityCategoryFilter = ChannelActivityViewCategoryFilter;
type ActivityAttentionFilter = ChannelActivityViewAttentionFilter;
type ComposerSendState = "idle" | "sending" | "failed";
type ChannelNotificationLevel = "all" | "mentions" | "muted";
type AttentionProgressTone = "success" | "running" | "waiting" | "blocked" | "failed" | "neutral";
type ChannelProposalStepDraft = {
  readonly teammateId: string;
  readonly action: ChannelExecutionProposal["collaborationSteps"][number]["action"];
  readonly summary: string;
  readonly sources?: ChannelExecutionProposal["collaborationSteps"][number]["sources"];
};
type ChannelProposalEditDraft = {
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteriaText: string;
  readonly shapingSummaryText: string;
  readonly shapingOpenQuestionsText: string;
  readonly shapingClarificationsText: string;
  readonly collaborationSteps: readonly ChannelProposalStepDraft[];
};
type RequirementShapingRow = {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly tone?: "neutral" | "attention" | "success";
};
const proposalStepActions: readonly ChannelProposalStepDraft["action"][] = ["coordinated", "consulted", "reviewed", "flagged_risk"];
type ThreadTurnsLoadState =
  | { readonly status: "not_loaded" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly turns: readonly LingTurn[]; readonly runLinks: readonly LingTurnRun[] }
  | { readonly status: "error"; readonly errorMessage: string };

interface AttentionProgressRow {
  readonly id: string;
  readonly icon: ReactNode;
  readonly tone: AttentionProgressTone;
  readonly primary: string;
  readonly secondary?: string;
  readonly onOpen?: () => void;
}

interface SelectedSourceDetailState {
  readonly summary: ConversationContextSourceSummary;
  readonly groupId?: string;
}

interface PendingLinkPreviewItem {
  readonly localId: string;
  readonly url: string;
  readonly state: PendingAssetState;
  readonly preview?: ChannelLinkPreview;
  readonly error?: string;
}

interface ChannelComposerSnapshot {
  readonly messageDraft: string;
  readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly pendingLinkPreviews: readonly PendingLinkPreviewItem[];
  readonly messageMentions: readonly ChannelMention[];
  readonly sendState: ComposerSendState;
  readonly sendError: string;
  readonly activeThreadId: string;
  readonly threadReplyDraft: string;
  readonly threadReplyError: string;
}

interface ActiveMentionPicker {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

interface ActiveSlashCommandPicker {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

const channelSidePanelRootViews: readonly ChannelDrawerRootView[] = ["files", "review", "settings"];
const activityCategoryFilters: readonly ActivityCategoryFilter[] = ["all", "message", "work", "approval", "protocol", "runtime"];
const activityAttentionFilters: readonly Exclude<ActivityAttentionFilter, "all">[] = ["needs_attention", "blocked", "failed", "pending"];
const channelNotificationLevels: readonly ChannelNotificationLevel[] = ["all", "mentions", "muted"];

function channelSidePanelLabel(view: ChannelSidePanelView): string {
  if (view === "files") {
    return "Files";
  }
  if (view === "sources") {
    return "Context sources";
  }
  if (view === "review") {
    return "Review";
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
  if (view === "task") {
    return <SquareTerminal size={size} />;
  }
  if (view === "files") {
    return <FileText size={size} />;
  }
  if (view === "approval") {
    return <ShieldCheck size={size} />;
  }
  if (view === "review") {
    return <CheckCircle2 size={size} />;
  }
  if (view === "sources") {
    return <FileCheck2 size={size} />;
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
  | { readonly id: string; readonly kind: "turn"; readonly turn: ConversationTurnViewModel }
  | { readonly id: string; readonly kind: "activity"; readonly item: ChannelActivityItem }
  | { readonly id: string; readonly kind: "pending-send"; readonly preview: PendingChannelSendPreview; readonly showSentMessage: boolean };

interface PendingChannelSendPreview {
  readonly id: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly requestAiReply: boolean;
  readonly autoReplyMode: Channel["autoReplyMode"];
  readonly createdAt: string;
}

function messageFeedItemRenderSignature(item: MessageFeedItem | undefined): string {
  if (!item) {
    return "";
  }
  if (item.kind === "older-loader") {
    return item.id;
  }
  if (item.kind === "pending-send") {
    return [
      item.id,
      item.showSentMessage ? "with-message" : "status-only",
      item.preview.body,
      item.preview.createdAt,
      item.preview.requestAiReply ? "reply" : "no-reply",
      item.preview.attachmentIds.join(","),
      item.preview.linkPreviewIds.join(","),
      item.preview.fileRefs.map((fileRef) => `${fileRef.path}:${fileRef.source ?? ""}:${fileRef.line ?? ""}`).join(","),
    ].join("|");
  }
  if (item.kind === "turn") {
    return conversationTurnRenderSignature(item.turn);
  }
  return channelActivityItemRenderSignature(item.item);
}

function messageFeedItemCanAnchor(item: MessageFeedItem | undefined): item is Extract<MessageFeedItem, { readonly kind: "activity" | "turn" }> {
  return item?.kind === "activity" || item?.kind === "turn";
}

function messageFeedItemIsPending(item: MessageFeedItem | undefined): boolean {
  if (!item) {
    return false;
  }
  if (item.kind === "activity") {
    return item.item.kind === "message" && item.item.record.status === "pending";
  }
  if (item.kind === "turn") {
    return turnHasPendingMessage(item.turn) || item.turn.operationCell?.mode === "active";
  }
  if (item.kind === "pending-send") {
    return true;
  }
  return false;
}

function turnHasPendingMessage(turn: ConversationTurnViewModel): boolean {
  return turn.sourceMessage.status === "pending" ||
    turn.coordinatorStartMessages.some((message) => message.status === "pending") ||
    turn.coordinatorTerminalMessages.some((message) => message.status === "pending");
}

function conversationTurnRenderSignature(turn: ConversationTurnViewModel): string {
  return [
    turn.id,
    turn.updatedAt,
    turn.sourceMessage.status,
    turn.sourceMessage.updatedAt,
    turn.sourceMessage.body,
    ...turn.coordinatorStartMessages.map((message) => `${message.id}:${message.status}:${message.updatedAt}:${message.body}`),
    turn.operationCell ? `${turn.operationCell.id}:${turn.operationCell.status}:${turn.operationCell.updatedAt}:${turn.operationCell.summary}` : "",
    ...turn.coordinatorTerminalMessages.map((message) => `${message.id}:${message.status}:${message.updatedAt}:${message.body}`),
  ].join("|");
}

function channelActivityItemRenderSignature(item: ChannelActivityItem): string {
  const base = `${item.id}|${item.kind}|${item.createdAt}|${item.attention}`;
  if (item.kind === "message") {
    return [
      base,
      item.record.status,
      item.record.updatedAt,
      item.record.body,
      item.record.attachmentIds.join(","),
      item.record.linkPreviewIds.join(","),
      (item.record.fileRefs ?? []).map((fileRef) => `${fileRef.path}:${fileRef.source ?? ""}:${fileRef.line ?? ""}`).join(","),
    ].join("|");
  }
  if (item.kind === "workflow") {
    return [base, item.record.status, item.record.updatedAt, item.record.title, item.record.objective].join("|");
  }
  if (item.kind === "workflow-step") {
    return [base, item.record.status, item.record.updatedAt, item.record.title, item.record.resultSummary ?? ""].join("|");
  }
  if (item.kind === "task") {
    return [base, item.record.status, item.record.updatedAt, item.record.title].join("|");
  }
  if (item.kind === "run") {
    return [base, item.record.status, item.record.updatedAt, item.record.endedAt ?? "", item.record.errorMessage ?? ""].join("|");
  }
  if (item.kind === "approval") {
    return [base, item.record.status, item.record.resolvedAt ?? "", item.record.decisionReason ?? ""].join("|");
  }
  if (item.kind === "summary") {
    return [base, item.record.updatedAt, item.record.summary].join("|");
  }
  if (item.kind === "state-transition") {
    return [base, item.record.fromStatus, item.record.toStatus, item.record.reason ?? ""].join("|");
  }
  if (item.kind === "decision") {
    return [base, item.record.status, item.record.updatedAt, item.record.title, item.record.decision].join("|");
  }
  return [base, item.record.status, item.record.updatedAt].join("|");
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
  readonly channelForm: ChannelCreateFormState;
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
  readonly onChannelFormChange: (form: ChannelCreateFormState) => void;
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
  const [sidePanelView, setSidePanelView] = useState<ChannelSidePanelView>(() => selectedTaskId ? "task" : "files");
  const [sidePanelOpen, setSidePanelOpen] = useState(() => Boolean(selectedTaskId));
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [conversationWorkCellDetailsByKey, setConversationWorkCellDetailsByKey] = useState<Readonly<Record<string, ConversationWorkCellDetailsState>>>({});
  const [conversationThreadTurnsByKey, setConversationThreadTurnsByKey] = useState<Readonly<Record<string, ThreadTurnsLoadState>>>({});
  const [channelMoreOpen, setChannelMoreOpen] = useState(false);
  const [progressPopoverOpen, setProgressPopoverOpen] = useState(false);
  const [governanceNotificationsOpen, setGovernanceNotificationsOpen] = useState(false);
  const [attentionProgressExpanded, setAttentionProgressExpanded] = useState(true);
  const [selectedSourceDetail, setSelectedSourceDetail] = useState<SelectedSourceDetailState | undefined>();
  const [activityToolsOpen, setActivityToolsOpen] = useState(false);
  const [activitySearch, setActivitySearch] = useState("");
  const [activityCategoryFilter, setActivityCategoryFilter] = useState<ActivityCategoryFilter>("all");
  const [activityAttentionFilter, setActivityAttentionFilter] = useState<ActivityAttentionFilter>("all");
  const [activitySavedViews, setActivitySavedViews] = useState<readonly ChannelActivitySavedView[]>([]);
  const [activeActivityViewId, setActiveActivityViewId] = useState(allChannelActivitySavedViewId);
  const [activityFiltersExpanded, setActivityFiltersExpanded] = useState(false);
  const [attentionQueueExpanded, setAttentionQueueExpanded] = useState(false);
  const [activityDrilldownItemId, setActivityDrilldownItemId] = useState("");
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
  const [messageDraft, setMessageDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachmentItem<ChannelAttachment>[]>([]);
  const [pendingLinkPreviews, setPendingLinkPreviews] = useState<readonly PendingLinkPreviewItem[]>([]);
  const [messageMentions, setMessageMentions] = useState<readonly ChannelMention[]>([]);
  const [mentionPicker, setMentionPicker] = useState<ActiveMentionPicker | undefined>();
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [slashPicker, setSlashPicker] = useState<ActiveSlashCommandPicker | undefined>();
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const [sendState, setSendState] = useState<ComposerSendState>("idle");
  const [sendError, setSendError] = useState("");
  const [runGuidanceInterventions, setRunGuidanceInterventions] = useState<readonly RunIntervention[]>([]);
  const [runGuidanceLoading, setRunGuidanceLoading] = useState(false);
  const [runGuidanceSubmitting, setRunGuidanceSubmitting] = useState<RunIntervention["mode"] | "stop" | "">("");
  const [runGuidanceCancelingId, setRunGuidanceCancelingId] = useState("");
  const [runGuidancePromotingId, setRunGuidancePromotingId] = useState("");
  const [runGuidanceError, setRunGuidanceError] = useState("");
  const [pendingChannelSendPreview, setPendingChannelSendPreview] = useState<PendingChannelSendPreview | undefined>();
  const [activeThreadId, setActiveThreadId] = useState("");
  const [activeWorkThreadId, setActiveWorkThreadId] = useState("");
  const [channelWorkThreads, setChannelWorkThreads] = useState<readonly LingThread[]>([]);
  const [channelWorkThreadsLoading, setChannelWorkThreadsLoading] = useState(false);
  const [channelWorkThreadsFallbackFromRuns, setChannelWorkThreadsFallbackFromRuns] = useState(false);
  const [channelWorkThreadError, setChannelWorkThreadError] = useState("");
  const [forkingWorkThreadId, setForkingWorkThreadId] = useState("");
  const [workThreadVisibilityId, setWorkThreadVisibilityId] = useState("");
  const [archiveConfirmWorkThreadId, setArchiveConfirmWorkThreadId] = useState("");
  const [archivedChannelWorkThreadIds, setArchivedChannelWorkThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [channelWorkThreadSearch, setChannelWorkThreadSearch] = useState("");
  const [threadReplyDraft, setThreadReplyDraft] = useState("");
  const [threadReplyPending, setThreadReplyPending] = useState(false);
  const [threadReplyError, setThreadReplyError] = useState("");
  const [pendingChannelTeammateId, setPendingChannelTeammateId] = useState("");
  const [pendingChannelCouncilId, setPendingChannelCouncilId] = useState("");
  const [channelNotificationLevel, setChannelNotificationLevel] = useState<ChannelNotificationLevel>("mentions");
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
  const [messageFeedLatestButtonVisible, setMessageFeedLatestButtonVisible] = useState(false);
  const composerInputRef = useRef<TokenizedComposerInputHandle | null>(null);
  const messageFeedRef = useRef<HTMLDivElement | null>(null);
  const messageFeedPinnedToLatestRef = useRef(true);
  const messageFeedAutoFollowUntilRef = useRef(0);
  const messageFeedUserScrollIntentRef = useRef(false);
  const messageFeedOlderLoadArmedRef = useRef(true);
  const messageFeedOlderLoadSnapshotRef = useRef<{ readonly anchorId: string; readonly anchorOffset: number } | undefined>();
  const channelMoreRef = useRef<HTMLDivElement | null>(null);
  const governanceNotificationsRef = useRef<HTMLDivElement | null>(null);
  const teammateManagerButtonRef = useRef<HTMLButtonElement | null>(null);
  const teammateManagerPanelRef = useRef<HTMLElement | null>(null);
  const conversationWorkCellEvidenceLoadsRef = useRef(new Set<string>());
  const conversationThreadTurnLoadsRef = useRef(new Set<string>());
  const conversationThreadTurnRunSignaturesRef = useRef(new Map<string, string>());
  const autoPreviewUrlsRef = useRef(new Set<string>());
  const attachmentPreviewUrlsRef = useRef(new Set<string>());
  const previousChannelIdRef = useRef(selectedChannelId);
  const composerSnapshotsRef = useRef<Record<string, ChannelComposerSnapshot>>({});
  const activeRun = activeRunId ? runById.get(activeRunId) : undefined;
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
  const derivedChannelWorkThreads = useMemo(
    () => deriveWorkspaceThreadsFromRuns(channelRuns),
    [channelRuns],
  );
  const channelWorkThreadCandidates = useMemo(
    () => mergeLingThreads(channelWorkThreads, channelWorkThreadsFallbackFromRuns ? derivedChannelWorkThreads : [])
      .filter((thread) => !thread.channelId || thread.channelId === selectedChannelId)
      .filter((thread) => !archivedChannelWorkThreadIds.has(thread.id) && thread.status !== "archived" && !thread.archivedAt)
      .sort((left, right) =>
        Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)) ||
        (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "") ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id)
      ),
    [archivedChannelWorkThreadIds, channelWorkThreads, channelWorkThreadsFallbackFromRuns, derivedChannelWorkThreads, selectedChannelId],
  );
  const visibleChannelWorkThreads = useMemo(
    () => filterChannelBranchThreads(channelWorkThreadCandidates, activeWorkThreadId),
    [activeWorkThreadId, channelWorkThreadCandidates],
  );
  const searchedChannelWorkThreads = useMemo(() => {
    const query = channelWorkThreadSearch.trim().replace(/\s+/g, " ").toLowerCase();
    if (query.length < 2) {
      return visibleChannelWorkThreads;
    }
    return visibleChannelWorkThreads.filter((thread) =>
      [
        thread.title,
        thread.objective,
        thread.id,
        thread.taskId,
        thread.lastRunId,
        thread.parentThreadId,
      ].some((value) => value?.toLowerCase().includes(query))
    );
  }, [channelWorkThreadSearch, visibleChannelWorkThreads]);
  const channelWorkThreadTreeRows = useMemo(
    () => buildChannelWorkThreadTree(searchedChannelWorkThreads),
    [searchedChannelWorkThreads],
  );
  const channelWorkThreadSearchActive = channelWorkThreadSearch.trim().replace(/\s+/g, " ").length >= 2;
  const activeWorkThread = activeWorkThreadId
    ? visibleChannelWorkThreads.find((thread) => thread.id === activeWorkThreadId)
    : undefined;
  const channelDiscussionRootThread = visibleChannelWorkThreads.find((thread) =>
    isChannelDiscussionRootThread(thread, selectedChannelId)
  );
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
  useEffect(() => {
    setActiveWorkThreadId("");
    setChannelWorkThreadSearch("");
  }, [selectedChannelId]);
  useEffect(() => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId) {
      setChannelWorkThreads([]);
      setChannelWorkThreadsFallbackFromRuns(false);
      setChannelWorkThreadError("");
      return;
    }
    let cancelled = false;
    setChannelWorkThreadsLoading(true);
    setChannelWorkThreadError("");
    void listLingThreads(workspaceCwd, { channelId: selectedChannelId, limit: 100 })
      .then((response) => {
        if (!cancelled) {
          setChannelWorkThreads(response.threads);
          const responseThreadIds = new Set(response.threads.map((thread) => thread.id));
          setArchivedChannelWorkThreadIds((current) => new Set([...current].filter((threadId) => !responseThreadIds.has(threadId))));
          setChannelWorkThreadsFallbackFromRuns(false);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          if (caught instanceof LingDaemonError && caught.status === 404) {
            setChannelWorkThreads([]);
            setChannelWorkThreadsFallbackFromRuns(true);
            setChannelWorkThreadError("");
            return;
          }
          setChannelWorkThreadError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setChannelWorkThreadsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, selectedChannelId, runs]);
  useEffect(() => {
    if (activeWorkThreadId && !visibleChannelWorkThreads.some((thread) => thread.id === activeWorkThreadId)) {
      setActiveWorkThreadId("");
    }
  }, [activeWorkThreadId, visibleChannelWorkThreads]);
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
  const visibleRunGuidanceInterventions = useMemo(
    () => runGuidanceInterventions.filter((item) => item.sourceRunId === activeConversationSourceRunId),
    [activeConversationSourceRunId, runGuidanceInterventions],
  );
  const openRunGuidanceInterventions = useMemo(
    () => visibleRunGuidanceInterventions.filter((item) => item.status === "queued" || item.status === "cancelling_source" || item.status === "starting_continuation"),
    [visibleRunGuidanceInterventions],
  );
  const runGuidanceItems = useMemo<readonly ConversationGuidanceItem[]>(
    () =>
      openRunGuidanceInterventions.map((intervention) => {
        const isQueued = intervention.status === "queued";
        const rowBusy = runGuidanceCancelingId === intervention.id || runGuidancePromotingId === intervention.id;
        return {
          id: intervention.id,
          instruction: intervention.messagePayload?.body || intervention.instruction,
          attachments: (intervention.messagePayload?.attachmentIds ?? [])
            .map((attachmentId) => channelAttachmentById.get(attachmentId))
            .filter((attachment): attachment is ChannelAttachment => Boolean(attachment))
            .map((attachment) => ({ id: attachment.id, label: attachment.fileName })),
          linkPreviews: (intervention.messagePayload?.linkPreviewIds ?? [])
            .map((previewId) => channelLinkPreviewById.get(previewId))
            .filter((preview): preview is ChannelLinkPreview => Boolean(preview))
            .map((preview) => ({ id: preview.id, label: preview.title || preview.url })),
          fileRefs: (intervention.messagePayload?.fileRefs ?? []).map((fileRef, index) => ({
            id: `${fileRef.path}:${fileRef.label ?? ""}:${index}`,
            label: fileRef.label ?? fileRef.path,
            status: fileRef.materializationStatus,
          })),
          statusLabel: channelRunInterventionStatusLabel(intervention.status, t),
          meta: channelRunInterventionModeLabel(intervention.mode, t),
          promoteLabel: t("Run this guidance now"),
          promoteDisabled: rowBusy || Boolean(runGuidanceSubmitting) || !activeConversationRun,
          promoteLoading: runGuidancePromotingId === intervention.id,
          onPromote: isQueued && activeConversationRun ? () => void promoteChannelRunGuidance(intervention.id) : undefined,
          deleteLabel: t("Delete queued guidance"),
          deleteDisabled: rowBusy,
          deleteLoading: runGuidanceCancelingId === intervention.id,
          onDelete: isQueued ? () => void cancelChannelRunGuidance(intervention.id) : undefined,
          moreLabel: t("More guidance actions"),
          editLabel: t("Edit message"),
          editDisabled: rowBusy,
          onEdit: isQueued ? () => void editChannelRunGuidance(intervention) : undefined,
          closeQueueLabel: t("Close queue"),
          closeQueueDisabled: rowBusy,
          closeQueueLoading: runGuidanceCancelingId === intervention.id,
          onCloseQueue: isQueued ? () => void cancelChannelRunGuidance(intervention.id) : undefined,
        };
      }),
    [activeConversationRun, channelAttachmentById, channelLinkPreviewById, openRunGuidanceInterventions, runGuidanceCancelingId, runGuidancePromotingId, runGuidanceSubmitting, t],
  );
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
          onClick: () => openApprovalInPanel(selectedApproval),
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
          onClick: () => openSidePanelView("settings"),
        },
      ]}
    />
  ) : null;

  useEffect(() => {
    if (!cwd || !activeConversationSourceRunId) {
      setRunGuidanceInterventions([]);
      setRunGuidanceError("");
      return undefined;
    }
    let cancelled = false;
    setRunGuidanceLoading(true);
    setRunGuidanceError("");
    void listRunInterventions(cwd, activeConversationSourceRunId, 100)
      .then((response) => {
        if (!cancelled) {
          setRunGuidanceInterventions(response.interventions);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRunGuidanceError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunGuidanceLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationSourceRunId, cwd]);

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
  const visibleActivityItems = useMemo(
    () => {
      const baseItems = auditActivityVisible
        ? filteredActivityItems
        : filteredActivityItems.filter((item) =>
          channelActivityVisibleInDefaultChat(item) ||
          (item.kind === "workflow" && workflowProgressByWorkflowId.has(item.record.id)) ||
          (item.kind === "run" && Boolean(item.record.threadId && conversationWorkCellByThreadId.has(item.record.threadId)))
        );
      return activeWorkThreadId
        ? baseItems.filter((item) => item.kind === "run" && item.record.threadId === activeWorkThreadId)
        : baseItems;
    },
    [activeWorkThreadId, auditActivityVisible, conversationWorkCellByThreadId, filteredActivityItems, workflowProgressByWorkflowId],
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
  const conversationFeedBodyItems = useMemo<readonly MessageFeedItem[]>(
    () => {
      const items: Array<MessageFeedItem & { readonly createdAt: string }> = [
        ...(!auditActivityVisible
          ? conversationTurnProjection.turns.map((turn) => ({ id: turn.id, kind: "turn" as const, turn, createdAt: turn.createdAt }))
          : []),
        ...renderableActivityItems.map((item) => ({ id: item.id, kind: "activity" as const, item, createdAt: item.createdAt })),
      ];
      items.sort((left, right) => {
        const timeComparison = left.createdAt.localeCompare(right.createdAt);
        return timeComparison === 0 ? left.id.localeCompare(right.id) : timeComparison;
      });
      return items.map(({ createdAt: _createdAt, ...item }) => item);
    },
    [auditActivityVisible, conversationTurnProjection.turns, renderableActivityItems],
  );
  const messageFeedCanLoadOlder =
    channelMessagesHasOlder && !activityFiltersActive && conversationFeedBodyItems.length > 0;
  const pendingChannelSendState = useMemo(() => {
    if (!pendingChannelSendPreview) {
      return { acknowledged: false, aiReplyStarted: false, awaitingAiReply: false };
    }
    const acknowledgedMessage = [...channelMessages]
      .reverse()
      .find((message) =>
        message.channelId === pendingChannelSendPreview.channelId &&
        message.threadId === pendingChannelSendPreview.threadId &&
        message.kind === "message" &&
        message.authorType === "local-user" &&
        message.body === pendingChannelSendPreview.body &&
        sameStringList(message.attachmentIds, pendingChannelSendPreview.attachmentIds) &&
        sameStringList(message.linkPreviewIds, pendingChannelSendPreview.linkPreviewIds) &&
        sameFileRefList(message.fileRefs ?? [], pendingChannelSendPreview.fileRefs)
      );
    const awaitingAiReply = pendingChannelSendPreview.requestAiReply || pendingChannelSendPreview.autoReplyMode !== "mentions_only";
    const replyThreadId = acknowledgedMessage ? acknowledgedMessage.threadId ?? acknowledgedMessage.id : pendingChannelSendPreview.threadId;
    const previewCreatedAt = Date.parse(pendingChannelSendPreview.createdAt);
    const aiReplyStarted = awaitingAiReply && channelMessages.some((message) => {
      if (message.channelId !== pendingChannelSendPreview.channelId || message.kind !== "ai_reply") {
        return false;
      }
      if (replyThreadId && message.threadId !== replyThreadId) {
        return false;
      }
      const messageCreatedAt = Date.parse(message.createdAt);
      return !Number.isFinite(previewCreatedAt) || !Number.isFinite(messageCreatedAt) || messageCreatedAt >= previewCreatedAt;
    });
    return {
      acknowledged: Boolean(acknowledgedMessage),
      aiReplyStarted,
      awaitingAiReply,
    };
  }, [channelMessages, pendingChannelSendPreview]);
  const pendingChannelSendResolved =
    pendingChannelSendState.acknowledged &&
    (!pendingChannelSendState.awaitingAiReply || pendingChannelSendState.aiReplyStarted);
  const pendingChannelSendVisible = Boolean(
    pendingChannelSendPreview &&
    !pendingChannelSendResolved &&
    pendingChannelSendPreview.channelId === selectedChannelId &&
    pendingChannelSendPreview.threadId === selectedChannelBranchRootThreadId &&
    !activeWorkThreadId,
  );
  const messageFeedItems = useMemo<readonly MessageFeedItem[]>(
    () => [
      ...(messageFeedCanLoadOlder ? [{ id: "older-channel-messages", kind: "older-loader" } satisfies MessageFeedItem] : []),
      ...conversationFeedBodyItems,
      ...(pendingChannelSendVisible && pendingChannelSendPreview
        ? [{
          id: `pending-send:${pendingChannelSendPreview.id}`,
          kind: "pending-send" as const,
          preview: pendingChannelSendPreview,
          showSentMessage: !pendingChannelSendState.acknowledged,
        }]
        : []),
    ],
    [conversationFeedBodyItems, messageFeedCanLoadOlder, pendingChannelSendPreview, pendingChannelSendState.acknowledged, pendingChannelSendVisible],
  );
  const messageFeedEmpty = !channelMessagesLoading && !channelProtocolLoading && conversationFeedBodyItems.length === 0 && !pendingChannelSendVisible;
  const messageFeedVirtualizer = useVirtualizer({
    count: messageFeedItems.length,
    getScrollElement: () => messageFeedRef.current,
    estimateSize: (index) => messageFeedItems[index]?.kind === "older-loader" ? 48 : 128,
    overscan: 10,
    getItemKey: (index) => messageFeedItems[index]?.id ?? index,
  });
  const messageFeedVirtualRows = messageFeedVirtualizer.getVirtualItems();
  const messageFeedTailRenderSignature = useMemo(
    () => messageFeedItemRenderSignature(messageFeedItems.at(-1)),
    [messageFeedItems],
  );
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
      const anchorRow = messageFeedVirtualRows.find((virtualRow) => messageFeedItemCanAnchor(messageFeedItems[virtualRow.index]));
      const anchorItem = anchorRow ? messageFeedItems[anchorRow.index] : undefined;
      if (anchorRow && messageFeedItemCanAnchor(anchorItem)) {
        messageFeedOlderLoadSnapshotRef.current = {
          anchorId: anchorItem.id,
          anchorOffset: anchorRow.start - feed.scrollTop,
        };
      } else {
        const fallbackAnchor = messageFeedItems.find(messageFeedItemCanAnchor);
        if (fallbackAnchor) {
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

  function readCurrentComposerSnapshot(): ChannelComposerSnapshot {
    return {
      messageDraft,
      pendingAttachments,
      pendingLinkPreviews,
      messageMentions,
      sendState,
      sendError,
      activeThreadId,
      threadReplyDraft,
      threadReplyError,
    };
  }

  function emptyComposerSnapshot(): ChannelComposerSnapshot {
    return {
      messageDraft: "",
      pendingAttachments: [],
      pendingLinkPreviews: [],
      messageMentions: [],
      sendState: "idle",
      sendError: "",
      activeThreadId: "",
      threadReplyDraft: "",
      threadReplyError: "",
    };
  }

  function applyComposerSnapshot(snapshot: ChannelComposerSnapshot): void {
    setMessageDraft(snapshot.messageDraft);
    setPendingAttachments(snapshot.pendingAttachments);
    setPendingLinkPreviews(snapshot.pendingLinkPreviews);
    setMessageMentions(snapshot.messageMentions);
    setSendState(snapshot.sendState);
    setSendError(snapshot.sendError);
    setActiveThreadId(snapshot.activeThreadId);
    setThreadReplyDraft(snapshot.threadReplyDraft);
    setThreadReplyError(snapshot.threadReplyError);
    setMentionPicker(undefined);
    setMentionActiveIndex(0);
    autoPreviewUrlsRef.current = new Set(snapshot.pendingLinkPreviews.map((item) => item.url));
  }

  useEffect(() => {
    const selectedChannelActivityViews = workspaceSettings?.channelActivityViews?.[selectedChannelId];
    const selectedChannelNotificationLevel = workspaceSettings?.channelNotifications?.[selectedChannelId];
    const settingsViews = parseCustomChannelActivitySavedViewsValue(selectedChannelActivityViews);
    const legacyViews = readCustomChannelActivitySavedViews(cwd, selectedChannelId);
    const legacyNotificationLevel = readSavedChannelNotificationLevel(cwd, selectedChannelId);
    const workspaceSettingsLoaded = workspaceSettings !== undefined;
    const hasSelectedChannel = selectedChannelId.trim().length > 0;
    const shouldMigrateViews =
      workspaceSettingsLoaded &&
      hasSelectedChannel &&
      selectedChannelActivityViews === undefined &&
      legacyViews.length > 0;
    const shouldMigrateNotification =
      workspaceSettingsLoaded &&
      hasSelectedChannel &&
      !isChannelNotificationLevel(selectedChannelNotificationLevel) &&
      legacyNotificationLevel !== undefined;

    setActivitySavedViews(settingsViews.length > 0 ? settingsViews : shouldMigrateViews || !workspaceSettingsLoaded ? legacyViews : []);
    applyActivityView(builtinChannelActivitySavedViews[0]);
    setActivityFiltersExpanded(false);
    setAttentionQueueExpanded(false);
    setActivityDrilldownItemId("");
    setPendingChannelTeammateId("");
    setChannelNotificationLevel(
      isChannelNotificationLevel(selectedChannelNotificationLevel)
        ? selectedChannelNotificationLevel
        : legacyNotificationLevel ?? "mentions",
    );
    if (shouldMigrateViews || shouldMigrateNotification) {
      onWorkspaceSettingsPatch({
        channelActivityViews: shouldMigrateViews
          ? {
            ...(workspaceSettings.channelActivityViews ?? {}),
            [selectedChannelId]: serializeCustomActivitySavedViews(legacyViews),
          }
          : workspaceSettings.channelActivityViews,
        channelNotifications: shouldMigrateNotification
          ? {
            ...(workspaceSettings.channelNotifications ?? {}),
            [selectedChannelId]: legacyNotificationLevel ?? "mentions",
          }
          : workspaceSettings.channelNotifications,
      });
    } else if (workspaceSettingsLoaded && hasSelectedChannel) {
      if (selectedChannelActivityViews !== undefined) {
        clearCustomChannelActivitySavedViews(cwd, selectedChannelId);
      }
      if (isChannelNotificationLevel(selectedChannelNotificationLevel)) {
        clearSavedChannelNotificationLevel(cwd, selectedChannelId);
      }
    }
    messageFeedPinnedToLatestRef.current = true;
    messageFeedUserScrollIntentRef.current = false;
    messageFeedOlderLoadArmedRef.current = true;
    messageFeedOlderLoadSnapshotRef.current = undefined;
    setMessageFeedLatestButtonVisible(false);
  }, [cwd, selectedChannelId, workspaceSettings, workspaceSettings?.channelActivityViews?.[selectedChannelId], workspaceSettings?.channelNotifications?.[selectedChannelId]]);

  useEffect(() => {
    setChannelWorkspaceExternalPath(
      selectedChannelWorkspace?.mode === "external_path" && selectedChannelWorkspace.executionPath
        ? selectedChannelWorkspace.executionPath
        : "",
    );
    setChannelWorkspaceNotice("");
    setChannelWorkspaceError("");
    setChannelWorkspaceBusyAction("");
  }, [selectedChannelId, selectedChannelWorkspace?.mode, selectedChannelWorkspace?.executionPath]);

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
      messageFeedAutoFollowUntilRef.current = Date.now() + 1_000;
      messageFeedUserScrollIntentRef.current = false;
      if (messageFeedItems.length > 0) {
        messageFeedVirtualizer.scrollToIndex(messageFeedItems.length - 1, { align: "end" });
      }
      feed.scrollTop = feed.scrollHeight;
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
    messageFeedTailRenderSignature,
    messageFeedItems.length,
    renderableActivityItems.length,
    selectedChannelId,
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
    composerSnapshotsRef.current[previousChannelId] = readCurrentComposerSnapshot();
    applyComposerSnapshot(
      selectedChannelId
        ? composerSnapshotsRef.current[selectedChannelId] ?? emptyComposerSnapshot()
        : emptyComposerSnapshot(),
    );
    setActivitySearch("");
    setActivityCategoryFilter("all");
    setActivityAttentionFilter("all");
    setActiveActivityViewId(allChannelActivitySavedViewId);
    setActivityFiltersExpanded(false);
    setAttentionQueueExpanded(false);
    setActivityDrilldownItemId("");
    setPendingChannelTeammateId("");
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setPendingChannelSendPreview(undefined);
    setAttentionProgressExpanded(true);
    setSidePanelView("files");
    setSidePanelOpen(false);
    setProgressPopoverOpen(false);
    setSelectedApprovalId("");
    setCreateTaskOpen(false);
    setChannelNotificationLevel("mentions");
    messageFeedPinnedToLatestRef.current = true;
    messageFeedUserScrollIntentRef.current = false;
    messageFeedOlderLoadArmedRef.current = true;
    messageFeedOlderLoadSnapshotRef.current = undefined;
    setMessageFeedLatestButtonVisible(false);
  }, [selectedChannelId]);

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
    setProgressPopoverOpen(false);
  }, [selectedTask, selectedTaskId]);

  function selectTask(taskId: string): void {
    setCreateTaskOpen(false);
    setSidePanelView("task");
    setSidePanelOpen(true);
    setProgressPopoverOpen(false);
    onSelectTask(taskId);
  }

  function handleMessageFeedScroll(_event: UIEvent<HTMLDivElement>): void {
    const feed = messageFeedRef.current;
    if (!feed) {
      return;
    }
    const maxScrollTop = feed.scrollHeight - feed.clientHeight;
    const pinnedToLatest = maxScrollTop <= 0 || maxScrollTop - feed.scrollTop <= 24;
    const latestItem = messageFeedItems.at(-1);
    const latestItemPending = messageFeedItemIsPending(latestItem);
    const preserveAutoFollow =
      !pinnedToLatest &&
      !messageFeedUserScrollIntentRef.current &&
      messageFeedPinnedToLatestRef.current &&
      (Date.now() < messageFeedAutoFollowUntilRef.current || latestItemPending);
    if (feed.scrollTop > 80) {
      messageFeedOlderLoadArmedRef.current = true;
    }
    if (preserveAutoFollow) {
      messageFeedPinnedToLatestRef.current = true;
      setMessageFeedLatestButtonVisible(false);
      return;
    }
    messageFeedPinnedToLatestRef.current = pinnedToLatest;
    setMessageFeedLatestButtonVisible((visible) => {
      const nextVisible = !pinnedToLatest && maxScrollTop > 0;
      return visible === nextVisible ? visible : nextVisible;
    });
  }

  function cancelMessageFeedAutoFollow(): void {
    messageFeedAutoFollowUntilRef.current = 0;
    messageFeedUserScrollIntentRef.current = true;
  }

  function scrollMessageFeedToLatest(): void {
    const feed = messageFeedRef.current;
    if (!feed) {
      return;
    }
    messageFeedAutoFollowUntilRef.current = Date.now() + 1_000;
    messageFeedUserScrollIntentRef.current = false;
    if (messageFeedItems.length > 0) {
      messageFeedVirtualizer.scrollToIndex(messageFeedItems.length - 1, { align: "end" });
    }
    feed.scrollTop = feed.scrollHeight;
    messageFeedPinnedToLatestRef.current = true;
    setMessageFeedLatestButtonVisible(false);
  }

  function copyMessageText(text: string): void {
    void navigator.clipboard.writeText(text).catch(() => undefined);
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
    setProgressPopoverOpen(false);
    if (mode === "runtime") {
      onRefreshRuntime();
    } else {
      onRefreshChannelProtocol();
    }
  }

  function openReviewFromActivity(): void {
    setActivityToolsOpen(false);
    setChannelMoreOpen(false);
    onSelectTask("");
    setSidePanelView("review");
    setSidePanelOpen(true);
    setProgressPopoverOpen(false);
    setCreateTaskOpen(false);
    onRefreshRunApprovals();
    onRefreshTasks();
    onRefreshChannelFiles();
  }

  function revealConversationThreadFromActivity(threadId: string): void {
    setActivityToolsOpen(false);
    setChannelMoreOpen(false);
    setActivityDrilldownItemId("");
    onSelectTask("");
    setSidePanelOpen(false);
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
    openReviewFromActivity();
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
    openReviewFromActivity();
  }

  function openApprovalInPanel(approval: ApprovalRequest | undefined): void {
    if (!approval) {
      onOpenApprovals();
      return;
    }
    setSelectedApprovalId(approval.id);
    setSidePanelView("approval");
    setSidePanelOpen(true);
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

  async function forkChannelWorkThread(thread: LingThread): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || forkingWorkThreadId) {
      return;
    }
    setForkingWorkThreadId(thread.id);
    setChannelWorkThreadError("");
    try {
      const response = await forkLingThread(workspaceCwd, thread.id, {
        idempotencyKey: `channel-fork:${thread.id}:${thread.lastRunId ?? ""}:${thread.updatedAt}`,
      });
      setChannelWorkThreads((current) => mergeLingThreads([response.childThread, response.sourceThread], current));
      setActiveWorkThreadId(response.childThread.id);
    } catch (error) {
      setChannelWorkThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setForkingWorkThreadId("");
    }
  }

  async function forkChannelMainBranch(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId || forkingWorkThreadId) {
      return;
    }
    const pendingMainThreadId = `channel-main:${selectedChannelId}`;
    setForkingWorkThreadId(pendingMainThreadId);
    setChannelWorkThreadError("");
    try {
      const rootThread = channelDiscussionRootThread ?? (await createLingThread(workspaceCwd, {
        kind: "channel_discussion",
        channelId: selectedChannelId,
        idempotencyKey: pendingMainThreadId,
      })).thread;
      const response = await forkLingThread(workspaceCwd, rootThread.id, {
        idempotencyKey: `channel-fork:${rootThread.id}:${rootThread.updatedAt}`,
      });
      setChannelWorkThreads((current) => mergeLingThreads([response.childThread, response.sourceThread, rootThread], current));
      setActiveWorkThreadId(response.childThread.id);
    } catch (error) {
      setChannelWorkThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setForkingWorkThreadId("");
    }
  }

  async function mutateChannelWorkThreadVisibility(thread: LingThread, action: "archive" | "pin" | "unpin"): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || workThreadVisibilityId) {
      return;
    }
    setWorkThreadVisibilityId(thread.id);
    setChannelWorkThreadError("");
    if (action === "archive") {
      setArchivedChannelWorkThreadIds((current) => new Set(current).add(thread.id));
      setChannelWorkThreads((current) => current.filter((item) => item.id !== thread.id));
      setArchiveConfirmWorkThreadId("");
    }
    try {
      const idempotencyKey = `channel-work-thread-${action}:${thread.id}`;
      const response = action === "archive"
        ? await archiveLingThread(workspaceCwd, thread.id, { idempotencyKey })
        : action === "pin"
          ? await pinLingThread(workspaceCwd, thread.id, { idempotencyKey })
          : await unpinLingThread(workspaceCwd, thread.id, { idempotencyKey });
      setChannelWorkThreads((current) =>
        action === "archive"
          ? current.filter((item) => item.id !== response.thread.id)
          : [response.thread, ...current.filter((item) => item.id !== response.thread.id)]
      );
      if (action === "archive") {
        setArchivedChannelWorkThreadIds((current) => new Set(current).add(response.thread.id));
      }
    } catch (error) {
      if (action === "archive") {
        setArchivedChannelWorkThreadIds((current) => {
          const next = new Set(current);
          next.delete(thread.id);
          return next;
        });
        setChannelWorkThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
      }
      setChannelWorkThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkThreadVisibilityId("");
    }
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
      openApprovalInPanel(pendingChannelApprovals.find((approval) => approval.runId === target.runId));
      return;
    }
    openReviewFromActivity();
  }

  function openActivityTriageResult(result: ChannelActivityTriageResult): void {
    setActivityDrilldownItemId("");
    if (result.kind === "task") {
      revealTaskFromActivity(result.task.id);
      return;
    }
    openReviewFromActivity();
  }

  function openThreadForMessage(message: ChannelMessage): void {
    setActiveThreadId(message.threadId ?? message.id);
    setThreadReplyError("");
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

  function toggleCreateChannelTeammate(teammateId: string): void {
    const selected = new Set(channelForm.selectedTeammateIds);
    if (selected.has(teammateId)) {
      selected.delete(teammateId);
    } else {
      selected.add(teammateId);
    }
    onChannelFormChange({
      ...channelForm,
      selectedTeammateIds: [...selected],
      defaultResponderTeammateId: "",
      defaultTeammateId: "",
    });
  }

  function updateCreateChannelRuntimeForm(nextForm: ChannelFormState): void {
    onChannelFormChange({
      ...nextForm,
      selectedTeammateIds: channelForm.selectedTeammateIds,
      defaultResponderTeammateId: "",
      defaultTeammateId: "",
    });
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
    clearCustomChannelActivitySavedViews(cwd, selectedChannelId);
    onWorkspaceSettingsPatch({
      channelActivityViews: {
        ...(workspaceSettings?.channelActivityViews ?? {}),
        [selectedChannelId]: serializeCustomActivitySavedViews(cappedViews),
      },
    });
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

  function openCreateTaskPanel(): void {
    setCreateTaskOpen(true);
    setSidePanelView("task");
    setSidePanelOpen(true);
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

  const sidePanelLoading = sidePanelView === "sources"
    ? false
    : sidePanelView === "task"
    ? tasksLoading
    : sidePanelView === "context"
      ? inspectorMode === "runtime" ? runtimeLoading : channelProtocolLoading
      : sidePanelView === "files"
        ? channelFilesLoading || channelRunArtifactsLoading
        : sidePanelView === "review"
          ? approvalsLoading || tasksLoading || channelRunArtifactsLoading
        : sidePanelView === "settings"
          ? channelsLoading || channelTeammateMembershipsLoading
          : sidePanelView === "approval"
            ? approvalsLoading
            : channelMessagesLoading || channelProtocolLoading || channelActivityTransitionsLoading || durableWorkItemsLoading || tasksLoading;

  function refreshSidePanel(): void {
    if (sidePanelView === "sources") {
      return;
    }
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
    if (sidePanelView === "files") {
      onRefreshChannelFiles();
      return;
    }
    if (sidePanelView === "review") {
      onRefreshRunApprovals();
      onRefreshTasks();
      onRefreshChannelFiles();
      return;
    }
    if (sidePanelView === "settings") {
      onRefreshChannels();
      onRefreshAiCouncils();
      onRefreshChannelCouncil();
      return;
    }
    onRefreshRunApprovals();
  }

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
  const slashCommandPickerOptions = useMemo(
    () => {
      if (!slashPicker) {
        return [];
      }
      const query = slashPicker.query.trim().toLowerCase();
      return slashCommands
        .filter((option) => {
          if (!query) {
            return true;
          }
          return option.id.toLowerCase().includes(query) || option.label.toLowerCase().includes(query);
        })
        .slice(0, 8);
    },
    [slashCommands, slashPicker],
  );
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
  const availableChannelTeammates = useMemo(
    () => activeLocalTeammates.filter((teammate) => teammate.id !== LING_AGENT_AUTHOR_ID && !teammate.hidden && !channelTeammateIds.has(teammate.id)),
    [activeLocalTeammates, channelTeammateIds],
  );
  const createChannelTeammateOptions = useMemo(
    () => activeLocalTeammates.filter((teammate) => teammate.id !== LING_AGENT_AUTHOR_ID && !teammate.hidden),
    [activeLocalTeammates],
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

  function updateMentionPicker(value: string, caret: number): void {
    const activeMention = findActiveMention(value, caret);
    setMentionPicker(activeMention);
    setMentionActiveIndex(0);
    setSlashPicker(activeMention ? undefined : findActiveSlashCommand(value, caret));
    setSlashActiveIndex(0);
  }

  function focusComposerAt(caret: number): void {
    const focus = (): void => {
      composerInputRef.current?.focusAt(caret);
    };
    focus();
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(focus);
      return;
    }
    globalThis.setTimeout(focus, 0);
  }

  function commitMention(option: ChannelMention): void {
    const composer = composerInputRef.current;
    const liveValue = messageDraft;
    const liveCaret = Math.min(composer?.readSelectionStart() ?? liveValue.length, liveValue.length);
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
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    focusComposerAt(inserted.caret);
  }

  function commitSlashCommand(option: ComposerSlashCommandOption): void {
    const composer = composerInputRef.current;
    const liveValue = messageDraft;
    const liveCaret = Math.min(composer?.readSelectionStart() ?? liveValue.length, liveValue.length);
    const picker = slashPicker ?? findActiveSlashCommand(liveValue, liveCaret) ?? findActiveSlashCommand(liveValue, liveValue.length);
    const inserted = insertSlashCommandToken(liveValue, picker, option.id);
    setMessageDraft(inserted.value);
    setSendState("idle");
    setSendError("");
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    focusComposerAt(inserted.caret);
  }

  function insertMentionTrigger(): void {
    const composer = composerInputRef.current;
    const start = composer?.readSelectionStart() ?? messageDraft.length;
    const end = composer?.readSelectionEnd() ?? start;
    const before = messageDraft.slice(0, start);
    const after = messageDraft.slice(end);
    const insert = before.endsWith("@") ? "" : before.length === 0 || /\s$/.test(before) ? "@" : " @";
    const nextDraft = `${before}${insert}${after}`;
    const nextCursor = before.length + insert.length;
    setMessageDraft(nextDraft);
    updateMentionPicker(nextDraft, nextCursor);
    globalThis.requestAnimationFrame(() => {
      composerInputRef.current?.focusAt(nextCursor);
    });
  }

  function handleComposerTextChange(value: string, caret: number): void {
    setMessageDraft(value);
    setMessageMentions((current) => mergeMentions(
      current.filter((mention) => mentionTokenExistsInText(value, mention)),
      findMentionsInText(value, teammateOptions),
    ));
    setSendState("idle");
    setSendError("");
    updateMentionPicker(value, caret);
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (mentionPicker && mentionPickerOptions.length > 0) {
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
      return;
    }
    if (slashPicker && slashCommandPickerOptions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current + 1) % slashCommandPickerOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current - 1 + slashCommandPickerOptions.length) % slashCommandPickerOptions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        commitSlashCommand(slashCommandPickerOptions[Math.min(slashActiveIndex, slashCommandPickerOptions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashPicker(undefined);
        setSlashActiveIndex(0);
      }
      return;
    }
    if (!mentionPicker && !slashPicker) {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (activeConversationRun) {
          if (composerHasSendableContent) {
            void submitChannelRunGuidanceFromDraft();
          }
          return;
        }
        void sendMessage();
        return;
      }
      if (event.key === "Escape") {
        setMentionPicker(undefined);
        setSlashPicker(undefined);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMentionPicker(undefined);
      setMentionActiveIndex(0);
      setSlashPicker(undefined);
      setSlashActiveIndex(0);
    }
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLDivElement>): void {
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
    const uploadItems = selectedFiles.map((file) => {
      const previewUrl = createAttachmentPreviewUrl(file);
      if (previewUrl) {
        attachmentPreviewUrlsRef.current.add(previewUrl);
      }
      return {
        localId: createLocalComposerAssetId("attachment"),
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
    const localId = createLocalComposerAssetId("link");
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

  function refreshChannelRunGuidanceSurfaces(): void {
    onRefreshChannelActivity();
    onRefreshTasks();
    onRefreshRuntime();
    onRefreshRunApprovals();
  }

  async function refreshChannelRunGuidance(sourceRunId = activeConversationSourceRunId): Promise<void> {
    if (!cwd || !sourceRunId) {
      setRunGuidanceInterventions([]);
      return;
    }
    try {
      const response = await listRunInterventions(cwd, sourceRunId, 100);
      setRunGuidanceInterventions(response.interventions);
    } catch (error) {
      setRunGuidanceError(error instanceof Error ? error.message : String(error));
    }
  }

  async function submitChannelRunGuidanceFromDraft(): Promise<boolean> {
    if (!selectedChannelId || !activeConversationRun || !activeConversationSourceRunId || runGuidanceSubmitting || composerBusy || assetOperationPending) {
      return false;
    }
    const draftSnapshot = messageDraft;
    const messageMentionsSnapshot = messageMentions;
    const pendingAttachmentsSnapshot = pendingAttachments;
    const pendingLinkPreviewsSnapshot = pendingLinkPreviews;
    const serializedInput = serializeComposerInputParts(composerInputParts);
    const body = serializedInput.body.trim();
    const fileRefs = [...composerFileRefs];
    const guidanceFileRefs = fileRefs.map((fileRef) => ({
      path: fileRef.path,
      ...(fileRef.label ? { label: fileRef.label } : {}),
      rootRelation: "unknown" as const,
      kind: "unknown" as const,
      materializationStatus: "not_loaded" as const,
    }));
    const attachmentIds = [...serializedInput.attachmentIds];
    const pendingPreviewRecords = pendingLinkPreviews.flatMap((item) => item.preview ? [item.preview] : []);
    const newPreviews: ChannelLinkPreview[] = [];
    if (!body && attachmentIds.length === 0 && readyLinkPreviewIds.length === 0 && fileRefs.length === 0) {
      return false;
    }
    setRunGuidanceSubmitting("queue_followup");
    setRunGuidanceError("");
    setComposerBusy(true);
    try {
      for (const url of extractUrls(body)) {
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
              { localId: createLocalComposerAssetId("link"), url, state: "failed", error: message },
            ]);
          }
        }
      }
      const linkPreviews = [...pendingPreviewRecords, ...newPreviews];
      const messagePayload = {
        body,
        attachmentIds,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        fileRefs: guidanceFileRefs,
      };
      const instruction = summarizeChannelGuidancePayload(messagePayload, t);
      const response = await createRunIntervention(cwd, activeConversationSourceRunId, {
        mode: "queue_followup",
        instruction,
        messagePayload,
        idempotencyKey: `web-channel:${activeConversationRun.id}:queue_followup:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      });
      setRunGuidanceInterventions((current) => [...current.filter((item) => item.id !== response.intervention.id), response.intervention]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
      setMessageDraft("");
      setMessageMentions([]);
      setPendingAttachments([]);
      setPendingLinkPreviews([]);
      autoPreviewUrlsRef.current.clear();
      setMentionPicker(undefined);
      setMentionActiveIndex(0);
      setSendState("idle");
      setSendError("");
      revokePendingAttachmentPreviews(pendingAttachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      refreshChannelRunGuidanceSurfaces();
      window.setTimeout(() => {
        void refreshChannelRunGuidance(activeConversationSourceRunId);
        refreshChannelRunGuidanceSurfaces();
      }, 250);
      return true;
    } catch (error) {
      setMessageDraft(draftSnapshot);
      setMessageMentions(messageMentionsSnapshot);
      setPendingAttachments(pendingAttachmentsSnapshot);
      setPendingLinkPreviews(pendingLinkPreviewsSnapshot);
      setRunGuidanceError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setComposerBusy(false);
      setRunGuidanceSubmitting("");
    }
  }

  async function cancelChannelRunGuidance(interventionId: string): Promise<void> {
    if (runGuidanceCancelingId) {
      return;
    }
    setRunGuidanceCancelingId(interventionId);
    setRunGuidanceError("");
    try {
      const response = await cancelRunIntervention(cwd, interventionId);
      setRunGuidanceInterventions((current) => current.map((item) => item.id === response.intervention.id ? response.intervention : item));
      refreshChannelRunGuidanceSurfaces();
    } catch (error) {
      setRunGuidanceError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunGuidanceCancelingId("");
    }
  }

  async function promoteChannelRunGuidance(interventionId: string): Promise<void> {
    if (runGuidancePromotingId) {
      return;
    }
    setRunGuidancePromotingId(interventionId);
    setRunGuidanceError("");
    try {
      const response = await promoteRunIntervention(cwd, interventionId);
      setRunGuidanceInterventions((current) => current.map((item) => item.id === response.intervention.id ? response.intervention : item));
      refreshChannelRunGuidanceSurfaces();
      window.setTimeout(() => {
        void refreshChannelRunGuidance(activeConversationSourceRunId);
        refreshChannelRunGuidanceSurfaces();
      }, 800);
    } catch (error) {
      setRunGuidanceError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunGuidancePromotingId("");
    }
  }

  async function editChannelRunGuidance(intervention: RunIntervention): Promise<void> {
    const payload = intervention.messagePayload;
    const body = payload?.body ?? intervention.instruction;
    setMessageDraft(body);
    setPendingAttachments((payload?.attachmentIds ?? [])
      .map((attachmentId) => channelAttachmentById.get(attachmentId))
      .filter((attachment): attachment is ChannelAttachment => Boolean(attachment))
      .map((attachment) => ({
        localId: createLocalComposerAssetId("attachment"),
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
        state: "ready" as const,
        attachment,
      })));
    setPendingLinkPreviews((payload?.linkPreviewIds ?? [])
      .map((previewId) => channelLinkPreviewById.get(previewId))
      .filter((preview): preview is ChannelLinkPreview => Boolean(preview))
      .map((preview) => ({
        localId: createLocalComposerAssetId("link"),
        url: preview.url,
        state: preview.status === "ready" ? "ready" as const : preview.status === "blocked" ? "blocked" as const : "failed" as const,
        preview,
        error: preview.errorMessage,
      })));
    setSendState("idle");
    setSendError("");
    await cancelChannelRunGuidance(intervention.id);
    focusComposerAt(body.length);
  }

  async function sendMessage(): Promise<void> {
    if (!selectedChannelId || composerBusy || assetOperationPending || !composerHasSendableContent) {
      return;
    }
    const draftSnapshot = messageDraft;
    const messageMentionsSnapshot = messageMentions;
    const pendingAttachmentsSnapshot = pendingAttachments;
    const pendingLinkPreviewsSnapshot = pendingLinkPreviews;
    const serializedInput = serializeComposerInputParts(composerInputParts);
    const body = serializedInput.body.trim();
    const slashIntent = parseComposerSlashIntent(body, {
      teammateMentions: teammateOptions.map((teammate) => ({ id: teammate.id, label: teammate.label })),
      commands: slashCommands,
    });
    const fileRefs = [...composerFileRefs];
    const pastedUrls = extractUrls(body);
    const newPreviews: ChannelLinkPreview[] = [];
    const attachmentIds = [...serializedInput.attachmentIds];
    const pendingPreviewRecords = pendingLinkPreviews.flatMap((item) => item.preview ? [item.preview] : []);
    const mentions = mergeMentions(messageMentions, findMentionsInText(body, teammateOptions));
    const shouldRequestAi = mentions.some((mention) => mention.kind === "ai-teammate");
    let pendingSendPreviewId = "";
    messageFeedPinnedToLatestRef.current = true;
    messageFeedAutoFollowUntilRef.current = Date.now() + 3_000;
    messageFeedUserScrollIntentRef.current = false;
    setMessageFeedLatestButtonVisible(false);
    setComposerBusy(true);
    setSendState("sending");
    setSendError("");
    try {
      if (slashIntent.kind === "agent_command" || slashIntent.kind === "multi_agent_command" || slashIntent.kind === "global_command") {
        const prompt = slashIntent.args.trim() || t("Run /{command} using the current channel context.", { command: slashIntent.commandId });
        const title = titleFromPrompt(prompt || slashIntent.commandLabel);
        const slashTaskTargets = slashIntent.kind === "multi_agent_command"
          ? slashIntent.teammates.map((teammate) => ({ id: teammate.id, label: teammate.label }))
          : slashIntent.kind === "agent_command"
            ? [{ id: slashIntent.teammateId, label: slashIntent.teammateLabel }]
            : [undefined];
        for (const target of slashTaskTargets) {
          await onCreateTaskFromSlashCommand({
            title,
            prompt,
            requestedSkillId: slashIntent.commandId,
            attachmentIds,
            ...(target ? { assigneeTeammateId: target.id } : {}),
          });
        }
        setMessageDraft("");
        setMessageMentions([]);
        revokePendingAttachmentPreviews(pendingAttachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
        setPendingAttachments([]);
        setPendingLinkPreviews([]);
        autoPreviewUrlsRef.current.clear();
        setSendState("idle");
        setSendError("");
        return;
      }
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
              { localId: createLocalComposerAssetId("link"), url, state: "failed", error: message },
            ]);
          }
        }
      }
      const linkPreviews = [...pendingPreviewRecords, ...newPreviews];
      const pendingSendPreview = {
        id: createLocalComposerAssetId("message"),
        channelId: selectedChannelId,
        threadId: selectedChannelBranchRootThreadId,
        body,
        mentions,
        attachmentIds,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        fileRefs,
        requestAiReply: shouldRequestAi,
        autoReplyMode: selectedChannel?.autoReplyMode ?? "mentions_only",
        createdAt: new Date().toISOString(),
      } satisfies PendingChannelSendPreview;
      pendingSendPreviewId = pendingSendPreview.id;
      setPendingChannelSendPreview(pendingSendPreview);
      setMessageDraft("");
      setMessageMentions([]);
      setPendingAttachments([]);
      setPendingLinkPreviews([]);
      autoPreviewUrlsRef.current.clear();
      await onSendMessage({
        threadId: selectedChannelBranchRootThreadId,
        body,
        mentions,
        attachmentIds,
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        fileRefs,
        requestAiReply: shouldRequestAi,
      });
      revokePendingAttachmentPreviews(pendingAttachmentsSnapshot, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      setPendingChannelSendPreview((current) => current?.id === pendingSendPreviewId ? undefined : current);
      setSendState("idle");
      setSendError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (pendingSendPreviewId) {
        setPendingChannelSendPreview((current) => current?.id === pendingSendPreviewId ? undefined : current);
        setMessageDraft(draftSnapshot);
        setMessageMentions(messageMentionsSnapshot);
        setPendingAttachments(pendingAttachmentsSnapshot);
        setPendingLinkPreviews(pendingLinkPreviewsSnapshot);
      }
      setSendState("failed");
      setSendError(message);
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
        fileRefs: [],
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
      revokePendingAttachmentPreview(removed, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      return current.filter((item) => item.localId !== localId);
    });
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
  const composerInputParts = parseComposerInputParts(messageDraft, {
    cwd,
    attachments: readyAttachmentIds.map((attachmentId) => ({ attachmentId })),
    teammateMentions: teammateOptions.map((teammate) => ({ id: teammate.id, label: teammate.label })),
    slashCommands,
    linkPreviews: pendingLinkPreviews.map((item) => ({
      url: item.url,
      normalizedUrl: item.preview?.normalizedUrl,
      title: item.preview?.title,
      state: item.state,
      error: item.error ?? item.preview?.errorMessage,
    })),
  });
  const composerFileReferenceParts = composerWorkspaceFileParts(composerInputParts);
  const composerFileRefs = composerFileReferenceParts.map((part): ChannelMessageFileRef => ({
    path: part.path,
    label: part.path,
    source: "composer",
    ...(part.line !== undefined ? { line: part.line } : {}),
  }));
  const composerSlashIntent = activeConversationRun
    ? { kind: "none" as const }
    : parseComposerSlashIntent(messageDraft.trim(), {
      teammateMentions: teammateOptions.map((teammate) => ({ id: teammate.id, label: teammate.label })),
      commands: slashCommands,
    });
  const composerSlashCommandActive = composerSlashIntent.kind !== "none";
  const composerSlashTargetLabel = composerSlashCommandActive ? composerSlashCommandTargetLabel(composerSlashIntent, t) : "";
  const composerHasSendableContent = messageDraft.trim().length > 0 || readyAttachmentIds.length > 0 || readyLinkPreviewIds.length > 0 || composerFileRefs.length > 0;
  const assetOperationPending = pendingAttachments.some((item) => item.state === "uploading") || pendingLinkPreviews.some((item) => item.state === "uploading");
  const pendingMessageAssetsVisible = pendingAttachments.length > 0;
  const channelComposerSubmitDisabled = activeConversationRun
    ? !selectedChannelId || isCancellingRun || Boolean(runGuidanceSubmitting) || (composerHasSendableContent && (composerBusy || assetOperationPending))
    : !selectedChannelId || composerBusy || assetOperationPending || !composerHasSendableContent;
  const channelComposerSubmitLabel = activeConversationRun
    ? composerHasSendableContent
      ? runGuidanceSubmitting === "queue_followup" ? t("Queueing guidance...") : t("Queue guidance")
      : isCancellingRun ? t("Stopping run...") : t("Stop run")
    : composerSlashCommandActive
      ? sendState === "sending" ? t("Creating task...") : t("Create task")
      : sendState === "sending" ? t("Sending...") : t("Send");
  const localUserDisplayName = userProfile?.displayName.trim() || t("You");

  function renderChannelMessageAvatar(message: ChannelMessage): ReactNode {
    if (message.authorType === "ai-teammate") {
      const teammate = allLocalTeammateById.get(message.authorId ?? "");
      return teammate
        ? <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
        : message.authorId === LING_AGENT_AUTHOR_ID
          ? <AvatarInitial label="L" tone="violet" />
          : <AvatarInitial label="A" tone="teal" />;
    }
    if (message.authorType === "system") {
      return <AvatarInitial label="S" tone="violet" />;
    }
    return <UserProfileAvatar profile={userProfile} fallbackLabel={localUserDisplayName} />;
  }

  function renderConversationAgentAvatar(span: ConversationAgentActivitySpan): ReactNode {
    const participantId = span.participantId?.trim();
    const teammate = (participantId ? allLocalTeammateById.get(participantId) : undefined) ??
      allLocalTeammateByName.get(span.label.trim().toLowerCase());
    return teammate ? <TeammateAvatarView teammate={teammate} cwd={cwd} compact /> : undefined;
  }

  function renderConversationTurnItem(turn: ConversationTurnViewModel): ReactNode {
    const operationCell = turn.operationCell;
    const operationRef = turn.operationRef;
    let detailsState: ConversationWorkCellDetailsState = { status: "not_loaded" };
    let onLoadDetails: ((id: string) => void) | undefined;
    if (operationCell && operationRef?.kind === "workflow") {
      detailsState = conversationWorkCellDetailsByKey[workflowWorkCellDetailsCacheKey(operationRef.workflowId)] ?? { status: "not_loaded" };
      onLoadDetails = loadWorkflowWorkCellDetails;
    } else if (operationCell && operationRef?.kind === "run_thread") {
      detailsState = conversationWorkCellDetailsByKey[conversationWorkCellDetailsCacheKey(operationRef.threadId)] ?? { status: "not_loaded" };
      onLoadDetails = loadConversationWorkCellDetails;
    }

    return (
      <div className="conversation-turn" data-conversation-turn-id={turn.id}>
        {renderMessageFeedActivityItem(channelMessageToActivityItem(turn.sourceMessage))}
        {renderConversationTurnAssistantTranscript(turn, detailsState, onLoadDetails)}
      </div>
    );
  }

  function renderConversationTurnAssistantTranscript(
    turn: ConversationTurnViewModel,
    detailsState: ConversationWorkCellDetailsState,
    onLoadDetails: ((id: string) => void) | undefined,
  ): ReactNode {
    if (turn.blocks.length === 0) {
      return null;
    }

    const anchorMessage = turn.blocks.find((block) => block.kind === "coordinator_text")?.message;
    const authorName = anchorMessage
      ? messageAuthorLabel(anchorMessage, teammateOptions, t("Deleted teammate"), localUserDisplayName, allLocalTeammateById)
      : t("Ling Agent");
    const createdAt = anchorMessage?.createdAt ?? turn.createdAt;
    const copyText = conversationTurnAssistantCopyText(turn);

    return (
      <MessageRow
        className="channel-message-row conversation-turn-assistant-row"
        authorType="ai-teammate"
        avatar={anchorMessage ? renderChannelMessageAvatar(anchorMessage) : <AvatarInitial label="L" tone="violet" />}
        authorName={authorName}
        createdAtLabel={formatDateTime(createdAt)}
        statusNode={<small className="conversation-message-tag">AI</small>}
        bodyNode={(
          <div className="conversation-turn-assistant-transcript">
            {turn.blocks.map((block) => renderConversationTranscriptBlock(turn, block, detailsState, onLoadDetails))}
          </div>
        )}
        actionsNode={(
          <div className="channel-message-row-footer-stack">
            <MessageFooterActions
              className="channel-message-row-actions"
              actions={[
                {
                  id: "copy",
                  label: t("Copy message"),
                  icon: <Copy size={11} />,
                  onClick: () => copyMessageText(copyText),
                },
                {
                  id: "reply",
                  label: t("Reply in topic"),
                  icon: <Reply size={11} />,
                  className: "message-reply-button message-meta-action",
                  onClick: () => openThreadForMessage(turn.sourceMessage),
                },
              ]}
            />
          </div>
        )}
      />
    );
  }

  function renderConversationTranscriptBlock(
    turn: ConversationTurnViewModel,
    block: ConversationTranscriptBlock,
    detailsState: ConversationWorkCellDetailsState,
    onLoadDetails: ((id: string) => void) | undefined,
  ): ReactNode {
    if (block.kind === "coordinator_text") {
      const body = conversationCoordinatorDisplayBody(turn, block.message, block.phase, t).trim();
      if (!body) {
        return null;
      }
      return (
        <div className={block.phase === "terminal" ? "conversation-turn-assistant-copy terminal" : "conversation-turn-assistant-copy"} key={block.id}>
          <MessageBodyRenderer text={body} cwd={cwd} compact />
          {block.memoryCitationEvents.length > 0 ? (
            <UsedMemorySummary
              variant="footer"
              events={block.memoryCitationEvents}
              memoryById={memoryById}
            />
          ) : null}
        </div>
      );
    }

    return (
      <div className="conversation-turn-operation" key={block.id}>
        <ConversationWorkCell
          model={block.operationCell}
          cwd={cwd}
          detailsState={detailsState}
          onOpenRun={block.operationCell.anchorRunId.startsWith("workflow:") ? undefined : openRunInPanel}
          onLoadDetails={onLoadDetails}
          renderAgentAvatar={renderConversationAgentAvatar}
        />
      </div>
    );
  }

  function conversationTurnAssistantCopyText(turn: ConversationTurnViewModel): string {
    return turn.blocks
      .flatMap((block) => {
        if (block.kind === "coordinator_text") {
          const body = conversationCoordinatorDisplayBody(turn, block.message, block.phase, t).trim();
          return body ? [body] : [];
        }
        return [block.operationCell.title];
      })
      .join("\n\n")
      .trim();
  }

  function channelMessageToActivityItem(message: ChannelMessage): ChannelActivityItem {
    return {
      id: `message:${message.id}`,
      kind: "message",
      createdAt: message.createdAt,
      record: message,
      category: "message",
      attention: message.status === "blocked" ? "blocked" : message.status === "failed" ? "failed" : message.status === "pending" ? "pending" : "none",
      searchText: message.body.toLowerCase(),
    };
  }

  function renderMessageFeedActivityItem(item: ChannelActivityItem): ReactNode {
    if (item.kind === "message") {
      const message = item.record;
      const plainChatMessage = message.kind === "message" || message.kind === "ai_reply";
      const pendingAiReply = message.kind === "ai_reply" && message.status === "pending";
      const pendingAiReplyBody = pendingAiReply && !message.body.trim() ? t("Thinking...") : message.body;
      const executionProposals = (executionProposalsByMessageId.get(message.id) ?? [])
        .filter((proposal) => auditActivityVisible || !proposalShouldHideInDefaultFeed(proposal, channelWorkflows));
      const messageUsedMemoryEvents = filterUsedMemoryEventsByResponse(usedMemoryEvents, message.id);
      const usedMemorySummary = messageUsedMemoryEvents.length > 0 ? (
        <UsedMemorySummary compact events={messageUsedMemoryEvents} memoryById={memoryById} />
      ) : undefined;
      const messageFileRefs = message.fileRefs ?? [];
      const nonChatAction = message.linkedTaskId
        ? activityActionRow(item.id, <code>{message.linkedTaskId}</code>)
        : activityActionRow(item.id);
      if (plainChatMessage) {
        return (
          <div className="message-group">
            <MessageRow
              className={message.status === "blocked" ? "channel-message-row blocked" : "channel-message-row"}
              authorType={message.authorType}
              avatar={renderChannelMessageAvatar(message)}
              authorName={messageAuthorLabel(message, teammateOptions, t("Deleted teammate"), localUserDisplayName, allLocalTeammateById)}
              createdAtLabel={formatDateTime(message.createdAt)}
              statusNode={message.kind === "ai_reply" ? <small className="conversation-message-tag">AI</small> : null}
              bodyNode={(
                <div className={pendingAiReply ? "message-body-shell message-body-with-spinner" : "message-body-shell"}>
                  {pendingAiReply ? <Loader2 className="message-pending-spinner spin" size={13} /> : null}
                  <MessageBodyRenderer text={pendingAiReplyBody} cwd={cwd} compact />
                </div>
              )}
              attachmentsNode={renderChannelMessageAssets(message.attachmentIds, messageFileRefs, message.channelId)}
              evidenceNode={messageUsedMemoryEvents.length > 0 ? (
                <ConversationEvidenceBundlePanel
                  label={t("Message evidence")}
                  bundle={{
                    summary: t("Used memory"),
                    sections: [
                      {
                        id: "memory",
                        label: t("Memory"),
                        summary: t("Used memory"),
                        content: usedMemorySummary,
                      },
                    ],
                  }}
                />
              ) : null}
              actionsNode={(
                <div className="channel-message-row-footer-stack">
                  <MessageFooterActions
                    className="channel-message-row-actions"
                    actions={[
                      {
                        id: "copy",
                        label: t("Copy message"),
                        icon: <Copy size={11} />,
                        onClick: () => copyMessageText(message.body),
                      },
                      {
                        id: "reply",
                        label: t("Reply in topic"),
                        icon: <Reply size={11} />,
                        className: "message-reply-button message-meta-action",
                        onClick: () => openThreadForMessage(message),
                      },
                    ]}
                  />
                </div>
              )}
            />
            {executionProposals.map((proposal) => (
              <ChannelExecutionProposalCard
                key={proposal.id}
                proposal={proposal}
                assigneeLabel={teammateLabel(proposal.assigneeTeammateId, teammateOptions, t("Deleted teammate"))}
                teammates={teammateOptions}
                linkedRun={proposal.linkedRunId ? runById.get(proposal.linkedRunId) : undefined}
                linkedWorkflow={proposal.linkedWorkflowId ? channelWorkflows.find((workflow) => workflow.id === proposal.linkedWorkflowId) : undefined}
                activeRunId={activeRunId}
                latestStatus={latestStatus}
                onConfirm={() => onConfirmExecutionProposal(proposal)}
                onCancel={() => onCancelExecutionProposal(proposal)}
                onUpdate={onUpdateExecutionProposal}
                onOpenRun={openRunInPanel}
              />
            ))}
          </div>
        );
      }
      return (
        <div className="message-group">
          <MessageBubble
            tone={message.status === "blocked" ? "chat-blocked" : plainChatMessage ? "chat" : "system"}
            side={plainChatMessage && message.authorType === "local-user" ? "end" : "start"}
            avatar={renderChannelMessageAvatar(message)}
            author={messageAuthorLabel(message, teammateOptions, t("Deleted teammate"), localUserDisplayName, allLocalTeammateById)}
            tag={message.kind === "task_link" ? "Task" : undefined}
            time={formatDateTime(message.createdAt)}
            body={pendingAiReplyBody}
            pending={pendingAiReply}
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
              assigneeLabel={teammateLabel(proposal.assigneeTeammateId, teammateOptions, t("Deleted teammate"))}
              teammates={teammateOptions}
              linkedRun={proposal.linkedRunId ? runById.get(proposal.linkedRunId) : undefined}
              linkedWorkflow={proposal.linkedWorkflowId ? channelWorkflows.find((workflow) => workflow.id === proposal.linkedWorkflowId) : undefined}
              activeRunId={activeRunId}
              latestStatus={latestStatus}
              onConfirm={() => onConfirmExecutionProposal(proposal)}
              onCancel={() => onCancelExecutionProposal(proposal)}
              onUpdate={onUpdateExecutionProposal}
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
              <button className="secondary-button compact-button" type="button" onClick={openReviewFromActivity}>
                <CheckCircle2 size={14} />
                {t("Review source")}
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
              <button className="secondary-button compact-button" type="button" onClick={openReviewFromActivity}>
                <CheckCircle2 size={14} />
                {t("Review source")}
              </button>
            </>)
          }
        />
      );
    }
    if (item.kind === "workflow") {
      const workflow = item.record;
      const steps = channelWorkflowSteps.filter((step) => step.workflowId === workflow.id);
      const progressModel = workflowProgressByWorkflowId.get(workflow.id);
      if (progressModel && !auditActivityVisible) {
        const workCell = conversationWorkCellByWorkflowId.get(workflow.id);
        if (!workCell) {
          return null;
        }
        const detailsKey = workflowWorkCellDetailsCacheKey(workflow.id);
        return (
          <ConversationWorkCell
            model={workCell}
            cwd={cwd}
            detailsState={conversationWorkCellDetailsByKey[detailsKey] ?? { status: "not_loaded" }}
            onOpenRun={workCell.anchorRunId.startsWith("workflow:") ? undefined : openRunInPanel}
            onLoadDetails={loadWorkflowWorkCellDetails}
            renderAgentAvatar={renderConversationAgentAvatar}
          />
        );
      }
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
              {workflow.status === "succeeded" ? (
                <WorkflowFinalSummary
                  workflow={workflow}
                  steps={steps}
                  artifactsByRun={channelArtifactsByRun}
                />
              ) : null}
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => onOrchestrateWorkflow(workflow)}
                disabled={orchestratingWorkflowId === workflow.id || !workflowCanAdvance(workflow.status)}
              >
                {orchestratingWorkflowId === workflow.id ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                {t("Advance")}
              </button>
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => onCancelWorkflow(workflow)}
                disabled={orchestratingWorkflowId === workflow.id || !workflowCanCancel(workflow.status)}
              >
                <Square size={14} />
                {t("Cancel")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={openReviewFromActivity}>
                <CheckCircle2 size={14} />
                {t("Review source")}
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
                <button className="secondary-button compact-button" type="button" onClick={() => onRetryWorkflowStep(step)} disabled={runningWorkflowStepId === step.id || step.status !== "blocked"}>
                  {runningWorkflowStepId === step.id ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  {t("Retry")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={openReviewFromActivity}>
                  <CheckCircle2 size={14} />
                  {t("Review source")}
                </button>
              </>)
            ) : step.taskId ? (
              activityActionRow(item.id, <>
                <span>{t("Task linked")}</span>
                <button className="secondary-button compact-button" type="button" onClick={openReviewFromActivity}>
                  <CheckCircle2 size={14} />
                  {t("Review source")}
                </button>
              </>)
            ) : (
              activityActionRow(item.id, (
                <button className="secondary-button compact-button" type="button" onClick={openReviewFromActivity}>
                  <CheckCircle2 size={14} />
                  {t("Review source")}
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
              <button className="secondary-button compact-button" type="button" onClick={() => revealTaskFromActivity(task.id)}>
                <SquareTerminal size={14} />
                {t("Show in transcript")}
              </button>
            ))
          }
        />
      );
    }
    if (item.kind === "run") {
      const run = item.record;
      const workCell = run.threadId ? conversationWorkCellByThreadId.get(run.threadId) : undefined;
      if (workCell) {
        if (workCell.anchorRunId !== run.id) {
          return null;
        }
        return (
          <ConversationWorkCell
            model={workCell}
            cwd={cwd}
            detailsState={conversationWorkCellDetailsByKey[conversationWorkCellDetailsCacheKey(workCell.threadId)] ?? { status: "not_loaded" }}
            onOpenRun={openRunInPanel}
            onLoadDetails={loadConversationWorkCellDetails}
            renderAgentAvatar={renderConversationAgentAvatar}
          />
        );
      }
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
              <button className="secondary-button compact-button" type="button" onClick={() => revealRunFromActivity(run.id)}>
                <History size={14} />
                {t("Show in transcript")}
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
                    revealTaskFromActivity(transition.entityId);
                  } else if (transition.entityType === "run") {
                    revealRunFromActivity(transition.entityId);
                  } else if (transition.entityType === "approval") {
                    openApprovalInPanel(approvals.find((approval) => approval.id === transition.entityId));
                  } else {
                    openReviewFromActivity();
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
            <button className="secondary-button compact-button" type="button" onClick={openReviewFromActivity}>
              <CheckCircle2 size={14} />
              {t("Review source")}
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
    if (feedItem.kind === "pending-send") {
      return renderPendingChannelSendPreview(feedItem.preview, feedItem.showSentMessage);
    }
    if (feedItem.kind === "turn") {
      return renderConversationTurnItem(feedItem.turn);
    }
    return renderMessageFeedActivityItem(feedItem.item);
  }

  function renderPendingChannelSendPreview(preview: PendingChannelSendPreview, showSentMessage: boolean): ReactNode {
    return (
      <div className="message-group channel-pending-send-group">
        {showSentMessage ? (
          <MessageRow
            className="channel-message-row pending-send"
            authorType="local-user"
            avatar={<UserProfileAvatar profile={userProfile} fallbackLabel={localUserDisplayName} />}
            authorName={localUserDisplayName}
            createdAtLabel={formatDateTime(preview.createdAt)}
            bodyNode={(
              <div className="message-body-shell">
                <MessageBodyRenderer text={preview.body} cwd={cwd} compact />
              </div>
            )}
            attachmentsNode={renderChannelMessageAssets(preview.attachmentIds, preview.fileRefs, preview.channelId)}
          />
        ) : null}
        <div className="channel-send-thinking-row" role="status" aria-live="polite">
          <Loader2 className="message-pending-spinner spin" size={13} />
          <span>{t("Thinking...")}</span>
        </div>
      </div>
    );
  }

  function renderChannelMessageAssets(
    attachmentIds: readonly string[],
    fileRefs: readonly ChannelMessageFileRef[] = [],
    channelId: string = selectedChannelId,
  ): ReactNode {
    const attachments = attachmentIds
      .map((id) => channelAttachmentById.get(id))
      .filter((attachment): attachment is ChannelAttachment => Boolean(attachment));
    if (attachments.length === 0 && fileRefs.length === 0) {
      return null;
    }
    return (
      <>
        <ConversationAttachmentStrip
          attachments={attachments.map((attachment) => ({
            id: attachment.id,
            label: attachment.fileName,
            meta: formatBytes(attachment.sizeBytes),
            href: attachmentContentUrl(attachment),
            target: "_blank",
            rel: "noreferrer",
            icon: attachment.kind === "image" ? <ImageIcon size={13} /> : <FileText size={13} />,
            previewRequest: attachmentCanPreview(attachment) ? {
              source: "attachment",
              cwd,
              attachmentId: attachment.id,
              scope: "channel",
              channelId,
            } : undefined,
          }))}
        />
        {fileRefs.length > 0 ? (
          <div className="conversation-attachment-strip channel-file-ref-strip" aria-label={t("Workspace file references")}>
            {fileRefs.map((fileRef, index) => (
              <FileRefChip
                key={`${fileRef.path}:${fileRef.line ?? ""}:${index}`}
                icon={<FileText size={13} />}
                label={fileRef.label ?? fileRef.path}
                meta={fileRef.line !== undefined ? `:${fileRef.line}` : undefined}
              />
            ))}
          </div>
        ) : null}
      </>
    );
  }

  const channelComposer = (
    <section className="composer-panel channel-composer" aria-label={t("Channel composer")}>
      {channelActiveStatusStrip}
      {activeConversationRun || openRunGuidanceInterventions.length > 0 ? (
        <>
          <ConversationGuidanceStrip
            title={activeConversationRun ? t("Run guidance") : t("Queued guidance")}
            description={activeConversationRun ? t("Type guidance in the message box and press Enter to queue it.") : t("Guidance is queued.")}
            submitting={runGuidanceSubmitting}
            items={runGuidanceItems}
          />
          {runGuidanceError ? (
            <div className="inline-error compact-inline-error">
              <CircleAlert size={14} />
              {runGuidanceError}
            </div>
          ) : null}
          {runGuidanceLoading ? (
            <div className="composer-status-row" aria-live="polite">
              <Loader2 className="spin" size={13} />
              <span>{t("Loading guidance...")}</span>
            </div>
          ) : null}
        </>
      ) : null}
      <InlineApprovalStrip
        approvals={inlineApprovalViews}
        resolvingApprovals={resolvingApprovals}
        onResolve={onResolveApproval}
        onOpenApproval={(approvalId) => openApprovalInPanel(approvals.find((approval) => approval.id === approvalId))}
      />
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
          </div>
        ) : null}
        <TokenizedComposerInput
          ref={composerInputRef}
          value={messageDraft}
          parts={composerInputParts}
          onChange={handleComposerTextChange}
          onKeyDown={handleComposerKeyDown}
          onPaste={handleComposerPaste}
          onSelect={updateMentionPicker}
          placeholder={t("Message this channel or @ an AI teammate")}
          ariaLabel={t("Message this channel or @ an AI teammate")}
          executableSlashCommandId={composerSlashCommandActive ? composerSlashIntent.commandId : undefined}
          executableSlashTargetLabel={composerSlashTargetLabel}
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
        {!mentionPicker && slashPicker ? (
          <div className="mention-picker-popover command-picker-popover" role="listbox" aria-label={t("Slash command")}>
            {slashCommandPickerOptions.length > 0 ? slashCommandPickerOptions.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={index === Math.min(slashActiveIndex, slashCommandPickerOptions.length - 1)}
                className={index === Math.min(slashActiveIndex, slashCommandPickerOptions.length - 1) ? "mention-suggestion command active" : "mention-suggestion command"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commitSlashCommand(option)}
              >
                <span>/{option.id}</span>
                <small>{option.label}</small>
              </button>
            )) : (
              <span className="mention-suggestion empty">{t("No matching commands")}</span>
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
        <button
          className="primary-button composer-send-button"
          type="button"
          onClick={() => {
            if (activeConversationRun) {
              if (composerHasSendableContent) {
                void submitChannelRunGuidanceFromDraft();
                return;
              }
              onCancelActiveRun(activeConversationRun);
              return;
            }
            void sendMessage();
          }}
          disabled={channelComposerSubmitDisabled}
          aria-label={channelComposerSubmitLabel}
          title={channelComposerSubmitLabel}
        >
          {activeConversationRun
            ? composerHasSendableContent
              ? runGuidanceSubmitting === "queue_followup" ? <Loader2 className="spin" size={15} /> : <Send size={15} />
              : isCancellingRun ? <Loader2 className="spin" size={15} /> : <Square size={15} />
            : sendState === "sending" ? <Loader2 className="spin" size={15} /> : composerSlashCommandActive ? <ListChecks size={15} /> : <Send size={15} />}
        </button>
      </div>
      {sendState === "failed" ? (
        <div className="composer-status-list" aria-live="polite">
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
            }}>
              {t("Dismiss")}
            </button>
          </div>
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
              : t("{count} teammates collaborate in this channel. Manage add and remove teammates here.", { count: channelTeammates.length })}
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
          {channelTeammates.map(({ teammate }) => {
            const saving = channelTeammateSavingId === teammate.id;
            return (
              <article key={teammate.id} className="channel-teammate-chip" role="listitem">
                <div
                  className="channel-teammate-chip-main"
                >
                  <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
                  <strong>{teammate.displayName}</strong>
                </div>
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

  const channelCouncilPanel = (
    <section className="channel-settings-card channel-council-panel" aria-label={t("Channel AI councils")}>
      <div className="channel-settings-section-head">
        <span>
          <UsersRound size={15} />
          <strong>{t("AI Councils")}</strong>
        </span>
        <small>
          {channelCouncilLoading || aiCouncilsLoading
            ? t("Loading councils...")
            : t("{count} council(s) attached", { count: attachedAiCouncils.length })}
        </small>
      </div>
      {attachedAiCouncils.length === 0 ? (
        <div className="client-empty-state channel-teammate-empty channel-council-empty">
          <UsersRound size={18} />
          <span>{aiCouncils.length === 0 ? t("No AI councils available") : t("No AI councils attached")}</span>
        </div>
      ) : (
        <div className="channel-council-list" role="list">
          {attachedAiCouncils.map((council) => {
            const preferred = channelCouncilPolicy?.preferredCouncilId === council.id;
            const memberCount = channelEffectiveCouncil?.councils
              .find((item) => item.council.id === council.id)
              ?.members.filter((item) => item.enabled && item.teammate && !isLingAgentTeammate(item.teammate)).length ?? 0;
            const capacityLabel = aiCouncilCapacityLabel(council, t);
            const healthLabels = aiCouncilHealthLabels(aiCouncilHealthReport, council.id, t);
            return (
              <article key={council.id} className={preferred ? "channel-council-card preferred" : "channel-council-card"} role="listitem">
                <div className="channel-council-card-main">
                  <span className="channel-council-icon" aria-hidden="true">
                    <UsersRound size={16} />
                  </span>
                  <span>
                    <strong>{council.displayName}</strong>
                    <small>{t("{count} projected specialist(s)", { count: memberCount })}</small>
                  </span>
                </div>
                <div className="context-packet muted" aria-label={t("Council boundaries")}>
                  <span>{aiCouncilRoutingModeLabel(council.routingPolicy.defaultMode, t)}</span>
                  {capacityLabel ? <span>{capacityLabel}</span> : null}
                  {aiCouncilBoundaryLabels(council, t).map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
                {healthLabels.length > 0 ? (
                  <div className="context-packet muted" aria-label={t("Council health")}>
                    {healthLabels.map((label) => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                ) : null}
                <div className="channel-council-actions">
                  <button className="secondary-button compact-button" type="button" onClick={() => setPreferredChannelCouncil(council.id)} disabled={preferred || channelCouncilSaving}>
                    {preferred ? <Check size={13} /> : <Pin size={13} />}
                    {preferred ? t("Preferred") : t("Prefer")}
                  </button>
                  <button className="icon-button compact-icon-button" type="button" aria-label={t("Detach council")} title={t("Detach council")} onClick={() => removeChannelCouncil(council.id)} disabled={channelCouncilSaving}>
                    {channelCouncilSaving ? <Loader2 className="spin" size={13} /> : <X size={13} />}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="channel-teammate-add-row channel-council-add-row">
        <label className="channel-teammate-select">
          <select
            aria-label={t("Attach AI council")}
            value={pendingChannelCouncilId}
            disabled={!selectedChannelId || availableAiCouncils.length === 0 || channelCouncilSaving}
            onChange={(event) => setPendingChannelCouncilId(event.target.value)}
          >
            <option value="">{availableAiCouncils.length > 0 ? t("Select AI council") : t("No councils available")}</option>
            {availableAiCouncils.map((council) => (
              <option key={council.id} value={council.id}>{council.displayName}</option>
            ))}
          </select>
        </label>
        <button className="primary-button compact-button" type="button" onClick={addSelectedChannelCouncil} disabled={!pendingChannelCouncilId || channelCouncilSaving}>
          {channelCouncilSaving ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
          {t("Attach")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => {
          onRefreshAiCouncils();
          onRefreshChannelCouncil();
        }} disabled={aiCouncilsLoading || channelCouncilLoading}>
          {aiCouncilsLoading || channelCouncilLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {t("Refresh")}
        </button>
      </div>
      {projectedCouncilSpecialists.length > 0 ? (
        <div className="channel-council-projection" aria-label={t("Projected council specialists")}>
          <strong>{t("Projected specialists")}</strong>
          <div className="channel-council-specialist-list" role="list">
            {projectedCouncilSpecialists.map((specialist) => {
              const councilSource = specialist.sources.find((source) => source.kind === "council");
              const sourceDetails = [councilSource?.councilDisplayName ?? t("AI council"), councilSource?.label ?? councilSource?.slotKey].filter(Boolean).join(" · ");
              return (
                <article key={specialist.teammateId} className="channel-council-specialist" role="listitem">
                  <TeammateAvatarView teammate={specialist.teammate} cwd={cwd} compact />
                  <span>
                    <strong>{specialist.teammate.displayName}</strong>
                    <small>{sourceDetails}</small>
                  </span>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
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
  const workflowAttentionProgressRows: readonly AttentionProgressRow[] = buildWorkflowAttentionProgressRows({
    items: buildCollaborationProgressProjection({
      cards: [...collaborationTaskCardByWorkflowId.values()],
      t,
      limit: 6,
      scope: "active",
    }),
  });
  const attentionProgressRowCandidates: readonly (AttentionProgressRow | undefined)[] = [
    ...workflowAttentionProgressRows,
    selectedTask && taskIsActiveProgressPopoverTask(selectedTask) ? {
      id: "current-task",
      icon: <SquareTerminal size={18} />,
      tone: selectedTask.status === "blocked" ? "blocked" : selectedTask.status === "failed" ? "failed" : selectedTask.status === "done" ? "success" : selectedTask.status === "running" ? "running" : "neutral",
      primary: selectedTask.title,
      secondary: `${t("Current task")} · ${t(selectedTask.status)}`,
      onOpen: () => selectTask(selectedTask.id),
    } : undefined,
    latestRun && runIsActiveProgressPopoverRun(latestRun) ? {
      id: "latest-run",
      icon: runProgressIcon(latestRun.status),
      tone: runProgressTone(latestRun.status),
      primary: `${t("Latest run")} · ${t(latestRun.status)}`,
      secondary: readRunTitle(latestRun),
      onOpen: () => openRunInPanel(latestRun.id),
    } : undefined,
    pendingApprovalCount > 0 ? {
      id: "pending-approval",
      icon: <ShieldCheck size={18} />,
      tone: "waiting",
      primary: t("Approval needed"),
      secondary: t("{count} pending approvals", { count: pendingApprovalCount }),
      onOpen: () => openApprovalInPanel(selectedApproval),
    } : undefined,
  ];
  const attentionProgressRows: readonly AttentionProgressRow[] = attentionProgressRowCandidates.filter((row): row is AttentionProgressRow => row !== undefined);
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
  const activeProgressSourceSummary = useMemo(
    () => buildActiveProgressSourceSummary({
      contextSummaries: channelContextSummaries,
      workflowSteps: channelWorkflowSteps,
      selectedTask,
      runningWorkflowStepId,
      t,
    }),
    [channelContextSummaries, channelWorkflowSteps, runningWorkflowStepId, selectedTask, t],
  );
  const channelHasProgressContent = attentionProgressRows.length > 0;

  function openSidePanelView(view: ChannelSidePanelView): void {
    setSidePanelView(view);
    setSidePanelOpen(true);
    setProgressPopoverOpen(false);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
    if (view === "files") {
      onRefreshChannelFiles();
    } else if (view === "review") {
      onRefreshRunApprovals();
      onRefreshTasks();
      onRefreshChannelFiles();
    } else if (view === "context") {
      onRefreshChannelProtocol();
    } else if (view === "settings") {
      onRefreshChannels();
      onRefreshAiCouncils();
      onRefreshChannelCouncil();
    } else if (view === "sources") {
      return;
    } else {
      onRefreshTasks();
      onRefreshChannelActivity();
      onRefreshWorkItems();
    }
  }

  function openSourceGroupInPanel(group: ConversationContextSourceGroup, summary: ConversationContextSourceSummary): void {
    setSelectedSourceDetail({ summary, groupId: group.id });
    setSidePanelView("sources");
    setSidePanelOpen(true);
    setProgressPopoverOpen(false);
    setChannelMoreOpen(false);
    setActivityToolsOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
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
        {selectedChannelWorkspace ? (
          <section className="channel-workspace-control field wide" aria-label={t("Channel workspace")}>
            <div className="channel-workspace-control-head">
              <span>
                {channelWorkspaceModeIcon(selectedChannelWorkspace.mode, 15)}
                <strong>{t("Workspace")}</strong>
              </span>
              <StatusBadge status={selectedChannelWorkspace.status === "ready" ? "done" : selectedChannelWorkspace.status === "missing" ? "blocked" : "todo"} />
            </div>
            <div className="channel-workspace-summary">
              <strong>{t(channelWorkspaceModeLabel(selectedChannelWorkspace.mode))}</strong>
              <small title={selectedChannelExecutionPath}>{shortWorkspacePath(selectedChannelExecutionPath, cwd)}</small>
              {selectedChannelWorkspace.errorMessage ? <small className="danger-text">{selectedChannelWorkspace.errorMessage}</small> : null}
            </div>
            <div className="channel-workspace-actions">
              <button className="secondary-button compact-button" type="button" onClick={onCreateManagedChannelWorktree} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}>
                {channelWorkspaceBusyAction === "create-worktree" ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />}
                {t("Create worktree")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={onRefreshChannelWorkspace} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}>
                {channelWorkspaceBusyAction === "refresh" ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                {t("Refresh status")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={onOpenChannelWorkspacePath} disabled={!selectedChannelExecutionPath}>
                <FolderOpen size={14} />
                {t("Open path")}
              </button>
            </div>
            <div className="channel-workspace-actions">
              <button className="secondary-button compact-button" type="button" onClick={() => onHandoffChannelWorkspace("local")} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || selectedChannelWorkspace.mode === "local"}>
                {channelWorkspaceBusyAction === "handoff-local" ? <Loader2 className="spin" size={14} /> : <Command size={14} />}
                {t("Hand off to Local")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => onHandoffChannelWorkspace("managed_worktree")} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || !selectedChannelWorkspace.worktreePath}>
                {channelWorkspaceBusyAction === "handoff-managed_worktree" ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />}
                {t("Hand off to Worktree")}
              </button>
            </div>
            <div className="channel-workspace-external-row">
              <input
                value={channelWorkspaceExternalPath}
                onChange={(event) => setChannelWorkspaceExternalPath(event.target.value)}
                placeholder={t("External workspace path")}
                disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction)}
              />
              <button className="secondary-button compact-button" type="button" onClick={() => onHandoffChannelWorkspace("external_path")} disabled={!selectedChannelId || Boolean(channelWorkspaceBusyAction) || !channelWorkspaceExternalPath.trim()}>
                {channelWorkspaceBusyAction === "handoff-external_path" ? <Loader2 className="spin" size={14} /> : <FolderOpen size={14} />}
                {t("Hand off to External")}
              </button>
            </div>
            {channelWorkspaceNotice ? <div className="inline-success compact">{channelWorkspaceNotice}</div> : null}
            {channelWorkspaceError ? (
              <div className="inline-error compact">
                <CircleAlert size={14} />
                {channelWorkspaceError}
              </div>
            ) : null}
          </section>
        ) : null}
        <label className="field wide">
          <span>{t("AI response language")}</span>
          <select
            value={channelEditForm.responseLanguage}
            onChange={(event) => onChannelEditFormChange({ ...channelEditForm, responseLanguage: event.target.value as ChannelFormState["responseLanguage"] })}
            disabled={!selectedChannelId}
          >
            <option value="workspace">{t("Workspace default")}</option>
            <option value="follow_user">{t("Follow user message")}</option>
            <option value="zh-CN">{t("Chinese")}</option>
            <option value="en-US">{t("English")}</option>
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

  const sidePanelTitle = createTaskOpen && sidePanelView === "task"
      ? t("New task")
      : t(channelSidePanelLabel(sidePanelView));
  const sidePanelContent = sidePanelView === "files" ? (
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
  ) : sidePanelView === "review" ? (
    <ChannelReviewPanel
      approvals={approvals}
      runs={channelRunsForFiles}
      tasks={tasks}
      artifactsByRun={channelArtifactsByRun}
      executionActionError={channelExecutionActionError}
      loading={approvalsLoading || tasksLoading || channelRunArtifactsLoading}
      onOpenApproval={openApprovalInPanel}
    />
  ) : sidePanelView === "context" ? (
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
  ) : sidePanelView === "sources" ? (
    <ChannelSourceDetailPanel
      detail={selectedSourceDetail}
      messages={channelMessages}
      decisions={channelDecisions}
    />
  ) : sidePanelView === "settings" ? (
    <div className="channel-settings-stack">
      {channelNotificationPanel}
      {channelCouncilPanel}
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
  const progressPopoverVisible = progressPopoverOpen && !teammateManagerOpen && !sidePanelOpen && channelHasProgressContent;

  return (
    <div className="client-window task-workbench-window" aria-label={t("Workspace")}>
      <header className="channel-header task-workbench-header">
        <div className="channel-title-area">
          <div className="channel-title-line">
            <span className="channel-title-icon" aria-hidden="true">#</span>
            <h1>{selectedChannel?.name ?? "Engineering"}</h1>
            {selectedChannelWorkspace ? (
              <button
                className={`channel-workspace-badge ${selectedChannelWorkspace.mode} ${selectedChannelWorkspace.status}`}
                type="button"
                onClick={() => openSidePanelView("settings")}
                title={selectedChannelExecutionPath}
              >
                {channelWorkspaceModeIcon(selectedChannelWorkspace.mode, 13)}
                <span>{t(channelWorkspaceModeLabel(selectedChannelWorkspace.mode))}</span>
                <small>{shortWorkspacePath(selectedChannelExecutionPath, cwd)}</small>
              </button>
            ) : null}
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
	                    <span>{t("Filter channel events")}</span>
	                  </button>
	                </div>
	              ) : null}
	            </div>
	          </div>
        </div>
        <div className="channel-header-actions" aria-label={t("Workspace task toolbar")}>
          {governanceNotificationCount > 0 || channelGovernanceNotificationsLoading ? (
            <div className="channel-governance-wrap" ref={governanceNotificationsRef}>
              <button
                className={governanceNotificationsOpen ? "channel-governance-button active" : "channel-governance-button"}
                type="button"
                aria-expanded={governanceNotificationsOpen}
                title={t("Review queue")}
                onClick={() => {
                  if (governanceNotificationCount === 0 && !channelGovernanceNotificationsLoading) {
                    return;
                  }
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
                disabled={governanceNotificationCount === 0 && channelGovernanceNotificationsLoading}
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
                setProgressPopoverOpen(false);
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
            className={progressPopoverVisible ? "icon-button active task-toolbar-progress" : "icon-button task-toolbar-progress"}
            type="button"
            aria-label={t("Progress")}
            title={t("Progress")}
            onClick={() => {
              if (!channelHasProgressContent) {
                setProgressPopoverOpen(false);
                return;
              }
              setSidePanelOpen(false);
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
            className={sidePanelOpen ? "icon-button active task-toolbar-panel" : "icon-button task-toolbar-panel"}
            type="button"
            aria-expanded={sidePanelOpen}
            aria-label={sidePanelOpen ? t("Hide details") : t("Show details")}
            title={sidePanelOpen ? t("Hide details") : t("Show details")}
            onClick={() => {
              if (sidePanelOpen) {
                setSidePanelOpen(false);
                setCreateTaskOpen(false);
                setProgressPopoverOpen(false);
                return;
              }
              if (sidePanelView === "context") {
                setSidePanelView("files");
              }
              setSidePanelOpen(true);
              setProgressPopoverOpen(false);
              setActivityToolsOpen(false);
            }}
          >
            {sidePanelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        </div>
        {progressPopoverVisible ? (
          <div className="channel-progress-popover">
            <ProgressPopover
              expanded={attentionProgressExpanded}
              onExpandedChange={setAttentionProgressExpanded}
              progressRows={attentionProgressRows}
              sourceSummary={activeProgressSourceSummary}
              onOpenSourceGroup={openSourceGroupInPanel}
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
        <div className="channel-create-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            onChannelCreateOpenChange(false);
          }
        }}>
          <section className="channel-create-dialog" role="dialog" aria-modal="true" aria-label={t("New channel")}>
            <div className="channel-create-head">
              <span>
                <Plus size={16} />
                <strong>{t("New channel")}</strong>
              </span>
              <button className="icon-button" type="button" onClick={() => onChannelCreateOpenChange(false)} aria-label={t("Cancel")} title={t("Cancel")}>
                <X size={14} />
              </button>
            </div>
            <div className="channel-options-grid channel-create-grid">
              <label className="field wide">
                <span>{t("Run provider")}</span>
                <select value={channelForm.defaultProviderPresetId} onChange={(event) => onChannelFormChange({ ...channelForm, defaultProviderPresetId: event.target.value })} disabled={providersLoading || providers.length === 0}>
                  <option value="">{t("Select provider preset")}</option>
                  <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
                </select>
              </label>
              <label className="field wide">
                <span>{t("Name")}</span>
                <input value={channelForm.name} onChange={(event) => onChannelFormChange({ ...channelForm, name: event.target.value })} autoFocus />
              </label>
              <section className="channel-create-teammates field wide" aria-label={t("AI teammates")}>
                <span>{t("AI teammates")}</span>
                {createChannelTeammateOptions.length === 0 ? (
                  <div className="client-empty-state compact-empty">
                    <UserPlus size={16} />
                    <span>{t("Create a workspace teammate before assigning channel members.")}</span>
                  </div>
                ) : (
                  <div className="channel-create-teammate-grid">
                    {createChannelTeammateOptions.map((teammate) => {
                      const selected = channelForm.selectedTeammateIds.includes(teammate.id);
                      return (
                        <button
                          key={teammate.id}
                          className={selected ? "channel-create-teammate selected" : "channel-create-teammate"}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => toggleCreateChannelTeammate(teammate.id)}
                        >
                          <TeammateAvatarView teammate={teammate} cwd={cwd} compact />
                          <span>
                            <strong>{teammate.displayName}</strong>
                            <small>{selected ? t("Joined channel") : t("Not joined")}</small>
                          </span>
                          {selected ? <Check size={14} /> : <Plus size={14} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
              <label className="field wide">
                <span>{t("AI response language")}</span>
                <select
                  value={channelForm.responseLanguage}
                  onChange={(event) => onChannelFormChange({ ...channelForm, responseLanguage: event.target.value as ChannelFormState["responseLanguage"] })}
                >
                  <option value="workspace">{t("Workspace default")}</option>
                  <option value="follow_user">{t("Follow user message")}</option>
                  <option value="zh-CN">{t("Chinese")}</option>
                  <option value="en-US">{t("English")}</option>
                </select>
              </label>
              <ChannelRuntimePolicyFields form={channelForm} onChange={updateCreateChannelRuntimeForm} />
              <div className="channel-option-actions">
                <button className="primary-button compact-button" type="button" onClick={onCreateChannel} disabled={channelsLoading}>
                  {channelsLoading ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                  {channelsLoading ? t("Creating isolated workspace...") : t("Create channel")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={() => onChannelCreateOpenChange(false)}>
                  {t("Cancel")}
                </button>
              </div>
            </div>
          </section>
        </div>
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
          progressPopoverVisible ? "progress-open" : "",
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
                      <ChannelWorkBoard
                        channel={selectedChannel}
                        tasks={tasks}
                        runs={runs}
                        approvals={approvals}
                        workflowSteps={channelWorkflowSteps}
                        externalActionDetails={externalActionDetails}
                        externalWorkCiTriage={externalWorkCiTriage}
                        artifactsByRun={channelArtifactsByRun}
                        durableWorkItems={durableWorkItems}
                        loading={tasksLoading || approvalsLoading || channelActivityTransitionsLoading || durableWorkItemsLoading}
                        onOpenTask={openTaskFromActivity}
                        onOpenRun={openRunInPanel}
                        onOpenApproval={(approvalId) => openApprovalInPanel(approvals.find((approval) => approval.id === approvalId))}
                        onClaimWorkItem={onClaimWorkItem}
                        onHeartbeatWorkItem={onHeartbeatWorkItem}
                        onReleaseWorkItem={onReleaseWorkItem}
                        onCompleteWorkItem={onCompleteWorkItem}
                        onFailWorkItem={onFailWorkItem}
                        busyWorkItemId={busyWorkItemId}
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
	                  {selectedChannelId && channelWorkThreadTreeVisible ? (
	                    <div className="channel-work-thread-tree" aria-label={t("Channel branches")}>
                      <div className="channel-work-thread-tree-head">
                        <span>
                          <GitBranch size={14} />
                          {t("Conversation branches")}
                        </span>
                        {channelWorkThreadsLoading ? (
                          <small><Loader2 className="spin" size={12} /> {t("Loading")}</small>
                        ) : null}
                      </div>
                      {visibleChannelWorkThreads.length > 0 || channelWorkThreadSearchActive ? (
                        <label className="activity-search-field channel-work-thread-search-field">
                          <Search size={14} />
                          <input
                            type="search"
                            value={channelWorkThreadSearch}
                            onChange={(event) => setChannelWorkThreadSearch(event.target.value)}
                            placeholder={t("Search branches")}
                            aria-label={t("Search branches")}
                          />
                        </label>
                      ) : null}
                      {channelWorkThreadError ? (
                        <div className="inline-error compact">
                          <CircleAlert size={14} />
                          {channelWorkThreadError}
                        </div>
                      ) : null}
                      <div className="channel-work-thread-row-list">
                        {!channelDiscussionRootThread && !channelWorkThreadSearchActive ? (
                          <div className={!activeWorkThreadId ? "channel-work-thread-row-shell selected" : "channel-work-thread-row-shell"}>
                            <button
                              className="channel-work-thread-row"
                              type="button"
                              onClick={() => setActiveWorkThreadId("")}
                            >
                              <span className="sidebar-hash" aria-hidden="true">#</span>
                              <span className="channel-work-thread-row-main">
                                <strong>{t("Main branch")}</strong>
                                <small>{t("Default channel branch")}</small>
                              </span>
                            </button>
                            <button
                              className="icon-button"
                              type="button"
                              aria-label={t("Fork branch")}
                              title={t("Fork branch")}
                              disabled={forkingWorkThreadId === `channel-main:${selectedChannelId}`}
                              onClick={() => void forkChannelMainBranch()}
                            >
                              {forkingWorkThreadId === `channel-main:${selectedChannelId}` ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />}
                            </button>
                          </div>
                        ) : null}
                        {visibleChannelWorkThreads.length > 0 || channelWorkThreadSearchActive ? (
                          <button
                            className={!activeWorkThreadId ? "channel-work-thread-row selected" : "channel-work-thread-row"}
                            type="button"
                            onClick={() => setActiveWorkThreadId("")}
                          >
                            <span className="sidebar-hash" aria-hidden="true">#</span>
                            <span className="channel-work-thread-row-main">
                              <strong>{t("All branches")}</strong>
                              <small>{t("{count} branches", { count: visibleChannelWorkThreads.length })}</small>
                            </span>
                          </button>
                        ) : null}
                        {channelWorkThreadTreeRows.map(({ thread, depth, parentHidden }) => (
                          <div
                            key={thread.id}
                            className={activeWorkThreadId === thread.id ? "channel-work-thread-row-shell selected" : "channel-work-thread-row-shell"}
                            style={{ paddingLeft: `${8 + depth * 18}px` }}
                          >
                            <button
                              className="channel-work-thread-row"
                              type="button"
                              onClick={() => setActiveWorkThreadId(thread.id)}
                            >
                              <span className={`status-dot ${thread.status}`} />
                              <span className="channel-work-thread-row-main">
                                <strong>{thread.title}</strong>
                                <small>
                                  {thread.parentThreadId ? `${t("Fork branch")} · ` : ""}
                                  {parentHidden ? `${t("Parent hidden")} · ` : ""}
                                  {thread.pinnedAt ? `${t("Pinned")} · ` : ""}
                                  {thread.archivedAt || thread.status === "archived" ? `${t("Archived")} · ` : ""}
                                  {thread.lastRunId ?? thread.id}
                                </small>
                              </span>
                            </button>
                            <button
                              className="icon-button"
                              type="button"
                              aria-label={thread.pinnedAt ? t("Unpin") : t("Pin")}
                              title={thread.pinnedAt ? t("Unpin") : t("Pin")}
                              disabled={workThreadVisibilityId === thread.id}
                              onClick={() => void mutateChannelWorkThreadVisibility(thread, thread.pinnedAt ? "unpin" : "pin")}
                            >
                              {workThreadVisibilityId === thread.id ? <Loader2 className="spin" size={14} /> : thread.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
                            </button>
                            <button
                              className="icon-button"
                              type="button"
                              aria-label={t("Fork branch")}
                              title={t("Fork branch")}
                              disabled={forkingWorkThreadId === thread.id || thread.status === "archived" || Boolean(thread.archivedAt)}
                              onClick={() => void forkChannelWorkThread(thread)}
                            >
                              {forkingWorkThreadId === thread.id ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />}
                            </button>
                            {archiveConfirmWorkThreadId === thread.id ? (
                              <>
                                <button
                                  className="secondary-button compact-button danger"
                                  type="button"
                                  disabled={workThreadVisibilityId === thread.id}
                                  onClick={() => void mutateChannelWorkThreadVisibility(thread, "archive")}
                                >
                                  {workThreadVisibilityId === thread.id ? <Loader2 className="spin" size={14} /> : <Archive size={14} />}
                                  {t("Confirm")}
                                </button>
                                <button
                                  className="secondary-button compact-button"
                                  type="button"
                                  disabled={workThreadVisibilityId === thread.id}
                                  onClick={() => setArchiveConfirmWorkThreadId("")}
                                >
                                  {t("Cancel")}
                                </button>
                              </>
                            ) : (
                              <button
                                className="icon-button"
                                type="button"
                                aria-label={t("Archive")}
                                title={t("Archive")}
                                disabled={workThreadVisibilityId === thread.id || thread.status === "archived" || Boolean(thread.archivedAt)}
                                onClick={() => setArchiveConfirmWorkThreadId(thread.id)}
                              >
                                <Archive size={14} />
                              </button>
                            )}
                          </div>
                        ))}
                        {channelWorkThreadSearchActive && channelWorkThreadTreeRows.length === 0 ? (
                          <div className="empty-state compact-empty">
                            <Search />
                            <span>{t("No active branches match")}</span>
                          </div>
                        ) : null}
	                      </div>
                    </div>
                  ) : null}
                  <ConversationVirtualFeed
                    scrollRef={messageFeedRef}
                    ariaLabel={t("Channel message feed")}
                    loading={channelMessagesLoading || channelProtocolLoading}
                    empty={messageFeedEmpty}
                    loadingLabel={t("Loading messages...")}
                    emptyIcon={activeWorkThreadId ? <GitBranch /> : activityFiltersActive ? <Search /> : <MessageSquare />}
                    emptyLabel={
                      activeWorkThreadId
                        ? t("No work recorded in this branch yet")
                        : activityFiltersActive
                        ? t("No activity matches these filters")
                        : selectedChannel
                          ? t("No channel messages yet")
                          : t("Create a default channel to start the workspace loop.")
                    }
                    totalSize={messageFeedVirtualizer.getTotalSize()}
                    virtualRows={messageFeedVirtualRows}
                    items={messageFeedItems}
                    getItemId={(feedItem) => feedItem.id}
                    getItemKind={(feedItem) => feedItem.kind}
                    renderItem={(feedItem) => renderMessageFeedItem(feedItem)}
                    measureElement={messageFeedVirtualizer.measureElement}
                    onScroll={handleMessageFeedScroll}
                    onUserScrollIntent={cancelMessageFeedAutoFollow}
                    statusNode={
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
                    }
                    latestButtonNode={
                      messageFeedLatestButtonVisible ? (
                        <button
                          className="message-feed-latest-button"
                          type="button"
                          onClick={scrollMessageFeedToLatest}
                          aria-label={t("Jump to latest message")}
                        >
                          <ArrowDown size={22} />
                        </button>
                      ) : null
                    }
                  />
                  {channelComposer}
                </div>
                {activeThreadRoot ? (
                  <ThreadReplyPanel
                    cwd={cwd}
                    rootMessage={activeThreadRoot}
                    replies={activeThreadMessages}
                    teammates={teammateOptions}
                    teammateById={allLocalTeammateById}
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
          <RightDrawer
            className="channel-side-panel"
            ariaLabel={sidePanelTitle}
            title={sidePanelTitle}
            icon={channelSidePanelIcon(sidePanelView, 16)}
            actions={sidePanelView === "sources" ? undefined : (
              <>
                {sidePanelView !== "approval" && sidePanelView !== "review" ? (
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
            navLabel={t("Channel drawer pages")}
            navItems={channelSidePanelRootViews.map((view) => ({
              id: view,
              label: t(channelSidePanelLabel(view)),
              icon: channelSidePanelIcon(view, 16),
              active: sidePanelView === view,
              onSelect: () => openSidePanelView(view),
            }))}
          >
            {sidePanelContent}
          </RightDrawer>
        ) : null}
      </div>
    </div>
  );
}

function ChannelGovernanceNotificationsPopover({
  notifications,
  loading,
  actionId,
  onRefresh,
  onMarkSeen,
  onDismiss,
}: {
  readonly notifications: readonly GovernanceNotification[];
  readonly loading: boolean;
  readonly actionId: string;
  readonly onRefresh: () => void;
  readonly onMarkSeen: (notificationId: string) => void;
  readonly onDismiss: (notificationId: string) => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <section className="channel-governance-popover" role="dialog" aria-label={t("Governance notifications")}>
      <div className="channel-governance-head">
        <span>
          <ShieldCheck size={15} />
          <strong>{t("Review queue")}</strong>
        </span>
        <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label={t("Refresh")} title={t("Refresh")}>
          {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
        </button>
      </div>
      {notifications.length === 0 ? (
        <div className="client-empty-state compact-empty channel-governance-empty">
          {loading ? <Loader2 className="spin" /> : <ShieldCheck />}
          <span>{loading ? t("Loading review queue...") : t("No review items")}</span>
        </div>
      ) : (
        <div className="channel-governance-list">
          {notifications.map((notification) => {
            const busy = actionId === notification.id;
            return (
              <article
                key={notification.id}
                className={`channel-governance-item ${notification.severity} ${notification.status}`}
              >
                <div className="channel-governance-item-head">
                  <span className={`channel-governance-icon ${notification.severity}`}>
                    {governanceNotificationIcon(notification)}
                  </span>
                  <div>
                    <strong>{notification.title}</strong>
                    <small>
                      {t(governanceNotificationKindLabel(notification.kind))}
                      {" · "}
                      {t(governanceNotificationRouteLabel(notification.targetRoute.page))}
                      {" · "}
                      {formatDateTime(notification.updatedAt)}
                    </small>
                  </div>
                </div>
                <p>{notification.summary}</p>
                <div className="channel-governance-actions">
                  {notification.status === "unread" ? (
                    <button className="secondary-button compact-button" type="button" onClick={() => onMarkSeen(notification.id)} disabled={busy}>
                      {busy ? <Loader2 className="spin" size={13} /> : <Check size={13} />}
                      {t("Seen")}
                    </button>
                  ) : null}
                  <button className="secondary-button compact-button" type="button" onClick={() => onDismiss(notification.id)} disabled={busy}>
                    {busy ? <Loader2 className="spin" size={13} /> : <X size={13} />}
                    {t("Dismiss")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function governanceNotificationIcon(notification: GovernanceNotification): JSX.Element {
  if (notification.severity === "critical" || notification.severity === "action_required") {
    return <CircleAlert size={15} />;
  }
  if (notification.severity === "warning") {
    return <Info size={15} />;
  }
  return <ShieldCheck size={15} />;
}

function governanceNotificationKindLabel(kind: GovernanceNotification["kind"]): string {
  if (kind === "memory_candidate") {
    return "Memory review";
  }
  if (kind === "memory_health_finding") {
    return "Memory health";
  }
  if (kind === "skill_candidate") {
    return "Skill review";
  }
  if (kind === "procedure_cluster") {
    return "Procedure review";
  }
  if (kind === "channel_protocol_candidate") {
    return "Protocol review";
  }
  if (kind === "channel_playbook_candidate") {
    return "Playbook review";
  }
  return "Workflow review";
}

function governanceNotificationRouteLabel(page: GovernanceNotification["targetRoute"]["page"]): string {
  if (page === "memory_promotion_inbox") {
    return "Memory inbox";
  }
  if (page === "memory_health") {
    return "Memory health";
  }
  if (page === "skill_candidate") {
    return "Skill candidate";
  }
  if (page === "procedure_cluster") {
    return "Procedure cluster";
  }
  if (page === "channel_protocol_candidate") {
    return "Channel protocol";
  }
  return "Channel playbook";
}

type ChannelInspectorMode = "protocol" | "brief" | "routing" | "decisions" | "handoffs" | "runtime";

function ChannelSourceDetailPanel({
  detail,
  messages,
  decisions,
}: {
  readonly detail?: SelectedSourceDetailState;
  readonly messages: readonly ChannelMessage[];
  readonly decisions: readonly ChannelDecision[];
}): JSX.Element {
  const { t } = useI18n();
  if (!detail) {
    return (
      <section className="context-source-detail-panel" aria-label={t("Context sources")}>
        <div className="context-source-detail-empty">
          <FileCheck2 size={15} />
          <span>{t("Context source details are not available.")}</span>
        </div>
      </section>
    );
  }
  const selectedGroups = detail.groupId
    ? detail.summary.groups.filter((group) => group.id === detail.groupId)
    : detail.summary.groups;
  const groups = selectedGroups.length > 0 ? selectedGroups : detail.summary.groups;

  return (
    <section className="context-source-detail-panel" aria-label={t("Context sources")}>
      <div className="context-source-detail-head">
        <span>
          <FileCheck2 size={15} />
          <strong>{t("Sources used")}</strong>
        </span>
        <small>{conversationContextSourceSummaryLabel(detail.summary, t)}</small>
      </div>
      {groups.length > 0 ? (
        <div className="context-source-detail-groups">
          {groups.map((group) => (
            <section key={group.id} className="context-source-detail-group" aria-label={group.label}>
              <div className="context-source-detail-group-head">
                <span className="attention-row-icon neutral">{conversationContextSourceGroupIcon(group.type)}</span>
                <span>
                  <strong>{group.label}</strong>
                  <small>{group.count === 1 ? t("1 item") : t("{count} items", { count: group.count })}</small>
                </span>
              </div>
              <ul className="context-source-ref-list">
                {group.refs.map((ref, index) => {
                  const display = contextSourceRefDisplay(ref, messages, decisions, t);
                  return (
                    <li key={`${ref.type}:${ref.id}:${index}`}>
                      <span>{display.primary}</span>
                      <small>{display.secondary}</small>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="context-source-detail-empty">
          <FileText size={15} />
          <span>{detail.summary.unavailableReason ?? t("No user-facing sources were recorded.")}</span>
        </div>
      )}
      {detail.summary.droppedCount > 0 || detail.summary.compactionCount > 0 ? (
        <div className="context-source-detail-foot">
          {detail.summary.droppedCount > 0 ? <span>{t("{count} items omitted from model context", { count: detail.summary.droppedCount })}</span> : null}
          {detail.summary.compactionCount > 0 ? <span>{t("{count} compacted context summaries", { count: detail.summary.compactionCount })}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function contextSourceRefDisplay(
  ref: ConversationContextSourceRefLike,
  messages: readonly ChannelMessage[],
  decisions: readonly ChannelDecision[],
  t: Translate,
): { readonly primary: string; readonly secondary: string } {
  const type = ref.type.trim().toLowerCase();
  if (type === "message" || type === "channel_message" || type === "private_message") {
    const message = messages.find((item) => item.id === ref.id);
    return {
      primary: t("Message {id}", { id: ref.id }),
      secondary: message ? `${contextSourceMessageAuthorLabel(message.authorType, t)} · ${formatDateTime(message.createdAt)}` : t("Source ref"),
    };
  }
  if (type === "decision" || type === "channel_decision") {
    const decision = decisions.find((item) => item.id === ref.id);
    return {
      primary: decision?.title ?? t("Decision {id}", { id: ref.id }),
      secondary: decision ? `${contextSourceDecisionStatusLabel(decision.status, t)} · ${ref.id}` : t("Source ref"),
    };
  }
  const label = ref.label?.trim();
  return {
    primary: label || ref.id,
    secondary: `${t("source {sourceKind}", { sourceKind: ref.type })} · ${ref.id}`,
  };
}

function contextSourceMessageAuthorLabel(authorType: ChannelMessage["authorType"], t: Translate): string {
  if (authorType === "local-user") {
    return t("Local user");
  }
  if (authorType === "ai-teammate") {
    return t("AI teammate");
  }
  if (authorType === "system") {
    return t("System");
  }
  return authorType;
}

function contextSourceDecisionStatusLabel(status: ChannelDecision["status"], t: Translate): string {
  const normalized = String(status);
  if (normalized === "accepted" || normalized === "active") {
    return t("Accepted");
  }
  if (normalized === "rejected") {
    return t("Rejected");
  }
  if (normalized === "superseded") {
    return t("Superseded");
  }
  return normalized;
}

function ChannelInspector({
  cwd,
  mode,
  onModeChange,
  channel,
  protocol,
  teammates,
  autoRouteEnabled,
  brief,
  briefDraft,
  onBriefDraftChange,
  onSaveBrief,
  onSaveProtocol,
  onRevertProtocol,
  routeDecisions,
  intentDecisions,
  decisions,
  handoffs,
  contextSummaries,
  workflows,
  workflowSteps,
  artifactsByRun,
  runtimeDiagnostics,
  workUnits,
  attachments,
  linkPreviews,
  runningWorkflowStepId,
  orchestratingWorkflowId,
  loading,
  runtimeLoading,
  runtimeActionWorkUnitId,
  selectedTask,
  onSupersedeDecision,
  onRejectDecision,
  onUpdateHandoffStatus,
  onStartWorkflowFromHandoff,
  onStartTemplateWorkflow,
  onOrchestrateWorkflow,
  onCancelWorkflow,
  onStartWorkflowStep,
  onRetryWorkflowStep,
  onUpdateWorkflowStepStatus,
  onCreateTaskFromContextSummary,
  onRefreshRuntime,
  onCancelWorkUnit,
  onRetryWorkUnit,
  onReconcileWorkUnit,
}: {
  readonly cwd: string;
  readonly mode: ChannelInspectorMode;
  readonly onModeChange: (mode: ChannelInspectorMode) => void;
  readonly channel: Channel | undefined;
  readonly protocol: ChannelCollaborationProtocolResponse | undefined;
  readonly teammates: readonly ChannelMention[];
  readonly autoRouteEnabled: boolean;
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
  readonly onSaveProtocol: (input: UpdateChannelCollaborationProtocolRequest) => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly onRevertProtocol: () => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly routeDecisions: readonly ChannelMessageRouteDecision[];
  readonly intentDecisions: readonly ChannelIntentDecision[];
  readonly decisions: readonly ChannelDecision[];
  readonly handoffs: readonly ChannelHandoff[];
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly runtimeDiagnostics: RuntimeDiagnosticsResponse | undefined;
  readonly workUnits: readonly WorkUnit[];
  readonly attachments: readonly ChannelAttachment[];
  readonly linkPreviews: readonly ChannelLinkPreview[];
  readonly runningWorkflowStepId: string;
  readonly orchestratingWorkflowId: string;
  readonly loading: boolean;
  readonly runtimeLoading: boolean;
  readonly runtimeActionWorkUnitId: string;
  readonly selectedTask: Task | undefined;
  readonly onSupersedeDecision: (decision: ChannelDecision) => void;
  readonly onRejectDecision: (decision: ChannelDecision) => void;
  readonly onUpdateHandoffStatus: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => void;
  readonly onStartWorkflowFromHandoff: (handoff: ChannelHandoff) => void;
  readonly onStartTemplateWorkflow: () => void;
  readonly onOrchestrateWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onCancelWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onRetryWorkflowStep: (step: ChannelWorkflowStep) => void;
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
  const [openRoutingDecisionId, setOpenRoutingDecisionId] = useState("");
  const recentRoutingEvidence = useMemo(
    () => buildRecentRoutingEvidence(routeDecisions, intentDecisions),
    [intentDecisions, routeDecisions],
  );
  return (
    <section className="channel-inspector" aria-label={t("Channel inspector")}>
      <div className="channel-inspector-tabs" role="tablist" aria-label={t("Channel inspector modes")}>
        {(["protocol", "brief", "routing", "decisions", "handoffs", "runtime"] as const).map((item) => (
          <button key={item} type="button" className={mode === item ? "active" : ""} onClick={() => onModeChange(item)}>
            {item === "protocol" ? t("Protocol") : item === "brief" ? t("Brief") : item === "routing" ? t("Routing") : item === "decisions" ? t("Decisions") : item === "handoffs" ? t("Handoffs") : t("Runtime")}
          </button>
        ))}
      </div>
      {(mode === "runtime" ? runtimeLoading : loading) ? (
        <div className="client-empty-state compact">
          <Loader2 className="spin" />
          <span>{mode === "runtime" ? t("Loading runtime...") : t("Loading protocol...")}</span>
        </div>
      ) : null}
      {mode === "protocol" ? (
        <ChannelProtocolEditor
          channel={channel}
          protocol={protocol}
          autoRouteEnabled={autoRouteEnabled}
          onSave={onSaveProtocol}
          onRevert={onRevertProtocol}
        />
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
      {mode === "routing" ? (
        <RoutingEvidenceIndex
          items={recentRoutingEvidence}
          teammates={teammates}
          openDecisionId={openRoutingDecisionId}
          onToggle={setOpenRoutingDecisionId}
        />
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
            <span className="button-row compact">
              <small>{activeWorkflows.length}</small>
              <button className="secondary-button compact-button" type="button" onClick={onStartTemplateWorkflow} disabled={Boolean(orchestratingWorkflowId)}>
                {orchestratingWorkflowId === "new:autoplan-lite" ? <Loader2 className="spin" size={13} /> : <Play size={13} />}
                {t("Start autoplan")}
              </button>
            </span>
          </div>
          <ProtocolList
            emptyLabel={t("No active workflows")}
            items={activeWorkflows}
            renderItem={(workflow) => (
              <WorkflowQueueCard
                key={workflow.id}
                cwd={cwd}
                workflow={workflow}
                steps={workflowSteps.filter((step) => step.workflowId === workflow.id)}
                artifactsByRun={artifactsByRun}
                brief={brief}
                decisions={activeDecisions}
                handoff={handoffs.find((handoff) => handoff.id === workflow.sourceHandoffId)}
                contextSummaries={contextSummaries}
                attachments={attachments}
                linkPreviews={linkPreviews}
                runningWorkflowStepId={runningWorkflowStepId}
                orchestrating={orchestratingWorkflowId === workflow.id}
                onOrchestrateWorkflow={onOrchestrateWorkflow}
                onCancelWorkflow={onCancelWorkflow}
                onStartWorkflowStep={onStartWorkflowStep}
                onRetryWorkflowStep={onRetryWorkflowStep}
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

type RoutingEvidenceItem =
  | {
      readonly kind: "route";
      readonly id: string;
      readonly createdAt: string;
      readonly decision: ChannelMessageRouteDecision;
    }
  | {
      readonly kind: "intent";
      readonly id: string;
      readonly createdAt: string;
      readonly decision: ChannelIntentDecision;
    };

function RoutingEvidenceIndex({
  items,
  teammates,
  openDecisionId,
  onToggle,
}: {
  readonly items: readonly RoutingEvidenceItem[];
  readonly teammates: readonly ChannelMention[];
  readonly openDecisionId: string;
  readonly onToggle: (id: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="routing-evidence-index">
      <div className="task-strip-head">
        <span><Info size={15} /><strong>{t("Routing evidence")}</strong></span>
        <small>{t("{count} decisions", { count: items.length })}</small>
      </div>
      <ProtocolList
        emptyLabel={t("No routing evidence recorded")}
        items={items}
        renderItem={(item) => {
          const open = openDecisionId === item.id;
          const label = item.kind === "route"
            ? channelRouteDecisionSummaryLabel(item.decision, t)
            : channelIntentDecisionSummaryLabel(item.decision, t);
          return (
            <div className="protocol-row routing-evidence-row" key={item.id}>
              <span>
                <strong>{label}</strong>
                <small>{item.kind === "route" ? t("Reply route") : t("Intent selector")} · {formatDateTime(item.createdAt)}</small>
              </span>
              <button
                className="secondary-button compact-button"
                type="button"
                aria-expanded={open}
                onClick={() => onToggle(open ? "" : item.id)}
              >
                {open ? t("Hide details") : t("Inspect")}
              </button>
              {open ? (
                <div className="routing-evidence-detail">
                  {item.kind === "route" ? (
                    <ChannelRouteInspectContent decision={item.decision} teammates={teammates} t={t} />
                  ) : (
                    <ChannelIntentInspectContent decision={item.decision} teammates={teammates} t={t} />
                  )}
                </div>
              ) : null}
            </div>
          );
        }}
      />
    </div>
  );
}

function buildRecentRoutingEvidence(
  routeDecisions: readonly ChannelMessageRouteDecision[],
  intentDecisions: readonly ChannelIntentDecision[],
): readonly RoutingEvidenceItem[] {
  return [
    ...routeDecisions.map((decision) => ({
      kind: "route" as const,
      id: `route:${decision.id}`,
      createdAt: decision.createdAt,
      decision,
    })),
    ...intentDecisions.map((decision) => ({
      kind: "intent" as const,
      id: `intent:${decision.id}`,
      createdAt: decision.createdAt,
      decision,
    })),
  ]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20);
}

interface ChannelProtocolDraft {
  readonly responseLanguage: NonNullable<Channel["responseLanguage"]>;
  readonly autoReplyMode: Channel["autoReplyMode"];
}

function ChannelProtocolEditor({
  channel,
  protocol,
  autoRouteEnabled,
  onSave,
  onRevert,
}: {
  readonly channel: Channel | undefined;
  readonly protocol: ChannelCollaborationProtocolResponse | undefined;
  readonly autoRouteEnabled: boolean;
  readonly onSave: (input: UpdateChannelCollaborationProtocolRequest) => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly onRevert: () => Promise<ChannelCollaborationProtocolResponse | undefined>;
}): JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ChannelProtocolDraft>(() => protocolDraftFromState(channel, protocol));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const baseDraft = useMemo(() => protocolDraftFromState(channel, protocol), [channel, protocol]);
  const changed =
    draft.responseLanguage !== baseDraft.responseLanguage ||
    draft.autoReplyMode !== baseDraft.autoReplyMode;

  useEffect(() => {
    setDraft(baseDraft);
    setError("");
    setNotice("");
  }, [baseDraft]);

  async function save(): Promise<void> {
    const patch: {
      responseLanguage?: UpdateChannelCollaborationProtocolRequest["responseLanguage"];
      autoReplyMode?: UpdateChannelCollaborationProtocolRequest["autoReplyMode"];
    } = {};
    if (draft.responseLanguage !== baseDraft.responseLanguage) {
      patch.responseLanguage = draft.responseLanguage;
    }
    if (draft.autoReplyMode !== baseDraft.autoReplyMode) {
      patch.autoReplyMode = draft.autoReplyMode;
    }
    if (Object.keys(patch).length === 0) {
      setNotice(t("No protocol changes"));
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await onSave(patch);
      setNotice(t("Protocol updated"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function revert(): Promise<void> {
    if (!window.confirm(t("Reset channel protocol?"))) {
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await onRevert();
      setNotice(t("Protocol reset"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="channel-protocol-editor">
      <div className="task-strip-head">
        <span><ShieldCheck size={15} /><strong>{t("Channel protocol")}</strong></span>
        <small>{protocol ? t("Updated {time}", { time: formatDateTime(protocol.protocol.updatedAt) }) : t("Not loaded")}</small>
      </div>
      {protocol ? (
        <div className="protocol-list">
          <div className="protocol-row compact">
            <span>
              <strong>{t("Effective response language")}</strong>
              <small>{responseLanguageLabel(protocol.protocol.responseLanguage, t)} · {protocolSourceLabel(protocol.sources.responseLanguage.source, t)}</small>
            </span>
          </div>
          <label className="field wide">
            <span>{t("AI response language")}</span>
            <select
              value={draft.responseLanguage}
              onChange={(event) => setDraft({ ...draft, responseLanguage: event.target.value as ChannelProtocolDraft["responseLanguage"] })}
              disabled={!channel || saving}
            >
              <option value="workspace">{t("Workspace default")}</option>
              <option value="follow_user">{t("Follow user")}</option>
              <option value="zh-CN">{t("Chinese")}</option>
              <option value="en-US">{t("English")}</option>
            </select>
          </label>
          <div className="task-strip-head">
            <span><Info size={15} /><strong>{t("Read-only protocol defaults")}</strong></span>
          </div>
          <ProtocolList
            emptyLabel={t("No read-only protocol fields")}
            items={[
              { id: "defaultWorkflowPreference", label: t("Workflow preference"), value: protocol.protocol.defaultWorkflowPreference, source: protocol.sources.defaultWorkflowPreference.source },
              { id: "visibleMultiReplyMaxParticipants", label: t("Visible multi-reply cap"), value: String(protocol.protocol.visibleMultiReplyMaxParticipants), source: protocol.sources.visibleMultiReplyMaxParticipants.source },
              { id: "privacyRules", label: t("Privacy rules"), value: protocol.protocol.privacyRules.length > 0 ? protocol.protocol.privacyRules.join("; ") : t("Default only"), source: protocol.sources.privacyRules.source },
              { id: "reviewRules", label: t("Review rules"), value: protocol.protocol.reviewRules.length > 0 ? protocol.protocol.reviewRules.join("; ") : t("Default only"), source: protocol.sources.reviewRules.source },
            ]}
            renderItem={(item) => (
              <div className="protocol-row compact" key={item.id}>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.value} · {protocolSourceLabel(item.source, t)} · {t("Not editable yet")}</small>
                </span>
              </div>
            )}
          />
          {changed ? (
            <div className="provider-run-notice neutral">
              <Info size={16} />
              <span>{t("Review protocol changes before saving.")}</span>
            </div>
          ) : null}
          {error ? (
            <div className="inline-error compact">
              <CircleAlert size={14} />
              {error}
            </div>
          ) : null}
          {notice ? <div className="inline-success compact">{notice}</div> : null}
          <div className="activity-action-row">
            <button className="primary-button compact-button" type="button" onClick={() => void save()} disabled={!channel || saving || !changed}>
              {saving ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              {t("Save protocol")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => setDraft(baseDraft)} disabled={saving || !changed}>{t("Cancel")}</button>
            <button className="secondary-button compact-button danger" type="button" onClick={() => void revert()} disabled={!channel || saving}>{t("Reset")}</button>
          </div>
        </div>
      ) : (
        <div className="client-empty-state compact">
          <Loader2 className="spin" />
          <span>{t("Loading protocol...")}</span>
        </div>
      )}
    </div>
  );
}

function protocolDraftFromState(
  channel: Channel | undefined,
  protocol: ChannelCollaborationProtocolResponse | undefined,
): ChannelProtocolDraft {
  return {
    responseLanguage: protocol?.sources.responseLanguage.channelValue ?? channel?.responseLanguage ?? "workspace",
    autoReplyMode: channel?.autoReplyMode ?? protocol?.protocol.autoReplyMode ?? "mentions_only",
  };
}

function protocolSourceLabel(source: ChannelCollaborationProtocolResponse["sources"]["responseLanguage"]["source"], t: Translate): string {
  if (source === "channel_setting") {
    return t("Channel setting");
  }
  if (source === "workspace_setting") {
    return t("Workspace setting");
  }
  if (source === "current_message") {
    return t("Current message");
  }
  if (source === "teammate_instruction") {
    return t("Teammate instruction");
  }
  return t("Default");
}

function responseLanguageLabel(value: NonNullable<Channel["responseLanguage"]>, t: Translate): string {
  if (value === "workspace") {
    return t("Workspace default");
  }
  if (value === "follow_user") {
    return t("Follow user");
  }
  if (value === "zh-CN") {
    return t("Chinese");
  }
  if (value === "en-US") {
    return t("English");
  }
  return t("Follow user");
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

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function conversationCoordinatorDisplayBody(
  turn: ConversationTurnViewModel,
  message: ChannelMessage,
  phase: "start" | "terminal",
  t: Translate,
): string {
  if (!turn.operationCell || !shouldSanitizeGeneratedCoordinatorBody(message.body)) {
    return message.body;
  }
  if (phase === "terminal" && isGeneratedWorkflowCoordinatorBody(message.body)) {
    const fallback = conversationCoordinatorTerminalFallback(turn, t);
    return isDuplicateCoordinatorDisplayBody(turn, fallback) ? "" : fallback;
  }
  const cleaned = cleanGeneratedWorkflowText(message.body);
  if (cleaned) {
    return isDuplicateCoordinatorDisplayBody(turn, cleaned) ? "" : cleaned;
  }
  const fallback = phase === "terminal"
    ? conversationCoordinatorTerminalFallback(turn, t)
    : conversationCoordinatorStartFallback(turn, t);
  return isDuplicateCoordinatorDisplayBody(turn, fallback) ? "" : fallback;
}

function shouldSanitizeGeneratedCoordinatorBody(body: string): boolean {
  const text = body.trim();
  if (!text) {
    return false;
  }
  if (/^(确认需求|完成|已完成)\s*[:：]/u.test(text) || /^(Confirm requirement|Completed)\s*:/iu.test(text)) {
    return true;
  }
  if (/Smoke ID\s*:/iu.test(text) || /开始\s*workflow\s*[:：]/iu.test(text)) {
    return true;
  }
  if (/(Confirmed proposal|Overall scope|Assigned teammate|Step action|Acceptance criteria)\s*:/u.test(text)) {
    return true;
  }
  return false;
}

function isGeneratedWorkflowCoordinatorBody(body: string): boolean {
  return /Smoke ID\s*:/iu.test(body) || /开始\s*workflow\s*[:：]/iu.test(body);
}

function conversationCoordinatorStartFallback(turn: ConversationTurnViewModel, t: Translate): string {
  const task = conversationTurnTaskText(turn);
  const agents = conversationTurnAgentLabels(turn);
  const delegation = agents.length > 0
    ? ` ${t("This task is assigned to {agents}.", { agents: formatAgentLabelList(agents) })}`
    : "";
  return `${ensureSentenceEnding(task)}${delegation}`.trim();
}

function conversationCoordinatorTerminalFallback(turn: ConversationTurnViewModel, t: Translate): string {
  const operationCell = turn.operationCell;
  const result = conversationTurnResultText(turn);
  const agents = conversationTurnAgentLabels(turn);
  const teammateSuffix = agents.length > 0
    ? ` ${t("Teammates: {agents}.", { agents: formatAgentLabelList(agents) })}`
    : "";
  if (operationCell?.status === "blocked") {
    return t("Blocked: {reason}.", { reason: result });
  }
  if (operationCell?.status === "failed") {
    return t("Failed: {summary}.", { summary: result });
  }
  if (operationCell?.status === "cancelled" || operationCell?.status === "superseded") {
    return t("Cancelled: {summary}.", { summary: result });
  }
  return `${ensureSentenceEnding(result)}${teammateSuffix ? ` ${teammateSuffix}` : ""}`.trim();
}

function conversationTurnTaskText(turn: ConversationTurnViewModel): string {
  return cleanGeneratedWorkflowText(turn.operationCell?.title) ??
    cleanGeneratedWorkflowText(turn.operationCell?.summary) ??
    cleanGeneratedWorkflowText(turn.sourceMessage.body) ??
    "current task";
}

function conversationTurnResultText(turn: ConversationTurnViewModel): string {
  return cleanGeneratedWorkflowText(turn.operationCell?.summary) ??
    cleanGeneratedWorkflowText(turn.operationCell?.title) ??
    cleanGeneratedWorkflowText(turn.sourceMessage.body) ??
    "current task";
}

function conversationTurnAgentLabels(turn: ConversationTurnViewModel): readonly string[] {
  return uniqueStrings(
    (turn.operationCell?.agentSpans ?? [])
      .filter((span) => span.kind !== "overflow")
      .map((span) => span.label.trim())
      .filter(Boolean),
  );
}

function formatAgentLabelList(labels: readonly string[]): string {
  return labels.join("、");
}

function ensureSentenceEnding(value: string): string {
  const text = value.trim();
  if (!text) {
    return "";
  }
  return /[。.!?！？]$/u.test(text) ? text : `${text}.`;
}

function isDuplicateCoordinatorDisplayBody(turn: ConversationTurnViewModel, value: string): boolean {
  const normalizedValue = normalizeCoordinatorDisplayComparison(value);
  if (!normalizedValue) {
    return true;
  }
  const operationCell = turn.operationCell;
  const candidates = [
    turn.sourceMessage.body,
    operationCell?.title,
    operationCell?.summary,
    ...(operationCell?.operationRows ?? []).map((row) => row.title),
  ];
  return candidates.some((candidate) => normalizeCoordinatorDisplayComparison(candidate) === normalizedValue);
}

function normalizeCoordinatorDisplayComparison(value: string | undefined): string {
  const cleaned = stripGeneratedWorkflowNoise(value)
    .toLowerCase()
    .replace(/[。.!?！？]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned;
}

function cleanGeneratedWorkflowText(value: string | undefined): string | undefined {
  const cleaned = stripGeneratedWorkflowNoise(value);
  if (!cleaned) {
    return undefined;
  }
  return truncatePreview(cleaned, 120);
}

function stripGeneratedWorkflowNoise(value: string | undefined): string {
  if (!value) {
    return "";
  }
  let text = value.trim();
  text = text
    .replace(/^确认需求\s*[:：]\s*/u, "")
    .replace(/^(完成|已完成)\s*[:：]\s*/u, "")
    .replace(/^Confirm requirement\s*:\s*/iu, "")
    .replace(/^Completed\s*:\s*/iu, "")
    .replace(/^["“「']+|["”」']+$/gu, "")
    .replace(/^[“「"]?开始\s*workflow\s*[:：]\s*/iu, "")
    .replace(/^\s*workflow\s*[:：]\s*/iu, "")
    .replace(/\s*Smoke ID\s*:\s*[\w.-]+[。.]?/giu, "")
    .replace(/\s*开始处理[。.]?$/u, "")
    .replace(/[」”"]+[。.]?$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  text = text.replace(/[。.]$/u, "").trim();
  return text;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFileRefList(left: readonly ChannelMessageFileRef[], right: readonly ChannelMessageFileRef[]): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return Boolean(other) &&
      value.path === other.path &&
      value.source === other.source &&
      value.line === other.line;
  });
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
  cwd,
  workflow,
  steps,
  artifactsByRun,
  brief,
  decisions,
  handoff,
  contextSummaries,
  attachments,
  linkPreviews,
  runningWorkflowStepId,
  orchestrating,
  onOrchestrateWorkflow,
  onCancelWorkflow,
  onStartWorkflowStep,
  onRetryWorkflowStep,
  onUpdateWorkflowStepStatus,
}: {
  readonly cwd: string;
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly brief: ChannelBrief | undefined;
  readonly decisions: readonly ChannelDecision[];
  readonly handoff: ChannelHandoff | undefined;
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly attachments: readonly ChannelAttachment[];
  readonly linkPreviews: readonly ChannelLinkPreview[];
  readonly runningWorkflowStepId: string;
  readonly orchestrating: boolean;
  readonly onOrchestrateWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onCancelWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onRetryWorkflowStep: (step: ChannelWorkflowStep) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
}): JSX.Element {
  const { t } = useI18n();
  const orderedSteps = [...steps].sort((left, right) => left.position - right.position);
  const workflowContextSummaries = contextSummaries.filter((summary) => orderedSteps.some((step) => step.contextSummaryId === summary.id));
  const canAdvance = workflowCanAdvance(workflow.status);
  return (
    <div className="protocol-row workflow-queue-card">
      <div className="workflow-queue-head">
        <span>
          <strong>{workflow.title}</strong>
          <small>{workflow.status} · {workflow.objective}</small>
        </span>
        <span className="workflow-queue-actions">
          <StatusBadge status={workflow.status} />
          <button className="secondary-button compact-button" type="button" onClick={() => onOrchestrateWorkflow(workflow)} disabled={!canAdvance || orchestrating}>
            {orchestrating ? <Loader2 className="spin" size={13} /> : <Play size={13} />}
            {t("Advance")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={() => onCancelWorkflow(workflow)} disabled={!workflowCanCancel(workflow.status) || orchestrating}>
            <Square size={13} />
            {t("Cancel")}
          </button>
        </span>
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
              cwd={cwd}
              step={step}
              running={runningWorkflowStepId === step.id}
              contextSummary={contextSummaries.find((summary) => summary.id === step.contextSummaryId)}
              artifactsByRun={artifactsByRun}
              onStartWorkflowStep={onStartWorkflowStep}
              onRetryWorkflowStep={onRetryWorkflowStep}
              onUpdateWorkflowStepStatus={onUpdateWorkflowStepStatus}
            />
          ))
        )}
      </div>
    </div>
  );
}

function WorkflowStepCard({
  cwd,
  step,
  running,
  contextSummary,
  artifactsByRun,
  onStartWorkflowStep,
  onRetryWorkflowStep,
  onUpdateWorkflowStepStatus,
}: {
  readonly cwd: string;
  readonly step: ChannelWorkflowStep;
  readonly running: boolean;
  readonly contextSummary: ChannelContextSummary | undefined;
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onRetryWorkflowStep: (step: ChannelWorkflowStep) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
}): JSX.Element {
  const { t } = useI18n();
  const terminal = isWorkflowStepTerminal(step.status);
  const canStart = step.status === "queued" || step.status === "blocked";
  const canSkip = step.status === "queued";
  const metadata = step.metadata;
  const runArtifacts = step.runId ? artifactsByRun[step.runId] ?? [] : [];
  const runArtifactsById = new Map(runArtifacts.map((artifact) => [artifact.id, artifact] as const));
  const additionalOutputArtifactIds = uniqueStrings((metadata?.outputArtifactIds ?? []).filter((artifactId) => artifactId !== metadata?.outputArtifactId));
  const packetArtifactIds = uniqueStrings([
    metadata?.contextArtifactId,
    metadata?.outputArtifactId,
    ...additionalOutputArtifactIds,
  ].filter((artifactId): artifactId is string => Boolean(artifactId)));
  const workflowSourceLabel = metadata ? workflowStepSourceLabel(metadata, t) : "";
  const gates = metadata?.gates ?? [];
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
      {metadata ? (
        <div className="context-packet muted">
          {metadata.templateStepId ? <span>{t("Template")}: {metadata.templateStepId}</span> : null}
          {metadata.skillId ? <span>{t("Skill")}: {metadata.skillId}</span> : null}
          {metadata.requestedRunnerId ? <span>{t("Runner")}: {metadata.requestedRunnerId}</span> : null}
          {metadata.providerPresetId ? <span>{t("Provider")}: {metadata.providerPresetId}</span> : null}
          {workflowSourceLabel ? <span>{t("Source")}: {workflowSourceLabel}</span> : null}
          {metadata.dependsOnStepIds?.length ? <span>{t("Depends")}: {metadata.dependsOnStepIds.length}</span> : null}
          {metadata.preStepApprovalId ? <span>{t("Pre-step approval")}: {metadata.preStepApprovalId}</span> : null}
        </div>
      ) : null}
      {packetArtifactIds.length > 0 || runArtifacts.length > 0 ? (
        <div className="context-packet muted" aria-label={t("Packet artifacts")}>
          {metadata?.contextArtifactId ? (
            <WorkflowArtifactChip
              label={t("Context source artifact")}
              artifactId={metadata.contextArtifactId}
              artifact={runArtifactsById.get(metadata.contextArtifactId)}
              cwd={cwd}
            />
          ) : null}
          {metadata?.outputArtifactId ? (
            <WorkflowArtifactChip
              label={t("Output packet")}
              artifactId={metadata.outputArtifactId}
              artifact={runArtifactsById.get(metadata.outputArtifactId)}
              cwd={cwd}
            />
          ) : null}
          {additionalOutputArtifactIds.map((artifactId) => (
            <WorkflowArtifactChip
              key={artifactId}
              label={t("Artifact")}
              artifactId={artifactId}
              artifact={runArtifactsById.get(artifactId)}
              cwd={cwd}
            />
          ))}
          {runArtifacts.length > packetArtifactIds.length ? <span>{t("{count} artifacts", { count: runArtifacts.length })}</span> : null}
        </div>
      ) : null}
      {metadata?.contextArtifactId ? (
        <WorkflowStepContextEvidencePanel cwd={cwd} step={step} />
      ) : null}
      {metadata?.policy ? (
        <div className="context-packet muted" aria-label={t("Workflow policy")}>
          <span>{t("Workflow policy")}</span>
          <span>{t("Run failed")}: {workflowStepFailurePolicyLabel(metadata.policy.onRunFailed, t)}</span>
          <span>{t("Run cancelled")}: {workflowStepFailurePolicyLabel(metadata.policy.onRunCancelled, t)}</span>
          <span>{t("Approval denied")}: {workflowStepFailurePolicyLabel(metadata.policy.onApprovalDenied, t)}</span>
          <span>{metadata.policy.retryable ? t("Retryable") : t("Not retryable")}</span>
          {metadata.policy.maxRetries !== undefined ? <span>{t("Max retries")}: {metadata.policy.maxRetries}</span> : null}
        </div>
      ) : null}
      {gates.length > 0 || metadata?.activeGateStage || metadata?.postStepApprovalId ? (
        <div className="context-packet muted" aria-label={t("Workflow gates")}>
          {gates.map((gate) => (
            <span key={`${gate.stage}:${gate.title}`}>
              {workflowGateStageLabel(gate.stage, t)}: {gate.title} · {approvalProfileText(gate.approvalProfile, t)}
            </span>
          ))}
          {metadata?.activeGateStage ? <span>{t("Active gate")}: {workflowGateStageLabel(metadata.activeGateStage, t)}</span> : null}
          {metadata?.postStepApprovalId ? <span>{t("Post-step approval")}: {metadata.postStepApprovalId}</span> : null}
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
        <button className="secondary-button compact-button" type="button" onClick={() => onRetryWorkflowStep(step)} disabled={step.status !== "blocked" || running}>
          {running ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {t("Retry")}
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

function WorkflowArtifactChip({
  label,
  artifactId,
  artifact,
  cwd,
}: {
  readonly label: string;
  readonly artifactId: string;
  readonly artifact: RunArtifact | undefined;
  readonly cwd: string;
}): JSX.Element {
  const { t } = useI18n();
  const chipTitle = artifact?.title || artifact?.path || artifactId;
  const text = `${label}: ${truncatePreview(chipTitle, 42)}`;
  if (!artifact) {
    return <code title={artifactId}>{text}</code>;
  }
  return (
    <a className="workflow-artifact-chip" href={artifactContentUrl(artifact.id, cwd)} target="_blank" rel="noreferrer" title={`${t("Open artifact")}: ${chipTitle}`}>
      {text}
    </a>
  );
}

type WorkflowStepContextEvidenceState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | {
    readonly status: "loaded";
    readonly inspect?: WorkflowContextInspectSummary;
    readonly packet?: ChannelWorkflowStepContextPacket;
    readonly diagnostics: readonly WorkflowEvidenceDiagnostic[];
  }
  | { readonly status: "error"; readonly errorMessage: string };

type WorkflowContextPackSnapshot = NonNullable<ChannelWorkflowStepContextPacket["contextPack"]>;
type WorkflowContextPackSectionSnapshot = WorkflowContextPackSnapshot["sections"][number];

function WorkflowStepContextEvidencePanel({
  cwd,
  step,
}: {
  readonly cwd: string;
  readonly step: ChannelWorkflowStep;
}): JSX.Element | null {
  const { t } = useI18n();
  const contextArtifactId = step.metadata?.contextArtifactId;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<WorkflowStepContextEvidenceState>({ status: "idle" });

  if (!contextArtifactId) {
    return null;
  }

  function toggleOpen(): void {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen && (state.status === "idle" || state.status === "error")) {
      void loadContextEvidence();
    }
  }

  async function loadContextEvidence(): Promise<void> {
    setState({ status: "loading" });
    try {
      const evidence = await getChannelWorkflowEvidence(cwd.trim(), step.workflowId);
      const evidenceStep = evidence.steps.find((item) => item.step.id === step.id);
      setState({
        status: "loaded",
        inspect: evidenceStep?.contextInspect,
        packet: evidenceStep?.contextPacket,
        diagnostics: evidenceStep?.diagnostics ?? [],
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setState({ status: "error", errorMessage: message || t("Context evidence failed to load.") });
    }
  }

  return (
    <section className="workflow-context-evidence-panel" aria-label={t("Context sources")}>
      <button className="secondary-button compact-button" type="button" onClick={toggleOpen} aria-expanded={open}>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        <FileText size={13} />
        {t("Context sources")}
      </button>
      {open ? (
        <WorkflowStepContextEvidenceBody
          artifactId={contextArtifactId}
          state={state}
          onRetry={loadContextEvidence}
        />
      ) : null}
    </section>
  );
}

function WorkflowStepContextEvidenceBody({
  artifactId,
  state,
  onRetry,
}: {
  readonly artifactId: string;
  readonly state: WorkflowStepContextEvidenceState;
  readonly onRetry: () => Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  if (state.status === "idle" || state.status === "loading") {
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state">
          <Loader2 className="spin" size={13} />
          <span>{t("Loading context evidence...")}</span>
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state failed">
          <CircleAlert size={13} />
          <span>{t("Artifact load failed")}: {artifactId}</span>
          <small>{state.errorMessage}</small>
          <button className="secondary-button compact-button" type="button" onClick={() => void onRetry()}>
            <RefreshCw size={13} />
            {t("Retry details")}
          </button>
        </div>
      </div>
    );
  }
  if (!state.packet) {
    if (state.inspect) {
      return <WorkflowContextInspectEvidence inspect={state.inspect} artifactId={artifactId} />;
    }
    const diagnostic = state.diagnostics.find((item) => item.kind === "bad_packet" || item.kind === "missing_context_packet");
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state">
          <FileText size={13} />
          <span>{diagnostic?.message ?? t("No persisted context snapshot for this step.")}</span>
          <small>{artifactId}</small>
        </div>
      </div>
    );
  }
  if (state.inspect) {
    return <WorkflowContextInspectEvidence inspect={state.inspect} artifactId={artifactId} fallbackPacket={state.packet} />;
  }
  if (!state.packet.contextPack) {
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state">
          <FileText size={13} />
          <span>{t("Context source details are not available.")}</span>
          <small>{artifactId}</small>
        </div>
      </div>
    );
  }
  return <WorkflowContextPackEvidence packet={state.packet} artifactId={artifactId} />;
}

function WorkflowContextInspectEvidence({
  inspect,
  artifactId,
  fallbackPacket,
}: {
  readonly inspect: WorkflowContextInspectSummary;
  readonly artifactId: string;
  readonly fallbackPacket?: ChannelWorkflowStepContextPacket;
}): JSX.Element {
  const { t } = useI18n();
  if (inspect.availability !== "available") {
    if (fallbackPacket?.contextPack) {
      return <WorkflowContextPackEvidence packet={fallbackPacket} artifactId={artifactId} />;
    }
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state">
          <FileText size={13} />
          <span>{workflowContextInspectAvailabilityLabel(inspect.availability, t)}</span>
          <small>{inspect.contextArtifactId ?? artifactId}</small>
        </div>
      </div>
    );
  }
  const summary = buildConversationContextSourceSummaryFromInspect(inspect, t);

  return (
    <div className="workflow-context-evidence-body">
      <WorkflowContextSourceSummaryView summary={summary} />
      <WorkflowContextDeveloperDiagnostics>
        <WorkflowContextInspectBudgetDiagnostics inspect={inspect} t={t} />
      </WorkflowContextDeveloperDiagnostics>
    </div>
  );
}

function WorkflowContextPackEvidence({
  packet,
  artifactId,
}: {
  readonly packet: ChannelWorkflowStepContextPacket;
  readonly artifactId: string;
}): JSX.Element {
  const { t } = useI18n();
  const pack = packet.contextPack;
  if (!pack) {
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state">
          <FileText size={13} />
          <span>{t("Context source details are not available.")}</span>
          <small>{artifactId}</small>
        </div>
      </div>
    );
  }
  const summary = buildConversationContextSourceSummaryFromPacket(packet, t);
  return (
    <div className="workflow-context-evidence-body">
      <WorkflowContextSourceSummaryView summary={summary} />
      <WorkflowContextDeveloperDiagnostics>
        <WorkflowContextBudgetDiagnostics pack={pack} t={t} />
      </WorkflowContextDeveloperDiagnostics>
    </div>
  );
}

function WorkflowContextSourceSummaryView({
  summary,
}: {
  readonly summary: ConversationContextSourceSummary;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="workflow-context-source-summary" aria-label={t("Context source summary")}>
      <div className="workflow-context-source-head">
        <strong>{t("Sources used")}</strong>
        <small>{conversationContextSourceSummaryLabel(summary, t)}</small>
      </div>
      {summary.groups.length > 0 ? (
        <ul className="workflow-context-source-list">
          {summary.groups.map((group) => (
            <li key={group.id}>
              <span>{group.label}</span>
              <small>
                {group.count === 1 ? t("1 item") : t("{count} items", { count: group.count })}
                {group.examples.length > 0 ? ` · ${group.examples.join(", ")}` : ""}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <small className="workflow-context-source-empty">{summary.unavailableReason ?? t("No user-facing sources were recorded.")}</small>
      )}
      {summary.droppedCount > 0 || summary.compactionCount > 0 ? (
        <div className="workflow-context-source-foot">
          {summary.droppedCount > 0 ? <span>{t("{count} items omitted from model context", { count: summary.droppedCount })}</span> : null}
          {summary.compactionCount > 0 ? <span>{t("{count} compacted context summaries", { count: summary.compactionCount })}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowContextDeveloperDiagnostics({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <details className="workflow-context-developer-diagnostics">
      <summary>
        <span>{t("Developer diagnostics")}</span>
      </summary>
      {children}
    </details>
  );
}

function WorkflowContextBudgetDiagnostics({
  pack,
  t,
}: {
  readonly pack: WorkflowContextPackSnapshot;
  readonly t: Translate;
}): JSX.Element {
  const sectionEstimateCount = pack.sections.filter((section) => typeof section.estimatedTokens === "number").length;
  return (
    <details className="workflow-context-budget-diagnostics">
      <summary>
        <span>{t("Budget diagnostics")}</span>
        <small>{t("Developer diagnostics")}</small>
      </summary>
      <WorkflowContextEvidenceSection
        title={t("Token budget")}
        summary={workflowContextBudgetUsageLabel(pack, t)}
      >
        <dl className="workflow-context-diagnostics-grid">
          <div>
            <dt>{t("Budget mode")}</dt>
            <dd>{pack.budget.mode || t("Not recorded")}</dd>
          </div>
          <div>
            <dt>{t("Capability source")}</dt>
            <dd>{pack.budget.capabilitySource || t("Not recorded")}</dd>
          </div>
          <div>
            <dt>{t("Capability confidence")}</dt>
            <dd>{pack.budget.capabilityConfidence || t("Not recorded")}</dd>
          </div>
          <div>
            <dt>{t("Tokenizer")}</dt>
            <dd>{pack.budget.tokenizer || t("Not recorded")}</dd>
          </div>
          <div>
            <dt>{t("Context window")}</dt>
            <dd>{formatWorkflowTokenCount(pack.budget.contextWindowTokens, t)}</dd>
          </div>
          <div>
            <dt>{t("Reserved output")}</dt>
            <dd>{formatWorkflowTokenCount(pack.budget.reservedOutputTokens, t)}</dd>
          </div>
          <div>
            <dt>{t("Runtime overhead")}</dt>
            <dd>{formatWorkflowTokenCount(pack.budget.reservedRuntimeOverheadTokens, t)}</dd>
          </div>
          <div>
            <dt>{t("Input budget")}</dt>
            <dd>{formatWorkflowTokenCount(pack.budget.inputBudgetTokens, t)}</dd>
          </div>
          <div>
            <dt>{t("Estimated input")}</dt>
            <dd>{formatWorkflowTokenCount(pack.estimatedInputTokens, t)}</dd>
          </div>
          <div>
            <dt>{t("Over budget")}</dt>
            <dd>{pack.overBudget ? t("Yes") : t("No")}</dd>
          </div>
        </dl>
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Section token estimates")}
        summary={t("{count} sections", { count: sectionEstimateCount })}
      >
        {pack.sections.length > 0 ? (
          <ul>
            {pack.sections.map((section) => (
              <li key={section.id}>
                <strong>{section.id}</strong>
                <small>{workflowContextSectionDiagnosticMeta(section, t)}</small>
              </li>
            ))}
          </ul>
        ) : <small>{t("No kept sections recorded.")}</small>}
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Dropped section ids")}
        summary={t("{count} sections", { count: pack.droppedSectionIds.length })}
      >
        {pack.droppedSectionIds.length > 0 ? (
          <div className="workflow-context-chip-list">
            {pack.droppedSectionIds.map((sectionId) => <code key={sectionId}>{sectionId}</code>)}
          </div>
        ) : <small>{t("No sections dropped.")}</small>}
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Compaction ids")}
        summary={t("{count} compactions", { count: pack.compactionIds.length })}
      >
        {pack.compactionIds.length > 0 ? (
          <div className="workflow-context-chip-list">
            {pack.compactionIds.map((compactionId) => <code key={compactionId}>{compactionId}</code>)}
          </div>
        ) : <small>{t("No compactions recorded.")}</small>}
      </WorkflowContextEvidenceSection>
    </details>
  );
}

function WorkflowContextInspectBudgetDiagnostics({
  inspect,
  t,
}: {
  readonly inspect: WorkflowContextInspectSummary;
  readonly t: Translate;
}): JSX.Element {
  const sectionEstimateCount = inspect.sections.filter((section) => typeof section.estimatedTokens === "number").length;
  return (
    <details className="workflow-context-budget-diagnostics">
      <summary>
        <span>{t("Budget diagnostics")}</span>
        <small>{t("Developer diagnostics")}</small>
      </summary>
      <WorkflowContextEvidenceSection
        title={t("Token budget")}
        summary={inspect.budget ? workflowContextInspectBudgetUsageLabel(inspect, t) : t("Not recorded")}
      >
        {inspect.budget ? (
          <dl className="workflow-context-diagnostics-grid">
            <div>
              <dt>{t("Budget mode")}</dt>
              <dd>{inspect.budget.mode || t("Not recorded")}</dd>
            </div>
            <div>
              <dt>{t("Capability source")}</dt>
              <dd>{inspect.budget.capabilitySource || t("Not recorded")}</dd>
            </div>
            <div>
              <dt>{t("Capability confidence")}</dt>
              <dd>{inspect.budget.capabilityConfidence || t("Not recorded")}</dd>
            </div>
            <div>
              <dt>{t("Tokenizer")}</dt>
              <dd>{inspect.budget.tokenizer || t("Not recorded")}</dd>
            </div>
            <div>
              <dt>{t("Input budget")}</dt>
              <dd>{formatWorkflowTokenCount(inspect.budget.inputBudgetTokens, t)}</dd>
            </div>
            <div>
              <dt>{t("Estimated input")}</dt>
              <dd>{formatWorkflowTokenCount(inspect.budget.estimatedInputTokens, t)}</dd>
            </div>
            <div>
              <dt>{t("Over budget")}</dt>
              <dd>{inspect.budget.overBudget ? t("Yes") : t("No")}</dd>
            </div>
          </dl>
        ) : <small>{t("Not recorded")}</small>}
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Section token estimates")}
        summary={t("{count} sections", { count: sectionEstimateCount })}
      >
        {inspect.sections.length > 0 ? (
          <ul>
            {inspect.sections.map((section) => (
              <li key={section.id}>
                <strong>{section.id}</strong>
                <small>{workflowContextInspectSectionDiagnosticMeta(section, t)}</small>
              </li>
            ))}
          </ul>
        ) : <small>{t("No kept sections recorded.")}</small>}
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Dropped section ids")}
        summary={t("{count} sections", { count: inspect.droppedSectionCount })}
      >
        {inspect.droppedSectionIds.length > 0 ? (
          <div className="workflow-context-chip-list">
            {inspect.droppedSectionIds.map((sectionId) => <code key={sectionId}>{sectionId}</code>)}
          </div>
        ) : <small>{t("No sections dropped.")}</small>}
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Compaction ids")}
        summary={t("{count} compactions", { count: inspect.compactionCount })}
      >
        {inspect.compactionIds.length > 0 ? (
          <div className="workflow-context-chip-list">
            {inspect.compactionIds.map((compactionId) => <code key={compactionId}>{compactionId}</code>)}
          </div>
        ) : <small>{t("No compactions recorded.")}</small>}
      </WorkflowContextEvidenceSection>
    </details>
  );
}

function WorkflowContextEvidenceSection({
  title,
  summary,
  children,
}: {
  readonly title: string;
  readonly summary: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="workflow-context-evidence-section">
      <header>
        <strong>{title}</strong>
        <small>{summary}</small>
      </header>
      {children}
    </section>
  );
}

function workflowContextSectionDiagnosticMeta(section: WorkflowContextPackSectionSnapshot, t: Translate): string {
  return [
    section.role,
    section.priority,
    formatWorkflowTokenCount(section.estimatedTokens, t),
    t("{count} refs", { count: section.sourceRefIds?.length ?? 0 }),
  ].join(" · ");
}

function workflowContextInspectSectionDiagnosticMeta(section: WorkflowContextInspectSummary["sections"][number], t: Translate): string {
  return [
    section.role,
    section.priority,
    formatWorkflowTokenCount(section.estimatedTokens, t),
    t("{count} refs", { count: section.sourceRefIds.length }),
  ].join(" · ");
}

function workflowContextBudgetUsageLabel(pack: WorkflowContextPackSnapshot, t: Translate): string {
  const estimated = pack.estimatedInputTokens;
  const budget = pack.budget.inputBudgetTokens;
  if (!Number.isFinite(estimated) || !Number.isFinite(budget) || budget <= 0) {
    return t("Not recorded");
  }
  return `${formatWorkflowTokenCount(estimated, t)} / ${formatWorkflowTokenCount(budget, t)} (${Math.round((estimated / budget) * 100)}%)`;
}

function workflowContextInspectBudgetUsageLabel(inspect: WorkflowContextInspectSummary, t: Translate): string {
  const estimated = inspect.budget?.estimatedInputTokens;
  const budget = inspect.budget?.inputBudgetTokens;
  if (typeof estimated !== "number" || typeof budget !== "number" || !Number.isFinite(estimated) || !Number.isFinite(budget) || budget <= 0) {
    return t("Not recorded");
  }
  return `${formatWorkflowTokenCount(estimated, t)} / ${formatWorkflowTokenCount(budget, t)} (${Math.round((estimated / budget) * 100)}%)`;
}

function formatWorkflowTokenCount(value: number | undefined, t: Translate): string {
  return typeof value === "number" && Number.isFinite(value) ? t("{count} tokens", { count: value }) : t("Not recorded");
}

function workflowContextInspectAvailabilityLabel(
  availability: WorkflowContextInspectSummary["availability"],
  t: Translate,
): string {
  if (availability === "missing_context_artifact") {
    return t("No persisted context snapshot for this step.");
  }
  if (availability === "unreadable_context_packet") {
    return t("Context source details could not be read.");
  }
  if (availability === "missing_context_pack") {
    return t("Context source details are not available.");
  }
  return t("Context source details are available.");
}

function workflowStepFailurePolicyLabel(policy: string, t: Translate): string {
  if (policy === "block_for_user") {
    return t("Block for user");
  }
  if (policy === "fail_workflow") {
    return t("Fail workflow");
  }
  if (policy === "cancel_workflow") {
    return t("Cancel workflow");
  }
  if (policy === "skip_if_optional") {
    return t("Skip if optional");
  }
  return policy;
}

function workflowGateStageLabel(stage: "pre" | "post", t: Translate): string {
  return stage === "pre" ? t("Pre-step gate") : t("Post-step gate");
}

function WorkflowFinalSummary({
  workflow,
  steps,
  artifactsByRun,
}: {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
}): JSX.Element {
  const { t } = useI18n();
  const orderedSteps = [...steps].sort((left, right) => left.position - right.position);
  const completedSteps = orderedSteps.filter((step) => step.status === "succeeded" || step.status === "skipped");
  const runIds = uniqueStrings(orderedSteps.map((step) => step.runId).filter((id): id is string => Boolean(id)));
  const artifacts = runIds.flatMap((runId) => artifactsByRun[runId] ?? []);
  const changedFiles = uniqueStrings(artifacts.map((artifact) => artifact.path).filter(Boolean));
  const summaries = orderedSteps
    .filter((step) => step.resultSummary)
    .map((step) => `${step.title}: ${step.resultSummary}`);

  return (
    <div className="workflow-final-summary" aria-label={t("Workflow summary")}>
      <strong>{t("Workflow summary")}</strong>
      <div className="context-packet muted">
        <span>{workflow.title}</span>
        <span>{t("{count} steps", { count: completedSteps.length })}</span>
        <span>{t("{count} runs", { count: runIds.length })}</span>
        <span>{t("{count} artifacts", { count: artifacts.length })}</span>
      </div>
      {summaries.length > 0 ? (
        <div className="context-packet muted">
          {summaries.slice(0, 4).map((summary) => <span key={summary}>{summary}</span>)}
        </div>
      ) : null}
      {changedFiles.length > 0 ? (
        <div className="context-packet muted">
          <span>{t("Changed files")}: {changedFiles.slice(0, 4).join(", ")}{changedFiles.length > 4 ? ` +${changedFiles.length - 4}` : ""}</span>
        </div>
      ) : null}
    </div>
  );
}

function workflowIdFromWorkCellThreadId(value: string): string {
  return value.startsWith("workflow:") ? value.slice("workflow:".length) : value;
}

function channelRunInterventionStatusLabel(
  status: RunIntervention["status"],
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (status === "cancelling_source") {
    return t("Stopping source");
  }
  if (status === "starting_continuation") {
    return t("Starting continuation");
  }
  if (status === "started") {
    return t("Started");
  }
  if (status === "cancelled") {
    return t("Cancelled");
  }
  if (status === "failed") {
    return t("Failed");
  }
  return t("Queued");
}

function channelRunInterventionModeLabel(
  mode: RunIntervention["mode"],
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  return mode === "interrupt_redirect" ? t("Stop and redirect") : t("Queue guidance");
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
          <span>{t("Generation-only models cannot run coding tasks.")}</span>
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
  cwd,
  task,
  channels,
  attachments,
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
  approvalPolicy,
  permissionMode,
  permissionPreset,
  decisions,
  contextSummaries,
  workflows,
  workflowSteps,
  onCreateHandoffFromTask,
  onOpenHandoffs,
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
  attachmentContentUrl,
}: {
  readonly cwd: string;
  readonly task: Task;
  readonly channels: readonly Channel[];
  readonly attachments: readonly ChannelAttachment[];
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
  readonly approvalPolicy: ApprovalPolicy | undefined;
  readonly permissionMode: SessionPermissionMode;
  readonly permissionPreset?: PermissionPreset;
  readonly decisions: readonly ChannelDecision[];
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly onCreateHandoffFromTask: (task: Task) => Promise<ChannelHandoff | undefined>;
  readonly onOpenHandoffs: () => void;
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
  readonly attachmentContentUrl: (attachment: ChannelAttachment) => string;
}): JSX.Element {
  const { t } = useI18n();
  const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
  const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
  const linkedRunSucceeded = linkedRunStatus === "succeeded";
  const repairHint = buildRunRepairHint(linkedRun, pendingApprovalCount, linkedRunStatus, "", t);
  const taskChannel = channels.find((channel) => channel.id === task.channelId);
  const taskAttachments = (task.attachmentIds ?? [])
    .map((attachmentId) => attachments.find((attachment) => attachment.id === attachmentId))
    .filter((attachment): attachment is ChannelAttachment => Boolean(attachment));
  const resolvedPermissionPreset = permissionPreset ?? inferPermissionPreset(permissionMode);
  const effectivePolicyPreview = buildLocalEffectivePolicyPreview({
    policy: approvalPolicy,
    mode: permissionMode,
    channelBoundPath: taskChannel?.boundPath,
  });
  const policyPreviewRows = [
    ...summarizeEffectivePolicySnapshot(effectivePolicyPreview, t),
    ...formatToolDecisionGroups(effectivePolicyPreview, t),
  ];
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
  const [handoffState, setHandoffState] = useState<{ readonly status: "idle" | "saving" | "saved" | "failed"; readonly message: string }>({
    status: "idle",
    message: "",
  });

  useEffect(() => {
    setHandoffState({ status: "idle", message: "" });
  }, [task.id]);

  async function handleCreateHandoff(): Promise<void> {
    if (handoffState.status === "saving") {
      return;
    }
    setHandoffState({ status: "saving", message: "" });
    try {
      const handoff = await onCreateHandoffFromTask(task);
      if (!handoff) {
        setHandoffState({ status: "failed", message: t("Create handoff failed") });
        return;
      }
      setHandoffState({ status: "saved", message: t("Handoff created") });
      onOpenHandoffs();
    } catch (error) {
      setHandoffState({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }

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
        {task.requestedSkillId ? (
          <span>
            <SquareTerminal size={13} />
            {t("Requested skill")}: {task.requestedSkillId}
          </span>
        ) : null}
      </div>
      {taskAttachments.length > 0 ? (
        <ConversationAttachmentStrip
          attachments={taskAttachments.map((attachment) => ({
            id: attachment.id,
            label: attachment.fileName,
            meta: formatBytes(attachment.sizeBytes),
            href: attachmentContentUrl(attachment),
            target: "_blank",
            rel: "noreferrer",
            icon: attachment.kind === "image" ? <ImageIcon size={13} /> : <FileText size={13} />,
            previewRequest: attachmentCanPreview(attachment) ? {
              source: "attachment",
              cwd,
              attachmentId: attachment.id,
              scope: "channel",
              channelId: task.channelId,
            } : undefined,
          }))}
        />
      ) : null}
      {task.currentRunId ? (
        <div className={linkedRunSucceeded ? "task-run-link compact succeeded" : "task-run-link compact"}>
          <StatusBadge status={linkedRunStatus} />
          <span className="task-run-summary">
            <span>{t("Run linked")}</span>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(task.currentRunId ?? "")}>
            <History size={14} />
            {t("Open run")}
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
      <div className="session-permission-control" aria-label={t("Permission mode")}>
        <div className="session-permission-head">
          <span>
            <ShieldCheck size={14} />
            {t("Permission preset")}
          </span>
          <strong>{sessionPermissionModeLabel(permissionMode, t)}</strong>
        </div>
        <div className="permission-preset-segment" role="group" aria-label={t("Permission preset")}>
          {permissionPresetOptions.map((preset) => (
            <button
              key={preset}
              className={resolvedPermissionPreset === preset ? "permission-preset-option active" : "permission-preset-option"}
              type="button"
              onClick={() => onPermissionModeChange(permissionModeForPreset(preset))}
              disabled={isRunning || taskActionPending}
              aria-pressed={resolvedPermissionPreset === preset}
            >
              <span>{permissionPresetLabel(preset, t)}</span>
            </button>
          ))}
        </div>
        <small>{permissionPresetDescription(resolvedPermissionPreset, t)}</small>
        <details className="permission-preview-disclosure">
          <summary>{t("Preview permissions")}</summary>
          <div className="permission-preview-list">
            {policyPreviewRows.map((row) => (
              <span key={row}>{row}</span>
            ))}
            <span>{sessionPermissionModeDescription(permissionMode, t)}</span>
          </div>
        </details>
      </div>
      <div className="task-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => void handleCreateHandoff()} disabled={handoffState.status === "saving"}>
          {handoffState.status === "saving" ? <Loader2 className="spin" size={14} /> : <Workflow size={14} />}
          {handoffState.status === "saving" ? t("Creating") : t("Create handoff")}
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
      {handoffState.status === "saved" || handoffState.status === "failed" ? (
        <div className={handoffState.status === "saved" ? "provider-run-notice ok" : "provider-run-notice"}>
          {handoffState.status === "saved" ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
          <span>{handoffState.message}</span>
        </div>
      ) : null}
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

function runCanBeStopped(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

function runIsActiveProgressPopoverRun(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

function taskIsActiveProgressPopoverTask(task: Task): boolean {
  return task.status === "claimed" || task.status === "running" || task.status === "blocked";
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

function ChannelExecutionProposalCard({
  proposal,
  assigneeLabel,
  teammates,
  linkedRun,
  linkedWorkflow,
  activeRunId,
  latestStatus,
  onConfirm,
  onCancel,
  onUpdate,
  onOpenRun,
}: {
  readonly proposal: ChannelExecutionProposal;
  readonly assigneeLabel: string;
  readonly teammates: readonly ChannelMention[];
  readonly linkedRun: RunSession | undefined;
  readonly linkedWorkflow: ChannelWorkflow | undefined;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onUpdate: (
    proposal: ChannelExecutionProposal,
    input: UpdateChannelExecutionProposalRequest,
  ) => Promise<ChannelExecutionProposal | undefined>;
  readonly onOpenRun: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [draft, setDraft] = useState<ChannelProposalEditDraft>(() => proposalToEditDraft(proposal));
  const canStart = proposal.status === "draft" || proposal.status === "blocked" || proposal.status === "run_failed";
  const canEdit = canStart && !proposal.linkedWorkflowId;
  const linkedRunStatus = proposal.linkedRunId
    ? displayLinkedRunStatus(proposal.linkedRunId, linkedRun, activeRunId, latestStatus)
    : "";
  const linkedWorkflowStatus = proposal.linkedWorkflowId
    ? (linkedWorkflow?.status ?? "workflow")
    : "";
  const collaborationSummary = proposalCollaborationSummary(proposal, teammates, t);
  const permissionSummary = buildProposalPermissionSummary({ proposal, assigneeLabel, t });
  const shapingRows = buildRequirementShapingRows({ proposal, assigneeLabel, t });
  const isRequirementShaping = proposal.status === "draft" && !editing;
  const statusIcon = proposal.status === "accepted"
    ? <CheckCircle2 size={14} />
    : proposal.status === "blocked" || proposal.status === "run_failed"
      ? <CircleAlert size={14} />
      : <Play size={14} />;
  const draftValid = proposalDraftIsValid(draft);

  useEffect(() => {
    if (!editing) {
      setDraft(proposalToEditDraft(proposal));
      setEditError("");
    }
  }, [editing, proposal]);

  async function saveEdit(): Promise<void> {
    if (!draftValid || saving) {
      return;
    }
    setSaving(true);
    setEditError("");
    try {
      const updated = await onUpdate(proposal, proposalDraftToUpdateInput(proposal, draft));
      if (updated) {
        setEditing(false);
      }
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function updateStep(index: number, patch: Partial<ChannelProposalStepDraft>): void {
    setDraft((current) => ({
      ...current,
      collaborationSteps: current.collaborationSteps.map((step, stepIndex) =>
        stepIndex === index
          ? {
              ...step,
              ...patch,
              ...(patch.teammateId && patch.teammateId !== step.teammateId ? { sources: undefined } : {}),
            }
          : step
      ),
    }));
  }

  function removeStep(index: number): void {
    setDraft((current) => ({
      ...current,
      collaborationSteps: current.collaborationSteps.filter((_, stepIndex) => stepIndex !== index),
    }));
  }

  function addStep(): void {
    setDraft((current) => ({
      ...current,
      collaborationSteps: [
        ...current.collaborationSteps,
        {
          teammateId: current.assigneeTeammateId || teammates[0]?.id || proposal.assigneeTeammateId,
          action: "coordinated",
          summary: "",
        },
      ],
    }));
  }

  return (
    <div className={`channel-execution-proposal ${proposal.status} ${isRequirementShaping ? "requirement-shaping-card" : ""}`} aria-label={t("Task confirmation")}>
      <div className="channel-proposal-head">
        <span>
          {statusIcon}
          <strong>{proposal.title}</strong>
        </span>
        <small>{t(executionProposalStatusLabel(proposal.status))}</small>
      </div>
      {editing ? (
        <div className="channel-proposal-edit-form">
          <label>
            <span>{t("Title")}</span>
            <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("Scope")}</span>
            <textarea rows={4} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("Assignee")}</span>
            <select value={draft.assigneeTeammateId} onChange={(event) => setDraft({ ...draft, assigneeTeammateId: event.currentTarget.value })}>
              {teammates.map((teammate) => (
                <option key={teammate.id} value={teammate.id}>{teammate.label}</option>
              ))}
              {teammates.some((teammate) => teammate.id === draft.assigneeTeammateId) ? null : (
                <option value={draft.assigneeTeammateId}>{teammateLabel(draft.assigneeTeammateId, teammates, t("Deleted teammate"))}</option>
              )}
            </select>
          </label>
          <label>
            <span>{t("Acceptance criteria")}</span>
            <textarea rows={3} value={draft.acceptanceCriteriaText} onChange={(event) => setDraft({ ...draft, acceptanceCriteriaText: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("Requirement summary")}</span>
            <textarea rows={3} value={draft.shapingSummaryText} onChange={(event) => setDraft({ ...draft, shapingSummaryText: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("Open questions")}</span>
            <textarea rows={3} value={draft.shapingOpenQuestionsText} onChange={(event) => setDraft({ ...draft, shapingOpenQuestionsText: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("User clarifications")}</span>
            <textarea rows={3} value={draft.shapingClarificationsText} onChange={(event) => setDraft({ ...draft, shapingClarificationsText: event.currentTarget.value })} />
          </label>
          <div className="channel-proposal-edit-steps">
            <div className="channel-proposal-edit-steps-head">
              <strong>{t("Steps")}</strong>
              <button className="secondary-button compact-button" type="button" onClick={addStep}>
                <Plus size={14} />
                {t("Add step")}
              </button>
            </div>
            {draft.collaborationSteps.map((step, index) => (
              <div className="channel-proposal-edit-step" key={`${index}-${step.teammateId}-${step.action}`}>
                <select value={step.teammateId} onChange={(event) => updateStep(index, { teammateId: event.currentTarget.value })}>
                  {teammates.map((teammate) => (
                    <option key={teammate.id} value={teammate.id}>{teammate.label}</option>
                  ))}
                  {teammates.some((teammate) => teammate.id === step.teammateId) ? null : (
                    <option value={step.teammateId}>{teammateLabel(step.teammateId, teammates, t("Deleted teammate"))}</option>
                  )}
                </select>
                <select value={step.action} onChange={(event) => updateStep(index, { action: event.currentTarget.value as ChannelProposalStepDraft["action"] })}>
                  {proposalStepActions.map((action) => (
                    <option key={action} value={action}>{t(proposalStepActionLabel(action))}</option>
                  ))}
                </select>
                <textarea rows={2} value={step.summary} onChange={(event) => updateStep(index, { summary: event.currentTarget.value })} />
                <button className="secondary-button danger compact-button" type="button" onClick={() => removeStep(index)} disabled={draft.collaborationSteps.length <= 1}>
                  <Trash2 size={14} />
                  {t("Remove")}
                </button>
              </div>
            ))}
          </div>
          {editError ? (
            <div className="channel-proposal-error">
              <CircleAlert size={14} />
              <span>{editError}</span>
            </div>
          ) : null}
        </div>
      ) : isRequirementShaping ? (
        <RequirementShapingSummary
          rows={shapingRows}
          shaping={proposal.shaping}
          collaborationSteps={proposal.collaborationSteps}
          teammates={teammates}
        />
      ) : (
        <p>{proposal.prompt}</p>
      )}
      <div className="channel-proposal-meta">
        <span>{t("Assignee")}: <strong>{assigneeLabel}</strong></span>
        {proposal.requiredTools.length > 0 ? <span>{t("Required tools")}: {proposal.requiredTools.join(", ")}</span> : null}
        {linkedWorkflowStatus ? <StatusBadge status={linkedWorkflowStatus} /> : null}
        {linkedRunStatus ? <StatusBadge status={linkedRunStatus} /> : null}
      </div>
      {!editing && canStart ? (
        <section className="channel-proposal-permission" aria-label={t("Task permission confirmation")}>
          <div className="channel-proposal-permission-head">
            <ShieldCheck size={14} />
            <strong>{t("Task permission confirmation")}</strong>
          </div>
          <p>{permissionSummary.sentence}</p>
          <div className="channel-proposal-permission-grid">
            <span>
              <small>{t("Required tool")}</small>
              <strong>{permissionSummary.toolLabel}</strong>
            </span>
            <span>
              <small>{t("Target")}</small>
              <strong>{permissionSummary.targetLabel}</strong>
            </span>
            <span>
              <small>{t("Executor")}</small>
              <strong>{permissionSummary.executorLabel}</strong>
            </span>
          </div>
          <small>{t("Starting this task does not approve future runtime actions. Ling may still ask before file changes, commands, MCP tools, or external actions.")}</small>
        </section>
      ) : null}
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
            {proposal.collaborationSteps.map((step, index) => {
              const sourceLabel = proposalStepSourceLabel(step, t);
              return (
                <li key={`${step.teammateId}-${step.action}-${index}`}>
                  <strong>{teammateLabel(step.teammateId, teammates, t("Deleted teammate"))}</strong>
                  <span className="channel-proposal-step-meta">
                    <small>{t(proposalStepActionLabel(step.action))}</small>
                    {sourceLabel ? (
                      <small className="channel-proposal-step-source">{sourceLabel}</small>
                    ) : null}
                  </span>
                  <span className="channel-proposal-step-summary">{step.summary}</span>
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
      <div className="channel-proposal-actions">
        {editing ? (
          <>
            <button className="primary-button compact-button" type="button" onClick={() => void saveEdit()} disabled={saving || !draftValid}>
              {saving ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              {t("Save")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => setEditing(false)} disabled={saving}>
              <X size={14} />
              {t("Cancel")}
            </button>
          </>
        ) : canStart ? (
          <button className="primary-button compact-button" type="button" onClick={onConfirm}>
            <Play size={14} />
            {t("Authorize and start task")}
          </button>
        ) : null}
        {!editing && canEdit ? (
          <button className="secondary-button compact-button" type="button" onClick={() => setEditing(true)}>
            <SlidersHorizontal size={14} />
            {t("Edit")}
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

function RequirementShapingSummary({
  rows,
  shaping,
  collaborationSteps,
  teammates,
}: {
  readonly rows: readonly RequirementShapingRow[];
  readonly shaping: ChannelExecutionProposal["shaping"];
  readonly collaborationSteps: ChannelExecutionProposal["collaborationSteps"];
  readonly teammates: readonly ChannelMention[];
}): JSX.Element {
  const { t } = useI18n();
  const visibleSteps = collaborationSteps.slice(0, 4);
  const openQuestions = shaping?.openQuestions.slice(0, 4) ?? [];
  const clarifications = shaping?.clarifications.slice(0, 4) ?? [];
  return (
    <section className="requirement-shaping-summary" aria-label={t("Requirement shaping")}>
      <header>
        <span>
          <ListChecks size={15} />
          <strong>{t("Ling is shaping the task")}</strong>
        </span>
        <small>{t(requirementShapingStatusLabel(shaping?.status ?? "ready_for_confirmation"))}</small>
      </header>
      <div className="requirement-shaping-grid">
        {rows.map((row) => (
          <span key={row.id} className={row.tone ?? "neutral"}>
            <small>{row.label}</small>
            <strong>{row.value}</strong>
          </span>
        ))}
      </div>
      {openQuestions.length > 0 || clarifications.length > 0 ? (
        <div className="requirement-shaping-notes">
          {openQuestions.length > 0 ? (
            <section aria-label={t("Open questions")}>
              <small>{t("Open questions")}</small>
              <ul>
                {openQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {clarifications.length > 0 ? (
            <section aria-label={t("User clarifications")}>
              <small>{t("User clarifications")}</small>
              <ul>
                {clarifications.map((clarification) => (
                  <li key={clarification.id}>{clarification.body}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
      {visibleSteps.length > 0 ? (
        <div className="requirement-shaping-participants" aria-label={t("Shaping participants")}>
          {visibleSteps.map((step, index) => (
            <span key={`${step.teammateId}-${step.action}-${index}`}>
              <small>{teammateLabel(step.teammateId, teammates, t("Deleted teammate"))} · {t(proposalStepActionLabel(step.action))}</small>
              <strong>{step.summary}</strong>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ThreadReplyPanel({
  cwd,
  rootMessage,
  replies,
  teammates,
  teammateById,
  memoryById,
  usedMemoryEvents,
  draft,
  pending,
  error,
  onDraftChange,
  onSend,
  onClose,
}: {
  readonly cwd: string;
  readonly rootMessage: ChannelMessage;
  readonly replies: readonly ChannelMessage[];
  readonly teammates: readonly ChannelMention[];
  readonly teammateById: ReadonlyMap<string, { readonly displayName: string }>;
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
          <small>{t("Topic started by {author}", { author: messageAuthorLabel(rootMessage, teammates, t("Deleted teammate"), t("You"), teammateById) })}</small>
        )}
        <MessageBodyRenderer text={rootMessage.body} cwd={cwd} compact />
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
                  <strong>{messageAuthorLabel(reply, teammates, t("Deleted teammate"), t("You"), teammateById)}</strong>
                  {reply.kind === "ai_reply" ? <small>AI</small> : null}
                </div>
              )}
              <MessageBodyRenderer text={reply.body} cwd={cwd} compact />
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
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
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
    <div className="activity-filter-toolbar" aria-label={t("Channel event filters")}>
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
        aria-label={t("Filter channel events")}
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
        <div className="activity-filter-panel" aria-label={t("Channel event filters")}>
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

function buildActiveProgressSourceSummary({
  contextSummaries,
  workflowSteps,
  selectedTask,
  runningWorkflowStepId,
  t,
}: {
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly selectedTask?: Task;
  readonly runningWorkflowStepId: string;
  readonly t: Translate;
}): ConversationContextSourceSummary | undefined {
  const activeStep = [
    workflowSteps.find((step) => step.id === runningWorkflowStepId),
    ...workflowSteps
      .filter((step) => workflowStepHasActiveContext(step))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  ].find((step): step is ChannelWorkflowStep => Boolean(step?.contextSummaryId));
  const activeSummary = activeStep?.contextSummaryId
    ? contextSummaries.find((summary) => summary.id === activeStep.contextSummaryId)
    : undefined;
  if (activeSummary) {
    return buildConversationContextSourceSummaryFromChannelSummary(activeSummary, t);
  }

  if (selectedTask && taskIsActiveProgressPopoverTask(selectedTask)) {
    const taskSummary = contextSummaries
      .filter((summary) => summary.targetType === "task" && summary.targetId === selectedTask.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return taskSummary ? buildConversationContextSourceSummaryFromChannelSummary(taskSummary, t) : undefined;
  }

  return undefined;
}

function workflowStepHasActiveContext(step: ChannelWorkflowStep): boolean {
  return Boolean(step.contextSummaryId) && (
    step.status === "claimed" ||
    step.status === "running" ||
    step.status === "waiting_for_approval" ||
    step.status === "blocked"
  );
}

function conversationContextSourceGroupIcon(type: string): ReactNode {
  if (type === "message" || type === "channel_message" || type === "private_message") {
    return <MessageSquare size={18} />;
  }
  if (type === "decision" || type === "channel_decision") {
    return <FileCheck2 size={18} />;
  }
  if (type === "file" || type === "workspace_file" || type === "attachment") {
    return <FileText size={18} />;
  }
  if (type === "artifact" || type === "run_artifact") {
    return <Archive size={18} />;
  }
  if (type === "memory" || type === "project_memory") {
    return <Database size={18} />;
  }
  if (type === "web" || type === "url" || type === "page") {
    return <Link2 size={18} />;
  }
  if (type === "teammate" || type === "agent") {
    return <UserPlus size={18} />;
  }
  if (type === "run" || type === "run_session" || type === "task" || type === "channel_task") {
    return <SquareTerminal size={18} />;
  }
  return <FileText size={18} />;
}

function ProgressPopover({
  expanded,
  onExpandedChange,
  progressRows,
  sourceSummary,
  onOpenSourceGroup,
}: {
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly progressRows: readonly AttentionProgressRow[];
  readonly sourceSummary?: ConversationContextSourceSummary;
  readonly onOpenSourceGroup?: (group: ConversationContextSourceGroup, summary: ConversationContextSourceSummary) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  if (progressRows.length === 0) {
    return null;
  }
  const sourceGroups = sourceSummary?.groups ?? [];
  return (
    <section className="attention-queue compact" aria-label={t("Progress")}>
      {sourceSummary && sourceSummary.sourceCount > 0 ? (
        <div className="attention-context-section" aria-label={t("Context source summary")}>
          <div className="attention-section-head">
            <strong>{t("Sources used")}</strong>
            <small>{conversationContextSourceSummaryLabel(sourceSummary, t)}</small>
          </div>
          <div className="attention-context-list">
            {sourceGroups.slice(0, 4).map((group) => (
              <button
                key={group.id}
                className="attention-context-row interactive"
                type="button"
                onClick={() => onOpenSourceGroup?.(group, sourceSummary)}
                aria-label={t("Open {label} sources", { label: group.label })}
              >
                <span className="attention-row-icon neutral">{conversationContextSourceGroupIcon(group.type)}</span>
                <span className="attention-context-copy">
                  <strong>{group.label}</strong>
                  <small>
                    {group.count === 1 ? t("1 item") : t("{count} items", { count: group.count })}
                    {group.examples.length > 0 ? ` · ${group.examples.join(", ")}` : ""}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {sourceSummary.droppedCount > 0 || sourceSummary.compactionCount > 0 ? (
            <div className="attention-context-foot">
              {sourceSummary.droppedCount > 0 ? <span>{t("{count} items omitted from model context", { count: sourceSummary.droppedCount })}</span> : null}
              {sourceSummary.compactionCount > 0 ? <span>{t("{count} compacted context summaries", { count: sourceSummary.compactionCount })}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {progressRows.length > 0 ? (
        <div className="attention-progress-preview">
          <div className="attention-section-head attention-progress-head">
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
            <div className="attention-progress-list" aria-label={t("Progress rows")}>
              {progressRows.slice(0, 6).map((row) => {
                const content = (
                  <>
                    <span className={`attention-row-icon ${row.tone}`}>{row.icon}</span>
                    <span className="attention-progress-copy">
                      <strong>{row.primary}</strong>
                      {row.secondary ? <small>{row.secondary}</small> : null}
                    </span>
                  </>
                );
                return row.onOpen ? (
                  <button key={row.id} className={`attention-progress-row ${row.tone} interactive`} type="button" onClick={row.onOpen}>
                    {content}
                  </button>
                ) : (
                  <div key={row.id} className={`attention-progress-row ${row.tone}`}>
                    {content}
                  </div>
                );
              })}
            </div>
          ) : null}
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
    return "Show task in transcript";
  }
  if (target.kind === "run") {
    return "Show run in transcript";
  }
  if (target.kind === "approval") {
    return "Open approval";
  }
  return "Review source";
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
  return result.kind === "task" ? "Show created task in transcript" : "Review created source";
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

function workflowCanAdvance(status: ChannelWorkflow["status"]): boolean {
  return status === "ready" || status === "running" || status === "waiting_for_approval" || status === "blocked";
}

function workflowCanCancel(status: ChannelWorkflow["status"]): boolean {
  return status === "draft" || status === "ready" || status === "running" || status === "waiting_for_approval" || status === "blocked";
}

function ChannelReviewPanel({
  approvals,
  runs,
  tasks,
  artifactsByRun,
  executionActionError,
  loading,
  onOpenApproval,
}: {
  readonly approvals: readonly ApprovalRequest[];
  readonly runs: readonly RunSession[];
  readonly tasks: readonly Task[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly executionActionError: string;
  readonly loading: boolean;
  readonly onOpenApproval: (approval: ApprovalRequest | undefined) => void;
}): JSX.Element {
  const { t } = useI18n();
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const pendingApprovals = approvals
    .filter((approval) => effectiveApprovalStatus(approval) === "pending")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 3);
  const terminalRuns = runs
    .filter((run) => run.status !== "queued" && run.status !== "running" && run.status !== "waiting_for_approval")
    .sort((left, right) => compareRunActivity(right, left))
    .slice(0, 5);
  const terminalArtifactCount = terminalRuns.reduce((count, run) => count + (artifactsByRun[run.id]?.length ?? 0), 0);
  const failedRunCount = terminalRuns.filter((run) => run.status === "failed" || run.status === "cancelled").length;

  return (
    <section className="channel-review-panel" aria-label={t("Review")}>
      {loading ? (
        <div className="channel-review-loading" role="status">
          <Loader2 className="spin" size={14} />
          <span>{t("Refreshing review data...")}</span>
        </div>
      ) : null}

      <div className="channel-review-summary" aria-label={t("Review summary")}>
        <span>
          <strong>{pendingApprovals.length}</strong>
          <small>{t("Pending approvals")}</small>
        </span>
        <span>
          <strong>{terminalRuns.length}</strong>
          <small>{t("Completed runs")}</small>
        </span>
        <span>
          <strong>{terminalArtifactCount}</strong>
          <small>{t("Artifacts")}</small>
        </span>
      </div>
      {executionActionError ? (
        <p className="channel-review-error danger-text">{executionActionError}</p>
      ) : null}

      <div className="channel-review-section">
        <div className="task-strip-head">
          <span>
            <ShieldCheck size={16} />
            <strong>{t("Approvals")}</strong>
          </span>
        </div>
        {pendingApprovals.length === 0 ? (
          <div className="client-empty-state compact-empty">
            <ShieldCheck />
            <span>{t("No pending approval")}</span>
          </div>
        ) : (
          <div className="channel-review-list">
            {pendingApprovals.map((approval) => (
              <button key={approval.id} className="channel-review-row button-row" type="button" onClick={() => onOpenApproval(approval)}>
                <span className="channel-review-row-main">
                  <strong>{approval.title}</strong>
                  <small>{approval.actionType} · {approval.risk} · {formatDateTime(approval.createdAt)}</small>
                </span>
                <span className={`approval-state ${effectiveApprovalStatus(approval)}`}>{effectiveApprovalStatus(approval)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="channel-review-section">
        <div className="task-strip-head">
          <span>
            <CheckCircle2 size={16} />
            <strong>{t("Run results")}</strong>
          </span>
          {failedRunCount > 0 ? <small>{t("{count} need review", { count: failedRunCount })}</small> : null}
        </div>
        {terminalRuns.length === 0 ? (
          <div className="client-empty-state compact-empty">
            <CheckCircle2 />
            <span>{t("No completed run to review")}</span>
          </div>
        ) : (
          <div className="channel-review-list">
            {terminalRuns.map((run) => {
              const task = taskById.get(run.taskId);
              const runArtifacts = artifactsByRun[run.id] ?? [];
              return (
                <div key={run.id} className="channel-review-row">
                  <span className="channel-review-row-main">
                    <strong>{task?.title ?? readRunTitle(run)}</strong>
                    <small>{formatDateTime(run.endedAt ?? run.updatedAt)} · {t("{count} artifacts", { count: runArtifacts.length })}</small>
                    {run.errorMessage ? <small className="danger-text">{run.errorMessage}</small> : null}
                  </span>
                  <StatusBadge status={run.status} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
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

function ChannelRouteInspectContent({
  decision,
  teammates,
  t,
}: {
  readonly decision: ChannelMessageRouteDecision;
  readonly teammates: readonly ChannelMention[];
  readonly t: Translate;
}): JSX.Element {
  const contextPack = decision.contextPack;
  return (
    <>
      <p>{channelRouteDecisionUserReason(decision, t)}</p>
      <dl className="channel-route-inspect-grid">
        <div>
          <dt>{t("Outcome")}</dt>
          <dd>{channelRouteDecisionOutcomeLabel(decision, t)}</dd>
        </div>
        <div>
          <dt>{t("Route mode")}</dt>
          <dd>{channelRouteDecisionModeLabel(decision, t) || decision.mode}</dd>
        </div>
        <div>
          <dt>{t("Selected teammate")}</dt>
          <dd>{formatSelectedTeammate(decision.selectedTeammateId, teammates, t)}</dd>
        </div>
        <div>
          <dt>{t("Provider preset")}</dt>
          <dd>{decision.selectedProviderPresetId || contextPack?.providerPresetId || t("Not recorded")}</dd>
        </div>
        <div>
          <dt>{t("Model")}</dt>
          <dd>{contextPack?.modelId || t("Not recorded")}</dd>
        </div>
        <div>
          <dt>{t("Created by")}</dt>
          <dd>{channelRouteDecisionCreatedByLabel(decision, t)}</dd>
        </div>
        <div>
          <dt>{t("Source message")}</dt>
          <dd>{decision.sourceMessageId}</dd>
        </div>
        <div>
          <dt>{t("Reply message")}</dt>
          <dd>{decision.replyMessageId || t("None")}</dd>
        </div>
        {decision.errorMessage ? (
          <div>
            <dt>{t("Error")}</dt>
            <dd>{decision.errorMessage}</dd>
          </div>
        ) : null}
      </dl>
      {decision.alternativesConsidered.length > 0 ? (
        <div className="channel-route-inspect-section">
          <span>{t("Alternatives considered")}</span>
          <ul>
            {decision.alternativesConsidered.map((alternative, index) => (
              <li key={`${alternative.teammateId ?? alternative.label}:${index}`}>
                <strong>
                  {alternative.teammateId
                    ? `${teammateLabel(alternative.teammateId, teammates, t("Deleted teammate"))} (${alternative.teammateId})`
                    : alternative.label}
                </strong>
                <small>{alternative.reason}</small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {contextPack ? (
        <div className="channel-route-inspect-section">
          <span>{t("Context source metadata")}</span>
          <dl className="channel-route-inspect-grid">
            <div>
              <dt>{t("Sources")}</dt>
              <dd>{formatRouteSourceRefCounts(contextPack.sourceRefCounts) || t("None")}</dd>
            </div>
            <div>
              <dt>{t("Compactions")}</dt>
              <dd>{contextPack.compactionIds.length > 0 ? t("{count} compacted context summaries", { count: contextPack.compactionIds.length }) : t("None")}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p>{t("No inspectable context source metadata was recorded for this route decision.")}</p>
      )}
    </>
  );
}

function ChannelIntentInspectContent({
  decision,
  teammates,
  t,
}: {
  readonly decision: ChannelIntentDecision;
  readonly teammates: readonly ChannelMention[];
  readonly t: Translate;
}): JSX.Element {
  const replyMessageIds = uniqueStrings([decision.replyMessageId, ...(decision.replyMessageIds ?? [])].filter((id): id is string => Boolean(id)));
  return (
    <>
      <p>{channelIntentDecisionUserReason(decision, t)}</p>
      <dl className="channel-route-inspect-grid">
        <div>
          <dt>{t("Outcome")}</dt>
          <dd>{channelIntentDecisionOutcomeLabel(decision, t)}</dd>
        </div>
        <div>
          <dt>{t("Intent action")}</dt>
          <dd>{channelIntentDecisionActionLabel(decision.action, t)}</dd>
        </div>
        <div>
          <dt>{t("Selected teammate")}</dt>
          <dd>{formatIntentDecisionTeammates(decision, teammates, t)}</dd>
        </div>
        <div>
          <dt>{t("Created by")}</dt>
          <dd>{channelIntentDecisionCreatedByLabel(decision, t)}</dd>
        </div>
        <div>
          <dt>{t("Source message")}</dt>
          <dd>{decision.sourceMessageId}</dd>
        </div>
        <div>
          <dt>{t("Reply messages")}</dt>
          <dd>{formatOptionalIdList(replyMessageIds, t)}</dd>
        </div>
        <div>
          <dt>{t("Proposal")}</dt>
          <dd>{decision.proposalId || t("None")}</dd>
        </div>
        <div>
          <dt>{t("Workflow")}</dt>
          <dd>{decision.workflowId || t("None")}</dd>
        </div>
        {decision.errorMessage ? (
          <div>
            <dt>{t("Error")}</dt>
            <dd>{decision.errorMessage}</dd>
          </div>
        ) : null}
      </dl>
    </>
  );
}

function channelRouteDecisionSummaryLabel(decision: ChannelMessageRouteDecision, t: Translate): string {
  if (decision.status === "failed") {
    return t("Auto reply failed");
  }
  if (decision.status === "accepted") {
    return channelRouteDecisionModeLabel(decision, t) || t("Reply created");
  }
  return t("Not auto-replied");
}

function channelRouteDecisionModeLabel(decision: ChannelMessageRouteDecision, t: Translate): string {
  if (decision.mode === "default_teammate") {
    return t("Default teammate");
  }
  if (decision.mode === "auto_route") {
    return t("Auto routed");
  }
  return "";
}

function channelRouteDecisionInspectTitle(decision: ChannelMessageRouteDecision, t: Translate): string {
  if (decision.status === "failed") {
    return t("Auto reply failed");
  }
  if (decision.status === "suppressed") {
    return t("Not auto-replied");
  }
  if (decision.mode === "default_teammate") {
    return t("The channel default teammate answered this message.");
  }
  if (decision.mode === "auto_route") {
    return t("Ling selected this teammate for the reply.");
  }
  return t("Reply created");
}

function channelRouteDecisionOutcomeLabel(decision: ChannelMessageRouteDecision, t: Translate): string {
  if (decision.status === "accepted") {
    return t("Reply created");
  }
  if (decision.status === "failed") {
    return t("Failed closed");
  }
  return t("Suppressed");
}

function channelRouteDecisionCreatedByLabel(decision: ChannelMessageRouteDecision, t: Translate): string {
  switch (decision.createdBy) {
    case "explicit_mention":
      return t("Explicit mention");
    case "deterministic":
      return t("Deterministic rule");
    case "model":
      return t("Model selector");
  }
}

function formatRouteSourceRefCounts(counts: Readonly<Record<string, number>> | undefined): string {
  if (!counts) {
    return "";
  }
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");
}

function channelIntentDecisionSummaryLabel(decision: ChannelIntentDecision, t: Translate): string {
  if (decision.status === "failed") {
    return t("Intent failed");
  }
  return channelIntentDecisionActionLabel(decision.action, t);
}

function channelIntentDecisionInspectTitle(decision: ChannelIntentDecision, t: Translate): string {
  if (decision.status === "failed") {
    return t("Intent failed");
  }
  return t("Why Ling handled this message this way");
}

function channelIntentDecisionOutcomeLabel(decision: ChannelIntentDecision, t: Translate): string {
  if (decision.status === "accepted") {
    return t("Accepted");
  }
  if (decision.status === "failed") {
    return t("Failed closed");
  }
  return t("Suppressed");
}

function channelIntentDecisionActionLabel(action: ChannelIntentDecision["action"], t: Translate): string {
  switch (action) {
    case "no_reply":
      return t("No reply");
    case "single_reply":
      return t("Single reply");
    case "visible_multi_reply":
      return t("Visible multi-reply");
    case "clarify":
      return t("Clarify");
    case "workflow_proposal":
      return t("Workflow proposal");
    case "direct_workflow":
      return t("Direct workflow proposal");
  }
}

function channelIntentDecisionCreatedByLabel(decision: ChannelIntentDecision, t: Translate): string {
  return decision.createdBy === "model" ? t("Model selector") : t("Deterministic rule");
}

function channelIntentDecisionUserReason(decision: ChannelIntentDecision, t: Translate): string {
  if (decision.errorMessage) {
    return t("Ling could not safely handle this channel intent.");
  }
  return decision.reason || channelIntentDecisionActionLabel(decision.action, t);
}

function formatSelectedTeammate(teammateId: string | undefined, teammates: readonly ChannelMention[], t: Translate): string {
  if (!teammateId) {
    return t("None");
  }
  return `${teammateLabel(teammateId, teammates, t("Deleted teammate"))} (${teammateId})`;
}

function formatIntentDecisionTeammates(
  decision: ChannelIntentDecision,
  teammates: readonly ChannelMention[],
  t: Translate,
): string {
  const ids = uniqueStrings([decision.selectedTeammateId, ...(decision.selectedTeammateIds ?? [])].filter((id): id is string => Boolean(id)));
  if (ids.length === 0) {
    return t("None");
  }
  return ids.map((id) => `${teammateLabel(id, teammates, t("Deleted teammate"))} (${id})`).join(", ");
}

function formatOptionalIdList(ids: readonly string[], t: Translate): string {
  return ids.length > 0 ? ids.join(", ") : t("None");
}

function channelRouteDecisionUserReason(decision: ChannelMessageRouteDecision, t: Translate): string {
  const errorText = decision.errorMessage?.trim();
  if (decision.status === "accepted") {
    return decision.reason || channelRouteDecisionInspectTitle(decision, t);
  }
  if (decision.status === "failed") {
    if (errorText?.includes("strict JSON object") || errorText?.includes("JSON object") || errorText?.includes("schema")) {
      return t("The route selector returned invalid output, so Ling did not create an automatic reply.");
    }
    if (errorText?.includes("unknown teammate")) {
      return t("The route selector chose a teammate that is not available in this channel.");
    }
    if (errorText?.includes("No runnable provider")) {
      return t("No runnable provider is available for the selected teammate.");
    }
    return t("Ling could not safely create an automatic reply.");
  }

  switch (decision.reason) {
    case "Message is not reply-worthy.":
      return t("This message looks like a note or acknowledgement, not a request for an AI reply.");
    case "Repeated short greeting was suppressed.":
      return t("A similar short greeting was already answered recently.");
    case "Message is empty.":
      return t("The message has no content for an AI teammate to answer.");
    case "Thread replies are outside the first auto-reply scope.":
      return t("Automatic replies currently only run for root channel messages.");
    case "Channel is not active.":
      return t("This channel is not active, so Ling did not create an automatic reply.");
    case "No active teammate candidate has a runnable provider.":
    case "Channel default teammate is missing, inactive, or not runnable.":
      return t("No runnable teammate is available to answer this message.");
    case "Channel auto_route feature flag is disabled.":
      return t("Automatic routing is not enabled for this workspace.");
    case "Route model confidence was below threshold.":
      return t("Ling was not confident enough to choose one teammate automatically.");
    case "An AI reply already exists for this source message.":
      return t("This message already has an AI reply.");
    default:
      return t("Ling decided not to create an automatic reply for this message.");
  }
}

function messageAuthorLabel(
  message: ChannelMessage,
  teammates: readonly ChannelMention[],
  deletedTeammateLabel = "Deleted teammate",
  localUserLabel = "You",
  teammateById?: ReadonlyMap<string, { readonly displayName: string }>,
): string {
  if (message.authorType === "system") {
    return "Ling Stack";
  }
  if (message.authorType === "ai-teammate") {
    if (message.authorId === LING_AGENT_AUTHOR_ID) {
      return teammateLabel(message.authorId, teammates, LING_AGENT_AUTHOR_LABEL, teammateById);
    }
    return teammateLabel(message.authorId, teammates, deletedTeammateLabel, teammateById);
  }
  return localUserLabel;
}

const LING_AGENT_AUTHOR_ID = "ling_agent";
const LING_AGENT_AUTHOR_LABEL = "Ling Agent";

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

function proposalToEditDraft(proposal: ChannelExecutionProposal): ChannelProposalEditDraft {
  const collaborationSteps = proposal.collaborationSteps.length > 0
    ? proposal.collaborationSteps
    : [{ teammateId: proposal.assigneeTeammateId, action: "coordinated", summary: "Complete the confirmed execution proposal." } satisfies ChannelProposalStepDraft];
  return {
    title: proposal.title,
    prompt: proposal.prompt,
    assigneeTeammateId: proposal.assigneeTeammateId,
    acceptanceCriteriaText: proposal.acceptanceCriteria.join("\n"),
    shapingSummaryText: proposal.shaping?.summary ?? "",
    shapingOpenQuestionsText: proposal.shaping?.openQuestions.join("\n") ?? "",
    shapingClarificationsText: proposal.shaping?.clarifications.map((clarification) => clarification.body).join("\n") ?? "",
    collaborationSteps,
  };
}

function proposalDraftIsValid(draft: ChannelProposalEditDraft): boolean {
  return draft.title.trim().length > 0 &&
    draft.prompt.trim().length > 0 &&
    draft.assigneeTeammateId.trim().length > 0 &&
    parseProposalLines(draft.acceptanceCriteriaText).length > 0 &&
    draft.collaborationSteps.length > 0 &&
    draft.collaborationSteps.every((step) => step.teammateId.trim().length > 0 && step.summary.trim().length > 0);
}

function proposalDraftToUpdateInput(proposal: ChannelExecutionProposal, draft: ChannelProposalEditDraft): UpdateChannelExecutionProposalRequest {
  return {
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    assigneeTeammateId: draft.assigneeTeammateId.trim(),
    acceptanceCriteria: parseProposalLines(draft.acceptanceCriteriaText),
    collaborationSteps: draft.collaborationSteps.map((step) => ({
      teammateId: step.teammateId.trim(),
      action: step.action,
      summary: step.summary.trim(),
      ...(step.sources && step.sources.length > 0 ? { sources: step.sources } : {}),
    })),
    shaping: proposalShapingFromEditDraft(proposal, draft),
  };
}

function buildRequirementShapingRows(input: {
  readonly proposal: ChannelExecutionProposal;
  readonly assigneeLabel: string;
  readonly t: Translate;
}): readonly RequirementShapingRow[] {
  const participantCount = Math.max(1, input.proposal.collaborationSteps.length);
  const firstCriterion = input.proposal.acceptanceCriteria[0];
  const openQuestionCount = input.proposal.shaping?.openQuestions.length ?? 0;
  const clarificationCount = input.proposal.shaping?.clarifications.length ?? 0;
  const shapingSummary = input.proposal.shaping?.summary;
  return [
    {
      id: "goal",
      label: input.t("Goal"),
      value: truncatePreview(shapingSummary || input.proposal.prompt, 180),
    },
    {
      id: "acceptance",
      label: input.t("Acceptance"),
      value: firstCriterion
        ? truncatePreview(firstCriterion, 150)
        : input.t("Acceptance checks will be clarified before execution."),
      tone: firstCriterion ? "success" : "attention",
    },
    {
      id: "participants",
      label: input.t("Participants"),
      value: input.t("{count} teammate(s), led by {teammate}", {
        count: participantCount,
        teammate: input.assigneeLabel,
      }),
    },
    {
      id: "risk",
      label: input.t("Boundary"),
      value: input.proposal.riskSummary
        ? truncatePreview(input.proposal.riskSummary, 150)
        : input.t("No additional boundary surfaced yet."),
      tone: input.proposal.riskSummary ? "attention" : "neutral",
    },
    {
      id: "questions",
      label: input.t("Open questions"),
      value: openQuestionCount > 0
        ? input.t("{count} open question(s)", { count: openQuestionCount })
        : clarificationCount > 0
          ? input.t("{count} clarification(s) recorded", { count: clarificationCount })
          : input.t("No open questions recorded."),
      tone: openQuestionCount > 0 ? "attention" : clarificationCount > 0 ? "success" : "neutral",
    },
    {
      id: "next",
      label: input.t("Next action"),
      value: input.t("Authorize when the scope looks right, or edit the card first."),
    },
  ];
}

function proposalShapingFromEditDraft(
  proposal: ChannelExecutionProposal,
  draft: ChannelProposalEditDraft,
): NonNullable<UpdateChannelExecutionProposalRequest["shaping"]> {
  const openQuestions = parseProposalLines(draft.shapingOpenQuestionsText);
  const clarificationBodies = parseProposalLines(draft.shapingClarificationsText);
  const existingClarifications = proposal.shaping?.clarifications ?? [];
  const now = new Date().toISOString();
  return {
    status: openQuestions.length > 0 ? "needs_user_clarification" : "ready_for_confirmation",
    summary: draft.shapingSummaryText.trim() || draft.title.trim(),
    openQuestions,
    clarifications: clarificationBodies.map((body, index) => {
      const existing = existingClarifications[index];
      if (existing?.body === body) {
        return existing;
      }
      return {
        id: `clarification_${proposal.id}_${index + 1}`,
        authorType: "local-user",
        body,
        sourceMessageId: proposal.sourceMessageId,
        createdAt: now,
      };
    }),
    sourceRefs: proposal.shaping?.sourceRefs.length
      ? proposal.shaping.sourceRefs
      : [{ type: "message", id: proposal.sourceMessageId }],
    updatedAt: now,
  };
}

function parseProposalLines(value: string): readonly string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

interface ProposalPermissionSummary {
  readonly sentence: string;
  readonly toolLabel: string;
  readonly targetLabel: string;
  readonly executorLabel: string;
}

function buildProposalPermissionSummary(input: {
  readonly proposal: ChannelExecutionProposal;
  readonly assigneeLabel: string;
  readonly t: Translate;
}): ProposalPermissionSummary {
  const { proposal, t } = input;
  const primaryTool = proposalPermissionPrimaryTool(proposal.requiredTools);
  const targetLabel = extractProposalPermissionTarget(proposal, primaryTool) ?? t("declared task scope");
  const toolLabel = proposal.requiredTools.length > 0 ? proposal.requiredTools.join(", ") : t("workspace tools");
  const sentence = proposalPermissionSentence({
    tool: primaryTool,
    targetLabel,
    t,
  });
  return {
    sentence,
    toolLabel,
    targetLabel,
    executorLabel: input.assigneeLabel,
  };
}

function proposalPermissionPrimaryTool(
  tools: readonly ChannelExecutionProposal["requiredTools"][number][],
): ChannelExecutionProposal["requiredTools"][number] | undefined {
  if (tools.includes("write")) {
    return "write";
  }
  if (tools.includes("edit")) {
    return "edit";
  }
  if (tools.includes("bash")) {
    return "bash";
  }
  return tools[0];
}

function proposalPermissionSentence(input: {
  readonly tool?: ChannelExecutionProposal["requiredTools"][number];
  readonly targetLabel: string;
  readonly t: Translate;
}): string {
  if (input.tool === "write") {
    return input.t("Need write permission to create {target} for this task.", { target: input.targetLabel });
  }
  if (input.tool === "edit") {
    return input.t("Need edit permission to update {target} for this task.", { target: input.targetLabel });
  }
  if (input.tool === "bash") {
    return input.t("Need bash permission to run {target} for this task.", { target: input.targetLabel });
  }
  if (input.tool) {
    return input.t("Need {tool} permission for {target} in this task.", { tool: input.tool, target: input.targetLabel });
  }
  return input.t("Confirm this bounded task scope before Ling starts.");
}

function extractProposalPermissionTarget(
  proposal: ChannelExecutionProposal,
  primaryTool?: ChannelExecutionProposal["requiredTools"][number],
): string | undefined {
  const sources = [proposal.riskSummary, proposal.prompt, proposal.title].filter((value): value is string => Boolean(value?.trim()));
  if (primaryTool === "bash") {
    const command = sources.map(extractProposalCommandTarget).find((value): value is string => Boolean(value));
    if (command) {
      return command;
    }
  }
  const path = sources.map(extractProposalPathTarget).find((value): value is string => Boolean(value));
  if (path) {
    return path;
  }
  return primaryTool === "bash" ? trimPermissionTarget(proposal.title.replace(/^run\s+/iu, "")) : undefined;
}

function extractProposalCommandTarget(value: string): string | undefined {
  const explicitCommand = /Command requested by user:\s*([^\n]+)/iu.exec(value)?.[1];
  if (explicitCommand) {
    return trimPermissionTarget(explicitCommand);
  }
  const riskCommand = /(?:run|运行)\s+(.+?)(?:[；;\n]|$)/iu.exec(value)?.[1];
  if (riskCommand) {
    return trimPermissionTarget(riskCommand);
  }
  return undefined;
}

function extractProposalPathTarget(value: string): string | undefined {
  const matches = value.match(/(?:\/[^\s`"'，。；;:)]+|(?:\.{1,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.[A-Za-z0-9]{1,8})/gu) ?? [];
  return matches
    .map(trimPermissionTarget)
    .find((candidate) => Boolean(candidate && !candidate.startsWith("http://") && !candidate.startsWith("https://")));
}

function trimPermissionTarget(value: string): string | undefined {
  const trimmed = value.trim().replace(/^[`"']+/u, "").replace(/[`"',，。；;:)]+$/u, "").replace(/\.$/u, "");
  return trimmed ? truncatePreview(trimmed, 180) : undefined;
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

function requirementShapingStatusLabel(status: NonNullable<ChannelExecutionProposal["shaping"]>["status"]): string {
  if (status === "collecting_context") {
    return "Collecting context";
  }
  if (status === "collecting_teammate_input") {
    return "Collecting teammate input";
  }
  if (status === "needs_user_clarification") {
    return "Needs user clarification";
  }
  if (status === "converted_to_task") {
    return "Converted to task";
  }
  if (status === "dismissed") {
    return "Dismissed";
  }
  return "Ready for confirmation";
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

function proposalStepSourceLabel(
  step: ChannelExecutionProposal["collaborationSteps"][number],
  t: Translate,
): string {
  const councilSource = step.sources?.find((source) => source.kind === "council");
  if (councilSource) {
    return t("From {source}", { source: councilSource.councilDisplayName ?? t("AI council") });
  }
  const directSource = step.sources?.find((source) => source.kind === "direct");
  if (directSource?.isDefault) {
    return t("Default channel teammate");
  }
  return directSource ? t("Direct channel teammate") : "";
}

function workflowStepSourceLabel(
  metadata: NonNullable<ChannelWorkflowStep["metadata"]>,
  t: Translate,
): string {
  const councilSource = metadata.proposalStepSources?.find((source) => source.kind === "council");
  if (councilSource) {
    return t("From {source}", { source: councilSource.councilDisplayName ?? t("AI council") });
  }
  const directSource = metadata.proposalStepSources?.find((source) => source.kind === "direct");
  if (directSource?.isDefault) {
    return t("Default channel teammate");
  }
  return directSource ? t("Direct channel teammate") : "";
}

function proposalCollaborationSummary(
  proposal: ChannelExecutionProposal,
  teammates: readonly ChannelMention[],
  t: Translate,
): string {
  return proposal.collaborationSteps
    .slice(0, 2)
    .map((step) => {
      const teammate = teammateLabel(step.teammateId, teammates, t("Deleted teammate"));
      const summary = step.summary.trim() || t(proposalStepActionLabel(step.action));
      return `${teammate} ${summary}`;
    })
    .join(" · ");
}

function findMentionsInText(body: string, teammates: readonly ChannelMention[]): readonly ChannelMention[] {
  return teammates.filter((teammate) => mentionTokenExistsInText(body, teammate));
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
  return mentionAliases(mention).some((token) => {
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

function serializeCustomActivitySavedViews(views: readonly ChannelActivitySavedView[]): readonly Record<string, unknown>[] {
  return views
    .filter((view) => !view.builtin)
    .slice(0, maxCustomChannelActivitySavedViews)
    .map((view) => ({
      id: view.id,
      name: view.name,
      filter: view.filter,
      builtin: false,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    }));
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

function channelWorkspaceModeLabel(mode: ChannelWorkspaceMode): string {
  if (mode === "managed_worktree") {
    return "Worktree";
  }
  if (mode === "external_path") {
    return "External";
  }
  return "Local";
}

function channelWorkspaceModeIcon(mode: ChannelWorkspaceMode, size: number): JSX.Element {
  if (mode === "managed_worktree") {
    return <GitBranch size={size} />;
  }
  if (mode === "external_path") {
    return <FolderOpen size={size} />;
  }
  return <Command size={size} />;
}

function shortWorkspacePath(path: string, cwd: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }
  const workspace = cwd.trim().replace(/\/$/, "");
  if (workspace && trimmed === workspace) {
    return ".";
  }
  if (workspace && trimmed.startsWith(`${workspace}/`)) {
    return `.${trimmed.slice(workspace.length)}`;
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length <= 3) {
    return trimmed;
  }
  return `.../${parts.slice(-3).join("/")}`;
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

function runProgressTone(status: RunSession["status"]): AttentionProgressTone {
  if (status === "succeeded") {
    return "success";
  }
  if (status === "running" || status === "queued") {
    return "running";
  }
  if (status === "waiting_for_approval") {
    return "waiting";
  }
  if (status === "failed") {
    return "failed";
  }
  return "neutral";
}

function runProgressIcon(status: RunSession["status"]): JSX.Element {
  if (status === "succeeded") {
    return <CheckCircle2 size={18} />;
  }
  if (status === "running") {
    return <Loader2 className="spin" size={18} />;
  }
  if (status === "waiting_for_approval") {
    return <ShieldCheck size={18} />;
  }
  if (status === "failed") {
    return <CircleAlert size={18} />;
  }
  if (status === "cancelled") {
    return <X size={18} />;
  }
  return <Clock3 size={18} />;
}

function buildWorkflowAttentionProgressRows(input: {
  readonly items: readonly CollaborationProgressProjectionItem[];
  readonly onOpen?: () => void;
}): readonly AttentionProgressRow[] {
  return input.items.map((item) => ({
    id: item.id,
    icon: collaborationProgressIcon(item.icon),
    tone: collaborationProgressTone(item.tone),
    primary: item.primary,
    secondary: item.secondary,
    onOpen: input.onOpen,
  }));
}

function collaborationProgressTone(tone: CollaborationProgressProjectionTone): AttentionProgressTone {
  return tone;
}

function collaborationProgressIcon(icon: CollaborationProgressProjectionIcon): JSX.Element {
  if (icon === "blocked" || icon === "failed") {
    return <CircleAlert size={18} />;
  }
  if (icon === "waiting") {
    return <ShieldCheck size={18} />;
  }
  if (icon === "success") {
    return <CheckCircle2 size={18} />;
  }
  if (icon === "running") {
    return <Loader2 className="spin" size={18} />;
  }
  return <Workflow size={18} />;
}

function deriveWorkspaceThreadsFromRuns(runs: readonly RunSession[]): readonly LingThread[] {
  const runsByThreadId = new Map<string, RunSession[]>();
  for (const run of runs) {
    if (!run.threadId) {
      continue;
    }
    runsByThreadId.set(run.threadId, [...(runsByThreadId.get(run.threadId) ?? []), run]);
  }
  return [...runsByThreadId.entries()].map(([threadId, threadRuns]) => {
    const latestRun = [...threadRuns].sort((left, right) => compareRunActivity(right, left))[0];
    const oldestRun = [...threadRuns].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    return {
      id: threadId,
      workspaceId: "workspace_default",
      kind: "task",
      channelId: latestRun.channelId,
      taskId: latestRun.taskId,
      teammateId: latestRun.teammateId,
      title: readTaskTitle(latestRun.taskSnapshot) || latestRun.taskId,
      objective: readTaskPrompt(latestRun.taskSnapshot) || readTaskTitle(latestRun.taskSnapshot) || latestRun.taskId,
      status: lingThreadStatusFromWorkspaceRun(latestRun),
      activeRunId: runCanBeStopped(latestRun) ? latestRun.id : undefined,
      lastRunId: latestRun.id,
      createdAt: oldestRun.createdAt,
      updatedAt: latestRun.updatedAt || latestRun.createdAt,
    } satisfies LingThread;
  });
}

function mergeLingThreads(...groups: readonly (readonly LingThread[])[]): readonly LingThread[] {
  const byId = new Map<string, LingThread>();
  for (const group of groups) {
    for (const thread of group) {
      const existing = byId.get(thread.id);
      if (!existing || thread.updatedAt >= existing.updatedAt) {
        byId.set(thread.id, { ...existing, ...thread });
      }
    }
  }
  return [...byId.values()];
}

function isChannelDiscussionRootThread(thread: LingThread, channelId: string | undefined): boolean {
  return thread.kind === "channel_discussion" &&
    Boolean(channelId) &&
    thread.channelId === channelId &&
    !thread.parentThreadId &&
    !thread.taskId &&
    !thread.teammateId &&
    !thread.workflowId &&
    !thread.workflowStepId &&
    !thread.externalWorkId;
}

function filterChannelBranchThreads(threads: readonly LingThread[], activeThreadId: string): readonly LingThread[] {
  const lineageParentThreadIds = new Set<string>();
  for (const thread of threads) {
    if (thread.parentThreadId) {
      lineageParentThreadIds.add(thread.parentThreadId);
    }
  }
  return threads.filter((thread) =>
    thread.kind === "channel_discussion" ||
    thread.kind === "task" ||
    Boolean(thread.parentThreadId) ||
    lineageParentThreadIds.has(thread.id) ||
    Boolean(thread.pinnedAt) ||
    (Boolean(activeThreadId) && thread.id === activeThreadId)
  );
}

function proposalShouldHideInDefaultFeed(proposal: ChannelExecutionProposal, workflows: readonly ChannelWorkflow[]): boolean {
  if (proposal.status === "accepted" && proposal.linkedWorkflowId) {
    return true;
  }
  return proposalHasTerminalWorkflow(proposal, workflows);
}

function proposalHasTerminalWorkflow(proposal: ChannelExecutionProposal, workflows: readonly ChannelWorkflow[]): boolean {
  if (!proposal.linkedWorkflowId) {
    return false;
  }
  const workflow = workflows.find((candidate) => candidate.id === proposal.linkedWorkflowId);
  return Boolean(workflow && workflowIsTerminal(workflow.status));
}

function workflowIsTerminal(status: ChannelWorkflow["status"]): boolean {
  return status === "succeeded" || status === "blocked" || status === "failed" || status === "cancelled";
}

function buildChannelWorkThreadTree(threads: readonly LingThread[]): ReadonlyArray<{
  readonly thread: LingThread;
  readonly depth: number;
  readonly parentHidden: boolean;
}> {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const childIdsByParent = new Map<string, string[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) {
      continue;
    }
    childIdsByParent.set(thread.parentThreadId, [...(childIdsByParent.get(thread.parentThreadId) ?? []), thread.id]);
  }
  const roots = threads
    .filter((thread) => !thread.parentThreadId || !threadById.has(thread.parentThreadId))
    .map((thread) => thread.id);
  const rows: Array<{ readonly thread: LingThread; readonly depth: number; readonly parentHidden: boolean }> = [];
  const visited = new Set<string>();
  const sortIds = (ids: readonly string[]): string[] =>
    [...new Set(ids)].sort((leftId, rightId) =>
      Number(Boolean(threadById.get(rightId)?.pinnedAt)) - Number(Boolean(threadById.get(leftId)?.pinnedAt)) ||
      (threadById.get(rightId)?.pinnedAt ?? "").localeCompare(threadById.get(leftId)?.pinnedAt ?? "") ||
      (threadById.get(rightId)?.updatedAt ?? "").localeCompare(threadById.get(leftId)?.updatedAt ?? "") ||
      leftId.localeCompare(rightId));
  const visit = (threadId: string, depth: number, parentHidden: boolean): void => {
    if (visited.has(threadId)) {
      return;
    }
    const thread = threadById.get(threadId);
    if (!thread) {
      return;
    }
    visited.add(threadId);
    rows.push({ thread, depth, parentHidden });
    for (const childId of sortIds(childIdsByParent.get(threadId) ?? [])) {
      visit(childId, Math.min(depth + 1, 6), false);
    }
  };
  for (const rootId of sortIds(roots)) {
    const root = threadById.get(rootId);
    visit(rootId, 0, Boolean(root?.parentThreadId && !threadById.has(root.parentThreadId)));
  }
  for (const thread of threads) {
    if (!visited.has(thread.id)) {
      rows.push({ thread, depth: 0, parentHidden: Boolean(thread.parentThreadId) });
    }
  }
  return rows;
}

function compareRunActivity(left: RunSession, right: RunSession): number {
  const leftTime = left.updatedAt || left.endedAt || left.startedAt || left.createdAt;
  const rightTime = right.updatedAt || right.endedAt || right.startedAt || right.createdAt;
  return leftTime.localeCompare(rightTime);
}

function lingThreadStatusFromWorkspaceRun(run: RunSession): LingThread["status"] {
  if (run.status === "queued") {
    return "open";
  }
  return run.status;
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

function summarizeChannelGuidancePayload(
  payload: {
    readonly body: string;
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
    readonly fileRefs?: readonly ChannelMessageFileRef[];
  },
  t: Translate,
): string {
  if (payload.body.trim()) {
    return payload.body.trim();
  }
  if (payload.fileRefs?.length) {
    return t("Queued guidance with {count} file reference(s)", { count: payload.fileRefs.length });
  }
  if (payload.attachmentIds.length > 0 && payload.linkPreviewIds.length > 0) {
    return t("Queued guidance with {attachmentCount} attachment(s) and {linkCount} link(s)", {
      attachmentCount: payload.attachmentIds.length,
      linkCount: payload.linkPreviewIds.length,
    });
  }
  if (payload.attachmentIds.length > 0) {
    return t("Queued guidance with {count} attachment(s)", { count: payload.attachmentIds.length });
  }
  if (payload.linkPreviewIds.length > 0) {
    return t("Queued guidance with {count} link(s)", { count: payload.linkPreviewIds.length });
  }
  return t("Queued guidance");
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

function findActiveSlashCommand(
  value: string,
  caret: number,
): ActiveSlashCommandPicker | undefined {
  const beforeCaret = value.slice(0, caret);
  const match = /(^|[\s([{])\/([A-Za-z0-9_.-]{0,48})$/.exec(beforeCaret);
  if (!match) {
    return undefined;
  }
  const slashStart = beforeCaret.length - (match[2]?.length ?? 0) - 1;
  if (!slashCommandCanOpenAt(value, slashStart)) {
    return undefined;
  }
  return {
    query: match[2] ?? "",
    start: slashStart,
    end: caret,
  };
}

function slashCommandCanOpenAt(
  value: string,
  slashStart: number,
): boolean {
  if (slashStart === 0) {
    return true;
  }
  return !/[/:]/u.test(value.slice(0, slashStart).trimEnd().at(-1) ?? "");
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

function insertSlashCommandToken(value: string, picker: ActiveSlashCommandPicker | undefined, commandId: string): { readonly value: string; readonly caret: number } {
  const start = Math.max(0, Math.min(picker?.start ?? value.length, value.length));
  const end = Math.max(start, Math.min(picker?.end ?? value.length, value.length));
  const prefix = value.slice(0, start);
  const suffix = value.slice(end).replace(/^\s+/, "");
  const command = `/${commandId}`;
  return {
    value: `${prefix}${command}${suffix ? ` ${suffix}` : " "}`,
    caret: prefix.length + command.length + 1,
  };
}

function composerSlashCommandTargetLabel(intent: Exclude<ComposerSlashIntent, { readonly kind: "none" }>, t: Translate): string {
  if (intent.kind === "multi_agent_command") {
    return intent.teammates.map((teammate) => `@${teammate.label}`).join(" ");
  }
  if (intent.kind === "agent_command") {
    return `@${intent.teammateLabel}`;
  }
  return t("Channel");
}

function normalizeComposerToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function mentionAliases(mention: Pick<ChannelMention, "id" | "label">): readonly string[] {
  return uniqueStrings([
    mention.label.trim(),
    mention.id.trim(),
    normalizeComposerToken(mention.label),
    normalizeComposerToken(mention.id),
  ]).filter(Boolean);
}

function chooseMostSpecificMentionPicker(candidates: readonly (ActiveMentionPicker | undefined)[]): ActiveMentionPicker | undefined {
  return candidates
    .filter((candidate): candidate is ActiveMentionPicker => Boolean(candidate))
    .sort((left, right) => (right.end - right.start) - (left.end - left.start))[0];
}

function isLingAgentTeammate(teammate: { readonly id: string; readonly systemRole?: string }): boolean {
  return teammate.id === LING_AGENT_AUTHOR_ID || teammate.systemRole === "ling_agent";
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
