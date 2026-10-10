import type { RunEvaluationQaArtifactPinsV1 } from "./harness-evaluation-qa.js";
import type { RunEvaluationVerdict, RunEvaluationSeverity } from "./harness.js";

export interface RunEvaluationHumanHostBindingV1 {
  readonly daemonEpoch: string;
  readonly desktopInstanceId: string;
  readonly desktopEpoch: string;
  readonly connectionEpoch: string;
  readonly osSessionId: string;
  readonly osUserId: string;
  readonly lockEpoch: string;
}
export interface RunEvaluationHumanDecisionV1 {
  readonly verdict: RunEvaluationVerdict;
  readonly score?: number;
  readonly severity?: RunEvaluationSeverity;
  readonly rationale: string;
}
export type RunEvaluationHumanSubmissionV1 = {
  readonly kind: "adjudicate";
  readonly decision: RunEvaluationHumanDecisionV1;
} | {
  readonly kind: "correct";
  readonly supersedesEventId: string;
  readonly decision: RunEvaluationHumanDecisionV1;
} | {
  readonly kind: "revoke";
  readonly revokesEventId: string;
  readonly rationale: string;
};
/** Native confirmation facts enter only via the private trusted Host ingress. Not a bearer identity claim. */
export interface RunEvaluationHumanConfirmationV1 {
  readonly kind: "macos_device_owner_authentication";
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly confirmedAt: string;
}
export interface RunEvaluationHumanPayloadV1 {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly requestId: string;
  readonly namespaceId: string;
  readonly canonicalWorkspaceCwd: string;
  readonly taskId: string;
  readonly enrollmentId: string;
  readonly evaluationId: string;
  readonly evaluationKey: string;
  readonly artifactPins: RunEvaluationQaArtifactPinsV1;
  readonly configArtifact: { readonly artifactId: string; readonly contentSha256: string };
  readonly configDigest: string;
  readonly frozenGraderDigest: string;
  readonly rubric: { readonly id: string; readonly version: string; readonly instructions: string };
  readonly rubricDigest: string;
  readonly expectedHeadRevision: number;
  readonly expectedHeadEventId?: string;
  readonly submission: RunEvaluationHumanSubmissionV1;
  readonly binding: RunEvaluationHumanHostBindingV1;
  readonly expiresAt: string;
}
export interface RunEvaluationHumanIntentV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly payload: RunEvaluationHumanPayloadV1;
  readonly payloadDigest: string;
  readonly state: "pending" | "consumed";
  readonly createdAt: string;
  readonly consumedAt?: string;
  readonly consumedEventId?: string;
}
export interface RunEvaluationHumanHeadV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly enrollmentId: string;
  readonly evaluationId: string;
  readonly revision: number;
  readonly eventId: string;
  readonly state: "active" | "revoked";
  readonly updatedAt: string;
}
export interface RunEvaluationHumanEventV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly enrollmentId: string;
  readonly evaluationId: string;
  readonly intentId: string;
  readonly revision: number;
  readonly submission: RunEvaluationHumanSubmissionV1;
  readonly payloadDigest: string;
  readonly confirmation: RunEvaluationHumanConfirmationV1;
  readonly auditSeq: number;
  readonly createdAt: string;
}
