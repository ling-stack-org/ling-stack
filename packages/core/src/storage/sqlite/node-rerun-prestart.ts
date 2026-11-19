import type { NodeRerunPreparedTargetV1 } from "@ling-stack/contracts";
import type { RunStore } from "../../run-types.js";
import type { SqliteStoreContext } from "./store-context.js";

type Ports = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "getTask" | "listRuntimeEvents">;

/** Complete no-start inventory for the exact prepared target, including historical resource rows. */
export function hasNeverStartedNodeRerunTarget(context: SqliteStoreContext, ports: Ports,
  target: NodeRerunPreparedTargetV1, releasedAt?: string, verifiedCapacityIntentId?: string): boolean {
  const { runId, taskId, fence } = target, db = context.database;
  const run = ports.getRun(runId), unit = ports.getWorkUnit(fence.workUnitId);
  const attempt = ports.getWorkUnitAttempt(fence.attemptId), task = ports.getTask(taskId);
  if (!run || !unit || !attempt || !task || run.startedAt || unit.startedAt || attempt.startedAt
    || unit.lastHeartbeatAt || attempt.lastHeartbeatAt || attempt.abortRequestedAt
    || (releasedAt ? run.status !== "cancelled" || unit.status !== "cancelled" || attempt.status !== "cancelled"
      || task.status !== "cancelled" || run.endedAt !== releasedAt || unit.endedAt !== releasedAt || attempt.endedAt !== releasedAt
      : run.status !== "queued" || unit.status !== "queued" || attempt.status !== "created" || task.status !== "todo"
        || run.endedAt || unit.endedAt || attempt.endedAt)) return false;
  const events = ports.listRuntimeEvents(unit.id, { complete: true });
  if (events.length !== (releasedAt ? 2 : 1) || events.some(event => event.attemptId !== fence.attemptId
    || event.runtimeInstanceId !== fence.runtimeInstanceId || event.fencingToken !== fence.fencingToken)) return false;
  const claim = events[0];
  if (!claim || claim.type !== "work_unit_claimed" || claim.ts !== target.preparedAt
    || (releasedAt && events[1]?.type !== "work_unit_cancelled")) return false;
  for (const table of ["resource_leases", "runtime_semaphore_slots", "host_operations", "host_attempt_completions",
    "harness_tool_executions", "native_submissions"]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE work_unit_id=? OR attempt_id=? LIMIT 1`).get(unit.id, attempt.id)) return false;
  }
  // The capacity-specific validator derives and verifies the sole allowable journal row before passing its ID.
  if (db.prepare(`SELECT 1 FROM runtime_host_capacity_intents WHERE (run_id=? OR work_unit_id=? OR attempt_id=?)
    AND (? IS NULL OR intent_id<>?) LIMIT 1`).get(runId, unit.id, attempt.id, verifiedCapacityIntentId ?? null, verifiedCapacityIntentId ?? null)) return false;
  if (db.prepare("SELECT 1 FROM resource_leases WHERE owner_type='run' AND owner_id=? LIMIT 1").get(runId)) return false;
  for (const table of ["run_events", "runner_continuations", "runtime_run_queue", "run_terminal_intents"])
    if (db.prepare(`SELECT 1 FROM ${table} WHERE run_id=? LIMIT 1`).get(runId)) return false;
  return true;
}
