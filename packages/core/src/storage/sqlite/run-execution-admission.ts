import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import type { SqliteStoreContext } from "./store-context.js";

/** Captured execution identity checked inside each authoritative write, not just before it. */
export const runExecutionOwnerSql = `EXISTS (
  SELECT 1 FROM run_sessions AS execution_run
  JOIN work_units AS execution_unit ON execution_unit.id = execution_run.work_unit_id
  JOIN work_unit_attempts AS execution_attempt ON execution_attempt.id = execution_unit.active_attempt_id
  WHERE execution_run.id = ? AND execution_run.work_unit_id = ?
    AND execution_unit.linked_run_id = execution_run.id
    AND execution_attempt.id = ? AND execution_attempt.work_unit_id = execution_unit.id
    AND execution_attempt.runtime_instance_id = ? AND execution_attempt.fencing_token = ?
    AND execution_run.status IN ('queued','running','waiting_for_approval')
    AND execution_run.ended_at IS NULL AND execution_attempt.ended_at IS NULL
    AND (
      (execution_unit.status IN ('queued','claimed','running','waiting_for_approval')
        AND execution_attempt.status IN ('created','started','waiting_for_approval')
        AND execution_attempt.abort_requested_at IS NULL)
      OR (? = 1 AND execution_unit.status IN ('running','waiting_for_approval','cancelling')
        AND execution_attempt.status IN ('created','started','waiting_for_approval','cancelling'))
    )
)`;

export function runExecutionOwnerParameters(runId: string, fence: RuntimeAttemptFenceV1, allowCleanup: boolean): readonly (string | number)[] {
  return [runId, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken, allowCleanup ? 1 : 0];
}

/** Read-side guard for callbacks; callers still need the same predicate at the mutation boundary. */
export function isCurrentRunExecutionOwner(context: SqliteStoreContext, runId: string, fence: RuntimeAttemptFenceV1, allowCleanup: boolean): boolean {
  return Boolean(context.database.prepare(`SELECT 1 WHERE ${runExecutionOwnerSql}`)
    .get(...runExecutionOwnerParameters(runId, fence, allowCleanup)));
}

/** Fact-only identity for original verified settlements, not permission to launch or clean up effects. */
export function isCapturedCancelledRunOwner(context: SqliteStoreContext, runId: string, fence: RuntimeAttemptFenceV1): boolean {
  return Boolean(context.database.prepare(`SELECT 1 FROM run_sessions AS run
    JOIN work_units AS unit ON unit.id=run.work_unit_id
    JOIN work_unit_attempts AS attempt ON attempt.id=unit.active_attempt_id
    WHERE run.id=? AND run.work_unit_id=? AND unit.linked_run_id=run.id
      AND attempt.id=? AND attempt.work_unit_id=unit.id
      AND attempt.runtime_instance_id=? AND attempt.fencing_token=?
      AND run.status='cancelled' AND unit.status='cancelled' AND attempt.status='cancelled'
      AND run.ended_at IS NOT NULL AND attempt.ended_at IS NOT NULL`)
    .get(runId, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken));
}
