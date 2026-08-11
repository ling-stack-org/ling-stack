import type { ChannelMessage, ChannelStoreFacet } from "@ling-stack/core";

export type ChannelConversationSurface =
  | { readonly kind: "root" }
  | { readonly kind: "branch"; readonly rootThreadId: string }
  | { readonly kind: "topic"; readonly sourceMessageId: string }
  | { readonly kind: "thread"; readonly threadId: string };

export function listChannelBranchRootThreadIds(store: Pick<ChannelStoreFacet, "listLingThreads">, channelId: string): string[] {
  return store.listLingThreads({ channelId, includeArchived: true, limit: 500 })
    .filter((thread) => thread.surfaceKind === "branch")
    .map((thread) => thread.id);
}

export function resolveChannelConversationSurface(
  store: Pick<ChannelStoreFacet, "getLingThread">,
  channelId: string,
  sourceMessage: ChannelMessage,
): ChannelConversationSurface {
  const threadId = sourceMessage.threadId;
  if (!threadId) {
    return { kind: "root" };
  }
  const thread = store.getLingThread(threadId);
  if (!thread || thread.channelId !== channelId) {
    return { kind: "thread", threadId };
  }
  if (thread.surfaceKind === "channel_root") {
    return { kind: "root" };
  }
  if (thread.surfaceKind === "branch") {
    return { kind: "branch", rootThreadId: threadId };
  }
  if (thread.surfaceKind === "topic" && thread.anchorItemId) {
    return { kind: "topic", sourceMessageId: thread.anchorItemId };
  }
  return { kind: "thread", threadId };
}

export function resolveChannelConversationLineKey(
  store: Pick<ChannelStoreFacet, "getLingThread">,
  channelId: string,
  sourceMessage: ChannelMessage,
): string {
  const surface = resolveChannelConversationSurface(store, channelId, sourceMessage);
  switch (surface.kind) {
    case "root":
      return "root";
    case "branch":
      return `branch:${surface.rootThreadId}`;
    case "topic":
      return `topic:${surface.sourceMessageId}`;
    case "thread":
      return `thread:${surface.threadId}`;
  }
}
