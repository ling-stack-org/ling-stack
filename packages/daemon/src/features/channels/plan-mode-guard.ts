import type { ChannelWorkflow, RunStore } from "@ling-stack/core";

const PLAN_MODE_WORKFLOW_BLOCKER = "Plan Mode is active for this channel. Exit Plan Mode or accept a proposed plan before starting workflow execution.";

export function getChannelPlanModeBlocker(store: RunStore, channelId: string | undefined): string | undefined {
  if (!channelId) {
    return undefined;
  }
  const thread = store.findLingThreadByOwner({
    kind: "channel_discussion",
    channelId,
  });
  return thread?.conversationMode.mode === "plan" ? PLAN_MODE_WORKFLOW_BLOCKER : undefined;
}

export function getWorkflowPlanModeBlocker(store: RunStore, workflow: ChannelWorkflow): string | undefined {
  return getChannelPlanModeBlocker(store, workflow.channelId);
}
