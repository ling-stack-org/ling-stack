import { useMemo, useRef } from "react";
import type { ChannelActivityItem } from "../../lib/channel-activity.js";
import type { ConversationTurnViewModel } from "../../lib/conversation-turn-projector.js";
import type { ChannelMessage, ChannelMessageFileRef } from "../../types.js";
import type { ChannelMessageFeedItem, PendingChannelSendPreview } from "./ChannelMessageFeed.js";

interface ChannelMessageFeedAssemblyInput {
  readonly auditActivityVisible: boolean;
  readonly activityFiltersActive: boolean;
  readonly activeWorkThreadId: string;
  readonly channelMessages: readonly ChannelMessage[];
  readonly channelMessagesHasOlder: boolean;
  readonly channelMessagesLoading: boolean;
  readonly channelProtocolLoading: boolean;
  readonly conversationTurns: readonly ConversationTurnViewModel[];
  readonly pendingChannelSendPreview: PendingChannelSendPreview | undefined;
  readonly renderableActivityItems: readonly ChannelActivityItem[];
  readonly selectedChannelBranchRootThreadId?: string;
  readonly selectedChannelId: string;
}

interface PendingChannelSendState {
  readonly acknowledged: boolean;
  readonly acknowledgedMessageId?: string;
  readonly aiReplyStarted: boolean;
}

export interface ChannelMessageFeedAssembly {
  readonly conversationFeedBodyItems: readonly ChannelMessageFeedItem[];
  readonly messageFeedCanLoadOlder: boolean;
  readonly messageFeedEmpty: boolean;
  readonly messageFeedItems: readonly ChannelMessageFeedItem[];
  readonly pendingChannelSendState: PendingChannelSendState;
  readonly pendingChannelSendVisible: boolean;
}

export function useChannelMessageFeedAssembly({
  activeWorkThreadId,
  activityFiltersActive,
  auditActivityVisible,
  channelMessages,
  channelMessagesHasOlder,
  channelMessagesLoading,
  channelProtocolLoading,
  conversationTurns,
  pendingChannelSendPreview,
  renderableActivityItems,
  selectedChannelBranchRootThreadId,
  selectedChannelId,
}: ChannelMessageFeedAssemblyInput): ChannelMessageFeedAssembly {
  const optimisticRenderKeyByMessageIdRef = useRef(new Map<string, string>());
  const pendingChannelSendState = useMemo(
    () => derivePendingChannelSendState(channelMessages, pendingChannelSendPreview),
    [channelMessages, pendingChannelSendPreview],
  );
  const pendingRenderKey = pendingChannelSendPreview ? `pending-send:${pendingChannelSendPreview.id}` : undefined;
  if (pendingChannelSendState.acknowledgedMessageId && pendingRenderKey) {
    optimisticRenderKeyByMessageIdRef.current.set(pendingChannelSendState.acknowledgedMessageId, pendingRenderKey);
  }

  const conversationFeedBodyItems = useMemo<readonly ChannelMessageFeedItem[]>(
    () => {
      const items: Array<ChannelMessageFeedItem & { readonly createdAt: string }> = [
        ...(!auditActivityVisible
          ? conversationTurns.map((turn) => ({
            id: turn.id,
            kind: "turn" as const,
            turn,
            renderKey: optimisticRenderKeyByMessageIdRef.current.get(turn.sourceMessageId),
            pendingReplyPreview:
              pendingChannelSendPreview &&
              pendingChannelSendState.acknowledgedMessageId === turn.sourceMessageId &&
              !pendingChannelSendState.aiReplyStarted
                ? pendingChannelSendPreview
                : undefined,
            createdAt: turn.createdAt,
          }))
          : []),
        ...renderableActivityItems.map((item) => ({ id: item.id, kind: "activity" as const, item, createdAt: item.createdAt })),
      ];
      items.sort((left, right) => {
        const timeComparison = left.createdAt.localeCompare(right.createdAt);
        return timeComparison === 0 ? left.id.localeCompare(right.id) : timeComparison;
      });
      return items.map(({ createdAt: _createdAt, ...item }) => item);
    },
    [auditActivityVisible, conversationTurns, pendingChannelSendPreview, pendingChannelSendState, renderableActivityItems],
  );

  const messageFeedCanLoadOlder =
    channelMessagesHasOlder && !activityFiltersActive && conversationFeedBodyItems.length > 0;

  const pendingChannelSendVisible = Boolean(
    pendingChannelSendPreview &&
    !pendingChannelSendState.acknowledged &&
    pendingChannelSendPreview.channelId === selectedChannelId &&
    pendingChannelSendPreview.threadId === selectedChannelBranchRootThreadId &&
    !activeWorkThreadId,
  );

  const messageFeedItems = useMemo<readonly ChannelMessageFeedItem[]>(
    () => [
      ...(messageFeedCanLoadOlder ? [{ id: "older-channel-messages", kind: "older-loader" } satisfies ChannelMessageFeedItem] : []),
      ...conversationFeedBodyItems,
      ...(pendingChannelSendVisible && pendingChannelSendPreview
        ? [{
          id: `pending-send:${pendingChannelSendPreview.id}`,
          renderKey: pendingRenderKey,
          kind: "pending-send" as const,
          preview: pendingChannelSendPreview,
          showSentMessage: true,
        }]
        : []),
    ],
    [conversationFeedBodyItems, messageFeedCanLoadOlder, pendingChannelSendPreview, pendingChannelSendState.acknowledged, pendingChannelSendVisible],
  );

  const messageFeedEmpty = !channelMessagesLoading && !channelProtocolLoading && conversationFeedBodyItems.length === 0 && !pendingChannelSendVisible;

  return {
    conversationFeedBodyItems,
    messageFeedCanLoadOlder,
    messageFeedEmpty,
    messageFeedItems,
    pendingChannelSendState,
    pendingChannelSendVisible,
  };
}

