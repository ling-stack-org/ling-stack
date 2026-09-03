/** Durable snapshot/restore contracts for post-compaction workspace recovery. */

export const workspaceSnapshotManifestStates = ["capturing", "committed", "sealed", "snapshot_unverified", "expired", "corrupt", "deleted"] as const;
export type WorkspaceSnapshotManifestState = (typeof workspaceSnapshotManifestStates)[number];

export const workspaceSnapshotEntryKinds = ["file", "directory", "symlink"] as const;
export type WorkspaceSnapshotEntryKind = (typeof workspaceSnapshotEntryKinds)[number];

export const snapshotRestoreStates = [
  "requested",
  "validating",
  "fenced",
  "staged",
  "committing",
  "verifying",
  "committed",
  "recovery_required",
  "conflict",
  "failed",
  "expired",
] as const;
export type SnapshotRestoreState = (typeof snapshotRestoreStates)[number];

export const snapshotRestoreJournalStates = ["pending", "applied", "rolled_back", "conflict", "failed"] as const;
export type SnapshotRestoreJournalState = (typeof snapshotRestoreJournalStates)[number];

export interface WorkspaceSnapshotEntry {
  readonly id: string;
  readonly manifestId: string;
  /** POSIX-style path relative to the canonical workspace root. */
  readonly relativePath: string;
  readonly kind: WorkspaceSnapshotEntryKind;
  readonly managed: boolean;
  readonly exclusionReason?: WorkspaceSnapshotExclusionReason;
  readonly symlinkTarget?: string;
  readonly mode?: number;
  readonly sizeBytes: number;
  readonly sha256?: string;
  /** Content-addressed blob digest for regular files. */
  readonly blobSha256?: string;
}

export type WorkspaceSnapshotExclusionReason =
  | "control_path"
  | "vcs_metadata"
  | "secret_like_path"
  | "too_large"
  | "unsupported_type"
  | "external_symlink"
  | "case_collision";

export interface WorkspaceSnapshotManifest {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly formatVersion: 1;
  readonly state: WorkspaceSnapshotManifestState;
  readonly fingerprint: string;
  readonly provenanceWatermark: string;
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly createdAt: string;
  readonly sealedAt?: string;
  readonly expiresAt?: string;
  readonly failureReason?: string;
  /** Frozen design aliases retained for API clients during the additive rollout. */
  readonly schemaVersion?: 1;
  readonly captureCwd?: string;
  readonly captureKind?: "user_restore_point" | "compaction_boundary";
  readonly sourceTurnId?: string;
  readonly sourceRunId?: string;
  readonly sourceCheckpointId?: string;
  readonly exclusionPolicySha256?: string;
  readonly managedEntryCount?: number;
  readonly excludedEntryCount?: number;
  readonly managedBytes?: number;
  readonly workspaceFingerprintSha256?: string;
  readonly manifestSha256?: string;
}

export interface CreateWorkspaceSnapshotManifestInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly fingerprint: string;
  readonly provenanceWatermark: string;
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly createdAt: string;
  readonly sealedAt?: string;
  readonly expiresAt?: string;
  readonly state?: WorkspaceSnapshotManifestState;
  readonly failureReason?: string;
  readonly schemaVersion?: 1;
  readonly captureCwd?: string;
  readonly captureKind?: "user_restore_point" | "compaction_boundary";
  readonly sourceTurnId?: string;
  readonly sourceRunId?: string;
  readonly sourceCheckpointId?: string;
  readonly exclusionPolicySha256?: string;
  readonly managedEntryCount?: number;
  readonly excludedEntryCount?: number;
  readonly managedBytes?: number;
  readonly workspaceFingerprintSha256?: string;
  readonly manifestSha256?: string;
}

export interface CreateWorkspaceSnapshotEntryInput {
  readonly id?: string;
  readonly manifestId: string;
  readonly relativePath: string;
  readonly kind: WorkspaceSnapshotEntryKind;
  readonly managed?: boolean;
  readonly exclusionReason?: WorkspaceSnapshotExclusionReason;
  readonly symlinkTarget?: string;
  readonly mode?: number;
  readonly sizeBytes: number;
  readonly sha256?: string;
  readonly blobSha256?: string;
}

export interface ListWorkspaceSnapshotManifestsOptions {
  readonly workspaceId?: string;
  readonly state?: WorkspaceSnapshotManifestState;
  readonly limit?: number;
}

export interface WorkspaceSnapshotGcResult {
  readonly expiredSnapshots: number;
  readonly deletedBlobs: number;
  readonly reclaimedBytes: number;
}

