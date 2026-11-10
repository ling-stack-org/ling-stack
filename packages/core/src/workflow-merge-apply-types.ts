import type { WorkflowIntegrationRound, WorkflowIsolationGitIdentity, WorkflowIsolationMutationResult,
  WorkflowIsolationWriter } from "./workflow-isolation-types.js";
import type { WorkflowMergeApprovalRequest, WorkflowMergeTargetSnapshotV1 } from "./workflow-merge-types.js";

export interface WorkflowMergeApplyPermit {
  readonly permitId: string;
  readonly approvalId: string;
  readonly requestId: string;
  readonly roundId: string;
  readonly generation: number;
  readonly authorityDigest: string;
  readonly basisFingerprint: string;
  readonly ownerToken: string;
  readonly leaseId: string;
  readonly intentId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Physical observation only. Neither a matching HEAD nor this object grants permission to apply. */
export interface WorkflowMergeApplyObservation {
  readonly state: "expected" | "candidate" | "diverged" | "unavailable";
  readonly verifiedClean: boolean;
  readonly repository?: WorkflowMergeTargetSnapshotV1;
  readonly head?: string;
  readonly tree?: string;
  readonly basisDigest?: string;
  readonly code?: string;
}

export type WorkflowMergeApplyDisposition = "applied" | "not_applied" | "unknown";
export interface WorkflowMergeApplyObservationEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "workflow_merge_apply_observation";
  readonly permitId: string;
  readonly approvalId: string;
  readonly disposition: WorkflowMergeApplyDisposition;
  readonly observation: WorkflowMergeApplyObservation;
}

export type WorkflowMergeApplyInspection = {
  readonly status: "not_started" | "pending" | "applied" | "not_applied" | "effect_unknown" | "blocked";
  readonly request: WorkflowMergeApprovalRequest;
  readonly permit?: WorkflowMergeApplyPermit;
  readonly round: WorkflowIntegrationRound;
  readonly code?: string;
} | { readonly status: "invalid"; readonly code: string };

/** Host-only single-use apply journal. Generic approvals and terminal writers cannot call through it. */
export interface WorkflowMergeApplyStore {
  beginApply(input: { readonly approvalId: string; readonly expectedRevision: number;
    readonly ownerToken: string; readonly payloadArtifactId: string; readonly now: string }): WorkflowIsolationMutationResult<WorkflowMergeApplyPermit>;
  getPermit(roundId: string, generation: number): WorkflowMergeApplyPermit | undefined;
  assertPermit(input: { readonly permitId: string; readonly ownerToken: string; readonly now: string }): {
    readonly status: "authorized"; readonly permit: WorkflowMergeApplyPermit; readonly request: WorkflowMergeApprovalRequest;
    readonly writer: WorkflowIsolationWriter; readonly round: WorkflowIntegrationRound;
  } | { readonly status: "blocked"; readonly code: string };
  recordObservation(input: { readonly permitId: string; readonly expectedRevision: number;
    readonly artifactId: string; readonly now: string }): WorkflowIsolationMutationResult<WorkflowIntegrationRound>;
  inspectApplication(input: { readonly approvalId: string; readonly now: string }): WorkflowMergeApplyInspection;
}

export interface WorkflowMergeApplyIdentities {
  readonly before: WorkflowIsolationGitIdentity;
  readonly after: WorkflowIsolationGitIdentity;
}
