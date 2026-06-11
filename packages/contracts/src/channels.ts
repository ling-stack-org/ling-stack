import type { RunTool, ToolName } from "./shared.js";
import type { ResponseLanguage, ResponseLanguagePreference } from "./settings.js";

export type ChannelStatus = "active" | "paused" | "archived";

export type ChannelBranchStatus = "active" | "archived";

export type ChannelAutoReplyMode = "mentions_only" | "default_teammate" | "auto_route";

export type ChannelResponseLanguage = "workspace" | ResponseLanguagePreference;

export type ChannelExecutionMode = "serial" | "parallel";

export type ChannelWriteLockScope = "channel" | "boundPath" | "workspace";

export type ChannelWorkspaceMode = "local" | "managed_worktree" | "external_path";

export type ChannelWorkspaceStatus = "ready" | "not_created" | "missing" | "unsupported" | "blocked";

export interface ChannelWorkspaceBinding {
  readonly mode: ChannelWorkspaceMode;
  readonly status: ChannelWorkspaceStatus;
  readonly executionPath?: string;
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly baseBranch?: string;
  readonly baseCommit?: string;
  readonly errorMessage?: string;
  readonly createdAt?: string;
  readonly checkedAt?: string;
  readonly updatedAt: string;
}

export interface ChannelWorkspaceSnapshot {
  readonly mode: ChannelWorkspaceMode;
  readonly status: ChannelWorkspaceStatus;
  readonly workspaceCwd: string;
  readonly executionCwd: string;
  readonly boundPath?: string;
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly baseBranch?: string;
  readonly baseCommit?: string;
  readonly checkedAt?: string;
}

export interface ChannelWorkspaceResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly binding: ChannelWorkspaceBinding;
  readonly snapshot: ChannelWorkspaceSnapshot;
}

export interface ChannelWorkspaceCreateWorktreeRequest {
  readonly baseBranch?: string;
}

export interface ChannelWorkspaceHandoffRequest {
  readonly mode: ChannelWorkspaceMode;
  readonly executionPath?: string;
}

export type ChannelWorkspaceMutationResponse = ChannelWorkspaceResponse;

export interface ChannelRuntimePolicy {
  readonly maxConcurrentRuns: number;
  readonly executionMode: ChannelExecutionMode;
  readonly writeLockScope: ChannelWriteLockScope;
  readonly allowReadOnlyParallel: boolean;
  readonly queueOnConflict: boolean;
}

