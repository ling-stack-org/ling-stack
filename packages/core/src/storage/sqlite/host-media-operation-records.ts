import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isHostMediaEffectKind, isHostMediaProtocol } from "@ling-stack/contracts";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import type { HostMediaExecutionRecord, HostMediaEffectRecord } from "../../host-media-operation-types.js";
import {
  assertHostOperationLineage, hostOperationFailure, hostOperationTimestamp, readHostOperation, sameHostOperationSource,
} from "./host-operation-journal-evidence.js";

export const mediaFactFailure = (code: string): never => hostOperationFailure(code);
export const mediaFactText = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,512}$/u.test(value);
export const mediaFactDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

/** Mutable child binding and revision do not change the original prepared identity. */
export function hostMediaExecutionIdentity(row: HostMediaExecutionRecord): Omit<HostMediaExecutionRecord,
  "identityDigest" | "revision" | "childFence" | "childBoundAt" | "submissionArtifactId" | "terminalArtifactId"
  | "manifestArtifactId" | "finalizationArtifactId"> {
  const { identityDigest: _digest, revision: _revision, childFence: _child, childBoundAt: _boundAt,
    submissionArtifactId: _submission, terminalArtifactId: _terminal, manifestArtifactId: _manifest,
    finalizationArtifactId: _finalization, ...identity } = row;
  return identity;
}

/** The prepared artifact cannot contain its own digest or mutable dispatch/cache fields. */
export function hostMediaPreparedPayload(row: HostMediaExecutionRecord): Record<string, unknown> {
  return { schemaVersion: 1, executionId: row.executionId, mediaJobId: row.mediaJobId,
    mediaChildWorkUnitId: row.mediaChildWorkUnitId, executionGenerationId: row.executionGenerationId,
    source: row.source, toolCallId: row.toolCallId, protocol: row.protocol, adapterId: row.adapterId,
    toolName: row.toolName, operation: row.operation, intentDigest: row.intentDigest,
    targetDigest: row.targetDigest, namespaceDigest: row.namespaceDigest };
}

export function readHostMediaExecution(database: DatabaseSync, id: string): HostMediaExecutionRecord | undefined {
  const row = database.prepare("SELECT * FROM host_media_executions WHERE execution_id=?").get(id);
  if (!row) return undefined;
  const result = mapExecution(row);
  validateHostMediaExecution(database, result);
  return result;
}

/** Independent read verification never mints a live ticket or derives identity from the current owner. */
export function validateHostMediaExecution(database: DatabaseSync, row: HostMediaExecutionRecord): void {
  const invalid = (): never => mediaFactFailure("host_media_evidence_invalid");
  assertHostOperationLineage(database, row.source);
  if (digestHarnessToolValue(hostMediaExecutionIdentity(row)) !== row.identityDigest) return invalid();
  const parent = readHostOperation(database, row.parentOperationId), transport = readHostOperation(database, row.transportOperationId);
  if (!parent || !transport || parent.kind !== "media" || transport.kind !== "media"
    || parent.parentOperationId || transport.parentOperationId !== parent.operationId
    || transport.producerId !== "media-http-chain" || parent.toolCallId !== row.toolCallId || transport.toolCallId !== row.toolCallId
    || !sameHostOperationSource(parent.source, row.source) || !sameHostOperationSource(transport.source, row.source)
    || hostOperationTimestamp(row.preparedAt) < hostOperationTimestamp(transport.admittedAt)) return invalid();
  const child = database.prepare("SELECT * FROM work_units WHERE id=?").get(row.mediaChildWorkUnitId);
  const job = database.prepare("SELECT * FROM media_jobs WHERE id=?").get(row.mediaJobId);
  const request = parseRecord(child?.request_json);
  const admission = record(request?.executionAdmission) ? request.executionAdmission : undefined;
  if (!job || job.workspace_id !== row.workspaceId || job.operation !== row.operation || !child
    || child.workspace_id !== row.workspaceId || child.kind !== "media_job" || child.owner_type !== "conversation_run"
    || child.owner_id !== row.source.runId || child.linked_run_id !== row.source.runId || child.linked_media_job_id !== row.mediaJobId
    || request?.source !== "conversation_media_tool" || request.mediaJobId !== row.mediaJobId || request.toolCallId !== row.toolCallId
    || request.operation !== row.operation || !admission || admission.schemaVersion !== 1
    || admission.requestDigest !== row.intentDigest || !record(admission.source)
    || digestHarnessToolValue(admission.source) !== digestHarnessToolValue(row.source)
    || digestHarnessToolValue(request.target) !== row.targetDigest) return invalid();
  const prepared = database.prepare("SELECT * FROM artifacts WHERE id=?").get(row.preparedRequestArtifactId);
  const payload = parseRecord(prepared?.sealed_payload_json);
  if (!prepared || prepared.run_id !== row.source.runId || prepared.media_job_id !== null || prepared.type !== "json"
    || !payload || !mediaFactDigest(prepared.content_sha256) || prepared.content_sha256 !== row.preparedRequestDigest
    || createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex") !== row.preparedRequestDigest
    || digestHarnessToolValue(payload) !== digestHarnessToolValue(hostMediaPreparedPayload(row))
    || hostOperationTimestamp(prepared.created_at) > hostOperationTimestamp(row.preparedAt)
    || hostOperationTimestamp(prepared.created_at) < hostOperationTimestamp(parent.admittedAt)) return invalid();
  if (row.childFence) {
    const bound = database.prepare("SELECT * FROM work_unit_attempts WHERE id=?").get(row.childFence.attemptId);
    if (!bound || bound.work_unit_id !== row.mediaChildWorkUnitId || bound.runtime_instance_id !== row.childFence.runtimeInstanceId
      || bound.fencing_token !== row.childFence.fencingToken || row.childFence.workUnitId !== row.mediaChildWorkUnitId
      || hostOperationTimestamp(row.childBoundAt) < hostOperationTimestamp(row.preparedAt)
      || hostOperationTimestamp(bound.created_at) > hostOperationTimestamp(row.childBoundAt)) return invalid();
  }
}

