import { randomUUID } from "node:crypto";
import type {
  ConversationItemV1,
  CompactionCheckpoint,
  CreateCompactionCheckpointInput,
  CreatePostCompactionUndoRecordInput,
  CreateWorkspaceMutationRecordInput,
  LingThreadRelationKindV2,
  LingThreadSurfaceKindV2,
  ListCompactionCheckpointsOptions,
  ListPostCompactionUndoRecordsOptions,
  ListWorkspaceMutationRecordsOptions,
  RunEventDataByType as ContractRunEventDataByType,
  RunEventEnvelope as ContractRunEventEnvelope,
  RunEventType as ContractRunEventType,
  ExecutionActionDiagnostic,
  HostOpenLocalTargetReceiptV1,
  PostCompactionUndoRecord,
  UpdatePostCompactionUndoRecordInput,
  WorkspaceMutationRecord,
  CreateWorkspaceSnapshotEntryInput,
  CreateWorkspaceSnapshotManifestInput,
  CreateWorkspaceSnapshotRestoreAnchorInput,
  CreateSnapshotRestoreJournalEntryInput,
  CreateSnapshotRestoreRequestInput,
  ListSnapshotRestoreJournalOptions,
  ListWorkspaceSnapshotManifestsOptions,
  SnapshotRestoreJournalEntry,
  SnapshotRestoreRequest,
  UpdateSnapshotRestoreRequestInput,
  UpdateSnapshotRestoreJournalEntryInput,
  WorkspaceSnapshotBlob,
  WorkspaceSnapshotEntry,
  WorkspaceSnapshotManifest,
  WorkspaceSnapshotRestoreAnchor,
  CreateSnapshotRestoreConfirmationInput,
  SnapshotRestoreConfirmation,
  ListSnapshotRestoreRequestsOptions,
  RunnerContinuationV1,
  HarnessToolExecutionV1,
  RunEvaluationGradeV1,
  RunEvaluationV1,
  CreateRunCompactionCheckpointInput,
  ListRunCompactionCheckpointsOptions,
  RunCompactionCheckpointV1,
  TransitionRunCompactionCheckpointInput,
} from "@ling-stack/contracts";
import type {
  ClaimRunnerContinuationInput,
  DeferRunnerContinuationInput,
  FinishRunnerContinuationInput,
  ListClaimableRunnerContinuationsInput,
  PrepareContinuationInput,
  PreparedContinuation,
  ReprepareContinuationInput,
  RunnerContinuationMutationResult,
  StartRunnerContinuationInput,
} from "./harness/continuations.js";
import type { DelegationQueryStore, HarnessDiagnosticsStore } from "./harness/store-ports.js";
import type { RunEvaluationTaskStore } from "./harness/evaluation-tasks.js";
import type { RunEvaluationQaStore } from "./harness/evaluation-qa.js";
import type { RunEvaluationHumanStore } from "./harness/human-evaluation.js";
import type {
  AvailabilityIncidentCandidatePage,
  CreateProviderRuntimeAvailabilityIncidentInput,
  ListAvailabilityIncidentCandidatesOptions,
} from "./provider-runtime-availability-types.js";
import type {
  ClaimHarnessToolExecutionInput,
  FailApprovedHarnessToolExecutionInput,
  FinishHarnessToolExecutionInput,
  HarnessToolExecutionMutationResult,
  HarnessToolExecutionRecoveryPage,
  PrepareHarnessToolExecutionInput,
  PreparedHarnessToolExecution,
  ReconcileAbandonedHarnessToolExecutionsInput,
  ReconcileAbandonedHarnessToolExecutionsPageInput,
  ResolveHarnessToolApprovalInput,
  StartHarnessToolExecutionInput,
} from "./harness/tool-executions.js";
import type {
  AppendRunEvaluationGradeInput,
  AppendRunEvaluationGradeResult,
  ClaimRunEvaluationInput,
  CompleteRunEvaluationInput,
  CompleteRunEvaluationResult,
  EnqueuedRunEvaluation,
  EnqueueRunEvaluationInput,
  FailRunEvaluationInput,
  ListClaimableRunEvaluationsInput,
  ListRunEvaluationsInput,
  RequeueRunEvaluationInput,
  RunEvaluationMutationResult,
  StartRunEvaluationInput,
} from "./harness/evaluations.js";
import type {
  ApprovalActionType,
  ApprovalCommandRule,
  ApprovalRequest,
  ApprovalRisk,
  CreateApprovalRequestInput,
  ListApprovalRequestsOptions,
  ResolveApprovalRequestInput,
} from "./approval-types.js";
import type {
  CommitRemoteConversationSendInput,
  CommitRemoteConversationSendResult,
  ConversationReadState,
  ListRemoteDispatchIntentsOptions,
  ListRemoteProjectionOutboxOptions,
  MarkConversationReadInput,
  RemoteCommandReceipt,
  RemoteConversationActivityInput,
  RemoteDispatchIntent,
  RemoteProjectionEntityVersion,
  RemoteProjectionEntityVersionInput,
  RemoteProjectionOutboxRecord,
} from "./remote-access-types.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyUpdateInput,
} from "./approval-policy.js";
import type {
  CommitApprovalResumeClaimInput,
  CommitApprovalResumeClaimResult,
  CommitApprovalResumeSuspensionInput,
  CommitApprovalResumeSuspensionResult,
  CommitApprovalResumeTerminalInput,
  CommitApprovalResumeTerminalResult,
  CreateApprovalCheckpointInput,
  LingApprovalCheckpoint,
  ListApprovalCheckpointsOptions,
  UpdateApprovalCheckpointStatusInput,
} from "./approval-checkpoints.js";
import type {
  ListProviderPresetsOptions,
  ProviderCheckResult,
  ProviderPreset,
  ProviderPresetInput,
  ProviderPresetUpdateInput,
} from "./provider-types.js";
import type { ProviderCheckPublicationStore } from "./provider-check-publication-types.js";
import type { LingStackRuntimePaths } from "./runtime-paths.js";
import type {
  OfficialSkillSourceSubscription,
  UpsertOfficialSkillSourceSubscriptionInput,
} from "./managed-official-skill-source-types.js";
import type {
  CreateMediaProjectInput,
  CreateMediaProjectAssetInput,
  CreateMediaJobInput,
  CreateMediaSceneInput,
  CreateMediaSceneRunInput,
  ListMediaJobsOptions,
  MediaJobExecutionHandle,
  MediaJob,
  MediaProject,
  MediaProjectAsset,
  MediaScene,
  MediaSceneRun,
  UpdateMediaProjectInput,
  UpdateMediaJobStatusInput,
  UpdateMediaSceneInput,
  UpsertMediaJobExecutionHandleInput,
} from "./media-types.js";
import type {
  CreateMediaWorkflowConnectionInput,
  CreateMediaWorkflowDefinitionInput,
  CreateMediaWorkflowVersionInput,
  ListMediaWorkflowDefinitionsOptions,
  MediaWorkflowConnection,
  MediaWorkflowDefinition,
  MediaWorkflowVersion,
  UpdateMediaWorkflowConnectionInput,
  UpdateMediaWorkflowDefinitionInput,
} from "./media-workflow-types.js";
import type {
  CreateOrReuseConversationMediaJobInput,
  CreateOrReuseConversationMediaJobResult,
} from "./media-generation-routing-types.js";
import type {
  ChannelInputMaterialization,
  CreateChannelInputMaterializationInput,
  ListChannelInputMaterializationsOptions,
} from "./input-materialization-types.js";
import type {
  CommitLingTerminalReportInput,
  CreateLingTerminalReportInput,
  FailLingTerminalReportInput,
  LingTerminalReportRecord,
  ListLingTerminalReportsOptions,
  MarkLingTerminalReportPublishedInput,
  TerminalReportSourceKind,
  UpdateLingTerminalReportDraftInput,
} from "./terminal-report-types.js";
import type {
  CommitConversationMessageEditInput,
  CommitConversationMessageEditResult,
  ConversationMessageRevision,
  ConversationReplacementStatus,
  ConversationTurnSupersession,
  ListConversationMessageRevisionsOptions,
  ListConversationTurnSupersessionsOptions,
} from "./conversation-revision-types.js";
import type {
  AppendConversationItem,
  ConversationItemListPage,
  ConversationItemChannelListPage,
  ListConversationItemsByChannelOptions,
  ListConversationItemsOptions,
  UpdatePendingConversationItemInput,
} from "./conversation-item-store-types.js";
import type {
  AppendConversationUserTurnInput,
  AppendConversationUserTurnResult,
} from "./conversation-turn-ingest-types.js";
import type {
  ResolveOrCreateConversationThreadInput,
  ResolveOrCreateConversationThreadResult,
} from "./conversation-thread-topology-types.js";
import type {
  AvailabilityIncident,
  ChannelTeamEvidenceItem,
  ChannelTeamPattern,
  ChannelTeamSnapshot,
  ChannelTeamEvaluationRun,
  CreateAvailabilityIncidentInput,
  CreateChannelTeamEvidenceItemInput,
  CreateChannelTeamEvaluationRunInput,
  CreateChannelTeamPatternInput,
  CreateChannelTeamSnapshotInput,
  CreateReliabilityIncidentInput,
  FoldedExpertsReadModel,
  ListActiveChannelTeamProvisionalRulesOptions,
  ListAvailabilityIncidentsOptions,
  ListChannelTeamEvaluationRunsOptions,
  ListChannelTeamEvidenceItemsOptions,
  ListChannelTeamPatternsOptions,
  ListChannelTeamSnapshotsOptions,
  ListFoldedChannelTeamEvidenceForTurnOptions,
  ListReliabilityIncidentsOptions,
  ReliabilityIncident,
  UpdateChannelTeamPatternInput,
  UpdateChannelTeamEvidenceItemInput,
} from "./channel-team-types.js";
import type {
  AiCouncil,
  AiCouncilHealthReport,
  AiCouncilHealthReportOptions,
  AiCouncilMember,
  AiTeammate,
  AiTeammateUpdateInput,
  Channel,
  ChannelBranch,
  ChannelBranchUpdateInput,
  ChannelAttachment,
  ChannelBrief,
  ChannelCollaborationProtocolDraft,
  ChannelCollaborationProtocolOverride,
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateStatus,
  ChannelProtocolDraftStatus,
  ChannelContextSummary,
  ChannelDecision,
  ChannelExecutionProposal,
  ChannelExecutionProposalClaimResult,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelHandoff,
  ChannelIntentDecision,
  ChannelLinkPreview,
  ChannelMessage,
  ChannelMessageRouteDecision,
  ChannelCouncilPolicy,
  ChannelUpdateInput,
  CloneAiCouncilInput,
  AssignConversationAttachmentInput,
  ConversationAttachment,
  CreateChannelAttachmentInput,
  CreateChannelBranchInput,
  CreateChannelCollaborationProtocolDraftInput,
  CreateChannelPlaybookCandidateInput,
  CreateChannelContextSummaryInput,
  CreateChannelDecisionInput,
  CreateOrReuseSupersedingChannelDecisionResult,
  CreateSupersedingChannelDecisionInput,
  CreateChannelExecutionProposalInput,
  CreateChannelMessageRouteDecisionInput,
  CreateWorkflowHandoffIntentInput,
  CreateWorkflowSelectorDecisionInput,
  CreateChannelWorkflowInput,
  CreateChannelWorkflowStepInput,
  CreateOrReuseChannelHandoffWorkflowInput,
  CreateOrReuseChannelHandoffWorkflowResult,
  CreateChannelHandoffInput,
  CreateChannelInput,
  CreateChannelIntentDecisionInput,
  CreateChannelLinkPreviewInput,
  CreateConversationAttachmentInput,
  CreateAiCouncilInput,
  CreateAiTeammateInput,
  CreateTeammateDirectLinkPreviewInput,
  CreateTeammateDirectMessageInput,
  CreateTeammateDirectReplyInterventionInput,
  CreateTeammatePrivateAttachmentInput,
  CreateTaskInput,
  DirectWorkspaceBinding,
  EffectiveChannelCouncilProjection,
  HardDeleteAiTeammateInput,
  HardDeleteAiTeammateResult,
  HardDeleteLingThreadInput,
  HardDeleteLingThreadResult,
  ListAiCouncilsOptions,
  ListAiTeammatesOptions,
  ListChannelAttachmentsOptions,
  ListChannelBranchesOptions,
  ListChannelContextSummariesOptions,
  ListChannelDecisionsOptions,
  ListChannelExecutionProposalsOptions,
  ListWorkflowHandoffIntentsOptions,
  ListWorkflowSelectorDecisionsOptions,
  ListChannelWorkflowStepsOptions,
  ListChannelWorkflowsOptions,
  ListChannelHandoffsOptions,
  ListChannelIntentDecisionsOptions,
  ListChannelsOptions,
  ListChannelLinkPreviewsOptions,
  ListChannelMessageRouteDecisionsOptions,
  ListConversationAttachmentsOptions,
  ListTeammatePrivateAttachmentsOptions,
  ListTeammateDirectLinkPreviewsOptions,
  ListTeammateDirectReplyInterventionsOptions,
  ListTeammateDirectMessagesOptions,
  ListTeammateDirectThreadsOptions,
  ListTasksOptions,
  ReplaceAiCouncilMemberInput,
  ReplaceTeammateChannelMembershipInput,
  ReplaceTeammateMemoryScopeInput,
  ReplaceTeammateSkillBindingInput,
  RejectActiveChannelDecisionInput,
  Task,
  TaskUpdateInput,
  TeammateChannelMembership,
  TeammateDirectLinkPreview,
  TeammateDirectMessage,
  TeammateDirectMessageListPage,
  TeammateDirectReplyIntervention,
  TeammateDirectThread,
  TeammateMemoryScope,
  TeammatePrivateAttachment,
  TeammateSkillBinding,
  UpdateChannelBriefInput,
  UpdateChannelPlaybookCandidateInput,
  UpdateChannelContextSummaryInput,
  UpdateChannelDecisionInput,
  UpdateChannelExecutionProposalInput,
  UpdateChannelMessageRouteDecisionInput,
  UpdateUserProfileInput,
  UpdateWorkspaceSettingsInput,
  UserProfile,
  WorkspaceSettings,
  UpdateWorkflowHandoffIntentInput,
  UpdateWorkflowSelectorDecisionInput,
  UpdateChannelWorkflowInput,
  UpdateChannelWorkflowStepInput,
  UpdateChannelHandoffInput,
  UpdateAiCouncilInput,
  UpsertChannelCouncilPolicyInput,
  UpsertChannelCollaborationProtocolOverrideInput,
  WorkflowHandoffIntent,
  WorkflowSelectorDecision,
  UpdateChannelLinkPreviewInput,
  UpdateTeammateDirectLinkPreviewInput,
  UpdateTeammateDirectReplyInterventionStatusInput,
} from "./workspace-types.js";
import type {
  CreateResourceLeaseInput,
  CreateStateTransitionEventInput,
  ListResourceLeasesOptions,
  ListStateTransitionEventsOptions,
  ResourceLease,
  ResourceLeaseOwnerLevelType,
  ResourceLeaseStatus,
  StateTransitionEvent,
} from "./channel-runtime-types.js";
import type {
  RunTransitionEvent,
  LingTurnTransitionEvent,
  StateTransitionActor,
  TaskTransitionEvent,
  TransitionResult,
  WorkUnitTransitionEvent,
  WorkflowStepTransitionEvent,
  WorkflowTransitionEvent,
} from "./state-machines.js";
import type {
  AcquireRuntimeSemaphoreSlotInput,
  AppendRuntimeEventInput,
  AppendTerminalRuntimeAuditInput,
  CreateWorkUnitAttemptInput,
  CreateWorkUnitInput,
  ListRuntimeEventsOptions,
  ListRuntimeSemaphoreSlotsOptions,
  ListWorkUnitsOptions,
  RecordRuntimeHeartbeatInput,
  RuntimeEvent,
  RuntimeHeartbeat,
  RuntimeAttemptFenceV1,
  RuntimeSemaphoreSlot,
  TerminalAttemptStatus,
  TerminalRuntimeEventType,
  WorkUnit,
  WorkUnitAttempt,
  WorkUnitStatus,
} from "./runtime-supervisor-types.js";
import type {
  CreateExternalWorkActionInput,
  CreateExternalWorkCiTriageInput,
  CreateExternalWorkWorkflowInput,
  ExternalWorkAction,
  ExternalWorkCiTriageRecord,
  ExternalWorkRecord,
  ExternalWorkRouteRequest,
  ExternalWorkSchedulerState,
  ExternalWorkWorkflowResult,
  ListExternalWorkActionsOptions,
  ListExternalWorkCiTriageOptions,
  ListExternalWorkRecordsOptions,
  ListExternalWorkSchedulerStatesOptions,
  UpdateExternalWorkActionInput,
  UpdateExternalWorkCiTriageInput,
  UpdateExternalWorkSchedulerStateInput,
  UpsertExternalWorkSchedulerStateInput,
} from "./external-work-types.js";
import type {
  ListWorkItemsOptions,
  UpsertWorkItemInput,
  WorkItem,
  WorkItemClaimBlocker,
  WorkItemClaimRequest,
  WorkItemCompleteRequest,
  WorkItemFailRequest,
  WorkItemHeartbeatRequest,
  WorkItemReleaseRequest,
  WorkItemRouteRequest,
} from "./work-item-types.js";
import type {
  CreateSkillCompiledRuntimeViewInput,
  CreateSkillImportDraftInput,
  CreateSkillRegressionRunInput,
  CreateSkillSourceArtifactInput,
  CreateSkillSourceSnapshotInput,
  ListSkillCompiledRuntimeViewOptions,
  ListSkillRegressionRunsOptions,
  ListSkillSourceArtifactOptions,
  ListSkillRegistryOptions,
  ListSkillSourceSnapshotOptions,
  PublishSkillRevisionDraftInput,
  SkillCompiledRuntimeViewRecord,
  SkillHardDeleteResult,
  SkillImportDraft,
  SkillRegressionRun,
  SkillRegistryEntry,
  SkillSourceArtifact,
  SkillSourceSnapshot,
  SkillSourceUpgradePolicy,
  UpdateSkillSourceUpgradePolicyInput,
} from "./skill-types.js";
import type {
  ApplySkillCandidateReviewActionInput,
  CreateSkillCandidateInput,
  ListSkillCandidatesOptions,
  SkillCandidate,
  SkillCandidateReviewRecord,
} from "./skill-candidate-types.js";
import type {
  CandidateGenerationDecision,
  CreateCandidateGenerationDecisionInput,
  CreateProcedureObservationInput,
  ListCandidateGenerationDecisionsOptions,
  ListProcedureObservationClustersOptions,
  ListProcedureObservationsOptions,
  ProcedureObservation,
  ProcedureObservationCluster,
} from "./procedure-observation-types.js";
import type {
  CreateSkillUsageEventInput,
  ListSkillUsageEventsOptions,
  ListSkillUsageStatsOptions,
  SkillUsageEvent,
  SkillUsageStats,
} from "./skill-usage-types.js";
import type {
  CreateMcpServerInput,
  ListMcpServersOptions,
  ListMcpToolsOptions,
  McpAuthorityRevision,
  McpServer,
  McpRuntimeStatusSnapshot,
  McpServerStatus,
  McpTool,
  ReplaceMcpServerToolInput,
  ReplaceTeammateMcpBindingInput,
  TeammateMcpBinding,
  UpdateMcpServerInput,
} from "./mcp-types.js";
import type {
  CommitMcpMetadataResult,
  CommitMcpMetadataResultInput,
  McpMetadataRequestKind,
  McpMetadataRequestTicket,
} from "./mcp-metadata-types.js";
import type {
  CommitCuaDriverActivationInput,
  CommitCuaDriverActivationResult,
  CuaDriverActivationState,
} from "./cua-driver-activation-types.js";
import type {
  ChromeBrowserCredentialRecord,
  UpsertChromeBrowserCredentialInput,
} from "./chrome-browser-types.js";
import type {
  CreateMemoryObjectInput,
  ApplyMemoryReviewActionInput,
  CreateMemoryReviewDecisionInput,
  CreateUsedMemoryEventInput,
  ListMemorySelfImprovingMetadataOptions,
  ListMemoryObjectsOptions,
  ListMemoryPromotionInboxOptions,
  ListUsedMemoryEventsOptions,
  MemoryObject,
  MemoryObjectUpdateInput,
  MemoryPromotionInboxItem,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryReviewActionRecord,
  MemoryReviewDecision,
  MemoryReviewPolicy,
  MemoryReviewPolicyUpdateInput,
  MemorySelfImprovingMetadata,
  UsedMemoryEvent,
  UpsertMemorySelfImprovingMetadataInput,
} from "./memory-types.js";
import type {
  CreateMemoryConsolidationJobInput,
  ListMemoryConsolidationJobsOptions,
  MemoryConsolidationJob,
  UpdateMemoryConsolidationJobInput,
} from "./memory-consolidation-types.js";
import type {
  CreateGovernanceNotificationInput,
  GovernanceNotification,
  GovernanceNotificationSummary,
  ListGovernanceNotificationsOptions,
  UpdateGovernanceNotificationDeliveryInput,
  UpsertGovernanceNotificationResult,
} from "./governance-notification-types.js";
import type {
  CreateManagedPluginEventInput,
  CreateManagedPluginRuntimeSnapshotInput,
  ListManagedPluginEventsOptions,
  ListManagedPluginsOptions,
  ManagedPluginContributionRecord,
  ManagedPluginEvent,
  ManagedPluginHealthSnapshot,
  ManagedPluginPackageRecord,
  ManagedPluginRecord,
  ManagedPluginRuntimeSnapshot,
  UpdateManagedPluginInput,
  UpsertManagedPluginPackageInput,
  UpsertManagedPluginContributionInput,
  UpsertManagedPluginInput,
} from "./plugin-manager-types.js";
import type {
  AutomationDraft,
  AutomationDefinition,
  AutomationRun,
  CreateAutomationDefinitionInput,
  CreateAutomationDraftInput,
  CreateAutomationRunInput,
  ListAutomationDefinitionsOptions,
  ListAutomationDraftsOptions,
  ListAutomationRunsOptions,
  UpdateAutomationDefinitionInput,
  UpdateAutomationDraftInput,
  UpdateAutomationRunInput,
} from "./automation-types.js";