export interface Channel {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: ChannelStatus;
  readonly boundPath?: string;
  readonly workspaceBinding?: ChannelWorkspaceBinding;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly autoReplyMode: ChannelAutoReplyMode;
  readonly responseLanguage?: ChannelResponseLanguage;
  readonly allowedTools: readonly ToolName[];
  readonly runtimePolicy: ChannelRuntimePolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelBranch {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly name: string;
  readonly status: ChannelBranchStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly deletedAt?: string;
}

export interface ChannelListResponse {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly branches: readonly ChannelBranch[];
}

export interface ChannelMutationResponse {
  readonly channel: Channel;
}

export interface ChannelBranchListResponse {
  readonly cwd: string;
  readonly channelId?: string;
  readonly branches: readonly ChannelBranch[];
}

export interface ChannelBranchMutationResponse {
  readonly branch: ChannelBranch;
}

export type ChannelProtocolFieldSource =
  | "current_message"
  | "channel_setting"
  | "workspace_setting"
  | "default"
  | "teammate_instruction";

export interface ChannelProtocolFieldResolution<T> {
  readonly value: T;
  readonly source: ChannelProtocolFieldSource;
  readonly channelValue?: T;
  readonly workspaceValue?: T;
}

export interface ChannelCollaborationProtocol {
  readonly schemaVersion: 1;
  readonly channelId: string;
  readonly responseLanguage: ChannelResponseLanguage;
  readonly autoReplyMode: ChannelAutoReplyMode;
  readonly defaultTeammateId?: string;
  readonly defaultWorkflowPreference: "manual";
  readonly visibleMultiReplyMaxParticipants: number;
  readonly privacyRules: readonly string[];
  readonly reviewRules: readonly string[];
  readonly updatedBy: "local-user" | "system_template";
  readonly updatedAt: string;
}

export interface ChannelCollaborationProtocolResponse {
  readonly cwd: string;
  readonly protocol: ChannelCollaborationProtocol;
  readonly sources: {
    readonly responseLanguage: ChannelProtocolFieldResolution<ChannelResponseLanguage>;
    readonly autoReplyMode: ChannelProtocolFieldResolution<ChannelAutoReplyMode>;
    readonly defaultTeammateId: ChannelProtocolFieldResolution<string | undefined>;
    readonly defaultWorkflowPreference: ChannelProtocolFieldResolution<"manual">;
    readonly visibleMultiReplyMaxParticipants: ChannelProtocolFieldResolution<number>;
    readonly privacyRules: ChannelProtocolFieldResolution<readonly string[]>;
    readonly reviewRules: ChannelProtocolFieldResolution<readonly string[]>;
  };
  readonly storage: {
    readonly mode: "channel_fields";
    readonly editableFields: readonly string[];
    readonly unsupportedFields: readonly string[];
  };
}

export interface UpdateChannelCollaborationProtocolRequest {
  readonly responseLanguage?: ChannelResponseLanguage | null;
  readonly autoReplyMode?: ChannelAutoReplyMode | null;
  readonly defaultTeammateId?: string | null;
}

export interface ChannelCollaborationProtocolMutationResponse extends ChannelCollaborationProtocolResponse {
  readonly revertedFields?: readonly string[];
}

export interface CreateChannelRequest {
  readonly name: string;
  readonly status: ChannelStatus;
  readonly boundPath?: string;
  readonly workspaceBinding?: ChannelWorkspaceBinding;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly autoReplyMode?: ChannelAutoReplyMode;
  readonly responseLanguage?: ChannelResponseLanguage;
  readonly allowedTools: readonly ToolName[];
  readonly runtimePolicy: ChannelRuntimePolicy;
}

export interface CreateChannelBranchRequest {
  readonly name: string;
  readonly status?: ChannelBranchStatus;
}

export interface UpdateChannelRequest {
  readonly name?: string;
  readonly status?: ChannelStatus;
  readonly boundPath?: string | null;
  readonly workspaceBinding?: ChannelWorkspaceBinding | null;
  readonly defaultProviderPresetId?: string | null;
  readonly defaultTeammateId?: string | null;
  readonly autoReplyMode?: ChannelAutoReplyMode | null;
  readonly responseLanguage?: ChannelResponseLanguage | null;
  readonly allowedTools?: readonly ToolName[];
  readonly runtimePolicy?: ChannelRuntimePolicy;
}

export interface UpdateChannelBranchRequest {
  readonly name?: string;
  readonly status?: ChannelBranchStatus;
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

export interface CreateChannelMessageRequest {
  readonly threadId?: string;
  readonly kind?: ChannelMessageKind;
  readonly intent?: ChannelMessageIntent;
  readonly authorType?: ChannelMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly mentions?: readonly ChannelMention[];
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly requestAiReply?: boolean;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
}

export interface ChannelMessageListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly messages: readonly ChannelMessage[];
  readonly hasMore?: boolean;
  readonly nextBeforeMessageId?: string;
}

export interface ChannelMessageMutationResponse {
  readonly message: ChannelMessage;
  readonly aiReply?: ChannelMessage;
  readonly aiReplies?: readonly ChannelMessage[];
}

export type ChannelMessageRouteAction = "reply" | "no_reply";

export type ChannelMessageRouteDecisionStatus = "accepted" | "suppressed" | "failed";

export type ChannelMessageRouteDecisionCreatedBy = "explicit_mention" | "deterministic" | "model";

export interface ChannelMessageRouteAlternative {
  readonly teammateId?: string;
  readonly label: string;
  readonly score?: number;
  readonly reason: string;
}

export interface ChannelMessageRouteContextPackMetadata {
  readonly schemaVersion: 1;
  readonly kind: string;
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly sectionIds: readonly string[];
  readonly droppedSectionIds: readonly string[];
  readonly sourceRefCounts: Readonly<Record<string, number>>;
  readonly compactionIds: readonly string[];
}

export interface ChannelMessageRouteDecision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly replyMessageId?: string;
  readonly mode: ChannelAutoReplyMode;
  readonly action: ChannelMessageRouteAction;
  readonly selectedTeammateId?: string;
  readonly selectedProviderPresetId?: string;
  readonly confidence?: number;
  readonly reason: string;
  readonly alternativesConsidered: readonly ChannelMessageRouteAlternative[];
  readonly contextPack?: ChannelMessageRouteContextPackMetadata;
  readonly status: ChannelMessageRouteDecisionStatus;
  readonly createdBy: ChannelMessageRouteDecisionCreatedBy;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelMessageRouteDecisionListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly decisions: readonly ChannelMessageRouteDecision[];
}

export type ChannelIntentDecisionAction =
  | "no_reply"
  | "single_reply"
  | "visible_multi_reply"
  | "clarify"
  | "workflow_proposal"
  | "direct_workflow";