export function readHostMediaEffects(database: DatabaseSync, execution: HostMediaExecutionRecord): HostMediaEffectRecord[] {
  const effects = database.prepare("SELECT * FROM host_media_effects WHERE execution_id=? ORDER BY ordinal,effect_id")
    .all(execution.executionId).map(mapEffect);
  for (const [ordinal, effect] of effects.entries()) {
    if (effect.ordinal !== ordinal || hostOperationTimestamp(effect.preparedAt) < hostOperationTimestamp(execution.childBoundAt)
      || !hostMediaEffectMatchesProtocol(execution.protocol, effect.kind)) return mediaFactFailure("host_media_evidence_invalid");
  }
  return effects;
}

export function hostMediaEffectMatchesProtocol(protocol: HostMediaExecutionRecord["protocol"], kind: HostMediaEffectRecord["kind"]): boolean {
  return protocol === "image_response_v1" ? kind === "image_request"
    : protocol === "seedance_task_v1" ? kind === "remote_generation_submit"
    : kind === "comfy_image_upload" || kind === "remote_generation_submit";
}

function mapExecution(row: Record<string, SQLOutputValue>): HostMediaExecutionRecord {
  const invalid = (): never => mediaFactFailure("host_media_record_corrupt");
  const names = ["execution_id", "workspace_id", "media_job_id", "media_child_work_unit_id", "execution_generation_id",
    "parent_operation_id", "transport_operation_id", "run_id", "work_unit_id", "attempt_id", "runtime_instance_id",
    "fencing_token", "tool_call_id", "adapter_id", "prepared_request_artifact_id"];
  if (row.schema_version !== 1 || names.some(key => !mediaFactText(row[key]))
    || !/^(0|[1-9][0-9]*)$/u.test(String(row.fencing_token)) || !isHostMediaProtocol(row.protocol)
    || !["image_generate", "image_edit", "video_generate"].includes(String(row.operation))
    || row.tool_name !== (row.operation === "video_generate" ? "video_generate" : "image_generate")
    || (row.protocol === "image_response_v1" && row.operation === "video_generate")
    || (row.protocol === "seedance_task_v1" && row.operation !== "video_generate")
    || ["intent_digest", "target_digest", "namespace_digest", "prepared_request_digest", "identity_digest"].some(key => !mediaFactDigest(row[key]))
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || row.parent_operation_id === row.transport_operation_id) return invalid();
  hostOperationTimestamp(row.prepared_at);
  if (["submission_artifact_id", "terminal_artifact_id", "manifest_artifact_id", "finalization_artifact_id"]
    .some(key => row[key] != null && !mediaFactText(row[key]))) return invalid();
  const childValues = [row.child_attempt_id, row.child_runtime_instance_id, row.child_fencing_token, row.child_bound_at];
  if (childValues.some(value => value !== null) && (childValues.some(value => value === null)
    || !mediaFactText(row.child_attempt_id) || !mediaFactText(row.child_runtime_instance_id)
    || !mediaFactText(row.child_fencing_token) || !/^(0|[1-9][0-9]*)$/u.test(String(row.child_fencing_token)))) return invalid();
  const result: HostMediaExecutionRecord = {
    schemaVersion: 1, executionId: String(row.execution_id), workspaceId: String(row.workspace_id),
    mediaJobId: String(row.media_job_id), mediaChildWorkUnitId: String(row.media_child_work_unit_id),
    executionGenerationId: String(row.execution_generation_id), parentOperationId: String(row.parent_operation_id),
    transportOperationId: String(row.transport_operation_id), source: { runId: String(row.run_id), workUnitId: String(row.work_unit_id),
      attemptId: String(row.attempt_id), runtimeInstanceId: String(row.runtime_instance_id), fencingToken: String(row.fencing_token) },
    toolCallId: String(row.tool_call_id), toolName: row.tool_name as HostMediaExecutionRecord["toolName"],
    operation: row.operation as HostMediaExecutionRecord["operation"], protocol: row.protocol, adapterId: String(row.adapter_id),
    intentDigest: String(row.intent_digest), targetDigest: String(row.target_digest), namespaceDigest: String(row.namespace_digest),
    preparedRequestArtifactId: String(row.prepared_request_artifact_id), preparedRequestDigest: String(row.prepared_request_digest),
    preparedAt: String(row.prepared_at), identityDigest: String(row.identity_digest), revision: Number(row.revision),
    ...(row.child_attempt_id === null ? {} : { childFence: { workUnitId: String(row.media_child_work_unit_id),
      attemptId: String(row.child_attempt_id), runtimeInstanceId: String(row.child_runtime_instance_id), fencingToken: String(row.child_fencing_token) },
      childBoundAt: String(row.child_bound_at) }),
    ...(row.submission_artifact_id == null ? {} : { submissionArtifactId: String(row.submission_artifact_id) }),
    ...(row.terminal_artifact_id == null ? {} : { terminalArtifactId: String(row.terminal_artifact_id) }),
    ...(row.manifest_artifact_id == null ? {} : { manifestArtifactId: String(row.manifest_artifact_id) }),
    ...(row.finalization_artifact_id == null ? {} : { finalizationArtifactId: String(row.finalization_artifact_id) }),
  };
  return result;
}