export type RunStatus = "queued" | "running" | "waiting_for_approval" | "yielded" | "succeeded" | "failed" | "cancelled";

export function createLingThreadId(): string {
  return `thread_${randomUUID()}`;
}

export function createLingThreadGoalId(): string {
  return `goal_${randomUUID()}`;
}

export function createProposedPlanArtifactId(): string {
  return `proposed_plan_${randomUUID()}`;
}

export function createLingTurnId(): string {
  return `turn_${randomUUID()}`;
}

export type LingTurnKind =
  | "initial_request"
  | "manual_followup"
  | "queued_followup"
  | "interrupt_redirect"
  | "workflow_step"
  | "external_work_update"
  | "automation_tick"
  | "review_queue_action";

export type LingTurnStatus =
  | "open"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

export type LingTurnCreatedByActor = "local-user" | "system" | "teammate" | "automation";

export type LingTurnRunRole = "primary" | "retry" | "resume" | "repair" | "validation";

export interface LingTurn {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly kind: LingTurnKind;
  readonly status: LingTurnStatus;
  readonly title: string;
  readonly userInstruction: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly automationId?: string;
  readonly sourceItemId?: string;
  readonly sourceTurnId?: string;
  readonly interventionId?: string;
  readonly activeRunId?: string;
  readonly lastRunId?: string;
  readonly createdByActor: LingTurnCreatedByActor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface LingTurnRun {
  readonly turnId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly role: LingTurnRunRole;
  readonly createdAt: string;
}

export interface CreateLingTurnInput {
  readonly id?: string;
  readonly threadId: string;
  readonly kind: LingTurnKind;
  readonly status?: LingTurnStatus;
  readonly title: string;
  readonly userInstruction: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly automationId?: string;
  readonly sourceItemId?: string;
  readonly sourceTurnId?: string;
  readonly interventionId?: string;
  readonly activeRunId?: string;
  readonly lastRunId?: string;
  readonly createdByActor?: LingTurnCreatedByActor;
}

export interface ListLingTurnsOptions {
  readonly threadId: string;
  readonly limit?: number;
  readonly beforeUpdatedAt?: string;
}

export interface LinkRunToLingTurnInput {
  readonly turnId: string;
  readonly runId: string;
  readonly role?: LingTurnRunRole;
  readonly now: string;
}

export interface TransitionLingTurnStatusInput {
  readonly turnId: string;
  readonly expectedStatus?: LingTurnStatus;
  readonly event: LingTurnTransitionEvent;
  readonly actor: StateTransitionActor;
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly now: string;
}

export type RunEventType = ContractRunEventType;
export type RunEventDataByType = ContractRunEventDataByType;
export type RunEventData = RunEventDataByType[RunEventType];
export type RunEventEmitter = <K extends RunEventType>(
  type: K,
  data: RunEventDataByType[K],
) => RunEventEnvelope | undefined;

export const runInterventionModes = ["queue_followup", "interrupt_redirect"] as const;
export type RunInterventionMode = (typeof runInterventionModes)[number];
export const runContinuationReasons = [...runInterventionModes, "manual_resume", "user_input_answer"] as const;
export type RunContinuationReason = (typeof runContinuationReasons)[number];

export const runInterventionStatuses = [
  "queued",
  "cancelling_source",
  "starting_continuation",
  "started",
  "failed",
  "cancelled",
] as const;
export type RunInterventionStatus = (typeof runInterventionStatuses)[number];

export const lingThreadKinds = [
  "task",
  "channel_discussion",
  "teammate_direct",
  "workflow_step",
  "external_work",
  "automation",
  "conversation",
] as const;
export type LingThreadKind = (typeof lingThreadKinds)[number];
export type LingThreadStatus = "open" | "running" | "waiting_for_approval" | "waiting_for_input" | "blocked" | "succeeded" | "failed" | "cancelled" | "archived";
export type LingThreadArchivedFilter = "exclude" | "include" | "only";
export const conversationModeKinds = ["default", "plan"] as const;
export type ConversationModeKind = (typeof conversationModeKinds)[number];
export type LingThreadGoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete" | "cleared" | "replaced";
export type LingThreadGoalCompletionActor = "local-user" | "ling-agent";
export type GoalUsageSource = "provider" | "estimated" | "mixed";
export type GoalContinuationStopReason =
  | "max_depth"
  | "no_evidence_threshold"
  | "same_blocker_threshold"
  | "plan_mode_active"
  | "pending_approval"
  | "active_run_exists"
  | "latest_run_not_terminal"
  | "goal_not_active"
  | "budget_limited"
  | "usage_limited"
  | "manual_stop"
  | "unknown";
export type GoalContinuationDecision = "started" | "stopped";
export type ProposedPlanArtifactStatus = "draft" | "accepted" | "superseded" | "archived";
export type ProposedPlanSourceMessageState = "available" | "deleted" | "unknown";
export type LingThreadSearchField =
  | "thread_title"
  | "thread_objective"
  | "turn_title"
  | "turn_instruction"
  | "task_id"
  | "task_title"
  | "task_prompt"
  | "metadata_summary";

export interface LingThreadMetadata {
  readonly schemaVersion: 1;
  readonly summary?: string;
  readonly pinnedAt?: string;
  readonly lastTurnId?: string;
  readonly lastActivityAt?: string;
  readonly pendingApprovalCount: number;
  readonly blockedCount: number;
  readonly failedAttemptCount: number;
  readonly artifactCount: number;
  readonly latestFailureRunId?: string;
  readonly latestEvidenceArtifactId?: string;
  readonly rebuiltAt: string;
}

export interface ConversationModeState {
  readonly mode: ConversationModeKind;
  readonly updatedAt?: string;
}

export type GoalEvidenceRef =
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "turn"; readonly id: string }
  | { readonly kind: "artifact"; readonly id: string }
  | { readonly kind: "approval"; readonly id: string }
  | { readonly kind: "workflow"; readonly id: string };

export interface GoalContinuationEvidenceDelta {
  readonly newEvidenceRefs: number;
  readonly changedFiles: number;
  readonly acceptedPlans: number;
  readonly artifacts: number;
  readonly statusChanged: boolean;
}

export interface GoalContinuationEvent {
  readonly id: string;
  readonly goalId: string;
  readonly chainId: string;
  readonly sourceRunId: string;
  readonly continuationRunId?: string;
  readonly decision: GoalContinuationDecision;
  readonly stopReason?: GoalContinuationStopReason;
  readonly continuationDepth: number;
  readonly noEvidenceContinuationCount: number;
  readonly sameBlockerCount: number;
  readonly blockerFingerprint?: string;
  readonly evidenceDelta: GoalContinuationEvidenceDelta;
  readonly createdAt: string;
}

export interface LingThreadGoal {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly objective: string;
  readonly status: LingThreadGoalStatus;
  readonly tokenBudget?: number;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly clearedAt?: string;
  readonly replacedByGoalId?: string;
  readonly lastRunId?: string;
  readonly blockedReason?: string;
  readonly completionEvidenceRefs: readonly GoalEvidenceRef[];
  readonly completedBy?: LingThreadGoalCompletionActor;
  readonly completedReason?: string;
  readonly completionVerificationSummary?: string;
  readonly usageSource?: GoalUsageSource;
  readonly continuationChainId?: string;
  readonly continuationDepth: number;
  readonly noEvidenceContinuationCount: number;
  readonly lastBlockerFingerprint?: string;
  readonly sameBlockerCount: number;
  readonly lastContinuationStopReason?: GoalContinuationStopReason;
  readonly lastContinuationStoppedAt?: string;
  readonly lastContinuationEvidenceDelta?: GoalContinuationEvidenceDelta;
}

export interface CreateLingThreadGoalInput {
  readonly id?: string;
  readonly threadId: string;
  readonly objective: string;
  readonly status?: LingThreadGoalStatus;
  readonly tokenBudget?: number;
}

export interface UpdateLingThreadGoalInput {
  readonly objective?: string;
  readonly status?: LingThreadGoalStatus;
  readonly tokenBudget?: number | null;
  readonly tokensUsed?: number;
  readonly timeUsedSeconds?: number;
  readonly lastRunId?: string | null;
  readonly blockedReason?: string | null;
  readonly completionEvidenceRefs?: readonly GoalEvidenceRef[];
  readonly completedBy?: LingThreadGoalCompletionActor | null;
  readonly completedReason?: string | null;
  readonly completionVerificationSummary?: string | null;
  readonly usageSource?: GoalUsageSource | null;
  readonly continuationChainId?: string | null;
  readonly continuationDepth?: number;
  readonly noEvidenceContinuationCount?: number;
  readonly lastBlockerFingerprint?: string | null;
  readonly sameBlockerCount?: number;
  readonly lastContinuationStopReason?: GoalContinuationStopReason | null;
  readonly lastContinuationStoppedAt?: string | null;
  readonly lastContinuationEvidenceDelta?: GoalContinuationEvidenceDelta | null;
}

export interface ProposedPlanArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly channelId?: string;
  readonly goalId?: string;
  readonly sourceAgentId?: string;
  readonly ownerAgentId?: string;
  readonly sourceTurnId?: string;
  readonly sourceMessageId?: string;
  readonly sourceMessageState?: ProposedPlanSourceMessageState;
  readonly sourceRunId?: string;
  readonly parentPlanId?: string;
  readonly supersededByPlanId?: string;
  readonly planGroupId?: string;
  readonly version?: number;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly status: ProposedPlanArtifactStatus;
  readonly savedAt?: string;
  readonly acceptedAt?: string;
  readonly convertedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
  readonly acceptedTaskId?: string;
  readonly acceptedWorkflowId?: string;
  readonly acceptedWorkflowStepId?: string;
  readonly acceptedRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProposedPlanArtifactInput {
  readonly id?: string;
  readonly threadId: string;
  readonly channelId?: string;
  readonly goalId?: string;
  readonly sourceAgentId?: string;
  readonly ownerAgentId?: string;
  readonly sourceTurnId?: string;
  readonly sourceMessageId?: string;
  readonly sourceRunId?: string;
  readonly parentPlanId?: string;
  readonly supersededByPlanId?: string;
  readonly planGroupId?: string;
  readonly version?: number;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly status?: ProposedPlanArtifactStatus;
  readonly savedAt?: string;
  readonly acceptedAt?: string;
  readonly convertedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
  readonly acceptedTaskId?: string;
  readonly acceptedWorkflowId?: string;
  readonly acceptedWorkflowStepId?: string;
  readonly acceptedRunId?: string;
}

export interface UpdateProposedPlanArtifactInput {
  readonly channelId?: string | null;
  readonly goalId?: string | null;
  readonly sourceAgentId?: string | null;
  readonly ownerAgentId?: string | null;
  readonly sourceTurnId?: string | null;
  readonly sourceMessageId?: string | null;
  readonly sourceRunId?: string | null;
  readonly parentPlanId?: string | null;
  readonly supersededByPlanId?: string | null;
  readonly planGroupId?: string | null;
  readonly version?: number | null;
  readonly title?: string;
  readonly bodyMarkdown?: string;
  readonly status?: ProposedPlanArtifactStatus;
  readonly savedAt?: string | null;
  readonly acceptedAt?: string | null;
  readonly convertedAt?: string | null;
  readonly archivedAt?: string | null;
  readonly archivedReason?: string | null;
  readonly acceptedTaskId?: string | null;
  readonly acceptedWorkflowId?: string | null;
  readonly acceptedWorkflowStepId?: string | null;
  readonly acceptedRunId?: string | null;
}

export interface ListProposedPlanArtifactsOptions {
  readonly threadId?: string;
  readonly channelId?: string;
  readonly goalId?: string;
  readonly agentId?: string;
  readonly statuses?: readonly ProposedPlanArtifactStatus[];
  readonly limit?: number;
}

export interface LingThread {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: LingThreadKind;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status: LingThreadStatus;
  readonly activeRunId?: string;
  readonly lastRunId?: string;
  readonly parentThreadId?: string;
  readonly parentTurnId?: string;
  readonly forkedFromRunId?: string;
  readonly metadata?: LingThreadMetadata;
  readonly conversationMode: ConversationModeState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
  readonly surfaceKind: LingThreadSurfaceKindV2;
  readonly relationKind: LingThreadRelationKindV2;
  readonly anchorItemId?: string;
  readonly forkContextSnapshotId?: string;
  readonly nextItemSequence: number;
}

export interface CreateLingThreadInput {
  readonly id?: string;
  readonly kind: LingThreadKind;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status?: LingThreadStatus;
  readonly activeRunId?: string;
  readonly lastRunId?: string;
  readonly parentThreadId?: string;
  readonly parentTurnId?: string;
  readonly forkedFromRunId?: string;
  readonly conversationMode?: ConversationModeState;
  readonly pinnedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
  readonly surfaceKind?: LingThreadSurfaceKindV2;
  readonly relationKind?: LingThreadRelationKindV2;
  readonly anchorItemId?: string;
  readonly forkContextSnapshotId?: string;
}

export interface UpdateLingThreadInput {
  readonly title?: string;
  readonly objective?: string;
  readonly status?: LingThreadStatus;
  readonly activeRunId?: string | null;
  readonly lastRunId?: string | null;
  readonly pinnedAt?: string | null;
  readonly archivedAt?: string | null;
  readonly archivedReason?: string | null;
}

export interface UpdateLingThreadConversationModeInput {
  readonly mode: ConversationModeKind;
}

export interface ListLingThreadsOptions {
  readonly q?: string;
  readonly kind?: LingThreadKind;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly externalWorkId?: string;
  readonly status?: LingThreadStatus;
  readonly includeArchived?: boolean;
  readonly archived?: LingThreadArchivedFilter;
  readonly limit?: number;
}

export interface LingThreadSearchMatch {
  readonly threadId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly field: LingThreadSearchField;
  readonly snippet: string;
}

export interface SearchLingThreadsResult {
  readonly threads: readonly LingThread[];
  readonly matches: readonly LingThreadSearchMatch[];
}

export type ExecutionActionType = ApprovalActionType | "runtime_diagnostic";

export type ExecutionScope =
  | "read_only"
  | "workspace_write"
  | "git_history"
  | "network"
  | "credential"
  | "provider_config"
  | "deployment"
  | "external_system";

export type ExecutionActionStatus =
  | "proposed"
  | "waiting_for_approval"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "executing"
  | "succeeded"
  | "failed";

export interface ExecutionActionTargetRef {
  readonly type:
    | "run"
    | "task"
    | "channel"
    | "workflow"
    | "workflow_step"
    | "work_unit"
    | "media_job"
    | "external_work_action"
    | "file"
    | "command"
    | "mcp_tool"
    | "host_capability";
  readonly id?: string;
  readonly label?: string;
  readonly path?: string;
}

/** Stable lineage references consumed by transcript projections and inspectors. */
export interface ExecutionActionSourceRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly path?: string;
}

export interface ExecutionActionCommandOutputChunk {
  readonly eventSeq: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly byteCount: number;
  readonly redacted: boolean;
  readonly ts: string;
}

export interface ExecutionActionCommandEvidence {
  readonly command: string;
  readonly outcome?: "succeeded" | "failed" | "timed_out" | "cancelled" | "unknown";
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly latestEventSeq: number;
  readonly outputTail: readonly ExecutionActionCommandOutputChunk[];
  readonly outputByteCount: number;
  readonly outputLineCount?: number;
  readonly outputTruncated: boolean;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly resultArtifactId?: string;
}

/** Bounded display evidence derived from accepted read-only tool events. */
export interface ExecutionActionToolEvidence {
  readonly toolName: string;
  readonly inputSummary: string;
  readonly outputText?: string;
  readonly outputTruncated: boolean;
  readonly latestEventSeq: number;
}

export interface ExecutionActionRuntimeDiagnostic {
  readonly code: "execution_loop_detected";
  readonly loopKind: "exact_repeat" | "repeated_update" | "cycle" | "no_progress_budget";
  readonly repeatedCount: number;
  readonly noProgressActionCount: number;
  readonly cycleLength?: number;
  readonly fingerprint: string;
  readonly retryable: false;
}

export interface ExecutionAction {
  readonly id: string;
  /** Monotonic event/approval revision for in-place transcript replacement. */
  readonly revision: number;
  /** Accepted tool_start sequence; unlike revision, this never moves on update. */
  readonly sourceEventSequence?: number;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly workUnitId?: string;
  readonly participantId?: string;
  readonly workflowStepId?: string;
  readonly approvalId?: string;
  readonly toolCallId?: string;
  readonly actionType: ExecutionActionType;
  readonly risk: ApprovalRisk;
  readonly status: ExecutionActionStatus;
  readonly title: string;
  readonly summary: string;
  readonly targetRefs: readonly ExecutionActionTargetRef[];
  readonly previewArtifactIds: readonly string[];
  readonly resultArtifactIds: readonly string[];
  readonly sourceRefs: readonly ExecutionActionSourceRef[];
  readonly diagnostics?: readonly ExecutionActionDiagnostic[];
  readonly scopes?: readonly ExecutionScope[];
  readonly scopeSummary?: string;
  readonly policySnapshot?: unknown;
  readonly commandEvidence?: ExecutionActionCommandEvidence;
  readonly toolEvidence?: ExecutionActionToolEvidence;
  readonly runtimeDiagnostic?: ExecutionActionRuntimeDiagnostic;
  /** Original-call Host launch evidence, not proof of window visibility. */
  readonly hostOpenReceipt?: HostOpenLocalTargetReceiptV1;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly resolvedAt?: string;
  readonly executedAt?: string;
  readonly completedAt?: string;
}

