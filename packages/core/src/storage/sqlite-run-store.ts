import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  ensureRuntimePaths,
  resolveRuntimePaths,
  type LingStackRuntimePaths,
} from "../runtime-paths.js";
import {
  type ApprovalRequest,
  type CreateApprovalRequestInput,
  type ListApprovalRequestsOptions,
  type ResolveApprovalRequestInput,
} from "../approval-types.js";
import {
  type CreateApprovalCheckpointInput,
  type LingApprovalCheckpoint,
  type ListApprovalCheckpointsOptions,
  type UpdateApprovalCheckpointStatusInput,
} from "../approval-checkpoints.js";
import {
  type ListProviderPresetsOptions,
  type ProviderCheckResult,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderPresetUpdateInput,
} from "../provider-types.js";
import {
  type ChannelInputMaterialization,
  type CreateChannelInputMaterializationInput,
  type ListChannelInputMaterializationsOptions,
} from "../input-materialization-types.js";
import type {
  CommitLingTerminalReportInput,
  CreateLingTerminalReportInput,
  FailLingTerminalReportInput,
  LingTerminalReportRecord,
  ListLingTerminalReportsOptions,
  MarkLingTerminalReportPublishedInput,
  TerminalReportSourceKind,
  UpdateLingTerminalReportDraftInput,
} from "../terminal-report-types.js";
import type {
  AvailabilityIncident,
  ChannelTeamEvidenceItem,
  ChannelTeamEvaluationRun,
  ChannelTeamPattern,
  ChannelTeamSnapshot,
  CreateAvailabilityIncidentInput,
  CreateChannelTeamEvaluationRunInput,
  CreateChannelTeamEvidenceItemInput,
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
} from "../channel-team-types.js";
import {
  type ApprovalPolicy,
  type ApprovalPolicyUpdateInput,
  type RunTool,
} from "../approval-policy.js";
import {
  DEFAULT_WORKSPACE_ID,
  type AiCouncil,
  type AiCouncilHealthReport,
  type AiCouncilHealthReportOptions,
  type AiCouncilMember,
  type AiTeammate,
  type AiTeammateUpdateInput,
  type Channel,
  type ChannelAttachment,
  type ChannelBrief,
  type ChannelBranch,
  type ChannelBranchUpdateInput,
  type ChannelCollaborationProtocolDraft,
  type ChannelCollaborationProtocolOverride,
  type ChannelPlaybookCandidate,
  type ChannelPlaybookCandidateStatus,
  type ChannelProtocolDraftStatus,
  type ChannelProtocolSourceRef,
  type ChannelContextSummary,
  type ChannelDecision,
  type ChannelExecutionProposal,
  type ChannelHandoff,
  type ChannelIntentDecision,
  type ChannelLinkPreview,
  type ChannelMessage,
  type ChannelMessageListPage,
  type ChannelMessageRouteDecision,
  type ChannelCouncilPolicy,
  type ChannelUpdateInput,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepStatus,
  type ChannelWorkflowStatus,
  type CloneAiCouncilInput,
  type AssignConversationAttachmentInput,
  type ConversationAttachment,
  type CreateAiCouncilInput,
  type CreateAiTeammateInput,
  type CreateChannelAttachmentInput,
  type CreateChannelBranchInput,
  type CreateChannelCollaborationProtocolDraftInput,
  type CreateChannelPlaybookCandidateInput,
  type CreateChannelContextSummaryInput,
  type CreateChannelDecisionInput,
  type CreateChannelExecutionProposalInput,
  type CreateChannelHandoffInput,
  type CreateChannelInput,
  type CreateChannelIntentDecisionInput,
  type CreateChannelLinkPreviewInput,
  type CreateChannelMessageInput,
  type CreateChannelMessageRouteDecisionInput,
  type CreateChannelWorkflowInput,
  type CreateChannelWorkflowStepInput,
  type CreateConversationAttachmentInput,
  type CreateWorkflowHandoffIntentInput,
  type CreateWorkflowSelectorDecisionInput,
  type CreateTeammateDirectLinkPreviewInput,
  type CreateTeammateDirectMessageInput,
  type CreateTeammateDirectReplyInterventionInput,
  type CreateTeammatePrivateAttachmentInput,
  type CreateTaskInput,
  type DirectWorkspaceBinding,
  type EffectiveChannelCouncilProjection,
  type HardDeleteAiTeammateInput,
  type HardDeleteAiTeammateResult,
  type HardDeleteLingThreadInput,
  type HardDeleteLingThreadResult,
  type ListAiCouncilsOptions,
  type ListAiTeammatesOptions,
  type ListChannelAttachmentsOptions,
  type ListChannelBranchesOptions,
  type ListChannelContextSummariesOptions,
  type ListChannelDecisionsOptions,
  type ListChannelExecutionProposalsOptions,
  type ListChannelHandoffsOptions,
  type ListChannelIntentDecisionsOptions,
  type ListChannelsOptions,
  type ListChannelLinkPreviewsOptions,
  type ListChannelMessagesOptions,
  type ListChannelMessageRouteDecisionsOptions,
  type ListChannelWorkflowsOptions,
  type ListChannelWorkflowStepsOptions,
  type ListConversationAttachmentsOptions,
  type ListWorkflowHandoffIntentsOptions,
  type ListWorkflowSelectorDecisionsOptions,
  type ListTeammateDirectLinkPreviewsOptions,
  type ListTeammateDirectMessagesOptions,
  type ListTeammateDirectReplyInterventionsOptions,
  type ListTeammatePrivateAttachmentsOptions,
  type ListTasksOptions,
  type ReplaceAiCouncilMemberInput,
  type ReplaceTeammateChannelMembershipInput,
  type ReplaceTeammateMemoryScopeInput,
  type ReplaceTeammateSkillBindingInput,
  type Task,
  type TaskStatus,
  type TaskUpdateInput,
  type TeammateChannelMembership,
  type TeammateDirectLinkPreview,
  type TeammateDirectMessage,
  type TeammateDirectMessageListPage,
  type TeammateDirectReplyIntervention,
  type TeammateDirectThread,
  type TeammateMemoryScope,
  type TeammatePrivateAttachment,
  type UpdateTeammateDirectLinkPreviewInput,
  type TeammateSkillBinding,
  type UpdateChannelBriefInput,
  type UpdateChannelPlaybookCandidateInput,
  type UpdateChannelContextSummaryInput,
  type UpdateChannelDecisionInput,
  type UpdateChannelExecutionProposalInput,
  type UpdateChannelMessageRouteDecisionInput,
  type UpdateChannelHandoffInput,
  type UpdateChannelLinkPreviewInput,
  type UpdateTeammateDirectReplyInterventionStatusInput,
  type UpdateAiCouncilInput,
  type UpdateChannelWorkflowInput,
  type UpdateChannelWorkflowStepInput,
  type UpdateUserProfileInput,
  type UpdateWorkflowHandoffIntentInput,
  type UpdateWorkflowSelectorDecisionInput,
  type UpdateWorkspaceSettingsInput,
  type UpsertChannelCouncilPolicyInput,
  type UserProfile,
  type UpsertChannelCollaborationProtocolOverrideInput,
  type WorkspaceSettings,
  type WorkflowHandoffIntent,
  type WorkflowPacketSourceRef,
  type WorkflowSelectorDecision,
} from "../workspace-types.js";
import {
  type CreateSkillCompiledRuntimeViewInput,
  type CreateSkillImportDraftInput,
  type CreateSkillRegressionRunInput,
  type CreateSkillSourceArtifactInput,
  type CreateSkillSourceSnapshotInput,
  type ListSkillCompiledRuntimeViewOptions,
  type ListSkillRegressionRunsOptions,
  type ListSkillSourceArtifactOptions,
  type ListSkillRegistryOptions,
  type ListSkillSourceSnapshotOptions,
  type PublishSkillRevisionDraftInput,
  type SkillCompiledRuntimeViewRecord,
  type SkillHardDeleteResult,
  type SkillImportDraft,
  type SkillRegressionRun,
  type SkillRegistryEntry,
  type SkillSourceArtifact,
  type SkillSourceSnapshot,
  type SkillSourceUpgradePolicy,
  type UpdateSkillSourceUpgradePolicyInput,
} from "../skill-types.js";
import {
  type ApplySkillCandidateReviewActionInput,
  type CreateSkillCandidateInput,
  type ListSkillCandidatesOptions,
  type SkillCandidate,
  type SkillCandidateReviewRecord,
} from "../skill-candidate-types.js";
import type {
  OfficialSkillSourceSubscription,
  UpsertOfficialSkillSourceSubscriptionInput,
} from "../managed-official-skill-source-types.js";
import type {
  CandidateGenerationDecision,
  CreateCandidateGenerationDecisionInput,
  CreateProcedureObservationInput,
  ListCandidateGenerationDecisionsOptions,
  ListProcedureObservationClustersOptions,
  ListProcedureObservationsOptions,
  ProcedureObservation,
  ProcedureObservationCluster,
} from "../procedure-observation-types.js";
import type {
  CreateSkillUsageEventInput,
  ListSkillUsageEventsOptions,
  ListSkillUsageStatsOptions,
  SkillUsageEvent,
  SkillUsageEventKind,
  SkillUsageStats,
} from "../skill-usage-types.js";
import {
  type AppendControlPlaneEventInput,
  type ConversationModeState,
  type CreateLingThreadGoalInput,
  type ControlPlaneEvent,
  type CreateLingThreadInput,
  type CreateProposedPlanArtifactInput,
  type CreateLingTurnInput,
  type CreateRunArtifactInput,
  type CreateRunInterventionInput,
  type CreateRunInput,
  type LinkRunToLingTurnInput,
  type LingThread,
  type LingThreadGoal,
  type LingThreadKind,
  type LingThreadStatus,
  type LingTurn,
  type LingTurnRun,
  type ListProposedPlanArtifactsOptions,
  type ListControlPlaneEventsOptions,
  type ListLingThreadsOptions,
  type ListLingTurnsOptions,
  type ListRunInterventionsOptions,
  type ListRunEventsOptions,
  type ListRunsOptions,
  type RunArtifact,
  type RunEventEnvelope,
  type RunEventType,
  type RunContinuationReason,
  type RunIntervention,
  type RunSession,
  type RunStore,
  type RunStatus,
  type ProposedPlanArtifact,
  type SearchLingThreadsResult,
  type UpdateLingThreadConversationModeInput,
  type UpdateLingThreadGoalInput,
  type UpdateLingThreadInput,
  type UpdateProposedPlanArtifactInput,
  type UpdateRunInterventionStatusInput,
} from "../run-types.js";
import {
  type AcquireRuntimeSemaphoreSlotInput,
  type AppendRuntimeEventInput,
  type CreateWorkUnitAttemptInput,
  type CreateWorkUnitInput,
  type ListRuntimeEventsOptions,
  type ListRuntimeSemaphoreSlotsOptions,
  type ListWorkUnitsOptions,
  type RecordRuntimeHeartbeatInput,
  type RuntimeEvent,
  type RuntimeHeartbeat,
  type RuntimeSemaphoreSlot,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkUnitStatus,
} from "../runtime-supervisor-types.js";
import {
  type CreateExternalWorkActionInput,
  type CreateExternalWorkCiTriageInput,
  type CreateExternalWorkWorkflowInput,
  type ExternalWorkAction,
  type ExternalWorkCiTriageRecord,
  type ExternalWorkRecord,
  type ExternalWorkRouteRequest,
  type ExternalWorkSchedulerState,
  type ExternalWorkWorkflowResult,
  type ListExternalWorkActionsOptions,
  type ListExternalWorkCiTriageOptions,
  type ListExternalWorkRecordsOptions,
  type ListExternalWorkSchedulerStatesOptions,
  type UpdateExternalWorkActionInput,
  type UpdateExternalWorkCiTriageInput,
  type UpdateExternalWorkSchedulerStateInput,
  type UpsertExternalWorkSchedulerStateInput,
} from "../external-work-types.js";
import {
  type CreateResourceLeaseInput,
  type CreateStateTransitionEventInput,
  type ListResourceLeasesOptions,
  type ListStateTransitionEventsOptions,
  type ResourceLease,
  type ResourceLeaseOwnerType,
  type StateTransitionEvent,
} from "../channel-runtime-types.js";
import {
  transitionTask,
  type RunTransitionEvent,
  type StateTransitionActor,
  type TaskTransitionEvent,
  type TransitionResult,
  type WorkUnitTransitionEvent,
  type WorkflowStepTransitionEvent,
  type WorkflowTransitionEvent,
} from "../state-machines.js";
import {
  type CreateMediaProjectInput,
  type CreateMediaJobInput,
  type CreateMediaSceneInput,
  type CreateMediaSceneRunInput,
  type ListMediaJobsOptions,
  type MediaJobExecutionHandle,
  type MediaJob,
  type MediaProject,
  type MediaScene,
  type MediaSceneRun,
  type UpdateMediaProjectInput,
  type UpdateMediaJobStatusInput,
  type UpdateMediaSceneInput,
  type UpsertMediaJobExecutionHandleInput,
} from "../media-types.js";
import {
  type CreateMediaWorkflowConnectionInput,
  type CreateMediaWorkflowDefinitionInput,
  type CreateMediaWorkflowVersionInput,
  type ListMediaWorkflowDefinitionsOptions,
  type MediaWorkflowConnection,
  type MediaWorkflowDefinition,
  type MediaWorkflowVersion,
  type UpdateMediaWorkflowConnectionInput,
  type UpdateMediaWorkflowDefinitionInput,
} from "../media-workflow-types.js";
import {
  type CreateMemoryConsolidationJobInput,
  type ListMemoryConsolidationJobsOptions,
  type MemoryConsolidationJob,
  type UpdateMemoryConsolidationJobInput,
} from "../memory-consolidation-types.js";
import {
  type CreateMcpServerInput,
  type ListMcpServersOptions,
  type ListMcpToolsOptions,
  type McpRuntimeStatusSnapshot,
  type McpServer,
  type McpServerStatus,
  type McpTool,
  type ReplaceMcpServerToolInput,
  type ReplaceTeammateMcpBindingInput,
  type TeammateMcpBinding,
  type UpdateMcpServerInput,
} from "../mcp-types.js";
import {
  type CreateManagedPluginEventInput,
  type CreateManagedPluginRuntimeSnapshotInput,
  type ListManagedPluginEventsOptions,
  type ListManagedPluginsOptions,
  type ManagedPluginContributionRecord,
  type ManagedPluginEvent,
  type ManagedPluginHealthSnapshot,
  type ManagedPluginPackageRecord,
  type ManagedPluginRecord,
  type ManagedPluginRuntimeSnapshot,
  type UpdateManagedPluginInput,
  type UpsertManagedPluginPackageInput,
  type UpsertManagedPluginContributionInput,
  type UpsertManagedPluginInput,
} from "../plugin-manager-types.js";
import {
  type AutomationDraft,
  type AutomationDefinition,
  type AutomationRun,
  type CreateAutomationDefinitionInput,
  type CreateAutomationDraftInput,
  type CreateAutomationRunInput,
  type ListAutomationDefinitionsOptions,
  type ListAutomationDraftsOptions,
  type ListAutomationRunsOptions,
  type UpdateAutomationDefinitionInput,
  type UpdateAutomationDraftInput,
  type UpdateAutomationRunInput,
} from "../automation-types.js";
import {
  type ListWorkItemsOptions,
  type UpsertWorkItemInput,
  type WorkItem,
  type WorkItemClaimBlocker,
  type WorkItemClaimRequest,
  type WorkItemCompleteRequest,
  type WorkItemFailRequest,
  type WorkItemHeartbeatRequest,
  type WorkItemReleaseRequest,
  type WorkItemRouteRequest,
} from "../work-item-types.js";
import {
  type ApplyMemoryReviewActionInput,
  type CreateMemoryObjectInput,
  type CreateMemoryReviewDecisionInput,
  type CreateUsedMemoryEventInput,
  type ListMemoryObjectsOptions,
  type ListMemoryPromotionInboxOptions,
  type ListUsedMemoryEventsOptions,
  type MemoryObject,
  type MemoryObjectUpdateInput,
  type MemoryPromotionInboxItem,
  type MemoryRecallRequest,
  type MemoryRecallResult,
  type MemoryReviewActionRecord,
  type MemoryReviewDecision,
  type MemoryReviewPolicy,
  type MemoryReviewPolicyUpdateInput,
  type MemorySelfImprovingMetadata,
  type ListMemorySelfImprovingMetadataOptions,
  type UsedMemoryEvent,
  type UpsertMemorySelfImprovingMetadataInput,
} from "../memory-types.js";
import {
  type CreateGovernanceNotificationInput,
  type GovernanceNotification,
  type GovernanceNotificationSummary,
  type ListGovernanceNotificationsOptions,
  type UpdateGovernanceNotificationDeliveryInput,
  type UpsertGovernanceNotificationResult,
} from "../governance-notification-types.js";
import { redactSecrets } from "../redaction.js";
import { applySqliteRunStoreMigrations, configureSqliteRunStoreDatabase } from "./sqlite/migrations.js";
import {
  isJsonRecord,
  isRecord,
  nullableUpdate,
  omitUndefined,
  parseJson,
  readBoolean,
  readNullableNumber,
  readNullableString,
  readNumber,
  readString,
} from "./sqlite/helpers.js";
import { SqliteAutomationStore } from "./sqlite/automation-store.js";
import { SqliteProviderStore } from "./sqlite/provider-store.js";
import { SqliteMcpStore } from "./sqlite/mcp-store.js";
import { SqliteManagedPluginStore } from "./sqlite/managed-plugin-store.js";
import { SqliteMediaStore } from "./sqlite/media-store.js";
import { SqliteMediaWorkflowStore } from "./sqlite/media-workflow-store.js";
import { SqliteApprovalPolicyStore } from "./sqlite/approval-policy-store.js";
import { SqliteApprovalRequestStore } from "./sqlite/approval-request-store.js";
import { SqliteApprovalCheckpointStore } from "./sqlite/approval-checkpoint-store.js";
import { SqliteArtifactStore } from "./sqlite/artifact-store.js";
import { SqliteControlPlaneStore } from "./sqlite/control-plane-store.js";
import { SqliteRunEventStore } from "./sqlite/run-event-store.js";
import { SqliteRunInterventionStore } from "./sqlite/run-intervention-store.js";
import { SqliteRunSessionStore } from "./sqlite/run-session-store.js";
import { SqliteLingThreadMetadataCoordinator } from "./sqlite/ling-thread-metadata-coordinator.js";
import { SqliteLingThreadSearchStore } from "./sqlite/ling-thread-search-store.js";
import { SqliteLingThreadStore } from "./sqlite/ling-thread-store.js";
import { SqliteLingThreadCleanupStore } from "./sqlite/ling-thread-cleanup-store.js";
import { SqliteLingTurnStore } from "./sqlite/ling-turn-store.js";
import { SqliteTerminalReportStore } from "./sqlite/terminal-report-store.js";
import { SqliteStateTransitionStore } from "./sqlite/state-transition-store.js";
import { SqliteResourceLeaseStore } from "./sqlite/resource-lease-store.js";
import { SqliteRuntimeSemaphoreStore } from "./sqlite/runtime-semaphore-store.js";
import { SqliteRuntimeRecoveryCoordinator } from "./sqlite/runtime-recovery-coordinator.js";
import { SqliteRuntimeWorkUnitStore } from "./sqlite/runtime-work-unit-store.js";
import { SqliteUserProfileStore } from "./sqlite/user-profile-store.js";
import { SqliteWorkspaceSettingsStore } from "./sqlite/workspace-settings-store.js";
import { SqliteSkillRegistryStore } from "./sqlite/skill-registry-store.js";
import { SqliteSkillRegressionStore } from "./sqlite/skill-regression-store.js";
import { SqliteSkillCandidateStore } from "./sqlite/skill-candidate-store.js";
import { SqliteSkillUsageStore } from "./sqlite/skill-usage-store.js";
import { SqliteProcedureObservationStore } from "./sqlite/procedure-observation-store.js";
import { SqliteTaskStore } from "./sqlite/task-store.js";
import { SqliteTeammateDirectStore } from "./sqlite/teammate-direct-store.js";
import { SqliteTeammateAssociationStore } from "./sqlite/teammate-association-store.js";
import { SqliteTeammateCoreStore } from "./sqlite/teammate-core-store.js";
import { SqliteTeammateBootstrapCoordinator } from "./sqlite/teammate-bootstrap-coordinator.js";
import { SqliteTeammateCleanupStore } from "./sqlite/teammate-cleanup-store.js";
import { SqliteAiCouncilStore } from "./sqlite/ai-council-store.js";
import { SqliteMemoryConsolidationStore } from "./sqlite/memory-consolidation-store.js";
import { SqliteMemoryObjectStore } from "./sqlite/memory-object-store.js";
import { SqliteMemoryReviewStore } from "./sqlite/memory-review-store.js";
import { SqliteMemoryRetrievalStore } from "./sqlite/memory-retrieval-store.js";
import { SqliteGovernanceNotificationStore } from "./sqlite/governance-notification-store.js";
import { SqliteChannelMessageStore } from "./sqlite/channel-message-store.js";
import { SqliteChannelReferenceValidator } from "./sqlite/channel-reference-validator.js";
import { SqliteChannelRouteDecisionStore } from "./sqlite/channel-route-decision-store.js";
import { SqliteChannelIntentDecisionStore } from "./sqlite/channel-intent-decision-store.js";
import { SqliteChannelProposalStore } from "./sqlite/channel-proposal-store.js";
import { SqliteChannelAssetStore } from "./sqlite/channel-asset-store.js";
import { SqliteConversationAssetStore } from "./sqlite/conversation-asset-store.js";
import { SqliteConversationRevisionStore } from "./sqlite/conversation-revision-store.js";
import { SqliteChannelCollaborationStore } from "./sqlite/channel-collaboration-store.js";
import { SqliteChannelProtocolStore } from "./sqlite/channel-protocol-store.js";
import { SqliteChannelPlaybookStore } from "./sqlite/channel-playbook-store.js";
import { SqliteChannelWorkflowStore } from "./sqlite/channel-workflow-store.js";
import { SqliteChannelTeamEvidenceStore } from "./sqlite/channel-team-evidence-store.js";
import { SqliteChannelTeamLifecycleStore } from "./sqlite/channel-team-lifecycle-store.js";
import { SqliteChannelTeamPatternStore } from "./sqlite/channel-team-pattern-store.js";
import { SqliteChannelTeamSnapshotStore } from "./sqlite/channel-team-snapshot-store.js";
import { SqliteChannelCoreStore } from "./sqlite/channel-core-store.js";
import { SqliteExternalWorkStore } from "./sqlite/external-work-store.js";
import { SqliteExternalWorkActionStore } from "./sqlite/external-work-action-store.js";
import { SqliteExternalWorkCiTriageStore } from "./sqlite/external-work-ci-triage-store.js";
import { SqliteExternalWorkSchedulerStore } from "./sqlite/external-work-scheduler-store.js";
import { SqliteExternalWorkWorkflowCoordinator } from "./sqlite/external-work-workflow-coordinator.js";
import { SqliteWorkItemStore } from "./sqlite/work-item-store.js";

