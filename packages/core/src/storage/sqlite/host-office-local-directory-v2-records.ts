import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, type HostOfficeLocalDirectoryExecutionRecordV2,
  type HostOfficeLocalDirectoryEffectRecordV2, type HostOfficeLocalDirectoryPreparedV2, type HostOfficeLocalDirectoryObservationV2 } from "../../host-office-local-directory-v2-types.js";
import { assertHostOperationLineage, readHostOperation, sameHostOperationSource } from "./host-operation-journal-evidence.js";
import { readOfficeLocalSeal } from "./host-office-local-records.js";
import { validateOfficeLocalDirectoryPreparedV2 } from "./host-office-local-directory-v2-prepared.js";
import { validateOfficeLocalDirectoryEffectV2 } from "./host-office-local-directory-v2-effects.js";
import { validateOfficeLocalDirectoryObservationPayloadV2 } from "./host-office-local-directory-v2-observations.js";
import { validateOfficeDirectoryHistoryV2 } from "./host-office-local-directory-v2-history.js";
import { directoryV2Failure, v2Size, v2Timestamp } from "./host-office-local-directory-v2-validation.js";

export function officeDirectoryIdentityDigestV2(prepared: HostOfficeLocalDirectoryPreparedV2, artifactId: string, digest: string): string {
  return digestHarnessToolValue({ protocol: HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, prepared, preparedArtifactId: artifactId, preparedDigest: digest });
}
export function officeDirectoryEffectDigestV2(execution: HostOfficeLocalDirectoryExecutionRecordV2, effect: unknown): string {
  return digestHarnessToolValue({ protocol: HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL, executionIdentityDigest: execution.identityDigest, effect });
}
export function assertOfficeDirectoryWorkspaceV2(database: DatabaseSync, prepared: HostOfficeLocalDirectoryPreparedV2): void {
  const run = database.prepare("SELECT cwd FROM run_sessions WHERE id=?").get(prepared.source.runId);
  if (!run || typeof run.cwd !== "string" || resolve(run.cwd) !== prepared.workspacePath) return directoryV2Failure();
}
export function hasOfficeDirectoryV2Execution(database: DatabaseSync, id: string): boolean {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_office_local_directory_v2_executions'").get();
  return !!table && !!database.prepare("SELECT 1 FROM host_office_local_directory_v2_executions WHERE execution_id=?").get(id);
}
/** Historical source/pair and sealed bytes only; never read today's namespace to repair evidence. */
export function readOfficeLocalDirectoryExecutionV2(database: DatabaseSync, id: string): HostOfficeLocalDirectoryExecutionRecordV2 | undefined {
  const row = database.prepare("SELECT * FROM host_office_local_directory_v2_executions WHERE execution_id=?").get(id);
  if (!row) return undefined;
  const source = { runId: String(row.run_id), workUnitId: String(row.work_unit_id), attemptId: String(row.attempt_id),
    runtimeInstanceId: String(row.runtime_instance_id), fencingToken: String(row.fencing_token) };
  assertHostOperationLineage(database, source);
  const seal = readOfficeLocalSeal(database, String(row.prepared_artifact_id), source.runId), prepared = validateOfficeLocalDirectoryPreparedV2(seal.payload);
  assertOfficeDirectoryWorkspaceV2(database, prepared);
  const identityDigest = officeDirectoryIdentityDigestV2(prepared, String(row.prepared_artifact_id), seal.hash);
  const parent = readHostOperation(database, prepared.parentOperationId), producer = readHostOperation(database, prepared.producerOperationId);
  if (row.schema_version !== 2 || row.protocol !== HOST_OFFICE_LOCAL_DIRECTORY_V2_PROTOCOL || prepared.executionId !== id
    || !sameHostOperationSource(source, prepared.source) || prepared.parentOperationId !== row.parent_operation_id || prepared.producerOperationId !== row.producer_operation_id
    || prepared.toolCallId !== row.tool_call_id || prepared.toolName !== row.tool_name || prepared.preparedAt !== row.prepared_at
    || seal.hash !== row.prepared_digest || identityDigest !== row.identity_digest || row.revision !== 0 || !parent || !producer
    || parent.kind !== "mcp" || parent.parentOperationId || producer.kind !== "file_mutation" || producer.parentOperationId !== parent.operationId
    || producer.producerId !== "office-local-binary" || parent.toolCallId !== prepared.toolCallId || producer.toolCallId !== prepared.toolCallId
    || !sameHostOperationSource(parent.source, source) || !sameHostOperationSource(producer.source, source)
    || v2Timestamp(prepared.preparedAt) < Math.max(v2Timestamp(parent.admittedAt), v2Timestamp(producer.admittedAt))
    || v2Timestamp(seal.createdAt) < v2Timestamp(prepared.preparedAt)
    || database.prepare("SELECT 1 FROM host_office_local_executions WHERE execution_id=? OR parent_operation_id IN (?,?) OR producer_operation_id IN (?,?)")
      .get(id, prepared.parentOperationId, prepared.producerOperationId, prepared.parentOperationId, prepared.producerOperationId)) return directoryV2Failure();
  return { ...prepared, preparedArtifactId: String(row.prepared_artifact_id), preparedDigest: seal.hash, identityDigest, revision: 0 };
}
export function validateOfficeLocalDirectoryObservationV2(database: DatabaseSync, execution: HostOfficeLocalDirectoryExecutionRecordV2,
  effect: HostOfficeLocalDirectoryEffectRecordV2, artifactId: string): HostOfficeLocalDirectoryObservationV2 {
  const seal = readOfficeLocalSeal(database, artifactId, execution.source.runId);
  return validateOfficeLocalDirectoryObservationPayloadV2(execution, effect, seal.payload, seal.createdAt);
}
export function readOfficeLocalDirectoryEffectsV2(database: DatabaseSync, execution: HostOfficeLocalDirectoryExecutionRecordV2): HostOfficeLocalDirectoryEffectRecordV2[] {
  const rows = database.prepare("SELECT * FROM host_office_local_directory_v2_effects WHERE execution_id=? ORDER BY ordinal").all(execution.executionId);
  const effects = rows.map((row, index): HostOfficeLocalDirectoryEffectRecordV2 => {
    let value: unknown; try { value = JSON.parse(String(row.descriptor_json)); } catch { return directoryV2Failure(); }
    const effect = validateOfficeLocalDirectoryEffectV2(execution, value);
    if (row.effect_id !== effect.effectId || row.ordinal !== index || effect.ordinal !== index || !v2Size(row.revision)
      || officeDirectoryEffectDigestV2(execution, effect) !== row.effect_digest) return directoryV2Failure();
    const result = { ...effect, executionId: execution.executionId, effectDigest: String(row.effect_digest),
      ...(row.entered_at === null ? {} : { enteredAt: String(row.entered_at) }),
      ...(row.observation_artifact_id === null ? {} : { observationArtifactId: String(row.observation_artifact_id) }), revision: Number(row.revision) };
    if (result.enteredAt && v2Timestamp(result.enteredAt) < v2Timestamp(effect.preparedAt)) return directoryV2Failure();
    return result;
  });
  validateOfficeDirectoryHistoryV2(effects.map(effect => ({ effect, observation: effect.observationArtifactId
    ? validateOfficeLocalDirectoryObservationV2(database, execution, effect, effect.observationArtifactId) : null })));
  return effects;
}
