import type { RuntimeAttemptFenceV1, RuntimeSemaphoreResourceType, RuntimeSemaphoreSlot } from "./runtime-supervisor-types.js";
import type { WorkflowStepStartOwnerV1 } from "./workflow-step-start-owner.js";

export interface WorkflowStepAdmissionEntry {
  readonly resourceType: Exclude<RuntimeSemaphoreResourceType, "workflow_resource">;
  readonly resourceKey: string;
  readonly limit: number;
}

/** Host-resolved identities, frozen before begin. Unresolved provider/runner plans fail closed. */
export interface WorkflowStepAdmissionPlan {
  readonly entries: readonly WorkflowStepAdmissionEntry[];
  /** Host-canonicalized exclusive identities, not unnormalized filesystem paths. */
  readonly resourceKeys: readonly string[];
}

export interface WorkflowStepStartAdmission {
  readonly workflowStepId: string;
  readonly workspaceId: string;
  readonly owner: WorkflowStepStartOwnerV1;
  readonly plan: WorkflowStepAdmissionPlan;
  readonly status: "preparing" | "transferred" | "released";
  readonly runId?: string;
  readonly fence?: RuntimeAttemptFenceV1;
  readonly slotIds: readonly string[];
  readonly createdAt: string;
  readonly transferredAt?: string;
  readonly releasedAt?: string;
}

export interface TransferChannelWorkflowStepStartAdmissionInput extends RuntimeAttemptFenceV1 {
  readonly workflowStepId: string;
  readonly owner: WorkflowStepStartOwnerV1;
  readonly runId: string;
  /** Derived from the actual Run by the Host, and must equal the complete begin plan. */
  readonly admission: WorkflowStepAdmissionPlan;
  readonly now: string;
  readonly expiresAt: string;
}

export type TransferChannelWorkflowStepStartAdmissionResult =
  | { readonly status: "transferred" | "duplicate"; readonly slots: readonly RuntimeSemaphoreSlot[] }
  | { readonly status: "stale" | "invalid"; readonly code: string };

/** Same logical Run only. Claim its durable continuation before reacquiring the complete plan. */
export interface ResumeChannelWorkflowStepStartAdmissionInput extends TransferChannelWorkflowStepStartAdmissionInput {
  readonly continuationId: string;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly expectedContinuationRevision: number;
  readonly claimOwner: string;
  readonly claimToken: string;
}

export type ResumeChannelWorkflowStepStartAdmissionResult =
  | { readonly status: "resumed" | "duplicate"; readonly slots: readonly RuntimeSemaphoreSlot[] }
  | { readonly status: "conflict"; readonly code: string; readonly resourceType: RuntimeSemaphoreResourceType; readonly resourceKey: string }
  | { readonly status: "stale" | "invalid"; readonly code: string };

export interface WorkflowStepAdmissionReleaseProof {
  readonly dispatchState: "not_dispatched" | "unknown";
  /** Mandatory if any Run was prepared for this Task, including a failed pre-dispatch Run. */
  readonly runId?: string;
  readonly fence?: RuntimeAttemptFenceV1;
}

export interface ReleaseChannelWorkflowStepStartAdmissionInput extends WorkflowStepAdmissionReleaseProof {
  readonly workflowStepId: string;
  readonly owner: WorkflowStepStartOwnerV1;
  readonly now: string;
  readonly reason: string;
}

export type ReleaseChannelWorkflowStepStartAdmissionResult =
  | { readonly status: "released" | "duplicate"; readonly releasedSlots: number }
  | { readonly status: "retained" | "stale" | "invalid"; readonly code: string };

export interface WorkflowStepAdmissionStore {
  getChannelWorkflowStepStartAdmission(workflowStepId: string, owner: WorkflowStepStartOwnerV1): WorkflowStepStartAdmission | undefined;
  transferChannelWorkflowStepStartAdmission(input: TransferChannelWorkflowStepStartAdmissionInput): TransferChannelWorkflowStepStartAdmissionResult;
  resumeChannelWorkflowStepStartAdmission(input: ResumeChannelWorkflowStepStartAdmissionInput): ResumeChannelWorkflowStepStartAdmissionResult;
  releaseChannelWorkflowStepStartAdmission(input: ReleaseChannelWorkflowStepStartAdmissionInput): ReleaseChannelWorkflowStepStartAdmissionResult;
}