export interface SqliteRunStoreOptions {
  readonly cwd: string;
  readonly paths?: LingStackRuntimePaths;
}

export class SqliteRunStore implements RunStore {
  readonly paths: LingStackRuntimePaths;
  private readonly database: DatabaseSync;
  private readonly automations: SqliteAutomationStore;
  private readonly providers: SqliteProviderStore;
  private readonly mcps: SqliteMcpStore;
  private readonly managedPlugins: SqliteManagedPluginStore;
  private readonly mediaJobs: SqliteMediaStore;
  private readonly mediaWorkflows: SqliteMediaWorkflowStore;
  private readonly approvalPolicies: SqliteApprovalPolicyStore;
  private readonly approvalCheckpoints: SqliteApprovalCheckpointStore;
  private readonly approvalRequests: SqliteApprovalRequestStore;
  private readonly artifacts: SqliteArtifactStore;
  private readonly controlPlane: SqliteControlPlaneStore;
  private readonly runEvents: SqliteRunEventStore;
  private readonly runInterventions: SqliteRunInterventionStore;
  private readonly runSessions: SqliteRunSessionStore;
  private readonly lingThreadMetadata: SqliteLingThreadMetadataCoordinator;
  private readonly lingThreadSearch: SqliteLingThreadSearchStore;
  private readonly lingThreads: SqliteLingThreadStore;
  private readonly lingThreadCleanup: SqliteLingThreadCleanupStore;
  private readonly lingTurns: SqliteLingTurnStore;
  private readonly terminalReports: SqliteTerminalReportStore;
  private readonly conversationRevisions: SqliteConversationRevisionStore;
  private readonly stateTransitions: SqliteStateTransitionStore;
  private readonly resourceLeases: SqliteResourceLeaseStore;
  private readonly runtimeSemaphores: SqliteRuntimeSemaphoreStore;
  private readonly runtimeRecovery: SqliteRuntimeRecoveryCoordinator;
  private readonly runtimeWorkUnits: SqliteRuntimeWorkUnitStore;
  private readonly userProfile: SqliteUserProfileStore;
  private readonly workspaceSettings: SqliteWorkspaceSettingsStore;
  private readonly skillRegistry: SqliteSkillRegistryStore;
  private readonly skillRegression: SqliteSkillRegressionStore;
  private readonly skillCandidates: SqliteSkillCandidateStore;
  private readonly skillUsage: SqliteSkillUsageStore;
  private readonly procedureObservations: SqliteProcedureObservationStore;
  private readonly tasks: SqliteTaskStore;
  private readonly teammateDirect: SqliteTeammateDirectStore;
  private readonly teammateAssociations: SqliteTeammateAssociationStore;
  private readonly aiTeammates: SqliteTeammateCoreStore;
  private readonly teammateBootstrap: SqliteTeammateBootstrapCoordinator;
  private readonly teammateCleanup: SqliteTeammateCleanupStore;
  private readonly aiCouncils: SqliteAiCouncilStore;
  private readonly memoryConsolidation: SqliteMemoryConsolidationStore;
  private readonly memoryObjects: SqliteMemoryObjectStore;
  private readonly memoryReviews: SqliteMemoryReviewStore;
  private readonly memoryRetrieval: SqliteMemoryRetrievalStore;
  private readonly governanceNotifications: SqliteGovernanceNotificationStore;
  private readonly channelReferences: SqliteChannelReferenceValidator;
  private readonly channelMessages: SqliteChannelMessageStore;
  private readonly channelRouteDecisions: SqliteChannelRouteDecisionStore;
  private readonly channelIntentDecisions: SqliteChannelIntentDecisionStore;
  private readonly channelProposals: SqliteChannelProposalStore;
  private readonly channelAssets: SqliteChannelAssetStore;
  private readonly conversationAssets: SqliteConversationAssetStore;
  private readonly channelCollaborations: SqliteChannelCollaborationStore;
  private readonly channelProtocols: SqliteChannelProtocolStore;
  private readonly channelPlaybooks: SqliteChannelPlaybookStore;
  private readonly channelWorkflows: SqliteChannelWorkflowStore;
  private readonly channelTeamEvidence: SqliteChannelTeamEvidenceStore;
  private readonly channelTeamLifecycle: SqliteChannelTeamLifecycleStore;
  private readonly channelTeamPatterns: SqliteChannelTeamPatternStore;
  private readonly channelTeamSnapshots: SqliteChannelTeamSnapshotStore;
  private readonly channelCore: SqliteChannelCoreStore;
  private readonly externalWork: SqliteExternalWorkStore;
  private readonly externalWorkActions: SqliteExternalWorkActionStore;
  private readonly externalWorkCiTriage: SqliteExternalWorkCiTriageStore;
  private readonly externalWorkScheduler: SqliteExternalWorkSchedulerStore;
  private readonly externalWorkWorkflows: SqliteExternalWorkWorkflowCoordinator;
  private readonly workItems: SqliteWorkItemStore;

