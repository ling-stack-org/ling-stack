import { RUN_EVALUATION_SEVERITIES, RUN_EVALUATION_VERDICTS, type RunEvaluationHumanHostBindingV1, type RunEvaluationHumanSubmissionV1 } from "@ling-stack/contracts";
import { RunEvaluationInputError } from "../../harness/evaluation-json.js";
import { taskDigest, taskIdentity, taskInteger, taskLimit, taskRecord, taskTime } from "./run-evaluation-task-validation.js";

export const HUMAN_BINDING_FIELDS = ["daemonEpoch", "desktopInstanceId", "desktopEpoch", "connectionEpoch", "osSessionId", "osUserId", "lockEpoch"] as const;
export const HUMAN_INTENT_TTL_MS = 300_000;
export function validateHumanBinding(value: unknown): void {
  const binding = taskRecord(value, HUMAN_BINDING_FIELDS);
  for (const field of HUMAN_BINDING_FIELDS) taskIdentity(binding[field]);
}
export function copyHumanBinding(value: RunEvaluationHumanHostBindingV1): RunEvaluationHumanHostBindingV1 {
  return Object.fromEntries(HUMAN_BINDING_FIELDS.map(field => [field, value[field]])) as unknown as RunEvaluationHumanHostBindingV1;
}
export function equalHumanBinding(left: RunEvaluationHumanHostBindingV1, right: RunEvaluationHumanHostBindingV1): boolean {
  return HUMAN_BINDING_FIELDS.every(field => left[field] === right[field]);
}
export function validateHumanSubmission(value: unknown): asserts value is RunEvaluationHumanSubmissionV1 {
  const submission = taskRecord(value, ["kind", "decision", "supersedesEventId", "revokesEventId", "rationale"], ["decision", "supersedesEventId", "revokesEventId", "rationale"]);
  if (submission.kind === "revoke") {
    taskRecord(value, ["kind", "revokesEventId", "rationale"]);
    taskIdentity(submission.revokesEventId); humanText(submission.rationale);
  } else if (submission.kind === "adjudicate" || submission.kind === "correct") {
    taskRecord(value, submission.kind === "correct" ? ["kind", "supersedesEventId", "decision"] : ["kind", "decision"]);
    if (submission.kind === "correct") taskIdentity(submission.supersedesEventId);
    const decision = taskRecord(submission.decision, ["verdict", "score", "severity", "rationale"], ["score", "severity"]);
    if (!(RUN_EVALUATION_VERDICTS as readonly unknown[]).includes(decision.verdict)) invalid();
    if (Object.hasOwn(decision, "score") && (typeof decision.score !== "number" || !Number.isFinite(decision.score) || decision.score < 0 || decision.score > 1)) invalid();
    if (Object.hasOwn(decision, "severity") && !(RUN_EVALUATION_SEVERITIES as readonly unknown[]).includes(decision.severity)) invalid();
    humanText(decision.rationale);
  } else invalid();
}
export function validateHumanRubric(value: unknown): void {
  const rubric = taskRecord(value, ["id", "version", "instructions"]);
  taskIdentity(rubric.id); taskIdentity(rubric.version); humanText(rubric.instructions);
}
export function validateHumanInput(value: unknown, kind: "create" | "commit" | "list"): void {
  const input = taskRecord(value, kind === "create" ? ["taskId", "requestId", "submission", "binding", "expiresAt", "now"]
    : kind === "commit" ? ["intentId", "payloadDigest", "binding", "confirmation", "now", "assertAuthorityCurrent"]
      : ["taskId", "afterRevision", "limit"], kind === "list" ? ["afterRevision", "limit"] : []);
  if (kind === "list") {
    taskIdentity(input.taskId); taskLimit(input.limit);
    if (Object.hasOwn(input, "afterRevision")) taskInteger(input.afterRevision);
    return;
  }
  taskTime(input.now); validateHumanBinding(input.binding);
  if (kind === "create") {
    taskIdentity(input.taskId); taskIdentity(input.requestId); validateHumanSubmission(input.submission); taskTime(input.expiresAt);
    if (input.expiresAt <= input.now || Date.parse(input.expiresAt) - Date.parse(input.now) > HUMAN_INTENT_TTL_MS) invalid();
  } else {
    taskIdentity(input.intentId); taskDigest(input.payloadDigest);
    if (typeof input.assertAuthorityCurrent !== "function") invalid();
    const confirmation = taskRecord(input.confirmation, ["kind", "requestId", "payloadDigest", "confirmedAt"]);
    if (confirmation.kind !== "macos_device_owner_authentication") invalid();
    taskIdentity(confirmation.requestId); taskDigest(confirmation.payloadDigest); taskTime(confirmation.confirmedAt);
  }
}
/** Freeze the persisted own-data snapshot; callers cannot mutate the exact native approval payload. */
export function freezeHumanJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeHumanJson(item);
    Object.freeze(value);
  }
  return value;
}
function humanText(value: unknown): void {
  if (typeof value !== "string" || !value.trim().length || value.length > 4096 || value.includes("\0")) invalid();
}
function invalid(): never { throw new RunEvaluationInputError("evaluation.task_invalid"); }
