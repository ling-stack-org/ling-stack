/**
 * A stream error belongs to the persisted assistant reply when the daemon
 * returned one. Otherwise the composer owns the transport error.
 *
 * All conversation surfaces use this policy; their stream protocols and state
 * containers may remain different.
 */
export type ConversationStreamErrorOwner = "assistant-reply" | "composer";

export function conversationStreamErrorOwner(hasAssistantReply: boolean): ConversationStreamErrorOwner {
  return hasAssistantReply ? "assistant-reply" : "composer";
}

export function shouldReportConversationStreamError(input: {
  readonly error?: string;
  readonly hasAssistantReply: boolean;
}): boolean {
  return Boolean(input.error) && conversationStreamErrorOwner(input.hasAssistantReply) === "composer";
}
