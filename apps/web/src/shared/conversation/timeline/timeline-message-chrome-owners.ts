import type { ConversationTimelineItem } from "@ling-stack/conversation-ui-core";

/**
 * Select one row for each logical message's attachments and full-message actions.
 * The caller supplies a single scoped timeline in display order; only its last
 * narration segment owns message chrome. Facts and canonical identity stay intact.
 */
export function timelineMessageChromeOwnerIds(
  items: readonly ConversationTimelineItem[],
): ReadonlySet<string> {
  const owners = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "userMessage" && item.kind !== "agentMessage") continue;
    const key = JSON.stringify([
      item.kind,
      item.itemId ?? item.id,
      item.turnId ?? null,
      item.runId ?? null,
      item.attemptId ?? null,
      item.participantId ?? null,
      item.workflowStepId ?? null,
    ]);
    owners.set(key, item.id);
  }
  return new Set(owners.values());
}
