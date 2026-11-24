import type {
  GoalVerificationRequirement,
  LingAppServerStageRecoverParams,
  LingAppServerStageRecoverResult,
  LingAppServerVerifyOperation,
  LingAppServerVerifyPlanResult,
} from "@ling-stack/contracts";
import type { ControlPlaneEvent, RunStore } from "@ling-stack/core";
import { HttpError } from "../errors.js";
import { readCompleteHandoffCandidate } from "../features/work-items/stage-handoff-candidates.js";
import type { ActiveRunRegistry } from "../runtime/active-runs.js";
import { continuationSourceReady } from "../runtime/continuation-source-barrier.js";
import { AppServerCollaborationError } from "./app-server-collaboration.js";

export async function recoverAppServerStage(
  store: RunStore, input: LingAppServerStageRecoverParams, activeRuns: ActiveRunRegistry,
): Promise<LingAppServerStageRecoverResult & { readonly event?: ControlPlaneEvent }> {
  const { workItemId, planRevision, workflowStepId, blockerId, failureEventId, operationId } = input;
  const item = store.getWorkItem(workItemId);
  if (!item) throw new AppServerCollaborationError("work_item_not_found", "The Work Item is unavailable.");
  const cwd = store.paths.cwd;
  const id = `work_item_stage_recovery_${operationId}`;
  const key = `stage-recovery:${input.idempotencyKey}`;
  const replay = (): LingAppServerStageRecoverResult | undefined => {
    const prior = store.findWorkItemEvidenceByKey(workItemId, key);
    if (!prior) return undefined;
    if (prior.kind !== "stage_recovery_ref") {
      throw new AppServerCollaborationError("idempotency_conflict", "The recovery key was used for another operation.");
    }
    const receipt = JSON.parse(prior.content) as LingAppServerStageRecoverResult["receipt"];
    if (prior.id !== id || prior.subjectRevision !== planRevision
      || receipt.workflowStepId !== workflowStepId || receipt.blockerId !== blockerId || receipt.failureEventId !== failureEventId) {
      throw new AppServerCollaborationError("idempotency_conflict", "The recovery key was used with a different stage or verification.");
    }
    return { cwd, receipt, replayed: true, workItemRevision: store.getWorkItem(workItemId)?.revision ?? item.revision };
  };
  const prior = replay();
  if (prior) return prior;

  const readBasis = () => {
    const current = store.getWorkItem(workItemId);
    const step = store.getChannelWorkflowStep(workflowStepId);
    if (!current?.workflowId || current.planRevision !== planRevision || current.revision !== input.expectedWorkItemRevision
      || step?.workflowId !== current.workflowId || !["blocked", "queued"].includes(step.status)) {
      throw new AppServerCollaborationError("stale_revision", "The accepted Plan or blocked stage changed.");
    }
    if (store.getWorkItemWorkflowAdmissionBlocker(current.workflowId) || current.holds.some(hold =>
      hold.blocksNewAdmission && hold.workflowStepIds?.includes(step.id))) {
      throw new HttpError(409, "resume_blocked", "The Work Item cannot recover this stage now.");
    }
    const progress = store.getWorkItemStageProgress(current, step);
    const blocker = progress?.blocker;
    const recovered = progress?.lastVerified?.kind === "verification_passed" ? progress.lastVerified : undefined;
    const lastRunId = blocker?.status === "stalled" && blocker.id === blockerId && blocker.sourceEventId === failureEventId
      ? blocker.lastRunId : undefined;
    const replacesRecovery = recovered?.blockerId === blockerId && recovered.failureEventId === failureEventId;
    if (!lastRunId && !replacesRecovery) {
      throw new AppServerCollaborationError("stale_revision", "Use the current stalled blocker's failure event.");
    }
    const failedRunId = lastRunId ?? recovered!.failedRunId;
    const run = store.getRun(failedRunId);
    const unit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
    if (!run?.endedAt || !unit || unit.linkedRunId !== run.id
      || !continuationSourceReady(store, unit, activeRuns, key, () => undefined)) {
      throw new HttpError(409, "resume_blocked", "The failed Run still needs execution and effect settlement.");
    }
    const failedAt = run.endedAt;
    const after = replacesRecovery ? recovered!.committedAt : failedAt;
    const requirement = step.metadata?.recoveryVerification;
    if (!requirement) throw verificationRequired();
    const candidateDigest = recoveryCandidate(store, input, requirement, after, run.cwd);
    if (!candidateDigest) throw verificationRequired();
    return { failedRunId, failedAt, candidateCwd: run.cwd, candidateDigest };
  };
  const basis = readBasis();
  const candidate = await readCompleteHandoffCandidate(basis.candidateCwd);
  const committed = replay();
  if (committed) return committed;
  if (candidate !== basis.candidateDigest) {
    throw new HttpError(409, "work_item_stage_candidate_stale", "The verified stage candidate changed.");
  }
  if (store.getWorkItemEvidence(id)) {
    throw new AppServerCollaborationError("idempotency_conflict", "This verification already has a stage recovery receipt.");
  }
  const now = new Date().toISOString();
  const receipt = { id, workflowStepId, blockerId, failureEventId, operationId, failedAt: basis.failedAt,
    failedRunId: basis.failedRunId, candidateDigest: basis.candidateDigest, committedAt: now };
  const result = store.appendWorkItemEvidence({
    id, workItemId, expectedWorkItemRevision: input.expectedWorkItemRevision, idempotencyKey: key,
    actorId: "local-user", subjectRevision: planRevision, kind: "stage_recovery_ref", content: JSON.stringify(receipt),
    visibility: "owner", sourceRefs: [
      { type: "workflow_step", id: workflowStepId, revision: planRevision },
      { type: "run_event", id: failureEventId },
      { type: "verification", id: operationId, digest: basis.candidateDigest },
    ],
    assertCurrent: () => {
      const current = readBasis();
      if (current.candidateDigest !== basis.candidateDigest || current.candidateCwd !== basis.candidateCwd) throw verificationRequired();
    },
  }, now, {
    cwd,
    project: (entry, workItemRevision) => ({
      action: "work_item.stage.updated",
      data: { workItemId, workflowStepId, planRevision, recoveryReceiptId: entry.id, workItemRevision },
    }),
  });
  if (!result) throw new AppServerCollaborationError("stale_revision", "The Work Item changed before recovering the stage.");
  return { cwd, receipt, replayed: result.status === "replayed", workItemRevision: result.workItemRevision, event: result.event };
}

