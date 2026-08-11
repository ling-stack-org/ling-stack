import type { ChannelReplyPendingEvent } from "../../types.js";
import type { PendingChannelSendPreview } from "./ChannelMessageFeed.js";

export function acknowledgePendingChannelSendPreview(
  current: PendingChannelSendPreview | undefined,
  previewId: string,
  sourceMessageId: string,
): PendingChannelSendPreview | undefined {
  if (!current || current.id !== previewId) return current;
  return { ...current, sourceMessageId };
}

export function projectPendingChannelReply(
  current: PendingChannelSendPreview | undefined,
  previewId: string,
  pending: ChannelReplyPendingEvent,
): PendingChannelSendPreview | undefined {
  if (!current || current.id !== previewId) return current;
  if (current.sourceMessageId && current.sourceMessageId !== pending.sourceMessageId) return current;
  return {
    ...current,
    sourceMessageId: pending.sourceMessageId,
    targetTeammateId: pending.targetTeammateId,
  };
}
