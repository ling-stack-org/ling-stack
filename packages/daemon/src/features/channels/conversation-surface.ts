import type { ChannelMessage, ChannelStoreFacet } from "@ling-stack/core";

export type ChannelConversationSurface =
  | { readonly kind: "root" }
  | { readonly kind: "branch"; readonly rootThreadId: string }
  | { readonly kind: "topic"; readonly sourceMessageId: string }
  | { readonly kind: "thread"; readonly threadId: string };

export function listChannelBranchRootThreadIds(store: Pick<ChannelStoreFacet, "listChannelBranches">, channelId: string): string[] {
  const branches = [
    ...store.listChannelBranches({ channelId }),
    ...store.listChannelBranches({ channelId, archived: true }),
  ];
  return [...new Set(branches.map((branch) => branch.rootThreadId).filter((threadId): threadId is string => Boolean(threadId)))];
}

export function resolveChannelConversationSurface(
  store: Pick<ChannelStoreFacet, "getChannelMessage" | "listChannelBranches">,
  channelId: string,
  sourceMessage: ChannelMessage,
): ChannelConversationSurface {
  const threadId = sourceMessage.threadId;
  if (!threadId) {
    return { kind: "root" };
  }
  if (listChannelBranchRootThreadIds(store, channelId).includes(threadId)) {
    return { kind: "branch", rootThreadId: threadId };
  }
  const parentMessage = store.getChannelMessage(threadId);
  if (parentMessage?.channelId === channelId) {
    return { kind: "topic", sourceMessageId: threadId };
  }
  return { kind: "thread", threadId };
}