function mapEffect(row: Record<string, SQLOutputValue>): HostMediaEffectRecord {
  if (row.schema_version !== 1 || !mediaFactText(row.effect_id) || !mediaFactText(row.execution_id)
    || !isHostMediaEffectKind(row.kind) || row.method !== "POST" || !Number.isSafeInteger(row.ordinal) || Number(row.ordinal) < 0
    || !mediaFactDigest(row.route_digest) || !mediaFactDigest(row.wire_digest)
    || (row.response_artifact_id != null && !mediaFactText(row.response_artifact_id))
    || (row.no_start_artifact_id != null && !mediaFactText(row.no_start_artifact_id))
    || (row.response_artifact_id != null && row.no_start_artifact_id != null)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) return mediaFactFailure("host_media_record_corrupt");
  const preparedAt = hostOperationTimestamp(row.prepared_at);
  if (row.launched_at !== null && hostOperationTimestamp(row.launched_at) < preparedAt) return mediaFactFailure("host_media_record_corrupt");
  return { schemaVersion: 1, executionId: row.execution_id, effectId: row.effect_id, ordinal: Number(row.ordinal),
    kind: row.kind, method: "POST", routeDigest: row.route_digest, wireDigest: row.wire_digest,
    preparedAt: String(row.prepared_at), revision: Number(row.revision),
    ...(row.launched_at === null ? {} : { launchedAt: String(row.launched_at) }),
    ...(row.response_artifact_id == null ? {} : { responseArtifactId: String(row.response_artifact_id) }),
    ...(row.no_start_artifact_id == null ? {} : { noStartArtifactId: String(row.no_start_artifact_id) }) };
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  const parsed: unknown = JSON.parse(value);
  return record(parsed) ? parsed : undefined;
}
