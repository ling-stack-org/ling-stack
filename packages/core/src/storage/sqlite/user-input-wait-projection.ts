import type { DatabaseSync } from "node:sqlite";
import type { LingThread, LingThreadStatus, LingTurn, LingTurnStatus, RunSession } from "../../run-types.js";
import type { UserInputWait } from "../../user-input-wait-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";

/** A physical Run ending cannot hide another logical input wait in its Thread. */
export function projectThreadUserInputWait(
  database: DatabaseSync,
  getWait: (threadId: string, requestId: string) => UserInputWait | undefined,
  thread: LingThread,
  endingRunId: string | undefined,
): { readonly status: LingThreadStatus; readonly activeRunId: string | null } | undefined {
  const rows = database.prepare(`SELECT q.request_id,q.source_run_id,r.status AS run_status,r.thread_id AS run_thread_id
    FROM user_input_requests q LEFT JOIN run_sessions r ON r.id=q.source_run_id
    WHERE q.workspace_id=? AND q.thread_id=? AND q.wait_status IN ('waiting','resuming','blocked')`)
    .all(thread.workspaceId, thread.id);
  if (rows.length === 0) return undefined;
  let invalid = false;
  for (const row of rows) {
    try {
      const wait = getWait(thread.id, String(row.request_id));
      if (!wait || wait.checkpoint.source.workspaceId !== thread.workspaceId
        || wait.checkpoint.source.threadId !== thread.id || wait.checkpoint.source.runId !== row.source_run_id
        || row.run_status !== "yielded" || row.run_thread_id !== thread.id || wait.status === "blocked") invalid = true;
    } catch (error) {
      if (!(error instanceof UserInputStoreError) || error.code !== "invalid_record") throw error;
      invalid = true;
    }
  }
  // Some Host terminal notifications precede the final Run status write. Ignore
  // only that source Run, never a sibling selected via the current active pointer.
  const active = database.prepare(`SELECT id,status FROM run_sessions WHERE thread_id=?
    AND status IN ('queued','running','waiting_for_approval') AND (? IS NULL OR id<>?)
    ORDER BY CASE WHEN status='waiting_for_approval' THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT 1`)
    .get(thread.id, endingRunId ?? null, endingRunId ?? null);
  return active ? { status: active.status === "waiting_for_approval" ? "waiting_for_approval" : "running", activeRunId: String(active.id) }
    : { status: invalid ? "blocked" : "waiting_for_input", activeRunId: null };
}

/** Reads validated question checkpoints, including waiting siblings of the latest Run. */
export function projectTurnUserInputWait(
  database: DatabaseSync,
  getWait: (threadId: string, requestId: string) => UserInputWait | undefined,
  turn: LingTurn,
  runs: readonly RunSession[],
  latestRunId: string | undefined,
): LingTurnStatus | undefined {
  const yieldedRuns = runs.filter(run => run.status === "yielded");
  if (yieldedRuns.length === 0) return undefined;
  let latestStatus: LingTurnStatus | undefined;
  let waiting = false;
  let invalid = false;
  const read = database.prepare(`SELECT request_id FROM user_input_requests
    WHERE workspace_id=? AND thread_id=? AND source_run_id=? AND wait_status IS NOT NULL`);
  for (const run of yieldedRuns) {
    const rows = read.all(turn.workspaceId, turn.threadId, run.id);
    if (rows.length === 0 && run.id === latestRunId) latestStatus = "blocked";
    for (const row of rows) {
      try {
        const wait = getWait(turn.threadId, String(row.request_id));
        if (!wait || wait.checkpoint.source.runId !== run.id || wait.checkpoint.source.turnId !== turn.id) {
          invalid = true;
        } else if (wait.status === "waiting" || wait.status === "resuming") {
          waiting = true;
        } else if (wait.status === "blocked") {
          invalid = true;
        } else if (run.id === latestRunId && wait.status === "cancelled") {
          latestStatus = "cancelled";
        }
      } catch (error) {
        if (!(error instanceof UserInputStoreError) || error.code !== "invalid_record") throw error;
        invalid = true;
      }
    }
  }
  return invalid ? "blocked" : waiting ? "waiting_for_input" : latestStatus;
}
