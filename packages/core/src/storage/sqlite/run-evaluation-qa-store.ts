import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { SQLOutputValue } from "node:sqlite";
import type { RunEvaluationQaBatchV1, RunEvaluationQaEnrollmentV1, RunEvaluationQaRequestV1 } from "@ling-stack/contracts";
import type {
  RunEvaluationQaStore, RunEvaluationQaMutationCode, RunEvaluationQaMutationResult,
  CreateRunEvaluationQaBatchInput, EnrollRunEvaluationQaTaskInput, AdmitRunEvaluationQaRequestInput,
  CompleteRunEvaluationQaRequestInput, MarkRunEvaluationQaRequestUnknownInput, ReleaseRunEvaluationQaLaneInput,
  RunEvaluationQaAdmission, RunEvaluationQaSettlement,
  ListClaimableRunEvaluationQaTasksInput,
} from "../../harness/evaluation-qa.js";
import { digestRunEvaluationValue, RunEvaluationInputError } from "../../harness/evaluation-json.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { mapQaBatch, mapQaEnrollment, mapQaRequest, mapQaScope } from "./run-evaluation-qa-mappers.js";
import { taskIdentity, taskLimit, validateTaskArtifactJson } from "./run-evaluation-task-validation.js";
import { qaAdmit, qaComplete, qaEnqueue, qaFence, validateQaInput, validateQaWirePayload } from "./run-evaluation-qa-validation.js";
import { EvidenceError, type SqliteRunEvaluationTaskStore } from "./run-evaluation-task-store.js";
import { mapRunEvaluationTask } from "./run-evaluation-task-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { RunArtifact } from "../../run-types.js";
type Row = Record<string, SQLOutputValue>;
// Process lifetime only. Reopening in another boot cannot prove an old request drained.
const PROCESS_BOOT_EPOCH = randomUUID();
class QaAbort extends Error { constructor(readonly code: RunEvaluationQaMutationCode) { super(code); } }

