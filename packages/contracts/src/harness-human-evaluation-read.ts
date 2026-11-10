import type { RunEvaluationTaskV1 } from "./harness.js";
import type { RunEvaluationQaArtifactPinsV1 } from "./harness-evaluation-qa.js";
import type { RunEvaluationHumanEventV1, RunEvaluationHumanHeadV1 } from "./harness-human-evaluation.js";

/** Minimal metadata for explicit QA enrollments, never ordinary conversation/run content. */
export interface RunEvaluationHumanQaRowV1 {
  readonly enrollmentId: string;
  readonly taskId: string;
  readonly evaluationId: string;
  readonly createdAt: string;
  readonly taskState: RunEvaluationTaskV1["state"];
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly caseId: string;
  readonly caseVersion: string;
  readonly head?: Pick<RunEvaluationHumanHeadV1, "eventId" | "revision" | "state">;
}
export interface RunEvaluationHumanQaPageV1 {
  readonly schemaVersion: 1;
  readonly items: readonly RunEvaluationHumanQaRowV1[];
  readonly nextAfterEnrollmentId?: string;
}
/** A report always pins this exact historical event, never silently chooses latest. */
export interface RunEvaluationHumanReportRefV1 {
  readonly taskId: string;
  readonly eventId: string;
  readonly revision: number;
}
/** Trusted atomic readback, stripped of private Host/OS identity and workspace paths. */
export interface RunEvaluationHumanReportSourceV1 {
  readonly schemaVersion: 1;
  readonly ref: RunEvaluationHumanReportRefV1;
  readonly event: RunEvaluationHumanEventV1;
  readonly intent: { readonly id: string; readonly payloadDigest: string };
  readonly lineage: {
    readonly enrollmentId: string;
    readonly batchId: string;
    readonly evaluationId: string;
    readonly evaluationKey: string;
    readonly artifactPins: RunEvaluationQaArtifactPinsV1;
    readonly configArtifact: { readonly artifactId: string; readonly contentSha256: string };
    readonly configDigest: string;
    readonly frozenGraderDigest: string;
    readonly rubric: { readonly id: string; readonly version: string; readonly instructions: string };
    readonly rubricDigest: string;
  };
  readonly audit: { readonly seq: number; readonly action: string; readonly createdAt: string };
  readonly head: Pick<RunEvaluationHumanHeadV1, "eventId" | "revision" | "state">;
  readonly currentness: "current" | "stale";
}
export type RunEvaluationHumanReportReadReason = "qa_not_enrolled" | "ref_not_found" | "ref_conflict"
  | "lineage_invalid" | "artifact_invalid" | "audit_invalid" | "read_failed";
export type RunEvaluationHumanReportSourceResultV1 = {
  readonly status: "available";
  readonly source: RunEvaluationHumanReportSourceV1;
} | {
  readonly status: "unavailable";
  readonly reason: RunEvaluationHumanReportReadReason;
};
/** Immutable report content; current head/currentness are separate live observations, not in its digest. */
export interface RunEvaluationHumanReportV1 {
  readonly schemaVersion: 1;
  readonly authority: "report-only";
  readonly ref: RunEvaluationHumanReportSourceV1["ref"];
  readonly event: RunEvaluationHumanReportSourceV1["event"];
  readonly intent: RunEvaluationHumanReportSourceV1["intent"];
  readonly lineage: RunEvaluationHumanReportSourceV1["lineage"];
  readonly audit: RunEvaluationHumanReportSourceV1["audit"];
  readonly reportDigest: string;
}
