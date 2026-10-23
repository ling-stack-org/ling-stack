import type { RunnerContinuationV1 } from "@ling-stack/contracts";
import type { RunSession } from "./run-types.js";
import type { RuntimeAttemptFenceV1, WorkUnit, WorkUnitAttempt } from "./runtime-supervisor-types.js";

/** Constructor-private Host input. Neither this method nor a caller flag is a public stale-run recovery path. */
export interface ActivateRootRunSuspensionInput {
  readonly suspensionId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly expectedReceiptDigest: string;
  readonly replayArtifactId: string;
  readonly target: { readonly runtimeInstanceId: string; readonly runnerId: string; readonly runnerCapabilityRevision: string };
  readonly claim: { readonly owner: string; readonly token: string; readonly expiresAt: string };
  readonly now: string;
}

export interface RootRunSuspensionActivationV1 {
  readonly schemaVersion: 1;
  readonly kind: "run.suspension_root_activation.v1";
  readonly id: string;
  readonly suspensionId: string;
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly targetFence: RuntimeAttemptFenceV1;
  readonly stoppedReceiptArtifactId: string;
  readonly stoppedReceiptDigest: string;
  readonly replayArtifactId: string;
  readonly replayDigest: string;
  readonly modelViewArtifactId: string;
  readonly continuationId: string;
  readonly inputDigest: string;
  readonly rootBudgetDigest: string;
  readonly activatedAt: string;
}

export interface RootRunSuspensionActivationRecord {
  readonly activation: RootRunSuspensionActivationV1;
  readonly artifactId: string;
  readonly digest: string;
}

export type ActivateRootRunSuspensionResult = {
  readonly kind: "activated";
  readonly record: RootRunSuspensionActivationRecord;
  readonly run: RunSession;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly continuation: RunnerContinuationV1;
} | {
  /** Audit-only replay. It never regrants dispatch, a claim token, or an SDK prepared acknowledgement. */
  readonly kind: "already_activated";
  readonly record: RootRunSuspensionActivationRecord;
};

export class RunSuspensionActivationError extends Error {
  constructor(readonly code: string) { super(`suspension_activation.${code}`); this.name = "RunSuspensionActivationError"; }
}
