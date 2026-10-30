import type { ChannelMessage, ConversationGeneratedMedia, ConversationItemV1 } from "../../types.js";
import type { ChannelConversationMessagePage } from "../../lib/channel-conversation-items.js";

interface CachedConversation {
  readonly messages: readonly ChannelMessage[];
  readonly items: readonly ConversationItemV1[];
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly hasOlder: boolean;
  readonly before?: number;
}

/** Replace the server's raw sequence window, retaining only previously loaded older pages. */
export function reconcileChannelSessionMessageCache(
  cached: CachedConversation | undefined,
  incoming: ChannelConversationMessagePage,
  hydratedItems: readonly ConversationItemV1[],
): CachedConversation {
  const boundary = incoming.hasMore ? incoming.nextBeforeSequence : undefined;
  const older = boundary === undefined ? [] : (cached?.items ?? []).filter(item => item.sequence < boundary);
  const olderIds = new Set(older.map(item => item.id));
  const visibleIds = new Set([...older, ...incoming.conversationItems].map(item => item.id));
  const items = new Map([...older, ...hydratedItems.filter(item => visibleIds.has(item.id))].map(item => [item.id, item]));
  const messages = new Map([...(cached?.messages ?? []).filter(message => olderIds.has(message.id)), ...incoming.messages]
    .map(message => [message.id, message]));
  const media = new Map([...(cached?.generatedMedia ?? []).filter(item => item.messageId && olderIds.has(item.messageId)), ...incoming.generatedMedia]
    .map(item => [item.mediaJobId, item]));
  return {
    items: [...items.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)),
    messages: [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    generatedMedia: [...media.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.mediaJobId.localeCompare(b.mediaJobId)),
    hasOlder: older.length ? cached!.hasOlder : incoming.hasMore,
    before: older.length ? cached!.before : incoming.nextBeforeSequence,
  };
}
