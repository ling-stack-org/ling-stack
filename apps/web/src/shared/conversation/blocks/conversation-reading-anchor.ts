export interface ConversationReadingAnchor {
  readonly rowKey: string;
  readonly parentSubAgentId?: string;
  readonly offsetTop: number;
}

export const conversationMeasurementScrollEvent = "ling:conversation-measurement-scroll";

const rowSelector = "[data-conversation-row-key]";

export function readConversationReadingAnchor(feed: HTMLElement): ConversationReadingAnchor | undefined {
  const viewport = feed.getBoundingClientRect();
  for (const row of feed.querySelectorAll<HTMLElement>(rowSelector)) {
    const rowKey = row.dataset.conversationRowKey;
    if (!rowKey) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= viewport.top + 12 || rect.top >= viewport.bottom - 12) continue;
    return {
      rowKey,
      parentSubAgentId: row.dataset.conversationParentSubAgentId,
      offsetTop: rect.top - viewport.top,
    };
  }
  return undefined;
}

/** Restore an existing row, or its collapsed parent, without opening disclosure. */
export function restoreConversationReadingAnchor(feed: HTMLElement, anchor: ConversationReadingAnchor): boolean {
  const rows = Array.from(feed.querySelectorAll<HTMLElement>(rowSelector));
  const row = rows.find(element => element.dataset.conversationRowKey === anchor.rowKey)
    ?? (anchor.parentSubAgentId ? rows.find(element =>
      element.dataset.feedItemId === anchor.parentSubAgentId
      && element.dataset.conversationTimelineDepth === "0") : undefined);
  if (!row) return false;
  const delta = row.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchor.offsetTop;
  if (Math.abs(delta) > 1) feed.scrollTop += delta;
  return true;
}
