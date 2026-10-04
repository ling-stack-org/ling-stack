import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isHostCommandPreparedV1, isHostCommandSettledV1 } from "@ling-stack/contracts";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import {
  HostOperationJournalError, type HostOperationEvidenceRef, type HostOperationRecord, type HostOperationSource,
} from "../../host-operation-journal-types.js";
import { hostMediaOperationDomainIdentity, verifyHostMediaReceipt } from "./host-media-receipt-evidence.js";
import { hostOfficeOperationDomainIdentity, verifyHostOfficeReceipt } from "./host-office-local-journal-evidence.js";

export interface StoredHostOperation extends HostOperationRecord {
  readonly domainIdentityDigest?: string;
  readonly settlementSignature?: string;
}
export const hostOperationFailure = (code: string): never => { throw new HostOperationJournalError(code); };
export const hostOperationText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const kinds = new Set(["command", "file_mutation", "mcp", "plugin", "media", "host_capability",
  "approval", "permission", "approval_review", "hydration", "sdk_tool", "cleanup"]);

export function hostOperationTimestamp(value: unknown): number {
  if (!hostOperationText(value)) return hostOperationFailure("host_operation_invalid_timestamp");
  const at = Date.parse(value);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value) return hostOperationFailure("host_operation_invalid_timestamp");
  return at;
}
export function sameHostOperationSource(left: HostOperationSource, right: HostOperationSource): boolean {
  return left.runId === right.runId && left.workUnitId === right.workUnitId && left.attemptId === right.attemptId
    && left.runtimeInstanceId === right.runtimeInstanceId && left.fencingToken === right.fencingToken;
}
export function assertHostOperationLineage(database: DatabaseSync, source: HostOperationSource): void {
  if (!source || ![source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken].every(hostOperationText)) {
    return hostOperationFailure("host_operation_invalid_source");
  }
  const row = database.prepare(`SELECT run.work_unit_id, attempt.work_unit_id AS attempt_unit_id,
    attempt.runtime_instance_id,attempt.fencing_token FROM run_sessions run
    JOIN work_unit_attempts attempt ON attempt.id=? WHERE run.id=?`).get(source.attemptId, source.runId);
  if (!row || row.work_unit_id !== source.workUnitId || row.attempt_unit_id !== source.workUnitId
    || row.runtime_instance_id !== source.runtimeInstanceId || row.fencing_token !== source.fencingToken) {
    return hostOperationFailure("host_operation_invalid_source");
  }
}

