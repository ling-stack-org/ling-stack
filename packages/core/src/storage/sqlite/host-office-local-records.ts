import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { HOST_OFFICE_LOCAL_PROTOCOL, type HostOfficeFileIdentity, type HostOfficeLocalPrepared,
  type HostOfficeLocalExecutionRecord, type HostOfficeLocalEffectRecord, type HostOfficeLocalEffectObservation,
  type PrepareHostOfficeLocalEffect } from "../../host-office-local-types.js";
import { assertHostOperationLineage, hostOperationFailure, hostOperationTimestamp, sameHostOperationSource,
  readHostOperation } from "./host-operation-journal-evidence.js";
import { validateOfficeLocalObservationPayload } from "./host-office-local-observations.js";

export const officeLocalFailure = (): never => hostOperationFailure("host_office_local_evidence_invalid");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const size = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const same = (left: unknown, right: unknown): boolean => digestHarnessToolValue(left) === digestHarnessToolValue(right);
function canonical(value: unknown): value is string { return text(value) && isAbsolute(value) && resolve(value) === value; }
function inside(root: string, path: string): boolean {
  const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function identity(value: unknown): value is HostOfficeFileIdentity {
  return object(value) && [value.device, value.inode, value.modifiedNs, value.changedNs]
    .every(v => typeof v === "string" && /^\d{1,40}$/.test(v)) && size(value.sizeBytes);
}
function snapshot(value: unknown, directory: boolean): boolean {
  if (!object(value)) return false;
  if (value.state === "absent") return Object.keys(value).length === 1;
  if (value.state === "directory") return directory && identity(value.identity);
  return !directory && value.state === "file" && identity(value.identity) && digest(value.bytesSha256)
    && size(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= 50 * 1024 * 1024
    && value.identity.sizeBytes === value.sizeBytes;
}

/** Read immutable JSON from SQLite, never reread current disk to guess historical bytes. */
export function readOfficeLocalSeal(database: DatabaseSync, artifactId: string, runId: string): {
  readonly payload: Record<string, unknown>; readonly hash: string; readonly createdAt: string;
} {
  const row = database.prepare("SELECT * FROM artifacts WHERE id=?").get(artifactId);
  let payload: unknown;
  try { payload = JSON.parse(String(row?.sealed_payload_json)); } catch { return officeLocalFailure(); }
  if (!row || row.run_id !== runId || row.media_job_id !== null || row.type !== "json"
    || !object(payload) || !digest(row.content_sha256)
    || createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex") !== row.content_sha256) return officeLocalFailure();
  hostOperationTimestamp(row.created_at);
  return { payload, hash: row.content_sha256, createdAt: String(row.created_at) };
}

export function validateOfficeLocalPrepared(value: unknown): HostOfficeLocalPrepared {
  if (!object(value) || value.schemaVersion !== 1 || value.protocol !== HOST_OFFICE_LOCAL_PROTOCOL
    || ![value.executionId, value.parentOperationId, value.producerOperationId, value.toolCallId].every(text)
    || value.parentOperationId === value.producerOperationId || !object(value.source)
    || ![value.source.runId,value.source.workUnitId,value.source.attemptId,value.source.runtimeInstanceId,value.source.fencingToken].every(text)
    || !canonical(value.workspacePath) || !canonical(value.targetPath) || !inside(value.workspacePath, value.targetPath)
    || typeof value.overwrite !== "boolean" || !digest(value.requestDigest) || !digest(value.policyDigest)
    || !object(value.input) || !snapshot(value.input, false) || !object(value.output) || !digest(value.output.bytesSha256)
    || !size(value.output.sizeBytes) || value.output.sizeBytes === 0 || value.output.sizeBytes > 50 * 1024 * 1024
    || !Array.isArray(value.members) || value.members.length < 2 || value.members.length > 128) return officeLocalFailure();
  if (!text(value.toolName)) return officeLocalFailure();
  const expected = ({ office_create_workbook: "xlsx", office_edit_workbook: "xlsx", office_create_document: "docx",
    office_edit_document: "docx", office_create_presentation: "pptx", office_edit_presentation: "pptx" } as Record<string, string>)[String(value.toolName)];
  if (!expected || expected !== value.format || !value.targetPath.toLowerCase().endsWith(`.${expected}`)
    || (String(value.toolName).startsWith("office_edit_") && (value.input.state !== "file" || !value.overwrite))
    || (value.input.state === "file" && !value.overwrite)) return officeLocalFailure();
  const ids = new Set<string>(), paths = new Set<string>();
  let targets = 0, temps = 0, recoveries = 0;
  for (const member of value.members) {
    if (!object(member) || !text(member.memberId) || ids.has(member.memberId) || !canonical(member.path)
      || !inside(value.workspacePath, member.path) || paths.has(member.path)
      || !text(member.role) || !["target","temporary","recovery","directory"].includes(member.role)
      || !object(member.initial) || !snapshot(member.initial, member.role === "directory")) return officeLocalFailure();
    ids.add(member.memberId); paths.add(member.path);
    if (member.role === "target") {
      targets++; if (member.path !== value.targetPath || !same(member.initial, value.input)) return officeLocalFailure();
    } else if (member.role === "temporary") {
      temps++; if (member.initial.state !== "absent" || resolve(member.path, "..") !== resolve(value.targetPath, "..")) return officeLocalFailure();
    } else if (member.role === "recovery") {
      recoveries++; if (member.initial.state !== "absent" || value.input.state !== "file") return officeLocalFailure();
    }
  }
  if (targets !== 1 || temps !== 1 || recoveries !== (value.input.state === "file" ? 1 : 0)) return officeLocalFailure();
  for (const member of value.members.filter(member => member.role === "directory")) {
    if (!value.members.some(other => other.role !== "directory" && inside(member.path, other.path))) return officeLocalFailure();
  }
  hostOperationTimestamp(value.preparedAt);
  return value as unknown as HostOfficeLocalPrepared;
}

/** Source identity alone cannot lend another workspace its filesystem authority. */
export function assertOfficeLocalWorkspace(database: DatabaseSync, prepared: HostOfficeLocalPrepared): void {
  const run = database.prepare("SELECT cwd FROM run_sessions WHERE id=?").get(prepared.source.runId);
  // Do not realpath today's disk while verifying historical evidence. The fixed
  // tracked issuer accepts only the Run's already-canonical captured workspace.
  if (!run || typeof run.cwd !== "string" || resolve(run.cwd) !== prepared.workspacePath) return officeLocalFailure();
}

export function readOfficeLocalExecution(database: DatabaseSync, id: string): HostOfficeLocalExecutionRecord | undefined {
  const row = database.prepare("SELECT * FROM host_office_local_executions WHERE execution_id=?").get(id);
  if (!row) return undefined;
  const source = { runId: String(row.run_id), workUnitId: String(row.work_unit_id), attemptId: String(row.attempt_id),
    runtimeInstanceId: String(row.runtime_instance_id), fencingToken: String(row.fencing_token) };
  assertHostOperationLineage(database, source);
  const seal = readOfficeLocalSeal(database, String(row.prepared_artifact_id), source.runId), prepared = validateOfficeLocalPrepared(seal.payload);
  assertOfficeLocalWorkspace(database, prepared);
  const identityDigest = digestHarnessToolValue({ prepared, preparedArtifactId: row.prepared_artifact_id, preparedDigest: seal.hash });
  const parent = readHostOperation(database, prepared.parentOperationId), producer = readHostOperation(database, prepared.producerOperationId);
  if (row.schema_version !== 1 || row.protocol !== HOST_OFFICE_LOCAL_PROTOCOL || prepared.executionId !== id
    || !sameHostOperationSource(source, prepared.source) || prepared.parentOperationId !== row.parent_operation_id
    || prepared.producerOperationId !== row.producer_operation_id || prepared.toolCallId !== row.tool_call_id
    || prepared.toolName !== row.tool_name || prepared.preparedAt !== row.prepared_at || seal.hash !== row.prepared_digest
    || identityDigest !== row.identity_digest || !size(row.revision) || !parent || !producer
    || parent.kind !== "mcp" || parent.parentOperationId || producer.kind !== "file_mutation"
    || producer.parentOperationId !== parent.operationId || producer.producerId !== "office-local-binary"
    || parent.toolCallId !== prepared.toolCallId || producer.toolCallId !== prepared.toolCallId
    || !sameHostOperationSource(parent.source, source) || !sameHostOperationSource(producer.source, source)
    || hostOperationTimestamp(prepared.preparedAt) < Math.max(hostOperationTimestamp(parent.admittedAt), hostOperationTimestamp(producer.admittedAt))
    || hostOperationTimestamp(seal.createdAt) < hostOperationTimestamp(prepared.preparedAt)) return officeLocalFailure();
  return { ...prepared, preparedArtifactId: String(row.prepared_artifact_id), preparedDigest: seal.hash,
    identityDigest, revision: Number(row.revision) };
}

export function validateOfficeLocalEffect(execution: HostOfficeLocalExecutionRecord, value: unknown): PrepareHostOfficeLocalEffect {
  const keys = new Set(["effectId", "ordinal", "kind", "mode", "memberId", "fromMemberId", "resourceLifetimeId", "offset", "sizeBytes", "preparedAt"]);
  if (!object(value) || Object.keys(value).some(key => !keys.has(key)) || !text(value.effectId) || !size(value.ordinal) || value.ordinal >= 1024
    || !text(value.kind) || !["mkdir","open","write","fsync","close","link","rename","unlink","rmdir"].includes(value.kind)
    || !text(value.mode) || !["forward","cleanup"].includes(value.mode)) return officeLocalFailure();
  const member = execution.members.find(item => item.memberId === value.memberId), from = execution.members.find(item => item.memberId === value.fromMemberId);
  if (!member) return officeLocalFailure();
  if (value.kind === "link" || value.kind === "rename") {
    if (member.role !== "target" || from?.role !== "temporary" || value.mode !== "forward"
      || (value.kind === "rename" && !execution.overwrite) || (value.kind === "link" && execution.input.state !== "absent")) return officeLocalFailure();
  } else if (value.fromMemberId !== undefined) return officeLocalFailure();
  if (value.kind === "mkdir" && (member.role !== "directory" || member.initial.state !== "absent" || value.mode !== "forward")) return officeLocalFailure();
  if (["open","write","fsync","close"].includes(value.kind)) {
    if (!text(value.resourceLifetimeId) || !["temporary","recovery"].includes(member.role)
      || (value.mode === "cleanup" && value.kind !== "close")) return officeLocalFailure();
  } else if (Object.hasOwn(value, "resourceLifetimeId")) return officeLocalFailure();
  if (value.kind === "unlink" && (member.role === "directory" || (value.mode === "forward" && member.role !== "temporary"))) return officeLocalFailure();
  if (value.kind === "rmdir" && (member.role !== "directory" || member.initial.state !== "absent" || value.mode !== "cleanup")) return officeLocalFailure();
  if (value.kind === "write") {
    const limit = member.role === "recovery" && execution.input.state === "file" ? execution.input.sizeBytes : execution.output.sizeBytes;
    if (!size(value.offset) || !size(value.sizeBytes) || value.sizeBytes === 0 || value.offset + value.sizeBytes > limit) return officeLocalFailure();
  } else if (value.offset !== undefined || value.sizeBytes !== undefined) return officeLocalFailure();
  if (hostOperationTimestamp(value.preparedAt) < hostOperationTimestamp(execution.preparedAt)) return officeLocalFailure();
  return value as unknown as PrepareHostOfficeLocalEffect;
}

export function readOfficeLocalEffects(database: DatabaseSync, execution: HostOfficeLocalExecutionRecord): HostOfficeLocalEffectRecord[] {
  return database.prepare("SELECT * FROM host_office_local_effects WHERE execution_id=? ORDER BY ordinal").all(execution.executionId)
    .map((row: Record<string, SQLOutputValue>, index) => {
      let descriptor: unknown;
      try { descriptor = JSON.parse(String(row.descriptor_json)); } catch { return officeLocalFailure(); }
      const effect = validateOfficeLocalEffect(execution, descriptor);
      if (row.effect_id !== effect.effectId || row.ordinal !== index || effect.ordinal !== index || !size(row.revision)
        || digestHarnessToolValue({ executionIdentityDigest: execution.identityDigest, effect }) !== row.effect_digest) return officeLocalFailure();
      const result: HostOfficeLocalEffectRecord = { ...effect, executionId: execution.executionId, effectDigest: String(row.effect_digest),
        ...(row.entered_at === null ? {} : { enteredAt: String(row.entered_at) }),
        ...(row.observation_artifact_id === null ? {} : { observationArtifactId: String(row.observation_artifact_id) }), revision: Number(row.revision) };
      if (result.enteredAt && hostOperationTimestamp(result.enteredAt) < hostOperationTimestamp(effect.preparedAt)) return officeLocalFailure();
      if (result.observationArtifactId) validateOfficeLocalObservation(database, execution, result, result.observationArtifactId);
      return result;
    });
}

export function validateOfficeLocalObservation(database: DatabaseSync, execution: HostOfficeLocalExecutionRecord,
  effect: HostOfficeLocalEffectRecord, artifactId: string): HostOfficeLocalEffectObservation {
  const seal = readOfficeLocalSeal(database, artifactId, execution.source.runId);
  return validateOfficeLocalObservationPayload(execution, effect, seal.payload, seal.createdAt);
}
