import type { RunnerContinuationV1 } from "@ling-stack/contracts";
import type { RunSession } from "./run-types.js";
import type { RuntimeAttemptFenceV1, WorkUnit, WorkUnitAttempt } from "./runtime-supervisor-types.js";

/** Issued only by the original Host's actual Pi prepared callback, read through a nominal private token. */
export interface RootRunSuspensionStartObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "run.suspension_start_observation.v1";
  readonly activationId: string;
  readonly runId: string;
  readonly targetFence: RuntimeAttemptFenceV1;
  readonly continuationId: string;
  readonly taskId: string;
  readonly preparedInputFingerprint: string;
  readonly runnerId: string;
  readonly observationId: string;
  readonly observedAt: string;
}
export interface AcknowledgeRootRunSuspensionStartInput {
  readonly suspensionId: string;
  readonly targetFence: RuntimeAttemptFenceV1;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly expectedRevision: number;
  readonly observationRef: unknown;
  readonly now: string;
}
export interface RootRunSuspensionStartV1 {
  readonly schemaVersion: 1;
  readonly kind: "run.suspension_root_start.v1";
  readonly id: string;
  readonly suspensionId: string;
  readonly activationArtifactId: string;
  readonly activationDigest: string;
  readonly observation: RootRunSuspensionStartObservationV1;
  readonly inputDigest: string;
  readonly rootBudgetDigest: string;
  readonly acknowledgedAt: string;
}
export interface RootRunSuspensionStartRecord {
  readonly start: RootRunSuspensionStartV1;
  readonly artifactId: string;
  readonly digest: string;
}
export type AcknowledgeRootRunSuspensionStartResult = {
  readonly kind: "started";
  readonly record: RootRunSuspensionStartRecord;
  readonly run: RunSession;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly continuation: RunnerContinuationV1;
} | { readonly kind: "already_started"; readonly record: RootRunSuspensionStartRecord };

export class RunSuspensionStartError extends Error {
  constructor(readonly code: string) { super(`suspension_start.${code}`); this.name = "RunSuspensionStartError"; }
}