export function readHostOperation(database: DatabaseSync, id: string): StoredHostOperation | undefined {
  const row = database.prepare("SELECT * FROM host_operations WHERE operation_id=?").get(id);
  return row ? mapHostOperation(row) : undefined;
}
export function readSourceHostOperations(database: DatabaseSync, source: HostOperationSource): StoredHostOperation[] {
  assertHostOperationLineage(database, source);
  return database.prepare("SELECT * FROM host_operations WHERE run_id=? OR attempt_id=? ORDER BY admitted_at,operation_id")
    .all(source.runId, source.attemptId).map(row => {
      const operation = mapHostOperation(row);
      if (!sameHostOperationSource(operation.source, source)) return hostOperationFailure("host_operation_invalid_source");
      return operation;
    });
}
function mapHostOperation(row: Record<string, SQLOutputValue>): StoredHostOperation {
  const invalid = (): never => hostOperationFailure("host_operation_journal_corrupt");
  if (row.schema_version !== 1 || ![row.operation_id,row.run_id,row.work_unit_id,row.attempt_id,
    row.runtime_instance_id,row.fencing_token,row.tool_call_id].every(hostOperationText)
    || !kinds.has(String(row.kind)) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || !["admitted","launched","safe","unknown_outcome"].includes(String(row.phase))) return invalid();
  if ((row.parent_operation_id === null) !== (row.producer_id === null)
    || (row.parent_operation_id !== null && (!hostOperationText(row.parent_operation_id) || !hostOperationText(row.producer_id)))) return invalid();
  const admittedAt = hostOperationTimestamp(row.admitted_at);
  if (row.launched_at !== null && hostOperationTimestamp(row.launched_at) < admittedAt) return invalid();
  if (row.phase === "launched" && row.launched_at === null) return invalid();
  if (row.evidence_id === null) {
    if (row.evidence_kind !== null || row.domain_identity_digest !== null) return invalid();
  } else if (!hostOperationText(row.evidence_id) || !["harness_tool_execution","host_command", "media_chain_execution", "media_transport_execution",
    "office_local_chain_execution", "office_local_binary_execution"].includes(String(row.evidence_kind))
    || !digest(row.domain_identity_digest)) return invalid();
  if (["safe","unknown_outcome"].includes(String(row.phase))) {
    const settledAt = hostOperationTimestamp(row.settled_at);
    if (settledAt < admittedAt || (row.launched_at !== null && settledAt < hostOperationTimestamp(row.launched_at))
      || !hostOperationText(row.settlement_signature)) return invalid();
    if (row.phase === "safe" && (!digest(row.evidence_digest) || row.code !== null
      || !["known_no_start", "file_completed", "media_response_completed", "media_remote_terminal", "media_chain_completed",
        "office_local_chain_completed", "office_local_binary_completed"].includes(String(row.settlement_kind))
      || (row.settlement_kind === "known_no_start" && row.launched_at !== null)
      || (row.settlement_kind !== "known_no_start" && row.launched_at === null))) return invalid();
    if (row.phase === "unknown_outcome" && (row.settlement_kind !== "unknown_outcome" || !hostOperationText(row.code))) return invalid();
  } else if ([row.settled_at,row.settlement_kind,row.evidence_digest,row.settlement_signature,row.code].some(value => value !== null)) return invalid();
  return {
    schemaVersion: 1, operationId: String(row.operation_id), source: { runId: String(row.run_id),
      workUnitId: String(row.work_unit_id), attemptId: String(row.attempt_id), runtimeInstanceId: String(row.runtime_instance_id),
      fencingToken: String(row.fencing_token) }, kind: row.kind as HostOperationRecord["kind"], toolCallId: String(row.tool_call_id),
    ...(row.parent_operation_id === null ? {} : { parentOperationId: String(row.parent_operation_id), producerId: String(row.producer_id) }),
    phase: row.phase as HostOperationRecord["phase"], admittedAt: String(row.admitted_at), revision: Number(row.revision),
    ...(row.launched_at === null ? {} : { launchedAt: String(row.launched_at) }),
    ...(row.settled_at === null ? {} : { settledAt: String(row.settled_at), settlementKind: row.settlement_kind as HostOperationRecord["settlementKind"] }),
    ...(row.evidence_id === null ? {} : { evidenceRef: { kind: row.evidence_kind as HostOperationEvidenceRef["kind"], id: String(row.evidence_id) },
      domainIdentityDigest: String(row.domain_identity_digest) }),
    ...(row.evidence_digest === null ? {} : { evidenceDigest: String(row.evidence_digest) }),
    ...(row.code === null ? {} : { code: String(row.code) }),
    ...(row.settlement_signature === null ? {} : { settlementSignature: String(row.settlement_signature) }),
  };
}

