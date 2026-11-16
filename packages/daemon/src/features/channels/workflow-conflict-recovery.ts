import { randomUUID } from "node:crypto";
import { createSqliteWorkflowConflictRecoveryStore, createSqliteWorkflowIsolationStore, createSqliteWorkflowUserCreationStore, type RunStore } from "@ling-stack/core";
import { parseWorkflowConflictRecoveryRequest, workflowGraphFingerprintV1,
  type WorkflowConflictRecoveryResponse } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { releaseWorkflowRepositoryFence } from "../workspaces/workflow-repository-fence.js";
import { compileWorkflowGraph } from "./workflow-graph.js";
import { runWorkflowIsolationOperation, workflowIsolationIsDraining } from "./workflow-isolation-lifecycle.js";
import { assertWorkflowIsolationHost, assertWorkflowIsolationSelectionIntegrity, selectWorkflowIsolatedExecution, type WorkflowIsolationHost } from "./workflow-isolation-selection.js";
import { maybeCreateWorkflowTerminalCoordinatorReply } from "./workflows.js";

/** Read-only after restart. A saved lineage is neither execution nor target-apply authority. */
export function readWorkflowConflictRecovery(store: RunStore, workflowId: string): WorkflowConflictRecoveryResponse | undefined {
  const recovery = createSqliteWorkflowConflictRecoveryStore(store).getByPredecessor(workflowId);
  if (!recovery) return;
  const workflow = store.getChannelWorkflow(recovery.successor.workflowId);
  const selection = createSqliteWorkflowIsolationStore(store).getSelection(recovery.successor.workflowId);
  if (!workflow || !workflow.metadata?.sourceTurnId || !workflow.metadata.sourceMessageId
    || !selection || selection.roundId !== recovery.successor.roundId)
    throw new HttpError(409, "workflow_recovery.successor_unverified", "The retained successor or selection cannot be verified.");
  if (selection.phase === "ready") {
    assertWorkflowIsolationSelectionIntegrity(store, workflow.id);
    if (createSqliteWorkflowIsolationStore(store).getIntegrationRound(selection.roundId)?.generation !== 1)
      throw new HttpError(409, "workflow_recovery.successor_unverified", "The successor must retain its own generation 1.");
  }
  return { recovery, workflow, workflowSteps: store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true }),
    phase: selection.phase, executionProfile: "pi_host_isolated_files_v1", mode: "candidate_only", requiresExplicitOrchestration: true };
}

/** Explicit local-user repair intent. Never dispatches, replays an old Git effect, or inherits an approval. */
export async function recoverWorkflowConflict(input: { readonly store: RunStore; readonly workflowId: string;
  readonly request: unknown; readonly runnerRegistry: RunnerRegistry; readonly host: WorkflowIsolationHost }): Promise<WorkflowConflictRecoveryResponse> {
  const request = parseWorkflowConflictRecoveryRequest(input.request), { store } = input;
  assertWorkflowIsolationHost(store, input.runnerRegistry, input.host);
  if (workflowIsolationIsDraining(store, input.workflowId)) throw new HttpError(409, "workflow_recovery.host_draining",
    "The original Host is still finishing workflow operations. Retry after its real drain.");
  const recoveryStore = createSqliteWorkflowConflictRecoveryStore(store);
  const created = recoveryStore.createSuccessor({ workflowId: input.workflowId, request,
    successorRoundId: `wir_${randomUUID()}`, now: new Date().toISOString(), compileSuccessor: () => {
      const previous = store.getChannelWorkflow(input.workflowId), graph = previous?.metadata?.workflowGraph;
      if (!previous || !graph || workflowGraphFingerprintV1(graph) !== previous.metadata?.workflowGraphFingerprint)
        throw new HttpError(409, "workflow_recovery.graph_unverified", "The original accepted graph cannot be verified.");
      const objective = `${previous.objective}\n\nUser-requested conflict repair (${request.roundId}, generation ${request.generation}):\n${request.repairInstruction}`;
      if (objective.length > 64_000) throw new HttpError(409, "workflow_recovery.objective_limit", "The successor objective exceeds the bounded recovery limit.");
      // Recompile only the definition. No old runtime pins, safety plans, completion claims or approvals are copied.
      const now = new Date().toISOString();
      return createSqliteWorkflowUserCreationStore(store).createWithinTransaction({ channelId: previous.channelId, now,
        compile: () => compileWorkflowGraph(store, { channelId: previous.channelId, title: previous.title, objective, createdBy: "local-user",
          // autoStart controls later scheduler eligibility; this Create-only path never dispatches.
          runnerId: "pi", autoStart: true, confirmUnsafeAutoStart: true, workflowGraph: { ...graph,
            nodes: graph.nodes.map(node => ({ ...node, requestedRunnerId: "pi", autoStart: true })) } }, now, input.runnerRegistry) });
    } });
  if (!("value" in created)) throw new HttpError(409, created.code, "The exact conflicted round is not safely recoverable.");
  const recovery = created.value;
  // Retirement is durable even when the successor cannot finish planning.
  maybeCreateWorkflowTerminalCoordinatorReply(store, input.workflowId);
  return runWorkflowIsolationOperation(store, recovery.successor.workflowId, "conflict-recovery:freeze", async () => {
    const isolation = createSqliteWorkflowIsolationStore(store), previous = isolation.getIntegrationRound(request.roundId, request.generation);
    if (!previous || previous.inputsDigest !== recovery.predecessor.inputsDigest)
      throw new HttpError(409, "workflow_recovery.predecessor_unverified", "The retained predecessor cannot be verified.");
    // The Core transaction has already proved physical drain and released its exact parent. This release is idempotent.
    releaseWorkflowRepositoryFence(store, previous.roundId, previous.generation, previous.inputs);
    try {
      await selectWorkflowIsolatedExecution({ store, workflowId: recovery.successor.workflowId, runnerRegistry: input.runnerRegistry, host: input.host });
    } catch (error) {
      throw new HttpError(409, "workflow_recovery.successor_planning", `Successor ${recovery.successor.workflowId} is retained but not started. Retry the exact recovery request after resolving planning: ${error instanceof Error ? error.message : "planning unavailable"}`);
    }
    const response = readWorkflowConflictRecovery(store, input.workflowId)!;
    const round = isolation.getIntegrationRound(recovery.successor.roundId);
    if (!round || round.generation !== 1 || round.inputs.workflowId !== response.workflow.id || round.inputs.mode !== "candidate_only")
      throw new HttpError(409, "workflow_recovery.successor_unverified", "The fresh candidate-only generation cannot be verified.");
    return response;
  });
}
