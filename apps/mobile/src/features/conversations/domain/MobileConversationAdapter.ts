import type {
  RemoteConversationKindV1,
  RemoteConversationMessageV1,
} from "@ling-stack/contracts";
import {
  parseMessageBody,
  type ConversationActorKind,
  type ConversationItem,
  type ConversationStatus,
  type ConversationSurface,
  type MessageBodyBlock,
} from "@ling-stack/conversation-ui-core";

const MESSAGE_GROUP_WINDOW_MS = 5 * 60_000;

export interface MobileConversationMessageViewModel {
  readonly id: string;
  readonly message: RemoteConversationMessageV1;
  readonly item: ConversationItem;
  readonly blocks: readonly MessageBodyBlock[];
  readonly mine: boolean;
  readonly system: boolean;
  readonly streaming: boolean;
  readonly groupedWithPrevious: boolean;
}

export function adaptRemoteConversationMessages(
  kind: RemoteConversationKindV1,
  messages: readonly RemoteConversationMessageV1[],
): MobileConversationMessageViewModel[] {
  const sorted = [...messages].sort(compareRemoteMessages);
  return sorted.map((message, index) => adaptRemoteConversationMessage(
    kind,
    message,
    isGroupedWithPrevious(sorted[index - 1], message),
  ));
}

export function adaptRemoteConversationMessage(
  kind: RemoteConversationKindV1,
  message: RemoteConversationMessageV1,
  groupedWithPrevious = false,
): MobileConversationMessageViewModel {
  const streaming = message.status === "pending" || message.status === "streaming";
  const surface = conversationSurface(kind);
  return {
    id: message.messageId,
    message,
    item: {
      id: message.messageId,
      surface,
      kind: conversationItemKind(message),
      actorKind: conversationActorKind(message),
      actorId: message.authorId,
      actorName: message.authorLabel,
      channelId: kind === "channel" ? message.conversationId : undefined,
      teammateId: kind === "teammate_direct" && message.role === "teammate" ? message.authorId : undefined,
      threadId: kind === "channel" ? undefined : message.conversationId,
      body: message.body,
      status: conversationStatus(message.status),
      createdAt: message.createdAt,
    },
    blocks: parseMessageBody(message.body, undefined, { streaming }),
    mine: message.role === "local_user",
    system: message.role === "system",
    streaming,
    groupedWithPrevious,
  };
}

function conversationSurface(kind: RemoteConversationKindV1): ConversationSurface {
  if (kind === "channel") return "channel_root";
  if (kind === "teammate_direct") return "teammate_direct";
  return "normal_conversation";
}

function conversationItemKind(message: RemoteConversationMessageV1): ConversationItem["kind"] {
  if (message.role === "local_user") return "human_message";
  if (message.role === "system") return "system_summary";
  return "teammate_message";
}

function conversationActorKind(message: RemoteConversationMessageV1): ConversationActorKind {
  if (message.role === "local_user") return "local_user";
  if (message.role === "system") return "system";
  if (message.role === "assistant") return "coordinator";
  return "ai_teammate";
}

function conversationStatus(status: RemoteConversationMessageV1["status"]): ConversationStatus {
  if (status === "pending") return "running";
  return status;
}

function compareRemoteMessages(
  left: RemoteConversationMessageV1,
  right: RemoteConversationMessageV1,
): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.activitySeq - right.activitySeq
    || left.messageId.localeCompare(right.messageId);
}

function isGroupedWithPrevious(
  previous: RemoteConversationMessageV1 | undefined,
  current: RemoteConversationMessageV1,
): boolean {
  if (!previous || previous.role === "system" || current.role === "system") return false;
  if (previous.role !== current.role || authorKey(previous) !== authorKey(current)) return false;
  const elapsed = Date.parse(current.createdAt) - Date.parse(previous.createdAt);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= MESSAGE_GROUP_WINDOW_MS;
}

function authorKey(message: RemoteConversationMessageV1): string {
  return message.authorId?.trim() || message.authorLabel.trim();
}
