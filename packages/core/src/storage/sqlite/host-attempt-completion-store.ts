import type { HostOperationSource } from "../../host-operation-journal-types.js";
import type { HostAttemptCompletionRecord, HostAttemptEffectObservation } from "../../host-attempt-completion-types.js";
import { readTrackedToolCoverage, verifiedTrackedToolCalls } from "./host-attempt-tracked-coverage.js";
import { readString, rollbackOwnedSqliteTransaction } from "./helpers.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import type { SqliteStoreContext } from "./store-context.js";

const capturedSourceSql = `EXISTS (SELECT 1 FROM run_sessions AS run
  JOIN work_units AS unit ON unit.id=run.work_unit_id
  JOIN work_unit_attempts AS attempt ON attempt.work_unit_id=unit.id
  WHERE run.id=c.run_id AND unit.id=c.work_unit_id AND unit.linked_run_id=run.id
    AND attempt.id=c.attempt_id AND attempt.runtime_instance_id=c.runtime_instance_id
    AND attempt.fencing_token=c.fencing_token)`;

export class SqliteHostAttemptCompletionStore {
  constructor(private readonly context: SqliteStoreContext,
    private readonly resources: Pick<import("../../run-types.js").RunStore,
      "releaseResourceLeasesForAttempt" | "releaseRuntimeSemaphoreSlotsForAttempt">) {}

  releaseHostAttemptResources(source: HostOperationSource, releasedAt: string): void {
    this.write(() => {
      if (!this.getHostAttemptCompletion(source)?.drainedAt) return;
      // Both resource tables use the existing exact-owner and effect vetoes.
      // A failed second write must not partially release the first table.
      this.resources.releaseResourceLeasesForAttempt(source, releasedAt, "run-finished");
      this.resources.releaseRuntimeSemaphoreSlotsForAttempt(source, releasedAt, "run-finished");
    });
  }

  trackHostAttemptCompletion(source: HostOperationSource, lifetime: Promise<unknown>,
    verifyEffectCoverage?: () => HostAttemptEffectObservation): Promise<HostAttemptCompletionRecord> {
    if (!(lifetime instanceof Promise)) throw new Error("host_attempt_completion_invalid_lifetime");
    const captured = Object.freeze({ runId: source.runId, workUnitId: source.workUnitId, attemptId: source.attemptId,
      runtimeInstanceId: source.runtimeInstanceId, fencingToken: source.fencingToken });
    const db = this.context.database;
    this.write(() => {
      if (!isCurrentRunExecutionOwner(this.context, captured.runId, captured, false)) {
        throw new Error("host_attempt_completion_invalid_source");
      }
      if (db.prepare("SELECT 1 FROM host_attempt_completions WHERE attempt_id=?").get(captured.attemptId)) {
        throw new Error("host_attempt_completion_already_registered");
      }
      db.prepare(`INSERT INTO host_attempt_completions
        (schema_version,run_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,registered_at)
        VALUES (1,?,?,?,?,?,?)`).run(captured.runId, captured.workUnitId, captured.attemptId,
          captured.runtimeInstanceId, captured.fencingToken, new Date().toISOString());
    });
    // Both fulfillment and rejection end the captured lifetime, not its effects.
    const finish = () => this.write(() => {
      const drainedAt = new Date().toISOString();
      const observation = verifyEffectCoverage?.();
      const coverage = observation === true ? "pi_no_tools_v1" : "unverified";
      const tracked = verifiedTrackedToolCalls(db, captured, observation, drainedAt);
      const changed = db.prepare(`UPDATE host_attempt_completions AS c SET drained_at=?,effect_coverage=?,tracked_tool_calls_json=?
        WHERE c.run_id=? AND c.work_unit_id=? AND c.attempt_id=? AND c.runtime_instance_id=? AND c.fencing_token=?
          AND c.drained_at IS NULL AND ${capturedSourceSql}`)
        .run(drainedAt, coverage, tracked ? JSON.stringify(tracked) : null, captured.runId, captured.workUnitId, captured.attemptId,
          captured.runtimeInstanceId, captured.fencingToken);
      if (changed.changes !== 1) throw new Error("host_attempt_completion_invalid_source");
      const fact = this.getHostAttemptCompletion(captured);
      if (!fact?.drainedAt) throw new Error("host_attempt_completion_invalid_source");
      return fact;
    });
    return lifetime.then(finish, finish);
  }

  getHostAttemptCompletion(source: HostOperationSource): HostAttemptCompletionRecord | undefined {
    const row = this.context.database.prepare(`SELECT c.* FROM host_attempt_completions AS c
      WHERE c.run_id=? AND c.work_unit_id=? AND c.attempt_id=? AND c.runtime_instance_id=? AND c.fencing_token=?
        AND ${capturedSourceSql}`)
      .get(source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken);
    if (!row) return undefined;
    return Object.freeze({ schemaVersion: 1, source: Object.freeze({ runId: readString(row, "run_id"),
      workUnitId: readString(row, "work_unit_id"), attemptId: readString(row, "attempt_id"),
      runtimeInstanceId: readString(row, "runtime_instance_id"), fencingToken: readString(row, "fencing_token") }),
      registeredAt: readString(row, "registered_at"),
      ...(row.drained_at !== null && row.effect_coverage === "pi_no_tools_v1" ? { effectCoverage: "pi_no_tools_v1" as const }
        : row.drained_at !== null && readTrackedToolCoverage(this.context.database, source, row.tracked_tool_calls_json,
          new Date().toISOString()) ? { effectCoverage: "pi_tracked_tools_v1" as const } : {}),
      ...(row.drained_at === null ? {} : { drainedAt: readString(row, "drained_at") }) });
  }

  private write<T>(callback: () => T): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.context.database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }
}
