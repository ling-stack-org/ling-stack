import type { ConversationPendingReplacement, RunTool, ToolName } from "./shared.js";
import type { RunIntervention } from "./runtime.js";
import type {
  ChannelIntentDecisionV2,
  ChannelIntentDecisionV2Action,
  ChannelIntentDecisionV2CreatedBy,
  ChannelIntentDecisionV2Status,
  ConversationContextProjectionMetadata,
  LingThreadRelationKindV2,
  LingThreadSurfaceKindV2,
} from "./conversation-continuity.js";
import type { ResponseLanguage, ResponseLanguagePreference } from "./settings.js";
import type { WorkflowParticipantProviderBlockerV1 } from "./conversation-model-binding.js";
import type {
  ProcedureObservationCluster,
  ProcedureObservationStep,
  ProcedureObservationValidationStep,
  SkillCandidateSourceRef,
} from "./skills.js";

export type ChannelStatus = "active" | "paused" | "archived";

export type ChannelBranchStatus = "active" | "archived";

export type ChannelAutoReplyMode = "mentions_only" | "default_teammate" | "auto_route";

export type ChannelResponseLanguage = "workspace" | ResponseLanguagePreference;

export type ChannelWorkflowPreference = "manual" | "architect_engineer_qa";

export type ChannelSchedulingMode = "smart";

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

export type WorkspaceGitStatusState = "clean" | "dirty" | "not_git_repo" | "unavailable" | "error";

export type WorkspaceGitFileKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "unknown";

export interface WorkspaceGitStatusFile {
  readonly path: string;
  readonly originalPath?: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly kind: WorkspaceGitFileKind;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
}

export interface WorkspaceGitStatus {
  readonly state: WorkspaceGitStatusState;
  readonly cwd: string;
  readonly repoRoot?: string;
  readonly branchName?: string;
  readonly upstream?: string;
  readonly headSha?: string;
  readonly changedFileCount: number;
  readonly stagedFileCount: number;
  readonly unstagedFileCount: number;
  readonly untrackedFileCount: number;
  readonly conflictedFileCount: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly files: readonly WorkspaceGitStatusFile[];
  readonly checkedAt: string;
  readonly unavailableReason?: string;
  readonly errorMessage?: string;
}

export interface ChannelWorkspaceGitStatusResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly binding: ChannelWorkspaceBinding;
  readonly snapshot: ChannelWorkspaceSnapshot;
  readonly gitStatus: WorkspaceGitStatus;
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
  readonly schedulingMode: ChannelSchedulingMode;
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
  readonly rootThreadId?: string;
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
  | "protocol_override"
  | "workspace_setting"
  | "default"
  | "teammate_instruction";

export type ChannelProtocolSourceRefType =
  | "message"
  | "channel_decision"
  | "context_summary"
  | "task"
  | "run"
  | "workflow"
  | "workflow_step";

export interface ChannelProtocolSourceRef {
  readonly type: ChannelProtocolSourceRefType;
  readonly id: string;
  readonly label?: string;
}

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
  readonly protocolVersion?: number;
  readonly defaultWorkflowPreference: ChannelWorkflowPreference;
  readonly visibleMultiReplyMaxParticipants: number;
  readonly privacyRules: readonly string[];
  readonly reviewRules: readonly string[];
  readonly updatedBy: "local-user" | "system_template" | "ai-draft";
  readonly updatedAt: string;
}

export interface ChannelCollaborationProtocolResponse {
  readonly cwd: string;
  readonly protocol: ChannelCollaborationProtocol;
  readonly sources: {
    readonly responseLanguage: ChannelProtocolFieldResolution<ChannelResponseLanguage>;
    readonly autoReplyMode: ChannelProtocolFieldResolution<ChannelAutoReplyMode>;
    readonly defaultTeammateId: ChannelProtocolFieldResolution<string | undefined>;
    readonly defaultWorkflowPreference: ChannelProtocolFieldResolution<ChannelWorkflowPreference>;
    readonly visibleMultiReplyMaxParticipants: ChannelProtocolFieldResolution<number>;
    readonly privacyRules: ChannelProtocolFieldResolution<readonly string[]>;
    readonly reviewRules: ChannelProtocolFieldResolution<readonly string[]>;
  };
  readonly storage: {
    readonly mode: "channel_fields" | "channel_fields_and_protocol_overrides";
    readonly editableFields: readonly string[];
    readonly unsupportedFields: readonly string[];
  };
}

export interface UpdateChannelCollaborationProtocolRequest {
  readonly responseLanguage?: ChannelResponseLanguage | null;
  readonly autoReplyMode?: ChannelAutoReplyMode | null;
  readonly defaultTeammateId?: string | null;
}

export type ChannelProtocolDraftStatus = "draft" | "applied" | "cancelled" | "stale";

export type ChannelProtocolDraftCreatedBy = "local-user" | "ai-draft";

export interface ChannelCollaborationProtocolPatch {
  readonly responseLanguage?: ChannelResponseLanguage | null;
  readonly autoReplyMode?: ChannelAutoReplyMode | null;
  readonly defaultTeammateId?: string | null;
  readonly defaultWorkflowPreference?: ChannelWorkflowPreference;
  readonly visibleMultiReplyMaxParticipants?: number;
  readonly privacyRules?: readonly string[];
  readonly reviewRules?: readonly string[];
}

