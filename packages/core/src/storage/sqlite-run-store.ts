import { existsSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
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
import {
  type ApprovalPolicy,
  type ApprovalPolicyUpdateInput,
  type RunTool,
} from "../approval-policy.js";
import {
  DEFAULT_WORKSPACE_ID,
  LING_AGENT_ID,
  LING_AGENT_SYSTEM_PROMPT,
  createBuiltinAiTeammateId,
  createLingAgentSystemTeammate,
  lingAgentAllowedTools,
  type AiTeammate,
  type AiTeammateUpdateInput,
  type Channel,
  type ChannelAttachment,
  type ChannelBrief,
  type ChannelBranch,
  type ChannelBranchUpdateInput,
  type ChannelCollaborationProtocolDraft,
  type ChannelCollaborationProtocolOverride,
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
  type ChannelUpdateInput,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepStatus,
  type ChannelWorkflowStatus,
  type CreateAiTeammateInput,
  type CreateChannelAttachmentInput,
  type CreateChannelBranchInput,
  type CreateChannelCollaborationProtocolDraftInput,
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
  type CreateWorkflowHandoffIntentInput,
  type CreateWorkflowSelectorDecisionInput,
  type CreateTeammateDirectLinkPreviewInput,
  type CreateTeammateDirectMessageInput,
  type CreateTeammateDirectReplyInterventionInput,
  type CreateTeammatePrivateAttachmentInput,
  type CreateTaskInput,
  type DirectWorkspaceBinding,
  type HardDeleteAiTeammateInput,
  type HardDeleteAiTeammateResult,
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
  type ListWorkflowHandoffIntentsOptions,
  type ListWorkflowSelectorDecisionsOptions,
  type ListTeammateDirectLinkPreviewsOptions,
  type ListTeammateDirectMessagesOptions,
  type ListTeammateDirectReplyInterventionsOptions,
  type ListTeammatePrivateAttachmentsOptions,
  type ListTasksOptions,
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
  type UpdateChannelContextSummaryInput,
  type UpdateChannelDecisionInput,
  type UpdateChannelExecutionProposalInput,
  type UpdateChannelMessageRouteDecisionInput,
  type UpdateChannelHandoffInput,
  type UpdateChannelLinkPreviewInput,
  type UpdateTeammateDirectReplyInterventionStatusInput,
  type UpdateChannelWorkflowInput,
  type UpdateChannelWorkflowStepInput,
  type UpdateWorkflowHandoffIntentInput,
  type UpdateWorkflowSelectorDecisionInput,
  type UpdateWorkspaceSettingsInput,
  type UpsertChannelCollaborationProtocolOverrideInput,
  type WorkspaceSettings,
  type WorkflowHandoffIntent,
  type WorkflowPacketSourceRef,
  type WorkflowSelectorDecision,
} from "../workspace-types.js";
import { GSTACK_DEFAULT_SKILL_PACK_ID, listDefaultTeammateTemplates } from "../builtin-skill-packs.js";
import {
  type AiTeammateTemplate,
  type CreateSkillImportDraftInput,
  type ListSkillRegistryOptions,
  type SkillImportDraft,
  type SkillRegistryEntry,
} from "../skill-types.js";
import {
  createLingThreadId,
  createLingTurnId,
  type AppendControlPlaneEventInput,
  type ControlPlaneEvent,
  type CreateLingThreadInput,
  type CreateLingTurnInput,
  type CreateRunArtifactInput,
  type CreateRunInterventionInput,
  type CreateRunInput,
  type LinkRunToLingTurnInput,
  type LingThread,
  type LingThreadSearchField,
  type LingThreadSearchMatch,
  type LingThreadKind,
  type LingThreadMetadata,
  type LingThreadStatus,
  type LingTurn,
  type LingTurnKind,
  type LingTurnRun,
  type LingTurnRunRole,
  type LingTurnStatus,
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
  type SearchLingThreadsResult,
  type UpdateLingThreadInput,
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
  createExternalWorkId,
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
  type CreateMediaJobInput,
  type ListMediaJobsOptions,
  type MediaJob,
  type UpdateMediaJobStatusInput,
} from "../media-types.js";
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
  stringifyJson,
} from "./sqlite/helpers.js";
import { SqliteAutomationStore } from "./sqlite/automation-store.js";
import { SqliteProviderStore } from "./sqlite/provider-store.js";
import { SqliteMcpStore } from "./sqlite/mcp-store.js";
import { SqliteManagedPluginStore } from "./sqlite/managed-plugin-store.js";
import { SqliteMediaStore } from "./sqlite/media-store.js";
import { SqliteApprovalPolicyStore } from "./sqlite/approval-policy-store.js";
import { SqliteApprovalRequestStore } from "./sqlite/approval-request-store.js";
import { SqliteArtifactStore } from "./sqlite/artifact-store.js";
import { SqliteControlPlaneStore } from "./sqlite/control-plane-store.js";
import { SqliteRunEventStore } from "./sqlite/run-event-store.js";
import { SqliteRunInterventionStore } from "./sqlite/run-intervention-store.js";
import { SqliteRunSessionStore } from "./sqlite/run-session-store.js";
import { SqliteStateTransitionStore } from "./sqlite/state-transition-store.js";
import { SqliteResourceLeaseStore } from "./sqlite/resource-lease-store.js";
import { SqliteRuntimeSemaphoreStore } from "./sqlite/runtime-semaphore-store.js";
import { SqliteRuntimeRecoveryCoordinator } from "./sqlite/runtime-recovery-coordinator.js";
import { SqliteRuntimeWorkUnitStore } from "./sqlite/runtime-work-unit-store.js";
import { SqliteWorkspaceSettingsStore } from "./sqlite/workspace-settings-store.js";
import { SqliteSkillRegistryStore } from "./sqlite/skill-registry-store.js";
import { SqliteTaskStore } from "./sqlite/task-store.js";
import { SqliteTeammateDirectStore } from "./sqlite/teammate-direct-store.js";
import { SqliteTeammateAssociationStore } from "./sqlite/teammate-association-store.js";
import { SqliteTeammateCoreStore, applyLingAgentProtectedFields } from "./sqlite/teammate-core-store.js";
import { SqliteTeammateCleanupStore } from "./sqlite/teammate-cleanup-store.js";
import { SqliteMemoryConsolidationStore } from "./sqlite/memory-consolidation-store.js";
import { SqliteMemoryObjectStore } from "./sqlite/memory-object-store.js";
import { SqliteMemoryReviewStore } from "./sqlite/memory-review-store.js";
import { SqliteMemoryRetrievalStore } from "./sqlite/memory-retrieval-store.js";
import { SqliteChannelMessageStore } from "./sqlite/channel-message-store.js";
import { SqliteChannelRouteDecisionStore } from "./sqlite/channel-route-decision-store.js";
import { SqliteChannelIntentDecisionStore } from "./sqlite/channel-intent-decision-store.js";
import { SqliteChannelProposalStore } from "./sqlite/channel-proposal-store.js";
import { SqliteChannelAssetStore } from "./sqlite/channel-asset-store.js";
import { SqliteChannelCollaborationStore } from "./sqlite/channel-collaboration-store.js";
import { SqliteChannelProtocolStore } from "./sqlite/channel-protocol-store.js";
import { SqliteChannelWorkflowStore } from "./sqlite/channel-workflow-store.js";
import { SqliteChannelCoreStore } from "./sqlite/channel-core-store.js";
import { SqliteExternalWorkStore } from "./sqlite/external-work-store.js";
import { SqliteExternalWorkActionStore } from "./sqlite/external-work-action-store.js";
import { SqliteExternalWorkCiTriageStore } from "./sqlite/external-work-ci-triage-store.js";
import { SqliteExternalWorkSchedulerStore } from "./sqlite/external-work-scheduler-store.js";
import { SqliteWorkItemStore } from "./sqlite/work-item-store.js";
import {
  mapLingThread,
  mapLingTurn,
  mapLingTurnRun,
  runActivityAt,
  runStatusToLingTurnStatus,
} from "./sqlite/run-mappers.js";
import {
  lingThreadSelectSql,
  lingTurnSelectSql,
} from "./sqlite/select-sql.js";

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
  private readonly approvalPolicies: SqliteApprovalPolicyStore;
  private readonly approvalRequests: SqliteApprovalRequestStore;
  private readonly artifacts: SqliteArtifactStore;
  private readonly controlPlane: SqliteControlPlaneStore;
  private readonly runEvents: SqliteRunEventStore;
  private readonly runInterventions: SqliteRunInterventionStore;
  private readonly runSessions: SqliteRunSessionStore;
  private readonly stateTransitions: SqliteStateTransitionStore;
  private readonly resourceLeases: SqliteResourceLeaseStore;
  private readonly runtimeSemaphores: SqliteRuntimeSemaphoreStore;
  private readonly runtimeRecovery: SqliteRuntimeRecoveryCoordinator;
  private readonly runtimeWorkUnits: SqliteRuntimeWorkUnitStore;
  private readonly workspaceSettings: SqliteWorkspaceSettingsStore;
  private readonly skillRegistry: SqliteSkillRegistryStore;
  private readonly tasks: SqliteTaskStore;
  private readonly teammateDirect: SqliteTeammateDirectStore;
  private readonly teammateAssociations: SqliteTeammateAssociationStore;
  private readonly aiTeammates: SqliteTeammateCoreStore;
  private readonly teammateCleanup: SqliteTeammateCleanupStore;
  private readonly memoryConsolidation: SqliteMemoryConsolidationStore;
  private readonly memoryObjects: SqliteMemoryObjectStore;
  private readonly memoryReviews: SqliteMemoryReviewStore;
  private readonly memoryRetrieval: SqliteMemoryRetrievalStore;
  private readonly channelMessages: SqliteChannelMessageStore;
  private readonly channelRouteDecisions: SqliteChannelRouteDecisionStore;
  private readonly channelIntentDecisions: SqliteChannelIntentDecisionStore;
  private readonly channelProposals: SqliteChannelProposalStore;
  private readonly channelAssets: SqliteChannelAssetStore;
  private readonly channelCollaborations: SqliteChannelCollaborationStore;
  private readonly channelProtocols: SqliteChannelProtocolStore;
  private readonly channelWorkflows: SqliteChannelWorkflowStore;
  private readonly channelCore: SqliteChannelCoreStore;
  private readonly externalWork: SqliteExternalWorkStore;
  private readonly externalWorkActions: SqliteExternalWorkActionStore;
  private readonly externalWorkCiTriage: SqliteExternalWorkCiTriageStore;
  private readonly externalWorkScheduler: SqliteExternalWorkSchedulerStore;
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
    this.approvalPolicies = new SqliteApprovalPolicyStore({ database: this.database });
    this.approvalRequests = new SqliteApprovalRequestStore(
      { database: this.database },
      {
        hasRun: (id) => Boolean(this.getRun(id)),
        hasMediaJob: (id) => Boolean(this.getMediaJob(id)),
        hasExternalWorkAction: (id) => Boolean(this.getExternalWorkAction(id)),
        hasWorkflowStep: (id) => Boolean(this.getChannelWorkflowStep(id)),
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
    this.runSessions = new SqliteRunSessionStore(
      { database: this.database },
      this.paths,
      {
        insertLingTurnRun: (turnId, runId, role, createdAt) => this.insertLingTurnRun(turnId, runId, role, createdAt),
        reconcileLingTurnStatus: (turnId, now) => this.reconcileLingTurnStatus(turnId, now),
        rebuildLingThreadMetadata: (threadId, now) => this.tryRebuildLingThreadMetadata(threadId, now),
        findStateTransitionByIdempotency: (entityType, entityId, idempotencyKey) =>
          this.findStateTransitionByIdempotency(entityType, entityId, idempotencyKey),
        recordStateTransitionEvent: (input) => this.recordStateTransitionEvent(input),
        reconcileLingTurnStatusForRun: (runId, now) => this.reconcileLingTurnStatusForRun(runId, now),
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
      transitionChannelWorkflowStepStatus: (input) => this.transitionChannelWorkflowStepStatus(input),
      getChannelWorkflow: (workflowId) => this.getChannelWorkflow(workflowId),
      transitionChannelWorkflowStatus: (input) => this.transitionChannelWorkflowStatus(input),
    });
    this.workspaceSettings = new SqliteWorkspaceSettingsStore({ database: this.database });
    this.skillRegistry = new SqliteSkillRegistryStore({ database: this.database });
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
    const id = input.id ?? createLingThreadId();
    this.database
      .prepare(`
        INSERT INTO ling_threads (
          id,
          workspace_id,
          kind,
          channel_id,
          task_id,
          teammate_id,
          workflow_id,
          workflow_step_id,
          external_work_id,
          title,
          objective,
          status,
          active_run_id,
          last_run_id,
          parent_thread_id,
          parent_turn_id,
          forked_from_run_id,
          metadata_json,
          created_at,
          updated_at,
          pinned_at,
          archived_at,
          archived_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        DEFAULT_WORKSPACE_ID,
        input.kind,
        input.channelId ?? null,
        input.taskId ?? null,
        input.teammateId ?? null,
        input.workflowId ?? null,
        input.workflowStepId ?? null,
        input.externalWorkId ?? null,
        input.title,
        input.objective,
        input.status ?? "open",
        input.activeRunId ?? null,
        input.lastRunId ?? null,
        input.parentThreadId ?? null,
        input.parentTurnId ?? null,
        input.forkedFromRunId ?? null,
        null,
        now,
        now,
        input.pinnedAt ?? null,
        input.archivedAt ?? null,
        input.archivedReason ?? null,
      );
    this.tryRebuildLingThreadMetadata(id, now);
    const thread = this.getLingThread(id);
    if (!thread) {
      throw new Error(`Failed to create Ling thread: ${id}`);
    }
    return thread;
  }

  getLingThread(threadId: string): LingThread | undefined {
    const row = this.database.prepare(lingThreadSelectSql("WHERE id = ?")).get(threadId);
    return row ? mapLingThread(row) : undefined;
  }

  findLingThreadByOwner(input: {
    readonly kind: LingThreadKind;
    readonly taskId?: string;
    readonly workflowStepId?: string;
    readonly externalWorkId?: string;
    readonly teammateId?: string;
    readonly channelId?: string;
  }): LingThread | undefined {
    const clauses = ["workspace_id = ?", "kind = ?"];
    const params: string[] = [DEFAULT_WORKSPACE_ID, input.kind];
    appendNullableOwnerClause(clauses, params, "task_id", input.taskId);
    appendNullableOwnerClause(clauses, params, "workflow_step_id", input.workflowStepId);
    appendNullableOwnerClause(clauses, params, "external_work_id", input.externalWorkId);
    appendNullableOwnerClause(clauses, params, "teammate_id", input.teammateId);
    appendNullableOwnerClause(clauses, params, "channel_id", input.channelId);
    const row = this.database.prepare(`${lingThreadSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC LIMIT 1`).get(...params);
    return row ? mapLingThread(row) : undefined;
  }

  listLingThreads(options: ListLingThreadsOptions = {}): LingThread[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.taskId) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.workflowStepId) {
      clauses.push("workflow_step_id = ?");
      params.push(options.workflowStepId);
    }
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const archivedFilter = options.archived ?? (options.includeArchived || options.status ? "include" : "exclude");
    if (archivedFilter === "exclude") {
      clauses.push("(archived_at IS NULL AND status != 'archived')");
    } else if (archivedFilter === "only") {
      clauses.push("(archived_at IS NOT NULL OR status = 'archived')");
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${lingThreadSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY pinned_at IS NULL ASC, pinned_at DESC, updated_at DESC LIMIT ?`)
      .all(...params)
      .map(mapLingThread);
  }

  searchLingThreads(options: ListLingThreadsOptions & { readonly q: string }): SearchLingThreadsResult {
    const query = normalizeLingThreadSearchQuery(options.q);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const candidates = this.listLingThreads({
      ...options,
      limit: 500,
    });
    if (candidates.length === 0) {
      return { threads: [], matches: [] };
    }
    const matchesByThreadId = new Map<string, LingThreadSearchMatch[]>();
    const threadIds = new Set(candidates.map((thread) => thread.id));

    for (const thread of candidates) {
      addLingThreadSearchMatch(matchesByThreadId, thread, "thread_title", thread.title, query);
      addLingThreadSearchMatch(matchesByThreadId, thread, "thread_objective", thread.objective, query);
      addLingThreadSearchMatch(matchesByThreadId, thread, "task_id", thread.taskId, query);
      addLingThreadSearchMatch(matchesByThreadId, thread, "task_id", thread.workflowStepId, query);
      addLingThreadSearchMatch(matchesByThreadId, thread, "task_id", thread.externalWorkId, query);
      addLingThreadSearchMatch(matchesByThreadId, thread, "metadata_summary", thread.metadata?.summary, query);
    }

    const threadIdPlaceholders = [...threadIds].map(() => "?").join(", ");
    const turnRows = this.database
      .prepare(`
        SELECT id, thread_id, title, user_instruction, task_id, source_turn_id
        FROM ling_turns
        WHERE thread_id IN (${threadIdPlaceholders})
        ORDER BY updated_at DESC, id DESC
        LIMIT 5000
      `)
      .all(...threadIds);
    for (const row of turnRows) {
      const threadId = readString(row, "thread_id");
      if (!threadIds.has(threadId)) {
        continue;
      }
      const turnId = readString(row, "id");
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "turn_title", readNullableString(row, "title"), query, { turnId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "turn_instruction", readNullableString(row, "user_instruction"), query, { turnId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_id", readNullableString(row, "task_id"), query, { turnId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_id", readNullableString(row, "source_turn_id"), query, { turnId });
    }

    const runRows = this.database
      .prepare(`
        SELECT id, thread_id, task_id, task_snapshot_json, summary_path
        FROM run_sessions
        WHERE thread_id IN (${threadIdPlaceholders})
        ORDER BY updated_at DESC, id DESC
        LIMIT 5000
      `)
      .all(...threadIds);
    for (const row of runRows) {
      const threadId = readNullableString(row, "thread_id");
      if (!threadId || !threadIds.has(threadId)) {
        continue;
      }
      const runId = readString(row, "id");
      const taskSnapshot = parseNullableSearchJsonObject(readString(row, "task_snapshot_json"));
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_id", readNullableString(row, "task_id"), query, { runId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_title", readOptionalSearchString(taskSnapshot, "title"), query, { runId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_prompt", readOptionalSearchString(taskSnapshot, "prompt"), query, { runId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_title", basenameSearchValue(readNullableString(row, "summary_path")), query, { runId });
    }

    const matchedThreads = candidates
      .filter((thread) => (matchesByThreadId.get(thread.id)?.length ?? 0) > 0)
      .sort((left, right) =>
        bestLingThreadSearchRank(left, matchesByThreadId.get(left.id) ?? [], query) -
        bestLingThreadSearchRank(right, matchesByThreadId.get(right.id) ?? [], query) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.id.localeCompare(left.id)
      )
      .slice(0, limit);
    const visibleThreadIds = new Set(matchedThreads.map((thread) => thread.id));
    const matches = matchedThreads.flatMap((thread) =>
      (matchesByThreadId.get(thread.id) ?? [])
        .slice(0, 5)
        .filter((match) => visibleThreadIds.has(match.threadId))
    );
    return { threads: matchedThreads, matches };
  }

  updateLingThread(threadId: string, input: UpdateLingThreadInput, now: string): LingThread | undefined {
    const existing = this.getLingThread(threadId);
    if (!existing) {
      return undefined;
    }
    const next: LingThread = {
      ...existing,
      title: input.title ?? existing.title,
      objective: input.objective ?? existing.objective,
      status: input.status ?? existing.status,
      activeRunId: nullableUpdate(input.activeRunId, existing.activeRunId),
      lastRunId: nullableUpdate(input.lastRunId, existing.lastRunId),
      pinnedAt: nullableUpdate(input.pinnedAt, existing.pinnedAt),
      archivedAt: nullableUpdate(input.archivedAt, existing.archivedAt),
      archivedReason: nullableUpdate(input.archivedReason, existing.archivedReason),
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE ling_threads
        SET title = ?,
            objective = ?,
            status = ?,
            active_run_id = ?,
            last_run_id = ?,
            updated_at = ?,
            pinned_at = ?,
            archived_at = ?,
            archived_reason = ?
        WHERE id = ?
      `)
      .run(
        next.title,
        next.objective,
        next.status,
        next.activeRunId ?? null,
        next.lastRunId ?? null,
        next.updatedAt,
        next.pinnedAt ?? null,
        next.archivedAt ?? null,
        next.archivedReason ?? null,
        threadId,
      );
    this.tryRebuildLingThreadMetadata(threadId, now);
    return this.getLingThread(threadId);
  }

  rebuildLingThreadMetadata(threadId: string, now: string): LingThread | undefined {
    const thread = this.getLingThread(threadId);
    if (!thread) {
      return undefined;
    }
    const runs = this.listRuns({ threadId, limit: 200 });
    const turns = this.listLingTurns({ threadId, limit: 500 });
    const approvalsById = new Map<string, ApprovalRequest>();
    for (const run of runs) {
      for (const approval of this.listApprovalRequests({ runId: run.id, limit: 500 })) {
        approvalsById.set(approval.id, approval);
      }
    }
    if (thread.workflowStepId) {
      for (const approval of this.listApprovalRequests({ workflowStepId: thread.workflowStepId, limit: 500 })) {
        approvalsById.set(approval.id, approval);
      }
    }
    const approvals = [...approvalsById.values()];
    const artifacts = runs.flatMap((run) => this.listArtifacts(run.id));
    const latestTurn = [...turns].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
    const latestFailedRun = runs
      .filter((run) => run.status === "failed")
      .sort((left, right) => compareIsoDesc(runActivityAt(left), runActivityAt(right)) || right.id.localeCompare(left.id))[0];
    const latestArtifact = [...artifacts]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    const activityTimestamps = [
      thread.createdAt,
      thread.updatedAt,
      thread.archivedAt,
      ...turns.flatMap((turn) => [turn.createdAt, turn.updatedAt, turn.completedAt]),
      ...runs.flatMap((run) => [run.createdAt, run.startedAt, run.endedAt, run.updatedAt]),
      ...approvals.flatMap((approval) => [approval.createdAt, approval.resolvedAt]),
      ...artifacts.map((artifact) => artifact.createdAt),
      this.readLatestRunActionActivityAt(runs.map((run) => run.id)),
    ];
    const metadata: LingThreadMetadata = omitUndefined({
      schemaVersion: 1 as const,
      summary: summarizeLingThreadForMetadata(thread, latestTurn),
      pinnedAt: thread.pinnedAt,
      lastTurnId: latestTurn?.id,
      lastActivityAt: maxIsoTimestamp(activityTimestamps),
      pendingApprovalCount: approvals.filter((approval) => approval.status === "pending").length,
      blockedCount: (thread.status === "blocked" ? 1 : 0) + turns.filter((turn) => turn.status === "blocked").length,
      failedAttemptCount: runs.filter((run) => run.status === "failed").length,
      artifactCount: artifacts.length,
      latestFailureRunId: latestFailedRun?.id,
      latestEvidenceArtifactId: latestArtifact?.id,
      rebuiltAt: now,
    });
    this.database
      .prepare("UPDATE ling_threads SET metadata_json = ? WHERE id = ?")
      .run(stringifyJson(metadata), threadId);
    return this.getLingThread(threadId);
  }

  rebuildLingThreadMetadataForRun(runId: string, now: string): LingThread | undefined {
    const run = this.getRun(runId);
    return run?.threadId ? this.rebuildLingThreadMetadata(run.threadId, now) : undefined;
  }

  createLingTurn(input: CreateLingTurnInput, now: string): LingTurn {
    const thread = this.getLingThread(input.threadId);
    if (!thread) {
      throw new Error(`Ling thread not found: ${input.threadId}`);
    }
    if (thread.status === "archived") {
      throw new Error(`Ling thread is archived: ${input.threadId}`);
    }
    if (input.sourceTurnId) {
      const sourceTurn = this.getLingTurn(input.sourceTurnId);
      if (!sourceTurn) {
        throw new Error(`Source Ling turn not found: ${input.sourceTurnId}`);
      }
      if (sourceTurn.threadId !== input.threadId) {
        throw new Error(`Source Ling turn does not belong to thread: ${input.sourceTurnId}`);
      }
    }
    if (input.activeRunId) {
      this.assertLingTurnRunReference(input.activeRunId, input.threadId, "activeRunId");
    }
    if (input.lastRunId) {
      this.assertLingTurnRunReference(input.lastRunId, input.threadId, "lastRunId");
    }

    const id = input.id ?? createLingTurnId();
    this.database
      .prepare(`
        INSERT INTO ling_turns (
          id,
          workspace_id,
          thread_id,
          kind,
          status,
          title,
          user_instruction,
          channel_id,
          task_id,
          teammate_id,
          workflow_step_id,
          external_work_id,
          automation_id,
          source_message_id,
          source_turn_id,
          intervention_id,
          active_run_id,
          last_run_id,
          created_by_actor,
          created_at,
          updated_at,
          completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        DEFAULT_WORKSPACE_ID,
        input.threadId,
        input.kind,
        input.status ?? "open",
        String(redactSecrets(input.title)),
        String(redactSecrets(input.userInstruction)),
        input.channelId ?? thread.channelId ?? null,
        input.taskId ?? thread.taskId ?? null,
        input.teammateId ?? thread.teammateId ?? null,
        input.workflowStepId ?? thread.workflowStepId ?? null,
        input.externalWorkId ?? thread.externalWorkId ?? null,
        input.automationId ?? null,
        input.sourceMessageId ?? null,
        input.sourceTurnId ?? null,
        input.interventionId ?? null,
        input.activeRunId ?? null,
        input.lastRunId ?? null,
        input.createdByActor ?? "local-user",
        now,
        now,
        null,
      );
    const turn = this.getLingTurn(id);
    if (!turn) {
      throw new Error(`Failed to create Ling turn: ${id}`);
    }
    this.tryRebuildLingThreadMetadata(input.threadId, now);
    return turn;
  }

  getLingTurn(turnId: string): LingTurn | undefined {
    const row = this.database.prepare(lingTurnSelectSql("WHERE id = ?")).get(turnId);
    return row ? mapLingTurn(row) : undefined;
  }

  listLingTurns(options: ListLingTurnsOptions): LingTurn[] {
    const clauses = ["workspace_id = ?", "thread_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.threadId];
    if (options.beforeUpdatedAt) {
      clauses.push("updated_at < ?");
      params.push(options.beforeUpdatedAt);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${lingTurnSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapLingTurn);
  }

  linkRunToLingTurn(input: LinkRunToLingTurnInput): LingTurnRun {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const link = this.insertLingTurnRun(input.turnId, input.runId, input.role ?? "primary", input.now);
      this.reconcileLingTurnStatus(input.turnId, input.now);
      this.database.exec("COMMIT");
      this.tryRebuildLingThreadMetadataForTurn(input.turnId, input.now);
      return link;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getLingTurnForRun(runId: string): LingTurn | undefined {
    const row = this.database
      .prepare(`
        ${lingTurnSelectSql("INNER JOIN ling_turn_runs ON ling_turn_runs.turn_id = ling_turns.id WHERE ling_turn_runs.run_id = ?")}
      `)
      .get(runId);
    return row ? mapLingTurn(row) : undefined;
  }

  listLingTurnRuns(turnId: string): LingTurnRun[] {
    return this.database
      .prepare(`
        SELECT turn_id, run_id, attempt_number, role, created_at
        FROM ling_turn_runs
        WHERE turn_id = ?
        ORDER BY attempt_number ASC, created_at ASC, run_id ASC
      `)
      .all(turnId)
      .map(mapLingTurnRun);
  }

  reconcileLingTurnStatus(turnId: string, now: string): LingTurn | undefined {
    const turn = this.getLingTurn(turnId);
    if (!turn) {
      return undefined;
    }
    const links = this.listLingTurnRuns(turnId);
    const runs = links
      .map((link) => ({ link, run: this.getRun(link.runId) }))
      .filter((item): item is { readonly link: LingTurnRun; readonly run: RunSession } => Boolean(item.run));
    const latest = [...runs]
      .sort((left, right) =>
        right.link.attemptNumber - left.link.attemptNumber ||
        right.run.updatedAt.localeCompare(left.run.updatedAt) ||
        right.run.id.localeCompare(left.run.id),
      )[0];
    const latestWaiting = [...runs]
      .filter((item) => item.run.status === "waiting_for_approval")
      .sort((left, right) =>
        right.link.attemptNumber - left.link.attemptNumber ||
        right.run.updatedAt.localeCompare(left.run.updatedAt) ||
        right.run.id.localeCompare(left.run.id),
      )[0];
    const latestActive = latestWaiting ?? [...runs]
      .filter((item) => item.run.status === "queued" || item.run.status === "running")
      .sort((left, right) =>
        right.link.attemptNumber - left.link.attemptNumber ||
        right.run.updatedAt.localeCompare(left.run.updatedAt) ||
        right.run.id.localeCompare(left.run.id),
      )[0];
    const nextStatus: LingTurnStatus = turn.status === "superseded"
      ? "superseded"
      : latestWaiting
        ? "waiting_for_approval"
        : latestActive
          ? "running"
          : latest
            ? runStatusToLingTurnStatus(latest.run.status)
            : "open";
    const terminal = nextStatus === "succeeded" || nextStatus === "failed" || nextStatus === "cancelled" || nextStatus === "superseded";
    this.database
      .prepare(`
        UPDATE ling_turns
        SET status = ?,
            active_run_id = ?,
            last_run_id = ?,
            updated_at = ?,
            completed_at = ?
        WHERE id = ?
      `)
      .run(
        nextStatus,
        latestActive?.run.id ?? null,
        latest?.run.id ?? null,
        now,
        terminal ? (turn.completedAt ?? now) : null,
        turnId,
      );
    this.tryRebuildLingThreadMetadata(turn.threadId, now);
    return this.getLingTurn(turnId);
  }

  createRun(input: CreateRunInput): RunSession {
    return this.runSessions.createRun(input);
  }

  markRunStarted(runId: string, startedAt: string): void {
    this.runSessions.markRunStarted(runId, startedAt);
  }

  markRunWaitingForApproval(runId: string, updatedAt: string): void {
    this.runSessions.markRunWaitingForApproval(runId, updatedAt);
  }

  markRunRunning(runId: string, updatedAt: string): void {
    this.runSessions.markRunRunning(runId, updatedAt);
  }

  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): void {
    this.runSessions.markRunSucceeded(runId, endedAt, summaryPath);
  }

  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): void {
    this.runSessions.markRunFailed(runId, endedAt, errorMessage, summaryPath);
  }

  markRunCancelled(runId: string, endedAt: string, summaryPath?: string): void {
    this.runSessions.markRunCancelled(runId, endedAt, summaryPath);
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
    return this.runSessions.transitionRunStatus(input);
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

  createSkillImportDraft(input: CreateSkillImportDraftInput, now: string): SkillImportDraft {
    return this.skillRegistry.createSkillImportDraft(input, now);
  }

  getSkillImportDraft(id: string): SkillImportDraft | undefined {
    return this.skillRegistry.getSkillImportDraft(id);
  }

  publishSkillImportDraft(id: string, now: string): SkillRegistryEntry[] {
    return this.skillRegistry.publishSkillImportDraft(id, now);
  }

  archiveSkillRegistryEntry(id: string, now: string): SkillRegistryEntry | undefined {
    return this.skillRegistry.archiveSkillRegistryEntry(id, now);
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
    this.assertChannelExists(input.channelId);
    const existing = this.getExternalWorkRecordByIdempotency(input.externalWorkItem.sourceKind, input.externalWorkItem.idempotencyKey);
    if (existing) {
      const workflow = this.getChannelWorkflow(existing.workflowId);
      const workflowStep = this.getChannelWorkflowStep(existing.workflowStepId);
      if (!workflow || !workflowStep) {
        throw new Error(`External work mapping points to missing workflow state: ${existing.id}`);
      }
      return {
        externalWork: existing,
        workflow,
        workflowStep,
        duplicate: true,
      };
    }

    const channel = this.getChannel(input.channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const participantId = input.toParticipantId ?? channel.defaultTeammateId ?? input.workflowDefinition.config.agent.teammateId ?? "engineer";
    const participantLabel = input.toParticipantLabel ?? labelForParticipant(participantId);
    const workflow = this.createChannelWorkflow(
      {
        channelId: input.channelId,
        title: `External work: ${input.externalWorkItem.identifier}`,
        objective: `Handle ${input.externalWorkItem.kind} ${input.externalWorkItem.identifier}: ${input.externalWorkItem.title}`,
        status: "ready",
        createdBy: `${input.externalWorkItem.sourceKind}:external-work`,
      },
      now,
    );
    const workflowStep = this.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        title: `Review ${input.externalWorkItem.identifier}`,
        prompt: input.renderedPrompt,
        toParticipantId: participantId,
        toParticipantLabel: participantLabel,
      },
      now,
    );
    const record: ExternalWorkRecord = {
      id: createExternalWorkId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceKind: input.externalWorkItem.sourceKind,
      workItemKind: input.externalWorkItem.kind,
      externalId: input.externalWorkItem.id,
      identifier: input.externalWorkItem.identifier,
      idempotencyKey: input.externalWorkItem.idempotencyKey,
      workflowId: workflow.id,
      workflowStepId: workflowStep.id,
      artifactIds: [],
      item: input.externalWorkItem,
      createdAt: now,
      updatedAt: now,
    };

    const created = this.externalWork.createExternalWorkRecord(record);
    return {
      externalWork: created,
      workflow,
      workflowStep,
      duplicate: false,
    };
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
    if (!this.hasTable("ai_teammates")) {
      return;
    }
    const now = new Date().toISOString();
    this.ensureLingAgentSystemTeammate(now);
    this.ensureLingAgentChannelMemberships(now);
    for (const template of listDefaultTeammateTemplates(GSTACK_DEFAULT_SKILL_PACK_ID)) {
      const teammateId = createBuiltinAiTeammateId(template.id);
      if (this.hasRetentionTombstone("ai-teammate", teammateId)) {
        continue;
      }
      const existing = this.getAiTeammate(teammateId);
      if (existing) {
        this.backfillTemplateSkillBindings(teammateId, template, now);
        this.ensureDefaultTeammateMemoryScopes(teammateId, now);
        this.database
          .prepare("UPDATE channels SET default_teammate_id = ?, updated_at = ? WHERE default_teammate_id = ?")
          .run(teammateId, now, template.id);
        this.database
          .prepare("UPDATE tasks SET assignee_teammate_id = ?, updated_at = ? WHERE assignee_teammate_id = ?")
          .run(teammateId, now, template.id);
        continue;
      }

      this.createAiTeammate(
        {
          id: teammateId,
          templateId: template.id,
          roleKey: template.roleKey,
          displayName: template.name,
          description: template.summary,
          systemPrompt: template.systemPrompt,
          allowedTools: template.allowedTools,
          approvalProfile: template.approvalProfile,
          status: "active",
          pinned: template.id === "engineer" || template.id === "designer",
          hidden: false,
        },
        now,
      );
      this.replaceTeammateSkillBindings(
        teammateId,
        template.defaultSkillIds.map((skillId) => ({ skillId, source: "template", enabled: true })),
        now,
      );
      this.ensureDefaultTeammateMemoryScopes(teammateId, now);
      this.database
        .prepare("UPDATE channels SET default_teammate_id = ?, updated_at = ? WHERE default_teammate_id = ?")
        .run(teammateId, now, template.id);
      this.database
        .prepare("UPDATE tasks SET assignee_teammate_id = ?, updated_at = ? WHERE assignee_teammate_id = ?")
        .run(teammateId, now, template.id);
    }
    this.ensureDefaultTeammateMemoryScopesForAll(now);
  }

  private backfillTemplateSkillBindings(teammateId: string, template: AiTeammateTemplate, now: string): boolean {
    const existingSkillIds = new Set(this.listTeammateSkillBindings(teammateId).map((binding) => binding.skillId));
    const missingSkillIds = template.defaultSkillIds.filter((skillId) => !existingSkillIds.has(skillId));
    if (missingSkillIds.length === 0) {
      return false;
    }

    const insert = this.database.prepare(`
      INSERT INTO teammate_skill_bindings (
        teammate_id,
        skill_id,
        source,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, 'template', 1, ?, ?)
    `);
    this.database.exec("BEGIN");
    try {
      for (const skillId of missingSkillIds) {
        insert.run(teammateId, skillId, now, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return true;
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

  private hasRetentionTombstone(entityType: string, entityId: string): boolean {
    if (!this.hasTable("retention_tombstones")) {
      return false;
    }
    return Boolean(
      this.database
        .prepare("SELECT id FROM retention_tombstones WHERE workspace_id = ? AND entity_type = ? AND entity_id = ? LIMIT 1")
        .get(DEFAULT_WORKSPACE_ID, entityType, entityId),
    );
  }

  private recordMigration(version: number, name: string): void {
    this.database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, name, new Date().toISOString());
  }

  private assertChannelExists(channelId: string): void {
    if (!this.getChannel(channelId)) {
      throw new Error(`Channel not found: ${channelId}`);
    }
  }

  private assertMessageInChannel(channelId: string, messageId: string): void {
    const message = this.getChannelMessage(messageId);
    if (!message) {
      throw new Error(`Channel message not found: ${messageId}`);
    }
    if (message.channelId !== channelId) {
      throw new Error(`Message does not belong to channel: ${messageId}`);
    }
  }

  private assertAttachmentInChannel(channelId: string, attachmentId: string): void {
    const attachment = this.getChannelAttachment(attachmentId);
    if (!attachment) {
      throw new Error(`Channel attachment not found: ${attachmentId}`);
    }
    if (attachment.channelId !== channelId) {
      throw new Error(`Attachment does not belong to channel: ${attachmentId}`);
    }
  }

  private assertLinkPreviewInChannel(channelId: string, linkPreviewId: string): void {
    const linkPreview = this.getChannelLinkPreview(linkPreviewId);
    if (!linkPreview) {
      throw new Error(`Channel link preview not found: ${linkPreviewId}`);
    }
    if (linkPreview.channelId !== channelId) {
      throw new Error(`Link preview does not belong to channel: ${linkPreviewId}`);
    }
  }

  private assertTaskInChannel(channelId: string, taskId: string): void {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.channelId !== channelId) {
      throw new Error(`Task does not belong to channel: ${taskId}`);
    }
  }

  private assertRunInChannel(channelId: string, runId: string): void {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run session not found: ${runId}`);
    }
    if (run.channelId !== channelId) {
      throw new Error(`Run does not belong to channel: ${runId}`);
    }
  }

  private assertWorkflowInChannel(channelId: string, workflowId: string): void {
    const workflow = this.getChannelWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Channel workflow not found: ${workflowId}`);
    }
    if (workflow.channelId !== channelId) {
      throw new Error(`Workflow does not belong to channel: ${workflowId}`);
    }
  }

  private assertProposalInChannel(channelId: string, proposalId: string): void {
    const proposal = this.getChannelExecutionProposal(proposalId);
    if (!proposal) {
      throw new Error(`Channel proposal not found: ${proposalId}`);
    }
    if (proposal.channelId !== channelId) {
      throw new Error(`Proposal does not belong to channel: ${proposalId}`);
    }
  }

  private assertWorkflowStepInChannel(channelId: string, workflowStepId: string): void {
    const step = this.getChannelWorkflowStep(workflowStepId);
    if (!step) {
      throw new Error(`Channel workflow step not found: ${workflowStepId}`);
    }
    if (step.channelId !== channelId) {
      throw new Error(`Workflow step does not belong to channel: ${workflowStepId}`);
    }
  }

  private assertDecisionInChannel(channelId: string, decisionId: string): void {
    const decision = this.getChannelDecision(decisionId);
    if (!decision) {
      throw new Error(`Channel decision not found: ${decisionId}`);
    }
    if (decision.channelId !== channelId) {
      throw new Error(`Decision does not belong to channel: ${decisionId}`);
    }
  }

  private assertHandoffInChannel(channelId: string, handoffId: string): void {
    const handoff = this.getChannelHandoff(handoffId);
    if (!handoff) {
      throw new Error(`Channel handoff not found: ${handoffId}`);
    }
    if (handoff.channelId !== channelId) {
      throw new Error(`Handoff does not belong to channel: ${handoffId}`);
    }
  }

  private assertWorkflowHandoffIntentInChannel(channelId: string, intentId: string): void {
    const intent = this.getWorkflowHandoffIntent(intentId);
    if (!intent) {
      throw new Error(`Workflow handoff intent not found: ${intentId}`);
    }
    if (intent.channelId !== channelId) {
      throw new Error(`Workflow handoff intent does not belong to channel: ${intentId}`);
    }
  }

  private assertWorkflowSelectorDecisionInChannel(channelId: string, decisionId: string): void {
    const decision = this.getWorkflowSelectorDecision(decisionId);
    if (!decision) {
      throw new Error(`Workflow selector decision not found: ${decisionId}`);
    }
    if (decision.channelId !== channelId) {
      throw new Error(`Workflow selector decision does not belong to channel: ${decisionId}`);
    }
  }

  private assertContextSummaryInChannel(channelId: string, contextSummaryId: string): void {
    const contextSummary = this.getChannelContextSummary(contextSummaryId);
    if (!contextSummary) {
      throw new Error(`Channel context summary not found: ${contextSummaryId}`);
    }
    if (contextSummary.channelId !== channelId) {
      throw new Error(`Context summary does not belong to channel: ${contextSummaryId}`);
    }
  }

  private assertSourceRefsInChannel(
    channelId: string,
    input: { readonly sourceMessageId?: string; readonly sourceTaskId?: string; readonly sourceRunId?: string },
  ): void {
    if (input.sourceMessageId) {
      this.assertMessageInChannel(channelId, input.sourceMessageId);
    }
    if (input.sourceTaskId) {
      this.assertTaskInChannel(channelId, input.sourceTaskId);
    }
    if (input.sourceRunId) {
      this.assertRunInChannel(channelId, input.sourceRunId);
    }
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
    if (refs.workflowId) {
      this.assertWorkflowInChannel(channelId, refs.workflowId);
    }
    if (refs.workflowStepId) {
      this.assertWorkflowStepInChannel(channelId, refs.workflowStepId);
      if (refs.workflowId) {
        const step = this.getChannelWorkflowStep(refs.workflowStepId);
        if (step?.workflowId !== refs.workflowId) {
          throw new Error(`Workflow step does not belong to workflow: ${refs.workflowStepId}`);
        }
      }
    }
    if (refs.runId) {
      this.assertRunInChannel(channelId, refs.runId);
    }
    if (refs.messageId) {
      this.assertMessageInChannel(channelId, refs.messageId);
    }
    if (refs.handoffId) {
      this.assertHandoffInChannel(channelId, refs.handoffId);
    }
  }

  private ensureLingAgentSystemTeammate(now: string): AiTeammate {
    const existing = this.getAiTeammate(LING_AGENT_ID);
    if (!existing) {
      const profile = createLingAgentSystemTeammate(now);
      return this.createAiTeammate({
        id: profile.id,
        templateId: profile.templateId,
        roleKey: profile.roleKey,
        displayName: profile.displayName,
        description: profile.description,
        avatarTone: profile.avatarTone,
        avatarImageAttachmentId: profile.avatarImageAttachmentId,
        providerPresetId: profile.providerPresetId,
        runnerId: profile.runnerId,
        systemPrompt: profile.systemPrompt,
        appendSystemPrompt: profile.appendSystemPrompt,
        allowedTools: profile.allowedTools,
        approvalProfile: profile.approvalProfile,
        status: profile.status,
        pinned: profile.pinned,
        hidden: profile.hidden,
      }, now);
    }

    const next = applyLingAgentProtectedFields(existing);
    this.database
      .prepare(`
        UPDATE ai_teammates
        SET
          template_id = ?,
          role_key = ?,
          display_name = ?,
          description = ?,
          avatar_tone = ?,
          avatar_image_attachment_id = ?,
          provider_preset_id = NULL,
          runner_id = NULL,
          system_prompt = ?,
          append_system_prompt_json = ?,
          allowed_tools_json = ?,
          approval_profile_json = ?,
          status = ?,
          pinned = ?,
          hidden = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.templateId ?? null,
        next.roleKey,
        next.displayName,
        next.description,
        next.avatarTone ?? null,
        next.avatarImageAttachmentId ?? null,
        next.systemPrompt ?? null,
        stringifyJson(next.appendSystemPrompt),
        stringifyJson(next.allowedTools),
        stringifyJson(next.approvalProfile),
        next.status,
        next.pinned ? 1 : 0,
        next.hidden ? 1 : 0,
        now,
        LING_AGENT_ID,
      );
    return this.getAiTeammate(LING_AGENT_ID) ?? next;
  }

  private ensureLingAgentChannelMemberships(now: string, channelId?: string): void {
    if (!this.hasTable("channels") || !this.hasTable("teammate_channel_memberships") || !this.getAiTeammate(LING_AGENT_ID)) {
      return;
    }
    this.database
      .prepare("UPDATE channels SET default_teammate_id = NULL, updated_at = ? WHERE default_teammate_id = ?")
      .run(now, LING_AGENT_ID);
    const channels = channelId
      ? this.database.prepare("SELECT id FROM channels WHERE id = ?").all(channelId)
      : this.database.prepare("SELECT id FROM channels").all();
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO teammate_channel_memberships (
        teammate_id,
        channel_id,
        is_default,
        created_at,
        updated_at
      ) VALUES (?, ?, 0, ?, ?)
    `);
    for (const row of channels as Record<string, SQLOutputValue>[]) {
      insert.run(LING_AGENT_ID, readString(row, "id"), now, now);
    }
    this.ensureDefaultTeammateMemoryScopes(LING_AGENT_ID, now);
  }

  private ensureDefaultTeammateMemoryScopesForAll(now: string): void {
    this.teammateAssociations.ensureDefaultTeammateMemoryScopesForAll(now);
  }

  private ensureDefaultTeammateMemoryScopes(teammateId: string, now: string): void {
    this.teammateAssociations.ensureDefaultTeammateMemoryScopes(teammateId, now);
  }

  private assertWorkflowSelectorTargetsInChannel(
    channelId: string,
    input: Pick<CreateWorkflowSelectorDecisionInput, "workflowId" | "selectedWorkflowStepId" | "selectedTeammateId" | "selectedHandoffIntentId">,
  ): void {
    if (input.selectedWorkflowStepId) {
      this.assertWorkflowStepInChannel(channelId, input.selectedWorkflowStepId);
      const step = this.getChannelWorkflowStep(input.selectedWorkflowStepId);
      if (step?.workflowId !== input.workflowId) {
        throw new Error(`Selected workflow step does not belong to workflow: ${input.selectedWorkflowStepId}`);
      }
    }
    if (input.selectedTeammateId) {
      const teammate = this.getAiTeammate(input.selectedTeammateId);
      if (!teammate) {
        throw new Error(`AI teammate not found: ${input.selectedTeammateId}`);
      }
      if (teammate.workspaceId !== DEFAULT_WORKSPACE_ID) {
        throw new Error(`AI teammate does not belong to workspace: ${input.selectedTeammateId}`);
      }
    }
    if (input.selectedHandoffIntentId) {
      this.assertWorkflowHandoffIntentInChannel(channelId, input.selectedHandoffIntentId);
    }
  }

  private assertWorkflowPacketSourceRefsInChannel(channelId: string, sourceRefs: readonly WorkflowPacketSourceRef[]): void {
    for (const sourceRef of sourceRefs) {
      switch (sourceRef.type) {
        case "channel_message":
          this.assertMessageInChannel(channelId, sourceRef.id);
          break;
        case "channel_decision":
          this.assertDecisionInChannel(channelId, sourceRef.id);
          break;
        case "context_summary":
          this.assertContextSummaryInChannel(channelId, sourceRef.id);
          break;
        case "task":
          this.assertTaskInChannel(channelId, sourceRef.id);
          break;
        case "run":
          this.assertRunInChannel(channelId, sourceRef.id);
          break;
        case "workflow":
          this.assertWorkflowInChannel(channelId, sourceRef.id);
          break;
        case "workflow_step":
          this.assertWorkflowStepInChannel(channelId, sourceRef.id);
          break;
        case "workflow_handoff_intent":
          this.assertWorkflowHandoffIntentInChannel(channelId, sourceRef.id);
          break;
        case "workflow_selector_decision":
          this.assertWorkflowSelectorDecisionInChannel(channelId, sourceRef.id);
          break;
        case "approval": {
          const approval = this.getApprovalRequest(sourceRef.id);
          if (!approval) {
            throw new Error(`Approval request not found: ${sourceRef.id}`);
          }
          if (approval.channelId !== channelId) {
            throw new Error(`Approval request does not belong to channel: ${sourceRef.id}`);
          }
          break;
        }
        case "artifact":
        case "channel_brief":
        case "memory":
          break;
      }
    }
  }

  private assertChannelProtocolSourceRefsInChannel(channelId: string, sourceRefs: readonly ChannelProtocolSourceRef[]): void {
    for (const sourceRef of sourceRefs) {
      switch (sourceRef.type) {
        case "message":
          this.assertMessageInChannel(channelId, sourceRef.id);
          break;
        case "channel_decision":
          this.assertDecisionInChannel(channelId, sourceRef.id);
          break;
        case "context_summary":
          this.assertContextSummaryInChannel(channelId, sourceRef.id);
          break;
        case "task":
          this.assertTaskInChannel(channelId, sourceRef.id);
          break;
        case "run":
          this.assertRunInChannel(channelId, sourceRef.id);
          break;
        case "workflow":
          this.assertWorkflowInChannel(channelId, sourceRef.id);
          break;
        case "workflow_step":
          this.assertWorkflowStepInChannel(channelId, sourceRef.id);
          break;
        default:
          throw new Error(`Unsupported channel protocol source ref type: ${String(sourceRef.type)}`);
      }
    }
  }

  private tryRebuildLingThreadMetadata(threadId: string | undefined, now: string): void {
    if (!threadId) {
      return;
    }
    try {
      this.rebuildLingThreadMetadata(threadId, now);
    } catch {
      // Metadata is a rebuildable read cache; source mutations must remain authoritative.
    }
  }

  private tryRebuildLingThreadMetadataForRun(runId: string | undefined, now: string): void {
    if (!runId) {
      return;
    }
    try {
      this.rebuildLingThreadMetadataForRun(runId, now);
    } catch {
      // Metadata is a rebuildable read cache; source mutations must remain authoritative.
    }
  }

  private tryRebuildLingThreadMetadataForTurn(turnId: string | undefined, now: string): void {
    if (!turnId) {
      return;
    }
    try {
      const turn = this.getLingTurn(turnId);
      this.tryRebuildLingThreadMetadata(turn?.threadId, now);
    } catch {
      // Metadata is a rebuildable read cache; source mutations must remain authoritative.
    }
  }

  private tryRebuildLingThreadMetadataForApproval(approval: ApprovalRequest | undefined, now: string): void {
    if (!approval) {
      return;
    }
    this.tryRebuildLingThreadMetadataForRun(approval.runId, now);
    if (approval.workflowStepId) {
      try {
        for (const thread of this.listLingThreads({ workflowStepId: approval.workflowStepId, includeArchived: true, limit: 500 })) {
          this.tryRebuildLingThreadMetadata(thread.id, now);
        }
      } catch {
        // Metadata is a rebuildable read cache; source mutations must remain authoritative.
      }
    }
  }

  private readLatestRunActionActivityAt(runIds: readonly string[]): string | undefined {
    return this.runEvents.readLatestRunActionActivityAt(runIds);
  }

  private insertLingTurnRun(turnId: string, runId: string, role: LingTurnRunRole, createdAt: string): LingTurnRun {
    const turn = this.getLingTurn(turnId);
    if (!turn) {
      throw new Error(`Ling turn not found: ${turnId}`);
    }
    const thread = this.getLingThread(turn.threadId);
    if (!thread) {
      throw new Error(`Ling thread not found for turn: ${turn.threadId}`);
    }
    if (thread.status === "archived") {
      throw new Error(`Ling thread is archived: ${thread.id}`);
    }
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run session not found: ${runId}`);
    }
    if (run.threadId !== turn.threadId) {
      throw new Error(`Run does not belong to Ling turn thread: ${runId}`);
    }
    const row = this.database
      .prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt FROM ling_turn_runs WHERE turn_id = ?")
      .get(turnId);
    const attemptNumber = readNumber(row, "next_attempt");
    this.database
      .prepare(`
        INSERT INTO ling_turn_runs (turn_id, run_id, attempt_number, role, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(turnId, runId, attemptNumber, role, createdAt);
    return {
      turnId,
      runId,
      attemptNumber,
      role,
      createdAt,
    };
  }

  private reconcileLingTurnStatusForRun(runId: string, now: string): void {
    const turn = this.getLingTurnForRun(runId);
    if (turn) {
      this.reconcileLingTurnStatus(turn.id, now);
    }
  }

  private assertLingTurnRunReference(runId: string, threadId: string, fieldName: string): void {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`${fieldName} run not found: ${runId}`);
    }
    if (run.threadId !== threadId) {
      throw new Error(`${fieldName} run does not belong to Ling turn thread: ${runId}`);
    }
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

function labelForParticipant(participantId: string): string {
  if (participantId === "engineer" || participantId === "teammate_builtin_engineer") {
    return "Engineer";
  }
  return participantId;
}

function normalizeLingThreadSearchQuery(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized.length < 2) {
    throw new Error("search query must include at least two visible characters");
  }
  if (normalized.length > 128) {
    throw new Error("search query must be at most 128 characters");
  }
  return normalized;
}

function addLingThreadSearchMatch(
  matchesByThreadId: Map<string, LingThreadSearchMatch[]>,
  thread: { readonly id: string },
  field: LingThreadSearchField,
  value: string | undefined | null,
  query: string,
  refs: { readonly turnId?: string; readonly runId?: string } = {},
): void {
  if (!value || !normalizedSearchText(value).includes(query)) {
    return;
  }
  const existing = matchesByThreadId.get(thread.id) ?? [];
  if (existing.some((match) => match.field === field && match.turnId === refs.turnId && match.runId === refs.runId)) {
    return;
  }
  matchesByThreadId.set(thread.id, [
    ...existing,
    omitUndefined({
      threadId: thread.id,
      turnId: refs.turnId,
      runId: refs.runId,
      field,
      snippet: buildSearchSnippet(value, query),
    }),
  ]);
}

function bestLingThreadSearchRank(thread: LingThread, matches: readonly LingThreadSearchMatch[], query: string): number {
  const archivedPenalty = thread.archivedAt || thread.status === "archived" ? 100 : 0;
  const pinnedBonus = thread.pinnedAt ? -5 : 0;
  return Math.min(...matches.map((match) => archivedPenalty + pinnedBonus + lingThreadSearchFieldRank(thread, match, query)));
}

function lingThreadSearchFieldRank(thread: LingThread, match: LingThreadSearchMatch, query: string): number {
  const title = normalizedSearchText(thread.title);
  if (match.field === "thread_title" && title === query) {
    return 0;
  }
  if (match.field === "thread_title" && title.startsWith(query)) {
    return 10;
  }
  if (match.field === "thread_title" || match.field === "thread_objective") {
    return 20;
  }
  if (match.field === "metadata_summary") {
    return 30;
  }
  if (match.field === "task_id" || match.field === "task_title" || match.field === "task_prompt") {
    return 40;
  }
  return 50;
}

function normalizedSearchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function buildSearchSnippet(value: string, query: string): string {
  const redacted = String(redactSecrets(value));
  const normalized = normalizedSearchText(redacted);
  const index = normalized.indexOf(query);
  const start = index > 30 ? index - 30 : 0;
  const end = Math.min(redacted.length, Math.max(index + query.length + 80, 160));
  const snippet = redacted.slice(start, end).trim();
  const prefix = start > 0 ? "..." : "";
  const suffix = end < redacted.length ? "..." : "";
  return `${prefix}${snippet}${suffix}`;
}

function parseNullableSearchJsonObject(value: string): Record<string, unknown> | undefined {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : undefined;
}

function readOptionalSearchString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function basenameSearchValue(value: string | undefined): string | undefined {
  return value?.split(/[\\/]/).filter(Boolean).at(-1);
}

function readOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function summarizeLingThreadForMetadata(thread: LingThread, latestTurn: LingTurn | undefined): string | undefined {
  const source = latestTurn?.title || thread.title || thread.objective;
  if (!source.trim()) {
    return undefined;
  }
  const redacted = String(redactSecrets(source));
  const compact = redacted.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 160) : undefined;
}

function maxIsoTimestamp(values: readonly (string | undefined)[]): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0];
}

function compareIsoDesc(left: string | undefined, right: string | undefined): number {
  return (right ?? "").localeCompare(left ?? "");
}

function appendNullableOwnerClause(clauses: string[], params: string[], column: string, value: string | undefined): void {
  if (value === undefined) {
    clauses.push(`${column} IS NULL`);
    return;
  }
  clauses.push(`${column} = ?`);
  params.push(value);
}
