import type { ConversationTimelineItem } from "@ling-stack/conversation-ui-core";

/** Display availability is not execution evidence or workflow completion. */
export function hasWorkflowTimelineContent(item: ConversationTimelineItem): boolean {
  if (item.kind === "subAgentActivity") return item.childItems.some(hasWorkflowTimelineContent);
  if (item.kind === "commandBatch") return item.batch.commands.some(hasWorkflowTimelineContent);
  if (item.kind === "explorationBatch") return item.batch.children.some(hasWorkflowTimelineContent);
  if (item.kind === "diagnostic") return item.code === "user_input_order_unavailable";
  if (item.kind === "agentMessage") return !!item.markdown.trim();
  return ["userInputRequest", "userInputAnswer", "terminalReport", "approval",
    "commandExecution", "fileChange", "exploration", "mcpToolCall", "dynamicToolCall",
    "collabAgentToolCall", "imageView"].includes(item.kind);
}
