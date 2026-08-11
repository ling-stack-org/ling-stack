import { randomUUID } from "node:crypto";
import { projectConversationItemToChannelMessage } from "../dist/index.js";

/**
 * Test-only convenience for fixtures that need a message-shaped presentation view.
 * It writes exclusively through the canonical ConversationItem/LingTurn stores.
 */
export function appendChannelItemFixture(store, input, now) {
  const channel = store.getChannel(input.channelId);
  if (!channel) throw new Error(`Channel not found: ${input.channelId}`);
  const explicitThread = input.threadId ? store.getLingThread(input.threadId) : undefined;
  if (input.threadId && !explicitThread) {
    throw new Error(`Fixture threadId must be a canonical LingThread id: ${input.threadId}`);
  }
  const topicAnchorItem = input.topicAnchorItemId
    ? store.getConversationItem(input.topicAnchorItemId)
    : undefined;
  if (input.topicAnchorItemId && !topicAnchorItem) {
    throw new Error(`Fixture Topic anchor item not found: ${input.topicAnchorItemId}`);
  }
  const replyToItem = input.replyToItemId
    ? store.getConversationItem(input.replyToItemId)
    : undefined;
  if (input.replyToItemId && !replyToItem) {
    throw new Error(`Fixture reply source item not found: ${input.replyToItemId}`);
  }
  const thread = explicitThread
    ?? (topicAnchorItem
      ? store.resolveOrCreateConversationThread({
          surfaceKind: "topic",
          channelId: input.channelId,
          anchorItemId: topicAnchorItem.id,
          title: input.body.replace(/\s+/gu, " ").trim().slice(0, 120) || "Topic",
          objective: `Topic anchored at conversation item ${topicAnchorItem.id}.`,
        }, now).thread
      : replyToItem
        ? store.getLingThread(replyToItem.threadId)
      : store.resolveOrCreateConversationThread({
          surfaceKind: "channel_root",
          channelId: input.channelId,
          title: `${channel.name} conversation`,
          objective: `Root conversation for ${channel.name}.`,
        }, now).thread);
  if (!thread) {
    throw new Error(`Fixture reply source Thread not found: ${replyToItem?.threadId ?? "unknown"}`);
  }
  if (thread.channelId !== input.channelId) {
    throw new Error(`Conversation thread does not belong to channel: ${thread.id}`);
  }

  if (input.authorType === "local-user" && (input.kind === undefined || input.kind === "message")) {
    const result = store.appendConversationUserTurn({
      ...(input.id ? { itemId: input.id } : {}),
      channelId: input.channelId,
      threadId: thread.id,
      turnKind: thread.nextItemSequence > 1 ? "manual_followup" : "initial_request",
      title: input.body.replace(/\s+/gu, " ").trim().slice(0, 160) || "Channel input",
      userInstruction: input.body || "Channel input with references.",
      ...(input.authorId ? { actorId: input.authorId } : {}),
      payload: {
        body: input.body,
        format: "plain_text",
        mentions: (input.mentions ?? []).map((mention) => ({
          id: mention.id,
          label: mention.label,
          kind: mention.kind === "ai-teammate"
            ? "ai_teammate"
            : mention.kind === "local-user"
              ? "local_user"
              : "channel",
        })),
        attachmentIds: input.attachmentIds ?? [],
        linkPreviewIds: input.linkPreviewIds ?? [],
        fileRefs: input.fileRefs ?? [],
        ...((topicAnchorItem ?? replyToItem) ? { replyToItemId: (topicAnchorItem ?? replyToItem).id } : {}),
      },
      domainRefs: [
        ...(input.linkedTaskId ? [{ type: "task", id: input.linkedTaskId }] : []),
        ...(input.linkedRunId ? [{ type: "run", id: input.linkedRunId }] : []),
      ],
      idempotencyKey: `fixture-channel-item:${input.id ?? randomUUID()}`,
    }, now);
    return projectConversationItemToChannelMessage(result.item, { linkedRunId: input.linkedRunId });
  }

  const latestTurnId = replyToItem?.turnId
    ?? [...store.listConversationItemsPage({ threadId: thread.id, limit: 100 }).items]
      .reverse()
      .find((item) => item.kind === "user_message" && item.turnId)?.turnId;
  const status = input.status ?? "ready";
  const assistantMessage = input.kind === "ai_reply" || (input.kind === undefined && input.authorType === "ai-teammate");
  const item = store.appendConversationItem(assistantMessage ? {
    ...(input.id ? { id: input.id } : {}),
    channelId: input.channelId,
    threadId: thread.id,
    ...(latestTurnId ? { turnId: latestTurnId } : {}),
    kind: "assistant_message",
    status: status === "pending" ? "pending" : status === "failed" ? "failed" : "committed",
    actorType: input.authorId === "ling_agent" ? "ling_agent" : "teammate",
    ...(input.authorId ? { actorId: input.authorId } : {}),
    visibility: "channel",
    payload: {
      body: input.body,
      format: "markdown",
      streaming: status === "pending",
      deliveryStatus: status,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    },
    domainRefs: [
      ...((topicAnchorItem ?? replyToItem)
        ? [{ type: "conversation_item", id: (topicAnchorItem ?? replyToItem).id }]
        : []),
      ...(input.linkedTaskId ? [{ type: "task", id: input.linkedTaskId }] : []),
      ...(input.linkedRunId ? [{ type: "run", id: input.linkedRunId }] : []),
    ],
    ...(input.id ? { idempotencyKey: `channel-item:${input.id}` } : {}),
  } : {
    ...(input.id ? { id: input.id } : {}),
    channelId: input.channelId,
    threadId: thread.id,
    ...(latestTurnId ? { turnId: latestTurnId } : {}),
    kind: "system_event",
    status: status === "failed" ? "failed" : "committed",
    actorType: "system",
    ...(input.authorId ? { actorId: input.authorId } : {}),
    visibility: "channel",
    payload: { eventType: input.kind ?? "system", summary: input.body },
    domainRefs: [
      ...(input.linkedTaskId ? [{ type: "task", id: input.linkedTaskId }] : []),
      ...(input.linkedRunId ? [{ type: "run", id: input.linkedRunId }] : []),
    ],
    ...(input.id ? { idempotencyKey: `channel-item:${input.id}` } : {}),
  }, now);
  return projectConversationItemToChannelMessage(item, { linkedRunId: input.linkedRunId });
}