export type WorkspaceSnapshotPreviewOperation = "create" | "update" | "delete" | "unchanged";
export interface WorkspaceSnapshotPreviewEntry {
  readonly relativePath: string;
  readonly operation: WorkspaceSnapshotPreviewOperation;
  readonly kind: WorkspaceSnapshotEntryKind;
  readonly managed: boolean;
  readonly exclusionReason?: WorkspaceSnapshotExclusionReason;
  readonly sizeBytes: number;
}
export interface WorkspaceSnapshotPreview {
  readonly manifest: WorkspaceSnapshotManifest;
  readonly entries: readonly WorkspaceSnapshotEntry[];
  readonly operations: readonly WorkspaceSnapshotPreviewEntry[];
  readonly currentFingerprint: string;
  readonly targetFingerprint: string;
  readonly fingerprintStatus: "matching" | "changed" | "unavailable";
}

export interface WorkspaceSnapshotBlob {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: "application/octet-stream";
  readonly createdAt: string;
  readonly refCount: number;
}

export interface WorkspaceSnapshotRestoreAnchor {
  readonly id: string;
  readonly workspaceId: string;
  /** Optional for a user-selected restore point that is not tied to compaction. */
  readonly threadId?: string;
  readonly targetTurnId?: string;
  readonly checkpointId?: string;
  readonly baselineSnapshotId: string;
  readonly baselineFingerprint: string;
  readonly baselineProvenanceWatermark: string;
  readonly expectedWorkspaceFingerprint: string;
  readonly expectedProvenanceWatermark: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface CreateWorkspaceSnapshotRestoreAnchorInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly threadId?: string;
  readonly targetTurnId?: string;
  readonly checkpointId?: string;
  readonly baselineSnapshotId: string;
  readonly baselineFingerprint: string;
  readonly baselineProvenanceWatermark: string;
  readonly expectedWorkspaceFingerprint: string;
  readonly expectedProvenanceWatermark: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface SnapshotRestoreRequest {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly anchorId: string;
  readonly snapshotId: string;
  readonly expectedWorkspaceFingerprint: string;
  readonly expectedProvenanceWatermark: string;
  readonly state: SnapshotRestoreState;
  readonly fencingEpoch: number;
  readonly journalEntryCount: number;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmationId?: string;
}

export interface CreateSnapshotRestoreRequestInput {
  readonly id?: string;
  readonly idempotencyKey: string;
  readonly workspaceId?: string;
  readonly anchorId: string;
  readonly snapshotId: string;
  readonly expectedWorkspaceFingerprint: string;
  readonly expectedProvenanceWatermark: string;
  readonly state?: SnapshotRestoreState;
  readonly fencingEpoch?: number;
  readonly journalEntryCount?: number;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly confirmationId?: string;
}

export type SnapshotRestoreConfirmationState = "pending" | "confirmed" | "denied" | "expired";
export interface SnapshotRestoreConfirmation {
  readonly id: string;
  readonly workspaceId: string;
  readonly anchorId: string;
  readonly snapshotId: string;
  readonly state: SnapshotRestoreConfirmationState;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}
export interface CreateSnapshotRestoreConfirmationInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly anchorId: string;
  readonly snapshotId: string;
  readonly createdAt: string;
}

export interface UpdateSnapshotRestoreRequestInput {
  readonly id: string;
  readonly expectedState: SnapshotRestoreState;
  readonly state: SnapshotRestoreState;
  readonly fencingEpoch?: number;
  readonly journalEntryCount?: number;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export interface SnapshotRestoreJournalEntry {
  readonly id: string;
  readonly restoreRequestId: string;
  readonly sequence: number;
  readonly relativePath: string;
  readonly expectedBeforeSha256?: string;
  readonly expectedAfterSha256?: string;
  readonly rollbackBlobSha256?: string;
  readonly rollbackSymlinkTarget?: string;
  readonly targetBlobSha256?: string;
  readonly targetSymlinkTarget?: string;
  readonly rollbackMode?: number;
  readonly targetMode?: number;
  readonly targetKind: WorkspaceSnapshotEntryKind;
  readonly targetExists: boolean;
  readonly state: SnapshotRestoreJournalState;
  readonly updatedAt: string;
}

export interface CreateSnapshotRestoreJournalEntryInput {
  readonly id?: string;
  readonly restoreRequestId: string;
  readonly sequence: number;
  readonly relativePath: string;
  readonly expectedBeforeSha256?: string;
  readonly expectedAfterSha256?: string;
  readonly rollbackBlobSha256?: string;
  readonly rollbackSymlinkTarget?: string;
  readonly targetBlobSha256?: string;
  readonly targetSymlinkTarget?: string;
  readonly rollbackMode?: number;
  readonly targetMode?: number;
  readonly targetKind: WorkspaceSnapshotEntryKind;
  readonly targetExists: boolean;
  readonly state?: SnapshotRestoreJournalState;
  readonly updatedAt: string;
}

export interface ListSnapshotRestoreJournalOptions {
  readonly restoreRequestId: string;
  readonly limit?: number;
}

export interface ListSnapshotRestoreRequestsOptions {
  readonly workspaceId?: string;
  readonly limit?: number;
}

export interface UpdateSnapshotRestoreJournalEntryInput {
  readonly id: string;
  readonly expectedState: SnapshotRestoreJournalState;
  readonly state: SnapshotRestoreJournalState;
  readonly updatedAt: string;
}
