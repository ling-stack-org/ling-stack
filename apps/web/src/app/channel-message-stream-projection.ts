import type {
  ChannelConversationTurnResponse,
  ChannelMessage,
  ChannelReplyDispatch,
} from "../types.js";

export interface ChannelPresentationStreamReadyEvent {
  readonly message: ChannelMessage;
  readonly aiReply?: ChannelMessage;
  readonly aiReplies?: readonly ChannelMessage[];
}

export interface ChannelPresentationStreamTerminalEvent {
  readonly message?: ChannelMessage;
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