function derivePendingChannelSendState(
  channelMessages: readonly ChannelMessage[],
  pendingChannelSendPreview: PendingChannelSendPreview | undefined,
): PendingChannelSendState {
  if (!pendingChannelSendPreview) {
    return { acknowledged: false, aiReplyStarted: false };
  }
  const acknowledgedMessage = [...channelMessages]
    .reverse()
    .find((message) =>
      message.channelId === pendingChannelSendPreview.channelId &&
      message.threadId === pendingChannelSendPreview.threadId &&
      message.kind === "message" &&
      message.authorType === "local-user" &&
      message.body === pendingChannelSendPreview.body &&
      sameStringList(message.attachmentIds, pendingChannelSendPreview.attachmentIds) &&
      sameStringList(message.linkPreviewIds, pendingChannelSendPreview.linkPreviewIds) &&
      sameFileRefList(message.fileRefs ?? [], pendingChannelSendPreview.fileRefs)
    );
  const replyThreadId = acknowledgedMessage ? acknowledgedMessage.threadId ?? acknowledgedMessage.id : pendingChannelSendPreview.threadId;
  const previewCreatedAt = Date.parse(pendingChannelSendPreview.createdAt);
  const aiReplyStarted = channelMessages.some((message) => {
    if (message.channelId !== pendingChannelSendPreview.channelId || message.kind !== "ai_reply") {
      return false;
    }
    if (replyThreadId && message.threadId !== replyThreadId) {
      return false;
    }
    const messageCreatedAt = Date.parse(message.createdAt);
    return !Number.isFinite(previewCreatedAt) || !Number.isFinite(messageCreatedAt) || messageCreatedAt >= previewCreatedAt;
  });
  return {
    acknowledged: Boolean(acknowledgedMessage),
    acknowledgedMessageId: acknowledgedMessage?.id,
    aiReplyStarted,
  };
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFileRefList(left: readonly ChannelMessageFileRef[], right: readonly ChannelMessageFileRef[]): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return Boolean(other) &&
      value.path === other.path &&
      value.source === other.source &&
      value.line === other.line;
  });
}
