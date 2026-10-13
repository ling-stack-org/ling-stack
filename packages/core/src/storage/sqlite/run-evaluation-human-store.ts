import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { RunEvaluationHumanPayloadV1, RunEvaluationHumanHeadV1, RunEvaluationHumanIntentV1, RunEvaluationHumanSubmissionV1 } from "@ling-stack/contracts";
import type { CreateRunEvaluationHumanIntentInput, CommitRunEvaluationHumanIntentInput, ListRunEvaluationHumanEventsInput, RunEvaluationHumanStore, RunEvaluationHumanMutationCode, RunEvaluationHumanMutationResult, RunEvaluationHumanSettlement } from "../../harness/human-evaluation.js";
import { digestRunEvaluationValue, RunEvaluationInputError } from "../../harness/evaluation-json.js";
import type { RunArtifact } from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { SqliteControlPlaneStore } from "./control-plane-store.js";
import { mapHumanEvent, mapHumanHead, mapHumanIntent, humanPayloadSha } from "./run-evaluation-human-mappers.js";
import { copyHumanBinding, equalHumanBinding, freezeHumanJson, validateHumanInput, validateHumanRubric } from "./run-evaluation-human-validation.js";
import { taskIdentity, taskLimit, validateTaskArtifactJson } from "./run-evaluation-task-validation.js";
import { EvidenceError, type SqliteRunEvaluationTaskStore } from "./run-evaluation-task-store.js";
import type { SqliteRunEvaluationQaStore } from "./run-evaluation-qa-store.js";
import type { SqliteStoreContext } from "./store-context.js";
type Row = Record<string, SQLOutputValue>;
// Private process lifetime. Reopening a DB in another process never revives its pending authority.
const PROCESS_BOOT_EPOCH = randomUUID();
class HumanAbort extends Error { constructor(readonly code: RunEvaluationHumanMutationCode) { super(code); } }
type Facts = Pick<RunEvaluationHumanPayloadV1, "namespaceId" | "canonicalWorkspaceCwd" | "taskId" | "enrollmentId" | "evaluationId" | "evaluationKey" | "artifactPins" | "configArtifact" | "configDigest" | "frozenGraderDigest" | "rubric" | "rubricDigest">;

