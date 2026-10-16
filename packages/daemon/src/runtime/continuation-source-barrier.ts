import { toRuntimeAttemptFence, type RunStore, type WorkUnit } from "@ling-stack/core";
import type { ActiveRunRegistry } from "./active-runs.js";
import { readWorkUnitStopEvidence } from "./work-unit-stop-evidence.js";

/** Terminal state is not physical completion. Never claim or fail a queued action while its source drains. */
export function continuationSourceReady(store: RunStore, unit: WorkUnit, activeRuns: ActiveRunRegistry,
  key: string, retry: () => void | Promise<void>): boolean {
  const run = unit.linkedRunId ? store.getRun(unit.linkedRunId) : undefined;
  if (!run || run.workUnitId !== unit.id || !["succeeded", "failed", "cancelled"].includes(run.status)) return false;
  const attempts = store.listWorkUnitAttempts(unit.id);
  const original = attempts.find(attempt => attempt.id === unit.activeAttemptId) ?? attempts.at(-1);
  if (!original) return false;
  const source = { runId: run.id, ...toRuntimeAttemptFence(original) };
  if (activeRuns.deferUntilAttemptDrained(source, key, retry)) return false;
  const evidence = readWorkUnitStopEvidence(store, unit, attempts, activeRuns);
  if (evidence.attempts.some(attempt => attempt.localExecution !== "drained")) return false;
  if (evidence.attempts.some(attempt => attempt.effects !== "settled")) return false;
  return !store.listResourceLeases({ workUnitId: unit.id, status: "active" }).length
    && !store.listRuntimeSemaphoreSlots({ workUnitId: unit.id, status: "active" }).length;
}
