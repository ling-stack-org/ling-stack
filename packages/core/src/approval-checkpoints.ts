import { createHash, randomUUID } from "node:crypto";
import type { RunnerContinuationV1 } from "@ling-stack/contracts";
import type {
  ApprovalActionType,
  ApprovalPayload,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalStatus,
} from "./approval-types.js";
import type { ControlPlaneEvent, RunSession } from "./run-types.js";
import type { PrepareContinuationInput } from "./harness/continuations.js";
import type {
  CreateWorkUnitAttemptInput,
  RuntimeAttemptFenceV1,
  WorkUnit,
  WorkUnitAttempt,
} from "./runtime-supervisor-types.js";

export type LingApprovalCheckpointStatus =
  | ApprovalStatus
  | "resume_pending"
  | "resumed"
  | "resume_failed";

export interface RunnerResumeHandle {
  readonly kind: "ling_continuation" | "runner_native";
  readonly runnerId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly handleRef?: string;
  readonly payload?: Record<string, unknown>;
  readonly verified?: boolean;
}

export interface ApprovalResumeBasisV1 {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly priorAttemptId: string;
  readonly workflowStepId?: string;
  readonly toolCallId: string;
  readonly actionType: ApprovalActionType;
  readonly sideEffectFingerprint: string;
  readonly delegatedRequirementFingerprint?: string;
  readonly fingerprint: string;
}

export interface LingApprovalCheckpoint {
  readonly id: string;
  readonly approvalId: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkActionId?: string;
  readonly workflowStepId?: string;
  readonly channelId?: string;
  readonly toolCallId?: string;
  readonly actionType: ApprovalActionType;
  readonly risk: ApprovalRisk;
  readonly title: string;
  readonly description: string;
  readonly status: LingApprovalCheckpointStatus;
  readonly sideEffect: ApprovalPayload;
  readonly previewArtifactIds: readonly string[];
  readonly resultArtifactIds: readonly string[];
  readonly revision: number;
  readonly resumeBasis?: ApprovalResumeBasisV1;
  readonly runnerResumeHandle?: RunnerResumeHandle;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
  readonly resumedAt?: string;
  readonly resumeFailureReason?: string;
}

export interface CreateApprovalCheckpointInput {
  readonly approval: ApprovalRequest;
  readonly status?: LingApprovalCheckpointStatus;
  readonly previewArtifactIds?: readonly string[];
  readonly resultArtifactIds?: readonly string[];
  readonly resumeBasis?: ApprovalResumeBasisV1;
  readonly runnerResumeHandle?: RunnerResumeHandle;
}

export interface UpdateApprovalCheckpointStatusInput {
  readonly status: LingApprovalCheckpointStatus;
  readonly resolvedAt?: string;
  readonly resumedAt?: string;
  readonly resumeFailureReason?: string | null;
  readonly previewArtifactIds?: readonly string[];
  readonly resultArtifactIds?: readonly string[];
  readonly expectedStatus?: LingApprovalCheckpointStatus;
  readonly expectedRevision?: number;
  readonly resumeBasis?: ApprovalResumeBasisV1;
  readonly runnerResumeHandle?: RunnerResumeHandle | null;
}

export interface ListApprovalCheckpointsOptions {
  readonly status?: LingApprovalCheckpointStatus;
  readonly before?: { readonly createdAt: string; readonly id: string };
  readonly approvalId?: string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly externalWorkActionId?: string;
  readonly workflowStepId?: string;
  readonly limit?: number;
}

export type ApprovalResumeClaimMode = "activate_waiting" | "replace_running";

export type ApprovalResumeContinuationPreparation = Omit<PrepareContinuationInput, "targetAttempt"> & {
  readonly targetAttempt: PrepareContinuationInput["targetAttempt"] & { readonly id: string };
};

