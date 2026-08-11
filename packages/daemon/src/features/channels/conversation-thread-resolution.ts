import type { ChannelConversationSurface } from "@ling-stack/contracts";
import type { Channel, LingThread, RunStore } from "@ling-stack/core";

export function resolveChannelConversationThread(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly surface?: ChannelConversationSurface;
  readonly now: string;
}): LingThread {
  if (!input.surface || input.surface.kind === "channel_root") {
    return input.store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root",
      channelId: input.channel.id,
      title: `${input.channel.name} conversation`,
      objective: `Root conversation for ${input.channel.name}.`,
    }, input.now).thread;
  }

  if (input.surface.kind === "thread") {
    const explicitThread = input.store.getLingThread(input.surface.threadId);
    if (!explicitThread) {
      throw new Error(`Conversation thread not found: ${input.surface.threadId}`);
    }
    if (explicitThread.channelId !== input.channel.id || explicitThread.archivedAt || explicitThread.status === "archived") {
      throw new Error(`Conversation thread is not active in channel: ${input.surface.threadId}`);
    }
    return explicitThread;
  }

  const anchor = input.store.getConversationItem(input.surface.anchorItemId);
  if (!anchor || anchor.channelId !== input.channel.id) {
    throw new Error(`Conversation topic anchor does not belong to channel: ${input.surface.anchorItemId}`);
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
