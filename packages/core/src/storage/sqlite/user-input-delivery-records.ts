import { parseUserInputAnswerSubmissionV1, validateUserInputAnswerForRequestV1 } from "@ling-stack/contracts";
import type { RunStore } from "../../run-types.js";
import { ConversationItemStoreError } from "../../conversation-item-store-types.js";
import type { UserInputDelivery, UserInputDeliveryRetryCode } from "../../user-input-delivery-types.js";
import { UserInputStoreError, type UserInputRequest, type UserInputAcceptedAnswer } from "../../user-input-store-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import { assertNonSensitiveUserInput, userInputHash, userInputTimestamp, type UserInputRow } from "./user-input-records.js";
import { readString, readNullableString } from "./helpers.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readUserInputRunEventPosition } from "./user-input-event-position.js";

export type UserInputDeliveryReadPorts = Pick<RunStore, "getUserInputRequest" | "getConversationItem">;
export function validDeliveryKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
export function validDeliveryRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
}
export const deliveryRetryCodes: readonly UserInputDeliveryRetryCode[] = ["receiver_unavailable", "receiver_rejected", "recoverable_failure"];

/** Used inside a caller-owned transaction. Corrupt records fail closed rather than becoming retryable work. */
export function mapUserInputDelivery(row: UserInputRow): UserInputDelivery {
  try {
    const status = row.status as UserInputDelivery["status"];
    const claimOwner = readNullableString(row, "claim_owner_id"), token = readNullableString(row, "claim_token");
    const expiry = readNullableString(row, "claim_expires_at"), retryAt = readNullableString(row, "retry_at") ?? null;
    const successorRunId = readNullableString(row, "successor_run_id") ?? null;
    const lastErrorCode = (readNullableString(row, "last_error_code") ?? null) as UserInputDeliveryRetryCode | null;
    const createdAt = readString(row, "created_at"), updatedAt = readString(row, "updated_at");
    if (!["pending", "claimed", "applied", "failed", "obsolete"].includes(status)
      || !validDeliveryRevision(row.status_revision) || !Number.isSafeInteger(row.attempt_count) || Number(row.attempt_count) < 0
      || row.request_version !== 1 || userInputTimestamp(updatedAt) < userInputTimestamp(createdAt)
      || (lastErrorCode !== null && !deliveryRetryCodes.includes(lastErrorCode))
      || (successorRunId !== null && !validDeliveryKey(successorRunId))) throw new Error("invalid");
    if (status === "claimed") {
      if (!validDeliveryKey(claimOwner) || !validDeliveryKey(token) || !expiry || !successorRunId || Number(row.attempt_count) < 1
        || retryAt || userInputTimestamp(expiry) <= userInputTimestamp(updatedAt)) throw new Error("invalid");
    } else if (claimOwner !== undefined || token !== undefined || expiry !== undefined) throw new Error("invalid");
    if (status === "failed") {
      if (!retryAt || !lastErrorCode || !successorRunId || Number(row.attempt_count) < 1
        || userInputTimestamp(retryAt) < userInputTimestamp(updatedAt)) throw new Error("invalid");
    } else if (retryAt !== null) throw new Error("invalid");
    if (status === "pending" && (Number(row.attempt_count) !== 0 || successorRunId || lastErrorCode)) throw new Error("invalid");
    return {
      deliveryId: readString(row, "delivery_id"), answerId: readString(row, "answer_id"),
      requestId: readString(row, "request_id"), requestVersion: 1, threadId: readString(row, "thread_id"),
      consumerWorkUnitId: readString(row, "consumer_work_unit_id"), status, revision: Number(row.status_revision),
      attemptCount: Number(row.attempt_count), createdAt, updatedAt, successorRunId,
      claim: status === "claimed" ? { ownerId: claimOwner!, token: token!, expiresAt: expiry! } : null, retryAt, lastErrorCode,
    };
  } catch { throw new UserInputStoreError("invalid_record"); }
}