export interface RunSession {
  readonly id: string;
  readonly status: RunStatus;
  readonly cwd: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly selectedSkillId?: string;
  readonly providerPresetId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly taskSnapshot: unknown;
  readonly providerSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly eventLogPath: string;
  readonly threadId?: string;
  readonly workUnitId?: string;
  readonly parentRunId?: string;
  readonly interventionId?: string;
  readonly continuationReason?: RunContinuationReason;
  /** Immutable context projection lineage captured before execution started. */
  readonly contextViewId?: string;
  readonly contextViewCreatedAt?: string;
  readonly summaryPath?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly updatedAt: string;
}

export type RunEventEnvelope = ContractRunEventEnvelope;

export interface CreateRunInput {
  readonly id: string;
  readonly cwd: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly selectedSkillId?: string;
  readonly providerPresetId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly taskSnapshot: unknown;
  readonly providerSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly threadId?: string;
  readonly workUnitId?: string;
  readonly turnId?: string;
  readonly turnRunRole?: LingTurnRunRole;
  readonly parentRunId?: string;
  readonly interventionId?: string;
  readonly continuationReason?: RunContinuationReason;
  readonly contextViewId?: string;
  readonly contextViewCreatedAt?: string;
  readonly createdAt: string;
}

export interface RunIntervention {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceRunId: string;
  readonly sourceWorkUnitId?: string;
  readonly sourceAttemptId?: string;
  readonly continuationRunId?: string;
  readonly continuationWorkUnitId?: string;
  readonly mode: RunInterventionMode;
  readonly status: RunInterventionStatus;
  readonly instruction: string;
  readonly messagePayload?: RunInterventionMessagePayload;
  readonly requestedBy: "local-user" | "system";
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failureReason?: string;
}

export interface RunInterventionMessagePayload {
  readonly sourceMessageId?: string;
  readonly targetTeammateId?: string;
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly attachments?: readonly RunInterventionAttachmentPayload[];
  readonly linkPreviews?: readonly RunInterventionLinkPreviewPayload[];
  readonly fileRefs?: readonly RunInterventionWorkspaceFilePayload[];
}

export type RunInterventionMaterializationStatus = "available" | "metadata_only" | "not_loaded" | "unsupported" | "blocked";

export interface RunInterventionAttachmentPayload {
  readonly id: string;
  readonly fileName: string;
  readonly kind: ChannelAttachment["kind"] | "other";
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly materializationStatus: RunInterventionMaterializationStatus;
  readonly previewStatus?: string;
  readonly previewText?: string;
  readonly reason?: string;
}

export interface RunInterventionLinkPreviewPayload {
  readonly id: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title?: string;
  readonly description?: string;
  readonly siteName?: string;
  readonly status: ChannelLinkPreview["status"] | "missing" | "channel_mismatch";
  readonly materializationStatus: RunInterventionMaterializationStatus;
  readonly previewText?: string;
  readonly reason?: string;
}

export interface RunInterventionWorkspaceFilePayload {
  readonly path: string;
  readonly label?: string;
  readonly rootRelation: "inside_workspace" | "outside_workspace" | "unknown";
  readonly kind: "file" | "directory" | "glob" | "unknown";
  readonly materializationStatus: RunInterventionMaterializationStatus;
  readonly previewText?: string;
  readonly blockedReason?: string;
}

export interface CreateRunInterventionInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly sourceRunId: string;
  readonly sourceWorkUnitId?: string;
  readonly sourceAttemptId?: string;
  readonly mode: RunInterventionMode;
  readonly instruction: string;
  readonly messagePayload?: RunInterventionMessagePayload;
  readonly requestedBy?: RunIntervention["requestedBy"];
  readonly idempotencyKey: string;
}

export interface ListRunInterventionsOptions {
  readonly sourceRunId?: string;
  readonly sourceMessageIds?: readonly string[];
  readonly status?: RunInterventionStatus;
  readonly mode?: RunInterventionMode;
  readonly limit?: number;
}

export interface UpdateRunInterventionStatusInput {
  readonly interventionId: string;
  readonly expectedStatuses?: readonly RunInterventionStatus[];
  readonly status: RunInterventionStatus;
  readonly continuationRunId?: string | null;
  readonly continuationWorkUnitId?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly failureReason?: string | null;
  readonly now: string;
}

export interface ClaimNextRunInterventionInput {
  readonly sourceRunId: string;
  readonly expectedStatuses: readonly RunInterventionStatus[];
  readonly status: RunInterventionStatus;
  readonly startedAt?: string | null;
  readonly now: string;
}

export interface ListPriorRunInterventionReplyMessagesInput {
  readonly sourceRunId: string;
  readonly beforeInterventionId: string;
  readonly channelId: string;
  readonly limit?: number;
}

