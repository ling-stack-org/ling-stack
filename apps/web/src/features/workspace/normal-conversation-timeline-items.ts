import {
  mergeConversationRunNarration,
  interleaveConversationUserInputRows,
  projectConversationRunNarration,
  type ConversationTimelineItem,
  type ConversationTimelineMessageItem,
  type ConversationTimelineUserInputItem,
} from "@ling-stack/conversation-ui-core";
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
  const narration: ConversationTimelineMessageItem[] = [];
  const items = flattenFeedRows(feedItems).flatMap<ConversationTimelineItem>((item) => {
    const message = feedItems.find((feedItem) => feedItem.message.id === item.itemId)?.message;
    if (item.kind !== "agentMessage" || !message?.runId || !message.narrationSegments?.length) return [item];
    narration.push(...projectConversationRunNarration({
      message: item,
      segments: message.narrationSegments,
      runId: message.runId,
      // No canonical snapshot exists yet. Keep the optimistic message position
      // without claiming its synthetic id is a persisted ConversationItem.
      anchor: { ...item, itemId: undefined, sourceRefs: [] },
    }));
    return [];
  });
  return interleaveConversationUserInputRows(mergeConversationRunNarration(items.filter(item => !isUserInput(item)), narration), items.filter(isUserInput));
}

function flattenFeedRows(
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
 * assistant segments use their durable event sequence to interleave with tool
 * starts. Legacy messages without event positions remain after their turn.
 */
export function selectNormalTimelineItems(
  items: readonly ConversationTimelineItem[],
  feedItems: readonly NormalConversationFeedItem[],
): readonly ConversationTimelineItem[] {
  const messageIds = new Set(feedItems.flatMap((item) => [item.message.id, ...(item.message.canonicalItemId ? [item.message.canonicalItemId] : [])]));
  const turnIds = new Set(feedItems.map((item) => item.message.turnId).filter((id): id is string => Boolean(id)));
  const runIds = new Set(feedItems.map((item) => item.message.runId).filter((id): id is string => Boolean(id)));
  const selectedCanonicalItems = items.filter((item) => {
    // The scoped Host anchor owns Q/A, not a legacy message-store relation.
    if (item.kind === "userInputRequest" || item.kind === "userInputAnswer") return true;
    if (item.kind === "userMessage" || item.kind === "agentMessage") {
      if (item.logicalMessageId) {
        return feedItems.some(feed => feed.message.id === item.logicalMessageId && feed.message.runId === item.runId);
      }
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
  for (const item of selectedCanonicalItems) {
    if ((item.kind === "agentMessage" || item.kind === "userMessage") && item.logicalMessageId) canonicalMessageIds.add(item.logicalMessageId);
  }
  for (const feed of feedItems) {
    if (feed.message.canonicalItemId && canonicalMessageIds.has(feed.message.canonicalItemId)) canonicalMessageIds.add(feed.message.id);
  }
  const fallbackNarrativeItems = flattenFeedRows(feedItems)
    .filter((item) => (
      (item.kind === "userMessage" || item.kind === "agentMessage")
      && item.itemId !== undefined
      && !canonicalMessageIds.has(item.itemId)
      && !canonicalIds.has(item.id)
    ))
    .flatMap<ConversationTimelineItem>((item) => {
      const feedItem = feedItems.find((candidate) => candidate.message.id === item.itemId);
      const segments = feedItem?.message.narrationSegments;
      const runId = feedItem?.message.runId;
      if (item.kind === "agentMessage" && segments?.length && runId) {
        const anchor = selectedCanonicalItems.find((candidate) =>
          candidate.kind === "userMessage" && candidate.turnId === item.turnId,
        ) ?? selectedCanonicalItems.find((candidate) => candidate.runId === runId);
        return projectConversationRunNarration({
          message: item,
          segments,
          runId,
          anchor: anchor ?? { ...item, itemId: undefined, sourceRefs: [] },
        });
      }
      return [anchorMissingNarrativeItem(item, selectedCanonicalItems)];
    });

  const eventNarration = fallbackNarrativeItems.filter((item): item is ConversationTimelineMessageItem =>
    item.kind === "agentMessage" && item.sourceEventSequence !== undefined,
  );
  return interleaveConversationUserInputRows(mergeConversationRunNarration(
    [...selectedCanonicalItems.filter(item => !isUserInput(item)), ...fallbackNarrativeItems.filter((item) =>
      item.kind !== "agentMessage" || item.sourceEventSequence === undefined,
    )].sort(compareTimelineItems),
    eventNarration,
  ), selectedCanonicalItems.filter(isUserInput));
}

function isUserInput(item: ConversationTimelineItem): item is ConversationTimelineUserInputItem {
  return item.kind === "userInputRequest" || item.kind === "userInputAnswer";
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
  const firstFactPartIndex = item.kind === "agentMessage"
    ? related
        .filter((candidate) => candidate.kind !== "userMessage" && candidate.kind !== "agentMessage")
        .reduce<number | undefined>((minimum, candidate) => minimum === undefined
          ? candidate.partIndex
          : Math.min(minimum, candidate.partIndex), undefined)
    : undefined;
  const partIndex = firstFactPartIndex ?? Math.max(...related.map((candidate) => candidate.partIndex)) + 1;
  return { ...item, threadSequence, partIndex };
}

function compareTimelineItems(left: ConversationTimelineItem, right: ConversationTimelineItem): number {
  return left.threadSequence - right.threadSequence
    || left.partIndex - right.partIndex
    || timelineItemTieRank(left) - timelineItemTieRank(right)
    || left.id.localeCompare(right.id);
}

function timelineItemTieRank(item: ConversationTimelineItem): number {
  if (item.kind === "userMessage") return 0;
  if (item.kind === "agentMessage") return 1;
  return 2;
}
