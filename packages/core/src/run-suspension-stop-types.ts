import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

export interface RunSuspensionStopInput {
  readonly suspensionId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly now: string;
}

/** Frozen structural edge. It does not claim that a queued child ever ran. */
export interface RunSuspensionDescendantV1 {
  readonly runId: string;
  readonly parentRunId: string;
  readonly workUnitId: string;
  readonly stepId: string;
  readonly reservationId: string;
  readonly lineageDigest: string;
  readonly sourceFence?: RuntimeAttemptFenceV1;
  /** Exact queued facts, not an SDK stop/ACK or permission to dispatch. */
  readonly neverDispatchedDigest?: string;
}

export type RunSuspensionStopSourceV1 = { readonly kind: "root" } | {
  readonly kind: "delegated";
  readonly reservationId: string;
  readonly stepId: string;
  readonly parentRunId: string;
  readonly parentFence: RuntimeAttemptFenceV1;
  readonly lineageDigest: string;
  readonly interruptMessageId: string;
  readonly interruptArtifactId: string;
  readonly interruptDigest: string;
};

/** Original live verifier result, captured before a child becomes cancelling. */
export interface RunSuspensionStopBeginV1 {
  readonly schemaVersion: 1;
  readonly kind: "run.suspension_stop_begin.v1";
  readonly suspensionId: string;
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly sealDigest: string;
  readonly modelAdmissionDigest: string;
  readonly canonicalEventDigest: string;
  readonly source: RunSuspensionStopSourceV1;
  readonly descendants: readonly RunSuspensionDescendantV1[];
  readonly begunAt: string;
}

export type RunSuspensionDescendantProofV1 = {
  readonly runId: string;
  readonly kind: "stopped";
  readonly suspensionId: string;
  readonly receiptArtifactId: string;
  readonly receiptDigest: string;
} | { readonly runId: string; readonly kind: "terminal" | "never_dispatched"; readonly evidenceDigest: string };

/** Physical source closure only. It is not a Run result or a recovery permit. */
export interface RunSuspensionStoppedV1 {
  readonly schemaVersion: 1;
  readonly kind: "run.suspension_stopped.v1";
  readonly suspensionId: string;
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly beginDigest: string;
  readonly sealDigest: string;
  readonly completionDigest: string;
  readonly drainedAt: string;
  readonly audit: { readonly seq: number; readonly digest: string };
  readonly descendants: readonly RunSuspensionDescendantProofV1[];
  readonly stoppedAt: string;
}

export interface RunSuspensionStopRecord {
  readonly suspensionId: string;
  readonly state: "stopping" | "stopped";
  readonly beginArtifactId: string;
  readonly beginDigest: string;
  readonly begin: RunSuspensionStopBeginV1;
  readonly receiptArtifactId?: string;
  readonly receiptDigest?: string;
  readonly receipt?: RunSuspensionStoppedV1;
}

export class RunSuspensionStopError extends Error {
  constructor(readonly code: string) { super(`suspension_stop.${code}`); this.name = "RunSuspensionStopError"; }
}
