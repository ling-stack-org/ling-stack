import type { RunStore } from "../../run-types.js";
import type { CommitUserInputYield, CommitUserInputYieldResult, UserInputWait, UserInputYieldCheckpoint } from "../../user-input-wait-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { resolveActiveUserInputSource, type UserInputSourcePorts } from "./user-input-source.js";
import { mapUserInputRequest, userInputHash, userInputTimestamp, type UserInputRow } from "./user-input-records.js";
import { assertUserInputQuiescence } from "./user-input-wait-evidence.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";
import type { SqliteStoreContext } from "./store-context.js";

type WaitPorts = UserInputSourcePorts & Pick<RunStore,
  "getTask" | "transitionRunStatus" | "transitionTaskStatus" | "transitionWorkUnitStatus" | "updateWorkUnitAttemptStatus"
  | "appendRuntimeEvent"
  | "transitionChannelWorkflowStepStatus" | "getChannelWorkflow" | "updateLingThread" | "reconcileLingTurnStatus">;

/** Owns the atomic physical-close/logical-wait transaction. Never starts or stops a process. */
export class SqliteUserInputWaitStore {
  constructor(private readonly context: SqliteStoreContext, private readonly events: SqliteControlPlaneStore, private readonly ports: WaitPorts) {}

  get(threadId: string, requestId: string): UserInputWait | undefined {
    const row = this.readRow(threadId, requestId);
    if (!row) return undefined;
    if (row.wait_status === null) {
      if (row.wait_revision !== 0 || row.wait_checkpoint_json !== null || row.wait_checkpoint_fingerprint !== null) {
        throw new UserInputStoreError("invalid_record");
      }
      return undefined;
    }
    try {
      const request = mapUserInputRequest(row);
      const checkpoint = JSON.parse(String(row.wait_checkpoint_json)) as UserInputYieldCheckpoint;
      if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.requestId !== requestId
        || checkpoint.requestVersion !== request.requestVersion || checkpoint.taskId !== request.source.taskBinding.taskId
        || !checkpoint.quiescence || checkpoint.quiescence.kind !== "runner_quiesced"
        || !Number.isSafeInteger(checkpoint.quiescence.lastRunEventSeq) || checkpoint.quiescence.lastRunEventSeq < 0
        || typeof checkpoint.quiescence.runnerId !== "string" || !checkpoint.quiescence.runnerId
        || userInputHash(checkpoint.source) !== userInputHash(request.source)
        || userInputHash(checkpoint) !== row.wait_checkpoint_fingerprint
        || !Number.isSafeInteger(row.wait_revision) || Number(row.wait_revision) < 1
        || !["waiting", "resuming", "resumed", "cancelled", "blocked"].includes(String(row.wait_status))) {
        throw new UserInputStoreError("invalid_record");
      }
      if (userInputTimestamp(checkpoint.quiescence.stoppedAt) > userInputTimestamp(checkpoint.committedAt)) {
        throw new UserInputStoreError("invalid_record");
      }
      return { status: row.wait_status as UserInputWait["status"], revision: Number(row.wait_revision), checkpoint };
    } catch { throw new UserInputStoreError("invalid_record"); }
  }

  commit(input: CommitUserInputYield, now: string): CommitUserInputYieldResult {
    userInputTimestamp(now);
    if (!input.sourceFence || !input.quiescence) throw new UserInputStoreError("invalid_input");
    const { database } = this.context;
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.readRow(input.threadId, input.requestId);
      if (!row) throw new UserInputStoreError("not_found");
      const request = mapUserInputRequest(row);
      if (request.requestVersion !== input.expectedRequestVersion) throw new UserInputStoreError("stale_request");
      const prior = this.get(input.threadId, input.requestId);
      if (prior) {
        if (yieldIdentity(input) !== yieldIdentity({ threadId: prior.checkpoint.source.threadId,
          requestId: prior.checkpoint.requestId, expectedRequestVersion: prior.checkpoint.requestVersion,
          sourceFence: prior.checkpoint.source.fence, quiescence: prior.checkpoint.quiescence })) throw new UserInputStoreError("wait_conflict");
        database.exec("COMMIT");
        return { wait: prior, replayed: true };
      }
      if (request.waitMode !== "required" || (request.status !== "pending" && request.status !== "answered")) {
        throw new UserInputStoreError("wait_conflict");
      }
      if (request.status === "pending" && request.expiresAt && Date.parse(request.expiresAt) <= Date.parse(now)) {
        throw new UserInputStoreError("request_expired");
      }
      const source = resolveActiveUserInputSource(this.ports, {
        sourceRunId: request.source.runId, sourceItemId: request.source.itemId, sourceFence: input.sourceFence,
        toolCallId: request.toolCallId, idempotencyKey: "yield", toolInput: {},
      });
      const run = this.ports.getRun(source.runId)!;
      const task = this.ports.getTask(run.taskId);
      const attempt = this.ports.getWorkUnitAttempt(source.fence.attemptId)!;
      if (userInputHash(source) !== userInputHash(request.source)
        || (source.taskBinding.kind === "stored_task" && (!task || task.status !== "running" || task.currentRunId !== run.id))
        || attempt.runnerId !== input.quiescence.runnerId
        || userInputTimestamp(input.quiescence.stoppedAt) < userInputTimestamp(request.createdAt)) throw new UserInputStoreError("source_conflict");
      if (source.workflowStepId) {
        const step = this.ports.getChannelWorkflowStep(source.workflowStepId)!;
        const workflow = this.ports.getChannelWorkflow(step.workflowId);
        if (!workflow || !["running", "waiting_for_input"].includes(workflow.status)) throw new UserInputStoreError("source_conflict");
      }
      if (database.prepare(`SELECT 1 FROM user_input_requests WHERE workspace_id=? AND source_attempt_id=?
        AND wait_status IN ('waiting','resuming') LIMIT 1`).get(DEFAULT_WORKSPACE_ID, source.fence.attemptId)) throw new UserInputStoreError("wait_conflict");
      assertUserInputQuiescence(database, run.id, input.quiescence, now, source.fence);
      const checkpoint: UserInputYieldCheckpoint = {
        schemaVersion: 1, requestId: request.requestId, requestVersion: request.requestVersion, source,
        taskId: run.taskId, quiescence: { kind: "runner_quiesced", runnerId: input.quiescence.runnerId,
          stoppedAt: input.quiescence.stoppedAt, lastRunEventSeq: input.quiescence.lastRunEventSeq }, committedAt: now,
      };
      const stored = database.prepare(`UPDATE user_input_requests SET wait_status='waiting', wait_revision=1,
        wait_checkpoint_json=?, wait_checkpoint_fingerprint=?, updated_at=?
        WHERE request_id=? AND wait_status IS NULL AND wait_revision=0`).run(JSON.stringify(checkpoint), userInputHash(checkpoint), now, request.requestId);
      if (Number(stored.changes) !== 1) throw new UserInputStoreError("wait_conflict");
      const transition = { actor: "system" as const, now, reason: "user_input_required", idempotencyKey: "user-input-yield:" + request.requestId };
      requireTransition(this.ports.transitionRunStatus({ ...transition, runId: run.id, expectedStatus: "running", event: "runner_yielded", endedAt: input.quiescence.stoppedAt }));
      if (task) requireTransition(this.ports.transitionTaskStatus({ ...transition, taskId: task.id, expectedStatus: "running", event: "user_input_requested", currentRunId: run.id }));
      requireTransition(this.ports.transitionWorkUnitStatus({ ...transition, ...source.fence, expectedStatus: "running",
        event: "user_input_requested", endedAt: null, errorCode: null, errorMessage: null }));
      this.ports.appendRuntimeEvent({ ...source.fence, type: "work_unit_waiting_for_input", actor: "system", ts: now,
        data: { requestId: request.requestId, requestVersion: request.requestVersion, runId: run.id, checkpointFingerprint: userInputHash(checkpoint) } });
      if (!this.ports.updateWorkUnitAttemptStatus({ ...source.fence, status: "yielded", endedAt: input.quiescence.stoppedAt, now })) {
        throw new UserInputStoreError("source_conflict");
      }
      // This transaction already verified physical quiescence. Its enclosing
      // Host observer may still be pending until the yield callback returns.
      this.releaseVerifiedYieldResources(source.fence, now);
      const cleared = database.prepare(`UPDATE work_units SET active_attempt_id=NULL WHERE id=?
        AND active_attempt_id=? AND status='waiting_for_input'`).run(source.fence.workUnitId, source.fence.attemptId);
      if (Number(cleared.changes) !== 1) throw new UserInputStoreError("source_conflict");
      if (source.workflowStepId) {
        requireTransition(this.ports.transitionChannelWorkflowStepStatus({ ...transition, workflowStepId: source.workflowStepId,
          expectedStatus: "running", event: "user_input_requested", blocker: null }));
        database.prepare(`UPDATE resource_leases SET status='released', released_at=?, release_reason='user_input_yielded'
          WHERE owner_type='workflow_step' AND owner_id=? AND status='active' AND attempt_id IS NULL`).run(now, source.workflowStepId);
      }
      this.ports.reconcileLingTurnStatus(source.turnId, now);
      const otherRun = database.prepare(`SELECT id,status FROM run_sessions WHERE thread_id=? AND id<>?
        AND status IN ('queued','running','waiting_for_approval') ORDER BY updated_at DESC,id DESC LIMIT 1`).get(source.threadId, run.id);
      this.ports.updateLingThread(source.threadId, { status: otherRun?.status === "waiting_for_approval" ? "waiting_for_approval"
        : otherRun ? "running" : "waiting_for_input", activeRunId: otherRun ? String(otherRun.id) : null, lastRunId: run.id }, now);
      this.events.appendControlPlaneEventWithinTransaction({ workspaceId: DEFAULT_WORKSPACE_ID, cwd: source.cwd, domain: "runs",
        entityType: "user_input_wait", entityId: request.requestId, action: "waiting",
        idempotencyKey: "user-input-wait:" + request.requestId + ":1",
        data: { requestId: request.requestId, threadId: source.threadId, turnId: source.turnId, runId: run.id,
          workUnitId: source.fence.workUnitId, attemptId: source.fence.attemptId, waitRevision: 1 } }, now);
      const wait = this.get(source.threadId, request.requestId)!;
      database.exec("COMMIT");
      return { wait, replayed: false };
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  }

  private readRow(threadId: string, requestId: string): UserInputRow | undefined {
    return this.context.database.prepare("SELECT * FROM user_input_requests WHERE workspace_id=? AND thread_id=? AND request_id=?")
      .get(DEFAULT_WORKSPACE_ID, threadId, requestId) as UserInputRow | undefined;
  }

  private releaseVerifiedYieldResources(fence: UserInputYieldCheckpoint["source"]["fence"], now: string): void {
    for (const table of ["resource_leases", "runtime_semaphore_slots"]) {
      this.context.database.prepare(`UPDATE ${table} SET status='released', released_at=?, release_reason='user_input_yielded'
        WHERE work_unit_id=? AND attempt_id=? AND runtime_instance_id=? AND fencing_token=? AND status='active'
          AND EXISTS (SELECT 1 FROM work_unit_attempts AS attempt JOIN work_units AS unit ON unit.id=attempt.work_unit_id
            WHERE attempt.id=${table}.attempt_id AND attempt.work_unit_id=${table}.work_unit_id
              AND attempt.runtime_instance_id=${table}.runtime_instance_id AND attempt.fencing_token=${table}.fencing_token
              AND unit.active_attempt_id=attempt.id AND attempt.status='yielded' AND unit.status='waiting_for_input')`)
        .run(now, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
    }
  }
}

function requireTransition(result: { readonly ok: boolean }): void {
  if (!result.ok) throw new UserInputStoreError("source_conflict");
}
function yieldIdentity(input: CommitUserInputYield): string {
  const fence = input.sourceFence, proof = input.quiescence;
  return userInputHash({ threadId: input.threadId, requestId: input.requestId, requestVersion: input.expectedRequestVersion,
    workUnitId: fence.workUnitId, attemptId: fence.attemptId, runtimeInstanceId: fence.runtimeInstanceId, fencingToken: fence.fencingToken,
    kind: proof.kind, runnerId: proof.runnerId, stoppedAt: proof.stoppedAt, lastRunEventSeq: proof.lastRunEventSeq });
}
