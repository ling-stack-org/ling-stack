import type { RunEvaluationArtifactPinV1 } from "./harness.js";

/** Read-only Host-managed QA facts. No prompt, secret, grade or producer authority. */
export interface RunEvaluationQaScopeV1 {
  readonly schemaVersion: 1;
  readonly namespaceId: string;
  readonly canonicalWorkspaceCwd: string;
  readonly batchRequestLimit: 3;
  readonly rollingRequestLimit: 12;
  readonly rollingWindowMs: 86400000;
  readonly clockHighWaterAt: string;
  readonly laneState: "available" | "held" | "quarantined";
  readonly laneRequestId?: string;
  readonly revision: number;
}
export interface RunEvaluationQaBatchV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly namespaceId: string;
  readonly configSnapshotRef: string;
  readonly configArtifactSha256: string;
  readonly configDigest: string;
  readonly createdAt: string;
}
export interface RunEvaluationQaArtifactPinsV1 {
  readonly suite: RunEvaluationArtifactPinV1;
  readonly case: RunEvaluationArtifactPinV1;
  readonly baseline: RunEvaluationArtifactPinV1;
  readonly candidate: RunEvaluationArtifactPinV1;
  readonly frozen: RunEvaluationArtifactPinV1;
}
export interface RunEvaluationQaEnrollmentV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly taskId: string;
  readonly batchId: string;
  readonly evaluationId: string;
  readonly evaluationKey: string;
  readonly artifactPins: RunEvaluationQaArtifactPinsV1;
  readonly frozenGraderDigest: string;
  /** Explicit Host review declaration; not an automatic de-identification proof. */
  readonly reviewRef: string;
  readonly createdAt: string;
}
export type RunEvaluationQaUsageV1 = {
  readonly state: "unknown";
} | {
  readonly state: "measured";
  readonly inputTokens: number;
  readonly outputTokens: number;
};
/** Trusted Host ingress data, verified by a private Daemon transport capability. */
export interface RunEvaluationQaTransportReceiptV1 {
  readonly transport: "owned_openai_chat_completions";
  readonly payloadSha256: string;
  readonly responseSha256: string;
  readonly responseStatus: 200;
  readonly modelId: string;
  readonly dispatchedAt: string;
  readonly receivedAt: string;
  readonly usage: RunEvaluationQaUsageV1;
}
export interface RunEvaluationQaRequestV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly namespaceId: string;
  readonly batchId: string;
  readonly enrollmentId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly requestDigest: string;
  readonly executionScopeDigest: string;
  readonly payloadSha256: string;
  readonly payloadBytes: number;
  readonly estimatedInputTokens: number;
  readonly outputTokenLimit: 1024;
  readonly state: "admitted" | "completed" | "unknown";
  readonly usage: RunEvaluationQaUsageV1;
  readonly receipt?: RunEvaluationQaTransportReceiptV1;
  readonly chargedAt: string;
  readonly processBootEpoch: string;
  readonly revision: number;
  readonly completedAt?: string;
  readonly releasedAt?: string;
  readonly releaseKind?: "host_callback_drained" | "host_explicit_reconciliation";
  readonly reconciliationAuditRef?: string;
}
