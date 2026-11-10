import type { DatabaseSync } from "node:sqlite";
import type { DelegationCompletionStepReadV1 } from "../../delegation-completion-evidence.js";
import { delegationDigest } from "../../harness/delegation-write-validation.js";
import { stopFail } from "./run-suspension-stop-records.js";

/** Rechecked under the caller's transaction; absence of an active pointer alone proves nothing. */
export function neverDispatchedDescendantDigest(database: DatabaseSync, read: DelegationCompletionStepReadV1): string {
  const { step, reservation, childRun: run, workUnit: unit } = read;
  const owner = unit && database.prepare("SELECT attempt_count,active_attempt_id,started_at,ended_at FROM work_units WHERE id=?").get(unit.id);
  if (!run || !unit || !reservation || !owner || read.attempt || read.hostCompletion || read.charges.length || read.results.length
    || step.state !== "spawning" || step.childRunId !== undefined || step.completedAt !== undefined
    || run.status !== "queued" || run.endedAt || unit.status !== "queued" || unit.endedAt || unit.activeAttemptId
    || owner.attempt_count !== 0 || owner.active_attempt_id !== null || owner.started_at !== null || owner.ended_at !== null
    || reservation.state !== "reserved" || reservation.settledAt !== undefined) stopFail("descendant_dispatch_unverified");

  // Any execution/continuation/question/usage fact contradicts a never-dispatched
  // child, even if a corrupt row has hidden or cleared the active Attempt pointer.
  for (const table of ["work_unit_attempts", "resource_leases", "runtime_semaphore_slots"]) {
    if (database.prepare(`SELECT 1 FROM ${table} WHERE work_unit_id=? LIMIT 1`).get(unit.id)) stopFail("descendant_dispatch_unverified");
  }
  for (const table of ["host_attempt_completions", "host_operations", "harness_tool_executions", "native_submissions", "runner_continuations"]) {
    if (database.prepare(`SELECT 1 FROM ${table} WHERE run_id=? OR work_unit_id=? LIMIT 1`).get(run.id, unit.id)) stopFail("descendant_dispatch_unverified");
  }
  for (const table of ["run_events", "approval_requests"]) {
    if (database.prepare(`SELECT 1 FROM ${table} WHERE run_id=? LIMIT 1`).get(run.id)) stopFail("descendant_dispatch_unverified");
  }
  if (database.prepare("SELECT 1 FROM user_input_requests WHERE source_run_id=? LIMIT 1").get(run.id)
    || database.prepare("SELECT 1 FROM delegation_budget_charges WHERE run_id=? OR reservation_id=? LIMIT 1").get(run.id, reservation.id)
    || database.prepare("SELECT 1 FROM runtime_events WHERE work_unit_id=? AND attempt_id IS NOT NULL LIMIT 1").get(unit.id)) {
    stopFail("descendant_dispatch_unverified");
  }
  // Ancestor status may change during leaf-first shutdown. Freeze this child's
  // original full Run/WU fingerprints and allocation, not ancestor liveness.
  return delegationDigest({ kind: "run.suspension_never_dispatched.v1", step, reservation, run, unit });
}
