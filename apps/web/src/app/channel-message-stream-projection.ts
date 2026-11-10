import type {
  ChannelConversationTurnResponse,
  ChannelMessage,
  ChannelReplyDispatch,
  ConversationItemV1,
} from "../types.js";

export interface ChannelPresentationStreamReadyEvent {
  readonly message: ChannelMessage;
  readonly conversationItems?: readonly ConversationItemV1[];
  readonly aiReply?: ChannelMessage;
  readonly aiReplies?: readonly ChannelMessage[];
}

export interface ChannelPresentationStreamTerminalEvent {
  readonly message?: ChannelMessage;
  readonly conversationItems?: readonly ConversationItemV1[];
  readonly aiReply?: ChannelMessage;
  readonly aiReplies?: readonly ChannelMessage[];
  readonly replyDispatch?: ChannelReplyDispatch;
  readonly autoStartedWorkflow?: ChannelConversationTurnResponse["autoStartedWorkflow"];
  readonly error?: string;
}

export interface ChannelPresentationStreamErrorEvent extends ChannelPresentationStreamTerminalEvent {
  readonly error: string;
}

export function projectChannelStreamReady(
  current: readonly ChannelMessage[],
  event: ChannelPresentationStreamReadyEvent,
): readonly ChannelMessage[] {
  const replies = channelStreamReplies(event);
  return replies.length > 0
    ? upsertChannelMessages(current, [event.message, ...replies])
    : current;
}

export function projectChannelItemsReady(
  current: readonly ConversationItemV1[],
  event: ChannelPresentationStreamReadyEvent,
): readonly ConversationItemV1[] {
  return mergeConversationItems(current, event.conversationItems ?? []);
}

export function projectChannelStreamTerminal(
  current: readonly ChannelMessage[],
  event: ChannelPresentationStreamTerminalEvent,
): readonly ChannelMessage[] {
  const replies = channelStreamReplies(event);
  if (event.replyDispatch?.disposition === "followup_queued") {
    return upsertChannelMessages(
      current.filter((message) => message.id !== event.message?.id),
      replies,
    );
  }
  return event.message
    ? upsertChannelMessages(current, [event.message, ...replies])
    : upsertChannelMessages(current, replies);
}

export function projectChannelItemsTerminal(
  current: readonly ConversationItemV1[],
  event: ChannelPresentationStreamTerminalEvent,
): readonly ConversationItemV1[] {
  const incoming = event.conversationItems ?? [];
  if (event.replyDispatch?.disposition === "followup_queued" && event.message) {
    return mergeConversationItems(
      current.filter((item) => item.id !== event.message?.id),
      incoming.filter((item) => item.id !== event.message?.id),
    );
  }
  return mergeConversationItems(current, incoming);
}

export function projectChannelItemDelta(
  current: readonly ConversationItemV1[],
  itemId: string,
  body: string,
): readonly ConversationItemV1[] {
  return current.map((item) => {
    if (item.id !== itemId) return item;
    if (item.kind === "assistant_message") {
      return {
        ...item,
        payload: {
          ...item.payload,
          body,
          streaming: true,
          deliveryStatus: "pending",
          presentationRole: "reply_result",
        },
      };
    }
    if (item.kind === "user_message") {
      return { ...item, payload: { ...item.payload, body } };
    }
    return item;
  });
}

export function projectChannelItemRunLinked(
  current: readonly ConversationItemV1[],
  itemId: string,
  linkedRunId: string,
): readonly ConversationItemV1[] {
  return current.map((item) => {
    if (item.id !== itemId || item.domainRefs.some((ref) => ref.type === "run" && ref.id === linkedRunId)) {
      return item;
    }
    return {
      ...item,
      domainRefs: mergeConversationDomainRefs(item.domainRefs, [{ type: "run", id: linkedRunId }]),
    };
  });
}

/**
 * Keep this small merge adapter local because the Node unit suite loads this
 * .ts module directly and cannot resolve the app's emitted .js import graph.
 * The workspace/page path uses the same revision and ref semantics below.
 */
function mergeConversationItems(
  existingItems: readonly ConversationItemV1[],
  incomingItems: readonly ConversationItemV1[],
): readonly ConversationItemV1[] {
  if (incomingItems.length === 0) return existingItems;
  const byId = new Map(existingItems.map((item) => [item.id, item]));
  for (const item of incomingItems) {
    const existing = byId.get(item.id);
    if (existing && item.revision < existing.revision) {
      continue;
    }
    byId.set(item.id, existing
      ? { ...item, domainRefs: mergeConversationDomainRefs(existing.domainRefs, item.domainRefs) }
      : item);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function mergeConversationDomainRefs(
  existing: readonly ConversationItemV1["domainRefs"][number][],
  incoming: readonly ConversationItemV1["domainRefs"][number][],
): readonly ConversationItemV1["domainRefs"][number][] {
  const refs = new Map<string, ConversationItemV1["domainRefs"][number]>();
  for (const ref of [...existing, ...incoming]) {
    refs.set(`${ref.type}:${ref.id}`, ref);
  }
  return [...refs.values()];
}

function channelStreamReplies(event: {
  readonly aiReply?: ChannelMessage;
  readonly aiReplies?: readonly ChannelMessage[];
}): readonly ChannelMessage[] {
  return event.aiReplies?.length ? event.aiReplies : event.aiReply ? [event.aiReply] : [];
}

function upsertChannelMessages(
  current: readonly ChannelMessage[],
  incoming: readonly ChannelMessage[],
): readonly ChannelMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  const order = current.map((message) => message.id);
  for (const message of incoming) {
    if (!byId.has(message.id)) order.push(message.id);
    byId.set(message.id, message);
  }
  return order.map((id) => byId.get(id)!);
}
