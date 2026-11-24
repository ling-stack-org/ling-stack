import type { StageRecoveryReviewRequirement } from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";

export function readStageRecoveryReview(store: RunStore, input: {
  readonly operationId: string;
  readonly workItemId: string;
  readonly planRevision: string;
  readonly controlGeneration: number;
  readonly requirement: StageRecoveryReviewRequirement;
  readonly after: string;
  readonly cwd: string;
}): { readonly candidateDigest: string; readonly reviewRevision: string } | undefined {
  if (!input.operationId.startsWith("review_assessment_")) return undefined;
  const assessmentId = input.operationId.slice("review_".length);
  const detail = store.getCodeAssessment(assessmentId);
  if (!detail) return undefined;
  const { assessment, findings, snapshot } = detail;
  // Both callers recapture the candidate before accepting this proof. A Review
  // without a finding update or a subsequent assessment may have no freshness record.
  if (assessment.kind !== "review" || assessment.reviewFocus || assessment.instructions
    || assessment.status !== "completed" || assessment.freshness && assessment.freshness.state !== "current"
    || assessment.reviewRules?.omitted.length
    || assessment.workItem?.workItemId !== input.workItemId || assessment.workItem.acceptedPlanRevision !== input.planRevision
    || assessment.workItem.controlGeneration !== input.controlGeneration || assessment.providerPresetId !== input.requirement.providerPresetId
    || snapshot.target.type !== "working_tree" || snapshot.coverage !== "complete" || snapshot.digest !== assessment.snapshotDigest
    || snapshot.capturedAt <= input.after || !assessment.runId || !assessment.reportArtifactId
    || findings.some(finding => (finding.disposition !== "resolved" && finding.disposition !== "dismissed")
      || finding.closeReason === "accepted_risk" || finding.freshnessState !== "current")) return undefined;
  const run = store.getRun(assessment.runId);
  const report = store.getArtifact(assessment.reportArtifactId);
  if (run?.status !== "succeeded" || run.cwd !== input.cwd || run.providerPresetId !== input.requirement.providerPresetId
    || report?.runId !== run.id) return undefined;
  return { candidateDigest: snapshot.digest, reviewRevision: assessment.updatedAt };
}