export interface ChannelCollaborationProtocolDraft {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly baseVersion?: number;
  readonly proposedPatch: ChannelCollaborationProtocolPatch;
  readonly reason: string;
  readonly createdBy: ChannelProtocolDraftCreatedBy;
  readonly sourceRefs: readonly ChannelProtocolSourceRef[];
  readonly status: ChannelProtocolDraftStatus;
  readonly appliedProtocolVersion?: number;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelCollaborationProtocolDraftRequest {
  readonly baseVersion?: number;
  readonly proposedPatch: ChannelCollaborationProtocolPatch;
  readonly reason: string;
  readonly createdBy?: ChannelProtocolDraftCreatedBy;
  readonly sourceRefs?: readonly ChannelProtocolSourceRef[];
  readonly expiresAt?: string;
}

export interface CreateChannelProtocolCandidateFromClusterRequest {
  readonly proposedPatch?: ChannelCollaborationProtocolPatch;
  readonly reason?: string;
  readonly expiresAt?: string;
}

export interface ChannelCollaborationProtocolDraftMutationResponse extends ChannelCollaborationProtocolResponse {
  readonly draft: ChannelCollaborationProtocolDraft;
}

export interface ChannelCollaborationProtocolDraftListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly drafts: readonly ChannelCollaborationProtocolDraft[];
}

export type ChannelProtocolCandidate = ChannelCollaborationProtocolDraft;

export type ChannelProtocolCandidateReviewAction = "approve" | "reject";

export interface ChannelProtocolCandidateReviewRequest {
  readonly action: ChannelProtocolCandidateReviewAction;
  readonly reason?: string;
}

export type ChannelProtocolCandidateListResponse = ChannelCollaborationProtocolDraftListResponse;

export type ChannelProtocolCandidateMutationResponse = ChannelCollaborationProtocolDraftMutationResponse;

export type ChannelPlaybookCandidateStatus = "draft" | "active" | "cancelled" | "stale";

export type ChannelPlaybookCandidateCreatedBy = "local-user" | "ai-draft";

export interface ChannelPlaybookCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly procedureSteps: readonly ProcedureObservationStep[];
  readonly validationSteps: readonly ProcedureObservationValidationStep[];
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly reason: string;
  readonly createdBy: ChannelPlaybookCandidateCreatedBy;
  readonly status: ChannelPlaybookCandidateStatus;
  readonly activatedAt?: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelPlaybookCandidateFromClusterRequest {
  readonly title?: string;
  readonly summary?: string;
  readonly normalizedGoal?: string;
  readonly procedureSteps?: readonly ProcedureObservationStep[];
  readonly validationSteps?: readonly ProcedureObservationValidationStep[];
  readonly positiveTriggers?: readonly string[];
  readonly negativeTriggers?: readonly string[];
  readonly reason?: string;
  readonly expiresAt?: string;
}

export type ChannelPlaybookCandidateReviewAction = "approve" | "reject";

export interface ChannelPlaybookCandidateReviewRequest {
  readonly action: ChannelPlaybookCandidateReviewAction;
  readonly reason?: string;
}

export interface ChannelPlaybookCandidateListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly candidates: readonly ChannelPlaybookCandidate[];
}

export interface ChannelPlaybookCandidateMutationResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly candidate: ChannelPlaybookCandidate;
}

export type ChannelProtocolCanvasSectionKind =
  | "current_protocol"
  | "candidate_clusters"
  | "draft_backlog"
  | "review_rules"
  | "privacy_rules";

export interface ChannelProtocolCanvasSection {
  readonly kind: ChannelProtocolCanvasSectionKind;
  readonly title: string;
  readonly summary: string;
  readonly itemCount: number;
  readonly status: "empty" | "healthy" | "needs_review" | "blocked";
}