export interface ListRunEventsOptions {
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface ListRunsOptions {
  readonly status?: RunStatus;
  readonly teammateId?: string;
  readonly workflowStepId?: string;
  readonly threadId?: string;
  readonly providerPresetId?: string;
  readonly limit?: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly status: RunStatus;
  readonly taskId: string;
  readonly eventCount: number;
  readonly messageCount?: number;
  readonly startedAt?: string;
  readonly endedAt: string;
  readonly errorMessage: string | null;
}

export type ArtifactType = "file" | "diff" | "log" | "json" | "markdown" | "image" | "video";

export interface RunArtifact {
  readonly id: string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkId?: string;
  readonly type: ArtifactType;
  readonly path: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly sealedPayload?: unknown;
  readonly contentSha256?: string;
  readonly createdAt: string;
}

export interface CreateRunArtifactInput {
  readonly id?: string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkId?: string;
  readonly type: ArtifactType;
  readonly path: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  /** Canonical SQLite-owned JSON for evidence whose identity must survive file projection changes. */
  readonly sealedPayload?: unknown;
  /** Optional caller assertion. The store always recomputes this digest from sealedPayload. */
  readonly contentSha256?: string;
  readonly createdAt: string;
}

export type ControlPlaneDomain =
  | "runs"
  | "work_units"
  | "memory"
  | "skills"
  | "teammates"
  | "approvals"
  | "providers"
  | "mcp"
  | "runners"
  | "artifacts";

export interface ControlPlaneEvent {
  readonly seq: number;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly ts: string;
  readonly domain: ControlPlaneDomain;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly data: Record<string, unknown>;
  readonly idempotencyKey?: string;
}

export interface AppendControlPlaneEventInput {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly domain: ControlPlaneDomain;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly data?: Record<string, unknown>;
  readonly idempotencyKey?: string;
}

export interface ListControlPlaneEventsOptions {
  readonly workspaceId: string;
  readonly afterSeq?: number;
  readonly limit?: number;
  readonly domains?: readonly ControlPlaneDomain[];
  readonly entityType?: string;
  readonly entityId?: string;
  readonly action?: string;
}

export interface ControlPlaneReplayState {
  readonly workspaceId: string;
  readonly replayFloorSeq: number;
  readonly latestSeq: number;
  readonly updatedAt: string;
}

export interface ReadControlPlaneReplayWindowInput {
  readonly workspaceId: string;
  readonly afterSeq: number;
  readonly limit: number;
  readonly domains?: readonly ControlPlaneDomain[];
  readonly entityType?: string;
  readonly entityId?: string;
  readonly action?: string;
}

export interface ControlPlaneReplayWindowResult {
  readonly window: import("@ling-stack/contracts").ControlPlaneReplayWindow;
  readonly events: readonly ControlPlaneEvent[];
}

export interface RunStore extends DelegationQueryStore, HarnessDiagnosticsStore, RunEvaluationTaskStore, RunEvaluationQaStore, RunEvaluationHumanStore {
  listApprovalPostCommitEffects(options?: {
    readonly approvalId?: string;
    readonly status?: import("./approval-postcommit-types.js").ApprovalPostCommitEffectStatus;
    readonly after?: { readonly createdAt: string; readonly approvalId: string; readonly effectKind: import("./approval-postcommit-types.js").ApprovalPostCommitEffectKind };
    readonly limit?: number;
  }): import("./approval-postcommit-types.js").ApprovalPostCommitEffect[];
  claimApprovalPostCommitEffect(approvalId: string, effectKind: import("./approval-postcommit-types.js").ApprovalPostCommitEffectKind, input: {
    readonly token: string; readonly claimExpiresAt: string;
  }, now: string): import("./approval-postcommit-types.js").ApprovalPostCommitEffect | undefined;
  settleApprovalPostCommitEffect(approvalId: string, effectKind: import("./approval-postcommit-types.js").ApprovalPostCommitEffectKind, input: {
    readonly token: string;
    readonly status: "completed" | "pending" | "blocked" | "effect_unknown";
    readonly errorCode?: string;
  }, now: string): import("./approval-postcommit-types.js").ApprovalPostCommitEffect | undefined;
  recoverExpiredApprovalPostCommitClaim(approvalId: string, effectKind: import("./approval-postcommit-types.js").ApprovalPostCommitEffectKind, input: {
    readonly expectedRevision: number;
    readonly status: "pending" | "completed" | "blocked" | "effect_unknown";
    readonly errorCode: string;
  }, now: string): import("./approval-postcommit-types.js").ApprovalPostCommitEffect | undefined;
  quarantineMediaApprovalSubmission(approvalId: string, mediaJobId: string, now: string): import("./approval-postcommit-types.js").ApprovalPostCommitEffect | undefined;
  prepareHostCommandExecution(input: import("./host-command-journal-types.js").PrepareHostCommandExecutionInput): import("./host-command-journal-types.js").HostCommandExecutionTicket;
  /** Optional synchronous read-only denial gate runs under the writer lock before claiming the launch. */
  launchHostCommandExecution<T>(ticket: import("./host-command-journal-types.js").HostCommandExecutionTicket, launch: () => T,
    assertMayLaunch?: () => void): T;
  /** Exact command + attempt operation launch, under one writer transaction. Neither ID is replay authority. */
  launchTrackedHostCommandExecution<T>(operation: import("./host-operation-journal-types.js").HostOperationTicket,
    command: import("./host-command-journal-types.js").HostCommandExecutionTicket, launch: () => T, assertMayLaunch?: () => void): T;
  settleHostCommandExecution(ticket: import("./host-command-journal-types.js").HostCommandExecutionTicket, input: import("./host-command-journal-types.js").HostCommandSettlementInput): Extract<RunEventEnvelope, { readonly type: "host_command_settled" }>;
  listHostCommandWriteBlockers(cwd: string): import("@ling-stack/contracts").HostCommandWriteBlockerV1[];
  admitHostOperation(input: import("./host-operation-journal-types.js").AdmitHostOperationInput): import("./host-operation-journal-types.js").HostOperationTicket;
  bindHostOperationEvidence(ticket: import("./host-operation-journal-types.js").HostOperationTicket, evidence: import("./host-operation-journal-types.js").HostOperationEvidenceRef): import("./host-operation-journal-types.js").HostOperationRecord;
  launchHostOperation<T>(ticket: import("./host-operation-journal-types.js").HostOperationTicket, launch: () => T): T;
  continueHostOperationEffect<T>(ticket: import("./host-operation-journal-types.js").HostOperationTicket, effect: () => T, mode?: "forward" | "cleanup"): T;
  settleHostOperation(ticket: import("./host-operation-journal-types.js").HostOperationTicket, input: import("./host-operation-journal-types.js").HostOperationSettlementInput): import("./host-operation-journal-types.js").HostOperationRecord;
  /** Safe rows are independently reverified against their exact domain evidence on every read. */
  getHostOperation(operationId: string): import("./host-operation-journal-types.js").HostOperationRecord | undefined;
  listHostOperationBlockers(source: import("./host-operation-journal-types.js").HostOperationSource, stoppedAt?: string): import("./host-operation-journal-types.js").HostOperationRecord[];
  prepareHostOfficeLocalExecution(parent: import("./host-operation-journal-types.js").HostOperationTicket,
    producer: import("./host-operation-journal-types.js").HostOperationTicket,
    input: import("./host-office-local-types.js").PrepareHostOfficeLocalInput): import("./host-office-local-types.js").HostOfficeLocalTicket;
  /** Original-owner admission before retaining any fixed writer read-only native resources. */
  beginHostOfficeLocalWriterObservation(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket): void;
  prepareHostOfficeLocalEffect(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket,
    input: import("./host-office-local-types.js").PrepareHostOfficeLocalEffect): import("./host-office-local-types.js").HostOfficeLocalEffectRecord;
  launchHostOfficeLocalEffect<T>(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket, effectId: string, effect: () => T): T;
  recordHostOfficeLocalObservation(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket,
    effectId: string, artifactId: string): import("./host-office-local-types.js").HostOfficeLocalEffectRecord;
  getHostOfficeLocalExecution(executionId: string): import("./host-office-local-types.js").HostOfficeLocalExecutionRecord | undefined;
  listHostOfficeLocalEffects(executionId: string): import("./host-office-local-types.js").HostOfficeLocalEffectRecord[];
  sealHostOfficeLocalTerminal(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket,
    input: import("./host-office-local-terminal-types.js").SealHostOfficeLocalTerminalInput): import("./host-office-local-terminal-types.js").HostOfficeLocalTerminalRecord;
  getHostOfficeLocalTerminal(executionId: string): import("./host-office-local-terminal-types.js").HostOfficeLocalTerminalRecord | undefined;
  /** Original live-ticket no-start history; this read never issues an execution capability. */
  getHostOfficeLocalNoStartReceipt(executionId: string): import("./host-office-local-no-start-types.js").HostOfficeLocalNoStartReceipt | undefined;
  settleHostOfficeLocalExecution(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket,
    input?: import("./host-office-local-types.js").SettleHostOfficeLocalInput): import("./host-office-local-types.js").HostOfficeLocalSettlement;
  /** Protocol-v2 facts use the same original live journal pair; no public-safe receipt is issued yet. */
  prepareHostOfficeLocalDirectoryExecutionV2(parent: import("./host-operation-journal-types.js").HostOperationTicket,
    producer: import("./host-operation-journal-types.js").HostOperationTicket,
    input: import("./host-office-local-types.js").PrepareHostOfficeLocalInput): import("./host-office-local-types.js").HostOfficeLocalTicket;
  /** Original constructor-bound Host custody; never a DTO/callback registration or a safe receipt. */
  bindHostOfficeLocalDirectoryScopeAuthorityV2(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket,
    authority: import("./original-office-host-bridge.js").OriginalOfficeDirectoryAuthorityV2): void;
  closeHostOfficeLocalDirectoryWindowV2(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket): import("./host-office-local-directory-v2-types.js").HostOfficeLocalDirectoryCloseClaimV2;
  settleHostOfficeLocalDirectoryExecutionV2(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket): import("./host-office-local-directory-v2-types.js").HostOfficeLocalDirectoryCommittedPairV2;
  prepareHostOfficeLocalDirectoryEffectV2(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket,
    input: import("./host-office-local-directory-v2-types.js").PrepareHostOfficeLocalDirectoryEffectV2): import("./host-office-local-directory-v2-types.js").HostOfficeLocalDirectoryEffectRecordV2;
  launchHostOfficeLocalDirectoryEffectV2<T>(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket, effectId: string, effect: () => T): T;
  recordHostOfficeLocalDirectoryObservationV2(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket,
    effectId: string, artifactId: string): import("./host-office-local-directory-v2-types.js").HostOfficeLocalDirectoryEffectRecordV2;
  getHostOfficeLocalDirectoryExecutionV2(executionId: string): import("./host-office-local-directory-v2-types.js").HostOfficeLocalDirectoryExecutionRecordV2 | undefined;
  listHostOfficeLocalDirectoryEffectsV2(executionId: string): import("./host-office-local-directory-v2-types.js").HostOfficeLocalDirectoryEffectRecordV2[];
  sealHostOfficeLocalDirectoryTerminalV2(ticket: import("./host-office-local-types.js").HostOfficeLocalTicket,
    input: import("./host-office-local-terminal-types.js").SealHostOfficeLocalTerminalInput): import("./host-office-local-directory-v2-terminal-types.js").HostOfficeLocalDirectoryTerminalRecordV2;
  getHostOfficeLocalDirectoryTerminalV2(executionId: string): import("./host-office-local-directory-v2-terminal-types.js").HostOfficeLocalDirectoryTerminalRecordV2 | undefined;
  prepareHostMediaExecution(parent: import("./host-operation-journal-types.js").HostOperationTicket,
    transport: import("./host-operation-journal-types.js").HostOperationTicket,
    input: import("./host-media-operation-types.js").PrepareHostMediaExecutionInput): import("./host-media-operation-types.js").HostMediaExecutionTicket;
  bindHostMediaChildExecution(ticket: import("./host-media-operation-types.js").HostMediaExecutionTicket,
    child: RuntimeAttemptFenceV1): import("./host-media-operation-types.js").HostMediaExecutionRecord;
  prepareHostMediaEffect(ticket: import("./host-media-operation-types.js").HostMediaExecutionTicket,
    input: import("./host-media-operation-types.js").PrepareHostMediaEffectInput): import("./host-media-operation-types.js").HostMediaEffectRecord;
  launchHostMediaEffect<T>(ticket: import("./host-media-operation-types.js").HostMediaExecutionTicket, effectId: string, send: () => T): T;
  getHostMediaExecution(executionId: string): import("./host-media-operation-types.js").HostMediaExecutionRecord | undefined;
  listHostMediaEffects(executionId: string): import("./host-media-operation-types.js").HostMediaEffectRecord[];
  recordHostMediaResponse(ticket: import("./host-media-operation-types.js").HostMediaExecutionTicket, effectId: string, artifactId: string): import("./host-media-operation-types.js").HostMediaExecutionRecord;
  recordHostMediaSubmission(ticket: import("./host-media-operation-types.js").HostMediaExecutionTicket, artifactId: string): import("./host-media-operation-types.js").HostMediaExecutionRecord;
  recordHostMediaSubmissionAndExecutionHandle(ticket: import("./host-media-operation-types.js").HostMediaExecutionTicket,
    submissionArtifactId: string, projection: import("./host-media-receipt-types.js").HostMediaSubmissionExecutionProjection): import("./host-media-operation-types.js").HostMediaExecutionRecord;
  recordHostMediaTerminal(ticket: import("./host-media-operation-types.js").HostMediaExecutionTicket, artifactId: string): import("./host-media-operation-types.js").HostMediaExecutionRecord;
  recordHostMediaArtifactManifest(ticket: import("./host-media-operation-types.js").HostMediaExecutionTicket, artifactId: string): import("./host-media-operation-types.js").HostMediaExecutionRecord;
  finalizeHostMediaExecution(ticket: import("./host-media-operation-types.js").HostMediaExecutionTicket, artifactId: string): import("./host-media-operation-types.js").HostMediaExecutionRecord;
  recordHostMediaEffectNoStart(ticket: import("./host-media-operation-types.js").HostMediaExecutionTicket, effectId: string, artifactId: string): import("./host-media-operation-types.js").HostMediaExecutionRecord;
  readonly paths: LingStackRuntimePaths;
  commitRemoteConversationSend(input: CommitRemoteConversationSendInput, now: string): CommitRemoteConversationSendResult;
  getRemoteCommandReceipt(commandId: string): RemoteCommandReceipt | undefined;
  compactRemoteCommandReceipts(now: string): { readonly compacted: number; readonly purged: number };
  listRemoteDispatchIntents(options?: ListRemoteDispatchIntentsOptions): RemoteDispatchIntent[];
  claimRemoteDispatchIntent(
    intentId: string,
    input: { readonly workerId: string; readonly claimExpiresAt: string },
    now: string,
  ): RemoteDispatchIntent | undefined;
  completeRemoteDispatchIntent(intentId: string, now: string): RemoteDispatchIntent | undefined;
  failRemoteDispatchIntent(intentId: string, errorMessage: string, retryAt: string, now: string): RemoteDispatchIntent | undefined;
  listRemoteProjectionOutbox(options?: ListRemoteProjectionOutboxOptions): RemoteProjectionOutboxRecord[];
  getRemoteProjectionEntityVersion(input: RemoteProjectionEntityVersionInput): RemoteProjectionEntityVersion;
  getLatestConversationActivitySeq(input: RemoteConversationActivityInput): number;
  markRemoteProjectionOutboxProcessed(activitySeqs: readonly number[], now: string): number;
  getConversationReadState(input: Omit<MarkConversationReadInput, "throughActivitySeq">, now: string): ConversationReadState;
  markConversationRead(input: MarkConversationReadInput, now: string): ConversationReadState;
  commitConversationMessageEdit(input: CommitConversationMessageEditInput, now: string): CommitConversationMessageEditResult;
  listConversationMessageRevisions(options: ListConversationMessageRevisionsOptions): ConversationMessageRevision[];
  getConversationTurnSupersession(id: string): ConversationTurnSupersession | undefined;
  getConversationTurnSupersessionByIdempotency(idempotencyKey: string): ConversationTurnSupersession | undefined;
  listConversationTurnSupersessions(options?: ListConversationTurnSupersessionsOptions): ConversationTurnSupersession[];
  updateConversationTurnSupersession(
    id: string,
    input: { readonly replacementTurnId?: string | null; readonly replacementStatus?: ConversationReplacementStatus; readonly failureReason?: string | null },
    now: string,
  ): ConversationTurnSupersession | undefined;
  createLingThread(input: CreateLingThreadInput, now: string): LingThread;
  resolveOrCreateConversationThread(
    input: ResolveOrCreateConversationThreadInput,
    now: string,
  ): ResolveOrCreateConversationThreadResult;
  getLingThread(threadId: string): LingThread | undefined;
  hardDeleteLingThread(threadId: string, input: HardDeleteLingThreadInput, now: string): HardDeleteLingThreadResult | undefined;
  findLingThreadByOwner(input: {
    readonly kind: LingThreadKind;
    readonly taskId?: string;
    readonly workflowStepId?: string;
    readonly externalWorkId?: string;
    readonly teammateId?: string;
    readonly channelId?: string;
  }): LingThread | undefined;
  listLingThreads(options?: ListLingThreadsOptions): LingThread[];
  searchLingThreads(options: ListLingThreadsOptions & { readonly q: string }): SearchLingThreadsResult;
  updateLingThread(threadId: string, input: UpdateLingThreadInput, now: string): LingThread | undefined;
  getLingThreadConversationMode(threadId: string): ConversationModeState | undefined;
  updateLingThreadConversationMode(threadId: string, input: UpdateLingThreadConversationModeInput, now: string): ConversationModeState | undefined;
  getLingThreadGoal(threadId: string): LingThreadGoal | undefined;
  createLingThreadGoal(input: CreateLingThreadGoalInput, now: string): LingThreadGoal;
  replaceLingThreadGoal(input: CreateLingThreadGoalInput, now: string): LingThreadGoal;
  updateLingThreadGoal(goalId: string, input: UpdateLingThreadGoalInput, now: string): LingThreadGoal | undefined;
  clearLingThreadGoal(threadId: string, now: string): LingThreadGoal | undefined;
  getProposedPlanArtifact(planId: string): ProposedPlanArtifact | undefined;
  listProposedPlanArtifacts(options: ListProposedPlanArtifactsOptions): ProposedPlanArtifact[];
  upsertProposedPlanArtifact(input: CreateProposedPlanArtifactInput, now: string): ProposedPlanArtifact;
  updateProposedPlanArtifact(planId: string, input: UpdateProposedPlanArtifactInput, now: string): ProposedPlanArtifact | undefined;
  rebuildLingThreadMetadata(threadId: string, now: string): LingThread | undefined;
  rebuildLingThreadMetadataForRun(runId: string, now: string): LingThread | undefined;
  createLingTurn(input: CreateLingTurnInput, now: string): LingTurn;
  getLingTurn(turnId: string): LingTurn | undefined;
  listLingTurns(options: ListLingTurnsOptions): LingTurn[];
  linkRunToLingTurn(input: LinkRunToLingTurnInput): LingTurnRun;
  getLingTurnForRun(runId: string): LingTurn | undefined;
  listLingTurnRuns(turnId: string): LingTurnRun[];
  reconcileLingTurnStatus(turnId: string, now: string): LingTurn | undefined;
  transitionLingTurnStatus(input: TransitionLingTurnStatusInput): TransitionResult<LingTurnStatus>;
  createTerminalReportDraft(input: CreateLingTerminalReportInput, now: string): LingTerminalReportRecord;
  getTerminalReport(id: string): LingTerminalReportRecord | undefined;
  getTerminalReportForSource(
    sourceKind: TerminalReportSourceKind,
    sourceId: string,
    generation?: number,
    workspaceId?: string,
  ): LingTerminalReportRecord | undefined;
  listTerminalReports(options?: ListLingTerminalReportsOptions): LingTerminalReportRecord[];
  updateTerminalReportDraft(input: UpdateLingTerminalReportDraftInput): LingTerminalReportRecord;
  commitTerminalReport(input: CommitLingTerminalReportInput): LingTerminalReportRecord;
  markTerminalReportPublished(input: MarkLingTerminalReportPublishedInput): LingTerminalReportRecord;
  commitTerminalReportPublication(
    input: import("./terminal-report-publication-types.js").CommitTerminalReportPublicationInput,
  ): import("./terminal-report-publication-types.js").CommitTerminalReportPublicationResult;
  failTerminalReport(input: FailLingTerminalReportInput): LingTerminalReportRecord;
  createRun(input: CreateRunInput): RunSession;
  markRunStarted(runId: string, startedAt: string): void;
  markRunWaitingForApproval(runId: string, updatedAt: string): void;
  markRunRunning(runId: string, updatedAt: string): void;
  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): void;
  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): void;
  markRunCancelled(runId: string, endedAt: string, summaryPath?: string): void;
  appendEvent<K extends RunEventType>(runId: string, type: K, data: RunEventDataByType[K]): Extract<RunEventEnvelope, { readonly type: K }>;
  /** Runner callbacks must supply the Host identity captured before dispatch. */
  appendExecutionEvent<K extends RunEventType>(runId: string, sourceFence: RuntimeAttemptFenceV1, type: K, data: RunEventDataByType[K]): Extract<RunEventEnvelope, { readonly type: K }>;
  isCurrentRunExecutionOwner(runId: string, sourceFence: RuntimeAttemptFenceV1, allowCleanup?: boolean): boolean;
  transitionRunExecutionStatus(input: Parameters<RunStore["transitionRunStatus"]>[0] & { readonly sourceFence: RuntimeAttemptFenceV1 }): TransitionResult<RunStatus>;
  appendIgnoredRunnerCompletionEvent(runId: string, data: RunEventDataByType["stale_runner_completion_ignored"]): Extract<RunEventEnvelope, { readonly type: "stale_runner_completion_ignored" }>;
  appendControlPlaneEvent(input: AppendControlPlaneEventInput, now: string): ControlPlaneEvent;
  getControlPlaneEventByIdempotency(workspaceId: string, idempotencyKey: string): ControlPlaneEvent | undefined;
  listControlPlaneEvents(options: ListControlPlaneEventsOptions): ControlPlaneEvent[];
  getLatestControlPlaneEventSeq(workspaceId: string): number;
  getControlPlaneReplayState(workspaceId: string): ControlPlaneReplayState;
  readControlPlaneReplayWindow(input: ReadControlPlaneReplayWindowInput): ControlPlaneReplayWindowResult;
  createChannelTeamEvidenceItem(input: CreateChannelTeamEvidenceItemInput, now: string): ChannelTeamEvidenceItem;
  getChannelTeamEvidenceItem(id: string): ChannelTeamEvidenceItem | undefined;
  listChannelTeamEvidenceItems(options: ListChannelTeamEvidenceItemsOptions): ChannelTeamEvidenceItem[];
  updateChannelTeamEvidenceItem(
    id: string,
    input: UpdateChannelTeamEvidenceItemInput,
    now: string,
  ): ChannelTeamEvidenceItem | undefined;
  listFoldedChannelTeamEvidenceForTurn(options: ListFoldedChannelTeamEvidenceForTurnOptions): FoldedExpertsReadModel;
  createReliabilityIncident(input: CreateReliabilityIncidentInput, now: string): ReliabilityIncident;
  listReliabilityIncidents(options?: ListReliabilityIncidentsOptions): ReliabilityIncident[];
  createAvailabilityIncident(input: CreateAvailabilityIncidentInput, now: string): AvailabilityIncident;
  listAvailabilityIncidents(options?: ListAvailabilityIncidentsOptions): AvailabilityIncident[];
  createProviderRuntimeAvailabilityIncident(input: CreateProviderRuntimeAvailabilityIncidentInput, now: string): AvailabilityIncident;
  listAvailabilityIncidentCandidates(options: ListAvailabilityIncidentCandidatesOptions): AvailabilityIncidentCandidatePage;
  createChannelTeamPattern(input: CreateChannelTeamPatternInput, now: string): ChannelTeamPattern;
  getChannelTeamPattern(id: string): ChannelTeamPattern | undefined;
  listChannelTeamPatterns(options: ListChannelTeamPatternsOptions): ChannelTeamPattern[];
  listActiveChannelTeamProvisionalRules(options: ListActiveChannelTeamProvisionalRulesOptions): ChannelTeamPattern[];
  updateChannelTeamPattern(id: string, input: UpdateChannelTeamPatternInput, now: string): ChannelTeamPattern | undefined;
  expireChannelTeamPatterns(now: string): number;
  createChannelTeamSnapshot(input: CreateChannelTeamSnapshotInput, now: string): ChannelTeamSnapshot;
  getChannelTeamSnapshot(id: string): ChannelTeamSnapshot | undefined;
  listChannelTeamSnapshots(options: ListChannelTeamSnapshotsOptions): ChannelTeamSnapshot[];
  createChannelTeamEvaluationRun(input: CreateChannelTeamEvaluationRunInput, now: string): ChannelTeamEvaluationRun;
  getChannelTeamEvaluationRun(id: string): ChannelTeamEvaluationRun | undefined;
  listChannelTeamEvaluationRuns(options: ListChannelTeamEvaluationRunsOptions): ChannelTeamEvaluationRun[];
  createSkillRegressionRun(input: CreateSkillRegressionRunInput, now: string): SkillRegressionRun;
  getSkillRegressionRun(id: string): SkillRegressionRun | undefined;
  listSkillRegressionRuns(options?: ListSkillRegressionRunsOptions): SkillRegressionRun[];
  getRun(runId: string): RunSession | undefined;
  listRuns(options?: ListRunsOptions): RunSession[];
  listEvents(runId: string, options?: ListRunEventsOptions): RunEventEnvelope[];
  getLatestRunCompactionStart(runId: string): Extract<RunEventEnvelope, { readonly type: "context_compaction_start" }> | undefined;
  countEvents(runId: string): number;
  /** Synchronous, read-only database snapshot. Callbacks must not perform I/O or return a Promise. */
  readSnapshot<T>(read: () => T): T;
  createWorkspaceMutationRecord(input: CreateWorkspaceMutationRecordInput): WorkspaceMutationRecord;
  createWorkspaceMutationRecords(inputs: readonly CreateWorkspaceMutationRecordInput[]): WorkspaceMutationRecord[];
  getWorkspaceMutationRecord(id: string): WorkspaceMutationRecord | undefined;
  listWorkspaceMutationRecords(options?: ListWorkspaceMutationRecordsOptions): WorkspaceMutationRecord[];
  getLatestWorkspaceProvenanceWatermark(workspaceId?: string): string;
  createCompactionCheckpoint(input: CreateCompactionCheckpointInput): CompactionCheckpoint;
  getCompactionCheckpoint(id: string): CompactionCheckpoint | undefined;
  listCompactionCheckpoints(options?: ListCompactionCheckpointsOptions): CompactionCheckpoint[];
  createRunCompactionCheckpoint(input: CreateRunCompactionCheckpointInput): RunCompactionCheckpointV1;
  getRunCompactionCheckpoint(id: string): RunCompactionCheckpointV1 | undefined;
  getLatestRunCompactionCheckpoint(runId: string): RunCompactionCheckpointV1 | undefined;
  listRunCompactionCheckpoints(options?: ListRunCompactionCheckpointsOptions): RunCompactionCheckpointV1[];
  transitionRunCompactionCheckpoint(input: TransitionRunCompactionCheckpointInput): RunCompactionCheckpointV1 | undefined;
  createPostCompactionUndoRecord(input: CreatePostCompactionUndoRecordInput): PostCompactionUndoRecord;
  getPostCompactionUndoRecord(id: string): PostCompactionUndoRecord | undefined;
  listPostCompactionUndoRecords(options?: ListPostCompactionUndoRecordsOptions): PostCompactionUndoRecord[];
  updatePostCompactionUndoRecord(input: UpdatePostCompactionUndoRecordInput): PostCompactionUndoRecord | undefined;
  createWorkspaceSnapshotManifest(input: CreateWorkspaceSnapshotManifestInput): WorkspaceSnapshotManifest;
  getWorkspaceSnapshotManifest(id: string): WorkspaceSnapshotManifest | undefined;
  listWorkspaceSnapshotManifests(options?: ListWorkspaceSnapshotManifestsOptions): WorkspaceSnapshotManifest[];
  createWorkspaceSnapshotEntries(inputs: readonly CreateWorkspaceSnapshotEntryInput[]): WorkspaceSnapshotEntry[];
  listWorkspaceSnapshotEntries(manifestId: string): WorkspaceSnapshotEntry[];
  getWorkspaceSnapshotBlob(sha256: string): WorkspaceSnapshotBlob | undefined;
  listWorkspaceSnapshotBlobs(): WorkspaceSnapshotBlob[];
  upsertWorkspaceSnapshotBlob(input: WorkspaceSnapshotBlob): WorkspaceSnapshotBlob;
  createWorkspaceSnapshotRestoreAnchor(input: CreateWorkspaceSnapshotRestoreAnchorInput): WorkspaceSnapshotRestoreAnchor;
  getWorkspaceSnapshotRestoreAnchor(id: string): WorkspaceSnapshotRestoreAnchor | undefined;
  createSnapshotRestoreRequest(input: CreateSnapshotRestoreRequestInput): SnapshotRestoreRequest;
  createSnapshotRestoreConfirmation(input: CreateSnapshotRestoreConfirmationInput): SnapshotRestoreConfirmation;
  getSnapshotRestoreConfirmation(id: string): SnapshotRestoreConfirmation | undefined;
  resolveSnapshotRestoreConfirmation(id: string, state: "confirmed" | "denied" | "expired", now: string): SnapshotRestoreConfirmation | undefined;
  getSnapshotRestoreRequest(id: string): SnapshotRestoreRequest | undefined;
  listSnapshotRestoreRequests(options?: ListSnapshotRestoreRequestsOptions): SnapshotRestoreRequest[];
  getSnapshotRestoreRequestByIdempotency(workspaceId: string, idempotencyKey: string): SnapshotRestoreRequest | undefined;
  updateSnapshotRestoreRequest(input: UpdateSnapshotRestoreRequestInput): SnapshotRestoreRequest | undefined;
  createSnapshotRestoreJournalEntries(inputs: readonly CreateSnapshotRestoreJournalEntryInput[]): SnapshotRestoreJournalEntry[];
  listSnapshotRestoreJournalEntries(options: ListSnapshotRestoreJournalOptions): SnapshotRestoreJournalEntry[];
  updateSnapshotRestoreJournalEntry(input: UpdateSnapshotRestoreJournalEntryInput): SnapshotRestoreJournalEntry | undefined;
  acquireWorkspaceSnapshotFence(workspaceId: string, ownerRequestId: string, now: string): number;
  getWorkspaceSnapshotFence(workspaceId: string): { readonly epoch: number; readonly ownerRequestId?: string };
  releaseWorkspaceSnapshotFence(workspaceId: string, ownerRequestId: string, now: string): boolean;
  expireWorkspaceSnapshotManifest(id: string, now: string): WorkspaceSnapshotManifest | undefined;
  deleteWorkspaceSnapshotManifest(id: string): boolean;
  deleteWorkspaceSnapshotBlob(sha256: string): boolean;
  commitWorkspaceSnapshot(input: CreateWorkspaceSnapshotManifestInput, entries: readonly CreateWorkspaceSnapshotEntryInput[]): { readonly manifest: WorkspaceSnapshotManifest; readonly entries: readonly WorkspaceSnapshotEntry[] };
  assertWorkspaceSnapshotFence(cwd: string): void;
  createRunIntervention(input: CreateRunInterventionInput, now: string): RunIntervention;
  getRunIntervention(interventionId: string): RunIntervention | undefined;
  listRunInterventions(options?: ListRunInterventionsOptions): RunIntervention[];
  claimNextRunIntervention(input: ClaimNextRunInterventionInput): RunIntervention | undefined;
  listPriorRunInterventionReplyMessages(input: ListPriorRunInterventionReplyMessagesInput): ChannelMessage[];
  updateRunInterventionStatus(input: UpdateRunInterventionStatusInput): RunIntervention | undefined;
  cancelRunIntervention(interventionId: string, now: string, reason?: string): RunIntervention | undefined;
  createWorkUnit(input: CreateWorkUnitInput): WorkUnit;
  getWorkUnit(workUnitId: string): WorkUnit | undefined;
  listWorkUnits(options?: ListWorkUnitsOptions): WorkUnit[];
  findWorkUnitByIdempotency(input: {
    readonly kind: WorkUnit["kind"];
    readonly ownerType: string;
    readonly ownerId: string;
    readonly idempotencyKey: string;
  }): WorkUnit | undefined;
  linkRunToWorkUnit(runId: string, workUnitId: string, now: string): RunSession | undefined;
  transitionWorkUnitStatus(input: {
    readonly workUnitId: string;
    readonly expectedStatus?: WorkUnitStatus;
    readonly event: WorkUnitTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly activeAttemptId?: string | null;
    readonly startedAt?: string;
    readonly endedAt?: string | null;
    readonly lastEventAt?: string;
    readonly lastHeartbeatAt?: string;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  } & (
    | {
        readonly attemptId?: never;
        readonly runtimeInstanceId?: never;
        readonly fencingToken?: never;
        readonly terminalAttemptOwnership?: never;
      }
    | (RuntimeAttemptFenceV1 & {
        /** Core-only reconciliation authority after the current process-owned Attempt is durably lost. */
        readonly terminalAttemptOwnership?: { readonly kind: "lost_attempt_reconciliation" };
      })
  )): TransitionResult<WorkUnitStatus>;
  createWorkUnitAttempt(input: CreateWorkUnitAttemptInput): WorkUnitAttempt;
  getWorkUnitAttempt(attemptId: string): WorkUnitAttempt | undefined;
  listWorkUnitAttempts(workUnitId: string): WorkUnitAttempt[];
  getRunnerContinuation(id: string): RunnerContinuationV1 | undefined;
  findRunnerContinuationByIdempotencyKey(idempotencyKey: string): RunnerContinuationV1 | undefined;
  listClaimableRunnerContinuations(input: ListClaimableRunnerContinuationsInput): readonly RunnerContinuationV1[];
  prepareContinuationAndAttempt(input: PrepareContinuationInput): PreparedContinuation;
  commitExistingRunContinuation(
    input: import("./harness/continuations.js").CommitExistingRunContinuationInput,
  ): import("./harness/continuations.js").CommitExistingRunContinuationResult;
  commitExistingRunContinuationPreparationFailure(
    input: import("./harness/continuations.js").CommitExistingRunContinuationPreparationFailureInput,
  ): import("./harness/continuations.js").CommitExistingRunContinuationPreparationFailureResult;
  commitStaleRunRecoveryFailure(
    input: import("./harness/continuations.js").CommitStaleRunRecoveryFailureInput,
  ): import("./harness/continuations.js").CommitStaleRunRecoveryFailureResult;
  reprepareContinuationAndAttempt(input: ReprepareContinuationInput): PreparedContinuation;
  deferRunnerContinuation(input: DeferRunnerContinuationInput): RunnerContinuationMutationResult;
  claimRunnerContinuation(input: ClaimRunnerContinuationInput): RunnerContinuationMutationResult;
  startRunnerContinuation(input: StartRunnerContinuationInput): RunnerContinuationMutationResult;
  finishRunnerContinuation(input: FinishRunnerContinuationInput): RunnerContinuationMutationResult;
  getHarnessToolExecution(id: string): HarnessToolExecutionV1 | undefined;
  findHarnessToolExecution(attemptId: string, toolCallId: string): HarnessToolExecutionV1 | undefined;
  listHarnessToolExecutions(runId: string): readonly HarnessToolExecutionV1[];
  prepareHarnessToolExecution(input: PrepareHarnessToolExecutionInput): PreparedHarnessToolExecution;
  resolveHarnessToolApproval(input: ResolveHarnessToolApprovalInput): HarnessToolExecutionMutationResult;
  claimHarnessToolExecution(input: ClaimHarnessToolExecutionInput): HarnessToolExecutionMutationResult;
  startHarnessToolExecution(input: StartHarnessToolExecutionInput): HarnessToolExecutionMutationResult;
  finishHarnessToolExecution(input: FinishHarnessToolExecutionInput): HarnessToolExecutionMutationResult;
  failApprovedHarnessToolExecution(input: FailApprovedHarnessToolExecutionInput): HarnessToolExecutionMutationResult;
  reconcileAbandonedHarnessToolExecutions(
    input: ReconcileAbandonedHarnessToolExecutionsInput,
  ): readonly HarnessToolExecutionV1[];
  reconcileAbandonedHarnessToolExecutionsPage(
    input: ReconcileAbandonedHarnessToolExecutionsPageInput,
  ): HarnessToolExecutionRecoveryPage;
  getRunEvaluation(id: string): RunEvaluationV1 | undefined;
  getRunEvaluationGrade(id: string): RunEvaluationGradeV1 | undefined;
  findRunEvaluationByIdempotencyKey(idempotencyKey: string): RunEvaluationV1 | undefined;
  listRunEvaluations(input?: ListRunEvaluationsInput): readonly RunEvaluationV1[];
  listClaimableRunEvaluations(input: ListClaimableRunEvaluationsInput): readonly RunEvaluationV1[];
  listRunEvaluationGrades(evaluationId: string): readonly RunEvaluationGradeV1[];
  enqueueRunEvaluation(input: EnqueueRunEvaluationInput): EnqueuedRunEvaluation;
  claimRunEvaluation(input: ClaimRunEvaluationInput): RunEvaluationMutationResult;
  startRunEvaluation(input: StartRunEvaluationInput): RunEvaluationMutationResult;
  requeueRunEvaluation(input: RequeueRunEvaluationInput): RunEvaluationMutationResult;
  failRunEvaluation(input: FailRunEvaluationInput): RunEvaluationMutationResult;
  completeRunEvaluation(input: CompleteRunEvaluationInput): CompleteRunEvaluationResult;
  appendRunEvaluationGrade(input: AppendRunEvaluationGradeInput): AppendRunEvaluationGradeResult;
  updateWorkUnitAttemptStatus(input: {
    readonly attemptId: string;
    readonly workUnitId: string;
    readonly runtimeInstanceId: string;
    readonly fencingToken: string;
    readonly status: WorkUnitAttempt["status"];
    readonly now: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly lastEventAt?: string;
    readonly lastHeartbeatAt?: string;
    readonly abortRequestedAt?: string;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  }): WorkUnitAttempt | undefined;
  /**
   * Atomically closes the canonical Work Unit, its current Attempt, and the
   * terminal runtime audit event under one Attempt fence.
   */
  transitionWorkUnitAttemptTerminal(input: RuntimeAttemptFenceV1 & {
    readonly event: WorkUnitTransitionEvent;
    readonly attemptStatus: TerminalAttemptStatus;
    readonly runtimeEventType: TerminalRuntimeEventType;
    readonly actor: StateTransitionActor;
    readonly now: string;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  }): boolean;
  appendRuntimeEvent(input: AppendRuntimeEventInput): RuntimeEvent;
  appendTerminalRuntimeAudit(input: AppendTerminalRuntimeAuditInput): RuntimeEvent;
  appendRuntimeDiagnosticEvent(input: import("./runtime-supervisor-types.js").AppendRuntimeDiagnosticEventInput): RuntimeEvent;
  listRuntimeEvents(workUnitId: string, options?: ListRuntimeEventsOptions): RuntimeEvent[];
  recordRuntimeHeartbeat(input: RecordRuntimeHeartbeatInput): RuntimeHeartbeat;
  acquireRuntimeSemaphoreSlot(input: AcquireRuntimeSemaphoreSlotInput): RuntimeSemaphoreSlot | undefined;
  renewRuntimeSemaphoreSlotsForAttempt(fence: RuntimeAttemptFenceV1, renewedAt: string): number;
  releaseRuntimeSemaphoreSlotsForAttempt(fence: RuntimeAttemptFenceV1, releasedAt: string, releaseReason: string): number;
  expireRuntimeSemaphoreSlots(now: string): number;
  listRuntimeSemaphoreSlots(options?: ListRuntimeSemaphoreSlotsOptions): RuntimeSemaphoreSlot[];
  createArtifact(input: CreateRunArtifactInput): RunArtifact;
  getArtifact(artifactId: string): RunArtifact | undefined;
  listArtifacts(runId: string): RunArtifact[];
  listMediaJobArtifacts(mediaJobId: string): RunArtifact[];
  listExternalWorkArtifacts(externalWorkId: string): RunArtifact[];
  recoverStaleRuns(now: string): number;
  recoverStaleChannelWorkflows(now: string): number;
  listStateTransitionEvents(options?: ListStateTransitionEventsOptions): StateTransitionEvent[];
  recordStateTransitionEvent(input: CreateStateTransitionEventInput): StateTransitionEvent;
  findStateTransitionByIdempotency(
    entityType: StateTransitionEvent["entityType"],
    entityId: string,
    idempotencyKey: string,
  ): StateTransitionEvent | undefined;
  transitionTaskStatus(input: {
    readonly taskId: string;
    readonly expectedStatus?: Task["status"];
    readonly event: TaskTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly currentRunId?: string | null;
    readonly assigneeTeammateId?: string | null;
  }): TransitionResult<Task["status"]>;
  transitionRunStatus(input: {
    readonly runId: string;
    readonly expectedStatus?: RunStatus;
    readonly event: RunTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly startedAt?: string;
    readonly endedAt?: string | null;
    readonly summaryPath?: string | null;
    readonly errorMessage?: string | null;
  }): TransitionResult<RunStatus>;
  acquireResourceLease(input: CreateResourceLeaseInput): ResourceLease | undefined;
  renewResourceLeasesForAttempt(fence: RuntimeAttemptFenceV1, renewedAt: string): number;
  releaseResourceLeasesForAttempt(fence: RuntimeAttemptFenceV1, releasedAt: string, releaseReason: string): number;
  releaseResourceLeasesForOwner(ownerType: ResourceLeaseOwnerLevelType, ownerId: string, releasedAt: string): number;
  expireResourceLeases(now: string): number;
  listResourceLeases(options?: ListResourceLeasesOptions): ResourceLease[];
  getBlockingResourceLease(resourceType: ResourceLease["resourceType"], resourceKey: string): ResourceLease | undefined;
  getUserProfile(now: string): UserProfile;
  updateUserProfile(input: UpdateUserProfileInput, now: string): UserProfile;
  getWorkspaceSettings(): WorkspaceSettings;
  updateWorkspaceSettings(input: UpdateWorkspaceSettingsInput, now: string): WorkspaceSettings;
  createChannel(input: CreateChannelInput, now: string): Channel;
  getChannel(id: string): Channel | undefined;
  listChannels(options?: ListChannelsOptions): Channel[];
  updateChannel(id: string, input: ChannelUpdateInput, now: string): Channel | undefined;
  deleteChannel(id: string): boolean;
  createChannelBranch(input: CreateChannelBranchInput, now: string): ChannelBranch;
  getChannelBranch(id: string): ChannelBranch | undefined;
  listChannelBranches(options?: ListChannelBranchesOptions): ChannelBranch[];
  updateChannelBranch(id: string, input: ChannelBranchUpdateInput, now: string): ChannelBranch | undefined;
  deleteChannelBranch(id: string): boolean;
  createTask(input: CreateTaskInput, now: string): Task;
  getTask(id: string): Task | undefined;
  listTasks(options?: ListTasksOptions): Task[];
  updateTask(id: string, input: TaskUpdateInput, now: string): Task | undefined;
  deleteTask(id: string): boolean;
  createAiTeammate(input: CreateAiTeammateInput, now: string): AiTeammate;
  getAiTeammate(id: string): AiTeammate | undefined;
  listAiTeammates(options?: ListAiTeammatesOptions): AiTeammate[];
  updateAiTeammate(id: string, input: AiTeammateUpdateInput, now: string): AiTeammate | undefined;
  disableAiTeammate(id: string, now: string): AiTeammate | undefined;
  hardDeleteAiTeammate(id: string, input: HardDeleteAiTeammateInput, now: string): HardDeleteAiTeammateResult | undefined;
  getAiCouncil(id: string): AiCouncil | undefined;
  listAiCouncils(options?: ListAiCouncilsOptions): AiCouncil[];
  createAiCouncil(input: CreateAiCouncilInput, now: string): AiCouncil;
  cloneAiCouncil(sourceCouncilId: string, input: CloneAiCouncilInput, now: string): AiCouncil;
  updateAiCouncil(id: string, input: UpdateAiCouncilInput, now: string): AiCouncil | undefined;
  getAiCouncilHealthReport(generatedAt: string, options?: AiCouncilHealthReportOptions): AiCouncilHealthReport;
  listAiCouncilMembers(councilId: string): AiCouncilMember[];
  replaceAiCouncilMembers(
    councilId: string,
    members: readonly ReplaceAiCouncilMemberInput[],
    now: string,
  ): AiCouncilMember[];
  getChannelCouncilPolicy(channelId: string): ChannelCouncilPolicy | undefined;
  upsertChannelCouncilPolicy(channelId: string, input: UpsertChannelCouncilPolicyInput, now: string): ChannelCouncilPolicy;
  getEffectiveChannelCouncil(channelId: string): EffectiveChannelCouncilProjection | undefined;
  listTeammateChannelMemberships(teammateId: string): TeammateChannelMembership[];
  replaceTeammateChannelMemberships(
    teammateId: string,
    memberships: readonly ReplaceTeammateChannelMembershipInput[],
    now: string,
  ): TeammateChannelMembership[];
  listTeammateSkillBindings(teammateId: string): TeammateSkillBinding[];
  replaceTeammateSkillBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateSkillBindingInput[],
    now: string,
  ): TeammateSkillBinding[];
  listTeammateMemoryScopes(teammateId: string): TeammateMemoryScope[];
  replaceTeammateMemoryScopes(
    teammateId: string,
    scopes: readonly ReplaceTeammateMemoryScopeInput[],
    now: string,
  ): TeammateMemoryScope[];
  createMemoryConsolidationJob(input: CreateMemoryConsolidationJobInput, now: string): MemoryConsolidationJob;
  getMemoryConsolidationJob(id: string): MemoryConsolidationJob | undefined;
  listMemoryConsolidationJobs(options?: ListMemoryConsolidationJobsOptions): MemoryConsolidationJob[];
  updateMemoryConsolidationJob(id: string, input: UpdateMemoryConsolidationJobInput, now: string): MemoryConsolidationJob | undefined;
  createMemoryObject(input: CreateMemoryObjectInput, now: string): MemoryObject;
  getMemoryObject(id: string): MemoryObject | undefined;
  listMemoryObjects(options?: ListMemoryObjectsOptions): MemoryObject[];
  updateMemoryObject(id: string, input: MemoryObjectUpdateInput, now: string): MemoryObject | undefined;
  getMemorySelfImprovingMetadata(memoryId: string): MemorySelfImprovingMetadata | undefined;
  upsertMemorySelfImprovingMetadata(input: UpsertMemorySelfImprovingMetadataInput): MemorySelfImprovingMetadata;
  listMemorySelfImprovingMetadata(options?: ListMemorySelfImprovingMetadataOptions): MemorySelfImprovingMetadata[];
  getMemoryReviewPolicy(workspaceId?: string): MemoryReviewPolicy;
  updateMemoryReviewPolicy(input: MemoryReviewPolicyUpdateInput, now: string): MemoryReviewPolicy;
  recordMemoryReviewDecision(input: CreateMemoryReviewDecisionInput, now: string): MemoryReviewDecision;
  getLatestMemoryReviewDecision(memoryId: string): MemoryReviewDecision | undefined;
  listMemoryPromotionInbox(options?: ListMemoryPromotionInboxOptions): MemoryPromotionInboxItem[];
  applyMemoryReviewAction(input: ApplyMemoryReviewActionInput, now: string): { readonly memory: MemoryObject; readonly action: MemoryReviewActionRecord };
  recallMemory(input: MemoryRecallRequest): MemoryRecallResult;
  /** Recheck selected IDs with recall's current scope/health predicate; never re-rank or return bodies. */
  getEligibleMemoryIdsForRecall(input: MemoryRecallRequest, memoryIds: readonly string[]): readonly string[];
  recordUsedMemoryEvent(input: CreateUsedMemoryEventInput, now: string): UsedMemoryEvent;
  listUsedMemoryEvents(options?: ListUsedMemoryEventsOptions): UsedMemoryEvent[];
  upsertGovernanceNotification(input: CreateGovernanceNotificationInput, now: string): UpsertGovernanceNotificationResult;
  getGovernanceNotification(id: string): GovernanceNotification | undefined;
  listGovernanceNotifications(options?: ListGovernanceNotificationsOptions): GovernanceNotification[];
  updateGovernanceNotificationDelivery(id: string, input: UpdateGovernanceNotificationDeliveryInput, now: string): GovernanceNotification | undefined;
  markGovernanceNotificationSeen(id: string, now: string): GovernanceNotification | undefined;
  dismissGovernanceNotification(id: string, now: string): GovernanceNotification | undefined;
  resolveGovernanceNotificationByDedupeKey(workspaceId: string, dedupeKey: string, now: string): GovernanceNotification | undefined;
  getGovernanceNotificationSummary(workspaceId?: string, generatedAt?: string): GovernanceNotificationSummary;
  getOrCreateTeammateDirectThread(teammateId: string, now: string): TeammateDirectThread;
  listTeammateDirectThreads(options?: ListTeammateDirectThreadsOptions): TeammateDirectThread[];
  updateTeammateDirectThreadWorkspace(threadId: string, workspaceBinding: DirectWorkspaceBinding | null, now: string): TeammateDirectThread | undefined;
  listTeammateDirectMessages(options: ListTeammateDirectMessagesOptions): TeammateDirectMessage[];
  listTeammateDirectMessagesPage(options: ListTeammateDirectMessagesOptions): TeammateDirectMessageListPage;
  getTeammateDirectMessage(id: string): TeammateDirectMessage | undefined;
  createTeammateDirectMessage(input: CreateTeammateDirectMessageInput, now: string): TeammateDirectMessage;
  updateTeammateDirectMessageRuntime(
    id: string,
    input: {
      readonly body?: string;
      readonly status?: TeammateDirectMessage["status"];
      readonly errorMessage?: string | null;
      readonly linkedRunId?: string | null;
    },
    now: string,
  ): TeammateDirectMessage | undefined;
  createTeammateDirectLinkPreview(input: CreateTeammateDirectLinkPreviewInput, now: string): TeammateDirectLinkPreview;
  getTeammateDirectLinkPreview(id: string): TeammateDirectLinkPreview | undefined;
  listTeammateDirectLinkPreviews(options: ListTeammateDirectLinkPreviewsOptions): TeammateDirectLinkPreview[];
  updateTeammateDirectLinkPreview(id: string, input: UpdateTeammateDirectLinkPreviewInput, now: string): TeammateDirectLinkPreview | undefined;
  createTeammateDirectReplyIntervention(input: CreateTeammateDirectReplyInterventionInput, now: string): TeammateDirectReplyIntervention;
  getTeammateDirectReplyIntervention(interventionId: string): TeammateDirectReplyIntervention | undefined;
  listTeammateDirectReplyInterventions(options?: ListTeammateDirectReplyInterventionsOptions): TeammateDirectReplyIntervention[];
  updateTeammateDirectReplyInterventionStatus(input: UpdateTeammateDirectReplyInterventionStatusInput): TeammateDirectReplyIntervention | undefined;
  cancelTeammateDirectReplyIntervention(interventionId: string, now: string, reason?: string): TeammateDirectReplyIntervention | undefined;
  createTeammatePrivateAttachment(input: CreateTeammatePrivateAttachmentInput): TeammatePrivateAttachment;
  getTeammatePrivateAttachment(id: string): TeammatePrivateAttachment | undefined;
  listTeammatePrivateAttachments(options: ListTeammatePrivateAttachmentsOptions): TeammatePrivateAttachment[];
  deleteTeammatePrivateAttachment(id: string): boolean;
  appendConversationItem(input: AppendConversationItem, now: string): ConversationItemV1;
  publishNormalRunNarration(runId: string, now: string): import("./normal-run-narration-types.js").PublishNormalRunNarrationResult;
  createNormalConversationFork(input: import("./normal-conversation-fork-types.js").CreateNormalConversationFork,
    capture: import("./normal-conversation-fork-types.js").CaptureNormalConversationFork, now: string): import("./normal-conversation-fork-types.js").CreateNormalConversationForkResult;
  getNormalConversationForkSeed(childThreadId: string): import("./normal-conversation-fork-types.js").NormalConversationForkSeed | undefined;
  listUnpublishedNormalNarrationRunIds(afterRunId: string, limit: number): string[];
  createUserInputRequest(input: import("./user-input-store-types.js").CreateUserInputRequest, now: string): import("./user-input-store-types.js").CreateUserInputRequestResult;
  getUserInputRequest(threadId: string, requestId: string): import("./user-input-store-types.js").UserInputRequest | undefined;
  readUserInputTranscript(input: import("./user-input-store-types.js").ReadUserInputTranscript): readonly import("@ling-stack/contracts").UserInputTranscriptItemV1[];
  findRequiredUserInputForAttempt(input: import("./user-input-store-types.js").FindRequiredUserInputForAttempt): import("./user-input-store-types.js").UserInputRequest | undefined;
  submitUserInputAnswer(input: import("./user-input-store-types.js").SubmitUserInputAnswer, now: string): import("./user-input-store-types.js").UserInputAnswerReceipt;
  cancelUserInputRequest(input: import("./user-input-store-types.js").CancelUserInputRequest, now: string): import("./user-input-store-types.js").UserInputRequest;
  listPendingUserInputDeliveries(options: import("./user-input-store-types.js").ListPendingUserInputDeliveries): readonly import("./user-input-store-types.js").PendingUserInputDelivery[];
  commitUserInputYield(input: import("./user-input-wait-types.js").CommitUserInputYield, now: string): import("./user-input-wait-types.js").CommitUserInputYieldResult;
  getUserInputWait(threadId: string, requestId: string): import("./user-input-wait-types.js").UserInputWait | undefined;
  getUserInputDelivery(threadId: string, deliveryId: string): import("./user-input-delivery-types.js").UserInputDelivery | undefined;
  getUserInputContinuationSeed(threadId: string, deliveryId: string): import("./user-input-continuation-types.js").UserInputContinuationSeed | undefined;
  listDueUserInputDeliveries(input: import("./user-input-delivery-types.js").ListDueUserInputDeliveries, now: string): readonly import("./user-input-delivery-types.js").UserInputDelivery[];
  claimUserInputDelivery(input: import("./user-input-delivery-types.js").ClaimUserInputDelivery, now: string): import("./user-input-delivery-types.js").UserInputDelivery | null;
  retryUserInputDelivery(input: import("./user-input-delivery-types.js").RetryUserInputDelivery, now: string): import("./user-input-delivery-types.js").UserInputDelivery;
  saveUserInputContinuationPreparation(input: import("./user-input-host-continuation-types.js").SaveUserInputContinuationPreparation, now: string): { readonly snapshot: import("./user-input-host-continuation-types.js").UserInputContinuationPreparation; readonly idempotentReplay: boolean };
  getUserInputContinuationPreparation(threadId: string, deliveryId: string, stage: import("./user-input-host-continuation-types.js").UserInputPreparationStage): import("./user-input-host-continuation-types.js").UserInputContinuationPreparation | undefined;
  admitUserInputContinuation(input: import("./user-input-host-continuation-types.js").AdmitUserInputContinuation, now: string): import("./user-input-host-continuation-types.js").UserInputContinuationBinding;
  getUserInputContinuationBinding(threadId: string, deliveryId: string): import("./user-input-host-continuation-types.js").UserInputContinuationBinding | undefined;
  acknowledgeUserInputContinuation(input: import("./user-input-host-continuation-types.js").AcknowledgeUserInputContinuation, now: string): { readonly receipt: import("./user-input-host-continuation-types.js").UserInputContinuationReceipt; readonly replayed: boolean };
  getUserInputContinuationReceipt(threadId: string, deliveryId: string): import("./user-input-host-continuation-types.js").UserInputContinuationReceipt | undefined;
  cancelUserInputWait(input: import("./user-input-wait-types.js").CancelUserInputWait, now: string): import("./user-input-wait-types.js").CancelUserInputWaitResult;
  appendConversationUserTurn(input: AppendConversationUserTurnInput, now: string): AppendConversationUserTurnResult;
  appendConversationUserTurnWithAcceptedSnapshot(
    input: import("./conversation-accepted-input-types.js").AppendConversationAcceptedInput,
    capture: import("./conversation-accepted-input-types.js").CaptureConversationAcceptedInput,
    now: string,
  ): import("./conversation-accepted-input-types.js").AppendConversationAcceptedInputResult;
  getConversationAcceptedInputSnapshot(sourceItemId: string): import("./conversation-accepted-input-types.js").ConversationAcceptedInputSnapshot | undefined;
  appendTeammateDirectUserTurnWithInputSnapshot(input: import("./teammate-direct-input-types.js").AppendTeammateDirectInput, now: string): import("./teammate-direct-input-types.js").AppendTeammateDirectInputResult;
  getTeammateDirectInputSnapshot(sourceItemId: string, teammateId: string): import("./teammate-direct-input-types.js").TeammateDirectInputSnapshot | undefined;
  saveConversationPreparedInput(input: import("./conversation-prepared-input-types.js").SaveConversationPreparedInput, now: string): import("./conversation-prepared-input-types.js").SaveConversationPreparedInputResult;
  getConversationPreparedInput(sourceItemId: string, stage: import("./conversation-prepared-input-types.js").ConversationPreparedInputStage): import("./conversation-prepared-input-types.js").ConversationPreparedInputSnapshot | undefined;
  getConversationItem(id: string): ConversationItemV1 | undefined;
  getEffectiveConversationItem(id: string): ConversationItemV1 | undefined;
  getConversationItemByIdempotencyKey(threadId: string, idempotencyKey: string): ConversationItemV1 | undefined;
  findConversationItemByDomainRef(
    input: import("./conversation-item-store-types.js").FindConversationItemByDomainRefInput,
  ): ConversationItemV1 | undefined;
  listConversationItemsForTurn(
    options: import("./conversation-item-store-types.js").ListConversationItemsForTurnOptions,
  ): readonly ConversationItemV1[];
  listConversationItemsPage(options: ListConversationItemsOptions): ConversationItemListPage;
  listConversationItemsByChannelPage(
    options: ListConversationItemsByChannelOptions,
  ): ConversationItemChannelListPage;
  listConversationItemsForSegment(
    options: import("./conversation-item-store-types.js").ListConversationItemsForSegmentOptions,
  ): readonly ConversationItemV1[];
  updatePendingConversationItem(
    itemId: string,
    input: UpdatePendingConversationItemInput,
    now: string,
  ): ConversationItemV1;
  getContextSegment(id: string): import("@ling-stack/contracts").ContextSegment | undefined;
  listContextSegments(
    options: import("./conversation-context-store-types.js").ListContextSegmentsOptions,
  ): readonly import("@ling-stack/contracts").ContextSegment[];
  getEffectiveTurnContextAssignment(
    turnId: string,
  ): import("@ling-stack/contracts").TurnContextAssignment | undefined;
  applyTurnContextAssignment(
    input: import("./conversation-context-store-types.js").ApplyTurnContextAssignmentInput,
    now: string,
  ): import("./conversation-context-store-types.js").ApplyTurnContextAssignmentResult;
  getConversationContextSummary(
    id: string,
  ): import("@ling-stack/contracts").ConversationContextSummary | undefined;
  listConversationContextSummaries(
    options: import("./conversation-context-store-types.js").ListConversationContextSummariesOptions,
  ): readonly import("@ling-stack/contracts").ConversationContextSummary[];
  commitConversationContextSummary(
    input: import("./conversation-context-store-types.js").CommitConversationContextSummaryInput,
    now: string,
  ): import("./conversation-context-store-types.js").CommitConversationContextSummaryResult;
  createConversationContextSnapshot(
    input: import("./conversation-context-store-types.js").CreateConversationContextSnapshotInput,
    now: string,
  ): import("@ling-stack/contracts").ConversationContextSnapshot;
  getConversationContextSnapshot(
    id: string,
  ): import("@ling-stack/contracts").ConversationContextSnapshot | undefined;
  listConversationContextSnapshots(
    options: import("./conversation-context-store-types.js").ListConversationContextSnapshotsOptions,
  ): readonly import("@ling-stack/contracts").ConversationContextSnapshot[];
  createChannelMessageRouteDecision(input: CreateChannelMessageRouteDecisionInput, now: string): ChannelMessageRouteDecision;
  getChannelMessageRouteDecision(id: string): ChannelMessageRouteDecision | undefined;
  listChannelMessageRouteDecisions(options?: ListChannelMessageRouteDecisionsOptions): ChannelMessageRouteDecision[];
  updateChannelMessageRouteDecision(
    id: string,
    input: UpdateChannelMessageRouteDecisionInput,
    now: string,
  ): ChannelMessageRouteDecision | undefined;
  createChannelIntentDecision(input: CreateChannelIntentDecisionInput, now: string): ChannelIntentDecision;
  getChannelIntentDecision(id: string): ChannelIntentDecision | undefined;
  listChannelIntentDecisions(options?: ListChannelIntentDecisionsOptions): ChannelIntentDecision[];
  createChannelExecutionProposal(input: CreateChannelExecutionProposalInput, now: string): ChannelExecutionProposal;
  getChannelExecutionProposal(id: string): ChannelExecutionProposal | undefined;
  listChannelExecutionProposals(options: ListChannelExecutionProposalsOptions): ChannelExecutionProposal[];
  updateChannelExecutionProposal(id: string, input: UpdateChannelExecutionProposalInput, now: string): ChannelExecutionProposal | undefined;
  claimChannelExecutionProposal(
    id: string,
    claimId: string,
    now: string,
    claimExpiresAt: string,
  ): ChannelExecutionProposalClaimResult;
  createChannelAttachment(input: CreateChannelAttachmentInput): ChannelAttachment;
  getChannelAttachment(id: string): ChannelAttachment | undefined;
  listChannelAttachments(options: ListChannelAttachmentsOptions): ChannelAttachment[];
  deleteChannelAttachment(id: string): boolean;
  createConversationAttachment(input: CreateConversationAttachmentInput): ConversationAttachment;
  getConversationAttachment(id: string): ConversationAttachment | undefined;
  listConversationAttachments(options: ListConversationAttachmentsOptions): ConversationAttachment[];
  assignConversationAttachment(input: AssignConversationAttachmentInput): ConversationAttachment | undefined;
  deleteConversationAttachment(id: string): boolean;
  createChannelLinkPreview(input: CreateChannelLinkPreviewInput, now: string): ChannelLinkPreview;
  getChannelLinkPreview(id: string): ChannelLinkPreview | undefined;
  listChannelLinkPreviews(options: ListChannelLinkPreviewsOptions): ChannelLinkPreview[];
  updateChannelLinkPreview(id: string, input: UpdateChannelLinkPreviewInput, now: string): ChannelLinkPreview | undefined;
  createChannelInputMaterialization(input: CreateChannelInputMaterializationInput, now: string): ChannelInputMaterialization;
  getChannelInputMaterialization(id: string): ChannelInputMaterialization | undefined;
  listChannelInputMaterializations(options: ListChannelInputMaterializationsOptions): ChannelInputMaterialization[];
  getChannelBrief(channelId: string): ChannelBrief | undefined;
  updateChannelBrief(channelId: string, input: UpdateChannelBriefInput, now: string): ChannelBrief;
  createChannelDecision(input: CreateChannelDecisionInput, now: string): ChannelDecision;
  createOrReuseSupersedingChannelDecision(
    input: CreateSupersedingChannelDecisionInput,
    now: string,
  ): CreateOrReuseSupersedingChannelDecisionResult;
  getChannelDecision(id: string): ChannelDecision | undefined;
  listChannelDecisions(options: ListChannelDecisionsOptions): ChannelDecision[];
  updateChannelDecision(id: string, input: UpdateChannelDecisionInput, now: string): ChannelDecision | undefined;
  rejectActiveChannelDecision(
    id: string,
    input: RejectActiveChannelDecisionInput,
    now: string,
  ): ChannelDecision | undefined;
  createChannelHandoff(input: CreateChannelHandoffInput, now: string): ChannelHandoff;
  getChannelHandoff(id: string): ChannelHandoff | undefined;
  listChannelHandoffs(options: ListChannelHandoffsOptions): ChannelHandoff[];
  updateChannelHandoff(id: string, input: UpdateChannelHandoffInput, now: string): ChannelHandoff | undefined;
  createWorkflowHandoffIntent(input: CreateWorkflowHandoffIntentInput, now: string): WorkflowHandoffIntent;
  getWorkflowHandoffIntent(id: string): WorkflowHandoffIntent | undefined;
  listWorkflowHandoffIntents(options?: ListWorkflowHandoffIntentsOptions): WorkflowHandoffIntent[];
  updateWorkflowHandoffIntent(id: string, input: UpdateWorkflowHandoffIntentInput, now: string): WorkflowHandoffIntent | undefined;
  createWorkflowSelectorDecision(input: CreateWorkflowSelectorDecisionInput, now: string): WorkflowSelectorDecision;
  getWorkflowSelectorDecision(id: string): WorkflowSelectorDecision | undefined;
  listWorkflowSelectorDecisions(options?: ListWorkflowSelectorDecisionsOptions): WorkflowSelectorDecision[];
  updateWorkflowSelectorDecision(id: string, input: UpdateWorkflowSelectorDecisionInput, now: string): WorkflowSelectorDecision | undefined;
  createChannelContextSummary(input: CreateChannelContextSummaryInput, now: string): ChannelContextSummary;
  getChannelContextSummary(id: string): ChannelContextSummary | undefined;
  listChannelContextSummaries(options: ListChannelContextSummariesOptions): ChannelContextSummary[];
  updateChannelContextSummary(
    id: string,
    input: UpdateChannelContextSummaryInput,
    now: string,
  ): ChannelContextSummary | undefined;
  getChannelCollaborationProtocolOverride(channelId: string): ChannelCollaborationProtocolOverride | undefined;
  upsertChannelCollaborationProtocolOverride(
    input: UpsertChannelCollaborationProtocolOverrideInput,
    now: string,
  ): ChannelCollaborationProtocolOverride;
  deleteChannelCollaborationProtocolOverride(channelId: string): boolean;
  createChannelCollaborationProtocolDraft(input: CreateChannelCollaborationProtocolDraftInput, now: string): ChannelCollaborationProtocolDraft;
  getChannelCollaborationProtocolDraft(id: string): ChannelCollaborationProtocolDraft | undefined;
  listChannelCollaborationProtocolDrafts(options: { readonly channelId: string; readonly status?: ChannelProtocolDraftStatus; readonly limit?: number }): ChannelCollaborationProtocolDraft[];
  updateChannelCollaborationProtocolDraft(
    id: string,
    input: { readonly status?: ChannelProtocolDraftStatus; readonly appliedProtocolVersion?: number | null },
    now: string,
  ): ChannelCollaborationProtocolDraft | undefined;
  createChannelPlaybookCandidate(input: CreateChannelPlaybookCandidateInput, now: string): ChannelPlaybookCandidate;
  getChannelPlaybookCandidate(id: string): ChannelPlaybookCandidate | undefined;
  listChannelPlaybookCandidates(options: {
    readonly channelId: string;
    readonly status?: ChannelPlaybookCandidateStatus;
    readonly limit?: number;
  }): ChannelPlaybookCandidate[];
  updateChannelPlaybookCandidate(
    id: string,
    input: UpdateChannelPlaybookCandidateInput,
    now: string,
  ): ChannelPlaybookCandidate | undefined;
  createOrReuseChannelHandoffWorkflow(
    input: CreateOrReuseChannelHandoffWorkflowInput,
    now: string,
  ): CreateOrReuseChannelHandoffWorkflowResult;
  createChannelWorkflow(input: CreateChannelWorkflowInput, now: string): ChannelWorkflow;
  getChannelWorkflow(id: string): ChannelWorkflow | undefined;
  getChannelWorkflowForHandoff(channelId: string, sourceHandoffId: string): ChannelWorkflow | undefined;
  listChannelWorkflows(options: ListChannelWorkflowsOptions): ChannelWorkflow[];
  updateChannelWorkflow(id: string, input: UpdateChannelWorkflowInput, now: string): ChannelWorkflow | undefined;
  transitionChannelWorkflowStatus(input: {
    readonly workflowId: string;
    readonly expectedStatus?: ChannelWorkflow["status"];
    readonly event: WorkflowTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
  }): TransitionResult<ChannelWorkflow["status"]>;
  commitChannelWorkflowCompletionEvaluation(input: {
    readonly workflowId: string;
    readonly evaluation: import("./workflow-completion-read-set.js").WorkflowCompletionEvaluationV1;
    readonly now: string;
  }): TransitionResult<ChannelWorkflow["status"]>;
  commitChannelWorkflowStepFinalization(input: {
    readonly workflowStepId: string;
    readonly expectedStatus: "running" | "waiting_for_approval";
    readonly expectedUpdatedAt: string;
    readonly expectedRun:
      | {
          readonly kind: "linked_run";
          readonly id: string;
          readonly status: "succeeded" | "failed" | "cancelled";
          readonly updatedAt: string;
          readonly eventWatermark: { readonly count: number; readonly latestSeq: number };
          readonly artifactIds: readonly string[];
        }
      | { readonly kind: "no_linked_run" };
    readonly expectedApproval?: { readonly id: string; readonly status: ApprovalRequest["status"]; readonly resolvedAt?: string };
    readonly finalStatus: "succeeded" | "blocked" | "failed" | "cancelled" | "skipped";
    readonly delegatedOutcome: import("@ling-stack/contracts").DelegatedOutcomeV1;
    readonly delegatedOutcomeBasisFingerprint: string;
    readonly executionVerification?: import("@ling-stack/contracts").WorkflowStepExecutionVerificationV1;
    readonly outputArtifactId?: string;
    readonly resultContextReview?: import("./workspace-types.js").WorkflowFanInContextReview;
    readonly resultSummary?: string;
    readonly blocker?: string;
    readonly actor: StateTransitionActor;
    readonly reason: string;
    readonly idempotencyKey: string;
    readonly now: string;
  }): TransitionResult<ChannelWorkflowStep["status"]>;
  createChannelWorkflowStep(input: CreateChannelWorkflowStepInput, now: string): ChannelWorkflowStep;
  getChannelWorkflowStep(id: string): ChannelWorkflowStep | undefined;
  listChannelWorkflowSteps(options: ListChannelWorkflowStepsOptions): ChannelWorkflowStep[];
  updateChannelWorkflowStep(id: string, input: UpdateChannelWorkflowStepInput, now: string): ChannelWorkflowStep | undefined;
  transitionChannelWorkflowStepStatus(input: {
    readonly workflowStepId: string;
    readonly expectedStatus?: ChannelWorkflowStep["status"];
    readonly event: WorkflowStepTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly taskId?: string | null;
    readonly runId?: string | null;
    readonly blocker?: string | null;
    readonly resultSummary?: string | null;
  }): TransitionResult<ChannelWorkflowStep["status"]>;
  createProviderPreset(input: ProviderPresetInput, now: string): ProviderPreset;
  getProviderPreset(id: string): ProviderPreset | undefined;
  listProviderPresets(options?: ListProviderPresetsOptions): ProviderPreset[];
  updateProviderPreset(id: string, input: ProviderPresetUpdateInput, now: string): ProviderPreset | undefined;
  recordProviderCheckResult(id: string, result: ProviderCheckResult): ProviderPreset | undefined;
  getProviderConfigurationSnapshot: ProviderCheckPublicationStore["getProviderConfigurationSnapshot"];
  getProviderCheckAuthority: ProviderCheckPublicationStore["getProviderCheckAuthority"];
  beginProviderCheckRequest: ProviderCheckPublicationStore["beginProviderCheckRequest"];
  commitProviderCheckResult: ProviderCheckPublicationStore["commitProviderCheckResult"];
  deleteProviderPreset(id: string): boolean;
  setProviderSecret(providerId: string, secretValue: string, now: string): void;
  getProviderSecret(providerId: string): string | undefined;
  hasProviderSecret(providerId: string): boolean;
  deleteProviderSecret(providerId: string): boolean;
  createMediaJob(input: CreateMediaJobInput, now: string): MediaJob;
  createOrReuseConversationMediaJob(
    input: CreateOrReuseConversationMediaJobInput,
    now: string,
  ): CreateOrReuseConversationMediaJobResult;
  getMediaJob(id: string): MediaJob | undefined;
  listMediaJobs(options?: ListMediaJobsOptions): MediaJob[];
  updateMediaJobStatus(id: string, input: UpdateMediaJobStatusInput, now: string): MediaJob | undefined;
  createMediaProject(input: CreateMediaProjectInput, now: string): MediaProject;
  getMediaProject(id: string): MediaProject | undefined;
  listMediaProjects(): MediaProject[];
  updateMediaProject(id: string, input: UpdateMediaProjectInput, now: string): MediaProject | undefined;
  deleteMediaProject(id: string): boolean;
  createMediaProjectAsset(input: CreateMediaProjectAssetInput, now: string): MediaProjectAsset;
  getMediaProjectAsset(id: string): MediaProjectAsset | undefined;
  listMediaProjectAssets(projectId: string): MediaProjectAsset[];
  findMediaProjectAssetByChecksum(projectId: string, checksum: string): MediaProjectAsset | undefined;
  deleteMediaProjectAsset(id: string): boolean;
  createMediaScene(input: CreateMediaSceneInput, now: string): MediaScene;
  getMediaScene(id: string): MediaScene | undefined;
  listMediaScenes(projectId: string): MediaScene[];
  updateMediaScene(id: string, input: UpdateMediaSceneInput, now: string): MediaScene | undefined;
  reorderMediaScenes(projectId: string, sceneIds: readonly string[], now: string): MediaScene[];
  deleteMediaScene(id: string): boolean;
  createMediaSceneRun(input: CreateMediaSceneRunInput, now: string): MediaSceneRun;
  listMediaSceneRuns(options: { readonly projectId?: string; readonly sceneId?: string }): MediaSceneRun[];
  getMediaSceneRun(id: string): MediaSceneRun | undefined;
  getMediaSceneRunByMediaJobId(mediaJobId: string): MediaSceneRun | undefined;
  upsertMediaJobExecutionHandle(input: UpsertMediaJobExecutionHandleInput, now: string): MediaJobExecutionHandle;
  getMediaJobExecutionHandle(mediaJobId: string): MediaJobExecutionHandle | undefined;
  listMediaJobExecutionHandles(): MediaJobExecutionHandle[];
  deleteMediaJobExecutionHandle(mediaJobId: string): boolean;
  createMediaWorkflowConnection(input: CreateMediaWorkflowConnectionInput, now: string): MediaWorkflowConnection;
  getMediaWorkflowConnection(id: string): MediaWorkflowConnection | undefined;
  listMediaWorkflowConnections(): MediaWorkflowConnection[];
  updateMediaWorkflowConnection(id: string, input: UpdateMediaWorkflowConnectionInput, now: string): MediaWorkflowConnection | undefined;
  deleteMediaWorkflowConnection(id: string): boolean;
  createMediaWorkflowDefinition(input: CreateMediaWorkflowDefinitionInput, now: string): MediaWorkflowDefinition;
  getMediaWorkflowDefinition(id: string): MediaWorkflowDefinition | undefined;
  listMediaWorkflowDefinitions(options?: ListMediaWorkflowDefinitionsOptions): MediaWorkflowDefinition[];
  updateMediaWorkflowDefinition(id: string, input: UpdateMediaWorkflowDefinitionInput, now: string): MediaWorkflowDefinition | undefined;
  deleteMediaWorkflowDefinition(id: string): boolean;
  createMediaWorkflowVersion(input: CreateMediaWorkflowVersionInput, now: string): MediaWorkflowVersion;
  getMediaWorkflowVersion(id: string): MediaWorkflowVersion | undefined;
  listMediaWorkflowVersions(workflowDefinitionId: string): MediaWorkflowVersion[];
  setMediaWorkflowVersionTestJob(id: string, mediaJobId: string): MediaWorkflowVersion | undefined;
  createApprovalRequest(input: CreateApprovalRequestInput, now: string): ApprovalRequest;
  /** Runner-originated approval creation checks the captured identity in the actual SQLite write. */
  createExecutionApprovalRequest(input: CreateApprovalRequestInput & { readonly runId: string }, sourceFence: RuntimeAttemptFenceV1, now: string): ApprovalRequest;
  getApprovalRequest(id: string): ApprovalRequest | undefined;
  listApprovalRequests(options?: ListApprovalRequestsOptions): ApprovalRequest[];
  approveApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  resolveApprovalBySystemReviewer(
    input: import("./approval-types.js").ResolveApprovalBySystemReviewerInput,
    now: string,
  ): import("./approval-types.js").ResolveApprovalBySystemReviewerResult;
  isRecoverableApprovalReviewOwner(approvalId: string, sourceFence: RuntimeAttemptFenceV1): boolean;
  denyApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  expireApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  cancelApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  listApprovalCommandRules(options?: { readonly includeRevoked?: boolean }): ApprovalCommandRule[];
  findMatchingApprovalCommandRule(toolName: "bash", argv: readonly string[]): ApprovalCommandRule | undefined;
  revokeApprovalCommandRule(id: string, now: string): ApprovalCommandRule | undefined;
  createApprovalCheckpoint(input: CreateApprovalCheckpointInput, now: string): LingApprovalCheckpoint;
  getApprovalCheckpoint(id: string): LingApprovalCheckpoint | undefined;
  getApprovalCheckpointForApproval(approvalId: string): LingApprovalCheckpoint | undefined;
  listApprovalCheckpoints(options?: ListApprovalCheckpointsOptions): LingApprovalCheckpoint[];
  updateApprovalCheckpointStatus(id: string, input: UpdateApprovalCheckpointStatusInput, now: string): LingApprovalCheckpoint | undefined;
  commitApprovalResumeClaim(input: CommitApprovalResumeClaimInput): CommitApprovalResumeClaimResult;
  commitApprovalResumeSuspension(input: CommitApprovalResumeSuspensionInput): CommitApprovalResumeSuspensionResult;
  commitApprovalResumeTerminal(input: CommitApprovalResumeTerminalInput): CommitApprovalResumeTerminalResult;
  getApprovalPolicy(): ApprovalPolicy;
  updateApprovalPolicy(input: ApprovalPolicyUpdateInput, now: string): ApprovalPolicy;
  createOrReuseExternalWorkWorkflow(input: CreateExternalWorkWorkflowInput, now: string): ExternalWorkWorkflowResult;
  getExternalWorkRecord(id: string): ExternalWorkRecord | undefined;
  listExternalWorkRecords(options?: ListExternalWorkRecordsOptions): ExternalWorkRecord[];
  countExternalWorkRecords(options?: Omit<ListExternalWorkRecordsOptions, "limit">): number;
  getExternalWorkRecordByIdempotency(sourceKind: ExternalWorkRecord["sourceKind"], idempotencyKey: string): ExternalWorkRecord | undefined;
  updateExternalWorkArtifacts(id: string, artifactIds: readonly string[], now: string): ExternalWorkRecord | undefined;
  routeExternalWorkRecord(id: string, input: ExternalWorkRouteRequest, now: string): ExternalWorkRecord | undefined;
  createExternalWorkAction(input: CreateExternalWorkActionInput, now: string): ExternalWorkAction;
  getExternalWorkAction(id: string): ExternalWorkAction | undefined;
  getExternalWorkActionByIdempotency(sourceKind: ExternalWorkAction["sourceKind"], idempotencyKey: string): ExternalWorkAction | undefined;
  listExternalWorkActions(options?: ListExternalWorkActionsOptions): ExternalWorkAction[];
  countExternalWorkActions(options?: Omit<ListExternalWorkActionsOptions, "limit">): number;
  updateExternalWorkAction(id: string, input: UpdateExternalWorkActionInput, now: string): ExternalWorkAction | undefined;
  createExternalWorkCiTriage(input: CreateExternalWorkCiTriageInput, now: string): ExternalWorkCiTriageRecord;
  getExternalWorkCiTriage(id: string): ExternalWorkCiTriageRecord | undefined;
  getExternalWorkCiTriageByFailureKey(sourceKind: ExternalWorkCiTriageRecord["sourceKind"], failureKey: string): ExternalWorkCiTriageRecord | undefined;
  listExternalWorkCiTriage(options?: ListExternalWorkCiTriageOptions): ExternalWorkCiTriageRecord[];
  countExternalWorkCiTriage(options?: Omit<ListExternalWorkCiTriageOptions, "limit">): number;
  updateExternalWorkCiTriage(id: string, input: UpdateExternalWorkCiTriageInput, now: string): ExternalWorkCiTriageRecord | undefined;
  upsertExternalWorkSchedulerState(input: UpsertExternalWorkSchedulerStateInput, now: string): ExternalWorkSchedulerState;
  getExternalWorkSchedulerState(externalWorkId: string): ExternalWorkSchedulerState | undefined;
  findActiveExternalWorkSchedulerState(sourceKey: string, subjectKey: string): ExternalWorkSchedulerState | undefined;
  listExternalWorkSchedulerStates(options?: ListExternalWorkSchedulerStatesOptions): ExternalWorkSchedulerState[];
  updateExternalWorkSchedulerState(
    externalWorkId: string,
    input: UpdateExternalWorkSchedulerStateInput,
    now: string,
  ): ExternalWorkSchedulerState | undefined;
  upsertWorkItem(input: UpsertWorkItemInput, now: string): WorkItem;
  getWorkItem(id: string): WorkItem | undefined;
  listWorkItems(options?: ListWorkItemsOptions, now?: string): WorkItem[];
  routeWorkItem(id: string, input: WorkItemRouteRequest, now: string): WorkItem | undefined;
  claimWorkItem(id: string, input: WorkItemClaimRequest, now: string): { readonly workItem: WorkItem; readonly claimToken?: string; readonly blocker?: WorkItemClaimBlocker } | undefined;
  heartbeatWorkItem(id: string, input: WorkItemHeartbeatRequest, now: string): WorkItem | undefined;
  releaseWorkItem(id: string, input: WorkItemReleaseRequest, now: string): WorkItem | undefined;
  completeWorkItem(id: string, input: WorkItemCompleteRequest, now: string): WorkItem | undefined;
  failWorkItem(id: string, input: WorkItemFailRequest, now: string): WorkItem | undefined;
  createMcpServer(input: CreateMcpServerInput, now: string): McpServer;
  getMcpServer(id: string): McpServer | undefined;
  getMcpAuthorityRevision(serverId: string): McpAuthorityRevision | undefined;
  beginMcpMetadataRequest(serverId: string, kind: McpMetadataRequestKind): McpMetadataRequestTicket | undefined;
  commitMcpMetadataResult(input: CommitMcpMetadataResultInput): CommitMcpMetadataResult;
  listMcpServers(options?: ListMcpServersOptions): McpServer[];
  updateMcpServer(id: string, input: UpdateMcpServerInput, now: string): McpServer | undefined;
  updateMcpServerStatus(id: string, status: McpServerStatus, now: string): McpServer | undefined;
  ensureCuaDriverActivationState(pluginId: string, now: string): CuaDriverActivationState;
  getCuaDriverActivationState(pluginId: string): CuaDriverActivationState | undefined;
  commitCuaDriverActivation(input: CommitCuaDriverActivationInput): CommitCuaDriverActivationResult;
  upsertChromeBrowserCredential(input: UpsertChromeBrowserCredentialInput, now: string): ChromeBrowserCredentialRecord;
  getChromeBrowserCredential(workspaceId: string, pluginId: string, extensionId: string): ChromeBrowserCredentialRecord | undefined;
  listChromeBrowserCredentials(workspaceId: string, pluginId: string): ChromeBrowserCredentialRecord[];
  revokeChromeBrowserCredentials(workspaceId: string, pluginId: string, now: string): number;
  upsertMcpStatusSnapshot(snapshot: McpRuntimeStatusSnapshot, now: string): McpRuntimeStatusSnapshot;
  getMcpStatusSnapshot(serverId: string, now?: string): McpRuntimeStatusSnapshot | undefined;
  deleteMcpStatusSnapshot(serverId: string): boolean;
  countLegacyMcpServerSecrets(serverId?: string): number;
  listLegacyMcpServerSecretNames(serverId: string): readonly string[];
  deleteMcpServer(id: string): boolean;
  setMcpServerSecret(serverId: string, secretName: string, secretValue: string, now: string): void;
  getMcpServerSecret(serverId: string, secretName: string): string | undefined;
  hasMcpServerSecret(serverId: string, secretName: string): boolean;
  deleteMcpServerSecret(serverId: string, secretName: string): boolean;
  replaceMcpServerTools(serverId: string, tools: readonly ReplaceMcpServerToolInput[], now: string): McpTool[];
  listMcpTools(options?: ListMcpToolsOptions): McpTool[];
  replaceTeammateMcpBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateMcpBindingInput[],
    now: string,
  ): TeammateMcpBinding[];
  upsertLingAgentChromeBrowserBinding(enabled: boolean, now: string): TeammateMcpBinding;
  upsertLingAgentBuiltInMcpBinding(serverId: string, enabled: boolean, now: string): TeammateMcpBinding;
  listTeammateMcpBindings(teammateId: string): TeammateMcpBinding[];
  createAutomationDefinition(input: CreateAutomationDefinitionInput, now: string): AutomationDefinition;
  getAutomationDefinition(automationId: string): AutomationDefinition | undefined;
  listAutomationDefinitions(options?: ListAutomationDefinitionsOptions): AutomationDefinition[];
  updateAutomationDefinition(
    automationId: string,
    input: UpdateAutomationDefinitionInput,
    now: string,
  ): AutomationDefinition | undefined;
  archiveAutomationDefinition(automationId: string, now: string): AutomationDefinition | undefined;
  createAutomationDraft(input: CreateAutomationDraftInput, now: string): AutomationDraft;
  getAutomationDraft(draftId: string): AutomationDraft | undefined;
  listAutomationDrafts(options?: ListAutomationDraftsOptions): AutomationDraft[];
  updateAutomationDraft(draftId: string, input: UpdateAutomationDraftInput, now: string): AutomationDraft | undefined;
  discardAutomationDraft(draftId: string, now: string): AutomationDraft | undefined;
  confirmAutomationDraft(draftId: string, automationId: string, now: string): AutomationDraft | undefined;
  createAutomationRun(input: CreateAutomationRunInput, now: string): AutomationRun;
  getAutomationRun(automationRunId: string): AutomationRun | undefined;
  findAutomationRunByIdempotencyKey(idempotencyKey: string): AutomationRun | undefined;
  listAutomationRuns(options?: ListAutomationRunsOptions): AutomationRun[];
  updateAutomationRun(automationRunId: string, input: UpdateAutomationRunInput, now: string): AutomationRun | undefined;
  listManagedPlugins(options?: ListManagedPluginsOptions): ManagedPluginRecord[];
  getManagedPlugin(pluginId: string): ManagedPluginRecord | undefined;
  upsertManagedPlugin(input: UpsertManagedPluginInput, now: string): ManagedPluginRecord;
  updateManagedPlugin(pluginId: string, input: UpdateManagedPluginInput, now: string): ManagedPluginRecord | undefined;
  replaceManagedPluginContributions(
    pluginId: string,
    contributions: readonly UpsertManagedPluginContributionInput[],
    now: string,
  ): ManagedPluginContributionRecord[];
  listManagedPluginContributions(pluginId?: string): ManagedPluginContributionRecord[];
  upsertManagedPluginHealthSnapshot(snapshot: ManagedPluginHealthSnapshot, now: string): ManagedPluginHealthSnapshot;
  getManagedPluginHealthSnapshot(pluginId: string, now?: string): ManagedPluginHealthSnapshot | undefined;
  appendManagedPluginEvent(input: CreateManagedPluginEventInput, now: string): ManagedPluginEvent;
  listManagedPluginEvents(options?: ListManagedPluginEventsOptions): ManagedPluginEvent[];
  upsertManagedPluginPackage(input: UpsertManagedPluginPackageInput, now: string): ManagedPluginPackageRecord;
  markManagedPluginPackageUninstalled(pluginId: string, now: string): ManagedPluginPackageRecord | undefined;
  getManagedPluginPackage(pluginId: string): ManagedPluginPackageRecord | undefined;
  listManagedPluginPackages(options?: { readonly status?: ManagedPluginPackageRecord["status"] }): ManagedPluginPackageRecord[];
  createManagedPluginRuntimeSnapshot(input: CreateManagedPluginRuntimeSnapshotInput): ManagedPluginRuntimeSnapshot;
  getManagedPluginRuntimeSnapshot(id: string): ManagedPluginRuntimeSnapshot | undefined;
  getManagedPluginRuntimeSnapshotForRun(runId: string): ManagedPluginRuntimeSnapshot | undefined;
  listSkillRegistryEntries(options?: ListSkillRegistryOptions): SkillRegistryEntry[];
  getSkillRegistryEntry(id: string): SkillRegistryEntry | undefined;
  listSkillSourceSnapshots(options?: ListSkillSourceSnapshotOptions): SkillSourceSnapshot[];
  getSkillSourceSnapshot(skillId: string, options?: Pick<ListSkillSourceSnapshotOptions, "reviewStatus" | "includeArchived">): SkillSourceSnapshot | undefined;
  getSkillSourceSnapshotById(id: string): SkillSourceSnapshot | undefined;
  upsertSkillSourceSnapshot(input: CreateSkillSourceSnapshotInput, now: string): SkillSourceSnapshot;
  archiveSkillSourceSnapshot(skillId: string, now: string): SkillSourceSnapshot | undefined;
  rollbackSkillSourceSnapshot(snapshotId: string, now: string): SkillSourceSnapshot | undefined;
  getOfficialSkillSourceSubscription(): OfficialSkillSourceSubscription | undefined;
  upsertOfficialSkillSourceSubscription(input: UpsertOfficialSkillSourceSubscriptionInput, now: string): OfficialSkillSourceSubscription;
  getSkillSourceUpgradePolicy(now?: string): SkillSourceUpgradePolicy;
  updateSkillSourceUpgradePolicy(input: UpdateSkillSourceUpgradePolicyInput, now: string): SkillSourceUpgradePolicy;
  upsertSkillSourceArtifact(input: CreateSkillSourceArtifactInput, now: string): SkillSourceArtifact;
  getSkillSourceArtifact(id: string): SkillSourceArtifact | undefined;
  listSkillSourceArtifacts(options?: ListSkillSourceArtifactOptions): SkillSourceArtifact[];
  upsertSkillCompiledRuntimeView(input: CreateSkillCompiledRuntimeViewInput, now: string): SkillCompiledRuntimeViewRecord;
  getSkillCompiledRuntimeView(id: string): SkillCompiledRuntimeViewRecord | undefined;
  listSkillCompiledRuntimeViews(options?: ListSkillCompiledRuntimeViewOptions): SkillCompiledRuntimeViewRecord[];
  archiveSkillCompiledRuntimeView(id: string, now: string): SkillCompiledRuntimeViewRecord | undefined;
  createSkillRegressionRun(input: CreateSkillRegressionRunInput, now: string): SkillRegressionRun;
  getSkillRegressionRun(id: string): SkillRegressionRun | undefined;
  listSkillRegressionRuns(options?: ListSkillRegressionRunsOptions): SkillRegressionRun[];
  createSkillImportDraft(input: CreateSkillImportDraftInput, now: string): SkillImportDraft;
  getSkillImportDraft(id: string): SkillImportDraft | undefined;
  publishSkillImportDraft(id: string, now: string): SkillRegistryEntry[];
  publishSkillRevisionDraft(input: PublishSkillRevisionDraftInput, now: string): SkillRegistryEntry;
  archiveSkillRegistryEntry(id: string, now: string): SkillRegistryEntry | undefined;
  hardDeleteSkillRegistryEntry(id: string): SkillHardDeleteResult;
  createSkillCandidate(input: CreateSkillCandidateInput, now: string): SkillCandidate;
  getSkillCandidate(id: string): SkillCandidate | undefined;
  listSkillCandidates(options?: ListSkillCandidatesOptions): SkillCandidate[];
  listSkillCandidateReviewRecords(candidateId: string): SkillCandidateReviewRecord[];
  applySkillCandidateReviewAction(
    input: ApplySkillCandidateReviewActionInput,
    now: string,
  ): { readonly candidate: SkillCandidate; readonly action: SkillCandidateReviewRecord };
  markSkillCandidatePublished(candidateId: string, now: string): SkillCandidate;
  createProcedureObservation(input: CreateProcedureObservationInput, now: string): ProcedureObservation;
  listProcedureObservations(options?: ListProcedureObservationsOptions): ProcedureObservation[];
  listProcedureObservationClusters(options?: ListProcedureObservationClustersOptions): ProcedureObservationCluster[];
  getProcedureObservationCluster(id: string, workspaceId?: string): ProcedureObservationCluster | undefined;
  createCandidateGenerationDecision(input: CreateCandidateGenerationDecisionInput, now: string): CandidateGenerationDecision;
  listCandidateGenerationDecisions(options?: ListCandidateGenerationDecisionsOptions): CandidateGenerationDecision[];
  appendSkillUsageEvent(input: CreateSkillUsageEventInput, now: string): SkillUsageEvent;
  listSkillUsageEvents(options?: ListSkillUsageEventsOptions): SkillUsageEvent[];
  listSkillUsageStats(options?: ListSkillUsageStatsOptions): SkillUsageStats[];
  close(): void;
}

