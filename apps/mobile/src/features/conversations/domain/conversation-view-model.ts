import type { RemoteConversationKindV1, RemoteConversationSummaryV1 } from "@ling-stack/contracts";

export type ConversationFilter = "all" | RemoteConversationKindV1;

export function filterAndSortConversations(
  conversations: readonly RemoteConversationSummaryV1[],
  filter: ConversationFilter,
): RemoteConversationSummaryV1[] {
  return conversations
    .filter((conversation) => filter === "all" || conversation.kind === filter)
    .sort((left, right) => {
      const leftTime = left.latestMessageAt ?? left.updatedAt;
      const rightTime = right.latestMessageAt ?? right.updatedAt;
      return rightTime.localeCompare(leftTime) || left.title.localeCompare(right.title);
    });
}

export function conversationKindLabel(kind: RemoteConversationKindV1): string {
  return kind === "channel" ? "频道" : kind === "conversation" ? "会话" : "私聊";
}

export function conversationListKindLabel(conversation: RemoteConversationSummaryV1): string {
  if (conversation.kind === "channel") {
    return `频道${conversation.memberCount ? ` · ${conversation.memberCount} 位成员` : ""}`;
  }
  if (conversation.kind === "teammate_direct") {
    return `私聊${conversation.identity.subtitle ? ` · ${conversation.identity.subtitle}` : ""}`;
  }
  return "会话";
}

export function conversationDetailSubtitle(conversation: RemoteConversationSummaryV1): string {
  if (conversation.kind === "channel") {
    return `频道${conversation.memberCount ? ` · ${conversation.memberCount} 位成员` : ""}`;
  }
  if (conversation.kind === "teammate_direct") {
    return conversation.identity.subtitle ? `${conversation.identity.subtitle} · 私聊` : "队友私聊";
  }
  return "与 Ling 对话";
}

export function conversationGlyph(conversation: RemoteConversationSummaryV1): string {
  if (conversation.kind === "channel") {
    return "#";
  }
  if (conversation.kind === "conversation") {
    return "L";
  }
  return initials(conversation.identity.label || conversation.title);
}

export function initials(value: string): string {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  if (parts.length > 1) {
    return `${[...parts[0]!][0] ?? ""}${[...parts.at(-1)!][0] ?? ""}`.toUpperCase();
  }
  return ([...(parts[0] ?? "L")][0] ?? "L").toUpperCase();
}

export function relativeTimestamp(value?: string, now = Date.now()): string {
  if (!value) {
    return "";
  }
  const timestamp = Date.parse(value);
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟`;
  const date = new Date(timestamp);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  const yesterday = new Date(now - 24 * 60 * 60_000);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  if (elapsed < 3 * 24 * 60 * 60_000) {
    return date.toLocaleDateString("zh-CN", { weekday: "short" });
  }
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

export function messageTimestamp(value: string, now = Date.now()): string {
  const date = new Date(value);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(now - 24 * 60 * 60_000);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${time}`;
}

export function transcriptDayLabel(value?: string, now = Date.now()): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now - 24 * 60 * 60_000);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} ${time}`;
}
