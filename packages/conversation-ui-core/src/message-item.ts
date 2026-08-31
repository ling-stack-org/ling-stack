import type {
  ConversationTimelineItemStatus,
  ConversationTimelineMessageItem,
} from "./transcript-item.js";
import type { ConversationOperationSourceRef } from "./work-cell-view-model.js";

/**
 * Framework-neutral input for the single message item constructor used by all
 * conversation surfaces. Surface adapters may choose author labels and policy
 * chrome, but they must not invent a second message item shape.
 */
export interface ConversationTimelineMessageInput {
  readonly id: string;
  readonly role: "user" | "agent";
  readonly markdown: string;
  readonly revision?: number;
  readonly threadSequence: number;
  readonly partIndex?: number;
  readonly status?: ConversationTimelineItemStatus;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly sourceRefs?: readonly ConversationOperationSourceRef[];
  readonly phase?: "commentary" | "final";
}

/**
 * Create the canonical message item. Identity, source refs and phase remain
 * explicit so no route can fall back to matching message bodies or changing
 * message semantics for private/channel views.
 */
export function createConversationTimelineMessageItem(
  input: ConversationTimelineMessageInput,
): ConversationTimelineMessageItem {
  const itemId = input.itemId?.trim();
  const sourceRefs = input.sourceRefs && input.sourceRefs.length > 0
    ? input.sourceRefs
    : itemId
      ? [{ kind: "conversation_item", id: itemId }]
      : [];
  const revision = input.revision;
  return {
    id: input.id,
    kind: input.role === "user" ? "userMessage" : "agentMessage",
    markdown: input.markdown,
    phase: input.phase ?? (input.role === "agent" && input.status === "succeeded" ? "final" : "commentary"),
    revision: Number.isSafeInteger(revision) && (revision ?? 0) >= 0 ? revision ?? 1 : 1,
    threadSequence: input.threadSequence,
    partIndex: input.partIndex ?? 0,
    status: input.status,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    sourceRefs,
  };
}
