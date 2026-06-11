import type { Channel, ChannelMessage } from "@ling-stack/core";

export interface ChannelDiscussionPromptTeammate {
  readonly id: string;
  readonly displayName: string;
  readonly roleKey: string;
  readonly isDefault?: boolean;
  readonly isCurrent?: boolean;
  readonly isVisibleParticipant?: boolean;
}

export interface ChannelDiscussionPromptContext {
  readonly currentTeammate?: {
    readonly id: string;
    readonly displayName: string;
    readonly roleKey: string;
  };
  readonly channelTeammates?: readonly ChannelDiscussionPromptTeammate[];
  readonly visibleParticipantTeammateIds?: readonly string[];
}

export function formatChannelDiscussionPrompt(
  channel: Channel,
  message: ChannelMessage,
  context: ChannelDiscussionPromptContext = {},
): string {
  const mentions = message.mentions.length > 0
    ? message.mentions.map((mention) => `@${mention.label}`).join(", ")
    : "none";
  const teammateById = new Map((context.channelTeammates ?? []).map((teammate) => [teammate.id, teammate]));
  const visibleParticipants = context.visibleParticipantTeammateIds
    ?.map((teammateId) => teammateById.get(teammateId))
    .filter((teammate): teammate is ChannelDiscussionPromptTeammate => Boolean(teammate));
  const contextLines = [
    context.currentTeammate
      ? `Current teammate: ${formatTeammateLabel(context.currentTeammate)}`
      : undefined,
    context.channelTeammates && context.channelTeammates.length > 0
      ? [
          "Channel teammates (configured roster; not online/presence):",
          ...context.channelTeammates.map((teammate) => `- ${formatTeammateLabel(teammate)}${formatTeammateTags(teammate)}`),
        ].join("\n")
      : undefined,
    visibleParticipants && visibleParticipants.length > 0
      ? `Visible multi-reply participants for this batch: ${visibleParticipants.map(formatTeammateLabel).join(", ")}`
      : undefined,
    context.channelTeammates && context.channelTeammates.length > 0
      ? "Visibility boundary: You may refer to the configured channel roster and selected visible participants. Do not claim online/presence status, and do not claim to read hidden, private, or not-yet-generated peer replies."
      : undefined,
  ].filter((line): line is string => Boolean(line));
  return [
    `Channel: ${channel.name}`,
    `Mentions: ${mentions}`,
    ...contextLines,
    `User message:`,
    message.body,
    "",
    "Reply as the channel AI teammate. Keep the response actionable and brief.",
  ].join("\n");
}

function formatTeammateLabel(teammate: { readonly id: string; readonly displayName: string; readonly roleKey: string }): string {
  return `${teammate.displayName} (id: ${teammate.id}, role: ${teammate.roleKey})`;
}

function formatTeammateTags(teammate: ChannelDiscussionPromptTeammate): string {
  const tags = [
    teammate.isCurrent ? "you" : undefined,
    teammate.isDefault ? "default" : undefined,
    teammate.isVisibleParticipant ? "visible participant" : undefined,
  ].filter((tag): tag is string => Boolean(tag));
  return tags.length > 0 ? ` [${tags.join(", ")}]` : "";
}
