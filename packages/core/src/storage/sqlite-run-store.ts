import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  ensureRuntimePaths,
  getRunEventLogPath,
  resolveRuntimePaths,
  type LingStackRuntimePaths,
} from "../runtime-paths.js";
import {
  createApprovalRequestId,
  type ApprovalRequest,
  type ApprovalStatus,
  type CreateApprovalRequestInput,
  type ListApprovalRequestsOptions,
  type ResolveApprovalRequestInput,
} from "../approval-types.js";
import {
  createProviderPresetId,
  providerTransports,
  type ListProviderPresetsOptions,
  type ProviderCheckResult,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderTransport,
  type ProviderPresetUpdateInput,
} from "../provider-types.js";
import {
  createDefaultApprovalPolicy,
  defaultApprovalToolDecisions,
  readOnlyRunTools,
  type ApprovalPolicy,
  type ApprovalPolicyUpdateInput,
  type ApprovalToolDecision,
  type ApprovalToolDecisions,
  type RunTool,
} from "../approval-policy.js";
import {
  DEFAULT_WORKSPACE_ID,
  createAiTeammateId,
  createBuiltinAiTeammateId,
  createChannelAttachmentId,
  createChannelBriefId,
  createChannelContextSummaryId,
  createChannelDecisionId,
  createChannelExecutionProposalId,
  createChannelHandoffId,
  createChannelId,
  createChannelIntentDecisionId,
  createChannelLinkPreviewId,
  createChannelMessageId,
  createChannelMessageRouteDecisionId,
  createChannelWorkflowId,
  createChannelWorkflowStepId,
  createWorkflowHandoffIntentId,
  createWorkflowSelectorDecisionId,
  createRetentionTombstoneId,
  createTeammateDirectMessageId,
  createTeammateDirectReplyInterventionId,
  createTeammateDirectThreadId,
  createTeammateMemoryScopeId,
  createTeammatePrivateAttachmentId,
  createTaskId,
  channelWorkflowStepStatuses,
  channelAutoReplyModes,
  channelMessageRouteDecisionCreatedByValues,
  channelMessageRouteDecisionStatuses,
  channelIntentDecisionActions,
  channelIntentDecisionCreatedByValues,
  channelIntentDecisionStatuses,
  normalizeChannelRuntimePolicy,
  type AiTeammate,
  type AiTeammateStatus,
  type AiTeammateUpdateInput,
  type Channel,
  type ChannelAttachment,
  type ChannelAttachmentKind,
  type ChannelBrief,
  type ChannelContextSummary,
  type ChannelContextSummaryAuthorType,
  type ChannelContextSummaryTargetType,
  type ChannelDecision,
  type ChannelDecisionStatus,
  type ChannelExecutionProposal,
  type ChannelExecutionProposalStatus,
  type ChannelHandoff,
  type ChannelHandoffStatus,
  type ChannelIntentDecision,
  type ChannelIntentDecisionAction,
  type ChannelIntentDecisionStatus,
  type ChannelLinkPreview,
  type ChannelLinkPreviewStatus,
  type ChannelMessage,
  type ChannelMessageAuthorType,
  type ChannelMessageIntent,
  type ChannelMessageKind,
  type ChannelMessageListPage,
  type ChannelMessageRouteAlternative,
  type ChannelMessageRouteDecision,
  type ChannelMessageRouteDecisionCreatedBy,
  type ChannelMessageRouteDecisionStatus,
  type ChannelResponseLanguage,
  type ChannelRuntimePolicy,
  type ChannelStatus,
  type ChannelUpdateInput,
  type ChannelWorkspaceBinding,
  type ChannelWorkflow,
  type ChannelWorkflowMetadata,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepMetadata,
  type ChannelWorkflowStepStatus,
  type ChannelWorkflowStatus,
  type CreateAiTeammateInput,
  type CreateChannelAttachmentInput,
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
  type CreateTeammateDirectMessageInput,
  type CreateTeammateDirectReplyInterventionInput,
  type CreateTeammatePrivateAttachmentInput,
  type CreateTaskInput,
  type HardDeleteAiTeammateInput,
  type HardDeleteAiTeammateResult,
  type ListAiTeammatesOptions,
  type ListChannelAttachmentsOptions,
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
  type ListTeammateDirectMessagesOptions,
  type ListTeammateDirectReplyInterventionsOptions,
  type ListTeammatePrivateAttachmentsOptions,
  type ListTasksOptions,
  type ReplaceTeammateChannelMembershipInput,
  type ReplaceTeammateMemoryScopeInput,
  type ReplaceTeammateSkillBindingInput,
  type ResponseLanguage,
  type ResponseLanguagePreference,
  type Task,
  type TaskStatus,
  type TaskUpdateInput,
  type TeammateChannelMembership,
  type TeammateDirectMessage,
  type TeammateDirectMessageAuthorType,
  type TeammateDirectMessageStatus,
  type TeammateDirectReplyIntervention,
  type TeammateDirectReplyInterventionMode,
  type TeammateDirectReplyInterventionStatus,
  type TeammateDirectThread,
  type TeammateMemoryScope,
  type TeammateMemoryScopeKind,
  type TeammatePrivateAttachment,
  type TeammatePrivateAttachmentScope,
  type TeammateSkillBinding,
  type TeammateSkillBindingSource,
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
  type WorkspaceSettings,
  type WorkflowFanInPolicy,
  type WorkflowHandoffIntent,
  type WorkflowHandoffIntentStatus,
  type WorkflowHandoffValidation,
  type WorkflowPacketSourceRef,
  type WorkflowSelectorAlternative,
  type WorkflowSelectorDecision,
  type WorkflowSelectorDecisionStatus,
  type WorkflowSelectorTargetKind,
  type WorkflowStepFailurePolicy,
  type WorkflowStepGate,
  type WorkflowStepPolicy,
} from "../workspace-types.js";
import { GSTACK_DEFAULT_SKILL_PACK_ID, listDefaultTeammateTemplates } from "../builtin-skill-packs.js";
import {
  createSkillImportDraftId,
  createSkillPackId,
  type AiTeammateTemplate,
  type AiTeammateRoleKey,
  type CreateSkillImportDraftInput,
  type ListSkillRegistryOptions,
  type SkillApprovalProfile,
  type SkillImportDraft,
  type SkillImportDraftDefinition,
  type SkillPackSource,
  type SkillRegistryEntry,
  type SkillRegistryReviewStatus,
  type SkillVisibility,
} from "../skill-types.js";
import {
  createArtifactId,
  createEventId,
  createLingThreadId,
  createLingTurnId,
  createRunInterventionId,
  runContinuationReasons,
  type AppendControlPlaneEventInput,
  type ArtifactType,
  type ControlPlaneDomain,
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
  type RunInterventionMode,
  type RunInterventionStatus,
  type RunSession,
  type RunStore,
  type RunStatus,
  type SearchLingThreadsResult,
  type UpdateLingThreadInput,
  type UpdateRunInterventionStatusInput,
} from "../run-types.js";
import {
  createRuntimeEventId,
  createRuntimeHeartbeatId,
  createRuntimeSemaphoreSlotId,
  createWorkUnitAttemptId,
  createWorkUnitId,
  defaultRuntimeTimeoutPolicy,
  type AcquireRuntimeSemaphoreSlotInput,
  type AppendRuntimeEventInput,
  type CreateWorkUnitAttemptInput,
  type CreateWorkUnitInput,
  type ListRuntimeEventsOptions,
  type ListRuntimeSemaphoreSlotsOptions,
  type ListWorkUnitsOptions,
  type RecordRuntimeHeartbeatInput,
  type RuntimeEvent,
  type RuntimeEventType,
  type RuntimeHeartbeat,
  type RuntimeSemaphoreResourceType,
  type RuntimeSemaphoreSlot,
  type RuntimeSemaphoreSlotStatus,
  type RuntimeTimeoutPolicy,
  type RunnerFallbackReason,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkUnitAttemptStatus,
  type WorkUnitKind,
  type WorkUnitStatus,
} from "../runtime-supervisor-types.js";
import {
  createExternalWorkActionId,
  createExternalWorkCiTriageId,
  createExternalWorkId,
  type CreateExternalWorkActionInput,
  type CreateExternalWorkCiTriageInput,
  type CreateExternalWorkWorkflowInput,
  type ExternalWorkAction,
  type ExternalWorkCiTriageRecord,
  type ExternalWorkItem,
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
  createResourceLeaseId,
  createStateTransitionEventId,
  type CreateResourceLeaseInput,
  type CreateStateTransitionEventInput,
  type ListResourceLeasesOptions,
  type ListStateTransitionEventsOptions,
  type ResourceLease,
  type ResourceLeaseOwnerType,
  type ResourceLeaseStatus,
  type StateTransitionEvent,
} from "../channel-runtime-types.js";
import {
  transitionRun,
  transitionTask,
  transitionWorkUnit,
  transitionWorkflow,
  transitionWorkflowStep,
  type RunTransitionEvent,
  type StateEntityType,
  type StateTransitionActor,
  type TaskTransitionEvent,
  type TransitionResult,
  type WorkUnitTransitionEvent,
  type WorkflowStepTransitionEvent,
  type WorkflowTransitionEvent,
} from "../state-machines.js";
import {
  createMediaJobId,
  type CreateMediaJobInput,
  type ListMediaJobsOptions,
  type MediaJob,
  type MediaJobStatus,
  type UpdateMediaJobStatusInput,
} from "../media-types.js";
import {
  createMemoryConsolidationJobId,
  type CreateMemoryConsolidationJobInput,
  type ListMemoryConsolidationJobsOptions,
  type MemoryConsolidationJob,
  type MemoryConsolidationJobKind,
  type MemoryConsolidationJobStatus,
  type UpdateMemoryConsolidationJobInput,
} from "../memory-consolidation-types.js";
import {
  createMcpServerId,
  type CreateMcpServerInput,
  type ListMcpServersOptions,
  type ListMcpToolsOptions,
  type McpRuntimeStatusSnapshot,
  type McpServer,
  type McpServerStatus,
  type McpServerTransport,
  type McpTool,
  type ReplaceMcpServerToolInput,
  type ReplaceTeammateMcpBindingInput,
  type TeammateMcpBinding,
  type UpdateMcpServerInput,
} from "../mcp-types.js";
import {
  createManagedPluginEventId,
  createManagedPluginRuntimeSnapshotId,
  type CreateManagedPluginEventInput,
  type CreateManagedPluginRuntimeSnapshotInput,
  type ListManagedPluginEventsOptions,
  type ListManagedPluginsOptions,
  type ManagedPluginContributionRecord,
  type ManagedPluginDescriptor,
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
  createAutomationDraftId,
  createAutomationId,
  createAutomationRunId,
  type AutomationDraft,
  type AutomationDraftField,
  type AutomationDraftSource,
  type AutomationDraftStatus,
  type AutomationDefinition,
  type AutomationExecutionPolicy,
  type AutomationKind,
  type AutomationOutputPolicy,
  type AutomationPromptTemplate,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationStatus,
  type AutomationTarget,
  type AutomationTrigger,
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
import { validateAutomationDraft } from "../automation-drafts.js";
import {
  createWorkItemId,
  type ListWorkItemsOptions,
  type UpsertWorkItemInput,
  type WorkItem,
  type WorkItemClaim,
  type WorkItemClaimBlocker,
  type WorkItemClaimRequest,
  type WorkItemCompleteRequest,
  type WorkItemFailRequest,
  type WorkItemHeartbeatRequest,
  type WorkItemReleaseRequest,
  type WorkItemRouteRequest,
  type WorkItemSourceType,
  type WorkItemStatus,
  type WorkItemWaitingReason,
} from "../work-item-types.js";
import {
  createMemoryReviewActionId,
  createMemoryReviewDecisionId,
  createMemoryObjectId,
  createUsedMemoryEventId,
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
  type MemoryReviewAction,
  type MemoryReviewActionRecord,
  type MemoryReviewDecision,
  type MemoryReviewMode,
  type MemoryReviewOutcome,
  type MemoryReviewPolicy,
  type MemoryReviewPolicyUpdateInput,
  type MemoryReviewState,
  type MemoryScopeType,
  type MemorySelfImprovingKind,
  type MemorySelfImprovingMetadata,
  type MemorySensitivity,
  type MemorySourceRef,
  type ListMemorySelfImprovingMetadataOptions,
  type UsedMemoryEvent,
  type UpsertMemorySelfImprovingMetadataInput,
} from "../memory-types.js";
import { createDefaultMemoryReviewPolicy } from "../memory-review-policy.js";
import { redactSecrets } from "../redaction.js";
import { parseSecretRef } from "../secrets.js";
import { appendEventLogLine } from "./event-log.js";

const INITIAL_MIGRATION_VERSION = 1;
const INITIAL_MIGRATION_NAME = "create_run_sessions_and_events";
const PROVIDERS_MIGRATION_VERSION = 2;
const PROVIDERS_MIGRATION_NAME = "create_provider_presets";
const APPROVALS_MIGRATION_VERSION = 3;
const APPROVALS_MIGRATION_NAME = "create_approval_requests";
const WORKSPACE_MIGRATION_VERSION = 4;
const WORKSPACE_MIGRATION_NAME = "create_workspace_channels_tasks";
const APPROVAL_POLICY_MIGRATION_VERSION = 5;
const APPROVAL_POLICY_MIGRATION_NAME = "create_approval_policy";
const PROVIDER_CHECKS_MIGRATION_VERSION = 6;
const PROVIDER_CHECKS_MIGRATION_NAME = "add_provider_check_results";
const ARTIFACTS_MIGRATION_VERSION = 7;
const ARTIFACTS_MIGRATION_NAME = "create_artifacts";
const MEDIA_JOBS_MIGRATION_VERSION = 8;
const MEDIA_JOBS_MIGRATION_NAME = "create_media_jobs";
const MEDIA_JOB_ARTIFACTS_MIGRATION_VERSION = 9;
const MEDIA_JOB_ARTIFACTS_MIGRATION_NAME = "allow_media_job_artifacts";
const APPROVAL_MEDIA_JOB_OWNER_MIGRATION_VERSION = 10;
const APPROVAL_MEDIA_JOB_OWNER_MIGRATION_NAME = "allow_media_job_approval_owners";
const CHANNEL_RUNTIME_MIGRATION_VERSION = 11;
const CHANNEL_RUNTIME_MIGRATION_NAME = "add_channel_runtime_state_and_leases";
const PROVIDER_SECRETS_MIGRATION_VERSION = 12;
const PROVIDER_SECRETS_MIGRATION_NAME = "create_provider_secrets";
const CHANNEL_WORKSPACE_MIGRATION_VERSION = 13;
const CHANNEL_WORKSPACE_MIGRATION_NAME = "create_channel_workspace_assets";
const CHANNEL_PROTOCOL_MIGRATION_VERSION = 14;
const CHANNEL_PROTOCOL_MIGRATION_NAME = "create_channel_collaboration_protocol";
const CHANNEL_WORKFLOW_MIGRATION_VERSION = 15;
const CHANNEL_WORKFLOW_MIGRATION_NAME = "create_channel_handoff_workflows";
const AI_TEAMMATE_WORKSPACE_MIGRATION_VERSION = 16;
const AI_TEAMMATE_WORKSPACE_MIGRATION_NAME = "create_ai_teammate_private_workspace";
const EXTERNAL_WORK_MIGRATION_VERSION = 17;
const EXTERNAL_WORK_MIGRATION_NAME = "create_external_work_items";
const EXTERNAL_WORK_SCHEDULER_MIGRATION_VERSION = 18;
const EXTERNAL_WORK_SCHEDULER_MIGRATION_NAME = "create_external_work_scheduler_state";
const EXTERNAL_WORK_ACTIONS_MIGRATION_VERSION = 19;
const EXTERNAL_WORK_ACTIONS_MIGRATION_NAME = "create_external_work_actions";
const EXTERNAL_WORK_CI_TRIAGE_MIGRATION_VERSION = 20;
const EXTERNAL_WORK_CI_TRIAGE_MIGRATION_NAME = "create_external_work_ci_triage";
const CHANNEL_EXECUTION_PROPOSALS_MIGRATION_VERSION = 21;
const CHANNEL_EXECUTION_PROPOSALS_MIGRATION_NAME = "create_channel_execution_proposals";
const RUNTIME_SUPERVISOR_MIGRATION_VERSION = 22;
const RUNTIME_SUPERVISOR_MIGRATION_NAME = "create_runtime_supervisor";
const MCP_TOOL_MANAGEMENT_MIGRATION_VERSION = 23;
const MCP_TOOL_MANAGEMENT_MIGRATION_NAME = "create_mcp_tool_management";
const LING_MEMORY_MIGRATION_VERSION = 24;
const LING_MEMORY_MIGRATION_NAME = "create_ling_memory_v1";
const SKILL_AWARE_RUN_MIGRATION_VERSION = 25;
const SKILL_AWARE_RUN_MIGRATION_NAME = "add_skill_aware_tasks_and_runs";
const PRIVATE_WORKSPACE_DATA_LIFECYCLE_MIGRATION_VERSION = 26;
const PRIVATE_WORKSPACE_DATA_LIFECYCLE_MIGRATION_NAME = "create_private_workspace_data_lifecycle";
const SKILL_REGISTRY_MIGRATION_VERSION = 27;
const SKILL_REGISTRY_MIGRATION_NAME = "create_skill_registry";
const RUN_INTERVENTIONS_MIGRATION_VERSION = 28;
const RUN_INTERVENTIONS_MIGRATION_NAME = "create_run_interventions";
const RUNNER_AUDIT_MIGRATION_VERSION = 29;
const RUNNER_AUDIT_MIGRATION_NAME = "add_runner_audit_fields";
const CHANNEL_WORKFLOW_STEP_METADATA_MIGRATION_VERSION = 30;
const CHANNEL_WORKFLOW_STEP_METADATA_MIGRATION_NAME = "add_channel_workflow_step_metadata";
const LING_THREADS_MIGRATION_VERSION = 31;
const LING_THREADS_MIGRATION_NAME = "create_ling_threads";
const APPROVAL_WORKFLOW_STEP_OWNER_MIGRATION_VERSION = 32;
const APPROVAL_WORKFLOW_STEP_OWNER_MIGRATION_NAME = "allow_workflow_step_approval_owners";
const RUN_WORKFLOW_STEP_OWNER_MIGRATION_VERSION = 33;
const RUN_WORKFLOW_STEP_OWNER_MIGRATION_NAME = "add_run_workflow_step_owner";
const MCP_STATUS_SNAPSHOTS_MIGRATION_VERSION = 34;
const MCP_STATUS_SNAPSHOTS_MIGRATION_NAME = "create_mcp_status_snapshots";
const MEMORY_REVIEW_POLICY_MIGRATION_VERSION = 35;
const MEMORY_REVIEW_POLICY_MIGRATION_NAME = "create_memory_review_policy";
const MEMORY_CONSOLIDATION_JOBS_MIGRATION_VERSION = 36;
const MEMORY_CONSOLIDATION_JOBS_MIGRATION_NAME = "create_memory_consolidation_jobs";
const MANAGED_PLUGINS_MIGRATION_VERSION = 37;
const MANAGED_PLUGINS_MIGRATION_NAME = "create_managed_plugins";
const AUTOMATIONS_MIGRATION_VERSION = 38;
const AUTOMATIONS_MIGRATION_NAME = "create_automations";
const AUTOMATION_DRAFTS_MIGRATION_VERSION = 39;
const AUTOMATION_DRAFTS_MIGRATION_NAME = "create_automation_drafts";
const MEMORY_HEALTH_MIGRATION_VERSION = 40;
const MEMORY_HEALTH_MIGRATION_NAME = "add_memory_health_metadata";
const MANAGED_PLUGIN_PACKAGES_MIGRATION_VERSION = 41;
const MANAGED_PLUGIN_PACKAGES_MIGRATION_NAME = "create_managed_plugin_packages";
const CONTROL_PLANE_EVENTS_MIGRATION_VERSION = 42;
const CONTROL_PLANE_EVENTS_MIGRATION_NAME = "create_control_plane_events";
const WORK_ITEMS_MIGRATION_VERSION = 43;
const WORK_ITEMS_MIGRATION_NAME = "create_work_items";
const LING_TURNS_MIGRATION_VERSION = 44;
const LING_TURNS_MIGRATION_NAME = "create_ling_turns";
const LING_THREAD_METADATA_MIGRATION_VERSION = 45;
const LING_THREAD_METADATA_MIGRATION_NAME = "add_ling_thread_metadata";
const LING_THREAD_FORK_LINEAGE_MIGRATION_VERSION = 46;
const LING_THREAD_FORK_LINEAGE_MIGRATION_NAME = "add_ling_thread_fork_lineage";
const LING_THREAD_VISIBILITY_MIGRATION_VERSION = 47;
const LING_THREAD_VISIBILITY_MIGRATION_NAME = "add_ling_thread_visibility_fields";
const CHANNEL_WORKFLOW_METADATA_MIGRATION_VERSION = 48;
const CHANNEL_WORKFLOW_METADATA_MIGRATION_NAME = "add_channel_workflow_metadata";
const WORKFLOW_COORDINATION_RECORDS_MIGRATION_VERSION = 49;
const WORKFLOW_COORDINATION_RECORDS_MIGRATION_NAME = "create_workflow_coordination_records";
const CHANNEL_AUTO_REPLY_ROUTER_MIGRATION_VERSION = 50;
const CHANNEL_AUTO_REPLY_ROUTER_MIGRATION_NAME = "create_channel_auto_reply_router";
const TEAMMATE_DIRECT_REPLY_INTERVENTIONS_MIGRATION_VERSION = 51;
const TEAMMATE_DIRECT_REPLY_INTERVENTIONS_MIGRATION_NAME = "create_teammate_direct_reply_interventions";
const WORKSPACE_SETTINGS_AND_CHANNEL_BINDING_MIGRATION_VERSION = 52;
const WORKSPACE_SETTINGS_AND_CHANNEL_BINDING_MIGRATION_NAME = "create_workspace_settings_and_channel_binding";
const CHANNEL_EXECUTION_PROPOSAL_WORKFLOW_LINK_MIGRATION_VERSION = 53;
const CHANNEL_EXECUTION_PROPOSAL_WORKFLOW_LINK_MIGRATION_NAME = "add_channel_execution_proposal_workflow_link";
const CHANNEL_INTENT_DECISIONS_MIGRATION_VERSION = 54;
const CHANNEL_INTENT_DECISIONS_MIGRATION_NAME = "create_channel_intent_decisions";
const RESPONSE_LANGUAGE_CONTEXT_MIGRATION_VERSION = 55;
const RESPONSE_LANGUAGE_CONTEXT_MIGRATION_NAME = "add_response_language_context";
const CHANNEL_VISIBLE_MULTI_REPLY_INTENT_MIGRATION_VERSION = 56;
const CHANNEL_VISIBLE_MULTI_REPLY_INTENT_MIGRATION_NAME = "add_channel_visible_multi_reply_intent";
const PROVIDER_TRANSPORT_MIGRATION_VERSION = 57;
const PROVIDER_TRANSPORT_MIGRATION_NAME = "add_provider_transport";
const STALE_RUN_ERROR = "Daemon stopped before the run reached a terminal state.";

export interface SqliteRunStoreOptions {
  readonly cwd: string;
  readonly paths?: LingStackRuntimePaths;
}

export class SqliteRunStore implements RunStore {
  readonly paths: LingStackRuntimePaths;
  private readonly database: DatabaseSync;

  constructor(options: SqliteRunStoreOptions) {
    this.paths = options.paths ?? resolveRuntimePaths(options.cwd);
    ensureRuntimePaths(this.paths);
    const existed = existsSync(this.paths.databasePath);
    this.database = new DatabaseSync(this.paths.databasePath);
    this.configureDatabase();
    this.applyMigrations();
    this.ensureDefaultWorkspace();
    this.ensureDefaultApprovalPolicy();
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
    const eventLogPath = getRunEventLogPath(this.paths, input.id);
    const redactedTaskSnapshot = redactSecrets(input.taskSnapshot);
    const redactedProviderSnapshot = redactSecrets(input.providerSnapshot);
    const redactedRequestSnapshot = redactSecrets(input.requestSnapshot);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
          INSERT INTO run_sessions (
            id,
            status,
            cwd,
            task_id,
            channel_id,
            teammate_id,
            workflow_step_id,
            selected_skill_id,
            provider_preset_id,
            provider_name,
            provider_model,
            task_snapshot_json,
            provider_snapshot_json,
            request_snapshot_json,
            event_log_path,
            thread_id,
            work_unit_id,
            parent_run_id,
            intervention_id,
            continuation_reason,
            summary_path,
            error_message,
            created_at,
            started_at,
            ended_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.id,
          "queued",
          input.cwd,
          input.taskId,
          input.channelId ?? null,
          input.teammateId ?? null,
          input.workflowStepId ?? null,
          input.selectedSkillId ?? null,
          input.providerPresetId ?? null,
          input.providerName,
          input.providerModel,
          stringifyJson(redactedTaskSnapshot),
          stringifyJson(redactedProviderSnapshot),
          stringifyJson(redactedRequestSnapshot),
          eventLogPath,
          input.threadId ?? null,
          input.workUnitId ?? null,
          input.parentRunId ?? null,
          input.interventionId ?? null,
          input.continuationReason ?? null,
          null,
          null,
          input.createdAt,
          null,
          null,
          input.createdAt,
        );
      if (input.turnId) {
        this.insertLingTurnRun(input.turnId, input.id, input.turnRunRole ?? "primary", input.createdAt);
        this.reconcileLingTurnStatus(input.turnId, input.createdAt);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    const session = this.getRun(input.id);
    if (!session) {
      throw new Error(`Failed to create run session: ${input.id}`);
    }
    this.tryRebuildLingThreadMetadata(session.threadId, session.createdAt);
    return session;
  }

  markRunStarted(runId: string, startedAt: string): void {
    this.updateRunStatus(runId, "running", startedAt, null, undefined, undefined, startedAt);
  }

  markRunWaitingForApproval(runId: string, updatedAt: string): void {
    this.updateRunStatus(runId, "waiting_for_approval", undefined, undefined, undefined, undefined, updatedAt);
  }

  markRunRunning(runId: string, updatedAt: string): void {
    this.updateRunStatus(runId, "running", undefined, undefined, undefined, undefined, updatedAt);
  }

  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "succeeded", undefined, endedAt, null, summaryPath, endedAt);
  }

  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "failed", undefined, endedAt, errorMessage, summaryPath, endedAt);
  }

  markRunCancelled(runId: string, endedAt: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "cancelled", undefined, endedAt, null, summaryPath, endedAt);
  }

  appendEvent(runId: string, type: RunEventType, data: unknown): RunEventEnvelope {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run session not found: ${runId}`);
    }

    const envelope: RunEventEnvelope = {
      id: createEventId(),
      runId,
      seq: this.nextEventSeq(runId),
      ts: new Date().toISOString(),
      type,
      data: redactSecrets(data),
    };

    this.database
      .prepare("INSERT INTO run_events (id, run_id, seq, ts, type, data_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(envelope.id, envelope.runId, envelope.seq, envelope.ts, envelope.type, stringifyJson(envelope.data));
    appendEventLogLine(run.eventLogPath, envelope);
    if (type === "tool_start" || type === "tool_update" || type === "tool_end") {
      this.tryRebuildLingThreadMetadata(run.threadId, envelope.ts);
    }
    return envelope;
  }

  appendControlPlaneEvent(input: AppendControlPlaneEventInput, now: string): ControlPlaneEvent {
    const redactedData = redactSecrets(input.data ?? {}) as Record<string, unknown>;
    this.database
      .prepare(`
        INSERT INTO control_plane_events (
          workspace_id,
          cwd,
          ts,
          domain,
          entity_type,
          entity_id,
          action,
          data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.workspaceId,
        input.cwd,
        now,
        input.domain,
        input.entityType,
        input.entityId,
        input.action,
        stringifyJson(redactedData),
      );
    const seq = readNumber(this.database.prepare("SELECT last_insert_rowid() AS seq").get(), "seq");
    const event = this.getControlPlaneEvent(seq);
    if (!event) {
      throw new Error(`Failed to append control-plane event: ${seq}`);
    }
    return event;
  }

  listControlPlaneEvents(options: ListControlPlaneEventsOptions): ControlPlaneEvent[] {
    const clauses = ["workspace_id = ?", "seq > ?"];
    const params: (string | number)[] = [options.workspaceId, Math.max(options.afterSeq ?? 0, 0)];
    if (options.domains && options.domains.length > 0) {
      clauses.push(`domain IN (${options.domains.map(() => "?").join(", ")})`);
      params.push(...options.domains);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    params.push(limit);
    return this.database
      .prepare(`${controlPlaneEventSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY seq ASC LIMIT ?`)
      .all(...params)
      .map(mapControlPlaneEvent);
  }

  getLatestControlPlaneEventSeq(workspaceId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM control_plane_events WHERE workspace_id = ?")
      .get(workspaceId);
    return readNumber(row, "latest_seq");
  }

  getRun(runId: string): RunSession | undefined {
    const row = this.database
      .prepare(
        `
          SELECT
            id,
            status,
            cwd,
            task_id,
            channel_id,
            teammate_id,
            workflow_step_id,
            selected_skill_id,
            provider_preset_id,
            provider_name,
            provider_model,
            task_snapshot_json,
            provider_snapshot_json,
	            request_snapshot_json,
	            event_log_path,
	            thread_id,
	            work_unit_id,
            parent_run_id,
            intervention_id,
            continuation_reason,
            summary_path,
            error_message,
            created_at,
            started_at,
            ended_at,
            updated_at
          FROM run_sessions
          WHERE id = ?
        `,
      )
      .get(runId);

    return row ? mapRunSession(row) : undefined;
  }

  listRuns(options: ListRunsOptions = {}): RunSession[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.workflowStepId) {
      clauses.push("workflow_step_id = ?");
      params.push(options.workflowStepId);
    }
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const statement = this.database.prepare(`
      SELECT
        id,
        status,
        cwd,
        task_id,
        channel_id,
        teammate_id,
        workflow_step_id,
        selected_skill_id,
        provider_preset_id,
        provider_name,
        provider_model,
        task_snapshot_json,
        provider_snapshot_json,
	        request_snapshot_json,
	        event_log_path,
	        thread_id,
	        work_unit_id,
        parent_run_id,
        intervention_id,
        continuation_reason,
        summary_path,
        error_message,
        created_at,
        started_at,
        ended_at,
        updated_at
      FROM run_sessions
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = statement.all(...params);
    return rows.map(mapRunSession);
  }

  listEvents(runId: string, options: ListRunEventsOptions = {}): RunEventEnvelope[] {
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    return this.database
      .prepare(
        `
          SELECT id, run_id, seq, ts, type, data_json
          FROM run_events
          WHERE run_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?
        `,
      )
      .all(runId, afterSeq, limit)
      .map(mapRunEvent);
  }

  countEvents(runId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?").get(runId);
    return readNumber(row, "count");
  }

  createRunIntervention(input: CreateRunInterventionInput, now: string): RunIntervention {
    const existing = this.database
      .prepare(runInterventionSelectSql("WHERE source_run_id = ? AND idempotency_key = ?"))
      .get(input.sourceRunId, input.idempotencyKey);
    if (existing) {
      return mapRunIntervention(existing);
    }
    if (!this.getRun(input.sourceRunId)) {
      throw new Error(`Source run not found: ${input.sourceRunId}`);
    }
    const id = input.id ?? createRunInterventionId();
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    this.database
      .prepare(`
        INSERT INTO run_interventions (
          id,
          workspace_id,
          source_run_id,
          source_work_unit_id,
          source_attempt_id,
          continuation_run_id,
          continuation_work_unit_id,
          mode,
          status,
          instruction,
          requested_by,
          idempotency_key,
          created_at,
          updated_at,
          started_at,
          completed_at,
          failure_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        workspaceId,
        input.sourceRunId,
        input.sourceWorkUnitId ?? null,
        input.sourceAttemptId ?? null,
        null,
        null,
        input.mode,
        "queued",
        input.instruction,
        input.requestedBy ?? "local-user",
        input.idempotencyKey,
        now,
        now,
        null,
        null,
        null,
      );
    const created = this.getRunIntervention(id);
    if (!created) {
      throw new Error(`Failed to create run intervention: ${id}`);
    }
    return created;
  }

  getRunIntervention(interventionId: string): RunIntervention | undefined {
    const row = this.database.prepare(runInterventionSelectSql("WHERE id = ?")).get(interventionId);
    return row ? mapRunIntervention(row) : undefined;
  }

  listRunInterventions(options: ListRunInterventionsOptions = {}): RunIntervention[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.sourceRunId) {
      clauses.push("source_run_id = ?");
      params.push(options.sourceRunId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.mode) {
      clauses.push("mode = ?");
      params.push(options.mode);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    return this.database
      .prepare(`${runInterventionSelectSql(whereClause)} ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(...params)
      .map(mapRunIntervention);
  }

  updateRunInterventionStatus(input: UpdateRunInterventionStatusInput): RunIntervention | undefined {
    const existing = this.getRunIntervention(input.interventionId);
    if (!existing) {
      return undefined;
    }
    const continuationRunId = input.continuationRunId === undefined ? existing.continuationRunId ?? null : input.continuationRunId;
    const continuationWorkUnitId = input.continuationWorkUnitId === undefined ? existing.continuationWorkUnitId ?? null : input.continuationWorkUnitId;
    const startedAt = input.startedAt === undefined ? existing.startedAt ?? null : input.startedAt;
    const completedAt = input.completedAt === undefined ? existing.completedAt ?? null : input.completedAt;
    const failureReason = input.failureReason === undefined ? existing.failureReason ?? null : input.failureReason;
    this.database
      .prepare(`
        UPDATE run_interventions
        SET status = ?,
            continuation_run_id = ?,
            continuation_work_unit_id = ?,
            updated_at = ?,
            started_at = ?,
            completed_at = ?,
            failure_reason = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        continuationRunId,
        continuationWorkUnitId,
        input.now,
        startedAt,
        completedAt,
        failureReason,
        input.interventionId,
      );
    return this.getRunIntervention(input.interventionId);
  }

  cancelRunIntervention(interventionId: string, now: string, reason?: string): RunIntervention | undefined {
    const existing = this.getRunIntervention(interventionId);
    if (!existing) {
      return undefined;
    }
    if (existing.status === "started" || existing.status === "cancelled" || existing.status === "failed") {
      return existing;
    }
    return this.updateRunInterventionStatus({
      interventionId,
      status: "cancelled",
      completedAt: now,
      failureReason: reason ?? "cancelled",
      now,
    });
  }

  createWorkUnit(input: CreateWorkUnitInput): WorkUnit {
    const id = input.id ?? createWorkUnitId();
    const timeoutPolicy = input.timeoutPolicy ?? defaultRuntimeTimeoutPolicy;
    const status = input.status ?? "queued";
    this.database
      .prepare(`
        INSERT INTO work_units (
          id,
          workspace_id,
          kind,
          owner_type,
          owner_id,
          channel_id,
          task_id,
          teammate_id,
          provider_preset_id,
          runner_id,
          requested_runner_id,
          effective_runner_id,
          runner_fallback_reason_json,
          idempotency_key,
          status,
          priority,
          attempt_count,
          active_attempt_id,
          created_by_client_id,
          created_by_actor,
          request_json,
          timeout_policy_json,
          linked_run_id,
          linked_message_id,
          linked_media_job_id,
          linked_external_work_id,
          created_at,
          updated_at,
          started_at,
          ended_at,
          last_event_at,
          last_heartbeat_at,
          error_code,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.workspaceId,
        input.kind,
        input.ownerType,
        input.ownerId,
        input.channelId ?? null,
        input.taskId ?? null,
        input.teammateId ?? null,
        input.providerPresetId ?? null,
        normalizeStoredRunnerId(input.runnerId ?? input.effectiveRunnerId) ?? null,
        normalizeStoredRunnerId(input.requestedRunnerId) ?? null,
        normalizeStoredRunnerId(input.effectiveRunnerId ?? input.runnerId) ?? null,
        input.fallbackReason ? stringifyJson(input.fallbackReason) : null,
        input.idempotencyKey,
        status,
        input.priority ?? 0,
        0,
        null,
        input.createdByClientId ?? null,
        input.createdByActor,
        stringifyJson(redactSecrets(input.request)),
        stringifyJson(timeoutPolicy),
        input.linkedRunId ?? null,
        input.linkedMessageId ?? null,
        input.linkedMediaJobId ?? null,
        input.linkedExternalWorkId ?? null,
        input.now,
        input.now,
        null,
        null,
        null,
        null,
        null,
        null,
      );

    const workUnit = this.getWorkUnit(id);
    if (!workUnit) {
      throw new Error(`Failed to create work unit: ${id}`);
    }
    return workUnit;
  }

  getWorkUnit(workUnitId: string): WorkUnit | undefined {
    const row = this.database.prepare(workUnitSelectSql("WHERE id = ?")).get(workUnitId);
    return row ? mapWorkUnit(row) : undefined;
  }

  listWorkUnits(options: ListWorkUnitsOptions = {}): WorkUnit[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.ownerType) {
      clauses.push("owner_type = ?");
      params.push(options.ownerType);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.linkedRunId) {
      clauses.push("linked_run_id = ?");
      params.push(options.linkedRunId);
    }
    if (options.linkedMessageId) {
      clauses.push("linked_message_id = ?");
      params.push(options.linkedMessageId);
    }
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${workUnitSelectSql(whereClause)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapWorkUnit);
  }

  findWorkUnitByIdempotency(input: {
    readonly kind: WorkUnit["kind"];
    readonly ownerType: string;
    readonly ownerId: string;
    readonly idempotencyKey: string;
  }): WorkUnit | undefined {
    const row = this.database
      .prepare(workUnitSelectSql("WHERE workspace_id = ? AND kind = ? AND owner_type = ? AND owner_id = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, input.kind, input.ownerType, input.ownerId, input.idempotencyKey);
    return row ? mapWorkUnit(row) : undefined;
  }

  linkRunToWorkUnit(runId: string, workUnitId: string, now: string): RunSession | undefined {
    this.database
      .prepare("UPDATE run_sessions SET work_unit_id = ?, updated_at = ? WHERE id = ?")
      .run(workUnitId, now, runId);
    this.database
      .prepare("UPDATE work_units SET linked_run_id = ?, updated_at = ? WHERE id = ?")
      .run(runId, now, workUnitId);
    return this.getRun(runId);
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
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.findStateTransitionByIdempotency("work_unit", input.workUnitId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: workUnit.status, to: workUnit.status, duplicate: true };
      }
    }

    const result = transitionWorkUnit({
      entityId: input.workUnitId,
      currentStatus: workUnit.status,
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
        UPDATE work_units
        SET
          status = ?,
          active_attempt_id = ?,
          updated_at = ?,
          started_at = ?,
          ended_at = ?,
          last_event_at = ?,
          last_heartbeat_at = ?,
          error_code = ?,
          error_message = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        result.to,
        input.activeAttemptId === undefined ? workUnit.activeAttemptId ?? null : input.activeAttemptId,
        input.now,
        input.startedAt ?? workUnit.startedAt ?? null,
        input.endedAt === undefined ? workUnit.endedAt ?? null : input.endedAt,
        input.lastEventAt ?? workUnit.lastEventAt ?? null,
        input.lastHeartbeatAt ?? workUnit.lastHeartbeatAt ?? null,
        input.errorCode === undefined ? workUnit.errorCode ?? null : input.errorCode,
        input.errorMessage === undefined ? workUnit.errorMessage ?? null : input.errorMessage,
        input.workUnitId,
        result.from,
      );
    if (Number(update.changes) === 0) {
      const current = this.getWorkUnit(input.workUnitId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? workUnit.status };
    }

    this.recordStateTransitionEvent({
      workspaceId: workUnit.workspaceId,
      entityType: "work_unit",
      entityId: input.workUnitId,
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

  createWorkUnitAttempt(input: CreateWorkUnitAttemptInput): WorkUnitAttempt {
    const id = input.id ?? createWorkUnitAttemptId();
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      throw new Error(`Work unit not found: ${input.workUnitId}`);
    }
    this.database
      .prepare(`
        INSERT INTO work_unit_attempts (
          id,
          work_unit_id,
          attempt_number,
          runtime_instance_id,
          runner_id,
          requested_runner_id,
          effective_runner_id,
          runner_fallback_reason_json,
          provider_preset_id,
          status,
          created_at,
          started_at,
          ended_at,
          last_event_at,
          last_heartbeat_at,
          abort_requested_at,
          error_code,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.workUnitId,
        input.attemptNumber,
        input.runtimeInstanceId,
        normalizeStoredRunnerId(input.runnerId) ?? input.runnerId,
        normalizeStoredRunnerId(input.requestedRunnerId) ?? null,
        normalizeStoredRunnerId(input.effectiveRunnerId ?? input.runnerId) ?? input.runnerId,
        input.fallbackReason ? stringifyJson(input.fallbackReason) : null,
        input.providerPresetId ?? null,
        input.status ?? "created",
        input.now,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      );
    this.database
      .prepare("UPDATE work_units SET attempt_count = MAX(attempt_count, ?), active_attempt_id = ?, updated_at = ? WHERE id = ?")
      .run(input.attemptNumber, id, input.now, input.workUnitId);
    const attempt = this.getWorkUnitAttempt(id);
    if (!attempt) {
      throw new Error(`Failed to create work unit attempt: ${id}`);
    }
    return attempt;
  }

  getWorkUnitAttempt(attemptId: string): WorkUnitAttempt | undefined {
    const row = this.database.prepare(workUnitAttemptSelectSql("WHERE id = ?")).get(attemptId);
    return row ? mapWorkUnitAttempt(row) : undefined;
  }

  listWorkUnitAttempts(workUnitId: string): WorkUnitAttempt[] {
    return this.database
      .prepare(`${workUnitAttemptSelectSql("WHERE work_unit_id = ?")} ORDER BY attempt_number ASC, created_at ASC`)
      .all(workUnitId)
      .map(mapWorkUnitAttempt);
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
    const attempt = this.getWorkUnitAttempt(input.attemptId);
    if (!attempt) {
      return undefined;
    }
    this.database
      .prepare(`
        UPDATE work_unit_attempts
        SET
          status = ?,
          started_at = ?,
          ended_at = ?,
          last_event_at = ?,
          last_heartbeat_at = ?,
          abort_requested_at = ?,
          error_code = ?,
          error_message = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        input.startedAt ?? attempt.startedAt ?? null,
        input.endedAt === undefined ? attempt.endedAt ?? null : input.endedAt,
        input.lastEventAt ?? attempt.lastEventAt ?? null,
        input.lastHeartbeatAt ?? attempt.lastHeartbeatAt ?? null,
        input.abortRequestedAt ?? attempt.abortRequestedAt ?? null,
        input.errorCode === undefined ? attempt.errorCode ?? null : input.errorCode,
        input.errorMessage === undefined ? attempt.errorMessage ?? null : input.errorMessage,
        input.attemptId,
      );
    return this.getWorkUnitAttempt(input.attemptId);
  }

  appendRuntimeEvent(input: AppendRuntimeEventInput): RuntimeEvent {
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      throw new Error(`Work unit not found: ${input.workUnitId}`);
    }
    const event: RuntimeEvent = {
      id: createRuntimeEventId(),
      workUnitId: input.workUnitId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      seq: this.nextRuntimeEventSeq(input.workUnitId),
      ts: input.ts,
      type: input.type,
      actor: input.actor,
      data: redactSecrets(input.data),
    };
    this.database
      .prepare(`
        INSERT INTO runtime_events (id, work_unit_id, attempt_id, seq, ts, type, actor, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(event.id, event.workUnitId, event.attemptId ?? null, event.seq, event.ts, event.type, event.actor, stringifyJson(event.data));
    this.database
      .prepare("UPDATE work_units SET last_event_at = ?, updated_at = ? WHERE id = ?")
      .run(event.ts, event.ts, input.workUnitId);
    if (input.attemptId) {
      this.database
        .prepare("UPDATE work_unit_attempts SET last_event_at = ? WHERE id = ?")
        .run(event.ts, input.attemptId);
    }
    return event;
  }

  listRuntimeEvents(workUnitId: string, options: ListRuntimeEventsOptions = {}): RuntimeEvent[] {
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    return this.database
      .prepare(`${runtimeEventSelectSql("WHERE work_unit_id = ? AND seq > ?")} ORDER BY seq ASC LIMIT ?`)
      .all(workUnitId, afterSeq, limit)
      .map(mapRuntimeEvent);
  }

  recordRuntimeHeartbeat(input: RecordRuntimeHeartbeatInput): RuntimeHeartbeat {
    const heartbeat: RuntimeHeartbeat = {
      id: createRuntimeHeartbeatId(),
      workUnitId: input.workUnitId,
      attemptId: input.attemptId,
      runtimeInstanceId: input.runtimeInstanceId,
      ts: input.ts,
      source: input.source,
      ...(input.detail !== undefined ? { detail: redactSecrets(input.detail) } : {}),
    };
    this.database
      .prepare(`
        INSERT INTO runtime_heartbeats (id, work_unit_id, attempt_id, runtime_instance_id, ts, source, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        heartbeat.id,
        heartbeat.workUnitId,
        heartbeat.attemptId,
        heartbeat.runtimeInstanceId,
        heartbeat.ts,
        heartbeat.source,
        heartbeat.detail === undefined ? null : stringifyJson(heartbeat.detail),
      );
    this.database
      .prepare("UPDATE work_units SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?")
      .run(input.ts, input.ts, input.workUnitId);
    this.database
      .prepare("UPDATE work_unit_attempts SET last_heartbeat_at = ? WHERE id = ?")
      .run(input.ts, input.attemptId);
    this.database
      .prepare("UPDATE resource_leases SET last_renewed_at = ? WHERE attempt_id = ? AND status = 'active'")
      .run(input.ts, input.attemptId);
    this.database
      .prepare("UPDATE runtime_semaphore_slots SET last_renewed_at = ? WHERE attempt_id = ? AND status = 'active'")
      .run(input.ts, input.attemptId);
    return heartbeat;
  }

  acquireRuntimeSemaphoreSlot(input: AcquireRuntimeSemaphoreSlotInput): RuntimeSemaphoreSlot | undefined {
    const id = createRuntimeSemaphoreSlotId();
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      const activeCount = readNumber(
        this.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM runtime_semaphore_slots
            WHERE workspace_id = ? AND resource_type = ? AND resource_key = ? AND status = 'active'
          `)
          .get(input.workspaceId, input.resourceType, input.resourceKey),
        "count",
      );
      if (activeCount >= input.limit) {
        this.database.exec("ROLLBACK;");
        return undefined;
      }
      this.database
        .prepare(`
          INSERT INTO runtime_semaphore_slots (
            id,
            workspace_id,
            resource_type,
            resource_key,
            owner_type,
            owner_id,
            work_unit_id,
            attempt_id,
            status,
            acquired_at,
            last_renewed_at,
            expires_at,
            released_at,
            release_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.workspaceId,
          input.resourceType,
          input.resourceKey,
          input.ownerType,
          input.ownerId,
          input.workUnitId,
          input.attemptId,
          input.acquiredAt,
          input.acquiredAt,
          input.expiresAt,
          null,
          null,
        );
      this.database.exec("COMMIT;");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // Ignore rollback failure; original error path returns no slot.
      }
      return undefined;
    }
    const slot = this.database.prepare(runtimeSemaphoreSlotSelectSql("WHERE id = ?")).get(id);
    return slot ? mapRuntimeSemaphoreSlot(slot) : undefined;
  }

  releaseRuntimeSemaphoreSlotsForOwner(ownerId: string, releasedAt: string, releaseReason: string): number {
    const result = this.database
      .prepare(`
        UPDATE runtime_semaphore_slots
        SET status = 'released', released_at = ?, release_reason = ?
        WHERE owner_id = ? AND status = 'active'
      `)
      .run(releasedAt, releaseReason, ownerId);
    return Number(result.changes);
  }

  listRuntimeSemaphoreSlots(options: ListRuntimeSemaphoreSlotsOptions = {}): RuntimeSemaphoreSlot[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.resourceType) {
      clauses.push("resource_type = ?");
      params.push(options.resourceType);
    }
    if (options.resourceKey) {
      clauses.push("resource_key = ?");
      params.push(options.resourceKey);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.workUnitId) {
      clauses.push("work_unit_id = ?");
      params.push(options.workUnitId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${runtimeSemaphoreSlotSelectSql(whereClause)} ORDER BY acquired_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapRuntimeSemaphoreSlot);
  }

  createArtifact(input: CreateRunArtifactInput): RunArtifact {
    const runId = normalizeOptionalOwnerId(input.runId);
    const mediaJobId = normalizeOptionalOwnerId(input.mediaJobId);
    const externalWorkId = normalizeOptionalOwnerId(input.externalWorkId);
    const ownerCount = [runId, mediaJobId, externalWorkId].filter(Boolean).length;
    if (ownerCount !== 1) {
      throw new Error("Artifact must belong to exactly one run, media job, or external work item.");
    }
    if (runId && !this.getRun(runId)) {
      throw new Error(`Run session not found: ${runId}`);
    }
    if (mediaJobId && !this.getMediaJob(mediaJobId)) {
      throw new Error(`Media job not found: ${mediaJobId}`);
    }
    if (externalWorkId && !this.getExternalWorkRecord(externalWorkId)) {
      throw new Error(`External work item not found: ${externalWorkId}`);
    }

    const artifact: RunArtifact = omitUndefined({
      id: input.id ?? createArtifactId(),
      runId,
      mediaJobId,
      externalWorkId,
      type: input.type,
      path: input.path,
      title: input.title,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      createdAt: input.createdAt,
    });

    this.database
      .prepare(`
        INSERT INTO artifacts (
          id,
          run_id,
          media_job_id,
          external_work_id,
          type,
          path,
          title,
          content_type,
          size_bytes,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        artifact.id,
        artifact.runId ?? null,
        artifact.mediaJobId ?? null,
        artifact.externalWorkId ?? null,
        artifact.type,
        artifact.path,
        artifact.title ?? null,
        artifact.contentType ?? null,
        artifact.sizeBytes ?? null,
        artifact.createdAt,
      );

    const created = this.getArtifact(artifact.id);
    if (!created) {
      throw new Error(`Failed to create artifact: ${artifact.id}`);
    }
    this.tryRebuildLingThreadMetadataForRun(created.runId, created.createdAt);
    return created;
  }

  getArtifact(artifactId: string): RunArtifact | undefined {
    const row = this.database.prepare(artifactSelectSql("WHERE id = ?")).get(artifactId);
    return row ? mapArtifact(row) : undefined;
  }

  listArtifacts(runId: string): RunArtifact[] {
    return this.database
      .prepare(`${artifactSelectSql("WHERE run_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(runId)
      .map(mapArtifact);
  }

  listMediaJobArtifacts(mediaJobId: string): RunArtifact[] {
    return this.database
      .prepare(`${artifactSelectSql("WHERE media_job_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(mediaJobId)
      .map(mapArtifact);
  }

  listExternalWorkArtifacts(externalWorkId: string): RunArtifact[] {
    return this.database
      .prepare(`${artifactSelectSql("WHERE external_work_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(externalWorkId)
      .map(mapArtifact);
  }

  recoverStaleRuns(now: string): number {
    this.expireResourceLeases(now);
    const staleRuns = this.database
      .prepare("SELECT id FROM run_sessions WHERE status IN ('queued', 'running', 'waiting_for_approval')")
      .all()
      .map((row) => readString(row, "id"));

    for (const runId of staleRuns) {
      if (!this.hasTerminalEvent(runId)) {
        this.appendEvent(runId, "run_error", { message: STALE_RUN_ERROR });
      }
      this.markRunFailed(runId, now, STALE_RUN_ERROR);
      const run = this.getRun(runId);
      const thread = run?.threadId ? this.getLingThread(run.threadId) : undefined;
      if (run?.threadId && thread) {
        this.updateLingThread(
          run.threadId,
          {
            status: "failed",
            activeRunId: thread.activeRunId === run.id ? null : thread.activeRunId,
            lastRunId: run.id,
          },
          now,
        );
      }
    }

    return staleRuns.length;
  }

  recoverStaleChannelWorkflows(now: string): number {
    let recovered = 0;
    const workflows = this.listRecoverableChannelWorkflows();

    for (const workflow of workflows) {
      const steps = this.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 });
      for (const step of steps) {
        if (step.status === "running" && step.runId) {
          const run = this.getRun(step.runId);
          if (run?.status === "succeeded") {
            recovered += this.recoverWorkflowStepSucceeded(step, run, now) ? 1 : 0;
          } else if (run?.status === "failed" || run?.status === "cancelled") {
            recovered += this.recoverWorkflowStepFailed(step, run, now) ? 1 : 0;
          } else if (!run) {
            recovered += this.recoverWorkflowStepBlocked(step, "Linked run is missing after daemon restart.", now) ? 1 : 0;
          }
          continue;
        }
        if (step.status === "running" && !step.runId) {
          recovered += this.recoverWorkflowStepBlocked(step, "Daemon restarted before workflow step run started; retry required.", now) ? 1 : 0;
          continue;
        }
        if (step.status === "claimed") {
          recovered += this.recoverWorkflowClaimedStepBlocked(step, "Daemon restarted after workflow step was claimed; retry required.", now) ? 1 : 0;
          continue;
        }
        if (step.status === "waiting_for_approval" && step.metadata?.preStepApprovalId) {
          const approval = this.getApprovalRequest(step.metadata.preStepApprovalId);
          if (approval?.status === "approved") {
            recovered += this.recoverWorkflowStepBlocked(step, "Daemon restarted after approval but before workflow step run started; retry required.", now) ? 1 : 0;
          } else if (approval && approval.status !== "pending") {
            recovered += this.recoverWorkflowStepApprovalFailed(step, approval.status, approval.decisionReason ?? `Workflow step approval ${approval.status}.`, now) ? 1 : 0;
          }
        }
      }
      recovered += this.recoverWorkflowAggregateStatus(workflow.id, now);
    }

    return recovered;
  }

  private recoverWorkflowStepSucceeded(step: ChannelWorkflowStep, run: RunSession, now: string): boolean {
    const result = this.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "running",
      event: "succeed",
      actor: "system",
      reason: `startup_recovery:${run.id}`,
      now,
      taskId: step.taskId ?? run.taskId,
      runId: run.id,
      resultSummary: "Recovered from linked terminal run.",
    });
    return result.ok;
  }

  private listRecoverableChannelWorkflows(): ChannelWorkflow[] {
    return this.database
      .prepare(`${channelWorkflowSelectSql("WHERE workspace_id = ? AND status IN ('running', 'waiting_for_approval', 'blocked')")} ORDER BY updated_at ASC, rowid ASC LIMIT 500`)
      .all(DEFAULT_WORKSPACE_ID)
      .map(mapChannelWorkflow);
  }

  private recoverWorkflowStepFailed(step: ChannelWorkflowStep, run: RunSession, now: string): boolean {
    const result = this.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "running",
      event: run.status === "cancelled" ? "cancel" : "fail",
      actor: "system",
      reason: run.errorMessage ?? `startup_recovery:${run.id}`,
      now,
      taskId: step.taskId ?? run.taskId,
      runId: run.id,
      blocker: run.errorMessage ?? `Linked run ${run.status} during startup recovery.`,
    });
    return result.ok;
  }

  private recoverWorkflowClaimedStepBlocked(step: ChannelWorkflowStep, blocker: string, now: string): boolean {
    const started = this.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      reason: "startup_recovery",
      now,
      blocker: null,
    });
    if (!started.ok) {
      return false;
    }
    return this.recoverWorkflowStepBlocked({ ...step, status: "running" }, blocker, now);
  }

  private recoverWorkflowStepBlocked(step: ChannelWorkflowStep, blocker: string, now: string): boolean {
    if (step.status === "waiting_for_approval") {
      const approved = this.transitionChannelWorkflowStepStatus({
        workflowStepId: step.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_approved",
        actor: "system",
        reason: "startup_recovery",
        now,
        blocker: null,
      });
      if (!approved.ok) {
        return false;
      }
      return this.recoverWorkflowStepBlocked({ ...step, status: "running" }, blocker, now);
    }
    const result = this.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: step.status,
      event: "blocked",
      actor: "system",
      reason: blocker,
      now,
      blocker,
    });
    return result.ok;
  }

  private recoverWorkflowStepApprovalFailed(step: ChannelWorkflowStep, status: string, blocker: string, now: string): boolean {
    const result = this.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "waiting_for_approval",
      event: "fail",
      actor: "system",
      reason: blocker,
      now,
      blocker,
    });
    if (result.ok) {
      this.transitionChannelWorkflowStatus({
        workflowId: step.workflowId,
        expectedStatus: this.getChannelWorkflow(step.workflowId)?.status,
        event: "step_failed",
        actor: "system",
        reason: `approval_${status}`,
        now,
      });
    }
    return result.ok;
  }

  private recoverWorkflowAggregateStatus(workflowId: string, now: string): number {
    const workflow = this.getChannelWorkflow(workflowId);
    if (!workflow || workflow.status === "succeeded" || workflow.status === "failed" || workflow.status === "cancelled") {
      return 0;
    }
    const steps = this.listChannelWorkflowSteps({ workflowId, limit: 500 });
    if (steps.length > 0 && steps.every((step) => step.status === "succeeded" || step.status === "skipped")) {
      const result = this.transitionChannelWorkflowStatus({
        workflowId,
        expectedStatus: workflow.status,
        event: workflow.status === "waiting_for_approval" ? "approval_approved" : "all_steps_succeeded",
        actor: "system",
        reason: "startup_recovery",
        now,
      });
      if (result.ok && result.to !== "succeeded") {
        const succeeded = this.transitionChannelWorkflowStatus({
          workflowId,
          expectedStatus: "running",
          event: "all_steps_succeeded",
          actor: "system",
          reason: "startup_recovery",
          now,
        });
        return succeeded.ok ? 2 : 1;
      }
      return result.ok ? 1 : 0;
    }
    const failed = steps.find((step) => step.status === "failed" || step.status === "cancelled");
    if (failed) {
      const result = this.transitionChannelWorkflowStatus({
        workflowId,
        expectedStatus: workflow.status,
        event: "step_failed",
        actor: "system",
        reason: failed.blocker ?? "startup_recovery",
        now,
      });
      return result.ok ? 1 : 0;
    }
    const blocked = steps.find((step) => step.status === "blocked");
    if (blocked && workflow.status === "running") {
      const result = this.transitionChannelWorkflowStatus({
        workflowId,
        expectedStatus: "running",
        event: "step_blocked",
        actor: "system",
        reason: blocked.blocker ?? "startup_recovery",
        now,
      });
      return result.ok ? 1 : 0;
    }
    return 0;
  }

  listStateTransitionEvents(options: ListStateTransitionEventsOptions = {}): StateTransitionEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.entityType) {
      clauses.push("entity_type = ?");
      params.push(options.entityType);
    }
    if (options.entityId) {
      clauses.push("entity_id = ?");
      params.push(options.entityId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${stateTransitionSelectSql(whereClause)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapStateTransitionEvent);
  }

  recordStateTransitionEvent(input: CreateStateTransitionEventInput): StateTransitionEvent {
    const event: StateTransitionEvent = {
      id: createStateTransitionEventId(),
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt,
    };
    this.database
      .prepare(`
        INSERT INTO state_transition_events (
          id,
          workspace_id,
          entity_type,
          entity_id,
          from_status,
          to_status,
          event,
          actor,
          reason,
          idempotency_key,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.workspaceId,
        event.entityType,
        event.entityId,
        event.fromStatus,
        event.toStatus,
        event.event,
        event.actor,
        event.reason ?? null,
        event.idempotencyKey ?? null,
        event.createdAt,
      );
    return event;
  }

  findStateTransitionByIdempotency(
    entityType: StateTransitionEvent["entityType"],
    entityId: string,
    idempotencyKey: string,
  ): StateTransitionEvent | undefined {
    const row = this.database
      .prepare(stateTransitionSelectSql("WHERE entity_type = ? AND entity_id = ? AND idempotency_key = ?"))
      .get(entityType, entityId, idempotencyKey);
    return row ? mapStateTransitionEvent(row) : undefined;
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
    const run = this.getRun(input.runId);
    if (!run) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.findStateTransitionByIdempotency("run", input.runId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: run.status, to: run.status, duplicate: true };
      }
    }

    const result = transitionRun({
      entityId: input.runId,
      currentStatus: run.status,
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
        UPDATE run_sessions
        SET
          status = ?,
          started_at = ?,
          ended_at = ?,
          error_message = ?,
          summary_path = ?,
          updated_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        result.to,
        input.startedAt ?? run.startedAt ?? null,
        input.endedAt === undefined ? run.endedAt ?? null : input.endedAt,
        input.errorMessage === undefined ? run.errorMessage ?? null : input.errorMessage,
        input.summaryPath ?? run.summaryPath ?? null,
        input.now,
        input.runId,
        result.from,
      );
    if (Number(update.changes) === 0) {
      const current = this.getRun(input.runId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? run.status };
    }

    this.recordStateTransitionEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entityType: "run",
      entityId: input.runId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    this.reconcileLingTurnStatusForRun(input.runId, input.now);
    this.tryRebuildLingThreadMetadata(run.threadId, input.now);
    return result;
  }

  acquireResourceLease(input: CreateResourceLeaseInput): ResourceLease | undefined {
    const lease: ResourceLease = {
      id: createResourceLeaseId(),
      workspaceId: input.workspaceId,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      status: "active",
      acquiredAt: input.acquiredAt,
      expiresAt: input.expiresAt,
      lastRenewedAt: input.lastRenewedAt ?? input.acquiredAt,
      workUnitId: input.workUnitId,
      attemptId: input.attemptId,
    };
    try {
      this.database
        .prepare(`
          INSERT INTO resource_leases (
            id,
            workspace_id,
            resource_type,
            resource_key,
            owner_type,
            owner_id,
            status,
            acquired_at,
            expires_at,
            last_renewed_at,
            released_at,
            release_reason,
            work_unit_id,
            attempt_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          lease.id,
          lease.workspaceId,
          lease.resourceType,
          lease.resourceKey,
          lease.ownerType,
          lease.ownerId,
          lease.status,
          lease.acquiredAt,
          lease.expiresAt,
          lease.lastRenewedAt ?? lease.acquiredAt,
          null,
          null,
          lease.workUnitId ?? null,
          lease.attemptId ?? null,
        );
      return lease;
    } catch {
      return undefined;
    }
  }

  releaseResourceLeasesForOwner(ownerType: ResourceLeaseOwnerType, ownerId: string, releasedAt: string): number {
    const result = this.database
      .prepare(`
        UPDATE resource_leases
        SET status = 'released', released_at = ?, release_reason = COALESCE(release_reason, 'released')
        WHERE owner_type = ? AND owner_id = ? AND status = 'active'
      `)
      .run(releasedAt, ownerType, ownerId);
    return Number(result.changes);
  }

  expireResourceLeases(now: string): number {
    const result = this.database
      .prepare(`
        UPDATE resource_leases
        SET status = 'expired', released_at = ?, release_reason = COALESCE(release_reason, 'expired')
        WHERE status = 'active' AND expires_at <= ?
      `)
      .run(now, now);
    return Number(result.changes);
  }

  listResourceLeases(options: ListResourceLeasesOptions = {}): ResourceLease[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.ownerType) {
      clauses.push("owner_type = ?");
      params.push(options.ownerType);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.resourceType) {
      clauses.push("resource_type = ?");
      params.push(options.resourceType);
    }
    if (options.resourceKey) {
      clauses.push("resource_key = ?");
      params.push(options.resourceKey);
    }
    if (options.workUnitId) {
      clauses.push("work_unit_id = ?");
      params.push(options.workUnitId);
    }
    if (options.attemptId) {
      clauses.push("attempt_id = ?");
      params.push(options.attemptId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${resourceLeaseSelectSql(whereClause)} ORDER BY acquired_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapResourceLease);
  }

  getBlockingResourceLease(resourceType: ResourceLease["resourceType"], resourceKey: string): ResourceLease | undefined {
    const row = this.database
      .prepare(resourceLeaseSelectSql("WHERE workspace_id = ? AND resource_type = ? AND resource_key = ? AND status = 'active'"))
      .get(DEFAULT_WORKSPACE_ID, resourceType, resourceKey);
    return row ? mapResourceLease(row) : undefined;
  }

  getWorkspaceSettings(): WorkspaceSettings {
    const row = this.database
      .prepare("SELECT settings_json, updated_at FROM workspace_settings WHERE workspace_id = ?")
      .get(DEFAULT_WORKSPACE_ID);
    if (!row) {
      return createDefaultWorkspaceSettings(new Date().toISOString());
    }
    return parseWorkspaceSettings(readString(row as Record<string, SQLOutputValue>, "settings_json"), readString(row as Record<string, SQLOutputValue>, "updated_at"));
  }

  updateWorkspaceSettings(input: UpdateWorkspaceSettingsInput, now: string): WorkspaceSettings {
    const current = this.getWorkspaceSettings();
    const next: WorkspaceSettings = omitUndefined({
      schemaVersion: 1 as const,
      workspaceCwd: nullableUpdate(input.workspaceCwd, current.workspaceCwd),
      theme: nullableUpdate(input.theme, current.theme),
      locale: nullableUpdate(input.locale, current.locale),
      responseLanguage: nullableUpdate(input.responseLanguage, current.responseLanguage),
      channelNotifications: nullableUpdate(input.channelNotifications, current.channelNotifications),
      channelActivityViews: nullableUpdate(input.channelActivityViews, current.channelActivityViews),
      updatedAt: now,
    });
    this.database
      .prepare(`
        INSERT INTO workspace_settings (workspace_id, settings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `)
      .run(DEFAULT_WORKSPACE_ID, stringifyJson(next), now, now);
    return this.getWorkspaceSettings();
  }

  createChannel(input: CreateChannelInput, now: string): Channel {
    const channel: Channel = {
      id: input.id ?? createChannelId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: input.name,
      status: input.status ?? "active",
      boundPath: input.boundPath,
      workspaceBinding: input.workspaceBinding,
      defaultProviderPresetId: input.defaultProviderPresetId,
      defaultTeammateId: input.defaultTeammateId,
      autoReplyMode: input.autoReplyMode ?? "mentions_only",
      responseLanguage: input.responseLanguage,
      allowedTools: input.allowedTools ?? [...readOnlyRunTools],
      runtimePolicy: normalizeChannelRuntimePolicy(input.runtimePolicy),
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channels (
          id,
          workspace_id,
          name,
          status,
          bound_path,
          default_provider_preset_id,
          default_teammate_id,
          auto_reply_mode,
          response_language,
          allowed_tools_json,
          runtime_policy_json,
          workspace_binding_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        channel.id,
        channel.workspaceId,
        channel.name,
        channel.status,
        channel.boundPath ?? null,
        channel.defaultProviderPresetId ?? null,
        channel.defaultTeammateId ?? null,
        channel.autoReplyMode,
        channel.responseLanguage ?? null,
        stringifyJson(channel.allowedTools),
        stringifyJson(channel.runtimePolicy),
        channel.workspaceBinding ? stringifyJson(channel.workspaceBinding) : null,
        channel.createdAt,
        channel.updatedAt,
      );

    const created = this.getChannel(channel.id);
    if (!created) {
      throw new Error(`Failed to create channel: ${channel.id}`);
    }
    return created;
  }

  getChannel(id: string): Channel | undefined {
    const row = this.database.prepare(channelSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannel(row) : undefined;
  }

  listChannels(options: ListChannelsOptions = {}): Channel[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.database
      .prepare(`${channelSelectSql("WHERE workspace_id = ?")} ORDER BY created_at DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, limit)
      .map(mapChannel);
  }

  updateChannel(id: string, input: ChannelUpdateInput, now: string): Channel | undefined {
    const existing = this.getChannel(id);
    if (!existing) {
      return undefined;
    }

    const next: Channel = {
      ...existing,
      name: input.name ?? existing.name,
      status: input.status ?? existing.status,
      boundPath: nullableUpdate(input.boundPath, existing.boundPath),
      workspaceBinding: nullableUpdate(input.workspaceBinding, existing.workspaceBinding),
      defaultProviderPresetId: nullableUpdate(input.defaultProviderPresetId, existing.defaultProviderPresetId),
      defaultTeammateId: nullableUpdate(input.defaultTeammateId, existing.defaultTeammateId),
      autoReplyMode: input.autoReplyMode === null ? "mentions_only" : input.autoReplyMode ?? existing.autoReplyMode,
      responseLanguage: nullableUpdate(input.responseLanguage, existing.responseLanguage),
      allowedTools: input.allowedTools ?? existing.allowedTools,
      runtimePolicy: input.runtimePolicy ? normalizeChannelRuntimePolicy({ ...existing.runtimePolicy, ...input.runtimePolicy }) : existing.runtimePolicy,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE channels
        SET
          name = ?,
          status = ?,
          bound_path = ?,
          default_provider_preset_id = ?,
          default_teammate_id = ?,
          auto_reply_mode = ?,
          response_language = ?,
          allowed_tools_json = ?,
          runtime_policy_json = ?,
          workspace_binding_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.name,
        next.status,
        next.boundPath ?? null,
        next.defaultProviderPresetId ?? null,
        next.defaultTeammateId ?? null,
        next.autoReplyMode,
        next.responseLanguage ?? null,
        stringifyJson(next.allowedTools),
        stringifyJson(next.runtimePolicy),
        next.workspaceBinding ? stringifyJson(next.workspaceBinding) : null,
        next.updatedAt,
        id,
      );

    return this.getChannel(id);
  }

  deleteChannel(id: string): boolean {
    const result = this.database.prepare("DELETE FROM channels WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createTask(input: CreateTaskInput, now: string): Task {
    const task: Task = {
      id: createTaskId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      title: input.title,
      prompt: input.prompt,
      status: input.status ?? "todo",
      assigneeTeammateId: input.assigneeTeammateId,
      requestedSkillId: input.requestedSkillId,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO tasks (
          id,
          workspace_id,
          channel_id,
          title,
          prompt,
          status,
          assignee_teammate_id,
          requested_skill_id,
          current_run_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.workspaceId,
        task.channelId,
        task.title,
        task.prompt,
        task.status,
        task.assigneeTeammateId ?? null,
        task.requestedSkillId ?? null,
        task.currentRunId ?? null,
        task.createdAt,
        task.updatedAt,
      );

    const created = this.getTask(task.id);
    if (!created) {
      throw new Error(`Failed to create task: ${task.id}`);
    }
    return created;
  }

  getTask(id: string): Task | undefined {
    const row = this.database.prepare(taskSelectSql("WHERE id = ?")).get(id);
    return row ? mapTask(row) : undefined;
  }

  listTasks(options: ListTasksOptions = {}): Task[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.assigneeTeammateId) {
      clauses.push("assignee_teammate_id = ?");
      params.push(options.assigneeTeammateId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${taskSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapTask);
  }

  updateTask(id: string, input: TaskUpdateInput, now: string): Task | undefined {
    const existing = this.getTask(id);
    if (!existing) {
      return undefined;
    }

    const next: Task = {
      ...existing,
      channelId: input.channelId ?? existing.channelId,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      status: input.status ?? existing.status,
      assigneeTeammateId: nullableUpdate(input.assigneeTeammateId, existing.assigneeTeammateId),
      requestedSkillId: nullableUpdate(input.requestedSkillId, existing.requestedSkillId),
      currentRunId: nullableUpdate(input.currentRunId, existing.currentRunId),
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE tasks
        SET
          channel_id = ?,
          title = ?,
          prompt = ?,
          status = ?,
          assignee_teammate_id = ?,
          requested_skill_id = ?,
          current_run_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.channelId,
        next.title,
        next.prompt,
        next.status,
        next.assigneeTeammateId ?? null,
        next.requestedSkillId ?? null,
        next.currentRunId ?? null,
        next.updatedAt,
        id,
      );

    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const result = this.database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createAiTeammate(input: CreateAiTeammateInput, now: string): AiTeammate {
    const teammate: AiTeammate = {
      id: input.id ?? createAiTeammateId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      templateId: input.templateId,
      roleKey: input.roleKey,
      displayName: input.displayName,
      description: input.description,
      avatarTone: input.avatarTone,
      avatarImageAttachmentId: input.avatarImageAttachmentId,
      providerPresetId: input.providerPresetId,
      runnerId: normalizeStoredRunnerId(input.runnerId),
      systemPrompt: input.systemPrompt,
      appendSystemPrompt: input.appendSystemPrompt ?? [],
      allowedTools: input.allowedTools ?? [...readOnlyRunTools],
      approvalProfile: input.approvalProfile,
      status: input.status ?? "active",
      pinned: input.pinned ?? false,
      hidden: input.hidden ?? false,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO ai_teammates (
          id,
          workspace_id,
          template_id,
          role_key,
          display_name,
          description,
          avatar_tone,
          avatar_image_attachment_id,
          provider_preset_id,
          runner_id,
          system_prompt,
          append_system_prompt_json,
          allowed_tools_json,
          approval_profile_json,
          status,
          pinned,
          hidden,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        teammate.id,
        teammate.workspaceId,
        teammate.templateId ?? null,
        teammate.roleKey,
        teammate.displayName,
        teammate.description,
        teammate.avatarTone ?? null,
        teammate.avatarImageAttachmentId ?? null,
        teammate.providerPresetId ?? null,
        teammate.runnerId ?? null,
        teammate.systemPrompt ?? null,
        stringifyJson(teammate.appendSystemPrompt),
        stringifyJson(teammate.allowedTools),
        stringifyJson(teammate.approvalProfile),
        teammate.status,
        teammate.pinned ? 1 : 0,
        teammate.hidden ? 1 : 0,
        teammate.createdAt,
        teammate.updatedAt,
      );

    const created = this.getAiTeammate(teammate.id);
    if (!created) {
      throw new Error(`Failed to create AI teammate: ${teammate.id}`);
    }
    return created;
  }

  getAiTeammate(id: string): AiTeammate | undefined {
    const row = this.database.prepare(aiTeammateSelectSql("WHERE id = ?")).get(id);
    return row ? mapAiTeammate(row) : undefined;
  }

  listAiTeammates(options: ListAiTeammatesOptions = {}): AiTeammate[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (!options.includeDisabled) {
      clauses.push("status != 'disabled'");
    }
    if (!options.includeHidden) {
      clauses.push("hidden = 0");
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${aiTeammateSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY pinned DESC, display_name ASC, created_at ASC LIMIT ?`)
      .all(...params)
      .map(mapAiTeammate);
  }

  updateAiTeammate(id: string, input: AiTeammateUpdateInput, now: string): AiTeammate | undefined {
    const existing = this.getAiTeammate(id);
    if (!existing) {
      return undefined;
    }
    if (input.avatarImageAttachmentId !== undefined && input.avatarImageAttachmentId !== null) {
      const avatar = this.getTeammatePrivateAttachment(input.avatarImageAttachmentId);
      if (!avatar || avatar.teammateId !== id || avatar.scope !== "teammate_profile_avatar" || avatar.kind !== "image") {
        throw new Error(`Avatar image attachment does not belong to teammate profile: ${input.avatarImageAttachmentId}`);
      }
    }

    const next: AiTeammate = {
      ...existing,
      templateId: nullableUpdate(input.templateId, existing.templateId),
      roleKey: input.roleKey ?? existing.roleKey,
      displayName: input.displayName ?? existing.displayName,
      description: input.description ?? existing.description,
      avatarTone: nullableUpdate(input.avatarTone, existing.avatarTone),
      avatarImageAttachmentId: nullableUpdate(input.avatarImageAttachmentId, existing.avatarImageAttachmentId),
      providerPresetId: nullableUpdate(input.providerPresetId, existing.providerPresetId),
      runnerId: normalizeStoredRunnerId(nullableUpdate(input.runnerId, existing.runnerId)),
      systemPrompt: nullableUpdate(input.systemPrompt, existing.systemPrompt),
      appendSystemPrompt: input.appendSystemPrompt ?? existing.appendSystemPrompt,
      allowedTools: input.allowedTools ?? existing.allowedTools,
      approvalProfile: input.approvalProfile ?? existing.approvalProfile,
      status: input.status ?? existing.status,
      pinned: input.pinned ?? existing.pinned,
      hidden: input.hidden ?? existing.hidden,
      updatedAt: now,
    };

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
          provider_preset_id = ?,
          runner_id = ?,
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
        next.providerPresetId ?? null,
        next.runnerId ?? null,
        next.systemPrompt ?? null,
        stringifyJson(next.appendSystemPrompt),
        stringifyJson(next.allowedTools),
        stringifyJson(next.approvalProfile),
        next.status,
        next.pinned ? 1 : 0,
        next.hidden ? 1 : 0,
        next.updatedAt,
        id,
      );

    return this.getAiTeammate(id);
  }

  disableAiTeammate(id: string, now: string): AiTeammate | undefined {
    return this.updateAiTeammate(id, { status: "disabled", hidden: true }, now);
  }

  hardDeleteAiTeammate(id: string, input: HardDeleteAiTeammateInput, now: string): HardDeleteAiTeammateResult | undefined {
    const teammate = this.getAiTeammate(id);
    if (!teammate) {
      return undefined;
    }
    const privateAttachmentRows = this.database
      .prepare("SELECT path FROM teammate_private_attachments WHERE workspace_id = ? AND teammate_id = ?")
      .all(DEFAULT_WORKSPACE_ID, id) as Record<string, SQLOutputValue>[];
    const deletedAttachmentPaths = privateAttachmentRows.map((row) => readString(row, "path"));
    const memoryRows = this.database
      .prepare("SELECT id FROM memory_objects WHERE workspace_id = ? AND scope_type = 'teammate' AND owner_id = ?")
      .all(DEFAULT_WORKSPACE_ID, id) as Record<string, SQLOutputValue>[];
    const memoryIds = memoryRows.map((row) => readString(row, "id"));
    const usedMemoryRows = this.database
      .prepare("SELECT id, memory_ids_json, teammate_id FROM memory_used_events WHERE workspace_id = ?")
      .all(DEFAULT_WORKSPACE_ID) as Record<string, SQLOutputValue>[];
    const usedMemoryEventIds = usedMemoryRows
      .filter((row) => {
        if (readNullableString(row, "teammate_id") === id) {
          return true;
        }
        const eventMemoryIds = parseJsonStringArray(readString(row, "memory_ids_json"));
        return memoryIds.some((memoryId) => eventMemoryIds.includes(memoryId));
      })
      .map((row) => readString(row, "id"));
    const directThreadCount = countWhere(this.database, "teammate_direct_threads", "teammate_id = ?", [id]);
    const directMessageCount = countWhere(this.database, "teammate_direct_messages", "teammate_id = ?", [id]);
    const privateAttachmentCount = countWhere(this.database, "teammate_private_attachments", "teammate_id = ?", [id]);
    const channelMembershipCount = countWhere(this.database, "teammate_channel_memberships", "teammate_id = ?", [id]);
    const skillBindingCount = countWhere(this.database, "teammate_skill_bindings", "teammate_id = ?", [id]);
    const memoryScopeCount = countWhere(this.database, "teammate_memory_scopes", "teammate_id = ?", [id]);
    const mcpBindingCount = countWhere(this.database, "teammate_mcp_bindings", "teammate_id = ?", [id]);
    const channelDefaultCount = countWhere(this.database, "channels", "default_teammate_id = ?", [id]);
    const taskAssigneeCount = countWhere(this.database, "tasks", "assignee_teammate_id = ?", [id]);
    const runSessionCount = countWhere(this.database, "run_sessions", "teammate_id = ?", [id]);
    const tombstone = {
      id: createRetentionTombstoneId(),
      workspaceId: teammate.workspaceId,
      entityType: "ai-teammate" as const,
      entityId: id,
      reason: input.reason,
      deletedCounts: {
        aiTeammates: 1,
        directThreads: directThreadCount,
        directMessages: directMessageCount,
        privateAttachments: privateAttachmentCount,
        memoryObjects: memoryIds.length,
        usedMemoryEvents: usedMemoryEventIds.length,
        channelMemberships: channelMembershipCount,
        skillBindings: skillBindingCount,
        memoryScopes: memoryScopeCount,
        mcpBindings: mcpBindingCount,
        channelDefaultsCleared: channelDefaultCount,
        taskAssigneesCleared: taskAssigneeCount,
        runTeammateRefsCleared: runSessionCount,
      },
      createdAt: now,
    };

    this.database.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.database
        .prepare(`
          INSERT INTO retention_tombstones (
            id,
            workspace_id,
            entity_type,
            entity_id,
            reason,
            deleted_counts_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          tombstone.id,
          tombstone.workspaceId,
          tombstone.entityType,
          tombstone.entityId,
          tombstone.reason ?? null,
          stringifyJson(tombstone.deletedCounts),
          tombstone.createdAt,
        );
      for (const eventId of usedMemoryEventIds) {
        this.database.prepare("DELETE FROM memory_used_events WHERE id = ?").run(eventId);
      }
      this.database.prepare("DELETE FROM memory_objects WHERE workspace_id = ? AND scope_type = 'teammate' AND owner_id = ?").run(DEFAULT_WORKSPACE_ID, id);
      this.database.prepare("DELETE FROM teammate_private_attachments WHERE teammate_id = ?").run(id);
      this.database.prepare("DELETE FROM teammate_direct_messages WHERE teammate_id = ?").run(id);
      this.database.prepare("DELETE FROM teammate_direct_threads WHERE teammate_id = ?").run(id);
      this.database.prepare("DELETE FROM teammate_channel_memberships WHERE teammate_id = ?").run(id);
      this.database.prepare("DELETE FROM teammate_skill_bindings WHERE teammate_id = ?").run(id);
      this.database.prepare("DELETE FROM teammate_memory_scopes WHERE teammate_id = ?").run(id);
      this.database.prepare("DELETE FROM teammate_mcp_bindings WHERE teammate_id = ?").run(id);
      this.database.prepare("UPDATE channels SET default_teammate_id = NULL, updated_at = ? WHERE default_teammate_id = ?").run(now, id);
      this.database.prepare("UPDATE tasks SET assignee_teammate_id = NULL, updated_at = ? WHERE assignee_teammate_id = ?").run(now, id);
      this.database.prepare("UPDATE run_sessions SET teammate_id = NULL, updated_at = ? WHERE teammate_id = ?").run(now, id);
      this.database.prepare("DELETE FROM ai_teammates WHERE id = ?").run(id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { tombstone, deletedAttachmentPaths };
  }

  listTeammateChannelMemberships(teammateId: string): TeammateChannelMembership[] {
    return this.database
      .prepare(`${teammateChannelMembershipSelectSql("WHERE teammate_id = ?")} ORDER BY created_at ASC`)
      .all(teammateId)
      .map(mapTeammateChannelMembership);
  }

  replaceTeammateChannelMemberships(
    teammateId: string,
    memberships: readonly ReplaceTeammateChannelMembershipInput[],
    now: string,
  ): TeammateChannelMembership[] {
    if (!this.getAiTeammate(teammateId)) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }

    const normalized = dedupeMembershipInputs(memberships);
    for (const membership of normalized) {
      if (!this.getChannel(membership.channelId)) {
        throw new Error(`Channel not found: ${membership.channelId}`);
      }
    }

    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM teammate_channel_memberships WHERE teammate_id = ?").run(teammateId);
      this.database.prepare("UPDATE channels SET default_teammate_id = NULL, updated_at = ? WHERE default_teammate_id = ?").run(now, teammateId);
      const insert = this.database.prepare(`
        INSERT INTO teammate_channel_memberships (
          teammate_id,
          channel_id,
          is_default,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const membership of normalized) {
        insert.run(teammateId, membership.channelId, membership.isDefault ? 1 : 0, now, now);
        if (membership.isDefault) {
          this.database.prepare("UPDATE channels SET default_teammate_id = ?, updated_at = ? WHERE id = ?").run(teammateId, now, membership.channelId);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return this.listTeammateChannelMemberships(teammateId);
  }

  listTeammateSkillBindings(teammateId: string): TeammateSkillBinding[] {
    return this.database
      .prepare(`${teammateSkillBindingSelectSql("WHERE teammate_id = ?")} ORDER BY skill_id ASC`)
      .all(teammateId)
      .map(mapTeammateSkillBinding);
  }

  replaceTeammateSkillBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateSkillBindingInput[],
    now: string,
  ): TeammateSkillBinding[] {
    const teammate = this.getAiTeammate(teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }

    const existing = this.listTeammateSkillBindings(teammateId);
    const normalized = protectDefaultSkillBindings(teammate, existing, dedupeSkillBindingInputs(bindings));
    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM teammate_skill_bindings WHERE teammate_id = ?").run(teammateId);
      const insert = this.database.prepare(`
        INSERT INTO teammate_skill_bindings (
          teammate_id,
          skill_id,
          source,
          enabled,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const binding of normalized) {
        insert.run(teammateId, binding.skillId, binding.source ?? "user", binding.enabled === false ? 0 : 1, now, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return this.listTeammateSkillBindings(teammateId);
  }

  listSkillRegistryEntries(options: ListSkillRegistryOptions = {}): SkillRegistryEntry[] {
    const conditions = ["workspace_id = ?"];
    const params: string[] = [DEFAULT_WORKSPACE_ID];
    if (!options.includeArchived) {
      conditions.push("review_status != 'archived'");
    }
    if (!options.includeDisabled) {
      conditions.push("review_status != 'disabled'");
    }
    return this.database
      .prepare(`${skillRegistryEntrySelectSql(`WHERE ${conditions.join(" AND ")}`)} ORDER BY source ASC, id ASC`)
      .all(...params)
      .map(mapSkillRegistryEntry);
  }

  getSkillRegistryEntry(id: string): SkillRegistryEntry | undefined {
    const row = this.database
      .prepare(skillRegistryEntrySelectSql("WHERE workspace_id = ? AND id = ?"))
      .get(DEFAULT_WORKSPACE_ID, id);
    return row ? mapSkillRegistryEntry(row as Record<string, SQLOutputValue>) : undefined;
  }

  createSkillImportDraft(input: CreateSkillImportDraftInput, now: string): SkillImportDraft {
    const id = input.id ?? createSkillImportDraftId();
    const draft: SkillImportDraft = omitUndefined({
      id,
      workspaceId: DEFAULT_WORKSPACE_ID,
      source: input.source,
      sourcePath: input.sourcePath,
      packId: input.packId,
      name: input.name,
      version: input.version,
      description: input.description,
      definitions: input.definitions,
      warnings: input.warnings ?? [],
      createdAt: now,
      updatedAt: now,
    });
    this.database
      .prepare(`
        INSERT INTO skill_import_drafts (
          id,
          workspace_id,
          source,
          source_path,
          draft_json,
          warnings_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        draft.id,
        DEFAULT_WORKSPACE_ID,
        draft.source,
        draft.sourcePath ?? null,
        stringifyJson({
          packId: draft.packId,
          name: draft.name,
          version: draft.version,
          description: draft.description,
          definitions: draft.definitions,
        }),
        stringifyJson(draft.warnings),
        now,
        now,
      );
    return draft;
  }

  getSkillImportDraft(id: string): SkillImportDraft | undefined {
    const row = this.database
      .prepare(skillImportDraftSelectSql("WHERE workspace_id = ? AND id = ?"))
      .get(DEFAULT_WORKSPACE_ID, id);
    return row ? mapSkillImportDraft(row as Record<string, SQLOutputValue>) : undefined;
  }

  publishSkillImportDraft(id: string, now: string): SkillRegistryEntry[] {
    const draft = this.getSkillImportDraft(id);
    if (!draft) {
      throw new Error(`Skill import draft not found: ${id}`);
    }
    const allWarnings = [
      ...draft.warnings,
      ...draft.definitions.flatMap((definition) => definition.warnings ?? []),
    ];
    if (allWarnings.some((warning) => warning.severity === "error")) {
      throw new Error("Skill import draft has error warnings and cannot be published");
    }
    const packId = draft.packId ?? createSkillPackId();
    this.database.exec("BEGIN");
    try {
      this.database
        .prepare(`
          INSERT INTO skill_packs (
            id,
            workspace_id,
            source,
            name,
            version,
            description,
            source_path,
            checksum,
            review_status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source = excluded.source,
            name = excluded.name,
            version = excluded.version,
            description = excluded.description,
            source_path = excluded.source_path,
            checksum = excluded.checksum,
            review_status = excluded.review_status,
            updated_at = excluded.updated_at
        `)
        .run(
          packId,
          DEFAULT_WORKSPACE_ID,
          draft.source,
          draft.name,
          draft.version ?? null,
          draft.description,
          draft.sourcePath ?? null,
          null,
          "published",
          now,
          now,
        );
      const insertDefinition = this.database.prepare(`
        INSERT INTO skill_definitions (
          id,
          workspace_id,
          pack_id,
          source,
          source_path,
          version,
          checksum,
          definition_json,
          visibility_json,
          review_status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          pack_id = excluded.pack_id,
          source = excluded.source,
          source_path = excluded.source_path,
          version = excluded.version,
          checksum = excluded.checksum,
          definition_json = excluded.definition_json,
          visibility_json = excluded.visibility_json,
          review_status = excluded.review_status,
          updated_at = excluded.updated_at
      `);
      for (const item of draft.definitions) {
        insertDefinition.run(
          item.definition.id,
          DEFAULT_WORKSPACE_ID,
          packId,
          draft.source,
          draft.sourcePath ?? null,
          draft.version ?? null,
          null,
          stringifyJson(item.definition),
          stringifyJson(item.visibility ?? defaultSkillVisibility()),
          "published",
          now,
          now,
        );
      }
      this.database
        .prepare("UPDATE skill_import_drafts SET updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(now, DEFAULT_WORKSPACE_ID, id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return draft.definitions
      .map((item) => this.getSkillRegistryEntry(item.definition.id))
      .filter((entry): entry is SkillRegistryEntry => Boolean(entry));
  }

  archiveSkillRegistryEntry(id: string, now: string): SkillRegistryEntry | undefined {
    const existing = this.getSkillRegistryEntry(id);
    if (!existing) {
      return undefined;
    }
    this.database
      .prepare("UPDATE skill_definitions SET review_status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, DEFAULT_WORKSPACE_ID, id);
    return this.getSkillRegistryEntry(id);
  }

  listTeammateMemoryScopes(teammateId: string): TeammateMemoryScope[] {
    return this.database
      .prepare(`${teammateMemoryScopeSelectSql("WHERE teammate_id = ?")} ORDER BY created_at ASC`)
      .all(teammateId)
      .map(mapTeammateMemoryScope);
  }

  replaceTeammateMemoryScopes(
    teammateId: string,
    scopes: readonly ReplaceTeammateMemoryScopeInput[],
    now: string,
  ): TeammateMemoryScope[] {
    if (!this.getAiTeammate(teammateId)) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    for (const scope of scopes) {
      if (scope.channelId && !this.getChannel(scope.channelId)) {
        throw new Error(`Channel not found: ${scope.channelId}`);
      }
    }

    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM teammate_memory_scopes WHERE teammate_id = ?").run(teammateId);
      const insert = this.database.prepare(`
        INSERT INTO teammate_memory_scopes (
          id,
          teammate_id,
          kind,
          channel_id,
          enabled,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const scope of scopes) {
        insert.run(scope.id ?? createTeammateMemoryScopeId(), teammateId, scope.kind, scope.channelId ?? null, scope.enabled === false ? 0 : 1, now, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return this.listTeammateMemoryScopes(teammateId);
  }

  createMemoryConsolidationJob(input: CreateMemoryConsolidationJobInput, now: string): MemoryConsolidationJob {
    const id = input.id ?? createMemoryConsolidationJobId();
    const job: MemoryConsolidationJob = {
      id,
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      kind: input.kind,
      sourceRefs: normalizeMemorySourceRefs(input.sourceRefs ?? []),
      status: input.status ?? "queued",
      createdCandidateIds: normalizeStringList(input.createdCandidateIds ?? []),
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };
    validateMemoryConsolidationJob(job);
    this.database
      .prepare(`
        INSERT INTO memory_consolidation_jobs (
          id,
          workspace_id,
          kind,
          source_refs_json,
          status,
          created_candidate_ids_json,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        job.id,
        job.workspaceId,
        job.kind,
        stringifyJson(job.sourceRefs),
        job.status,
        stringifyJson(job.createdCandidateIds),
        job.errorMessage ?? null,
        job.createdAt,
        job.updatedAt,
      );
    const created = this.getMemoryConsolidationJob(job.id);
    if (!created) {
      throw new Error(`Failed to create memory consolidation job: ${job.id}`);
    }
    return created;
  }

  getMemoryConsolidationJob(id: string): MemoryConsolidationJob | undefined {
    const row = this.database.prepare(memoryConsolidationJobSelectSql("WHERE id = ?")).get(id);
    return row ? mapMemoryConsolidationJob(row as Record<string, SQLOutputValue>) : undefined;
  }

  listMemoryConsolidationJobs(options: ListMemoryConsolidationJobsOptions = {}): MemoryConsolidationJob[] {
    const clauses: string[] = ["workspace_id = ?"];
    const params: (string | number)[] = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${memoryConsolidationJobSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapMemoryConsolidationJob(row as Record<string, SQLOutputValue>));
  }

  updateMemoryConsolidationJob(id: string, input: UpdateMemoryConsolidationJobInput, now: string): MemoryConsolidationJob | undefined {
    const existing = this.getMemoryConsolidationJob(id);
    if (!existing) {
      return undefined;
    }
    const next: MemoryConsolidationJob = {
      ...existing,
      sourceRefs: input.sourceRefs ? normalizeMemorySourceRefs(input.sourceRefs) : existing.sourceRefs,
      status: input.status ?? existing.status,
      createdCandidateIds: input.createdCandidateIds ? normalizeStringList(input.createdCandidateIds) : existing.createdCandidateIds,
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
      updatedAt: now,
    };
    validateMemoryConsolidationJob(next);
    this.database
      .prepare(`
        UPDATE memory_consolidation_jobs
        SET
          source_refs_json = ?,
          status = ?,
          created_candidate_ids_json = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        stringifyJson(next.sourceRefs),
        next.status,
        stringifyJson(next.createdCandidateIds),
        next.errorMessage ?? null,
        next.updatedAt,
        id,
      );
    return this.getMemoryConsolidationJob(id);
  }

  createMemoryObject(input: CreateMemoryObjectInput, now: string): MemoryObject {
    const id = input.id ?? createMemoryObjectId();
    const memory: MemoryObject = {
      id,
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      scopeType: input.scopeType,
      ownerId: input.ownerId,
      title: input.title,
      body: input.body,
      tags: normalizeStringList(input.tags ?? []),
      sourceRefs: ensureMemorySourceRefs(id, normalizeMemorySourceRefs(input.sourceRefs ?? [])),
      reviewState: input.reviewState ?? "active",
      enabled: input.enabled ?? true,
      sensitivity: input.sensitivity ?? "normal",
      verifyBeforeUse: input.verifyBeforeUse ?? false,
      retrievalProviderId: input.retrievalProviderId,
      retrievalHandle: input.retrievalHandle,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    validateMemoryObject(memory);

    this.database
      .prepare(`
        INSERT INTO memory_objects (
          id,
          workspace_id,
          scope_type,
          owner_id,
          title,
          body,
          tags_json,
          source_refs_json,
          review_state,
          enabled,
          sensitivity,
          verify_before_use,
          retrieval_provider_id,
          retrieval_handle,
          created_by,
          created_at,
          updated_at,
          last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        memory.id,
        memory.workspaceId,
        memory.scopeType,
        memory.ownerId,
        memory.title,
        memory.body,
        stringifyJson(memory.tags),
        stringifyJson(memory.sourceRefs),
        memory.reviewState,
        memory.enabled ? 1 : 0,
        memory.sensitivity,
        memory.verifyBeforeUse ? 1 : 0,
        memory.retrievalProviderId ?? null,
        memory.retrievalHandle ?? null,
        memory.createdBy ?? null,
        memory.createdAt,
        memory.updatedAt,
        memory.lastUsedAt ?? null,
      );

    const created = this.getMemoryObject(memory.id);
    if (!created) {
      throw new Error(`Failed to create memory object: ${memory.id}`);
    }
    return created;
  }

  getMemoryObject(id: string): MemoryObject | undefined {
    const row = this.database.prepare(memoryObjectSelectSql("WHERE id = ?")).get(id);
    return row ? mapMemoryObject(row) : undefined;
  }

  listMemoryObjects(options: ListMemoryObjectsOptions = {}): MemoryObject[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    clauses.push("workspace_id = ?");
    params.push(options.workspaceId ?? DEFAULT_WORKSPACE_ID);
    if (options.scopeType) {
      clauses.push("scope_type = ?");
      params.push(options.scopeType);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.reviewState) {
      clauses.push("review_state = ?");
      params.push(options.reviewState);
    }
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    if (options.sensitivity) {
      clauses.push("sensitivity = ?");
      params.push(options.sensitivity);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const memories = this.database
      .prepare(`${memoryObjectSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapMemoryObject);
    if (!options.tag) {
      return memories;
    }
    const tag = options.tag.toLowerCase();
    return memories.filter((memory) => memory.tags.some((item) => item.toLowerCase() === tag));
  }

  updateMemoryObject(id: string, input: MemoryObjectUpdateInput, now: string): MemoryObject | undefined {
    const existing = this.getMemoryObject(id);
    if (!existing) {
      return undefined;
    }
    const next: MemoryObject = {
      ...existing,
      scopeType: input.scopeType ?? existing.scopeType,
      ownerId: input.ownerId ?? existing.ownerId,
      title: input.title ?? existing.title,
      body: input.body ?? existing.body,
      tags: input.tags ? normalizeStringList(input.tags) : existing.tags,
      sourceRefs: input.sourceRefs ? ensureMemorySourceRefs(existing.id, normalizeMemorySourceRefs(input.sourceRefs)) : existing.sourceRefs,
      reviewState: input.reviewState ?? existing.reviewState,
      enabled: input.enabled ?? existing.enabled,
      sensitivity: input.sensitivity ?? existing.sensitivity,
      verifyBeforeUse: input.verifyBeforeUse ?? existing.verifyBeforeUse,
      retrievalProviderId: nullableUpdate(input.retrievalProviderId, existing.retrievalProviderId),
      retrievalHandle: nullableUpdate(input.retrievalHandle, existing.retrievalHandle),
      createdBy: nullableUpdate(input.createdBy, existing.createdBy),
      lastUsedAt: nullableUpdate(input.lastUsedAt, existing.lastUsedAt),
      updatedAt: now,
    };
    validateMemoryObject(next);

    this.database
      .prepare(`
        UPDATE memory_objects
        SET
          scope_type = ?,
          owner_id = ?,
          title = ?,
          body = ?,
          tags_json = ?,
          source_refs_json = ?,
          review_state = ?,
          enabled = ?,
          sensitivity = ?,
          verify_before_use = ?,
          retrieval_provider_id = ?,
          retrieval_handle = ?,
          created_by = ?,
          updated_at = ?,
          last_used_at = ?
        WHERE id = ?
      `)
      .run(
        next.scopeType,
        next.ownerId,
        next.title,
        next.body,
        stringifyJson(next.tags),
        stringifyJson(next.sourceRefs),
        next.reviewState,
        next.enabled ? 1 : 0,
        next.sensitivity,
        next.verifyBeforeUse ? 1 : 0,
        next.retrievalProviderId ?? null,
        next.retrievalHandle ?? null,
        next.createdBy ?? null,
        next.updatedAt,
        next.lastUsedAt ?? null,
        id,
      );

    return this.getMemoryObject(id);
  }

  getMemorySelfImprovingMetadata(memoryId: string): MemorySelfImprovingMetadata | undefined {
    const row = this.database.prepare(memorySelfImprovingMetadataSelectSql("WHERE memory_id = ?")).get(memoryId);
    return row ? mapMemorySelfImprovingMetadata(row as Record<string, SQLOutputValue>) : undefined;
  }

  upsertMemorySelfImprovingMetadata(input: UpsertMemorySelfImprovingMetadataInput): MemorySelfImprovingMetadata {
    if (!this.getMemoryObject(input.memoryId)) {
      throw new Error(`Memory object not found: ${input.memoryId}`);
    }
    if (input.useWhen?.some((item) => !item.trim()) || input.doNotUseWhen?.some((item) => !item.trim())) {
      throw new Error("useWhen and doNotUseWhen entries must be non-empty strings");
    }
    const metadata: MemorySelfImprovingMetadata = {
      memoryId: input.memoryId,
      kind: input.kind,
      trigger: input.trigger,
      lesson: input.lesson,
      useWhen: normalizeStringList(input.useWhen ?? []),
      doNotUseWhen: normalizeStringList(input.doNotUseWhen ?? []),
      validUntil: nullableUpdate(input.validUntil, undefined),
      lastSeenAt: nullableUpdate(input.lastSeenAt, undefined),
      evidenceCount: input.evidenceCount ?? 0,
      supersededBy: nullableUpdate(input.supersededBy, undefined),
      lastUsedAt: nullableUpdate(input.lastUsedAt, undefined),
      useCount: input.useCount ?? 0,
    };
    validateMemorySelfImprovingMetadata(metadata);
    this.database
      .prepare(`
        INSERT INTO memory_self_improving_metadata (
          memory_id,
          kind,
          trigger,
          lesson,
          use_when_json,
          do_not_use_when_json,
          valid_until,
          last_seen_at,
          evidence_count,
          superseded_by,
          last_used_at,
          use_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          kind = excluded.kind,
          trigger = excluded.trigger,
          lesson = excluded.lesson,
          use_when_json = excluded.use_when_json,
          do_not_use_when_json = excluded.do_not_use_when_json,
          valid_until = excluded.valid_until,
          last_seen_at = excluded.last_seen_at,
          evidence_count = excluded.evidence_count,
          superseded_by = excluded.superseded_by,
          last_used_at = excluded.last_used_at,
          use_count = excluded.use_count
      `)
      .run(
        metadata.memoryId,
        metadata.kind,
        metadata.trigger,
        metadata.lesson,
        stringifyJson(metadata.useWhen),
        stringifyJson(metadata.doNotUseWhen),
        metadata.validUntil ?? null,
        metadata.lastSeenAt ?? null,
        metadata.evidenceCount,
        metadata.supersededBy ?? null,
        metadata.lastUsedAt ?? null,
        metadata.useCount,
      );
    const stored = this.getMemorySelfImprovingMetadata(input.memoryId);
    if (!stored) {
      throw new Error(`Failed to upsert memory self-improving metadata: ${input.memoryId}`);
    }
    return stored;
  }

  listMemorySelfImprovingMetadata(options: ListMemorySelfImprovingMetadataOptions = {}): MemorySelfImprovingMetadata[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.workspaceId) {
      clauses.push("memory_id IN (SELECT id FROM memory_objects WHERE workspace_id = ?)");
      params.push(options.workspaceId);
    }
    if (options.memoryId) {
      clauses.push("memory_id = ?");
      params.push(options.memoryId);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
    params.push(limit);
    return this.database
      .prepare(`${memorySelfImprovingMetadataSelectSql(whereClause)} ORDER BY memory_id ASC LIMIT ?`)
      .all(...params)
      .map((row) => mapMemorySelfImprovingMetadata(row as Record<string, SQLOutputValue>));
  }

  getMemoryReviewPolicy(workspaceId = DEFAULT_WORKSPACE_ID): MemoryReviewPolicy {
    const row = this.database
      .prepare(`
        SELECT
          workspace_id,
          mode,
          auto_active_same_scope,
          auto_active_user_explicit,
          require_manual_for_workspace,
          require_manual_for_persona,
          require_manual_for_cross_scope,
          quarantine_secret_adjacent,
          updated_at
        FROM memory_review_policy
        WHERE workspace_id = ?
      `)
      .get(workspaceId);
    return row ? mapMemoryReviewPolicy(row as Record<string, SQLOutputValue>) : createDefaultMemoryReviewPolicy(workspaceId);
  }

  updateMemoryReviewPolicy(input: MemoryReviewPolicyUpdateInput, now: string): MemoryReviewPolicy {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const existing = this.getMemoryReviewPolicy(workspaceId);
    const next: MemoryReviewPolicy = {
      workspaceId,
      mode: input.mode ?? existing.mode,
      autoActiveSameScope: input.autoActiveSameScope ?? existing.autoActiveSameScope,
      autoActiveUserExplicit: input.autoActiveUserExplicit ?? existing.autoActiveUserExplicit,
      requireManualForWorkspace: input.requireManualForWorkspace ?? existing.requireManualForWorkspace,
      requireManualForPersona: input.requireManualForPersona ?? existing.requireManualForPersona,
      requireManualForCrossScope: input.requireManualForCrossScope ?? existing.requireManualForCrossScope,
      quarantineSecretAdjacent: input.quarantineSecretAdjacent ?? existing.quarantineSecretAdjacent,
      updatedAt: now,
    };
    validateMemoryReviewPolicy(next);
    this.database
      .prepare(`
        INSERT INTO memory_review_policy (
          workspace_id,
          mode,
          auto_active_same_scope,
          auto_active_user_explicit,
          require_manual_for_workspace,
          require_manual_for_persona,
          require_manual_for_cross_scope,
          quarantine_secret_adjacent,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          mode = excluded.mode,
          auto_active_same_scope = excluded.auto_active_same_scope,
          auto_active_user_explicit = excluded.auto_active_user_explicit,
          require_manual_for_workspace = excluded.require_manual_for_workspace,
          require_manual_for_persona = excluded.require_manual_for_persona,
          require_manual_for_cross_scope = excluded.require_manual_for_cross_scope,
          quarantine_secret_adjacent = excluded.quarantine_secret_adjacent,
          updated_at = excluded.updated_at
      `)
      .run(
        next.workspaceId,
        next.mode,
        next.autoActiveSameScope ? 1 : 0,
        next.autoActiveUserExplicit ? 1 : 0,
        next.requireManualForWorkspace ? 1 : 0,
        next.requireManualForPersona ? 1 : 0,
        next.requireManualForCrossScope ? 1 : 0,
        next.quarantineSecretAdjacent ? 1 : 0,
        next.updatedAt,
      );
    return this.getMemoryReviewPolicy(workspaceId);
  }

  recordMemoryReviewDecision(input: CreateMemoryReviewDecisionInput, now: string): MemoryReviewDecision {
    const memory = this.getMemoryObject(input.memoryId);
    if (!memory) {
      throw new Error(`Memory object not found: ${input.memoryId}`);
    }
    const decision: MemoryReviewDecision = {
      id: input.id ?? createMemoryReviewDecisionId(),
      workspaceId: input.workspaceId ?? memory.workspaceId,
      memoryId: input.memoryId,
      outcome: input.outcome,
      mode: input.mode,
      reasonCode: input.reasonCode,
      reason: input.reason,
      confidence: input.confidence,
      requiresManualReview: input.requiresManualReview,
      quarantineReason: input.quarantineReason,
      targetReviewState: input.targetReviewState,
      targetSensitivity: input.targetSensitivity,
      sourceRefs: ensureMemorySourceRefs(input.memoryId, normalizeMemorySourceRefs(input.sourceRefs ?? memory.sourceRefs)),
      decidedBy: input.decidedBy,
      createdAt: now,
    };
    validateMemoryReviewDecision(decision);
    this.database
      .prepare(`
        INSERT INTO memory_review_decisions (
          id,
          workspace_id,
          memory_id,
          outcome,
          mode,
          reason_code,
          reason,
          confidence,
          requires_manual_review,
          quarantine_reason,
          target_review_state,
          target_sensitivity,
          source_refs_json,
          decided_by,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.workspaceId,
        decision.memoryId,
        decision.outcome,
        decision.mode,
        decision.reasonCode,
        decision.reason,
        decision.confidence,
        decision.requiresManualReview ? 1 : 0,
        decision.quarantineReason ?? null,
        decision.targetReviewState,
        decision.targetSensitivity,
        stringifyJson(decision.sourceRefs),
        decision.decidedBy,
        decision.createdAt,
      );
    return decision;
  }

  getLatestMemoryReviewDecision(memoryId: string): MemoryReviewDecision | undefined {
    const row = this.database
      .prepare(memoryReviewDecisionSelectSql("WHERE memory_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"))
      .get(memoryId);
    return row ? mapMemoryReviewDecision(row as Record<string, SQLOutputValue>) : undefined;
  }

  listMemoryPromotionInbox(options: ListMemoryPromotionInboxOptions = {}): MemoryPromotionInboxItem[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const candidates = [
      ...this.listMemoryObjects({ workspaceId: options.workspaceId, scopeType: options.scopeType, ownerId: options.ownerId, sensitivity: options.sensitivity, reviewState: "candidate", limit: 500 }),
      ...this.listMemoryObjects({ workspaceId: options.workspaceId, scopeType: options.scopeType, ownerId: options.ownerId, sensitivity: options.sensitivity, reviewState: "disabled", limit: 500 }),
    ];
    const seen = new Set<string>();
    const items: MemoryPromotionInboxItem[] = [];
    for (const memory of candidates) {
      if (seen.has(memory.id)) {
        continue;
      }
      seen.add(memory.id);
      const decision = this.getLatestMemoryReviewDecision(memory.id);
      if (
        memory.reviewState === "disabled" &&
        (!decision || (decision.outcome !== "manual-review" && decision.outcome !== "quarantine"))
      ) {
        continue;
      }
      items.push({
        memory,
        decision,
        sourceSummary: summarizeMemorySourceRefs(memory.sourceRefs),
        recommendedAction: recommendMemoryReviewAction(memory, decision),
      });
      if (items.length >= limit) {
        break;
      }
    }
    return items;
  }

  applyMemoryReviewAction(input: ApplyMemoryReviewActionInput, now: string): { readonly memory: MemoryObject; readonly action: MemoryReviewActionRecord } {
    const existing = this.getMemoryObject(input.memoryId);
    if (!existing) {
      throw new Error(`Memory object not found: ${input.memoryId}`);
    }
    const workspaceId = input.workspaceId ?? existing.workspaceId;
    if (workspaceId !== existing.workspaceId) {
      throw new Error("Memory review workspace does not match memory object");
    }
    const update = memoryUpdateForReviewAction(input, existing);
    const updated = this.updateMemoryObject(input.memoryId, update, now);
    if (!updated) {
      throw new Error(`Failed to update memory object: ${input.memoryId}`);
    }
    const action: MemoryReviewActionRecord = {
      id: createMemoryReviewActionId(),
      workspaceId,
      memoryId: input.memoryId,
      action: input.action,
      previousReviewState: existing.reviewState,
      nextReviewState: updated.reviewState,
      sourceRefs: updated.sourceRefs,
      editedMemory: input.editedMemory,
      reason: input.reason,
      actor: input.actor,
      createdAt: now,
    };
    validateMemoryReviewActionRecord(action);
    this.database
      .prepare(`
        INSERT INTO memory_review_actions (
          id,
          workspace_id,
          memory_id,
          action,
          previous_review_state,
          next_review_state,
          source_refs_json,
          edited_memory_json,
          reason,
          actor,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        action.id,
        action.workspaceId,
        action.memoryId,
        action.action,
        action.previousReviewState,
        action.nextReviewState,
        stringifyJson(action.sourceRefs),
        action.editedMemory ? stringifyJson(action.editedMemory) : null,
        action.reason ?? null,
        action.actor,
        action.createdAt,
      );
    return { memory: updated, action };
  }

  recallMemory(input: MemoryRecallRequest): MemoryRecallResult {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const maxResults = Math.min(Math.max(input.maxResults ?? 8, 1), 20);
    const allowedScopes = memoryRecallAllowedScopes(input, workspaceId);
    if (allowedScopes.length === 0) {
      return { request: { ...input, workspaceId }, memories: [], policyVersion: "ling-memory-v1-lexical" };
    }

    const listOptions: ListMemoryObjectsOptions = {
      workspaceId,
      limit: 500,
    };
    const candidates = this.listMemoryObjects(input.includeDisabled ? listOptions : { ...listOptions, enabled: true })
      .filter((memory) => memoryAllowedForRecall(memory, input, allowedScopes));
    const queryTerms = tokenizeMemoryQuery([input.query, ...(input.tags ?? [])].join(" "));
    const requestedTags = new Set((input.tags ?? []).map((tag) => tag.toLowerCase()));
    const memories = candidates
      .map((memory) => scoreMemoryForRecall(memory, queryTerms, requestedTags))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
      .slice(0, maxResults);
    return {
      request: { ...input, workspaceId },
      memories,
      policyVersion: "ling-memory-v1-lexical",
    };
  }

  recordUsedMemoryEvent(input: CreateUsedMemoryEventInput, now: string): UsedMemoryEvent {
    const event: UsedMemoryEvent = {
      id: input.id ?? createUsedMemoryEventId(),
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      memoryIds: normalizeStringList(input.memoryIds),
      intent: input.intent,
      recallQuery: input.recallQuery,
      teammateId: input.teammateId,
      channelId: input.channelId,
      taskId: input.taskId,
      runId: input.runId,
      responseId: input.responseId,
      policyVersion: input.policyVersion,
      createdAt: now,
    };
    if (event.memoryIds.length === 0) {
      throw new Error("memoryIds must contain at least one memory id");
    }

    this.database
      .prepare(`
        INSERT INTO memory_used_events (
          id,
          workspace_id,
          memory_ids_json,
          intent,
          recall_query,
          teammate_id,
          channel_id,
          task_id,
          run_id,
          response_id,
          policy_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.workspaceId,
        stringifyJson(event.memoryIds),
        event.intent,
        event.recallQuery,
        event.teammateId ?? null,
        event.channelId ?? null,
        event.taskId ?? null,
        event.runId ?? null,
        event.responseId ?? null,
        event.policyVersion,
        event.createdAt,
      );
    for (const memoryId of event.memoryIds) {
      this.database
        .prepare("UPDATE memory_objects SET last_used_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, memoryId);
    }
    return event;
  }

  listUsedMemoryEvents(options: ListUsedMemoryEventsOptions = {}): UsedMemoryEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    clauses.push("workspace_id = ?");
    params.push(options.workspaceId ?? DEFAULT_WORKSPACE_ID);
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.taskId) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.responseId) {
      clauses.push("response_id = ?");
      params.push(options.responseId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const events = this.database
      .prepare(`${memoryUsedEventSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapUsedMemoryEvent);
    if (!options.memoryId) {
      return events;
    }
    return events.filter((event) => event.memoryIds.includes(options.memoryId as string));
  }

  getOrCreateTeammateDirectThread(teammateId: string, now: string): TeammateDirectThread {
    const teammate = this.getAiTeammate(teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    const existing = this.database
      .prepare(teammateDirectThreadSelectSql("WHERE workspace_id = ? AND teammate_id = ?"))
      .get(DEFAULT_WORKSPACE_ID, teammateId);
    if (existing) {
      return mapTeammateDirectThread(existing);
    }

    const thread: TeammateDirectThread = {
      id: createTeammateDirectThreadId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      teammateId,
      title: teammate.displayName,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(`
        INSERT INTO teammate_direct_threads (
          id,
          workspace_id,
          teammate_id,
          title,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(thread.id, thread.workspaceId, thread.teammateId, thread.title, thread.createdAt, thread.updatedAt);

    return thread;
  }

  listTeammateDirectMessages(options: ListTeammateDirectMessagesOptions): TeammateDirectMessage[] {
    const clauses = ["workspace_id = ?", "teammate_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.teammateId];
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${teammateDirectMessageSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(...params)
      .map(mapTeammateDirectMessage);
  }

  getTeammateDirectMessage(id: string): TeammateDirectMessage | undefined {
    const row = this.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(id);
    return row ? mapTeammateDirectMessage(row) : undefined;
  }

  createTeammateDirectMessage(input: CreateTeammateDirectMessageInput, now: string): TeammateDirectMessage {
    const teammate = this.getAiTeammate(input.teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${input.teammateId}`);
    }
    const thread = this.getOrCreateTeammateDirectThread(input.teammateId, now);
    if (thread.id !== input.threadId) {
      throw new Error(`Direct thread does not belong to teammate: ${input.threadId}`);
    }
    const attachmentIds = normalizeStringList(input.attachmentIds ?? []);
    if (attachmentIds.length > 10) {
      throw new Error("A teammate direct message can reference at most 10 attachments");
    }
    for (const attachmentId of attachmentIds) {
      const attachment = this.getTeammatePrivateAttachment(attachmentId);
      if (!attachment || attachment.teammateId !== input.teammateId || attachment.threadId !== input.threadId || attachment.scope !== "teammate_direct_thread") {
        throw new Error(`Private attachment does not belong to teammate direct thread: ${attachmentId}`);
      }
    }

    const message: TeammateDirectMessage = {
      id: createTeammateDirectMessageId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      threadId: input.threadId,
      teammateId: input.teammateId,
      authorType: input.authorType,
      authorId: input.authorId,
      body: input.body,
      attachmentIds,
      status: input.status ?? "ready",
      errorMessage: input.errorMessage,
      linkedTaskId: input.linkedTaskId,
      linkedRunId: input.linkedRunId,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO teammate_direct_messages (
          id,
          workspace_id,
          thread_id,
          teammate_id,
          author_type,
          author_id,
          body,
          attachment_ids_json,
          status,
          error_message,
          linked_task_id,
          linked_run_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.workspaceId,
        message.threadId,
        message.teammateId,
        message.authorType,
        message.authorId ?? null,
        message.body,
        stringifyJson(message.attachmentIds),
        message.status,
        message.errorMessage ?? null,
        message.linkedTaskId ?? null,
        message.linkedRunId ?? null,
        message.createdAt,
        message.updatedAt,
      );

    const created = this.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(message.id);
    if (!created) {
      throw new Error(`Failed to create teammate direct message: ${message.id}`);
    }
    return mapTeammateDirectMessage(created);
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
    const existing = this.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(id);
    if (!existing) {
      return undefined;
    }
    const current = mapTeammateDirectMessage(existing);
    this.database
      .prepare(`
        UPDATE teammate_direct_messages
        SET
          body = ?,
          status = ?,
          error_message = ?,
          linked_run_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.body ?? current.body,
        input.status ?? current.status,
        input.errorMessage === undefined ? current.errorMessage ?? null : input.errorMessage,
        input.linkedRunId === undefined ? current.linkedRunId ?? null : input.linkedRunId,
        now,
        id,
      );
    const updated = this.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(id);
    return updated ? mapTeammateDirectMessage(updated) : undefined;
  }

  createTeammateDirectReplyIntervention(input: CreateTeammateDirectReplyInterventionInput, now: string): TeammateDirectReplyIntervention {
    const teammate = this.getAiTeammate(input.teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${input.teammateId}`);
    }
    const thread = this.getOrCreateTeammateDirectThread(input.teammateId, now);
    if (thread.id !== input.threadId) {
      throw new Error(`Direct thread does not belong to teammate: ${input.threadId}`);
    }
    const sourceMessage = this.getTeammateDirectMessage(input.sourceMessageId);
    if (!sourceMessage || sourceMessage.teammateId !== input.teammateId || sourceMessage.threadId !== input.threadId) {
      throw new Error(`Direct message does not belong to teammate direct thread: ${input.sourceMessageId}`);
    }
    const existing = this.database
      .prepare(teammateDirectReplyInterventionSelectSql("WHERE workspace_id = ? AND teammate_id = ? AND thread_id = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, input.teammateId, input.threadId, input.idempotencyKey);
    if (existing) {
      return mapTeammateDirectReplyIntervention(existing);
    }

    const intervention: TeammateDirectReplyIntervention = {
      id: input.id ?? createTeammateDirectReplyInterventionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      teammateId: input.teammateId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      sourceWorkUnitId: input.sourceWorkUnitId,
      mode: input.mode,
      status: "queued",
      instruction: input.instruction,
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.requestedBy ?? "local-user",
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(`
        INSERT INTO teammate_direct_reply_interventions (
          id,
          workspace_id,
          teammate_id,
          thread_id,
          source_message_id,
          source_work_unit_id,
          mode,
          status,
          instruction,
          idempotency_key,
          requested_by,
          continuation_message_id,
          continuation_work_unit_id,
          created_at,
          updated_at,
          started_at,
          completed_at,
          failure_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        intervention.id,
        intervention.workspaceId,
        intervention.teammateId,
        intervention.threadId,
        intervention.sourceMessageId,
        intervention.sourceWorkUnitId ?? null,
        intervention.mode,
        intervention.status,
        intervention.instruction,
        intervention.idempotencyKey,
        intervention.requestedBy,
        intervention.continuationMessageId ?? null,
        intervention.continuationWorkUnitId ?? null,
        intervention.createdAt,
        intervention.updatedAt,
        intervention.startedAt ?? null,
        intervention.completedAt ?? null,
        intervention.failureReason ?? null,
      );
    const created = this.getTeammateDirectReplyIntervention(intervention.id);
    if (!created) {
      throw new Error(`Failed to create teammate direct reply intervention: ${intervention.id}`);
    }
    return created;
  }

  getTeammateDirectReplyIntervention(interventionId: string): TeammateDirectReplyIntervention | undefined {
    const row = this.database.prepare(teammateDirectReplyInterventionSelectSql("WHERE id = ?")).get(interventionId);
    return row ? mapTeammateDirectReplyIntervention(row) : undefined;
  }

  listTeammateDirectReplyInterventions(options: ListTeammateDirectReplyInterventionsOptions = {}): TeammateDirectReplyIntervention[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.sourceWorkUnitId) {
      clauses.push("source_work_unit_id = ?");
      params.push(options.sourceWorkUnitId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.mode) {
      clauses.push("mode = ?");
      params.push(options.mode);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${teammateDirectReplyInterventionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(...params)
      .map(mapTeammateDirectReplyIntervention);
  }

  updateTeammateDirectReplyInterventionStatus(input: UpdateTeammateDirectReplyInterventionStatusInput): TeammateDirectReplyIntervention | undefined {
    const existing = this.getTeammateDirectReplyIntervention(input.interventionId);
    if (!existing) {
      return undefined;
    }
    const continuationMessageId = input.continuationMessageId === undefined ? existing.continuationMessageId ?? null : input.continuationMessageId;
    const continuationWorkUnitId = input.continuationWorkUnitId === undefined ? existing.continuationWorkUnitId ?? null : input.continuationWorkUnitId;
    const startedAt = input.startedAt === undefined ? existing.startedAt ?? null : input.startedAt;
    const completedAt = input.completedAt === undefined ? existing.completedAt ?? null : input.completedAt;
    const failureReason = input.failureReason === undefined ? existing.failureReason ?? null : input.failureReason;
    this.database
      .prepare(`
        UPDATE teammate_direct_reply_interventions
        SET status = ?,
            continuation_message_id = ?,
            continuation_work_unit_id = ?,
            updated_at = ?,
            started_at = ?,
            completed_at = ?,
            failure_reason = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        continuationMessageId,
        continuationWorkUnitId,
        input.now,
        startedAt,
        completedAt,
        failureReason,
        input.interventionId,
      );
    return this.getTeammateDirectReplyIntervention(input.interventionId);
  }

  cancelTeammateDirectReplyIntervention(interventionId: string, now: string, reason?: string): TeammateDirectReplyIntervention | undefined {
    const existing = this.getTeammateDirectReplyIntervention(interventionId);
    if (!existing) {
      return undefined;
    }
    if (existing.status === "started" || existing.status === "cancelled" || existing.status === "failed") {
      return existing;
    }
    return this.updateTeammateDirectReplyInterventionStatus({
      interventionId,
      status: "cancelled",
      completedAt: now,
      failureReason: reason ?? "cancelled",
      now,
    });
  }

  createTeammatePrivateAttachment(input: CreateTeammatePrivateAttachmentInput): TeammatePrivateAttachment {
    const teammate = this.getAiTeammate(input.teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${input.teammateId}`);
    }
    if (input.scope === "teammate_direct_thread") {
      if (!input.threadId) {
        throw new Error("threadId is required for teammate_direct_thread attachments");
      }
      const thread = this.getOrCreateTeammateDirectThread(input.teammateId, input.createdAt ?? new Date().toISOString());
      if (thread.id !== input.threadId) {
        throw new Error(`Direct thread does not belong to teammate: ${input.threadId}`);
      }
      if (input.messageId) {
        const message = this.getTeammateDirectMessage(input.messageId);
        if (!message || message.teammateId !== input.teammateId || message.threadId !== input.threadId) {
          throw new Error(`Direct message does not belong to teammate direct thread: ${input.messageId}`);
        }
      }
    }
    if (input.scope === "teammate_profile_avatar" && input.kind !== "image") {
      throw new Error("Avatar attachments must be images");
    }
    const attachment: TeammatePrivateAttachment = {
      id: createTeammatePrivateAttachmentId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      teammateId: input.teammateId,
      threadId: input.threadId,
      messageId: input.messageId,
      scope: input.scope,
      kind: input.kind,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      path: input.path,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.database
      .prepare(`
        INSERT INTO teammate_private_attachments (
          id,
          workspace_id,
          teammate_id,
          thread_id,
          message_id,
          scope,
          kind,
          file_name,
          content_type,
          size_bytes,
          path,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attachment.id,
        attachment.workspaceId,
        attachment.teammateId,
        attachment.threadId ?? null,
        attachment.messageId ?? null,
        attachment.scope,
        attachment.kind,
        attachment.fileName,
        attachment.contentType,
        attachment.sizeBytes,
        attachment.path,
        attachment.createdAt,
      );
    const created = this.getTeammatePrivateAttachment(attachment.id);
    if (!created) {
      throw new Error(`Failed to create teammate private attachment: ${attachment.id}`);
    }
    return created;
  }

  getTeammatePrivateAttachment(id: string): TeammatePrivateAttachment | undefined {
    const row = this.database.prepare(teammatePrivateAttachmentSelectSql("WHERE id = ?")).get(id);
    return row ? mapTeammatePrivateAttachment(row) : undefined;
  }

  listTeammatePrivateAttachments(options: ListTeammatePrivateAttachmentsOptions): TeammatePrivateAttachment[] {
    const clauses = ["workspace_id = ?", "teammate_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.teammateId];
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.scope) {
      clauses.push("scope = ?");
      params.push(options.scope);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${teammatePrivateAttachmentSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapTeammatePrivateAttachment);
  }

  deleteTeammatePrivateAttachment(id: string): boolean {
    const result = this.database.prepare("DELETE FROM teammate_private_attachments WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createChannelMessage(input: CreateChannelMessageInput, now: string): ChannelMessage {
    if (!this.getChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const message: ChannelMessage = {
      id: createChannelMessageId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      threadId: input.threadId,
      kind: input.kind ?? "message",
      intent: input.intent ?? "discuss",
      authorType: input.authorType,
      authorId: input.authorId,
      body: input.body,
      mentions: input.mentions ?? [],
      attachmentIds: input.attachmentIds ?? [],
      linkPreviewIds: input.linkPreviewIds ?? [],
      linkedTaskId: input.linkedTaskId,
      linkedRunId: input.linkedRunId,
      status: input.status ?? "ready",
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_messages (
          id,
          workspace_id,
          channel_id,
          thread_id,
          kind,
          intent,
          author_type,
          author_id,
          body,
          mentions_json,
          attachment_ids_json,
          link_preview_ids_json,
          linked_task_id,
          linked_run_id,
          status,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.workspaceId,
        message.channelId,
        message.threadId ?? null,
        message.kind,
        message.intent,
        message.authorType,
        message.authorId ?? null,
        message.body,
        stringifyJson(message.mentions),
        stringifyJson(message.attachmentIds),
        stringifyJson(message.linkPreviewIds),
        message.linkedTaskId ?? null,
        message.linkedRunId ?? null,
        message.status,
        message.errorMessage ?? null,
        message.createdAt,
        message.updatedAt,
      );

    const created = this.getChannelMessage(message.id);
    if (!created) {
      throw new Error(`Failed to create channel message: ${message.id}`);
    }
    return created;
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
    const existing = this.getChannelMessage(id);
    if (!existing) {
      return undefined;
    }
    this.database
      .prepare(`
        UPDATE channel_messages
        SET
          body = ?,
          status = ?,
          error_message = ?,
          linked_run_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.body ?? existing.body,
        input.status ?? existing.status,
        input.errorMessage === undefined ? existing.errorMessage ?? null : input.errorMessage,
        input.linkedRunId === undefined ? existing.linkedRunId ?? null : input.linkedRunId,
        now,
        id,
      );
    return this.getChannelMessage(id);
  }

  getChannelMessage(id: string): ChannelMessage | undefined {
    const row = this.database.prepare(channelMessageSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelMessage(row) : undefined;
  }

  listChannelMessages(options: ListChannelMessagesOptions): ChannelMessage[] {
    return this.listChannelMessagesPage(options).messages.slice();
  }

  listChannelMessagesPage(options: ListChannelMessagesOptions): ChannelMessageListPage {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.beforeMessageId) {
      const cursor = this.database
        .prepare("SELECT channel_id, thread_id, created_at, rowid FROM channel_messages WHERE workspace_id = ? AND id = ?")
        .get(DEFAULT_WORKSPACE_ID, options.beforeMessageId);
      if (!cursor || readString(cursor, "channel_id") !== options.channelId) {
        throw new Error(`Invalid channel message cursor: ${options.beforeMessageId}`);
      }
      const cursorThreadId = readNullableString(cursor, "thread_id");
      if ((options.threadId ?? undefined) !== cursorThreadId) {
        throw new Error(`Invalid channel message cursor: ${options.beforeMessageId}`);
      }
      clauses.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
      const cursorCreatedAt = readString(cursor, "created_at");
      params.push(cursorCreatedAt, cursorCreatedAt, readNumber(cursor, "rowid"));
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    params.push(limit + 1);
    const rows = this.database
      .prepare(`${channelMessageSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelMessage);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse();
    return {
      messages,
      hasMore,
      nextBeforeMessageId: hasMore && messages.length > 0 ? messages[0].id : undefined,
    };
  }

  createChannelMessageRouteDecision(input: CreateChannelMessageRouteDecisionInput, now: string): ChannelMessageRouteDecision {
    validateChannelMessageRouteDecisionInput(input);
    if (!this.getChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const sourceMessage = this.getChannelMessage(input.sourceMessageId);
    if (!sourceMessage || sourceMessage.channelId !== input.channelId) {
      throw new Error(`Source message does not belong to channel: ${input.sourceMessageId}`);
    }
    if (input.replyMessageId) {
      const replyMessage = this.getChannelMessage(input.replyMessageId);
      if (!replyMessage || replyMessage.channelId !== input.channelId) {
        throw new Error(`Reply message does not belong to channel: ${input.replyMessageId}`);
      }
    }
    const decision: ChannelMessageRouteDecision = {
      schemaVersion: 1,
      id: createChannelMessageRouteDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      replyMessageId: input.replyMessageId,
      mode: input.mode,
      action: input.action,
      selectedTeammateId: input.selectedTeammateId,
      selectedProviderPresetId: input.selectedProviderPresetId,
      confidence: input.confidence,
      reason: input.reason,
      alternativesConsidered: input.alternativesConsidered ?? [],
      status: input.status,
      createdBy: input.createdBy,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_message_route_decisions (
          id,
          schema_version,
          workspace_id,
          channel_id,
          source_message_id,
          reply_message_id,
          mode,
          action,
          selected_teammate_id,
          selected_provider_preset_id,
          confidence,
          reason,
          alternatives_json,
          status,
          created_by,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.schemaVersion,
        decision.workspaceId,
        decision.channelId,
        decision.sourceMessageId,
        decision.replyMessageId ?? null,
        decision.mode,
        decision.action,
        decision.selectedTeammateId ?? null,
        decision.selectedProviderPresetId ?? null,
        decision.confidence ?? null,
        decision.reason,
        stringifyJson(decision.alternativesConsidered),
        decision.status,
        decision.createdBy,
        decision.errorMessage ?? null,
        decision.createdAt,
        decision.updatedAt,
      );

    const created = this.getChannelMessageRouteDecision(decision.id);
    if (!created) {
      throw new Error(`Failed to create channel message route decision: ${decision.id}`);
    }
    return created;
  }

  getChannelMessageRouteDecision(id: string): ChannelMessageRouteDecision | undefined {
    const row = this.database.prepare(channelMessageRouteDecisionSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelMessageRouteDecision(row) : undefined;
  }

  listChannelMessageRouteDecisions(options: ListChannelMessageRouteDecisionsOptions = {}): ChannelMessageRouteDecision[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceMessageId) {
      clauses.push("source_message_id = ?");
      params.push(options.sourceMessageId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelMessageRouteDecisionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelMessageRouteDecision);
  }

  updateChannelMessageRouteDecision(
    id: string,
    input: UpdateChannelMessageRouteDecisionInput,
    now: string,
  ): ChannelMessageRouteDecision | undefined {
    const existing = this.getChannelMessageRouteDecision(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelMessageRouteDecision = {
      ...existing,
      replyMessageId: nullableUpdate(input.replyMessageId, existing.replyMessageId),
      selectedProviderPresetId: nullableUpdate(input.selectedProviderPresetId, existing.selectedProviderPresetId),
      confidence: nullableUpdate(input.confidence, existing.confidence),
      reason: input.reason ?? existing.reason,
      alternativesConsidered: input.alternativesConsidered ?? existing.alternativesConsidered,
      status: input.status ?? existing.status,
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
      updatedAt: now,
    };
    validateChannelMessageRouteDecisionInput(next);
    if (next.replyMessageId) {
      const replyMessage = this.getChannelMessage(next.replyMessageId);
      if (!replyMessage || replyMessage.channelId !== next.channelId) {
        throw new Error(`Reply message does not belong to channel: ${next.replyMessageId}`);
      }
    }

    this.database
      .prepare(`
        UPDATE channel_message_route_decisions
        SET
          reply_message_id = ?,
          selected_provider_preset_id = ?,
          confidence = ?,
          reason = ?,
          alternatives_json = ?,
          status = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.replyMessageId ?? null,
        next.selectedProviderPresetId ?? null,
        next.confidence ?? null,
        next.reason,
        stringifyJson(next.alternativesConsidered),
        next.status,
        next.errorMessage ?? null,
        next.updatedAt,
        id,
      );

    return this.getChannelMessageRouteDecision(id);
  }

  createChannelIntentDecision(input: CreateChannelIntentDecisionInput, now: string): ChannelIntentDecision {
    this.assertMessageInChannel(input.channelId, input.sourceMessageId);
    this.assertChannelIntentDecisionRefsInChannel(input.channelId, input);
    const decision: ChannelIntentDecision = {
      schemaVersion: 1,
      id: createChannelIntentDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      action: input.action,
      selectedTeammateId: input.selectedTeammateId,
      selectedTeammateIds: input.selectedTeammateIds,
      proposalId: input.proposalId,
      replyMessageId: input.replyMessageId,
      replyMessageIds: input.replyMessageIds,
      workflowId: input.workflowId,
      reason: input.reason,
      status: input.status,
      createdBy: input.createdBy,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };
    validateChannelIntentDecisionInput(decision);
    this.database
      .prepare(`
        INSERT INTO channel_intent_decisions (
          id,
          schema_version,
          workspace_id,
          channel_id,
          source_message_id,
          action,
          selected_teammate_id,
          selected_teammate_ids_json,
          proposal_id,
          reply_message_id,
          reply_message_ids_json,
          workflow_id,
          reason,
          status,
          created_by,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.schemaVersion,
        decision.workspaceId,
        decision.channelId,
        decision.sourceMessageId,
        decision.action,
        decision.selectedTeammateId ?? null,
        stringifyJson(decision.selectedTeammateIds ?? []),
        decision.proposalId ?? null,
        decision.replyMessageId ?? null,
        stringifyJson(decision.replyMessageIds ?? []),
        decision.workflowId ?? null,
        decision.reason,
        decision.status,
        decision.createdBy,
        decision.errorMessage ?? null,
        decision.createdAt,
        decision.updatedAt,
      );
    const created = this.getChannelIntentDecision(decision.id);
    if (!created) {
      throw new Error(`Failed to create channel intent decision: ${decision.id}`);
    }
    return created;
  }

  getChannelIntentDecision(id: string): ChannelIntentDecision | undefined {
    const row = this.database.prepare(channelIntentDecisionSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelIntentDecision(row) : undefined;
  }

  listChannelIntentDecisions(options: ListChannelIntentDecisionsOptions = {}): ChannelIntentDecision[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceMessageId) {
      clauses.push("source_message_id = ?");
      params.push(options.sourceMessageId);
    }
    if (options.action) {
      clauses.push("action = ?");
      params.push(options.action);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelIntentDecisionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelIntentDecision);
  }

  createChannelExecutionProposal(input: CreateChannelExecutionProposalInput, now: string): ChannelExecutionProposal {
    if (!this.getChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const sourceMessage = this.getChannelMessage(input.sourceMessageId);
    if (!sourceMessage || sourceMessage.channelId !== input.channelId) {
      throw new Error(`Source message does not belong to channel: ${input.sourceMessageId}`);
    }
    const proposal: ChannelExecutionProposal = {
      id: createChannelExecutionProposalId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      proposedByTeammateId: input.proposedByTeammateId,
      title: input.title,
      prompt: input.prompt,
      assigneeTeammateId: input.assigneeTeammateId,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      collaborationSteps: input.collaborationSteps ?? [],
      requiredTools: input.requiredTools ?? [],
      riskSummary: input.riskSummary,
      responseLanguage: input.responseLanguage,
      status: input.status ?? "draft",
      linkedTaskId: input.linkedTaskId,
      linkedRunId: input.linkedRunId,
      linkedWorkflowId: input.linkedWorkflowId,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_execution_proposals (
          id,
          workspace_id,
          channel_id,
          source_message_id,
          proposed_by_teammate_id,
          title,
          prompt,
          assignee_teammate_id,
          acceptance_criteria_json,
          collaboration_steps_json,
          required_tools_json,
          risk_summary,
          response_language,
          status,
          linked_task_id,
          linked_run_id,
          linked_workflow_id,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        proposal.id,
        proposal.workspaceId,
        proposal.channelId,
        proposal.sourceMessageId,
        proposal.proposedByTeammateId,
        proposal.title,
        proposal.prompt,
        proposal.assigneeTeammateId,
        stringifyJson(proposal.acceptanceCriteria),
        stringifyJson(proposal.collaborationSteps),
        stringifyJson(proposal.requiredTools),
        proposal.riskSummary ?? null,
        proposal.responseLanguage ?? null,
        proposal.status,
        proposal.linkedTaskId ?? null,
        proposal.linkedRunId ?? null,
        proposal.linkedWorkflowId ?? null,
        proposal.errorMessage ?? null,
        proposal.createdAt,
        proposal.updatedAt,
      );

    const created = this.getChannelExecutionProposal(proposal.id);
    if (!created) {
      throw new Error(`Failed to create channel execution proposal: ${proposal.id}`);
    }
    return created;
  }

  getChannelExecutionProposal(id: string): ChannelExecutionProposal | undefined {
    const row = this.database.prepare(channelExecutionProposalSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelExecutionProposal(row) : undefined;
  }

  listChannelExecutionProposals(options: ListChannelExecutionProposalsOptions): ChannelExecutionProposal[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.sourceMessageId) {
      clauses.push("source_message_id = ?");
      params.push(options.sourceMessageId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelExecutionProposalSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(...params)
      .map(mapChannelExecutionProposal);
  }

  updateChannelExecutionProposal(
    id: string,
    input: UpdateChannelExecutionProposalInput,
    now: string,
  ): ChannelExecutionProposal | undefined {
    const existing = this.getChannelExecutionProposal(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelExecutionProposal = {
      ...existing,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      assigneeTeammateId: input.assigneeTeammateId ?? existing.assigneeTeammateId,
      acceptanceCriteria: input.acceptanceCriteria ?? existing.acceptanceCriteria,
      collaborationSteps: input.collaborationSteps ?? existing.collaborationSteps,
      requiredTools: input.requiredTools ?? existing.requiredTools,
      riskSummary: nullableUpdate(input.riskSummary, existing.riskSummary),
      responseLanguage: nullableUpdate(input.responseLanguage, existing.responseLanguage),
      status: input.status ?? existing.status,
      linkedTaskId: nullableUpdate(input.linkedTaskId, existing.linkedTaskId),
      linkedRunId: nullableUpdate(input.linkedRunId, existing.linkedRunId),
      linkedWorkflowId: nullableUpdate(input.linkedWorkflowId, existing.linkedWorkflowId),
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE channel_execution_proposals
        SET
          title = ?,
          prompt = ?,
          assignee_teammate_id = ?,
          acceptance_criteria_json = ?,
          collaboration_steps_json = ?,
          required_tools_json = ?,
          risk_summary = ?,
          response_language = ?,
          status = ?,
          linked_task_id = ?,
          linked_run_id = ?,
          linked_workflow_id = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.title,
        next.prompt,
        next.assigneeTeammateId,
        stringifyJson(next.acceptanceCriteria),
        stringifyJson(next.collaborationSteps),
        stringifyJson(next.requiredTools),
        next.riskSummary ?? null,
        next.responseLanguage ?? null,
        next.status,
        next.linkedTaskId ?? null,
        next.linkedRunId ?? null,
        next.linkedWorkflowId ?? null,
        next.errorMessage ?? null,
        next.updatedAt,
        next.id,
      );

    return this.getChannelExecutionProposal(id);
  }

  createChannelAttachment(input: CreateChannelAttachmentInput): ChannelAttachment {
    if (!this.getChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const attachment: ChannelAttachment = {
      id: createChannelAttachmentId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      messageId: input.messageId,
      kind: input.kind,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      path: input.path,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.database
      .prepare(`
        INSERT INTO channel_attachments (
          id,
          workspace_id,
          channel_id,
          message_id,
          kind,
          file_name,
          content_type,
          size_bytes,
          path,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attachment.id,
        attachment.workspaceId,
        attachment.channelId,
        attachment.messageId ?? null,
        attachment.kind,
        attachment.fileName,
        attachment.contentType,
        attachment.sizeBytes,
        attachment.path,
        attachment.createdAt,
      );

    const created = this.getChannelAttachment(attachment.id);
    if (!created) {
      throw new Error(`Failed to create channel attachment: ${attachment.id}`);
    }
    return created;
  }

  getChannelAttachment(id: string): ChannelAttachment | undefined {
    const row = this.database.prepare(channelAttachmentSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelAttachment(row) : undefined;
  }

  listChannelAttachments(options: ListChannelAttachmentsOptions): ChannelAttachment[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.database
      .prepare(`${channelAttachmentSelectSql("WHERE workspace_id = ? AND channel_id = ?")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, options.channelId, limit)
      .map(mapChannelAttachment);
  }

  deleteChannelAttachment(id: string): boolean {
    const result = this.database.prepare("DELETE FROM channel_attachments WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createChannelLinkPreview(input: CreateChannelLinkPreviewInput, now: string): ChannelLinkPreview {
    if (!this.getChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const preview: ChannelLinkPreview = {
      id: createChannelLinkPreviewId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      messageId: input.messageId,
      url: input.url,
      normalizedUrl: input.normalizedUrl,
      title: input.title,
      description: input.description,
      imageUrl: input.imageUrl,
      siteName: input.siteName,
      status: input.status,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(`
        INSERT INTO channel_link_previews (
          id,
          workspace_id,
          channel_id,
          message_id,
          url,
          normalized_url,
          title,
          description,
          image_url,
          site_name,
          status,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        preview.id,
        preview.workspaceId,
        preview.channelId,
        preview.messageId ?? null,
        preview.url,
        preview.normalizedUrl,
        preview.title ?? null,
        preview.description ?? null,
        preview.imageUrl ?? null,
        preview.siteName ?? null,
        preview.status,
        preview.errorMessage ?? null,
        preview.createdAt,
        preview.updatedAt,
      );

    const created = this.getChannelLinkPreview(preview.id);
    if (!created) {
      throw new Error(`Failed to create channel link preview: ${preview.id}`);
    }
    return created;
  }

  getChannelLinkPreview(id: string): ChannelLinkPreview | undefined {
    const row = this.database.prepare(channelLinkPreviewSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelLinkPreview(row) : undefined;
  }

  listChannelLinkPreviews(options: ListChannelLinkPreviewsOptions): ChannelLinkPreview[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.database
      .prepare(`${channelLinkPreviewSelectSql("WHERE workspace_id = ? AND channel_id = ?")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, options.channelId, limit)
      .map(mapChannelLinkPreview);
  }

  updateChannelLinkPreview(id: string, input: UpdateChannelLinkPreviewInput, now: string): ChannelLinkPreview | undefined {
    const existing = this.getChannelLinkPreview(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelLinkPreview = {
      ...existing,
      title: nullableUpdate(input.title, existing.title),
      description: nullableUpdate(input.description, existing.description),
      imageUrl: nullableUpdate(input.imageUrl, existing.imageUrl),
      siteName: nullableUpdate(input.siteName, existing.siteName),
      status: input.status ?? existing.status,
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_link_previews
        SET
          title = ?,
          description = ?,
          image_url = ?,
          site_name = ?,
          status = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.title ?? null,
        next.description ?? null,
        next.imageUrl ?? null,
        next.siteName ?? null,
        next.status,
        next.errorMessage ?? null,
        next.updatedAt,
        id,
    );
    return this.getChannelLinkPreview(id);
  }

  getChannelBrief(channelId: string): ChannelBrief | undefined {
    const row = this.database.prepare(channelBriefSelectSql("WHERE channel_id = ?")).get(channelId);
    return row ? mapChannelBrief(row) : undefined;
  }

  updateChannelBrief(channelId: string, input: UpdateChannelBriefInput, now: string): ChannelBrief {
    this.assertChannelExists(channelId);
    for (const decisionId of input.decisionIds ?? []) {
      this.assertDecisionInChannel(channelId, decisionId);
    }
    for (const attachmentId of input.attachmentIds ?? []) {
      this.assertAttachmentInChannel(channelId, attachmentId);
    }
    for (const linkPreviewId of input.linkPreviewIds ?? []) {
      this.assertLinkPreviewInChannel(channelId, linkPreviewId);
    }

    const existing = this.getChannelBrief(channelId);
    const brief: ChannelBrief = {
      id: existing?.id ?? createChannelBriefId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId,
      objective: input.objective,
      scope: input.scope,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      openQuestions: input.openQuestions ?? [],
      risks: input.risks ?? [],
      decisionIds: input.decisionIds ?? [],
      attachmentIds: input.attachmentIds ?? [],
      linkPreviewIds: input.linkPreviewIds ?? [],
      updatedBy: input.updatedBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_briefs (
          id,
          workspace_id,
          channel_id,
          objective,
          scope,
          acceptance_criteria_json,
          open_questions_json,
          risks_json,
          decision_ids_json,
          attachment_ids_json,
          link_preview_ids_json,
          updated_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          objective = excluded.objective,
          scope = excluded.scope,
          acceptance_criteria_json = excluded.acceptance_criteria_json,
          open_questions_json = excluded.open_questions_json,
          risks_json = excluded.risks_json,
          decision_ids_json = excluded.decision_ids_json,
          attachment_ids_json = excluded.attachment_ids_json,
          link_preview_ids_json = excluded.link_preview_ids_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `)
      .run(
        brief.id,
        brief.workspaceId,
        brief.channelId,
        brief.objective,
        brief.scope,
        stringifyJson(brief.acceptanceCriteria),
        stringifyJson(brief.openQuestions),
        stringifyJson(brief.risks),
        stringifyJson(brief.decisionIds),
        stringifyJson(brief.attachmentIds),
        stringifyJson(brief.linkPreviewIds),
        brief.updatedBy,
        brief.createdAt,
        brief.updatedAt,
      );

    const updated = this.getChannelBrief(channelId);
    if (!updated) {
      throw new Error(`Failed to update channel brief: ${channelId}`);
    }
    return updated;
  }

  createChannelDecision(input: CreateChannelDecisionInput, now: string): ChannelDecision {
    this.assertChannelExists(input.channelId);
    this.assertSourceRefsInChannel(input.channelId, input);
    if (input.supersedesDecisionId) {
      this.assertDecisionInChannel(input.channelId, input.supersedesDecisionId);
      this.updateChannelDecision(input.supersedesDecisionId, { status: "superseded" }, now);
    }

    const decision: ChannelDecision = {
      id: createChannelDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      sourceTaskId: input.sourceTaskId,
      sourceRunId: input.sourceRunId,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale ?? "",
      alternatives: input.alternatives ?? [],
      status: input.supersedesDecisionId ? "active" : input.status ?? "active",
      supersedesDecisionId: input.supersedesDecisionId,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_decisions (
          id,
          workspace_id,
          channel_id,
          source_message_id,
          source_task_id,
          source_run_id,
          title,
          decision,
          rationale,
          alternatives_json,
          status,
          supersedes_decision_id,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.workspaceId,
        decision.channelId,
        decision.sourceMessageId ?? null,
        decision.sourceTaskId ?? null,
        decision.sourceRunId ?? null,
        decision.title,
        decision.decision,
        decision.rationale,
        stringifyJson(decision.alternatives),
        decision.status,
        decision.supersedesDecisionId ?? null,
        decision.createdBy,
        decision.createdAt,
        decision.updatedAt,
      );

    const created = this.getChannelDecision(decision.id);
    if (!created) {
      throw new Error(`Failed to create channel decision: ${decision.id}`);
    }
    return created;
  }

  getChannelDecision(id: string): ChannelDecision | undefined {
    const row = this.database.prepare(channelDecisionSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelDecision(row) : undefined;
  }

  listChannelDecisions(options: ListChannelDecisionsOptions): ChannelDecision[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelDecisionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelDecision);
  }

  updateChannelDecision(id: string, input: UpdateChannelDecisionInput, now: string): ChannelDecision | undefined {
    const existing = this.getChannelDecision(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelDecision = {
      ...existing,
      title: input.title ?? existing.title,
      decision: input.decision ?? existing.decision,
      rationale: input.rationale ?? existing.rationale,
      alternatives: input.alternatives ?? existing.alternatives,
      status: input.status ?? existing.status,
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_decisions
        SET title = ?, decision = ?, rationale = ?, alternatives_json = ?, status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(next.title, next.decision, next.rationale, stringifyJson(next.alternatives), next.status, next.updatedAt, id);
    return this.getChannelDecision(id);
  }

  createChannelHandoff(input: CreateChannelHandoffInput, now: string): ChannelHandoff {
    this.assertChannelExists(input.channelId);
    this.assertSourceRefsInChannel(input.channelId, input);
    const handoff: ChannelHandoff = {
      id: createChannelHandoffId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      sourceTaskId: input.sourceTaskId,
      sourceRunId: input.sourceRunId,
      fromParticipantId: input.fromParticipantId,
      fromParticipantLabel: input.fromParticipantLabel,
      toParticipantId: input.toParticipantId,
      toParticipantLabel: input.toParticipantLabel,
      reason: input.reason,
      requiredInput: input.requiredInput,
      expectedOutput: input.expectedOutput,
      status: input.status ?? "proposed",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_handoffs (
          id,
          workspace_id,
          channel_id,
          source_message_id,
          source_task_id,
          source_run_id,
          from_participant_id,
          from_participant_label,
          to_participant_id,
          to_participant_label,
          reason,
          required_input,
          expected_output,
          status,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        handoff.id,
        handoff.workspaceId,
        handoff.channelId,
        handoff.sourceMessageId ?? null,
        handoff.sourceTaskId ?? null,
        handoff.sourceRunId ?? null,
        handoff.fromParticipantId,
        handoff.fromParticipantLabel,
        handoff.toParticipantId,
        handoff.toParticipantLabel,
        handoff.reason,
        handoff.requiredInput,
        handoff.expectedOutput,
        handoff.status,
        handoff.createdBy,
        handoff.createdAt,
        handoff.updatedAt,
      );

    const created = this.getChannelHandoff(handoff.id);
    if (!created) {
      throw new Error(`Failed to create channel handoff: ${handoff.id}`);
    }
    return created;
  }

  getChannelHandoff(id: string): ChannelHandoff | undefined {
    const row = this.database.prepare(channelHandoffSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelHandoff(row) : undefined;
  }

  listChannelHandoffs(options: ListChannelHandoffsOptions): ChannelHandoff[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelHandoffSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelHandoff);
  }

  updateChannelHandoff(id: string, input: UpdateChannelHandoffInput, now: string): ChannelHandoff | undefined {
    const existing = this.getChannelHandoff(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelHandoff = {
      ...existing,
      fromParticipantId: input.fromParticipantId ?? existing.fromParticipantId,
      fromParticipantLabel: input.fromParticipantLabel ?? existing.fromParticipantLabel,
      toParticipantId: input.toParticipantId ?? existing.toParticipantId,
      toParticipantLabel: input.toParticipantLabel ?? existing.toParticipantLabel,
      reason: input.reason ?? existing.reason,
      requiredInput: input.requiredInput ?? existing.requiredInput,
      expectedOutput: input.expectedOutput ?? existing.expectedOutput,
      status: input.status ?? existing.status,
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_handoffs
        SET
          from_participant_id = ?,
          from_participant_label = ?,
          to_participant_id = ?,
          to_participant_label = ?,
          reason = ?,
          required_input = ?,
          expected_output = ?,
          status = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.fromParticipantId,
        next.fromParticipantLabel,
        next.toParticipantId,
        next.toParticipantLabel,
        next.reason,
        next.requiredInput,
        next.expectedOutput,
        next.status,
        next.updatedAt,
        id,
      );
    return this.getChannelHandoff(id);
  }

  createWorkflowHandoffIntent(input: CreateWorkflowHandoffIntentInput, now: string): WorkflowHandoffIntent {
    this.assertChannelExists(input.channelId);
    this.assertWorkflowCoordinationRefsInChannel(input.channelId, {
      workflowId: input.workflowId,
      workflowStepId: input.sourceWorkflowStepId,
      runId: input.sourceRunId,
      messageId: input.sourceMessageId,
      handoffId: input.channelHandoffId,
    });
    this.assertWorkflowPacketSourceRefsInChannel(input.channelId, input.sourceRefs ?? []);
    const intent: WorkflowHandoffIntent = {
      schemaVersion: 1,
      id: createWorkflowHandoffIntentId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      workflowId: input.workflowId,
      sourceWorkflowStepId: input.sourceWorkflowStepId,
      sourceRunId: input.sourceRunId,
      sourceMessageId: input.sourceMessageId,
      channelHandoffId: input.channelHandoffId,
      fromParticipantId: input.fromParticipantId,
      fromParticipantLabel: input.fromParticipantLabel,
      toParticipantId: input.toParticipantId,
      toParticipantLabel: input.toParticipantLabel,
      reason: input.reason,
      requiredInput: input.requiredInput,
      expectedOutput: input.expectedOutput,
      riskSummary: input.riskSummary,
      sourceRefs: [...(input.sourceRefs ?? [])],
      status: input.status ?? "proposed",
      validation: input.validation,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    validateWorkflowHandoffIntent(intent);
    this.database
      .prepare(`
        INSERT INTO workflow_handoff_intents (
          id,
          workspace_id,
          channel_id,
          workflow_id,
          source_workflow_step_id,
          source_run_id,
          source_message_id,
          channel_handoff_id,
          from_participant_id,
          from_participant_label,
          to_participant_id,
          to_participant_label,
          reason,
          required_input,
          expected_output,
          risk_summary,
          source_refs_json,
          status,
          validation_json,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        intent.id,
        intent.workspaceId,
        intent.channelId,
        intent.workflowId ?? null,
        intent.sourceWorkflowStepId ?? null,
        intent.sourceRunId ?? null,
        intent.sourceMessageId ?? null,
        intent.channelHandoffId ?? null,
        intent.fromParticipantId,
        intent.fromParticipantLabel,
        intent.toParticipantId,
        intent.toParticipantLabel ?? null,
        intent.reason,
        intent.requiredInput,
        intent.expectedOutput,
        intent.riskSummary ?? null,
        stringifyJson(intent.sourceRefs),
        intent.status,
        intent.validation ? stringifyJson(intent.validation) : null,
        intent.createdBy,
        intent.createdAt,
        intent.updatedAt,
      );
    const created = this.getWorkflowHandoffIntent(intent.id);
    if (!created) {
      throw new Error(`Failed to create workflow handoff intent: ${intent.id}`);
    }
    return created;
  }

  getWorkflowHandoffIntent(id: string): WorkflowHandoffIntent | undefined {
    const row = this.database.prepare(workflowHandoffIntentSelectSql("WHERE id = ?")).get(id);
    return row ? mapWorkflowHandoffIntent(row) : undefined;
  }

  listWorkflowHandoffIntents(options: ListWorkflowHandoffIntentsOptions = {}): WorkflowHandoffIntent[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.workflowId) {
      clauses.push("workflow_id = ?");
      params.push(options.workflowId);
    }
    if (options.sourceWorkflowStepId) {
      clauses.push("source_workflow_step_id = ?");
      params.push(options.sourceWorkflowStepId);
    }
    if (options.sourceRunId) {
      clauses.push("source_run_id = ?");
      params.push(options.sourceRunId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${workflowHandoffIntentSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapWorkflowHandoffIntent);
  }

  updateWorkflowHandoffIntent(id: string, input: UpdateWorkflowHandoffIntentInput, now: string): WorkflowHandoffIntent | undefined {
    const existing = this.getWorkflowHandoffIntent(id);
    if (!existing) {
      return undefined;
    }
    const channelHandoffId = nullableUpdate(input.channelHandoffId, existing.channelHandoffId);
    if (channelHandoffId) {
      this.assertHandoffInChannel(existing.channelId, channelHandoffId);
    }
    const sourceRefs = input.sourceRefs ? [...input.sourceRefs] : existing.sourceRefs;
    this.assertWorkflowPacketSourceRefsInChannel(existing.channelId, sourceRefs);
    const next: WorkflowHandoffIntent = {
      ...existing,
      channelHandoffId,
      toParticipantLabel: nullableUpdate(input.toParticipantLabel, existing.toParticipantLabel),
      reason: input.reason ?? existing.reason,
      requiredInput: input.requiredInput ?? existing.requiredInput,
      expectedOutput: input.expectedOutput ?? existing.expectedOutput,
      riskSummary: nullableUpdate(input.riskSummary, existing.riskSummary),
      sourceRefs,
      status: input.status ?? existing.status,
      validation: nullableUpdate(input.validation, existing.validation),
      updatedAt: now,
    };
    validateWorkflowHandoffIntent(next);
    this.database
      .prepare(`
        UPDATE workflow_handoff_intents
        SET
          channel_handoff_id = ?,
          to_participant_label = ?,
          reason = ?,
          required_input = ?,
          expected_output = ?,
          risk_summary = ?,
          source_refs_json = ?,
          status = ?,
          validation_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.channelHandoffId ?? null,
        next.toParticipantLabel ?? null,
        next.reason,
        next.requiredInput,
        next.expectedOutput,
        next.riskSummary ?? null,
        stringifyJson(next.sourceRefs),
        next.status,
        next.validation ? stringifyJson(next.validation) : null,
        next.updatedAt,
        id,
      );
    return this.getWorkflowHandoffIntent(id);
  }

  createWorkflowSelectorDecision(input: CreateWorkflowSelectorDecisionInput, now: string): WorkflowSelectorDecision {
    this.assertChannelExists(input.channelId);
    this.assertWorkflowCoordinationRefsInChannel(input.channelId, {
      workflowId: input.workflowId,
      workflowStepId: input.sourceWorkflowStepId,
    });
    this.assertWorkflowSelectorTargetsInChannel(input.channelId, input);
    this.assertWorkflowPacketSourceRefsInChannel(input.channelId, input.sourceRefs ?? []);
    const decision: WorkflowSelectorDecision = {
      schemaVersion: 1,
      id: createWorkflowSelectorDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      workflowId: input.workflowId,
      sourceWorkflowStepId: input.sourceWorkflowStepId,
      selectorNodeId: input.selectorNodeId,
      targetKind: input.targetKind,
      selectedWorkflowStepId: input.selectedWorkflowStepId,
      selectedGraphNodeId: input.selectedGraphNodeId,
      selectedTeammateId: input.selectedTeammateId,
      selectedSkillId: input.selectedSkillId,
      selectedHandoffIntentId: input.selectedHandoffIntentId,
      reason: input.reason,
      alternativesConsidered: [...(input.alternativesConsidered ?? [])],
      confidence: input.confidence ?? "medium",
      requiresUserConfirmation: input.requiresUserConfirmation ?? false,
      status: input.status ?? "accepted",
      sourceRefs: [...(input.sourceRefs ?? [])],
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    validateWorkflowSelectorDecision(decision);
    this.database
      .prepare(`
        INSERT INTO workflow_selector_decisions (
          id,
          workspace_id,
          channel_id,
          workflow_id,
          source_workflow_step_id,
          selector_node_id,
          target_kind,
          selected_workflow_step_id,
          selected_graph_node_id,
          selected_teammate_id,
          selected_skill_id,
          selected_handoff_intent_id,
          reason,
          alternatives_json,
          confidence,
          requires_user_confirmation,
          status,
          source_refs_json,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.workspaceId,
        decision.channelId,
        decision.workflowId,
        decision.sourceWorkflowStepId ?? null,
        decision.selectorNodeId ?? null,
        decision.targetKind,
        decision.selectedWorkflowStepId ?? null,
        decision.selectedGraphNodeId ?? null,
        decision.selectedTeammateId ?? null,
        decision.selectedSkillId ?? null,
        decision.selectedHandoffIntentId ?? null,
        decision.reason,
        stringifyJson(decision.alternativesConsidered),
        decision.confidence,
        decision.requiresUserConfirmation ? 1 : 0,
        decision.status,
        stringifyJson(decision.sourceRefs),
        decision.createdBy,
        decision.createdAt,
        decision.updatedAt,
      );
    const created = this.getWorkflowSelectorDecision(decision.id);
    if (!created) {
      throw new Error(`Failed to create workflow selector decision: ${decision.id}`);
    }
    return created;
  }

  getWorkflowSelectorDecision(id: string): WorkflowSelectorDecision | undefined {
    const row = this.database.prepare(workflowSelectorDecisionSelectSql("WHERE id = ?")).get(id);
    return row ? mapWorkflowSelectorDecision(row) : undefined;
  }

  listWorkflowSelectorDecisions(options: ListWorkflowSelectorDecisionsOptions = {}): WorkflowSelectorDecision[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.workflowId) {
      clauses.push("workflow_id = ?");
      params.push(options.workflowId);
    }
    if (options.sourceWorkflowStepId) {
      clauses.push("source_workflow_step_id = ?");
      params.push(options.sourceWorkflowStepId);
    }
    if (options.selectedWorkflowStepId) {
      clauses.push("selected_workflow_step_id = ?");
      params.push(options.selectedWorkflowStepId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${workflowSelectorDecisionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapWorkflowSelectorDecision);
  }

  updateWorkflowSelectorDecision(id: string, input: UpdateWorkflowSelectorDecisionInput, now: string): WorkflowSelectorDecision | undefined {
    const existing = this.getWorkflowSelectorDecision(id);
    if (!existing) {
      return undefined;
    }
    const sourceRefs = input.sourceRefs ? [...input.sourceRefs] : existing.sourceRefs;
    this.assertWorkflowPacketSourceRefsInChannel(existing.channelId, sourceRefs);
    const next: WorkflowSelectorDecision = {
      ...existing,
      reason: input.reason ?? existing.reason,
      alternativesConsidered: input.alternativesConsidered ? [...input.alternativesConsidered] : existing.alternativesConsidered,
      confidence: input.confidence ?? existing.confidence,
      requiresUserConfirmation: input.requiresUserConfirmation ?? existing.requiresUserConfirmation,
      status: input.status ?? existing.status,
      sourceRefs,
      updatedAt: now,
    };
    validateWorkflowSelectorDecision(next);
    this.database
      .prepare(`
        UPDATE workflow_selector_decisions
        SET
          reason = ?,
          alternatives_json = ?,
          confidence = ?,
          requires_user_confirmation = ?,
          status = ?,
          source_refs_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.reason,
        stringifyJson(next.alternativesConsidered),
        next.confidence,
        next.requiresUserConfirmation ? 1 : 0,
        next.status,
        stringifyJson(next.sourceRefs),
        next.updatedAt,
        id,
      );
    return this.getWorkflowSelectorDecision(id);
  }

  createChannelContextSummary(input: CreateChannelContextSummaryInput, now: string): ChannelContextSummary {
    this.assertChannelExists(input.channelId);
    this.assertSummaryTargetInChannel(input.channelId, input.targetType, input.targetId);
    for (const messageId of input.sourceMessageIds ?? []) {
      this.assertMessageInChannel(input.channelId, messageId);
    }
    for (const decisionId of input.decisionIds ?? []) {
      this.assertDecisionInChannel(input.channelId, decisionId);
    }

    const summary: ChannelContextSummary = {
      id: createChannelContextSummaryId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      targetType: input.targetType,
      targetId: input.targetId,
      sourceMessageIds: input.sourceMessageIds ?? [],
      decisionIds: input.decisionIds ?? [],
      summary: input.summary,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      openQuestions: input.openQuestions ?? [],
      authorType: input.authorType,
      authorId: input.authorId,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_context_summaries (
          id,
          workspace_id,
          channel_id,
          target_type,
          target_id,
          source_message_ids_json,
          decision_ids_json,
          summary,
          acceptance_criteria_json,
          open_questions_json,
          author_type,
          author_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        summary.id,
        summary.workspaceId,
        summary.channelId,
        summary.targetType,
        summary.targetId,
        stringifyJson(summary.sourceMessageIds),
        stringifyJson(summary.decisionIds),
        summary.summary,
        stringifyJson(summary.acceptanceCriteria),
        stringifyJson(summary.openQuestions),
        summary.authorType,
        summary.authorId ?? null,
        summary.createdAt,
        summary.updatedAt,
      );

    const created = this.getChannelContextSummary(summary.id);
    if (!created) {
      throw new Error(`Failed to create channel context summary: ${summary.id}`);
    }
    return created;
  }

  getChannelContextSummary(id: string): ChannelContextSummary | undefined {
    const row = this.database.prepare(channelContextSummarySelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelContextSummary(row) : undefined;
  }

  listChannelContextSummaries(options: ListChannelContextSummariesOptions): ChannelContextSummary[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.targetType) {
      clauses.push("target_type = ?");
      params.push(options.targetType);
    }
    if (options.targetId) {
      clauses.push("target_id = ?");
      params.push(options.targetId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelContextSummarySelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelContextSummary);
  }

  updateChannelContextSummary(
    id: string,
    input: UpdateChannelContextSummaryInput,
    now: string,
  ): ChannelContextSummary | undefined {
    const existing = this.getChannelContextSummary(id);
    if (!existing) {
      return undefined;
    }
    const targetType = input.targetType ?? existing.targetType;
    const targetId = input.targetId ?? existing.targetId;
    this.assertSummaryTargetInChannel(existing.channelId, targetType, targetId);
    for (const messageId of input.sourceMessageIds ?? existing.sourceMessageIds) {
      this.assertMessageInChannel(existing.channelId, messageId);
    }
    for (const decisionId of input.decisionIds ?? existing.decisionIds) {
      this.assertDecisionInChannel(existing.channelId, decisionId);
    }
    const next: ChannelContextSummary = {
      ...existing,
      targetType,
      targetId,
      sourceMessageIds: input.sourceMessageIds ?? existing.sourceMessageIds,
      decisionIds: input.decisionIds ?? existing.decisionIds,
      summary: input.summary ?? existing.summary,
      acceptanceCriteria: input.acceptanceCriteria ?? existing.acceptanceCriteria,
      openQuestions: input.openQuestions ?? existing.openQuestions,
      authorType: input.authorType ?? existing.authorType,
      authorId: nullableUpdate(input.authorId, existing.authorId),
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_context_summaries
        SET
          target_type = ?,
          target_id = ?,
          source_message_ids_json = ?,
          decision_ids_json = ?,
          summary = ?,
          acceptance_criteria_json = ?,
          open_questions_json = ?,
          author_type = ?,
          author_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.targetType,
        next.targetId,
        stringifyJson(next.sourceMessageIds),
        stringifyJson(next.decisionIds),
        next.summary,
        stringifyJson(next.acceptanceCriteria),
        stringifyJson(next.openQuestions),
        next.authorType,
        next.authorId ?? null,
        next.updatedAt,
        id,
      );
    return this.getChannelContextSummary(id);
  }

  createChannelWorkflow(input: CreateChannelWorkflowInput, now: string): ChannelWorkflow {
    this.assertChannelExists(input.channelId);
    if (input.sourceHandoffId) {
      this.assertHandoffInChannel(input.channelId, input.sourceHandoffId);
    }

    const workflow: ChannelWorkflow = {
      id: createChannelWorkflowId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceHandoffId: input.sourceHandoffId,
      title: input.title,
      objective: input.objective,
      status: input.status ?? "draft",
      createdBy: input.createdBy,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_workflows (
          id,
          workspace_id,
          channel_id,
          source_handoff_id,
          title,
          objective,
          status,
          created_by,
          metadata_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        workflow.id,
        workflow.workspaceId,
        workflow.channelId,
        workflow.sourceHandoffId ?? null,
        workflow.title,
        workflow.objective,
        workflow.status,
        workflow.createdBy,
        workflow.metadata ? stringifyJson(workflow.metadata) : null,
        workflow.createdAt,
        workflow.updatedAt,
      );

    const created = this.getChannelWorkflow(workflow.id);
    if (!created) {
      throw new Error(`Failed to create channel workflow: ${workflow.id}`);
    }
    return created;
  }

  getChannelWorkflow(id: string): ChannelWorkflow | undefined {
    const row = this.database.prepare(channelWorkflowSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelWorkflow(row) : undefined;
  }

  listChannelWorkflows(options: ListChannelWorkflowsOptions): ChannelWorkflow[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelWorkflowSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelWorkflow);
  }

  updateChannelWorkflow(id: string, input: UpdateChannelWorkflowInput, now: string): ChannelWorkflow | undefined {
    const existing = this.getChannelWorkflow(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelWorkflow = {
      ...existing,
      title: input.title ?? existing.title,
      objective: input.objective ?? existing.objective,
      status: input.status ?? existing.status,
      metadata: nullableUpdate(input.metadata, existing.metadata),
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_workflows
        SET title = ?, objective = ?, status = ?, metadata_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(next.title, next.objective, next.status, next.metadata ? stringifyJson(next.metadata) : null, next.updatedAt, id);
    return this.getChannelWorkflow(id);
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
    const workflow = this.getChannelWorkflow(input.workflowId);
    if (!workflow) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.findStateTransitionByIdempotency("workflow", input.workflowId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: workflow.status, to: workflow.status, duplicate: true };
      }
    }
    const result = transitionWorkflow({
      entityId: input.workflowId,
      currentStatus: workflow.status,
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
      .prepare("UPDATE channel_workflows SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(result.to, input.now, input.workflowId, result.from);
    if (Number(update.changes) === 0) {
      const current = this.getChannelWorkflow(input.workflowId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? workflow.status };
    }
    this.recordStateTransitionEvent({
      workspaceId: workflow.workspaceId,
      entityType: "workflow",
      entityId: input.workflowId,
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

  createChannelWorkflowStep(input: CreateChannelWorkflowStepInput, now: string): ChannelWorkflowStep {
    const workflow = this.getChannelWorkflow(input.workflowId);
    if (!workflow) {
      throw new Error(`Channel workflow not found: ${input.workflowId}`);
    }
    if (input.sourceHandoffId) {
      this.assertHandoffInChannel(workflow.channelId, input.sourceHandoffId);
    }
    if (input.contextSummaryId) {
      this.assertContextSummaryInChannel(workflow.channelId, input.contextSummaryId);
    }
    const position = input.position ?? this.nextWorkflowStepPosition(input.workflowId);
    const step: ChannelWorkflowStep = {
      id: createChannelWorkflowStepId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: workflow.channelId,
      workflowId: workflow.id,
      sourceHandoffId: input.sourceHandoffId,
      contextSummaryId: input.contextSummaryId,
      position,
      title: input.title,
      prompt: input.prompt,
      toParticipantId: input.toParticipantId,
	      toParticipantLabel: input.toParticipantLabel,
	      status: input.status ?? "queued",
	      metadata: input.metadata,
	      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_workflow_steps (
          id,
          workspace_id,
          channel_id,
          workflow_id,
          source_handoff_id,
          context_summary_id,
          task_id,
          run_id,
          position,
          title,
          prompt,
          to_participant_id,
          to_participant_label,
          status,
	          blocker,
	          result_summary,
	          metadata_json,
	          created_at,
	          updated_at
	        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        step.id,
        step.workspaceId,
        step.channelId,
        step.workflowId,
        step.sourceHandoffId ?? null,
        step.contextSummaryId ?? null,
        null,
        null,
        step.position,
        step.title,
        step.prompt,
        step.toParticipantId,
        step.toParticipantLabel,
	        step.status,
	        null,
	        null,
	        step.metadata ? stringifyJson(step.metadata) : null,
	        step.createdAt,
	        step.updatedAt,
      );

    const created = this.getChannelWorkflowStep(step.id);
    if (!created) {
      throw new Error(`Failed to create channel workflow step: ${step.id}`);
    }
    return created;
  }

  getChannelWorkflowStep(id: string): ChannelWorkflowStep | undefined {
    const row = this.database.prepare(channelWorkflowStepSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelWorkflowStep(row) : undefined;
  }

  listChannelWorkflowSteps(options: ListChannelWorkflowStepsOptions): ChannelWorkflowStep[] {
    const clauses = ["workspace_id = ?", "workflow_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.workflowId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelWorkflowStepSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY position ASC, created_at ASC LIMIT ?`)
      .all(...params)
      .map(mapChannelWorkflowStep);
  }

  updateChannelWorkflowStep(
    id: string,
    input: UpdateChannelWorkflowStepInput,
    now: string,
  ): ChannelWorkflowStep | undefined {
    const existing = this.getChannelWorkflowStep(id);
    if (!existing) {
      return undefined;
    }
    const sourceHandoffId = nullableUpdate(input.sourceHandoffId, existing.sourceHandoffId);
    const contextSummaryId = nullableUpdate(input.contextSummaryId, existing.contextSummaryId);
    const taskId = nullableUpdate(input.taskId, existing.taskId);
    const runId = nullableUpdate(input.runId, existing.runId);
    if (sourceHandoffId) {
      this.assertHandoffInChannel(existing.channelId, sourceHandoffId);
    }
    if (contextSummaryId) {
      this.assertContextSummaryInChannel(existing.channelId, contextSummaryId);
    }
    if (taskId) {
      this.assertTaskInChannel(existing.channelId, taskId);
    }
    if (runId) {
      this.assertRunInChannel(existing.channelId, runId);
    }
	    const next: ChannelWorkflowStep = {
	      ...existing,
      sourceHandoffId,
      contextSummaryId,
      taskId,
      runId,
      position: input.position ?? existing.position,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      toParticipantId: input.toParticipantId ?? existing.toParticipantId,
      toParticipantLabel: input.toParticipantLabel ?? existing.toParticipantLabel,
      status: input.status ?? existing.status,
	      blocker: nullableUpdate(input.blocker, existing.blocker),
	      resultSummary: nullableUpdate(input.resultSummary, existing.resultSummary),
	      metadata: nullableUpdate(input.metadata, existing.metadata),
	      updatedAt: now,
	    };
    this.database
      .prepare(`
        UPDATE channel_workflow_steps
        SET
          source_handoff_id = ?,
          context_summary_id = ?,
          task_id = ?,
          run_id = ?,
          position = ?,
          title = ?,
          prompt = ?,
          to_participant_id = ?,
          to_participant_label = ?,
	          status = ?,
	          blocker = ?,
	          result_summary = ?,
	          metadata_json = ?,
	          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.sourceHandoffId ?? null,
        next.contextSummaryId ?? null,
        next.taskId ?? null,
        next.runId ?? null,
        next.position,
        next.title,
        next.prompt,
        next.toParticipantId,
        next.toParticipantLabel,
	        next.status,
	        next.blocker ?? null,
	        next.resultSummary ?? null,
	        next.metadata ? stringifyJson(next.metadata) : null,
	        next.updatedAt,
        id,
      );
    return this.getChannelWorkflowStep(id);
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
    const step = this.getChannelWorkflowStep(input.workflowStepId);
    if (!step) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.findStateTransitionByIdempotency("workflow_step", input.workflowStepId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: step.status, to: step.status, duplicate: true };
      }
    }
    const result = transitionWorkflowStep({
      entityId: input.workflowStepId,
      currentStatus: step.status,
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
        UPDATE channel_workflow_steps
        SET
          status = ?,
          task_id = ?,
          run_id = ?,
          blocker = ?,
          result_summary = ?,
          updated_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        result.to,
        input.taskId === undefined ? step.taskId ?? null : input.taskId,
        input.runId === undefined ? step.runId ?? null : input.runId,
        input.blocker === undefined ? step.blocker ?? null : input.blocker,
        input.resultSummary === undefined ? step.resultSummary ?? null : input.resultSummary,
        input.now,
        input.workflowStepId,
        result.from,
      );
    if (Number(update.changes) === 0) {
      const current = this.getChannelWorkflowStep(input.workflowStepId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? step.status };
    }
    this.recordStateTransitionEvent({
      workspaceId: step.workspaceId,
      entityType: "workflow_step",
      entityId: input.workflowStepId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    if (result.to === "succeeded" || result.to === "failed" || result.to === "skipped" || result.to === "cancelled") {
      this.releaseResourceLeasesForOwner("workflow_step", input.workflowStepId, input.now);
    }
    return result;
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

    this.database
      .prepare(`
        INSERT INTO external_work_items (
          id,
          workspace_id,
          channel_id,
          source_kind,
          work_item_kind,
          external_id,
          identifier,
          idempotency_key,
          workflow_id,
          workflow_step_id,
          artifact_ids_json,
          item_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.workspaceId,
        record.channelId,
        record.sourceKind,
        record.workItemKind,
        record.externalId,
        record.identifier,
        record.idempotencyKey,
        record.workflowId,
        record.workflowStepId,
        stringifyJson(record.artifactIds),
        stringifyJson(record.item),
        record.createdAt,
        record.updatedAt,
      );

    const created = this.getExternalWorkRecord(record.id);
    if (!created) {
      throw new Error(`Failed to create external work item: ${record.id}`);
    }
    return {
      externalWork: created,
      workflow,
      workflowStep,
      duplicate: false,
    };
  }

  getExternalWorkRecord(id: string): ExternalWorkRecord | undefined {
    const row = this.database.prepare(externalWorkSelectSql("WHERE id = ?")).get(id);
    return row ? mapExternalWorkRecord(row) : undefined;
  }

  listExternalWorkRecords(options: ListExternalWorkRecordsOptions = {}): ExternalWorkRecord[] {
    const clauses = ["w.workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("w.channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceKind) {
      clauses.push("w.source_kind = ?");
      params.push(options.sourceKind);
    }
    if (options.workItemKind) {
      clauses.push("w.work_item_kind = ?");
      params.push(options.workItemKind);
    }
    if (options.schedulerStatus) {
      clauses.push("s.scheduler_status = ?");
      params.push(options.schedulerStatus);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`
        SELECT
          ${externalWorkSelectColumnsFromAlias("w")}
        FROM external_work_items w
        LEFT JOIN external_work_scheduler_state s ON s.external_work_id = w.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY w.updated_at DESC, w.id DESC
        LIMIT ?
      `)
      .all(...params)
      .map(mapExternalWorkRecord);
  }

  countExternalWorkRecords(options: Omit<ListExternalWorkRecordsOptions, "limit"> = {}): number {
    const clauses = ["w.workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("w.channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceKind) {
      clauses.push("w.source_kind = ?");
      params.push(options.sourceKind);
    }
    if (options.workItemKind) {
      clauses.push("w.work_item_kind = ?");
      params.push(options.workItemKind);
    }
    if (options.schedulerStatus) {
      clauses.push("s.scheduler_status = ?");
      params.push(options.schedulerStatus);
    }
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM external_work_items w
        LEFT JOIN external_work_scheduler_state s ON s.external_work_id = w.id
        WHERE ${clauses.join(" AND ")}
      `)
      .get(...params) as { readonly count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  getExternalWorkRecordByIdempotency(sourceKind: ExternalWorkRecord["sourceKind"], idempotencyKey: string): ExternalWorkRecord | undefined {
    const row = this.database
      .prepare(externalWorkSelectSql("WHERE workspace_id = ? AND source_kind = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceKind, idempotencyKey);
    return row ? mapExternalWorkRecord(row) : undefined;
  }

  updateExternalWorkArtifacts(id: string, artifactIds: readonly string[], now: string): ExternalWorkRecord | undefined {
    const existing = this.getExternalWorkRecord(id);
    if (!existing) {
      return undefined;
    }
    this.database
      .prepare("UPDATE external_work_items SET artifact_ids_json = ?, updated_at = ? WHERE id = ?")
      .run(stringifyJson([...artifactIds]), now, id);
    return this.getExternalWorkRecord(id);
  }

  routeExternalWorkRecord(id: string, input: ExternalWorkRouteRequest, now: string): ExternalWorkRecord | undefined {
    const existing = this.getExternalWorkRecord(id);
    if (!existing) {
      return undefined;
    }
    this.assertChannelExists(input.channelId);
    const nextItem: ExternalWorkItem = input.priority === undefined
      ? existing.item
      : { ...existing.item, priority: input.priority };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
          UPDATE external_work_items
          SET channel_id = ?, item_json = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(input.channelId, stringifyJson(nextItem), now, id);
      this.database
        .prepare("UPDATE external_work_scheduler_state SET channel_id = ?, updated_at = ? WHERE external_work_id = ?")
        .run(input.channelId, now, id);
      this.database
        .prepare("UPDATE external_work_actions SET channel_id = ?, updated_at = ? WHERE external_work_id = ?")
        .run(input.channelId, now, id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getExternalWorkRecord(id);
  }

  createExternalWorkAction(input: CreateExternalWorkActionInput, now: string): ExternalWorkAction {
    this.assertChannelExists(input.channelId);
    const externalWork = this.getExternalWorkRecord(input.externalWorkId);
    if (!externalWork) {
      throw new Error(`External work item not found: ${input.externalWorkId}`);
    }
    if (externalWork.channelId !== input.channelId) {
      throw new Error(`External work item does not belong to channel: ${input.channelId}`);
    }
    const existing = this.getExternalWorkActionByIdempotency(input.sourceKind, input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const action: ExternalWorkAction = omitUndefined({
      id: createExternalWorkActionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      externalWorkId: input.externalWorkId,
      sourceKind: input.sourceKind,
      actionKind: input.actionKind,
      status: input.status,
      approvalId: input.approvalId,
      idempotencyKey: input.idempotencyKey,
      target: input.target,
      payload: input.payload,
      approvalRequirement: input.approvalRequirement,
      artifactIds: [...(input.artifactIds ?? [])],
      executionAttemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    this.database
      .prepare(`
        INSERT INTO external_work_actions (
          id,
          workspace_id,
          channel_id,
          external_work_id,
          source_kind,
          action_kind,
          status,
          approval_id,
          idempotency_key,
          target_json,
          payload_json,
          approval_requirement,
          artifact_ids_json,
          execution_attempt_count,
          last_attempt_at,
          next_attempt_at,
          last_error_code,
          last_error_message,
          created_at,
          updated_at,
          executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        action.id,
        action.workspaceId,
        action.channelId,
        action.externalWorkId,
        action.sourceKind,
        action.actionKind,
        action.status,
        action.approvalId ?? null,
        action.idempotencyKey,
        stringifyJson(action.target),
        stringifyJson(action.payload),
        action.approvalRequirement,
        stringifyJson(action.artifactIds),
        action.executionAttemptCount,
        null,
        null,
        null,
        null,
        action.createdAt,
        action.updatedAt,
        null,
      );

    const created = this.getExternalWorkAction(action.id);
    if (!created) {
      throw new Error(`Failed to create external work action: ${action.id}`);
    }
    return created;
  }

  getExternalWorkAction(id: string): ExternalWorkAction | undefined {
    const row = this.database.prepare(externalWorkActionSelectSql("WHERE id = ?")).get(id);
    return row ? mapExternalWorkAction(row) : undefined;
  }

  getExternalWorkActionByIdempotency(sourceKind: ExternalWorkAction["sourceKind"], idempotencyKey: string): ExternalWorkAction | undefined {
    const row = this.database
      .prepare(externalWorkActionSelectSql("WHERE workspace_id = ? AND source_kind = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceKind, idempotencyKey);
    return row ? mapExternalWorkAction(row) : undefined;
  }

  listExternalWorkActions(options: ListExternalWorkActionsOptions = {}): ExternalWorkAction[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.actionKind) {
      clauses.push("action_kind = ?");
      params.push(options.actionKind);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${externalWorkActionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapExternalWorkAction);
  }

  countExternalWorkActions(options: Omit<ListExternalWorkActionsOptions, "limit"> = {}): number {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.actionKind) {
      clauses.push("action_kind = ?");
      params.push(options.actionKind);
    }
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM external_work_actions WHERE ${clauses.join(" AND ")}`)
      .get(...params) as { readonly count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  updateExternalWorkAction(id: string, input: UpdateExternalWorkActionInput, now: string): ExternalWorkAction | undefined {
    const existing = this.getExternalWorkAction(id);
    if (!existing) {
      return undefined;
    }
    this.database
      .prepare(`
        UPDATE external_work_actions
        SET
          status = ?,
          approval_id = ?,
          artifact_ids_json = ?,
          execution_attempt_count = ?,
          last_attempt_at = ?,
          next_attempt_at = ?,
          last_error_code = ?,
          last_error_message = ?,
          updated_at = ?,
          executed_at = ?
        WHERE id = ?
      `)
      .run(
        input.status ?? existing.status,
        input.approvalId === undefined ? existing.approvalId ?? null : input.approvalId,
        stringifyJson(input.artifactIds ?? existing.artifactIds),
        input.executionAttemptCount ?? existing.executionAttemptCount,
        input.lastAttemptAt === undefined ? existing.lastAttemptAt ?? null : input.lastAttemptAt,
        input.nextAttemptAt === undefined ? existing.nextAttemptAt ?? null : input.nextAttemptAt,
        input.lastErrorCode === undefined ? existing.lastErrorCode ?? null : input.lastErrorCode,
        input.lastErrorMessage === undefined ? existing.lastErrorMessage ?? null : input.lastErrorMessage,
        now,
        input.executedAt === undefined ? existing.executedAt ?? null : input.executedAt,
        id,
      );
    return this.getExternalWorkAction(id);
  }

  createExternalWorkCiTriage(input: CreateExternalWorkCiTriageInput, now: string): ExternalWorkCiTriageRecord {
    this.assertChannelExists(input.channelId);
    const externalWork = this.getExternalWorkRecord(input.externalWorkId);
    if (!externalWork) {
      throw new Error(`External work item not found: ${input.externalWorkId}`);
    }
    if (externalWork.channelId !== input.channelId) {
      throw new Error(`External work item does not belong to channel: ${input.channelId}`);
    }
    const existing = this.getExternalWorkCiTriageByFailureKey(input.sourceKind, input.failureKey);
    if (existing) {
      return existing;
    }

    const record: ExternalWorkCiTriageRecord = omitUndefined({
      id: createExternalWorkCiTriageId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      externalWorkId: input.externalWorkId,
      sourceKind: input.sourceKind,
      repository: input.repository,
      subjectKind: input.subjectKind,
      subjectNumber: input.subjectNumber,
      headSha: input.headSha,
      failureKey: input.failureKey,
      status: input.status,
      checkName: input.checkName,
      workflowName: input.workflowName,
      jobName: input.jobName,
      conclusion: input.conclusion,
      htmlUrl: input.htmlUrl,
      firstFailingCommand: input.firstFailingCommand,
      reproductionCommand: input.reproductionCommand,
      suspectedSourcePath: input.suspectedSourcePath,
      taskId: input.taskId,
      runId: input.runId,
      artifactIds: [...(input.artifactIds ?? [])],
      failure: input.failure,
      lastErrorCode: input.lastErrorCode,
      lastErrorMessage: input.lastErrorMessage,
      createdAt: now,
      updatedAt: now,
    });

    this.database
      .prepare(`
        INSERT INTO external_work_ci_triage (
          id,
          workspace_id,
          channel_id,
          external_work_id,
          source_kind,
          repository,
          subject_kind,
          subject_number,
          head_sha,
          failure_key,
          status,
          check_name,
          workflow_name,
          job_name,
          conclusion,
          html_url,
          first_failing_command,
          reproduction_command,
          suspected_source_path,
          task_id,
          run_id,
          artifact_ids_json,
          failure_json,
          last_error_code,
          last_error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.workspaceId,
        record.channelId,
        record.externalWorkId,
        record.sourceKind,
        record.repository,
        record.subjectKind,
        record.subjectNumber,
        record.headSha,
        record.failureKey,
        record.status,
        record.checkName,
        record.workflowName ?? null,
        record.jobName ?? null,
        record.conclusion,
        record.htmlUrl ?? null,
        record.firstFailingCommand ?? null,
        record.reproductionCommand ?? null,
        record.suspectedSourcePath ?? null,
        record.taskId ?? null,
        record.runId ?? null,
        stringifyJson(record.artifactIds),
        stringifyJson(record.failure),
        record.lastErrorCode ?? null,
        record.lastErrorMessage ?? null,
        record.createdAt,
        record.updatedAt,
      );

    const created = this.getExternalWorkCiTriage(record.id);
    if (!created) {
      throw new Error(`Failed to create external work CI triage: ${record.id}`);
    }
    return created;
  }

  getExternalWorkCiTriage(id: string): ExternalWorkCiTriageRecord | undefined {
    const row = this.database.prepare(externalWorkCiTriageSelectSql("WHERE id = ?")).get(id);
    return row ? mapExternalWorkCiTriage(row) : undefined;
  }

  getExternalWorkCiTriageByFailureKey(
    sourceKind: ExternalWorkCiTriageRecord["sourceKind"],
    failureKey: string,
  ): ExternalWorkCiTriageRecord | undefined {
    const row = this.database
      .prepare(externalWorkCiTriageSelectSql("WHERE workspace_id = ? AND source_kind = ? AND failure_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceKind, failureKey);
    return row ? mapExternalWorkCiTriage(row) : undefined;
  }

  listExternalWorkCiTriage(options: ListExternalWorkCiTriageOptions = {}): ExternalWorkCiTriageRecord[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${externalWorkCiTriageSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapExternalWorkCiTriage);
  }

  countExternalWorkCiTriage(options: Omit<ListExternalWorkCiTriageOptions, "limit"> = {}): number {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM external_work_ci_triage WHERE ${clauses.join(" AND ")}`)
      .get(...params) as { readonly count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  updateExternalWorkCiTriage(
    id: string,
    input: UpdateExternalWorkCiTriageInput,
    now: string,
  ): ExternalWorkCiTriageRecord | undefined {
    const existing = this.getExternalWorkCiTriage(id);
    if (!existing) {
      return undefined;
    }
    this.database
      .prepare(`
        UPDATE external_work_ci_triage
        SET
          status = ?,
          first_failing_command = ?,
          reproduction_command = ?,
          suspected_source_path = ?,
          task_id = ?,
          run_id = ?,
          artifact_ids_json = ?,
          failure_json = ?,
          last_error_code = ?,
          last_error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.status ?? existing.status,
        nullableUpdate(input.firstFailingCommand, existing.firstFailingCommand) ?? null,
        nullableUpdate(input.reproductionCommand, existing.reproductionCommand) ?? null,
        nullableUpdate(input.suspectedSourcePath, existing.suspectedSourcePath) ?? null,
        nullableUpdate(input.taskId, existing.taskId) ?? null,
        nullableUpdate(input.runId, existing.runId) ?? null,
        stringifyJson(input.artifactIds ?? existing.artifactIds),
        stringifyJson(input.failure ?? existing.failure),
        nullableUpdate(input.lastErrorCode, existing.lastErrorCode) ?? null,
        nullableUpdate(input.lastErrorMessage, existing.lastErrorMessage) ?? null,
        now,
        id,
      );
    return this.getExternalWorkCiTriage(id);
  }

  upsertExternalWorkSchedulerState(input: UpsertExternalWorkSchedulerStateInput, now: string): ExternalWorkSchedulerState {
    this.assertChannelExists(input.channelId);
    if (!this.getExternalWorkRecord(input.externalWorkId)) {
      throw new Error(`External work item not found: ${input.externalWorkId}`);
    }
    this.database
      .prepare(`
        INSERT INTO external_work_scheduler_state (
          external_work_id,
          workspace_id,
          channel_id,
          subject_key,
          source_key,
          workflow_id,
          workflow_step_id,
          scheduler_status,
          attempt_count,
          last_attempt_at,
          next_attempt_at,
          max_retry_backoff_ms,
          last_error_code,
          last_error_message,
          workspace_path,
          workspace_mode,
          hook_artifact_ids_json,
          last_reconciled_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_work_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          subject_key = excluded.subject_key,
          source_key = excluded.source_key,
          workflow_id = excluded.workflow_id,
          workflow_step_id = excluded.workflow_step_id,
          scheduler_status = excluded.scheduler_status,
          attempt_count = excluded.attempt_count,
          last_attempt_at = excluded.last_attempt_at,
          next_attempt_at = excluded.next_attempt_at,
          max_retry_backoff_ms = excluded.max_retry_backoff_ms,
          last_error_code = excluded.last_error_code,
          last_error_message = excluded.last_error_message,
          workspace_path = excluded.workspace_path,
          workspace_mode = excluded.workspace_mode,
          hook_artifact_ids_json = excluded.hook_artifact_ids_json,
          last_reconciled_at = excluded.last_reconciled_at,
          updated_at = excluded.updated_at
      `)
      .run(
        input.externalWorkId,
        DEFAULT_WORKSPACE_ID,
        input.channelId,
        input.subjectKey,
        input.sourceKey,
        input.workflowId,
        input.workflowStepId,
        input.schedulerStatus,
        input.attemptCount ?? 0,
        input.lastAttemptAt ?? null,
        input.nextAttemptAt ?? null,
        input.maxRetryBackoffMs,
        input.lastErrorCode ?? null,
        input.lastErrorMessage ?? null,
        input.workspacePath ?? null,
        input.workspaceMode ?? null,
        stringifyJson(input.hookArtifactIds ?? []),
        input.lastReconciledAt ?? null,
        now,
        now,
      );
    const created = this.getExternalWorkSchedulerState(input.externalWorkId);
    if (!created) {
      throw new Error(`Failed to upsert external work scheduler state: ${input.externalWorkId}`);
    }
    return created;
  }

  getExternalWorkSchedulerState(externalWorkId: string): ExternalWorkSchedulerState | undefined {
    const row = this.database.prepare(externalWorkSchedulerStateSelectSql("WHERE external_work_id = ?")).get(externalWorkId);
    return row ? mapExternalWorkSchedulerState(row) : undefined;
  }

  findActiveExternalWorkSchedulerState(sourceKey: string, subjectKey: string): ExternalWorkSchedulerState | undefined {
    const row = this.database
      .prepare(`
        ${externalWorkSchedulerStateSelectSql(
          "WHERE workspace_id = ? AND source_key = ? AND subject_key = ? AND scheduler_status IN ('discovered', 'claimed', 'workspace_preparing', 'ready', 'retry_wait')",
        )}
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(DEFAULT_WORKSPACE_ID, sourceKey, subjectKey);
    return row ? mapExternalWorkSchedulerState(row) : undefined;
  }

  listExternalWorkSchedulerStates(options: ListExternalWorkSchedulerStatesOptions = {}): ExternalWorkSchedulerState[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.schedulerStatus) {
      clauses.push("scheduler_status = ?");
      params.push(options.schedulerStatus);
    }
    if (options.sourceKey) {
      clauses.push("source_key = ?");
      params.push(options.sourceKey);
    }
    if (options.subjectKey) {
      clauses.push("subject_key = ?");
      params.push(options.subjectKey);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${externalWorkSchedulerStateSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, external_work_id DESC LIMIT ?`)
      .all(...params)
      .map(mapExternalWorkSchedulerState);
  }

  updateExternalWorkSchedulerState(
    externalWorkId: string,
    input: UpdateExternalWorkSchedulerStateInput,
    now: string,
  ): ExternalWorkSchedulerState | undefined {
    const existing = this.getExternalWorkSchedulerState(externalWorkId);
    if (!existing) {
      return undefined;
    }
    const next = {
      schedulerStatus: input.schedulerStatus ?? existing.schedulerStatus,
      attemptCount: input.attemptCount ?? existing.attemptCount,
      lastAttemptAt: nullableUpdate(input.lastAttemptAt, existing.lastAttemptAt),
      nextAttemptAt: nullableUpdate(input.nextAttemptAt, existing.nextAttemptAt),
      maxRetryBackoffMs: input.maxRetryBackoffMs ?? existing.maxRetryBackoffMs,
      lastErrorCode: nullableUpdate(input.lastErrorCode, existing.lastErrorCode),
      lastErrorMessage: nullableUpdate(input.lastErrorMessage, existing.lastErrorMessage),
      workspacePath: nullableUpdate(input.workspacePath, existing.workspacePath),
      workspaceMode: nullableUpdate(input.workspaceMode, existing.workspaceMode),
      hookArtifactIds: input.hookArtifactIds ?? existing.hookArtifactIds,
      lastReconciledAt: nullableUpdate(input.lastReconciledAt, existing.lastReconciledAt),
    };
    this.database
      .prepare(`
        UPDATE external_work_scheduler_state
        SET
          scheduler_status = ?,
          attempt_count = ?,
          last_attempt_at = ?,
          next_attempt_at = ?,
          max_retry_backoff_ms = ?,
          last_error_code = ?,
          last_error_message = ?,
          workspace_path = ?,
          workspace_mode = ?,
          hook_artifact_ids_json = ?,
          last_reconciled_at = ?,
          updated_at = ?
        WHERE external_work_id = ?
      `)
      .run(
        next.schedulerStatus,
        next.attemptCount,
        next.lastAttemptAt ?? null,
        next.nextAttemptAt ?? null,
        next.maxRetryBackoffMs,
        next.lastErrorCode ?? null,
        next.lastErrorMessage ?? null,
        next.workspacePath ?? null,
        next.workspaceMode ?? null,
        stringifyJson(next.hookArtifactIds),
        next.lastReconciledAt ?? null,
        now,
        externalWorkId,
      );
    return this.getExternalWorkSchedulerState(externalWorkId);
  }

  upsertWorkItem(input: UpsertWorkItemInput, now: string): WorkItem {
    if (input.channelId) {
      this.assertChannelExists(input.channelId);
    }
    if (input.assigneeTeammateId && !this.getAiTeammate(input.assigneeTeammateId)) {
      throw new Error(`AI teammate not found: ${input.assigneeTeammateId}`);
    }
    const existing = this.getWorkItemBySource(input.sourceType, input.sourceId);
    const id = existing?.id ?? input.id ?? createWorkItemId();
    const createdAt = existing?.createdAt ?? now;
    const labels = input.labels ?? existing?.labels ?? [];
    const artifactIds = input.artifactIds ?? existing?.artifactIds ?? [];
    const proofArtifactIds = input.proofArtifactIds ?? existing?.proofArtifactIds ?? [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
          INSERT INTO work_items (
            id,
            workspace_id,
            channel_id,
            source_type,
            source_id,
            title,
            description,
            status,
            waiting_reason,
            priority,
            labels_json,
            assignee_teammate_id,
            task_id,
            run_id,
            workflow_id,
            workflow_step_id,
            external_work_id,
            external_work_action_id,
            approval_id,
            artifact_ids_json,
            proof_artifact_ids_json,
            claim_owner_id,
            claim_token,
            claimed_at,
            heartbeat_at,
            claim_expires_at,
            attempt_count,
            retry_budget,
            completed_at,
            failed_at,
            failure_reason,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, source_type, source_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            title = excluded.title,
            description = excluded.description,
            status = excluded.status,
            waiting_reason = excluded.waiting_reason,
            priority = excluded.priority,
            labels_json = excluded.labels_json,
            assignee_teammate_id = excluded.assignee_teammate_id,
            task_id = excluded.task_id,
            run_id = excluded.run_id,
            workflow_id = excluded.workflow_id,
            workflow_step_id = excluded.workflow_step_id,
            external_work_id = excluded.external_work_id,
            external_work_action_id = excluded.external_work_action_id,
            approval_id = excluded.approval_id,
            artifact_ids_json = excluded.artifact_ids_json,
            proof_artifact_ids_json = excluded.proof_artifact_ids_json,
            retry_budget = excluded.retry_budget,
            updated_at = excluded.updated_at
        `)
        .run(
          id,
          DEFAULT_WORKSPACE_ID,
          input.channelId ?? existing?.channelId ?? null,
          input.sourceType,
          input.sourceId,
          input.title,
          input.description ?? existing?.description ?? null,
          input.status ?? existing?.status ?? "ready",
          input.waitingReason ?? existing?.waitingReason ?? null,
          input.priority ?? existing?.priority ?? "normal",
          stringifyJson(labels),
          input.assigneeTeammateId ?? existing?.assigneeTeammateId ?? null,
          input.taskId ?? existing?.taskId ?? null,
          input.runId ?? existing?.runId ?? null,
          input.workflowId ?? existing?.workflowId ?? null,
          input.workflowStepId ?? existing?.workflowStepId ?? null,
          input.externalWorkId ?? existing?.externalWorkId ?? null,
          input.externalWorkActionId ?? existing?.externalWorkActionId ?? null,
          input.approvalId ?? existing?.approvalId ?? null,
          stringifyJson(artifactIds),
          stringifyJson(proofArtifactIds),
          existing?.claim?.ownerId ?? null,
          existing?.claim?.token ?? null,
          existing?.claim?.claimedAt ?? null,
          existing?.claim?.heartbeatAt ?? null,
          existing?.claim?.expiresAt ?? null,
          existing?.attemptCount ?? 0,
          input.retryBudget ?? existing?.retryBudget ?? 3,
          existing?.completedAt ?? null,
          existing?.failedAt ?? null,
          existing?.failureReason ?? null,
          createdAt,
          now,
        );
      this.replaceWorkItemDependencies(id, input.dependencyIds ?? existing?.dependencyIds ?? [], now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const item = this.getWorkItem(id);
    if (!item) {
      throw new Error(`Failed to upsert work item: ${id}`);
    }
    return item;
  }

  getWorkItem(id: string): WorkItem | undefined {
    const row = this.database.prepare(workItemSelectSql("WHERE id = ?")).get(id);
    return row ? mapWorkItem(row, this.getWorkItemDependencyIds(id)) : undefined;
  }

  listWorkItems(options: ListWorkItemsOptions = {}, now?: string): WorkItem[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.sourceType) {
      clauses.push("source_type = ?");
      params.push(options.sourceType);
    }
    if (options.assigneeTeammateId) {
      clauses.push("assignee_teammate_id = ?");
      params.push(options.assigneeTeammateId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${workItemSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapWorkItem(row, this.getWorkItemDependencyIds(readString(row, "id")), now));
  }

  routeWorkItem(id: string, input: WorkItemRouteRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing) {
      return undefined;
    }
    if (input.channelId) {
      this.assertChannelExists(input.channelId);
    }
    if (input.assigneeTeammateId && !this.getAiTeammate(input.assigneeTeammateId)) {
      throw new Error(`AI teammate not found: ${input.assigneeTeammateId}`);
    }
    this.database
      .prepare(`
        UPDATE work_items
        SET channel_id = ?, priority = ?, assignee_teammate_id = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.channelId === undefined ? existing.channelId ?? null : input.channelId,
        input.priority ?? existing.priority,
        input.assigneeTeammateId === undefined ? existing.assigneeTeammateId ?? null : input.assigneeTeammateId,
        now,
        id,
      );
    return this.getWorkItem(id);
  }

  claimWorkItem(
    id: string,
    input: WorkItemClaimRequest,
    now: string,
  ): { readonly workItem: WorkItem; readonly claimToken?: string; readonly blocker?: WorkItemClaimBlocker } | undefined {
    const existing = this.getWorkItem(id);
    if (!existing) {
      return undefined;
    }
    const blocker = this.workItemClaimBlocker(existing, now);
    if (blocker) {
      return { workItem: existing, blocker };
    }
    const claimToken = createWorkItemClaimToken();
    const expiresAt = new Date(Date.parse(now) + clampWorkItemLeaseMs(input.leaseMs)).toISOString();
    this.database
      .prepare(`
        UPDATE work_items
        SET status = ?, claim_owner_id = ?, claim_token = ?, claimed_at = ?, heartbeat_at = ?, claim_expires_at = ?, attempt_count = ?, updated_at = ?
        WHERE id = ?
      `)
      .run("running", input.ownerId, claimToken, now, now, expiresAt, existing.attemptCount + 1, now, id);
    const workItem = this.getWorkItem(id);
    if (!workItem) {
      throw new Error(`Failed to claim work item: ${id}`);
    }
    return { workItem, claimToken };
  }

  heartbeatWorkItem(id: string, input: WorkItemHeartbeatRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing || existing.claim?.token !== input.claimToken) {
      return undefined;
    }
    const expiresAt = new Date(Date.parse(now) + clampWorkItemLeaseMs(input.leaseMs)).toISOString();
    this.database
      .prepare("UPDATE work_items SET heartbeat_at = ?, claim_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(now, expiresAt, now, id);
    return this.getWorkItem(id);
  }

  releaseWorkItem(id: string, input: WorkItemReleaseRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing || existing.claim?.token !== input.claimToken) {
      return undefined;
    }
    this.database
      .prepare(`
        UPDATE work_items
        SET status = ?, claim_owner_id = NULL, claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run("ready", now, id);
    return this.getWorkItem(id);
  }

  completeWorkItem(id: string, input: WorkItemCompleteRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing || existing.claim?.token !== input.claimToken) {
      return undefined;
    }
    const proofArtifactIds = input.proofArtifactIds ?? existing.proofArtifactIds;
    this.database
      .prepare(`
        UPDATE work_items
        SET status = ?, proof_artifact_ids_json = ?, claim_owner_id = NULL, claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL, claim_expires_at = NULL, completed_at = ?, failed_at = NULL, failure_reason = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run("done", stringifyJson(proofArtifactIds), now, now, id);
    return this.getWorkItem(id);
  }

  failWorkItem(id: string, input: WorkItemFailRequest, now: string): WorkItem | undefined {
    const existing = this.getWorkItem(id);
    if (!existing || existing.claim?.token !== input.claimToken) {
      return undefined;
    }
    const canRetry = input.retry === true && existing.attemptCount < existing.retryBudget;
    this.database
      .prepare(`
        UPDATE work_items
        SET status = ?, waiting_reason = ?, claim_owner_id = NULL, claim_token = NULL, claimed_at = NULL, heartbeat_at = NULL, claim_expires_at = NULL, failed_at = ?, failure_reason = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(canRetry ? "ready" : "blocked", canRetry ? null : "user", now, input.reason, now, id);
    return this.getWorkItem(id);
  }

  private getWorkItemBySource(sourceType: WorkItemSourceType, sourceId: string): WorkItem | undefined {
    const row = this.database
      .prepare(workItemSelectSql("WHERE workspace_id = ? AND source_type = ? AND source_id = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceType, sourceId);
    return row ? mapWorkItem(row, this.getWorkItemDependencyIds(readString(row, "id"))) : undefined;
  }

  private getWorkItemDependencyIds(id: string): string[] {
    return this.database
      .prepare("SELECT depends_on_work_item_id FROM work_item_dependencies WHERE work_item_id = ? ORDER BY depends_on_work_item_id ASC")
      .all(id)
      .map((row) => readString(row, "depends_on_work_item_id"));
  }

  private replaceWorkItemDependencies(id: string, dependencyIds: readonly string[], now: string): void {
    this.database.prepare("DELETE FROM work_item_dependencies WHERE work_item_id = ?").run(id);
    const insert = this.database.prepare("INSERT OR IGNORE INTO work_item_dependencies (work_item_id, depends_on_work_item_id, created_at) VALUES (?, ?, ?)");
    for (const dependencyId of [...new Set(dependencyIds)].filter((dependencyId) => dependencyId !== id)) {
      insert.run(id, dependencyId, now);
    }
  }

  private workItemClaimBlocker(item: WorkItem, now: string): WorkItemClaimBlocker | undefined {
    if (item.status === "done" || item.status === "archived") {
      return { code: "terminal", message: `Work item is terminal: ${item.status}` };
    }
    if (item.attemptCount >= item.retryBudget) {
      return { code: "retry_budget_exhausted", message: "Work item retry budget is exhausted." };
    }
    if (item.claim && item.claim.expiresAt > now) {
      return {
        code: "already_claimed",
        message: "Work item already has an active claim.",
        claimedBy: item.claim.ownerId,
        claimExpiresAt: item.claim.expiresAt,
      };
    }
    const incompleteDependencies = item.dependencyIds.filter((dependencyId) => {
      const dependency = this.getWorkItem(dependencyId);
      return !dependency || dependency.status !== "done";
    });
    if (incompleteDependencies.length > 0) {
      return {
        code: "dependency_blocked",
        message: "Work item dependencies are not complete.",
        dependencyIds: incompleteDependencies,
      };
    }
    return undefined;
  }

  createProviderPreset(input: ProviderPresetInput, now: string): ProviderPreset {
    const preset: ProviderPreset = {
      id: createProviderPresetId(),
      kind: input.kind,
      displayName: input.displayName,
      providerId: input.providerId,
      model: input.model,
      api: input.api,
      providerTransport: normalizeProviderTransport(input.providerTransport),
      baseUrl: input.baseUrl,
      apiKeyRef: input.apiKeyRef,
      headers: input.headers ?? {},
      authHeader: input.authHeader,
      reasoning: input.reasoning,
      input: input.input ?? ["text"],
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
      compat: input.compat ?? {},
      capabilities: input.capabilities,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO provider_presets (
          id,
          kind,
          display_name,
          provider_id,
          model,
          api,
          provider_transport,
          base_url,
          api_key_ref,
          headers_json,
          auth_header,
          reasoning,
          input_json,
          context_window,
          max_tokens,
          compat_json,
          capabilities_json,
          enabled,
          last_check_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        preset.id,
        preset.kind,
        preset.displayName,
        preset.providerId,
        preset.model,
        preset.api,
        preset.providerTransport ?? null,
        preset.baseUrl ?? null,
        preset.apiKeyRef ?? null,
        stringifyJson(preset.headers),
        booleanToSql(preset.authHeader),
        booleanToSql(preset.reasoning),
        stringifyJson(preset.input),
        preset.contextWindow ?? null,
        preset.maxTokens ?? null,
        stringifyJson(preset.compat),
        stringifyJson(preset.capabilities),
        preset.enabled ? 1 : 0,
        preset.lastCheck ? stringifyJson(preset.lastCheck) : null,
        preset.createdAt,
        preset.updatedAt,
      );

    const created = this.getProviderPreset(preset.id);
    if (!created) {
      throw new Error(`Failed to create provider preset: ${preset.id}`);
    }
    return created;
  }

  getProviderPreset(id: string): ProviderPreset | undefined {
    const row = this.database.prepare(providerPresetSelectSql("WHERE id = ?")).get(id);
    return row ? mapProviderPreset(row) : undefined;
  }

  listProviderPresets(options: ListProviderPresetsOptions = {}): ProviderPreset[] {
    const whereClause = options.enabled === undefined ? "" : "WHERE enabled = ?";
    const statement = this.database.prepare(`${providerPresetSelectSql(whereClause)} ORDER BY created_at DESC`);
    const rows = options.enabled === undefined ? statement.all() : statement.all(options.enabled ? 1 : 0);
    return rows.map(mapProviderPreset);
  }

  updateProviderPreset(id: string, input: ProviderPresetUpdateInput, now: string): ProviderPreset | undefined {
    const existing = this.getProviderPreset(id);
    if (!existing) {
      return undefined;
    }

    const next: ProviderPreset = {
      ...existing,
      kind: input.kind ?? existing.kind,
      displayName: input.displayName ?? existing.displayName,
      providerId: input.providerId ?? existing.providerId,
      model: input.model ?? existing.model,
      api: input.api ?? existing.api,
      providerTransport: normalizeProviderTransportUpdate(input.providerTransport, existing.providerTransport),
      baseUrl: nullableUpdate(input.baseUrl, existing.baseUrl),
      apiKeyRef: nullableUpdate(input.apiKeyRef, existing.apiKeyRef),
      headers: input.headers ?? existing.headers,
      authHeader: nullableUpdate(input.authHeader, existing.authHeader),
      reasoning: nullableUpdate(input.reasoning, existing.reasoning),
      input: input.input ?? existing.input,
      contextWindow: nullableUpdate(input.contextWindow, existing.contextWindow),
      maxTokens: nullableUpdate(input.maxTokens, existing.maxTokens),
      compat: input.compat ?? existing.compat,
      capabilities: input.capabilities ?? existing.capabilities,
      enabled: input.enabled ?? existing.enabled,
      lastCheck: undefined,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE provider_presets
        SET
          kind = ?,
          display_name = ?,
          provider_id = ?,
          model = ?,
          api = ?,
          provider_transport = ?,
          base_url = ?,
          api_key_ref = ?,
          headers_json = ?,
          auth_header = ?,
          reasoning = ?,
          input_json = ?,
          context_window = ?,
          max_tokens = ?,
          compat_json = ?,
          capabilities_json = ?,
          enabled = ?,
          last_check_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.kind,
        next.displayName,
        next.providerId,
        next.model,
        next.api,
        next.providerTransport ?? null,
        next.baseUrl ?? null,
        next.apiKeyRef ?? null,
        stringifyJson(next.headers),
        booleanToSql(next.authHeader),
        booleanToSql(next.reasoning),
        stringifyJson(next.input),
        next.contextWindow ?? null,
        next.maxTokens ?? null,
        stringifyJson(next.compat),
        stringifyJson(next.capabilities),
        next.enabled ? 1 : 0,
        next.lastCheck ? stringifyJson(next.lastCheck) : null,
        next.updatedAt,
        id,
      );

    return this.getProviderPreset(id);
  }

  recordProviderCheckResult(id: string, result: ProviderCheckResult): ProviderPreset | undefined {
    const updateResult = this.database
      .prepare("UPDATE provider_presets SET last_check_json = ? WHERE id = ?")
      .run(stringifyJson(result), id);
    if (Number(updateResult.changes) === 0) {
      return undefined;
    }
    return this.getProviderPreset(id);
  }

  deleteProviderPreset(id: string): boolean {
    const result = this.database.prepare("DELETE FROM provider_presets WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  setProviderSecret(providerId: string, secretValue: string, now: string): void {
    this.database
      .prepare(`
        INSERT INTO provider_secrets (
          provider_id,
          secret_value,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET
          secret_value = excluded.secret_value,
          updated_at = excluded.updated_at
      `)
      .run(providerId, secretValue, now, now);
  }

  getProviderSecret(providerId: string): string | undefined {
    const row = this.database
      .prepare("SELECT secret_value FROM provider_secrets WHERE provider_id = ?")
      .get(providerId);
    return row ? readString(row, "secret_value") : undefined;
  }

  hasProviderSecret(providerId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 AS found FROM provider_secrets WHERE provider_id = ?").get(providerId));
  }

  deleteProviderSecret(providerId: string): boolean {
    const result = this.database.prepare("DELETE FROM provider_secrets WHERE provider_id = ?").run(providerId);
    return Number(result.changes) > 0;
  }

  createMcpServer(input: CreateMcpServerInput, now: string): McpServer {
    const server: McpServer = {
      id: input.id ?? createMcpServerId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      displayName: input.displayName,
      transport: normalizeMcpServerTransport(input.transport),
      enabled: input.enabled ?? true,
      required: input.required ?? false,
      status: input.status ?? { kind: "unknown" },
      startupTimeoutSec: input.startupTimeoutSec,
      toolTimeoutSec: input.toolTimeoutSec,
      enabledTools: input.enabledTools,
      disabledTools: input.disabledTools ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO mcp_servers (
          id,
          workspace_id,
          display_name,
          transport_json,
          enabled,
          required,
          status_json,
          startup_timeout_sec,
          tool_timeout_sec,
          enabled_tools_json,
          disabled_tools_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        server.id,
        server.workspaceId,
        server.displayName,
        stringifyJson(server.transport),
        server.enabled ? 1 : 0,
        server.required ? 1 : 0,
        stringifyJson(server.status),
        server.startupTimeoutSec ?? null,
        server.toolTimeoutSec ?? null,
        server.enabledTools ? stringifyJson(server.enabledTools) : null,
        stringifyJson(server.disabledTools),
        server.createdAt,
        server.updatedAt,
      );

    const created = this.getMcpServer(server.id);
    if (!created) {
      throw new Error(`Failed to create MCP server: ${server.id}`);
    }
    return created;
  }

  getMcpServer(id: string): McpServer | undefined {
    const row = this.database.prepare(mcpServerSelectSql("WHERE id = ?")).get(id);
    return row ? mapMcpServer(row) : undefined;
  }

  listMcpServers(options: ListMcpServersOptions = {}): McpServer[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${mcpServerSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapMcpServer);
  }

  updateMcpServer(id: string, input: UpdateMcpServerInput, now: string): McpServer | undefined {
    const existing = this.getMcpServer(id);
    if (!existing) {
      return undefined;
    }
    const next: McpServer = {
      ...existing,
      displayName: input.displayName ?? existing.displayName,
      transport: input.transport ? normalizeMcpServerTransport(input.transport) : existing.transport,
      enabled: input.enabled ?? existing.enabled,
      required: input.required ?? existing.required,
      status: input.status ?? existing.status,
      startupTimeoutSec: nullableUpdate(input.startupTimeoutSec, existing.startupTimeoutSec),
      toolTimeoutSec: nullableUpdate(input.toolTimeoutSec, existing.toolTimeoutSec),
      enabledTools: nullableUpdate(input.enabledTools, existing.enabledTools),
      disabledTools: input.disabledTools ?? existing.disabledTools,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE mcp_servers
        SET
          display_name = ?,
          transport_json = ?,
          enabled = ?,
          required = ?,
          status_json = ?,
          startup_timeout_sec = ?,
          tool_timeout_sec = ?,
          enabled_tools_json = ?,
          disabled_tools_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.displayName,
        stringifyJson(next.transport),
        next.enabled ? 1 : 0,
        next.required ? 1 : 0,
        stringifyJson(next.status),
        next.startupTimeoutSec ?? null,
        next.toolTimeoutSec ?? null,
        next.enabledTools ? stringifyJson(next.enabledTools) : null,
        stringifyJson(next.disabledTools),
        next.updatedAt,
        id,
      );

    return this.getMcpServer(id);
  }

  updateMcpServerStatus(id: string, status: McpServerStatus, now: string): McpServer | undefined {
    return this.updateMcpServer(id, { status }, now);
  }

  upsertMcpStatusSnapshot(snapshot: McpRuntimeStatusSnapshot, now: string): McpRuntimeStatusSnapshot {
    if (!this.getMcpServer(snapshot.serverId)) {
      throw new Error(`MCP server not found: ${snapshot.serverId}`);
    }
    this.database
      .prepare(`
        INSERT INTO mcp_status_snapshots (
          server_id,
          status_json,
          checked_at,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          status_json = excluded.status_json,
          checked_at = excluded.checked_at,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `)
      .run(snapshot.serverId, stringifyJson(snapshot), snapshot.checkedAt, snapshot.expiresAt, now, now);
    const stored = this.getMcpStatusSnapshot(snapshot.serverId);
    if (!stored) {
      throw new Error(`Failed to persist MCP status snapshot: ${snapshot.serverId}`);
    }
    return stored;
  }

  getMcpStatusSnapshot(serverId: string, now?: string): McpRuntimeStatusSnapshot | undefined {
    const row = this.database
      .prepare("SELECT status_json, expires_at FROM mcp_status_snapshots WHERE server_id = ?")
      .get(serverId);
    if (!row) {
      return undefined;
    }
    const expiresAt = readString(row, "expires_at");
    const snapshot = parseMcpRuntimeStatusSnapshot(readString(row, "status_json"));
    if (now && expiresAt <= now) {
      return {
        ...snapshot,
        status: "expired",
        message: snapshot.message ?? "MCP status snapshot expired.",
      };
    }
    return snapshot;
  }

  deleteMcpStatusSnapshot(serverId: string): boolean {
    const result = this.database.prepare("DELETE FROM mcp_status_snapshots WHERE server_id = ?").run(serverId);
    return Number(result.changes) > 0;
  }

  countLegacyMcpServerSecrets(serverId?: string): number {
    const row = serverId
      ? this.database.prepare("SELECT COUNT(*) AS count FROM mcp_server_secrets WHERE server_id = ?").get(serverId)
      : this.database.prepare("SELECT COUNT(*) AS count FROM mcp_server_secrets").get();
    return row ? readNumber(row, "count") : 0;
  }

  listLegacyMcpServerSecretNames(serverId: string): readonly string[] {
    return this.database
      .prepare("SELECT secret_name FROM mcp_server_secrets WHERE server_id = ? ORDER BY secret_name ASC")
      .all(serverId)
      .map((row) => readString(row, "secret_name"));
  }

  deleteMcpServer(id: string): boolean {
    const result = this.database.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  setMcpServerSecret(serverId: string, secretName: string, secretValue: string, now: string): void {
    void serverId;
    void secretName;
    void secretValue;
    void now;
    throw new Error("MCP raw secret writes are disabled; store secret refs in MCP transport config.");
  }

  getMcpServerSecret(serverId: string, secretName: string): string | undefined {
    const row = this.database
      .prepare("SELECT secret_value FROM mcp_server_secrets WHERE server_id = ? AND secret_name = ?")
      .get(serverId, secretName);
    return row ? readString(row, "secret_value") : undefined;
  }

  hasMcpServerSecret(serverId: string, secretName: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 AS found FROM mcp_server_secrets WHERE server_id = ? AND secret_name = ?")
        .get(serverId, secretName),
    );
  }

  deleteMcpServerSecret(serverId: string, secretName: string): boolean {
    const result = this.database
      .prepare("DELETE FROM mcp_server_secrets WHERE server_id = ? AND secret_name = ?")
      .run(serverId, secretName);
    return Number(result.changes) > 0;
  }

  replaceMcpServerTools(serverId: string, tools: readonly ReplaceMcpServerToolInput[], now: string): McpTool[] {
    if (!this.getMcpServer(serverId)) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    const existingTools = new Map(this.listMcpTools({ serverId }).map((tool) => [tool.rawName, tool]));
    this.database.prepare("DELETE FROM mcp_tools WHERE server_id = ?").run(serverId);
    const insert = this.database.prepare(`
      INSERT INTO mcp_tools (
        server_id,
        raw_name,
        display_name,
        description,
        input_schema_json,
        callable_namespace,
        callable_name,
        side_effect_level,
        default_approval,
        enabled,
        first_seen_at,
        last_seen_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const tool of dedupeMcpToolInputs(tools)) {
      const existing = existingTools.get(tool.rawName);
      insert.run(
        serverId,
        tool.rawName,
        tool.displayName,
        tool.description ?? null,
        stringifyJson(tool.inputSchema),
        tool.callableNamespace,
        tool.callableName,
        tool.sideEffectLevel,
        tool.defaultApproval,
        tool.enabled === false ? 0 : 1,
        existing?.firstSeenAt ?? now,
        now,
        now,
      );
    }
    return this.listMcpTools({ serverId, limit: 500 });
  }

  listMcpTools(options: ListMcpToolsOptions = {}): McpTool[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.serverId) {
      clauses.push("server_id = ?");
      params.push(options.serverId);
    }
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${mcpToolSelectSql(whereClause)} ORDER BY server_id ASC, raw_name ASC LIMIT ?`)
      .all(...params)
      .map(mapMcpTool);
  }

  replaceTeammateMcpBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateMcpBindingInput[],
    now: string,
  ): TeammateMcpBinding[] {
    if (!this.getAiTeammate(teammateId)) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    this.database.prepare("DELETE FROM teammate_mcp_bindings WHERE teammate_id = ?").run(teammateId);
    const insert = this.database.prepare(`
      INSERT INTO teammate_mcp_bindings (
        teammate_id,
        server_id,
        mode,
        selected_tool_names_json,
        approval_overrides_json,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const binding of dedupeTeammateMcpBindingInputs(bindings)) {
      if (!this.getMcpServer(binding.serverId)) {
        throw new Error(`MCP server not found: ${binding.serverId}`);
      }
      insert.run(
        teammateId,
        binding.serverId,
        binding.mode,
        stringifyJson(binding.selectedToolNames ?? []),
        stringifyJson(binding.approvalOverrides ?? {}),
        binding.enabled === false ? 0 : 1,
        now,
        now,
      );
    }
    return this.listTeammateMcpBindings(teammateId);
  }

  listTeammateMcpBindings(teammateId: string): TeammateMcpBinding[] {
    return this.database
      .prepare(`${teammateMcpBindingSelectSql("WHERE teammate_id = ?")} ORDER BY server_id ASC`)
      .all(teammateId)
      .map(mapTeammateMcpBinding);
  }

  createAutomationDefinition(input: CreateAutomationDefinitionInput, now: string): AutomationDefinition {
    const definition: AutomationDefinition = {
      id: input.id ?? createAutomationId(),
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      threadId: input.threadId,
      title: input.title,
      description: input.description,
      kind: input.kind,
      status: input.status ?? "enabled",
      trigger: input.trigger,
      target: input.target,
      promptTemplate: input.promptTemplate,
      executionPolicy: input.executionPolicy,
      outputPolicy: input.outputPolicy,
      createdAt: now,
      updatedAt: now,
      nextRunAt: input.nextRunAt,
    };
    this.database
      .prepare(`
        INSERT INTO automation_definitions (
          id,
          workspace_id,
          channel_id,
          thread_id,
          title,
          description,
          kind,
          status,
          trigger_json,
          target_json,
          prompt_template_json,
          execution_policy_json,
          output_policy_json,
          created_at,
          updated_at,
          last_run_id,
          next_run_at,
          last_error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        definition.id,
        definition.workspaceId,
        definition.channelId ?? null,
        definition.threadId,
        definition.title,
        definition.description ?? null,
        definition.kind,
        definition.status,
        stringifyJson(definition.trigger),
        stringifyJson(definition.target),
        stringifyJson(definition.promptTemplate),
        stringifyJson(definition.executionPolicy),
        stringifyJson(definition.outputPolicy),
        definition.createdAt,
        definition.updatedAt,
        null,
        definition.nextRunAt ?? null,
        null,
      );
    const stored = this.getAutomationDefinition(definition.id);
    if (!stored) {
      throw new Error(`Failed to persist automation definition: ${definition.id}`);
    }
    return stored;
  }

  getAutomationDefinition(automationId: string): AutomationDefinition | undefined {
    const row = this.database.prepare(automationDefinitionSelectSql("WHERE id = ?")).get(automationId);
    return row ? mapAutomationDefinition(row) : undefined;
  }

  listAutomationDefinitions(options: ListAutomationDefinitionsOptions = {}): AutomationDefinition[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (!options.includeArchived) {
      clauses.push("status != 'archived'");
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.scheduledOnly) {
      clauses.push("json_extract(trigger_json, '$.type') = 'schedule'");
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${automationDefinitionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapAutomationDefinition);
  }

  updateAutomationDefinition(
    automationId: string,
    input: UpdateAutomationDefinitionInput,
    now: string,
  ): AutomationDefinition | undefined {
    const existing = this.getAutomationDefinition(automationId);
    if (!existing) {
      return undefined;
    }
    const next: AutomationDefinition = {
      ...existing,
      channelId: nullableUpdate(input.channelId, existing.channelId),
      threadId: input.threadId ?? existing.threadId,
      title: input.title ?? existing.title,
      description: nullableUpdate(input.description, existing.description),
      kind: input.kind ?? existing.kind,
      status: input.status ?? existing.status,
      trigger: input.trigger ?? existing.trigger,
      target: input.target ?? existing.target,
      promptTemplate: input.promptTemplate ?? existing.promptTemplate,
      executionPolicy: input.executionPolicy ?? existing.executionPolicy,
      outputPolicy: input.outputPolicy ?? existing.outputPolicy,
      updatedAt: now,
      lastRunId: nullableUpdate(input.lastRunId, existing.lastRunId),
      nextRunAt: nullableUpdate(input.nextRunAt, existing.nextRunAt),
      lastErrorMessage: nullableUpdate(input.lastErrorMessage, existing.lastErrorMessage),
    };
    this.database
      .prepare(`
        UPDATE automation_definitions
        SET channel_id = ?,
            thread_id = ?,
            title = ?,
            description = ?,
            kind = ?,
            status = ?,
            trigger_json = ?,
            target_json = ?,
            prompt_template_json = ?,
            execution_policy_json = ?,
            output_policy_json = ?,
            updated_at = ?,
            last_run_id = ?,
            next_run_at = ?,
            last_error_message = ?
        WHERE id = ?
      `)
      .run(
        next.channelId ?? null,
        next.threadId,
        next.title,
        next.description ?? null,
        next.kind,
        next.status,
        stringifyJson(next.trigger),
        stringifyJson(next.target),
        stringifyJson(next.promptTemplate),
        stringifyJson(next.executionPolicy),
        stringifyJson(next.outputPolicy),
        next.updatedAt,
        next.lastRunId ?? null,
        next.nextRunAt ?? null,
        next.lastErrorMessage ?? null,
        automationId,
      );
    return this.getAutomationDefinition(automationId);
  }

  archiveAutomationDefinition(automationId: string, now: string): AutomationDefinition | undefined {
    return this.updateAutomationDefinition(automationId, { status: "archived", nextRunAt: null }, now);
  }

  createAutomationDraft(input: CreateAutomationDraftInput, now: string): AutomationDraft {
    const draft = validateAutomationDraft({
      id: input.id ?? createAutomationDraftId(),
      source: input.source,
      status: input.status ?? "draft",
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      channelId: input.channelId ?? input.target?.channelId,
      title: input.title,
      description: input.description,
      kind: input.kind,
      trigger: input.trigger,
      target: input.target,
      promptTemplate: input.promptTemplate,
      executionPolicy: input.executionPolicy,
      outputPolicy: input.outputPolicy,
      missingFields: [],
      warnings: [],
      createdAt: now,
      updatedAt: now,
      proposedByRunId: input.proposedByRunId,
      proposedByThreadId: input.proposedByThreadId,
    });
    this.database
      .prepare(`
        INSERT INTO automation_drafts (
          id,
          workspace_id,
          channel_id,
          source,
          status,
          draft_json,
          missing_fields_json,
          warnings_json,
          proposed_by_run_id,
          proposed_by_thread_id,
          confirmed_automation_id,
          discarded_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        draft.id,
        draft.workspaceId,
        draft.channelId ?? null,
        draft.source,
        draft.status,
        stringifyJson(automationDraftPayload(draft)),
        stringifyJson(draft.missingFields),
        stringifyJson(draft.warnings),
        draft.proposedByRunId ?? null,
        draft.proposedByThreadId ?? null,
        null,
        null,
        draft.createdAt,
        draft.updatedAt,
      );
    const stored = this.getAutomationDraft(draft.id);
    if (!stored) {
      throw new Error(`Failed to persist automation draft: ${draft.id}`);
    }
    return stored;
  }

  getAutomationDraft(draftId: string): AutomationDraft | undefined {
    const row = this.database.prepare(automationDraftSelectSql("WHERE id = ?")).get(draftId);
    return row ? mapAutomationDraft(row) : undefined;
  }

  listAutomationDrafts(options: ListAutomationDraftsOptions = {}): AutomationDraft[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (!options.includeTerminal) {
      clauses.push("status NOT IN ('confirmed', 'discarded')");
    }
    if (options.source) {
      clauses.push("source = ?");
      params.push(options.source);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${automationDraftSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapAutomationDraft);
  }

  updateAutomationDraft(draftId: string, input: UpdateAutomationDraftInput, now: string): AutomationDraft | undefined {
    const existing = this.getAutomationDraft(draftId);
    if (!existing || existing.status === "confirmed" || existing.status === "discarded") {
      return existing;
    }
    const next = validateAutomationDraft({
      ...existing,
      channelId: nullableUpdate(input.channelId, existing.channelId),
      title: nullableUpdate(input.title, existing.title),
      description: nullableUpdate(input.description, existing.description),
      kind: nullableUpdate(input.kind, existing.kind),
      trigger: nullableUpdate(input.trigger, existing.trigger),
      target: nullableUpdate(input.target, existing.target),
      promptTemplate: nullableUpdate(input.promptTemplate, existing.promptTemplate),
      executionPolicy: nullableUpdate(input.executionPolicy, existing.executionPolicy),
      outputPolicy: nullableUpdate(input.outputPolicy, existing.outputPolicy),
      proposedByRunId: nullableUpdate(input.proposedByRunId, existing.proposedByRunId),
      proposedByThreadId: nullableUpdate(input.proposedByThreadId, existing.proposedByThreadId),
      updatedAt: now,
    });
    this.writeAutomationDraft(next);
    return this.getAutomationDraft(draftId);
  }

  discardAutomationDraft(draftId: string, now: string): AutomationDraft | undefined {
    const existing = this.getAutomationDraft(draftId);
    if (!existing || existing.status === "confirmed") {
      return existing;
    }
    const next: AutomationDraft = {
      ...existing,
      status: "discarded",
      discardedAt: now,
      updatedAt: now,
    };
    this.writeAutomationDraft(next);
    return this.getAutomationDraft(draftId);
  }

  confirmAutomationDraft(draftId: string, automationId: string, now: string): AutomationDraft | undefined {
    const existing = this.getAutomationDraft(draftId);
    if (!existing || existing.status === "discarded") {
      return existing;
    }
    const next: AutomationDraft = {
      ...existing,
      status: "confirmed",
      confirmedAutomationId: automationId,
      updatedAt: now,
    };
    this.writeAutomationDraft(next);
    return this.getAutomationDraft(draftId);
  }

  private writeAutomationDraft(draft: AutomationDraft): void {
    this.database
      .prepare(`
        UPDATE automation_drafts
        SET channel_id = ?,
            status = ?,
            draft_json = ?,
            missing_fields_json = ?,
            warnings_json = ?,
            proposed_by_run_id = ?,
            proposed_by_thread_id = ?,
            confirmed_automation_id = ?,
            discarded_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        draft.channelId ?? null,
        draft.status,
        stringifyJson(automationDraftPayload(draft)),
        stringifyJson(draft.missingFields),
        stringifyJson(draft.warnings),
        draft.proposedByRunId ?? null,
        draft.proposedByThreadId ?? null,
        draft.confirmedAutomationId ?? null,
        draft.discardedAt ?? null,
        draft.updatedAt,
        draft.id,
      );
  }

  createAutomationRun(input: CreateAutomationRunInput, now: string): AutomationRun {
    const existing = this.findAutomationRunByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      throw new Error(`Automation run idempotency key already exists: ${input.idempotencyKey}`);
    }
    const run: AutomationRun = {
      id: input.id ?? createAutomationRunId(),
      automationId: input.automationId,
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      threadId: input.threadId,
      runId: input.runId,
      triggerType: input.triggerType,
      scheduledFor: input.scheduledFor,
      firedAt: input.firedAt ?? now,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status: input.status ?? "queued",
      idempotencyKey: input.idempotencyKey,
      contextPreviewArtifactId: input.contextPreviewArtifactId,
      outputArtifactIds: input.outputArtifactIds ?? [],
      skipReason: input.skipReason,
      errorMessage: input.errorMessage,
    };
    this.database
      .prepare(`
        INSERT INTO automation_runs (
          id,
          automation_id,
          workspace_id,
          channel_id,
          thread_id,
          run_id,
          trigger_type,
          scheduled_for,
          fired_at,
          started_at,
          completed_at,
          status,
          idempotency_key,
          context_preview_artifact_id,
          output_artifact_ids_json,
          skip_reason,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.automationId,
        run.workspaceId,
        run.channelId ?? null,
        run.threadId,
        run.runId ?? null,
        run.triggerType,
        run.scheduledFor ?? null,
        run.firedAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.status,
        run.idempotencyKey,
        run.contextPreviewArtifactId ?? null,
        stringifyJson(run.outputArtifactIds),
        run.skipReason ?? null,
        run.errorMessage ?? null,
      );
    const stored = this.getAutomationRun(run.id);
    if (!stored) {
      throw new Error(`Failed to persist automation run: ${run.id}`);
    }
    return stored;
  }

  getAutomationRun(automationRunId: string): AutomationRun | undefined {
    const row = this.database.prepare(automationRunSelectSql("WHERE id = ?")).get(automationRunId);
    return row ? mapAutomationRun(row) : undefined;
  }

  findAutomationRunByIdempotencyKey(idempotencyKey: string): AutomationRun | undefined {
    const row = this.database.prepare(automationRunSelectSql("WHERE idempotency_key = ?")).get(idempotencyKey);
    return row ? mapAutomationRun(row) : undefined;
  }

  listAutomationRuns(options: ListAutomationRunsOptions = {}): AutomationRun[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.automationId) {
      clauses.push("automation_id = ?");
      params.push(options.automationId);
    }
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${automationRunSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY fired_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapAutomationRun);
  }

  updateAutomationRun(automationRunId: string, input: UpdateAutomationRunInput, now: string): AutomationRun | undefined {
    const existing = this.getAutomationRun(automationRunId);
    if (!existing) {
      return undefined;
    }
    const next: AutomationRun = {
      ...existing,
      runId: nullableUpdate(input.runId, existing.runId),
      startedAt: nullableUpdate(input.startedAt, existing.startedAt),
      completedAt: nullableUpdate(input.completedAt, existing.completedAt),
      status: input.status ?? existing.status,
      contextPreviewArtifactId: nullableUpdate(input.contextPreviewArtifactId, existing.contextPreviewArtifactId),
      outputArtifactIds: input.outputArtifactIds ?? existing.outputArtifactIds,
      skipReason: nullableUpdate(input.skipReason, existing.skipReason),
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
    };
    this.database
      .prepare(`
        UPDATE automation_runs
        SET run_id = ?,
            started_at = ?,
            completed_at = ?,
            status = ?,
            context_preview_artifact_id = ?,
            output_artifact_ids_json = ?,
            skip_reason = ?,
            error_message = ?
        WHERE id = ?
      `)
      .run(
        next.runId ?? null,
        next.startedAt ?? null,
        next.completedAt ?? null,
        next.status,
        next.contextPreviewArtifactId ?? null,
        stringifyJson(next.outputArtifactIds),
        next.skipReason ?? null,
        next.errorMessage ?? null,
        automationRunId,
      );
    const stored = this.getAutomationRun(automationRunId);
    if (stored) {
      this.updateAutomationDefinition(
        stored.automationId,
        {
          lastRunId: stored.id,
          lastErrorMessage: stored.status === "failed" ? stored.errorMessage ?? "Automation run failed." : null,
        },
        now,
      );
    }
    return stored;
  }

  listManagedPlugins(options: ListManagedPluginsOptions = {}): ManagedPluginRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    if (options.sourceKind) {
      clauses.push("source_kind = ?");
      params.push(options.sourceKind);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${managedPluginSelectSql(whereClause)} ORDER BY source_kind ASC, id ASC LIMIT ?`)
      .all(...params)
      .map(mapManagedPlugin);
  }

  getManagedPlugin(pluginId: string): ManagedPluginRecord | undefined {
    const row = this.database.prepare(managedPluginSelectSql("WHERE id = ?")).get(pluginId);
    return row ? mapManagedPlugin(row) : undefined;
  }

  upsertManagedPlugin(input: UpsertManagedPluginInput, now: string): ManagedPluginRecord {
    const existing = this.getManagedPlugin(input.id);
    const createdAt = existing?.createdAt ?? now;
    this.database
      .prepare(`
        INSERT INTO managed_plugins (
          id,
          source_kind,
          version,
          enabled,
          disabled_reason,
          descriptor_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_kind = excluded.source_kind,
          version = excluded.version,
          enabled = excluded.enabled,
          disabled_reason = excluded.disabled_reason,
          descriptor_json = excluded.descriptor_json,
          updated_at = excluded.updated_at
      `)
      .run(
        input.id,
        input.sourceKind,
        input.version,
        input.enabled ? 1 : 0,
        input.disabledReason ?? null,
        stringifyJson(input.descriptor),
        createdAt,
        now,
      );
    const record = this.getManagedPlugin(input.id);
    if (!record) {
      throw new Error(`Failed to persist managed plugin: ${input.id}`);
    }
    return record;
  }

  updateManagedPlugin(pluginId: string, input: UpdateManagedPluginInput, now: string): ManagedPluginRecord | undefined {
    const existing = this.getManagedPlugin(pluginId);
    if (!existing) {
      return undefined;
    }
    const next: ManagedPluginRecord = {
      ...existing,
      version: input.version ?? input.descriptor?.version ?? existing.version,
      enabled: input.enabled ?? existing.enabled,
      disabledReason: nullableUpdate(input.disabledReason, existing.disabledReason),
      descriptor: input.descriptor ?? existing.descriptor,
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE managed_plugins
        SET version = ?,
            enabled = ?,
            disabled_reason = ?,
            descriptor_json = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.version,
        next.enabled ? 1 : 0,
        next.disabledReason ?? null,
        stringifyJson(next.descriptor),
        now,
        pluginId,
      );
    return this.getManagedPlugin(pluginId);
  }

  replaceManagedPluginContributions(
    pluginId: string,
    contributions: readonly UpsertManagedPluginContributionInput[],
    now: string,
  ): ManagedPluginContributionRecord[] {
    if (!this.getManagedPlugin(pluginId)) {
      throw new Error(`Managed plugin not found: ${pluginId}`);
    }
    this.database.prepare("DELETE FROM managed_plugin_contributions WHERE plugin_id = ?").run(pluginId);
    const insert = this.database.prepare(`
      INSERT INTO managed_plugin_contributions (
        plugin_id,
        contribution_kind,
        contribution_id,
        linked_resource_id,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const contribution of dedupeManagedPluginContributionInputs(contributions)) {
      insert.run(
        pluginId,
        contribution.contributionKind,
        contribution.contributionId,
        contribution.linkedResourceId ?? null,
        contribution.enabled === false ? 0 : 1,
        now,
        now,
      );
    }
    return this.listManagedPluginContributions(pluginId);
  }

  listManagedPluginContributions(pluginId?: string): ManagedPluginContributionRecord[] {
    const whereClause = pluginId ? "WHERE plugin_id = ?" : "";
    const params = pluginId ? [pluginId] : [];
    return this.database
      .prepare(`${managedPluginContributionSelectSql(whereClause)} ORDER BY plugin_id ASC, contribution_kind ASC, contribution_id ASC`)
      .all(...params)
      .map(mapManagedPluginContribution);
  }

  upsertManagedPluginHealthSnapshot(snapshot: ManagedPluginHealthSnapshot, now: string): ManagedPluginHealthSnapshot {
    if (!this.getManagedPlugin(snapshot.pluginId)) {
      throw new Error(`Managed plugin not found: ${snapshot.pluginId}`);
    }
    this.database
      .prepare(`
        INSERT INTO managed_plugin_health_snapshots (
          plugin_id,
          status_json,
          checked_at,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET
          status_json = excluded.status_json,
          checked_at = excluded.checked_at,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `)
      .run(snapshot.pluginId, stringifyJson(snapshot), snapshot.checkedAt, snapshot.expiresAt, now, now);
    const stored = this.getManagedPluginHealthSnapshot(snapshot.pluginId);
    if (!stored) {
      throw new Error(`Failed to persist managed plugin health snapshot: ${snapshot.pluginId}`);
    }
    return stored;
  }

  getManagedPluginHealthSnapshot(pluginId: string, now?: string): ManagedPluginHealthSnapshot | undefined {
    const row = this.database
      .prepare("SELECT status_json, expires_at FROM managed_plugin_health_snapshots WHERE plugin_id = ?")
      .get(pluginId);
    if (!row) {
      return undefined;
    }
    const snapshot = parseManagedPluginHealthSnapshot(readString(row, "status_json"));
    const expiresAt = readString(row, "expires_at");
    if (now && expiresAt <= now) {
      return {
        ...snapshot,
        status: "expired",
        message: snapshot.message ?? "Plugin health snapshot expired.",
      };
    }
    return snapshot;
  }

  appendManagedPluginEvent(input: CreateManagedPluginEventInput, now: string): ManagedPluginEvent {
    if (!this.getManagedPlugin(input.pluginId)) {
      throw new Error(`Managed plugin not found: ${input.pluginId}`);
    }
    const event: ManagedPluginEvent = {
      id: input.id ?? createManagedPluginEventId(),
      pluginId: input.pluginId,
      type: input.type,
      actor: input.actor ?? "local-user",
      message: input.message,
      data: input.data,
      createdAt: now,
    };
    this.database
      .prepare(`
        INSERT INTO managed_plugin_events (
          id,
          plugin_id,
          type,
          actor,
          message,
          data_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.pluginId,
        event.type,
        event.actor,
        event.message ?? null,
        event.data === undefined ? null : stringifyJson(redactSecrets(redactManagedPluginEventData(event.data))),
        event.createdAt,
      );
    return event;
  }

  listManagedPluginEvents(options: ListManagedPluginEventsOptions = {}): ManagedPluginEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.pluginId) {
      clauses.push("plugin_id = ?");
      params.push(options.pluginId);
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${managedPluginEventSelectSql(whereClause)} ORDER BY created_at ASC LIMIT ?`)
      .all(...params)
      .map(mapManagedPluginEvent);
  }

  upsertManagedPluginPackage(input: UpsertManagedPluginPackageInput, now: string): ManagedPluginPackageRecord {
    const existing = this.getManagedPluginPackage(input.pluginId);
    const installedAt = input.installedAt ?? existing?.installedAt ?? now;
    const status = input.status ?? "installed";
    this.database
      .prepare(`
        INSERT INTO managed_plugin_packages (
          plugin_id,
          source_kind,
          version,
          status,
          cache_ref,
          package_hash,
          manifest_json,
          installed_at,
          updated_at,
          uninstalled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET
          source_kind = excluded.source_kind,
          version = excluded.version,
          status = excluded.status,
          cache_ref = excluded.cache_ref,
          package_hash = excluded.package_hash,
          manifest_json = excluded.manifest_json,
          updated_at = excluded.updated_at,
          uninstalled_at = excluded.uninstalled_at
      `)
      .run(
        input.pluginId,
        input.sourceKind,
        input.version,
        status,
        input.cacheRef,
        input.packageHash ?? null,
        input.manifestJson,
        installedAt,
        now,
        input.uninstalledAt ?? null,
      );
    const record = this.getManagedPluginPackage(input.pluginId);
    if (!record) {
      throw new Error(`Failed to persist managed plugin package: ${input.pluginId}`);
    }
    return record;
  }

  markManagedPluginPackageUninstalled(pluginId: string, now: string): ManagedPluginPackageRecord | undefined {
    const existing = this.getManagedPluginPackage(pluginId);
    if (!existing) {
      return undefined;
    }
    this.database
      .prepare(`
        UPDATE managed_plugin_packages
        SET status = 'uninstalled',
            updated_at = ?,
            uninstalled_at = ?
        WHERE plugin_id = ?
      `)
      .run(now, now, pluginId);
    return this.getManagedPluginPackage(pluginId);
  }

  getManagedPluginPackage(pluginId: string): ManagedPluginPackageRecord | undefined {
    const row = this.database.prepare(managedPluginPackageSelectSql("WHERE plugin_id = ?")).get(pluginId);
    return row ? mapManagedPluginPackage(row) : undefined;
  }

  listManagedPluginPackages(options: { readonly status?: ManagedPluginPackageRecord["status"] } = {}): ManagedPluginPackageRecord[] {
    const whereClause = options.status ? "WHERE status = ?" : "";
    const params = options.status ? [options.status] : [];
    return this.database
      .prepare(`${managedPluginPackageSelectSql(whereClause)} ORDER BY source_kind ASC, plugin_id ASC`)
      .all(...params)
      .map(mapManagedPluginPackage);
  }

  createManagedPluginRuntimeSnapshot(input: CreateManagedPluginRuntimeSnapshotInput): ManagedPluginRuntimeSnapshot {
    const snapshot: ManagedPluginRuntimeSnapshot = {
      id: input.id ?? createManagedPluginRuntimeSnapshotId(),
      runId: input.runId,
      cwd: input.cwd,
      pluginIds: input.capabilities.map((item) => item.pluginId),
      capabilities: input.capabilities,
      policyOverlays: input.policyOverlays,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.database
      .prepare(`
        INSERT INTO managed_plugin_runtime_snapshots (
          id,
          run_id,
          cwd,
          plugin_ids_json,
          capabilities_json,
          policy_overlays_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshot.id,
        snapshot.runId ?? null,
        snapshot.cwd,
        stringifyJson(snapshot.pluginIds),
        stringifyJson(snapshot.capabilities),
        stringifyJson(snapshot.policyOverlays),
        snapshot.createdAt,
      );
    return snapshot;
  }

  getManagedPluginRuntimeSnapshot(id: string): ManagedPluginRuntimeSnapshot | undefined {
    const row = this.database.prepare(managedPluginRuntimeSnapshotSelectSql("WHERE id = ?")).get(id);
    return row ? mapManagedPluginRuntimeSnapshot(row) : undefined;
  }

  getManagedPluginRuntimeSnapshotForRun(runId: string): ManagedPluginRuntimeSnapshot | undefined {
    const row = this.database
      .prepare(`${managedPluginRuntimeSnapshotSelectSql("WHERE run_id = ?")} ORDER BY created_at DESC LIMIT 1`)
      .get(runId);
    return row ? mapManagedPluginRuntimeSnapshot(row) : undefined;
  }

  createMediaJob(input: CreateMediaJobInput, now: string): MediaJob {
    const job: MediaJob = {
      id: createMediaJobId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      providerPresetId: input.providerPresetId,
      operation: input.operation,
      prompt: input.prompt,
      input: input.input ?? {},
      artifactIds: [],
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO media_jobs (
          id,
          workspace_id,
          provider_preset_id,
          operation,
          prompt,
          input_json,
          artifact_ids_json,
          status,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        job.id,
        job.workspaceId,
        job.providerPresetId,
        job.operation,
        job.prompt,
        stringifyJson(redactSecrets(job.input)),
        stringifyJson(job.artifactIds),
        job.status,
        null,
        job.createdAt,
        job.updatedAt,
      );

    const created = this.getMediaJob(job.id);
    if (!created) {
      throw new Error(`Failed to create media job: ${job.id}`);
    }
    return created;
  }

  getMediaJob(id: string): MediaJob | undefined {
    const row = this.database.prepare(mediaJobSelectSql("WHERE id = ?")).get(id);
    return row ? mapMediaJob(row) : undefined;
  }

  listMediaJobs(options: ListMediaJobsOptions = {}): MediaJob[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.providerPresetId) {
      clauses.push("provider_preset_id = ?");
      params.push(options.providerPresetId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${mediaJobSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapMediaJob);
  }

  updateMediaJobStatus(id: string, input: UpdateMediaJobStatusInput, now: string): MediaJob | undefined {
    const existing = this.getMediaJob(id);
    if (!existing) {
      return undefined;
    }

    this.database
      .prepare(`
        UPDATE media_jobs
        SET
          status = ?,
          artifact_ids_json = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        stringifyJson(input.artifactIds ?? existing.artifactIds),
        input.errorMessage === undefined ? existing.errorMessage ?? null : input.errorMessage,
        now,
        id,
      );

    return this.getMediaJob(id);
  }

  createApprovalRequest(input: CreateApprovalRequestInput, now: string): ApprovalRequest {
    const runId = normalizeOptionalOwnerId(input.runId);
    const taskId = normalizeOptionalOwnerId(input.taskId);
    const mediaJobId = normalizeOptionalOwnerId(input.mediaJobId);
    const externalWorkActionId = normalizeOptionalOwnerId(input.externalWorkActionId);
    const workflowStepId = normalizeOptionalOwnerId(input.workflowStepId);
    const hasRunOwner = Boolean(runId && taskId);
    const hasMediaOwner = Boolean(mediaJobId);
    const hasExternalWorkActionOwner = Boolean(externalWorkActionId);
    const hasWorkflowStepOwner = Boolean(workflowStepId);
    if (Boolean(runId) !== Boolean(taskId)) {
      throw new Error("Run approval requests require both runId and taskId.");
    }
    if ([hasRunOwner, hasMediaOwner, hasExternalWorkActionOwner, hasWorkflowStepOwner].filter(Boolean).length !== 1) {
      throw new Error("Approval requests require exactly one owner: runId/taskId, mediaJobId, externalWorkActionId, or workflowStepId.");
    }
    if (runId && !this.getRun(runId)) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (mediaJobId && !this.getMediaJob(mediaJobId)) {
      throw new Error(`Media job not found: ${mediaJobId}`);
    }
    if (externalWorkActionId && !this.getExternalWorkAction(externalWorkActionId)) {
      throw new Error(`External work action not found: ${externalWorkActionId}`);
    }
    if (workflowStepId && !this.getChannelWorkflowStep(workflowStepId)) {
      throw new Error(`Workflow step not found: ${workflowStepId}`);
    }

    const approval: ApprovalRequest = {
      id: createApprovalRequestId(),
      runId,
      taskId,
      mediaJobId,
      externalWorkActionId,
      workflowStepId,
      channelId: input.channelId,
      toolCallId: input.toolCallId,
      actionType: input.actionType,
      risk: input.risk,
      title: String(redactSecrets(input.title, input.extraSecrets ?? [])),
      description: String(redactSecrets(input.description, input.extraSecrets ?? [])),
      payload: redactSecrets(input.payload, input.extraSecrets ?? []) as ApprovalRequest["payload"],
      status: "pending",
      createdAt: now,
      expiresAt: input.expiresAt,
    };

    this.database
      .prepare(`
        INSERT INTO approval_requests (
          id,
          run_id,
          task_id,
          media_job_id,
          external_work_action_id,
          workflow_step_id,
          channel_id,
          tool_call_id,
          action_type,
          risk,
          title,
          description,
          payload_json,
          status,
          created_at,
          expires_at,
          resolved_at,
          resolved_by,
          decision_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        approval.id,
        approval.runId ?? null,
        approval.taskId ?? null,
        approval.mediaJobId ?? null,
        approval.externalWorkActionId ?? null,
        approval.workflowStepId ?? null,
        approval.channelId ?? null,
        approval.toolCallId ?? null,
        approval.actionType,
        approval.risk,
        approval.title,
        approval.description,
        stringifyJson(approval.payload),
        approval.status,
        approval.createdAt,
        approval.expiresAt ?? null,
        null,
        null,
        null,
      );

    const created = this.getApprovalRequest(approval.id);
    if (!created) {
      throw new Error(`Failed to create approval request: ${approval.id}`);
    }
    this.tryRebuildLingThreadMetadataForApproval(created, now);
    return created;
  }

  getApprovalRequest(id: string): ApprovalRequest | undefined {
    const row = this.database.prepare(approvalRequestSelectSql("WHERE id = ?")).get(id);
    return row ? mapApprovalRequest(row) : undefined;
  }

  listApprovalRequests(options: ListApprovalRequestsOptions = {}): ApprovalRequest[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.mediaJobId) {
      clauses.push("media_job_id = ?");
      params.push(options.mediaJobId);
    }
    if (options.externalWorkActionId) {
      clauses.push("external_work_action_id = ?");
      params.push(options.externalWorkActionId);
    }
    if (options.workflowStepId) {
      clauses.push("workflow_step_id = ?");
      params.push(options.workflowStepId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${approvalRequestSelectSql(whereClause)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapApprovalRequest);
  }

  approveApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "approved", input, now);
  }

  denyApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "denied", input, now);
  }

  expireApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "expired", input, now);
  }

  cancelApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "cancelled", input, now);
  }

  getApprovalPolicy(): ApprovalPolicy {
    const row = this.database.prepare(approvalPolicySelectSql("WHERE workspace_id = ?")).get(DEFAULT_WORKSPACE_ID);
    if (row) {
      return mapApprovalPolicy(row);
    }
    this.ensureDefaultApprovalPolicy();
    const created = this.database.prepare(approvalPolicySelectSql("WHERE workspace_id = ?")).get(DEFAULT_WORKSPACE_ID);
    if (!created) {
      throw new Error(`Approval policy not found: ${DEFAULT_WORKSPACE_ID}`);
    }
    return mapApprovalPolicy(created);
  }

  updateApprovalPolicy(input: ApprovalPolicyUpdateInput, now: string): ApprovalPolicy {
    const existing = this.getApprovalPolicy();
    const next: ApprovalPolicy = {
      ...existing,
      toolDecisions: {
        ...existing.toolDecisions,
        ...(input.toolDecisions ?? {}),
      },
      allowedWritePaths: input.allowedWritePaths ?? existing.allowedWritePaths,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE approval_policies
        SET
          tool_decisions_json = ?,
          allowed_write_paths_json = ?,
          updated_at = ?
        WHERE workspace_id = ?
      `)
      .run(
        stringifyJson(next.toolDecisions),
        stringifyJson(next.allowedWritePaths),
        next.updatedAt,
        next.workspaceId,
      );

    return this.getApprovalPolicy();
  }

  close(): void {
    if (this.database.isOpen) {
      this.database.close();
    }
  }

  private configureDatabase(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private resolveApprovalRequest(
    id: string,
    status: Extract<ApprovalStatus, "approved" | "denied" | "expired" | "cancelled">,
    input: ResolveApprovalRequestInput,
    now: string,
  ): ApprovalRequest | undefined {
    const existing = this.getApprovalRequest(id);
    if (!existing) {
      return undefined;
    }
    if (existing.status !== "pending") {
      throw new Error(`Approval request is not pending: ${id}`);
    }

    this.database
      .prepare(`
        UPDATE approval_requests
        SET
          status = ?,
          resolved_at = ?,
          resolved_by = ?,
          decision_reason = ?
        WHERE id = ?
      `)
      .run(
        status,
        now,
        status === "expired" ? (input.resolvedBy ?? null) : (input.resolvedBy ?? "local-user"),
        input.reason ?? null,
        id,
      );

    const resolved = this.getApprovalRequest(id);
    this.tryRebuildLingThreadMetadataForApproval(resolved, now);
    return resolved;
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    if (!this.hasMigration(INITIAL_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS run_sessions (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          cwd TEXT NOT NULL,
          task_id TEXT NOT NULL,
          channel_id TEXT,
          teammate_id TEXT,
          provider_preset_id TEXT,
          provider_name TEXT NOT NULL,
          provider_model TEXT NOT NULL,
          task_snapshot_json TEXT NOT NULL,
	          provider_snapshot_json TEXT NOT NULL,
	          request_snapshot_json TEXT NOT NULL,
	          event_log_path TEXT NOT NULL,
	          thread_id TEXT,
	          parent_run_id TEXT,
          intervention_id TEXT,
          continuation_reason TEXT,
          summary_path TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts TEXT NOT NULL,
          type TEXT NOT NULL,
          data_json TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          UNIQUE(run_id, seq)
        );

        CREATE INDEX IF NOT EXISTS idx_run_sessions_status ON run_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_run_sessions_task ON run_sessions(task_id);
        CREATE INDEX IF NOT EXISTS idx_run_sessions_created_at ON run_sessions(created_at);
        CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
        CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(type);
      `);

      this.recordMigration(INITIAL_MIGRATION_VERSION, INITIAL_MIGRATION_NAME);
    }

    if (!this.hasMigration(PROVIDERS_MIGRATION_VERSION)) {
      if (!this.hasColumn("run_sessions", "provider_preset_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN provider_preset_id TEXT;");
      }

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS provider_presets (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          display_name TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          api TEXT NOT NULL,
          provider_transport TEXT,
          base_url TEXT,
          api_key_ref TEXT,
          headers_json TEXT NOT NULL,
          auth_header INTEGER,
          reasoning INTEGER,
          input_json TEXT NOT NULL,
          context_window INTEGER,
          max_tokens INTEGER,
          compat_json TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_provider_presets_kind ON provider_presets(kind);
        CREATE INDEX IF NOT EXISTS idx_provider_presets_enabled ON provider_presets(enabled);
      `);

      this.recordMigration(PROVIDERS_MIGRATION_VERSION, PROVIDERS_MIGRATION_NAME);
    }

    if (!this.hasMigration(APPROVALS_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
      `);

      this.recordMigration(APPROVALS_MIGRATION_VERSION, APPROVALS_MIGRATION_NAME);
    }

    if (!this.hasMigration(WORKSPACE_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          default_provider_preset_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          bound_path TEXT,
          default_provider_preset_id TEXT,
          default_teammate_id TEXT,
          auto_reply_mode TEXT NOT NULL DEFAULT 'mentions_only',
          response_language TEXT,
          allowed_tools_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          assignee_teammate_id TEXT,
          current_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id)
        );

        CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_channel_status ON tasks(channel_id, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_current_run ON tasks(current_run_id);
      `);

      this.recordMigration(WORKSPACE_MIGRATION_VERSION, WORKSPACE_MIGRATION_NAME);
    }

    if (!this.hasMigration(APPROVAL_POLICY_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS approval_policies (
          workspace_id TEXT PRIMARY KEY,
          tool_decisions_json TEXT NOT NULL,
          allowed_write_paths_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
      `);

      this.recordMigration(APPROVAL_POLICY_MIGRATION_VERSION, APPROVAL_POLICY_MIGRATION_NAME);
    }

    if (!this.hasMigration(PROVIDER_CHECKS_MIGRATION_VERSION)) {
      if (!this.hasColumn("provider_presets", "last_check_json")) {
        this.database.exec("ALTER TABLE provider_presets ADD COLUMN last_check_json TEXT;");
      }

      this.recordMigration(PROVIDER_CHECKS_MIGRATION_VERSION, PROVIDER_CHECKS_MIGRATION_NAME);
    }

    if (!this.hasMigration(ARTIFACTS_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          type TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT,
          content_type TEXT,
          size_bytes INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
      `);

      this.recordMigration(ARTIFACTS_MIGRATION_VERSION, ARTIFACTS_MIGRATION_NAME);
    }

    if (!this.hasMigration(MEDIA_JOBS_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS media_jobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          provider_preset_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          prompt TEXT NOT NULL,
          input_json TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_media_jobs_workspace ON media_jobs(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_provider ON media_jobs(provider_preset_id);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_created_at ON media_jobs(created_at);
      `);

      this.recordMigration(MEDIA_JOBS_MIGRATION_VERSION, MEDIA_JOBS_MIGRATION_NAME);
    }

    if (!this.hasMigration(MEDIA_JOB_ARTIFACTS_MIGRATION_VERSION)) {
      this.database.exec(`
        DROP TABLE IF EXISTS artifacts_next;

        CREATE TABLE artifacts_next (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          media_job_id TEXT,
          type TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT,
          content_type TEXT,
          size_bytes INTEGER,
          created_at TEXT NOT NULL,
          CHECK ((run_id IS NOT NULL AND media_job_id IS NULL) OR (run_id IS NULL AND media_job_id IS NOT NULL)),
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE
        );

        INSERT INTO artifacts_next (
          id,
          run_id,
          media_job_id,
          type,
          path,
          title,
          content_type,
          size_bytes,
          created_at
        )
        SELECT
          id,
          run_id,
          NULL,
          type,
          path,
          title,
          content_type,
          size_bytes,
          created_at
        FROM artifacts;

        DROP TABLE artifacts;
        ALTER TABLE artifacts_next RENAME TO artifacts;

        CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_media_job ON artifacts(media_job_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
      `);

      this.recordMigration(MEDIA_JOB_ARTIFACTS_MIGRATION_VERSION, MEDIA_JOB_ARTIFACTS_MIGRATION_NAME);
    }

    if (!this.hasMigration(APPROVAL_MEDIA_JOB_OWNER_MIGRATION_VERSION)) {
      this.database.exec(`
        DROP TABLE IF EXISTS approval_requests_next;

        CREATE TABLE approval_requests_next (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          task_id TEXT,
          media_job_id TEXT,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT,
          CHECK (
            (run_id IS NOT NULL AND task_id IS NOT NULL AND media_job_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NOT NULL)
          ),
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE
        );

        INSERT INTO approval_requests_next (
          id,
          run_id,
          task_id,
          media_job_id,
          channel_id,
          tool_call_id,
          action_type,
          risk,
          title,
          description,
          payload_json,
          status,
          created_at,
          expires_at,
          resolved_at,
          resolved_by,
          decision_reason
        )
        SELECT
          id,
          run_id,
          task_id,
          NULL,
          channel_id,
          tool_call_id,
          action_type,
          risk,
          title,
          description,
          payload_json,
          status,
          created_at,
          expires_at,
          resolved_at,
          resolved_by,
          decision_reason
        FROM approval_requests;

        DROP TABLE approval_requests;
        ALTER TABLE approval_requests_next RENAME TO approval_requests;

        CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_media_job ON approval_requests(media_job_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
      `);

      this.recordMigration(APPROVAL_MEDIA_JOB_OWNER_MIGRATION_VERSION, APPROVAL_MEDIA_JOB_OWNER_MIGRATION_NAME);
    }

    const hasChannelRuntimeMigration = this.hasMigration(CHANNEL_RUNTIME_MIGRATION_VERSION);
    if (
      !hasChannelRuntimeMigration ||
      !this.hasColumn("channels", "status") ||
      !this.hasColumn("channels", "runtime_policy_json") ||
      !this.hasTable("state_transition_events") ||
      !this.hasTable("resource_leases")
    ) {
      if (!this.hasColumn("channels", "status")) {
        this.database.exec("ALTER TABLE channels ADD COLUMN status TEXT NOT NULL DEFAULT 'active';");
      }
      if (!this.hasColumn("channels", "runtime_policy_json")) {
        this.database.exec(
          `ALTER TABLE channels ADD COLUMN runtime_policy_json TEXT NOT NULL DEFAULT '${stringifyJson(normalizeChannelRuntimePolicy(undefined))}';`,
        );
      }

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS state_transition_events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          from_status TEXT NOT NULL,
          to_status TEXT NOT NULL,
          event TEXT NOT NULL,
          actor TEXT NOT NULL,
          reason TEXT,
          idempotency_key TEXT,
          created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_state_transition_idempotency
        ON state_transition_events(entity_type, entity_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_state_transition_entity
        ON state_transition_events(entity_type, entity_id, created_at);

        CREATE TABLE IF NOT EXISTS resource_leases (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_key TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          status TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          released_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_resource_lease
        ON resource_leases(workspace_id, resource_type, resource_key)
        WHERE status = 'active';

        CREATE INDEX IF NOT EXISTS idx_resource_leases_owner
        ON resource_leases(owner_type, owner_id, status);

        CREATE INDEX IF NOT EXISTS idx_resource_leases_expiry
        ON resource_leases(status, expires_at);
      `);

      if (!hasChannelRuntimeMigration) {
        this.recordMigration(CHANNEL_RUNTIME_MIGRATION_VERSION, CHANNEL_RUNTIME_MIGRATION_NAME);
      }
    }

    const hasProviderSecretsMigration = this.hasMigration(PROVIDER_SECRETS_MIGRATION_VERSION);
    if (!hasProviderSecretsMigration || !this.hasTable("provider_secrets")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS provider_secrets (
          provider_id TEXT PRIMARY KEY,
          secret_value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(provider_id) REFERENCES provider_presets(id) ON DELETE CASCADE
        );
      `);

      if (!hasProviderSecretsMigration) {
        this.recordMigration(PROVIDER_SECRETS_MIGRATION_VERSION, PROVIDER_SECRETS_MIGRATION_NAME);
      }
    }

    const hasChannelWorkspaceMigration = this.hasMigration(CHANNEL_WORKSPACE_MIGRATION_VERSION);
    if (
      !hasChannelWorkspaceMigration ||
      !this.hasColumn("channels", "default_teammate_id") ||
      !this.hasColumn("tasks", "assignee_teammate_id") ||
      !this.hasTable("channel_messages") ||
      !this.hasTable("channel_attachments") ||
      !this.hasTable("channel_link_previews")
    ) {
      if (!this.hasColumn("channels", "default_teammate_id")) {
        this.database.exec("ALTER TABLE channels ADD COLUMN default_teammate_id TEXT;");
      }
      if (!this.hasColumn("tasks", "assignee_teammate_id")) {
        this.database.exec("ALTER TABLE tasks ADD COLUMN assignee_teammate_id TEXT;");
      }

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_messages (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          thread_id TEXT,
          kind TEXT NOT NULL,
          intent TEXT NOT NULL,
          author_type TEXT NOT NULL,
          author_id TEXT,
          body TEXT NOT NULL,
          mentions_json TEXT NOT NULL,
          attachment_ids_json TEXT NOT NULL,
          link_preview_ids_json TEXT NOT NULL,
          linked_task_id TEXT,
          linked_run_id TEXT,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created
        ON channel_messages(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_messages_thread
        ON channel_messages(thread_id, created_at);

        CREATE TABLE IF NOT EXISTS channel_attachments (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          message_id TEXT,
          kind TEXT NOT NULL,
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(message_id) REFERENCES channel_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_attachments_channel_created
        ON channel_attachments(channel_id, created_at);

        CREATE TABLE IF NOT EXISTS channel_link_previews (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          message_id TEXT,
          url TEXT NOT NULL,
          normalized_url TEXT NOT NULL,
          title TEXT,
          description TEXT,
          image_url TEXT,
          site_name TEXT,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(message_id) REFERENCES channel_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_link_previews_channel_created
        ON channel_link_previews(channel_id, created_at);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_link_previews_channel_url
        ON channel_link_previews(channel_id, normalized_url);
      `);

      if (!hasChannelWorkspaceMigration) {
        this.recordMigration(CHANNEL_WORKSPACE_MIGRATION_VERSION, CHANNEL_WORKSPACE_MIGRATION_NAME);
      }
    }

    const hasChannelProtocolMigration = this.hasMigration(CHANNEL_PROTOCOL_MIGRATION_VERSION);
    if (
      !hasChannelProtocolMigration ||
      !this.hasTable("channel_briefs") ||
      !this.hasTable("channel_decisions") ||
      !this.hasTable("channel_handoffs") ||
      !this.hasTable("channel_context_summaries")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_briefs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL UNIQUE,
          objective TEXT NOT NULL,
          scope TEXT NOT NULL,
          acceptance_criteria_json TEXT NOT NULL,
          open_questions_json TEXT NOT NULL,
          risks_json TEXT NOT NULL,
          decision_ids_json TEXT NOT NULL,
          attachment_ids_json TEXT NOT NULL,
          link_preview_ids_json TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_briefs_channel
        ON channel_briefs(channel_id);

        CREATE TABLE IF NOT EXISTS channel_decisions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT,
          source_task_id TEXT,
          source_run_id TEXT,
          title TEXT NOT NULL,
          decision TEXT NOT NULL,
          rationale TEXT NOT NULL,
          alternatives_json TEXT NOT NULL,
          status TEXT NOT NULL,
          supersedes_decision_id TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE SET NULL,
          FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(source_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
          FOREIGN KEY(supersedes_decision_id) REFERENCES channel_decisions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_decisions_channel_created
        ON channel_decisions(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_decisions_channel_status_created
        ON channel_decisions(channel_id, status, created_at);

        CREATE TABLE IF NOT EXISTS channel_handoffs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT,
          source_task_id TEXT,
          source_run_id TEXT,
          from_participant_id TEXT NOT NULL,
          from_participant_label TEXT NOT NULL,
          to_participant_id TEXT NOT NULL,
          to_participant_label TEXT NOT NULL,
          reason TEXT NOT NULL,
          required_input TEXT NOT NULL,
          expected_output TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE SET NULL,
          FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(source_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_handoffs_channel_status_created
        ON channel_handoffs(channel_id, status, created_at);

        CREATE TABLE IF NOT EXISTS channel_context_summaries (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          source_message_ids_json TEXT NOT NULL,
          decision_ids_json TEXT NOT NULL,
          summary TEXT NOT NULL,
          acceptance_criteria_json TEXT NOT NULL,
          open_questions_json TEXT NOT NULL,
          author_type TEXT NOT NULL,
          author_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_context_summaries_target_updated
        ON channel_context_summaries(channel_id, target_type, target_id, updated_at);
      `);

      if (!hasChannelProtocolMigration) {
        this.recordMigration(CHANNEL_PROTOCOL_MIGRATION_VERSION, CHANNEL_PROTOCOL_MIGRATION_NAME);
      }
    }

    const hasChannelWorkflowMigration = this.hasMigration(CHANNEL_WORKFLOW_MIGRATION_VERSION);
    if (
      !hasChannelWorkflowMigration ||
      !this.hasTable("channel_workflows") ||
      !this.hasTable("channel_workflow_steps")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_workflows (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_handoff_id TEXT,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_handoff_id) REFERENCES channel_handoffs(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_workflows_channel_status_updated
        ON channel_workflows(channel_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_workflows_handoff
        ON channel_workflows(source_handoff_id);

        CREATE TABLE IF NOT EXISTS channel_workflow_steps (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          source_handoff_id TEXT,
          context_summary_id TEXT,
          task_id TEXT,
          run_id TEXT,
          position INTEGER NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          to_participant_id TEXT NOT NULL,
          to_participant_label TEXT NOT NULL,
          status TEXT NOT NULL,
          blocker TEXT,
          result_summary TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(workflow_id) REFERENCES channel_workflows(id) ON DELETE CASCADE,
          FOREIGN KEY(source_handoff_id) REFERENCES channel_handoffs(id) ON DELETE SET NULL,
          FOREIGN KEY(context_summary_id) REFERENCES channel_context_summaries(id) ON DELETE SET NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_workflow_position
        ON channel_workflow_steps(workflow_id, position);

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_channel_status
        ON channel_workflow_steps(channel_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_task
        ON channel_workflow_steps(task_id);

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_run
        ON channel_workflow_steps(run_id);
      `);

      if (!hasChannelWorkflowMigration) {
        this.recordMigration(CHANNEL_WORKFLOW_MIGRATION_VERSION, CHANNEL_WORKFLOW_MIGRATION_NAME);
      }
    }

    const hasAiTeammateWorkspaceMigration = this.hasMigration(AI_TEAMMATE_WORKSPACE_MIGRATION_VERSION);
    if (
      !hasAiTeammateWorkspaceMigration ||
      !this.hasTable("ai_teammates") ||
      !this.hasTable("teammate_channel_memberships") ||
      !this.hasTable("teammate_skill_bindings") ||
      !this.hasTable("teammate_memory_scopes") ||
      !this.hasTable("teammate_direct_threads") ||
      !this.hasTable("teammate_direct_messages")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS ai_teammates (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          template_id TEXT,
          role_key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          description TEXT NOT NULL,
          avatar_tone TEXT,
          avatar_image_attachment_id TEXT,
          provider_preset_id TEXT,
          runner_id TEXT,
          system_prompt TEXT,
          append_system_prompt_json TEXT NOT NULL,
          allowed_tools_json TEXT NOT NULL,
          approval_profile_json TEXT NOT NULL,
          status TEXT NOT NULL,
          pinned INTEGER NOT NULL,
          hidden INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_teammates_workspace_status
        ON ai_teammates(workspace_id, status, hidden, pinned);

        CREATE TABLE IF NOT EXISTS teammate_channel_memberships (
          teammate_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          is_default INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(teammate_id, channel_id),
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_channel_memberships_channel
        ON teammate_channel_memberships(channel_id);

        CREATE TABLE IF NOT EXISTS teammate_skill_bindings (
          teammate_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          source TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(teammate_id, skill_id),
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS teammate_memory_scopes (
          id TEXT PRIMARY KEY,
          teammate_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          channel_id TEXT,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_memory_scopes_teammate
        ON teammate_memory_scopes(teammate_id, enabled);

        CREATE TABLE IF NOT EXISTS teammate_direct_threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_teammate_direct_threads_teammate
        ON teammate_direct_threads(workspace_id, teammate_id);

        CREATE TABLE IF NOT EXISTS teammate_direct_messages (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          author_type TEXT NOT NULL,
          author_id TEXT,
          body TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          linked_task_id TEXT,
          linked_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES teammate_direct_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_messages_thread_created
        ON teammate_direct_messages(thread_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_messages_teammate_created
        ON teammate_direct_messages(teammate_id, created_at);
      `);

      if (!hasAiTeammateWorkspaceMigration) {
        this.recordMigration(AI_TEAMMATE_WORKSPACE_MIGRATION_VERSION, AI_TEAMMATE_WORKSPACE_MIGRATION_NAME);
      }
    }

    const hasExternalWorkMigration = this.hasMigration(EXTERNAL_WORK_MIGRATION_VERSION);
    if (
      !hasExternalWorkMigration ||
      !this.hasTable("external_work_items") ||
      !this.hasColumn("artifacts", "external_work_id")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_items (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          work_item_kind TEXT NOT NULL,
          external_id TEXT NOT NULL,
          identifier TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          workflow_step_id TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL,
          item_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_external_work_idempotency
        ON external_work_items(workspace_id, source_kind, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_external_work_channel_created
        ON external_work_items(channel_id, created_at);
      `);

      if (!this.hasColumn("artifacts", "external_work_id")) {
        this.database.exec(`
          DROP TABLE IF EXISTS artifacts_next;

          CREATE TABLE artifacts_next (
            id TEXT PRIMARY KEY,
            run_id TEXT,
            media_job_id TEXT,
            external_work_id TEXT,
            type TEXT NOT NULL,
            path TEXT NOT NULL,
            title TEXT,
            content_type TEXT,
            size_bytes INTEGER,
            created_at TEXT NOT NULL,
            CHECK (
              (run_id IS NOT NULL AND media_job_id IS NULL AND external_work_id IS NULL)
              OR (run_id IS NULL AND media_job_id IS NOT NULL AND external_work_id IS NULL)
              OR (run_id IS NULL AND media_job_id IS NULL AND external_work_id IS NOT NULL)
            ),
            FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
            FOREIGN KEY(external_work_id) REFERENCES external_work_items(id) ON DELETE CASCADE
          );

          INSERT INTO artifacts_next (
            id,
            run_id,
            media_job_id,
            external_work_id,
            type,
            path,
            title,
            content_type,
            size_bytes,
            created_at
          )
          SELECT
            id,
            run_id,
            media_job_id,
            NULL,
            type,
            path,
            title,
            content_type,
            size_bytes,
            created_at
          FROM artifacts;

          DROP TABLE artifacts;
          ALTER TABLE artifacts_next RENAME TO artifacts;

          CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
          CREATE INDEX IF NOT EXISTS idx_artifacts_media_job ON artifacts(media_job_id);
          CREATE INDEX IF NOT EXISTS idx_artifacts_external_work ON artifacts(external_work_id);
          CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
        `);
      }

      if (!hasExternalWorkMigration) {
        this.recordMigration(EXTERNAL_WORK_MIGRATION_VERSION, EXTERNAL_WORK_MIGRATION_NAME);
      }
    }

    const hasExternalWorkSchedulerMigration = this.hasMigration(EXTERNAL_WORK_SCHEDULER_MIGRATION_VERSION);
    if (!hasExternalWorkSchedulerMigration || !this.hasTable("external_work_scheduler_state")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_scheduler_state (
          external_work_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          source_key TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          workflow_step_id TEXT NOT NULL,
          scheduler_status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL,
          last_attempt_at TEXT,
          next_attempt_at TEXT,
          max_retry_backoff_ms INTEGER NOT NULL,
          last_error_code TEXT,
          last_error_message TEXT,
          workspace_path TEXT,
          workspace_mode TEXT,
          hook_artifact_ids_json TEXT NOT NULL,
          last_reconciled_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_external_work_scheduler_subject
        ON external_work_scheduler_state(workspace_id, source_key, subject_key, scheduler_status);

        CREATE INDEX IF NOT EXISTS idx_external_work_scheduler_channel_status
        ON external_work_scheduler_state(channel_id, scheduler_status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_external_work_scheduler_retry
        ON external_work_scheduler_state(scheduler_status, next_attempt_at);
      `);

      if (!hasExternalWorkSchedulerMigration) {
        this.recordMigration(EXTERNAL_WORK_SCHEDULER_MIGRATION_VERSION, EXTERNAL_WORK_SCHEDULER_MIGRATION_NAME);
      }
    }

    const hasExternalWorkActionsMigration = this.hasMigration(EXTERNAL_WORK_ACTIONS_MIGRATION_VERSION);
    if (
      !hasExternalWorkActionsMigration ||
      !this.hasTable("external_work_actions") ||
      !this.hasColumn("approval_requests", "external_work_action_id")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_actions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          external_work_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          action_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          approval_id TEXT,
          idempotency_key TEXT NOT NULL,
          target_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          approval_requirement TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL,
          execution_attempt_count INTEGER NOT NULL,
          last_attempt_at TEXT,
          next_attempt_at TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          executed_at TEXT,
          FOREIGN KEY(external_work_id) REFERENCES external_work_items(id) ON DELETE CASCADE,
          FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_external_work_actions_idempotency
        ON external_work_actions(workspace_id, source_kind, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_external_work_actions_external_work_status
        ON external_work_actions(workspace_id, external_work_id, status);

        CREATE INDEX IF NOT EXISTS idx_external_work_actions_approval
        ON external_work_actions(workspace_id, approval_id);

        CREATE INDEX IF NOT EXISTS idx_external_work_actions_updated
        ON external_work_actions(workspace_id, updated_at);
      `);

      if (!this.hasColumn("approval_requests", "external_work_action_id")) {
        this.database.exec(`
          DROP TABLE IF EXISTS approval_requests_next;

          CREATE TABLE approval_requests_next (
            id TEXT PRIMARY KEY,
            run_id TEXT,
            task_id TEXT,
            media_job_id TEXT,
            external_work_action_id TEXT,
            channel_id TEXT,
            tool_call_id TEXT,
            action_type TEXT NOT NULL,
            risk TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            resolved_at TEXT,
            resolved_by TEXT,
            decision_reason TEXT,
            CHECK (
              (run_id IS NOT NULL AND task_id IS NOT NULL AND media_job_id IS NULL AND external_work_action_id IS NULL)
              OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NOT NULL AND external_work_action_id IS NULL)
              OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NOT NULL)
            ),
            FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
            FOREIGN KEY(external_work_action_id) REFERENCES external_work_actions(id) ON DELETE CASCADE
          );

          INSERT INTO approval_requests_next (
            id,
            run_id,
            task_id,
            media_job_id,
            external_work_action_id,
            channel_id,
            tool_call_id,
            action_type,
            risk,
            title,
            description,
            payload_json,
            status,
            created_at,
            expires_at,
            resolved_at,
            resolved_by,
            decision_reason
          )
          SELECT
            id,
            run_id,
            task_id,
            media_job_id,
            NULL,
            channel_id,
            tool_call_id,
            action_type,
            risk,
            title,
            description,
            payload_json,
            status,
            created_at,
            expires_at,
            resolved_at,
            resolved_by,
            decision_reason
          FROM approval_requests;

          DROP TABLE approval_requests;
          ALTER TABLE approval_requests_next RENAME TO approval_requests;

          CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_media_job ON approval_requests(media_job_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_external_work_action ON approval_requests(external_work_action_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
        `);
      }

      if (!hasExternalWorkActionsMigration) {
        this.recordMigration(EXTERNAL_WORK_ACTIONS_MIGRATION_VERSION, EXTERNAL_WORK_ACTIONS_MIGRATION_NAME);
      }
    }

    const hasExternalWorkCiTriageMigration = this.hasMigration(EXTERNAL_WORK_CI_TRIAGE_MIGRATION_VERSION);
    if (!hasExternalWorkCiTriageMigration || !this.hasTable("external_work_ci_triage")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_ci_triage (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          external_work_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          repository TEXT NOT NULL,
          subject_kind TEXT NOT NULL,
          subject_number INTEGER NOT NULL,
          head_sha TEXT NOT NULL,
          failure_key TEXT NOT NULL,
          status TEXT NOT NULL,
          check_name TEXT NOT NULL,
          workflow_name TEXT,
          job_name TEXT,
          conclusion TEXT NOT NULL,
          html_url TEXT,
          first_failing_command TEXT,
          reproduction_command TEXT,
          suspected_source_path TEXT,
          task_id TEXT,
          run_id TEXT,
          artifact_ids_json TEXT NOT NULL,
          failure_json TEXT NOT NULL,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(external_work_id) REFERENCES external_work_items(id) ON DELETE CASCADE,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_external_work_ci_triage_failure
        ON external_work_ci_triage(workspace_id, source_kind, failure_key);

        CREATE INDEX IF NOT EXISTS idx_external_work_ci_triage_external_work_status
        ON external_work_ci_triage(workspace_id, external_work_id, status);

        CREATE INDEX IF NOT EXISTS idx_external_work_ci_triage_channel_updated
        ON external_work_ci_triage(workspace_id, channel_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_external_work_ci_triage_head
        ON external_work_ci_triage(workspace_id, head_sha);
      `);

      if (!hasExternalWorkCiTriageMigration) {
        this.recordMigration(EXTERNAL_WORK_CI_TRIAGE_MIGRATION_VERSION, EXTERNAL_WORK_CI_TRIAGE_MIGRATION_NAME);
      }
    }

    const hasChannelExecutionProposalsMigration = this.hasMigration(CHANNEL_EXECUTION_PROPOSALS_MIGRATION_VERSION);
    if (!hasChannelExecutionProposalsMigration || !this.hasTable("channel_execution_proposals")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_execution_proposals (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          proposed_by_teammate_id TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          assignee_teammate_id TEXT NOT NULL,
          acceptance_criteria_json TEXT NOT NULL,
          collaboration_steps_json TEXT NOT NULL,
          required_tools_json TEXT NOT NULL,
          risk_summary TEXT,
          response_language TEXT,
          status TEXT NOT NULL,
          linked_task_id TEXT,
          linked_run_id TEXT,
          linked_workflow_id TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE CASCADE,
          FOREIGN KEY(linked_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(linked_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_execution_proposals_channel_created
        ON channel_execution_proposals(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_execution_proposals_source
        ON channel_execution_proposals(source_message_id);

        CREATE INDEX IF NOT EXISTS idx_channel_execution_proposals_status
        ON channel_execution_proposals(channel_id, status, updated_at);
      `);

      if (!hasChannelExecutionProposalsMigration) {
        this.recordMigration(CHANNEL_EXECUTION_PROPOSALS_MIGRATION_VERSION, CHANNEL_EXECUTION_PROPOSALS_MIGRATION_NAME);
      }
    }

    const hasChannelExecutionProposalWorkflowLinkMigration = this.hasMigration(CHANNEL_EXECUTION_PROPOSAL_WORKFLOW_LINK_MIGRATION_VERSION);
    if (
      !hasChannelExecutionProposalWorkflowLinkMigration ||
      !this.hasColumn("channel_execution_proposals", "linked_workflow_id")
    ) {
      if (this.hasTable("channel_execution_proposals") && !this.hasColumn("channel_execution_proposals", "linked_workflow_id")) {
        this.database.exec("ALTER TABLE channel_execution_proposals ADD COLUMN linked_workflow_id TEXT;");
      }
      if (!hasChannelExecutionProposalWorkflowLinkMigration) {
        this.recordMigration(CHANNEL_EXECUTION_PROPOSAL_WORKFLOW_LINK_MIGRATION_VERSION, CHANNEL_EXECUTION_PROPOSAL_WORKFLOW_LINK_MIGRATION_NAME);
      }
    }

    const hasChannelIntentDecisionsMigration = this.hasMigration(CHANNEL_INTENT_DECISIONS_MIGRATION_VERSION);
    if (!hasChannelIntentDecisionsMigration || !this.hasTable("channel_intent_decisions")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_intent_decisions (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          action TEXT NOT NULL,
          selected_teammate_id TEXT,
          selected_teammate_ids_json TEXT,
          proposal_id TEXT,
          reply_message_id TEXT,
          reply_message_ids_json TEXT,
          workflow_id TEXT,
          reason TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE CASCADE,
          FOREIGN KEY(proposal_id) REFERENCES channel_execution_proposals(id) ON DELETE SET NULL,
          FOREIGN KEY(reply_message_id) REFERENCES channel_messages(id) ON DELETE SET NULL,
          FOREIGN KEY(workflow_id) REFERENCES channel_workflows(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_intent_decisions_channel_created
        ON channel_intent_decisions(workspace_id, channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_intent_decisions_source
        ON channel_intent_decisions(workspace_id, source_message_id);

        CREATE INDEX IF NOT EXISTS idx_channel_intent_decisions_status
        ON channel_intent_decisions(workspace_id, channel_id, status, updated_at);
      `);
      if (!hasChannelIntentDecisionsMigration) {
        this.recordMigration(CHANNEL_INTENT_DECISIONS_MIGRATION_VERSION, CHANNEL_INTENT_DECISIONS_MIGRATION_NAME);
      }
    }

    const hasChannelVisibleMultiReplyIntentMigration = this.hasMigration(CHANNEL_VISIBLE_MULTI_REPLY_INTENT_MIGRATION_VERSION);
    if (
      !hasChannelVisibleMultiReplyIntentMigration ||
      !this.hasColumn("channel_intent_decisions", "selected_teammate_ids_json") ||
      !this.hasColumn("channel_intent_decisions", "reply_message_ids_json")
    ) {
      if (this.hasTable("channel_intent_decisions") && !this.hasColumn("channel_intent_decisions", "selected_teammate_ids_json")) {
        this.database.exec("ALTER TABLE channel_intent_decisions ADD COLUMN selected_teammate_ids_json TEXT;");
      }
      if (this.hasTable("channel_intent_decisions") && !this.hasColumn("channel_intent_decisions", "reply_message_ids_json")) {
        this.database.exec("ALTER TABLE channel_intent_decisions ADD COLUMN reply_message_ids_json TEXT;");
      }
      if (!hasChannelVisibleMultiReplyIntentMigration) {
        this.recordMigration(CHANNEL_VISIBLE_MULTI_REPLY_INTENT_MIGRATION_VERSION, CHANNEL_VISIBLE_MULTI_REPLY_INTENT_MIGRATION_NAME);
      }
    }

    const hasResponseLanguageContextMigration = this.hasMigration(RESPONSE_LANGUAGE_CONTEXT_MIGRATION_VERSION);
    if (
      !hasResponseLanguageContextMigration ||
      !this.hasColumn("channels", "response_language") ||
      !this.hasColumn("channel_execution_proposals", "response_language")
    ) {
      if (this.hasTable("channels") && !this.hasColumn("channels", "response_language")) {
        this.database.exec("ALTER TABLE channels ADD COLUMN response_language TEXT;");
      }
      if (this.hasTable("channel_execution_proposals") && !this.hasColumn("channel_execution_proposals", "response_language")) {
        this.database.exec("ALTER TABLE channel_execution_proposals ADD COLUMN response_language TEXT;");
      }
      if (!hasResponseLanguageContextMigration) {
        this.recordMigration(RESPONSE_LANGUAGE_CONTEXT_MIGRATION_VERSION, RESPONSE_LANGUAGE_CONTEXT_MIGRATION_NAME);
      }
    }

    const hasProviderTransportMigration = this.hasMigration(PROVIDER_TRANSPORT_MIGRATION_VERSION);
    if (!hasProviderTransportMigration || !this.hasColumn("provider_presets", "provider_transport")) {
      if (this.hasTable("provider_presets") && !this.hasColumn("provider_presets", "provider_transport")) {
        this.database.exec("ALTER TABLE provider_presets ADD COLUMN provider_transport TEXT;");
      }
      if (!hasProviderTransportMigration) {
        this.recordMigration(PROVIDER_TRANSPORT_MIGRATION_VERSION, PROVIDER_TRANSPORT_MIGRATION_NAME);
      }
    }

    const hasRuntimeSupervisorMigration = this.hasMigration(RUNTIME_SUPERVISOR_MIGRATION_VERSION);
    if (
      !hasRuntimeSupervisorMigration ||
      !this.hasColumn("run_sessions", "work_unit_id") ||
      !this.hasTable("work_units") ||
      !this.hasTable("work_unit_attempts") ||
      !this.hasTable("runtime_events") ||
      !this.hasTable("runtime_heartbeats") ||
      !this.hasTable("runtime_semaphore_slots") ||
      !this.hasColumn("resource_leases", "last_renewed_at") ||
      !this.hasColumn("resource_leases", "release_reason") ||
      !this.hasColumn("resource_leases", "work_unit_id") ||
      !this.hasColumn("resource_leases", "attempt_id")
    ) {
      if (!this.hasColumn("run_sessions", "work_unit_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN work_unit_id TEXT;");
      }
      if (!this.hasColumn("resource_leases", "last_renewed_at")) {
        this.database.exec("ALTER TABLE resource_leases ADD COLUMN last_renewed_at TEXT;");
        this.database.exec("UPDATE resource_leases SET last_renewed_at = acquired_at WHERE last_renewed_at IS NULL;");
      }
      if (!this.hasColumn("resource_leases", "release_reason")) {
        this.database.exec("ALTER TABLE resource_leases ADD COLUMN release_reason TEXT;");
      }
      if (!this.hasColumn("resource_leases", "work_unit_id")) {
        this.database.exec("ALTER TABLE resource_leases ADD COLUMN work_unit_id TEXT;");
      }
      if (!this.hasColumn("resource_leases", "attempt_id")) {
        this.database.exec("ALTER TABLE resource_leases ADD COLUMN attempt_id TEXT;");
      }

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS work_units (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          channel_id TEXT,
          task_id TEXT,
          teammate_id TEXT,
          provider_preset_id TEXT,
          runner_id TEXT,
          requested_runner_id TEXT,
          effective_runner_id TEXT,
          runner_fallback_reason_json TEXT,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL,
          attempt_count INTEGER NOT NULL,
          active_attempt_id TEXT,
          created_by_client_id TEXT,
          created_by_actor TEXT NOT NULL,
          request_json TEXT NOT NULL,
          timeout_policy_json TEXT NOT NULL,
          linked_run_id TEXT,
          linked_message_id TEXT,
          linked_media_job_id TEXT,
          linked_external_work_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          last_event_at TEXT,
          last_heartbeat_at TEXT,
          error_code TEXT,
          error_message TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(linked_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_units_idempotency
        ON work_units(workspace_id, kind, owner_type, owner_id, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_work_units_status_priority
        ON work_units(workspace_id, status, priority, created_at);

        CREATE INDEX IF NOT EXISTS idx_work_units_owner
        ON work_units(workspace_id, owner_type, owner_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_work_units_linked_run
        ON work_units(linked_run_id);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_work_unit
        ON run_sessions(work_unit_id);

        CREATE TABLE IF NOT EXISTS work_unit_attempts (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          runtime_instance_id TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          requested_runner_id TEXT,
          effective_runner_id TEXT,
          runner_fallback_reason_json TEXT,
          provider_preset_id TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          last_event_at TEXT,
          last_heartbeat_at TEXT,
          abort_requested_at TEXT,
          error_code TEXT,
          error_message TEXT,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          UNIQUE(work_unit_id, attempt_number)
        );

        CREATE INDEX IF NOT EXISTS idx_work_unit_attempts_work_unit
        ON work_unit_attempts(work_unit_id, attempt_number);

        CREATE INDEX IF NOT EXISTS idx_work_unit_attempts_runtime
        ON work_unit_attempts(runtime_instance_id, status);

        CREATE TABLE IF NOT EXISTS runtime_events (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          attempt_id TEXT,
          seq INTEGER NOT NULL,
          ts TEXT NOT NULL,
          type TEXT NOT NULL,
          actor TEXT NOT NULL,
          data_json TEXT NOT NULL,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE SET NULL,
          UNIQUE(work_unit_id, seq)
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_events_work_unit_seq
        ON runtime_events(work_unit_id, seq);

        CREATE INDEX IF NOT EXISTS idx_runtime_events_type_ts
        ON runtime_events(type, ts);

        CREATE TABLE IF NOT EXISTS runtime_heartbeats (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          runtime_instance_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          source TEXT NOT NULL,
          detail_json TEXT,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_heartbeats_attempt_ts
        ON runtime_heartbeats(attempt_id, ts);

        CREATE INDEX IF NOT EXISTS idx_runtime_heartbeats_runtime_ts
        ON runtime_heartbeats(runtime_instance_id, ts);

        CREATE TABLE IF NOT EXISTS runtime_semaphore_slots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_key TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          work_unit_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          status TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          last_renewed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          released_at TEXT,
          release_reason TEXT,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_semaphore_active
        ON runtime_semaphore_slots(workspace_id, resource_type, resource_key, status, expires_at);

        CREATE INDEX IF NOT EXISTS idx_runtime_semaphore_owner
        ON runtime_semaphore_slots(owner_id, status);

        CREATE INDEX IF NOT EXISTS idx_runtime_semaphore_work_unit
        ON runtime_semaphore_slots(work_unit_id, status);

        CREATE INDEX IF NOT EXISTS idx_resource_leases_work_unit
        ON resource_leases(work_unit_id, attempt_id, status);
      `);

      if (!hasRuntimeSupervisorMigration) {
        this.recordMigration(RUNTIME_SUPERVISOR_MIGRATION_VERSION, RUNTIME_SUPERVISOR_MIGRATION_NAME);
      }
    }

    const hasMcpToolManagementMigration = this.hasMigration(MCP_TOOL_MANAGEMENT_MIGRATION_VERSION);
    if (
      !hasMcpToolManagementMigration ||
      !this.hasTable("mcp_servers") ||
      !this.hasTable("mcp_server_secrets") ||
      !this.hasTable("mcp_tools") ||
      !this.hasTable("teammate_mcp_bindings")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          transport_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          required INTEGER NOT NULL,
          status_json TEXT NOT NULL,
          startup_timeout_sec INTEGER,
          tool_timeout_sec INTEGER,
          enabled_tools_json TEXT,
          disabled_tools_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_mcp_servers_workspace
        ON mcp_servers(workspace_id, enabled, created_at);

        CREATE TABLE IF NOT EXISTS mcp_server_secrets (
          server_id TEXT NOT NULL,
          secret_name TEXT NOT NULL,
          secret_value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(server_id, secret_name),
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS mcp_tools (
          server_id TEXT NOT NULL,
          raw_name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          description TEXT,
          input_schema_json TEXT NOT NULL,
          callable_namespace TEXT NOT NULL,
          callable_name TEXT NOT NULL,
          side_effect_level TEXT NOT NULL,
          default_approval TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(server_id, raw_name),
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_mcp_tools_server_enabled
        ON mcp_tools(server_id, enabled, raw_name);

        CREATE TABLE IF NOT EXISTS teammate_mcp_bindings (
          teammate_id TEXT NOT NULL,
          server_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          selected_tool_names_json TEXT NOT NULL,
          approval_overrides_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(teammate_id, server_id),
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_mcp_bindings_server
        ON teammate_mcp_bindings(server_id, enabled);
      `);

      if (!hasMcpToolManagementMigration) {
        this.recordMigration(MCP_TOOL_MANAGEMENT_MIGRATION_VERSION, MCP_TOOL_MANAGEMENT_MIGRATION_NAME);
      }
    }

    const hasLingMemoryMigration = this.hasMigration(LING_MEMORY_MIGRATION_VERSION);
    if (!hasLingMemoryMigration || !this.hasTable("memory_objects") || !this.hasTable("memory_used_events")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS memory_objects (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          scope_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          review_state TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          sensitivity TEXT NOT NULL,
          verify_before_use INTEGER NOT NULL DEFAULT 0,
          retrieval_provider_id TEXT,
          retrieval_handle TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_objects_scope
        ON memory_objects(workspace_id, scope_type, owner_id, review_state, enabled);

        CREATE INDEX IF NOT EXISTS idx_memory_objects_updated
        ON memory_objects(workspace_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_memory_objects_last_used
        ON memory_objects(workspace_id, last_used_at);

        CREATE TABLE IF NOT EXISTS memory_used_events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          memory_ids_json TEXT NOT NULL,
          intent TEXT NOT NULL,
          recall_query TEXT NOT NULL,
          teammate_id TEXT,
          channel_id TEXT,
          task_id TEXT,
          run_id TEXT,
          response_id TEXT,
          policy_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_used_events_run
        ON memory_used_events(workspace_id, run_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_memory_used_events_response
        ON memory_used_events(workspace_id, response_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_memory_used_events_teammate_channel
        ON memory_used_events(workspace_id, teammate_id, channel_id, created_at);
      `);

      if (!hasLingMemoryMigration) {
        this.recordMigration(LING_MEMORY_MIGRATION_VERSION, LING_MEMORY_MIGRATION_NAME);
      }
    }

    const hasMemoryReviewPolicyMigration = this.hasMigration(MEMORY_REVIEW_POLICY_MIGRATION_VERSION);
    if (
      !hasMemoryReviewPolicyMigration ||
      !this.hasTable("memory_review_policy") ||
      !this.hasTable("memory_review_decisions") ||
      !this.hasTable("memory_review_actions") ||
      !this.hasColumn("memory_review_actions", "source_refs_json")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS memory_review_policy (
          workspace_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          auto_active_same_scope INTEGER NOT NULL,
          auto_active_user_explicit INTEGER NOT NULL,
          require_manual_for_workspace INTEGER NOT NULL,
          require_manual_for_persona INTEGER NOT NULL,
          require_manual_for_cross_scope INTEGER NOT NULL,
          quarantine_secret_adjacent INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS memory_review_decisions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          outcome TEXT NOT NULL,
          mode TEXT NOT NULL,
          reason_code TEXT NOT NULL,
          reason TEXT NOT NULL,
          confidence TEXT NOT NULL,
          requires_manual_review INTEGER NOT NULL,
          quarantine_reason TEXT,
          target_review_state TEXT NOT NULL,
          target_sensitivity TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          decided_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(memory_id) REFERENCES memory_objects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_review_decisions_memory
        ON memory_review_decisions(memory_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_memory_review_decisions_workspace_outcome
        ON memory_review_decisions(workspace_id, outcome, created_at);

        CREATE TABLE IF NOT EXISTS memory_review_actions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          action TEXT NOT NULL,
          previous_review_state TEXT NOT NULL,
          next_review_state TEXT NOT NULL,
          source_refs_json TEXT NOT NULL DEFAULT '[]',
          edited_memory_json TEXT,
          reason TEXT,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(memory_id) REFERENCES memory_objects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_review_actions_memory
        ON memory_review_actions(memory_id, created_at);
      `);
      if (this.hasTable("memory_review_actions") && !this.hasColumn("memory_review_actions", "source_refs_json")) {
        this.database.exec("ALTER TABLE memory_review_actions ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]';");
      }

      if (!hasMemoryReviewPolicyMigration) {
        this.recordMigration(MEMORY_REVIEW_POLICY_MIGRATION_VERSION, MEMORY_REVIEW_POLICY_MIGRATION_NAME);
      }
    }

    const hasMemoryConsolidationJobsMigration = this.hasMigration(MEMORY_CONSOLIDATION_JOBS_MIGRATION_VERSION);
    if (!hasMemoryConsolidationJobsMigration || !this.hasTable("memory_consolidation_jobs")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS memory_consolidation_jobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_candidate_ids_json TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_consolidation_jobs_workspace
        ON memory_consolidation_jobs(workspace_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_memory_consolidation_jobs_kind
        ON memory_consolidation_jobs(workspace_id, kind, updated_at);
      `);

      if (!hasMemoryConsolidationJobsMigration) {
        this.recordMigration(MEMORY_CONSOLIDATION_JOBS_MIGRATION_VERSION, MEMORY_CONSOLIDATION_JOBS_MIGRATION_NAME);
      }
    }

    const hasMemoryHealthMigration = this.hasMigration(MEMORY_HEALTH_MIGRATION_VERSION);
    if (
      !hasMemoryHealthMigration ||
      !this.hasColumn("memory_objects", "verify_before_use") ||
      !this.hasTable("memory_self_improving_metadata")
    ) {
      if (this.hasTable("memory_objects") && !this.hasColumn("memory_objects", "verify_before_use")) {
        this.database.exec("ALTER TABLE memory_objects ADD COLUMN verify_before_use INTEGER NOT NULL DEFAULT 0;");
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS memory_self_improving_metadata (
          memory_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          trigger TEXT NOT NULL,
          lesson TEXT NOT NULL,
          use_when_json TEXT NOT NULL,
          do_not_use_when_json TEXT NOT NULL,
          valid_until TEXT,
          last_seen_at TEXT,
          evidence_count INTEGER NOT NULL,
          superseded_by TEXT,
          last_used_at TEXT,
          use_count INTEGER NOT NULL,
          FOREIGN KEY(memory_id) REFERENCES memory_objects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_self_improving_metadata_kind
        ON memory_self_improving_metadata(kind);

        CREATE INDEX IF NOT EXISTS idx_memory_self_improving_metadata_superseded
        ON memory_self_improving_metadata(superseded_by);
      `);

      if (!hasMemoryHealthMigration) {
        this.recordMigration(MEMORY_HEALTH_MIGRATION_VERSION, MEMORY_HEALTH_MIGRATION_NAME);
      }
    }

    const hasManagedPluginsMigration = this.hasMigration(MANAGED_PLUGINS_MIGRATION_VERSION);
    if (
      !hasManagedPluginsMigration ||
      !this.hasTable("managed_plugins") ||
      !this.hasTable("managed_plugin_contributions") ||
      !this.hasTable("managed_plugin_health_snapshots") ||
      !this.hasTable("managed_plugin_events")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS managed_plugins (
          id TEXT PRIMARY KEY,
          source_kind TEXT NOT NULL,
          version TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          disabled_reason TEXT,
          descriptor_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS managed_plugin_contributions (
          plugin_id TEXT NOT NULL,
          contribution_kind TEXT NOT NULL,
          contribution_id TEXT NOT NULL,
          linked_resource_id TEXT,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(plugin_id, contribution_kind, contribution_id),
          FOREIGN KEY(plugin_id) REFERENCES managed_plugins(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_contributions_linked
        ON managed_plugin_contributions(linked_resource_id);

        CREATE TABLE IF NOT EXISTS managed_plugin_health_snapshots (
          plugin_id TEXT PRIMARY KEY,
          status_json TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(plugin_id) REFERENCES managed_plugins(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_health_expires
        ON managed_plugin_health_snapshots(expires_at);

        CREATE TABLE IF NOT EXISTS managed_plugin_events (
          id TEXT PRIMARY KEY,
          plugin_id TEXT NOT NULL,
          type TEXT NOT NULL,
          actor TEXT NOT NULL,
          message TEXT,
          data_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(plugin_id) REFERENCES managed_plugins(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_events_plugin_created
        ON managed_plugin_events(plugin_id, created_at);
      `);

      if (!hasManagedPluginsMigration) {
        this.recordMigration(MANAGED_PLUGINS_MIGRATION_VERSION, MANAGED_PLUGINS_MIGRATION_NAME);
      }
    }

    const hasManagedPluginPackagesMigration = this.hasMigration(MANAGED_PLUGIN_PACKAGES_MIGRATION_VERSION);
    if (
      !hasManagedPluginPackagesMigration ||
      !this.hasTable("managed_plugin_packages") ||
      !this.hasTable("managed_plugin_runtime_snapshots")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS managed_plugin_packages (
          plugin_id TEXT PRIMARY KEY,
          source_kind TEXT NOT NULL,
          version TEXT NOT NULL,
          status TEXT NOT NULL,
          cache_ref TEXT NOT NULL,
          package_hash TEXT,
          manifest_json TEXT NOT NULL,
          installed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          uninstalled_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_packages_status
        ON managed_plugin_packages(status);

        CREATE TABLE IF NOT EXISTS managed_plugin_runtime_snapshots (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          cwd TEXT NOT NULL,
          plugin_ids_json TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          policy_overlays_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_runtime_snapshots_run
        ON managed_plugin_runtime_snapshots(run_id);

        CREATE INDEX IF NOT EXISTS idx_managed_plugin_runtime_snapshots_created
        ON managed_plugin_runtime_snapshots(created_at);
      `);

      if (!hasManagedPluginPackagesMigration) {
        this.recordMigration(MANAGED_PLUGIN_PACKAGES_MIGRATION_VERSION, MANAGED_PLUGIN_PACKAGES_MIGRATION_NAME);
      }
    }

    const hasSkillAwareRunMigration = this.hasMigration(SKILL_AWARE_RUN_MIGRATION_VERSION);
    if (
      !hasSkillAwareRunMigration ||
      !this.hasColumn("tasks", "requested_skill_id") ||
      !this.hasColumn("run_sessions", "selected_skill_id")
    ) {
      if (!this.hasColumn("tasks", "requested_skill_id")) {
        this.database.exec("ALTER TABLE tasks ADD COLUMN requested_skill_id TEXT;");
      }
      if (!this.hasColumn("run_sessions", "selected_skill_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN selected_skill_id TEXT;");
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_requested_skill
        ON tasks(requested_skill_id);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_selected_skill
        ON run_sessions(selected_skill_id);
      `);
      if (!hasSkillAwareRunMigration) {
        this.recordMigration(SKILL_AWARE_RUN_MIGRATION_VERSION, SKILL_AWARE_RUN_MIGRATION_NAME);
      }
    }

    const hasPrivateWorkspaceDataLifecycleMigration = this.hasMigration(PRIVATE_WORKSPACE_DATA_LIFECYCLE_MIGRATION_VERSION);
    if (
      !hasPrivateWorkspaceDataLifecycleMigration ||
      !this.hasColumn("teammate_direct_messages", "attachment_ids_json") ||
      !this.hasTable("teammate_private_attachments") ||
      !this.hasTable("retention_tombstones")
    ) {
      if (!this.hasColumn("teammate_direct_messages", "attachment_ids_json")) {
        this.database.exec("ALTER TABLE teammate_direct_messages ADD COLUMN attachment_ids_json TEXT NOT NULL DEFAULT '[]';");
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS teammate_private_attachments (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          thread_id TEXT,
          message_id TEXT,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL,
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES teammate_direct_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(message_id) REFERENCES teammate_direct_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_private_attachments_owner
        ON teammate_private_attachments(teammate_id, scope, created_at);

        CREATE INDEX IF NOT EXISTS idx_teammate_private_attachments_thread
        ON teammate_private_attachments(thread_id, created_at);

        CREATE TABLE IF NOT EXISTS retention_tombstones (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          reason TEXT,
          deleted_counts_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_retention_tombstones_entity
        ON retention_tombstones(workspace_id, entity_type, entity_id, created_at);
      `);
      if (!hasPrivateWorkspaceDataLifecycleMigration) {
        this.recordMigration(PRIVATE_WORKSPACE_DATA_LIFECYCLE_MIGRATION_VERSION, PRIVATE_WORKSPACE_DATA_LIFECYCLE_MIGRATION_NAME);
      }
    }

    const hasSkillRegistryMigration = this.hasMigration(SKILL_REGISTRY_MIGRATION_VERSION);
    if (
      !hasSkillRegistryMigration ||
      !this.hasTable("skill_packs") ||
      !this.hasTable("skill_definitions") ||
      !this.hasTable("skill_import_drafts")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS skill_packs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source TEXT NOT NULL,
          name TEXT NOT NULL,
          version TEXT,
          description TEXT NOT NULL,
          source_path TEXT,
          checksum TEXT,
          review_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_skill_packs_workspace_status
        ON skill_packs(workspace_id, review_status, updated_at);

        CREATE TABLE IF NOT EXISTS skill_definitions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          pack_id TEXT NOT NULL,
          source TEXT NOT NULL,
          source_path TEXT,
          version TEXT,
          checksum TEXT,
          definition_json TEXT NOT NULL,
          visibility_json TEXT NOT NULL,
          review_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(pack_id) REFERENCES skill_packs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_skill_definitions_workspace_status
        ON skill_definitions(workspace_id, review_status, source, id);

        CREATE TABLE IF NOT EXISTS skill_import_drafts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source TEXT NOT NULL,
          source_path TEXT,
          draft_json TEXT NOT NULL,
          warnings_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_skill_import_drafts_workspace_updated
        ON skill_import_drafts(workspace_id, updated_at);
      `);
      if (!hasSkillRegistryMigration) {
        this.recordMigration(SKILL_REGISTRY_MIGRATION_VERSION, SKILL_REGISTRY_MIGRATION_NAME);
      }
    }

    const hasRunInterventionsMigration = this.hasMigration(RUN_INTERVENTIONS_MIGRATION_VERSION);
    if (
      !hasRunInterventionsMigration ||
      !this.hasTable("run_interventions") ||
      !this.hasColumn("run_sessions", "parent_run_id") ||
      !this.hasColumn("run_sessions", "intervention_id") ||
      !this.hasColumn("run_sessions", "continuation_reason")
    ) {
      if (!this.hasColumn("run_sessions", "parent_run_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN parent_run_id TEXT;");
      }
      if (!this.hasColumn("run_sessions", "intervention_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN intervention_id TEXT;");
      }
      if (!this.hasColumn("run_sessions", "continuation_reason")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN continuation_reason TEXT;");
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS run_interventions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source_run_id TEXT NOT NULL,
          source_work_unit_id TEXT,
          source_attempt_id TEXT,
          continuation_run_id TEXT,
          continuation_work_unit_id TEXT,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          instruction TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          failure_reason TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(source_run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(continuation_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_run_interventions_idempotency
        ON run_interventions(source_run_id, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_run_interventions_source_status
        ON run_interventions(source_run_id, status, created_at);

        CREATE INDEX IF NOT EXISTS idx_run_interventions_continuation
        ON run_interventions(continuation_run_id);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_parent_run
        ON run_sessions(parent_run_id);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_intervention
        ON run_sessions(intervention_id);
      `);
      if (!hasRunInterventionsMigration) {
        this.recordMigration(RUN_INTERVENTIONS_MIGRATION_VERSION, RUN_INTERVENTIONS_MIGRATION_NAME);
      }
    }

    const hasRunnerAuditMigration = this.hasMigration(RUNNER_AUDIT_MIGRATION_VERSION);
    if (
      !hasRunnerAuditMigration ||
      !this.hasColumn("ai_teammates", "runner_id") ||
      !this.hasColumn("work_units", "requested_runner_id") ||
      !this.hasColumn("work_units", "effective_runner_id") ||
      !this.hasColumn("work_units", "runner_fallback_reason_json") ||
      !this.hasColumn("work_unit_attempts", "requested_runner_id") ||
      !this.hasColumn("work_unit_attempts", "effective_runner_id") ||
      !this.hasColumn("work_unit_attempts", "runner_fallback_reason_json")
    ) {
      if (!this.hasColumn("ai_teammates", "runner_id")) {
        this.database.exec("ALTER TABLE ai_teammates ADD COLUMN runner_id TEXT;");
      }
      if (!this.hasColumn("work_units", "requested_runner_id")) {
        this.database.exec("ALTER TABLE work_units ADD COLUMN requested_runner_id TEXT;");
      }
      if (!this.hasColumn("work_units", "effective_runner_id")) {
        this.database.exec("ALTER TABLE work_units ADD COLUMN effective_runner_id TEXT;");
      }
      if (!this.hasColumn("work_units", "runner_fallback_reason_json")) {
        this.database.exec("ALTER TABLE work_units ADD COLUMN runner_fallback_reason_json TEXT;");
      }
      if (!this.hasColumn("work_unit_attempts", "requested_runner_id")) {
        this.database.exec("ALTER TABLE work_unit_attempts ADD COLUMN requested_runner_id TEXT;");
      }
      if (!this.hasColumn("work_unit_attempts", "effective_runner_id")) {
        this.database.exec("ALTER TABLE work_unit_attempts ADD COLUMN effective_runner_id TEXT;");
      }
      if (!this.hasColumn("work_unit_attempts", "runner_fallback_reason_json")) {
        this.database.exec("ALTER TABLE work_unit_attempts ADD COLUMN runner_fallback_reason_json TEXT;");
      }
      if (!hasRunnerAuditMigration) {
        this.recordMigration(RUNNER_AUDIT_MIGRATION_VERSION, RUNNER_AUDIT_MIGRATION_NAME);
      }
    }

    const hasChannelWorkflowStepMetadataMigration = this.hasMigration(CHANNEL_WORKFLOW_STEP_METADATA_MIGRATION_VERSION);
    if (!hasChannelWorkflowStepMetadataMigration || !this.hasColumn("channel_workflow_steps", "metadata_json")) {
      if (!this.hasColumn("channel_workflow_steps", "metadata_json")) {
        this.database.exec("ALTER TABLE channel_workflow_steps ADD COLUMN metadata_json TEXT;");
      }
      if (!hasChannelWorkflowStepMetadataMigration) {
        this.recordMigration(CHANNEL_WORKFLOW_STEP_METADATA_MIGRATION_VERSION, CHANNEL_WORKFLOW_STEP_METADATA_MIGRATION_NAME);
      }
    }

    const hasLingThreadsMigration = this.hasMigration(LING_THREADS_MIGRATION_VERSION);
    if (!hasLingThreadsMigration || !this.hasTable("ling_threads") || !this.hasColumn("run_sessions", "thread_id")) {
      if (!this.hasColumn("run_sessions", "thread_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN thread_id TEXT;");
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS ling_threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          channel_id TEXT,
          task_id TEXT,
          teammate_id TEXT,
          workflow_id TEXT,
          workflow_step_id TEXT,
          external_work_id TEXT,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          active_run_id TEXT,
          last_run_id TEXT,
          parent_thread_id TEXT,
          parent_turn_id TEXT,
          forked_from_run_id TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          pinned_at TEXT,
          archived_at TEXT,
          archived_reason TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(active_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
          FOREIGN KEY(last_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
          FOREIGN KEY(parent_thread_id) REFERENCES ling_threads(id) ON DELETE SET NULL,
          FOREIGN KEY(parent_turn_id) REFERENCES ling_turns(id) ON DELETE SET NULL,
          FOREIGN KEY(forked_from_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ling_threads_owner
        ON ling_threads(workspace_id, kind, task_id, workflow_step_id, external_work_id, teammate_id, channel_id);

        CREATE INDEX IF NOT EXISTS idx_ling_threads_status_updated
        ON ling_threads(workspace_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_ling_threads_visible_channel
        ON ling_threads(channel_id, archived_at, pinned_at, updated_at);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_thread
        ON run_sessions(thread_id);
      `);
      if (!hasLingThreadsMigration) {
        this.recordMigration(LING_THREADS_MIGRATION_VERSION, LING_THREADS_MIGRATION_NAME);
      }
    }

    const hasApprovalWorkflowStepOwnerMigration = this.hasMigration(APPROVAL_WORKFLOW_STEP_OWNER_MIGRATION_VERSION);
    if (!hasApprovalWorkflowStepOwnerMigration || !this.hasColumn("approval_requests", "workflow_step_id")) {
      this.database.exec(`
        DROP TABLE IF EXISTS approval_requests_next;

        CREATE TABLE approval_requests_next (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          task_id TEXT,
          media_job_id TEXT,
          external_work_action_id TEXT,
          workflow_step_id TEXT,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT,
          CHECK (
            (run_id IS NOT NULL AND task_id IS NOT NULL AND media_job_id IS NULL AND external_work_action_id IS NULL AND workflow_step_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NOT NULL AND external_work_action_id IS NULL AND workflow_step_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NOT NULL AND workflow_step_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NULL AND workflow_step_id IS NOT NULL)
          ),
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
          FOREIGN KEY(external_work_action_id) REFERENCES external_work_actions(id) ON DELETE CASCADE,
          FOREIGN KEY(workflow_step_id) REFERENCES channel_workflow_steps(id) ON DELETE CASCADE
        );

        INSERT INTO approval_requests_next (
          id,
          run_id,
          task_id,
          media_job_id,
          external_work_action_id,
          workflow_step_id,
          channel_id,
          tool_call_id,
          action_type,
          risk,
          title,
          description,
          payload_json,
          status,
          created_at,
          expires_at,
          resolved_at,
          resolved_by,
          decision_reason
        )
        SELECT
          id,
          run_id,
          task_id,
          media_job_id,
          external_work_action_id,
          NULL,
          channel_id,
          tool_call_id,
          action_type,
          risk,
          title,
          description,
          payload_json,
          status,
          created_at,
          expires_at,
          resolved_at,
          resolved_by,
          decision_reason
        FROM approval_requests;

        DROP TABLE approval_requests;
        ALTER TABLE approval_requests_next RENAME TO approval_requests;

        CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_media_job ON approval_requests(media_job_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_external_work_action ON approval_requests(external_work_action_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_workflow_step ON approval_requests(workflow_step_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
      `);
      if (!hasApprovalWorkflowStepOwnerMigration) {
        this.recordMigration(APPROVAL_WORKFLOW_STEP_OWNER_MIGRATION_VERSION, APPROVAL_WORKFLOW_STEP_OWNER_MIGRATION_NAME);
      }
    }

    const hasRunWorkflowStepOwnerMigration = this.hasMigration(RUN_WORKFLOW_STEP_OWNER_MIGRATION_VERSION);
    if (!hasRunWorkflowStepOwnerMigration || !this.hasColumn("run_sessions", "workflow_step_id")) {
      if (!this.hasColumn("run_sessions", "workflow_step_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN workflow_step_id TEXT;");
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_run_sessions_workflow_step
        ON run_sessions(workflow_step_id);
      `);
      if (!hasRunWorkflowStepOwnerMigration) {
        this.recordMigration(RUN_WORKFLOW_STEP_OWNER_MIGRATION_VERSION, RUN_WORKFLOW_STEP_OWNER_MIGRATION_NAME);
      }
    }

    const hasMcpStatusSnapshotsMigration = this.hasMigration(MCP_STATUS_SNAPSHOTS_MIGRATION_VERSION);
    if (!hasMcpStatusSnapshotsMigration || !this.hasTable("mcp_status_snapshots")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS mcp_status_snapshots (
          server_id TEXT PRIMARY KEY,
          status_json TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_mcp_status_snapshots_expires
        ON mcp_status_snapshots(expires_at);
      `);
      if (!hasMcpStatusSnapshotsMigration) {
        this.recordMigration(MCP_STATUS_SNAPSHOTS_MIGRATION_VERSION, MCP_STATUS_SNAPSHOTS_MIGRATION_NAME);
      }
    }

    const hasAutomationsMigration = this.hasMigration(AUTOMATIONS_MIGRATION_VERSION);
    if (!hasAutomationsMigration || !this.hasTable("automation_definitions") || !this.hasTable("automation_runs")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS automation_definitions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT,
          thread_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          trigger_json TEXT NOT NULL,
          target_json TEXT NOT NULL,
          prompt_template_json TEXT NOT NULL,
          execution_policy_json TEXT NOT NULL,
          output_policy_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_run_id TEXT,
          next_run_at TEXT,
          last_error_message TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS automation_runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          channel_id TEXT,
          thread_id TEXT NOT NULL,
          run_id TEXT,
          trigger_type TEXT NOT NULL,
          scheduled_for TEXT,
          fired_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          status TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          context_preview_artifact_id TEXT,
          output_artifact_ids_json TEXT NOT NULL,
          skip_reason TEXT,
          error_message TEXT,
          FOREIGN KEY(automation_id) REFERENCES automation_definitions(id) ON DELETE CASCADE,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_automation_definitions_status
        ON automation_definitions(status);

        CREATE INDEX IF NOT EXISTS idx_automation_definitions_kind
        ON automation_definitions(kind);

        CREATE INDEX IF NOT EXISTS idx_automation_definitions_channel
        ON automation_definitions(channel_id);

        CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
        ON automation_runs(automation_id, fired_at);

        CREATE INDEX IF NOT EXISTS idx_automation_runs_run
        ON automation_runs(run_id);

        CREATE INDEX IF NOT EXISTS idx_automation_runs_status
        ON automation_runs(status);
      `);
      if (!hasAutomationsMigration) {
        this.recordMigration(AUTOMATIONS_MIGRATION_VERSION, AUTOMATIONS_MIGRATION_NAME);
      }
    }

    const hasAutomationDraftsMigration = this.hasMigration(AUTOMATION_DRAFTS_MIGRATION_VERSION);
    if (!hasAutomationDraftsMigration || !this.hasTable("automation_drafts")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS automation_drafts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          draft_json TEXT NOT NULL,
          missing_fields_json TEXT NOT NULL,
          warnings_json TEXT NOT NULL,
          proposed_by_run_id TEXT,
          proposed_by_thread_id TEXT,
          confirmed_automation_id TEXT,
          discarded_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(confirmed_automation_id) REFERENCES automation_definitions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_automation_drafts_status
        ON automation_drafts(workspace_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_automation_drafts_confirmed_automation
        ON automation_drafts(confirmed_automation_id);
      `);
      if (!hasAutomationDraftsMigration) {
        this.recordMigration(AUTOMATION_DRAFTS_MIGRATION_VERSION, AUTOMATION_DRAFTS_MIGRATION_NAME);
      }
    }

    const hasControlPlaneEventsMigration = this.hasMigration(CONTROL_PLANE_EVENTS_MIGRATION_VERSION);
    if (!hasControlPlaneEventsMigration || !this.hasTable("control_plane_events")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS control_plane_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          ts TEXT NOT NULL,
          domain TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          data_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS control_plane_events_workspace_seq
        ON control_plane_events(workspace_id, seq);

        CREATE INDEX IF NOT EXISTS control_plane_events_workspace_domain_seq
        ON control_plane_events(workspace_id, domain, seq);
      `);
      if (!hasControlPlaneEventsMigration) {
        this.recordMigration(CONTROL_PLANE_EVENTS_MIGRATION_VERSION, CONTROL_PLANE_EVENTS_MIGRATION_NAME);
      }
    }

    const hasWorkItemsMigration = this.hasMigration(WORK_ITEMS_MIGRATION_VERSION);
    if (!hasWorkItemsMigration || !this.hasTable("work_items") || !this.hasTable("work_item_dependencies")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS work_items (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          waiting_reason TEXT,
          priority TEXT NOT NULL,
          labels_json TEXT NOT NULL,
          assignee_teammate_id TEXT,
          task_id TEXT,
          run_id TEXT,
          workflow_id TEXT,
          workflow_step_id TEXT,
          external_work_id TEXT,
          external_work_action_id TEXT,
          approval_id TEXT,
          artifact_ids_json TEXT NOT NULL,
          proof_artifact_ids_json TEXT NOT NULL,
          claim_owner_id TEXT,
          claim_token TEXT,
          claimed_at TEXT,
          heartbeat_at TEXT,
          claim_expires_at TEXT,
          attempt_count INTEGER NOT NULL,
          retry_budget INTEGER NOT NULL,
          completed_at TEXT,
          failed_at TEXT,
          failure_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(workspace_id, source_type, source_id)
        );

        CREATE TABLE IF NOT EXISTS work_item_dependencies (
          work_item_id TEXT NOT NULL,
          depends_on_work_item_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(work_item_id, depends_on_work_item_id),
          FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
          FOREIGN KEY(depends_on_work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_work_items_channel_status
        ON work_items(workspace_id, channel_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_work_items_source
        ON work_items(workspace_id, source_type, source_id);

        CREATE INDEX IF NOT EXISTS idx_work_items_assignee
        ON work_items(workspace_id, assignee_teammate_id, status);

        CREATE INDEX IF NOT EXISTS idx_work_items_claim
        ON work_items(workspace_id, claim_expires_at);
      `);
      if (!hasWorkItemsMigration) {
        this.recordMigration(WORK_ITEMS_MIGRATION_VERSION, WORK_ITEMS_MIGRATION_NAME);
      }
    }

    const hasLingTurnsMigration = this.hasMigration(LING_TURNS_MIGRATION_VERSION);
    if (!hasLingTurnsMigration || !this.hasTable("ling_turns") || !this.hasTable("ling_turn_runs")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS ling_turns (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          user_instruction TEXT NOT NULL,
          channel_id TEXT,
          task_id TEXT,
          teammate_id TEXT,
          workflow_step_id TEXT,
          external_work_id TEXT,
          automation_id TEXT,
          source_message_id TEXT,
          source_turn_id TEXT,
          intervention_id TEXT,
          active_run_id TEXT,
          last_run_id TEXT,
          created_by_actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(source_turn_id) REFERENCES ling_turns(id) ON DELETE SET NULL,
          FOREIGN KEY(active_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
          FOREIGN KEY(last_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ling_turns_thread_updated
        ON ling_turns(thread_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_ling_turns_workspace_status
        ON ling_turns(workspace_id, status, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_ling_turns_source
        ON ling_turns(source_turn_id);

        CREATE TABLE IF NOT EXISTS ling_turn_runs (
          turn_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(turn_id, run_id),
          UNIQUE(run_id),
          UNIQUE(turn_id, attempt_number),
          FOREIGN KEY(turn_id) REFERENCES ling_turns(id) ON DELETE CASCADE,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ling_turn_runs_run
        ON ling_turn_runs(run_id);
      `);
      if (!hasLingTurnsMigration) {
        this.recordMigration(LING_TURNS_MIGRATION_VERSION, LING_TURNS_MIGRATION_NAME);
      }
    }

    const hasLingThreadMetadataMigration = this.hasMigration(LING_THREAD_METADATA_MIGRATION_VERSION);
    if (!hasLingThreadMetadataMigration || !this.hasColumn("ling_threads", "metadata_json")) {
      if (!this.hasColumn("ling_threads", "metadata_json")) {
        this.database.exec("ALTER TABLE ling_threads ADD COLUMN metadata_json TEXT;");
      }
      if (!hasLingThreadMetadataMigration) {
        this.recordMigration(LING_THREAD_METADATA_MIGRATION_VERSION, LING_THREAD_METADATA_MIGRATION_NAME);
      }
    }

    const hasLingThreadForkLineageMigration = this.hasMigration(LING_THREAD_FORK_LINEAGE_MIGRATION_VERSION);
    if (
      !hasLingThreadForkLineageMigration ||
      !this.hasColumn("ling_threads", "parent_thread_id") ||
      !this.hasColumn("ling_threads", "parent_turn_id") ||
      !this.hasColumn("ling_threads", "forked_from_run_id")
    ) {
      if (!this.hasColumn("ling_threads", "parent_thread_id")) {
        this.database.exec("ALTER TABLE ling_threads ADD COLUMN parent_thread_id TEXT;");
      }
      if (!this.hasColumn("ling_threads", "parent_turn_id")) {
        this.database.exec("ALTER TABLE ling_threads ADD COLUMN parent_turn_id TEXT;");
      }
      if (!this.hasColumn("ling_threads", "forked_from_run_id")) {
        this.database.exec("ALTER TABLE ling_threads ADD COLUMN forked_from_run_id TEXT;");
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_ling_threads_parent
        ON ling_threads(parent_thread_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_ling_threads_parent_turn
        ON ling_threads(parent_turn_id);
      `);
      if (!hasLingThreadForkLineageMigration) {
        this.recordMigration(LING_THREAD_FORK_LINEAGE_MIGRATION_VERSION, LING_THREAD_FORK_LINEAGE_MIGRATION_NAME);
      }
    }

    const hasLingThreadVisibilityMigration = this.hasMigration(LING_THREAD_VISIBILITY_MIGRATION_VERSION);
    if (
      !hasLingThreadVisibilityMigration ||
      !this.hasColumn("ling_threads", "pinned_at") ||
      !this.hasColumn("ling_threads", "archived_at") ||
      !this.hasColumn("ling_threads", "archived_reason")
    ) {
      if (!this.hasColumn("ling_threads", "pinned_at")) {
        this.database.exec("ALTER TABLE ling_threads ADD COLUMN pinned_at TEXT;");
      }
      if (!this.hasColumn("ling_threads", "archived_at")) {
        this.database.exec("ALTER TABLE ling_threads ADD COLUMN archived_at TEXT;");
      }
      if (!this.hasColumn("ling_threads", "archived_reason")) {
        this.database.exec("ALTER TABLE ling_threads ADD COLUMN archived_reason TEXT;");
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_ling_threads_visible_channel
        ON ling_threads(channel_id, archived_at, pinned_at, updated_at);

        CREATE INDEX IF NOT EXISTS idx_ling_threads_archived
        ON ling_threads(channel_id, archived_at, updated_at);

        CREATE INDEX IF NOT EXISTS idx_ling_threads_pinned
        ON ling_threads(parent_thread_id, pinned_at, updated_at);
      `);
      if (!hasLingThreadVisibilityMigration) {
        this.recordMigration(LING_THREAD_VISIBILITY_MIGRATION_VERSION, LING_THREAD_VISIBILITY_MIGRATION_NAME);
      }
    }

    const hasChannelWorkflowMetadataMigration = this.hasMigration(CHANNEL_WORKFLOW_METADATA_MIGRATION_VERSION);
    if (!hasChannelWorkflowMetadataMigration || !this.hasColumn("channel_workflows", "metadata_json")) {
      if (!this.hasColumn("channel_workflows", "metadata_json")) {
        this.database.exec("ALTER TABLE channel_workflows ADD COLUMN metadata_json TEXT;");
      }
      if (!hasChannelWorkflowMetadataMigration) {
        this.recordMigration(CHANNEL_WORKFLOW_METADATA_MIGRATION_VERSION, CHANNEL_WORKFLOW_METADATA_MIGRATION_NAME);
      }
    }

    const hasWorkflowCoordinationRecordsMigration = this.hasMigration(WORKFLOW_COORDINATION_RECORDS_MIGRATION_VERSION);
    if (
      !hasWorkflowCoordinationRecordsMigration ||
      !this.hasTable("workflow_handoff_intents") ||
      !this.hasTable("workflow_selector_decisions")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workflow_handoff_intents (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          workflow_id TEXT,
          source_workflow_step_id TEXT,
          source_run_id TEXT,
          source_message_id TEXT,
          channel_handoff_id TEXT,
          from_participant_id TEXT NOT NULL,
          from_participant_label TEXT NOT NULL,
          to_participant_id TEXT NOT NULL,
          to_participant_label TEXT,
          reason TEXT NOT NULL,
          required_input TEXT NOT NULL,
          expected_output TEXT NOT NULL,
          risk_summary TEXT,
          source_refs_json TEXT NOT NULL,
          status TEXT NOT NULL,
          validation_json TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_handoff_intents_workflow
        ON workflow_handoff_intents(workflow_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_workflow_handoff_intents_step
        ON workflow_handoff_intents(source_workflow_step_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_workflow_handoff_intents_channel
        ON workflow_handoff_intents(channel_id, status, updated_at);

        CREATE TABLE IF NOT EXISTS workflow_selector_decisions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          source_workflow_step_id TEXT,
          selector_node_id TEXT,
          target_kind TEXT NOT NULL,
          selected_workflow_step_id TEXT,
          selected_graph_node_id TEXT,
          selected_teammate_id TEXT,
          selected_skill_id TEXT,
          selected_handoff_intent_id TEXT,
          reason TEXT NOT NULL,
          alternatives_json TEXT NOT NULL,
          confidence TEXT NOT NULL,
          requires_user_confirmation INTEGER NOT NULL,
          status TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_selector_decisions_workflow
        ON workflow_selector_decisions(workflow_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_workflow_selector_decisions_step
        ON workflow_selector_decisions(source_workflow_step_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_workflow_selector_decisions_selected_step
        ON workflow_selector_decisions(selected_workflow_step_id, status, updated_at);
      `);

      if (!hasWorkflowCoordinationRecordsMigration) {
        this.recordMigration(WORKFLOW_COORDINATION_RECORDS_MIGRATION_VERSION, WORKFLOW_COORDINATION_RECORDS_MIGRATION_NAME);
      }
    }

    const hasChannelAutoReplyRouterMigration = this.hasMigration(CHANNEL_AUTO_REPLY_ROUTER_MIGRATION_VERSION);
    if (
      !hasChannelAutoReplyRouterMigration ||
      !this.hasColumn("channels", "auto_reply_mode") ||
      !this.hasTable("channel_message_route_decisions")
    ) {
      if (!this.hasColumn("channels", "auto_reply_mode")) {
        this.database.exec("ALTER TABLE channels ADD COLUMN auto_reply_mode TEXT NOT NULL DEFAULT 'mentions_only';");
      }

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_message_route_decisions (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          reply_message_id TEXT,
          mode TEXT NOT NULL,
          action TEXT NOT NULL,
          selected_teammate_id TEXT,
          selected_provider_preset_id TEXT,
          confidence REAL,
          reason TEXT NOT NULL,
          alternatives_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE CASCADE,
          FOREIGN KEY(reply_message_id) REFERENCES channel_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_message_route_decisions_source
        ON channel_message_route_decisions(source_message_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_message_route_decisions_channel
        ON channel_message_route_decisions(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_message_route_decisions_status
        ON channel_message_route_decisions(channel_id, status, updated_at);
      `);

      if (!hasChannelAutoReplyRouterMigration) {
        this.recordMigration(CHANNEL_AUTO_REPLY_ROUTER_MIGRATION_VERSION, CHANNEL_AUTO_REPLY_ROUTER_MIGRATION_NAME);
      }
    }

    const hasTeammateDirectReplyInterventionsMigration = this.hasMigration(TEAMMATE_DIRECT_REPLY_INTERVENTIONS_MIGRATION_VERSION);
    if (!hasTeammateDirectReplyInterventionsMigration || !this.hasTable("teammate_direct_reply_interventions")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS teammate_direct_reply_interventions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          source_work_unit_id TEXT,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          instruction TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          continuation_message_id TEXT,
          continuation_work_unit_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          failure_reason TEXT,
          UNIQUE(workspace_id, teammate_id, thread_id, idempotency_key),
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES teammate_direct_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES teammate_direct_messages(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_reply_interventions_thread
        ON teammate_direct_reply_interventions(teammate_id, thread_id, status, created_at);

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_reply_interventions_source_work_unit
        ON teammate_direct_reply_interventions(source_work_unit_id, status, created_at);
      `);
      if (!hasTeammateDirectReplyInterventionsMigration) {
        this.recordMigration(TEAMMATE_DIRECT_REPLY_INTERVENTIONS_MIGRATION_VERSION, TEAMMATE_DIRECT_REPLY_INTERVENTIONS_MIGRATION_NAME);
      }
    }

    const hasWorkspaceSettingsAndChannelBindingMigration = this.hasMigration(WORKSPACE_SETTINGS_AND_CHANNEL_BINDING_MIGRATION_VERSION);
    if (
      !hasWorkspaceSettingsAndChannelBindingMigration ||
      !this.hasColumn("channels", "workspace_binding_json") ||
      !this.hasTable("workspace_settings")
    ) {
      if (!this.hasColumn("channels", "workspace_binding_json")) {
        this.database.exec("ALTER TABLE channels ADD COLUMN workspace_binding_json TEXT;");
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workspace_settings (
          workspace_id TEXT PRIMARY KEY,
          settings_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
      `);
      if (!hasWorkspaceSettingsAndChannelBindingMigration) {
        this.recordMigration(WORKSPACE_SETTINGS_AND_CHANNEL_BINDING_MIGRATION_VERSION, WORKSPACE_SETTINGS_AND_CHANNEL_BINDING_MIGRATION_NAME);
      }
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

  private ensureDefaultApprovalPolicy(): void {
    const now = new Date().toISOString();
    const policy = createDefaultApprovalPolicy(DEFAULT_WORKSPACE_ID, now);
    this.database
      .prepare(`
        INSERT INTO approval_policies (
          workspace_id,
          tool_decisions_json,
          allowed_write_paths_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO NOTHING
      `)
      .run(
        policy.workspaceId,
        stringifyJson(policy.toolDecisions),
        stringifyJson(policy.allowedWritePaths),
        policy.createdAt,
        policy.updatedAt,
      );
  }

  private ensureDefaultAiTeammates(): void {
    if (!this.hasTable("ai_teammates")) {
      return;
    }
    const now = new Date().toISOString();
    for (const template of listDefaultTeammateTemplates(GSTACK_DEFAULT_SKILL_PACK_ID)) {
      const teammateId = createBuiltinAiTeammateId(template.id);
      if (this.hasRetentionTombstone("ai-teammate", teammateId)) {
        continue;
      }
      const existing = this.getAiTeammate(teammateId);
      if (existing) {
        this.backfillTemplateSkillBindings(teammateId, template, now);
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
      this.database
        .prepare("UPDATE channels SET default_teammate_id = ?, updated_at = ? WHERE default_teammate_id = ?")
        .run(teammateId, now, template.id);
      this.database
        .prepare("UPDATE tasks SET assignee_teammate_id = ?, updated_at = ? WHERE assignee_teammate_id = ?")
        .run(teammateId, now, template.id);
    }
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

  private nextEventSeq(runId: string): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?").get(runId);
    return readNumber(row, "next_seq");
  }

  private nextRuntimeEventSeq(workUnitId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM runtime_events WHERE work_unit_id = ?")
      .get(workUnitId);
    return readNumber(row, "next_seq");
  }

  private getControlPlaneEvent(seq: number): ControlPlaneEvent | undefined {
    const row = this.database.prepare(controlPlaneEventSelectSql("WHERE seq = ?")).get(seq);
    return row ? mapControlPlaneEvent(row) : undefined;
  }

  private hasTerminalEvent(runId: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS found FROM run_events WHERE run_id = ? AND type IN ('run_end', 'run_error', 'run_cancelled', 'result') LIMIT 1")
      .get(runId);
    return Boolean(row);
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

  private assertChannelIntentDecisionRefsInChannel(
    channelId: string,
    input: Pick<CreateChannelIntentDecisionInput, "selectedTeammateId" | "selectedTeammateIds" | "proposalId" | "replyMessageId" | "replyMessageIds" | "workflowId">,
  ): void {
    if (input.selectedTeammateId && !this.getAiTeammate(input.selectedTeammateId)) {
      throw new Error(`AI teammate not found: ${input.selectedTeammateId}`);
    }
    for (const teammateId of input.selectedTeammateIds ?? []) {
      if (!this.getAiTeammate(teammateId)) {
        throw new Error(`AI teammate not found: ${teammateId}`);
      }
    }
    if (input.proposalId) {
      this.assertProposalInChannel(channelId, input.proposalId);
    }
    if (input.replyMessageId) {
      this.assertMessageInChannel(channelId, input.replyMessageId);
    }
    for (const replyMessageId of input.replyMessageIds ?? []) {
      this.assertMessageInChannel(channelId, replyMessageId);
    }
    if (input.workflowId) {
      this.assertWorkflowInChannel(channelId, input.workflowId);
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

  private assertSummaryTargetInChannel(
    channelId: string,
    targetType: ChannelContextSummaryTargetType,
    targetId: string,
  ): void {
    if (targetType === "task") {
      this.assertTaskInChannel(channelId, targetId);
      return;
    }
    const directMessage = this.getChannelMessage(targetId);
    if (directMessage) {
      if (directMessage.channelId !== channelId) {
        throw new Error(`Summary target does not belong to channel: ${targetId}`);
      }
      return;
    }
    const threadMessage = this.database
      .prepare("SELECT id FROM channel_messages WHERE channel_id = ? AND thread_id = ? LIMIT 1")
      .get(channelId, targetId);
    if (!threadMessage) {
      throw new Error(`Channel thread not found: ${targetId}`);
    }
  }

  private nextWorkflowStepPosition(workflowId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM channel_workflow_steps WHERE workflow_id = ?")
      .get(workflowId);
    return readNumber(row, "next_position");
  }

  private updateRunStatus(
    runId: string,
    status: RunStatus,
    startedAt: string | undefined,
    endedAt: string | null | undefined,
    errorMessage: string | null | undefined,
    summaryPath: string | undefined,
    updatedAt: string,
  ): void {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Run session not found: ${runId}`);
    }

    this.database
      .prepare(
        `
          UPDATE run_sessions
          SET
            status = ?,
            started_at = ?,
            ended_at = ?,
            error_message = ?,
            summary_path = ?,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        status,
        startedAt ?? existing.startedAt ?? null,
        endedAt === undefined ? existing.endedAt ?? null : endedAt,
        errorMessage === undefined ? existing.errorMessage ?? null : errorMessage,
        summaryPath ?? existing.summaryPath ?? null,
        updatedAt,
        runId,
      );
    this.reconcileLingTurnStatusForRun(runId, updatedAt);
    this.tryRebuildLingThreadMetadata(existing.threadId, updatedAt);
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
    if (runIds.length === 0) {
      return undefined;
    }
    const placeholders = runIds.map(() => "?").join(", ");
    const row = this.database
      .prepare(`
        SELECT MAX(ts) AS latest_ts
        FROM run_events
        WHERE run_id IN (${placeholders})
          AND type IN ('tool_start', 'tool_update', 'tool_end')
      `)
      .get(...runIds);
    return row ? readNullableString(row, "latest_ts") : undefined;
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

export function createSqliteRunStore(cwd: string): SqliteRunStore {
  return new SqliteRunStore({ cwd });
}

function mapLingThread(row: Record<string, SQLOutputValue>): LingThread {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    kind: readString(row, "kind") as LingThreadKind,
    channelId: readNullableString(row, "channel_id"),
    taskId: readNullableString(row, "task_id"),
    teammateId: readNullableString(row, "teammate_id"),
    workflowId: readNullableString(row, "workflow_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    externalWorkId: readNullableString(row, "external_work_id"),
    title: readString(row, "title"),
    objective: readString(row, "objective"),
    status: readString(row, "status") as LingThreadStatus,
    activeRunId: readNullableString(row, "active_run_id"),
    lastRunId: readNullableString(row, "last_run_id"),
    parentThreadId: readNullableString(row, "parent_thread_id"),
    parentTurnId: readNullableString(row, "parent_turn_id"),
    forkedFromRunId: readNullableString(row, "forked_from_run_id"),
    metadata: parseOptionalLingThreadMetadata(readNullableString(row, "metadata_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    pinnedAt: readNullableString(row, "pinned_at"),
    archivedAt: readNullableString(row, "archived_at"),
    archivedReason: readNullableString(row, "archived_reason"),
  });
}

function mapLingTurn(row: Record<string, SQLOutputValue>): LingTurn {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    threadId: readString(row, "thread_id"),
    kind: readString(row, "kind") as LingTurnKind,
    status: readString(row, "status") as LingTurnStatus,
    title: readString(row, "title"),
    userInstruction: readString(row, "user_instruction"),
    channelId: readNullableString(row, "channel_id"),
    taskId: readNullableString(row, "task_id"),
    teammateId: readNullableString(row, "teammate_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    externalWorkId: readNullableString(row, "external_work_id"),
    automationId: readNullableString(row, "automation_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    sourceTurnId: readNullableString(row, "source_turn_id"),
    interventionId: readNullableString(row, "intervention_id"),
    activeRunId: readNullableString(row, "active_run_id"),
    lastRunId: readNullableString(row, "last_run_id"),
    createdByActor: readString(row, "created_by_actor") as LingTurn["createdByActor"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    completedAt: readNullableString(row, "completed_at"),
  });
}

function mapLingTurnRun(row: Record<string, SQLOutputValue>): LingTurnRun {
  return {
    turnId: readString(row, "turn_id"),
    runId: readString(row, "run_id"),
    attemptNumber: readNumber(row, "attempt_number"),
    role: readString(row, "role") as LingTurnRunRole,
    createdAt: readString(row, "created_at"),
  };
}

function mapAutomationDefinition(row: Record<string, SQLOutputValue>): AutomationDefinition {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readNullableString(row, "channel_id"),
    threadId: readString(row, "thread_id"),
    title: readString(row, "title"),
    description: readNullableString(row, "description"),
    kind: readString(row, "kind") as AutomationKind,
    status: readString(row, "status") as AutomationStatus,
    trigger: parseAutomationTrigger(readString(row, "trigger_json")),
    target: parseAutomationTarget(readString(row, "target_json")),
    promptTemplate: parseAutomationPromptTemplate(readString(row, "prompt_template_json")),
    executionPolicy: parseAutomationExecutionPolicy(readString(row, "execution_policy_json")),
    outputPolicy: parseAutomationOutputPolicy(readString(row, "output_policy_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    lastRunId: readNullableString(row, "last_run_id"),
    nextRunAt: readNullableString(row, "next_run_at"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
  });
}

function mapAutomationDraft(row: Record<string, SQLOutputValue>): AutomationDraft {
  const payload = parseJsonObject(readString(row, "draft_json"));
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readNullableString(row, "channel_id"),
    source: readString(row, "source") as AutomationDraftSource,
    status: readString(row, "status") as AutomationDraftStatus,
    title: readOptionalStringValue(payload.title),
    description: readOptionalStringValue(payload.description),
    kind: readOptionalStringValue(payload.kind) as AutomationKind | undefined,
    trigger: payload.trigger as AutomationTrigger | undefined,
    target: payload.target as AutomationTarget | undefined,
    promptTemplate: payload.promptTemplate as AutomationPromptTemplate | undefined,
    executionPolicy: payload.executionPolicy as AutomationExecutionPolicy | undefined,
    outputPolicy: payload.outputPolicy as AutomationOutputPolicy | undefined,
    missingFields: parseJsonStringArray(readString(row, "missing_fields_json")).filter(isAutomationDraftField),
    warnings: parseJson(readString(row, "warnings_json")) as AutomationDraft["warnings"],
    proposedByRunId: readNullableString(row, "proposed_by_run_id"),
    proposedByThreadId: readNullableString(row, "proposed_by_thread_id"),
    confirmedAutomationId: readNullableString(row, "confirmed_automation_id"),
    discardedAt: readNullableString(row, "discarded_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapAutomationRun(row: Record<string, SQLOutputValue>): AutomationRun {
  return omitUndefined({
    id: readString(row, "id"),
    automationId: readString(row, "automation_id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readNullableString(row, "channel_id"),
    threadId: readString(row, "thread_id"),
    runId: readNullableString(row, "run_id"),
    triggerType: readString(row, "trigger_type") as AutomationRun["triggerType"],
    scheduledFor: readNullableString(row, "scheduled_for"),
    firedAt: readString(row, "fired_at"),
    startedAt: readNullableString(row, "started_at"),
    completedAt: readNullableString(row, "completed_at"),
    status: readString(row, "status") as AutomationRunStatus,
    idempotencyKey: readString(row, "idempotency_key"),
    contextPreviewArtifactId: readNullableString(row, "context_preview_artifact_id"),
    outputArtifactIds: parseJsonStringArray(readString(row, "output_artifact_ids_json")),
    skipReason: readNullableString(row, "skip_reason"),
    errorMessage: readNullableString(row, "error_message"),
  });
}

function mapRunSession(row: Record<string, SQLOutputValue>): RunSession {
  return omitUndefined({
    id: readString(row, "id"),
    status: readString(row, "status") as RunStatus,
    cwd: readString(row, "cwd"),
    taskId: readString(row, "task_id"),
    channelId: readNullableString(row, "channel_id"),
    teammateId: readNullableString(row, "teammate_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    selectedSkillId: readNullableString(row, "selected_skill_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    providerName: readString(row, "provider_name"),
    providerModel: readString(row, "provider_model"),
    taskSnapshot: parseJson(readString(row, "task_snapshot_json")),
    providerSnapshot: parseJson(readString(row, "provider_snapshot_json")),
    requestSnapshot: parseJson(readString(row, "request_snapshot_json")),
    eventLogPath: readString(row, "event_log_path"),
    threadId: readNullableString(row, "thread_id"),
    workUnitId: readNullableString(row, "work_unit_id"),
    parentRunId: readNullableString(row, "parent_run_id"),
    interventionId: readNullableString(row, "intervention_id"),
    continuationReason: readNullableRunContinuationReason(row, "continuation_reason"),
    summaryPath: readNullableString(row, "summary_path"),
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    startedAt: readNullableString(row, "started_at"),
    endedAt: readNullableString(row, "ended_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapRunIntervention(row: Record<string, SQLOutputValue>): RunIntervention {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    sourceRunId: readString(row, "source_run_id"),
    sourceWorkUnitId: readNullableString(row, "source_work_unit_id"),
    sourceAttemptId: readNullableString(row, "source_attempt_id"),
    continuationRunId: readNullableString(row, "continuation_run_id"),
    continuationWorkUnitId: readNullableString(row, "continuation_work_unit_id"),
    mode: readString(row, "mode") as RunInterventionMode,
    status: readString(row, "status") as RunInterventionStatus,
    instruction: readString(row, "instruction"),
    requestedBy: readString(row, "requested_by") as RunIntervention["requestedBy"],
    idempotencyKey: readString(row, "idempotency_key"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    startedAt: readNullableString(row, "started_at"),
    completedAt: readNullableString(row, "completed_at"),
    failureReason: readNullableString(row, "failure_reason"),
  });
}

function mapRunEvent(row: Record<string, SQLOutputValue>): RunEventEnvelope {
  return {
    id: readString(row, "id"),
    runId: readString(row, "run_id"),
    seq: readNumber(row, "seq"),
    ts: readString(row, "ts"),
    type: readString(row, "type") as RunEventType,
    data: parseJson(readString(row, "data_json")),
  };
}

function runInterventionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      source_run_id,
      source_work_unit_id,
      source_attempt_id,
      continuation_run_id,
      continuation_work_unit_id,
      mode,
      status,
      instruction,
      requested_by,
      idempotency_key,
      created_at,
      updated_at,
      started_at,
      completed_at,
      failure_reason
    FROM run_interventions
    ${whereClause}
  `;
}

function lingThreadSelectSql(whereClause: string): string {
  return `
    SELECT
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
    FROM ling_threads
    ${whereClause}
  `;
}

function lingTurnSelectSql(whereClause: string): string {
  return `
    SELECT
      ling_turns.id,
      ling_turns.workspace_id,
      ling_turns.thread_id,
      ling_turns.kind,
      ling_turns.status,
      ling_turns.title,
      ling_turns.user_instruction,
      ling_turns.channel_id,
      ling_turns.task_id,
      ling_turns.teammate_id,
      ling_turns.workflow_step_id,
      ling_turns.external_work_id,
      ling_turns.automation_id,
      ling_turns.source_message_id,
      ling_turns.source_turn_id,
      ling_turns.intervention_id,
      ling_turns.active_run_id,
      ling_turns.last_run_id,
      ling_turns.created_by_actor,
      ling_turns.created_at,
      ling_turns.updated_at,
      ling_turns.completed_at
    FROM ling_turns
    ${whereClause}
  `;
}

function automationDefinitionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      thread_id,
      title,
      description,
      kind,
      status,
      trigger_json,
      target_json,
      prompt_template_json,
      execution_policy_json,
      output_policy_json,
      created_at,
      updated_at,
      last_run_id,
      next_run_at,
      last_error_message
    FROM automation_definitions
    ${whereClause}
  `;
}

function automationDraftSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source,
      status,
      draft_json,
      missing_fields_json,
      warnings_json,
      proposed_by_run_id,
      proposed_by_thread_id,
      confirmed_automation_id,
      discarded_at,
      created_at,
      updated_at
    FROM automation_drafts
    ${whereClause}
  `;
}

function automationRunSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      automation_id,
      workspace_id,
      channel_id,
      thread_id,
      run_id,
      trigger_type,
      scheduled_for,
      fired_at,
      started_at,
      completed_at,
      status,
      idempotency_key,
      context_preview_artifact_id,
      output_artifact_ids_json,
      skip_reason,
      error_message
    FROM automation_runs
    ${whereClause}
  `;
}

function mapChannel(row: Record<string, SQLOutputValue>): Channel {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    name: readString(row, "name"),
    status: readString(row, "status") as ChannelStatus,
    boundPath: readNullableString(row, "bound_path"),
    workspaceBinding: parseNullableChannelWorkspaceBinding(readNullableString(row, "workspace_binding_json")),
    defaultProviderPresetId: readNullableString(row, "default_provider_preset_id"),
    defaultTeammateId: readNullableString(row, "default_teammate_id"),
    autoReplyMode: readString(row, "auto_reply_mode") as Channel["autoReplyMode"],
    responseLanguage: parseOptionalChannelResponseLanguage(readNullableString(row, "response_language")),
    allowedTools: parseJsonStringArray(readString(row, "allowed_tools_json")) as RunTool[],
    runtimePolicy: parseChannelRuntimePolicy(readString(row, "runtime_policy_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapTask(row: Record<string, SQLOutputValue>): Task {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    title: readString(row, "title"),
    prompt: readString(row, "prompt"),
    status: readString(row, "status") as TaskStatus,
    assigneeTeammateId: readNullableString(row, "assignee_teammate_id"),
    requestedSkillId: readNullableString(row, "requested_skill_id"),
    currentRunId: readNullableString(row, "current_run_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapAiTeammate(row: Record<string, SQLOutputValue>): AiTeammate {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    templateId: readNullableString(row, "template_id"),
    roleKey: readString(row, "role_key") as AiTeammateRoleKey,
    displayName: readString(row, "display_name"),
    description: readString(row, "description"),
    avatarTone: readNullableString(row, "avatar_tone"),
    avatarImageAttachmentId: readNullableString(row, "avatar_image_attachment_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    runnerId: normalizeStoredRunnerId(readNullableString(row, "runner_id")),
    systemPrompt: readNullableString(row, "system_prompt"),
    appendSystemPrompt: parseJsonStringArray(readString(row, "append_system_prompt_json")),
    allowedTools: parseJsonStringArray(readString(row, "allowed_tools_json")) as RunTool[],
    approvalProfile: parseApprovalProfile(readString(row, "approval_profile_json")),
    status: readString(row, "status") as AiTeammateStatus,
    pinned: readBoolean(row, "pinned"),
    hidden: readBoolean(row, "hidden"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapTeammateChannelMembership(row: Record<string, SQLOutputValue>): TeammateChannelMembership {
  return {
    teammateId: readString(row, "teammate_id"),
    channelId: readString(row, "channel_id"),
    isDefault: readBoolean(row, "is_default"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapTeammateSkillBinding(row: Record<string, SQLOutputValue>): TeammateSkillBinding {
  return {
    teammateId: readString(row, "teammate_id"),
    skillId: readString(row, "skill_id"),
    source: readString(row, "source") as TeammateSkillBindingSource,
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapSkillRegistryEntry(row: Record<string, SQLOutputValue>): SkillRegistryEntry {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    packId: readString(row, "pack_id"),
    source: readString(row, "source") as SkillPackSource,
    sourcePath: readNullableString(row, "source_path"),
    version: readNullableString(row, "version"),
    checksum: readNullableString(row, "checksum"),
    definition: parseJson(readString(row, "definition_json")) as SkillRegistryEntry["definition"],
    visibility: parseSkillVisibility(readString(row, "visibility_json")),
    reviewStatus: readString(row, "review_status") as SkillRegistryReviewStatus,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapSkillImportDraft(row: Record<string, SQLOutputValue>): SkillImportDraft {
  const draft = parseJsonObject(readString(row, "draft_json"));
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    source: readString(row, "source") as SkillPackSource,
    sourcePath: readNullableString(row, "source_path"),
    packId: typeof draft.packId === "string" ? draft.packId : undefined,
    name: typeof draft.name === "string" ? draft.name : "Imported skills",
    version: typeof draft.version === "string" ? draft.version : undefined,
    description: typeof draft.description === "string" ? draft.description : "",
    definitions: Array.isArray(draft.definitions) ? draft.definitions as SkillImportDraftDefinition[] : [],
    warnings: parseJson(readString(row, "warnings_json")) as SkillImportDraft["warnings"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseSkillVisibility(value: string): SkillVisibility {
  const parsed = parseJsonObject(value);
  return omitUndefined({
    workspaceVisible: typeof parsed.workspaceVisible === "boolean" ? parsed.workspaceVisible : true,
    ownerTeammateId: typeof parsed.ownerTeammateId === "string" ? parsed.ownerTeammateId : undefined,
    promotableToWorkspace: typeof parsed.promotableToWorkspace === "boolean" ? parsed.promotableToWorkspace : true,
  });
}

function defaultSkillVisibility(): SkillVisibility {
  return {
    workspaceVisible: true,
    promotableToWorkspace: true,
  };
}

function mapTeammateMemoryScope(row: Record<string, SQLOutputValue>): TeammateMemoryScope {
  return omitUndefined({
    id: readString(row, "id"),
    teammateId: readString(row, "teammate_id"),
    kind: readString(row, "kind") as TeammateMemoryScopeKind,
    channelId: readNullableString(row, "channel_id"),
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapMemoryObject(row: Record<string, SQLOutputValue>): MemoryObject {
  const id = readString(row, "id");
  return omitUndefined({
    id,
    workspaceId: readString(row, "workspace_id"),
    scopeType: readString(row, "scope_type") as MemoryScopeType,
    ownerId: readString(row, "owner_id"),
    title: readString(row, "title"),
    body: readString(row, "body"),
    tags: parseJsonStringArray(readString(row, "tags_json")),
    sourceRefs: ensureMemorySourceRefs(id, parseMemorySourceRefs(readString(row, "source_refs_json"))),
    reviewState: readString(row, "review_state") as MemoryReviewState,
    enabled: readBoolean(row, "enabled"),
    sensitivity: readString(row, "sensitivity") as MemorySensitivity,
    verifyBeforeUse: readBoolean(row, "verify_before_use"),
    retrievalProviderId: readNullableString(row, "retrieval_provider_id"),
    retrievalHandle: readNullableString(row, "retrieval_handle"),
    createdBy: readNullableString(row, "created_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    lastUsedAt: readNullableString(row, "last_used_at"),
  });
}

function mapMemorySelfImprovingMetadata(row: Record<string, SQLOutputValue>): MemorySelfImprovingMetadata {
  return omitUndefined({
    memoryId: readString(row, "memory_id"),
    kind: readString(row, "kind") as MemorySelfImprovingKind,
    trigger: readString(row, "trigger") as MemorySelfImprovingMetadata["trigger"],
    lesson: readString(row, "lesson"),
    useWhen: parseJsonStringArray(readString(row, "use_when_json")),
    doNotUseWhen: parseJsonStringArray(readString(row, "do_not_use_when_json")),
    validUntil: readNullableString(row, "valid_until"),
    lastSeenAt: readNullableString(row, "last_seen_at"),
    evidenceCount: readNumber(row, "evidence_count"),
    supersededBy: readNullableString(row, "superseded_by"),
    lastUsedAt: readNullableString(row, "last_used_at"),
    useCount: readNumber(row, "use_count"),
  });
}

function mapMemoryConsolidationJob(row: Record<string, SQLOutputValue>): MemoryConsolidationJob {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    kind: readString(row, "kind") as MemoryConsolidationJobKind,
    sourceRefs: parseMemorySourceRefs(readString(row, "source_refs_json")),
    status: readString(row, "status") as MemoryConsolidationJobStatus,
    createdCandidateIds: parseJsonStringArray(readString(row, "created_candidate_ids_json")),
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapUsedMemoryEvent(row: Record<string, SQLOutputValue>): UsedMemoryEvent {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    memoryIds: parseJsonStringArray(readString(row, "memory_ids_json")),
    intent: readString(row, "intent") as UsedMemoryEvent["intent"],
    recallQuery: readString(row, "recall_query"),
    teammateId: readNullableString(row, "teammate_id"),
    channelId: readNullableString(row, "channel_id"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    responseId: readNullableString(row, "response_id"),
    policyVersion: readString(row, "policy_version"),
    createdAt: readString(row, "created_at"),
  });
}

function mapMemoryReviewPolicy(row: Record<string, SQLOutputValue>): MemoryReviewPolicy {
  return {
    workspaceId: readString(row, "workspace_id"),
    mode: readString(row, "mode") as MemoryReviewMode,
    autoActiveSameScope: readBoolean(row, "auto_active_same_scope"),
    autoActiveUserExplicit: readBoolean(row, "auto_active_user_explicit"),
    requireManualForWorkspace: readBoolean(row, "require_manual_for_workspace"),
    requireManualForPersona: readBoolean(row, "require_manual_for_persona"),
    requireManualForCrossScope: readBoolean(row, "require_manual_for_cross_scope"),
    quarantineSecretAdjacent: readBoolean(row, "quarantine_secret_adjacent"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapMemoryReviewDecision(row: Record<string, SQLOutputValue>): MemoryReviewDecision {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    memoryId: readString(row, "memory_id"),
    outcome: readString(row, "outcome") as MemoryReviewOutcome,
    mode: readString(row, "mode") as MemoryReviewMode,
    reasonCode: readString(row, "reason_code"),
    reason: readString(row, "reason"),
    confidence: readString(row, "confidence") as MemoryReviewDecision["confidence"],
    requiresManualReview: readBoolean(row, "requires_manual_review"),
    quarantineReason: readNullableString(row, "quarantine_reason"),
    targetReviewState: readString(row, "target_review_state") as MemoryReviewState,
    targetSensitivity: readString(row, "target_sensitivity") as MemorySensitivity,
    sourceRefs: parseMemorySourceRefs(readString(row, "source_refs_json")),
    decidedBy: readString(row, "decided_by") as MemoryReviewDecision["decidedBy"],
    createdAt: readString(row, "created_at"),
  });
}

function mapTeammateDirectThread(row: Record<string, SQLOutputValue>): TeammateDirectThread {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    teammateId: readString(row, "teammate_id"),
    title: readString(row, "title"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapTeammateDirectMessage(row: Record<string, SQLOutputValue>): TeammateDirectMessage {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    threadId: readString(row, "thread_id"),
    teammateId: readString(row, "teammate_id"),
    authorType: readString(row, "author_type") as TeammateDirectMessageAuthorType,
    authorId: readNullableString(row, "author_id"),
    body: readString(row, "body"),
    attachmentIds: parseJsonStringArray(readString(row, "attachment_ids_json")),
    status: readString(row, "status") as TeammateDirectMessageStatus,
    errorMessage: readNullableString(row, "error_message"),
    linkedTaskId: readNullableString(row, "linked_task_id"),
    linkedRunId: readNullableString(row, "linked_run_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapTeammateDirectReplyIntervention(row: Record<string, SQLOutputValue>): TeammateDirectReplyIntervention {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    teammateId: readString(row, "teammate_id"),
    threadId: readString(row, "thread_id"),
    sourceMessageId: readString(row, "source_message_id"),
    sourceWorkUnitId: readNullableString(row, "source_work_unit_id"),
    mode: readString(row, "mode") as TeammateDirectReplyInterventionMode,
    status: readString(row, "status") as TeammateDirectReplyInterventionStatus,
    instruction: readString(row, "instruction"),
    idempotencyKey: readString(row, "idempotency_key"),
    requestedBy: readString(row, "requested_by") as TeammateDirectReplyIntervention["requestedBy"],
    continuationMessageId: readNullableString(row, "continuation_message_id"),
    continuationWorkUnitId: readNullableString(row, "continuation_work_unit_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    startedAt: readNullableString(row, "started_at"),
    completedAt: readNullableString(row, "completed_at"),
    failureReason: readNullableString(row, "failure_reason"),
  });
}

function mapTeammatePrivateAttachment(row: Record<string, SQLOutputValue>): TeammatePrivateAttachment {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    teammateId: readString(row, "teammate_id"),
    threadId: readNullableString(row, "thread_id"),
    messageId: readNullableString(row, "message_id"),
    scope: readString(row, "scope") as TeammatePrivateAttachmentScope,
    kind: readString(row, "kind") as ChannelAttachmentKind,
    fileName: readString(row, "file_name"),
    contentType: readString(row, "content_type"),
    sizeBytes: readNumber(row, "size_bytes"),
    path: readString(row, "path"),
    createdAt: readString(row, "created_at"),
  });
}

function mapChannelMessage(row: Record<string, SQLOutputValue>): ChannelMessage {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    threadId: readNullableString(row, "thread_id"),
    kind: readString(row, "kind") as ChannelMessageKind,
    intent: readString(row, "intent") as ChannelMessageIntent,
    authorType: readString(row, "author_type") as ChannelMessageAuthorType,
    authorId: readNullableString(row, "author_id"),
    body: readString(row, "body"),
    mentions: parseChannelMentions(readString(row, "mentions_json")),
    attachmentIds: parseJsonStringArray(readString(row, "attachment_ids_json")),
    linkPreviewIds: parseJsonStringArray(readString(row, "link_preview_ids_json")),
    linkedTaskId: readNullableString(row, "linked_task_id"),
    linkedRunId: readNullableString(row, "linked_run_id"),
    status: readString(row, "status") as ChannelMessage["status"],
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelMessageRouteDecision(row: Record<string, SQLOutputValue>): ChannelMessageRouteDecision {
  return omitUndefined({
    schemaVersion: readNumber(row, "schema_version") as 1,
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readString(row, "source_message_id"),
    replyMessageId: readNullableString(row, "reply_message_id"),
    mode: readString(row, "mode") as ChannelMessageRouteDecision["mode"],
    action: readString(row, "action") as ChannelMessageRouteDecision["action"],
    selectedTeammateId: readNullableString(row, "selected_teammate_id"),
    selectedProviderPresetId: readNullableString(row, "selected_provider_preset_id"),
    confidence: readNullableNumber(row, "confidence"),
    reason: readString(row, "reason"),
    alternativesConsidered: parseChannelMessageRouteAlternatives(readString(row, "alternatives_json")),
    status: readString(row, "status") as ChannelMessageRouteDecisionStatus,
    createdBy: readString(row, "created_by") as ChannelMessageRouteDecisionCreatedBy,
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelIntentDecision(row: Record<string, SQLOutputValue>): ChannelIntentDecision {
  return omitUndefined({
    schemaVersion: readNumber(row, "schema_version") as 1,
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readString(row, "source_message_id"),
    action: readString(row, "action") as ChannelIntentDecisionAction,
    selectedTeammateId: readNullableString(row, "selected_teammate_id"),
    selectedTeammateIds: parseJsonStringArray(readNullableString(row, "selected_teammate_ids_json") ?? "[]"),
    proposalId: readNullableString(row, "proposal_id"),
    replyMessageId: readNullableString(row, "reply_message_id"),
    replyMessageIds: parseJsonStringArray(readNullableString(row, "reply_message_ids_json") ?? "[]"),
    workflowId: readNullableString(row, "workflow_id"),
    reason: readString(row, "reason"),
    status: readString(row, "status") as ChannelIntentDecisionStatus,
    createdBy: readString(row, "created_by") as ChannelIntentDecision["createdBy"],
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelExecutionProposal(row: Record<string, SQLOutputValue>): ChannelExecutionProposal {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readString(row, "source_message_id"),
    proposedByTeammateId: readString(row, "proposed_by_teammate_id"),
    title: readString(row, "title"),
    prompt: readString(row, "prompt"),
    assigneeTeammateId: readString(row, "assignee_teammate_id"),
    acceptanceCriteria: parseJsonStringArray(readString(row, "acceptance_criteria_json")),
    collaborationSteps: parseChannelExecutionProposalSteps(readString(row, "collaboration_steps_json")),
    requiredTools: parseJsonStringArray(readString(row, "required_tools_json")) as ChannelExecutionProposal["requiredTools"],
    riskSummary: readNullableString(row, "risk_summary"),
    responseLanguage: parseOptionalResponseLanguage(readNullableString(row, "response_language")),
    status: readString(row, "status") as ChannelExecutionProposalStatus,
    linkedTaskId: readNullableString(row, "linked_task_id"),
    linkedRunId: readNullableString(row, "linked_run_id"),
    linkedWorkflowId: readNullableString(row, "linked_workflow_id"),
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelAttachment(row: Record<string, SQLOutputValue>): ChannelAttachment {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    messageId: readNullableString(row, "message_id"),
    kind: readString(row, "kind") as ChannelAttachmentKind,
    fileName: readString(row, "file_name"),
    contentType: readString(row, "content_type"),
    sizeBytes: readNumber(row, "size_bytes"),
    path: readString(row, "path"),
    createdAt: readString(row, "created_at"),
  });
}

function mapChannelLinkPreview(row: Record<string, SQLOutputValue>): ChannelLinkPreview {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    messageId: readNullableString(row, "message_id"),
    url: readString(row, "url"),
    normalizedUrl: readString(row, "normalized_url"),
    title: readNullableString(row, "title"),
    description: readNullableString(row, "description"),
    imageUrl: readNullableString(row, "image_url"),
    siteName: readNullableString(row, "site_name"),
    status: readString(row, "status") as ChannelLinkPreviewStatus,
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelBrief(row: Record<string, SQLOutputValue>): ChannelBrief {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    objective: readString(row, "objective"),
    scope: readString(row, "scope"),
    acceptanceCriteria: parseJsonStringArray(readString(row, "acceptance_criteria_json")),
    openQuestions: parseJsonStringArray(readString(row, "open_questions_json")),
    risks: parseJsonStringArray(readString(row, "risks_json")),
    decisionIds: parseJsonStringArray(readString(row, "decision_ids_json")),
    attachmentIds: parseJsonStringArray(readString(row, "attachment_ids_json")),
    linkPreviewIds: parseJsonStringArray(readString(row, "link_preview_ids_json")),
    updatedBy: readString(row, "updated_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapChannelDecision(row: Record<string, SQLOutputValue>): ChannelDecision {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    sourceTaskId: readNullableString(row, "source_task_id"),
    sourceRunId: readNullableString(row, "source_run_id"),
    title: readString(row, "title"),
    decision: readString(row, "decision"),
    rationale: readString(row, "rationale"),
    alternatives: parseJsonStringArray(readString(row, "alternatives_json")),
    status: readString(row, "status") as ChannelDecisionStatus,
    supersedesDecisionId: readNullableString(row, "supersedes_decision_id"),
    createdBy: readString(row, "created_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelHandoff(row: Record<string, SQLOutputValue>): ChannelHandoff {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    sourceTaskId: readNullableString(row, "source_task_id"),
    sourceRunId: readNullableString(row, "source_run_id"),
    fromParticipantId: readString(row, "from_participant_id"),
    fromParticipantLabel: readString(row, "from_participant_label"),
    toParticipantId: readString(row, "to_participant_id"),
    toParticipantLabel: readString(row, "to_participant_label"),
    reason: readString(row, "reason"),
    requiredInput: readString(row, "required_input"),
    expectedOutput: readString(row, "expected_output"),
    status: readString(row, "status") as ChannelHandoffStatus,
    createdBy: readString(row, "created_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapWorkflowHandoffIntent(row: Record<string, SQLOutputValue>): WorkflowHandoffIntent {
  return omitUndefined({
    schemaVersion: 1 as const,
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    workflowId: readNullableString(row, "workflow_id"),
    sourceWorkflowStepId: readNullableString(row, "source_workflow_step_id"),
    sourceRunId: readNullableString(row, "source_run_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    channelHandoffId: readNullableString(row, "channel_handoff_id"),
    fromParticipantId: readString(row, "from_participant_id"),
    fromParticipantLabel: readString(row, "from_participant_label"),
    toParticipantId: readString(row, "to_participant_id"),
    toParticipantLabel: readNullableString(row, "to_participant_label"),
    reason: readString(row, "reason"),
    requiredInput: readString(row, "required_input"),
    expectedOutput: readString(row, "expected_output"),
    riskSummary: readNullableString(row, "risk_summary"),
    sourceRefs: parseWorkflowPacketSourceRefs(readString(row, "source_refs_json")),
    status: readString(row, "status") as WorkflowHandoffIntentStatus,
    validation: parseOptionalWorkflowHandoffValidation(readNullableString(row, "validation_json")),
    createdBy: readString(row, "created_by") as WorkflowHandoffIntent["createdBy"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapWorkflowSelectorDecision(row: Record<string, SQLOutputValue>): WorkflowSelectorDecision {
  return omitUndefined({
    schemaVersion: 1 as const,
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    workflowId: readString(row, "workflow_id"),
    sourceWorkflowStepId: readNullableString(row, "source_workflow_step_id"),
    selectorNodeId: readNullableString(row, "selector_node_id"),
    targetKind: readString(row, "target_kind") as WorkflowSelectorTargetKind,
    selectedWorkflowStepId: readNullableString(row, "selected_workflow_step_id"),
    selectedGraphNodeId: readNullableString(row, "selected_graph_node_id"),
    selectedTeammateId: readNullableString(row, "selected_teammate_id"),
    selectedSkillId: readNullableString(row, "selected_skill_id"),
    selectedHandoffIntentId: readNullableString(row, "selected_handoff_intent_id"),
    reason: readString(row, "reason"),
    alternativesConsidered: parseWorkflowSelectorAlternatives(readString(row, "alternatives_json")),
    confidence: readString(row, "confidence") as WorkflowSelectorDecision["confidence"],
    requiresUserConfirmation: readBoolean(row, "requires_user_confirmation"),
    status: readString(row, "status") as WorkflowSelectorDecisionStatus,
    sourceRefs: parseWorkflowPacketSourceRefs(readString(row, "source_refs_json")),
    createdBy: readString(row, "created_by") as WorkflowSelectorDecision["createdBy"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelContextSummary(row: Record<string, SQLOutputValue>): ChannelContextSummary {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    targetType: readString(row, "target_type") as ChannelContextSummaryTargetType,
    targetId: readString(row, "target_id"),
    sourceMessageIds: parseJsonStringArray(readString(row, "source_message_ids_json")),
    decisionIds: parseJsonStringArray(readString(row, "decision_ids_json")),
    summary: readString(row, "summary"),
    acceptanceCriteria: parseJsonStringArray(readString(row, "acceptance_criteria_json")),
    openQuestions: parseJsonStringArray(readString(row, "open_questions_json")),
    authorType: readString(row, "author_type") as ChannelContextSummaryAuthorType,
    authorId: readNullableString(row, "author_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelWorkflow(row: Record<string, SQLOutputValue>): ChannelWorkflow {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceHandoffId: readNullableString(row, "source_handoff_id"),
    title: readString(row, "title"),
    objective: readString(row, "objective"),
    status: readString(row, "status") as ChannelWorkflowStatus,
    createdBy: readString(row, "created_by"),
    metadata: parseOptionalChannelWorkflowMetadata(readNullableString(row, "metadata_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelWorkflowStep(row: Record<string, SQLOutputValue>): ChannelWorkflowStep {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    workflowId: readString(row, "workflow_id"),
    sourceHandoffId: readNullableString(row, "source_handoff_id"),
    contextSummaryId: readNullableString(row, "context_summary_id"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    position: readNumber(row, "position"),
    title: readString(row, "title"),
    prompt: readString(row, "prompt"),
    toParticipantId: readString(row, "to_participant_id"),
    toParticipantLabel: readString(row, "to_participant_label"),
    status: readString(row, "status") as ChannelWorkflowStepStatus,
    blocker: readNullableString(row, "blocker"),
    resultSummary: readNullableString(row, "result_summary"),
    metadata: parseOptionalChannelWorkflowStepMetadata(readNullableString(row, "metadata_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapProviderPreset(row: Record<string, SQLOutputValue>): ProviderPreset {
  return omitUndefined({
    id: readString(row, "id"),
    kind: readString(row, "kind") as ProviderPreset["kind"],
    displayName: readString(row, "display_name"),
    providerId: readString(row, "provider_id"),
    model: readString(row, "model"),
    api: readString(row, "api") as ProviderPreset["api"],
    providerTransport: readNullableString(row, "provider_transport") as ProviderPreset["providerTransport"],
    baseUrl: readNullableString(row, "base_url"),
    apiKeyRef: readNullableString(row, "api_key_ref"),
    headers: parseJsonStringRecord(readString(row, "headers_json")),
    authHeader: readNullableBoolean(row, "auth_header"),
    reasoning: readNullableBoolean(row, "reasoning"),
    input: parseJsonStringArray(readString(row, "input_json")) as ProviderPreset["input"],
    contextWindow: readNullableNumber(row, "context_window"),
    maxTokens: readNullableNumber(row, "max_tokens"),
    compat: parseJsonObject(readString(row, "compat_json")),
    capabilities: parseJsonStringArray(readString(row, "capabilities_json")) as ProviderPreset["capabilities"],
    enabled: readBoolean(row, "enabled"),
    lastCheck: parseProviderCheckResult(readNullableString(row, "last_check_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapMcpServer(row: Record<string, SQLOutputValue>): McpServer {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    displayName: readString(row, "display_name"),
    transport: parseMcpServerTransport(readString(row, "transport_json")),
    enabled: readBoolean(row, "enabled"),
    required: readBoolean(row, "required"),
    status: parseMcpServerStatus(readString(row, "status_json")),
    startupTimeoutSec: readNullableNumber(row, "startup_timeout_sec"),
    toolTimeoutSec: readNullableNumber(row, "tool_timeout_sec"),
    enabledTools: parseNullableJsonStringArray(readNullableString(row, "enabled_tools_json")),
    disabledTools: parseJsonStringArray(readString(row, "disabled_tools_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapMcpTool(row: Record<string, SQLOutputValue>): McpTool {
  return omitUndefined({
    serverId: readString(row, "server_id"),
    rawName: readString(row, "raw_name"),
    displayName: readString(row, "display_name"),
    description: readNullableString(row, "description"),
    inputSchema: parseJson(readString(row, "input_schema_json")),
    callableNamespace: readString(row, "callable_namespace"),
    callableName: readString(row, "callable_name"),
    sideEffectLevel: readString(row, "side_effect_level") as McpTool["sideEffectLevel"],
    defaultApproval: readString(row, "default_approval") as McpTool["defaultApproval"],
    enabled: readBoolean(row, "enabled"),
    firstSeenAt: readString(row, "first_seen_at"),
    lastSeenAt: readString(row, "last_seen_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapTeammateMcpBinding(row: Record<string, SQLOutputValue>): TeammateMcpBinding {
  return {
    teammateId: readString(row, "teammate_id"),
    serverId: readString(row, "server_id"),
    mode: readString(row, "mode") as TeammateMcpBinding["mode"],
    selectedToolNames: parseJsonStringArray(readString(row, "selected_tool_names_json")),
    approvalOverrides: parseMcpApprovalOverrides(readString(row, "approval_overrides_json")),
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapManagedPlugin(row: Record<string, SQLOutputValue>): ManagedPluginRecord {
  return omitUndefined({
    id: readString(row, "id"),
    sourceKind: readString(row, "source_kind") as ManagedPluginRecord["sourceKind"],
    version: readString(row, "version"),
    enabled: readBoolean(row, "enabled"),
    disabledReason: readNullableString(row, "disabled_reason"),
    descriptor: parseManagedPluginDescriptor(readString(row, "descriptor_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapManagedPluginContribution(row: Record<string, SQLOutputValue>): ManagedPluginContributionRecord {
  return omitUndefined({
    pluginId: readString(row, "plugin_id"),
    contributionKind: readString(row, "contribution_kind") as ManagedPluginContributionRecord["contributionKind"],
    contributionId: readString(row, "contribution_id"),
    linkedResourceId: readNullableString(row, "linked_resource_id"),
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapManagedPluginEvent(row: Record<string, SQLOutputValue>): ManagedPluginEvent {
  return omitUndefined({
    id: readString(row, "id"),
    pluginId: readString(row, "plugin_id"),
    type: readString(row, "type") as ManagedPluginEvent["type"],
    actor: readString(row, "actor") as ManagedPluginEvent["actor"],
    message: readNullableString(row, "message"),
    data: parseNullableJson(readNullableString(row, "data_json")),
    createdAt: readString(row, "created_at"),
  });
}

function redactManagedPluginEventData(value: unknown): unknown {
  return redactManagedPluginEventValue(value, new WeakSet<object>());
}

function redactManagedPluginEventValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return looksLikeLocalPath(value) ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((item) => redactManagedPluginEventValue(item, seen));
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = shouldRedactManagedPluginEventKey(key)
        ? "[REDACTED]"
        : redactManagedPluginEventValue(item, seen);
    }
    return result;
  }
  return value;
}

function shouldRedactManagedPluginEventKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    normalized === "command" ||
    normalized.endsWith("command") ||
    normalized.endsWith("path") ||
    normalized.endsWith("root") ||
    normalized.endsWith("binary")
  );
}

function looksLikeLocalPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function mapManagedPluginPackage(row: Record<string, SQLOutputValue>): ManagedPluginPackageRecord {
  return omitUndefined({
    pluginId: readString(row, "plugin_id"),
    sourceKind: readString(row, "source_kind") as ManagedPluginPackageRecord["sourceKind"],
    version: readString(row, "version"),
    status: readString(row, "status") as ManagedPluginPackageRecord["status"],
    cacheRef: readString(row, "cache_ref"),
    packageHash: readNullableString(row, "package_hash"),
    manifestJson: readString(row, "manifest_json"),
    installedAt: readString(row, "installed_at"),
    updatedAt: readString(row, "updated_at"),
    uninstalledAt: readNullableString(row, "uninstalled_at"),
  });
}

function mapManagedPluginRuntimeSnapshot(row: Record<string, SQLOutputValue>): ManagedPluginRuntimeSnapshot {
  return omitUndefined({
    id: readString(row, "id"),
    runId: readNullableString(row, "run_id"),
    cwd: readString(row, "cwd"),
    pluginIds: parseJson(readString(row, "plugin_ids_json")) as ManagedPluginRuntimeSnapshot["pluginIds"],
    capabilities: parseJson(readString(row, "capabilities_json")) as ManagedPluginRuntimeSnapshot["capabilities"],
    policyOverlays: parseJson(readString(row, "policy_overlays_json")) as ManagedPluginRuntimeSnapshot["policyOverlays"],
    createdAt: readString(row, "created_at"),
  });
}

function mapApprovalRequest(row: Record<string, SQLOutputValue>): ApprovalRequest {
  return omitUndefined({
    id: readString(row, "id"),
    runId: readNullableString(row, "run_id"),
    taskId: readNullableString(row, "task_id"),
    mediaJobId: readNullableString(row, "media_job_id"),
    externalWorkActionId: readNullableString(row, "external_work_action_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    channelId: readNullableString(row, "channel_id"),
    toolCallId: readNullableString(row, "tool_call_id"),
    actionType: readString(row, "action_type") as ApprovalRequest["actionType"],
    risk: readString(row, "risk") as ApprovalRequest["risk"],
    title: readString(row, "title"),
    description: readString(row, "description"),
    payload: parseJsonObject(readString(row, "payload_json")) as ApprovalRequest["payload"],
    status: readString(row, "status") as ApprovalStatus,
    createdAt: readString(row, "created_at"),
    expiresAt: readNullableString(row, "expires_at"),
    resolvedAt: readNullableString(row, "resolved_at"),
    resolvedBy: readNullableString(row, "resolved_by") as ApprovalRequest["resolvedBy"],
    decisionReason: readNullableString(row, "decision_reason"),
  });
}

function mapApprovalPolicy(row: Record<string, SQLOutputValue>): ApprovalPolicy {
  return {
    workspaceId: readString(row, "workspace_id"),
    toolDecisions: parseApprovalToolDecisions(readString(row, "tool_decisions_json")),
    allowedWritePaths: parseJsonStringArray(readString(row, "allowed_write_paths_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
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

function mapArtifact(row: Record<string, SQLOutputValue>): RunArtifact {
  return omitUndefined({
    id: readString(row, "id"),
    runId: readNullableString(row, "run_id"),
    mediaJobId: readNullableString(row, "media_job_id"),
    externalWorkId: readNullableString(row, "external_work_id"),
    type: readString(row, "type") as ArtifactType,
    path: readString(row, "path"),
    title: readNullableString(row, "title"),
    contentType: readNullableString(row, "content_type"),
    sizeBytes: readNullableNumber(row, "size_bytes"),
    createdAt: readString(row, "created_at"),
  });
}

function mapExternalWorkRecord(row: Record<string, SQLOutputValue>): ExternalWorkRecord {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceKind: readString(row, "source_kind") as ExternalWorkRecord["sourceKind"],
    workItemKind: readString(row, "work_item_kind") as ExternalWorkRecord["workItemKind"],
    externalId: readString(row, "external_id"),
    identifier: readString(row, "identifier"),
    idempotencyKey: readString(row, "idempotency_key"),
    workflowId: readString(row, "workflow_id"),
    workflowStepId: readString(row, "workflow_step_id"),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    item: parseJsonObject(readString(row, "item_json")) as unknown as ExternalWorkItem,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapWorkItem(row: Record<string, SQLOutputValue>, dependencyIds: readonly string[], now?: string): WorkItem {
  const claim = mapWorkItemClaim(row, now);
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readNullableString(row, "channel_id"),
    sourceType: readString(row, "source_type") as WorkItemSourceType,
    sourceId: readString(row, "source_id"),
    title: readString(row, "title"),
    description: readNullableString(row, "description"),
    status: readString(row, "status") as WorkItemStatus,
    waitingReason: readNullableString(row, "waiting_reason") as WorkItemWaitingReason | undefined,
    priority: readString(row, "priority") as WorkItem["priority"],
    labels: parseJsonStringArray(readString(row, "labels_json")),
    assigneeTeammateId: readNullableString(row, "assignee_teammate_id"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    workflowId: readNullableString(row, "workflow_id"),
    workflowStepId: readNullableString(row, "workflow_step_id"),
    externalWorkId: readNullableString(row, "external_work_id"),
    externalWorkActionId: readNullableString(row, "external_work_action_id"),
    approvalId: readNullableString(row, "approval_id"),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    proofArtifactIds: parseJsonStringArray(readString(row, "proof_artifact_ids_json")),
    dependencyIds: [...dependencyIds],
    claim,
    attemptCount: readNumber(row, "attempt_count"),
    retryBudget: readNumber(row, "retry_budget"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    completedAt: readNullableString(row, "completed_at"),
    failedAt: readNullableString(row, "failed_at"),
    failureReason: readNullableString(row, "failure_reason"),
  });
}

function mapWorkItemClaim(row: Record<string, SQLOutputValue>, now?: string): WorkItemClaim | undefined {
  const ownerId = readNullableString(row, "claim_owner_id");
  const token = readNullableString(row, "claim_token");
  const claimedAt = readNullableString(row, "claimed_at");
  const heartbeatAt = readNullableString(row, "heartbeat_at");
  const expiresAt = readNullableString(row, "claim_expires_at");
  if (!ownerId || !token || !claimedAt || !heartbeatAt || !expiresAt) {
    return undefined;
  }
  if (now && expiresAt <= now) {
    return undefined;
  }
  return { ownerId, token, claimedAt, heartbeatAt, expiresAt };
}

function mapExternalWorkSchedulerState(row: Record<string, SQLOutputValue>): ExternalWorkSchedulerState {
  return omitUndefined({
    externalWorkId: readString(row, "external_work_id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    subjectKey: readString(row, "subject_key"),
    sourceKey: readString(row, "source_key"),
    workflowId: readString(row, "workflow_id"),
    workflowStepId: readString(row, "workflow_step_id"),
    schedulerStatus: readString(row, "scheduler_status") as ExternalWorkSchedulerState["schedulerStatus"],
    attemptCount: readNumber(row, "attempt_count"),
    lastAttemptAt: readNullableString(row, "last_attempt_at"),
    nextAttemptAt: readNullableString(row, "next_attempt_at"),
    maxRetryBackoffMs: readNumber(row, "max_retry_backoff_ms"),
    lastErrorCode: readNullableString(row, "last_error_code"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
    workspacePath: readNullableString(row, "workspace_path"),
    workspaceMode: readNullableString(row, "workspace_mode") as ExternalWorkSchedulerState["workspaceMode"],
    hookArtifactIds: parseJsonStringArray(readString(row, "hook_artifact_ids_json")),
    lastReconciledAt: readNullableString(row, "last_reconciled_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapExternalWorkAction(row: Record<string, SQLOutputValue>): ExternalWorkAction {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    externalWorkId: readString(row, "external_work_id"),
    sourceKind: readString(row, "source_kind") as ExternalWorkAction["sourceKind"],
    actionKind: readString(row, "action_kind") as ExternalWorkAction["actionKind"],
    status: readString(row, "status") as ExternalWorkAction["status"],
    approvalId: readNullableString(row, "approval_id"),
    idempotencyKey: readString(row, "idempotency_key"),
    target: parseJsonObject(readString(row, "target_json")) as unknown as ExternalWorkAction["target"],
    payload: parseJsonObject(readString(row, "payload_json")) as unknown as ExternalWorkAction["payload"],
    approvalRequirement: readString(row, "approval_requirement") as ExternalWorkAction["approvalRequirement"],
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    executionAttemptCount: readNumber(row, "execution_attempt_count"),
    lastAttemptAt: readNullableString(row, "last_attempt_at"),
    nextAttemptAt: readNullableString(row, "next_attempt_at"),
    lastErrorCode: readNullableString(row, "last_error_code"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    executedAt: readNullableString(row, "executed_at"),
  });
}

function mapExternalWorkCiTriage(row: Record<string, SQLOutputValue>): ExternalWorkCiTriageRecord {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    externalWorkId: readString(row, "external_work_id"),
    sourceKind: readString(row, "source_kind") as ExternalWorkCiTriageRecord["sourceKind"],
    repository: readString(row, "repository"),
    subjectKind: readString(row, "subject_kind") as ExternalWorkCiTriageRecord["subjectKind"],
    subjectNumber: readNumber(row, "subject_number"),
    headSha: readString(row, "head_sha"),
    failureKey: readString(row, "failure_key"),
    status: readString(row, "status") as ExternalWorkCiTriageRecord["status"],
    checkName: readString(row, "check_name"),
    workflowName: readNullableString(row, "workflow_name"),
    jobName: readNullableString(row, "job_name"),
    conclusion: readString(row, "conclusion") as ExternalWorkCiTriageRecord["conclusion"],
    htmlUrl: readNullableString(row, "html_url"),
    firstFailingCommand: readNullableString(row, "first_failing_command"),
    reproductionCommand: readNullableString(row, "reproduction_command"),
    suspectedSourcePath: readNullableString(row, "suspected_source_path"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    failure: parseJsonObject(readString(row, "failure_json")) as unknown as ExternalWorkCiTriageRecord["failure"],
    lastErrorCode: readNullableString(row, "last_error_code"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapMediaJob(row: Record<string, SQLOutputValue>): MediaJob {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    providerPresetId: readString(row, "provider_preset_id"),
    operation: readString(row, "operation") as MediaJob["operation"],
    prompt: readString(row, "prompt"),
    input: parseJsonObject(readString(row, "input_json")),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    status: readString(row, "status") as MediaJobStatus,
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapStateTransitionEvent(row: Record<string, SQLOutputValue>): StateTransitionEvent {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    entityType: readString(row, "entity_type") as StateEntityType,
    entityId: readString(row, "entity_id"),
    fromStatus: readString(row, "from_status"),
    toStatus: readString(row, "to_status"),
    event: readString(row, "event"),
    actor: readString(row, "actor") as StateTransitionActor,
    reason: readNullableString(row, "reason"),
    idempotencyKey: readNullableString(row, "idempotency_key"),
    createdAt: readString(row, "created_at"),
  });
}

function mapWorkUnit(row: Record<string, SQLOutputValue>): WorkUnit {
  const runnerId = normalizeStoredRunnerId(readNullableString(row, "runner_id"));
  const requestedRunnerId = normalizeStoredRunnerId(readNullableString(row, "requested_runner_id"));
  const effectiveRunnerId = normalizeStoredRunnerId(readNullableString(row, "effective_runner_id") ?? runnerId);
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    kind: readString(row, "kind") as WorkUnitKind,
    ownerType: readString(row, "owner_type"),
    ownerId: readString(row, "owner_id"),
    channelId: readNullableString(row, "channel_id"),
    taskId: readNullableString(row, "task_id"),
    teammateId: readNullableString(row, "teammate_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    runnerId,
    requestedRunnerId,
    effectiveRunnerId,
    fallbackReason: parseOptionalRunnerFallbackReason(readNullableString(row, "runner_fallback_reason_json")),
    idempotencyKey: readString(row, "idempotency_key"),
    status: readString(row, "status") as WorkUnitStatus,
    priority: readNumber(row, "priority"),
    attemptCount: readNumber(row, "attempt_count"),
    activeAttemptId: readNullableString(row, "active_attempt_id"),
    createdByClientId: readNullableString(row, "created_by_client_id"),
    createdByActor: readString(row, "created_by_actor") as WorkUnit["createdByActor"],
    request: parseJson(readString(row, "request_json")),
    timeoutPolicy: parseRuntimeTimeoutPolicy(readString(row, "timeout_policy_json")),
    linkedRunId: readNullableString(row, "linked_run_id"),
    linkedMessageId: readNullableString(row, "linked_message_id"),
    linkedMediaJobId: readNullableString(row, "linked_media_job_id"),
    linkedExternalWorkId: readNullableString(row, "linked_external_work_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    startedAt: readNullableString(row, "started_at"),
    endedAt: readNullableString(row, "ended_at"),
    lastEventAt: readNullableString(row, "last_event_at"),
    lastHeartbeatAt: readNullableString(row, "last_heartbeat_at"),
    errorCode: readNullableString(row, "error_code"),
    errorMessage: readNullableString(row, "error_message"),
  });
}

function mapWorkUnitAttempt(row: Record<string, SQLOutputValue>): WorkUnitAttempt {
  const runnerId = normalizeStoredRunnerId(readString(row, "runner_id")) ?? readString(row, "runner_id");
  const requestedRunnerId = normalizeStoredRunnerId(readNullableString(row, "requested_runner_id"));
  const effectiveRunnerId = normalizeStoredRunnerId(readNullableString(row, "effective_runner_id") ?? runnerId) ?? runnerId;
  return omitUndefined({
    id: readString(row, "id"),
    workUnitId: readString(row, "work_unit_id"),
    attemptNumber: readNumber(row, "attempt_number"),
    runtimeInstanceId: readString(row, "runtime_instance_id"),
    runnerId,
    requestedRunnerId,
    effectiveRunnerId,
    fallbackReason: parseOptionalRunnerFallbackReason(readNullableString(row, "runner_fallback_reason_json")),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    status: readString(row, "status") as WorkUnitAttemptStatus,
    createdAt: readString(row, "created_at"),
    startedAt: readNullableString(row, "started_at"),
    endedAt: readNullableString(row, "ended_at"),
    lastEventAt: readNullableString(row, "last_event_at"),
    lastHeartbeatAt: readNullableString(row, "last_heartbeat_at"),
    abortRequestedAt: readNullableString(row, "abort_requested_at"),
    errorCode: readNullableString(row, "error_code"),
    errorMessage: readNullableString(row, "error_message"),
  });
}

function mapRuntimeEvent(row: Record<string, SQLOutputValue>): RuntimeEvent {
  return omitUndefined({
    id: readString(row, "id"),
    workUnitId: readString(row, "work_unit_id"),
    attemptId: readNullableString(row, "attempt_id"),
    seq: readNumber(row, "seq"),
    ts: readString(row, "ts"),
    type: readString(row, "type") as RuntimeEventType,
    actor: readString(row, "actor") as RuntimeEvent["actor"],
    data: parseJson(readString(row, "data_json")),
  });
}

function mapRuntimeSemaphoreSlot(row: Record<string, SQLOutputValue>): RuntimeSemaphoreSlot {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    resourceType: readString(row, "resource_type") as RuntimeSemaphoreResourceType,
    resourceKey: readString(row, "resource_key"),
    ownerType: readString(row, "owner_type") as RuntimeSemaphoreSlot["ownerType"],
    ownerId: readString(row, "owner_id"),
    workUnitId: readString(row, "work_unit_id"),
    attemptId: readString(row, "attempt_id"),
    status: readString(row, "status") as RuntimeSemaphoreSlotStatus,
    acquiredAt: readString(row, "acquired_at"),
    lastRenewedAt: readString(row, "last_renewed_at"),
    expiresAt: readString(row, "expires_at"),
    releasedAt: readNullableString(row, "released_at"),
    releaseReason: readNullableString(row, "release_reason"),
  });
}

function mapResourceLease(row: Record<string, SQLOutputValue>): ResourceLease {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    resourceType: readString(row, "resource_type") as ResourceLease["resourceType"],
    resourceKey: readString(row, "resource_key"),
    ownerType: readString(row, "owner_type") as ResourceLease["ownerType"],
    ownerId: readString(row, "owner_id"),
    status: readString(row, "status") as ResourceLeaseStatus,
    acquiredAt: readString(row, "acquired_at"),
    expiresAt: readString(row, "expires_at"),
    lastRenewedAt: readNullableString(row, "last_renewed_at"),
    releasedAt: readNullableString(row, "released_at"),
    releaseReason: readNullableString(row, "release_reason"),
    workUnitId: readNullableString(row, "work_unit_id"),
    attemptId: readNullableString(row, "attempt_id"),
  });
}

function mapControlPlaneEvent(row: Record<string, SQLOutputValue>): ControlPlaneEvent {
  return {
    seq: readNumber(row, "seq"),
    workspaceId: readString(row, "workspace_id"),
    cwd: readString(row, "cwd"),
    ts: readString(row, "ts"),
    domain: readString(row, "domain") as ControlPlaneDomain,
    entityType: readString(row, "entity_type"),
    entityId: readString(row, "entity_id"),
    action: readString(row, "action"),
    data: parseJsonObject(readString(row, "data_json")),
  };
}

function parseApprovalToolDecisions(value: string): ApprovalToolDecisions {
  const parsed = parseJsonObject(value);
  const decisions: Record<RunTool, ApprovalToolDecision> = { ...defaultApprovalToolDecisions };
  for (const tool of Object.keys(defaultApprovalToolDecisions) as RunTool[]) {
    const decision = parsed[tool];
    if (decision === "allow" || decision === "ask" || decision === "deny") {
      decisions[tool] = decision;
    }
  }
  return decisions;
}

function parseChannelRuntimePolicy(value: string): ChannelRuntimePolicy {
  const parsed = parseJsonObject(value);
  return normalizeChannelRuntimePolicy({
    maxConcurrentRuns: typeof parsed.maxConcurrentRuns === "number" ? parsed.maxConcurrentRuns : undefined,
    executionMode: parsed.executionMode === "parallel" ? "parallel" : parsed.executionMode === "serial" ? "serial" : undefined,
    writeLockScope:
      parsed.writeLockScope === "channel" || parsed.writeLockScope === "boundPath" || parsed.writeLockScope === "workspace"
        ? parsed.writeLockScope
        : undefined,
    allowReadOnlyParallel: typeof parsed.allowReadOnlyParallel === "boolean" ? parsed.allowReadOnlyParallel : undefined,
    queueOnConflict: typeof parsed.queueOnConflict === "boolean" ? parsed.queueOnConflict : undefined,
  });
}

function parseNullableChannelWorkspaceBinding(value: string | undefined): ChannelWorkspaceBinding | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseJsonObject(value);
  return normalizeChannelWorkspaceBinding(parsed);
}

function normalizeChannelWorkspaceBinding(value: Record<string, unknown>): ChannelWorkspaceBinding | undefined {
  const mode = value.mode;
  if (mode !== "local" && mode !== "managed_worktree" && mode !== "external_path") {
    return undefined;
  }
  const normalizedMode: ChannelWorkspaceBinding["mode"] = mode;
  const status = value.status;
  const normalizedStatus: ChannelWorkspaceBinding["status"] =
    status === "ready" || status === "not_created" || status === "missing" || status === "unsupported" || status === "blocked"
      ? status
      : normalizedMode === "local" || normalizedMode === "external_path" ? "ready" : "not_created";
  return omitUndefined({
    mode: normalizedMode,
    status: normalizedStatus,
    executionPath: typeof value.executionPath === "string" && value.executionPath.trim() ? value.executionPath : undefined,
    worktreePath: typeof value.worktreePath === "string" && value.worktreePath.trim() ? value.worktreePath : undefined,
    branchName: typeof value.branchName === "string" && value.branchName.trim() ? value.branchName : undefined,
    baseBranch: typeof value.baseBranch === "string" && value.baseBranch.trim() ? value.baseBranch : undefined,
    baseCommit: typeof value.baseCommit === "string" && value.baseCommit.trim() ? value.baseCommit : undefined,
    errorMessage: typeof value.errorMessage === "string" && value.errorMessage.trim() ? value.errorMessage : undefined,
    createdAt: typeof value.createdAt === "string" && value.createdAt.trim() ? value.createdAt : undefined,
    checkedAt: typeof value.checkedAt === "string" && value.checkedAt.trim() ? value.checkedAt : undefined,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt : new Date().toISOString(),
  });
}

function createDefaultWorkspaceSettings(now: string): WorkspaceSettings {
  return {
    schemaVersion: 1,
    updatedAt: now,
  };
}

function parseOptionalResponseLanguage(value: unknown): ResponseLanguage | undefined {
  return value === "zh-CN" || value === "en-US" ? value : undefined;
}

function parseOptionalResponseLanguagePreference(value: unknown): ResponseLanguagePreference | undefined {
  return value === "follow_user" || value === "zh-CN" || value === "en-US" ? value : undefined;
}

function parseOptionalChannelResponseLanguage(value: unknown): ChannelResponseLanguage | undefined {
  return value === "workspace" || value === "follow_user" || value === "zh-CN" || value === "en-US" ? value : undefined;
}

function parseWorkspaceSettings(value: string, updatedAt: string): WorkspaceSettings {
  const parsed = parseJsonObject(value);
  const parsedTheme: WorkspaceSettings["theme"] =
    parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system" ? parsed.theme : undefined;
  return omitUndefined({
    schemaVersion: 1 as const,
    workspaceCwd: typeof parsed.workspaceCwd === "string" && parsed.workspaceCwd.trim() ? parsed.workspaceCwd : undefined,
    theme: parsedTheme,
    locale: typeof parsed.locale === "string" && parsed.locale.trim() ? parsed.locale : undefined,
    responseLanguage: parseOptionalResponseLanguagePreference(parsed.responseLanguage),
    channelNotifications: parseOptionalStringRecord(parsed.channelNotifications),
    channelActivityViews: parseOptionalUnknownRecord(parsed.channelActivityViews),
    updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : updatedAt,
  });
}

function parseOptionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      result[key] = entryValue;
    }
  }
  return result;
}

function parseOptionalUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseRuntimeTimeoutPolicy(value: string): RuntimeTimeoutPolicy {
  try {
    const parsed = parseJsonObject(value);
    return {
      heartbeatIntervalMs: readRuntimePolicyNumber(parsed.heartbeatIntervalMs, defaultRuntimeTimeoutPolicy.heartbeatIntervalMs),
      heartbeatTimeoutMs: readRuntimePolicyNumber(parsed.heartbeatTimeoutMs, defaultRuntimeTimeoutPolicy.heartbeatTimeoutMs),
      idleTimeoutMs: readRuntimePolicyNumber(parsed.idleTimeoutMs, defaultRuntimeTimeoutPolicy.idleTimeoutMs),
      hardTimeoutMs: readRuntimePolicyNumber(parsed.hardTimeoutMs, defaultRuntimeTimeoutPolicy.hardTimeoutMs),
      cancelGraceMs: readRuntimePolicyNumber(parsed.cancelGraceMs, defaultRuntimeTimeoutPolicy.cancelGraceMs),
    };
  } catch {
    return defaultRuntimeTimeoutPolicy;
  }
}

function readRuntimePolicyNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function channelSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      name,
      status,
      bound_path,
      default_provider_preset_id,
      default_teammate_id,
      auto_reply_mode,
      response_language,
      allowed_tools_json,
      runtime_policy_json,
      workspace_binding_json,
      created_at,
      updated_at
    FROM channels
    ${whereClause}
  `;
}

function stateTransitionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      entity_type,
      entity_id,
      from_status,
      to_status,
      event,
      actor,
      reason,
      idempotency_key,
      created_at
    FROM state_transition_events
    ${whereClause}
  `;
}

function resourceLeaseSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      resource_type,
      resource_key,
      owner_type,
      owner_id,
      status,
      acquired_at,
      expires_at,
      last_renewed_at,
      released_at,
      release_reason,
      work_unit_id,
      attempt_id
    FROM resource_leases
    ${whereClause}
  `;
}

function workUnitSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      kind,
      owner_type,
      owner_id,
      channel_id,
      task_id,
      teammate_id,
      provider_preset_id,
      runner_id,
      requested_runner_id,
      effective_runner_id,
      runner_fallback_reason_json,
      idempotency_key,
      status,
      priority,
      attempt_count,
      active_attempt_id,
      created_by_client_id,
      created_by_actor,
      request_json,
      timeout_policy_json,
      linked_run_id,
      linked_message_id,
      linked_media_job_id,
      linked_external_work_id,
      created_at,
      updated_at,
      started_at,
      ended_at,
      last_event_at,
      last_heartbeat_at,
      error_code,
      error_message
    FROM work_units
    ${whereClause}
  `;
}

function controlPlaneEventSelectSql(whereClause: string): string {
  return `
    SELECT
      seq,
      workspace_id,
      cwd,
      ts,
      domain,
      entity_type,
      entity_id,
      action,
      data_json
    FROM control_plane_events
    ${whereClause}
  `;
}

function workUnitAttemptSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      work_unit_id,
      attempt_number,
      runtime_instance_id,
      runner_id,
      requested_runner_id,
      effective_runner_id,
      runner_fallback_reason_json,
      provider_preset_id,
      status,
      created_at,
      started_at,
      ended_at,
      last_event_at,
      last_heartbeat_at,
      abort_requested_at,
      error_code,
      error_message
    FROM work_unit_attempts
    ${whereClause}
  `;
}

function runtimeEventSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      work_unit_id,
      attempt_id,
      seq,
      ts,
      type,
      actor,
      data_json
    FROM runtime_events
    ${whereClause}
  `;
}

function runtimeSemaphoreSlotSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      resource_type,
      resource_key,
      owner_type,
      owner_id,
      work_unit_id,
      attempt_id,
      status,
      acquired_at,
      last_renewed_at,
      expires_at,
      released_at,
      release_reason
    FROM runtime_semaphore_slots
    ${whereClause}
  `;
}

function taskSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      title,
      prompt,
      status,
      assignee_teammate_id,
      requested_skill_id,
      current_run_id,
      created_at,
      updated_at
    FROM tasks
    ${whereClause}
  `;
}

function aiTeammateSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      template_id,
      role_key,
      display_name,
      description,
      avatar_tone,
      avatar_image_attachment_id,
      provider_preset_id,
      runner_id,
      system_prompt,
      append_system_prompt_json,
      allowed_tools_json,
      approval_profile_json,
      status,
      pinned,
      hidden,
      created_at,
      updated_at
    FROM ai_teammates
    ${whereClause}
  `;
}

function teammateChannelMembershipSelectSql(whereClause: string): string {
  return `
    SELECT
      teammate_id,
      channel_id,
      is_default,
      created_at,
      updated_at
    FROM teammate_channel_memberships
    ${whereClause}
  `;
}

function teammateSkillBindingSelectSql(whereClause: string): string {
  return `
    SELECT
      teammate_id,
      skill_id,
      source,
      enabled,
      created_at,
      updated_at
    FROM teammate_skill_bindings
    ${whereClause}
  `;
}

function skillRegistryEntrySelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      pack_id,
      source,
      source_path,
      version,
      checksum,
      definition_json,
      visibility_json,
      review_status,
      created_at,
      updated_at
    FROM skill_definitions
    ${whereClause}
  `;
}

function skillImportDraftSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      source,
      source_path,
      draft_json,
      warnings_json,
      created_at,
      updated_at
    FROM skill_import_drafts
    ${whereClause}
  `;
}

function teammateMemoryScopeSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      teammate_id,
      kind,
      channel_id,
      enabled,
      created_at,
      updated_at
    FROM teammate_memory_scopes
    ${whereClause}
  `;
}

function memoryObjectSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      scope_type,
      owner_id,
      title,
      body,
      tags_json,
      source_refs_json,
      review_state,
      enabled,
      sensitivity,
      verify_before_use,
      retrieval_provider_id,
      retrieval_handle,
      created_by,
      created_at,
      updated_at,
      last_used_at
    FROM memory_objects
    ${whereClause}
  `;
}

function memorySelfImprovingMetadataSelectSql(whereClause: string): string {
  return `
    SELECT
      memory_id,
      kind,
      trigger,
      lesson,
      use_when_json,
      do_not_use_when_json,
      valid_until,
      last_seen_at,
      evidence_count,
      superseded_by,
      last_used_at,
      use_count
    FROM memory_self_improving_metadata
    ${whereClause}
  `;
}

function memoryConsolidationJobSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      kind,
      source_refs_json,
      status,
      created_candidate_ids_json,
      error_message,
      created_at,
      updated_at
    FROM memory_consolidation_jobs
    ${whereClause}
  `;
}

function memoryUsedEventSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      memory_ids_json,
      intent,
      recall_query,
      teammate_id,
      channel_id,
      task_id,
      run_id,
      response_id,
      policy_version,
      created_at
    FROM memory_used_events
    ${whereClause}
  `;
}

function memoryReviewDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      memory_id,
      outcome,
      mode,
      reason_code,
      reason,
      confidence,
      requires_manual_review,
      quarantine_reason,
      target_review_state,
      target_sensitivity,
      source_refs_json,
      decided_by,
      created_at
    FROM memory_review_decisions
    ${whereClause}
  `;
}

function teammateDirectThreadSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      teammate_id,
      title,
      created_at,
      updated_at
    FROM teammate_direct_threads
    ${whereClause}
  `;
}

function teammateDirectMessageSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      thread_id,
      teammate_id,
      author_type,
      author_id,
      body,
      attachment_ids_json,
      status,
      error_message,
      linked_task_id,
      linked_run_id,
      created_at,
      updated_at
    FROM teammate_direct_messages
    ${whereClause}
  `;
}

function teammateDirectReplyInterventionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      teammate_id,
      thread_id,
      source_message_id,
      source_work_unit_id,
      mode,
      status,
      instruction,
      idempotency_key,
      requested_by,
      continuation_message_id,
      continuation_work_unit_id,
      created_at,
      updated_at,
      started_at,
      completed_at,
      failure_reason
    FROM teammate_direct_reply_interventions
    ${whereClause}
  `;
}

function teammatePrivateAttachmentSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      teammate_id,
      thread_id,
      message_id,
      scope,
      kind,
      file_name,
      content_type,
      size_bytes,
      path,
      created_at
    FROM teammate_private_attachments
    ${whereClause}
  `;
}

function channelMessageSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      thread_id,
      kind,
      intent,
      author_type,
      author_id,
      body,
      mentions_json,
      attachment_ids_json,
      link_preview_ids_json,
      linked_task_id,
      linked_run_id,
      status,
      error_message,
      created_at,
      updated_at
    FROM channel_messages
    ${whereClause}
  `;
}

function channelMessageRouteDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      schema_version,
      workspace_id,
      channel_id,
      source_message_id,
      reply_message_id,
      mode,
      action,
      selected_teammate_id,
      selected_provider_preset_id,
      confidence,
      reason,
      alternatives_json,
      status,
      created_by,
      error_message,
      created_at,
      updated_at
    FROM channel_message_route_decisions
    ${whereClause}
  `;
}

function channelIntentDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      schema_version,
      id,
      workspace_id,
      channel_id,
      source_message_id,
      action,
      selected_teammate_id,
      selected_teammate_ids_json,
      proposal_id,
      reply_message_id,
      reply_message_ids_json,
      workflow_id,
      reason,
      status,
      created_by,
      error_message,
      created_at,
      updated_at
    FROM channel_intent_decisions
    ${whereClause}
  `;
}

function channelExecutionProposalSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_message_id,
      proposed_by_teammate_id,
      title,
      prompt,
      assignee_teammate_id,
      acceptance_criteria_json,
      collaboration_steps_json,
      required_tools_json,
      risk_summary,
      response_language,
      status,
      linked_task_id,
      linked_run_id,
      linked_workflow_id,
      error_message,
      created_at,
      updated_at
    FROM channel_execution_proposals
    ${whereClause}
  `;
}

function channelAttachmentSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      message_id,
      kind,
      file_name,
      content_type,
      size_bytes,
      path,
      created_at
    FROM channel_attachments
    ${whereClause}
  `;
}

function channelLinkPreviewSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      message_id,
      url,
      normalized_url,
      title,
      description,
      image_url,
      site_name,
      status,
      error_message,
      created_at,
      updated_at
    FROM channel_link_previews
    ${whereClause}
  `;
}

function channelBriefSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      objective,
      scope,
      acceptance_criteria_json,
      open_questions_json,
      risks_json,
      decision_ids_json,
      attachment_ids_json,
      link_preview_ids_json,
      updated_by,
      created_at,
      updated_at
    FROM channel_briefs
    ${whereClause}
  `;
}

function channelDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_message_id,
      source_task_id,
      source_run_id,
      title,
      decision,
      rationale,
      alternatives_json,
      status,
      supersedes_decision_id,
      created_by,
      created_at,
      updated_at
    FROM channel_decisions
    ${whereClause}
  `;
}

function channelHandoffSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_message_id,
      source_task_id,
      source_run_id,
      from_participant_id,
      from_participant_label,
      to_participant_id,
      to_participant_label,
      reason,
      required_input,
      expected_output,
      status,
      created_by,
      created_at,
      updated_at
    FROM channel_handoffs
    ${whereClause}
  `;
}

function workflowHandoffIntentSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      workflow_id,
      source_workflow_step_id,
      source_run_id,
      source_message_id,
      channel_handoff_id,
      from_participant_id,
      from_participant_label,
      to_participant_id,
      to_participant_label,
      reason,
      required_input,
      expected_output,
      risk_summary,
      source_refs_json,
      status,
      validation_json,
      created_by,
      created_at,
      updated_at
    FROM workflow_handoff_intents
    ${whereClause}
  `;
}

function workflowSelectorDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      workflow_id,
      source_workflow_step_id,
      selector_node_id,
      target_kind,
      selected_workflow_step_id,
      selected_graph_node_id,
      selected_teammate_id,
      selected_skill_id,
      selected_handoff_intent_id,
      reason,
      alternatives_json,
      confidence,
      requires_user_confirmation,
      status,
      source_refs_json,
      created_by,
      created_at,
      updated_at
    FROM workflow_selector_decisions
    ${whereClause}
  `;
}

function channelContextSummarySelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      target_type,
      target_id,
      source_message_ids_json,
      decision_ids_json,
      summary,
      acceptance_criteria_json,
      open_questions_json,
      author_type,
      author_id,
      created_at,
      updated_at
    FROM channel_context_summaries
    ${whereClause}
  `;
}

function channelWorkflowSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_handoff_id,
      title,
      objective,
      status,
      created_by,
      metadata_json,
      created_at,
      updated_at
    FROM channel_workflows
    ${whereClause}
  `;
}

function channelWorkflowStepSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      workflow_id,
      source_handoff_id,
      context_summary_id,
      task_id,
      run_id,
      position,
      title,
      prompt,
      to_participant_id,
      to_participant_label,
      status,
      blocker,
      result_summary,
      metadata_json,
      created_at,
      updated_at
    FROM channel_workflow_steps
    ${whereClause}
  `;
}

function providerPresetSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      kind,
      display_name,
      provider_id,
      model,
      api,
      provider_transport,
      base_url,
      api_key_ref,
      headers_json,
      auth_header,
      reasoning,
      input_json,
      context_window,
      max_tokens,
      compat_json,
      capabilities_json,
      enabled,
      last_check_json,
      created_at,
      updated_at
    FROM provider_presets
    ${whereClause}
  `;
}

function approvalRequestSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      run_id,
      task_id,
      media_job_id,
      external_work_action_id,
      workflow_step_id,
      channel_id,
      tool_call_id,
      action_type,
      risk,
      title,
      description,
      payload_json,
      status,
      created_at,
      expires_at,
      resolved_at,
      resolved_by,
      decision_reason
    FROM approval_requests
    ${whereClause}
  `;
}

function mcpServerSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      display_name,
      transport_json,
      enabled,
      required,
      status_json,
      startup_timeout_sec,
      tool_timeout_sec,
      enabled_tools_json,
      disabled_tools_json,
      created_at,
      updated_at
    FROM mcp_servers
    ${whereClause}
  `;
}

function mcpToolSelectSql(whereClause: string): string {
  return `
    SELECT
      server_id,
      raw_name,
      display_name,
      description,
      input_schema_json,
      callable_namespace,
      callable_name,
      side_effect_level,
      default_approval,
      enabled,
      first_seen_at,
      last_seen_at,
      updated_at
    FROM mcp_tools
    ${whereClause}
  `;
}

function teammateMcpBindingSelectSql(whereClause: string): string {
  return `
    SELECT
      teammate_id,
      server_id,
      mode,
      selected_tool_names_json,
      approval_overrides_json,
      enabled,
      created_at,
      updated_at
    FROM teammate_mcp_bindings
    ${whereClause}
  `;
}

function managedPluginSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      source_kind,
      version,
      enabled,
      disabled_reason,
      descriptor_json,
      created_at,
      updated_at
    FROM managed_plugins
    ${whereClause}
  `;
}

function managedPluginContributionSelectSql(whereClause: string): string {
  return `
    SELECT
      plugin_id,
      contribution_kind,
      contribution_id,
      linked_resource_id,
      enabled,
      created_at,
      updated_at
    FROM managed_plugin_contributions
    ${whereClause}
  `;
}

function managedPluginEventSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      plugin_id,
      type,
      actor,
      message,
      data_json,
      created_at
    FROM managed_plugin_events
    ${whereClause}
  `;
}

function managedPluginPackageSelectSql(whereClause: string): string {
  return `
    SELECT
      plugin_id,
      source_kind,
      version,
      status,
      cache_ref,
      package_hash,
      manifest_json,
      installed_at,
      updated_at,
      uninstalled_at
    FROM managed_plugin_packages
    ${whereClause}
  `;
}

function managedPluginRuntimeSnapshotSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      run_id,
      cwd,
      plugin_ids_json,
      capabilities_json,
      policy_overlays_json,
      created_at
    FROM managed_plugin_runtime_snapshots
    ${whereClause}
  `;
}

function approvalPolicySelectSql(whereClause: string): string {
  return `
    SELECT
      workspace_id,
      tool_decisions_json,
      allowed_write_paths_json,
      created_at,
      updated_at
    FROM approval_policies
    ${whereClause}
  `;
}

function artifactSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      run_id,
      media_job_id,
      external_work_id,
      type,
      path,
      title,
      content_type,
      size_bytes,
      created_at
    FROM artifacts
    ${whereClause}
  `;
}

function externalWorkSelectSql(whereClause: string): string {
  return `
    SELECT
      ${externalWorkSelectColumnsFromAlias("")}
    FROM external_work_items
    ${whereClause}
  `;
}

function externalWorkSelectColumnsFromAlias(alias: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `
      ${prefix}id,
      ${prefix}workspace_id,
      ${prefix}channel_id,
      ${prefix}source_kind,
      ${prefix}work_item_kind,
      ${prefix}external_id,
      ${prefix}identifier,
      ${prefix}idempotency_key,
      ${prefix}workflow_id,
      ${prefix}workflow_step_id,
      ${prefix}artifact_ids_json,
      ${prefix}item_json,
      ${prefix}created_at,
      ${prefix}updated_at
  `;
}

function workItemSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_type,
      source_id,
      title,
      description,
      status,
      waiting_reason,
      priority,
      labels_json,
      assignee_teammate_id,
      task_id,
      run_id,
      workflow_id,
      workflow_step_id,
      external_work_id,
      external_work_action_id,
      approval_id,
      artifact_ids_json,
      proof_artifact_ids_json,
      claim_owner_id,
      claim_token,
      claimed_at,
      heartbeat_at,
      claim_expires_at,
      attempt_count,
      retry_budget,
      completed_at,
      failed_at,
      failure_reason,
      created_at,
      updated_at
    FROM work_items
    ${whereClause}
  `;
}

function externalWorkSchedulerStateSelectSql(whereClause: string): string {
  return `
    SELECT
      external_work_id,
      workspace_id,
      channel_id,
      subject_key,
      source_key,
      workflow_id,
      workflow_step_id,
      scheduler_status,
      attempt_count,
      last_attempt_at,
      next_attempt_at,
      max_retry_backoff_ms,
      last_error_code,
      last_error_message,
      workspace_path,
      workspace_mode,
      hook_artifact_ids_json,
      last_reconciled_at,
      created_at,
      updated_at
    FROM external_work_scheduler_state
    ${whereClause}
  `;
}

function externalWorkActionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      external_work_id,
      source_kind,
      action_kind,
      status,
      approval_id,
      idempotency_key,
      target_json,
      payload_json,
      approval_requirement,
      artifact_ids_json,
      execution_attempt_count,
      last_attempt_at,
      next_attempt_at,
      last_error_code,
      last_error_message,
      created_at,
      updated_at,
      executed_at
    FROM external_work_actions
    ${whereClause}
  `;
}

function externalWorkCiTriageSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      external_work_id,
      source_kind,
      repository,
      subject_kind,
      subject_number,
      head_sha,
      failure_key,
      status,
      check_name,
      workflow_name,
      job_name,
      conclusion,
      html_url,
      first_failing_command,
      reproduction_command,
      suspected_source_path,
      task_id,
      run_id,
      artifact_ids_json,
      failure_json,
      last_error_code,
      last_error_message,
      created_at,
      updated_at
    FROM external_work_ci_triage
    ${whereClause}
  `;
}

function mediaJobSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      provider_preset_id,
      operation,
      prompt,
      input_json,
      artifact_ids_json,
      status,
      error_message,
      created_at,
      updated_at
    FROM media_jobs
    ${whereClause}
  `;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function createWorkItemClaimToken(): string {
  return `work_item_claim_${randomUUID().replaceAll("-", "")}`;
}

function clampWorkItemLeaseMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 60_000;
  }
  return Math.min(Math.max(Math.trunc(value), 5_000), 15 * 60_000);
}

function automationDraftPayload(draft: AutomationDraft): Record<string, unknown> {
  return omitUndefined({
    title: draft.title,
    description: draft.description,
    kind: draft.kind,
    trigger: draft.trigger,
    target: draft.target,
    promptTemplate: draft.promptTemplate,
    executionPolicy: draft.executionPolicy,
    outputPolicy: draft.outputPolicy,
  });
}

function isAutomationDraftField(value: string): value is AutomationDraftField {
  return (
    value === "title" ||
    value === "kind" ||
    value === "trigger" ||
    value === "target" ||
    value === "promptTemplate" ||
    value === "outputPolicy"
  );
}

function countWhere(database: DatabaseSync, table: string, whereClause: string, params: readonly (string | number)[]): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${whereClause}`).get(...params) as Record<string, SQLOutputValue> | undefined;
  return row ? readNumber(row, "count") : 0;
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON from SQLite: ${message}`);
  }
}

function parseNullableJson(value: string | undefined): unknown {
  return value === undefined ? undefined : parseJson(value);
}

function parseManagedPluginDescriptor(value: string): ManagedPluginDescriptor {
  return parseJson(value) as ManagedPluginDescriptor;
}

function parseManagedPluginHealthSnapshot(value: string): ManagedPluginHealthSnapshot {
  return parseJson(value) as ManagedPluginHealthSnapshot;
}

function parseOptionalRunnerFallbackReason(value: string | undefined): RunnerFallbackReason | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const code = record.code;
  const message = record.message;
  if (
    (code === "missing_requested_runner" ||
      code === "disabled_requested_runner" ||
      code === "unsupported_provider_api" ||
      code === "unsupported_tool") &&
    typeof message === "string"
  ) {
    return { code, message };
  }
  return undefined;
}

function parseOptionalLingThreadMetadata(value: string | undefined): LingThreadMetadata | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.rebuiltAt !== "string") {
    return undefined;
  }
  const pendingApprovalCount = readRequiredNonNegativeIntegerValue(record.pendingApprovalCount);
  const blockedCount = readRequiredNonNegativeIntegerValue(record.blockedCount);
  const failedAttemptCount = readRequiredNonNegativeIntegerValue(record.failedAttemptCount);
  const artifactCount = readRequiredNonNegativeIntegerValue(record.artifactCount);
  if (
    pendingApprovalCount === undefined ||
    blockedCount === undefined ||
    failedAttemptCount === undefined ||
    artifactCount === undefined
  ) {
    return undefined;
  }
  return omitUndefined({
    schemaVersion: 1 as const,
    summary: readOptionalStringValue(record.summary),
    pinnedAt: readOptionalStringValue(record.pinnedAt),
    lastTurnId: readOptionalStringValue(record.lastTurnId),
    lastActivityAt: readOptionalStringValue(record.lastActivityAt),
    pendingApprovalCount,
    blockedCount,
    failedAttemptCount,
    artifactCount,
    latestFailureRunId: readOptionalStringValue(record.latestFailureRunId),
    latestEvidenceArtifactId: readOptionalStringValue(record.latestEvidenceArtifactId),
    rebuiltAt: record.rebuiltAt,
  });
}

function parseOptionalChannelWorkflowStepMetadata(value: string | undefined): ChannelWorkflowStepMetadata | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  return omitUndefined({
    workflowTemplateId: readOptionalStringValue(record.workflowTemplateId),
    templateVersion: readOptionalStringValue(record.templateVersion),
    templateStepId: readOptionalStringValue(record.templateStepId),
    graphId: readOptionalStringValue(record.graphId),
    graphNodeId: readOptionalStringValue(record.graphNodeId),
    dependsOnStepIds: readOptionalStringListValue(record.dependsOnStepIds),
    branchGroupId: readOptionalStringValue(record.branchGroupId),
    joinGroupId: readOptionalStringValue(record.joinGroupId),
    dependencyMode: readOptionalWorkflowStepDependencyModeValue(record.dependencyMode),
    maxParallelSiblings: readOptionalPositiveIntegerValue(record.maxParallelSiblings),
    teammateTemplateId: readOptionalStringValue(record.teammateTemplateId),
    skillId: readOptionalStringValue(record.skillId),
    requestedRunnerId: normalizeStoredRunnerId(readOptionalStringValue(record.requestedRunnerId)),
    effectiveRunnerId: normalizeStoredRunnerId(readOptionalStringValue(record.effectiveRunnerId)),
    providerPresetId: readOptionalStringValue(record.providerPresetId),
    autoStart: typeof record.autoStart === "boolean" ? record.autoStart : undefined,
    approvalGate: parseOptionalApprovalProfileValue(record.approvalGate),
    preStepApprovalId: readOptionalStringValue(record.preStepApprovalId),
    policy: parseOptionalWorkflowStepPolicyValue(record.policy),
    gates: parseOptionalWorkflowStepGateListValue(record.gates),
    fanInPolicy: parseOptionalWorkflowFanInPolicyValue(record.fanInPolicy),
    activeGateStage: readOptionalGateStageValue(record.activeGateStage),
    postStepApprovalId: readOptionalStringValue(record.postStepApprovalId),
    contextArtifactId: readOptionalStringValue(record.contextArtifactId),
    outputArtifactId: readOptionalStringValue(record.outputArtifactId),
    outputArtifactIds: readOptionalStringListValue(record.outputArtifactIds),
    selectorDecisionIds: readOptionalStringListValue(record.selectorDecisionIds),
    handoffIntentIds: readOptionalStringListValue(record.handoffIntentIds),
    fanInSummaryArtifactId: readOptionalStringValue(record.fanInSummaryArtifactId),
    memoryCandidateIds: readOptionalStringListValue(record.memoryCandidateIds),
  });
}

function parseOptionalChannelWorkflowMetadata(value: string | undefined): ChannelWorkflowMetadata | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  return omitUndefined({
    workflowGraphId: readOptionalStringValue(record.workflowGraphId),
    workflowGraphSchemaVersion: readOptionalPositiveIntegerValue(record.workflowGraphSchemaVersion),
    workflowGraphArtifactId: readOptionalStringValue(record.workflowGraphArtifactId),
    termination: parseOptionalWorkflowTerminationPolicyValue(record.termination),
    maxParallelSteps: readOptionalPositiveIntegerValue(record.maxParallelSteps),
    sourceProposalId: readOptionalStringValue(record.sourceProposalId),
    sourceMessageId: readOptionalStringValue(record.sourceMessageId),
    responseLanguage: parseOptionalResponseLanguage(record.responseLanguage),
  });
}

function parseOptionalWorkflowTerminationPolicyValue(value: unknown): ChannelWorkflowMetadata["termination"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const success = record.success;
  const onFailedRequiredNode = record.onFailedRequiredNode;
  const onApprovalDenied = record.onApprovalDenied;
  if (
    (success !== "all_terminal" && success !== "all_required_succeeded") ||
    (onFailedRequiredNode !== "block_for_user" && onFailedRequiredNode !== "fail_workflow") ||
    (onApprovalDenied !== "block_for_user" && onApprovalDenied !== "fail_workflow")
  ) {
    return undefined;
  }
  return omitUndefined({
    success: success as NonNullable<ChannelWorkflowMetadata["termination"]>["success"],
    onFailedRequiredNode: onFailedRequiredNode as NonNullable<ChannelWorkflowMetadata["termination"]>["onFailedRequiredNode"],
    onApprovalDenied: onApprovalDenied as NonNullable<ChannelWorkflowMetadata["termination"]>["onApprovalDenied"],
    maxTicks: readOptionalPositiveIntegerValue(record.maxTicks),
  });
}

function readOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalStringListValue(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;
}

function readOptionalPositiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readRequiredNonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readOptionalWorkflowStepDependencyModeValue(value: unknown): ChannelWorkflowStepMetadata["dependencyMode"] | undefined {
  return value === "all_succeeded" || value === "all_terminal" || value === "any_succeeded" ? value : undefined;
}

function parseOptionalWorkflowStepPolicyValue(value: unknown): WorkflowStepPolicy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const onRunFailed = readWorkflowStepFailurePolicy(record.onRunFailed);
  const onRunCancelled = readWorkflowStepFailurePolicy(record.onRunCancelled);
  const onApprovalDenied = readWorkflowStepFailurePolicy(record.onApprovalDenied);
  if (!onRunFailed || !onRunCancelled || !onApprovalDenied || typeof record.retryable !== "boolean") {
    return undefined;
  }
  return omitUndefined({
    onRunFailed,
    onRunCancelled,
    onApprovalDenied,
    retryable: record.retryable,
    maxRetries: typeof record.maxRetries === "number" && Number.isFinite(record.maxRetries) ? record.maxRetries : undefined,
  });
}

function parseOptionalWorkflowFanInPolicyValue(value: unknown): WorkflowFanInPolicy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const mode = readWorkflowFanInModeValue(record.mode);
  const memoryCandidateScope = readWorkflowFanInMemoryCandidateScopeValue(record.memoryCandidateScope);
  const maxInputArtifacts = readOptionalPositiveIntegerValue(record.maxInputArtifacts);
  if (
    !mode ||
    !memoryCandidateScope ||
    maxInputArtifacts === undefined ||
    typeof record.requireAllBranchesTerminal !== "boolean" ||
    typeof record.includeFailedBranches !== "boolean" ||
    typeof record.createSummaryArtifact !== "boolean" ||
    typeof record.createMemoryCandidates !== "boolean"
  ) {
    return undefined;
  }
  return {
    mode,
    requireAllBranchesTerminal: record.requireAllBranchesTerminal,
    includeFailedBranches: record.includeFailedBranches,
    createSummaryArtifact: record.createSummaryArtifact,
    createMemoryCandidates: record.createMemoryCandidates,
    memoryCandidateScope,
    maxInputArtifacts,
  };
}

function readWorkflowFanInModeValue(value: unknown): WorkflowFanInPolicy["mode"] | undefined {
  return value === "summarize_outputs" || value === "compare_outputs" || value === "collect_checks" || value === "memory_candidates"
    ? value
    : undefined;
}

function readWorkflowFanInMemoryCandidateScopeValue(value: unknown): WorkflowFanInPolicy["memoryCandidateScope"] | undefined {
  return value === "run" || value === "task" || value === "channel" ? value : undefined;
}

function parseOptionalWorkflowStepGateListValue(value: unknown): readonly WorkflowStepGate[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const gates = value
    .map(parseWorkflowStepGateValue)
    .filter((gate): gate is WorkflowStepGate => gate !== undefined);
  return gates.length === value.length ? gates : undefined;
}

function parseWorkflowStepGateValue(value: unknown): WorkflowStepGate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const stage = readOptionalGateStageValue(record.stage);
  const title = readOptionalStringValue(record.title);
  const reason = readOptionalStringValue(record.reason);
  const approvalProfile = parseOptionalApprovalProfileValue(record.approvalProfile);
  if (!stage || !title || !reason || !approvalProfile) {
    return undefined;
  }
  const requiredForStatuses = parseOptionalWorkflowStepStatusListValue(record.requiredForStatuses);
  return omitUndefined({
    stage,
    approvalProfile,
    title,
    reason,
    requiredForStatuses,
  });
}

function readWorkflowStepFailurePolicy(value: unknown): WorkflowStepFailurePolicy | undefined {
  return value === "block_for_user" || value === "fail_workflow" || value === "cancel_workflow" || value === "skip_if_optional"
    ? value
    : undefined;
}

function readOptionalGateStageValue(value: unknown): "pre" | "post" | undefined {
  return value === "pre" || value === "post" ? value : undefined;
}

function parseOptionalWorkflowStepStatusListValue(value: unknown): readonly ChannelWorkflowStepStatus[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every(isChannelWorkflowStepStatusValue) ? value as ChannelWorkflowStepStatus[] : undefined;
}

function isChannelWorkflowStepStatusValue(value: unknown): value is ChannelWorkflowStepStatus {
  return typeof value === "string" && channelWorkflowStepStatuses.includes(value as ChannelWorkflowStepStatus);
}

function parseOptionalApprovalProfileValue(value: unknown): SkillApprovalProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return record.mode === "none" || record.mode === "standard" || record.mode === "strict"
    ? record as unknown as SkillApprovalProfile
    : undefined;
}

function normalizeStoredRunnerId(value: string | undefined): string | undefined {
  return value === "pi-coding-agent" ? "pi" : value;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object from SQLite");
  }
  return parsed as Record<string, unknown>;
}

function parseJsonStringRecord(value: string): Record<string, string> {
  const parsed = parseJsonObject(value);
  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(parsed)) {
    if (typeof entryValue !== "string") {
      throw new Error("Expected JSON string record from SQLite");
    }
    result[key] = entryValue;
  }
  return result;
}

function parseJsonStringArray(value: string): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Expected JSON string array from SQLite");
  }
  return parsed as string[];
}

function parseWorkflowPacketSourceRefs(value: string): WorkflowPacketSourceRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected workflow packet source refs array from SQLite");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Expected workflow packet source ref object from SQLite");
    }
    const record = item as Record<string, unknown>;
    if (!isWorkflowPacketSourceRefTypeValue(record.type) || typeof record.id !== "string") {
      throw new Error("Invalid workflow packet source ref from SQLite");
    }
    return omitUndefined({
      type: record.type,
      id: record.id,
      label: readOptionalStringValue(record.label),
    });
  });
}

function parseWorkflowSelectorAlternatives(value: string): WorkflowSelectorAlternative[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected workflow selector alternatives array from SQLite");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Expected workflow selector alternative object from SQLite");
    }
    const record = item as Record<string, unknown>;
    if (
      !isWorkflowSelectorTargetKindValue(record.targetKind) ||
      typeof record.targetId !== "string" ||
      typeof record.label !== "string" ||
      typeof record.reason !== "string"
    ) {
      throw new Error("Invalid workflow selector alternative from SQLite");
    }
    return {
      targetKind: record.targetKind,
      targetId: record.targetId,
      label: record.label,
      reason: record.reason,
    };
  });
}

function parseChannelMessageRouteAlternatives(value: string): ChannelMessageRouteAlternative[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel message route alternatives array from SQLite");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Expected channel message route alternative object from SQLite");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.label !== "string" || typeof record.reason !== "string") {
      throw new Error("Invalid channel message route alternative from SQLite");
    }
    const score = record.score;
    if (score !== undefined && typeof score !== "number") {
      throw new Error("Invalid channel message route alternative score from SQLite");
    }
    return omitUndefined({
      teammateId: readOptionalStringValue(record.teammateId),
      label: record.label,
      score,
      reason: record.reason,
    });
  });
}

function parseOptionalWorkflowHandoffValidation(value: string | undefined): WorkflowHandoffValidation | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.targetTeammateExists !== "boolean" ||
    typeof record.targetTeammateActive !== "boolean" ||
    typeof record.skillExecutable !== "boolean" ||
    typeof record.providerRunnable !== "boolean" ||
    typeof record.approvalProfileCompatible !== "boolean" ||
    typeof record.resourceLeaseAvailable !== "boolean" ||
    !Array.isArray(record.blockers) ||
    record.blockers.some((item) => typeof item !== "string")
  ) {
    return undefined;
  }
  return {
    targetTeammateExists: record.targetTeammateExists,
    targetTeammateActive: record.targetTeammateActive,
    skillExecutable: record.skillExecutable,
    providerRunnable: record.providerRunnable,
    approvalProfileCompatible: record.approvalProfileCompatible,
    resourceLeaseAvailable: record.resourceLeaseAvailable,
    blockers: record.blockers,
  };
}

function parseNullableJsonStringArray(value: string | undefined): string[] | undefined {
  return value ? parseJsonStringArray(value) : undefined;
}

function parseMcpServerTransport(value: string): McpServerTransport {
  return normalizeMcpServerTransport(parseJson(value) as McpServerTransport);
}

function normalizeMcpServerTransport(transport: McpServerTransport): McpServerTransport {
  if (transport.type === "stdio") {
    if (typeof transport.command !== "string" || transport.command.length === 0) {
      throw new Error("Expected MCP stdio command");
    }
    const secretEnvRefs = { ...(transport.secretEnvRefs ?? {}) };
    validateMcpSecretRefRecord(secretEnvRefs, "MCP stdio secretEnvRefs");
    for (const envName of Object.keys(secretEnvRefs)) {
      if (transport.env?.[envName] !== undefined) {
        throw new Error(`MCP stdio env ${envName} cannot be both static and secret-backed`);
      }
    }
    const normalized = omitUndefined({
      type: "stdio",
      command: transport.command,
      args: [...(transport.args ?? [])],
      env: { ...(transport.env ?? {}) },
      cwd: transport.cwd,
      secretEnvRefs,
      secretEnvNames: transport.secretEnvNames ? [...transport.secretEnvNames] : undefined,
    });
    return normalized as McpServerTransport;
  }
  if (transport.type === "streamable-http") {
    if (typeof transport.url !== "string" || transport.url.length === 0) {
      throw new Error("Expected MCP streamable HTTP URL");
    }
    const secretHeaderRefs = { ...(transport.secretHeaderRefs ?? {}) };
    validateMcpSecretRefRecord(secretHeaderRefs, "MCP HTTP secretHeaderRefs");
    for (const headerName of Object.keys(secretHeaderRefs)) {
      if (transport.headers?.[headerName] !== undefined) {
        throw new Error(`MCP HTTP header ${headerName} cannot be both static and secret-backed`);
      }
    }
    if (transport.bearerTokenRef !== undefined) {
      parseSecretRef(transport.bearerTokenRef);
    }
    const normalized = omitUndefined({
      type: "streamable-http",
      url: transport.url,
      headers: { ...(transport.headers ?? {}) },
      secretHeaderRefs,
      bearerTokenRef: transport.bearerTokenRef,
      bearerTokenEnvVar: transport.bearerTokenEnvVar,
      envHeaders: transport.envHeaders ? { ...transport.envHeaders } : undefined,
      secretHeaderNames: transport.secretHeaderNames ? [...transport.secretHeaderNames] : undefined,
      oauthClientId: transport.oauthClientId,
      oauthResource: transport.oauthResource,
    });
    return normalized as McpServerTransport;
  }
  throw new Error("Expected MCP server transport from SQLite");
}

function validateMcpSecretRefRecord(refs: Readonly<Record<string, string>>, label: string): void {
  for (const [name, ref] of Object.entries(refs)) {
    if (!name.trim()) {
      throw new Error(`${label} keys must be non-empty`);
    }
    parseSecretRef(ref);
  }
}

function parseMcpServerStatus(value: string): McpServerStatus {
  const parsed = parseJsonObject(value);
  if (
    parsed.kind !== "unknown" &&
    parsed.kind !== "checking" &&
    parsed.kind !== "ready" &&
    parsed.kind !== "failed" &&
    parsed.kind !== "disabled"
  ) {
    throw new Error("Expected MCP server status kind from SQLite");
  }
  if (parsed.message !== undefined && typeof parsed.message !== "string") {
    throw new Error("Expected MCP server status message from SQLite");
  }
  if (parsed.checkedAt !== undefined && typeof parsed.checkedAt !== "string") {
    throw new Error("Expected MCP server status checkedAt from SQLite");
  }
  return omitUndefined({
    kind: parsed.kind,
    message: parsed.message,
    checkedAt: parsed.checkedAt,
  }) as McpServerStatus;
}

function parseMcpRuntimeStatusSnapshot(value: string): McpRuntimeStatusSnapshot {
  const parsed = parseJsonObject(value);
  const status = parsed.status;
  if (
    status !== "unknown" &&
    status !== "ready" &&
    status !== "failed" &&
    status !== "disabled" &&
    status !== "expired" &&
    status !== "migration_required"
  ) {
    throw new Error("Expected MCP runtime status snapshot kind from SQLite");
  }
  if (typeof parsed.serverId !== "string") {
    throw new Error("Expected MCP runtime status snapshot serverId from SQLite");
  }
  if (typeof parsed.checkedAt !== "string") {
    throw new Error("Expected MCP runtime status snapshot checkedAt from SQLite");
  }
  if (typeof parsed.expiresAt !== "string") {
    throw new Error("Expected MCP runtime status snapshot expiresAt from SQLite");
  }
  const authStatus = isRecord(parsed.authStatus) ? parsed.authStatus : undefined;
  if (!authStatus) {
    throw new Error("Expected MCP runtime status snapshot authStatus from SQLite");
  }
  const authKind = authStatus.kind;
  if (
    authKind !== "not_required" &&
    authKind !== "configured" &&
    authKind !== "missing" &&
    authKind !== "access_denied" &&
    authKind !== "store_unavailable" &&
    authKind !== "invalid_ref" &&
    authKind !== "migration_required"
  ) {
    throw new Error("Expected MCP runtime status auth kind from SQLite");
  }
  const serverInfo = parsed.serverInfo === undefined ? undefined : parseMcpServerInfo(parsed.serverInfo);
  return omitUndefined({
    serverId: parsed.serverId,
    checkedAt: parsed.checkedAt,
    expiresAt: parsed.expiresAt,
    status,
    serverInfo,
    protocolVersion: typeof parsed.protocolVersion === "string" ? parsed.protocolVersion : undefined,
    toolCount: typeof parsed.toolCount === "number" ? parsed.toolCount : undefined,
    missingSecretRefs: parseUnknownStringArray(parsed.missingSecretRefs, "MCP runtime missingSecretRefs"),
    authStatus: omitUndefined({
      kind: authKind,
      refs: parseUnknownStringArray(authStatus.refs, "MCP runtime auth refs"),
      missingRefs: parseUnknownStringArray(authStatus.missingRefs, "MCP runtime auth missingRefs"),
      message: typeof authStatus.message === "string" ? authStatus.message : undefined,
    }),
    latencyMs: typeof parsed.latencyMs === "number" ? parsed.latencyMs : undefined,
    errorCode: typeof parsed.errorCode === "string" ? parsed.errorCode : undefined,
    message: typeof parsed.message === "string" ? parsed.message : undefined,
  }) as McpRuntimeStatusSnapshot;
}

function parseMcpServerInfo(value: unknown): McpRuntimeStatusSnapshot["serverInfo"] {
  if (!isRecord(value)) {
    throw new Error("Expected MCP runtime serverInfo object from SQLite");
  }
  return omitUndefined({
    name: typeof value.name === "string" ? value.name : undefined,
    version: typeof value.version === "string" ? value.version : undefined,
  });
}

function parseUnknownStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected ${label} to be a string array`);
  }
  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMcpApprovalOverrides(value: string): TeammateMcpBinding["approvalOverrides"] {
  const parsed = parseJsonObject(value);
  const result: Record<string, McpTool["defaultApproval"]> = {};
  for (const [toolName, decision] of Object.entries(parsed)) {
    if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
      throw new Error("Expected MCP approval override decision from SQLite");
    }
    result[toolName] = decision;
  }
  return result;
}

function parseChannelMentions(value: string): ChannelMessage["mentions"] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel mentions array from SQLite");
  }
  return parsed.map((item) => {
    if (!isJsonRecord(item) || typeof item.id !== "string" || typeof item.label !== "string") {
      throw new Error("Expected channel mention from SQLite");
    }
    if (item.kind !== "ai-teammate" && item.kind !== "local-user" && item.kind !== "channel") {
      throw new Error("Expected channel mention kind from SQLite");
    }
    return {
      id: item.id,
      label: item.label,
      kind: item.kind,
    };
  });
}

function parseMemorySourceRefs(value: string): MemorySourceRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected memory source refs array from SQLite");
  }
  return normalizeMemorySourceRefs(parsed);
}

function parseChannelExecutionProposalSteps(value: string): ChannelExecutionProposal["collaborationSteps"] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel execution proposal steps array from SQLite");
  }
  return parsed.map((item) => {
    if (!isJsonRecord(item) || typeof item.teammateId !== "string" || typeof item.summary !== "string") {
      throw new Error("Expected channel execution proposal step from SQLite");
    }
    if (
      item.action !== "coordinated" &&
      item.action !== "consulted" &&
      item.action !== "reviewed" &&
      item.action !== "flagged_risk"
    ) {
      throw new Error("Expected channel execution proposal step action from SQLite");
    }
    return {
      teammateId: item.teammateId,
      action: item.action,
      summary: item.summary,
    };
  });
}

function parseApprovalProfile(value: string): SkillApprovalProfile {
  const parsed = parseJsonObject(value);
  if (parsed.mode !== "none" && parsed.mode !== "standard" && parsed.mode !== "strict") {
    throw new Error("Expected approval profile mode from SQLite");
  }
  return parsed as unknown as SkillApprovalProfile;
}

function parseAutomationTrigger(value: string): AutomationTrigger {
  const parsed = parseJsonObject(value);
  if (parsed.type !== "manual" && parsed.type !== "schedule" && parsed.type !== "monitor") {
    throw new Error("Expected automation trigger from SQLite");
  }
  return parsed as unknown as AutomationTrigger;
}

function parseAutomationTarget(value: string): AutomationTarget {
  const parsed = parseJsonObject(value);
  if (
    parsed.scope !== "workspace" &&
    parsed.scope !== "channel" &&
    parsed.scope !== "task" &&
    parsed.scope !== "thread" &&
    parsed.scope !== "external_work"
  ) {
    throw new Error("Expected automation target from SQLite");
  }
  if (typeof parsed.workspaceId !== "string") {
    throw new Error("Expected automation target workspaceId from SQLite");
  }
  return parsed as unknown as AutomationTarget;
}

function parseAutomationPromptTemplate(value: string): AutomationPromptTemplate {
  const parsed = parseJsonObject(value);
  if (typeof parsed.templateVersion !== "number" || typeof parsed.promptMarkdown !== "string" || !Array.isArray(parsed.contextSelectors)) {
    throw new Error("Expected automation prompt template from SQLite");
  }
  return parsed as unknown as AutomationPromptTemplate;
}

function parseAutomationExecutionPolicy(value: string): AutomationExecutionPolicy {
  return parseJsonObject(value) as unknown as AutomationExecutionPolicy;
}

function parseAutomationOutputPolicy(value: string): AutomationOutputPolicy {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed.destinations) || parsed.artifactFormat !== "markdown") {
    throw new Error("Expected automation output policy from SQLite");
  }
  return parsed as unknown as AutomationOutputPolicy;
}

function normalizeStringList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item.toLowerCase())) {
      continue;
    }
    seen.add(item.toLowerCase());
    normalized.push(item);
  }
  return normalized;
}

function normalizeMemorySourceRefs(values: readonly unknown[]): MemorySourceRef[] {
  return values.map((value, index) => {
    if (!isJsonRecord(value)) {
      throw new Error(`sourceRefs[${index}] must be an object`);
    }
    const type = value.type;
    if (!isMemorySourceType(type)) {
      throw new Error(`sourceRefs[${index}].type is not supported`);
    }
    if (typeof value.id !== "string" || value.id.trim().length === 0) {
      throw new Error(`sourceRefs[${index}].id must be a non-empty string`);
    }
    return omitUndefined({
      type,
      id: value.id.trim(),
      label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : undefined,
      url: typeof value.url === "string" && value.url.trim() ? value.url.trim() : undefined,
    });
  });
}

function ensureMemorySourceRefs(memoryId: string, sourceRefs: readonly MemorySourceRef[]): readonly MemorySourceRef[] {
  if (sourceRefs.length > 0) {
    return sourceRefs;
  }
  return [{ type: "manual", id: memoryId, label: "Manual memory" }];
}

function isMemorySourceType(value: unknown): value is MemorySourceRef["type"] {
  return (
    value === "manual" ||
    value === "message" ||
    value === "decision" ||
    value === "doc" ||
    value === "attachment" ||
    value === "run-event" ||
    value === "artifact" ||
    value === "import"
  );
}

function validateMemoryObject(memory: MemoryObject): void {
  if (!isMemoryScopeType(memory.scopeType)) {
    throw new Error("scopeType is not supported");
  }
  if (!memory.ownerId.trim()) {
    throw new Error("ownerId must be a non-empty string");
  }
  if (!memory.title.trim()) {
    throw new Error("title must be a non-empty string");
  }
  if (!memory.body.trim()) {
    throw new Error("body must be a non-empty string");
  }
  if (!isMemoryReviewState(memory.reviewState)) {
    throw new Error("reviewState is not supported");
  }
  if (!isMemorySensitivity(memory.sensitivity)) {
    throw new Error("sensitivity is not supported");
  }
}

function validateWorkflowHandoffIntent(intent: WorkflowHandoffIntent): void {
  validateNonEmptyString(intent.fromParticipantId, "workflow handoff from participant id");
  validateNonEmptyString(intent.fromParticipantLabel, "workflow handoff from participant label");
  validateNonEmptyString(intent.toParticipantId, "workflow handoff target participant id");
  validateNonEmptyString(intent.reason, "workflow handoff reason");
  validateNonEmptyString(intent.requiredInput, "workflow handoff required input");
  validateNonEmptyString(intent.expectedOutput, "workflow handoff expected output");
  if (!isWorkflowHandoffIntentStatusValue(intent.status)) {
    throw new Error("workflow handoff intent status is not supported");
  }
  if (intent.createdBy !== "local-user" && intent.createdBy !== "ai-teammate" && intent.createdBy !== "orchestrator") {
    throw new Error("workflow handoff intent createdBy is not supported");
  }
  validateWorkflowPacketSourceRefs(intent.sourceRefs);
  if (intent.validation) {
    validateStringList(intent.validation.blockers, "workflow handoff validation blockers");
  }
}

function validateWorkflowSelectorDecision(decision: WorkflowSelectorDecision): void {
  if (!isWorkflowSelectorTargetKindValue(decision.targetKind)) {
    throw new Error("workflow selector target kind is not supported");
  }
  if (!isWorkflowSelectorDecisionStatusValue(decision.status)) {
    throw new Error("workflow selector decision status is not supported");
  }
  if (decision.confidence !== "low" && decision.confidence !== "medium" && decision.confidence !== "high") {
    throw new Error("workflow selector decision confidence is not supported");
  }
  if (decision.createdBy !== "deterministic" && decision.createdBy !== "model" && decision.createdBy !== "local-user") {
    throw new Error("workflow selector decision createdBy is not supported");
  }
  validateNonEmptyString(decision.reason, "workflow selector decision reason");
  validateWorkflowPacketSourceRefs(decision.sourceRefs);
  for (const alternative of decision.alternativesConsidered) {
    if (!isWorkflowSelectorTargetKindValue(alternative.targetKind)) {
      throw new Error("workflow selector alternative target kind is not supported");
    }
    validateNonEmptyString(alternative.targetId, "workflow selector alternative target id");
    validateNonEmptyString(alternative.label, "workflow selector alternative label");
    validateNonEmptyString(alternative.reason, "workflow selector alternative reason");
  }
}

function validateChannelMessageRouteDecisionInput(
  decision: Pick<
    CreateChannelMessageRouteDecisionInput,
    "mode" | "action" | "confidence" | "reason" | "alternativesConsidered" | "status" | "createdBy"
  >,
): void {
  if (!channelAutoReplyModes.includes(decision.mode)) {
    throw new Error("channel message route mode is not supported");
  }
  if (decision.action !== "reply" && decision.action !== "no_reply") {
    throw new Error("channel message route action is not supported");
  }
  if (!channelMessageRouteDecisionStatuses.includes(decision.status)) {
    throw new Error("channel message route status is not supported");
  }
  if (!channelMessageRouteDecisionCreatedByValues.includes(decision.createdBy)) {
    throw new Error("channel message route createdBy is not supported");
  }
  if (decision.confidence !== undefined && (decision.confidence < 0 || decision.confidence > 1)) {
    throw new Error("channel message route confidence must be between 0 and 1");
  }
  validateNonEmptyString(decision.reason, "channel message route reason");
  for (const alternative of decision.alternativesConsidered ?? []) {
    validateNonEmptyString(alternative.label, "channel message route alternative label");
    validateNonEmptyString(alternative.reason, "channel message route alternative reason");
    if (alternative.score !== undefined && (alternative.score < 0 || alternative.score > 1)) {
      throw new Error("channel message route alternative score must be between 0 and 1");
    }
  }
}

function validateChannelIntentDecisionInput(
  decision: Pick<CreateChannelIntentDecisionInput, "action" | "reason" | "status" | "createdBy">,
): void {
  if (!channelIntentDecisionActions.includes(decision.action)) {
    throw new Error("channel intent decision action is not supported");
  }
  if (!channelIntentDecisionStatuses.includes(decision.status)) {
    throw new Error("channel intent decision status is not supported");
  }
  if (!channelIntentDecisionCreatedByValues.includes(decision.createdBy)) {
    throw new Error("channel intent decision createdBy is not supported");
  }
  validateNonEmptyString(decision.reason, "channel intent decision reason");
}

function validateWorkflowPacketSourceRefs(sourceRefs: readonly WorkflowPacketSourceRef[]): void {
  for (const sourceRef of sourceRefs) {
    if (!isWorkflowPacketSourceRefTypeValue(sourceRef.type)) {
      throw new Error("workflow packet source ref type is not supported");
    }
    validateNonEmptyString(sourceRef.id, "workflow packet source ref id");
  }
}

function isWorkflowHandoffIntentStatusValue(value: unknown): value is WorkflowHandoffIntentStatus {
  return value === "proposed" || value === "validated" || value === "accepted" || value === "declined" || value === "converted" || value === "failed";
}

function isWorkflowSelectorDecisionStatusValue(value: unknown): value is WorkflowSelectorDecisionStatus {
  return value === "proposed" || value === "accepted" || value === "rejected" || value === "blocked" || value === "superseded";
}

function isWorkflowSelectorTargetKindValue(value: unknown): value is WorkflowSelectorTargetKind {
  return value === "workflow_step" || value === "graph_node" || value === "teammate" || value === "skill" || value === "handoff" || value === "wait";
}

function isWorkflowPacketSourceRefTypeValue(value: unknown): value is WorkflowPacketSourceRef["type"] {
  return (
    value === "channel_message" ||
    value === "channel_brief" ||
    value === "channel_decision" ||
    value === "context_summary" ||
    value === "task" ||
    value === "run" ||
    value === "workflow" ||
    value === "workflow_step" ||
    value === "workflow_handoff_intent" ||
    value === "workflow_selector_decision" ||
    value === "artifact" ||
    value === "approval" ||
    value === "memory"
  );
}

function validateNonEmptyString(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
}

function validateStringList(value: readonly string[], label: string): void {
  for (const item of value) {
    if (!item.trim()) {
      throw new Error(`${label} must not contain empty strings`);
    }
  }
}

function validateMemorySelfImprovingMetadata(metadata: MemorySelfImprovingMetadata): void {
  if (!metadata.memoryId.trim()) {
    throw new Error("memoryId must be a non-empty string");
  }
  if (!isMemorySelfImprovingKind(metadata.kind)) {
    throw new Error("memory self-improving metadata kind is not supported");
  }
  if (!isMemorySelfImprovingTrigger(metadata.trigger)) {
    throw new Error("memory self-improving metadata trigger is not supported");
  }
  if (!metadata.lesson.trim()) {
    throw new Error("lesson must be a non-empty string");
  }
  if (metadata.evidenceCount < 0 || metadata.useCount < 0) {
    throw new Error("memory self-improving metadata counters must be non-negative");
  }
  if (metadata.supersededBy === metadata.memoryId) {
    throw new Error("supersededBy must not equal memoryId");
  }
}

function validateMemoryConsolidationJob(job: MemoryConsolidationJob): void {
  if (!job.workspaceId.trim()) {
    throw new Error("workspaceId must be a non-empty string");
  }
  if (!isMemoryConsolidationJobKind(job.kind)) {
    throw new Error("memory consolidation job kind is not supported");
  }
  if (!isMemoryConsolidationJobStatus(job.status)) {
    throw new Error("memory consolidation job status is not supported");
  }
}

function validateMemoryReviewPolicy(policy: MemoryReviewPolicy): void {
  if (!policy.workspaceId.trim()) {
    throw new Error("workspaceId must be a non-empty string");
  }
  if (!isMemoryReviewMode(policy.mode)) {
    throw new Error("memory review mode is not supported");
  }
}

function validateMemoryReviewDecision(decision: MemoryReviewDecision): void {
  if (!decision.memoryId.trim()) {
    throw new Error("memoryId must be a non-empty string");
  }
  if (!isMemoryReviewOutcome(decision.outcome)) {
    throw new Error("memory review outcome is not supported");
  }
  if (!isMemoryReviewMode(decision.mode)) {
    throw new Error("memory review mode is not supported");
  }
  if (!isMemoryReviewState(decision.targetReviewState)) {
    throw new Error("targetReviewState is not supported");
  }
  if (!isMemorySensitivity(decision.targetSensitivity)) {
    throw new Error("targetSensitivity is not supported");
  }
  if (decision.confidence !== "low" && decision.confidence !== "medium" && decision.confidence !== "high") {
    throw new Error("memory review confidence is not supported");
  }
  if (decision.decidedBy !== "policy" && decision.decidedBy !== "local-user" && decision.decidedBy !== "system") {
    throw new Error("memory review decision actor is not supported");
  }
}

function validateMemoryReviewActionRecord(action: MemoryReviewActionRecord): void {
  if (!isMemoryReviewAction(action.action)) {
    throw new Error("memory review action is not supported");
  }
  if (!isMemoryReviewState(action.previousReviewState) || !isMemoryReviewState(action.nextReviewState)) {
    throw new Error("memory review action state is not supported");
  }
  if (action.actor !== "local-user" && action.actor !== "system") {
    throw new Error("memory review action actor is not supported");
  }
}

function isMemoryScopeType(value: unknown): value is MemoryScopeType {
  return value === "workspace" || value === "channel" || value === "teammate" || value === "task" || value === "run";
}

function isMemoryConsolidationJobKind(value: unknown): value is MemoryConsolidationJobKind {
  return value === "private_chat_summary" || value === "channel_decision_summary" || value === "task_run_lesson" || value === "workspace_consolidation";
}

function isMemorySelfImprovingKind(value: unknown): value is MemorySelfImprovingKind {
  return (
    value === "correction" ||
    value === "reflection" ||
    value === "workflow_lesson" ||
    value === "tool_routing_lesson" ||
    value === "runtime_recovery_lesson"
  );
}

function isMemorySelfImprovingTrigger(value: unknown): value is MemorySelfImprovingMetadata["trigger"] {
  return value === "manual_review" || value === "promotion" || value === "run_review" || value === "health_review" || value === "import";
}

function isMemoryConsolidationJobStatus(value: unknown): value is MemoryConsolidationJobStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function isMemoryReviewMode(value: unknown): value is MemoryReviewMode {
  return value === "conservative" || value === "balanced" || value === "fast";
}

function isMemoryReviewOutcome(value: unknown): value is MemoryReviewOutcome {
  return value === "auto-active" || value === "auto-candidate" || value === "manual-review" || value === "quarantine";
}

function isMemoryReviewAction(value: unknown): value is MemoryReviewAction {
  return value === "approve" || value === "edit_and_approve" || value === "keep_candidate" || value === "reject" || value === "archive" || value === "quarantine";
}

function isMemoryReviewState(value: unknown): value is MemoryReviewState {
  return value === "candidate" || value === "active" || value === "disabled" || value === "archived" || value === "rejected";
}

function isMemorySensitivity(value: unknown): value is MemorySensitivity {
  return value === "normal" || value === "private" || value === "secret-adjacent";
}

function memoryRecallAllowedScopes(
  input: MemoryRecallRequest,
  workspaceId: string,
): readonly { readonly scopeType: MemoryScopeType; readonly ownerId: string }[] {
  const scopes: Array<{ readonly scopeType: MemoryScopeType; readonly ownerId: string }> = [
    { scopeType: "workspace", ownerId: workspaceId },
  ];
  if (input.channelId) {
    scopes.push({ scopeType: "channel", ownerId: input.channelId });
  }
  if (input.teammateId) {
    scopes.push({ scopeType: "teammate", ownerId: input.teammateId });
  }
  if (input.taskId) {
    scopes.push({ scopeType: "task", ownerId: input.taskId });
  }
  if (input.runId) {
    scopes.push({ scopeType: "run", ownerId: input.runId });
  }
  return scopes;
}

function memoryAllowedForRecall(
  memory: MemoryObject,
  input: MemoryRecallRequest,
  allowedScopes: readonly { readonly scopeType: MemoryScopeType; readonly ownerId: string }[],
): boolean {
  if (!input.includeDisabled && (!memory.enabled || memory.reviewState !== "active")) {
    return false;
  }
  if (!input.includeSecretAdjacent && memory.sensitivity === "secret-adjacent") {
    return false;
  }
  if (
    !input.includePrivate &&
    memory.sensitivity === "private" &&
    input.intent !== "private-chat" &&
    input.intent !== "channel-reply" &&
    input.intent !== "task-run"
  ) {
    return false;
  }
  return allowedScopes.some((scope) => scope.scopeType === memory.scopeType && scope.ownerId === memory.ownerId);
}

function memoryUpdateForReviewAction(input: ApplyMemoryReviewActionInput, existing: MemoryObject): MemoryObjectUpdateInput {
  switch (input.action) {
    case "approve":
      return { reviewState: "active", enabled: true };
    case "edit_and_approve":
      return {
        ...(input.editedMemory ?? {}),
        reviewState: "active",
        enabled: true,
      };
    case "keep_candidate":
      return { reviewState: "candidate", enabled: true };
    case "reject":
      return { reviewState: "rejected", enabled: false };
    case "archive":
      return { reviewState: "archived", enabled: false };
    case "quarantine":
      return {
        reviewState: "disabled",
        enabled: false,
        sensitivity: input.editedMemory?.sensitivity ?? (existing.sensitivity === "secret-adjacent" ? "secret-adjacent" : existing.sensitivity),
      };
  }
}

function summarizeMemorySourceRefs(sourceRefs: readonly MemorySourceRef[]): string {
  if (sourceRefs.length === 0) {
    return "manual";
  }
  return sourceRefs.slice(0, 3).map((ref) => `${ref.type}:${ref.label ?? ref.id}`).join(", ");
}

function recommendMemoryReviewAction(memory: MemoryObject, decision: MemoryReviewDecision | undefined): MemoryReviewAction {
  if (decision?.outcome === "quarantine" || memory.sensitivity === "secret-adjacent") {
    return "quarantine";
  }
  if (decision?.outcome === "manual-review") {
    return "approve";
  }
  return memory.reviewState === "disabled" ? "archive" : "approve";
}

function tokenizeMemoryQuery(query: string): readonly string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return [...new Set(terms)].slice(0, 32);
}

function scoreMemoryForRecall(
  memory: MemoryObject,
  queryTerms: readonly string[],
  requestedTags: ReadonlySet<string>,
): MemoryRecallResult["memories"][number] {
  const title = memory.title.toLowerCase();
  const body = memory.body.toLowerCase();
  const tags = memory.tags.map((tag) => tag.toLowerCase());
  const sourceLabels = memory.sourceRefs
    .map((ref) => [ref.type, ref.id, ref.label, ref.url].filter((item): item is string => typeof item === "string").join(" ").toLowerCase())
    .join(" ");
  const matchedTerms = new Set<string>();
  let score = 0;

  for (const term of queryTerms) {
    if (title.includes(term)) {
      score += 8;
      matchedTerms.add(term);
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += 6;
      matchedTerms.add(term);
    }
    if (sourceLabels.includes(term)) {
      score += 3;
      matchedTerms.add(term);
    }
    if (body.includes(term)) {
      score += 2;
      matchedTerms.add(term);
    }
  }

  for (const tag of requestedTags) {
    if (tags.includes(tag)) {
      score += 10;
      matchedTerms.add(tag);
    }
  }

  if (queryTerms.length === 0 && requestedTags.size === 0) {
    score = 1;
  }

  return {
    memory,
    score,
    matchedTerms: [...matchedTerms],
    excerpt: excerptMemoryBody(memory.body, queryTerms),
  };
}

function excerptMemoryBody(body: string, queryTerms: readonly string[]): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  const lower = normalized.toLowerCase();
  const firstIndex = queryTerms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, firstIndex - 80);
  const excerpt = normalized.slice(start, start + 240);
  return `${start > 0 ? "..." : ""}${excerpt}${start + 240 < normalized.length ? "..." : ""}`;
}

function dedupeMembershipInputs(
  memberships: readonly ReplaceTeammateChannelMembershipInput[],
): readonly ReplaceTeammateChannelMembershipInput[] {
  const byChannel = new Map<string, ReplaceTeammateChannelMembershipInput>();
  for (const membership of memberships) {
    byChannel.set(membership.channelId, membership);
  }
  return [...byChannel.values()];
}

function dedupeSkillBindingInputs(
  bindings: readonly ReplaceTeammateSkillBindingInput[],
): readonly ReplaceTeammateSkillBindingInput[] {
  const bySkill = new Map<string, ReplaceTeammateSkillBindingInput>();
  for (const binding of bindings) {
    bySkill.set(binding.skillId, binding);
  }
  return [...bySkill.values()];
}

function dedupeMcpToolInputs(tools: readonly ReplaceMcpServerToolInput[]): readonly ReplaceMcpServerToolInput[] {
  const byRawName = new Map<string, ReplaceMcpServerToolInput>();
  for (const tool of tools) {
    byRawName.set(tool.rawName, tool);
  }
  return [...byRawName.values()];
}

function dedupeTeammateMcpBindingInputs(
  bindings: readonly ReplaceTeammateMcpBindingInput[],
): readonly ReplaceTeammateMcpBindingInput[] {
  const byServer = new Map<string, ReplaceTeammateMcpBindingInput>();
  for (const binding of bindings) {
    byServer.set(binding.serverId, binding);
  }
  return [...byServer.values()];
}

function dedupeManagedPluginContributionInputs(
  contributions: readonly UpsertManagedPluginContributionInput[],
): readonly UpsertManagedPluginContributionInput[] {
  const byContribution = new Map<string, UpsertManagedPluginContributionInput>();
  for (const contribution of contributions) {
    byContribution.set(`${contribution.contributionKind}:${contribution.contributionId}`, contribution);
  }
  return [...byContribution.values()];
}

function protectDefaultSkillBindings(
  teammate: AiTeammate,
  existing: readonly TeammateSkillBinding[],
  bindings: readonly ReplaceTeammateSkillBindingInput[],
): readonly ReplaceTeammateSkillBindingInput[] {
  const bySkill = new Map<string, ReplaceTeammateSkillBindingInput>();
  for (const binding of bindings) {
    bySkill.set(binding.skillId, binding);
  }

  const template = teammate.templateId
    ? listDefaultTeammateTemplates(GSTACK_DEFAULT_SKILL_PACK_ID).find((item) => item.id === teammate.templateId)
    : undefined;
  if (!template) {
    return [...bySkill.values()];
  }

  const existingBySkill = new Map(existing.map((binding) => [binding.skillId, binding]));
  for (const skillId of template.defaultSkillIds) {
    const requested = bySkill.get(skillId);
    const previous = existingBySkill.get(skillId);
    bySkill.set(skillId, {
      skillId,
      source: "template",
      enabled: requested?.enabled ?? previous?.enabled ?? true,
    });
  }
  return [...bySkill.values()];
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProviderCheckResult(value: string | undefined): ProviderCheckResult | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = parseJsonObject(value);
  if (typeof parsed.ok !== "boolean" || typeof parsed.message !== "string" || typeof parsed.checkedAt !== "string") {
    throw new Error("Expected provider check result from SQLite");
  }
  if (parsed.code !== undefined && typeof parsed.code !== "string") {
    throw new Error("Expected provider check code to be a string");
  }

  const code = typeof parsed.code === "string" ? parsed.code : undefined;
  return omitUndefined({
    ok: parsed.ok,
    code,
    message: parsed.message,
    checkedAt: parsed.checkedAt,
  }) as ProviderCheckResult;
}

function readString(row: Record<string, SQLOutputValue> | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string`);
  }
  return value;
}

function readBoolean(row: Record<string, SQLOutputValue>, key: string): boolean {
  const value = row[key];
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "bigint") {
    return value === 1n;
  }
  throw new Error(`Expected SQLite column ${key} to be a boolean integer`);
}

function readNullableBoolean(row: Record<string, SQLOutputValue>, key: string): boolean | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "bigint") {
    return value === 1n;
  }
  throw new Error(`Expected SQLite column ${key} to be a boolean integer or null`);
}

function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string or null`);
  }
  return value;
}

function readNullableRunContinuationReason(row: Record<string, SQLOutputValue>, key: string): RunContinuationReason | undefined {
  const value = readNullableString(row, key);
  return value && runContinuationReasons.includes(value as RunContinuationReason)
    ? value as RunContinuationReason
    : undefined;
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

function runActivityAt(run: RunSession): string {
  return run.updatedAt || run.endedAt || run.startedAt || run.createdAt;
}

function compareIsoDesc(left: string | undefined, right: string | undefined): number {
  return (right ?? "").localeCompare(left ?? "");
}

function runStatusToLingTurnStatus(status: RunStatus): LingTurnStatus {
  if (status === "queued" || status === "running") {
    return "running";
  }
  return status;
}

function readNullableNumber(row: Record<string, SQLOutputValue>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`Expected SQLite column ${key} to be a number or null`);
}

function readNumber(row: Record<string, SQLOutputValue> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`Expected SQLite column ${key} to be a number`);
}

function booleanToSql(value: boolean | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

function nullableUpdate<T>(value: T | null | undefined, existing: T | undefined): T | undefined {
  if (value === undefined) {
    return existing;
  }
  if (value === null) {
    return undefined;
  }
  return value;
}

function normalizeProviderTransport(value: ProviderTransport | null | undefined): ProviderTransport | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!providerTransports.includes(value)) {
    throw new Error(`providerTransport must be one of: ${providerTransports.join(", ")}`);
  }
  return value;
}

function normalizeProviderTransportUpdate(
  value: ProviderTransport | null | undefined,
  existing: ProviderTransport | undefined,
): ProviderTransport | undefined {
  if (value === undefined) {
    return existing;
  }
  return normalizeProviderTransport(value);
}

function appendNullableOwnerClause(clauses: string[], params: string[], column: string, value: string | undefined): void {
  if (value === undefined) {
    clauses.push(`${column} IS NULL`);
    return;
  }
  clauses.push(`${column} = ?`);
  params.push(value);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}
