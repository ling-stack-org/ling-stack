import type { ConversationHomeMessage } from "./normal-conversation-types.js";

export function createConversationHomeMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `message:${globalThis.crypto.randomUUID()}`;
  }
  return `message:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

export function upsertConversationHomeMessage(
  messages: readonly ConversationHomeMessage[],
  message: ConversationHomeMessage,
): readonly ConversationHomeMessage[] {
  const messageKey = conversationHomeMessageMergeKey(message);
  const index = messages.findIndex((item) => conversationHomeMessageMergeKey(item) === messageKey);
  const next = index >= 0
    ? messages.map((item) => (conversationHomeMessageMergeKey(item) === messageKey ? message : item))
    : [...messages, message];
  return [...next].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function conversationHomeMessageMergeKey(message: ConversationHomeMessage): string {
  const assistantMatch = /^conversation-assistant:([^:]+)/u.exec(message.id);
  if (assistantMatch?.[1]) return `assistant:${assistantMatch[1]}`;
  const userMatch = /^conversation-user:([^:]+)/u.exec(message.id);
  if (userMatch?.[1]) return `user:${userMatch[1]}`;
  return message.id;
}
