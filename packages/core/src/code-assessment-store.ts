import type { CodeAssessment, CodeAssessmentDetail, CodeAssessmentFinding, CodeAssessmentFreshness, CodeAssessmentKind, CodeAssessmentList, CodeAssessmentListOptions, CodeAssessmentMetrics, CodeAssessmentPhase, CodeAssessmentRunPhase, CodeAssessmentSnapshot, CodeAssessmentStatus, CodeFindingDisposition, CodeFindingCloseReason } from "@ling-stack/contracts";
export interface CodeAssessmentStore {
  createCodeAssessment(input: { readonly id: string; readonly kind: CodeAssessmentKind; readonly providerPresetId: string; readonly instructions?: string; readonly snapshot: CodeAssessmentSnapshot; readonly preparedAt?: string; readonly captureStartedAt?: string; readonly metrics?: CodeAssessmentMetrics; readonly now: string }): CodeAssessmentDetail;
  getCodeAssessment(id: string): CodeAssessmentDetail | undefined;
  listCodeAssessments(input?: CodeAssessmentListOptions): CodeAssessmentList;
  bindCodeAssessmentRun(id: string, runId: string, now: string, phase?: CodeAssessmentRunPhase): CodeAssessment;
  completeCodeAssessmentThreatModel(id: string, input: { readonly runId: string; readonly artifactId: string; readonly now: string }): boolean;
  advanceCodeAssessmentPhase(id: string, input: { readonly phase: Extract<CodeAssessmentPhase, "validating_output" | "validating_candidates" | "synthesizing_findings">; readonly runId: string; readonly metrics?: CodeAssessmentMetrics; readonly now: string }): CodeAssessment;
  recordCodeAssessmentFreshness(id: string, freshness: CodeAssessmentFreshness): CodeAssessmentFreshness;
  finishCodeAssessment(id: string, input: { readonly status: Exclude<CodeAssessmentStatus, "queued" | "analyzing">; readonly runId?: string; readonly summary?: string; readonly errorMessage?: string; readonly reportArtifactId?: string; readonly diagnosticArtifactId?: string; readonly findings?: readonly CodeAssessmentFinding[]; readonly metrics?: CodeAssessmentMetrics; readonly now: string }): CodeAssessment;
  setCodeFindingDisposition(assessmentId: string, findingId: string, input: { readonly snapshotDigest: string; readonly disposition: CodeFindingDisposition; readonly closeReason?: CodeFindingCloseReason; readonly reason?: string; readonly now: string }): CodeAssessmentFinding;
}

export type { CodeAssessmentListOptions } from "@ling-stack/contracts";
