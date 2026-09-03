import type {
  ChannelConversationItemDecoration,
  ChannelConversationItemPageResponse,
  ChannelConversationThread,
  ChannelConversationTurnResponse,
  ConversationDomainRef,
  ConversationItemV1,
  ChannelMessage,
  ConversationGeneratedMedia,
} from "@ling-stack/contracts";
import { projectConversationItemToChannelMessage } from "@ling-stack/contracts";

export interface ChannelConversationMessagePage {
  readonly messages: readonly ChannelMessage[];
  /** Canonical items retained for typed transcript presentation. */
  readonly conversationItems: readonly ConversationItemV1[];
  readonly generatedMedia: readonly ConversationGeneratedMedia[];
  readonly hasMore: boolean;
  readonly nextBeforeSequence?: number;
}

export function projectChannelConversationItemPage(
  response: ChannelConversationItemPageResponse,
): ChannelConversationMessagePage {
  return {
    messages: projectMessageItems(response.items, response.decorations, response.thread),
    conversationItems: response.items,
    generatedMedia: response.generatedMedia,
    hasMore: response.hasMore,
    ...(response.nextBeforeSequence !== undefined
      ? { nextBeforeSequence: response.nextBeforeSequence }
      : {}),
  };
}

export function projectChannelConversationTurn(response: ChannelConversationTurnResponse): {
  readonly message: ChannelMessage;
  readonly conversationItems: readonly ConversationItemV1[];
  readonly aiReply?: ChannelMessage;
  readonly aiReplies?: readonly ChannelMessage[];
  readonly replyDispatch?: ChannelConversationTurnResponse["replyDispatch"];
  readonly autoStartedWorkflow?: ChannelConversationTurnResponse["autoStartedWorkflow"];
} {
  const message = projectMessageItem(response.userItem, response.decorations, response.thread);
  const aiReplies = projectMessageItems(response.assistantItems ?? [], response.decorations, response.thread);
  return {
    message,
    conversationItems: [response.userItem, ...(response.assistantItems ?? [])],
    ...(aiReplies[0] ? { aiReply: aiReplies[0] } : {}),
    ...(aiReplies.length > 0 ? { aiReplies } : {}),
    ...(response.replyDispatch ? { replyDispatch: response.replyDispatch } : {}),
    ...(response.autoStartedWorkflow ? { autoStartedWorkflow: response.autoStartedWorkflow } : {}),
  };
}

export function mergeConversationItems(
  existingItems: readonly ConversationItemV1[],
  incomingItems: readonly ConversationItemV1[],
): readonly ConversationItemV1[] {
  if (incomingItems.length === 0) return existingItems;
  const byId = new Map(existingItems.map((item) => [item.id, item]));
  for (const item of incomingItems) {
    const existing = byId.get(item.id);
    if (existing && item.revision < existing.revision) {
      continue;
    }
    byId.set(item.id, existing
      ? { ...item, domainRefs: mergeConversationDomainRefs(existing.domainRefs, item.domainRefs) }
      : item);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

export function mergeConversationDomainRefs(
  existing: readonly ConversationDomainRef[],
  incoming: readonly ConversationDomainRef[],
): readonly ConversationDomainRef[] {
  const refs = new Map<string, ConversationDomainRef>();
  for (const ref of [...existing, ...incoming]) {
    refs.set(`${ref.type}:${ref.id}`, ref);
  }
  return [...refs.values()];
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
