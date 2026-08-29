import type { ConversationTimelineItem } from "./transcript-item.js";
import { isConversationTimelineItem } from "./transcript-item.js";

/**
 * Merge a replay/snapshot into the currently rendered transcript.
 *
 * Items are keyed by their durable projection identity. An older or equal
 * revision is ignored, while a newer revision replaces the payload in place.
 * The incoming order is authoritative for items present in the snapshot; items
 * that are still only present in the current view are retained at the end so a
 * reconnect cannot make an optimistic/streaming item disappear before the
 * authoritative owner acknowledges it.
 */
export function mergeConversationTimelineItems(
  current: readonly ConversationTimelineItem[],
  incoming: readonly unknown[],
): readonly ConversationTimelineItem[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  const merged: ConversationTimelineItem[] = [];
  const seen = new Set<string>();

  for (const candidate of incoming) {
    if (!isConversationTimelineItem(candidate) || seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    const previous = currentById.get(candidate.id);
    if (previous && candidate.revision <= previous.revision) {
      merged.push(previous);
    } else {
      merged.push(candidate);
    }
  }

  for (const item of current) {
    if (!seen.has(item.id)) {
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Keep only well-formed typed items at an adapter boundary. Invalid records are
 * deliberately dropped here because the raw-row projector already creates a
 * visible blocked generic item for malformed WorkCell rows.
 */
export function normalizeConversationTimelineItems(
  items: readonly unknown[],
): readonly ConversationTimelineItem[] {
  return items.filter(isConversationTimelineItem);
}
