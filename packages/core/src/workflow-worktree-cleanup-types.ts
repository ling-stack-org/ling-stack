import type { WorkflowMergeTargetSnapshotV1 } from "./workflow-merge-types.js";
import type { WorkflowIsolationMutationResult } from "./workflow-isolation-types.js";

export interface WorkflowWorktreeCleanupRef {
  readonly ref: string;
  readonly commit: string;
}

/** Frozen Host creation evidence; not a request-provided path or permission to remove it. */
export interface WorkflowWorktreeCleanupPlanV1 {
  readonly schemaVersion: 1;
  readonly kind: "workflow_worktree_cleanup_plan";
  readonly roundId: string;
  readonly generation: number;
  readonly workflowId: string;
  readonly inputsDigest: string;
  readonly authorityDigest: string;
  readonly role: "integration" | "step";
  readonly bindingId: string;
  readonly runId: string;
  readonly scope: {
    readonly roundId: string;
    readonly stepId: string;
    readonly generation: number;
    readonly worktreeId: string;
    readonly executionRoot: string;
    readonly branchRef: string;
    readonly baseCommit: string;
    readonly worktreeRoot: string;
    readonly repository: WorkflowMergeTargetSnapshotV1;
  };
  readonly creationReceipt: {
    readonly worktreeId: string;
    readonly executionRoot: string;
    readonly branchRef: string;
    readonly baseCommit: string;
    readonly commonDir: string;
    readonly rootDevice: string;
    readonly rootInode: string;
  };
  readonly retainedRefs: readonly WorkflowWorktreeCleanupRef[];
  readonly artifactIds: readonly string[];
}

export type WorkflowWorktreeCleanupInspection = {
  readonly status: "eligible";
  readonly plan: WorkflowWorktreeCleanupPlanV1;
} | { readonly status: "retained"; readonly code: string };

export interface WorkflowWorktreeCleanupIntent {
  readonly cleanupId: string;
  readonly roundId: string;
  readonly generation: number;
  readonly worktreeId: string;
  readonly ownerToken: string;
  readonly planArtifactId: string;
  readonly planDigest: string;
  readonly plan: WorkflowWorktreeCleanupPlanV1;
  readonly createdAt: string;
}

/** A physical observation, never evidence that the original Attempt stopped. */
export interface WorkflowWorktreeCleanupObservation {
  readonly state: "removed" | "present" | "unknown";
  readonly executionRoot: string;
  readonly worktreeId: string;
  readonly branchRef: string;
  readonly commonDir: string;
  readonly retainedRefs: readonly WorkflowWorktreeCleanupRef[];
  readonly code?: string;
}

export interface WorkflowWorktreeCleanupReceipt {
  readonly receiptId: string;
  readonly cleanupId: string;
  readonly state: WorkflowWorktreeCleanupObservation["state"];
  readonly artifactId: string;
  readonly createdAt: string;
}

/** Separate from the business round journal: cleanup failures never change the delivery result. */
export interface WorkflowWorktreeCleanupStore {
  inspect(input: { readonly roundId: string; readonly generation: number; readonly worktreeId: string;
    readonly now: string }): WorkflowWorktreeCleanupInspection;
  begin(input: { readonly roundId: string; readonly generation: number; readonly worktreeId: string;
    readonly ownerToken: string; readonly planArtifactId: string; readonly now: string }): WorkflowIsolationMutationResult<WorkflowWorktreeCleanupIntent>;
  getIntent(roundId: string, generation: number, worktreeId: string): WorkflowWorktreeCleanupIntent | undefined;
  listIntents(input?: { readonly roundId?: string; readonly generation?: number;
    readonly workflowId?: string }): readonly WorkflowWorktreeCleanupIntent[];
  assertIntent(input: { readonly cleanupId: string; readonly ownerToken: string; readonly now: string }): WorkflowWorktreeCleanupInspection;
  recordObservation(input: { readonly cleanupId: string; readonly artifactId: string; readonly now: string }): WorkflowIsolationMutationResult<WorkflowWorktreeCleanupReceipt>;
  listReceipts(cleanupId: string): readonly WorkflowWorktreeCleanupReceipt[];
}
