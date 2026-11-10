/**
 * A stream error belongs to the persisted assistant reply when the daemon
 * returned one. Otherwise the composer owns the transport error.
 *
 * All conversation surfaces use this policy; their stream protocols and state
 * containers may remain different.
 */
export type ConversationStreamErrorOwner = "assistant-reply" | "composer";

export type ChannelStreamErrorOwner = "assistant-reply" | "channel-composer" | "topic-thread";

export type ChannelStreamErrorOwnerHint = Exclude<ChannelStreamErrorOwner, "assistant-reply">;

export function conversationStreamErrorOwner(hasAssistantReply: boolean): ConversationStreamErrorOwner {
  return hasAssistantReply ? "assistant-reply" : "composer";
}

export function shouldReportConversationStreamError(input: {
  readonly error?: string;
  readonly hasAssistantReply: boolean;
}): boolean {
  return Boolean(input.error) && conversationStreamErrorOwner(input.hasAssistantReply) === "composer";
}

/**
 * Classifies a channel terminal error before it is projected into UI state.
 * Persisted assistant replies own their provider error; otherwise the caller's
 * explicit channel surface owns it.
 */
export function channelStreamErrorOwner(input: {
  readonly hasAssistantReply: boolean;
  readonly fallbackOwner: ChannelStreamErrorOwnerHint;
}): ChannelStreamErrorOwner {
  return input.hasAssistantReply ? "assistant-reply" : input.fallbackOwner;
}

export function channelConversationScopeKey(input: {
  readonly workspaceCwd: string;
  readonly channelId: string;
  readonly branchRootThreadId?: string;
}): string {
  return JSON.stringify([
    input.workspaceCwd.trim(),
    input.channelId,
    input.branchRootThreadId ?? "root",
  ]);
}

export function channelTopicScopeKey(input: {
  readonly workspaceCwd: string;
  readonly channelId: string;
  readonly topicThreadId: string;
}): string {
  return JSON.stringify([
    input.workspaceCwd.trim(),
    input.channelId,
    input.topicThreadId,
  ]);
}
