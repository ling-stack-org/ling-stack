import { UserInputStoreError, toRuntimeAttemptFence, type RunSession, type RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";

/** Shared by every generic cancellation writer, before events, summaries, aborts, or lease release. */
export function assertNoUnsafeRequiredPause(store: RunStore, run: RunSession): void {
  const work = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  const attempt = work?.activeAttemptId ? store.getWorkUnitAttempt(work.activeAttemptId) : undefined;
  if (!attempt) return;
  try {
    const required = store.findRequiredUserInputForAttempt({ sourceRunId: run.id, sourceFence: toRuntimeAttemptFence(attempt) });
    if (!required) return;
  } catch (error) {
    if (!(error instanceof UserInputStoreError)) throw error;
    // Conflict/corrupt evidence is not proof that no pause exists. Preserve
    // authority, but expose the same safe domain response instead of a raw 500.
  }
  throw new HttpError(409, "run_execution_recovery_blocked",
    "Execution has not reached a verified safe checkpoint; execution authority is retained.");
}
