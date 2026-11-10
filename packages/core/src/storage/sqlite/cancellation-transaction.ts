import type { DatabaseSync } from "node:sqlite";
import type { RunStore } from "../../run-types.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

const cancellations = new WeakMap<DatabaseSync, (() => void)[]>();

export function ownsCancellationTransaction(database: DatabaseSync): boolean {
  return cancellations.has(database);
}

export function afterCancellationCommit(database: DatabaseSync, publish: () => void): void {
  const effects = cancellations.get(database);
  if (effects) effects.push(publish);
  else publish();
}

/** The writer lock covers target validation, logical cancellation and exact-owner cleanup. */
export function withCancellationFence<T>(database: DatabaseSync,
  ports: Pick<RunStore, "getRun" | "getWorkUnit">,
  input: Parameters<RunStore["withCancellationFence"]>[0],
  mutate: Parameters<RunStore["withCancellationFence"]>[1],
): T {
  if (Object.prototype.toString.call(mutate) === "[object AsyncFunction]") {
    throw new TypeError("Cancellation must be synchronous");
  }
  const target = { ...input };
  database.exec("BEGIN IMMEDIATE");
  const effects: (() => void)[] = [];
  let committed = false;
  try {
    const run = target.runId ? ports.getRun(target.runId) : undefined;
    const workUnitId = target.workUnitId ?? run?.workUnitId;
    const workUnit = workUnitId ? ports.getWorkUnit(workUnitId) : undefined;
    if ((!target.runId && !workUnitId) || (target.runId && !run) || (workUnitId && !workUnit)
      || (target.workUnitId && run?.workUnitId !== undefined && run.workUnitId !== target.workUnitId)
      || (run && workUnit?.linkedRunId && workUnit.linkedRunId !== run.id)
      || (target.expectedAttemptId !== undefined && (workUnit?.activeAttemptId ?? null) !== target.expectedAttemptId)
      || (target.expectedRunId !== undefined && (workUnit?.linkedRunId ?? null) !== target.expectedRunId)) {
      throw Object.assign(new Error("The cancellation target has been replaced."), { code: "stale_cancellation" });
    }
    cancellations.set(database, effects);
    const result = mutate({ run, workUnit }) as T;
    if (result && (typeof result === "object" || typeof result === "function") && typeof Reflect.get(result, "then") === "function") {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError("Cancellation must be synchronous");
    }
    database.exec("COMMIT");
    committed = true;
    cancellations.delete(database);
    for (const publish of effects) publish();
    return result;
  } catch (error) {
    if (!committed) rollbackOwnedSqliteTransaction(database);
    throw error;
  } finally {
    cancellations.delete(database);
  }
}
