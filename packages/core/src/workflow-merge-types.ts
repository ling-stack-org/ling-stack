import type { ApprovalRequest } from "./approval-types.js";
import type { WorkflowIntegrationCandidate, WorkflowIntegrationRound, WorkflowIsolationMutationResult,
  WorkflowIsolationRepositoryIdentity, WorkflowIsolationTarget, WorkflowIsolationTemplatePin } from "./workflow-isolation-types.js";

export interface WorkflowMergeHostStateSnapshotV1 {
  readonly root: string;
  readonly rootDevice: string;
  readonly rootInode: string;
}

/** Host-observed repository identity. No filesystem access or write permission is implied. */
export interface WorkflowMergeTargetSnapshotV1 {
  readonly root: string;
  readonly commonDir: string;
  readonly gitDir: string;
  readonly head: string;
  readonly branchRef: string;
  readonly configurationDigest: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly commonDevice: string;
  readonly commonInode: string;
  readonly dirty: boolean;
  /** Exact Host state directory only; candidate trees may never contain this path. */
  readonly hostState?: WorkflowMergeHostStateSnapshotV1;
}

export interface WorkflowMergeApprovalPayloadV1 {
  readonly type: "workflow_merge";
  readonly schemaVersion: 1;
  readonly workflowId: string;
  /** Existing durable approval owner, not a pre/post step gate. */
  readonly workflowStepId: string;
  readonly roundId: string;
  readonly generation: number;
  readonly authorityDigest: string;
  readonly inputsDigest: string;
  readonly graphFingerprint: string;
  readonly safetyFingerprint: string;
  readonly templatePins: readonly WorkflowIsolationTemplatePin[];
  readonly repositoryIdentity: WorkflowIsolationRepositoryIdentity;
  readonly target: WorkflowIsolationTarget;
  readonly targetSnapshot: WorkflowMergeTargetSnapshotV1;
  readonly candidate: WorkflowIntegrationCandidate;
  readonly expiresAt: string;
  readonly fingerprint: string;
}

export interface WorkflowMergeApprovalRequest {
  readonly requestId: string;
  readonly approvalId: string;
  readonly payload: WorkflowMergeApprovalPayloadV1;
  readonly createdAt: string;
}

export type WorkflowMergeApprovalInspection = {
  readonly status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  readonly request: WorkflowMergeApprovalRequest;
  readonly approval: ApprovalRequest;
  readonly round: WorkflowIntegrationRound;
} | { readonly status: "blocked"; readonly code: string };

/** Host-only proposal/evidence adapter. This interface cannot issue a merge permit or apply Git. */
export interface WorkflowMergeApprovalStore {
  requestApproval(input: {
    readonly roundId: string;
    readonly generation: number;
    readonly expectedRevision: number;
    readonly authorityDigest: string;
    readonly targetSnapshot: WorkflowMergeTargetSnapshotV1;
    readonly expiresAt: string;
    readonly now: string;
  }): WorkflowIsolationMutationResult<WorkflowMergeApprovalRequest>;
  getRequest(roundId: string, generation: number): WorkflowMergeApprovalRequest | undefined;
  inspectApproval(input: { readonly approvalId: string; readonly now: string }): WorkflowMergeApprovalInspection;
}