/** Local trusted Host authority ledger. Model outputs remain unverified; no grade/promotion writes. */
export class SqliteRunEvaluationHumanStore implements RunEvaluationHumanStore {
  constructor(private readonly context: SqliteStoreContext, private readonly tasks: SqliteRunEvaluationTaskStore, private readonly qa: SqliteRunEvaluationQaStore, private readonly controlPlane: SqliteControlPlaneStore, private readonly getArtifact: (id: string) => RunArtifact | undefined) {}
  getRunEvaluationHumanIntent(id: string) {
    taskIdentity(id);
    const row = this.intentRow(id);
    return row ? mapHumanIntent(row) : undefined;
  }
  getRunEvaluationHumanHead(taskId: string) {
    taskIdentity(taskId);
    const row = this.context.database.prepare("SELECT * FROM run_evaluation_human_heads WHERE task_id=?").get(taskId);
    return row ? mapHumanHead(row as Row) : undefined;
  }
  getRunEvaluationHumanEvent(id: string) {
    taskIdentity(id);
    const row = this.context.database.prepare("SELECT * FROM run_evaluation_human_events WHERE id=?").get(id);
    return row ? mapHumanEvent(row as Row) : undefined;
  }
  listRunEvaluationHumanEvents(input: ListRunEvaluationHumanEventsInput) {
    validateHumanInput(input, "list");
    return this.context.database.prepare("SELECT * FROM run_evaluation_human_events WHERE task_id=? AND revision>? ORDER BY revision LIMIT ?").all(input.taskId, input.afterRevision ?? 0, taskLimit(input.limit)).map(row => mapHumanEvent(row as Row));
  }
  createRunEvaluationHumanIntent(input: CreateRunEvaluationHumanIntentInput): RunEvaluationHumanMutationResult<RunEvaluationHumanIntentV1> {
    validateHumanInput(input, "create");
    input = freezeHumanJson({ ...input, binding: copyHumanBinding(input.binding), submission: JSON.parse(JSON.stringify(input.submission)) as RunEvaluationHumanSubmissionV1 });
    return this.mutate(() => {
      const existingRow = this.context.database.prepare("SELECT * FROM run_evaluation_human_intents WHERE request_id=?").get(input.requestId) as Row | undefined;
      if (existingRow) {
        const existing = mapHumanIntent(existingRow);
        if (existing.payload.taskId !== input.taskId || !equalHumanBinding(existing.payload.binding, input.binding) || !semanticEqual(existing.payload.submission, input.submission)) return fail("identity_conflict");
        if (existing.state === "pending") {
          this.assertPending(existingRow, existing, input.now);
          if (!semanticEqual(this.facts(input.taskId), payloadFacts(existing.payload))) return fail("identity_conflict");
          this.assertHead(existing.payload);
        }
        // Retry never extends the original expiry or replaces its exact frozen payload.
        return ok(existing, true);
      }
      const facts = this.facts(input.taskId), head = this.getRunEvaluationHumanHead(input.taskId);
      this.assertTransition(input.submission, head);
      const id = `evaluation_human_intent_${randomUUID()}`;
      const payload: RunEvaluationHumanPayloadV1 = {
        schemaVersion: 1, intentId: id, requestId: input.requestId, ...facts,
        expectedHeadRevision: head?.revision ?? 0,
        ...(head ? { expectedHeadEventId: head.eventId } : {}),
        submission: JSON.parse(JSON.stringify(input.submission)) as RunEvaluationHumanSubmissionV1,
        binding: copyHumanBinding(input.binding), expiresAt: input.expiresAt,
      };
      const json = JSON.stringify(payload), digest = humanPayloadSha(json);
      this.context.database.prepare("INSERT INTO run_evaluation_human_intents(id,schema_version,request_id,task_id,payload_json,payload_digest,boot_epoch,expires_at,state,created_at) VALUES(?,1,?,?,?,?,?,?,'pending',?)").run(id, input.requestId, input.taskId, json, digest, PROCESS_BOOT_EPOCH, input.expiresAt, input.now);
      return ok(this.getRunEvaluationHumanIntent(id)!);
    });
  }
  commitRunEvaluationHumanIntent(input: CommitRunEvaluationHumanIntentInput): RunEvaluationHumanMutationResult<RunEvaluationHumanSettlement> {
    validateHumanInput(input, "commit");
    input = freezeHumanJson({ ...input, binding: copyHumanBinding(input.binding), confirmation: { ...input.confirmation } });
    return this.mutate(() => {
      this.assertAuthority(input);
      const row = this.intentRow(input.intentId);
      if (!row) return fail("not_found");
      const intent = mapHumanIntent(row), { payload } = intent;
      if (intent.payloadDigest !== input.payloadDigest) return fail("identity_conflict");
      if (!equalHumanBinding(payload.binding, input.binding)) return fail("human_binding_changed");
      if (input.confirmation.requestId !== payload.requestId || input.confirmation.payloadDigest !== intent.payloadDigest || input.confirmation.confirmedAt < intent.createdAt || input.confirmation.confirmedAt >= payload.expiresAt || input.confirmation.confirmedAt > input.now) return fail("human_confirmation_invalid");
      if (intent.state === "consumed") {
        const event = this.getRunEvaluationHumanEvent(intent.consumedEventId!), head = this.getRunEvaluationHumanHead(payload.taskId), audit = this.controlPlane.getControlPlaneEventByIdempotency(DEFAULT_WORKSPACE_ID, auditKey(intent.id));
        if (!event || !head || !audit || event.intentId !== intent.id || event.payloadDigest !== intent.payloadDigest || event.auditSeq !== audit.seq || audit.entityId !== event.id || !semanticEqual(event.confirmation, input.confirmation)) return fail("identity_conflict");
        this.assertAuthority(input);
        // Historical exact replay cannot re-consume, revive a tombstone, write another audit, or grant fresh authority.
        return ok({ intent, head, event, audit }, true);
      }
      this.assertPending(row, intent, input.now);
      if (!semanticEqual(this.facts(payload.taskId), payloadFacts(payload))) return fail("identity_conflict");
      this.assertHead(payload);
      const head = this.getRunEvaluationHumanHead(payload.taskId);
      this.assertTransition(payload.submission, head);
      const revision = payload.expectedHeadRevision + 1;
      if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) return fail("human_invalid_transition");
      const eventId = `evaluation_human_event_${randomUUID()}`;
      const audit = this.controlPlane.appendControlPlaneEventWithinTransaction({ workspaceId: DEFAULT_WORKSPACE_ID, cwd: payload.canonicalWorkspaceCwd, domain: "runs", entityType: "run_evaluation_human_event", entityId: eventId,
        action: `human_evaluation.${payload.submission.kind}`, idempotencyKey: auditKey(intent.id),
        data: { taskId: payload.taskId, enrollmentId: payload.enrollmentId, evaluationId: payload.evaluationId, intentId: intent.id, revision, payloadDigest: intent.payloadDigest, submissionKind: payload.submission.kind } }, input.now);
      this.context.database.prepare("INSERT INTO run_evaluation_human_events(id,schema_version,task_id,enrollment_id,evaluation_id,intent_id,revision,previous_event_id,submission_json,payload_digest,confirmation_json,audit_seq,created_at) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?)")
        .run(eventId, payload.taskId, payload.enrollmentId, payload.evaluationId, intent.id, revision, head?.eventId ?? null, JSON.stringify(payload.submission), intent.payloadDigest, JSON.stringify(input.confirmation), audit.seq, input.now);
      const state = payload.submission.kind === "revoke" ? "revoked" : "active";
      if (head) this.changed(this.context.database.prepare("UPDATE run_evaluation_human_heads SET revision=?,event_id=?,state=?,updated_at=? WHERE task_id=? AND revision=? AND event_id=? AND state='active'").run(revision, eventId, state, input.now, payload.taskId, head.revision, head.eventId).changes);
      else this.changed(this.context.database.prepare("INSERT INTO run_evaluation_human_heads(task_id,schema_version,enrollment_id,evaluation_id,revision,event_id,state,updated_at) VALUES(?,1,?,?,?,?,?,?)").run(payload.taskId, payload.enrollmentId, payload.evaluationId, revision, eventId, state, input.now).changes);
      this.changed(this.context.database.prepare("UPDATE run_evaluation_human_intents SET state='consumed',consumed_at=?,consumed_event_id=? WHERE id=? AND state='pending' AND payload_digest=? AND boot_epoch=?").run(input.now, eventId, intent.id, intent.payloadDigest, PROCESS_BOOT_EPOCH).changes);
      const settlement = { intent: this.getRunEvaluationHumanIntent(intent.id)!, head: this.getRunEvaluationHumanHead(payload.taskId)!, event: this.getRunEvaluationHumanEvent(eventId)!, audit };
      // Last operation before owned COMMIT; every synchronous evidence/audit callback may invalidate authority.
      this.assertAuthority(input);
      return ok(settlement);
    });
  }
  private facts(taskId: string): Facts {
    const scope = this.qa.getRunEvaluationQaScope(), enrollment = this.qa.getRunEvaluationQaEnrollment(taskId), task = this.tasks.getRunEvaluationTask(taskId);
    if (!scope || !enrollment) throw new HumanAbort("qa_not_enrolled");
    if (!task) throw new HumanAbort("not_found");
    const evaluation = this.tasks.validateTaskWithinTransaction(task), batch = this.qa.getRunEvaluationQaBatch(enrollment.batchId);
    if (!batch || batch.namespaceId !== scope.namespaceId || enrollment.evaluationId !== evaluation.id || enrollment.evaluationKey !== task.evaluationKey || enrollment.frozenGraderDigest !== task.frozenGraderDigest) throw new HumanAbort("identity_conflict");
    for (const prefix of ["suite", "case", "baseline", "candidate"] as const) {
      const pin = enrollment.artifactPins[prefix];
      if (pin.artifactId !== evaluation[`${prefix}ArtifactId`] || pin.contentSha256 !== evaluation[`${prefix}Digest`]) throw new HumanAbort("identity_conflict");
    }
    if (!semanticEqual(enrollment.artifactPins.frozen, task.frozenGraderArtifact)) throw new HumanAbort("identity_conflict");
    const artifact = this.getArtifact(batch.configSnapshotRef);
    if (!artifact || !artifact.contentSha256 || artifact.sealedPayload === undefined) throw new HumanAbort("evaluation.artifact_invalid");
    validateTaskArtifactJson(artifact.sealedPayload);
    if (artifact.contentSha256 !== batch.configArtifactSha256 || humanPayloadSha(JSON.stringify(artifact.sealedPayload)) !== batch.configArtifactSha256 || digestRunEvaluationValue(artifact.sealedPayload) !== batch.configDigest) throw new HumanAbort("evaluation.artifact_invalid");
    const snapshot = artifact.sealedPayload as { readonly schemaVersion?: unknown; readonly input?: { readonly rubric?: unknown } };
    let rubric: Facts["rubric"];
    try {
      if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.schemaVersion !== 1 || !snapshot.input || typeof snapshot.input !== "object" || Array.isArray(snapshot.input)) throw new HumanAbort("human_rubric_invalid");
      validateHumanRubric(snapshot.input.rubric);
      const value = snapshot.input.rubric as Facts["rubric"];
      rubric = { id: value.id, version: value.version, instructions: value.instructions };
      if (digestRunEvaluationValue(rubric) !== task.frozenGrader.rubricDigest) throw new HumanAbort("human_rubric_invalid");
    } catch { throw new HumanAbort("human_rubric_invalid"); }
    return { namespaceId: scope.namespaceId, canonicalWorkspaceCwd: scope.canonicalWorkspaceCwd, taskId, enrollmentId: enrollment.id, evaluationId: evaluation.id, evaluationKey: task.evaluationKey,
      artifactPins: enrollment.artifactPins, configArtifact: { artifactId: artifact.id, contentSha256: batch.configArtifactSha256 }, configDigest: batch.configDigest, frozenGraderDigest: task.frozenGraderDigest, rubric, rubricDigest: task.frozenGrader.rubricDigest };
  }
  private assertTransition(submission: RunEvaluationHumanSubmissionV1, head: RunEvaluationHumanHeadV1 | undefined): void {
    if (submission.kind === "adjudicate" ? head !== undefined : !head || head.state !== "active" || (submission.kind === "correct" ? submission.supersedesEventId : submission.revokesEventId) !== head.eventId) throw new HumanAbort("human_invalid_transition");
  }
  private assertHead(payload: RunEvaluationHumanPayloadV1): void {
    const head = this.getRunEvaluationHumanHead(payload.taskId);
    if ((head?.revision ?? 0) !== payload.expectedHeadRevision || head?.eventId !== payload.expectedHeadEventId) throw new HumanAbort("human_head_changed");
  }
  private assertPending(row: Row, intent: RunEvaluationHumanIntentV1, now: string): void {
    if (row.boot_epoch !== PROCESS_BOOT_EPOCH) throw new HumanAbort("human_binding_changed");
    if (now < intent.createdAt || now >= intent.payload.expiresAt) throw new HumanAbort("human_intent_expired");
  }
  private assertAuthority(input: CommitRunEvaluationHumanIntentInput): void {
    try {
      const result: unknown = input.assertAuthorityCurrent();
      if (result !== undefined) {
        // A void type accepts async functions in TypeScript. Never treat their Promise as synchronous authority.
        void Promise.resolve(result).catch(() => {});
        throw new HumanAbort("human_binding_changed");
      }
    } catch { throw new HumanAbort("human_binding_changed"); }
  }
  private intentRow(id: string): Row | undefined { return this.context.database.prepare("SELECT * FROM run_evaluation_human_intents WHERE id=?").get(id) as Row | undefined; }
  private changed(changes: number | bigint): void { if (changes !== 1 && changes !== 1n) throw new HumanAbort("human_head_changed"); }
  private mutate<T>(operation: () => RunEvaluationHumanMutationResult<T>): RunEvaluationHumanMutationResult<T> {
    this.context.database.exec("BEGIN IMMEDIATE;");
    try { const result = operation(); this.context.database.exec("COMMIT;"); return result; }
    catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      if (error instanceof HumanAbort) return fail(error.code);
      if (error instanceof EvidenceError && ["identity_conflict", "evaluation.lineage_invalid", "evaluation.artifact_invalid"].includes(error.code)) return fail(error.code as RunEvaluationHumanMutationCode);
      throw new RunEvaluationInputError("evaluation.task_invalid");
    }
  }
}
function payloadFacts(payload: RunEvaluationHumanPayloadV1): Facts {
  const { namespaceId, canonicalWorkspaceCwd, taskId, enrollmentId, evaluationId, evaluationKey, artifactPins, configArtifact, configDigest, frozenGraderDigest, rubric, rubricDigest } = payload;
  return { namespaceId, canonicalWorkspaceCwd, taskId, enrollmentId, evaluationId, evaluationKey, artifactPins, configArtifact, configDigest, frozenGraderDigest, rubric, rubricDigest };
}
function semanticEqual(left: unknown, right: unknown): boolean { return digestRunEvaluationValue(left) === digestRunEvaluationValue(right); }
function auditKey(intentId: string): string { return `human-evaluation:${intentId}`; }
function ok<T>(value: T, replayed = false): RunEvaluationHumanMutationResult<T> { return { ok: true, value, replayed }; }
function fail(code: RunEvaluationHumanMutationCode): { readonly ok: false; readonly code: RunEvaluationHumanMutationCode } { return { ok: false, code }; }
