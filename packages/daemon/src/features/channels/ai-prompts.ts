import type { Channel, ChannelMessage } from "@ling-stack/core";

export function formatChannelDiscussionPrompt(channel: Channel, message: ChannelMessage): string {
  const mentions = message.mentions.length > 0
    ? message.mentions.map((mention) => `@${mention.label}`).join(", ")
    : "none";
  return [
    `Channel: ${channel.name}`,
    `Mentions: ${mentions}`,
    `User message:`,
    message.body,
    "",
    "Reply as the channel AI teammate. Keep the response actionable and brief.",
  ].join("\n");
}
