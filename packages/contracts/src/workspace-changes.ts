import type { WorkspaceGitFileKind, WorkspaceGitStatusState } from "./channels.js";
import type { ConversationDomainRef } from "./conversation-continuity.js";

export interface WorkspaceChangeFile {
  readonly path: string;
  readonly originalPath?: string;
  readonly kind: WorkspaceGitFileKind;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly diff?: string;
  readonly truncated: boolean;
}

export interface WorkspaceChangesResponse {
  readonly cwd: string;
  readonly state: WorkspaceGitStatusState;
  readonly repoRoot?: string;
  readonly branchName?: string;
  readonly upstream?: string;
  readonly headSha?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly files: readonly WorkspaceChangeFile[];
  readonly totalFileCount: number;
  readonly truncated: boolean;
  readonly checkedAt: string;
  readonly unavailableReason?: string;
  readonly errorMessage?: string;
}

export type RunWorkspaceChangeState = "applied" | "undone" | "conflicted" | "unavailable";

export interface RunWorkspaceChangeFile {
  readonly path: string;
  readonly operationCount: number;
  readonly additions: number;
  readonly deletions: number;
}

/** A review is an immutable, scoped net diff, not summed recovery operations or current Git status. */
export interface WorkspaceChangeReview {
  readonly scope: { readonly kind: "turn" | "run" | "workflow"; readonly id: string };
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly runIds: readonly string[];
  readonly revision: string;
  readonly state: "exact" | "partial" | "unavailable";
  readonly files: readonly WorkspaceChangeReviewFile[];
  /** Includes paths restored to baseline, which correctly have no net-diff row. */
  readonly coveredPaths: readonly string[];
  /** Present only when every included path has a complete, bounded net diff. */
  readonly additions?: number;
  readonly deletions?: number;
  readonly unavailableReason?: string;
}

export interface WorkspaceChangeReviewFile {
  readonly id: string;
  readonly path: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly state: "exact" | "unavailable";
  readonly additions?: number;
  readonly deletions?: number;
  readonly diff?: string;
  readonly unavailableReason?: string;
}

export interface RunWorkspaceChangeSummary {
  readonly fileCount: number;
  readonly addCount: number;
  readonly updateCount: number;
  readonly deleteCount: number;
  readonly moveCount: number;
  readonly addedLines: number;
  readonly removedLines: number;
}

export interface RunWorkspaceChangesResponse {
  readonly cwd: string;
  readonly runId: string;
  readonly state: RunWorkspaceChangeState;
  readonly canUndo: boolean;
  readonly canReapply: boolean;
  readonly files: readonly RunWorkspaceChangeFile[];
  readonly summary: RunWorkspaceChangeSummary;
  readonly unavailableReason?: string;
  readonly updatedAt: string;
  readonly review?: WorkspaceChangeReview;
}

export const workspaceMutationOperations = ["add", "update", "delete", "move"] as const;
export type WorkspaceMutationOperation = (typeof workspaceMutationOperations)[number];

export const workspaceMutationEffectStates = ["applied", "effect_unknown", "failed"] as const;
export type WorkspaceMutationEffectState = (typeof workspaceMutationEffectStates)[number];

/** Durable provenance for one reversible workspace operation. */
export interface WorkspaceMutationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId: string;
  readonly toolCallId?: string;
  readonly approvalId?: string;
  readonly artifactId?: string;
  /** Artifact containing the forward PatchPlan used for reapply. */
  readonly forwardPatchArtifactId?: string;
  readonly patchPlanId: string;
  readonly operationIndex: number;
  readonly path: string;
  readonly operation: WorkspaceMutationOperation;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly inversePatchArtifactId: string;
  readonly provenanceSeq: number;
  readonly effectState: WorkspaceMutationEffectState;
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly createdAt: string;
}

export interface CreateWorkspaceMutationRecordInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly cwd: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId: string;
  readonly toolCallId?: string;
  readonly approvalId?: string;
  readonly artifactId?: string;
  readonly forwardPatchArtifactId?: string;
  readonly patchPlanId: string;
  readonly operationIndex: number;
  readonly path: string;
  readonly operation: WorkspaceMutationOperation;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly inversePatchArtifactId: string;
  readonly effectState?: WorkspaceMutationEffectState;
  readonly sourceRefs?: readonly ConversationDomainRef[];
  readonly createdAt: string;
}

export interface ListWorkspaceMutationRecordsOptions {
  readonly workspaceId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly patchPlanId?: string;
  readonly effectState?: WorkspaceMutationEffectState;
  readonly limit?: number;
}

/** Immutable install boundary for a replacement context projection. */
export interface CompactionCheckpoint {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly channelId?: string;
  readonly sourceTurnId: string;
  readonly contextViewId?: string;
  readonly contextViewCreatedAt?: string;
  readonly coveredItemSeqFrom: number;
  readonly coveredItemSeqTo: number;
  readonly coveredTurnIds: readonly string[];
  readonly summaryIds: readonly string[];
  readonly summaryContentSha256?: string;
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly workspaceProvenanceWatermark: string;
  readonly compactionPolicyVersion: string;
  readonly createdAt: string;
}

export interface CreateCompactionCheckpointInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly threadId: string;
  readonly channelId?: string;
  readonly sourceTurnId: string;
  readonly contextViewId?: string;
  readonly contextViewCreatedAt?: string;
  readonly coveredItemSeqFrom: number;
  readonly coveredItemSeqTo: number;
  readonly coveredTurnIds: readonly string[];
  readonly summaryIds?: readonly string[];
  readonly summaryContentSha256?: string;
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly workspaceProvenanceWatermark: string;
  readonly compactionPolicyVersion: string;
  readonly createdAt: string;
}

