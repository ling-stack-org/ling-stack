import type { ChannelWorkflow, RunStore } from "@ling-stack/core";
import { findChannelDefaultConversationThread } from "./conversation-thread-resolution.js";

const PLAN_MODE_WORKFLOW_BLOCKER = "Plan Mode is active for this conversation. Exit Plan Mode or accept a proposed plan before starting workflow execution.";
const SOURCE_CONVERSATION_BLOCKER = "The workflow source conversation is unavailable or inconsistent. Repair its source before starting execution.";

export function getChannelPlanModeBlocker(store: RunStore, channelId: string | undefined): string | undefined {
  if (!channelId) {
    return undefined;
  }
  const thread = findChannelDefaultConversationThread(store, channelId);
  return thread?.conversationMode.mode === "plan" ? PLAN_MODE_WORKFLOW_BLOCKER : undefined;
}

export function getWorkflowPlanModeBlocker(store: RunStore, workflow: ChannelWorkflow): string | undefined {
  const turnId = workflow.metadata?.sourceTurnId;
  const itemId = workflow.metadata?.sourceMessageId;
  // Legacy channel work has no conversation attribution. It keeps the default
  // channel behavior; an explicit but broken source must never select another session.
  if (turnId === undefined && itemId === undefined) return getChannelPlanModeBlocker(store, workflow.channelId);
  const turn = turnId !== undefined ? store.getLingTurn(turnId) : undefined;
  const item = itemId !== undefined ? store.getConversationItem(itemId) : undefined;
  if ((turnId !== undefined && !turn) || (itemId !== undefined && !item)
    || (turn && item && turn.threadId !== item.threadId)) return SOURCE_CONVERSATION_BLOCKER;
  const threadId = turn?.threadId ?? item?.threadId;
  const thread = threadId ? store.getLingThread(threadId) : undefined;
  if (!thread || thread.kind !== "channel_discussion" || thread.channelId !== workflow.channelId
    || thread.archivedAt || thread.status === "archived") return SOURCE_CONVERSATION_BLOCKER;
  return thread.conversationMode.mode === "plan" ? PLAN_MODE_WORKFLOW_BLOCKER : undefined;
}