export type RunStoreFacet<K extends keyof RunStore> = Pick<RunStore, K>;

export type RunStorePathsFacet = RunStoreFacet<"paths">;

/** Host-only provenance projection, separate from public historical incident DTOs. */
export type AvailabilityIncidentStoreFacet = RunStoreFacet<
  | "createAvailabilityIncident"
  | "listAvailabilityIncidents"
  | "createProviderRuntimeAvailabilityIncident"
  | "listAvailabilityIncidentCandidates"
>;

export type RemoteAccessStoreFacet = RunStoreFacet<
  | "commitRemoteConversationSend"
  | "getRemoteCommandReceipt"
  | "compactRemoteCommandReceipts"
  | "listRemoteDispatchIntents"
  | "claimRemoteDispatchIntent"
  | "completeRemoteDispatchIntent"
  | "failRemoteDispatchIntent"
  | "listRemoteProjectionOutbox"
  | "getRemoteProjectionEntityVersion"
  | "getLatestConversationActivitySeq"
  | "markRemoteProjectionOutboxProcessed"
  | "getConversationReadState"
  | "markConversationRead"
>;

export type LingThreadStoreFacet = RunStoreFacet<
  | "createLingThread"
  | "getLingThread"
  | "findLingThreadByOwner"
  | "listLingThreads"
  | "searchLingThreads"
  | "updateLingThread"
  | "rebuildLingThreadMetadata"
  | "rebuildLingThreadMetadataForRun"
  | "createLingTurn"
  | "getLingTurn"
  | "listLingTurns"
  | "linkRunToLingTurn"
  | "getLingTurnForRun"
  | "listLingTurnRuns"
  | "reconcileLingTurnStatus"
  | "transitionLingTurnStatus"
