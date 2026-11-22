import { readWorkflowStageHandoff, type ChannelWorkflowStep, type RunStore } from "@ling-stack/core";
import { captureCodeAssessmentSnapshot } from "../code-assessments/snapshot.js";
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
    if (!handoff?.decision.candidateDigest) continue;
    const sourceRun = handoff.decision.sourceRunId && store.getRun(handoff.decision.sourceRunId);
    if (!sourceRun) return false;
    if (!captured.has(sourceRun.cwd)) captured.set(sourceRun.cwd, await readCompleteHandoffCandidate(sourceRun.cwd));
    if (captured.get(sourceRun.cwd) !== handoff.decision.candidateDigest) return false;
  }
  return true;
}