  constructor(options: SqliteRunStoreOptions) {
    this.paths = options.paths ?? resolveRuntimePaths(options.cwd);
    ensureRuntimePaths(this.paths);
    const existed = existsSync(this.paths.databasePath);
    this.database = new DatabaseSync(this.paths.databasePath);
    this.automations = new SqliteAutomationStore({ database: this.database });
    this.providers = new SqliteProviderStore({ database: this.database });
    this.mcps = new SqliteMcpStore(
      { database: this.database },
      { getAiTeammate: (id) => this.getAiTeammate(id) },
    );
    this.managedPlugins = new SqliteManagedPluginStore({ database: this.database });
    this.mediaJobs = new SqliteMediaStore({ database: this.database });
    this.mediaWorkflows = new SqliteMediaWorkflowStore({ database: this.database });
    this.approvalPolicies = new SqliteApprovalPolicyStore({ database: this.database });
    this.approvalCheckpoints = new SqliteApprovalCheckpointStore({ database: this.database });
    this.approvalRequests = new SqliteApprovalRequestStore(
      { database: this.database },
      {
        hasRun: (id) => Boolean(this.getRun(id)),
        hasMediaJob: (id) => Boolean(this.getMediaJob(id)),
        hasExternalWorkAction: (id) => Boolean(this.getExternalWorkAction(id)),
        hasWorkflowStep: (id) => Boolean(this.getChannelWorkflowStep(id)),
        createApprovalCheckpoint: (approval, now) => {
          this.approvalCheckpoints.createApprovalCheckpoint({ approval }, now);
        },
        syncApprovalCheckpointForApproval: (approval, now) => {
          this.approvalCheckpoints.syncApprovalCheckpointForApproval(approval, now);
        },
        rebuildLingThreadMetadataForApproval: (approval, now) => this.tryRebuildLingThreadMetadataForApproval(approval, now),
      },
    );
    this.artifacts = new SqliteArtifactStore(
      { database: this.database },
      {
        hasRun: (id) => Boolean(this.getRun(id)),
        hasMediaJob: (id) => Boolean(this.getMediaJob(id)),
        hasExternalWorkRecord: (id) => Boolean(this.getExternalWorkRecord(id)),
        rebuildLingThreadMetadataForRun: (runId, now) => this.tryRebuildLingThreadMetadataForRun(runId, now),
      },
    );
    this.controlPlane = new SqliteControlPlaneStore({ database: this.database });
    this.stateTransitions = new SqliteStateTransitionStore({ database: this.database });
    this.resourceLeases = new SqliteResourceLeaseStore({ database: this.database });
    this.runtimeSemaphores = new SqliteRuntimeSemaphoreStore({ database: this.database });
    this.runtimeWorkUnits = new SqliteRuntimeWorkUnitStore(
      { database: this.database },
      {
        findStateTransitionByIdempotency: (entityType, entityId, idempotencyKey) =>
          this.findStateTransitionByIdempotency(entityType, entityId, idempotencyKey),
        recordStateTransitionEvent: (input) => this.recordStateTransitionEvent(input),
        renewResourceLeasesForAttempt: (attemptId, renewedAt) =>
          this.resourceLeases.renewActiveResourceLeasesForAttempt(attemptId, renewedAt),
        renewRuntimeSemaphoreSlotsForAttempt: (attemptId, renewedAt) =>
          this.runtimeSemaphores.renewRuntimeSemaphoreSlotsForAttempt(attemptId, renewedAt),
      },
    );
    this.lingThreads = new SqliteLingThreadStore(
      { database: this.database },
      { rebuildLingThreadMetadata: (threadId, now) => this.tryRebuildLingThreadMetadata(threadId, now) },
    );
    this.lingThreadCleanup = new SqliteLingThreadCleanupStore(
      { database: this.database },
      { getLingThread: (threadId) => this.getLingThread(threadId) },
    );
    this.lingTurns = new SqliteLingTurnStore(
      { database: this.database },
      {
        getLingThread: (threadId) => this.getLingThread(threadId),
        getRun: (runId) => this.getRun(runId),
        rebuildLingThreadMetadata: (threadId, now) => this.tryRebuildLingThreadMetadata(threadId, now),
        rebuildLingThreadMetadataForTurn: (turnId, now) => this.tryRebuildLingThreadMetadataForTurn(turnId, now),
      },
    );
    this.terminalReports = new SqliteTerminalReportStore({ database: this.database });
    this.conversationRevisions = new SqliteConversationRevisionStore({ database: this.database });
    this.lingThreadMetadata = new SqliteLingThreadMetadataCoordinator(
      { database: this.database },
      {
        getLingThread: (threadId) => this.getLingThread(threadId),
        getLingTurn: (turnId) => this.getLingTurn(turnId),
        getRun: (runId) => this.getRun(runId),
        listLingThreads: (options) => this.listLingThreads(options),
        listLingTurns: (options) => this.listLingTurns(options),
        listRuns: (options) => this.listRuns(options),
        listApprovalRequests: (options) => this.listApprovalRequests(options),
        listArtifacts: (runId) => this.listArtifacts(runId),
        readLatestRunActionActivityAt: (runIds) => this.runEvents.readLatestRunActionActivityAt(runIds),
      },
    );
    this.lingThreadSearch = new SqliteLingThreadSearchStore(
      { database: this.database },
      { listLingThreads: (options) => this.listLingThreads(options) },
    );
    this.runSessions = new SqliteRunSessionStore(
      { database: this.database },
      this.paths,
      {
        insertLingTurnRun: (turnId, runId, role, createdAt) => this.lingTurns.insertLingTurnRun(turnId, runId, role, createdAt),
        reconcileLingTurnStatus: (turnId, now) => this.reconcileLingTurnStatus(turnId, now),
        rebuildLingThreadMetadata: (threadId, now) => this.tryRebuildLingThreadMetadata(threadId, now),
        findStateTransitionByIdempotency: (entityType, entityId, idempotencyKey) =>
          this.findStateTransitionByIdempotency(entityType, entityId, idempotencyKey),
        recordStateTransitionEvent: (input) => this.recordStateTransitionEvent(input),
        reconcileLingTurnStatusForRun: (runId, now) => this.lingTurns.reconcileLingTurnStatusForRun(runId, now),
        updateLinkedWorkUnitRunId: (workUnitId, runId, now) => this.runtimeWorkUnits.updateLinkedRunId(workUnitId, runId, now),
      },
    );
    this.runEvents = new SqliteRunEventStore(
      { database: this.database },
      {
        getRun: (runId) => this.getRun(runId),
        rebuildLingThreadMetadata: (threadId, now) => this.tryRebuildLingThreadMetadata(threadId, now),
      },
    );
    this.runInterventions = new SqliteRunInterventionStore(
      { database: this.database },
      {
        getRun: (runId) => this.getRun(runId),
        assertAttachmentInChannel: (channelId, attachmentId) => this.assertAttachmentInChannel(channelId, attachmentId),
        assertLinkPreviewInChannel: (channelId, linkPreviewId) => this.assertLinkPreviewInChannel(channelId, linkPreviewId),
      },
    );
    this.runtimeRecovery = new SqliteRuntimeRecoveryCoordinator({
      expireResourceLeases: (now) => this.expireResourceLeases(now),
      listRecoverableRunIds: () => this.runSessions.listRecoverableRunIds(),
      hasTerminalRunEvent: (runId) => this.runEvents.hasTerminalEvent(runId),
      appendRunEvent: (runId, type, data) => this.appendEvent(runId, type, data),
      markRunFailed: (runId, endedAt, errorMessage) => this.markRunFailed(runId, endedAt, errorMessage),
      getRun: (runId) => this.getRun(runId),
      getLingThread: (threadId) => this.getLingThread(threadId),
      updateLingThread: (threadId, input, now) => this.updateLingThread(threadId, input, now),
      listRecoverableChannelWorkflows: () => this.channelWorkflows.listRecoverableChannelWorkflows(),
      listChannelWorkflowSteps: (options) => this.listChannelWorkflowSteps(options),
      getApprovalRequest: (id) => this.getApprovalRequest(id),
      listApprovalRequests: (options) => this.listApprovalRequests(options),
      transitionChannelWorkflowStepStatus: (input) => this.transitionChannelWorkflowStepStatus(input),
      getChannelWorkflow: (workflowId) => this.getChannelWorkflow(workflowId),
      transitionChannelWorkflowStatus: (input) => this.transitionChannelWorkflowStatus(input),
    });
    this.userProfile = new SqliteUserProfileStore({ database: this.database });
    this.workspaceSettings = new SqliteWorkspaceSettingsStore({ database: this.database });
    this.skillRegistry = new SqliteSkillRegistryStore({ database: this.database });
    this.skillRegression = new SqliteSkillRegressionStore({ database: this.database });
    this.skillCandidates = new SqliteSkillCandidateStore({ database: this.database });
    this.skillUsage = new SqliteSkillUsageStore({ database: this.database });
    this.procedureObservations = new SqliteProcedureObservationStore({ database: this.database });
    this.tasks = new SqliteTaskStore({ database: this.database });
    this.teammateDirect = new SqliteTeammateDirectStore(
      { database: this.database },
      { getAiTeammate: (id) => this.getAiTeammate(id) },
    );
    this.teammateAssociations = new SqliteTeammateAssociationStore(
      { database: this.database },
      {
        getAiTeammate: (id) => this.getAiTeammate(id),
        getChannel: (id) => this.getChannel(id),
        hasTable: (tableName) => this.hasTable(tableName),
      },
    );
    this.aiTeammates = new SqliteTeammateCoreStore(
      { database: this.database },
      {
        ensureDefaultTeammateMemoryScopes: (teammateId, now) => this.ensureDefaultTeammateMemoryScopes(teammateId, now),
        ensureDefaultTeammateMemoryScopesForAll: (now) => this.ensureDefaultTeammateMemoryScopesForAll(now),
        getTeammatePrivateAttachment: (id) => this.getTeammatePrivateAttachment(id),
      },
    );
    this.teammateCleanup = new SqliteTeammateCleanupStore(
      { database: this.database },
      { getAiTeammate: (id) => this.getAiTeammate(id) },
    );
    this.aiCouncils = new SqliteAiCouncilStore(
      { database: this.database },
      {
        getAiTeammate: (id) => this.getAiTeammate(id),
        getChannel: (id) => this.getChannel(id),
        hasTable: (tableName) => this.hasTable(tableName),
      },
    );
    this.teammateBootstrap = new SqliteTeammateBootstrapCoordinator(
      { database: this.database },
      {
        hasTable: (tableName) => this.hasTable(tableName),
        getAiTeammate: (id) => this.getAiTeammate(id),
        createAiTeammate: (input, now) => this.createAiTeammate(input, now),
        listTeammateSkillBindings: (teammateId) => this.listTeammateSkillBindings(teammateId),
        replaceTeammateSkillBindings: (teammateId, bindings, now) =>
          this.replaceTeammateSkillBindings(teammateId, bindings, now),
        ensureDefaultTeammateMemoryScopes: (teammateId, now) =>
          this.teammateAssociations.ensureDefaultTeammateMemoryScopes(teammateId, now),
        ensureDefaultTeammateMemoryScopesForAll: (now) =>
          this.teammateAssociations.ensureDefaultTeammateMemoryScopesForAll(now),
      },
    );
    this.memoryConsolidation = new SqliteMemoryConsolidationStore({ database: this.database });
    this.memoryObjects = new SqliteMemoryObjectStore({ database: this.database });
    this.memoryReviews = new SqliteMemoryReviewStore(
      { database: this.database },
      {
        getMemoryObject: (id) => this.getMemoryObject(id),
        listMemoryObjects: (options) => this.listMemoryObjects(options),
        updateMemoryObject: (id, input, now) => this.updateMemoryObject(id, input, now),
      },
    );
    this.memoryRetrieval = new SqliteMemoryRetrievalStore(
      { database: this.database },
      { listMemoryObjects: (options) => this.listMemoryObjects(options) },
    );
    this.governanceNotifications = new SqliteGovernanceNotificationStore({ database: this.database });
    this.channelReferences = new SqliteChannelReferenceValidator({
      getChannel: (channelId) => this.getChannel(channelId),
      getChannelMessage: (messageId) => this.getChannelMessage(messageId),
      getChannelAttachment: (attachmentId) => this.getChannelAttachment(attachmentId),
      getChannelLinkPreview: (linkPreviewId) => this.getChannelLinkPreview(linkPreviewId),
      getTask: (taskId) => this.getTask(taskId),
      getRun: (runId) => this.getRun(runId),
      getChannelWorkflow: (workflowId) => this.getChannelWorkflow(workflowId),
      getChannelWorkflowStep: (workflowStepId) => this.getChannelWorkflowStep(workflowStepId),
      getChannelExecutionProposal: (proposalId) => this.getChannelExecutionProposal(proposalId),
      getChannelDecision: (decisionId) => this.getChannelDecision(decisionId),
      getChannelHandoff: (handoffId) => this.getChannelHandoff(handoffId),
      getWorkflowHandoffIntent: (intentId) => this.getWorkflowHandoffIntent(intentId),
      getWorkflowSelectorDecision: (decisionId) => this.getWorkflowSelectorDecision(decisionId),
      getChannelContextSummary: (contextSummaryId) => this.getChannelContextSummary(contextSummaryId),
      getAiTeammate: (teammateId) => this.getAiTeammate(teammateId),
      getApprovalRequest: (approvalId) => this.getApprovalRequest(approvalId),
    });
    this.channelMessages = new SqliteChannelMessageStore(
      { database: this.database },
      { hasChannel: (id) => Boolean(this.getChannel(id)) },
    );
    this.channelRouteDecisions = new SqliteChannelRouteDecisionStore(
      { database: this.database },
      {
        hasChannel: (id) => Boolean(this.getChannel(id)),
        getChannelMessage: (id) => this.getChannelMessage(id),
      },
    );
    this.channelIntentDecisions = new SqliteChannelIntentDecisionStore(
      { database: this.database },
      {
        assertMessageInChannel: (channelId, messageId) => this.assertMessageInChannel(channelId, messageId),
        assertProposalInChannel: (channelId, proposalId) => this.assertProposalInChannel(channelId, proposalId),
        assertWorkflowInChannel: (channelId, workflowId) => this.assertWorkflowInChannel(channelId, workflowId),
        hasAiTeammate: (id) => Boolean(this.getAiTeammate(id)),
      },
    );
    this.channelProposals = new SqliteChannelProposalStore(
      { database: this.database },
      {
        hasChannel: (id) => Boolean(this.getChannel(id)),
        getChannelMessage: (id) => this.getChannelMessage(id),
      },
    );
    this.channelAssets = new SqliteChannelAssetStore(
      { database: this.database },
      { hasChannel: (id) => Boolean(this.getChannel(id)) },
    );
    this.conversationAssets = new SqliteConversationAssetStore(
      { database: this.database },
      {
        hasLingThread: (id) => Boolean(this.getLingThread(id)),
        hasLingTurn: (id) => Boolean(this.getLingTurn(id)),
      },
    );
    this.channelCollaborations = new SqliteChannelCollaborationStore(
      { database: this.database },
      {
        assertChannelExists: (channelId) => this.assertChannelExists(channelId),
        assertSourceRefsInChannel: (channelId, input) => this.assertSourceRefsInChannel(channelId, input),
        assertAttachmentInChannel: (channelId, attachmentId) => this.assertAttachmentInChannel(channelId, attachmentId),
        assertLinkPreviewInChannel: (channelId, linkPreviewId) => this.assertLinkPreviewInChannel(channelId, linkPreviewId),
        assertMessageInChannel: (channelId, messageId) => this.assertMessageInChannel(channelId, messageId),
        assertTaskInChannel: (channelId, taskId) => this.assertTaskInChannel(channelId, taskId),
      },
    );
    this.channelProtocols = new SqliteChannelProtocolStore(
      { database: this.database },
      {
        assertChannelExists: (channelId) => this.assertChannelExists(channelId),
        assertChannelProtocolSourceRefsInChannel: (channelId, sourceRefs) => this.assertChannelProtocolSourceRefsInChannel(channelId, sourceRefs),
      },
    );
    this.channelPlaybooks = new SqliteChannelPlaybookStore(
      { database: this.database },
      { assertChannelExists: (channelId) => this.assertChannelExists(channelId) },
    );
    this.channelWorkflows = new SqliteChannelWorkflowStore(
      { database: this.database },
      {
        assertChannelExists: (channelId) => this.assertChannelExists(channelId),
        assertHandoffInChannel: (channelId, handoffId) => this.assertHandoffInChannel(channelId, handoffId),
        assertContextSummaryInChannel: (channelId, contextSummaryId) => this.assertContextSummaryInChannel(channelId, contextSummaryId),
        assertTaskInChannel: (channelId, taskId) => this.assertTaskInChannel(channelId, taskId),
        assertRunInChannel: (channelId, runId) => this.assertRunInChannel(channelId, runId),
        assertWorkflowCoordinationRefsInChannel: (channelId, refs) => this.assertWorkflowCoordinationRefsInChannel(channelId, refs),
        assertWorkflowSelectorTargetsInChannel: (channelId, input) => this.assertWorkflowSelectorTargetsInChannel(channelId, input),
        assertWorkflowPacketSourceRefsInChannel: (channelId, sourceRefs) => this.assertWorkflowPacketSourceRefsInChannel(channelId, sourceRefs),
        findStateTransitionByIdempotency: (entityType, entityId, idempotencyKey) =>
          this.findStateTransitionByIdempotency(entityType, entityId, idempotencyKey),
        recordStateTransitionEvent: (input) => this.recordStateTransitionEvent(input),
        releaseResourceLeasesForWorkflowStep: (workflowStepId, releasedAt) =>
          this.releaseResourceLeasesForOwner("workflow_step", workflowStepId, releasedAt),
      },
    );
    this.channelCore = new SqliteChannelCoreStore(
      { database: this.database },
      { ensureLingAgentChannelMemberships: (now, channelId) => this.ensureLingAgentChannelMemberships(now, channelId) },
    );
    this.channelTeamEvidence = new SqliteChannelTeamEvidenceStore(
      { database: this.database },
      { assertChannelExists: (channelId) => this.assertChannelExists(channelId) },
    );
    this.channelTeamLifecycle = new SqliteChannelTeamLifecycleStore({ database: this.database });
    this.channelTeamPatterns = new SqliteChannelTeamPatternStore(
      { database: this.database },
      { assertChannelExists: (channelId) => this.assertChannelExists(channelId) },
    );
    this.channelTeamSnapshots = new SqliteChannelTeamSnapshotStore(
      { database: this.database },
      { assertChannelExists: (channelId) => this.assertChannelExists(channelId) },
    );
    this.externalWork = new SqliteExternalWorkStore(
      { database: this.database },
      { assertChannelExists: (channelId) => this.assertChannelExists(channelId) },
    );
    this.externalWorkActions = new SqliteExternalWorkActionStore(
      { database: this.database },
      {
        assertChannelExists: (channelId) => this.assertChannelExists(channelId),
        getExternalWorkRecord: (id) => this.getExternalWorkRecord(id),
      },
    );
    this.externalWorkCiTriage = new SqliteExternalWorkCiTriageStore(
      { database: this.database },
      {
        assertChannelExists: (channelId) => this.assertChannelExists(channelId),
        getExternalWorkRecord: (id) => this.getExternalWorkRecord(id),
      },
    );
    this.externalWorkScheduler = new SqliteExternalWorkSchedulerStore(
      { database: this.database },
      {
        assertChannelExists: (channelId) => this.assertChannelExists(channelId),
        hasExternalWorkRecord: (id) => Boolean(this.getExternalWorkRecord(id)),
      },
    );
    this.externalWorkWorkflows = new SqliteExternalWorkWorkflowCoordinator({
      assertChannelExists: (channelId) => this.assertChannelExists(channelId),
      getChannel: (channelId) => this.getChannel(channelId),
      getExternalWorkRecordByIdempotency: (sourceKind, idempotencyKey) =>
        this.getExternalWorkRecordByIdempotency(sourceKind, idempotencyKey),
      createExternalWorkRecord: (record) => this.externalWork.createExternalWorkRecord(record),
      getChannelWorkflow: (workflowId) => this.getChannelWorkflow(workflowId),
      createChannelWorkflow: (input, now) => this.createChannelWorkflow(input, now),
      getChannelWorkflowStep: (workflowStepId) => this.getChannelWorkflowStep(workflowStepId),
      createChannelWorkflowStep: (input, now) => this.createChannelWorkflowStep(input, now),
    });
    this.workItems = new SqliteWorkItemStore(
      { database: this.database },
      {
        assertChannelExists: (channelId) => this.assertChannelExists(channelId),
        hasAiTeammate: (id) => Boolean(this.getAiTeammate(id)),
      },
    );
    configureSqliteRunStoreDatabase(this.database);
    applySqliteRunStoreMigrations({
      database: this.database,
      hasMigration: (version) => this.hasMigration(version),
      hasColumn: (tableName, columnName) => this.hasColumn(tableName, columnName),
      hasTable: (tableName) => this.hasTable(tableName),
      recordMigration: (version, name) => this.recordMigration(version, name),
    });
    this.ensureDefaultWorkspace();
    this.approvalPolicies.ensureDefaultApprovalPolicy();
    this.ensureDefaultAiTeammates();

    if (!existed) {
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    }
  }

  createLingThread(input: CreateLingThreadInput, now: string): LingThread {
    return this.lingThreads.createLingThread(input, now);
  }

  commitConversationMessageEdit(
    input: import("../conversation-revision-types.js").CommitConversationMessageEditInput,
    now: string,
  ): import("../conversation-revision-types.js").CommitConversationMessageEditResult {
    return this.conversationRevisions.commitConversationMessageEdit(input, now);
  }

  listConversationMessageRevisions(
    options: import("../conversation-revision-types.js").ListConversationMessageRevisionsOptions,
  ): import("../conversation-revision-types.js").ConversationMessageRevision[] {
    return this.conversationRevisions.listConversationMessageRevisions(options);
  }

  getConversationTurnSupersession(
    id: string,
  ): import("../conversation-revision-types.js").ConversationTurnSupersession | undefined {
    return this.conversationRevisions.getConversationTurnSupersession(id);
  }

  getConversationTurnSupersessionByIdempotency(
    idempotencyKey: string,
  ): import("../conversation-revision-types.js").ConversationTurnSupersession | undefined {
    return this.conversationRevisions.getConversationTurnSupersessionByIdempotency(idempotencyKey);
  }

  listConversationTurnSupersessions(
    options?: import("../conversation-revision-types.js").ListConversationTurnSupersessionsOptions,
  ): import("../conversation-revision-types.js").ConversationTurnSupersession[] {
    return this.conversationRevisions.listConversationTurnSupersessions(options);
  }

  updateConversationTurnSupersession(
    id: string,
    input: {
      readonly replacementTurnId?: string | null;
      readonly replacementStatus?: import("../conversation-revision-types.js").ConversationReplacementStatus;
      readonly failureReason?: string | null;
    },
    now: string,
  ): import("../conversation-revision-types.js").ConversationTurnSupersession | undefined {
    return this.conversationRevisions.updateConversationTurnSupersession(id, input, now);
  }

  getLingThread(threadId: string): LingThread | undefined {
    return this.lingThreads.getLingThread(threadId);
  }

  hardDeleteLingThread(
    threadId: string,
    input: HardDeleteLingThreadInput,
    now: string,
  ): HardDeleteLingThreadResult | undefined {
    return this.lingThreadCleanup.hardDeleteLingThread(threadId, input, now);
  }

  findLingThreadByOwner(input: {
    readonly kind: LingThreadKind;
    readonly taskId?: string;
    readonly workflowStepId?: string;
    readonly externalWorkId?: string;
    readonly teammateId?: string;
    readonly channelId?: string;
  }): LingThread | undefined {
    return this.lingThreads.findLingThreadByOwner(input);
  }

  listLingThreads(options: ListLingThreadsOptions = {}): LingThread[] {
    return this.lingThreads.listLingThreads(options);
  }

  searchLingThreads(options: ListLingThreadsOptions & { readonly q: string }): SearchLingThreadsResult {
    return this.lingThreadSearch.searchLingThreads(options);
  }

  updateLingThread(threadId: string, input: UpdateLingThreadInput, now: string): LingThread | undefined {
    return this.lingThreads.updateLingThread(threadId, input, now);
  }

  getLingThreadConversationMode(threadId: string): ConversationModeState | undefined {
    return this.lingThreads.getLingThreadConversationMode(threadId);
  }

  updateLingThreadConversationMode(
    threadId: string,
    input: UpdateLingThreadConversationModeInput,
    now: string,
  ): ConversationModeState | undefined {
    return this.lingThreads.updateLingThreadConversationMode(threadId, input, now);
  }

  getLingThreadGoal(threadId: string): LingThreadGoal | undefined {
    return this.lingThreads.getLingThreadGoal(threadId);
  }

  createLingThreadGoal(input: CreateLingThreadGoalInput, now: string): LingThreadGoal {
    return this.lingThreads.createLingThreadGoal(input, now);
  }

  replaceLingThreadGoal(input: CreateLingThreadGoalInput, now: string): LingThreadGoal {
    return this.lingThreads.replaceLingThreadGoal(input, now);
  }

  updateLingThreadGoal(goalId: string, input: UpdateLingThreadGoalInput, now: string): LingThreadGoal | undefined {
    return this.lingThreads.updateLingThreadGoal(goalId, input, now);
  }

  clearLingThreadGoal(threadId: string, now: string): LingThreadGoal | undefined {
    return this.lingThreads.clearLingThreadGoal(threadId, now);
  }

  getProposedPlanArtifact(planId: string): ProposedPlanArtifact | undefined {
    return this.lingThreads.getProposedPlanArtifact(planId);
  }

