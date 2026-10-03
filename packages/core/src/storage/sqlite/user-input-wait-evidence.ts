import type { DatabaseSync } from "node:sqlite";
import type { UserInputQuiescence } from "../../user-input-wait-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { userInputTimestamp } from "./user-input-records.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";

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
  const durableSettlements = assertUserInputDurableQuiescence(database, runId, sourceFence, stoppedAt);
  const active = new Map<string, string>();
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
    if (row.type === "tool_start") {
      if (active.has(id)) return reject();
      active.set(id, name);
    } else {
      if (active.get(id) !== name || !active.delete(id)) return reject();
      // Only built-in reads and the synchronous question control tool have no
      // external executor lifecycle. Other tools require their durable receipt.
      if (!["read", "grep", "find", "ls", "request_user_input"].includes(name)
        && durableSettlements.get(id) !== name) return reject();
    }
  }
  if (active.size) return reject();
}
