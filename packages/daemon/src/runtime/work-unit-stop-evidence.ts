import type { WorkUnitDetailResponse } from "@ling-stack/contracts";
import { toRuntimeAttemptFence, type RunStore, type WorkUnit, type WorkUnitAttempt } from "@ling-stack/core";
import type { ActiveRunRegistry } from "./active-runs.js";

/** Read original Host/callback facts, then apply Core's independently reverified durable vetoes. */
export function readWorkUnitStopEvidence(store: RunStore, unit: WorkUnit, attempts: readonly WorkUnitAttempt[],
  activeRuns: ActiveRunRegistry): NonNullable<WorkUnitDetailResponse["stopEvidence"]> {
  const run = unit.linkedRunId ? store.getRun(unit.linkedRunId) : undefined;
  return { schemaVersion: 1, workUnitId: unit.id, attempts: attempts.map(attempt => {
    const identity = { attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken };
    if (!run || run.workUnitId !== unit.id) return { ...identity, localExecution: "unverified", effects: "unverified" };
    const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) };
    const observed = activeRuns.observeAttemptStop(source);
    try {
      const completion = store.getHostAttemptCompletion(source);
      const localExecution = observed.localExecution === "unverified" && completion?.drainedAt
        ? "drained" as const : observed.localExecution;
      const operations = store.listHostOperationBlockers(source);
      const commands = store.listHostCommandWriteBlockers(run.cwd).filter(command => command.runId === run.id && command.attemptId === attempt.id);
      const effects = observed.effects === "unknown" || operations.some(operation => operation.phase === "unknown_outcome")
        || commands.some(command => command.state === "stop_unconfirmed") ? "unknown"
        : operations.length || commands.length || observed.effects === "pending" ? "pending"
        // The in-memory group covers only enrolled executors. Even an empty
        // group needs the closed SDK/Host inventory before certifying effects.
        : completion?.drainedAt && completion.effectCoverage ? "settled" : "unverified";
      return { ...identity, localExecution, effects };
    } catch {
      // Corrupt/mismatched or unavailable journals cannot become proof of no effects.
      return { ...identity, localExecution: observed.localExecution, effects: "unverified" };
    }
  }) };
}
