import type { ChannelWorkflow, RunStore } from "@ling-stack/core";

export function syncWorkflowSourceTurnProgress(
  store: RunStore,
  workflow: ChannelWorkflow,
  now: string,
): void {
  const sourceTurnId = workflow.metadata?.sourceTurnId;
  if (!sourceTurnId) return;
  const turn = store.getLingTurn(sourceTurnId);
  if (!turn || isTerminalTurnStatus(turn.status)) return;
  if (workflow.status === "waiting_for_approval"
    && (turn.status === "open" || turn.status === "running")) {
    store.transitionLingTurnStatus({
      turnId: turn.id,
      expectedStatus: turn.status,
      event: "approval_requested",
      actor: "system",
      reason: `workflow:${workflow.id}:waiting_for_approval`,
      idempotencyKey: `workflow:${workflow.id}:source-turn:waiting_for_approval`,
      now,
    });
  } else if (workflow.status === "running" && turn.status === "waiting_for_approval") {
    store.transitionLingTurnStatus({
      turnId: turn.id,
      expectedStatus: "waiting_for_approval",
      event: "approval_approved",
      actor: "system",
      reason: `workflow:${workflow.id}:running`,
      idempotencyKey: `workflow:${workflow.id}:source-turn:approval_approved`,
      now,
    });
  } else if (workflow.status === "running" && (turn.status === "open" || turn.status === "blocked")) {
    store.transitionLingTurnStatus({
      turnId: turn.id,
      expectedStatus: turn.status,
      event: "start",
      actor: "system",
      reason: `workflow:${workflow.id}:running`,
      idempotencyKey: `workflow:${workflow.id}:source-turn:start`,
      now,
    });
  }
}

function isTerminalTurnStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "superseded";
}
