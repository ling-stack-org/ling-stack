import type { WorkflowConflictRecovery, WorkflowConflictRecoveryRequest } from "@ling-stack/contracts";
import type { ChannelWorkflow, ChannelWorkflowStep } from "./workspace-types.js";
import type { WorkflowIsolationMutationResult } from "./workflow-isolation-types.js";

/** Host composition only. The synchronous compiler runs in the retirement/lineage transaction. */
export interface WorkflowConflictRecoveryStore {
  getByPredecessor(workflowId: string): WorkflowConflictRecovery | undefined;
  getBySuccessor(workflowId: string): WorkflowConflictRecovery | undefined;
  createSuccessor(input: {
    readonly workflowId: string;
    readonly request: WorkflowConflictRecoveryRequest;
    readonly successorRoundId: string;
    readonly now: string;
    readonly compileSuccessor: () => { readonly workflow: ChannelWorkflow; readonly workflowSteps: readonly ChannelWorkflowStep[] };
  }): WorkflowIsolationMutationResult<WorkflowConflictRecovery>;
}
