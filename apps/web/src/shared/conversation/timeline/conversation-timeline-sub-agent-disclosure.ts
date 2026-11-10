import type { ConversationTimelineItem, ConversationTimelineSubAgentItem } from "@ling-stack/conversation-ui-core";

/**
 * Active and attention-bearing Agent spans stay open. A completed span may
 * collapse only when every child is a safe terminal fact or inert narration.
 */
export function shouldDefaultExpandConversationTimelineSubAgent(
  item: ConversationTimelineSubAgentItem,
): boolean {
  if (item.lifecycle !== "completed") {
    return true;
  }
  return !item.childItems.every(isSafeCompletedChildItem);
}

function isSafeCompletedChildItem(item: ConversationTimelineItem): boolean {
  if (item.kind === "userMessage" || item.kind === "agentMessage" || item.kind === "reasoning") {
    return item.status === undefined || item.status === "succeeded";
  }

  if (item.kind === "plan") {
    return (item.status === undefined || item.status === "succeeded") &&
      item.steps.every((step) => step.status === "completed");
  }

  if (item.kind === "commandBatch") {
    return item.batch.commands.every((command) =>
      isSafeCompletedChildItem(command) &&
      (command.leadingItems?.every(isSafeCompletedChildItem) ?? true)
    );
  }

  if (item.kind === "explorationBatch") {
    return item.batch.children.every(isSafeCompletedChildItem);
  }

  if (item.kind === "subAgentActivity") {
    return item.lifecycle === "completed" && item.childItems.every(isSafeCompletedChildItem);
  }

  if (item.kind === "terminalReport") {
    return item.outcomeStatus === "succeeded" &&
      (item.status === undefined || item.status === "succeeded");
  }

  if (item.kind === "diagnostic") {
    return false;
  }

  return item.status === "succeeded";
}
