import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import type { ConversationRuntimeMetrics } from "@ling-stack/contracts";
import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import type { ChannelActivityTriageDraft, ChannelActivityTriageResult } from "../../lib/channel-activity-triage.js";
import type {
  ApprovalRequest,
  ApprovalPolicy,
  AuthorizationMode,
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
  ConversationItemV1,
  TurnContextAssignment,
  UserInputTranscriptItemV1,
  ConversationGeneratedMedia,
  ChannelMessageFileRef,
  ChannelReplyPendingEvent,
  ChannelMessageRouteDecision,
  ChannelReplyDispatch,
  ChannelReplyDisposition,
  ConversationActiveReplyTarget,
  ChannelExecutionProposal,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelWorkflowStepStartMode,
  ExecutionAction,
  GovernanceNotification,
  ExternalWorkActionView,
  ExternalWorkCiTriageView,
  MemoryObject,
  ProviderPreset,
  ResourceLease,
  RuntimeDiagnosticsResponse,
  RunArtifact,
  RunSession,
  PermissionPreset,
  PermissionConfirmation,
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
  ErrorPresentationOptions,
  UserProfile,
} from "../../types.js";
import type { ApprovalResolution } from "../approvals/types.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import type { ChannelTeammateRelationFeedback } from "./ChannelSettingsPanels.js";
import type { ChannelFeedbackEntry } from "./useChannelFeedbackController.js";
import type { ChannelStreamErrorOwner, ChannelStreamErrorOwnerHint } from "../../shared/conversation/stream-error-ownership.js";

