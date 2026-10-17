import { randomUUID } from "node:crypto";
import {
  parseUserInputToolInputV1, parseUserInputAnswerSubmissionV1, validateUserInputAnswerForRequestV1,
  type UserInputAnswerSubmissionV1,
} from "@ling-stack/contracts";
import {
  UserInputStoreError, type CancelUserInputRequest, type CreateUserInputRequest, type CreateUserInputRequestResult,
  type FindRequiredUserInputForAttempt, type ListPendingUserInputDeliveries, type PendingUserInputDelivery, type SubmitUserInputAnswer,
  type UserInputAnswerReceipt, type UserInputRequest, type UserInputSource,
} from "../../user-input-store-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteConversationItemStore } from "./conversation-item-store.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import { readString, rollbackOwnedSqliteTransaction } from "./helpers.js";
import { resolveActiveUserInputSource, type UserInputSourcePorts } from "./user-input-source.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import { assertUserInputAnswerAuthority, type UserInputAnswerAuthorityPorts } from "./user-input-answer-authority.js";
import { captureUserInputRunEventPosition } from "./user-input-event-position.js";
import {
  assertNonSensitiveUserInput, mapUserInputRequest, userInputCreateFingerprint,
  userInputHash, userInputTimestamp, type UserInputRow,
} from "./user-input-records.js";