export interface ListCompactionCheckpointsOptions {
  readonly workspaceId?: string;
  readonly threadId?: string;
  readonly sourceTurnId?: string;
  readonly limit?: number;
}

export interface TurnWorkspaceChangesResponse {
  readonly cwd: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runIds: readonly string[];
  readonly state: RunWorkspaceChangeState;
  readonly canUndo: boolean;
  readonly canReapply: boolean;
  readonly files: readonly RunWorkspaceChangeFile[];
  readonly summary: RunWorkspaceChangeSummary;
  readonly checkpointId?: string;
  readonly provenanceComplete: boolean;
  readonly unavailableReason?: string;
  readonly updatedAt: string;
  readonly review?: WorkspaceChangeReview;
}

export const postCompactionUndoStates = [
  "available",
  "validating",
  "applied",
  "undone",
  "conflict",
  "provenance_missing",
  "snapshot_unverified",
  "expired",
  "failed",
] as const;
export type PostCompactionUndoState = (typeof postCompactionUndoStates)[number];
export type PostCompactionUndoAction = "undo" | "reapply";

/** Durable idempotency/CAS record for one Turn-level post-compaction recovery request. */
export interface PostCompactionUndoRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly targetTurnId: string;
  readonly targetRunIds: readonly string[];
  readonly checkpointId?: string;
  /** Fingerprint of the target paths observed immediately before this action. */
  readonly expectedWorkspaceFingerprint: string;
  readonly action: PostCompactionUndoAction;
  readonly state: PostCompactionUndoState;
  readonly affectedPaths: readonly string[];
  readonly lastEventSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePostCompactionUndoRecordInput {
  readonly id?: string;
  readonly idempotencyKey: string;
  readonly workspaceId?: string;
  readonly threadId: string;
  readonly targetTurnId: string;
  readonly targetRunIds: readonly string[];
  readonly checkpointId?: string;
  readonly expectedWorkspaceFingerprint: string;
  readonly action: PostCompactionUndoAction;
  readonly state?: PostCompactionUndoState;
  readonly affectedPaths: readonly string[];
  readonly lastEventSeq?: number;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface UpdatePostCompactionUndoRecordInput {
  readonly id: string;
  readonly expectedState: PostCompactionUndoState;
  readonly state: PostCompactionUndoState;
  readonly lastEventSeq: number;
  readonly updatedAt: string;
}

export interface ListPostCompactionUndoRecordsOptions {
  readonly workspaceId?: string;
  readonly threadId?: string;
  readonly targetTurnId?: string;
  readonly idempotencyKey?: string;
  readonly limit?: number;
}

export interface WorkflowWorkspaceChangesResponse {
  readonly cwd: string;
  readonly workflowId: string;
  readonly runIds: readonly string[];
  readonly state: RunWorkspaceChangeState;
  readonly canUndo: boolean;
  readonly canReapply: boolean;
  readonly files: readonly RunWorkspaceChangeFile[];
  readonly summary: RunWorkspaceChangeSummary;
  readonly unavailableReason?: string;
  readonly updatedAt: string;
  readonly review?: WorkspaceChangeReview;
}

export type WorkspaceFileOpenTarget =
  | "vscode"
  | "cursor"
  | "zed"
  | "sublime_text"
  | "textedit"
  | "xcode"
  | "pycharm"
  | "webstorm"
  | "intellij"
  | "finder"
  | "terminal";

export type WorkspaceFileCapabilityTarget = "open_file" | "open_diff" | "open_artifact";

export interface WorkspaceFileCapabilityScope {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly participantId: string;
  readonly workflowStepId?: string;
}

/** Request for a short-lived Host grant. The ref id is checked against durable action evidence. */
export interface WorkspaceFileCapabilityRequest {
  readonly cwd: string;
  readonly capabilityTarget: WorkspaceFileCapabilityTarget;
  readonly refId: string;
  readonly scope: WorkspaceFileCapabilityScope;
  readonly ttlMs?: number;
}

export interface WorkspaceFileCapability {
  readonly capabilityId: string;
  readonly capabilityTarget: WorkspaceFileCapabilityTarget;
  readonly refId: string;
  readonly displayPath: string;
  readonly scope: WorkspaceFileCapabilityScope;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly daemonEpoch: string;
}

export interface WorkspaceFileCapabilityResponse {
  readonly cwd: string;
  readonly capability: WorkspaceFileCapability;
}

export interface WorkspaceFileCapabilityPreviewRequest {
  readonly cwd: string;
  readonly capabilityId: string;
  readonly scope: WorkspaceFileCapabilityScope;
  readonly maxBytes?: number;
  readonly line?: number;
}

export interface WorkspaceFileOpenOption {
  readonly id: WorkspaceFileOpenTarget;
  readonly label: string;
  readonly available: boolean;
}

export interface WorkspaceFileOpenOptionsResponse {
  readonly cwd: string;
  readonly path: string;
  readonly options: readonly WorkspaceFileOpenOption[];
}

export interface WorkspaceFileOpenRequest {
  readonly target: WorkspaceFileOpenTarget;
  readonly line?: number;
  /** Required when opening a transcript-owned trusted ref; omitted for generic workspace browsing. */
  readonly capabilityId?: string;
  readonly scope?: WorkspaceFileCapabilityScope;
}

export interface WorkspaceFileOpenResponse {
  readonly cwd: string;
  readonly path: string;
  readonly target: WorkspaceFileOpenTarget;
  readonly opened: true;
  readonly capabilityId?: string;
}
