import type { ChannelAttachmentKind, ChannelMention, ChannelMessageFileRef } from "./channels.js";
import type { ApprovalRequest, LingApprovalCheckpoint } from "./approvals.js";
import type { AuthorizationMode, ConversationPendingReplacement, PermissionConfirmation, PermissionPreset, ReasoningSummaryMode, RunThinkingLevel, RunTool, SessionPermissionMode, WorkspaceAccessMode } from "./shared.js";
import type { ExecutionAction, ExecutionActionSourceRef } from "./execution-actions.js";
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
import type { UserInputTranscriptItemV1 } from "./user-input-transcript.js";

export type ConversationTranscriptRole = "user" | "assistant" | "system";
export type ConversationTranscriptStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";

/** Read-only narrative lineage, verified from durable Run/Turn/Attempt facts by Host. */
export interface ConversationNarrationSource {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly participantId: string;
}

/** One assistant message boundary, derived from durable RunEvents without changing history. */
export interface ConversationNarrationSegment {
  readonly source?: ConversationNarrationSource;
  /** Projection-only revision for ownership withdrawal, not a Run event position. */
  readonly sourceRevision?: number;
  readonly content: string;
  readonly firstEventId: string;
  readonly lastEventId: string;
  readonly startEventSequence: number;
  readonly endEventSequence: number;
  readonly completed: boolean;
}

/**
 * Provider-safe reasoning summary derived from one durable Run event.
 * Raw thinking text and provider-private reasoning content are deliberately
 * absent: this is a read model, not narration or execution evidence.
 */
export interface ConversationReasoningSummaryRecord {
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly attemptId?: string;
  readonly participantId?: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string;
  readonly anchorItemId: string;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly text: string;
  readonly parts: readonly string[];
  readonly semantic: "safe_summary";
  readonly source: "openai_responses";
  readonly truncated: boolean;
  readonly sourceRefs: readonly ExecutionActionSourceRef[];
  readonly createdAt: string;
}

export interface ConversationTranscriptMessage {
  readonly id: string;
  /** Durable Item identity, independent of the stable streaming message id. */
  readonly canonicalItemId?: string;
  readonly role: ConversationTranscriptRole;
  readonly authorId?: string;
  readonly authorLabel?: string;
  readonly content: string;
  /** Read/stream projection provenance; a Host status placeholder is not model prose. */
  readonly contentSource?: "run_narration" | "host_status";
  /** Distinct assistant messages in persisted event order; content is the readable aggregate. */
  readonly narrationSegments?: readonly ConversationNarrationSegment[];
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
  readonly reasoningSummary?: ReasoningSummaryMode;
  readonly authorizationMode?: AuthorizationMode;
  readonly workspaceAccessMode?: WorkspaceAccessMode;
  readonly permissionPreset?: PermissionPreset;
  readonly permissionMode?: SessionPermissionMode;
  readonly permissionConfirmation?: PermissionConfirmation;
  readonly responseLanguage?: ResponseLanguagePreference;
  readonly tools?: readonly RunTool[];
  readonly idempotencyKey?: string;
}

/** A native input lookup, not evidence that its reply completed. Unknown never means rejected. */
export interface ConversationSubmissionReceipt {
  readonly cwd: string;
  readonly idempotencyKey: string;
  readonly status: "accepted" | "unknown";
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceItemId?: string;
  readonly sourceItem?: ConversationItemV1;
}

export type ConversationSubmissionQuery = {
  readonly surface: "normal";
  readonly idempotencyKey: string;
  readonly threadId?: string;
} | {
  readonly surface: "channel";
  readonly channelId: string;
  readonly idempotencyKey: string;
  readonly threadId?: string;
};

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

/**
 * Durable, monotonic deletion facts for the effective conversation projection.
 *
 * Detail snapshots intentionally omit superseded records. Clients that merge a
 * fresh snapshot with live state still need these ids so an older response
 * cannot resurrect the removed turn and its execution lineage.
 */
export interface ConversationSupersessionTombstones {
  readonly turnIds: readonly string[];
  readonly runIds: readonly string[];
  readonly responseMessageIds: readonly string[];
}

export interface ConversationDetailResponse {
  readonly cwd: string;
  readonly thread: LingThread;
  readonly turns: readonly LingTurn[];
  /** Canonical source-order history. `messages` remains a compatibility view for existing callers. */
  readonly conversationItems: readonly ConversationItemV1[];
  /** Scoped read-only question/answer content; not another message history. */
  readonly userInputs: readonly UserInputTranscriptItemV1[];
  /** Append-only edit tombstones used to reconcile stale/reordered detail reads. */
  readonly supersessionTombstones: ConversationSupersessionTombstones;
  /** Durable turn -> run/attempt links used by the typed transcript projector. */
  readonly runLinks: readonly LingTurnRun[];
  readonly runs: readonly RunSession[];
  /** Provider-safe reasoning summaries reconstructed from durable RunEvents. */
  readonly reasoningSummaries: readonly ConversationReasoningSummaryRecord[];
  readonly executionActions: readonly ExecutionAction[];
  readonly approvals: readonly ApprovalRequest[];
  /** Durable approval ownership and Attempt lineage; projected separately from tool execution. */
  readonly approvalCheckpoints: readonly LingApprovalCheckpoint[];
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
    readonly reasoningSummary?: ReasoningSummaryMode;
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
