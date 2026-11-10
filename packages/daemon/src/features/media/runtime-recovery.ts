import type { MediaJobExecutionHandle, RunStore } from "@ling-stack/core";
import type { MediaRuntimeHandle, RunMediaJobHooks } from "./executor.js";

/**
 * Rebinds a persisted external media operation to a new fenced Attempt after
 * RuntimeSupervisor invalidates the previous daemon's execution ownership.
 * The external operation handle remains authoritative, so recovery polls the
 * existing operation and never submits paid work a second time.
 */
export function restoreOrRecoverMediaRuntimeHandle(input: {
  readonly store: RunStore;
  readonly handle: MediaJobExecutionHandle | undefined;
  readonly hooks: RunMediaJobHooks;
  readonly reason: string;
}): MediaRuntimeHandle | undefined {
  const { handle } = input;
  if (!handle?.workUnitId || !handle.attemptId) return undefined;
  const workUnit = input.store.getWorkUnit(handle.workUnitId);
  const attempt = input.store.getWorkUnitAttempt(handle.attemptId);
  if (!workUnit || !attempt || attempt.workUnitId !== workUnit.id) return undefined;

  if (workUnit.activeAttemptId === attempt.id
    && (workUnit.status === "claimed" || workUnit.status === "running")
    && (attempt.status === "created" || attempt.status === "started")) {
    return { workUnit, attempt };
  }

  if (workUnit.activeAttemptId !== attempt.id
    || workUnit.status !== "stale"
    || attempt.status !== "lost") {
    return undefined;
  }

  return input.hooks.recoverRuntimeWorkUnit({
    store: input.store,
    workUnit,
    reason: input.reason,
    providerPresetId: workUnit.providerPresetId,
  });
}
