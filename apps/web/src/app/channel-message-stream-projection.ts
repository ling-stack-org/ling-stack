import type {
  ChannelMessage,
  ChannelMessageStreamBlockedEvent,
  ChannelMessageStreamDoneEvent,
  ChannelMessageStreamErrorEvent,
  ChannelMessageStreamReadyEvent,
} from "../types.js";

export function projectChannelStreamReady(
  current: readonly ChannelMessage[],
  event: ChannelMessageStreamReadyEvent,
): readonly ChannelMessage[] {
  const replies = channelStreamReplies(event);
  return replies.length > 0
    ? upsertChannelMessages(current, [event.message, ...replies])
    : current;
}

export function projectChannelStreamTerminal(
  current: readonly ChannelMessage[],
  event: ChannelMessageStreamDoneEvent | ChannelMessageStreamBlockedEvent | ChannelMessageStreamErrorEvent,
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
