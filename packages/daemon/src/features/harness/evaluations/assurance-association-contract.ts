import { FRAMEWORK_ASSURANCE_ASSOCIATION_FROZEN_INPUT_KEYS } from "@ling-stack/contracts";
import type {
  FrameworkAssuranceAssociationArtifactPin,
  FrameworkAssuranceAssociationCode,
  FrameworkAssuranceAssociationGradePin,
  FrameworkAssuranceAssociationHostSource,
  FrameworkAssuranceAssociationInputDigests,
  FrameworkAssuranceAssociationJsonValue,
  FrameworkAssuranceAssociationObservation,
  FrameworkAssuranceAssociationRequest,
  FrameworkAssuranceAssociationResult,
  FrameworkAssuranceAssociationTaskIdentity,
  RunEvaluationGradeV1, RunEvaluationV1,
} from "@ling-stack/contracts";
import type { RunArtifact, RunEvaluationIdentityInput, RunSession } from "@ling-stack/core";

export const ASSOCIATION_IDENTITY_FIELDS = [
  "rootRunId", "runId", "suiteId", "suiteVersion", "suiteArtifactId", "suiteDigest",
  "caseId", "caseVersion", "caseArtifactId", "caseDigest", "baselineId", "baselineVersion",
  "baselineArtifactId", "baselineDigest", "candidateArtifactId", "candidateDigest",
] as const satisfies readonly (keyof RunEvaluationIdentityInput)[];

export const FROZEN_INPUT_KEYS = FRAMEWORK_ASSURANCE_ASSOCIATION_FROZEN_INPUT_KEYS;
export type FrozenInputKey = (typeof FROZEN_INPUT_KEYS)[number];

export type AssociationCode = FrameworkAssuranceAssociationCode;
export type ArtifactPin = FrameworkAssuranceAssociationArtifactPin;
export type HostAssociationSource = FrameworkAssuranceAssociationHostSource;
export type AssociationTaskIdentity = FrameworkAssuranceAssociationTaskIdentity;
export type AssociationInputDigests = FrameworkAssuranceAssociationInputDigests;
export type ObservationBinding = FrameworkAssuranceAssociationObservation;
export type GradePin = FrameworkAssuranceAssociationGradePin;

/** Exact synchronous reads; no enumeration, mutation, initialization or execution ports. */
export interface AssuranceEvaluationReadPorts {
  readonly getRun: (id: string) => Pick<RunSession, "id" | "status" | "parentRunId"> | undefined;
  readonly getRunEvaluation: (id: string) => RunEvaluationV1 | undefined;
  readonly getRunEvaluationGrade: (id: string) => RunEvaluationGradeV1 | undefined;
  readonly getArtifact: (id: string) => RunArtifact | undefined;
  readonly getCurrentHostSource: (runId: string) => HostAssociationSource | undefined;
  readonly getFrozenInput: (key: FrozenInputKey) => Uint8Array | undefined;
}

export type AssuranceEvaluationAssociationRequest = FrameworkAssuranceAssociationRequest;
export type AssuranceEvaluationAssociationResult = FrameworkAssuranceAssociationResult;
export type AssociationJsonValue = FrameworkAssuranceAssociationJsonValue;

export interface FrozenAssociationDefinitions {
  readonly suite: Readonly<Record<string, AssociationJsonValue>>;
  readonly rule: AssociationJsonValue;
  readonly expected: AssociationJsonValue;
}
