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
  readonly waitingPlaceholder?: boolean;
  readonly revision?: number;
  readonly threadSequence: number;
  readonly partIndex?: number;
  readonly status?: ConversationTimelineItemStatus;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly participantId?: string;
  readonly sourceRefs?: readonly ConversationOperationSourceRef[];
  /**
   * Persisted message file references are display-only until the Host has
   * validated and upgraded them to a trusted source ref.  Keeping them on the
   * canonical message item prevents each surface from inventing its own path
   * handling while preserving the no-navigation default.
   */
  readonly fileRefs?: readonly ConversationTimelineFileRefInput[];
  readonly phase?: "commentary" | "final";
}

export interface ConversationTimelineFileRefInput {
  readonly path: string;
  readonly label?: string;
  readonly line?: number;
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
  const sourceRefs = mergeMessageSourceRefs(
    input.sourceRefs ?? (itemId ? [{ kind: "conversation_item", id: itemId }] : []),
    input.fileRefs ?? [],
    itemId,
  );
  const revision = input.revision;
  return {
    id: input.id,
    kind: input.role === "user" ? "userMessage" : "agentMessage",
    markdown: input.markdown,
    ...(input.waitingPlaceholder && input.role === "agent" && (input.status === "pending" || input.status === "running")
      ? { waitingPlaceholder: true } : {}),
    phase: input.phase ?? (input.role === "agent" && input.status === "succeeded" ? "final" : "commentary"),
    revision: Number.isSafeInteger(revision) && (revision ?? 0) >= 0 ? revision ?? 1 : 1,
    threadSequence: input.threadSequence,
    partIndex: input.partIndex ?? 0,
    status: input.status,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.participantId ? { participantId: input.participantId } : {}),
    sourceRefs,
  };
}

/**
 * Converts message file refs into safe, copyable source refs.  This function
 * deliberately does not add `hostTarget`: a path supplied by a message is not
 * proof that the file exists in the current workspace.  A daemon/Host adapter
 * may later replace the matching ref with a minted trusted capability.
 */
export function conversationMessageSourceRefs(
  itemId: string | undefined,
  fileRefs: readonly ConversationTimelineFileRefInput[] = [],
  sourceRefs: readonly ConversationOperationSourceRef[] = [],
): readonly ConversationOperationSourceRef[] {
  return mergeMessageSourceRefs(sourceRefs, fileRefs, itemId);
}

function mergeMessageSourceRefs(
  sourceRefs: readonly ConversationOperationSourceRef[],
  fileRefs: readonly ConversationTimelineFileRefInput[],
  itemId: string | undefined,
): readonly ConversationOperationSourceRef[] {
  const refs: ConversationOperationSourceRef[] = [
    ...(sourceRefs.length > 0
      ? sourceRefs
      : itemId
        ? [{ kind: "conversation_item", id: itemId }]
        : []),
  ];
  for (const fileRef of fileRefs) {
    const path = fileRef.path.trim();
    if (!path) continue;
    refs.push({
      kind: "path",
      id: `message-file:${itemId ?? "unknown"}:${path}:${fileRef.line ?? ""}`,
      path,
      ...(fileRef.label?.trim() ? { label: fileRef.label.trim() } : {}),
      visibility: "conversation",
    });
  }
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
