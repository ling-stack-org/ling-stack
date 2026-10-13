import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { RunEvaluationHumanEventV1, RunEvaluationHumanHeadV1, RunEvaluationHumanIntentV1 } from "@ling-stack/contracts";
import { RunEvaluationInputError } from "../../harness/evaluation-json.js";
import { freezeHumanJson } from "./run-evaluation-human-validation.js";
type Row = Record<string, SQLOutputValue>;
export function humanPayloadSha(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
export function mapHumanIntent(row: Row): RunEvaluationHumanIntentV1 {
  const payload = JSON.parse(row.payload_json as string) as RunEvaluationHumanIntentV1["payload"];
  if (humanPayloadSha(JSON.stringify(payload)) !== row.payload_digest || payload.intentId !== row.id || payload.requestId !== row.request_id || payload.taskId !== row.task_id || payload.expiresAt !== row.expires_at) throw new RunEvaluationInputError("evaluation.task_invalid");
  return freezeHumanJson({ schemaVersion: 1, id: row.id as string, payload, payloadDigest: row.payload_digest as string, state: row.state as RunEvaluationHumanIntentV1["state"], createdAt: row.created_at as string,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at as string, consumedEventId: row.consumed_event_id as string }) });
}
export function mapHumanHead(row: Row): RunEvaluationHumanHeadV1 {
  return freezeHumanJson({ schemaVersion: 1, taskId: row.task_id as string, enrollmentId: row.enrollment_id as string, evaluationId: row.evaluation_id as string, revision: row.revision as number, eventId: row.event_id as string, state: row.state as RunEvaluationHumanHeadV1["state"], updatedAt: row.updated_at as string });
}
export function mapHumanEvent(row: Row): RunEvaluationHumanEventV1 {
  return freezeHumanJson({ schemaVersion: 1, id: row.id as string, taskId: row.task_id as string, enrollmentId: row.enrollment_id as string, evaluationId: row.evaluation_id as string, intentId: row.intent_id as string, revision: row.revision as number,
    submission: JSON.parse(row.submission_json as string) as RunEvaluationHumanEventV1["submission"], payloadDigest: row.payload_digest as string,
    confirmation: JSON.parse(row.confirmation_json as string) as RunEvaluationHumanEventV1["confirmation"], auditSeq: row.audit_seq as number, createdAt: row.created_at as string });
}
