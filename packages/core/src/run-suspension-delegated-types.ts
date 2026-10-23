import type { ClaimedDelegatedChild, DelegationRunnerStartObservation } from "./harness/delegation-lifecycle-types.js";
import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

/** Constructor-private Host input, never authority inferred from a manual interrupt or model message. */
export interface ActivateDelegatedRunSuspensionInput {
  readonly suspensionId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly expectedReceiptDigest: string;
  readonly parentFence: RuntimeAttemptFenceV1;
  readonly expectedStepRevision: number;
  readonly runtimeInstanceId: string;
  readonly now: string;
}

export interface DelegatedRunSuspensionActivationV1 {
  readonly schemaVersion: 1;
  readonly kind: "run.suspension_delegated_activation.v1";
  readonly id: string;
  readonly suspensionId: string;
  readonly runId: string;
  readonly rootRunId: string;
  readonly parentRunId: string;
  readonly stepId: string;
  readonly reservationId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly targetFence: RuntimeAttemptFenceV1;
  readonly parentFence: RuntimeAttemptFenceV1;
  readonly parentStartArtifactId: string;
  readonly parentStartDigest: string;
  readonly stoppedReceiptArtifactId: string;
  readonly stoppedReceiptDigest: string;
  readonly modelViewArtifactId: string;
  readonly preparationArtifactId: string;
  readonly preparationDigest: string;
  readonly inputDigest: string;
  readonly rootBudgetDigest: string;
  readonly reservationDigest: string;
  readonly activatedAt: string;
}

export interface DelegatedRunSuspensionActivationRecord {
  readonly activation: DelegatedRunSuspensionActivationV1;
  readonly artifactId: string;
  readonly digest: string;
}

export type ActivateDelegatedRunSuspensionResult = {
  readonly kind: "activated";
  readonly record: DelegatedRunSuspensionActivationRecord;
  readonly child: ClaimedDelegatedChild;
} | {
  /** Immutable observation only. A replay never regrants a claim or dispatch capability. */
  readonly kind: "already_activated";
  readonly record: DelegatedRunSuspensionActivationRecord;
};

export interface DelegatedRunSuspensionStartV1 {
  readonly schemaVersion: 1;
  readonly kind: "run.suspension_delegated_start.v1";
  readonly id: string;
  readonly suspensionId: string;
  readonly activationArtifactId: string;
  readonly activationDigest: string;
  readonly observation: DelegationRunnerStartObservation;
  readonly acknowledgedAt: string;
}

export interface DelegatedRunSuspensionStartRecord {
  readonly start: DelegatedRunSuspensionStartV1;
  readonly artifactId: string;
  readonly digest: string;
}

export class RunDelegatedSuspensionError extends Error {
  constructor(readonly code: string) { super(`suspension_delegated.${code}`); this.name = "RunDelegatedSuspensionError"; }
}
