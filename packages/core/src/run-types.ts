import { randomUUID } from "node:crypto";
import type {
  ApprovalActionType,
  ApprovalRequest,
  ApprovalRisk,
  CreateApprovalRequestInput,
  ListApprovalRequestsOptions,
  ResolveApprovalRequestInput,
} from "./approval-types.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyUpdateInput,
} from "./approval-policy.js";
import type {
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
import type { LingStackRuntimePaths } from "./runtime-paths.js";
import type {
  CreateMediaJobInput,
  ListMediaJobsOptions,
  MediaJob,
  UpdateMediaJobStatusInput,
} from "./media-types.js";
import type {
  ChannelInputMaterialization,
  CreateChannelInputMaterializationInput,
  ListChannelInputMaterializationsOptions,
} from "./input-materialization-types.js";
import type {
  AiTeammate,
  AiTeammateUpdateInput,
  Channel,
  ChannelBranch,
  ChannelBranchUpdateInput,
  ChannelAttachment,
  ChannelBrief,
  ChannelCollaborationProtocolDraft,
  ChannelCollaborationProtocolOverride,
  ChannelProtocolDraftStatus,
  ChannelContextSummary,
  ChannelDecision,
  ChannelExecutionProposal,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelHandoff,
  ChannelIntentDecision,
  ChannelLinkPreview,
  ChannelMessage,
  ChannelMessageRouteDecision,
  ChannelMessageListPage,
  ChannelUpdateInput,
  CreateChannelAttachmentInput,
  CreateChannelBranchInput,
  CreateChannelCollaborationProtocolDraftInput,
  CreateChannelContextSummaryInput,
  CreateChannelDecisionInput,
  CreateChannelExecutionProposalInput,
  CreateChannelMessageRouteDecisionInput,
  CreateWorkflowHandoffIntentInput,
  CreateWorkflowSelectorDecisionInput,
  CreateChannelWorkflowInput,
  CreateChannelWorkflowStepInput,
  CreateChannelHandoffInput,
  CreateChannelInput,
  CreateChannelIntentDecisionInput,
  CreateChannelLinkPreviewInput,
  CreateChannelMessageInput,
  CreateAiTeammateInput,
  CreateTeammateDirectLinkPreviewInput,
  CreateTeammateDirectMessageInput,
  CreateTeammateDirectReplyInterventionInput,
  CreateTeammatePrivateAttachmentInput,
  CreateTaskInput,
  DirectWorkspaceBinding,
  HardDeleteAiTeammateInput,
  HardDeleteAiTeammateResult,
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
  ListChannelMessagesOptions,
  ListChannelMessageRouteDecisionsOptions,
  ListTeammatePrivateAttachmentsOptions,
  ListTeammateDirectLinkPreviewsOptions,
  ListTeammateDirectReplyInterventionsOptions,
  ListTeammateDirectMessagesOptions,
  ListTasksOptions,
  ReplaceTeammateChannelMembershipInput,
  ReplaceTeammateMemoryScopeInput,
  ReplaceTeammateSkillBindingInput,
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
  ResourceLeaseOwnerType,
  ResourceLeaseStatus,
  StateTransitionEvent,
} from "./channel-runtime-types.js";
import type {
  RunTransitionEvent,
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
  CreateWorkUnitAttemptInput,
  CreateWorkUnitInput,
  ListRuntimeEventsOptions,
  ListRuntimeSemaphoreSlotsOptions,
  ListWorkUnitsOptions,
  RecordRuntimeHeartbeatInput,
  RuntimeEvent,
  RuntimeHeartbeat,
  RuntimeSemaphoreSlot,
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
  CreateSkillImportDraftInput,
  ListSkillRegistryOptions,
  SkillImportDraft,
  SkillRegistryEntry,
} from "./skill-types.js";
import type {
  ApplySkillCandidateReviewActionInput,
  CreateSkillCandidateInput,
  ListSkillCandidatesOptions,
  SkillCandidate,
  SkillCandidateReviewRecord,
} from "./skill-candidate-types.js";
import type {
  CreateProcedureObservationInput,
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

export type RunStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export function createLingThreadId(): string {
  return `thread_${randomUUID()}`;
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
  readonly sourceMessageId?: string;
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
  readonly sourceMessageId?: string;
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

export type RunEventType =
  | "run_created"
  | "run_start"
  | "turn_start"
  | "turn_end"
  | "assistant_text_delta"
  | "assistant_thinking_delta"
  | "tool_hydration_request"
  | "tool_hydration_end"
  | "message_end"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "run_end"
  | "run_error"
  | "run_cancelled"
  | "approval_requested"
  | "approval_approved"
  | "approval_denied"
  | "approval_expired"
  | "approval_cancelled"
  | "artifact_created"
  | "run_intervention_created"
  | "run_followup_queued"
  | "run_interrupt_requested"
  | "run_continuation_starting"
  | "run_continuation_started"
  | "run_intervention_failed"
  | "stale_runner_completion_ignored"
  | "result";

export const runInterventionModes = ["queue_followup", "interrupt_redirect"] as const;
export type RunInterventionMode = (typeof runInterventionModes)[number];
export const runContinuationReasons = [...runInterventionModes, "manual_resume"] as const;
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

export type LingThreadKind = "task" | "channel_discussion" | "teammate_direct" | "workflow_step" | "external_work" | "automation";
export type LingThreadStatus = "open" | "running" | "waiting_for_approval" | "blocked" | "succeeded" | "failed" | "cancelled" | "archived";
export type LingThreadArchivedFilter = "exclude" | "include" | "only";
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
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
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
  readonly pinnedAt?: string;
  readonly archivedAt?: string;
  readonly archivedReason?: string;
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

export type ExecutionActionType = ApprovalActionType;

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
    | "mcp_tool";
  readonly id?: string;
  readonly label?: string;
  readonly path?: string;
}

export interface ExecutionAction {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
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
  readonly scopes?: readonly ExecutionScope[];
  readonly scopeSummary?: string;
  readonly policySnapshot?: unknown;
  readonly createdAt: string;
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
  readonly summaryPath?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly updatedAt: string;
}

export interface RunEventEnvelope {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: RunEventType;
  readonly data: unknown;
}

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
  readonly status?: RunInterventionStatus;
  readonly mode?: RunInterventionMode;
  readonly limit?: number;
}

export interface UpdateRunInterventionStatusInput {
  readonly interventionId: string;
  readonly status: RunInterventionStatus;
  readonly continuationRunId?: string | null;
  readonly continuationWorkUnitId?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly failureReason?: string | null;
  readonly now: string;
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
}

export interface AppendControlPlaneEventInput {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly domain: ControlPlaneDomain;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly data?: Record<string, unknown>;
}

export interface ListControlPlaneEventsOptions {
  readonly workspaceId: string;
  readonly afterSeq?: number;
  readonly limit?: number;
  readonly domains?: readonly ControlPlaneDomain[];
}

export interface RunStore {
  readonly paths: LingStackRuntimePaths;
  createLingThread(input: CreateLingThreadInput, now: string): LingThread;
  getLingThread(threadId: string): LingThread | undefined;
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
  rebuildLingThreadMetadata(threadId: string, now: string): LingThread | undefined;
  rebuildLingThreadMetadataForRun(runId: string, now: string): LingThread | undefined;
  createLingTurn(input: CreateLingTurnInput, now: string): LingTurn;
  getLingTurn(turnId: string): LingTurn | undefined;
  listLingTurns(options: ListLingTurnsOptions): LingTurn[];
  linkRunToLingTurn(input: LinkRunToLingTurnInput): LingTurnRun;
  getLingTurnForRun(runId: string): LingTurn | undefined;
  listLingTurnRuns(turnId: string): LingTurnRun[];
  reconcileLingTurnStatus(turnId: string, now: string): LingTurn | undefined;
  createRun(input: CreateRunInput): RunSession;
  markRunStarted(runId: string, startedAt: string): void;
  markRunWaitingForApproval(runId: string, updatedAt: string): void;
  markRunRunning(runId: string, updatedAt: string): void;
  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): void;
  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): void;
  markRunCancelled(runId: string, endedAt: string, summaryPath?: string): void;
  appendEvent(runId: string, type: RunEventType, data: unknown): RunEventEnvelope;
  appendControlPlaneEvent(input: AppendControlPlaneEventInput, now: string): ControlPlaneEvent;
  listControlPlaneEvents(options: ListControlPlaneEventsOptions): ControlPlaneEvent[];
  getLatestControlPlaneEventSeq(workspaceId: string): number;
  getRun(runId: string): RunSession | undefined;
  listRuns(options?: ListRunsOptions): RunSession[];
  listEvents(runId: string, options?: ListRunEventsOptions): RunEventEnvelope[];
  countEvents(runId: string): number;
  createRunIntervention(input: CreateRunInterventionInput, now: string): RunIntervention;
  getRunIntervention(interventionId: string): RunIntervention | undefined;
  listRunInterventions(options?: ListRunInterventionsOptions): RunIntervention[];
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
  }): TransitionResult<WorkUnitStatus>;
  createWorkUnitAttempt(input: CreateWorkUnitAttemptInput): WorkUnitAttempt;
  getWorkUnitAttempt(attemptId: string): WorkUnitAttempt | undefined;
  listWorkUnitAttempts(workUnitId: string): WorkUnitAttempt[];
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
  }): WorkUnitAttempt | undefined;
  appendRuntimeEvent(input: AppendRuntimeEventInput): RuntimeEvent;
  listRuntimeEvents(workUnitId: string, options?: ListRuntimeEventsOptions): RuntimeEvent[];
  recordRuntimeHeartbeat(input: RecordRuntimeHeartbeatInput): RuntimeHeartbeat;
  acquireRuntimeSemaphoreSlot(input: AcquireRuntimeSemaphoreSlotInput): RuntimeSemaphoreSlot | undefined;
  releaseRuntimeSemaphoreSlotsForOwner(ownerId: string, releasedAt: string, releaseReason: string): number;
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
    readonly endedAt?: string;
    readonly summaryPath?: string;
    readonly errorMessage?: string | null;
  }): TransitionResult<RunStatus>;
  acquireResourceLease(input: CreateResourceLeaseInput): ResourceLease | undefined;
  releaseResourceLeasesForOwner(ownerType: ResourceLeaseOwnerType, ownerId: string, releasedAt: string): number;
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
  recordUsedMemoryEvent(input: CreateUsedMemoryEventInput, now: string): UsedMemoryEvent;
  listUsedMemoryEvents(options?: ListUsedMemoryEventsOptions): UsedMemoryEvent[];
  getOrCreateTeammateDirectThread(teammateId: string, now: string): TeammateDirectThread;
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
  createChannelMessage(input: CreateChannelMessageInput, now: string): ChannelMessage;
  updateChannelMessageRuntime(
    id: string,
    input: {
      readonly body?: string;
      readonly status?: ChannelMessage["status"];
      readonly errorMessage?: string | null;
      readonly linkedRunId?: string | null;
    },
    now: string,
  ): ChannelMessage | undefined;
  getChannelMessage(id: string): ChannelMessage | undefined;
  listChannelMessages(options: ListChannelMessagesOptions): ChannelMessage[];
  listChannelMessagesPage(options: ListChannelMessagesOptions): ChannelMessageListPage;
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
  createChannelAttachment(input: CreateChannelAttachmentInput): ChannelAttachment;
  getChannelAttachment(id: string): ChannelAttachment | undefined;
  listChannelAttachments(options: ListChannelAttachmentsOptions): ChannelAttachment[];
  deleteChannelAttachment(id: string): boolean;
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
  getChannelDecision(id: string): ChannelDecision | undefined;
  listChannelDecisions(options: ListChannelDecisionsOptions): ChannelDecision[];
  updateChannelDecision(id: string, input: UpdateChannelDecisionInput, now: string): ChannelDecision | undefined;
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
  createChannelWorkflow(input: CreateChannelWorkflowInput, now: string): ChannelWorkflow;
  getChannelWorkflow(id: string): ChannelWorkflow | undefined;
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
  deleteProviderPreset(id: string): boolean;
  setProviderSecret(providerId: string, secretValue: string, now: string): void;
  getProviderSecret(providerId: string): string | undefined;
  hasProviderSecret(providerId: string): boolean;
  deleteProviderSecret(providerId: string): boolean;
  createMediaJob(input: CreateMediaJobInput, now: string): MediaJob;
  getMediaJob(id: string): MediaJob | undefined;
  listMediaJobs(options?: ListMediaJobsOptions): MediaJob[];
  updateMediaJobStatus(id: string, input: UpdateMediaJobStatusInput, now: string): MediaJob | undefined;
  createApprovalRequest(input: CreateApprovalRequestInput, now: string): ApprovalRequest;
  getApprovalRequest(id: string): ApprovalRequest | undefined;
  listApprovalRequests(options?: ListApprovalRequestsOptions): ApprovalRequest[];
  approveApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  denyApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  expireApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  cancelApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  createApprovalCheckpoint(input: CreateApprovalCheckpointInput, now: string): LingApprovalCheckpoint;
  getApprovalCheckpoint(id: string): LingApprovalCheckpoint | undefined;
  getApprovalCheckpointForApproval(approvalId: string): LingApprovalCheckpoint | undefined;
  listApprovalCheckpoints(options?: ListApprovalCheckpointsOptions): LingApprovalCheckpoint[];
  updateApprovalCheckpointStatus(id: string, input: UpdateApprovalCheckpointStatusInput, now: string): LingApprovalCheckpoint | undefined;
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
  listMcpServers(options?: ListMcpServersOptions): McpServer[];
  updateMcpServer(id: string, input: UpdateMcpServerInput, now: string): McpServer | undefined;
  updateMcpServerStatus(id: string, status: McpServerStatus, now: string): McpServer | undefined;
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
  createSkillImportDraft(input: CreateSkillImportDraftInput, now: string): SkillImportDraft;
  getSkillImportDraft(id: string): SkillImportDraft | undefined;
  publishSkillImportDraft(id: string, now: string): SkillRegistryEntry[];
  archiveSkillRegistryEntry(id: string, now: string): SkillRegistryEntry | undefined;
  createSkillCandidate(input: CreateSkillCandidateInput, now: string): SkillCandidate;
  getSkillCandidate(id: string): SkillCandidate | undefined;
  listSkillCandidates(options?: ListSkillCandidatesOptions): SkillCandidate[];
  listSkillCandidateReviewRecords(candidateId: string): SkillCandidateReviewRecord[];
  applySkillCandidateReviewAction(
    input: ApplySkillCandidateReviewActionInput,
    now: string,
  ): { readonly candidate: SkillCandidate; readonly action: SkillCandidateReviewRecord };
  createProcedureObservation(input: CreateProcedureObservationInput, now: string): ProcedureObservation;
  listProcedureObservations(options?: ListProcedureObservationsOptions): ProcedureObservation[];
  listProcedureObservationClusters(options?: ListProcedureObservationClustersOptions): ProcedureObservationCluster[];
  getProcedureObservationCluster(id: string, workspaceId?: string): ProcedureObservationCluster | undefined;
  appendSkillUsageEvent(input: CreateSkillUsageEventInput, now: string): SkillUsageEvent;
  listSkillUsageEvents(options?: ListSkillUsageEventsOptions): SkillUsageEvent[];
  listSkillUsageStats(options?: ListSkillUsageStatsOptions): SkillUsageStats[];
  close(): void;
}

