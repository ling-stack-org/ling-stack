import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import type { HostMediaExecutionRecord, PrepareHostMediaEffectInput, HostMediaEffectRecord } from "../../host-media-operation-types.js";
import { digestHarnessToolValue } from "../../harness/tool-executions.js";
import { hostOperationTimestamp } from "./host-operation-journal-evidence.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import type { SqliteStoreContext } from "./store-context.js";
import {
  hostMediaEffectMatchesProtocol, hostMediaExecutionIdentity, mediaFactDigest, mediaFactFailure, mediaFactText,
  readHostMediaExecution, readHostMediaEffects,
} from "./host-media-operation-records.js";

type PreparedExecution = Omit<HostMediaExecutionRecord, "schemaVersion" | "workspaceId" | "identityDigest" | "revision" | "childFence" | "childBoundAt"
  | "submissionArtifactId" | "terminalArtifactId" | "manifestArtifactId" | "finalizationArtifactId">;

/**
 * Internal immutable facts writer. The public journal owns live tickets and all
 * actual-send gates. These rows are not safe settlements or replay capabilities.
 * Mutations never open/adopt an implicit transaction or trust isTransaction.
 */
export class SqliteHostMediaFactsStore {
  constructor(private readonly context: SqliteStoreContext) {}

  insertPreparedExecution(input: PreparedExecution): HostMediaExecutionRecord {
    this.assertWriteTransaction();
    if (this.getExecution(input.executionId)) return mediaFactFailure("host_media_execution_already_prepared");
    const job = this.context.database.prepare("SELECT workspace_id FROM media_jobs WHERE id=?").get(input.mediaJobId);
    if (!job || !mediaFactText(job.workspace_id)) return mediaFactFailure("host_media_invalid_preparation");
    const record: HostMediaExecutionRecord = { ...input, source: { ...input.source }, schemaVersion: 1,
      workspaceId: job.workspace_id, identityDigest: "", revision: 0 };
    const digest = digestHarnessToolValue(hostMediaExecutionIdentity(record));
    this.context.database.prepare(`INSERT INTO host_media_executions(execution_id,schema_version,workspace_id,media_job_id,
      media_child_work_unit_id,execution_generation_id,parent_operation_id,transport_operation_id,run_id,work_unit_id,
      attempt_id,runtime_instance_id,fencing_token,tool_call_id,tool_name,operation,protocol,adapter_id,intent_digest,
      target_digest,namespace_digest,prepared_request_artifact_id,prepared_request_digest,prepared_at,identity_digest)
      VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.executionId, job.workspace_id, input.mediaJobId,
        input.mediaChildWorkUnitId, input.executionGenerationId, input.parentOperationId, input.transportOperationId,
        input.source.runId, input.source.workUnitId, input.source.attemptId, input.source.runtimeInstanceId, input.source.fencingToken,
        input.toolCallId, input.toolName, input.operation, input.protocol, input.adapterId, input.intentDigest,
        input.targetDigest, input.namespaceDigest, input.preparedRequestArtifactId, input.preparedRequestDigest, input.preparedAt, digest);
    const inserted = this.requireExecution(input.executionId);
    this.assertOwner(inserted);
    return inserted;
  }

  bindChildExecution(executionId: string, fence: RuntimeAttemptFenceV1, boundAt: string): HostMediaExecutionRecord {
    this.assertWriteTransaction();
    const row = this.requireExecution(executionId);
    this.assertOwner(row);
    if (row.childFence) {
      if (digestHarnessToolValue(row.childFence) !== digestHarnessToolValue(fence)) return mediaFactFailure("host_media_child_conflict");
      this.assertChildCurrent(row);
      return row;
    }
    if (!fence || fence.workUnitId !== row.mediaChildWorkUnitId
      || ![fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken].every(mediaFactText)
      || !/^(0|[1-9][0-9]*)$/u.test(fence.fencingToken)
      || hostOperationTimestamp(boundAt) < hostOperationTimestamp(row.preparedAt)) return mediaFactFailure("host_media_child_conflict");
    this.assertChildCurrent({ ...row, childFence: fence });
    const updated = this.context.database.prepare(`UPDATE host_media_executions SET child_attempt_id=?,
      child_runtime_instance_id=?,child_fencing_token=?,child_bound_at=?,revision=revision+1
      WHERE execution_id=? AND revision=? AND child_attempt_id IS NULL`).run(fence.attemptId, fence.runtimeInstanceId,
        fence.fencingToken, boundAt, executionId, row.revision);
    if (updated.changes !== 1) return mediaFactFailure("host_media_cas_conflict");
    return this.requireExecution(executionId);
  }

  prepareEffect(executionId: string, input: PrepareHostMediaEffectInput): HostMediaEffectRecord {
    this.assertWriteTransaction();
    const row = this.requireExecution(executionId);
    this.assertOwner(row); this.assertChildCurrent(row);
    if (row.finalizationArtifactId) return mediaFactFailure("host_media_operation_finalized");
    const effects = this.listEffects(executionId);
    if (!mediaFactText(input.effectId) || !Number.isSafeInteger(input.ordinal) || input.ordinal !== effects.length
      || input.method !== "POST" || !mediaFactDigest(input.routeDigest) || !mediaFactDigest(input.wireDigest)
      || !hostMediaEffectMatchesProtocol(row.protocol, input.kind)
      || hostOperationTimestamp(input.preparedAt) < hostOperationTimestamp(row.childBoundAt)
      || effects.some(effect => effect.kind !== "comfy_image_upload")) return mediaFactFailure("host_media_invalid_effect");
    this.context.database.prepare(`INSERT INTO host_media_effects(effect_id,schema_version,execution_id,ordinal,kind,
      method,route_digest,wire_digest,prepared_at) VALUES(?,1,?,?,?,?,?,?,?)`).run(input.effectId, executionId,
        input.ordinal, input.kind, input.method, input.routeDigest, input.wireDigest, input.preparedAt);
    return this.listEffects(executionId).at(-1)!;
  }

  /** Called under the same write lock as private-ticket validation, immediately before the synchronous send. */
  markEffectLaunched(executionId: string, effectId: string, launchedAt: string): HostMediaEffectRecord {
    this.assertWriteTransaction();
    const row = this.requireExecution(executionId);
    this.assertOwner(row); this.assertChildCurrent(row);
    if (row.finalizationArtifactId) return mediaFactFailure("host_media_operation_finalized");
    const effects = this.listEffects(executionId), effect = effects.find(member => member.effectId === effectId);
    if (!effect) return mediaFactFailure("host_media_effect_missing");
    if (effect.launchedAt) return mediaFactFailure("host_media_effect_already_launched");
    if (effect.noStartArtifactId) return mediaFactFailure("host_media_effect_not_started");
    if (effects.some(member => member.ordinal < effect.ordinal && !member.launchedAt)
      || hostOperationTimestamp(launchedAt) < hostOperationTimestamp(effect.preparedAt)) return mediaFactFailure("host_media_invalid_effect");
    const updated = this.context.database.prepare(`UPDATE host_media_effects SET launched_at=?,revision=revision+1
      WHERE effect_id=? AND execution_id=? AND revision=? AND launched_at IS NULL`).run(launchedAt, effectId, executionId, effect.revision);
    if (updated.changes !== 1) return mediaFactFailure("host_media_cas_conflict");
    return this.listEffects(executionId).find(member => member.effectId === effectId)!;
  }

  getExecution(id: string): HostMediaExecutionRecord | undefined { return readHostMediaExecution(this.context.database, id); }
  listEffects(id: string): HostMediaEffectRecord[] { return readHostMediaEffects(this.context.database, this.requireExecution(id)); }

  private requireExecution(id: string): HostMediaExecutionRecord {
    return this.getExecution(id) ?? mediaFactFailure("host_media_execution_missing");
  }
  private assertOwner(row: HostMediaExecutionRecord): void {
    if (!isCurrentRunExecutionOwner(this.context, row.source.runId, row.source, false)) return mediaFactFailure("host_operation_stale_owner");
  }
  private assertChildCurrent(row: HostMediaExecutionRecord): void {
    if (!row.childFence) return mediaFactFailure("host_media_child_missing");
    const fence = row.childFence;
    const child = this.context.database.prepare(`SELECT attempt.id FROM work_units unit
      JOIN work_unit_attempts attempt ON attempt.id=unit.active_attempt_id
      WHERE unit.id=? AND attempt.id=? AND attempt.work_unit_id=unit.id AND attempt.runtime_instance_id=?
        AND attempt.fencing_token=? AND attempt.ended_at IS NULL AND attempt.abort_requested_at IS NULL
        AND attempt.status IN ('created','started','waiting_for_approval')
        AND unit.status IN ('queued','claimed','running','waiting_for_approval')`).get(fence.workUnitId, fence.attemptId,
          fence.runtimeInstanceId, fence.fencingToken);
    if (!child) return mediaFactFailure("host_media_child_stale");
  }
  private assertWriteTransaction(): void {
    if (this.context.database.prepare("PRAGMA query_only").get()?.query_only === 1) return mediaFactFailure("host_media_writer_transaction_required");
    try { this.context.database.exec("BEGIN IMMEDIATE"); }
    catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR"
        && error.message === "cannot start a transaction within a transaction") return;
      throw error;
    }
    this.context.database.exec("ROLLBACK");
    return mediaFactFailure("host_media_writer_transaction_required");
  }
}
