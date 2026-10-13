import type { SQLOutputValue } from "node:sqlite";
import type { RunEvaluationQaScopeV1, RunEvaluationQaBatchV1, RunEvaluationQaEnrollmentV1, RunEvaluationQaRequestV1 } from "@ling-stack/contracts";
type Row = Record<string, SQLOutputValue>;
export function mapQaScope(row: Row): RunEvaluationQaScopeV1 {
  return { schemaVersion: 1, namespaceId: row.id as string, canonicalWorkspaceCwd: row.canonical_cwd as string, batchRequestLimit: 3, rollingRequestLimit: 12, rollingWindowMs: 86400000, clockHighWaterAt: row.clock_high_water_at as string, laneState: row.lane_state as RunEvaluationQaScopeV1["laneState"], ...(row.lane_request_id === null ? {} : { laneRequestId: row.lane_request_id as string }), revision: row.revision as number };
}
export function mapQaBatch(row: Row): RunEvaluationQaBatchV1 {
  return { schemaVersion: 1, id: row.id as string, namespaceId: row.namespace_id as string, configSnapshotRef: row.config_snapshot_ref as string, configArtifactSha256: row.config_artifact_sha as string, configDigest: row.config_digest as string, createdAt: row.created_at as string };
}
export function mapQaEnrollment(row: Row): RunEvaluationQaEnrollmentV1 {
  return { schemaVersion: 1, id: row.id as string, taskId: row.task_id as string, batchId: row.batch_id as string, evaluationId: row.evaluation_id as string, evaluationKey: row.evaluation_key as string, artifactPins: JSON.parse(row.pins_json as string) as RunEvaluationQaEnrollmentV1["artifactPins"], frozenGraderDigest: row.frozen_digest as string, reviewRef: row.review_ref as string, createdAt: row.created_at as string };
}
export function mapQaRequest(row: Row): RunEvaluationQaRequestV1 {
  return { schemaVersion: 1, id: row.id as string, namespaceId: row.namespace_id as string, batchId: row.batch_id as string, enrollmentId: row.enrollment_id as string, taskId: row.task_id as string, attemptId: row.attempt_id as string, invocationId: row.invocation_id as string, requestDigest: row.request_digest as string, executionScopeDigest: row.scope_digest as string, payloadSha256: row.payload_sha as string, payloadBytes: row.payload_bytes as number, estimatedInputTokens: row.estimated_input_tokens as number, outputTokenLimit: 1024, state: row.state as RunEvaluationQaRequestV1["state"], usage: JSON.parse(row.usage_json as string) as RunEvaluationQaRequestV1["usage"], chargedAt: row.charged_at as string, processBootEpoch: row.boot_epoch as string, revision: row.revision as number,
    ...(row.receipt_json === null ? {} : { receipt: JSON.parse(row.receipt_json as string) as NonNullable<RunEvaluationQaRequestV1["receipt"]> }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at as string }),
    ...(row.released_at === null ? {} : { releasedAt: row.released_at as string, releaseKind: row.release_kind as NonNullable<RunEvaluationQaRequestV1["releaseKind"]> }),
    ...(row.reconciliation_audit_ref === null ? {} : { reconciliationAuditRef: row.reconciliation_audit_ref as string }),
  };
}
