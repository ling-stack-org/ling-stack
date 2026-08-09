import type { Channel, LingThread, RunStore } from "@ling-stack/core";

export function resolveChannelConversationThread(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly surfaceRefId?: string;
  readonly now: string;
}): LingThread {
  if (!input.surfaceRefId) {
    return input.store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root",
      channelId: input.channel.id,
      title: `${input.channel.name} conversation`,
      objective: `Root conversation for ${input.channel.name}.`,
    }, input.now).thread;
  }

  const explicitThread = input.store.getLingThread(input.surfaceRefId);
  if (explicitThread) {
    if (explicitThread.channelId !== input.channel.id || explicitThread.archivedAt || explicitThread.status === "archived") {
      throw new Error(`Conversation thread is not active in channel: ${input.surfaceRefId}`);
    }
    return explicitThread;
  }

  const anchor = input.store.getConversationItem(input.surfaceRefId);
  if (!anchor || anchor.channelId !== input.channel.id) {
    throw new Error(`Conversation surface reference does not belong to channel: ${input.surfaceRefId}`);
  }
  return input.store.resolveOrCreateConversationThread({
    surfaceKind: "topic",
    channelId: input.channel.id,
    anchorItemId: anchor.id,
    title: topicTitle(anchor.kind === "user_message" || anchor.kind === "assistant_message" ? anchor.payload.body : "Topic"),
    objective: `Topic anchored at conversation item ${anchor.id}.`,
  }, input.now).thread;
}

function topicTitle(body: string): string {
  const compact = body.replace(/\s+/gu, " ").trim();
  return compact ? compact.slice(0, 120) : "Topic";
}
