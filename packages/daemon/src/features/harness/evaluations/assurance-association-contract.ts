import type {
  FrameworkAssuranceComparison, FrameworkAssuranceEvidenceResponse,
  RunEvaluationGradeV1, RunEvaluationState, RunEvaluationV1,
} from "@ling-stack/contracts";
import type { RunArtifact, RunEvaluationIdentityInput, RunSession } from "@ling-stack/core";

export const ASSOCIATION_IDENTITY_FIELDS = [
  "rootRunId", "runId", "suiteId", "suiteVersion", "suiteArtifactId", "suiteDigest",
  "caseId", "caseVersion", "caseArtifactId", "caseDigest", "baselineId", "baselineVersion",
  "baselineArtifactId", "baselineDigest", "candidateArtifactId", "candidateDigest",
] as const satisfies readonly (keyof RunEvaluationIdentityInput)[];

export const FROZEN_INPUT_KEYS = [
  "suiteBytes", "taskBytes", "ruleBytes", "expectedBytes", "profileBytes", "lockBytes",
] as const;
export type FrozenInputKey = (typeof FROZEN_INPUT_KEYS)[number];

export type AssociationCode =
  | "association.invalid_request" | "association.workspace_uninitialized"
  | "association.read_failed" | "association.host_source_unavailable"
  | "association.lineage_mismatch" | "association.stale_attempt" | "association.snapshot_changed"
  | "association.frozen_input_missing" | "association.frozen_input_mismatch"
  | "association.mapping_mismatch" | "association.evaluation_missing"
  | "association.evaluation_identity_mismatch" | "association.evaluation_incomplete"
  | "association.artifact_missing" | "association.artifact_invalid"
  | "association.grade_missing" | "association.grade_invalid"
  | "association.attempt_binding_unavailable" | "association.grades_not_selected";

export interface ArtifactPin {
  readonly artifactId: string;
  readonly contentSha256: string;
}

export type HostAssociationSource = Pick<
  FrameworkAssuranceEvidenceResponse, "comparison" | "execution" | "snapshots" | "artifacts"
>;

export interface AssociationTaskIdentity {
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly taskId: string;
  readonly taskVersion: string;
}

export type AssociationInputDigests = Readonly<Record<FrozenInputKey, string>>;

export interface ObservationBinding {
  readonly observationId: string;
  readonly invocationId: string;
  readonly caseId: string;
  readonly taskIdentity: AssociationTaskIdentity;
  readonly sourceCommit: string;
  readonly inputDigests: AssociationInputDigests;
  readonly comparison: FrameworkAssuranceComparison;
  readonly evidenceKind: "live_execution" | "fixture_replay";
  readonly assessment: "not_assessed";
}

export interface FrozenAssociationMapping {
  readonly schemaVersion: 1;
  readonly kind: "assurance_evaluation_mapping";
  readonly definitionEncoding: "json_parse_stringify_v1";
  readonly taskIdentity: AssociationTaskIdentity;
  readonly observationCaseId: string;
  readonly sourceCommit: string;
  readonly inputDigests: AssociationInputDigests;
  readonly evaluationIdentity: RunEvaluationIdentityInput;
  readonly candidate: ArtifactPin & { readonly role: string };
}

export interface GradePin {
  readonly gradeId: string;
  readonly gradeDigest: string;
  readonly graderType: RunEvaluationGradeV1["graderType"];
  readonly graderId: string;
  readonly graderVersion: string;
  readonly rawOutputArtifact?: ArtifactPin;
  readonly rationaleArtifact?: ArtifactPin;
}

/** Exact synchronous reads; no enumeration, mutation, initialization or execution ports. */
export interface AssuranceEvaluationReadPorts {
  readonly getRun: (id: string) => Pick<RunSession, "id" | "status" | "parentRunId"> | undefined;
  readonly getRunEvaluation: (id: string) => RunEvaluationV1 | undefined;
  readonly getRunEvaluationGrade: (id: string) => RunEvaluationGradeV1 | undefined;
  readonly getArtifact: (id: string) => RunArtifact | undefined;
  readonly getCurrentHostSource: (runId: string) => HostAssociationSource | undefined;
  readonly getFrozenInput: (key: FrozenInputKey) => Uint8Array | undefined;
}

export interface AssuranceEvaluationAssociationRequest {
  readonly schemaVersion: 1;
  readonly observation: ObservationBinding;
  readonly source: HostAssociationSource;
  readonly evaluationId: string;
  readonly evaluationKey: string;
  readonly mapping: FrozenAssociationMapping;
  readonly mappingDigest: string;
  readonly gradePins: readonly GradePin[];
}

export interface AssuranceEvaluationAssociationResult {
  readonly schemaVersion: 1;
  readonly kind: "assurance_evaluation_association";
  readonly authority: "report-only";
  readonly assessment: "not_assessed";
  readonly enforcementAuthorized: false;
  readonly status: "matched" | "incomplete" | "unavailable" | "invalid";
  readonly observationId: string | null;
  readonly mappingDigest: string | null;
  readonly evaluation: {
    readonly id: string;
    readonly runId: string;
    readonly rootRunId: string;
    readonly state: RunEvaluationState;
    readonly revision: number;
    readonly evaluationKey: string;
  } | null;
  readonly binding: {
    readonly run: "matched" | "unavailable";
    readonly frozenInputs: "matched" | "unavailable";
    readonly candidateArtifact: "matched" | "unavailable";
  };
  readonly attemptBinding: {
    readonly status: "unavailable";
    readonly code: "association.attempt_binding_unavailable";
  };
  readonly grades: readonly {
    readonly gradeId: string;
    readonly gradeDigest: string;
    readonly graderType: RunEvaluationGradeV1["graderType"];
    readonly graderId: string;
    readonly graderVersion: string;
    readonly verdict: RunEvaluationGradeV1["verdict"];
    readonly score: number | null;
    readonly severity: NonNullable<RunEvaluationGradeV1["severity"]> | null;
  }[];
  readonly diagnostics: readonly { readonly code: AssociationCode }[];
  readonly limitations: readonly string[];
}

export type AssociationJsonValue =
  | null | boolean | number | string
  | readonly AssociationJsonValue[]
  | { readonly [key: string]: AssociationJsonValue };

export interface FrozenAssociationDefinitions {
  readonly suite: Readonly<Record<string, AssociationJsonValue>>;
  readonly rule: AssociationJsonValue;
  readonly expected: AssociationJsonValue;
}
