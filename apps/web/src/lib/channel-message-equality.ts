import type { ChannelMessage } from "@ling-stack/contracts";

export function channelMessagesEqual(
  currentMessages: readonly ChannelMessage[],
  nextMessages: readonly ChannelMessage[],
): boolean {
  return JSON.stringify(currentMessages) === JSON.stringify(nextMessages);
}
