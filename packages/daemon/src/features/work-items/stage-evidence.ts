import type { LingAppServerVerifyOperation, LingAppServerVerifyPlanResult } from "@ling-stack/contracts";
import type { ChannelWorkflowStep, RunStore, WorkItemEvidenceEntry } from "@ling-stack/core";
import { readWorkflowStepOutputPacketArtifact } from "../channels/workflow-step-packets.js";
import { stageCoordinationDenied, type StageCoordinationBinding } from "./stage-coordination-authority.js";
import { readWorkItemRetainedStageResults, readWorkItemWorkflowBinding } from "./workflow-stages.js";

function developmentRefs(entry: WorkItemEvidenceEntry, binding: StageCoordinationBinding) {
  if (entry.workItemId !== binding.workItemId || entry.subjectRevision !== binding.planRevision
    || entry.kind !== "evidence_ref" || entry.visibility !== "work_item") return [];
  return entry.sourceRefs.flatMap(({ type, id, digest }) =>
    (type === "verification" || type === "review") && id.length <= 256 && typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest)
      ? [{ type, id, digest }] : []);
}

export function listStageDevelopmentEvidence(store: RunStore, binding: StageCoordinationBinding, afterSequence: number) {
  const limit = 12;
  const entries = store.listWorkItemEvidence({ workItemId: binding.workItemId, afterSequence, limit: limit + 1 });
  const page = entries.slice(0, limit);
  const records = page.flatMap(entry => {
    const sources = developmentRefs(entry, binding).slice(0, 4);
    return sources.length ? [{ evidenceId: entry.id, sources }] : [];
  });
  return { records, ...(entries.length > limit ? { nextAfterSequence: page.at(-1)!.sequence } : {}) };
}

export function readStageDevelopmentEvidence(store: RunStore, binding: StageCoordinationBinding, evidenceId: string, sourceId: string) {
  const entry = store.getWorkItemEvidence(evidenceId);
  const ref = entry && developmentRefs(entry, binding).find(candidate => candidate.id === sourceId);
  if (!ref) throw stageCoordinationDenied();
  if (ref.type === "verification") {
    const stored = store.getAppServerState("verify_operation", ref.id)?.payload as
      { readonly plan: LingAppServerVerifyPlanResult; readonly operation: LingAppServerVerifyOperation } | undefined;
    const { plan, operation } = stored ?? {};
    if (operation?.operationId !== ref.id || !operation.completedAt || operation.workItemId !== binding.workItemId
      || operation.candidateDigest !== ref.digest || plan?.planId !== operation.planId
      || plan.workItemId !== binding.workItemId || plan.acceptedPlanRevision !== binding.planRevision
      || plan.candidate.candidateDigest !== ref.digest) throw stageCoordinationDenied();
    return { kind: ref.type, operationId: operation.operationId, candidateDigest: ref.digest, completedAt: operation.completedAt,
      status: operation.status, checks: operation.checks.slice(0, 24).map(({ checkId, status, verifierBasisRef, coverageDigest, execution }) =>
        ({ checkId, status, verifierBasisRef, coverageDigest, exitCode: execution?.exitCode })), checkCount: operation.checks.length };
  }
  const assessmentId = ref.id.startsWith("review_assessment_") ? ref.id.slice("review_".length) : ref.id;
  const detail = store.getCodeAssessment(assessmentId);
  const assessment = detail?.assessment;
  if (!detail || assessment?.kind !== "review" || assessment.reviewFocus || assessment.snapshotDigest !== ref.digest
    || detail.snapshot.digest !== ref.digest || assessment.workItem?.workItemId !== binding.workItemId
    || assessment.workItem.acceptedPlanRevision !== binding.planRevision || assessment.workItem.controlGeneration !== binding.controlGeneration) {
    throw stageCoordinationDenied();
  }
  return { kind: ref.type, assessmentId: assessment.id, candidateDigest: ref.digest, revision: assessment.updatedAt,
    status: assessment.status, coverage: detail.snapshot.coverage, summary: assessment.summary,
    findings: detail.findings.slice(0, 12).map(({ id, title, path, startLine, endLine, severity, disposition }) =>
      ({ id, title, path, startLine, endLine, severity, disposition })), findingCount: assessment.findingCount };
}

export function readStageDependencyOutput(store: RunStore, step: ChannelWorkflowStep, artifactId: string) {
  const artifact = store.getArtifact(artifactId);
  const run = artifact?.runId ? store.getRun(artifact.runId) : undefined;
  const source = run?.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
  if (!source || run?.status !== "succeeded" || source.status !== "succeeded" || source.runId !== run.id
    || source.metadata?.outputArtifactId !== artifactId) throw stageCoordinationDenied();
  const direct = source.workflowId === step.workflowId && step.metadata?.dependsOnStepIds?.includes(source.id);
  const retained = !direct && readWorkItemRetainedStageResults(store, readWorkItemWorkflowBinding(store, step.workflowId), step.id).some(
    result => result.sourceArtifactId === artifactId && result.sourceRunId === run.id && result.sourceStepId === source.id
      && result.expectedSourceRevision === source.updatedAt,
  );
  if (!direct && !retained) throw stageCoordinationDenied();
  const packet = readWorkflowStepOutputPacketArtifact({ store, artifactId });
  if (!packet || packet.workflowId !== source.workflowId || packet.workflowStepId !== source.id || packet.runId !== run.id) {
    throw stageCoordinationDenied();
  }
  return { kind: "stage_output", artifactId, runId: run.id, stepId: source.id, revision: source.updatedAt,
    status: packet.status, resultSummary: packet.resultSummary, changedPaths: packet.changedPaths?.slice(0, 24) };
}
