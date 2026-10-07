/**
 * Durable Host-owned checkpoint for an SDK context compaction boundary.
 *
 * The SDK's summary/session is descriptive only. Recovery may continue a Run
 * only after this record and its sealed context artifact are both durable.
 */
export const RUN_COMPACTION_CHECKPOINT_STATES = ["prepared", "committed", "blocked"] as const;
export type RunCompactionCheckpointState = (typeof RUN_COMPACTION_CHECKPOINT_STATES)[number];

export const RUN_COMPACTION_CHECKPOINT_BLOCKER_CODES = [
  "checkpoint.missing",
  "checkpoint.effect_unknown",
  "checkpoint.compaction_failed",
  "checkpoint.snapshot_unavailable",
  "checkpoint.lineage_mismatch",
  "checkpoint.permission_drift",
  "checkpoint.source_watermark_changed",
  "checkpoint.reconstruction_unavailable",
] as const;
export type RunCompactionCheckpointBlockerCode = (typeof RUN_COMPACTION_CHECKPOINT_BLOCKER_CODES)[number];

export interface RunCompactionCheckpointV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly runId: string;
  readonly attemptId: string;
  /** Durable compaction-start seq, or a later settled-tool progress watermark. */
  readonly sourceEventSeq: number;
  /** A checkpoint can have at most one successor. */
  readonly predecessorId?: string;
  readonly contextSnapshotArtifactId: string;
  /** Sealed summary/model-view replacement, never a transcript item. */
  readonly summaryArtifactId: string;
  readonly summaryContentSha256: string;
  readonly contextViewId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly policyVersion: string;
  readonly policySnapshotFingerprint: string;
  readonly workspaceProvenanceWatermark: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly unresolvedToolCallIds: readonly string[];
  readonly unresolvedApprovalIds: readonly string[];
  readonly unresolvedQuestionIds: readonly string[];
  readonly state: RunCompactionCheckpointState;
  readonly revision: number;
  readonly blockerCode?: RunCompactionCheckpointBlockerCode;
  readonly blockerDetail?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt?: string;
}

export interface CreateRunCompactionCheckpointInput {
  readonly id?: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly sourceEventSeq: number;
  readonly predecessorId?: string;
  readonly contextSnapshotArtifactId: string;
  readonly summaryArtifactId: string;
  readonly summaryContentSha256: string;
  readonly contextViewId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly policyVersion: string;
  readonly policySnapshotFingerprint: string;
  readonly workspaceProvenanceWatermark: string;
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly unresolvedToolCallIds?: readonly string[];
  readonly unresolvedApprovalIds?: readonly string[];
  readonly unresolvedQuestionIds?: readonly string[];
  readonly createdAt: string;
}

export interface TransitionRunCompactionCheckpointInput {
  readonly id: string;
  readonly expectedRevision: number;
  readonly state: Extract<RunCompactionCheckpointState, "committed" | "blocked">;
  readonly blockerCode?: RunCompactionCheckpointBlockerCode;
  readonly blockerDetail?: string;
  readonly now: string;
}

export interface ListRunCompactionCheckpointsOptions {
  readonly runId?: string;
  readonly attemptId?: string;
  readonly state?: RunCompactionCheckpointState;
  readonly limit?: number;
}
