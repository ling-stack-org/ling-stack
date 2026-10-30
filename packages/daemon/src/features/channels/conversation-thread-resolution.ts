import type { ChannelConversationSurface } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import type { Channel, LingThread, RunStore } from "@ling-stack/core";

/** The session directory is the authority when archived historical roots coexist. */
export function findChannelDefaultConversationThread(
  store: Pick<RunStore, "getChannel" | "listChannelSessions" | "getLingThread">, channelId: string,
): LingThread | undefined {
  if (!store.getChannel(channelId)) return undefined;
  const root = store.listChannelSessions(channelId).defaultSession;
  return root ? store.getLingThread(root.id) : undefined;
}

export function resolveChannelConversationThread(input: {
  readonly store: RunStore;
  readonly channel: Channel;
  readonly surface?: ChannelConversationSurface;
  readonly now: string;
  readonly readOnly?: boolean;
}): LingThread {
  if (!input.surface || input.surface.kind === "channel_root") {
    const root = findChannelDefaultConversationThread(input.store, input.channel.id);
    if (root) return root;
    if (input.readOnly) throw new HttpError(409, "default_session_missing", "The channel default conversation requires repair.");
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
      // An existing conversation item is a malformed thread selector and
      // remains a client validation error; an unknown thread id is a not-found
      // resource error for callers navigating an independent session.
      if (input.store.getConversationItem(input.surface.threadId)) {
        throw new Error(`Conversation thread not found: ${input.surface.threadId}`);
      }
      throw new HttpError(404, "conversation_thread_not_found", `Conversation thread not found: ${input.surface.threadId}`);
    }
    if (explicitThread.channelId !== input.channel.id) {
      throw new HttpError(404, "conversation_thread_not_found", `Conversation thread not found in channel: ${input.surface.threadId}`);
    }
    if (!input.readOnly && (explicitThread.archivedAt || explicitThread.status === "archived")) {
      throw new HttpError(409, "conversation_thread_archived", `Conversation thread is archived: ${input.surface.threadId}`);
    }
    return explicitThread;
  }

  const anchor = input.store.getConversationItem(input.surface.anchorItemId);
  if (!anchor || anchor.channelId !== input.channel.id) {
    throw new Error(`Conversation topic anchor does not belong to channel: ${input.surface.anchorItemId}`);
  }
  const existingTopic = input.store.listLingThreads({ channelId: input.channel.id, includeArchived: true, limit: 500 })
    .find((thread) => thread.surfaceKind === "topic" && thread.anchorItemId === anchor.id);
  if (existingTopic) {
    if (!input.readOnly && (existingTopic.archivedAt || existingTopic.status === "archived")) {
      throw new HttpError(409, "conversation_thread_archived", `Conversation thread is archived: ${existingTopic.id}`);
    }
    return existingTopic;
  }
  if (input.readOnly) {
    throw new HttpError(404, "conversation_topic_not_found", `Conversation topic not found: ${anchor.id}`);
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