/** Single canonical workspace / owned Host profile. No multi-machine or cross-database quota claim. */
export class SqliteRunEvaluationQaStore implements RunEvaluationQaStore {
  private readonly canonicalCwd: string;
  private readonly namespaceId: string;
  constructor(private readonly context: SqliteStoreContext, private readonly tasks: SqliteRunEvaluationTaskStore, cwd: string, private readonly getArtifact: (id: string) => RunArtifact | undefined) {
    this.canonicalCwd = realpathSync(cwd);
    this.namespaceId = `evaluation_qa_${sha(this.canonicalCwd)}`;
  }
  getRunEvaluationQaScope() {
    const row = this.context.database.prepare("SELECT * FROM run_evaluation_qa_namespace WHERE singleton=1").get();
    if (!row) return undefined;
    if (row.id !== this.namespaceId || row.canonical_cwd !== this.canonicalCwd) throw new RunEvaluationInputError("evaluation.task_invalid");
    return mapQaScope(row as Row);
  }
  getRunEvaluationQaBatch(id: string) {
    taskIdentity(id);
    const row = this.context.database.prepare("SELECT * FROM run_evaluation_qa_batches WHERE id=?").get(id);
    return row ? mapQaBatch(row as Row) : undefined;
  }
  getRunEvaluationQaEnrollment(taskId: string) {
    taskIdentity(taskId);
    const row = this.context.database.prepare("SELECT * FROM run_evaluation_qa_enrollments WHERE task_id=?").get(taskId);
    return row ? mapQaEnrollment(row as Row) : undefined;
  }
  getRunEvaluationQaRequest(id: string) {
    taskIdentity(id);
    const row = this.context.database.prepare("SELECT * FROM run_evaluation_qa_requests WHERE id=?").get(id);
    return row ? mapQaRequest(row as Row) : undefined;
  }
  /** Filter the current enrolled batch before LIMIT; unrelated queue prefixes cannot starve it. */
  listClaimableRunEvaluationQaTasks(input: ListClaimableRunEvaluationQaTasksInput) {
    validateQaInput(input, "list");
    const scope = this.getRunEvaluationQaScope();
    if (!scope) return [];
    return this.context.database.prepare(`SELECT t.* FROM run_evaluation_qa_batches b
      JOIN run_evaluation_qa_enrollments e INDEXED BY idx_evaluation_qa_enrollment_batch_task ON e.batch_id=b.id
      JOIN run_evaluation_tasks t ON t.id=e.task_id
      WHERE b.id=? AND b.namespace_id=? ${input.configDigest === undefined ? "" : "AND b.config_digest=?"}
        AND t.state='queued' AND (t.next_attempt_at IS NULL OR t.next_attempt_at<=?)
      ORDER BY COALESCE(t.next_attempt_at,t.created_at),t.created_at,t.id LIMIT ?`)
      .all(input.batchId, scope.namespaceId, ...(input.configDigest === undefined ? [] : [input.configDigest]), input.now, taskLimit(input.limit))
      .map(row => mapRunEvaluationTask(row as Row));
  }
  createRunEvaluationQaBatch(input: CreateRunEvaluationQaBatchInput) {
    validateQaInput(input, "batch");
    return this.mutate(() => {
      const artifactSha = this.validateConfigArtifact(input.configSnapshotRef, input.configDigest);
      const scope = this.getRunEvaluationQaScope();
      if (!scope) this.context.database.prepare("INSERT INTO run_evaluation_qa_namespace(id,singleton,schema_version,canonical_cwd,batch_limit,rolling_limit,rolling_window_ms,clock_high_water_at,lane_state,revision) VALUES(?,1,1,?,3,12,86400000,?,'available',0)").run(this.namespaceId, this.canonicalCwd, input.now);
      const id = `evaluation_qa_batch_${randomUUID()}`;
      this.context.database.prepare("INSERT INTO run_evaluation_qa_batches(id,schema_version,namespace_id,config_snapshot_ref,config_artifact_sha,config_digest,created_at) VALUES(?,1,?,?,?,?,?)").run(id, this.namespaceId, input.configSnapshotRef, artifactSha, input.configDigest, input.now);
      return ok(this.getRunEvaluationQaBatch(id)!);
    });
  }
  enrollRunEvaluationQaTask(input: EnrollRunEvaluationQaTaskInput): RunEvaluationQaMutationResult<RunEvaluationQaEnrollmentV1> {
    validateQaInput(input, "enroll");
    return this.mutate(() => {
      const scope = this.getRunEvaluationQaScope(), batch = this.getRunEvaluationQaBatch(input.batchId);
      if (!scope || !batch || batch.namespaceId !== scope.namespaceId) return fail("not_found");
      this.validateBatch(batch);
      const taskResult = this.tasks.enqueueWithinTransaction(qaEnqueue(input));
      if (!taskResult.ok) throw new QaAbort(taskResult.code);
      const task = taskResult.value;
      const evaluation = this.tasks.validateTaskWithinTransaction(task);
      for (const prefix of ["suite", "case", "baseline", "candidate"] as const) {
        const pin = input.artifactPins[prefix];
        if (pin.artifactId !== evaluation[`${prefix}ArtifactId`] || pin.contentSha256 !== evaluation[`${prefix}Digest`]) throw new QaAbort("identity_conflict");
      }
      if (digestRunEvaluationValue(input.artifactPins.frozen) !== digestRunEvaluationValue(task.frozenGraderArtifact)) throw new QaAbort("identity_conflict");
      const existing = this.getRunEvaluationQaEnrollment(task.id);
      if (existing) {
        if (existing.batchId !== batch.id || existing.reviewRef !== input.reviewRef || digestRunEvaluationValue(existing.artifactPins) !== digestRunEvaluationValue(input.artifactPins)) throw new QaAbort("identity_conflict");
        return ok(existing, true);
      }
      // An already-used foundation task cannot be retroactively designated QA.
      if (task.state !== "queued" || task.revision !== 0) throw new QaAbort("invalid_transition");
      const id = `evaluation_qa_enrollment_${randomUUID()}`;
      this.context.database.prepare("INSERT INTO run_evaluation_qa_enrollments(id,schema_version,task_id,batch_id,evaluation_id,evaluation_key,pins_json,frozen_digest,review_ref,created_at) VALUES(?,1,?,?,?,?,?,?,?,?)").run(id, task.id, batch.id, task.evaluationId, task.evaluationKey, JSON.stringify(input.artifactPins), task.frozenGraderDigest, input.reviewRef, input.now);
      return ok(this.getRunEvaluationQaEnrollment(task.id)!);
    });
  }
  admitRunEvaluationQaRequest(input: AdmitRunEvaluationQaRequestInput): RunEvaluationQaMutationResult<RunEvaluationQaAdmission> {
    validateQaInput(input, "admit");
    const bytes = Buffer.byteLength(input.payloadUtf8, "utf8");
    if (bytes > 32768 || input.estimatedInputTokens > 8000) return fail("qa_payload_budget_exceeded");
    const payloadSha = sha(input.payloadUtf8);
    return this.mutate(() => {
      this.reconcileWithinTransaction(input.now);
      const scope = this.getRunEvaluationQaScope(), enrollment = this.getRunEvaluationQaEnrollment(input.taskId);
      if (!scope || !enrollment) return fail("qa_not_enrolled");
      const batch = this.getRunEvaluationQaBatch(enrollment.batchId);
      if (!batch || batch.namespaceId !== scope.namespaceId || input.batchId !== batch.id || batch.configDigest !== input.configDigest) return fail("qa_config_conflict");
      this.validateBatch(batch);
      const task = this.tasks.getRunEvaluationTask(input.taskId);
      if (!task || !validateQaWirePayload(input.payloadUtf8, task.frozenGrader.modelId)) return fail("qa_payload_invalid");
      const existingRow = this.context.database.prepare("SELECT * FROM run_evaluation_qa_requests WHERE attempt_id=?").get(input.attemptId);
      if (existingRow) {
        const request = mapQaRequest(existingRow as Row);
        if (request.state !== "admitted" || scope.laneState !== "held" || scope.laneRequestId !== request.id) return fail(scope.laneState === "quarantined" ? "qa_lane_quarantined" : "invalid_transition");
        if (request.batchId !== batch.id || request.taskId !== input.taskId || request.payloadSha256 !== payloadSha || request.payloadBytes !== bytes || request.estimatedInputTokens !== input.estimatedInputTokens || request.requestDigest !== input.requestDigest || request.executionScopeDigest !== input.executionScopeDigest) return fail("identity_conflict");
        const admission = this.tasks.admitWithinTransaction(qaAdmit(input));
        return admission.ok ? ok({ ...admission.value, request, mayDispatch: false }, true) : admission;
      }
      if (scope.laneState !== "available") return fail(scope.laneState === "quarantined" ? "qa_lane_quarantined" : "qa_lane_busy");
      const count = this.context.database.prepare("SELECT COUNT(*) AS n FROM run_evaluation_qa_requests WHERE batch_id=?").get(batch.id)!.n as number;
      if (count >= scope.batchRequestLimit) return fail("qa_batch_budget_exhausted");
      const effectiveNow = input.now > scope.clockHighWaterAt ? input.now : scope.clockHighWaterAt;
      const cutoff = new Date(Date.parse(effectiveNow) - scope.rollingWindowMs).toISOString();
      const consumed = this.context.database.prepare("SELECT COUNT(*) AS n FROM run_evaluation_qa_requests WHERE namespace_id=? AND charged_at>?").get(scope.namespaceId, cutoff)!.n as number;
      if (consumed >= scope.rollingRequestLimit) return fail("qa_window_budget_exhausted");
      const admission = this.tasks.admitWithinTransaction(qaAdmit(input));
      if (!admission.ok) return admission;
      if (!admission.value.mayDispatch || !admission.value.attempt.invocationId) throw new QaAbort("identity_conflict");
      const id = `evaluation_qa_request_${randomUUID()}`;
      this.context.database.prepare("INSERT INTO run_evaluation_qa_requests(id,schema_version,namespace_id,batch_id,enrollment_id,task_id,attempt_id,invocation_id,request_digest,scope_digest,payload_sha,payload_bytes,estimated_input_tokens,output_token_limit,state,usage_json,charged_at,boot_epoch,revision) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,1024,'admitted','{\"state\":\"unknown\"}',?,?,0)").run(id, scope.namespaceId, batch.id, enrollment.id, input.taskId, input.attemptId, admission.value.attempt.invocationId, input.requestDigest, input.executionScopeDigest, payloadSha, bytes, input.estimatedInputTokens, effectiveNow, PROCESS_BOOT_EPOCH);
      this.changed(this.context.database.prepare("UPDATE run_evaluation_qa_namespace SET lane_state='held',lane_request_id=?,clock_high_water_at=?,revision=revision+1 WHERE id=? AND revision=? AND lane_state='available'").run(id, effectiveNow, scope.namespaceId, scope.revision).changes);
      return ok({ ...admission.value, request: this.getRunEvaluationQaRequest(id)! });
    });
  }
  completeRunEvaluationQaRequest(input: CompleteRunEvaluationQaRequestInput): RunEvaluationQaMutationResult<RunEvaluationQaSettlement> {
    validateQaInput(input, "complete");
    return this.mutate(() => {
      this.reconcileWithinTransaction(input.now);
      const request = this.getRunEvaluationQaRequest(input.requestId), scope = this.getRunEvaluationQaScope();
      if (!request || !scope) return fail("not_found");
      if (!this.matches(request, input) || request.processBootEpoch !== PROCESS_BOOT_EPOCH) return fail("lease_mismatch");
      if (request.state === "unknown" || scope.laneState === "quarantined") return fail("qa_lane_quarantined");
      const task = this.tasks.getRunEvaluationTask(input.taskId);
      if (!task || input.receipt.payloadSha256 !== request.payloadSha256 || input.receipt.modelId !== task.frozenGrader.modelId) return fail("qa_receipt_invalid");
      const usage = input.receipt.usage;
      if (input.result.costAmountMicros !== undefined || (usage.state === "unknown" ? input.result.costInputTokens !== undefined || input.result.costOutputTokens !== undefined : input.result.costInputTokens !== usage.inputTokens || input.result.costOutputTokens !== usage.outputTokens || usage.outputTokens > 1024)) return fail("qa_receipt_invalid");
      if (request.state === "completed") {
        if (digestRunEvaluationValue(request.receipt) !== digestRunEvaluationValue(input.receipt)) return fail("result_conflict");
        const settlement = this.tasks.completeWithinTransaction(qaComplete(input));
        return settlement.ok ? ok({ ...settlement.value, request }, true) : settlement;
      }
      if (scope.laneState !== "held" || scope.laneRequestId !== request.id) return fail("qa_lane_quarantined");
      const settlement = this.tasks.completeWithinTransaction(qaComplete(input));
      if (!settlement.ok) return settlement;
      this.changed(this.context.database.prepare("UPDATE run_evaluation_qa_requests SET state='completed',receipt_json=?,usage_json=?,completed_at=?,revision=revision+1 WHERE id=? AND revision=? AND state='admitted'").run(JSON.stringify(input.receipt), JSON.stringify(usage), input.now, request.id, request.revision).changes);
      // No lane release here: the actual callback has not yet drained.
      return ok({ ...settlement.value, request: this.getRunEvaluationQaRequest(request.id)! });
    });
  }
  markRunEvaluationQaRequestUnknown(input: MarkRunEvaluationQaRequestUnknownInput): RunEvaluationQaMutationResult<RunEvaluationQaRequestV1> {
    validateQaInput(input, "unknown");
    return this.mutate(() => {
      const request = this.getRunEvaluationQaRequest(input.requestId);
      if (!request) return fail("not_found");
      if (!this.matches(request, input) || request.processBootEpoch !== PROCESS_BOOT_EPOCH) return fail("lease_mismatch");
      if (request.state !== "admitted") return fail("invalid_transition");
      const result = this.tasks.markUnknownWithinTransaction(qaFence(input));
      if (!result.ok) return result;
      this.quarantineWithinTransaction(input.attemptId, input.now);
      return ok(this.getRunEvaluationQaRequest(request.id)!);
    });
  }
  /** Foundation lease recovery hook: task unknown and QA quarantine commit together. */
  quarantineWithinTransaction(attemptId: string, now: string): void {
    const row = this.context.database.prepare("SELECT * FROM run_evaluation_qa_requests WHERE attempt_id=? AND released_at IS NULL").get(attemptId);
    if (!row) return;
    const request = mapQaRequest(row as Row);
    if (request.state === "admitted") this.changed(this.context.database.prepare("UPDATE run_evaluation_qa_requests SET state='unknown',completed_at=?,revision=revision+1 WHERE id=? AND state='admitted' AND revision=?").run(now, request.id, request.revision).changes);
    const scope = this.getRunEvaluationQaScope();
    if (!scope || (scope.laneRequestId !== undefined && scope.laneRequestId !== request.id)) throw new QaAbort("qa_lane_quarantined");
    if (scope.laneState !== "quarantined" || scope.laneRequestId !== request.id) this.changed(this.context.database.prepare("UPDATE run_evaluation_qa_namespace SET lane_state='quarantined',lane_request_id=?,revision=revision+1 WHERE id=? AND revision=?").run(request.id, scope.namespaceId, scope.revision).changes);
  }
  reconcileRunEvaluationQaScope(input: { readonly now: string }) {
    validateQaInput(input, "reconcile");
    return this.mutate(() => {
      const scope = this.getRunEvaluationQaScope();
      if (!scope) return fail("not_found");
      this.reconcileWithinTransaction(input.now);
      return ok(this.getRunEvaluationQaScope()!);
    });
  }
  releaseRunEvaluationQaLane(input: ReleaseRunEvaluationQaLaneInput): RunEvaluationQaMutationResult<RunEvaluationQaRequestV1> {
    validateQaInput(input, "release");
    return this.mutate(() => {
      this.reconcileWithinTransaction(input.now);
      const request = this.getRunEvaluationQaRequest(input.requestId), scope = this.getRunEvaluationQaScope();
      if (!request || !scope) return fail("not_found");
      if (request.revision !== input.expectedRequestRevision) return fail("stale_revision");
      if (request.releasedAt || scope.laneRequestId !== request.id || scope.laneState === "available") return fail("invalid_transition");
      if (request.state === "admitted") return fail("invalid_transition");
      if (input.release.kind === "host_callback_drained" && (request.state !== "completed" || !request.receipt || request.processBootEpoch !== PROCESS_BOOT_EPOCH || scope.laneState !== "held")) return fail("qa_lane_quarantined");
      this.changed(this.context.database.prepare("UPDATE run_evaluation_qa_requests SET released_at=?,release_kind=?,reconciliation_audit_ref=?,revision=revision+1 WHERE id=? AND revision=? AND released_at IS NULL").run(input.now, input.release.kind, input.release.kind === "host_explicit_reconciliation" ? input.release.auditRef : null, request.id, request.revision).changes);
      this.changed(this.context.database.prepare("UPDATE run_evaluation_qa_namespace SET lane_state='available',lane_request_id=NULL,revision=revision+1 WHERE id=? AND revision=? AND lane_request_id=?").run(scope.namespaceId, scope.revision, request.id).changes);
      // Deliberately retain the charged row forever; no quota refund.
      return ok(this.getRunEvaluationQaRequest(request.id)!);
    });
  }
  private reconcileWithinTransaction(now: string): void {
    const scope = this.getRunEvaluationQaScope();
    if (!scope) return;
    const rows = this.context.database.prepare("SELECT * FROM run_evaluation_qa_requests WHERE namespace_id=? AND released_at IS NULL ORDER BY state,id LIMIT 2").all(scope.namespaceId);
    if (rows.length > 1) throw new QaAbort("qa_lane_quarantined");
    if (!rows.length) {
      if (scope.laneState !== "available") throw new QaAbort("qa_lane_quarantined");
      return;
    }
    const request = mapQaRequest(rows[0] as Row);
    const task = this.tasks.getRunEvaluationTask(request.taskId), attempt = this.tasks.getRunEvaluationTaskAttempt(request.attemptId);
    if (!task || !attempt || task.activeAttemptId !== request.attemptId || attempt.invocationId !== request.invocationId || attempt.taskId !== request.taskId) throw new QaAbort("qa_lane_quarantined");
    const orphan = request.processBootEpoch !== PROCESS_BOOT_EPOCH;
    if (request.state === "unknown" || task.state === "unknown_outcome" || orphan || scope.laneState === "quarantined" || (request.state === "admitted" && attempt.claimExpiresAt <= now)) {
      if (request.state === "admitted") this.tasks.reconcileQaOrphanWithinTransaction(request.taskId, request.attemptId, now);
      this.quarantineWithinTransaction(request.attemptId, now);
    } else if (scope.laneState !== "held" || scope.laneRequestId !== request.id || (request.state === "admitted" && (task.state !== "active" || attempt.state !== "dispatch_admitted")) || (request.state === "completed" && (task.state !== "completed" || attempt.state !== "completed"))) throw new QaAbort("qa_lane_quarantined");
  }
  private matches(request: RunEvaluationQaRequestV1, input: { readonly taskId: string; readonly attemptId: string }): boolean { return request.taskId === input.taskId && request.attemptId === input.attemptId; }
  private validateBatch(batch: RunEvaluationQaBatchV1): void {
    if (this.validateConfigArtifact(batch.configSnapshotRef, batch.configDigest) !== batch.configArtifactSha256) throw new QaAbort("qa_config_conflict");
  }
  private validateConfigArtifact(id: string, digest: string): string {
    const artifact = this.getArtifact(id);
    if (!artifact || artifact.sealedPayload === undefined || !artifact.contentSha256) throw new QaAbort("evaluation.artifact_invalid");
    validateTaskArtifactJson(artifact.sealedPayload);
    const actual = sha(JSON.stringify(artifact.sealedPayload));
    if (actual !== artifact.contentSha256 || digestRunEvaluationValue(artifact.sealedPayload) !== digest) throw new QaAbort("qa_config_conflict");
    return actual;
  }
  private changed(changes: number | bigint): void { if (changes !== 1 && changes !== 1n) throw new RunEvaluationInputError("evaluation.task_invalid"); }
  private mutate<T>(operation: () => RunEvaluationQaMutationResult<T>): RunEvaluationQaMutationResult<T> {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try { const result = operation(); this.context.database.exec("COMMIT;"); return result; }
    catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof QaAbort || error instanceof EvidenceError) return fail(error.code);
      throw new RunEvaluationInputError("evaluation.task_invalid");
    }
  }
}
function sha(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function ok<T>(value: T, replayed = false): RunEvaluationQaMutationResult<T> { return { ok: true, value, replayed }; }
function fail(code: RunEvaluationQaMutationCode): { readonly ok: false; readonly code: RunEvaluationQaMutationCode } { return { ok: false, code }; }
