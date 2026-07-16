export type TranscriptBlockKind =
  | "coordinator_message"
  | "operation"
  | "agent_activity"
  | "approval"
  | "artifact_strip"
  | "source_summary"
  | "requirement_shaping"
  | "decision_needed"
  | "final_result"
  | "raw_debug_ref";

export type TranscriptBlockStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "failed"
  | "cancelled"
  | "succeeded";

export type TranscriptDisplayLineTone =
  | "default"
  | "muted"
  | "running"
  | "waiting"
  | "success"
  | "failed";

export interface TranscriptDisplayLine {
  readonly id: string;
  readonly text: string;
  readonly tone?: TranscriptDisplayLineTone;
  readonly meta?: string;
}

export type TranscriptDetailMode = "inline" | "in_turn_preview" | "lightbox" | "raw_debug";

export interface TranscriptExpandedDetail {
  readonly mode: TranscriptDetailMode;
  readonly title?: string;
  readonly summary?: string;
  readonly lines?: readonly TranscriptDisplayLine[];
}

export type ConversationPreviewTargetKind =
  | "file"
  | "diff"
  | "image"
  | "artifact"
  | "link"
  | "source"
  | "approval"
  | "raw_debug";

export interface ConversationPreviewTarget {
  readonly id: string;
  readonly kind: ConversationPreviewTargetKind;
  readonly label: string;
  readonly href?: string;
  readonly metadata?: readonly TranscriptDisplayLine[];
}

export interface RawDetailRef {
  readonly id: string;
  readonly source: string;
}

export interface TranscriptBlockBase<TKind extends TranscriptBlockKind = TranscriptBlockKind> {
  readonly id: string;
  readonly turnId: string;
  readonly kind: TKind;
  readonly status?: TranscriptBlockStatus;
  /**
   * Blocks with the same id update in place. A higher revision means renderers should
   * preserve disclosure state where possible while refreshing display and details.
   */
  readonly revision?: number;
  readonly updatedAt?: string;
  readonly ownerId?: string;
  readonly display: readonly TranscriptDisplayLine[];
  readonly expanded?: TranscriptExpandedDetail;
  readonly previewTargets?: readonly ConversationPreviewTarget[];
  readonly raw?: RawDetailRef;
}

export type TranscriptBlock = TranscriptBlockBase;

export interface ConversationTurn<TBlock extends TranscriptBlockBase = TranscriptBlock> {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly blocks: readonly TBlock[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ConversationTranscript<TTurn extends ConversationTurn = ConversationTurn> {
  readonly schemaVersion: 1;
  readonly surfaceId: string;
  readonly turns: readonly TTurn[];
}