  listProposedPlanArtifacts(options: ListProposedPlanArtifactsOptions): ProposedPlanArtifact[] {
    return this.lingThreads.listProposedPlanArtifacts(options);
  }

  upsertProposedPlanArtifact(input: CreateProposedPlanArtifactInput, now: string): ProposedPlanArtifact {
    return this.lingThreads.upsertProposedPlanArtifact(input, now);
  }

  updateProposedPlanArtifact(planId: string, input: UpdateProposedPlanArtifactInput, now: string): ProposedPlanArtifact | undefined {
    return this.lingThreads.updateProposedPlanArtifact(planId, input, now);
  }

  rebuildLingThreadMetadata(threadId: string, now: string): LingThread | undefined {
    return this.lingThreadMetadata.rebuildLingThreadMetadata(threadId, now);
  }

  rebuildLingThreadMetadataForRun(runId: string, now: string): LingThread | undefined {
    return this.lingThreadMetadata.rebuildLingThreadMetadataForRun(runId, now);
  }

  createLingTurn(input: CreateLingTurnInput, now: string): LingTurn {
    return this.lingTurns.createLingTurn(input, now);
  }

  getLingTurn(turnId: string): LingTurn | undefined {
    return this.lingTurns.getLingTurn(turnId);
  }

  listLingTurns(options: ListLingTurnsOptions): LingTurn[] {
    return this.lingTurns.listLingTurns(options);
  }

  linkRunToLingTurn(input: LinkRunToLingTurnInput): LingTurnRun {
    return this.lingTurns.linkRunToLingTurn(input);
  }

  getLingTurnForRun(runId: string): LingTurn | undefined {
    return this.lingTurns.getLingTurnForRun(runId);
  }

  listLingTurnRuns(turnId: string): LingTurnRun[] {
    return this.lingTurns.listLingTurnRuns(turnId);
  }

  reconcileLingTurnStatus(turnId: string, now: string): LingTurn | undefined {
    return this.lingTurns.reconcileLingTurnStatus(turnId, now);
  }

  createTerminalReportDraft(input: CreateLingTerminalReportInput, now: string): LingTerminalReportRecord {
    return this.terminalReports.createTerminalReportDraft(input, now);
  }

  getTerminalReport(id: string): LingTerminalReportRecord | undefined {
    return this.terminalReports.getTerminalReport(id);
  }

  getTerminalReportForSource(
    sourceKind: TerminalReportSourceKind,
    sourceId: string,
    generation = 1,
    workspaceId?: string,
  ): LingTerminalReportRecord | undefined {
    return this.terminalReports.getTerminalReportForSource(sourceKind, sourceId, generation, workspaceId);
  }

  listTerminalReports(options: ListLingTerminalReportsOptions = {}): LingTerminalReportRecord[] {
    return this.terminalReports.listTerminalReports(options);
  }

  updateTerminalReportDraft(input: UpdateLingTerminalReportDraftInput): LingTerminalReportRecord {
    return this.terminalReports.updateTerminalReportDraft(input);
  }

  commitTerminalReport(input: CommitLingTerminalReportInput): LingTerminalReportRecord {
    return this.terminalReports.commitTerminalReport(input);
  }

  markTerminalReportPublished(input: MarkLingTerminalReportPublishedInput): LingTerminalReportRecord {
    return this.terminalReports.markTerminalReportPublished(input);
  }

  failTerminalReport(input: FailLingTerminalReportInput): LingTerminalReportRecord {
    return this.terminalReports.failTerminalReport(input);
  }

  createRun(input: CreateRunInput): RunSession {
    const run = this.runSessions.createRun(input);
    this.recordRunSkillUsage(run, "selected", run.createdAt);
    return run;
  }

  markRunStarted(runId: string, startedAt: string): void {
    this.runSessions.markRunStarted(runId, startedAt);
    this.recordRunSkillUsage(this.getRun(runId), "started", startedAt);
  }

  markRunWaitingForApproval(runId: string, updatedAt: string): void {
    this.runSessions.markRunWaitingForApproval(runId, updatedAt);
  }

