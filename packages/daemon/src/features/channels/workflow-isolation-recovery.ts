import { createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowMergeApprovalStore,
  createSqliteWorkflowMergeApplyStore, type RunStore } from "@ling-stack/core";
import { reconcileWorkflowStepRuns } from "./orchestrator.js";
import { completeWorkflowIfStepsFinished } from "./workflow-completion.js";
import { coordinateWorkflowIntegration } from "./workflow-integration-coordinator.js";
import { reconcileWorkflowIsolatedResults } from "./workflow-isolated-result.js";
import { maybeCreateWorkflowTerminalCoordinatorReply } from "./workflows.js";
import { reconcileWorkflowMergeApplication } from "./workflow-merge-apply.js";
import { cleanupWorkflowWorktrees } from "./workflow-worktree-cleanup.js";

/** Recover persisted rounds, not only workflows still carrying their mutable step pins. */
export async function recoverWorkflowIsolationsAtStartup(store: RunStore): Promise<number> {
  let coordinator;
  try { coordinator = createSqliteWorkflowIntegrationCoordinatorStore(store); }
  catch (error) {
    if (error instanceof Error && error.message === "workflow_integration.store_not_sqlite") return 0;
    throw error;
  }
  const rounds = coordinator.listRounds();
  // Cancelled/terminal workflows can still have an unresolved physical target effect.
  // Observe these before semantic filtering; restart never replays an approved-but-unstarted merge.
  for (const round of rounds) {
    if (round.inputs.mode !== "apply_to_target") continue;
    const request = createSqliteWorkflowMergeApprovalStore(store).getRequest(round.roundId, round.generation);
    if (request && createSqliteWorkflowMergeApplyStore(store).getPermit(round.roundId, round.generation))
      await reconcileWorkflowMergeApplication({ store, approvalId: request.approvalId });
  }
  const workflows = new Set(rounds.map(round => round.inputs.workflowId));
  let recovered = 0;
  for (const workflowId of workflows) {
    await cleanupWorkflowWorktrees(store, workflowId, { observeOnly: true });
    const workflow = store.getChannelWorkflow(workflowId);
    if (!workflow || ["succeeded", "failed", "cancelled"].includes(workflow.status)) continue;
    await reconcileWorkflowIsolatedResults(store, workflowId);
    reconcileWorkflowStepRuns(store, workflowId);
    const results = [];
    for (const round of rounds.filter(round => round.inputs.workflowId === workflowId)) {
      results.push(await coordinateWorkflowIntegration({ store, roundId: round.roundId }));
    }
    if (results.some(result => ["blocked", "failed", "conflicted"].includes(result.status))) continue;
    const now = new Date().toISOString();
    completeWorkflowIfStepsFinished(store, workflowId, now);
    maybeCreateWorkflowTerminalCoordinatorReply(store, workflowId, { now });
    recovered++;
  }
  return recovered;
}
