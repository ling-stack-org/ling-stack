import type { DatabaseSync } from "node:sqlite";
import type { UserInputQuiescence } from "../../user-input-wait-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { userInputTimestamp } from "./user-input-records.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { readUserInputDurableSettlementsByAttempt } from "./user-input-durable-quiescence.js";
import { assertHistoricalAttemptSource, hostAttemptReadScopeForSource } from "./host-attempt-read-scope.js";

/** Validates a trusted Host stop receipt against the complete, current atomic tool log. */
export function assertUserInputQuiescence(
  database: DatabaseSync, runId: string, proof: UserInputQuiescence, now: string, sourceFence: RuntimeAttemptFenceV1,
): void {
  const reject = (): never => { throw new UserInputStoreError("not_quiescent"); };
  if (!proof || proof.kind !== "runner_quiesced" || typeof proof.runnerId !== "string" || !proof.runnerId
    || !Number.isSafeInteger(proof.lastRunEventSeq) || proof.lastRunEventSeq < 0) return reject();
  let stoppedAt: number;
  try {
    stoppedAt = userInputTimestamp(proof.stoppedAt);
    if (stoppedAt > userInputTimestamp(now)) return reject();
  } catch { return reject(); }
  const last = database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq, MAX(ts) AS ts FROM run_events WHERE run_id=?").get(runId);
  if (last?.seq !== proof.lastRunEventSeq) return reject();
  try { if (last.ts !== null && (typeof last.ts !== "string" || userInputTimestamp(last.ts) > stoppedAt)) return reject(); }
  catch { return reject(); }
  if (database.prepare("SELECT 1 FROM approval_requests WHERE run_id=? AND status='pending' LIMIT 1").get(runId)) return reject();
  const source = { runId, ...sourceFence }, scope = hostAttemptReadScopeForSource(database, source);
  const durableSettlements = readUserInputDurableSettlementsByAttempt(database, runId, sourceFence, stoppedAt, scope);
  const activeByAttempt = new Map<string, Map<string, string>>();
  const verifiedHistorical = new Set<string>();
  // Iterate, rather than truncating to the first page or materializing every output payload.
  for (const row of database.prepare(`SELECT type, ts, data_json FROM run_events WHERE run_id=?
    AND type IN ('tool_start','tool_end','run_end','run_error','run_cancelled','result') ORDER BY seq`).iterate(runId)) {
    if (row.type !== "tool_start" && row.type !== "tool_end") return reject();
    try { if (typeof row.ts !== "string" || userInputTimestamp(row.ts) > stoppedAt) return reject(); }
    catch { return reject(); }
    let data: unknown;
    try { data = JSON.parse(String(row.data_json)); } catch { return reject(); }
    const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
    const id = record?.toolCallId, name = record?.toolName;
    if (typeof id !== "string" || !id || typeof name !== "string" || !name) return reject();
    let attemptId = sourceFence.attemptId;
    if (scope === "exact_attempt") {
      // New execution tool events are attributed at Host admission. Missing
      // attribution is not inferred from timestamps or a reused toolCallId.
      if (typeof record?.attemptId !== "string" || !record.attemptId) return reject();
      attemptId = record.attemptId;
      if (attemptId !== sourceFence.attemptId && !verifiedHistorical.has(attemptId)) {
        const historical = database.prepare(`SELECT runtime_instance_id,fencing_token FROM work_unit_attempts
          WHERE id=? AND work_unit_id=?`).get(attemptId, sourceFence.workUnitId);
        if (typeof historical?.runtime_instance_id !== "string" || typeof historical.fencing_token !== "string") return reject();
        try {
          assertHistoricalAttemptSource(database, source, { runId, workUnitId: sourceFence.workUnitId, attemptId,
            runtimeInstanceId: historical.runtime_instance_id, fencingToken: historical.fencing_token }, proof.stoppedAt);
        } catch { return reject(); }
        verifiedHistorical.add(attemptId);
      }
    }
    const active = activeByAttempt.get(attemptId) ?? new Map<string, string>();
    activeByAttempt.set(attemptId, active);
    if (row.type === "tool_start") {
      if (active.has(id)) return reject();
      active.set(id, name);
    } else {
      if (active.get(id) !== name || !active.delete(id)) return reject();
      // Only built-in reads and the synchronous question control tool have no
      // external executor lifecycle. Other tools require their durable receipt.
      if (!["read", "grep", "find", "ls", "request_user_input"].includes(name)
        && durableSettlements.get(attemptId)?.get(id) !== name) return reject();
    }
  }
  if ([...activeByAttempt.values()].some(active => active.size)) return reject();
}
