import type { ConversationTimelineItem } from "@ling-stack/conversation-ui-core";
import type { NormalConversationFeedItem } from "./normal-conversation-feed-view-models.js";

/**
 * Compatibility adapter for an optimistic normal feed that has not received
 * the canonical Continuity projection yet. It preserves the feed order and
 * re-bases local positions so the surface still owns one deterministic
 * Timeline instead of one Timeline per message.
 */
export function flattenNormalTimelineItems(
  feedItems: readonly NormalConversationFeedItem[],
): readonly ConversationTimelineItem[] {
  const seen = new Set<string>();
  const flattened: ConversationTimelineItem[] = [];
  feedItems.forEach((feedItem, messageIndex) => {
    feedItem.timelineItems.forEach((item, partIndex) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      flattened.push({
        ...item,
        threadSequence: messageIndex,
        partIndex,
      });
    });
  });
  return flattened;
}

/**
 * Merge canonical durable facts with the compatibility message view without
 * allowing a partial canonical snapshot to reorder the narrative. Missing
 * assistant messages are anchored to their turn's canonical sequence and are
 * placed after that turn's facts.
 */
export function selectNormalTimelineItems(
  items: readonly ConversationTimelineItem[],
  feedItems: readonly NormalConversationFeedItem[],
): readonly ConversationTimelineItem[] {
  const messageIds = new Set(feedItems.map((item) => item.message.id));
  const turnIds = new Set(feedItems.map((item) => item.message.turnId).filter((id): id is string => Boolean(id)));
  const runIds = new Set(feedItems.map((item) => item.message.runId).filter((id): id is string => Boolean(id)));
  const selectedCanonicalItems = items.filter((item) => {
    if (item.kind === "userMessage" || item.kind === "agentMessage") {
      return Boolean(item.itemId && messageIds.has(item.itemId));
    }
    return Boolean((item.turnId && turnIds.has(item.turnId)) || (item.runId && runIds.has(item.runId)));
  });

  const canonicalMessageIds = new Set(
    selectedCanonicalItems
      .filter((item) => item.kind === "userMessage" || item.kind === "agentMessage")
      .map((item) => item.itemId)
      .filter((id): id is string => Boolean(id)),
  );
  const canonicalIds = new Set(selectedCanonicalItems.map((item) => item.id));
  const fallbackNarrativeItems = flattenNormalTimelineItems(feedItems)
    .filter((item) => (
      (item.kind === "userMessage" || item.kind === "agentMessage")
      && item.itemId !== undefined
      && !canonicalMessageIds.has(item.itemId)
      && !canonicalIds.has(item.id)
    ))
    .map((item) => anchorMissingNarrativeItem(item, selectedCanonicalItems));

  return [...selectedCanonicalItems, ...fallbackNarrativeItems].sort(compareTimelineItems);
}

export function maxTimelineRevision(items: readonly ConversationTimelineItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.revision), 0);
}

function anchorMissingNarrativeItem(
  item: ConversationTimelineItem,
  canonicalItems: readonly ConversationTimelineItem[],
): ConversationTimelineItem {
  if (item.kind !== "userMessage" && item.kind !== "agentMessage") {
    return item;
  }
  const related = canonicalItems.filter((candidate) =>
    (item.turnId && candidate.turnId === item.turnId) ||
    (item.runId && candidate.runId === item.runId),
  );
  if (related.length === 0) {
    return item;
  }
  const threadSequence = Math.min(...related.map((candidate) => candidate.threadSequence));
  const partIndex = Math.max(...related.map((candidate) => candidate.partIndex)) + 1;
  return { ...item, threadSequence, partIndex };
}

function compareTimelineItems(left: ConversationTimelineItem, right: ConversationTimelineItem): number {
  return left.threadSequence - right.threadSequence || left.partIndex - right.partIndex || left.id.localeCompare(right.id);
}