export interface ChannelProtocolCanvasResponse extends ChannelCollaborationProtocolResponse {
  readonly candidateClusters: readonly ProcedureObservationCluster[];
  readonly draftCandidates: readonly ChannelProtocolCandidate[];
  readonly sections: readonly ChannelProtocolCanvasSection[];
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

/** inferred_text is display-only lexical metadata, not a request to load a file. */
export type ChannelMessageFileRefSource = "composer" | "explicit_text" | "api" | "inferred_text";

export interface ChannelMessageFileRef {
  readonly path: string;
  readonly label?: string;
  readonly source?: ChannelMessageFileRefSource;
  readonly line?: number;
}

export type MessageWebEvidenceStatus = "available" | "degraded" | "blocked";

export interface MessageWebEvidenceProvider {
  readonly adapterId: string;
  readonly providerPresetId: string;
  readonly displayName: string;
}

export interface MessageWebEvidenceSource {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

export interface MessageWebEvidenceReadUrl {
  readonly url: string;
  readonly status: "available" | "blocked";
  readonly finalUrl?: string;
  readonly title?: string;
  readonly reason?: string;
}

export interface MessageWebEvidence {
  readonly status: MessageWebEvidenceStatus;
  readonly query?: string;
  readonly queries?: readonly string[];
  readonly provider?: MessageWebEvidenceProvider;
  readonly reason?: string;
  readonly sources: readonly MessageWebEvidenceSource[];
  readonly readUrls: readonly MessageWebEvidenceReadUrl[];
  readonly updatedAt: string;
}

export interface ChannelMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  /** Canonical LingThread identity. Never overloaded with a parent item id. */
  readonly threadId?: string;
  readonly turnId?: string;
  readonly threadSurfaceKind?: LingThreadSurfaceKindV2;
  readonly threadRelationKind?: LingThreadRelationKindV2;
  readonly threadAnchorItemId?: string;
  readonly replyToItemId?: string;
  readonly kind: ChannelMessageKind;
  readonly intent: ChannelMessageIntent;
  readonly authorType: ChannelMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly status: "pending" | "ready" | "blocked" | "failed";
  readonly errorMessage?: string;
  readonly revision?: number;
  readonly editedAt?: string;
  readonly pendingReplacement?: ConversationPendingReplacement;
  readonly webEvidence?: MessageWebEvidence;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelReplyDisposition {
  readonly mode: "queue_followup";
  readonly activeRunId?: string;
}

export interface ChannelReplyDispatch {
  readonly targetTeammateId: string;
  readonly disposition: "reply_requested" | "followup_queued";
  readonly sourceRunId?: string;
  readonly intervention?: RunIntervention;
}

export interface ChannelReplyPendingEvent {
  readonly sourceMessageId: string;
  readonly targetTeammateId: string;
  readonly startedAt: string;
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
  readonly contextProjection?: ConversationContextProjectionMetadata;
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

export type ChannelIntentDecisionAction = ChannelIntentDecisionV2Action;
export type ChannelIntentDecisionStatus = ChannelIntentDecisionV2Status;
export type ChannelIntentDecisionCreatedBy = ChannelIntentDecisionV2CreatedBy;
export type ChannelIntentDecision = ChannelIntentDecisionV2;

export interface ChannelIntentDecisionListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly decisions: readonly ChannelIntentDecision[];
}

export type ChannelExecutionProposalStatus = "draft" | "accepted" | "cancelled" | "superseded" | "blocked" | "run_failed";

export type ChannelExecutionProposalStepAction = "coordinated" | "consulted" | "reviewed" | "flagged_risk";

export type ChannelExecutionProposalStepSourceKind = "direct" | "council";

export interface ChannelExecutionProposalStepSource {
  readonly kind: ChannelExecutionProposalStepSourceKind;
  readonly councilId?: string;
  readonly councilDisplayName?: string;
  readonly slotKey?: string;
  readonly label?: string;
  readonly isDefault?: boolean;
}

export interface ChannelExecutionProposalStep {
  readonly teammateId: string;
  readonly action: ChannelExecutionProposalStepAction;
  readonly summary: string;
  readonly sources?: readonly ChannelExecutionProposalStepSource[];
}

export type ChannelRequirementShapingStatus =
  | "collecting_context"
  | "collecting_teammate_input"
  | "needs_user_clarification"
  | "ready_for_confirmation"
  | "converted_to_task"
  | "dismissed";

export type ChannelRequirementShapingClarificationAuthor = "local-user" | "ai-teammate" | "system";

export interface ChannelRequirementShapingClarification {
  readonly id: string;
  readonly authorType: ChannelRequirementShapingClarificationAuthor;
  readonly authorId?: string;
  readonly body: string;
  readonly sourceMessageId?: string;
  readonly createdAt: string;
}

export interface ChannelRequirementShaping {
  readonly status: ChannelRequirementShapingStatus;
  readonly summary?: string;
  readonly openQuestions: readonly string[];
  readonly clarifications: readonly ChannelRequirementShapingClarification[];
  readonly sourceRefs: readonly ChannelProtocolSourceRef[];
  readonly updatedAt?: string;
}

export interface ChannelExecutionProposal {
  readonly id: string;
  readonly revision: number;
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
  readonly responseLanguage?: ResponseLanguagePreference;
  readonly shaping?: ChannelRequirementShaping;
  readonly status: ChannelExecutionProposalStatus;
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly linkedWorkflowId?: string;
  readonly errorMessage?: string;
  readonly blocker?: WorkflowParticipantProviderBlockerV1;
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
  readonly responseLanguage?: ResponseLanguagePreference;
  readonly shaping?: ChannelRequirementShaping;
}

export interface UpdateChannelExecutionProposalRequest {
  readonly expectedRevision?: number;
  readonly title?: string;
  readonly prompt?: string;
  readonly assigneeTeammateId?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly collaborationSteps?: readonly ChannelExecutionProposalStep[];
  readonly requiredTools?: readonly RunTool[];
  readonly riskSummary?: string | null;
  readonly responseLanguage?: ResponseLanguagePreference | null;
  readonly shaping?: ChannelRequirementShaping | null;
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
  /** Item PATCH only supports the terminal reject transition. Supersession uses collection POST. */
  readonly status?: "rejected";
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
