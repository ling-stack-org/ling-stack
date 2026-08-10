import type {
  ChannelConversationItemDecoration,
  ChannelConversationItemPageResponse,
  ChannelConversationThread,
  ChannelConversationTurnResponse,
  ConversationItemV1,
  ChannelMessage,
} from "@ling-stack/contracts";
import { projectConversationItemToChannelMessage } from "@ling-stack/contracts";

export interface ChannelConversationMessagePage {
  readonly messages: readonly ChannelMessage[];
  readonly hasMore: boolean;
  readonly nextBeforeSequence?: number;
}

export function projectChannelConversationItemPage(
  response: ChannelConversationItemPageResponse,
): ChannelConversationMessagePage {
  return {
    messages: projectMessageItems(response.items, response.decorations, response.thread),
    hasMore: response.hasMore,
    ...(response.nextBeforeSequence !== undefined
      ? { nextBeforeSequence: response.nextBeforeSequence }
      : {}),
  };
}

export function projectChannelConversationTurn(response: ChannelConversationTurnResponse): {
  readonly message: ChannelMessage;
  readonly aiReply?: ChannelMessage;
  readonly aiReplies?: readonly ChannelMessage[];
  readonly replyDispatch?: ChannelConversationTurnResponse["replyDispatch"];
  readonly autoStartedWorkflow?: ChannelConversationTurnResponse["autoStartedWorkflow"];
} {
  const message = projectMessageItem(response.userItem, response.decorations, response.thread);
  const aiReplies = projectMessageItems(response.assistantItems ?? [], response.decorations, response.thread);
  return {
    message,
    ...(aiReplies[0] ? { aiReply: aiReplies[0] } : {}),
    ...(aiReplies.length > 0 ? { aiReplies } : {}),
    ...(response.replyDispatch ? { replyDispatch: response.replyDispatch } : {}),
    ...(response.autoStartedWorkflow ? { autoStartedWorkflow: response.autoStartedWorkflow } : {}),
  };
}

export function projectMessageItems(
  items: readonly ConversationItemV1[],
  decorations: readonly ChannelConversationItemDecoration[],
  thread?: ChannelConversationThread,
): readonly ChannelMessage[] {
  const decorationsByItemId = new Map(decorations.map((decoration) => [decoration.itemId, decoration]));
  return items
    .filter((item) => item.kind === "user_message" || item.kind === "assistant_message" || item.kind === "system_event")
    .map((item) => projectMessageItemWithDecoration(item, decorationsByItemId.get(item.id), thread));
}

export function projectMessageItem(
  item: ConversationItemV1,
  decorations: readonly ChannelConversationItemDecoration[],
  thread?: ChannelConversationThread,
): ChannelMessage {
  return projectMessageItemWithDecoration(
    item,
    decorations.find((candidate) => candidate.itemId === item.id),
    thread,
  );
}

function projectMessageItemWithDecoration(
  item: ConversationItemV1,
  decoration: ChannelConversationItemDecoration | undefined,
  thread?: ChannelConversationThread,
): ChannelMessage {
  const message = projectConversationItemToChannelMessage(item, {
    linkedRunId: decoration?.linkedRunId,
  });
  return {
    ...message,
    ...(thread ? {
      threadSurfaceKind: thread.surfaceKind,
      threadRelationKind: thread.relationKind,
      ...(thread.anchorItemId ? { threadAnchorItemId: thread.anchorItemId } : {}),
    } : {}),
    ...(decoration?.editedAt ? { editedAt: decoration.editedAt } : {}),
    ...(decoration?.pendingReplacement ? { pendingReplacement: decoration.pendingReplacement } : {}),
    ...(decoration?.webEvidence ? { webEvidence: decoration.webEvidence } : {}),
  };
}