/** Scope is enforced before decoding content; one caller-owned read/write transaction owns all reads. */
export function readUserInputDelivery(context: SqliteStoreContext, ports: UserInputDeliveryReadPorts, threadId: string, deliveryId: string):
  { readonly delivery: UserInputDelivery; readonly request: UserInputRequest; readonly answer: UserInputAcceptedAnswer } | undefined {
  const { database } = context;
  const row = database.prepare("SELECT d.*, a.request_id, a.request_version, r.thread_id FROM user_input_deliveries d"
    + " JOIN user_input_answers a ON a.answer_id=d.answer_id JOIN user_input_requests r ON r.request_id=a.request_id"
    + " WHERE r.workspace_id=? AND r.thread_id=? AND d.delivery_id=?").get(DEFAULT_WORKSPACE_ID, threadId, deliveryId);
  if (!row) return undefined;
  const delivery = mapUserInputDelivery(row);
  // Storage/port failures must propagate. Only decoding and consistency failures below become invalid_record.
  const request = ports.getUserInputRequest(threadId, delivery.requestId);
  const answer = database.prepare("SELECT * FROM user_input_answers WHERE answer_id=?").get(delivery.answerId);
  if (!request || !answer) throw new UserInputStoreError("invalid_record");
  const requestItem = readCanonicalItem(ports, request.itemId);
  const answerItem = readCanonicalItem(ports, readString(answer, "answer_item_id"));
  try {
    if (!request || !answer || request.source.fence.workUnitId !== delivery.consumerWorkUnitId
      || request.requestVersion !== delivery.requestVersion || answer.request_version !== delivery.requestVersion) throw new Error("invalid");
    const parsed = parseUserInputAnswerSubmissionV1(JSON.parse(readString(answer, "submission_json")));
    if (!parsed.ok) throw new Error("invalid");
    const submission = { ...parsed.value, answers: [...parsed.value.answers].sort((a, b) => a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0) };
    const acceptedAt = readString(answer, "accepted_at");
    if (submission.requestId !== request.requestId || submission.expectedVersion !== request.requestVersion
      || submission.idempotencyKey !== answer.idempotency_key || userInputHash(submission) !== answer.submission_fingerprint
      || request.statusRevision <= submission.expectedStatusRevision || delivery.createdAt !== acceptedAt) throw new Error("invalid");
    assertNonSensitiveUserInput(submission);
    const validated = validateUserInputAnswerForRequestV1(submission,
      { ...request, status: "pending", statusRevision: submission.expectedStatusRevision }, userInputTimestamp(acceptedAt));
    if (!validated.ok) throw new Error("invalid");
    for (const [item, kind, payload] of [
      [requestItem, "user_input_request", { requestId: request.requestId, requestVersion: request.requestVersion }],
      [answerItem, "user_input_answer", { requestId: request.requestId, requestVersion: request.requestVersion, answerId: delivery.answerId }],
    ] as const) {
      if (!item || item.kind !== kind || item.status !== "committed" || item.workspaceId !== request.source.workspaceId
        || item.threadId !== threadId || item.turnId !== request.source.turnId || item.channelId !== request.source.channelId
        || item.visibility !== request.source.visibility || item.visibilityOwnerId !== request.source.visibilityOwnerId
        || userInputHash(item.payload) !== userInputHash({ ...payload,
          ...(item.payload.runEventPosition ? { runEventPosition: item.payload.runEventPosition } : {}) })) throw new Error("invalid");
      readUserInputRunEventPosition(context, item.payload.runEventPosition, request.source);
      if (kind === "user_input_answer" ? item.actorType !== "local_user"
        : item.actorId !== request.source.participantId
          || item.actorType !== (request.source.participantId === "ling_agent" ? "ling_agent" : "teammate")) throw new Error("invalid");
    }
    const requestPosition = requestItem?.kind === "user_input_request" ? requestItem.payload.runEventPosition : undefined;
    const answerPosition = answerItem?.kind === "user_input_answer" ? answerItem.payload.runEventPosition : undefined;
    if (requestPosition && (!answerPosition || answerPosition.afterEventSequence < requestPosition.afterEventSequence)) throw new Error("invalid");
    return { delivery, request, answer: { answerId: delivery.answerId,
      itemId: readString(answer, "answer_item_id"), acceptedAt, answers: validated.value.answers } };
  } catch { throw new UserInputStoreError("invalid_record"); }
}

export function readCanonicalItem(ports: UserInputDeliveryReadPorts, id: string) {
  try { return ports.getConversationItem(id); }
  catch (error) {
    if (error instanceof ConversationItemStoreError && error.code === "item_invalid") {
      throw new UserInputStoreError("invalid_record");
    }
    throw error;
  }
}