export type RunStoreFacet<K extends keyof RunStore> = Pick<RunStore, K>;

export type RunStorePathsFacet = RunStoreFacet<"paths">;

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
  | "appendControlPlaneEvent"
  | "listControlPlaneEvents"
  | "getLatestControlPlaneEventSeq"
  | "getRun"
  | "listRuns"
  | "listEvents"
  | "countEvents"
  | "createRunIntervention"
  | "getRunIntervention"
  | "listRunInterventions"
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
  | "appendRuntimeEvent"
  | "listRuntimeEvents"
  | "recordRuntimeHeartbeat"
  | "acquireRuntimeSemaphoreSlot"
  | "releaseRuntimeSemaphoreSlotsForOwner"
  | "listRuntimeSemaphoreSlots"
  | "recoverStaleRuns"
  | "recoverStaleChannelWorkflows"
  | "listStateTransitionEvents"
  | "recordStateTransitionEvent"
  | "findStateTransitionByIdempotency"
  | "transitionTaskStatus"
  | "transitionRunStatus"
  | "acquireResourceLease"
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
  | "createChannelMessage"
  | "updateChannelMessageRuntime"
  | "getChannelMessage"
  | "listChannelMessages"
  | "listChannelMessagesPage"
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
  | "createChannelWorkflow"
  | "getChannelWorkflow"
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
>;

export type ApprovalStoreFacet = RunStoreFacet<
  | "createApprovalRequest"
  | "getApprovalRequest"
  | "listApprovalRequests"
  | "approveApprovalRequest"
  | "denyApprovalRequest"
  | "expireApprovalRequest"
  | "cancelApprovalRequest"
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

export type McpStoreFacet = RunStoreFacet<
  | "createMcpServer"
  | "getMcpServer"
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
  | "listTeammateMcpBindings"
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
  | "createSkillImportDraft"
  | "getSkillImportDraft"
  | "publishSkillImportDraft"
  | "archiveSkillRegistryEntry"
>;

export type SkillCandidateStoreFacet = RunStoreFacet<
  | "createSkillCandidate"
  | "getSkillCandidate"
  | "listSkillCandidates"
  | "listSkillCandidateReviewRecords"
  | "applySkillCandidateReviewAction"
>;

export type ProcedureObservationStoreFacet = RunStoreFacet<
  | "createProcedureObservation"
  | "listProcedureObservations"
>;

export type SkillUsageStoreFacet = RunStoreFacet<
  | "appendSkillUsageEvent"
  | "listSkillUsageEvents"
  | "listSkillUsageStats"
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