  markRunRunning(runId: string, updatedAt: string): void {
    this.runSessions.markRunRunning(runId, updatedAt);
  }

  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): void {
    this.runSessions.markRunSucceeded(runId, endedAt, summaryPath);
    this.recordRunSkillUsage(this.getRun(runId), "succeeded", endedAt);
  }

  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): void {
    this.runSessions.markRunFailed(runId, endedAt, errorMessage, summaryPath);
    this.recordRunSkillUsage(this.getRun(runId), "failed", endedAt, errorMessage);
  }

  markRunCancelled(runId: string, endedAt: string, summaryPath?: string): void {
    this.runSessions.markRunCancelled(runId, endedAt, summaryPath);
    this.recordRunSkillUsage(this.getRun(runId), "cancelled", endedAt);
  }

  appendEvent(runId: string, type: RunEventType, data: unknown): RunEventEnvelope {
    return this.runEvents.appendEvent(runId, type, data);
  }

  appendControlPlaneEvent(input: AppendControlPlaneEventInput, now: string): ControlPlaneEvent {
    return this.controlPlane.appendControlPlaneEvent(input, now);
  }

  listControlPlaneEvents(options: ListControlPlaneEventsOptions): ControlPlaneEvent[] {
    return this.controlPlane.listControlPlaneEvents(options);
  }

  getLatestControlPlaneEventSeq(workspaceId: string): number {
    return this.controlPlane.getLatestControlPlaneEventSeq(workspaceId);
  }

  getRun(runId: string): RunSession | undefined {
    return this.runSessions.getRun(runId);
  }

  listRuns(options: ListRunsOptions = {}): RunSession[] {
    return this.runSessions.listRuns(options);
  }

  listEvents(runId: string, options: ListRunEventsOptions = {}): RunEventEnvelope[] {
    return this.runEvents.listEvents(runId, options);
  }

  countEvents(runId: string): number {
    return this.runEvents.countEvents(runId);
  }

  createRunIntervention(input: CreateRunInterventionInput, now: string): RunIntervention {
    return this.runInterventions.createRunIntervention(input, now);
  }

  getRunIntervention(interventionId: string): RunIntervention | undefined {
    return this.runInterventions.getRunIntervention(interventionId);
  }

  listRunInterventions(options: ListRunInterventionsOptions = {}): RunIntervention[] {
    return this.runInterventions.listRunInterventions(options);
  }

  updateRunInterventionStatus(input: UpdateRunInterventionStatusInput): RunIntervention | undefined {
    return this.runInterventions.updateRunInterventionStatus(input);
  }

  cancelRunIntervention(interventionId: string, now: string, reason?: string): RunIntervention | undefined {
    return this.runInterventions.cancelRunIntervention(interventionId, now, reason);
  }

  createWorkUnit(input: CreateWorkUnitInput): WorkUnit {
    return this.runtimeWorkUnits.createWorkUnit(input);
  }

  getWorkUnit(workUnitId: string): WorkUnit | undefined {
    return this.runtimeWorkUnits.getWorkUnit(workUnitId);
  }

  listWorkUnits(options: ListWorkUnitsOptions = {}): WorkUnit[] {
    return this.runtimeWorkUnits.listWorkUnits(options);
  }

  findWorkUnitByIdempotency(input: {
    readonly kind: WorkUnit["kind"];
    readonly ownerType: string;
    readonly ownerId: string;
    readonly idempotencyKey: string;
  }): WorkUnit | undefined {
    return this.runtimeWorkUnits.findWorkUnitByIdempotency(input);
  }

  linkRunToWorkUnit(runId: string, workUnitId: string, now: string): RunSession | undefined {
    return this.runSessions.linkRunToWorkUnit(runId, workUnitId, now);
  }

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
  }): TransitionResult<WorkUnitStatus> {
    return this.runtimeWorkUnits.transitionWorkUnitStatus(input);
  }

  createWorkUnitAttempt(input: CreateWorkUnitAttemptInput): WorkUnitAttempt {
    return this.runtimeWorkUnits.createWorkUnitAttempt(input);
  }

  getWorkUnitAttempt(attemptId: string): WorkUnitAttempt | undefined {
    return this.runtimeWorkUnits.getWorkUnitAttempt(attemptId);
  }

  listWorkUnitAttempts(workUnitId: string): WorkUnitAttempt[] {
    return this.runtimeWorkUnits.listWorkUnitAttempts(workUnitId);
  }

  updateWorkUnitAttemptStatus(input: {
    readonly attemptId: string;
    readonly status: WorkUnitAttempt["status"];
    readonly now: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly lastEventAt?: string;
    readonly lastHeartbeatAt?: string;
    readonly abortRequestedAt?: string;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  }): WorkUnitAttempt | undefined {
    return this.runtimeWorkUnits.updateWorkUnitAttemptStatus(input);
  }

  appendRuntimeEvent(input: AppendRuntimeEventInput): RuntimeEvent {
    return this.runtimeWorkUnits.appendRuntimeEvent(input);
  }

  listRuntimeEvents(workUnitId: string, options: ListRuntimeEventsOptions = {}): RuntimeEvent[] {
    return this.runtimeWorkUnits.listRuntimeEvents(workUnitId, options);
  }

  recordRuntimeHeartbeat(input: RecordRuntimeHeartbeatInput): RuntimeHeartbeat {
    return this.runtimeWorkUnits.recordRuntimeHeartbeat(input);
  }

  acquireRuntimeSemaphoreSlot(input: AcquireRuntimeSemaphoreSlotInput): RuntimeSemaphoreSlot | undefined {
    return this.runtimeSemaphores.acquireRuntimeSemaphoreSlot(input);
  }

  releaseRuntimeSemaphoreSlotsForOwner(ownerId: string, releasedAt: string, releaseReason: string): number {
    return this.runtimeSemaphores.releaseRuntimeSemaphoreSlotsForOwner(ownerId, releasedAt, releaseReason);
  }

  listRuntimeSemaphoreSlots(options: ListRuntimeSemaphoreSlotsOptions = {}): RuntimeSemaphoreSlot[] {
    return this.runtimeSemaphores.listRuntimeSemaphoreSlots(options);
  }

  createArtifact(input: CreateRunArtifactInput): RunArtifact {
    return this.artifacts.createArtifact(input);
  }

  getArtifact(artifactId: string): RunArtifact | undefined {
    return this.artifacts.getArtifact(artifactId);
  }

  listArtifacts(runId: string): RunArtifact[] {
    return this.artifacts.listArtifacts(runId);
  }

  listMediaJobArtifacts(mediaJobId: string): RunArtifact[] {
    return this.artifacts.listMediaJobArtifacts(mediaJobId);
  }

  listExternalWorkArtifacts(externalWorkId: string): RunArtifact[] {
    return this.artifacts.listExternalWorkArtifacts(externalWorkId);
  }

  recoverStaleRuns(now: string): number {
    return this.runtimeRecovery.recoverStaleRuns(now);
  }

  recoverStaleChannelWorkflows(now: string): number {
    return this.runtimeRecovery.recoverStaleChannelWorkflows(now);
  }

  listStateTransitionEvents(options: ListStateTransitionEventsOptions = {}): StateTransitionEvent[] {
    return this.stateTransitions.listStateTransitionEvents(options);
  }

  recordStateTransitionEvent(input: CreateStateTransitionEventInput): StateTransitionEvent {
    return this.stateTransitions.recordStateTransitionEvent(input);
  }

  findStateTransitionByIdempotency(
    entityType: StateTransitionEvent["entityType"],
    entityId: string,
    idempotencyKey: string,
  ): StateTransitionEvent | undefined {
    return this.stateTransitions.findStateTransitionByIdempotency(entityType, entityId, idempotencyKey);
  }

  transitionTaskStatus(input: {
    readonly taskId: string;
    readonly expectedStatus?: TaskStatus;
    readonly event: TaskTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly currentRunId?: string | null;
    readonly assigneeTeammateId?: string | null;
  }): TransitionResult<TaskStatus> {
    const task = this.getTask(input.taskId);
    if (!task) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.findStateTransitionByIdempotency("task", input.taskId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: task.status, to: task.status, duplicate: true };
      }
    }

    const result = transitionTask({
      entityId: input.taskId,
      currentStatus: task.status,
      expectedStatus: input.expectedStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) {
      return result;
    }

    const update = this.database
      .prepare(`
        UPDATE tasks
        SET
          status = ?,
          current_run_id = ?,
          assignee_teammate_id = ?,
          updated_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        result.to,
        input.currentRunId === undefined ? task.currentRunId ?? null : input.currentRunId,
        input.assigneeTeammateId === undefined ? task.assigneeTeammateId ?? null : input.assigneeTeammateId,
        input.now,
        input.taskId,
        result.from,
      );
    if (Number(update.changes) === 0) {
      const current = this.getTask(input.taskId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? task.status };
    }

    this.recordStateTransitionEvent({
      workspaceId: task.workspaceId,
      entityType: "task",
      entityId: input.taskId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    return result;
  }

  transitionRunStatus(input: {
    readonly runId: string;
    readonly expectedStatus?: RunStatus;
    readonly event: RunTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly summaryPath?: string;
    readonly errorMessage?: string | null;
  }): TransitionResult<RunStatus> {
    const result = this.runSessions.transitionRunStatus(input);
    if (result.ok && !result.duplicate) {
      const run = this.getRun(input.runId);
      if (result.to === "running") {
        this.recordRunSkillUsage(run, "started", input.now, input.reason);
      } else if (result.to === "succeeded" || result.to === "failed" || result.to === "cancelled") {
        this.recordRunSkillUsage(run, result.to, input.now, input.errorMessage ?? input.reason);
      }
    }
    return result;
  }

  acquireResourceLease(input: CreateResourceLeaseInput): ResourceLease | undefined {
    return this.resourceLeases.acquireResourceLease(input);
  }

  releaseResourceLeasesForOwner(ownerType: ResourceLeaseOwnerType, ownerId: string, releasedAt: string): number {
    return this.resourceLeases.releaseResourceLeasesForOwner(ownerType, ownerId, releasedAt);
  }

  expireResourceLeases(now: string): number {
    return this.resourceLeases.expireResourceLeases(now);
  }

  listResourceLeases(options: ListResourceLeasesOptions = {}): ResourceLease[] {
    return this.resourceLeases.listResourceLeases(options);
  }

  getBlockingResourceLease(resourceType: ResourceLease["resourceType"], resourceKey: string): ResourceLease | undefined {
    return this.resourceLeases.getBlockingResourceLease(resourceType, resourceKey);
  }

  getUserProfile(now: string): UserProfile {
    return this.userProfile.getUserProfile(now);
  }

  updateUserProfile(input: UpdateUserProfileInput, now: string): UserProfile {
    return this.userProfile.updateUserProfile(input, now);
  }

  getWorkspaceSettings(): WorkspaceSettings {
    return this.workspaceSettings.getWorkspaceSettings();
  }

  updateWorkspaceSettings(input: UpdateWorkspaceSettingsInput, now: string): WorkspaceSettings {
    return this.workspaceSettings.updateWorkspaceSettings(input, now);
  }

  createChannel(input: CreateChannelInput, now: string): Channel {
    return this.channelCore.createChannel(input, now);
  }

  getChannel(id: string): Channel | undefined {
    return this.channelCore.getChannel(id);
  }

  listChannels(options: ListChannelsOptions = {}): Channel[] {
    return this.channelCore.listChannels(options);
  }

  updateChannel(id: string, input: ChannelUpdateInput, now: string): Channel | undefined {
    return this.channelCore.updateChannel(id, input, now);
  }

  deleteChannel(id: string): boolean {
    return this.channelCore.deleteChannel(id);
  }

  createChannelBranch(input: CreateChannelBranchInput, now: string): ChannelBranch {
    return this.channelCore.createChannelBranch(input, now);
  }

  getChannelBranch(id: string): ChannelBranch | undefined {
    return this.channelCore.getChannelBranch(id);
  }

  listChannelBranches(options: ListChannelBranchesOptions = {}): ChannelBranch[] {
    return this.channelCore.listChannelBranches(options);
  }

  updateChannelBranch(id: string, input: ChannelBranchUpdateInput, now: string): ChannelBranch | undefined {
    return this.channelCore.updateChannelBranch(id, input, now);
  }

  deleteChannelBranch(id: string): boolean {
    return this.channelCore.deleteChannelBranch(id);
  }

  createChannelTeamEvidenceItem(input: CreateChannelTeamEvidenceItemInput, now: string): ChannelTeamEvidenceItem {
    return this.channelTeamEvidence.createChannelTeamEvidenceItem(input, now);
  }

  getChannelTeamEvidenceItem(id: string): ChannelTeamEvidenceItem | undefined {
    return this.channelTeamEvidence.getChannelTeamEvidenceItem(id);
  }

  listChannelTeamEvidenceItems(options: ListChannelTeamEvidenceItemsOptions): ChannelTeamEvidenceItem[] {
    return this.channelTeamEvidence.listChannelTeamEvidenceItems(options);
  }

  updateChannelTeamEvidenceItem(
    id: string,
    input: UpdateChannelTeamEvidenceItemInput,
    now: string,
  ): ChannelTeamEvidenceItem | undefined {
    return this.channelTeamEvidence.updateChannelTeamEvidenceItem(id, input, now);
  }

  listFoldedChannelTeamEvidenceForTurn(options: ListFoldedChannelTeamEvidenceForTurnOptions): FoldedExpertsReadModel {
    return this.channelTeamEvidence.listFoldedChannelTeamEvidenceForTurn(options);
  }

  createReliabilityIncident(input: CreateReliabilityIncidentInput, now: string): ReliabilityIncident {
    return this.channelTeamLifecycle.createReliabilityIncident(input, now);
  }

  listReliabilityIncidents(options: ListReliabilityIncidentsOptions = {}): ReliabilityIncident[] {
    return this.channelTeamLifecycle.listReliabilityIncidents(options);
  }

  createAvailabilityIncident(input: CreateAvailabilityIncidentInput, now: string): AvailabilityIncident {
    return this.channelTeamLifecycle.createAvailabilityIncident(input, now);
  }

  listAvailabilityIncidents(options: ListAvailabilityIncidentsOptions = {}): AvailabilityIncident[] {
    return this.channelTeamLifecycle.listAvailabilityIncidents(options);
  }

  createChannelTeamPattern(input: CreateChannelTeamPatternInput, now: string): ChannelTeamPattern {
    return this.channelTeamPatterns.createChannelTeamPattern(input, now);
  }

  getChannelTeamPattern(id: string): ChannelTeamPattern | undefined {
    return this.channelTeamPatterns.getChannelTeamPattern(id);
  }

  listChannelTeamPatterns(options: ListChannelTeamPatternsOptions): ChannelTeamPattern[] {
    return this.channelTeamPatterns.listChannelTeamPatterns(options);
  }

  listActiveChannelTeamProvisionalRules(options: ListActiveChannelTeamProvisionalRulesOptions): ChannelTeamPattern[] {
    return this.channelTeamPatterns.listActiveChannelTeamProvisionalRules(options);
  }

  updateChannelTeamPattern(
    id: string,
    input: UpdateChannelTeamPatternInput,
    now: string,
  ): ChannelTeamPattern | undefined {
    return this.channelTeamPatterns.updateChannelTeamPattern(id, input, now);
  }

  expireChannelTeamPatterns(now: string): number {
    return this.channelTeamPatterns.expireChannelTeamPatterns(now);
  }

  createChannelTeamSnapshot(input: CreateChannelTeamSnapshotInput, now: string): ChannelTeamSnapshot {
    return this.channelTeamSnapshots.createChannelTeamSnapshot(input, now);
  }

  getChannelTeamSnapshot(id: string): ChannelTeamSnapshot | undefined {
    return this.channelTeamSnapshots.getChannelTeamSnapshot(id);
  }

  listChannelTeamSnapshots(options: ListChannelTeamSnapshotsOptions): ChannelTeamSnapshot[] {
    return this.channelTeamSnapshots.listChannelTeamSnapshots(options);
  }

  createChannelTeamEvaluationRun(input: CreateChannelTeamEvaluationRunInput, now: string): ChannelTeamEvaluationRun {
    return this.channelTeamSnapshots.createChannelTeamEvaluationRun(input, now);
  }

  getChannelTeamEvaluationRun(id: string): ChannelTeamEvaluationRun | undefined {
    return this.channelTeamSnapshots.getChannelTeamEvaluationRun(id);
  }

  listChannelTeamEvaluationRuns(options: ListChannelTeamEvaluationRunsOptions): ChannelTeamEvaluationRun[] {
    return this.channelTeamSnapshots.listChannelTeamEvaluationRuns(options);
  }

  createTask(input: CreateTaskInput, now: string): Task {
    return this.tasks.createTask(input, now);
  }

  getTask(id: string): Task | undefined {
    return this.tasks.getTask(id);
  }

  listTasks(options: ListTasksOptions = {}): Task[] {
    return this.tasks.listTasks(options);
  }

  updateTask(id: string, input: TaskUpdateInput, now: string): Task | undefined {
    return this.tasks.updateTask(id, input, now);
  }

  deleteTask(id: string): boolean {
    return this.tasks.deleteTask(id);
  }

  createAiTeammate(input: CreateAiTeammateInput, now: string): AiTeammate {
    return this.aiTeammates.createAiTeammate(input, now);
  }

  getAiTeammate(id: string): AiTeammate | undefined {
    return this.aiTeammates.getAiTeammate(id);
  }

  listAiTeammates(options: ListAiTeammatesOptions = {}): AiTeammate[] {
    return this.aiTeammates.listAiTeammates(options);
  }

  updateAiTeammate(id: string, input: AiTeammateUpdateInput, now: string): AiTeammate | undefined {
    return this.aiTeammates.updateAiTeammate(id, input, now);
  }

  disableAiTeammate(id: string, now: string): AiTeammate | undefined {
    return this.aiTeammates.disableAiTeammate(id, now);
  }

  hardDeleteAiTeammate(id: string, input: HardDeleteAiTeammateInput, now: string): HardDeleteAiTeammateResult | undefined {
    return this.teammateCleanup.hardDeleteAiTeammate(id, input, now);
  }

  getAiCouncil(id: string): AiCouncil | undefined {
    return this.aiCouncils.getAiCouncil(id);
  }

  listAiCouncils(options: ListAiCouncilsOptions = {}): AiCouncil[] {
    return this.aiCouncils.listAiCouncils(options);
  }

  createAiCouncil(input: CreateAiCouncilInput, now: string): AiCouncil {
    return this.aiCouncils.createAiCouncil(input, now);
  }

  cloneAiCouncil(sourceCouncilId: string, input: CloneAiCouncilInput, now: string): AiCouncil {
    return this.aiCouncils.cloneAiCouncil(sourceCouncilId, input, now);
  }

  updateAiCouncil(id: string, input: UpdateAiCouncilInput, now: string): AiCouncil | undefined {
    return this.aiCouncils.updateAiCouncil(id, input, now);
  }

  getAiCouncilHealthReport(generatedAt: string, options: AiCouncilHealthReportOptions = {}): AiCouncilHealthReport {
    return this.aiCouncils.getAiCouncilHealthReport(generatedAt, options);
  }

  listAiCouncilMembers(councilId: string): AiCouncilMember[] {
    return this.aiCouncils.listAiCouncilMembers(councilId);
  }

  replaceAiCouncilMembers(
    councilId: string,
    members: readonly ReplaceAiCouncilMemberInput[],
    now: string,
  ): AiCouncilMember[] {
    return this.aiCouncils.replaceAiCouncilMembers(councilId, members, now);
  }

  getChannelCouncilPolicy(channelId: string): ChannelCouncilPolicy | undefined {
    return this.aiCouncils.getChannelCouncilPolicy(channelId);
  }

  upsertChannelCouncilPolicy(
    channelId: string,
    input: UpsertChannelCouncilPolicyInput,
    now: string,
  ): ChannelCouncilPolicy {
    return this.aiCouncils.upsertChannelCouncilPolicy(channelId, input, now);
  }

  getEffectiveChannelCouncil(channelId: string): EffectiveChannelCouncilProjection | undefined {
    return this.aiCouncils.getEffectiveChannelCouncil(channelId);
  }

  listTeammateChannelMemberships(teammateId: string): TeammateChannelMembership[] {
    return this.teammateAssociations.listTeammateChannelMemberships(teammateId);
  }

  replaceTeammateChannelMemberships(
    teammateId: string,
    memberships: readonly ReplaceTeammateChannelMembershipInput[],
    now: string,
  ): TeammateChannelMembership[] {
    return this.teammateAssociations.replaceTeammateChannelMemberships(teammateId, memberships, now);
  }

  listTeammateSkillBindings(teammateId: string): TeammateSkillBinding[] {
    return this.teammateAssociations.listTeammateSkillBindings(teammateId);
  }

  replaceTeammateSkillBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateSkillBindingInput[],
    now: string,
  ): TeammateSkillBinding[] {
    return this.teammateAssociations.replaceTeammateSkillBindings(teammateId, bindings, now);
  }

  listSkillRegistryEntries(options: ListSkillRegistryOptions = {}): SkillRegistryEntry[] {
    return this.skillRegistry.listSkillRegistryEntries(options);
  }

  getSkillRegistryEntry(id: string): SkillRegistryEntry | undefined {
    return this.skillRegistry.getSkillRegistryEntry(id);
  }

  listSkillSourceSnapshots(options: ListSkillSourceSnapshotOptions = {}): SkillSourceSnapshot[] {
    return this.skillRegistry.listSkillSourceSnapshots(options);
  }

  getSkillSourceSnapshot(skillId: string, options: Pick<ListSkillSourceSnapshotOptions, "reviewStatus" | "includeArchived"> = {}): SkillSourceSnapshot | undefined {
    return this.skillRegistry.getSkillSourceSnapshot(skillId, options);
  }

  getSkillSourceSnapshotById(id: string): SkillSourceSnapshot | undefined {
    return this.skillRegistry.getSkillSourceSnapshotById(id);
  }

  upsertSkillSourceSnapshot(input: CreateSkillSourceSnapshotInput, now: string): SkillSourceSnapshot {
    return this.skillRegistry.upsertSkillSourceSnapshot(input, now);
  }

  archiveSkillSourceSnapshot(skillId: string, now: string): SkillSourceSnapshot | undefined {
    return this.skillRegistry.archiveSkillSourceSnapshot(skillId, now);
  }

  rollbackSkillSourceSnapshot(snapshotId: string, now: string): SkillSourceSnapshot | undefined {
    return this.skillRegistry.rollbackSkillSourceSnapshot(snapshotId, now);
  }

  getOfficialSkillSourceSubscription(): OfficialSkillSourceSubscription | undefined {
    return this.skillRegistry.getOfficialSkillSourceSubscription();
  }

  upsertOfficialSkillSourceSubscription(input: UpsertOfficialSkillSourceSubscriptionInput, now: string): OfficialSkillSourceSubscription {
    return this.skillRegistry.upsertOfficialSkillSourceSubscription(input, now);
  }

  getSkillSourceUpgradePolicy(now?: string): SkillSourceUpgradePolicy {
    return this.skillRegistry.getSkillSourceUpgradePolicy(now);
  }

  updateSkillSourceUpgradePolicy(input: UpdateSkillSourceUpgradePolicyInput, now: string): SkillSourceUpgradePolicy {
    return this.skillRegistry.updateSkillSourceUpgradePolicy(input, now);
  }

  upsertSkillSourceArtifact(input: CreateSkillSourceArtifactInput, now: string): SkillSourceArtifact {
    return this.skillRegistry.upsertSkillSourceArtifact(input, now);
  }

  getSkillSourceArtifact(id: string): SkillSourceArtifact | undefined {
    return this.skillRegistry.getSkillSourceArtifact(id);
  }

  listSkillSourceArtifacts(options: ListSkillSourceArtifactOptions = {}): SkillSourceArtifact[] {
    return this.skillRegistry.listSkillSourceArtifacts(options);
  }

  upsertSkillCompiledRuntimeView(input: CreateSkillCompiledRuntimeViewInput, now: string): SkillCompiledRuntimeViewRecord {
    return this.skillRegistry.upsertSkillCompiledRuntimeView(input, now);
  }

  getSkillCompiledRuntimeView(id: string): SkillCompiledRuntimeViewRecord | undefined {
    return this.skillRegistry.getSkillCompiledRuntimeView(id);
  }

  listSkillCompiledRuntimeViews(options: ListSkillCompiledRuntimeViewOptions = {}): SkillCompiledRuntimeViewRecord[] {
    return this.skillRegistry.listSkillCompiledRuntimeViews(options);
  }

  archiveSkillCompiledRuntimeView(id: string, now: string): SkillCompiledRuntimeViewRecord | undefined {
    return this.skillRegistry.archiveSkillCompiledRuntimeView(id, now);
  }

  createSkillRegressionRun(input: CreateSkillRegressionRunInput, now: string): SkillRegressionRun {
    return this.skillRegression.createSkillRegressionRun(input, now);
  }

  getSkillRegressionRun(id: string): SkillRegressionRun | undefined {
    return this.skillRegression.getSkillRegressionRun(id);
  }

  listSkillRegressionRuns(options: ListSkillRegressionRunsOptions = {}): SkillRegressionRun[] {
    return this.skillRegression.listSkillRegressionRuns(options);
  }

  createSkillImportDraft(input: CreateSkillImportDraftInput, now: string): SkillImportDraft {
    return this.skillRegistry.createSkillImportDraft(input, now);
  }

  getSkillImportDraft(id: string): SkillImportDraft | undefined {
    return this.skillRegistry.getSkillImportDraft(id);
  }

  publishSkillImportDraft(id: string, now: string): SkillRegistryEntry[] {
    return this.skillRegistry.publishSkillImportDraft(id, now);
  }

  publishSkillRevisionDraft(input: PublishSkillRevisionDraftInput, now: string): SkillRegistryEntry {
    return this.skillRegistry.publishSkillRevisionDraft(input, now);
  }

  archiveSkillRegistryEntry(id: string, now: string): SkillRegistryEntry | undefined {
    return this.skillRegistry.archiveSkillRegistryEntry(id, now);
  }

  hardDeleteSkillRegistryEntry(id: string): SkillHardDeleteResult {
    return this.skillRegistry.hardDeleteSkillRegistryEntry(id);
  }

  createSkillCandidate(input: CreateSkillCandidateInput, now: string): SkillCandidate {
    return this.skillCandidates.createSkillCandidate(input, now);
  }

  getSkillCandidate(id: string): SkillCandidate | undefined {
    return this.skillCandidates.getSkillCandidate(id);
  }

  listSkillCandidates(options: ListSkillCandidatesOptions = {}): SkillCandidate[] {
    return this.skillCandidates.listSkillCandidates(options);
  }

  listSkillCandidateReviewRecords(candidateId: string): SkillCandidateReviewRecord[] {
    return this.skillCandidates.listSkillCandidateReviewRecords(candidateId);
  }

  applySkillCandidateReviewAction(
    input: ApplySkillCandidateReviewActionInput,
    now: string,
  ): { readonly candidate: SkillCandidate; readonly action: SkillCandidateReviewRecord } {
    return this.skillCandidates.applySkillCandidateReviewAction(input, now);
  }

  markSkillCandidatePublished(candidateId: string, now: string): SkillCandidate {
    return this.skillCandidates.markSkillCandidatePublished(candidateId, now);
  }

  createProcedureObservation(input: CreateProcedureObservationInput, now: string): ProcedureObservation {
    return this.procedureObservations.createProcedureObservation(input, now);
  }

  listProcedureObservations(options: ListProcedureObservationsOptions = {}): ProcedureObservation[] {
    return this.procedureObservations.listProcedureObservations(options);
  }

  listProcedureObservationClusters(options: ListProcedureObservationClustersOptions = {}): ProcedureObservationCluster[] {
    return this.procedureObservations.listProcedureObservationClusters(options);
  }

  getProcedureObservationCluster(id: string, workspaceId?: string): ProcedureObservationCluster | undefined {
    return this.procedureObservations.getProcedureObservationCluster(id, workspaceId);
  }

  createCandidateGenerationDecision(input: CreateCandidateGenerationDecisionInput, now: string): CandidateGenerationDecision {
    return this.procedureObservations.createCandidateGenerationDecision(input, now);
  }

  listCandidateGenerationDecisions(options: ListCandidateGenerationDecisionsOptions = {}): CandidateGenerationDecision[] {
    return this.procedureObservations.listCandidateGenerationDecisions(options);
  }

  appendSkillUsageEvent(input: CreateSkillUsageEventInput, now: string): SkillUsageEvent {
    return this.skillUsage.appendSkillUsageEvent(input, now);
  }

  listSkillUsageEvents(options: ListSkillUsageEventsOptions = {}): SkillUsageEvent[] {
    return this.skillUsage.listSkillUsageEvents(options);
  }

  listSkillUsageStats(options: ListSkillUsageStatsOptions = {}): SkillUsageStats[] {
    return this.skillUsage.listSkillUsageStats(options);
  }

  private recordRunSkillUsage(
    run: RunSession | undefined,
    kind: Extract<SkillUsageEventKind, "selected" | "started" | "succeeded" | "failed" | "cancelled">,
    now: string,
    reason?: string | null,
  ): void {
    if (!run?.selectedSkillId) {
      return;
    }
    this.skillUsage.appendSkillUsageEvent({
      skillId: run.selectedSkillId,
      runId: run.id,
      teammateId: run.teammateId,
      channelId: run.channelId,
      kind,
      reason: reason ?? undefined,
    }, now);
  }

  listTeammateMemoryScopes(teammateId: string): TeammateMemoryScope[] {
    return this.teammateAssociations.listTeammateMemoryScopes(teammateId);
  }

  replaceTeammateMemoryScopes(
    teammateId: string,
    scopes: readonly ReplaceTeammateMemoryScopeInput[],
    now: string,
  ): TeammateMemoryScope[] {
    return this.teammateAssociations.replaceTeammateMemoryScopes(teammateId, scopes, now);
  }

  createMemoryConsolidationJob(input: CreateMemoryConsolidationJobInput, now: string): MemoryConsolidationJob {
    return this.memoryConsolidation.createMemoryConsolidationJob(input, now);
  }

  getMemoryConsolidationJob(id: string): MemoryConsolidationJob | undefined {
    return this.memoryConsolidation.getMemoryConsolidationJob(id);
  }

  listMemoryConsolidationJobs(options: ListMemoryConsolidationJobsOptions = {}): MemoryConsolidationJob[] {
    return this.memoryConsolidation.listMemoryConsolidationJobs(options);
  }

  updateMemoryConsolidationJob(id: string, input: UpdateMemoryConsolidationJobInput, now: string): MemoryConsolidationJob | undefined {
    return this.memoryConsolidation.updateMemoryConsolidationJob(id, input, now);
  }

  createMemoryObject(input: CreateMemoryObjectInput, now: string): MemoryObject {
    return this.memoryObjects.createMemoryObject(input, now);
  }

  getMemoryObject(id: string): MemoryObject | undefined {
    return this.memoryObjects.getMemoryObject(id);
  }

  listMemoryObjects(options: ListMemoryObjectsOptions = {}): MemoryObject[] {
    return this.memoryObjects.listMemoryObjects(options);
  }

  updateMemoryObject(id: string, input: MemoryObjectUpdateInput, now: string): MemoryObject | undefined {
    return this.memoryObjects.updateMemoryObject(id, input, now);
  }

  getMemorySelfImprovingMetadata(memoryId: string): MemorySelfImprovingMetadata | undefined {
    return this.memoryObjects.getMemorySelfImprovingMetadata(memoryId);
  }

  upsertMemorySelfImprovingMetadata(input: UpsertMemorySelfImprovingMetadataInput): MemorySelfImprovingMetadata {
    return this.memoryObjects.upsertMemorySelfImprovingMetadata(input);
  }

  listMemorySelfImprovingMetadata(options: ListMemorySelfImprovingMetadataOptions = {}): MemorySelfImprovingMetadata[] {
    return this.memoryObjects.listMemorySelfImprovingMetadata(options);
  }

  getMemoryReviewPolicy(workspaceId = DEFAULT_WORKSPACE_ID): MemoryReviewPolicy {
    return this.memoryReviews.getMemoryReviewPolicy(workspaceId);
  }

  updateMemoryReviewPolicy(input: MemoryReviewPolicyUpdateInput, now: string): MemoryReviewPolicy {
    return this.memoryReviews.updateMemoryReviewPolicy(input, now);
  }

  recordMemoryReviewDecision(input: CreateMemoryReviewDecisionInput, now: string): MemoryReviewDecision {
    return this.memoryReviews.recordMemoryReviewDecision(input, now);
  }

  getLatestMemoryReviewDecision(memoryId: string): MemoryReviewDecision | undefined {
    return this.memoryReviews.getLatestMemoryReviewDecision(memoryId);
  }

  listMemoryPromotionInbox(options: ListMemoryPromotionInboxOptions = {}): MemoryPromotionInboxItem[] {
    return this.memoryReviews.listMemoryPromotionInbox(options);
  }

  applyMemoryReviewAction(input: ApplyMemoryReviewActionInput, now: string): { readonly memory: MemoryObject; readonly action: MemoryReviewActionRecord } {
    return this.memoryReviews.applyMemoryReviewAction(input, now);
  }

  recallMemory(input: MemoryRecallRequest): MemoryRecallResult {
    return this.memoryRetrieval.recallMemory(input);
  }

  recordUsedMemoryEvent(input: CreateUsedMemoryEventInput, now: string): UsedMemoryEvent {
    return this.memoryRetrieval.recordUsedMemoryEvent(input, now);
  }

  listUsedMemoryEvents(options: ListUsedMemoryEventsOptions = {}): UsedMemoryEvent[] {
    return this.memoryRetrieval.listUsedMemoryEvents(options);
  }

  upsertGovernanceNotification(input: CreateGovernanceNotificationInput, now: string): UpsertGovernanceNotificationResult {
    return this.governanceNotifications.upsertGovernanceNotification(input, now);
  }

  getGovernanceNotification(id: string): GovernanceNotification | undefined {
    return this.governanceNotifications.getGovernanceNotification(id);
  }

  listGovernanceNotifications(options: ListGovernanceNotificationsOptions = {}): GovernanceNotification[] {
    return this.governanceNotifications.listGovernanceNotifications(options);
  }

  updateGovernanceNotificationDelivery(id: string, input: UpdateGovernanceNotificationDeliveryInput, now: string): GovernanceNotification | undefined {
    return this.governanceNotifications.updateGovernanceNotificationDelivery(id, input, now);
  }

  markGovernanceNotificationSeen(id: string, now: string): GovernanceNotification | undefined {
    return this.governanceNotifications.markGovernanceNotificationSeen(id, now);
  }

  dismissGovernanceNotification(id: string, now: string): GovernanceNotification | undefined {
    return this.governanceNotifications.dismissGovernanceNotification(id, now);
  }

  resolveGovernanceNotificationByDedupeKey(workspaceId: string, dedupeKey: string, now: string): GovernanceNotification | undefined {
    return this.governanceNotifications.resolveGovernanceNotificationByDedupeKey(workspaceId, dedupeKey, now);
  }

  getGovernanceNotificationSummary(workspaceId = DEFAULT_WORKSPACE_ID, generatedAt?: string): GovernanceNotificationSummary {
    return this.governanceNotifications.getGovernanceNotificationSummary(workspaceId, generatedAt);
  }

  getOrCreateTeammateDirectThread(teammateId: string, now: string): TeammateDirectThread {
    return this.teammateDirect.getOrCreateTeammateDirectThread(teammateId, now);
  }

  updateTeammateDirectThreadWorkspace(threadId: string, workspaceBinding: DirectWorkspaceBinding | null, now: string): TeammateDirectThread | undefined {
    return this.teammateDirect.updateTeammateDirectThreadWorkspace(threadId, workspaceBinding, now);
  }

  listTeammateDirectMessages(options: ListTeammateDirectMessagesOptions): TeammateDirectMessage[] {
    return this.teammateDirect.listTeammateDirectMessages(options);
  }

  listTeammateDirectMessagesPage(options: ListTeammateDirectMessagesOptions): TeammateDirectMessageListPage {
    return this.teammateDirect.listTeammateDirectMessagesPage(options);
  }

  getTeammateDirectMessage(id: string): TeammateDirectMessage | undefined {
    return this.teammateDirect.getTeammateDirectMessage(id);
  }

  createTeammateDirectMessage(input: CreateTeammateDirectMessageInput, now: string): TeammateDirectMessage {
    return this.teammateDirect.createTeammateDirectMessage(input, now);
  }

  updateTeammateDirectMessageRuntime(
    id: string,
    input: {
      readonly body?: string;
      readonly status?: TeammateDirectMessage["status"];
      readonly errorMessage?: string | null;
      readonly linkedRunId?: string | null;
    },
    now: string,
  ): TeammateDirectMessage | undefined {
    return this.teammateDirect.updateTeammateDirectMessageRuntime(id, input, now);
  }

  createTeammateDirectLinkPreview(input: CreateTeammateDirectLinkPreviewInput, now: string): TeammateDirectLinkPreview {
    return this.teammateDirect.createTeammateDirectLinkPreview(input, now);
  }

  getTeammateDirectLinkPreview(id: string): TeammateDirectLinkPreview | undefined {
    return this.teammateDirect.getTeammateDirectLinkPreview(id);
  }

  listTeammateDirectLinkPreviews(options: ListTeammateDirectLinkPreviewsOptions): TeammateDirectLinkPreview[] {
    return this.teammateDirect.listTeammateDirectLinkPreviews(options);
  }

  updateTeammateDirectLinkPreview(id: string, input: UpdateTeammateDirectLinkPreviewInput, now: string): TeammateDirectLinkPreview | undefined {
    return this.teammateDirect.updateTeammateDirectLinkPreview(id, input, now);
  }

  createTeammateDirectReplyIntervention(input: CreateTeammateDirectReplyInterventionInput, now: string): TeammateDirectReplyIntervention {
    return this.teammateDirect.createTeammateDirectReplyIntervention(input, now);
  }

  getTeammateDirectReplyIntervention(interventionId: string): TeammateDirectReplyIntervention | undefined {
    return this.teammateDirect.getTeammateDirectReplyIntervention(interventionId);
  }

  listTeammateDirectReplyInterventions(options: ListTeammateDirectReplyInterventionsOptions = {}): TeammateDirectReplyIntervention[] {
    return this.teammateDirect.listTeammateDirectReplyInterventions(options);
  }

  updateTeammateDirectReplyInterventionStatus(input: UpdateTeammateDirectReplyInterventionStatusInput): TeammateDirectReplyIntervention | undefined {
    return this.teammateDirect.updateTeammateDirectReplyInterventionStatus(input);
  }

  cancelTeammateDirectReplyIntervention(interventionId: string, now: string, reason?: string): TeammateDirectReplyIntervention | undefined {
    return this.teammateDirect.cancelTeammateDirectReplyIntervention(interventionId, now, reason);
  }

  createTeammatePrivateAttachment(input: CreateTeammatePrivateAttachmentInput): TeammatePrivateAttachment {
    return this.teammateDirect.createTeammatePrivateAttachment(input);
  }

  getTeammatePrivateAttachment(id: string): TeammatePrivateAttachment | undefined {
    return this.teammateDirect.getTeammatePrivateAttachment(id);
  }

  listTeammatePrivateAttachments(options: ListTeammatePrivateAttachmentsOptions): TeammatePrivateAttachment[] {
    return this.teammateDirect.listTeammatePrivateAttachments(options);
  }

  deleteTeammatePrivateAttachment(id: string): boolean {
    return this.teammateDirect.deleteTeammatePrivateAttachment(id);
  }

  createChannelMessage(input: CreateChannelMessageInput, now: string): ChannelMessage {
    return this.channelMessages.createChannelMessage(input, now);
  }

  updateChannelMessageRuntime(
    id: string,
    input: {
      readonly body?: string;
      readonly status?: ChannelMessage["status"];
      readonly errorMessage?: string | null;
      readonly linkedRunId?: string | null;
    },
    now: string,
  ): ChannelMessage | undefined {
    return this.channelMessages.updateChannelMessageRuntime(id, input, now);
  }

  getChannelMessage(id: string): ChannelMessage | undefined {
    return this.channelMessages.getChannelMessage(id);
  }

  listChannelMessages(options: ListChannelMessagesOptions): ChannelMessage[] {
    return this.channelMessages.listChannelMessages(options);
  }

  listChannelMessagesPage(options: ListChannelMessagesOptions): ChannelMessageListPage {
    return this.channelMessages.listChannelMessagesPage(options);
  }

  createChannelMessageRouteDecision(input: CreateChannelMessageRouteDecisionInput, now: string): ChannelMessageRouteDecision {
    return this.channelRouteDecisions.createChannelMessageRouteDecision(input, now);
  }

  getChannelMessageRouteDecision(id: string): ChannelMessageRouteDecision | undefined {
    return this.channelRouteDecisions.getChannelMessageRouteDecision(id);
  }

  listChannelMessageRouteDecisions(options: ListChannelMessageRouteDecisionsOptions = {}): ChannelMessageRouteDecision[] {
    return this.channelRouteDecisions.listChannelMessageRouteDecisions(options);
  }

  updateChannelMessageRouteDecision(
    id: string,
    input: UpdateChannelMessageRouteDecisionInput,
    now: string,
  ): ChannelMessageRouteDecision | undefined {
    return this.channelRouteDecisions.updateChannelMessageRouteDecision(id, input, now);
  }

  createChannelIntentDecision(input: CreateChannelIntentDecisionInput, now: string): ChannelIntentDecision {
    return this.channelIntentDecisions.createChannelIntentDecision(input, now);
  }

  getChannelIntentDecision(id: string): ChannelIntentDecision | undefined {
    return this.channelIntentDecisions.getChannelIntentDecision(id);
  }

  listChannelIntentDecisions(options: ListChannelIntentDecisionsOptions = {}): ChannelIntentDecision[] {
    return this.channelIntentDecisions.listChannelIntentDecisions(options);
  }

  createChannelExecutionProposal(input: CreateChannelExecutionProposalInput, now: string): ChannelExecutionProposal {
    return this.channelProposals.createChannelExecutionProposal(input, now);
  }

  getChannelExecutionProposal(id: string): ChannelExecutionProposal | undefined {
    return this.channelProposals.getChannelExecutionProposal(id);
  }

  listChannelExecutionProposals(options: ListChannelExecutionProposalsOptions): ChannelExecutionProposal[] {
    return this.channelProposals.listChannelExecutionProposals(options);
  }

  updateChannelExecutionProposal(
    id: string,
    input: UpdateChannelExecutionProposalInput,
    now: string,
  ): ChannelExecutionProposal | undefined {
    return this.channelProposals.updateChannelExecutionProposal(id, input, now);
  }

  createChannelAttachment(input: CreateChannelAttachmentInput): ChannelAttachment {
    return this.channelAssets.createChannelAttachment(input);
  }

  getChannelAttachment(id: string): ChannelAttachment | undefined {
    return this.channelAssets.getChannelAttachment(id);
  }

  listChannelAttachments(options: ListChannelAttachmentsOptions): ChannelAttachment[] {
    return this.channelAssets.listChannelAttachments(options);
  }

  deleteChannelAttachment(id: string): boolean {
    return this.channelAssets.deleteChannelAttachment(id);
  }

  createConversationAttachment(input: CreateConversationAttachmentInput): ConversationAttachment {
    return this.conversationAssets.createConversationAttachment(input);
  }

  getConversationAttachment(id: string): ConversationAttachment | undefined {
    return this.conversationAssets.getConversationAttachment(id);
  }

  listConversationAttachments(options: ListConversationAttachmentsOptions): ConversationAttachment[] {
    return this.conversationAssets.listConversationAttachments(options);
  }

  assignConversationAttachment(input: AssignConversationAttachmentInput): ConversationAttachment | undefined {
    return this.conversationAssets.assignConversationAttachment(input);
  }

  deleteConversationAttachment(id: string): boolean {
    return this.conversationAssets.deleteConversationAttachment(id);
  }

  createChannelLinkPreview(input: CreateChannelLinkPreviewInput, now: string): ChannelLinkPreview {
    return this.channelAssets.createChannelLinkPreview(input, now);
  }

  getChannelLinkPreview(id: string): ChannelLinkPreview | undefined {
    return this.channelAssets.getChannelLinkPreview(id);
  }

  listChannelLinkPreviews(options: ListChannelLinkPreviewsOptions): ChannelLinkPreview[] {
    return this.channelAssets.listChannelLinkPreviews(options);
  }

  updateChannelLinkPreview(id: string, input: UpdateChannelLinkPreviewInput, now: string): ChannelLinkPreview | undefined {
    return this.channelAssets.updateChannelLinkPreview(id, input, now);
  }

  createChannelInputMaterialization(input: CreateChannelInputMaterializationInput, now: string): ChannelInputMaterialization {
    return this.channelAssets.createChannelInputMaterialization(input, now);
  }

  getChannelInputMaterialization(id: string): ChannelInputMaterialization | undefined {
    return this.channelAssets.getChannelInputMaterialization(id);
  }

  listChannelInputMaterializations(options: ListChannelInputMaterializationsOptions): ChannelInputMaterialization[] {
    return this.channelAssets.listChannelInputMaterializations(options);
  }

  getChannelBrief(channelId: string): ChannelBrief | undefined {
    return this.channelCollaborations.getChannelBrief(channelId);
  }

  updateChannelBrief(channelId: string, input: UpdateChannelBriefInput, now: string): ChannelBrief {
    return this.channelCollaborations.updateChannelBrief(channelId, input, now);
  }

  createChannelDecision(input: CreateChannelDecisionInput, now: string): ChannelDecision {
    return this.channelCollaborations.createChannelDecision(input, now);
  }

  getChannelDecision(id: string): ChannelDecision | undefined {
    return this.channelCollaborations.getChannelDecision(id);
  }

  listChannelDecisions(options: ListChannelDecisionsOptions): ChannelDecision[] {
    return this.channelCollaborations.listChannelDecisions(options);
  }

  updateChannelDecision(id: string, input: UpdateChannelDecisionInput, now: string): ChannelDecision | undefined {
    return this.channelCollaborations.updateChannelDecision(id, input, now);
  }

  createChannelHandoff(input: CreateChannelHandoffInput, now: string): ChannelHandoff {
    return this.channelCollaborations.createChannelHandoff(input, now);
  }

  getChannelHandoff(id: string): ChannelHandoff | undefined {
    return this.channelCollaborations.getChannelHandoff(id);
  }

  listChannelHandoffs(options: ListChannelHandoffsOptions): ChannelHandoff[] {
    return this.channelCollaborations.listChannelHandoffs(options);
  }

  updateChannelHandoff(id: string, input: UpdateChannelHandoffInput, now: string): ChannelHandoff | undefined {
    return this.channelCollaborations.updateChannelHandoff(id, input, now);
  }

  createWorkflowHandoffIntent(input: CreateWorkflowHandoffIntentInput, now: string): WorkflowHandoffIntent {
    return this.channelWorkflows.createWorkflowHandoffIntent(input, now);
  }

  getWorkflowHandoffIntent(id: string): WorkflowHandoffIntent | undefined {
    return this.channelWorkflows.getWorkflowHandoffIntent(id);
  }

  listWorkflowHandoffIntents(options: ListWorkflowHandoffIntentsOptions = {}): WorkflowHandoffIntent[] {
    return this.channelWorkflows.listWorkflowHandoffIntents(options);
  }

  updateWorkflowHandoffIntent(id: string, input: UpdateWorkflowHandoffIntentInput, now: string): WorkflowHandoffIntent | undefined {
    return this.channelWorkflows.updateWorkflowHandoffIntent(id, input, now);
  }

  createWorkflowSelectorDecision(input: CreateWorkflowSelectorDecisionInput, now: string): WorkflowSelectorDecision {
    return this.channelWorkflows.createWorkflowSelectorDecision(input, now);
  }

  getWorkflowSelectorDecision(id: string): WorkflowSelectorDecision | undefined {
    return this.channelWorkflows.getWorkflowSelectorDecision(id);
  }

  listWorkflowSelectorDecisions(options: ListWorkflowSelectorDecisionsOptions = {}): WorkflowSelectorDecision[] {
    return this.channelWorkflows.listWorkflowSelectorDecisions(options);
  }

  updateWorkflowSelectorDecision(id: string, input: UpdateWorkflowSelectorDecisionInput, now: string): WorkflowSelectorDecision | undefined {
    return this.channelWorkflows.updateWorkflowSelectorDecision(id, input, now);
  }

  createChannelContextSummary(input: CreateChannelContextSummaryInput, now: string): ChannelContextSummary {
    return this.channelCollaborations.createChannelContextSummary(input, now);
  }

  getChannelContextSummary(id: string): ChannelContextSummary | undefined {
    return this.channelCollaborations.getChannelContextSummary(id);
  }

  listChannelContextSummaries(options: ListChannelContextSummariesOptions): ChannelContextSummary[] {
    return this.channelCollaborations.listChannelContextSummaries(options);
  }

  updateChannelContextSummary(
    id: string,
    input: UpdateChannelContextSummaryInput,
    now: string,
  ): ChannelContextSummary | undefined {
    return this.channelCollaborations.updateChannelContextSummary(id, input, now);
  }

  getChannelCollaborationProtocolOverride(channelId: string): ChannelCollaborationProtocolOverride | undefined {
    return this.channelProtocols.getChannelCollaborationProtocolOverride(channelId);
  }

  upsertChannelCollaborationProtocolOverride(
    input: UpsertChannelCollaborationProtocolOverrideInput,
    now: string,
  ): ChannelCollaborationProtocolOverride {
    return this.channelProtocols.upsertChannelCollaborationProtocolOverride(input, now);
  }

  deleteChannelCollaborationProtocolOverride(channelId: string): boolean {
    return this.channelProtocols.deleteChannelCollaborationProtocolOverride(channelId);
  }

  createChannelCollaborationProtocolDraft(input: CreateChannelCollaborationProtocolDraftInput, now: string): ChannelCollaborationProtocolDraft {
    return this.channelProtocols.createChannelCollaborationProtocolDraft(input, now);
  }

  getChannelCollaborationProtocolDraft(id: string): ChannelCollaborationProtocolDraft | undefined {
    return this.channelProtocols.getChannelCollaborationProtocolDraft(id);
  }

  listChannelCollaborationProtocolDrafts(options: {
    readonly channelId: string;
    readonly status?: ChannelProtocolDraftStatus;
    readonly limit?: number;
  }): ChannelCollaborationProtocolDraft[] {
    return this.channelProtocols.listChannelCollaborationProtocolDrafts(options);
  }

  updateChannelCollaborationProtocolDraft(
    id: string,
    input: { readonly status?: ChannelProtocolDraftStatus; readonly appliedProtocolVersion?: number | null },
    now: string,
  ): ChannelCollaborationProtocolDraft | undefined {
    return this.channelProtocols.updateChannelCollaborationProtocolDraft(id, input, now);
  }

  createChannelPlaybookCandidate(input: CreateChannelPlaybookCandidateInput, now: string): ChannelPlaybookCandidate {
    return this.channelPlaybooks.createChannelPlaybookCandidate(input, now);
  }

  getChannelPlaybookCandidate(id: string): ChannelPlaybookCandidate | undefined {
    return this.channelPlaybooks.getChannelPlaybookCandidate(id);
  }

  listChannelPlaybookCandidates(options: {
    readonly channelId: string;
    readonly status?: ChannelPlaybookCandidateStatus;
    readonly limit?: number;
  }): ChannelPlaybookCandidate[] {
    return this.channelPlaybooks.listChannelPlaybookCandidates(options);
  }

  updateChannelPlaybookCandidate(
    id: string,
    input: UpdateChannelPlaybookCandidateInput,
    now: string,
  ): ChannelPlaybookCandidate | undefined {
    return this.channelPlaybooks.updateChannelPlaybookCandidate(id, input, now);
  }

  createChannelWorkflow(input: CreateChannelWorkflowInput, now: string): ChannelWorkflow {
    return this.channelWorkflows.createChannelWorkflow(input, now);
  }

  getChannelWorkflow(id: string): ChannelWorkflow | undefined {
    return this.channelWorkflows.getChannelWorkflow(id);
  }

  listChannelWorkflows(options: ListChannelWorkflowsOptions): ChannelWorkflow[] {
    return this.channelWorkflows.listChannelWorkflows(options);
  }

  updateChannelWorkflow(id: string, input: UpdateChannelWorkflowInput, now: string): ChannelWorkflow | undefined {
    return this.channelWorkflows.updateChannelWorkflow(id, input, now);
  }

  transitionChannelWorkflowStatus(input: {
    readonly workflowId: string;
    readonly expectedStatus?: ChannelWorkflowStatus;
    readonly event: WorkflowTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
  }): TransitionResult<ChannelWorkflowStatus> {
    return this.channelWorkflows.transitionChannelWorkflowStatus(input);
  }

  createChannelWorkflowStep(input: CreateChannelWorkflowStepInput, now: string): ChannelWorkflowStep {
    return this.channelWorkflows.createChannelWorkflowStep(input, now);
  }

  getChannelWorkflowStep(id: string): ChannelWorkflowStep | undefined {
    return this.channelWorkflows.getChannelWorkflowStep(id);
  }

  listChannelWorkflowSteps(options: ListChannelWorkflowStepsOptions): ChannelWorkflowStep[] {
    return this.channelWorkflows.listChannelWorkflowSteps(options);
  }

  updateChannelWorkflowStep(
    id: string,
    input: UpdateChannelWorkflowStepInput,
    now: string,
  ): ChannelWorkflowStep | undefined {
    return this.channelWorkflows.updateChannelWorkflowStep(id, input, now);
  }

  transitionChannelWorkflowStepStatus(input: {
    readonly workflowStepId: string;
    readonly expectedStatus?: ChannelWorkflowStepStatus;
    readonly event: WorkflowStepTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly taskId?: string | null;
    readonly runId?: string | null;
    readonly blocker?: string | null;
    readonly resultSummary?: string | null;
  }): TransitionResult<ChannelWorkflowStepStatus> {
    return this.channelWorkflows.transitionChannelWorkflowStepStatus(input);
  }

  createOrReuseExternalWorkWorkflow(input: CreateExternalWorkWorkflowInput, now: string): ExternalWorkWorkflowResult {
    return this.externalWorkWorkflows.createOrReuseExternalWorkWorkflow(input, now);
  }

  getExternalWorkRecord(id: string): ExternalWorkRecord | undefined {
    return this.externalWork.getExternalWorkRecord(id);
  }

  listExternalWorkRecords(options: ListExternalWorkRecordsOptions = {}): ExternalWorkRecord[] {
    return this.externalWork.listExternalWorkRecords(options);
  }

  countExternalWorkRecords(options: Omit<ListExternalWorkRecordsOptions, "limit"> = {}): number {
    return this.externalWork.countExternalWorkRecords(options);
  }

  getExternalWorkRecordByIdempotency(sourceKind: ExternalWorkRecord["sourceKind"], idempotencyKey: string): ExternalWorkRecord | undefined {
    return this.externalWork.getExternalWorkRecordByIdempotency(sourceKind, idempotencyKey);
  }

  updateExternalWorkArtifacts(id: string, artifactIds: readonly string[], now: string): ExternalWorkRecord | undefined {
    return this.externalWork.updateExternalWorkArtifacts(id, artifactIds, now);
  }

  routeExternalWorkRecord(id: string, input: ExternalWorkRouteRequest, now: string): ExternalWorkRecord | undefined {
    return this.externalWork.routeExternalWorkRecord(id, input, now);
  }

  createExternalWorkAction(input: CreateExternalWorkActionInput, now: string): ExternalWorkAction {
    return this.externalWorkActions.createExternalWorkAction(input, now);
  }

  getExternalWorkAction(id: string): ExternalWorkAction | undefined {
    return this.externalWorkActions.getExternalWorkAction(id);
  }

  getExternalWorkActionByIdempotency(sourceKind: ExternalWorkAction["sourceKind"], idempotencyKey: string): ExternalWorkAction | undefined {
    return this.externalWorkActions.getExternalWorkActionByIdempotency(sourceKind, idempotencyKey);
  }

  listExternalWorkActions(options: ListExternalWorkActionsOptions = {}): ExternalWorkAction[] {
    return this.externalWorkActions.listExternalWorkActions(options);
  }

  countExternalWorkActions(options: Omit<ListExternalWorkActionsOptions, "limit"> = {}): number {
    return this.externalWorkActions.countExternalWorkActions(options);
  }

  updateExternalWorkAction(id: string, input: UpdateExternalWorkActionInput, now: string): ExternalWorkAction | undefined {
    return this.externalWorkActions.updateExternalWorkAction(id, input, now);
  }

  createExternalWorkCiTriage(input: CreateExternalWorkCiTriageInput, now: string): ExternalWorkCiTriageRecord {
    return this.externalWorkCiTriage.createExternalWorkCiTriage(input, now);
  }

  getExternalWorkCiTriage(id: string): ExternalWorkCiTriageRecord | undefined {
    return this.externalWorkCiTriage.getExternalWorkCiTriage(id);
  }

  getExternalWorkCiTriageByFailureKey(
    sourceKind: ExternalWorkCiTriageRecord["sourceKind"],
    failureKey: string,
  ): ExternalWorkCiTriageRecord | undefined {
    return this.externalWorkCiTriage.getExternalWorkCiTriageByFailureKey(sourceKind, failureKey);
  }

  listExternalWorkCiTriage(options: ListExternalWorkCiTriageOptions = {}): ExternalWorkCiTriageRecord[] {
    return this.externalWorkCiTriage.listExternalWorkCiTriage(options);
  }

  countExternalWorkCiTriage(options: Omit<ListExternalWorkCiTriageOptions, "limit"> = {}): number {
    return this.externalWorkCiTriage.countExternalWorkCiTriage(options);
  }

  updateExternalWorkCiTriage(
    id: string,
    input: UpdateExternalWorkCiTriageInput,
    now: string,
  ): ExternalWorkCiTriageRecord | undefined {
    return this.externalWorkCiTriage.updateExternalWorkCiTriage(id, input, now);
  }

  upsertExternalWorkSchedulerState(input: UpsertExternalWorkSchedulerStateInput, now: string): ExternalWorkSchedulerState {
    return this.externalWorkScheduler.upsertExternalWorkSchedulerState(input, now);
  }

  getExternalWorkSchedulerState(externalWorkId: string): ExternalWorkSchedulerState | undefined {
    return this.externalWorkScheduler.getExternalWorkSchedulerState(externalWorkId);
  }

  findActiveExternalWorkSchedulerState(sourceKey: string, subjectKey: string): ExternalWorkSchedulerState | undefined {
    return this.externalWorkScheduler.findActiveExternalWorkSchedulerState(sourceKey, subjectKey);
  }

  listExternalWorkSchedulerStates(options: ListExternalWorkSchedulerStatesOptions = {}): ExternalWorkSchedulerState[] {
    return this.externalWorkScheduler.listExternalWorkSchedulerStates(options);
  }

  updateExternalWorkSchedulerState(
    externalWorkId: string,
    input: UpdateExternalWorkSchedulerStateInput,
    now: string,
  ): ExternalWorkSchedulerState | undefined {
    return this.externalWorkScheduler.updateExternalWorkSchedulerState(externalWorkId, input, now);
  }

  upsertWorkItem(input: UpsertWorkItemInput, now: string): WorkItem {
    return this.workItems.upsertWorkItem(input, now);
  }

  getWorkItem(id: string): WorkItem | undefined {
    return this.workItems.getWorkItem(id);
  }

  listWorkItems(options: ListWorkItemsOptions = {}, now?: string): WorkItem[] {
    return this.workItems.listWorkItems(options, now);
  }

  routeWorkItem(id: string, input: WorkItemRouteRequest, now: string): WorkItem | undefined {
    return this.workItems.routeWorkItem(id, input, now);
  }

  claimWorkItem(
    id: string,
    input: WorkItemClaimRequest,
    now: string,
  ): { readonly workItem: WorkItem; readonly claimToken?: string; readonly blocker?: WorkItemClaimBlocker } | undefined {
    return this.workItems.claimWorkItem(id, input, now);
  }

  heartbeatWorkItem(id: string, input: WorkItemHeartbeatRequest, now: string): WorkItem | undefined {
    return this.workItems.heartbeatWorkItem(id, input, now);
  }

  releaseWorkItem(id: string, input: WorkItemReleaseRequest, now: string): WorkItem | undefined {
    return this.workItems.releaseWorkItem(id, input, now);
  }

  completeWorkItem(id: string, input: WorkItemCompleteRequest, now: string): WorkItem | undefined {
    return this.workItems.completeWorkItem(id, input, now);
  }

  failWorkItem(id: string, input: WorkItemFailRequest, now: string): WorkItem | undefined {
    return this.workItems.failWorkItem(id, input, now);
  }

  createProviderPreset(input: ProviderPresetInput, now: string): ProviderPreset {
    return this.providers.createProviderPreset(input, now);
  }

  getProviderPreset(id: string): ProviderPreset | undefined {
    return this.providers.getProviderPreset(id);
  }

  listProviderPresets(options: ListProviderPresetsOptions = {}): ProviderPreset[] {
    return this.providers.listProviderPresets(options);
  }

  updateProviderPreset(id: string, input: ProviderPresetUpdateInput, now: string): ProviderPreset | undefined {
    return this.providers.updateProviderPreset(id, input, now);
  }

  recordProviderCheckResult(id: string, result: ProviderCheckResult): ProviderPreset | undefined {
    return this.providers.recordProviderCheckResult(id, result);
  }

  deleteProviderPreset(id: string): boolean {
    return this.providers.deleteProviderPreset(id);
  }

  setProviderSecret(providerId: string, secretValue: string, now: string): void {
    this.providers.setProviderSecret(providerId, secretValue, now);
  }

  getProviderSecret(providerId: string): string | undefined {
    return this.providers.getProviderSecret(providerId);
  }

  hasProviderSecret(providerId: string): boolean {
    return this.providers.hasProviderSecret(providerId);
  }

  deleteProviderSecret(providerId: string): boolean {
    return this.providers.deleteProviderSecret(providerId);
  }

  createMcpServer(input: CreateMcpServerInput, now: string): McpServer {
    return this.mcps.createMcpServer(input, now);
  }

  getMcpServer(id: string): McpServer | undefined {
    return this.mcps.getMcpServer(id);
  }

  listMcpServers(options: ListMcpServersOptions = {}): McpServer[] {
    return this.mcps.listMcpServers(options);
  }

  updateMcpServer(id: string, input: UpdateMcpServerInput, now: string): McpServer | undefined {
    return this.mcps.updateMcpServer(id, input, now);
  }

  updateMcpServerStatus(id: string, status: McpServerStatus, now: string): McpServer | undefined {
    return this.mcps.updateMcpServerStatus(id, status, now);
  }

  upsertMcpStatusSnapshot(snapshot: McpRuntimeStatusSnapshot, now: string): McpRuntimeStatusSnapshot {
    return this.mcps.upsertMcpStatusSnapshot(snapshot, now);
  }

  getMcpStatusSnapshot(serverId: string, now?: string): McpRuntimeStatusSnapshot | undefined {
    return this.mcps.getMcpStatusSnapshot(serverId, now);
  }

  deleteMcpStatusSnapshot(serverId: string): boolean {
    return this.mcps.deleteMcpStatusSnapshot(serverId);
  }

  countLegacyMcpServerSecrets(serverId?: string): number {
    return this.mcps.countLegacyMcpServerSecrets(serverId);
  }

  listLegacyMcpServerSecretNames(serverId: string): readonly string[] {
    return this.mcps.listLegacyMcpServerSecretNames(serverId);
  }

  deleteMcpServer(id: string): boolean {
    return this.mcps.deleteMcpServer(id);
  }

  setMcpServerSecret(serverId: string, secretName: string, secretValue: string, now: string): void {
    this.mcps.setMcpServerSecret(serverId, secretName, secretValue, now);
  }

  getMcpServerSecret(serverId: string, secretName: string): string | undefined {
    return this.mcps.getMcpServerSecret(serverId, secretName);
  }

  hasMcpServerSecret(serverId: string, secretName: string): boolean {
    return this.mcps.hasMcpServerSecret(serverId, secretName);
  }

  deleteMcpServerSecret(serverId: string, secretName: string): boolean {
    return this.mcps.deleteMcpServerSecret(serverId, secretName);
  }

  replaceMcpServerTools(serverId: string, tools: readonly ReplaceMcpServerToolInput[], now: string): McpTool[] {
    return this.mcps.replaceMcpServerTools(serverId, tools, now);
  }

  listMcpTools(options: ListMcpToolsOptions = {}): McpTool[] {
    return this.mcps.listMcpTools(options);
  }

  replaceTeammateMcpBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateMcpBindingInput[],
    now: string,
  ): TeammateMcpBinding[] {
    return this.mcps.replaceTeammateMcpBindings(teammateId, bindings, now);
  }

  listTeammateMcpBindings(teammateId: string): TeammateMcpBinding[] {
    return this.mcps.listTeammateMcpBindings(teammateId);
  }

  createAutomationDefinition(input: CreateAutomationDefinitionInput, now: string): AutomationDefinition {
    return this.automations.createAutomationDefinition(input, now);
  }

  getAutomationDefinition(automationId: string): AutomationDefinition | undefined {
    return this.automations.getAutomationDefinition(automationId);
  }

  listAutomationDefinitions(options: ListAutomationDefinitionsOptions = {}): AutomationDefinition[] {
    return this.automations.listAutomationDefinitions(options);
  }

  updateAutomationDefinition(
    automationId: string,
    input: UpdateAutomationDefinitionInput,
    now: string,
  ): AutomationDefinition | undefined {
    return this.automations.updateAutomationDefinition(automationId, input, now);
  }

  archiveAutomationDefinition(automationId: string, now: string): AutomationDefinition | undefined {
    return this.automations.archiveAutomationDefinition(automationId, now);
  }

  createAutomationDraft(input: CreateAutomationDraftInput, now: string): AutomationDraft {
    return this.automations.createAutomationDraft(input, now);
  }

  getAutomationDraft(draftId: string): AutomationDraft | undefined {
    return this.automations.getAutomationDraft(draftId);
  }

  listAutomationDrafts(options: ListAutomationDraftsOptions = {}): AutomationDraft[] {
    return this.automations.listAutomationDrafts(options);
  }

  updateAutomationDraft(draftId: string, input: UpdateAutomationDraftInput, now: string): AutomationDraft | undefined {
    return this.automations.updateAutomationDraft(draftId, input, now);
  }

  discardAutomationDraft(draftId: string, now: string): AutomationDraft | undefined {
    return this.automations.discardAutomationDraft(draftId, now);
  }

  confirmAutomationDraft(draftId: string, automationId: string, now: string): AutomationDraft | undefined {
    return this.automations.confirmAutomationDraft(draftId, automationId, now);
  }

  createAutomationRun(input: CreateAutomationRunInput, now: string): AutomationRun {
    return this.automations.createAutomationRun(input, now);
  }

  getAutomationRun(automationRunId: string): AutomationRun | undefined {
    return this.automations.getAutomationRun(automationRunId);
  }

  findAutomationRunByIdempotencyKey(idempotencyKey: string): AutomationRun | undefined {
    return this.automations.findAutomationRunByIdempotencyKey(idempotencyKey);
  }

  listAutomationRuns(options: ListAutomationRunsOptions = {}): AutomationRun[] {
    return this.automations.listAutomationRuns(options);
  }

  updateAutomationRun(automationRunId: string, input: UpdateAutomationRunInput, now: string): AutomationRun | undefined {
    return this.automations.updateAutomationRun(automationRunId, input, now);
  }

  listManagedPlugins(options: ListManagedPluginsOptions = {}): ManagedPluginRecord[] {
    return this.managedPlugins.listManagedPlugins(options);
  }

  getManagedPlugin(pluginId: string): ManagedPluginRecord | undefined {
    return this.managedPlugins.getManagedPlugin(pluginId);
  }

  upsertManagedPlugin(input: UpsertManagedPluginInput, now: string): ManagedPluginRecord {
    return this.managedPlugins.upsertManagedPlugin(input, now);
  }

  updateManagedPlugin(pluginId: string, input: UpdateManagedPluginInput, now: string): ManagedPluginRecord | undefined {
    return this.managedPlugins.updateManagedPlugin(pluginId, input, now);
  }

  replaceManagedPluginContributions(
    pluginId: string,
    contributions: readonly UpsertManagedPluginContributionInput[],
    now: string,
  ): ManagedPluginContributionRecord[] {
    return this.managedPlugins.replaceManagedPluginContributions(pluginId, contributions, now);
  }

  listManagedPluginContributions(pluginId?: string): ManagedPluginContributionRecord[] {
    return this.managedPlugins.listManagedPluginContributions(pluginId);
  }

  upsertManagedPluginHealthSnapshot(snapshot: ManagedPluginHealthSnapshot, now: string): ManagedPluginHealthSnapshot {
    return this.managedPlugins.upsertManagedPluginHealthSnapshot(snapshot, now);
  }

  getManagedPluginHealthSnapshot(pluginId: string, now?: string): ManagedPluginHealthSnapshot | undefined {
    return this.managedPlugins.getManagedPluginHealthSnapshot(pluginId, now);
  }

  appendManagedPluginEvent(input: CreateManagedPluginEventInput, now: string): ManagedPluginEvent {
    return this.managedPlugins.appendManagedPluginEvent(input, now);
  }

  listManagedPluginEvents(options: ListManagedPluginEventsOptions = {}): ManagedPluginEvent[] {
    return this.managedPlugins.listManagedPluginEvents(options);
  }

  upsertManagedPluginPackage(input: UpsertManagedPluginPackageInput, now: string): ManagedPluginPackageRecord {
    return this.managedPlugins.upsertManagedPluginPackage(input, now);
  }

  markManagedPluginPackageUninstalled(pluginId: string, now: string): ManagedPluginPackageRecord | undefined {
    return this.managedPlugins.markManagedPluginPackageUninstalled(pluginId, now);
  }

  getManagedPluginPackage(pluginId: string): ManagedPluginPackageRecord | undefined {
    return this.managedPlugins.getManagedPluginPackage(pluginId);
  }

  listManagedPluginPackages(options: { readonly status?: ManagedPluginPackageRecord["status"] } = {}): ManagedPluginPackageRecord[] {
    return this.managedPlugins.listManagedPluginPackages(options);
  }

  createManagedPluginRuntimeSnapshot(input: CreateManagedPluginRuntimeSnapshotInput): ManagedPluginRuntimeSnapshot {
    return this.managedPlugins.createManagedPluginRuntimeSnapshot(input);
  }

  getManagedPluginRuntimeSnapshot(id: string): ManagedPluginRuntimeSnapshot | undefined {
    return this.managedPlugins.getManagedPluginRuntimeSnapshot(id);
  }

  getManagedPluginRuntimeSnapshotForRun(runId: string): ManagedPluginRuntimeSnapshot | undefined {
    return this.managedPlugins.getManagedPluginRuntimeSnapshotForRun(runId);
  }

  createMediaJob(input: CreateMediaJobInput, now: string): MediaJob {
    return this.mediaJobs.createMediaJob(input, now);
  }

  getMediaJob(id: string): MediaJob | undefined {
    return this.mediaJobs.getMediaJob(id);
  }

  listMediaJobs(options: ListMediaJobsOptions = {}): MediaJob[] {
    return this.mediaJobs.listMediaJobs(options);
  }

  updateMediaJobStatus(id: string, input: UpdateMediaJobStatusInput, now: string): MediaJob | undefined {
    return this.mediaJobs.updateMediaJobStatus(id, input, now);
  }

  createMediaProject(input: CreateMediaProjectInput, now: string): MediaProject {
    return this.mediaJobs.createMediaProject(input, now);
  }

  getMediaProject(id: string): MediaProject | undefined {
    return this.mediaJobs.getMediaProject(id);
  }

  listMediaProjects(): MediaProject[] {
    return this.mediaJobs.listMediaProjects();
  }

  updateMediaProject(id: string, input: UpdateMediaProjectInput, now: string): MediaProject | undefined {
    return this.mediaJobs.updateMediaProject(id, input, now);
  }

  deleteMediaProject(id: string): boolean {
    return this.mediaJobs.deleteMediaProject(id);
  }

  createMediaScene(input: CreateMediaSceneInput, now: string): MediaScene {
    return this.mediaJobs.createMediaScene(input, now);
  }

  getMediaScene(id: string): MediaScene | undefined {
    return this.mediaJobs.getMediaScene(id);
  }

  listMediaScenes(projectId: string): MediaScene[] {
    return this.mediaJobs.listMediaScenes(projectId);
  }

  updateMediaScene(id: string, input: UpdateMediaSceneInput, now: string): MediaScene | undefined {
    return this.mediaJobs.updateMediaScene(id, input, now);
  }

  reorderMediaScenes(projectId: string, sceneIds: readonly string[], now: string): MediaScene[] {
    return this.mediaJobs.reorderMediaScenes(projectId, sceneIds, now);
  }

  deleteMediaScene(id: string): boolean {
    return this.mediaJobs.deleteMediaScene(id);
  }

  createMediaSceneRun(input: CreateMediaSceneRunInput, now: string): MediaSceneRun {
    return this.mediaJobs.createMediaSceneRun(input, now);
  }

  listMediaSceneRuns(options: { readonly projectId?: string; readonly sceneId?: string }): MediaSceneRun[] {
    return this.mediaJobs.listMediaSceneRuns(options);
  }

  getMediaSceneRun(id: string): MediaSceneRun | undefined {
    return this.mediaJobs.getMediaSceneRun(id);
  }

  getMediaSceneRunByMediaJobId(mediaJobId: string): MediaSceneRun | undefined {
    return this.mediaJobs.getMediaSceneRunByMediaJobId(mediaJobId);
  }

  upsertMediaJobExecutionHandle(input: UpsertMediaJobExecutionHandleInput, now: string): MediaJobExecutionHandle {
    return this.mediaJobs.upsertMediaJobExecutionHandle(input, now);
  }

  getMediaJobExecutionHandle(mediaJobId: string): MediaJobExecutionHandle | undefined {
    return this.mediaJobs.getMediaJobExecutionHandle(mediaJobId);
  }

  listMediaJobExecutionHandles(): MediaJobExecutionHandle[] {
    return this.mediaJobs.listMediaJobExecutionHandles();
  }

  deleteMediaJobExecutionHandle(mediaJobId: string): boolean {
    return this.mediaJobs.deleteMediaJobExecutionHandle(mediaJobId);
  }

  createMediaWorkflowConnection(input: CreateMediaWorkflowConnectionInput, now: string): MediaWorkflowConnection {
    return this.mediaWorkflows.createConnection(input, now);
  }

  getMediaWorkflowConnection(id: string): MediaWorkflowConnection | undefined {
    return this.mediaWorkflows.getConnection(id);
  }

  listMediaWorkflowConnections(): MediaWorkflowConnection[] {
    return this.mediaWorkflows.listConnections();
  }

  updateMediaWorkflowConnection(id: string, input: UpdateMediaWorkflowConnectionInput, now: string): MediaWorkflowConnection | undefined {
    return this.mediaWorkflows.updateConnection(id, input, now);
  }

  deleteMediaWorkflowConnection(id: string): boolean {
    return this.mediaWorkflows.deleteConnection(id);
  }

  createMediaWorkflowDefinition(input: CreateMediaWorkflowDefinitionInput, now: string): MediaWorkflowDefinition {
    return this.mediaWorkflows.createDefinition(input, now);
  }

  getMediaWorkflowDefinition(id: string): MediaWorkflowDefinition | undefined {
    return this.mediaWorkflows.getDefinition(id);
  }

  listMediaWorkflowDefinitions(options: ListMediaWorkflowDefinitionsOptions = {}): MediaWorkflowDefinition[] {
    return this.mediaWorkflows.listDefinitions(options);
  }

  updateMediaWorkflowDefinition(id: string, input: UpdateMediaWorkflowDefinitionInput, now: string): MediaWorkflowDefinition | undefined {
    return this.mediaWorkflows.updateDefinition(id, input, now);
  }

  deleteMediaWorkflowDefinition(id: string): boolean {
    return this.mediaWorkflows.deleteDefinition(id);
  }

  createMediaWorkflowVersion(input: CreateMediaWorkflowVersionInput, now: string): MediaWorkflowVersion {
    return this.mediaWorkflows.createVersion(input, now);
  }

  getMediaWorkflowVersion(id: string): MediaWorkflowVersion | undefined {
    return this.mediaWorkflows.getVersion(id);
  }

  listMediaWorkflowVersions(workflowDefinitionId: string): MediaWorkflowVersion[] {
    return this.mediaWorkflows.listVersions(workflowDefinitionId);
  }

  setMediaWorkflowVersionTestJob(id: string, mediaJobId: string): MediaWorkflowVersion | undefined {
    return this.mediaWorkflows.setVersionTestJob(id, mediaJobId);
  }

  createApprovalRequest(input: CreateApprovalRequestInput, now: string): ApprovalRequest {
    return this.approvalRequests.createApprovalRequest(input, now);
  }

  getApprovalRequest(id: string): ApprovalRequest | undefined {
    return this.approvalRequests.getApprovalRequest(id);
  }

  listApprovalRequests(options: ListApprovalRequestsOptions = {}): ApprovalRequest[] {
    return this.approvalRequests.listApprovalRequests(options);
  }

  approveApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.approvalRequests.approveApprovalRequest(id, input, now);
  }

  denyApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.approvalRequests.denyApprovalRequest(id, input, now);
  }

  expireApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.approvalRequests.expireApprovalRequest(id, input, now);
  }

  cancelApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.approvalRequests.cancelApprovalRequest(id, input, now);
  }

  createApprovalCheckpoint(input: CreateApprovalCheckpointInput, now: string): LingApprovalCheckpoint {
    return this.approvalCheckpoints.createApprovalCheckpoint(input, now);
  }

  getApprovalCheckpoint(id: string): LingApprovalCheckpoint | undefined {
    return this.approvalCheckpoints.getApprovalCheckpoint(id);
  }

  getApprovalCheckpointForApproval(approvalId: string): LingApprovalCheckpoint | undefined {
    return this.approvalCheckpoints.getApprovalCheckpointForApproval(approvalId);
  }

  listApprovalCheckpoints(options: ListApprovalCheckpointsOptions = {}): LingApprovalCheckpoint[] {
    return this.approvalCheckpoints.listApprovalCheckpoints(options);
  }

  updateApprovalCheckpointStatus(
    id: string,
    input: UpdateApprovalCheckpointStatusInput,
    now: string,
  ): LingApprovalCheckpoint | undefined {
    return this.approvalCheckpoints.updateApprovalCheckpointStatus(id, input, now);
  }

  getApprovalPolicy(): ApprovalPolicy {
    return this.approvalPolicies.getApprovalPolicy();
  }

  updateApprovalPolicy(input: ApprovalPolicyUpdateInput, now: string): ApprovalPolicy {
    return this.approvalPolicies.updateApprovalPolicy(input, now);
  }

  close(): void {
    if (this.database.isOpen) {
      this.database.close();
    }
  }

  private ensureDefaultWorkspace(): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO workspaces (id, name, default_provider_preset_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `)
      .run(DEFAULT_WORKSPACE_ID, "Default Workspace", null, now, now);
  }

  private ensureDefaultAiTeammates(): void {
    this.teammateBootstrap.ensureDefaultAiTeammates();
    this.aiCouncils.ensureBuiltinDevelopmentCouncil(new Date().toISOString());
  }

  private hasMigration(version: number): boolean {
    return Boolean(this.database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version));
  }

  private hasColumn(tableName: string, columnName: string): boolean {
    return this.database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .some((row) => readString(row, "name") === columnName);
  }

  private hasTable(tableName: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName),
    );
  }

  private recordMigration(version: number, name: string): void {
    this.database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, name, new Date().toISOString());
  }

  private assertChannelExists(channelId: string): void {
    this.channelReferences.assertChannelExists(channelId);
  }

  private assertMessageInChannel(channelId: string, messageId: string): void {
    this.channelReferences.assertMessageInChannel(channelId, messageId);
  }

  private assertAttachmentInChannel(channelId: string, attachmentId: string): void {
    this.channelReferences.assertAttachmentInChannel(channelId, attachmentId);
  }

  private assertLinkPreviewInChannel(channelId: string, linkPreviewId: string): void {
    this.channelReferences.assertLinkPreviewInChannel(channelId, linkPreviewId);
  }

  private assertTaskInChannel(channelId: string, taskId: string): void {
    this.channelReferences.assertTaskInChannel(channelId, taskId);
  }

  private assertRunInChannel(channelId: string, runId: string): void {
    this.channelReferences.assertRunInChannel(channelId, runId);
  }

  private assertWorkflowInChannel(channelId: string, workflowId: string): void {
    this.channelReferences.assertWorkflowInChannel(channelId, workflowId);
  }

  private assertProposalInChannel(channelId: string, proposalId: string): void {
    this.channelReferences.assertProposalInChannel(channelId, proposalId);
  }

  private assertWorkflowStepInChannel(channelId: string, workflowStepId: string): void {
    this.channelReferences.assertWorkflowStepInChannel(channelId, workflowStepId);
  }

  private assertDecisionInChannel(channelId: string, decisionId: string): void {
    this.channelReferences.assertDecisionInChannel(channelId, decisionId);
  }

  private assertHandoffInChannel(channelId: string, handoffId: string): void {
    this.channelReferences.assertHandoffInChannel(channelId, handoffId);
  }

  private assertWorkflowHandoffIntentInChannel(channelId: string, intentId: string): void {
    this.channelReferences.assertWorkflowHandoffIntentInChannel(channelId, intentId);
  }

  private assertWorkflowSelectorDecisionInChannel(channelId: string, decisionId: string): void {
    this.channelReferences.assertWorkflowSelectorDecisionInChannel(channelId, decisionId);
  }

  private assertContextSummaryInChannel(channelId: string, contextSummaryId: string): void {
    this.channelReferences.assertContextSummaryInChannel(channelId, contextSummaryId);
  }

  private assertSourceRefsInChannel(
    channelId: string,
    input: { readonly sourceMessageId?: string; readonly sourceTaskId?: string; readonly sourceRunId?: string },
  ): void {
    this.channelReferences.assertSourceRefsInChannel(channelId, input);
  }

  private assertWorkflowCoordinationRefsInChannel(
    channelId: string,
    refs: {
      readonly workflowId?: string;
      readonly workflowStepId?: string;
      readonly runId?: string;
      readonly messageId?: string;
      readonly handoffId?: string;
    },
  ): void {
    this.channelReferences.assertWorkflowCoordinationRefsInChannel(channelId, refs);
  }

  private ensureLingAgentChannelMemberships(now: string, channelId?: string): void {
    this.teammateBootstrap.ensureLingAgentChannelMemberships(now, channelId);
  }

  private ensureDefaultTeammateMemoryScopesForAll(now: string): void {
    this.teammateBootstrap.ensureDefaultTeammateMemoryScopesForAll(now);
  }

  private ensureDefaultTeammateMemoryScopes(teammateId: string, now: string): void {
    this.teammateBootstrap.ensureDefaultTeammateMemoryScopes(teammateId, now);
  }

  private assertWorkflowSelectorTargetsInChannel(
    channelId: string,
    input: Pick<CreateWorkflowSelectorDecisionInput, "workflowId" | "selectedWorkflowStepId" | "selectedTeammateId" | "selectedHandoffIntentId">,
  ): void {
    this.channelReferences.assertWorkflowSelectorTargetsInChannel(channelId, input);
  }

  private assertWorkflowPacketSourceRefsInChannel(channelId: string, sourceRefs: readonly WorkflowPacketSourceRef[]): void {
    this.channelReferences.assertWorkflowPacketSourceRefsInChannel(channelId, sourceRefs);
  }

  private assertChannelProtocolSourceRefsInChannel(channelId: string, sourceRefs: readonly ChannelProtocolSourceRef[]): void {
    this.channelReferences.assertChannelProtocolSourceRefsInChannel(channelId, sourceRefs);
  }

  private tryRebuildLingThreadMetadata(threadId: string | undefined, now: string): void {
    this.lingThreadMetadata.tryRebuildLingThreadMetadata(threadId, now);
  }

  private tryRebuildLingThreadMetadataForRun(runId: string | undefined, now: string): void {
    this.lingThreadMetadata.tryRebuildLingThreadMetadataForRun(runId, now);
  }

  private tryRebuildLingThreadMetadataForTurn(turnId: string | undefined, now: string): void {
    this.lingThreadMetadata.tryRebuildLingThreadMetadataForTurn(turnId, now);
  }

  private tryRebuildLingThreadMetadataForApproval(approval: ApprovalRequest | undefined, now: string): void {
    this.lingThreadMetadata.tryRebuildLingThreadMetadataForApproval(approval, now);
  }

}

export function createSqliteRunStore(cwd: string, paths?: LingStackRuntimePaths): SqliteRunStore {
  return new SqliteRunStore({ cwd, paths });
}

function normalizeOptionalOwnerId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
