import type { ConversationTranscriptMessage, LingThread, LingTurn, RunSession } from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";

/** Read canonical narration only after caller verifies thread access; never repair history on GET. */
export function publishedNormalConversationMessage(
  store: RunStore, thread: LingThread, turn: LingTurn, run: RunSession,
): ConversationTranscriptMessage | undefined {
  const item = store.getConversationItem(`narration:${run.id}`);
  if (!item || item.kind !== "assistant_message" || !item.payload.runNarration) return undefined;
  const saved = item.payload.runNarration, source = saved.source;
  if (saved.messageId !== `conversation-assistant:${turn.id}`) return undefined;
  if (thread.kind !== "conversation" || item.threadId !== thread.id || item.turnId !== turn.id
    || item.workspaceId !== thread.workspaceId || item.channelId || source.runId !== run.id
    || source.threadId !== thread.id || source.turnId !== turn.id || saved.sourceItemId !== turn.sourceItemId
    || source.workUnitId !== run.workUnitId || source.participantId !== "ling_agent"
    || item.actorType !== "ling_agent" || item.actorId !== "ling_agent"
    || item.visibility !== "thread_participants" || item.visibilityOwnerId
    || !["succeeded", "failed", "cancelled"].includes(run.status)
    || (run.status === "succeeded" && item.payload.deliveryStatus !== "ready")
    || (run.status === "failed" && item.payload.deliveryStatus !== "failed")
    || (run.status === "cancelled" && item.payload.deliveryStatus !== "blocked")) return undefined;
  return { id: saved.messageId, canonicalItemId: item.id, role: "assistant", authorId: "ling_agent",
    threadId: thread.id, turnId: turn.id, runId: run.id, content: item.payload.body, contentSource: "run_narration",
    narrationSegments: saved.segments.map(segment => ({ ...segment, source })),
    status: run.status as "succeeded" | "failed" | "cancelled", errorMessage: run.errorMessage,
    createdAt: run.createdAt, updatedAt: item.updatedAt };
}
