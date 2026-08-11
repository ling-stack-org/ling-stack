import {
  LING_AGENT_ID,
  projectConversationItemToChannelMessage,
  type ChannelMessage,
  type RunStore,
} from "@ling-stack/core";

type ConversationItemMessageStore = Pick<
  RunStore,
  "getConversationItem" | "getEffectiveConversationItem" | "getLingTurn" | "listConversationItemsByChannelPage" | "listConversationItemsPage" | "updatePendingConversationItem" | "appendConversationItem"
>;

export function getChannelMessageView(store: ConversationItemMessageStore, itemId: string): ChannelMessage | undefined {
  const item = store.getEffectiveConversationItem(itemId);
  if (!item) return undefined;
  const turn = item.turnId ? store.getLingTurn(item.turnId) : undefined;
  return projectConversationItemToChannelMessage(item, {
    linkedRunId: turn?.activeRunId ?? turn?.lastRunId,
  });
}

export function listChannelMessageViewsPage(input: {
  readonly store: ConversationItemMessageStore;
  readonly channelId: string;
  readonly threadId?: string;
  readonly excludeThreadIds?: readonly string[];
  readonly beforeItemId?: string;
  readonly limit?: number;
}): {
  readonly messages: readonly ChannelMessage[];
  readonly hasMore: boolean;
  readonly nextBeforeMessageId?: string;
} {
  const page = input.store.listConversationItemsByChannelPage({
    channelId: input.channelId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.excludeThreadIds ? { excludeThreadIds: input.excludeThreadIds } : {}),
    ...(input.beforeItemId ? { beforeItemId: input.beforeItemId } : {}),
    kinds: ["user_message", "assistant_message", "system_event"],
    effectiveOnly: true,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });
  const messages = page.items.map((item) => {
    const turn = item.turnId ? input.store.getLingTurn(item.turnId) : undefined;
    return projectConversationItemToChannelMessage(item, {
      linkedRunId: turn?.activeRunId ?? turn?.lastRunId,
    });
  });
  return {
    messages,
    hasMore: page.hasMore,
    ...(page.nextBeforeItemId ? { nextBeforeMessageId: page.nextBeforeItemId } : {}),
  };
}

export function listChannelMessageViews(input: {
  readonly store: ConversationItemMessageStore;
  readonly channelId: string;
  readonly threadId?: string;
  readonly excludeThreadIds?: readonly string[];
  readonly limit?: number;
}): readonly ChannelMessage[] {
  return listChannelMessageViewsPage(input).messages;
}

export function findChannelAssistantReplyForSource(input: {
  readonly store: ConversationItemMessageStore;
  readonly sourceItemId: string;
  readonly limit?: number;
}): ChannelMessage | undefined {
  const source = input.store.getConversationItem(input.sourceItemId);
  if (!source) return undefined;
  const items = source.channelId
    ? input.store.listConversationItemsByChannelPage({
        channelId: source.channelId,
        kinds: ["assistant_message"],
        effectiveOnly: true,
        limit: input.limit ?? 500,
      }).items
    : input.store.listConversationItemsPage({
        threadId: source.threadId,
        effectiveOnly: true,
        limit: input.limit ?? 100,
      }).items;
  const reply = [...items].reverse().find((item) =>
    item.kind === "assistant_message"
    && item.status !== "failed"
    && item.domainRefs.some((ref) => ref.type === "conversation_item" && ref.id === source.id)
  );
  if (!reply) return undefined;
  return getChannelMessageView(input.store, reply.id);
}

export function updatePendingAssistantMessage(input: {
  readonly store: ConversationItemMessageStore;
  readonly itemId: string;
  readonly body: string;
  readonly status: ChannelMessage["status"];
  readonly errorMessage?: string | null;
  readonly now: string;
}): ChannelMessage {
  const item = input.store.getConversationItem(input.itemId);
  if (!item || item.kind !== "assistant_message") {
    throw new Error(`Pending assistant conversation item not found: ${input.itemId}`);
  }
  const terminal = input.status === "ready" || input.status === "blocked" || input.status === "failed";
  const updated = input.store.updatePendingConversationItem(input.itemId, {
    expectedRevision: item.revision,
    payload: {
      body: input.body,
      format: item.payload.format,
      streaming: !terminal,
      deliveryStatus: input.status,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    },
    status: input.status === "failed" ? "failed" : terminal ? "committed" : "pending",
  }, input.now);
  const turn = updated.turnId ? input.store.getLingTurn(updated.turnId) : undefined;
  return projectConversationItemToChannelMessage(updated, {
    linkedRunId: turn?.activeRunId ?? turn?.lastRunId,
  });
}

export function appendChannelAssistantMessage(input: {
  readonly store: ConversationItemMessageStore;
  readonly sourceItemId: string;
  readonly actorId: string;
  readonly body: string;
  readonly status?: "ready" | "blocked" | "failed";
  readonly errorMessage?: string;
  readonly linkedRunId?: string;
  readonly itemId?: string;
  readonly idempotencyKey?: string;
  readonly now: string;
}): ChannelMessage {
  const sourceItem = input.store.getConversationItem(input.sourceItemId);
  if (!sourceItem?.channelId || !sourceItem.turnId) {
    throw new Error(`Assistant reply source item has no owning channel turn: ${input.sourceItemId}`);
  }
  const item = input.store.appendConversationItem({
    ...(input.itemId ? { id: input.itemId } : {}),
    channelId: sourceItem.channelId,
    threadId: sourceItem.threadId,
    turnId: sourceItem.turnId,
    kind: "assistant_message",
    status: "pending",
    actorType: input.actorId === LING_AGENT_ID ? "ling_agent" : "teammate",
    actorId: input.actorId,
    visibility: "channel",
    payload: {
      body: input.body,
      format: "markdown",
      streaming: true,
      deliveryStatus: "pending",
    },
    domainRefs: [
      { type: "conversation_item", id: sourceItem.id },
      ...(input.linkedRunId ? [{ type: "run" as const, id: input.linkedRunId }] : []),
    ],
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  }, input.now);
  return updatePendingAssistantMessage({
    store: input.store,
    itemId: item.id,
    body: input.body,
    status: input.status ?? "ready",
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    now: input.now,
  });
}