interface CommitApprovalResumeClaimBase {
  readonly checkpointId: string;
  readonly expectedCheckpointStatus: "approved" | "resume_pending";
  readonly expectedCheckpointRevision: number;
  readonly approvalId: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly expectedActiveAttemptId: string;
  readonly attemptToLoseId?: string;
  readonly runnerResumeHandle: RunnerResumeHandle;
  readonly mode: ApprovalResumeClaimMode;
  readonly now: string;
}

export type CommitApprovalResumeClaimInput = CommitApprovalResumeClaimBase & (
  | {
      readonly replacementAttempt: CreateWorkUnitAttemptInput & { readonly id: string };
      readonly continuationPreparation?: never;
    }
  | {
      /** The approval transaction creates the continuation and replacement Attempt together. */
      readonly replacementAttempt?: never;
      readonly continuationPreparation: ApprovalResumeContinuationPreparation;
    }
);

export type CommitApprovalResumeClaimResult =
  | {
      readonly ok: true;
      readonly checkpoint: LingApprovalCheckpoint;
      readonly run: RunSession;
      readonly workUnit: WorkUnit;
      readonly attempt: WorkUnitAttempt;
      readonly runnerContinuation?: RunnerContinuationV1;
      readonly controlPlaneEvents: readonly ControlPlaneEvent[];
    }
  | {
      readonly ok: false;
      readonly code:
        | "approval_resume_checkpoint_stale"
        | "approval_resume_lineage_mismatch"
        | "approval_resume_run_state_stale"
        | "approval_resume_work_unit_state_stale"
        | "approval_resume_attempt_conflict"
        | "approval_resume_transition_failed";
    };

export interface CommitApprovalResumeVerifiedTerminalInput {
  readonly kind: "verified_lineage";
  readonly checkpointId: string;
  readonly expectedCheckpointStatus: "approved" | "resume_pending";
  readonly expectedCheckpointRevision: number;
  readonly approvalId: string;
  readonly runId: string;
  readonly expectedRunStatus: "waiting_for_approval" | "running";
  readonly workUnitId: string;
  readonly expectedWorkUnitStatus: "waiting_for_approval" | "running";
  readonly attemptId: string;
  readonly status: "succeeded" | "failed";
  readonly attemptStatus: "succeeded" | "failed" | "lost";
  readonly checkpointStatus: "resumed" | "resume_failed";
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly summaryPath?: string;
  readonly runnerContinuationTerminal?: {
    readonly continuationId: string;
    readonly expectedRevision: number;
    readonly expectedState: Extract<RunnerContinuationV1["state"], "prepared" | "claimed" | "running">;
    readonly claimOwner: string;
    readonly claimToken: string;
    readonly targetFence: RuntimeAttemptFenceV1;
  };
  readonly now: string;
}

export interface CommitApprovalResumeCheckpointQuarantineInput {
  readonly kind: "checkpoint_quarantine";
  readonly checkpointId: string;
  readonly expectedCheckpointStatus: "approved" | "resume_pending";
  readonly expectedCheckpointRevision: number;
  readonly approvalId: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly now: string;
}

export interface CommitSuspendedApprovalDeniedTerminalInput {
  readonly kind: "suspended_approval_denied";
  readonly checkpointId: string;
  readonly expectedCheckpointRevision: number;
  readonly approvalId: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly reason: string;
  readonly now: string;
}

export type CommitApprovalResumeTerminalInput =
  | CommitApprovalResumeVerifiedTerminalInput
  | CommitApprovalResumeCheckpointQuarantineInput
  | CommitSuspendedApprovalDeniedTerminalInput;

