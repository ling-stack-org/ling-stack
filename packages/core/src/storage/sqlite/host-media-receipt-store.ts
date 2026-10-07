import type { HostMediaExecutionRecord } from "../../host-media-operation-types.js";
import { hostOperationTimestamp, readHostOperation } from "./host-operation-journal-evidence.js";
import { mediaFactFailure, mediaFactText, readHostMediaExecution, readHostMediaEffects } from "./host-media-operation-records.js";
import { readHostMediaReceipt, validateHostMediaManifest, validateHostMediaNoStart, validateHostMediaResponse,
  validateHostMediaSubmission, validateHostMediaTerminal, verifyHostMediaReceipt } from "./host-media-receipt-evidence.js";
import type { HostMediaLocalFinalization, HostMediaSubmissionExecutionProjection } from "../../host-media-receipt-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { writeMediaSubmissionExecutionHandle } from "./host-media-submission-handle.js";

type ExecutionRef = "submission_artifact_id" | "terminal_artifact_id" | "manifest_artifact_id" | "finalization_artifact_id";
type EffectRef = "response_artifact_id" | "no_start_artifact_id";

/** Fixed receipt writes. Only the live-capability layer calls these inside its writer transaction. */
export class SqliteHostMediaReceiptStore {
  constructor(private readonly context: SqliteStoreContext) {}

  recordResponse(executionId: string, effectId: string, artifactId: string): HostMediaExecutionRecord {
    const execution = this.execution(executionId), effect = this.effects(execution).find(member => member.effectId === effectId);
    if (!effect) return mediaFactFailure("host_media_effect_missing");
    validateHostMediaResponse(this.context.database, execution, effect, artifactId);
    this.bindEffectRef(execution, effectId, "response_artifact_id", artifactId);
    return this.execution(executionId);
  }
  recordSubmission(executionId: string, artifactId: string): HostMediaExecutionRecord {
    const execution = this.execution(executionId);
    validateHostMediaSubmission(this.context.database, execution, this.effects(execution), artifactId);
    this.bindExecutionRef(execution, "submission_artifact_id", artifactId);
    return this.execution(executionId);
  }
  recordSubmissionAndExecutionHandle(executionId: string, artifactId: string,
    projection: HostMediaSubmissionExecutionProjection): HostMediaExecutionRecord {
    const execution = this.execution(executionId);
    const submission = validateHostMediaSubmission(this.context.database, execution, this.effects(execution), artifactId);
    this.bindExecutionRef(execution, "submission_artifact_id", artifactId);
    writeMediaSubmissionExecutionHandle(this.context, execution, submission, projection);
    return this.execution(executionId);
  }
  recordTerminal(executionId: string, artifactId: string): HostMediaExecutionRecord {
    const execution = this.execution(executionId);
    validateHostMediaTerminal(this.context.database, execution, this.effects(execution), artifactId);
    this.bindExecutionRef(execution, "terminal_artifact_id", artifactId);
    return this.execution(executionId);
  }
  recordManifest(executionId: string, artifactId: string): HostMediaExecutionRecord {
    const execution = this.execution(executionId);
    validateHostMediaManifest(this.context.database, execution, this.effects(execution), artifactId);
    this.bindExecutionRef(execution, "manifest_artifact_id", artifactId);
    return this.execution(executionId);
  }
  recordNoStart(executionId: string, effectId: string, artifactId: string): HostMediaExecutionRecord {
    const execution = this.execution(executionId), effect = this.effects(execution).find(member => member.effectId === effectId);
    if (!effect) return mediaFactFailure("host_media_effect_missing");
    validateHostMediaNoStart(this.context.database, execution, effect, artifactId);
    this.bindEffectRef(execution, effectId, "no_start_artifact_id", artifactId);
    return this.execution(executionId);
  }
  finalize(executionId: string, artifactId: string): HostMediaExecutionRecord {
    const execution = this.execution(executionId), operation = readHostOperation(this.context.database, execution.transportOperationId);
    const seal = readHostMediaReceipt<HostMediaLocalFinalization>(this.context.database, execution, artifactId, "media_finalization_v1");
    if (!operation || hostOperationTimestamp(seal.createdAt) > Date.now()) return mediaFactFailure("host_media_receipt_invalid");
    const noStart = this.effects(execution).every(effect => !effect.launchedAt);
    // Verify the entire exact candidate before committing its first-writer-wins ref.
    this.bindExecutionRef(execution, "finalization_artifact_id", artifactId);
    const updated = this.execution(executionId);
    verifyHostMediaReceipt(this.context.database, { ...operation, settledAt: new Date().toISOString(),
      settlementKind: noStart ? "known_no_start" : execution.protocol === "image_response_v1" ? "media_response_completed" : "media_remote_terminal" });
    return updated;
  }

  private execution(id: string): HostMediaExecutionRecord {
    this.assertWriteTransaction();
    return readHostMediaExecution(this.context.database, id) ?? mediaFactFailure("host_media_execution_missing");
  }
  private effects(execution: HostMediaExecutionRecord) { return readHostMediaEffects(this.context.database, execution); }
  private bindExecutionRef(execution: HostMediaExecutionRecord, column: ExecutionRef, artifactId: string): void {
    if (!mediaFactText(artifactId)) return mediaFactFailure("host_media_receipt_invalid");
    const row = this.context.database.prepare(`SELECT ${column} AS ref FROM host_media_executions WHERE execution_id=?`).get(execution.executionId);
    if (row?.ref === artifactId) return;
    if (row?.ref || execution.finalizationArtifactId) return mediaFactFailure("host_media_receipt_conflict");
    const result = this.context.database.prepare(`UPDATE host_media_executions SET ${column}=?,revision=revision+1
      WHERE execution_id=? AND revision=? AND ${column} IS NULL`).run(artifactId, execution.executionId, execution.revision);
    if (result.changes !== 1) return mediaFactFailure("host_media_cas_conflict");
  }
  private bindEffectRef(execution: HostMediaExecutionRecord, id: string, column: EffectRef, artifactId: string): void {
    const effect = this.effects(execution).find(member => member.effectId === id);
    if (!effect || !mediaFactText(artifactId)) return mediaFactFailure("host_media_receipt_invalid");
    const existing = column === "response_artifact_id" ? effect.responseArtifactId : effect.noStartArtifactId;
    if (existing === artifactId) return;
    if (existing || execution.finalizationArtifactId) return mediaFactFailure("host_media_receipt_conflict");
    const result = this.context.database.prepare(`UPDATE host_media_effects SET ${column}=?,revision=revision+1
      WHERE execution_id=? AND effect_id=? AND revision=? AND ${column} IS NULL`).run(artifactId, execution.executionId, id, effect.revision);
    if (result.changes !== 1) return mediaFactFailure("host_media_cas_conflict");
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
