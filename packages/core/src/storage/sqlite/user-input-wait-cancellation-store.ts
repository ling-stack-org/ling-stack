import type { RunStore, LingThreadStatus } from "../../run-types.js";
import { UserInputStoreError, type UserInputRequest } from "../../user-input-store-types.js";
import type { CancelUserInputWait, CancelUserInputWaitResult, UserInputWait } from "../../user-input-wait-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { userInputTimestamp } from "./user-input-records.js";
import { assertUserInputWaitingSource } from "./user-input-wait-source.js";
import { obsoleteUserInputDeliveriesForCancelledWait } from "./user-input-delivery-cancellation.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";

type CancellationPorts = Pick<RunStore, "getUserInputRequest" | "getUserInputWait" | "getRun" | "getTask"
  | "getWorkUnit" | "getWorkUnitAttempt" | "getLingThread" | "getLingTurnForRun" | "getChannelWorkflowStep"
  | "transitionTaskStatus" | "transitionWorkUnitStatus" | "transitionChannelWorkflowStepStatus"
  | "appendRuntimeEvent" | "reconcileLingTurnStatus" | "updateLingThread">;

/** Cancels durable logical waiting in one transaction; never reopens or cancels a yielded execution. */
export class SqliteUserInputWaitCancellationStore {
  constructor(private readonly context: SqliteStoreContext, private readonly events: SqliteControlPlaneStore,
    private readonly ports: CancellationPorts) {}

  cancel(input: CancelUserInputWait, now: string): CancelUserInputWaitResult {
    userInputTimestamp(now);
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const rows = database.prepare(`SELECT request_id FROM user_input_requests WHERE workspace_id=?
        AND thread_id=? AND source_run_id=? AND wait_status IS NOT NULL`).all(DEFAULT_WORKSPACE_ID, input.threadId, input.sourceRunId);
      if (rows.length === 0) throw new UserInputStoreError("not_found");
      if (rows.length !== 1) throw new UserInputStoreError("invalid_record");
      const requestId = String(rows[0]!.request_id);
      const request = this.ports.getUserInputRequest(input.threadId, requestId);
      const wait = this.ports.getUserInputWait(input.threadId, requestId);
      if (!request || !wait) throw new UserInputStoreError("invalid_record");
      if (wait.status === "cancelled") {
        database.exec("COMMIT");
        return { request, wait, replayed: true };
      }
      if (wait.status !== "waiting" || userInputTimestamp(now) < userInputTimestamp(wait.checkpoint.committedAt)) {
        throw new UserInputStoreError("wait_conflict");
      }
      assertUserInputWaitingSource(this.ports, request, wait);
      obsoleteUserInputDeliveriesForCancelledWait(this.context, this.events, request, now);
      if (request.status === "pending") {
        const cancelled = database.prepare(`UPDATE user_input_requests SET status='cancelled',
          status_revision=status_revision+1, updated_at=? WHERE request_id=? AND status='pending' AND status_revision=?`)
          .run(now, requestId, request.statusRevision);
        requireChange(cancelled.changes);
      }
      const cancelledWait = database.prepare(`UPDATE user_input_requests SET wait_status='cancelled',
        wait_revision=wait_revision+1, updated_at=? WHERE request_id=? AND wait_status='waiting' AND wait_revision=?`)
        .run(now, requestId, wait.revision);
      requireChange(cancelledWait.changes);
      const { source } = request;
      const transition = { actor: "local-user" as const, now, reason: "user_input_wait_cancelled",
        idempotencyKey: "user-input-wait-cancel:" + requestId };
      // This is a logical-owner transition with no active execution. The original
      // closed fence is retained as audit data, never borrowed as a current fence.
      requireTransition(this.ports.transitionWorkUnitStatus({ ...transition, workUnitId: source.fence.workUnitId,
        expectedStatus: "waiting_for_input", event: "user_input_cancelled", endedAt: now, errorCode: null, errorMessage: null }));
      if (source.taskBinding.kind === "stored_task") {
        requireTransition(this.ports.transitionTaskStatus({ ...transition, taskId: source.taskBinding.taskId,
          expectedStatus: "waiting_for_input", event: "cancel", currentRunId: source.runId }));
      }
      if (source.workflowStepId) {
        requireTransition(this.ports.transitionChannelWorkflowStepStatus({ ...transition, workflowStepId: source.workflowStepId,
          expectedStatus: "waiting_for_input", event: "cancel" }));
      }
      this.ports.appendRuntimeEvent({ workUnitId: source.fence.workUnitId, type: "work_unit_cancelled", actor: "local-user", ts: now,
        data: { reason: "user_input_wait_cancelled", requestId, sourceRunId: source.runId, sourceFence: source.fence } });
      this.ports.reconcileLingTurnStatus(source.turnId, now);
      this.reconcileThread(request, now);
      const updatedRequest = this.ports.getUserInputRequest(input.threadId, requestId)!;
      const updatedWait = this.ports.getUserInputWait(input.threadId, requestId)!;
      if (request.status === "pending") {
        this.events.appendControlPlaneEventWithinTransaction({ workspaceId: source.workspaceId, cwd: source.cwd, domain: "runs",
          entityType: "user_input_request", entityId: requestId, action: "cancelled",
          idempotencyKey: "user-input:" + requestId + ":" + updatedRequest.statusRevision,
          data: { threadId: source.threadId, requestId, requestVersion: request.requestVersion,
            statusRevision: updatedRequest.statusRevision, itemId: request.itemId } }, now);
      }
      this.events.appendControlPlaneEventWithinTransaction({ workspaceId: source.workspaceId, cwd: source.cwd, domain: "runs",
        entityType: "user_input_wait", entityId: requestId, action: "cancelled",
        idempotencyKey: "user-input-wait:" + requestId + ":" + updatedWait.revision,
        data: { requestId, threadId: source.threadId, turnId: source.turnId, runId: source.runId,
          workUnitId: source.fence.workUnitId, attemptId: source.fence.attemptId, waitRevision: updatedWait.revision } }, now);
      database.exec("COMMIT");
      return { request: updatedRequest, wait: updatedWait, replayed: false };
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }


  private reconcileThread(request: UserInputRequest, now: string): void {
    const { source } = request;
    const thread = this.ports.getLingThread(source.threadId)!;
    const active = this.context.database.prepare(`SELECT id,status FROM run_sessions WHERE thread_id=?
      AND status IN ('queued','running','waiting_for_approval') ORDER BY updated_at DESC,id DESC LIMIT 1`).get(source.threadId);
    let otherWait = false;
    for (const row of this.context.database.prepare(`SELECT request_id FROM user_input_requests
      WHERE workspace_id=? AND thread_id=? AND wait_status IN ('waiting','resuming')`).iterate(source.workspaceId, source.threadId)) {
      const wait = this.ports.getUserInputWait(source.threadId, String(row.request_id));
      if (!wait) throw new UserInputStoreError("invalid_record");
      otherWait = true;
    }
    const latestTurn = this.ports.getLingTurnForRun(thread.lastRunId ?? source.runId);
    const status: LingThreadStatus = active ? active.status === "waiting_for_approval" ? "waiting_for_approval" : "running"
      : otherWait ? "waiting_for_input" : !latestTurn || latestTurn.status === "superseded" ? "blocked" : latestTurn.status;
    this.ports.updateLingThread(source.threadId, { status, activeRunId: active ? String(active.id) : null }, now);
  }
}

function requireTransition(result: { readonly ok: boolean }): void {
  if (!result.ok) throw new UserInputStoreError("source_conflict");
}
function requireChange(changes: number | bigint): void {
  if (Number(changes) !== 1) throw new UserInputStoreError("source_conflict");
}