export type CommitApprovalResumeTerminalResult =
  | {
      readonly ok: true;
      readonly kind: "verified_lineage";
      readonly checkpoint: LingApprovalCheckpoint;
      readonly run: RunSession;
      readonly workUnit: WorkUnit;
      readonly attempt: WorkUnitAttempt;
      readonly runnerContinuation?: RunnerContinuationV1;
      readonly controlPlaneEvents: readonly ControlPlaneEvent[];
    }
  | {
      readonly ok: true;
      readonly kind: "checkpoint_quarantine";
      readonly checkpoint: LingApprovalCheckpoint;
      readonly controlPlaneEvents: readonly ControlPlaneEvent[];
    }
  | {
      readonly ok: true;
      readonly kind: "suspended_approval_denied";
      readonly checkpoint: LingApprovalCheckpoint;
      readonly run: RunSession;
      readonly workUnit: WorkUnit;
      readonly attempt: WorkUnitAttempt;
      readonly controlPlaneEvents: readonly ControlPlaneEvent[];
    }
  | { readonly ok: false; readonly code: "approval_resume_terminal_stale" | "approval_resume_lineage_mismatch" };

interface CommitApprovalResumeSuspensionBaseInput {
  readonly checkpointId: string;
  readonly expectedCheckpointRevision: number;
  readonly approvalId: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly cause: string;
  readonly now: string;
}

export type CommitApprovalResumeSuspensionInput = CommitApprovalResumeSuspensionBaseInput & (
  | {
      readonly kind: "approval_wait";
      readonly expectedCheckpointStatus: "pending" | "approved";
      readonly expectedRunStatus: "waiting_for_approval";
      readonly expectedWorkUnitStatus: "waiting_for_approval";
    }
  | {
      readonly kind: "resume_pre_dispatch";
      readonly expectedCheckpointStatus: "resume_pending";
      readonly expectedRunStatus: "running";
      readonly expectedWorkUnitStatus: "running";
    }
);

export type CommitApprovalResumeSuspensionResult =
  | {
      readonly ok: true;
      readonly checkpoint: LingApprovalCheckpoint;
      readonly run: RunSession;
      readonly workUnit: WorkUnit;
      readonly attempt: WorkUnitAttempt;
      readonly controlPlaneEvents: readonly ControlPlaneEvent[];
    }
  | { readonly ok: false; readonly code: "approval_resume_suspension_stale" | "approval_resume_lineage_mismatch" };

export const approvalCheckpointStatuses: readonly LingApprovalCheckpointStatus[] = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
  "resume_pending",
  "resumed",
  "resume_failed",
];

export function createApprovalCheckpointId(): string {
  return `approval_checkpoint_${randomUUID()}`;
}

export function approvalSideEffectFingerprintV1(input: {
  readonly actionType: ApprovalActionType;
  readonly toolCallId: string;
  readonly sideEffect: ApprovalPayload;
}): string {
  return sha256StableJson({
    schemaVersion: 1,
    actionType: input.actionType,
    toolCallId: input.toolCallId,
    sideEffect: input.sideEffect,
  });
}

export function createApprovalResumeBasisV1(input: Omit<ApprovalResumeBasisV1, "schemaVersion" | "fingerprint">): ApprovalResumeBasisV1 {
  const value = { schemaVersion: 1 as const, ...input };
  return { ...value, fingerprint: sha256StableJson(value) };
}

export function isApprovalResumeBasisV1(value: unknown): value is ApprovalResumeBasisV1 {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1
    || !isNonEmptyString(record.approvalId)
    || !isNonEmptyString(record.runId)
    || !isNonEmptyString(record.workUnitId)
    || !isNonEmptyString(record.priorAttemptId)
    || !isNonEmptyString(record.toolCallId)
    || !isNonEmptyString(record.actionType)
    || !isNonEmptyString(record.sideEffectFingerprint)
    || !isNonEmptyString(record.fingerprint)) {
    return false;
  }
  if (record.workflowStepId !== undefined && !isNonEmptyString(record.workflowStepId)) return false;
  if (record.delegatedRequirementFingerprint !== undefined && !isNonEmptyString(record.delegatedRequirementFingerprint)) return false;
  const { fingerprint, ...basis } = record;
  return fingerprint === sha256StableJson(basis);
}

function sha256StableJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value)), "utf8").digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
