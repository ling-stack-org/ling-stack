import type { DatabaseSync } from "node:sqlite";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import { hasRootSuspensionTargetLineage } from "./run-suspension-activation-records.js";
import { hasDelegatedSuspensionTargetLineage } from "./run-suspension-delegated-records.js";

/** Opt-in only. Existing whole-Run readers keep their fail-closed contract. */
export type HostAttemptReadScope = "whole_run" | "exact_attempt";

/** Exact scope is derived from committed delegation ownership, never a caller flag. */
export function hostAttemptReadScopeForSource(database: DatabaseSync, source: HostOperationSource): HostAttemptReadScope {
  return database.prepare(`SELECT 1 FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
    JOIN delegation_steps s ON s.id=u.owner_id AND s.child_run_id=r.id AND s.parent_run_id=r.parent_run_id
    JOIN delegation_budget_reservations b ON b.delegation_step_id=s.id AND b.child_run_id=r.id AND b.root_run_id=s.root_run_id
    JOIN work_unit_attempts a ON a.work_unit_id=u.id
    WHERE r.id=? AND u.id=? AND u.owner_type='delegation_step' AND a.id=? AND a.runtime_instance_id=? AND a.fencing_token=?`)
    .get(source.runId, source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken)
    || hasRootSuspensionTargetLineage(database, source) || hasDelegatedSuspensionTargetLineage(database, source) ? "exact_attempt" : "whole_run";
}

/**
 * A different row is not automatically historical. Before excluding it, prove
 * its immutable owner/fence, terminal Attempt and original drained lifetime.
 * Its individual executor facts still require the caller's normal verifier.
 */
export function assertHistoricalAttemptSource(database: DatabaseSync, expected: HostOperationSource,
  historical: HostOperationSource, at: string): void {
  const reject = (): never => { throw new Error("host_attempt_historical_source_unverified"); };
  if (historical.runId !== expected.runId || historical.workUnitId !== expected.workUnitId
    || historical.attemptId === expected.attemptId) return reject();
  const row = database.prepare(`SELECT a.status,a.ended_at,c.registered_at,c.drained_at,c.effect_coverage,
    c.tracked_tool_calls_json,c.native_effect_inventory_json FROM work_unit_attempts a
    JOIN run_sessions r ON r.work_unit_id=a.work_unit_id
    JOIN host_attempt_completions c ON c.run_id=r.id AND c.work_unit_id=a.work_unit_id AND c.attempt_id=a.id
      AND c.runtime_instance_id=a.runtime_instance_id AND c.fencing_token=a.fencing_token
    WHERE r.id=? AND a.work_unit_id=? AND a.id=? AND a.runtime_instance_id=? AND a.fencing_token=?`)
    .get(historical.runId, historical.workUnitId, historical.attemptId, historical.runtimeInstanceId, historical.fencingToken);
  if (!row || !["succeeded", "failed", "cancelled", "lost", "yielded"].includes(String(row.status))
    || !canonicalBefore(row.ended_at, at) || !canonicalBefore(row.registered_at, at) || !canonicalBefore(row.drained_at, at)
    || String(row.drained_at) < String(row.registered_at)) return reject();
  if (row.effect_coverage === "pi_no_tools_v1") return;
  if (typeof row.tracked_tool_calls_json === "string") {
    const inventory: unknown = JSON.parse(row.tracked_tool_calls_json);
    const ids = Array.isArray(inventory) ? inventory : inventory && typeof inventory === "object"
      && (inventory as Record<string, unknown>).schemaVersion === 1 ? (inventory as Record<string, unknown>).toolCallIds : undefined;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id.length) || new Set(ids).size !== ids.length) return reject();
    return;
  }
  if (typeof row.native_effect_inventory_json === "string") {
    const inventory: unknown = JSON.parse(row.native_effect_inventory_json);
    if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return reject();
    const data = inventory as Record<string, unknown>;
    if (data.schemaVersion !== 1 || data.kind !== "native_journal_v1" || !Array.isArray(data.submissionIds)
      || data.submissionIds.some(id => typeof id !== "string" || !id.length) || new Set(data.submissionIds).size !== data.submissionIds.length) return reject();
    return;
  }
  return reject();
}

function canonicalBefore(value: unknown, at: string): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && value <= at;
}
