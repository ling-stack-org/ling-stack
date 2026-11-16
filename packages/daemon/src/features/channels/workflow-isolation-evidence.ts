import type { ChannelWorkflow, WorkflowIntegrationRoundEvidenceV1, WorkflowIsolationEvidenceV1 } from "@ling-stack/contracts";
import { createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowMergeApprovalStore,
  createSqliteWorkflowMergeApplyStore, type RunStore } from "@ling-stack/core";
import { workflowIsolationIsDraining } from "./workflow-isolation-lifecycle.js";

const publicCode = (value: string | undefined): string | undefined => value === undefined ? undefined
  : /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(value) ? value : "workflow_isolation.evidence_unverified";

/** Read the retained rounds even if a step's current plan pin has been removed. */
export function buildWorkflowIsolationEvidence(store: RunStore, workflowId: string,
  now = new Date().toISOString()): WorkflowIsolationEvidenceV1 | undefined {
  const pinned = store.listChannelWorkflowSteps({ workflowId, complete: true }).some(step => Boolean(step.metadata?.isolationScopePlan));
  const hostOperationPending = workflowIsolationIsDraining(store, workflowId);
  const unavailable = (reasonCode: string): WorkflowIsolationEvidenceV1 => ({ schemaVersion: 1, status: "unavailable",
    rounds: [], gitEffects: "unconfirmed", hostOperationPending, completion: "blocked", reasonCode });
  try {
    const coordinator = createSqliteWorkflowIntegrationCoordinatorStore(store);
    const approvals = createSqliteWorkflowMergeApprovalStore(store);
    const applications = createSqliteWorkflowMergeApplyStore(store);
    return store.readSnapshot(() => {
      const rounds = coordinator.listRounds(workflowId);
      if (!rounds.length) return pinned ? unavailable("workflow_isolation.round_evidence_missing") : undefined;
      const publicationBlockerCode = publicCode(coordinator.readPublicationBlocker(workflowId));
      const completionBlockerCode = publicCode(coordinator.readCompletionBlocker(workflowId));
      const evidence: WorkflowIntegrationRoundEvidenceV1[] = rounds.map(round => {
        const request = approvals.getRequest(round.roundId, round.generation);
        const approval = request ? approvals.inspectApproval({ approvalId: request.approvalId, now }) : undefined;
        const application = request ? applications.inspectApplication({ approvalId: request.approvalId, now }) : undefined;
        const scope = { roundId: round.roundId, generation: round.generation };
        const receipts = coordinator.listReceipts(scope);
        return {
          roundId: round.roundId, generation: round.generation, revision: round.revision,
          phase: round.phase, lastConfirmedPhase: round.lastConfirmedPhase, mode: round.inputs.mode,
          maxConcurrentSteps: round.inputs.parallelExecution?.maxConcurrentSteps ?? 1,
          participants: round.inputs.participants.map(({ workflowStepId, required }) => ({ workflowStepId, required })),
          candidate: round.candidate ? { commit: round.candidate.commit, tree: round.candidate.tree } : undefined,
          approval: request && approval ? { approvalId: request.approvalId, status: approval.status,
            reasonCode: approval.status === "blocked" ? publicCode(approval.code) : undefined } : undefined,
          application: { status: application?.status ?? "not_started",
            reasonCode: application ? publicCode(application.code) : undefined },
          effects: coordinator.listEffects(scope).map(effect => ({ id: effect.intentId, kind: effect.kind, status: effect.status,
            artifactIds: receipts.filter(receipt => receipt.intentId === effect.intentId).map(receipt => receipt.artifactId) })),
          reasonCode: publicCode(round.reason), updatedAt: round.updatedAt,
        };
      });
      return { schemaVersion: 1, status: "available", rounds: evidence,
        gitEffects: publicationBlockerCode || hostOperationPending ? "unconfirmed" : "confirmed", hostOperationPending,
        completion: completionBlockerCode || hostOperationPending ? "blocked" : "ready", publicationBlockerCode, completionBlockerCode };
    });
  } catch (error) {
    if (!pinned && !hostOperationPending && error instanceof Error && error.message === "workflow_integration.store_not_sqlite") return undefined;
    return unavailable("workflow_isolation.evidence_unavailable");
  }
}

/**
 * Returns a cheap channel-level discovery hint for evidence that can survive
 * removal or delayed loading of the current workflow steps. The full evidence
 * remains behind the per-workflow endpoint and is still read only there.
 */
export function listRetainedIsolationWorkflowIds(store: RunStore, workflows: readonly ChannelWorkflow[]): readonly string[] {
  const retained = new Set(workflows.filter(workflow => workflowIsolationIsDraining(store, workflow.id)).map(workflow => workflow.id));
  try {
    const coordinator = createSqliteWorkflowIntegrationCoordinatorStore(store);
    for (const workflow of workflows) {
      if (coordinator.listRounds(workflow.id).length) retained.add(workflow.id);
    }
  } catch {
    // Non-SQLite stores and unregistered coordinator adapters have no durable
    // retained-round index to expose; live draining hints remain valid.
  }
  return workflows.filter(workflow => retained.has(workflow.id)).map(workflow => workflow.id);
}
