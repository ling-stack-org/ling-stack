import { createSqliteWorkflowIsolationStore, createSqliteWorkflowIntegrationCoordinatorStore,
  createSqliteWorkflowMergeApprovalStore, type RunStore, type WorkflowIsolationMutationResult,
  type WorkflowMergeApprovalRequest } from "@ling-stack/core";
import { inspectWorkflowGitRepository, WorkflowGitError } from "../workspaces/workflow-git-repository.js";
import { runWorkflowIsolationOperation } from "./workflow-isolation-lifecycle.js";

export type WorkflowMergeApprovalProposalResult = WorkflowIsolationMutationResult<WorkflowMergeApprovalRequest>
  | { readonly status: "blocked"; readonly code: string };

/** Host observation only. Neither callers nor an approved proposal can execute a target write here. */
export async function requestWorkflowMergeApproval(input: { readonly store: RunStore; readonly roundId: string;
  readonly now?: () => string }): Promise<WorkflowMergeApprovalProposalResult> {
  const isolation = createSqliteWorkflowIsolationStore(input.store), round = isolation.getIntegrationRound(input.roundId);
  if (!round) return { status: "blocked", code: "workflow_merge.round_missing" };
  return runWorkflowIsolationOperation(input.store, round.inputs.workflowId, `merge-approval:${round.roundId}`, async () => {
    try {
      const now = input.now ?? (() => new Date().toISOString());
      const approvals = createSqliteWorkflowMergeApprovalStore(input.store);
      const existing = approvals.getRequest(round.roundId, round.generation);
      const targetSnapshot = await inspectWorkflowGitRepository(round.inputs.canonicalWorkspaceRoot);
      const at = now();
      const authority = existing ? { status: "authorized" as const, authorityDigest: existing.payload.authorityDigest }
        : createSqliteWorkflowIntegrationCoordinatorStore(input.store).assertAuthority({ roundId: round.roundId,
          generation: round.generation, now: at });
      if (authority.status !== "authorized") return { status: "blocked", code: authority.code };
      return approvals.requestApproval({ roundId: round.roundId, generation: round.generation,
        expectedRevision: isolation.getIntegrationRound(round.roundId)!.revision, authorityDigest: authority.authorityDigest,
        targetSnapshot, expiresAt: existing?.payload.expiresAt ?? new Date(Date.parse(at) + 10 * 60_000).toISOString(), now: at });
    } catch (cause) {
      return { status: "blocked", code: cause instanceof WorkflowGitError ? cause.code : "workflow_merge.proposal_evidence_unverified" };
    }
  });
}
