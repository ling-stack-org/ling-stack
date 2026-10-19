import { randomUUID } from "node:crypto";
import type { RunStore } from "../../run-types.js";
import type { ClaimUserInputDelivery, ListDueUserInputDeliveries, ListUserInputDispatchCandidates, RetryUserInputDelivery,
  UserInputDelivery, UserInputDispatchCandidate } from "../../user-input-delivery-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { UserInputStoreError, type UserInputRequest } from "../../user-input-store-types.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { userInputTimestamp } from "./user-input-records.js";
import { readUserInputDelivery, validDeliveryKey, validDeliveryRevision, deliveryRetryCodes } from "./user-input-delivery-records.js";
import { assertUserInputWaitingSource, type UserInputWaitingSourcePorts } from "./user-input-wait-source.js";
import { assertUserInputQuiescence } from "./user-input-wait-evidence.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import { freezeUserInputContinuationSeed, readUserInputContinuationSeed } from "./user-input-continuation-store.js";
import type { UserInputSeedPorts } from "./user-input-continuation-records.js";
import type { UserInputContinuationSeed } from "../../user-input-continuation-types.js";
import type { UserInputContinuationClaim } from "../../user-input-host-continuation-types.js";

type DeliveryPorts = UserInputWaitingSourcePorts & UserInputSeedPorts & Pick<RunStore, "getChannelWorkflow">;

/** Owns outbox leases and frozen answer seeds. No Runner, Run creation, prior-input mutation, ACK or permissions. */
export class SqliteUserInputDeliveryStore {
  constructor(private readonly context: SqliteStoreContext, private readonly events: SqliteControlPlaneStore, private readonly ports: DeliveryPorts) {}

  get(threadId: string, deliveryId: string): UserInputDelivery | undefined {
    if (!validDeliveryKey(threadId) || !validDeliveryKey(deliveryId)) return undefined;
    return readSqliteSnapshot(this.context.database, () => readUserInputDelivery(this.context, this.ports, threadId, deliveryId)?.delivery);
  }