/** Owns synchronous request/receipt/outbox transactions; never resumes runners or grants permissions. */
export class SqliteUserInputStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly items: SqliteConversationItemStore,
    private readonly events: SqliteControlPlaneStore,
    private readonly sources: UserInputSourcePorts & UserInputAnswerAuthorityPorts,
  ) {}

  create(input: CreateUserInputRequest, now: string): CreateUserInputRequestResult {
    const nowMs = userInputTimestamp(now);
    const parsed = parseUserInputToolInputV1(input.toolInput);
    if (!parsed.ok) throw new UserInputStoreError(parsed.error.code);
    if (!validKey(input.toolCallId) || !validKey(input.idempotencyKey) || !input.sourceFence
      || !validKey(input.sourceFence.attemptId)) throw new UserInputStoreError("invalid_input");
    const expiresMs = input.expiresAt === undefined ? undefined : userInputTimestamp(input.expiresAt);
    assertNonSensitiveUserInput(parsed.value);
    const fingerprint = userInputCreateFingerprint(input, parsed.value);
    return this.transaction(() => {
      const { database } = this.context;
      const existing = database.prepare(`SELECT * FROM user_input_requests
        WHERE workspace_id=? AND source_attempt_id=? AND (tool_call_id=? OR idempotency_key=?)`)
        .all(DEFAULT_WORKSPACE_ID, input.sourceFence.attemptId, input.toolCallId, input.idempotencyKey) as UserInputRow[];
      if (existing.length) {
        if (existing.length !== 1 || existing[0]!.input_fingerprint !== fingerprint) throw new UserInputStoreError("idempotency_conflict");
        return { request: mapUserInputRequest(existing[0]!), replayed: true };
      }
      if (expiresMs !== undefined && expiresMs <= nowMs) throw new UserInputStoreError("request_expired");
      const source = resolveActiveUserInputSource(this.sources, input);
      if (parsed.value.waitMode === "required" && this.requiredForSource(source.runId, source.fence.attemptId)) {
        throw new UserInputStoreError("wait_conflict");
      }
      const requestId = "uir_" + randomUUID();
      const item = this.items.appendConversationItemWithinTransaction({
        ...itemScope(source), kind: "user_input_request",
        actorType: source.participantId === "ling_agent" ? "ling_agent" : "teammate", actorId: source.participantId,
        payload: { requestId, requestVersion: 1, runEventPosition: captureUserInputRunEventPosition(this.context, source) },
        domainRefs: [{ type: "user_input_request", id: requestId }, { type: "run", id: source.runId },
          { type: "conversation_item", id: source.itemId }],
      }, now);
      database.prepare(`INSERT INTO user_input_requests (
        request_id, workspace_id, thread_id, request_version, status_revision, status,
        source_run_id, source_attempt_id, tool_call_id, idempotency_key, input_fingerprint,
        source_json, source_fingerprint, tool_input_json, item_id, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, 1, 1, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        requestId, DEFAULT_WORKSPACE_ID, source.threadId, source.runId, source.fence.attemptId,
        input.toolCallId, input.idempotencyKey, fingerprint, JSON.stringify(source), userInputHash(source), JSON.stringify(parsed.value),
        item.id, now, now, input.expiresAt ?? null);
      const request = this.require(source.threadId, requestId);
      this.invalidate(request, now);
      return { request, replayed: false };
    });
  }

  findRequired(input: FindRequiredUserInputForAttempt): UserInputRequest | undefined {
    if (!input.sourceFence || !isCurrentRunExecutionOwner(this.context, input.sourceRunId, input.sourceFence, false)) {
      throw new UserInputStoreError("source_conflict");
    }
    const request = this.requiredForSource(input.sourceRunId, input.sourceFence.attemptId);
    if (request) {
      const source = resolveActiveUserInputSource(this.sources, { sourceRunId: input.sourceRunId,
        sourceItemId: request.source.itemId, sourceFence: input.sourceFence,
        toolCallId: request.toolCallId, idempotencyKey: "required-input-boundary", toolInput: {} });
      if (userInputHash(source) !== userInputHash(request.source)) throw new UserInputStoreError("source_conflict");
    }
    return request;
  }

  private requiredForSource(runId: string, attemptId: string): UserInputRequest | undefined {
    let required: UserInputRequest | undefined;
    const rows = this.context.database.prepare(`SELECT * FROM user_input_requests WHERE workspace_id=?
      AND source_run_id=? AND source_attempt_id=? AND status IN ('pending','answered') AND wait_status IS NULL
      ORDER BY created_at,request_id`).iterate(DEFAULT_WORKSPACE_ID, runId, attemptId);
    for (const row of rows) {
      const request = mapUserInputRequest(row as UserInputRow);
      if (request.waitMode !== "required") continue;
      if (required) throw new UserInputStoreError("wait_conflict");
      required = request;
    }
    return required;
  }

  get(threadId: string, requestId: string): UserInputRequest | undefined {
    const row = this.context.database.prepare(`SELECT * FROM user_input_requests
      WHERE workspace_id=? AND thread_id=? AND request_id=?`).get(DEFAULT_WORKSPACE_ID, threadId, requestId);
    return row ? mapUserInputRequest(row) : undefined;
  }

  submit(input: SubmitUserInputAnswer, now: string): UserInputAnswerReceipt {
    const nowMs = userInputTimestamp(now);
    const parsed = parseUserInputAnswerSubmissionV1(input.submission);
    if (!parsed.ok) throw new UserInputStoreError(parsed.error.code);
    const submission = normalizeSubmission(parsed.value);
    assertNonSensitiveUserInput(submission);
    const fingerprint = userInputHash(submission);
    return this.transaction(() => {
      const { database } = this.context;
      const request = this.require(input.threadId, submission.requestId);
      const existing = database.prepare("SELECT * FROM user_input_answers WHERE request_id=? AND request_version=?")
        .get(request.requestId, submission.expectedVersion);
      // Replay before pending-only validation; a receipt remains valid after delivery or expiration.
      if (existing) {
        if (input.authority) {
          if (input.authority.statusRevision !== submission.expectedStatusRevision) throw new UserInputStoreError("stale_request");
          assertUserInputAnswerAuthority(this.context, this.sources, request, input.authority, now, { requireCurrent: false });
        }
        if (existing.submission_fingerprint !== fingerprint) throw new UserInputStoreError("idempotency_conflict");
        return this.receipt(request, existing, true);
      }
      if (input.authority) {
        if (input.authority.statusRevision !== submission.expectedStatusRevision) throw new UserInputStoreError("stale_request");
        assertUserInputAnswerAuthority(this.context, this.sources, request, input.authority, now, { requireCurrent: true });
      }
      const validated = validateUserInputAnswerForRequestV1(submission, request, nowMs);
      if (!validated.ok) throw new UserInputStoreError(validated.error.code);
      const updated = database.prepare(`UPDATE user_input_requests SET status='answered', status_revision=status_revision+1, updated_at=?
        WHERE request_id=? AND status='pending' AND request_version=? AND status_revision=?`)
        .run(now, request.requestId, submission.expectedVersion, submission.expectedStatusRevision);
      if (Number(updated.changes) !== 1) throw new UserInputStoreError("stale_request");
      const answerId = "uia_" + randomUUID(), deliveryId = "uid_" + randomUUID();
      const item = this.items.appendConversationItemWithinTransaction({
        ...itemScope(request.source), kind: "user_input_answer", actorType: "local_user",
        payload: { requestId: request.requestId, requestVersion: request.requestVersion, answerId,
          runEventPosition: captureUserInputRunEventPosition(this.context, request.source) },
        domainRefs: [{ type: "user_input_request", id: request.requestId }, { type: "user_input_answer", id: answerId }],
      }, now);
      database.prepare(`INSERT INTO user_input_answers (
        answer_id, request_id, request_version, idempotency_key, submission_fingerprint, submission_json, answer_item_id, accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(answerId, request.requestId, request.requestVersion,
        submission.idempotencyKey, fingerprint, JSON.stringify(submission), item.id, now);
      database.prepare(`INSERT INTO user_input_deliveries (delivery_id, answer_id, consumer_work_unit_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?)`).run(deliveryId, answerId, request.source.fence.workUnitId, now, now);
      this.invalidate(this.require(input.threadId, request.requestId), now);
      return { requestId: request.requestId, requestVersion: request.requestVersion, answerId,
        answerItemId: item.id, deliveryId, acceptedAt: now, replayed: false };
    });
  }

  cancel(input: CancelUserInputRequest, now: string): UserInputRequest {
    userInputTimestamp(now);
    return this.transaction(() => {
      const request = this.require(input.threadId, input.requestId);
      const waiting = this.context.database.prepare("SELECT wait_status FROM user_input_requests WHERE request_id=?")
        .get(request.requestId);
      if (waiting?.wait_status !== null) throw new UserInputStoreError("wait_conflict");
      if (request.statusRevision !== input.expectedStatusRevision) throw new UserInputStoreError("stale_request");
      if (request.status !== "pending") throw new UserInputStoreError("request_not_pending");
      const updated = this.context.database.prepare(`UPDATE user_input_requests
        SET status='cancelled', status_revision=status_revision+1, updated_at=?
        WHERE request_id=? AND status_revision=? AND status='pending'`).run(now, input.requestId, input.expectedStatusRevision);
      if (Number(updated.changes) !== 1) throw new UserInputStoreError("stale_request");
      const cancelled = this.require(input.threadId, input.requestId);
      this.invalidate(cancelled, now);
      return cancelled;
    });
  }

  listPending(options: ListPendingUserInputDeliveries): readonly PendingUserInputDelivery[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new UserInputStoreError("invalid_input");
    return this.context.database.prepare(`SELECT d.*, a.request_id, a.request_version, r.thread_id
      FROM user_input_deliveries d JOIN user_input_answers a ON a.answer_id=d.answer_id
      JOIN user_input_requests r ON r.request_id=a.request_id
      WHERE r.workspace_id=? AND r.thread_id=? AND r.status='answered' AND d.status='pending'
      ORDER BY d.created_at, d.delivery_id LIMIT ?`).all(DEFAULT_WORKSPACE_ID, options.threadId, limit)
      .map(row => ({ deliveryId: readString(row, "delivery_id"), requestId: readString(row, "request_id"),
        requestVersion: Number(row.request_version), answerId: readString(row, "answer_id"),
        threadId: readString(row, "thread_id"), consumerWorkUnitId: readString(row, "consumer_work_unit_id"),
        status: "pending", createdAt: readString(row, "created_at") }));
  }

  private require(threadId: string, requestId: string): UserInputRequest {
    const request = this.get(threadId, requestId);
    if (!request) throw new UserInputStoreError("not_found");
    return request;
  }

  private receipt(request: UserInputRequest, answer: UserInputRow, replayed: boolean): UserInputAnswerReceipt {
    const delivery = this.context.database.prepare("SELECT delivery_id FROM user_input_deliveries WHERE answer_id=? AND consumer_work_unit_id=?")
      .get(readString(answer, "answer_id"), request.source.fence.workUnitId);
    if (!delivery || request.status !== "answered") throw new UserInputStoreError("invalid_record");
    const parsed = parseUserInputAnswerSubmissionV1(JSON.parse(readString(answer, "submission_json")));
    if (!parsed.ok || userInputHash(normalizeSubmission(parsed.value)) !== answer.submission_fingerprint) {
      throw new UserInputStoreError("invalid_record");
    }
    return { requestId: request.requestId, requestVersion: request.requestVersion,
      answerId: readString(answer, "answer_id"), answerItemId: readString(answer, "answer_item_id"),
      deliveryId: readString(delivery, "delivery_id"), acceptedAt: readString(answer, "accepted_at"), replayed };
  }

  private invalidate(request: UserInputRequest, now: string): void {
    this.events.appendControlPlaneEventWithinTransaction({
      workspaceId: DEFAULT_WORKSPACE_ID, cwd: request.source.cwd, domain: "runs",
      entityType: "user_input_request", entityId: request.requestId, action: request.status,
      data: { threadId: request.source.threadId, requestId: request.requestId, requestVersion: request.requestVersion,
        statusRevision: request.statusRevision, itemId: request.itemId },
      idempotencyKey: "user-input:" + request.requestId + ":" + request.statusRevision,
    }, now);
  }

  private transaction<T>(operation: () => T): T {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }
}
function validKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function itemScope(source: UserInputSource) {
  return { threadId: source.threadId, turnId: source.turnId, channelId: source.channelId,
    visibility: source.visibility, visibilityOwnerId: source.visibilityOwnerId };
}
function normalizeSubmission(value: UserInputAnswerSubmissionV1): UserInputAnswerSubmissionV1 {
  return { ...value, answers: [...value.answers].sort((a, b) => a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0) };
}
