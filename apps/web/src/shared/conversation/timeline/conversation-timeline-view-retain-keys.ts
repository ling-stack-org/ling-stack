import type { ConversationTimelineItem } from "@ling-stack/conversation-ui-core";
import type { ConversationViewRetainKeys } from "../view-store/conversation-view-store.js";

/** Stable view-store identity for the single disclosure owned by an Agent span. */
export function conversationTimelineSubAgentDisclosureKey(itemId: string): string {
  return `timeline-sub-agent:${itemId}`;
}

/**
 * Collects every view-store identity owned by a Timeline snapshot. The walk is
 * intentionally recursive because collapsed batches and nested Agent timelines
 * still own disclosure state that must survive an SSE/revision replacement.
 */
export function collectConversationTimelineViewRetainKeys(
  items: readonly ConversationTimelineItem[],
  seed?: ConversationViewRetainKeys,
): ConversationViewRetainKeys {
  const blockIds = new Set(seed?.blockIds ?? []);
  const spanIds = new Set(seed?.spanIds ?? []);
  const actionIds = new Set(seed?.actionIds ?? []);

  const collect = (item: ConversationTimelineItem): void => {
    if (item.actionId) actionIds.add(item.actionId);

    if (item.kind === "commandBatch") {
      blockIds.add(item.batch.id);
      item.actionIds.forEach((actionId) => actionIds.add(actionId));
      item.childActionIds.forEach((actionId) => actionIds.add(actionId));
      for (const command of item.batch.commands) {
        collect(command);
        command.leadingItems?.forEach(collect);
      }
      return;
    }

    if (item.kind === "explorationBatch") {
      blockIds.add(item.batch.id);
      item.actionIds.forEach((actionId) => actionIds.add(actionId));
      item.childActionIds.forEach((actionId) => actionIds.add(actionId));
      item.batch.children.forEach(collect);
      return;
    }

    if (item.kind === "subAgentActivity") {
      blockIds.add(conversationTimelineSubAgentDisclosureKey(item.id));
      item.childItems.forEach(collect);
      return;
    }

    if (item.kind !== "userMessage" && item.kind !== "agentMessage") {
      blockIds.add(`timeline-item:${item.id}`);
    }
  };

  items.forEach(collect);
  return { blockIds, spanIds, actionIds };
}
