import type {
  RunEvaluationQaArtifactPinsV1, RunEvaluationQaBatchV1, RunEvaluationQaEnrollmentV1,
  RunEvaluationQaRequestV1, RunEvaluationQaScopeV1, RunEvaluationQaTransportReceiptV1,
  RunEvaluationTaskV1,
} from "@ling-stack/contracts";
import type {
  AdmitRunEvaluationTaskDispatchInput, CompleteRunEvaluationTaskInput, EnqueueRunEvaluationTaskInput,
  RunEvaluationTaskAdmission, RunEvaluationTaskFence, RunEvaluationTaskMutationCode,
  RunEvaluationTaskSettlement,
} from "./evaluation-tasks.js";

export interface CreateRunEvaluationQaBatchInput {
  /** Existing sealed artifact id; Core validates its actual bytes and canonical digest. */
  readonly configSnapshotRef: string;
  readonly configDigest: string;
  readonly now: string;
}
export interface EnrollRunEvaluationQaTaskInput extends EnqueueRunEvaluationTaskInput {
  readonly batchId: string;
  readonly reviewRef: string;
  readonly artifactPins: RunEvaluationQaArtifactPinsV1;
}
export interface ListClaimableRunEvaluationQaTasksInput {
  readonly batchId: string;
  readonly configDigest?: string;
  readonly now: string;
  readonly limit?: number;
}
export interface AdmitRunEvaluationQaRequestInput extends AdmitRunEvaluationTaskDispatchInput {
  readonly batchId: string;
  readonly configDigest: string;
  /** Final serialized wire body, transiently checked and hashed; never persisted. */
  readonly payloadUtf8: string;
  readonly estimatedInputTokens: number;
  readonly outputTokenLimit: 1024;
}
export interface CompleteRunEvaluationQaRequestInput extends CompleteRunEvaluationTaskInput {
  readonly requestId: string;
  readonly receipt: RunEvaluationQaTransportReceiptV1;
}
export interface MarkRunEvaluationQaRequestUnknownInput extends RunEvaluationTaskFence {
  readonly requestId: string;
}
export interface ReleaseRunEvaluationQaLaneInput {
  readonly requestId: string;
  readonly expectedRequestRevision: number;
  readonly now: string;
  /** Trusted Host port, not a public assertion of transport drain. */
  readonly release: { readonly kind: "host_callback_drained" }
    | { readonly kind: "host_explicit_reconciliation"; readonly auditRef: string };
}
export type RunEvaluationQaMutationCode = RunEvaluationTaskMutationCode
  | "qa_not_enrolled" | "qa_config_conflict" | "qa_lane_busy" | "qa_lane_quarantined"
  | "qa_batch_budget_exhausted" | "qa_window_budget_exhausted" | "qa_payload_budget_exceeded"
  | "qa_payload_invalid"
  | "qa_receipt_invalid";
export type RunEvaluationQaMutationResult<T> = { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly code: RunEvaluationQaMutationCode };
export interface RunEvaluationQaAdmission extends RunEvaluationTaskAdmission { readonly request: RunEvaluationQaRequestV1 }
export interface RunEvaluationQaSettlement extends RunEvaluationTaskSettlement { readonly request: RunEvaluationQaRequestV1 }
export interface RunEvaluationQaStore {
  getRunEvaluationQaScope(): RunEvaluationQaScopeV1 | undefined;
  getRunEvaluationQaBatch(id: string): RunEvaluationQaBatchV1 | undefined;
  getRunEvaluationQaEnrollment(taskId: string): RunEvaluationQaEnrollmentV1 | undefined;
  getRunEvaluationQaRequest(id: string): RunEvaluationQaRequestV1 | undefined;
  /** Exact allowlisted receipt row for one immutable task binding; never returns request payload bytes. */
  getRunEvaluationQaRequestForTask(taskId: string): RunEvaluationQaRequestV1 | undefined;
  listClaimableRunEvaluationQaTasks(input: ListClaimableRunEvaluationQaTasksInput): readonly RunEvaluationTaskV1[];
  createRunEvaluationQaBatch(input: CreateRunEvaluationQaBatchInput): RunEvaluationQaMutationResult<RunEvaluationQaBatchV1>;
  enrollRunEvaluationQaTask(input: EnrollRunEvaluationQaTaskInput): RunEvaluationQaMutationResult<RunEvaluationQaEnrollmentV1>;
  admitRunEvaluationQaRequest(input: AdmitRunEvaluationQaRequestInput): RunEvaluationQaMutationResult<RunEvaluationQaAdmission>;
  completeRunEvaluationQaRequest(input: CompleteRunEvaluationQaRequestInput): RunEvaluationQaMutationResult<RunEvaluationQaSettlement>;
  markRunEvaluationQaRequestUnknown(input: MarkRunEvaluationQaRequestUnknownInput): RunEvaluationQaMutationResult<RunEvaluationQaRequestV1>;
  reconcileRunEvaluationQaScope(input: { readonly now: string }): RunEvaluationQaMutationResult<RunEvaluationQaScopeV1>;
  releaseRunEvaluationQaLane(input: ReleaseRunEvaluationQaLaneInput): RunEvaluationQaMutationResult<RunEvaluationQaRequestV1>;
}