>;

export type TerminalReportStoreFacet = RunStoreFacet<
  | "createTerminalReportDraft"
  | "getTerminalReport"
  | "getTerminalReportForSource"
  | "listTerminalReports"
  | "updateTerminalReportDraft"
  | "commitTerminalReport"
  | "markTerminalReportPublished"
  | "commitTerminalReportPublication"
  | "failTerminalReport"
>;

export type RunExecutionStoreFacet = RunStoreFacet<
  | "createRun"
  | "markRunStarted"
  | "markRunWaitingForApproval"
  | "markRunRunning"
  | "markRunSucceeded"
  | "markRunFailed"
  | "markRunCancelled"
  | "appendEvent"
  | "appendExecutionEvent"
  | "isCurrentRunExecutionOwner"
  | "appendControlPlaneEvent"
  | "getControlPlaneEventByIdempotency"
  | "listControlPlaneEvents"
  | "getLatestControlPlaneEventSeq"
  | "getControlPlaneReplayState"
  | "readControlPlaneReplayWindow"
  | "getRun"
  | "listRuns"
  | "listEvents"
  | "countEvents"
  | "createRunIntervention"
  | "getRunIntervention"
  | "listRunInterventions"
  | "claimNextRunIntervention"
  | "listPriorRunInterventionReplyMessages"
  | "updateRunInterventionStatus"
  | "cancelRunIntervention"
  | "createArtifact"
  | "getArtifact"
  | "listArtifacts"
  | "listMediaJobArtifacts"
  | "listExternalWorkArtifacts"
