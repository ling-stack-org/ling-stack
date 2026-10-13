import { randomUUID } from "node:crypto";
import type {
  RunEvaluationArtifactPinV1,
  RunEvaluationTaskAttemptV1,
  RunEvaluationTaskFailureCode,
  RunEvaluationTaskResultV1,
  RunEvaluationTaskV1,
  RunEvaluationVerdict,
  RunEvaluationSeverity,
} from "@ling-stack/contracts";
import { digestRunEvaluationValue } from "./evaluation-json.js";
import { validateTaskEnqueueIdentity } from "../storage/sqlite/run-evaluation-task-validation.js";

export interface EnqueueRunEvaluationTaskInput {
  readonly evaluationId: string;
  readonly evaluationKey: string;
  readonly frozenGraderArtifact: RunEvaluationArtifactPinV1;
  readonly frozenGraderDigest: string;
  readonly repeatOrdinal: number;
  readonly now: string;
}
export interface RunEvaluationTaskFence {
  readonly taskId: string;
  readonly attemptId: string;
  readonly expectedTaskRevision: number;
  readonly expectedAttemptRevision: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly now: string;
}
export interface ClaimRunEvaluationTaskInput {
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly now: string;
}
export interface ListClaimableRunEvaluationTasksInput {
  readonly now: string;
  readonly limit?: number;
}
export interface RenewRunEvaluationTaskLeaseInput extends RunEvaluationTaskFence {
  readonly claimExpiresAt: string;
}
export interface AdmitRunEvaluationTaskDispatchInput extends RunEvaluationTaskFence {
  readonly requestDigest: string;
  readonly executionScopeDigest: string;
}
export interface RunEvaluationTaskResultInput {
  readonly verdict: RunEvaluationVerdict;
  readonly score?: number;
  readonly severity?: RunEvaluationSeverity;
  readonly rawOutputArtifact: RunEvaluationArtifactPinV1;
  readonly rationaleArtifact?: RunEvaluationArtifactPinV1;
  readonly costInputTokens?: number;
  readonly costOutputTokens?: number;
  readonly costAmountMicros?: number;
  readonly latencyMs?: number;
}
export interface CompleteRunEvaluationTaskInput extends RunEvaluationTaskFence {
  readonly result: RunEvaluationTaskResultInput;
}
export interface FinishRunEvaluationTaskBeforeDispatchInput extends RunEvaluationTaskFence {
  readonly nextState: "queued" | "failed" | "cancelled";
  readonly failureCode: RunEvaluationTaskFailureCode;
  readonly nextAttemptAt?: string;
}
export interface RunEvaluationTaskRecoveryCursor {
  readonly claimExpiresAt: string;
  readonly attemptId: string;
}
export interface ReconcileExpiredRunEvaluationTaskAttemptsPageInput {
  readonly now: string;
  readonly limit?: number;
  readonly cursor?: RunEvaluationTaskRecoveryCursor;
}
export interface ReconcileExpiredRunEvaluationTaskAttemptInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly now: string;
}
export interface RunEvaluationTaskClaim {
  readonly task: RunEvaluationTaskV1;
  readonly attempt: RunEvaluationTaskAttemptV1;
}
export interface RunEvaluationTaskAdmission extends RunEvaluationTaskClaim {
  readonly mayDispatch: boolean;
}
export interface RunEvaluationTaskSettlement extends RunEvaluationTaskClaim {
  readonly result: RunEvaluationTaskResultV1;
}
export interface RunEvaluationTaskRecoveryPage {
  readonly examinedCount: number;
  readonly changed: readonly RunEvaluationTaskClaim[];
  readonly nextCursor?: RunEvaluationTaskRecoveryCursor;
}
export type RunEvaluationTaskMutationCode = "not_found" | "stale_revision" | "invalid_transition" | "lease_mismatch" | "lease_not_claimable" | "identity_conflict" | "result_conflict" | "evaluation.lineage_invalid" | "evaluation.artifact_invalid";
export type RunEvaluationTaskMutationResult<T> = {
  readonly ok: true;
  readonly value: T;
  readonly replayed: boolean;
} | {
  readonly ok: false;
  readonly code: RunEvaluationTaskMutationCode;
};
export interface RunEvaluationTaskStore {
  getRunEvaluationTask(taskId: string): RunEvaluationTaskV1 | undefined;
  getRunEvaluationTaskAttempt(attemptId: string): RunEvaluationTaskAttemptV1 | undefined;
  getRunEvaluationTaskResult(taskId: string): RunEvaluationTaskResultV1 | undefined;
  enqueueRunEvaluationTask(input: EnqueueRunEvaluationTaskInput): RunEvaluationTaskMutationResult<RunEvaluationTaskV1>;
  listClaimableRunEvaluationTasks(input: ListClaimableRunEvaluationTasksInput): readonly RunEvaluationTaskV1[];
  claimRunEvaluationTask(input: ClaimRunEvaluationTaskInput): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim>;
  renewRunEvaluationTaskLease(input: RenewRunEvaluationTaskLeaseInput): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim>;
  admitRunEvaluationTaskDispatch(input: AdmitRunEvaluationTaskDispatchInput): RunEvaluationTaskMutationResult<RunEvaluationTaskAdmission>;
  completeRunEvaluationTask(input: CompleteRunEvaluationTaskInput): RunEvaluationTaskMutationResult<RunEvaluationTaskSettlement>;
  finishRunEvaluationTaskBeforeDispatch(input: FinishRunEvaluationTaskBeforeDispatchInput): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim>;
  markRunEvaluationTaskDispatchUnknown(input: RunEvaluationTaskFence): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim>;
  reconcileExpiredRunEvaluationTaskAttempt(input: ReconcileExpiredRunEvaluationTaskAttemptInput): RunEvaluationTaskMutationResult<RunEvaluationTaskClaim>;
  reconcileExpiredRunEvaluationTaskAttemptsPage(input: ReconcileExpiredRunEvaluationTaskAttemptsPageInput): RunEvaluationTaskRecoveryPage;
}
export function runEvaluationTaskIdempotencyKey(input: Omit<EnqueueRunEvaluationTaskInput, "now">): string {
  validateTaskEnqueueIdentity(input);
  return `run-evaluation-task:${digestRunEvaluationValue({
    evaluationId: input.evaluationId,
    evaluationKey: input.evaluationKey,
    frozenGraderArtifact: {
      artifactId: input.frozenGraderArtifact.artifactId,
      contentSha256: input.frozenGraderArtifact.contentSha256
    },
    frozenGraderDigest: input.frozenGraderDigest,
    repeatOrdinal: input.repeatOrdinal,
    graderType: "model"
  })}`;
}
export function createRunEvaluationTaskId(): string {
  return `evaluation_task_${randomUUID()}`;
}
export function createRunEvaluationTaskAttemptId(): string {
  return `evaluation_task_attempt_${randomUUID()}`;
}
export function createRunEvaluationTaskInvocationId(): string {
  return `evaluation_invocation_${randomUUID()}`;
}
export function createRunEvaluationTaskResultId(): string {
  return `evaluation_task_result_${randomUUID()}`;
}
