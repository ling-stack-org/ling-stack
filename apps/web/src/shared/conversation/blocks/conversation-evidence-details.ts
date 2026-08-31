import type {
  ConversationWorkCellEvidenceLink,
  ConversationWorkCellGroup,
} from "../../../lib/conversation-work-cell.js";

/** Async state for optional audit details; the primary feed never depends on it. */
export type ConversationTimelineDetailsStatus = "not_loaded" | "loading" | "loaded" | "empty" | "error";

export interface ConversationTimelineDetailsState {
  readonly status: ConversationTimelineDetailsStatus;
  readonly groups?: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks?: readonly ConversationWorkCellEvidenceLink[];
  readonly errorMessage?: string;
}

/** @deprecated Rename callers to ConversationTimelineDetailsState in the next cleanup. */
export type ConversationWorkCellDetailsState = ConversationTimelineDetailsState;
