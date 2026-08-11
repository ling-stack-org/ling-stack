import type { ProposedPlanArtifact, RunStore } from "@ling-stack/core";

export function hydrateProposedPlanSourceState(store: RunStore, plan: ProposedPlanArtifact): ProposedPlanArtifact {
  if (!plan.sourceMessageId) {
    return plan;
  }
  const sourceMessage = store.getConversationItem(plan.sourceMessageId);
  return {
    ...plan,
    sourceMessageState: sourceMessage && (!plan.channelId || sourceMessage.channelId === plan.channelId)
      ? "available"
      : "deleted",
  };
}

export function hydrateProposedPlanSourceStates(
  store: RunStore,
  plans: readonly ProposedPlanArtifact[],
): readonly ProposedPlanArtifact[] {
  return plans.map((plan) => hydrateProposedPlanSourceState(store, plan));
}