>;

export type RuntimeSupervisorStoreFacet = RunStoreFacet<
  | "createWorkUnit"
  | "getWorkUnit"
  | "listWorkUnits"
  | "findWorkUnitByIdempotency"
  | "linkRunToWorkUnit"
  | "transitionWorkUnitStatus"
  | "createWorkUnitAttempt"
  | "getWorkUnitAttempt"
  | "listWorkUnitAttempts"
  | "updateWorkUnitAttemptStatus"
  | "transitionWorkUnitAttemptTerminal"
  | "appendRuntimeEvent"
  | "appendTerminalRuntimeAudit"
  | "appendRuntimeDiagnosticEvent"
  | "listRuntimeEvents"
  | "recordRuntimeHeartbeat"
  | "acquireRuntimeSemaphoreSlot"
  | "renewRuntimeSemaphoreSlotsForAttempt"
  | "releaseRuntimeSemaphoreSlotsForAttempt"
  | "expireRuntimeSemaphoreSlots"
  | "listRuntimeSemaphoreSlots"
  | "recoverStaleRuns"
  | "recoverStaleChannelWorkflows"
  | "listStateTransitionEvents"
  | "recordStateTransitionEvent"
  | "findStateTransitionByIdempotency"
  | "transitionTaskStatus"
  | "transitionRunStatus"
  | "acquireResourceLease"
  | "renewResourceLeasesForAttempt"
  | "releaseResourceLeasesForAttempt"
  | "releaseResourceLeasesForOwner"
  | "expireResourceLeases"
  | "listResourceLeases"
  | "getBlockingResourceLease"