export interface WorkspaceClientViewProps {
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
  readonly channelConversationItems: readonly ConversationItemV1[];
  readonly channelRuntimeMetrics?: ConversationRuntimeMetrics;
  readonly channelTurnContextAssignments: readonly TurnContextAssignment[];
  readonly channelUserInputs: readonly UserInputTranscriptItemV1[];
  readonly channelReasoningSummaries: readonly import("../../types.js").ConversationReasoningSummaryRecord[];
  readonly channelConversationRefreshToken: number;
  readonly channelContextCompactions: readonly import("../../types.js").ConversationContextCompactionRecord[];
  readonly channelGeneratedMedia: readonly ConversationGeneratedMedia[];
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
  readonly channelTeammateError: ChannelTeammateRelationFeedback | undefined;
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
  readonly approvalErrors: Readonly<Record<string, string>>;
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
  readonly cancellingRunIds: readonly string[];
  readonly approvalPolicy: ApprovalPolicy | undefined;
  readonly authorizationMode: AuthorizationMode;
  readonly permissionMode: SessionPermissionMode;
  readonly permissionPreset?: PermissionPreset;
  readonly fullAccessConfirmed: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly runningWorkflowStepId: string;
  readonly orchestratingWorkflowId: string;
  readonly channelFeedbackEntries: readonly ChannelFeedbackEntry[];
  readonly onClearChannelFeedback: (surface: ChannelFeedbackEntry["surface"], identity: string, workspaceCwd: string) => void;
  readonly onChannelCreateOpenChange: (open: boolean) => void;
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onAddChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onRemoveChannelTeammate: (teammateId: string) => Promise<void>;
  readonly onOpenTeammates: () => void;
  readonly onRefreshChannels: () => void;
  readonly onSaveChannel: (formOverride?: ChannelFormState) => void | Promise<void>;
  readonly onCreateTask: () => Promise<boolean>;
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
    readonly streamOwner?: ChannelStreamErrorOwnerHint;
    readonly replyDisposition?: ChannelReplyDisposition;
    readonly onMessageAccepted?: (message: ChannelMessage) => void;
    readonly onReplyPending?: (pending: ChannelReplyPendingEvent) => void;
    readonly onReplyLinked?: (target: ConversationActiveReplyTarget) => void;
    readonly onReplyDispatch?: (dispatch: ChannelReplyDispatch) => void;
  }) => Promise<{ readonly errorMessage?: string; readonly errorOwner?: ChannelStreamErrorOwner }>;
  readonly onConfirmExecutionProposal: (proposal: ChannelExecutionProposal) => Promise<void>;
  readonly onCancelExecutionProposal: (proposal: ChannelExecutionProposal) => Promise<void>;
  readonly onUploadAttachments: (files: readonly File[]) => Promise<readonly ChannelAttachment[]>;
  readonly onCreateLinkPreview: (url: string) => Promise<ChannelLinkPreview | undefined>;
  readonly onDeleteAttachment: (attachmentId: string) => void;
  readonly onSaveBrief: (input: UpdateChannelBriefRequest) => void;
  readonly onSaveChannelProtocol: (input: UpdateChannelCollaborationProtocolRequest) => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly onRevertChannelProtocol: () => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly onSupersedeDecision: (decision: ChannelDecision) => Promise<void>;
  readonly onRejectDecision: (decision: ChannelDecision) => Promise<void>;
  readonly onCreateHandoffFromTask: (task: Task) => Promise<ChannelHandoff | undefined>;
  readonly onUpdateHandoffStatus: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => void;
  readonly onStartWorkflowFromHandoff: (handoff: ChannelHandoff) => Promise<void>;
  readonly onStartTemplateWorkflow: () => void;
  readonly onOrchestrateWorkflow: (workflow: ChannelWorkflow) => Promise<void>;
  readonly onCancelWorkflow: (workflow: ChannelWorkflow) => Promise<void>;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onRetryWorkflowStep: (step: ChannelWorkflowStep) => Promise<void>;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => Promise<void>;
  readonly onRunActivityTriageAction: (draft: ChannelActivityTriageDraft) => Promise<ChannelActivityTriageResult>;
  readonly onLoadOlderChannelMessages: () => void;
  readonly onRefreshChannelMessages: () => void;
  readonly onRefreshPendingChannelReply: () => void;
  readonly onRefreshChannelActivity: () => Promise<void>;
  readonly onRefreshExternalWorkCiTriage: () => void;
  readonly onRefreshWorkItems: () => void;
  readonly onRefreshChannelProtocol: () => void;
  readonly onRefreshChannelFiles: () => void;
  readonly onMarkChannelGovernanceNotificationSeen: (notificationId: string) => void;
  readonly onDismissChannelGovernanceNotification: (notificationId: string) => void;
  readonly onRefreshAiCouncils: () => void;
  readonly onRefreshChannelCouncil: () => void;
  readonly onUpdateChannelCouncilPolicy: (input: UpdateChannelCouncilPolicyRequest) => Promise<void>;
  readonly attachmentContentUrl: (attachment: ChannelAttachment) => string;
  readonly onRefreshTasks: () => void;
  readonly onRefreshRunApprovals: () => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
  readonly permissionSelectionOwnerKey: string;
  readonly onPermissionSelectionChange: (selection: import("../../shared/conversation/conversation-permission-selection.js").CompactPermissionSelection) => void;
  readonly onConfirmFullAccessSelection: () => Promise<PermissionConfirmation | undefined>;
  readonly onOpenSandboxSettings: () => void;
  readonly onCancelActiveRun: (run?: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onRefreshRuntime: () => void;
  readonly onCancelWorkUnit: (workUnitId: string) => void;
  readonly onRetryWorkUnit: (workUnitId: string) => void;
  readonly onReconcileWorkUnit: (workUnitId: string) => void;
  readonly onResolveApproval: (
    approvalId: string,
    decision: ApprovalResolution,
    reason?: string,
    proposedRuleFingerprint?: string,
  ) => void;
  readonly onClaimWorkItem: (workItemId: string) => void;
  readonly onHeartbeatWorkItem: (workItemId: string, claimToken: string) => void;
  readonly onReleaseWorkItem: (workItemId: string, claimToken: string) => void;
  readonly onCompleteWorkItem: (workItemId: string, claimToken: string) => void;
  readonly onFailWorkItem: (workItemId: string, claimToken: string) => void;
  readonly busyWorkItemId: string;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly workspaceSettings: WorkspaceSettings | undefined;
  readonly onWorkspaceSettingsPatch: (
    patch: UpdateWorkspaceSettingsRequest,
    options?: ErrorPresentationOptions,
  ) => void | Promise<WorkspaceSettings | undefined>;
}

export type ChannelSidePanelView = "context" | "settings" | "task";