export type ChannelIntentDecisionStatus = "accepted" | "suppressed" | "failed";

export type ChannelIntentDecisionCreatedBy = "deterministic" | "model";

export interface ChannelIntentDecision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceMessageId: string;
  readonly action: ChannelIntentDecisionAction;
  readonly selectedTeammateId?: string;
  readonly selectedTeammateIds?: readonly string[];
  readonly proposalId?: string;
  readonly replyMessageId?: string;
  readonly replyMessageIds?: readonly string[];
  readonly workflowId?: string;
  readonly reason: string;
  readonly status: ChannelIntentDecisionStatus;
  readonly createdBy: ChannelIntentDecisionCreatedBy;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelIntentDecisionListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly decisions: readonly ChannelIntentDecision[];
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
  readonly requiredTools: readonly RunTool[];
  readonly riskSummary?: string;
  readonly responseLanguage?: ResponseLanguage;
  readonly status: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly linkedWorkflowId?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelExecutionProposalRequest {
  readonly sourceMessageId: string;
  readonly proposedByTeammateId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly collaborationSteps?: readonly ChannelExecutionProposalStep[];
  readonly requiredTools?: readonly RunTool[];
  readonly riskSummary?: string;
  readonly responseLanguage?: ResponseLanguage;
}

export interface UpdateChannelExecutionProposalRequest {
  readonly title?: string;
  readonly prompt?: string;
  readonly assigneeTeammateId?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly collaborationSteps?: readonly ChannelExecutionProposalStep[];
  readonly requiredTools?: readonly RunTool[];
  readonly riskSummary?: string | null;
  readonly responseLanguage?: ResponseLanguage | null;
  readonly status?: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string | null;
  readonly linkedRunId?: string | null;
  readonly linkedWorkflowId?: string | null;
  readonly errorMessage?: string | null;
}

export interface ChannelExecutionProposalListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly proposals: readonly ChannelExecutionProposal[];
}

export interface ChannelExecutionProposalMutationResponse {
  readonly proposal: ChannelExecutionProposal;
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

export interface CreateChannelAttachmentRequest {
  readonly fileName: string;
  readonly contentType?: string;
  readonly contentBase64: string;
  readonly messageId?: string;
}

export interface ChannelAttachmentListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly attachments: readonly ChannelAttachment[];
}

export interface ChannelAttachmentMutationResponse {
  readonly attachment: ChannelAttachment;
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

export interface CreateChannelLinkPreviewRequest {
  readonly url: string;
  readonly messageId?: string;
}

export interface ChannelLinkPreviewListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly linkPreviews: readonly ChannelLinkPreview[];
}

export interface ChannelLinkPreviewMutationResponse {
  readonly linkPreview: ChannelLinkPreview;
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

export interface UpdateChannelBriefRequest {
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

export interface ChannelBriefResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly brief: ChannelBrief;
}

export interface ChannelBriefMutationResponse {
  readonly brief: ChannelBrief;
}

export type ChannelDecisionStatus = "active" | "superseded" | "rejected";

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

export interface CreateChannelDecisionRequest {
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

export interface UpdateChannelDecisionRequest {
  readonly title?: string;
  readonly decision?: string;
  readonly rationale?: string;
  readonly alternatives?: readonly string[];
  readonly status?: ChannelDecisionStatus;
}

export interface ChannelDecisionListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly decisions: readonly ChannelDecision[];
}

export interface ChannelDecisionMutationResponse {
  readonly decision: ChannelDecision;
}

export type ChannelHandoffStatus = "proposed" | "accepted" | "declined" | "completed" | "cancelled";

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

export interface CreateChannelHandoffRequest {
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

export interface UpdateChannelHandoffRequest {
  readonly fromParticipantId?: string;
  readonly fromParticipantLabel?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly reason?: string;
  readonly requiredInput?: string;
  readonly expectedOutput?: string;
  readonly status?: ChannelHandoffStatus;
}

export interface ChannelHandoffListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly handoffs: readonly ChannelHandoff[];
}

export interface ChannelHandoffMutationResponse {
  readonly handoff: ChannelHandoff;
}

export type ChannelContextSummaryTargetType = "thread" | "task";

export type ChannelContextSummaryAuthorType = "local-user" | "ai-teammate" | "system";

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

export interface CreateChannelContextSummaryRequest {
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

export interface UpdateChannelContextSummaryRequest {
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

export interface ChannelContextSummaryListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly contextSummaries: readonly ChannelContextSummary[];
}

export interface ChannelContextSummaryMutationResponse {
  readonly contextSummary: ChannelContextSummary;
}