export function getChannelItemViewFixture(store, itemId) {
  const item = store.getEffectiveConversationItem(itemId);
  if (!item?.channelId) return undefined;
  const turn = item.turnId ? store.getLingTurn(item.turnId) : undefined;
  return projectConversationItemToChannelMessage(item, {
    linkedRunId: turn?.activeRunId ?? turn?.lastRunId,
  });
}

export function listChannelItemViewsFixture(store, options) {
  return store.listConversationItemsByChannelPage({
    channelId: options.channelId,
    ...(options.threadId ? { threadId: options.threadId } : {}),
    ...(options.excludeThreadIds ? { excludeThreadIds: options.excludeThreadIds } : {}),
    ...(options.beforeItemId ? { beforeItemId: options.beforeItemId } : {}),
    kinds: ["user_message", "assistant_message", "system_event"],
    effectiveOnly: true,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  }).items.map((item) => getChannelItemViewFixture(store, item.id));
}

export function listChannelItemViewPageFixture(store, options) {
  const page = store.listConversationItemsPage({
    threadId: options.threadId,
    ...(options.beforeSequence !== undefined ? { beforeSequence: options.beforeSequence } : {}),
    effectiveOnly: true,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  return {
    messages: page.items.map((item) => getChannelItemViewFixture(store, item.id)),
    hasMore: page.nextBeforeSequence !== undefined,
    ...(page.nextBeforeSequence !== undefined ? { nextBeforeSequence: page.nextBeforeSequence } : {}),
  };
}

export function updateChannelItemFixture(store, itemId, input, now) {
  const item = store.getConversationItem(itemId);
  if (!item) return undefined;
  if (input.linkedRunId && item.turnId && !store.getLingTurnForRun(input.linkedRunId)) {
    store.linkRunToLingTurn({ turnId: item.turnId, runId: input.linkedRunId, now });
  }
  if (item.kind !== "assistant_message" || item.status !== "pending") {
    return getChannelItemViewFixture(store, itemId);
  }
  const status = input.status ?? item.payload.deliveryStatus;
  const terminal = status === "ready" || status === "blocked" || status === "failed";
  store.updatePendingConversationItem(itemId, {
    expectedRevision: item.revision,
    payload: {
      body: input.body ?? item.payload.body,
      format: item.payload.format,
      streaming: !terminal,
      deliveryStatus: status,
      ...(input.errorMessage === null
        ? {}
        : input.errorMessage !== undefined
          ? { errorMessage: input.errorMessage }
          : item.payload.errorMessage
            ? { errorMessage: item.payload.errorMessage }
            : {}),
    },
    status: status === "failed" ? "failed" : terminal ? "committed" : "pending",
  }, now);
  return getChannelItemViewFixture(store, itemId);
}
