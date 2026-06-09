import { randomUUID } from "node:crypto";
import type { RunTool } from "./approval-policy.js";
import type { RunnerFallbackReason, RunnerRequestSource } from "./runtime-supervisor-types.js";
import type { AiTeammateRoleKey, SkillApprovalProfile } from "./skill-types.js";
import type { WorkflowTerminationPolicy } from "./workflow-graph-types.js";

export const DEFAULT_WORKSPACE_ID = "workspace_default";

export type TaskStatus =
  | "todo"
  | "claimed"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export const taskStatuses: readonly TaskStatus[] = [
  "todo",
  "claimed",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
  "cancelled",
];

export type ChannelStatus = "active" | "paused" | "archived";

export const channelStatuses: readonly ChannelStatus[] = ["active", "paused", "archived"];

export type ChannelExecutionMode = "serial" | "parallel";

export type ChannelWriteLockScope = "channel" | "boundPath" | "workspace";

export interface ChannelRuntimePolicy {
  readonly maxConcurrentRuns: number;
  readonly executionMode: ChannelExecutionMode;
  readonly writeLockScope: ChannelWriteLockScope;
  readonly allowReadOnlyParallel: boolean;
  readonly queueOnConflict: boolean;
}

export const defaultChannelRuntimePolicy: ChannelRuntimePolicy = {
  maxConcurrentRuns: 1,
  executionMode: "serial",
  writeLockScope: "boundPath",
  allowReadOnlyParallel: true,
  queueOnConflict: true,
};

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly defaultProviderPresetId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Channel {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: ChannelStatus;
  readonly boundPath?: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly allowedTools: readonly RunTool[];
  readonly runtimePolicy: ChannelRuntimePolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelInput {
  readonly name: string;
  readonly status?: ChannelStatus;
  readonly boundPath?: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly allowedTools?: readonly RunTool[];
  readonly runtimePolicy?: Partial<ChannelRuntimePolicy>;
}

export interface ChannelUpdateInput {
  readonly name?: string;
  readonly status?: ChannelStatus;
  readonly boundPath?: string | null;
  readonly defaultProviderPresetId?: string | null;
  readonly defaultTeammateId?: string | null;
  readonly allowedTools?: readonly RunTool[];
  readonly runtimePolicy?: Partial<ChannelRuntimePolicy>;
}

export interface ListChannelsOptions {
  readonly limit?: number;
}

export interface Task {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly assigneeTeammateId?: string;
  readonly requestedSkillId?: string;
  readonly currentRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTaskInput {
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status?: TaskStatus;
  readonly assigneeTeammateId?: string;
  readonly requestedSkillId?: string;
}

export interface TaskUpdateInput {
  readonly channelId?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly status?: TaskStatus;
  readonly assigneeTeammateId?: string | null;
  readonly requestedSkillId?: string | null;
  readonly currentRunId?: string | null;
}

export interface ListTasksOptions {
  readonly channelId?: string;
  readonly assigneeTeammateId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}

export type AiTeammateStatus = "active" | "paused" | "disabled";

export const aiTeammateStatuses: readonly AiTeammateStatus[] = ["active", "paused", "disabled"];

export interface AiTeammate {
  readonly id: string;
  readonly workspaceId: string;
  readonly templateId?: string;
  readonly roleKey: AiTeammateRoleKey;
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt: readonly string[];
  readonly allowedTools: readonly RunTool[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly status: AiTeammateStatus;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAiTeammateInput {
  readonly id?: string;
  readonly templateId?: string;
  readonly roleKey: AiTeammateRoleKey;
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarImageAttachmentId?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly allowedTools?: readonly RunTool[];
  readonly approvalProfile: SkillApprovalProfile;
  readonly status?: AiTeammateStatus;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
}

export interface AiTeammateUpdateInput {
  readonly templateId?: string | null;
  readonly roleKey?: AiTeammateRoleKey;
  readonly displayName?: string;
  readonly description?: string;
  readonly avatarTone?: string | null;
  readonly avatarImageAttachmentId?: string | null;
  readonly providerPresetId?: string | null;
  readonly runnerId?: string | null;
  readonly systemPrompt?: string | null;
  readonly appendSystemPrompt?: readonly string[];
  readonly allowedTools?: readonly RunTool[];
  readonly approvalProfile?: SkillApprovalProfile;
  readonly status?: AiTeammateStatus;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
}

export interface ListAiTeammatesOptions {
  readonly status?: AiTeammateStatus;
  readonly includeHidden?: boolean;
  readonly includeDisabled?: boolean;
  readonly limit?: number;
}

export interface TeammateChannelMembership {
  readonly teammateId: string;
  readonly channelId: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateChannelMembershipInput {
  readonly channelId: string;
  readonly isDefault?: boolean;
}

export type TeammateSkillBindingSource = "template" | "user";

export interface TeammateSkillBinding {
  readonly teammateId: string;
  readonly skillId: string;
  readonly source: TeammateSkillBindingSource;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateSkillBindingInput {
  readonly skillId: string;
  readonly source?: TeammateSkillBindingSource;
  readonly enabled?: boolean;
}

export type TeammateMemoryScopeKind =
  | "channel-brief"
  | "channel-decisions"
  | "private-chat-summary"
  | "private-notes";

export interface TeammateMemoryScope {
  readonly id: string;
  readonly teammateId: string;
  readonly kind: TeammateMemoryScopeKind;
  readonly channelId?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplaceTeammateMemoryScopeInput {
  readonly id?: string;
  readonly kind: TeammateMemoryScopeKind;
  readonly channelId?: string;
  readonly enabled?: boolean;
}

export interface TeammateDirectThread {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TeammateDirectMessageStatus = "pending" | "ready" | "blocked" | "failed";

export type TeammateDirectMessageAuthorType = "local-user" | "ai-teammate" | "system";

export interface TeammateDirectMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly teammateId: string;
  readonly authorType: TeammateDirectMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly status: TeammateDirectMessageStatus;
  readonly errorMessage?: string;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTeammateDirectMessageInput {
  readonly threadId: string;
  readonly teammateId: string;
  readonly authorType: TeammateDirectMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly attachmentIds?: readonly string[];
  readonly status?: TeammateDirectMessageStatus;
  readonly errorMessage?: string;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
}

export interface ListTeammateDirectMessagesOptions {
  readonly teammateId: string;
  readonly threadId?: string;
  readonly limit?: number;
}

export type TeammatePrivateAttachmentScope = "teammate_direct_thread" | "teammate_profile_avatar";

export interface TeammatePrivateAttachment {
  readonly id: string;
  readonly workspaceId: string;
  readonly teammateId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly scope: TeammatePrivateAttachmentScope;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt: string;
}

export interface CreateTeammatePrivateAttachmentInput {
  readonly teammateId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly scope: TeammatePrivateAttachmentScope;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt?: string;
}

export interface ListTeammatePrivateAttachmentsOptions {
  readonly teammateId: string;
  readonly threadId?: string;
  readonly scope?: TeammatePrivateAttachmentScope;
  readonly limit?: number;
}

export interface RetentionTombstone {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityType: "ai-teammate";
  readonly entityId: string;
  readonly reason?: string;
  readonly deletedCounts: Readonly<Record<string, number>>;
  readonly createdAt: string;
}

export interface HardDeleteAiTeammateInput {
  readonly reason?: string;
}

export interface HardDeleteAiTeammateResult {
  readonly tombstone: RetentionTombstone;
  readonly deletedAttachmentPaths: readonly string[];
}

export type ChannelMessageKind = "message" | "ai_reply" | "system" | "task_link";

export type ChannelMessageIntent = "discuss" | "task";

export type ChannelMessageAuthorType = "local-user" | "ai-teammate" | "system";

export interface ChannelMention {
  readonly id: string;
  readonly label: string;
  readonly kind: "ai-teammate" | "local-user" | "channel";
}

export interface ChannelMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly kind: ChannelMessageKind;
  readonly intent: ChannelMessageIntent;
  readonly authorType: ChannelMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly status: "pending" | "ready" | "blocked" | "failed";
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelMessageInput {
  readonly channelId: string;
  readonly threadId?: string;
  readonly kind?: ChannelMessageKind;
  readonly intent?: ChannelMessageIntent;
  readonly authorType: ChannelMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly mentions?: readonly ChannelMention[];
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly status?: ChannelMessage["status"];
  readonly errorMessage?: string;
}

export interface ListChannelMessagesOptions {
  readonly channelId: string;
  readonly threadId?: string;
  readonly beforeMessageId?: string;
  readonly limit?: number;
}

export interface ChannelMessageListPage {
  readonly messages: readonly ChannelMessage[];
  readonly hasMore: boolean;
  readonly nextBeforeMessageId?: string;
}

export type ChannelExecutionProposalStatus = "draft" | "accepted" | "cancelled" | "superseded" | "blocked" | "run_failed";

export type ChannelExecutionProposalStepAction = "coordinated" | "consulted" | "reviewed" | "flagged_risk";

export interface ChannelExecutionProposalStep {
  readonly teammateId: string;
  readonly action: ChannelExecutionProposalStepAction;
  readonly summary: string;
}

export interface ChannelExecutionProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly proposedByTeammateId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteria: readonly string[];
  readonly collaborationSteps: readonly ChannelExecutionProposalStep[];
  readonly requiredTools: readonly ("read" | "grep" | "find" | "ls" | "bash" | "edit" | "write")[];
  readonly riskSummary?: string;
  readonly status: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelExecutionProposalInput {
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly proposedByTeammateId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly collaborationSteps?: readonly ChannelExecutionProposalStep[];
  readonly requiredTools?: readonly ChannelExecutionProposal["requiredTools"][number][];
  readonly riskSummary?: string;
  readonly status?: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly errorMessage?: string;
}

export interface UpdateChannelExecutionProposalInput {
  readonly title?: string;
  readonly prompt?: string;
  readonly assigneeTeammateId?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly collaborationSteps?: readonly ChannelExecutionProposalStep[];
  readonly requiredTools?: readonly ChannelExecutionProposal["requiredTools"][number][];
  readonly riskSummary?: string | null;
  readonly status?: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string | null;
  readonly linkedRunId?: string | null;
  readonly errorMessage?: string | null;
}

export interface ListChannelExecutionProposalsOptions {
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly status?: ChannelExecutionProposalStatus;
  readonly limit?: number;
}

export type ChannelAttachmentKind = "image" | "pdf" | "office" | "text";

export interface ChannelAttachment {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt: string;
}

export interface CreateChannelAttachmentInput {
  readonly channelId: string;
  readonly messageId?: string;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt?: string;
}

export interface ListChannelAttachmentsOptions {
  readonly channelId: string;
  readonly limit?: number;
}

export type ChannelLinkPreviewStatus = "ready" | "blocked" | "failed";

export interface ChannelLinkPreview {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title?: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly siteName?: string;
  readonly status: ChannelLinkPreviewStatus;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelLinkPreviewInput {
  readonly channelId: string;
  readonly messageId?: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title?: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly siteName?: string;
  readonly status: ChannelLinkPreviewStatus;
  readonly errorMessage?: string;
}

export interface UpdateChannelLinkPreviewInput {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly imageUrl?: string | null;
  readonly siteName?: string | null;
  readonly status?: ChannelLinkPreviewStatus;
  readonly errorMessage?: string | null;
}

export interface ListChannelLinkPreviewsOptions {
  readonly channelId: string;
  readonly limit?: number;
}

export interface ChannelBrief {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly objective: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly risks: readonly string[];
  readonly decisionIds: readonly string[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateChannelBriefInput {
  readonly objective: string;
  readonly scope: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly risks?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly updatedBy: string;
}

export type ChannelDecisionStatus = "active" | "superseded" | "rejected";

export const channelDecisionStatuses: readonly ChannelDecisionStatus[] = ["active", "superseded", "rejected"];

export interface ChannelDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly title: string;
  readonly decision: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly status: ChannelDecisionStatus;
  readonly supersedesDecisionId?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelDecisionInput {
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly title: string;
  readonly decision: string;
  readonly rationale?: string;
  readonly alternatives?: readonly string[];
  readonly status?: ChannelDecisionStatus;
  readonly supersedesDecisionId?: string;
  readonly createdBy: string;
}

export interface UpdateChannelDecisionInput {
  readonly title?: string;
  readonly decision?: string;
  readonly rationale?: string;
  readonly alternatives?: readonly string[];
  readonly status?: ChannelDecisionStatus;
}

export interface ListChannelDecisionsOptions {
  readonly channelId: string;
  readonly status?: ChannelDecisionStatus;
  readonly limit?: number;
}

export type ChannelHandoffStatus = "proposed" | "accepted" | "declined" | "completed" | "cancelled";

export const channelHandoffStatuses: readonly ChannelHandoffStatus[] = [
  "proposed",
  "accepted",
  "declined",
  "completed",
  "cancelled",
];

export interface ChannelHandoff {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly status: ChannelHandoffStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelHandoffInput {
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly status?: ChannelHandoffStatus;
  readonly createdBy: string;
}

export interface UpdateChannelHandoffInput {
  readonly fromParticipantId?: string;
  readonly fromParticipantLabel?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly reason?: string;
  readonly requiredInput?: string;
  readonly expectedOutput?: string;
  readonly status?: ChannelHandoffStatus;
}

export interface ListChannelHandoffsOptions {
  readonly channelId: string;
  readonly status?: ChannelHandoffStatus;
  readonly limit?: number;
}

export type ChannelContextSummaryTargetType = "thread" | "task";
export type ChannelContextSummaryAuthorType = "local-user" | "ai-teammate" | "system";

export const channelContextSummaryTargetTypes: readonly ChannelContextSummaryTargetType[] = ["thread", "task"];
export const channelContextSummaryAuthorTypes: readonly ChannelContextSummaryAuthorType[] = [
  "local-user",
  "ai-teammate",
  "system",
];

export interface ChannelContextSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly targetType: ChannelContextSummaryTargetType;
  readonly targetId: string;
  readonly sourceMessageIds: readonly string[];
  readonly decisionIds: readonly string[];
  readonly summary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly authorType: ChannelContextSummaryAuthorType;
  readonly authorId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelContextSummaryInput {
  readonly channelId: string;
  readonly targetType: ChannelContextSummaryTargetType;
  readonly targetId: string;
  readonly sourceMessageIds?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly summary: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly authorType: ChannelContextSummaryAuthorType;
  readonly authorId?: string;
}

export interface UpdateChannelContextSummaryInput {
  readonly targetType?: ChannelContextSummaryTargetType;
  readonly targetId?: string;
  readonly sourceMessageIds?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly summary?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly authorType?: ChannelContextSummaryAuthorType;
  readonly authorId?: string | null;
}

export interface ListChannelContextSummariesOptions {
  readonly channelId: string;
  readonly targetType?: ChannelContextSummaryTargetType;
  readonly targetId?: string;
  readonly limit?: number;
}

export type ChannelWorkflowStatus =
  | "draft"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

export const channelWorkflowStatuses: readonly ChannelWorkflowStatus[] = [
  "draft",
  "ready",
  "running",
  "waiting_for_approval",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
];

export type ChannelWorkflowStepStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export const channelWorkflowStepStatuses: readonly ChannelWorkflowStepStatus[] = [
  "queued",
  "claimed",
  "running",
  "waiting_for_approval",
  "blocked",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
];

export type ChannelWorkflowStepStartMode = "create_task" | "create_and_run_task";

export type WorkflowStepFailurePolicy =
  | "block_for_user"
  | "fail_workflow"
  | "cancel_workflow"
  | "skip_if_optional";

export interface WorkflowStepPolicy {
  readonly onRunFailed: WorkflowStepFailurePolicy;
  readonly onRunCancelled: WorkflowStepFailurePolicy;
  readonly onApprovalDenied: WorkflowStepFailurePolicy;
  readonly retryable: boolean;
  readonly maxRetries?: number;
}

export interface WorkflowStepGate {
  readonly stage: "pre" | "post";
  readonly approvalProfile: SkillApprovalProfile;
  readonly title: string;
  readonly reason: string;
  readonly requiredForStatuses?: readonly ChannelWorkflowStepStatus[];
}

export type WorkflowFanInMode =
  | "summarize_outputs"
  | "compare_outputs"
  | "collect_checks"
  | "memory_candidates";

export interface WorkflowFanInPolicy {
  readonly mode: WorkflowFanInMode;
  readonly requireAllBranchesTerminal: boolean;
  readonly includeFailedBranches: boolean;
  readonly createSummaryArtifact: boolean;
  readonly createMemoryCandidates: boolean;
  readonly memoryCandidateScope: "run" | "task" | "channel";
  readonly maxInputArtifacts: number;
}

export interface RunnerResolutionAudit {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly requestSource?: RunnerRequestSource;
  readonly fallbackAllowed?: boolean;
  readonly fallbackReason?: RunnerFallbackReason;
}

export interface WorkflowStepOutputRef {
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly resultSummary?: string;
  readonly outputArtifactId?: string;
  readonly artifactIds: readonly string[];
  readonly branchGroupId?: string;
}

export type WorkflowPacketSourceRefType =
  | "channel_message"
  | "channel_brief"
  | "channel_decision"
  | "context_summary"
  | "task"
  | "run"
  | "workflow"
  | "workflow_step"
  | "workflow_handoff_intent"
  | "workflow_selector_decision"
  | "artifact"
  | "approval"
  | "memory";

export interface WorkflowPacketSourceRef {
  readonly type: WorkflowPacketSourceRefType;
  readonly id: string;
  readonly label?: string;
}

export type WorkflowHandoffIntentStatus =
  | "proposed"
  | "validated"
  | "accepted"
  | "declined"
  | "converted"
  | "failed";

export const workflowHandoffIntentStatuses: readonly WorkflowHandoffIntentStatus[] = [
  "proposed",
  "validated",
  "accepted",
  "declined",
  "converted",
  "failed",
];

export type WorkflowHandoffIntentCreatedBy = "local-user" | "ai-teammate" | "orchestrator";

export interface WorkflowHandoffValidation {
  readonly targetTeammateExists: boolean;
  readonly targetTeammateActive: boolean;
  readonly skillExecutable: boolean;
  readonly providerRunnable: boolean;
  readonly approvalProfileCompatible: boolean;
  readonly resourceLeaseAvailable: boolean;
  readonly blockers: readonly string[];
}

export interface WorkflowHandoffIntent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly sourceMessageId?: string;
  readonly channelHandoffId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel?: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly riskSummary?: string;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly status: WorkflowHandoffIntentStatus;
  readonly validation?: WorkflowHandoffValidation;
  readonly createdBy: WorkflowHandoffIntentCreatedBy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkflowHandoffIntentInput {
  readonly channelId: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly sourceMessageId?: string;
  readonly channelHandoffId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel?: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly riskSummary?: string;
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly status?: WorkflowHandoffIntentStatus;
  readonly validation?: WorkflowHandoffValidation;
  readonly createdBy: WorkflowHandoffIntentCreatedBy;
}

export interface UpdateWorkflowHandoffIntentInput {
  readonly channelHandoffId?: string | null;
  readonly toParticipantLabel?: string | null;
  readonly reason?: string;
  readonly requiredInput?: string;
  readonly expectedOutput?: string;
  readonly riskSummary?: string | null;
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly status?: WorkflowHandoffIntentStatus;
  readonly validation?: WorkflowHandoffValidation | null;
}

export interface ListWorkflowHandoffIntentsOptions {
  readonly channelId?: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly status?: WorkflowHandoffIntentStatus;
  readonly limit?: number;
}

export type WorkflowSelectorDecisionStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "blocked"
  | "superseded";

export const workflowSelectorDecisionStatuses: readonly WorkflowSelectorDecisionStatus[] = [
  "proposed",
  "accepted",
  "rejected",
  "blocked",
  "superseded",
];

export type WorkflowSelectorTargetKind =
  | "workflow_step"
  | "graph_node"
  | "teammate"
  | "skill"
  | "handoff"
  | "wait";

export const workflowSelectorTargetKinds: readonly WorkflowSelectorTargetKind[] = [
  "workflow_step",
  "graph_node",
  "teammate",
  "skill",
  "handoff",
  "wait",
];

export type WorkflowSelectorDecisionCreatedBy = "deterministic" | "model" | "local-user";

export interface WorkflowSelectorAlternative {
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly targetId: string;
  readonly label: string;
  readonly reason: string;
}

export interface WorkflowSelectorDecision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceWorkflowStepId?: string;
  readonly selectorNodeId?: string;
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly selectedWorkflowStepId?: string;
  readonly selectedGraphNodeId?: string;
  readonly selectedTeammateId?: string;
  readonly selectedSkillId?: string;
  readonly selectedHandoffIntentId?: string;
  readonly reason: string;
  readonly alternativesConsidered: readonly WorkflowSelectorAlternative[];
  readonly confidence: "low" | "medium" | "high";
  readonly requiresUserConfirmation: boolean;
  readonly status: WorkflowSelectorDecisionStatus;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly createdBy: WorkflowSelectorDecisionCreatedBy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkflowSelectorDecisionInput {
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceWorkflowStepId?: string;
  readonly selectorNodeId?: string;
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly selectedWorkflowStepId?: string;
  readonly selectedGraphNodeId?: string;
  readonly selectedTeammateId?: string;
  readonly selectedSkillId?: string;
  readonly selectedHandoffIntentId?: string;
  readonly reason: string;
  readonly alternativesConsidered?: readonly WorkflowSelectorAlternative[];
  readonly confidence?: "low" | "medium" | "high";
  readonly requiresUserConfirmation?: boolean;
  readonly status?: WorkflowSelectorDecisionStatus;
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly createdBy: WorkflowSelectorDecisionCreatedBy;
}

export interface UpdateWorkflowSelectorDecisionInput {
  readonly reason?: string;
  readonly alternativesConsidered?: readonly WorkflowSelectorAlternative[];
  readonly confidence?: "low" | "medium" | "high";
  readonly requiresUserConfirmation?: boolean;
  readonly status?: WorkflowSelectorDecisionStatus;
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
}

export interface ListWorkflowSelectorDecisionsOptions {
  readonly channelId?: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly selectedWorkflowStepId?: string;
  readonly status?: WorkflowSelectorDecisionStatus;
  readonly limit?: number;
}

export interface ChannelWorkflowStepContextPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly objective: string;
  readonly stepTitle: string;
  readonly stepPrompt: string;
  readonly dependencies: readonly WorkflowStepOutputRef[];
  readonly priorOutputArtifactIds: readonly string[];
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly approvalGate?: SkillApprovalProfile;
  readonly generatedAt: string;
}

export interface ChannelWorkflowStepOutputPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly resultSummary?: string;
  readonly artifactIds: readonly string[];
  readonly decisions?: readonly string[];
  readonly blockers?: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly runnerAudit?: RunnerResolutionAudit;
  readonly generatedAt: string;
}

export interface ChannelWorkflowStepMetadata {
  readonly workflowTemplateId?: string;
  readonly templateVersion?: string;
  readonly templateStepId?: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly dependsOnStepIds?: readonly string[];
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly dependencyMode?: "all_succeeded" | "all_terminal" | "any_succeeded";
  readonly maxParallelSiblings?: number;
  readonly teammateTemplateId?: string;
  readonly skillId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly autoStart?: boolean;
  readonly approvalGate?: SkillApprovalProfile;
  readonly preStepApprovalId?: string;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly fanInPolicy?: WorkflowFanInPolicy;
  readonly activeGateStage?: "pre" | "post";
  readonly postStepApprovalId?: string;
  readonly contextArtifactId?: string;
  readonly outputArtifactId?: string;
  readonly outputArtifactIds?: readonly string[];
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly fanInSummaryArtifactId?: string;
  readonly memoryCandidateIds?: readonly string[];
}

export interface ChannelWorkflowMetadata {
  readonly workflowGraphId?: string;
  readonly workflowGraphSchemaVersion?: number;
  readonly workflowGraphArtifactId?: string;
  readonly termination?: WorkflowTerminationPolicy;
  readonly maxParallelSteps?: number;
}

export interface ChannelWorkflow {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceHandoffId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status: ChannelWorkflowStatus;
  readonly createdBy: string;
  readonly metadata?: ChannelWorkflowMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelWorkflowInput {
  readonly channelId: string;
  readonly sourceHandoffId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status?: ChannelWorkflowStatus;
  readonly createdBy: string;
  readonly metadata?: ChannelWorkflowMetadata;
}

export interface UpdateChannelWorkflowInput {
  readonly title?: string;
  readonly objective?: string;
  readonly status?: ChannelWorkflowStatus;
  readonly metadata?: ChannelWorkflowMetadata | null;
}

export interface ListChannelWorkflowsOptions {
  readonly channelId: string;
  readonly status?: ChannelWorkflowStatus;
  readonly limit?: number;
}

export interface ChannelWorkflowStep {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceHandoffId?: string;
  readonly contextSummaryId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly position: number;
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly blocker?: string;
  readonly resultSummary?: string;
  readonly metadata?: ChannelWorkflowStepMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelWorkflowStepInput {
  readonly workflowId: string;
  readonly sourceHandoffId?: string;
  readonly contextSummaryId?: string;
  readonly position?: number;
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly status?: ChannelWorkflowStepStatus;
  readonly metadata?: ChannelWorkflowStepMetadata;
}

export interface UpdateChannelWorkflowStepInput {
  readonly sourceHandoffId?: string | null;
  readonly contextSummaryId?: string | null;
  readonly taskId?: string | null;
  readonly runId?: string | null;
  readonly position?: number;
  readonly title?: string;
  readonly prompt?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly status?: ChannelWorkflowStepStatus;
  readonly blocker?: string | null;
  readonly resultSummary?: string | null;
  readonly metadata?: ChannelWorkflowStepMetadata | null;
}

export interface ListChannelWorkflowStepsOptions {
  readonly workflowId: string;
  readonly status?: ChannelWorkflowStepStatus;
  readonly limit?: number;
}

export function createChannelId(): string {
  return `channel_${randomUUID()}`;
}

export function createTaskId(): string {
  return `task_${randomUUID()}`;
}

export function createAiTeammateId(): string {
  return `teammate_${randomUUID()}`;
}

export function createBuiltinAiTeammateId(templateId: string): string {
  return `teammate_builtin_${templateId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function createTeammateMemoryScopeId(): string {
  return `memory_scope_${randomUUID()}`;
}

export function createTeammateDirectThreadId(): string {
  return `dm_thread_${randomUUID()}`;
}

export function createTeammateDirectMessageId(): string {
  return `dm_msg_${randomUUID()}`;
}

export function createChannelMessageId(): string {
  return `msg_${randomUUID()}`;
}

export function createChannelExecutionProposalId(): string {
  return `proposal_${randomUUID()}`;
}

export function createChannelAttachmentId(): string {
  return `att_${randomUUID()}`;
}

export function createTeammatePrivateAttachmentId(): string {
  return `patt_${randomUUID()}`;
}

export function createRetentionTombstoneId(): string {
  return `tombstone_${randomUUID().replaceAll("-", "")}`;
}

export function createChannelLinkPreviewId(): string {
  return `link_${randomUUID()}`;
}

export function createChannelBriefId(): string {
  return `brief_${randomUUID()}`;
}

export function createChannelDecisionId(): string {
  return `decision_${randomUUID()}`;
}

export function createChannelHandoffId(): string {
  return `handoff_${randomUUID()}`;
}

export function createWorkflowHandoffIntentId(): string {
  return `wf_handoff_intent_${randomUUID()}`;
}

export function createWorkflowSelectorDecisionId(): string {
  return `wf_selector_decision_${randomUUID()}`;
}

export function createChannelContextSummaryId(): string {
  return `summary_${randomUUID()}`;
}

export function createChannelWorkflowId(): string {
  return `workflow_${randomUUID()}`;
}

export function createChannelWorkflowStepId(): string {
  return `wfstep_${randomUUID()}`;
}

export function normalizeChannelRuntimePolicy(input: Partial<ChannelRuntimePolicy> | undefined): ChannelRuntimePolicy {
  return {
    ...defaultChannelRuntimePolicy,
    ...(input ?? {}),
  };
}
