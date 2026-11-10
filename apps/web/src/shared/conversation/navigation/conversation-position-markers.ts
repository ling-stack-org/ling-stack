import type { ConversationTimelineItem, ConversationTimelineMessageItem } from "@ling-stack/conversation-ui-core";

export interface ConversationPositionMarker {
  readonly id: string;
  readonly item: ConversationTimelineMessageItem;
  readonly itemIds: readonly string[];
  readonly preview: string;
}

/** A disposable index of the scoped timeline; never a second message/history store. */
export function conversationPositionMarkers(items: readonly ConversationTimelineItem[]): readonly ConversationPositionMarker[] {
  const markers = new Map<string, { item: ConversationTimelineMessageItem; itemIds: string[]; text: string[] }>();
  for (const item of items) {
    if ((item.kind !== "userMessage" && item.kind !== "agentMessage") || item.waitingPlaceholder) continue;
    if (!item.markdown.trim() && item.sourceRefs.length === 0) continue;
    const id = JSON.stringify([item.kind, item.participantId, item.runId, item.logicalMessageId ?? item.itemId ?? item.id]);
    const marker = markers.get(id);
    if (marker) {
      marker.itemIds.push(item.id);
      if (item.markdown && !marker.text.includes(item.markdown)) marker.text.push(item.markdown);
    } else {
      markers.set(id, { item, itemIds: [item.id], text: [item.markdown] });
    }
  }
  return [...markers].map(([id, marker]) => ({
    id, item: marker.item, itemIds: marker.itemIds,
    preview: positionPreviewText(marker.text.join("\n")),
  }));
}

/** Plain text only: preview content cannot execute HTML or open model-provided links. */
export function positionPreviewText(markdown: string): string {
  const text = markdown.slice(0, 4000)
    .replace(/```[^\n]*\n?/gu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gu, "$1")
    .replace(/[*_`~]/gu, "")
    .replace(/\s+/gu, " ").trim();
  const characters = [...text];
  return characters.length > 140 ? `${characters.slice(0, 140).join("")}…` : text;
}
