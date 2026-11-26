import { readWorkflowStageHandoff, type ChannelWorkflowStep, type RunStore } from "@ling-stack/core";
import { captureCodeAssessmentSnapshot } from "../code-assessments/snapshot.js";
import { readStageRecoveryReview } from "./stage-recovery-review.js";
import { readWorkItemWorkflowBinding } from "./workflow-stages.js";

export async function readCompleteHandoffCandidate(cwd: string): Promise<string | undefined> {
  const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" }).catch(() => undefined);
  return snapshot?.coverage === "complete" ? snapshot.digest : undefined;
}

export async function workItemHandoffCandidatesCurrent(store: RunStore, step: ChannelWorkflowStep): Promise<boolean> {
  const sourceIds = step.metadata?.requiredPlanHandoffStepIds;
  if (!sourceIds?.length) return true;
  const link = readWorkItemWorkflowBinding(store, step.workflowId);
  const item = link && store.getWorkItem(link.workItemId);
  if (!item?.planRevision) return false;
  const captured = new Map<string, string | undefined>();
  for (const sourceStepId of sourceIds) {
    const source = store.getChannelWorkflowStep(sourceStepId);
    const handoff = source && readWorkflowStageHandoff(store, {
      workItemId: item.id, planRevision: item.planRevision, sourceStepId, sourceRevision: source.updatedAt, targetStepId: step.id,
    });
    if (handoff?.record.action !== "accepted" || !handoff.decision.candidateDigest) continue;
    const sourceRun = handoff.decision.sourceRunId && store.getRun(handoff.decision.sourceRunId);
    if (!sourceRun) return false;
    if (!captured.has(sourceRun.cwd)) captured.set(sourceRun.cwd, await readCompleteHandoffCandidate(sourceRun.cwd));
    if (captured.get(sourceRun.cwd) !== handoff.decision.candidateDigest) return false;
  }
  return true;
}

export async function workItemStageRecoveryCandidateCurrent(store: RunStore, step: ChannelWorkflowStep, cwd: string): Promise<boolean> {
  const binding = readWorkItemWorkflowBinding(store, step.workflowId);
  const readItem = () => binding && store.getWorkItem(binding.workItemId);
  const readRecovery = (item = readItem()) => {
    const recovery = item && store.getWorkItemStageProgress(item, step)?.lastVerified;
    return recovery?.kind === "verification_passed" || recovery?.kind === "review_passed" ? recovery : undefined;
  };
  const recovery = readRecovery();
  if (!recovery) return true;
  const source = store.getRun(recovery.failedRunId);
  const latest = step.runId ? store.getRun(step.runId) : undefined;
  if (latest?.startedAt && latest.startedAt > recovery.committedAt) return true;
  if (source?.cwd !== cwd || await readCompleteHandoffCandidate(cwd) !== recovery.candidateDigest) return false;
  const item = readItem();
  if (readRecovery(item)?.id !== recovery.id) return false;
  if (!recovery.reviewRevision) return true;
  const requirement = step.metadata?.recoveryReview;
  const proof = requirement && item?.planRevision && readStageRecoveryReview(store, {
    operationId: recovery.operationId, workItemId: item.id, planRevision: item.planRevision,
    controlGeneration: item.control.generation, requirement, after: recovery.failedAt, cwd,
  });
  return Boolean(proof && proof.reviewRevision === recovery.reviewRevision && proof.candidateDigest === recovery.candidateDigest);
}
