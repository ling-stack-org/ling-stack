import { createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowIsolationStore,
  type RunStore } from "@ling-stack/core";
import { releaseWorkflowRepositoryFence } from "../workspaces/workflow-repository-fence.js";

/** Observation only. Core requires terminal lineage, original Host drain and settled journals before release. */
export function reconcileWorkflowParallelParentFences(store: RunStore, workflowId: string,
  now = new Date().toISOString()): void {
  let coordinator;
  try { coordinator = createSqliteWorkflowIntegrationCoordinatorStore(store); }
  catch (error) {
    if (error instanceof Error && error.message === "workflow_integration.store_not_sqlite") return;
    throw error;
  }
  const isolation = createSqliteWorkflowIsolationStore(store);
  for (const round of coordinator.listRounds(workflowId)) {
    if (!round.inputs.parallelExecution) continue;
    const result = isolation.reconcileParallelParentFence({ roundId: round.roundId, generation: round.generation, now });
    if (result.status === "released") releaseWorkflowRepositoryFence(store, round.roundId, round.generation, round.inputs, now);
  }
}
