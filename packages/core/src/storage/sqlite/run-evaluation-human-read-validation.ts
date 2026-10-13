import { RUN_EVALUATION_TASK_STATES, type RunEvaluationHumanEventV1, type RunEvaluationHumanHeadV1, type RunEvaluationHumanIntentV1, type RunEvaluationHumanReportRefV1, type RunEvaluationHumanReportReadReason } from "@ling-stack/contracts";
import type { ListRunEvaluationHumanEnrollmentsInput } from "../../harness/human-evaluation-read.js";
import { digestRunEvaluationValue, RunEvaluationInputError } from "../../harness/evaluation-json.js";
import { humanPayloadSha } from "./run-evaluation-human-mappers.js";
import { validateHumanBinding, validateHumanRubric, validateHumanSubmission } from "./run-evaluation-human-validation.js";
import { taskDigest, taskIdentity, taskInteger, taskRecord, taskTime, validateTaskArtifactPin } from "./run-evaluation-task-validation.js";
import type { ControlPlaneEvent } from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
export class HumanReadRefusal extends Error { constructor(readonly reason: RunEvaluationHumanReportReadReason) { super(reason); } }
export function humanListLimit(input: ListRunEvaluationHumanEnrollmentsInput): number {
  const record = taskRecord(input, ["afterEnrollmentId", "limit"], ["afterEnrollmentId", "limit"]);
  if (Object.hasOwn(record, "afterEnrollmentId")) taskIdentity(record.afterEnrollmentId);
  if (!Object.hasOwn(record, "limit")) return 25;
  taskInteger(record.limit, 1);
  if (record.limit > 50) throw new RunEvaluationInputError("evaluation.task_invalid");
  return record.limit;
}
export function validateHumanReportRef(value: unknown): asserts value is RunEvaluationHumanReportRefV1 {
  const ref = taskRecord(value, ["taskId", "eventId", "revision"]);
  taskIdentity(ref.taskId); taskIdentity(ref.eventId); taskInteger(ref.revision, 1);
}
export function validateHumanReadEvent(event: RunEvaluationHumanEventV1): void {
  taskRecord(event, ["schemaVersion", "id", "taskId", "enrollmentId", "evaluationId", "intentId", "revision", "submission", "payloadDigest", "confirmation", "auditSeq", "createdAt"]);
  if (event.schemaVersion !== 1) refuse("lineage_invalid");
  for (const field of ["id", "taskId", "enrollmentId", "evaluationId", "intentId"] as const) taskIdentity(event[field]);
  taskInteger(event.revision, 1); taskInteger(event.auditSeq, 1); taskDigest(event.payloadDigest); taskTime(event.createdAt); validateHumanSubmission(event.submission);
  const confirmation = taskRecord(event.confirmation, ["kind", "requestId", "payloadDigest", "confirmedAt"]);
  if (confirmation.kind !== "macos_device_owner_authentication") refuse("lineage_invalid");
  taskIdentity(confirmation.requestId); taskDigest(confirmation.payloadDigest); taskTime(confirmation.confirmedAt);
  if (confirmation.payloadDigest !== event.payloadDigest || confirmation.confirmedAt > event.createdAt) refuse("lineage_invalid");
}
export function validateHumanReadHead(head: RunEvaluationHumanHeadV1): void {
  taskRecord(head, ["schemaVersion", "taskId", "enrollmentId", "evaluationId", "revision", "eventId", "state", "updatedAt"]);
  if (head.schemaVersion !== 1 || !["active", "revoked"].includes(head.state)) refuse("lineage_invalid");
  for (const field of ["taskId", "enrollmentId", "evaluationId", "eventId"] as const) taskIdentity(head[field]);
  taskInteger(head.revision, 1); taskTime(head.updatedAt);
}
export function validateHumanReadIntent(intent: RunEvaluationHumanIntentV1, event: RunEvaluationHumanEventV1): void {
  taskRecord(intent, ["schemaVersion", "id", "payload", "payloadDigest", "state", "createdAt", "consumedAt", "consumedEventId"]);
  const payload = taskRecord(intent.payload, ["schemaVersion", "intentId", "requestId", "namespaceId", "canonicalWorkspaceCwd", "taskId", "enrollmentId", "evaluationId", "evaluationKey", "artifactPins", "configArtifact", "configDigest", "frozenGraderDigest", "rubric", "rubricDigest", "expectedHeadRevision", "expectedHeadEventId", "submission", "binding", "expiresAt"], ["expectedHeadEventId"]);
  for (const field of ["intentId", "requestId", "namespaceId", "canonicalWorkspaceCwd", "taskId", "enrollmentId", "evaluationId"] as const) taskIdentity(payload[field]);
  for (const field of ["configDigest", "frozenGraderDigest", "rubricDigest"] as const) taskDigest(payload[field]);
  if (typeof payload.evaluationKey !== "string" || !/^run-evaluation:[a-f0-9]{64}$/u.test(payload.evaluationKey)) refuse("lineage_invalid");
  const pins = taskRecord(payload.artifactPins, ["suite", "case", "baseline", "candidate", "frozen"]);
  for (const pin of Object.values(pins)) validateTaskArtifactPin(pin);
  validateTaskArtifactPin(payload.configArtifact); validateHumanRubric(payload.rubric); validateHumanBinding(payload.binding); validateHumanSubmission(payload.submission);
  taskInteger(payload.expectedHeadRevision); if (Object.hasOwn(payload, "expectedHeadEventId")) taskIdentity(payload.expectedHeadEventId);
  taskTime(payload.expiresAt); taskTime(intent.createdAt); taskTime(intent.consumedAt);
  if (intent.schemaVersion !== 1 || payload.schemaVersion !== 1 || intent.state !== "consumed" || intent.id !== event.intentId || payload.intentId !== intent.id
    || payload.taskId !== event.taskId || payload.enrollmentId !== event.enrollmentId || payload.evaluationId !== event.evaluationId || intent.consumedEventId !== event.id || intent.consumedAt !== event.createdAt
    || payload.expectedHeadRevision + 1 !== event.revision || intent.payloadDigest !== event.payloadDigest || humanPayloadSha(JSON.stringify(intent.payload)) !== intent.payloadDigest
    || !sameHumanReadValue(payload.submission, event.submission) || payload.requestId !== event.confirmation.requestId
    || event.confirmation.confirmedAt < intent.createdAt || event.confirmation.confirmedAt >= payload.expiresAt || intent.createdAt >= payload.expiresAt) refuse("lineage_invalid");
  if (event.submission.kind === "adjudicate" ? payload.expectedHeadRevision !== 0 || Object.hasOwn(payload, "expectedHeadEventId")
    : payload.expectedHeadRevision < 1 || payload.expectedHeadEventId !== (event.submission.kind === "correct" ? event.submission.supersedesEventId : event.submission.revokesEventId)) refuse("lineage_invalid");
}
export function validateHumanReadAudit(audit: ControlPlaneEvent, intent: RunEvaluationHumanIntentV1, event: RunEvaluationHumanEventV1): void {
  taskRecord(audit, ["seq", "workspaceId", "cwd", "ts", "domain", "entityType", "entityId", "action", "data", "idempotencyKey"]);
  taskRecord(audit.data, ["taskId", "enrollmentId", "evaluationId", "intentId", "revision", "payloadDigest", "submissionKind"]);
  const expectedData = { taskId: event.taskId, enrollmentId: event.enrollmentId, evaluationId: event.evaluationId, intentId: intent.id, revision: event.revision, payloadDigest: intent.payloadDigest, submissionKind: event.submission.kind };
  if (audit.seq !== event.auditSeq || audit.workspaceId !== DEFAULT_WORKSPACE_ID || audit.cwd !== intent.payload.canonicalWorkspaceCwd || audit.ts !== event.createdAt || audit.domain !== "runs"
    || audit.entityType !== "run_evaluation_human_event" || audit.entityId !== event.id || audit.action !== `human_evaluation.${event.submission.kind}` || audit.idempotencyKey !== `human-evaluation:${intent.id}` || !sameHumanReadValue(audit.data, expectedData)) refuse("audit_invalid");
}
export function validateHumanTaskState(value: unknown): void { if (!(RUN_EVALUATION_TASK_STATES as readonly unknown[]).includes(value)) throw new RunEvaluationInputError("evaluation.task_invalid"); }
export function sameHumanReadValue(left: unknown, right: unknown): boolean { return digestRunEvaluationValue(left) === digestRunEvaluationValue(right); }
function refuse(reason: RunEvaluationHumanReportReadReason): never { throw new HumanReadRefusal(reason); }
