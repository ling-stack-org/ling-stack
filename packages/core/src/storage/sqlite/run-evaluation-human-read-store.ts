import type { SQLOutputValue } from "node:sqlite";
import type { RunEvaluationHumanQaPageV1, RunEvaluationHumanQaRowV1, RunEvaluationHumanReportRefV1, RunEvaluationHumanReportSourceResultV1, RunEvaluationHumanReportSourceV1, RunEvaluationHumanIntentV1, RunEvaluationHumanEventV1, RunEvaluationHumanReportReadReason } from "@ling-stack/contracts";
import type { RunEvaluationHumanReadStore, ListRunEvaluationHumanEnrollmentsInput } from "../../harness/human-evaluation-read.js";
import type { RunEvaluationHumanStore } from "../../harness/human-evaluation.js";
import { digestRunEvaluationValue, RunEvaluationInputError } from "../../harness/evaluation-json.js";
import type { RunArtifact } from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import { EvidenceError, type SqliteRunEvaluationTaskStore } from "./run-evaluation-task-store.js";
import type { SqliteRunEvaluationQaStore } from "./run-evaluation-qa-store.js";
import { humanPayloadSha } from "./run-evaluation-human-mappers.js";
import { freezeHumanJson, validateHumanRubric } from "./run-evaluation-human-validation.js";
import { humanListLimit, HumanReadRefusal, sameHumanReadValue, validateHumanReadAudit, validateHumanReadEvent, validateHumanReadHead, validateHumanReadIntent, validateHumanReportRef, validateHumanTaskState } from "./run-evaluation-human-read-validation.js";
import { taskIdentity, taskInteger, taskTime, validateTaskArtifactJson } from "./run-evaluation-task-validation.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";
type Row = Record<string, SQLOutputValue>;
type HumanReadPorts = Pick<RunEvaluationHumanStore, "getRunEvaluationHumanEvent" | "getRunEvaluationHumanIntent" | "getRunEvaluationHumanHead">;

/** Own synchronous read snapshots only: no quota, history, human authority, grade or promotion mutation. */
export class SqliteRunEvaluationHumanReadStore implements RunEvaluationHumanReadStore {
  constructor(private readonly context: SqliteStoreContext, private readonly tasks: SqliteRunEvaluationTaskStore, private readonly qa: SqliteRunEvaluationQaStore, private readonly human: HumanReadPorts,
    private readonly controlPlane: Pick<SqliteControlPlaneStore, "getControlPlaneEventByIdempotency">, private readonly getArtifact: (id: string) => RunArtifact | undefined) {}

  listRunEvaluationHumanEnrollments(input: ListRunEvaluationHumanEnrollmentsInput = {}): RunEvaluationHumanQaPageV1 {
    const limit = humanListLimit(input), after = input.afterEnrollmentId;
    return readSqliteSnapshot(this.context.database, () => {
      const scope = this.qa.getRunEvaluationQaScope();
      if (!scope) return freezeHumanJson({ schemaVersion: 1, items: [] });
      if (after !== undefined && !this.context.database.prepare("SELECT 1 FROM run_evaluation_qa_enrollments e JOIN run_evaluation_qa_batches b ON b.id=e.batch_id WHERE e.id=? AND b.namespace_id=?").get(after, scope.namespaceId)) throw new RunEvaluationInputError("evaluation.task_invalid");
      // Enrollment namespace filtering precedes LIMIT; ordinary task/run prefixes cannot starve QA.
      // Every state is included. Metadata only: no sealed artifact, prompt, log or OS binding reads.
      const rows = this.context.database.prepare(`SELECT e.id AS enrollment_id,e.task_id,e.evaluation_id,e.created_at,t.state AS task_state,
        v.suite_id,v.suite_version,v.case_id,v.case_version,h.event_id AS head_event_id,h.revision AS head_revision,h.state AS head_state,
        h.enrollment_id AS head_enrollment_id,h.evaluation_id AS head_evaluation_id
        FROM run_evaluation_qa_enrollments e JOIN run_evaluation_qa_batches b ON b.id=e.batch_id
        JOIN run_evaluation_tasks t ON t.id=e.task_id AND t.evaluation_id=e.evaluation_id
        JOIN run_evaluations v ON v.id=e.evaluation_id
        LEFT JOIN run_evaluation_human_heads h ON h.task_id=e.task_id
        WHERE b.namespace_id=? ${after === undefined ? "" : "AND e.id>?"} ORDER BY e.id LIMIT ?`)
        .all(scope.namespaceId, ...(after === undefined ? [] : [after]), limit + 1);
      const items = rows.slice(0, limit).map(row => mapQaRow(row as Row));
      return freezeHumanJson({ schemaVersion: 1, items, ...(rows.length > limit ? { nextAfterEnrollmentId: items[items.length - 1]!.enrollmentId } : {}) });
    });
  }

