import type { ChannelAttachmentKind, ChannelMention, ChannelMessageFileRef } from "./channels.js";
import type { ApprovalRequest } from "./approvals.js";
import type { AuthorizationMode, ConversationPendingReplacement, PermissionConfirmation, PermissionPreset, RunThinkingLevel, RunTool, SessionPermissionMode, WorkspaceAccessMode } from "./shared.js";
import type { ExecutionAction } from "./execution-actions.js";
import type { ResponseLanguagePreference } from "./settings.js";
import type { ConversationActiveReplyTarget, RunEventEnvelope, RunIntervention, RunSession } from "./runtime.js";
import type { ConversationContextSnapshot, ConversationContextSummary, ConversationItemV1 } from "./conversation-continuity.js";
import type { LingThread } from "./threads.js";
import type { LingTurn, LingTurnRun } from "./turns.js";
import type { ConversationTerminalReportProjectionDto } from "./terminal-reports.js";
import type { ConversationGeneratedMedia } from "./media.js";
import type { RunArtifact } from "./artifacts.js";
import type { CompactionCheckpoint } from "./workspace-changes.js";
import type { ProposedPlanArtifact } from "./threads.js";

export type ConversationTranscriptRole = "user" | "assistant" | "system";
export type ConversationTranscriptStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";

export interface ConversationTranscriptMessage {
  readonly id: string;
  readonly role: ConversationTranscriptRole;
  readonly authorId?: string;
  readonly authorLabel?: string;
  readonly content: string;
  /** Runtime/provider failure kept separate from assistant narrative content. */
  readonly errorMessage?: string;
  readonly attachments?: readonly ConversationAttachment[];
  readonly fileRefs?: readonly ChannelMessageFileRef[];
  readonly status: ConversationTranscriptStatus;
  readonly threadId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly revision?: number;
  readonly editedAt?: string;
  readonly pendingReplacement?: ConversationPendingReplacement;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationStreamRequest {
  readonly threadId?: string;
  readonly message: string;
  readonly attachmentIds?: readonly string[];
  readonly fileRefs?: readonly ChannelMessageFileRef[];
  readonly projectPath?: string;
  readonly providerPresetId: string;
  readonly thinkingLevel?: RunThinkingLevel;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode?: SessionPermissionMode;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly responseLanguage?: ResponseLanguagePreference;
  readonly tools?: readonly RunTool[];
  readonly idempotencyKey?: string;
}

export interface ConversationStreamReadyEvent {
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly userMessage: ConversationTranscriptMessage;
  readonly assistantMessage: ConversationTranscriptMessage;
  readonly runId?: string;
  readonly activeReply?: ConversationActiveReplyTarget;
}

export interface ConversationStreamRunEvent {
  readonly threadId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly event: RunEventEnvelope;
  readonly assistantMessage?: ConversationTranscriptMessage;
}

export interface ConversationStreamDoneEvent {
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly run: RunSession;
  readonly assistantMessage: ConversationTranscriptMessage;
}

export interface ConversationStreamBlockedEvent {
  readonly thread?: LingThread;
  readonly turn?: LingTurn;
  readonly run?: RunSession;
  readonly assistantMessage?: ConversationTranscriptMessage;
  readonly error: string;
}

export interface ConversationDetailResponse {
  readonly cwd: string;
  readonly thread: LingThread;
  readonly turns: readonly LingTurn[];
  /** Canonical source-order history. `messages` remains a compatibility view for existing callers. */
  readonly conversationItems: readonly ConversationItemV1[];
  /** Durable turn -> run/attempt links used by the typed transcript projector. */
  readonly runLinks: readonly LingTurnRun[];
  readonly runs: readonly RunSession[];
  readonly executionActions: readonly ExecutionAction[];
  readonly approvals: readonly ApprovalRequest[];
  readonly interventions: readonly RunIntervention[];
  readonly terminalReports: readonly ConversationTerminalReportProjectionDto[];
  /** Host-owned artifacts used by file, diff, image, and evidence timeline items. */
  readonly artifacts: readonly RunArtifact[];
  /** Durable proposed plans; projected into the shared `plan` item when anchored. */
  readonly plans?: readonly ProposedPlanArtifact[];
  /** Durable context compaction checkpoints; projected into `contextCompaction`. */
  readonly compactionCheckpoints?: readonly CompactionCheckpoint[];
  /** Context snapshots used to preserve contextSegmentId lineage in detail. */
  readonly contextSnapshots?: readonly ConversationContextSnapshot[];
  /** Durable summaries referenced by compaction checkpoints; never a second transcript. */
  readonly contextSummaries?: readonly ConversationContextSummary[];
  readonly messages: readonly ConversationTranscriptMessage[];
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly defaults: {
    readonly projectPath?: string;
    readonly providerPresetId?: string;
    readonly thinkingLevel?: RunThinkingLevel;
    readonly authorizationMode?: AuthorizationMode;
    readonly workspaceAccessMode?: WorkspaceAccessMode;
    readonly permissionPreset?: PermissionPreset;
    readonly permissionMode?: SessionPermissionMode;
  };
}

export interface ConversationAttachment {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly kind: ChannelAttachmentKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly path: string;
  readonly createdAt: string;
}

export interface CreateConversationAttachmentRequest {
  readonly fileName: string;
  readonly contentType?: string;
  readonly contentBase64: string;
  readonly threadId?: string;
}

export interface ConversationAttachmentListResponse {
  readonly cwd: string;
  readonly threadId?: string;
  readonly attachments: readonly ConversationAttachment[];
}

export interface ConversationAttachmentMutationResponse {
  readonly attachment: ConversationAttachment;
}

export type ConversationMessageEditSurface =
  | "normal_conversation"
  | "channel_root"
  | "channel_branch"
  | "topic_reply"
  | "teammate_direct";

export interface EditConversationMessageRequest {
  readonly surface: ConversationMessageEditSurface;
  readonly ownerId: string;
  readonly messageId: string;
  readonly expectedRevision: number;
  readonly body: string;
  readonly mentions?: readonly ChannelMention[];
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly fileRefs?: readonly ChannelMessageFileRef[];
  readonly providerPresetId?: string;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly requestedSkillId?: string;
  readonly idempotencyKey: string;
}

export interface ConversationMessageRevisionView {
  readonly id: string;
  readonly surface: ConversationMessageEditSurface;
  readonly ownerId: string;
  readonly laneId: string;
  readonly messageId: string;
  readonly revision: number;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly createdAt: string;
}

export interface EditConversationMessageResponse {
  readonly message: ConversationMessageRevisionView;
  readonly supersessionId: string;
  readonly supersededTurnId?: string;
  readonly replacementTurnId?: string;
  readonly interruptedRunIds: readonly string[];
  readonly supersededResponseMessageIds: readonly string[];
  readonly preservedWorkspaceChanges: true;
  readonly status: "replacement_started" | "replacement_pending";
  readonly failureReason?: string;
  readonly idempotentReplay: boolean;
}