/** Validates exact domain identity while binding, before any physical file effect can start. */
export function hostOperationDomainIdentity(database: DatabaseSync, operation: HostOperationRecord,
  evidence: HostOperationEvidenceRef, binding: boolean): string {
  if (!evidence || !hostOperationText(evidence.id)) return hostOperationFailure("host_operation_evidence_invalid");
  if (evidence.kind === "media_chain_execution" || evidence.kind === "media_transport_execution") {
    return hostMediaOperationDomainIdentity(database, { ...operation, evidenceRef: evidence }, binding);
  }
  if (evidence.kind === "office_local_chain_execution" || evidence.kind === "office_local_binary_execution") {
    return hostOfficeOperationDomainIdentity(database, { ...operation, evidenceRef: evidence }, binding);
  }
  if (evidence.kind === "host_command" && operation.kind === "command") {
    const rows = database.prepare(`SELECT run_id,ts,data_json FROM run_events WHERE type='host_command_prepared'
      AND json_extract(data_json,'$.executionId')=?`).all(evidence.id);
    if (rows.length !== 1) return hostOperationFailure("host_operation_evidence_invalid");
    const data: unknown = JSON.parse(String(rows[0]!.data_json));
    if (!isHostCommandPreparedV1(data) || rows[0]!.run_id !== operation.source.runId
      || !sameHostOperationSource({ runId: String(rows[0]!.run_id), ...data.source }, operation.source)
      || data.toolCallId !== operation.toolCallId || hostOperationTimestamp(rows[0]!.ts) < hostOperationTimestamp(operation.admittedAt)) {
      return hostOperationFailure("host_operation_evidence_invalid");
    }
    if (binding && database.prepare(`SELECT 1 FROM run_events WHERE type='host_command_settled'
      AND json_extract(data_json,'$.executionId')=? LIMIT 1`).get(evidence.id)) return hostOperationFailure("host_operation_evidence_already_started");
    return digestHarnessToolValue({ runId: rows[0]!.run_id, ts: rows[0]!.ts, prepared: data });
  }
  if (evidence.kind !== "harness_tool_execution" || operation.kind !== "file_mutation") {
    return hostOperationFailure("host_operation_evidence_invalid");
  }
  const row = readFileExecution(database, operation, evidence.id);
  if (binding && row.execution_started_at !== null) return hostOperationFailure("host_operation_evidence_already_started");
  const policy = sealedArtifact(database, String(row.policy_snapshot_artifact_id), operation.source.runId);
  if (policy.payload.schemaVersion !== 1 || policy.payload.runId !== operation.source.runId
    || policy.payload.attemptId !== operation.source.attemptId || policy.payload.toolCallId !== operation.toolCallId
    || policy.payload.executorKind !== row.executor_kind || policy.payload.requestDigest !== row.request_digest
    || policy.payload.sideEffectFingerprint !== row.side_effect_fingerprint || !record(policy.payload.effectivePolicySnapshot)
    || hostOperationTimestamp(policy.createdAt) > hostOperationTimestamp(row.created_at)) return hostOperationFailure("host_operation_evidence_invalid");
  return digestHarnessToolValue({ id: row.id, runId: row.run_id, workUnitId: row.work_unit_id,
    attemptId: row.attempt_id, toolCallId: row.tool_call_id, toolName: row.tool_name, executorKind: row.executor_kind,
    requestDigest: row.request_digest, sideEffectFingerprint: row.side_effect_fingerprint,
    policySnapshotArtifactId: row.policy_snapshot_artifact_id, policyDigest: policy.hash, createdAt: row.created_at });
}

/** Rechecks immutable lineage, evidence and all reserved producers, including after restart. */
export function verifyHostOperationSafe(database: DatabaseSync, operation: StoredHostOperation,
  stoppedAt = operation.settledAt, depth = 0): string {
  if (depth > 128 || !stoppedAt || !operation.settledAt || operation.phase !== "safe"
    || hostOperationTimestamp(operation.settledAt) > hostOperationTimestamp(stoppedAt)) return hostOperationFailure("host_operation_evidence_invalid");
  assertHostOperationLineage(database, operation.source);
  const children = database.prepare("SELECT * FROM host_operations WHERE parent_operation_id=? ORDER BY operation_id")
    .all(operation.operationId).map(mapHostOperation);
  const childDigests = children.map(child => {
    if (!sameHostOperationSource(child.source, operation.source) || child.toolCallId !== operation.toolCallId
      || (operation.settlementKind === "known_no_start" && child.settlementKind !== "known_no_start")) {
      return hostOperationFailure("host_operation_evidence_invalid");
    }
    const value = verifyHostOperationSafe(database, child, operation.settledAt, depth + 1);
    if (value !== child.evidenceDigest) return hostOperationFailure("host_operation_evidence_invalid");
    return { operationId: child.operationId, digest: value };
  });
  let domainDigest: string | undefined;
  if (operation.evidenceRef) {
    if (hostOperationDomainIdentity(database, operation, operation.evidenceRef, false) !== operation.domainIdentityDigest) {
      return hostOperationFailure("host_operation_evidence_invalid");
    }
    domainDigest = operation.evidenceRef.kind === "media_chain_execution" || operation.evidenceRef.kind === "media_transport_execution"
      ? verifyHostMediaReceipt(database, operation)
      : operation.evidenceRef.kind === "office_local_chain_execution" || operation.evidenceRef.kind === "office_local_binary_execution"
      ? verifyHostOfficeReceipt(database, operation)
      : operation.evidenceRef.kind === "harness_tool_execution"
      ? verifyFileTerminal(database, operation, operation.settlementKind === "known_no_start")
      : verifyCommandNoStart(database, operation);
  }
  if (operation.settlementKind === "file_completed" && (!operation.launchedAt || !operation.evidenceRef
    || operation.evidenceRef.kind !== "harness_tool_execution")) return hostOperationFailure("host_operation_evidence_invalid");
  if (operation.settlementKind === "known_no_start" && operation.launchedAt) return hostOperationFailure("host_operation_evidence_invalid");
  if (operation.settlementKind?.startsWith("media_") && (operation.kind !== "media" || !operation.evidenceRef
    || !["media_chain_execution", "media_transport_execution"].includes(operation.evidenceRef.kind))) return hostOperationFailure("host_operation_evidence_invalid");
  if (operation.settlementKind?.startsWith("office_local_") && (!operation.launchedAt || !operation.evidenceRef
    || !["office_local_chain_execution", "office_local_binary_execution"].includes(operation.evidenceRef.kind))) {
    return hostOperationFailure("host_operation_evidence_invalid");
  }
  return digestHarnessToolValue({ source: operation.source, operationId: operation.operationId, kind: operation.settlementKind,
    admittedAt: operation.admittedAt, launchedAt: operation.launchedAt, settledAt: operation.settledAt,
    domainDigest, childDigests });
}