  readRunEvaluationHumanReportSource(ref: RunEvaluationHumanReportRefV1): RunEvaluationHumanReportSourceResultV1 {
    validateHumanReportRef(ref);
    ref = freezeHumanJson({ taskId: ref.taskId, eventId: ref.eventId, revision: ref.revision });
    try {
      return readSqliteSnapshot(this.context.database, () => {
        const scope = this.qa.getRunEvaluationQaScope(), enrollment = this.qa.getRunEvaluationQaEnrollment(ref.taskId);
        if (!scope || !enrollment) refuse("qa_not_enrolled");
        const batch = this.qa.getRunEvaluationQaBatch(enrollment.batchId), task = this.tasks.getRunEvaluationTask(ref.taskId);
        if (!batch || batch.namespaceId !== scope.namespaceId || !task) refuse("lineage_invalid");
        const selected = this.eventEvidence(ref.eventId);
        const { event, intent, audit } = selected, payload = intent.payload;
        if (event.taskId !== ref.taskId || event.revision !== ref.revision) refuse("ref_conflict");
        if (payload.namespaceId !== scope.namespaceId || payload.canonicalWorkspaceCwd !== scope.canonicalWorkspaceCwd || enrollment.id !== event.enrollmentId
          || enrollment.evaluationId !== event.evaluationId || enrollment.evaluationKey !== payload.evaluationKey || task.evaluationId !== event.evaluationId
          || task.evaluationKey !== payload.evaluationKey || task.frozenGraderDigest !== payload.frozenGraderDigest || enrollment.frozenGraderDigest !== payload.frozenGraderDigest
          || !sameHumanReadValue(enrollment.artifactPins, payload.artifactPins) || !sameHumanReadValue(task.frozenGraderArtifact, payload.artifactPins.frozen)) refuse("lineage_invalid");
        const evaluation = checkedTaskEvidence(() => this.tasks.validateTaskWithinTransaction(task));
        for (const prefix of ["suite", "case", "baseline", "candidate"] as const) {
          if (payload.artifactPins[prefix].artifactId !== evaluation[`${prefix}ArtifactId`] || payload.artifactPins[prefix].contentSha256 !== evaluation[`${prefix}Digest`]) refuse("lineage_invalid");
        }
        if (payload.configArtifact.artifactId !== batch.configSnapshotRef || payload.configArtifact.contentSha256 !== batch.configArtifactSha256 || payload.configDigest !== batch.configDigest) refuse("lineage_invalid");
        const config = checked("artifact_invalid", () => {
          const artifact = this.getArtifact(batch.configSnapshotRef);
          if (!artifact || artifact.sealedPayload === undefined || artifact.contentSha256 !== batch.configArtifactSha256) refuse("artifact_invalid");
          validateTaskArtifactJson(artifact.sealedPayload);
          if (humanPayloadSha(JSON.stringify(artifact.sealedPayload)) !== batch.configArtifactSha256 || digestRunEvaluationValue(artifact.sealedPayload) !== batch.configDigest) refuse("artifact_invalid");
          return artifact.sealedPayload;
        });
        checked("artifact_invalid", () => {
          const value = config as { readonly schemaVersion?: unknown; readonly input?: { readonly rubric?: unknown } };
          if (value === null || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || !value.input || typeof value.input !== "object" || Array.isArray(value.input)) refuse("artifact_invalid");
          validateHumanRubric(value.input.rubric);
          if (!sameHumanReadValue(value.input.rubric, payload.rubric) || digestRunEvaluationValue(payload.rubric) !== payload.rubricDigest || payload.rubricDigest !== task.frozenGrader.rubricDigest) refuse("artifact_invalid");
        });
        const head = checked("lineage_invalid", () => this.human.getRunEvaluationHumanHead(ref.taskId));
        if (!head) refuse("lineage_invalid");
        checked("lineage_invalid", () => validateHumanReadHead(head));
        if (head.taskId !== ref.taskId || head.enrollmentId !== enrollment.id || head.evaluationId !== event.evaluationId || head.revision < event.revision) refuse("lineage_invalid");
        const latest = head.eventId === event.id ? selected : this.eventEvidence(head.eventId);
        if (latest.event.taskId !== ref.taskId || latest.event.enrollmentId !== enrollment.id || latest.event.evaluationId !== event.evaluationId
          || latest.event.revision !== head.revision || latest.event.createdAt !== head.updatedAt || (latest.event.submission.kind === "revoke" ? head.state !== "revoked" : head.state !== "active")) refuse("lineage_invalid");
        for (const field of ["namespaceId", "canonicalWorkspaceCwd", "evaluationKey", "artifactPins", "configArtifact", "configDigest", "frozenGraderDigest", "rubric", "rubricDigest"] as const) {
          if (!sameHumanReadValue(latest.intent.payload[field], payload[field])) refuse("lineage_invalid");
        }
        const source: RunEvaluationHumanReportSourceV1 = { schemaVersion: 1, ref, event, intent: { id: intent.id, payloadDigest: intent.payloadDigest },
          lineage: { enrollmentId: enrollment.id, batchId: batch.id, evaluationId: event.evaluationId, evaluationKey: payload.evaluationKey, artifactPins: payload.artifactPins, configArtifact: payload.configArtifact,
            configDigest: payload.configDigest, frozenGraderDigest: payload.frozenGraderDigest, rubric: payload.rubric, rubricDigest: payload.rubricDigest },
          audit: { seq: audit.seq, action: audit.action, createdAt: audit.ts }, head: { eventId: head.eventId, revision: head.revision, state: head.state },
          currentness: head.state === "active" && head.eventId === event.id && head.revision === event.revision ? "current" : "stale" };
        return freezeHumanJson({ status: "available", source });
      });
    } catch (error) {
      return freezeHumanJson({ status: "unavailable", reason: error instanceof HumanReadRefusal ? error.reason : "read_failed" });
    }
  }
  private eventEvidence(id: string) {
    const event = checked("lineage_invalid", () => this.human.getRunEvaluationHumanEvent(id));
    if (!event) refuse("ref_not_found");
    checked("lineage_invalid", () => validateHumanReadEvent(event));
    if (event.id !== id) refuse("lineage_invalid");
    const intent = checked("lineage_invalid", () => this.human.getRunEvaluationHumanIntent(event.intentId));
    if (!intent) refuse("lineage_invalid");
    checked("lineage_invalid", () => validateHumanReadIntent(intent, event));
    if (event.submission.kind !== "adjudicate") {
      const previousId = event.submission.kind === "correct" ? event.submission.supersedesEventId : event.submission.revokesEventId;
      const previous = checked("lineage_invalid", () => this.human.getRunEvaluationHumanEvent(previousId));
      if (!previous) refuse("lineage_invalid");
      checked("lineage_invalid", () => validateHumanReadEvent(previous));
      if (previous.id !== previousId || previous.taskId !== event.taskId || previous.enrollmentId !== event.enrollmentId || previous.evaluationId !== event.evaluationId || previous.revision + 1 !== event.revision || previous.submission.kind === "revoke") refuse("lineage_invalid");
    }
    const audit = checked("audit_invalid", () => this.controlPlane.getControlPlaneEventByIdempotency(DEFAULT_WORKSPACE_ID, `human-evaluation:${intent.id}`));
    if (!audit) refuse("audit_invalid");
    checked("audit_invalid", () => validateHumanReadAudit(audit, intent, event));
    return { event, intent, audit };
  }
}
function checked<T>(reason: RunEvaluationHumanReportReadReason, read: () => T): T {
  try { return read(); } catch (error) { if (error instanceof HumanReadRefusal) throw error; refuse(reason); }
}
function checkedTaskEvidence<T>(read: () => T): T {
  try { return read(); } catch (error) {
    if (error instanceof EvidenceError) refuse(error.code === "evaluation.artifact_invalid" ? "artifact_invalid" : "lineage_invalid");
    refuse("artifact_invalid");
  }
}
function refuse(reason: RunEvaluationHumanReportReadReason): never { throw new HumanReadRefusal(reason); }
function mapQaRow(row: Row): RunEvaluationHumanQaRowV1 {
  for (const key of ["enrollment_id", "task_id", "evaluation_id", "suite_id", "suite_version", "case_id", "case_version"] as const) taskIdentity(row[key]);
  taskTime(row.created_at); validateHumanTaskState(row.task_state);
  if (row.head_event_id !== null) {
    taskIdentity(row.head_event_id); taskInteger(row.head_revision, 1);
    if (!["active", "revoked"].includes(row.head_state as string) || row.head_enrollment_id !== row.enrollment_id || row.head_evaluation_id !== row.evaluation_id) throw new RunEvaluationInputError("evaluation.task_invalid");
  } else if ([row.head_revision, row.head_state, row.head_enrollment_id, row.head_evaluation_id].some(value => value !== null)) throw new RunEvaluationInputError("evaluation.task_invalid");
  return { enrollmentId: row.enrollment_id as string, taskId: row.task_id as string, evaluationId: row.evaluation_id as string, createdAt: row.created_at as string,
    taskState: row.task_state as RunEvaluationHumanQaRowV1["taskState"], suiteId: row.suite_id as string, suiteVersion: row.suite_version as string, caseId: row.case_id as string, caseVersion: row.case_version as string,
    ...(row.head_event_id === null ? {} : { head: { eventId: row.head_event_id as string, revision: row.head_revision as number, state: row.head_state as "active" | "revoked" } }) };
}