  getSeed(threadId: string, deliveryId: string): UserInputContinuationSeed | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      const bound = readUserInputDelivery(this.context, this.ports, threadId, deliveryId);
      return bound ? readUserInputContinuationSeed(this.context, this.ports, bound) : undefined;
    });
  }

  /** Discovery only. The current lease and consumer must still be checked atomically by claim. */
  listDue(input: ListDueUserInputDeliveries, now: string): readonly UserInputDelivery[] {
    userInputTimestamp(now);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500
      || input.threadId !== undefined && !validDeliveryKey(input.threadId)
      || input.after !== undefined && (!validDeliveryKey(input.after.deliveryId)
        || !Number.isFinite(Date.parse(input.after.createdAt)))) throw new UserInputStoreError("invalid_input");
    return readSqliteSnapshot(this.context.database, () => {
      const clauses = ["r.workspace_id=?", "(d.status='pending'"
        + " OR (d.status='claimed' AND (d.claim_expires_at IS NULL OR d.claim_expires_at<=?)"
        + " AND (d.retry_at IS NULL OR d.retry_at<=?))"
        + " OR (d.status='failed' AND d.retry_at<=?))"];
      const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, now, now, now];
      if (input.threadId !== undefined) { clauses.push("r.thread_id=?"); params.push(input.threadId); }
      if (input.after !== undefined) {
        clauses.push("(d.created_at>? OR (d.created_at=? AND d.delivery_id>?))");
        params.push(input.after.createdAt, input.after.createdAt, input.after.deliveryId);
      }
      params.push(limit);
      const rows = this.context.database.prepare("SELECT d.delivery_id,r.thread_id FROM user_input_deliveries d"
        + " JOIN user_input_answers a ON a.answer_id=d.answer_id JOIN user_input_requests r ON r.request_id=a.request_id"
        + ` WHERE ${clauses.join(" AND ")} ORDER BY d.created_at,d.delivery_id LIMIT ?`).all(...params);
      return rows.map(row => this.require(String(row.thread_id), String(row.delivery_id)).delivery);
    });
  }

  listDispatchCandidates(input: ListUserInputDispatchCandidates, now: string): readonly UserInputDispatchCandidate[] {
    const nowMs = userInputTimestamp(now), cutoffMs = userInputTimestamp(input.createdAtOrBefore), limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || cutoffMs > nowMs
      || input.after && (typeof input.after.deliveryId !== "string" || typeof input.after.createdAt !== "string")) {
      throw new UserInputStoreError("invalid_input");
    }
    return readSqliteSnapshot(this.context.database, () => {
      const rows = this.context.database.prepare("SELECT d.delivery_id,d.created_at,r.thread_id FROM user_input_deliveries d"
        + " JOIN user_input_answers a ON a.answer_id=d.answer_id JOIN user_input_requests r ON r.request_id=a.request_id"
        + " WHERE r.workspace_id=? AND typeof(d.delivery_id)='text' AND typeof(d.created_at)='text' AND typeof(r.thread_id)='text' AND d.created_at<=?"
        + " AND (? IS NULL OR d.created_at>? OR (d.created_at=? AND d.delivery_id>?))"
        + " AND (d.status='pending' OR (d.status='claimed' AND (d.claim_expires_at IS NULL OR d.claim_expires_at<=?)"
        + " AND (d.retry_at IS NULL OR d.retry_at<=?)) OR (d.status='failed' AND d.retry_at<=?))"
        + " ORDER BY d.created_at,d.delivery_id LIMIT ?")
        .all(DEFAULT_WORKSPACE_ID, input.createdAtOrBefore, input.after?.createdAt ?? null,
          input.after?.createdAt ?? null, input.after?.createdAt ?? null, input.after?.deliveryId ?? null, now, now, now, limit);
      return rows.map(row => ({ threadId: String(row.thread_id), deliveryId: String(row.delivery_id), createdAt: String(row.created_at) }));
    });
  }

  claim(input: ClaimUserInputDelivery, now: string): UserInputDelivery | null {
    const nowMs = userInputTimestamp(now);
    if (!validDeliveryKey(input.ownerId) || !validDeliveryRevision(input.expectedRevision)
      || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 60_000
      || nowMs > 8_640_000_000_000_000 - input.leaseMs) throw new UserInputStoreError("invalid_input");
    return this.transaction(() => {
      const bound = this.require(input.threadId, input.deliveryId);
      const { delivery, request } = bound;
      this.assertRevision(delivery, input.expectedRevision, now);
      if (delivery.status === "obsolete") return null;
      if (delivery.status === "applied" || this.hasSuccessor(delivery)) throw new UserInputStoreError("delivery_conflict");
      const readiness = this.readiness(request, now);
      if (readiness === "obsolete") { this.obsolete(delivery, request, now); return null; }
      if (readiness === "not_ready") throw new UserInputStoreError("delivery_not_ready");
      if (delivery.claim && Date.parse(delivery.claim.expiresAt) > nowMs) throw new UserInputStoreError("delivery_conflict");
      if (delivery.retryAt && Date.parse(delivery.retryAt) > nowMs) throw new UserInputStoreError("delivery_not_ready");
      if (!Number.isSafeInteger(delivery.attemptCount + 1)) throw new UserInputStoreError("invalid_record");
      const successorRunId = delivery.successorRunId ?? "run_" + randomUUID();
      freezeUserInputContinuationSeed(this.context, this.ports, bound, successorRunId, now);
      const changed = this.context.database.prepare("UPDATE user_input_deliveries SET status='claimed',status_revision=status_revision+1,"
        + " attempt_count=attempt_count+1,updated_at=?,successor_run_id=?,claim_owner_id=?,claim_token=?,claim_expires_at=?,retry_at=NULL,last_error_code=NULL"
        + " WHERE delivery_id=? AND status_revision=?")
        .run(now, successorRunId, input.ownerId, randomUUID(), new Date(nowMs + input.leaseMs).toISOString(), input.deliveryId, input.expectedRevision);
      if (Number(changed.changes) !== 1) throw new UserInputStoreError("delivery_conflict");
      const updated = this.require(input.threadId, input.deliveryId).delivery;
      this.invalidate(updated, request, now);
      return updated;
    });
  }

  retry(input: RetryUserInputDelivery, now: string): UserInputDelivery {
    const nowMs = userInputTimestamp(now), retryMs = userInputTimestamp(input.retryAt);
    if (!validDeliveryRevision(input.expectedRevision) || !validDeliveryKey(input.ownerId) || !validDeliveryKey(input.claimToken)
      || !deliveryRetryCodes.includes(input.errorCode) || retryMs < nowMs || retryMs - nowMs > 3_600_000) throw new UserInputStoreError("invalid_input");
    return this.transaction(() => {
      const { delivery, request } = this.require(input.threadId, input.deliveryId);
      this.assertRevision(delivery, input.expectedRevision, now);
      if (delivery.status !== "claimed" || delivery.claim?.ownerId !== input.ownerId || delivery.claim.token !== input.claimToken
        || Date.parse(delivery.claim.expiresAt) <= nowMs || this.hasSuccessor(delivery)) throw new UserInputStoreError("delivery_conflict");
      const readiness = this.readiness(request, now);
      if (readiness === "obsolete") return this.obsolete(delivery, request, now);
      if (readiness === "not_ready") throw new UserInputStoreError("delivery_not_ready");
      const changed = this.context.database.prepare("UPDATE user_input_deliveries SET status='failed',status_revision=status_revision+1,updated_at=?,"
        + " claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL,retry_at=?,last_error_code=? WHERE delivery_id=? AND status_revision=?")
        .run(now, input.retryAt, input.errorCode, delivery.deliveryId, delivery.revision);
      if (Number(changed.changes) !== 1) throw new UserInputStoreError("delivery_conflict");
      const updated = this.require(input.threadId, input.deliveryId).delivery;
      this.invalidate(updated, request, now);
      return updated;
    });
  }

  /** Read-only validation inside a continuation-owned write transaction; never renews or steals a lease. */
  assertContinuationClaim(input: UserInputContinuationClaim, now: string) {
    const nowMs = userInputTimestamp(now);
    if (!validDeliveryRevision(input.expectedRevision) || !validDeliveryKey(input.ownerId) || !validDeliveryKey(input.claimToken)) {
      throw new UserInputStoreError("invalid_input");
    }
    const bound = this.require(input.threadId, input.deliveryId), { delivery, request } = bound;
    this.assertRevision(delivery, input.expectedRevision, now);
    if (delivery.status !== "claimed" || delivery.claim?.ownerId !== input.ownerId || delivery.claim.token !== input.claimToken
      || Date.parse(delivery.claim.expiresAt) <= nowMs || this.hasSuccessor(delivery)) throw new UserInputStoreError("delivery_conflict");
    if (this.readiness(request, now) !== "ready") throw new UserInputStoreError("delivery_not_ready");
    return bound;
  }

  private readiness(request: UserInputRequest, now: string): "ready" | "not_ready" | "obsolete" {
    const { source } = request;
    const run = this.ports.getRun(source.runId), unit = this.ports.getWorkUnit(source.fence.workUnitId);
    const thread = this.ports.getLingThread(source.threadId), turn = this.ports.getLingTurnForRun(source.runId);
    if (request.status !== "answered" || !run || !unit || !thread || !turn || thread.status === "archived" || thread.archivedAt
      || ["succeeded", "failed", "cancelled"].includes(run.status)
      || ["succeeded", "failed", "cancelled"].includes(unit.status)
      || ["succeeded", "failed", "cancelled", "superseded"].includes(turn.status)) return "obsolete";
    if (source.workflowStepId) {
      const step = this.ports.getChannelWorkflowStep(source.workflowStepId);
      const workflow = step ? this.ports.getChannelWorkflow(step.workflowId) : undefined;
      if (!step || !workflow || ["succeeded", "failed", "cancelled"].includes(workflow.status)) return "obsolete";
      if (workflow.workspaceId !== source.workspaceId || workflow.channelId !== source.channelId) {
        throw new UserInputStoreError("source_conflict");
      }
      if (!["running", "waiting_for_input"].includes(workflow.status)) return "not_ready";
    }
    if (request.waitMode === "optional" || run.status !== "yielded") return "not_ready";
    const wait = this.ports.getUserInputWait(source.threadId, request.requestId);
    if (!wait) throw new UserInputStoreError("invalid_record");
    if (wait.status === "cancelled") return "obsolete";
    if (wait.status === "blocked") return "not_ready";
    if (userInputTimestamp(now) < userInputTimestamp(wait.checkpoint.committedAt)) return "not_ready";
    if (wait.status !== "waiting") throw new UserInputStoreError("delivery_conflict");
    assertUserInputWaitingSource(this.ports, request, wait);
    assertUserInputQuiescence(this.context.database, source.runId, wait.checkpoint.quiescence, now, request.source.fence);
    return "ready";
  }

  private obsolete(delivery: UserInputDelivery, request: UserInputRequest, now: string): UserInputDelivery {
    const changed = this.context.database.prepare("UPDATE user_input_deliveries SET status='obsolete',status_revision=status_revision+1,updated_at=?,"
      + " claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL,retry_at=NULL WHERE delivery_id=? AND status_revision=?")
      .run(now, delivery.deliveryId, delivery.revision);
    if (Number(changed.changes) !== 1) throw new UserInputStoreError("delivery_conflict");
    const updated = this.require(delivery.threadId, delivery.deliveryId).delivery;
    this.invalidate(updated, request, now);
    return updated;
  }
  private hasSuccessor(delivery: UserInputDelivery): boolean {
    return !!delivery.successorRunId && !!this.context.database.prepare("SELECT 1 FROM run_sessions WHERE id=?").get(delivery.successorRunId);
  }
  private assertRevision(delivery: UserInputDelivery, expected: number, now: string): void {
    if (delivery.revision !== expected || Date.parse(now) < Date.parse(delivery.updatedAt)) throw new UserInputStoreError("delivery_conflict");
  }
  private require(threadId: string, deliveryId: string) {
    const result = readUserInputDelivery(this.context, this.ports, threadId, deliveryId);
    if (!result) throw new UserInputStoreError("not_found");
    return result;
  }
  private invalidate(delivery: UserInputDelivery, request: UserInputRequest, now: string): void {
    this.events.appendControlPlaneEventWithinTransaction({
      workspaceId: request.source.workspaceId, cwd: request.source.cwd, domain: "runs",
      entityType: "user_input_delivery", entityId: delivery.deliveryId, action: delivery.status,
      idempotencyKey: "user-input-delivery:" + delivery.deliveryId + ":" + delivery.revision,
      data: { threadId: delivery.threadId, requestId: request.requestId, answerId: delivery.answerId,
        deliveryId: delivery.deliveryId, revision: delivery.revision, successorRunId: delivery.successorRunId },
    }, now);
  }
  private transaction<T>(operation: () => T): T {
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(database); throw error; }
  }
}