function readFileExecution(database: DatabaseSync, operation: HostOperationRecord, id: string): Record<string, SQLOutputValue> {
  const row = database.prepare(`SELECT execution.*,attempt.runtime_instance_id,attempt.fencing_token
    FROM harness_tool_executions execution JOIN work_unit_attempts attempt ON attempt.id=execution.attempt_id
    WHERE execution.id=?`).get(id);
  if (!row || row.schema_version !== 1 || !sameHostOperationSource({ runId: String(row.run_id), workUnitId: String(row.work_unit_id),
    attemptId: String(row.attempt_id), runtimeInstanceId: String(row.runtime_instance_id), fencingToken: String(row.fencing_token) }, operation.source)
    || row.tool_call_id !== operation.toolCallId || !["write","apply_patch"].includes(String(row.executor_kind))
    // Native whole-file edit uses `write`; an explicit patch edit uses
    // `apply_patch`. Preserve the model-facing edit identity in both cases.
    || !((row.tool_name === "write" && row.executor_kind === "write")
      || (row.tool_name === "write" && row.executor_kind === "apply_patch")
      || (row.tool_name === "apply_patch" && row.executor_kind === "apply_patch")
      || (row.tool_name === "edit" && row.executor_kind === "write")
      || (row.tool_name === "edit" && row.executor_kind === "apply_patch"))
    || !digest(row.request_digest) || !digest(row.side_effect_fingerprint)
    || hostOperationTimestamp(row.created_at) < hostOperationTimestamp(operation.admittedAt)) return hostOperationFailure("host_operation_evidence_invalid");
  return row;
}
function verifyFileTerminal(database: DatabaseSync, operation: HostOperationRecord, noStart: boolean): string {
  const row = readFileExecution(database, operation, operation.evidenceRef!.id);
  const finishedAt = hostOperationTimestamp(row.execution_finished_at);
  if (!["succeeded","failed","cancelled","denied","superseded"].includes(String(row.state))
    || finishedAt > hostOperationTimestamp(operation.settledAt) || finishedAt < hostOperationTimestamp(row.created_at)
    || hostOperationTimestamp(row.updated_at) < finishedAt) return hostOperationFailure("host_operation_evidence_invalid");
  if (noStart) {
    if (row.execution_started_at !== null || row.state === "succeeded") return hostOperationFailure("host_operation_evidence_invalid");
    return digestHarnessToolValue({ id: row.id, state: row.state, finishedAt: row.execution_finished_at, noStart: true });
  }
  const startedAt = hostOperationTimestamp(row.execution_started_at);
  if (!operation.launchedAt || startedAt < hostOperationTimestamp(row.created_at)
    || startedAt > hostOperationTimestamp(operation.launchedAt) || finishedAt < hostOperationTimestamp(operation.launchedAt)
    || !digest(row.result_digest)) return hostOperationFailure("host_operation_evidence_invalid");
  const summary = parseRecord(row.result_summary_json);
  if (!summary || digestHarnessToolValue(summary) !== row.result_digest || !["applied","not_applied","rolled_back"].includes(String(summary.outcome))
    || !hostOperationText(summary.status) || !Array.isArray(summary.touchedPaths) || !summary.touchedPaths.every(hostOperationText)
    || !Number.isSafeInteger(summary.artifactCount) || typeof summary.cancelled !== "boolean"
    || (summary.outcome === "applied" ? row.state !== "succeeded" : !["failed","cancelled"].includes(String(row.state)))) {
    return hostOperationFailure("host_operation_evidence_invalid");
  }
  const links = database.prepare(`SELECT artifact.id,artifact.path,artifact.sealed_payload_json FROM harness_tool_execution_artifacts link
    JOIN artifacts artifact ON artifact.id=link.artifact_id WHERE link.execution_id=? ORDER BY link.ordinal`).all(row.id!);
  if (links.length !== summary.artifactCount || links.length === 0) return hostOperationFailure("host_operation_evidence_invalid");
  const resultDigests: { id: string; hash: string }[] = [];
  let hasResult = false;
  for (const linked of links) {
    if (linked.sealed_payload_json === null) continue; // Unsealed approval previews are not result proof.
    const artifact = sealedArtifact(database, String(linked.id), operation.source.runId);
    resultDigests.push({ id: String(linked.id), hash: artifact.hash });
    if (!/(?:\/result\.json|\/patch-result\.json)$/.test(String(linked.path))) continue;
    const outcome = artifact.payload.outcome ?? (artifact.payload.status === "applied" ? "applied" : undefined);
    if (outcome !== summary.outcome || artifact.payload.status !== summary.status
      || artifact.payload.format !== "ling-apply-patch-v1" || !digest(artifact.payload.rawPatchSha256)
      || JSON.stringify(artifact.payload.touchedPaths) !== JSON.stringify(summary.touchedPaths)
      || hostOperationTimestamp(artifact.createdAt) < startedAt || hostOperationTimestamp(artifact.createdAt) > finishedAt) {
      return hostOperationFailure("host_operation_evidence_invalid");
    }
    hasResult = true;
  }
  if (!hasResult) return hostOperationFailure("host_operation_evidence_invalid");
  return digestHarnessToolValue({ id: row.id, state: row.state, resultDigest: row.result_digest,
    startedAt: row.execution_started_at, finishedAt: row.execution_finished_at, artifactDigests: resultDigests });
}
function verifyCommandNoStart(database: DatabaseSync, operation: HostOperationRecord): string {
  if (operation.settlementKind !== "known_no_start" || operation.launchedAt) return hostOperationFailure("host_operation_evidence_invalid");
  const rows = database.prepare(`SELECT run_id,ts,data_json FROM run_events WHERE type='host_command_settled'
    AND json_extract(data_json,'$.executionId')=?`).all(operation.evidenceRef!.id);
  if (rows.length !== 1) return hostOperationFailure("host_operation_evidence_invalid");
  const data: unknown = JSON.parse(String(rows[0]!.data_json));
  if (!isHostCommandSettledV1(data) || data.outcome !== "not_started" || !data.ownerCurrent
    || rows[0]!.run_id !== operation.source.runId || hostOperationTimestamp(rows[0]!.ts) > hostOperationTimestamp(operation.settledAt)) {
    return hostOperationFailure("host_operation_evidence_invalid");
  }
  return digestHarnessToolValue({ runId: rows[0]!.run_id, ts: rows[0]!.ts, settled: data });
}
function sealedArtifact(database: DatabaseSync, id: string, runId: string): { payload: Record<string, unknown>; hash: string; createdAt: string } {
  const row = database.prepare("SELECT run_id,sealed_payload_json,content_sha256,created_at FROM artifacts WHERE id=?").get(id);
  const payload = parseRecord(row?.sealed_payload_json);
  if (!row || row.run_id !== runId || !payload || !digest(row.content_sha256)
    || createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex") !== row.content_sha256) {
    return hostOperationFailure("host_operation_evidence_invalid");
  }
  hostOperationTimestamp(row.created_at);
  return { payload, hash: row.content_sha256, createdAt: String(row.created_at) };
}
function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (!hostOperationText(value)) return undefined;
  const parsed: unknown = JSON.parse(value);
  return record(parsed) ? parsed : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
