import type {
  ChannelConversationItemDecoration,
  ChannelConversationItemPageResponse,
  ChannelConversationTurnResponse,
  ConversationItemV1,
  ChannelMessage,
} from "@ling-stack/contracts";
import { projectConversationItemToChannelMessage } from "@ling-stack/core";

export interface ChannelConversationMessagePage {
  readonly messages: readonly ChannelMessage[];
  readonly hasMore: boolean;
  readonly nextBeforeSequence?: number;
}

export function projectChannelConversationItemPage(
  response: ChannelConversationItemPageResponse,
): ChannelConversationMessagePage {
  return {
    messages: projectMessageItems(response.items, response.decorations),
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
  const message = projectMessageItem(response.userItem, response.decorations);
  const aiReplies = projectMessageItems(response.assistantItems ?? [], response.decorations);
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
): readonly ChannelMessage[] {
  return items
    .filter((item) => item.kind === "user_message" || item.kind === "assistant_message" || item.kind === "system_event")
    .map((item) => projectMessageItem(item, decorations));
}

export function projectMessageItem(
  item: ConversationItemV1,
  decorations: readonly ChannelConversationItemDecoration[],
): ChannelMessage {
  const decoration = decorations.find((candidate) => candidate.itemId === item.id);
  const message = projectConversationItemToChannelMessage(item, {
    linkedRunId: decoration?.linkedRunId,
  });
  return {
    ...message,
    ...(decoration?.editedAt ? { editedAt: decoration.editedAt } : {}),
    ...(decoration?.pendingReplacement ? { pendingReplacement: decoration.pendingReplacement } : {}),
    ...(decoration?.webEvidence ? { webEvidence: decoration.webEvidence } : {}),
  };
}
