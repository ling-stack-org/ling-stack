import type { ConversationTimelineItem, ConversationTimelineProtocolEventItem } from "@ling-stack/conversation-ui-core";
import { isWorkflowIsolationTimelineItem } from "./workflow-isolation-evidence.js";

/** Display availability is not execution evidence or workflow completion. */
export function hasWorkflowTimelineContent(item: ConversationTimelineItem): boolean {
  if (item.kind === "subAgentActivity") return item.childItems.some(hasWorkflowTimelineContent);
  if (item.kind === "commandBatch") return item.batch.commands.some(hasWorkflowTimelineContent);
  if (item.kind === "explorationBatch") return item.batch.children.some(hasWorkflowTimelineContent);
  if (item.kind === "diagnostic") return item.code === "user_input_order_unavailable";
  if (item.kind === "agentMessage") return !!item.markdown.trim();
  if (item.kind === "protocolEvent") return Boolean(item.blockedExplanation) || isWorkflowIsolationTimelineItem(item);
  return ["userInputRequest", "userInputAnswer", "terminalReport", "approval",
    "commandExecution", "fileChange", "exploration", "mcpToolCall", "dynamicToolCall",
    "collabAgentToolCall", "imageView"].includes(item.kind);
}

/** Retained execution facts must not hide the owning workflow's lifecycle controls. */
export function selectWorkflowTimelineItems(
  facts: readonly ConversationTimelineItem[],
  summary: ConversationTimelineProtocolEventItem,
  retainControls: boolean,
): readonly ConversationTimelineItem[] {
  if (!facts.some(hasWorkflowTimelineContent)) return [summary];
  if (!retainControls || facts.some(item => item.id === summary.id)) return facts;
  return [summary, ...facts];
}
