import type {
  ContextSegment,
  ConversationContextProjectionMetadata,
  ConversationContextSummary,
  ConversationDomainRef,
  ConversationItemV1,
  LingThreadContinuityV2,
  TurnContextAssignment,
} from "./conversation-continuity.js";
import type {
  ChannelExecutionProposal,
  ChannelMessageFileRef,
  ChannelMention,
  ChannelReplyDispatch,
  MessageWebEvidence,
} from "./channels.js";
import type { ConversationPendingReplacement } from "./shared.js";
import type { ConversationActiveReplyTarget } from "./runtime.js";
import type { LingThread } from "./threads.js";
import type { LingTurn } from "./turns.js";
import type { ChannelWorkflow, ChannelWorkflowOrchestrationResponse, ChannelWorkflowStep } from "./workflows.js";
import type { ConversationGeneratedMedia } from "./media.js";

export type ChannelConversationThread = LingThread & LingThreadContinuityV2 & {
  readonly nextItemSequence: number;
};

/**
 * Identifies the conversation surface without overloading canonical Thread ids
 * with ConversationItem anchor ids.
 */
export type ChannelConversationSurface =
  | { readonly kind: "channel_root" }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "topic"; readonly anchorItemId: string };

export interface ListChannelConversationItemsOptions {
  readonly limit?: number;
  readonly beforeSequence?: number;
  /** Omitted and `channel_root` both select the Channel Root conversation. */
  readonly surface?: ChannelConversationSurface;
}

/**
 * Non-authoritative display metadata that cannot be reconstructed from an item alone.
 * The item remains the timeline authority; clients may discard and reload decorations.
 */
export interface ChannelConversationItemDecoration {
  readonly itemId: string;
  readonly linkedRunId?: string;
  readonly editedAt?: string;
  readonly pendingReplacement?: ConversationPendingReplacement;
  readonly webEvidence?: MessageWebEvidence;
}

export interface ChannelConversationItemPageResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly thread: ChannelConversationThread;
  readonly turns: readonly LingTurn[];
  readonly items: readonly ConversationItemV1[];
  readonly decorations: readonly ChannelConversationItemDecoration[];
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly hasMore: boolean;
  /** Stable per-thread sequence cursor. The next page contains only lower sequences. */
  readonly nextBeforeSequence?: number;
}

export interface CreateChannelTurnRequest {
  readonly idempotencyKey?: string;
  /** Omitted and `channel_root` both append to the Channel Root conversation. */
  readonly surface?: ChannelConversationSurface;
  readonly contextSegmentId?: string;
  readonly body: string;
  readonly mentions?: readonly ChannelMention[];
  readonly attachmentIds?: readonly string[];
  readonly linkPreviewIds?: readonly string[];
  readonly fileRefs?: readonly ChannelMessageFileRef[];
  readonly requestAiReply?: boolean;
  readonly replyDisposition?: {
    readonly mode: "queue_followup";
    readonly activeRunId?: string;
  };
  readonly providerPresetId?: string;
  readonly teammateId?: string;
}

export interface ChannelConversationTurnResponse {
  readonly thread: ChannelConversationThread;
  readonly turn: LingTurn;
  readonly userItem: ConversationItemV1;
  readonly assistantItems?: readonly ConversationItemV1[];
  readonly decorations: readonly ChannelConversationItemDecoration[];
  readonly replyDispatch?: ChannelReplyDispatch;
  readonly autoStartedWorkflow?: {
    readonly proposal: ChannelExecutionProposal;
    readonly workflow: ChannelWorkflow;
    readonly workflowSteps: readonly ChannelWorkflowStep[];
    readonly orchestration?: ChannelWorkflowOrchestrationResponse;
  };
}

export interface ChannelConversationStreamReadyEvent {
  readonly thread: ChannelConversationThread;
  readonly turn: LingTurn;
  readonly userItem: ConversationItemV1;
  readonly assistantItems?: readonly ConversationItemV1[];
  readonly decorations: readonly ChannelConversationItemDecoration[];
}

export interface ChannelConversationStreamReplyPendingEvent {
  readonly sourceItemId: string;
  readonly targetTeammateId: string;
  readonly startedAt: string;
}

export interface ChannelConversationStreamDeltaEvent {
  readonly itemId: string;
  readonly delta: string;
  readonly body: string;
}

export interface ChannelConversationStreamRunLinkedEvent {
  readonly itemId: string;
  readonly linkedRunId: string;
  readonly activeReply?: ConversationActiveReplyTarget;
}

export interface ChannelConversationStreamDoneEvent extends ChannelConversationTurnResponse {}

export interface ChannelConversationStreamBlockedEvent extends ChannelConversationTurnResponse {
  readonly error?: string;
}

export interface ChannelConversationStreamErrorEvent {
  readonly thread?: ChannelConversationThread;
  readonly turn?: LingTurn;
  readonly userItem?: ConversationItemV1;
  readonly assistantItems?: readonly ConversationItemV1[];
  readonly decorations?: readonly ChannelConversationItemDecoration[];
  readonly replyDispatch?: ChannelReplyDispatch;
  readonly error: string;
}

export interface ChannelConversationContextInspectResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly thread: ChannelConversationThread;
  readonly turn: LingTurn;
  readonly sourceItemId: string;
  readonly segment: ContextSegment;
  readonly segments: readonly ContextSegment[];
  readonly assignment: TurnContextAssignment;
  readonly projection: ConversationContextProjectionMetadata;
  readonly summaries: readonly ConversationContextSummary[];
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly droppedItemCount: number;
  readonly redactedItemCount: number;
  readonly safety: {
    readonly rawPromptTextIncluded: false;
    readonly hiddenReasoningIncluded: false;
    readonly privateMemoryBodiesIncluded: false;
    readonly secretValuesIncluded: false;
  };
}

export interface CorrectChannelTurnContextRequest {
  readonly segmentId: string;
  readonly expectedAssignmentRevision: number;
}

export interface CorrectChannelTurnContextResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly thread: ChannelConversationThread;
  readonly turn: LingTurn;
  readonly segment: ContextSegment;
  readonly assignment: TurnContextAssignment;
  readonly previousAssignment: TurnContextAssignment;
  readonly invalidatedSummaryIds: readonly string[];
  readonly projection: ConversationContextProjectionMetadata;
  readonly idempotentReplay: boolean;
}
