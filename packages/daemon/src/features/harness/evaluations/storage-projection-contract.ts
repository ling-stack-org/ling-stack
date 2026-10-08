import type { RunEvaluationGradeV1, RunEvaluationV1 } from "@ling-stack/contracts";
import type { RunArtifact, RunSession } from "@ling-stack/core";
import type { ShadowPromotionFactSummary, ShadowPromotionReport } from "./promotion-report.js";

/** Deliberately excludes list, mutation, clock, provider and runtime control ports. */
export interface ShadowPromotionStorageReadPorts {
  readonly getRun: (id: string) => Pick<RunSession, "id" | "status" | "parentRunId"> | undefined;
  readonly getRunEvaluation: (id: string) => RunEvaluationV1 | undefined;
  readonly getRunEvaluationGrade: (id: string) => RunEvaluationGradeV1 | undefined;
  readonly getArtifact: (id: string) => RunArtifact | undefined;
}

export interface ShadowPromotionArtifactRef {
  readonly artifactId: string;
  /** Storage artifact bytes, not a canonical evaluation/configuration digest. */
  readonly contentSha256: string;
}

export interface StoredShadowPromotionRequest {
  readonly schemaVersion: 1;
  readonly rootRunId: string;
  readonly manifestArtifact: ShadowPromotionArtifactRef;
}

export interface ShadowPromotionGradeRef {
  readonly gradeId: string;
  readonly gradeDigest: string;
  readonly rawOutputArtifact?: ShadowPromotionArtifactRef;
  readonly rationaleArtifact?: ShadowPromotionArtifactRef;
}

export interface ShadowPromotionCorpusRow {
  readonly evaluationId: string;
  /** Full immutable Core enqueue identity, including definition and artifact digests. */
  readonly evaluationKey: string;
  readonly modelGrade?: ShadowPromotionGradeRef;
  readonly humanGrade?: ShadowPromotionGradeRef;
}

export interface ShadowPromotionCorpusManifest {
  readonly schemaVersion: 1;
  readonly kind: "shadow_promotion_corpus";
  readonly rootRunId: string;
  readonly frozenGraderArtifact: ShadowPromotionArtifactRef;
  readonly frozenGraderDigest: string;
  readonly cases: readonly ShadowPromotionCorpusRow[];
}

export const SHADOW_STORAGE_COST_FIELDS = ["costInputTokens", "costOutputTokens", "costAmountMicros", "latencyMs"] as const;
export type ShadowStorageCostField = (typeof SHADOW_STORAGE_COST_FIELDS)[number];

export type ShadowStorageDiagnosticCode =
  | "artifact_missing" | "artifact_invalid" | "manifest_invalid"
  | "evaluation_missing" | "evaluation_invalid" | "evaluation_incomplete"
  | "lineage_invalid" | "grade_missing" | "grade_invalid" | "observation_invalid"
  | "frozen_invalid" | "read_failed" | "snapshot_changed"
  | "model_grade_missing" | "human_grade_missing" | "observation_manifest_missing"
  | "human_source_unavailable" | "invocation_source_unavailable";

export interface ShadowStorageDiagnostic {
  readonly code: ShadowStorageDiagnosticCode;
  readonly evaluationId?: string;
}

/** Integrity-verified declarations remain separate from authenticated report evidence. */
export interface StoredShadowPromotionResult {
  readonly authority: "report-only";
  readonly assessment: "not_assessed";
  readonly enforcementAuthorized: false;
  readonly report: ShadowPromotionReport | null;
  readonly manifestDigest: string;
  readonly verifiedCaseCount: number;
  readonly declaredModelGradeCount: number;
  readonly declaredHumanGradeCount: number;
  readonly declaredObservationCount: number;
  readonly declaredCosts: Readonly<Record<ShadowStorageCostField, ShadowPromotionFactSummary>>;
  readonly diagnostics: readonly ShadowStorageDiagnostic[];
}
