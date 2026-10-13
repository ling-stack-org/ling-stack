import type { RuntimeAttemptFenceV1 } from "./runtime-supervisor-types.js";

export const RUN_PROGRESS_MODEL_VIEW_CONTENT_TYPE = "application/vnd.ling.run-progress-model-view+json";
export const RUN_PROGRESS_MAX_PAYLOAD_BYTES = 512 * 1024;

/** Frozen, secret-free identity. Fingerprints are expectations, never caller grants. */
export interface RunProgressCheckpointLineage {
  readonly workspaceId: string;
  readonly contextViewId: string;
  readonly contextViewCreatedAt: string;
  readonly providerPresetId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly providerConfigurationFingerprint: string;
  readonly preparedExecutionFingerprint: string;
  readonly acceptedInstructionsFingerprint: string;
  readonly policySnapshotFingerprint: string;
  readonly policySourcesFingerprint: string;
  readonly workspaceProvenanceWatermark: string;
}

export interface RunProgressCheckpointHead {
  readonly checkpointId: string | null;
  readonly revision: number;
}

export interface RunProgressCheckpoint {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly kind: "noncompacted_model_view";
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly sourceEventSeq: number;
  readonly predecessorId: string | null;
  readonly modelViewArtifactId: string;
  readonly modelViewSha256: string;
  readonly lineage: RunProgressCheckpointLineage;
  readonly committedAt: string;
}

export interface RunProgressCheckpointWitness {
  readonly checkpointId: string;
  readonly headRevision: number;
  readonly modelViewSha256: string;
  readonly sourceEventSeq: number;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly lineage: RunProgressCheckpointLineage;
}

export interface RunProgressContinuationBinding {
  readonly continuationId: string;
  readonly targetFence: RuntimeAttemptFenceV1;
}

export interface CommitRunProgressCheckpointInput {
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly expectedHead: RunProgressCheckpointHead;
  readonly sourceEventSeq: number;
  readonly expectedLineage: RunProgressCheckpointLineage;
  /** Actual SDK view. Core assembles and hashes the sealed payload itself. */
  readonly modelView: readonly unknown[];
  readonly artifactId?: string;
  /** Required when the source is a successor of the checkpoint's Attempt. */
  readonly recoveryPredecessor?: RunProgressCheckpointWitness;
  readonly now: string;
}

export interface ReadRunProgressCheckpointForRecoveryInput {
  readonly runId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly expectedLineage: RunProgressCheckpointLineage;
  readonly continuationBinding?: RunProgressContinuationBinding;
}

export type RunProgressCheckpointBlockerCode =
  | "checkpoint.missing"
  | "checkpoint.lineage_mismatch"
  | "checkpoint.snapshot_unavailable"
  | "checkpoint.permission_drift"
  | "checkpoint.source_watermark_changed"
  | "checkpoint.effect_unknown"
  | "checkpoint.effect_unjournaled"
  | "checkpoint.head_conflict"
  | "checkpoint.commit_failed";

export type CommitRunProgressCheckpointResult =
  | { readonly kind: "committed"; readonly checkpoint: RunProgressCheckpoint; readonly headRevision: number; readonly replayed: boolean }
  | { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode };

export type ReadRunProgressCheckpointForRecoveryResult =
  | { readonly kind: "not_needed" }
  | { readonly kind: "verified"; readonly checkpoint: RunProgressCheckpoint; readonly modelView: readonly unknown[]; readonly witness: RunProgressCheckpointWitness }
  | { readonly kind: "blocked"; readonly code: RunProgressCheckpointBlockerCode };

export class RunProgressCheckpointError extends Error {
  constructor(readonly code: RunProgressCheckpointBlockerCode) { super(code); this.name = "RunProgressCheckpointError"; }
}