function recoveryCandidate(store: RunStore, input: LingAppServerStageRecoverParams, requirement: GoalVerificationRequirement,
  after: string, cwd: string): string | undefined {
  const stored = store.getAppServerState("verify_operation", input.operationId)?.payload as
    { readonly operation: LingAppServerVerifyOperation; readonly plan: LingAppServerVerifyPlanResult } | undefined;
  if (!stored) return undefined;
  const { operation, plan } = stored;
  const proof = operation.checks.find(check => check.checkId === requirement.checkId);
  const planned = plan.checks.find(check => check.checkId === requirement.checkId);
  if (operation.operationId !== input.operationId || operation.planId !== plan.planId
    || operation.workItemId !== input.workItemId || plan.workItemId !== input.workItemId || plan.acceptedPlanRevision !== input.planRevision
    || operation.status !== "passed" || !operation.completedAt || !proof?.execution || proof.execution.startedAt <= after
    || operation.candidateDigest !== plan.candidate.candidateDigest || plan.candidate.workspaceId !== cwd
    || proof.status !== "passed" || planned?.required !== true || proof.candidateDigest !== operation.candidateDigest
    || proof.planRevision !== plan.planRevision || proof.recipeDigest !== planned.recipeDigest
    || proof.verifierBasisRef !== requirement.verifierBasisRef || proof.verifierBasisRef !== planned.verifierBasisRef
    || proof.coverageDigest !== requirement.coverageDigest || proof.coverageDigest !== planned.coverageDigest
    || !proof.producerRefs.length || JSON.stringify(proof.producerRefs) !== JSON.stringify(planned.producerRefs)) return undefined;
  return operation.candidateDigest;
}

function verificationRequired(): HttpError {
  return new HttpError(409, "work_item_stage_verification_required", "Run the accepted stage's trusted check against the current candidate after the failure.");
}