>;

export type WorkspaceStoreFacet = RunStoreFacet<
  | "getUserProfile"
  | "updateUserProfile"
  | "getWorkspaceSettings"
  | "updateWorkspaceSettings"
  | "createChannel"
  | "getChannel"
  | "listChannels"
  | "updateChannel"
  | "deleteChannel"
  | "createChannelBranch"
  | "getChannelBranch"
  | "listChannelBranches"
  | "updateChannelBranch"
  | "deleteChannelBranch"
  | "createTask"
  | "getTask"
  | "listTasks"
  | "updateTask"
  | "deleteTask"
>;

export type TeammateStoreFacet = RunStoreFacet<
  | "createAiTeammate"
  | "getAiTeammate"
  | "listAiTeammates"
  | "updateAiTeammate"
  | "disableAiTeammate"
  | "hardDeleteAiTeammate"
  | "listTeammateChannelMemberships"
  | "replaceTeammateChannelMemberships"
  | "listTeammateSkillBindings"
  | "replaceTeammateSkillBindings"
  | "listTeammateMemoryScopes"
  | "replaceTeammateMemoryScopes"
  | "getOrCreateTeammateDirectThread"
  | "listTeammateDirectThreads"
  | "updateTeammateDirectThreadWorkspace"
  | "listTeammateDirectMessages"
  | "listTeammateDirectMessagesPage"
  | "getTeammateDirectMessage"
  | "createTeammateDirectMessage"
  | "updateTeammateDirectMessageRuntime"
  | "createTeammateDirectLinkPreview"
  | "getTeammateDirectLinkPreview"
  | "listTeammateDirectLinkPreviews"
  | "updateTeammateDirectLinkPreview"
  | "createTeammateDirectReplyIntervention"
  | "getTeammateDirectReplyIntervention"
  | "listTeammateDirectReplyInterventions"
  | "updateTeammateDirectReplyInterventionStatus"
  | "cancelTeammateDirectReplyIntervention"
  | "createTeammatePrivateAttachment"
  | "getTeammatePrivateAttachment"
  | "listTeammatePrivateAttachments"
  | "deleteTeammatePrivateAttachment"
  | "replaceTeammateMcpBindings"
  | "listTeammateMcpBindings"
>;

export type AiCouncilStoreFacet = RunStoreFacet<
  | "getAiCouncil"
  | "listAiCouncils"
  | "createAiCouncil"
  | "cloneAiCouncil"
  | "updateAiCouncil"
  | "getAiCouncilHealthReport"
  | "listAiCouncilMembers"
  | "replaceAiCouncilMembers"
  | "getChannelCouncilPolicy"
  | "upsertChannelCouncilPolicy"
  | "getEffectiveChannelCouncil"
>;

export type MemoryStoreFacet = RunStoreFacet<
  | "createMemoryConsolidationJob"
  | "getMemoryConsolidationJob"
  | "listMemoryConsolidationJobs"
  | "updateMemoryConsolidationJob"
  | "createMemoryObject"
  | "getMemoryObject"
  | "listMemoryObjects"
  | "updateMemoryObject"
  | "getMemorySelfImprovingMetadata"
  | "upsertMemorySelfImprovingMetadata"
  | "listMemorySelfImprovingMetadata"
  | "getMemoryReviewPolicy"
  | "updateMemoryReviewPolicy"
  | "recordMemoryReviewDecision"
  | "getLatestMemoryReviewDecision"
  | "listMemoryPromotionInbox"
  | "applyMemoryReviewAction"
  | "recallMemory"
  | "recordUsedMemoryEvent"
  | "listUsedMemoryEvents"
>;

export type ChannelStoreFacet = RunStoreFacet<
  | "listChannelBranches"
  | "getLingThread"
  | "listLingThreads"
  | "resolveOrCreateConversationThread"
  | "appendConversationItem"
  | "appendConversationUserTurn"
  | "getConversationItem"
  | "getEffectiveConversationItem"
  | "getConversationItemByIdempotencyKey"
  | "findConversationItemByDomainRef"
  | "listConversationItemsForTurn"
  | "listConversationItemsPage"
  | "listConversationItemsByChannelPage"
  | "listConversationItemsForSegment"
  | "updatePendingConversationItem"
  | "getContextSegment"
  | "listContextSegments"
  | "getEffectiveTurnContextAssignment"
  | "applyTurnContextAssignment"
  | "getConversationContextSummary"
  | "listConversationContextSummaries"
  | "commitConversationContextSummary"
  | "createConversationContextSnapshot"
  | "getConversationContextSnapshot"
  | "listConversationContextSnapshots"
  | "createChannelMessageRouteDecision"
  | "getChannelMessageRouteDecision"
  | "listChannelMessageRouteDecisions"
  | "updateChannelMessageRouteDecision"
  | "createChannelIntentDecision"
  | "getChannelIntentDecision"
  | "listChannelIntentDecisions"
  | "createChannelExecutionProposal"
  | "getChannelExecutionProposal"
  | "listChannelExecutionProposals"
  | "updateChannelExecutionProposal"
  | "claimChannelExecutionProposal"
  | "createChannelAttachment"
  | "getChannelAttachment"
  | "listChannelAttachments"
  | "deleteChannelAttachment"
  | "createChannelLinkPreview"
  | "getChannelLinkPreview"
  | "listChannelLinkPreviews"
  | "updateChannelLinkPreview"
  | "createChannelInputMaterialization"
  | "getChannelInputMaterialization"
  | "listChannelInputMaterializations"
  | "getChannelBrief"
  | "updateChannelBrief"
  | "createChannelDecision"
  | "createOrReuseSupersedingChannelDecision"
  | "getChannelDecision"
  | "listChannelDecisions"
  | "updateChannelDecision"
  | "createChannelHandoff"
  | "getChannelHandoff"
  | "listChannelHandoffs"
  | "updateChannelHandoff"
  | "createWorkflowHandoffIntent"
  | "getWorkflowHandoffIntent"
  | "listWorkflowHandoffIntents"
  | "updateWorkflowHandoffIntent"
  | "createWorkflowSelectorDecision"
  | "getWorkflowSelectorDecision"
  | "listWorkflowSelectorDecisions"
  | "updateWorkflowSelectorDecision"
  | "createChannelContextSummary"
  | "getChannelContextSummary"
  | "listChannelContextSummaries"
  | "updateChannelContextSummary"
  | "getChannelCollaborationProtocolOverride"
  | "upsertChannelCollaborationProtocolOverride"
  | "deleteChannelCollaborationProtocolOverride"
  | "createChannelCollaborationProtocolDraft"
  | "getChannelCollaborationProtocolDraft"
  | "listChannelCollaborationProtocolDrafts"
  | "updateChannelCollaborationProtocolDraft"
  | "createOrReuseChannelHandoffWorkflow"
  | "createChannelWorkflow"
  | "getChannelWorkflow"
  | "getChannelWorkflowForHandoff"
  | "listChannelWorkflows"
  | "updateChannelWorkflow"
  | "transitionChannelWorkflowStatus"
  | "createChannelWorkflowStep"
  | "getChannelWorkflowStep"
  | "listChannelWorkflowSteps"
  | "updateChannelWorkflowStep"
  | "transitionChannelWorkflowStepStatus"
>;

export type ProviderStoreFacet = RunStoreFacet<
  | "createProviderPreset"
  | "getProviderPreset"
  | "getProviderConfigurationSnapshot"
  | "listProviderPresets"
  | "updateProviderPreset"
  | "recordProviderCheckResult"
  | "deleteProviderPreset"
  | "setProviderSecret"
  | "getProviderSecret"
  | "hasProviderSecret"
  | "deleteProviderSecret"
>;

export type MediaStoreFacet = RunStoreFacet<
  | "createMediaJob"
  | "getMediaJob"
  | "listMediaJobs"
  | "updateMediaJobStatus"
  | "createMediaProject"
  | "getMediaProject"
  | "listMediaProjects"
  | "updateMediaProject"
  | "deleteMediaProject"
  | "createMediaProjectAsset"
  | "getMediaProjectAsset"
  | "listMediaProjectAssets"
  | "findMediaProjectAssetByChecksum"
  | "deleteMediaProjectAsset"
  | "createMediaScene"
  | "getMediaScene"
  | "listMediaScenes"
  | "updateMediaScene"
  | "reorderMediaScenes"
  | "deleteMediaScene"
  | "createMediaSceneRun"
  | "listMediaSceneRuns"
  | "getMediaSceneRun"
  | "getMediaSceneRunByMediaJobId"
  | "upsertMediaJobExecutionHandle"
  | "getMediaJobExecutionHandle"
  | "listMediaJobExecutionHandles"
  | "deleteMediaJobExecutionHandle"
>;

export type ApprovalStoreFacet = RunStoreFacet<
  | "createApprovalRequest"
  | "createExecutionApprovalRequest"
  | "getApprovalRequest"
  | "listApprovalRequests"
  | "approveApprovalRequest"
  | "resolveApprovalBySystemReviewer"
  | "isRecoverableApprovalReviewOwner"
  | "denyApprovalRequest"
  | "expireApprovalRequest"
  | "cancelApprovalRequest"
  | "listApprovalCommandRules"
  | "findMatchingApprovalCommandRule"
  | "revokeApprovalCommandRule"
  | "getApprovalPolicy"
  | "updateApprovalPolicy"
>;

export type ExternalWorkStoreFacet = RunStoreFacet<
  | "createOrReuseExternalWorkWorkflow"
  | "getExternalWorkRecord"
  | "listExternalWorkRecords"
  | "countExternalWorkRecords"
  | "getExternalWorkRecordByIdempotency"
  | "updateExternalWorkArtifacts"
  | "routeExternalWorkRecord"
  | "createExternalWorkAction"
  | "getExternalWorkAction"
  | "getExternalWorkActionByIdempotency"
  | "listExternalWorkActions"
  | "countExternalWorkActions"
  | "updateExternalWorkAction"
  | "createExternalWorkCiTriage"
  | "getExternalWorkCiTriage"
  | "getExternalWorkCiTriageByFailureKey"
  | "listExternalWorkCiTriage"
  | "countExternalWorkCiTriage"
  | "updateExternalWorkCiTriage"
  | "upsertExternalWorkSchedulerState"
  | "getExternalWorkSchedulerState"
  | "findActiveExternalWorkSchedulerState"
  | "listExternalWorkSchedulerStates"
  | "updateExternalWorkSchedulerState"
>;

export type WorkItemStoreFacet = RunStoreFacet<
  | "upsertWorkItem"
  | "getWorkItem"
  | "listWorkItems"
  | "routeWorkItem"
  | "claimWorkItem"
  | "heartbeatWorkItem"
  | "releaseWorkItem"
  | "completeWorkItem"
  | "failWorkItem"
>;

export type McpMetadataStoreFacet = RunStoreFacet<"beginMcpMetadataRequest" | "commitMcpMetadataResult">;

export type McpStoreFacet = RunStoreFacet<
  | "createMcpServer"
  | "getMcpServer"
  | "getMcpAuthorityRevision"
  | "listMcpServers"
  | "updateMcpServer"
  | "updateMcpServerStatus"
  | "upsertMcpStatusSnapshot"
  | "getMcpStatusSnapshot"
  | "deleteMcpStatusSnapshot"
  | "countLegacyMcpServerSecrets"
  | "listLegacyMcpServerSecretNames"
  | "deleteMcpServer"
  | "setMcpServerSecret"
  | "getMcpServerSecret"
  | "hasMcpServerSecret"
  | "deleteMcpServerSecret"
  | "replaceMcpServerTools"
  | "listMcpTools"
  | "replaceTeammateMcpBindings"
  | "upsertLingAgentChromeBrowserBinding"
  | "upsertLingAgentBuiltInMcpBinding"
  | "listTeammateMcpBindings"
>;

export type CuaDriverActivationStoreFacet = RunStoreFacet<
  | "ensureCuaDriverActivationState"
  | "getCuaDriverActivationState"
  | "commitCuaDriverActivation"
>;

export type ChromeBrowserCredentialStoreFacet = RunStoreFacet<
  | "upsertChromeBrowserCredential"
  | "getChromeBrowserCredential"
  | "listChromeBrowserCredentials"
  | "revokeChromeBrowserCredentials"
>;

export type AutomationStoreFacet = RunStoreFacet<
  | "createAutomationDefinition"
  | "getAutomationDefinition"
  | "listAutomationDefinitions"
  | "updateAutomationDefinition"
  | "archiveAutomationDefinition"
  | "createAutomationDraft"
  | "getAutomationDraft"
  | "listAutomationDrafts"
  | "updateAutomationDraft"
  | "discardAutomationDraft"
  | "confirmAutomationDraft"
  | "createAutomationRun"
  | "getAutomationRun"
  | "findAutomationRunByIdempotencyKey"
  | "listAutomationRuns"
  | "updateAutomationRun"
>;

export type ManagedPluginStoreFacet = RunStoreFacet<
  | "listManagedPlugins"
  | "getManagedPlugin"
  | "upsertManagedPlugin"
  | "updateManagedPlugin"
  | "replaceManagedPluginContributions"
  | "listManagedPluginContributions"
  | "upsertManagedPluginHealthSnapshot"
  | "getManagedPluginHealthSnapshot"
  | "appendManagedPluginEvent"
  | "listManagedPluginEvents"
  | "upsertManagedPluginPackage"
  | "markManagedPluginPackageUninstalled"
  | "getManagedPluginPackage"
  | "listManagedPluginPackages"
  | "createManagedPluginRuntimeSnapshot"
  | "getManagedPluginRuntimeSnapshot"
  | "getManagedPluginRuntimeSnapshotForRun"
>;

export type SkillRegistryStoreFacet = RunStoreFacet<
  | "listSkillRegistryEntries"
  | "getSkillRegistryEntry"
  | "listSkillSourceSnapshots"
  | "getSkillSourceSnapshot"
  | "getSkillSourceSnapshotById"
  | "upsertSkillSourceSnapshot"
  | "archiveSkillSourceSnapshot"
  | "rollbackSkillSourceSnapshot"
  | "getOfficialSkillSourceSubscription"
  | "upsertOfficialSkillSourceSubscription"
  | "getSkillSourceUpgradePolicy"
  | "updateSkillSourceUpgradePolicy"
  | "upsertSkillSourceArtifact"
  | "getSkillSourceArtifact"
  | "listSkillSourceArtifacts"
  | "upsertSkillCompiledRuntimeView"
  | "getSkillCompiledRuntimeView"
  | "listSkillCompiledRuntimeViews"
  | "archiveSkillCompiledRuntimeView"
  | "createSkillRegressionRun"
  | "getSkillRegressionRun"
  | "listSkillRegressionRuns"
  | "createSkillImportDraft"
  | "getSkillImportDraft"
  | "publishSkillImportDraft"
  | "publishSkillRevisionDraft"
  | "archiveSkillRegistryEntry"
  | "hardDeleteSkillRegistryEntry"
>;

export type SkillCandidateStoreFacet = RunStoreFacet<
  | "createSkillCandidate"
  | "getSkillCandidate"
  | "listSkillCandidates"
  | "listSkillCandidateReviewRecords"
  | "applySkillCandidateReviewAction"
  | "markSkillCandidatePublished"
>;

export type ProcedureObservationStoreFacet = RunStoreFacet<
  | "createProcedureObservation"
  | "listProcedureObservations"
  | "createCandidateGenerationDecision"
  | "listCandidateGenerationDecisions"
>;

export type SkillUsageStoreFacet = RunStoreFacet<
  | "appendSkillUsageEvent"
  | "listSkillUsageEvents"
  | "listSkillUsageStats"
>;

export type GovernanceNotificationStoreFacet = RunStoreFacet<
  | "upsertGovernanceNotification"
  | "getGovernanceNotification"
  | "listGovernanceNotifications"
  | "updateGovernanceNotificationDelivery"
  | "markGovernanceNotificationSeen"
  | "dismissGovernanceNotification"
  | "resolveGovernanceNotificationByDedupeKey"
  | "getGovernanceNotificationSummary"
>;

export function createRunId(): string {
  return `run_${randomUUID()}`;
}

export function createEventId(): string {
  return `evt_${randomUUID()}`;
}

export function createArtifactId(): string {
  return `artifact_${randomUUID()}`;
}

export function createRunInterventionId(): string {
  return `rint_${randomUUID()}`;
}
