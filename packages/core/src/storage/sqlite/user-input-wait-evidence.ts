import type { DatabaseSync } from "node:sqlite";
import type { UserInputQuiescence } from "../../user-input-wait-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { userInputTimestamp } from "./user-input-records.js";

/** Validates a trusted Host stop receipt against the complete, current atomic tool log. */
export function assertUserInputQuiescence(database: DatabaseSync, runId: string, proof: UserInputQuiescence, now: string): void {
  const reject = (): never => { throw new UserInputStoreError("not_quiescent"); };
  if (!proof || proof.kind !== "runner_quiesced" || typeof proof.runnerId !== "string" || !proof.runnerId
    || !Number.isSafeInteger(proof.lastRunEventSeq) || proof.lastRunEventSeq < 0) return reject();
  const stoppedAt = userInputTimestamp(proof.stoppedAt);
  if (stoppedAt > userInputTimestamp(now)) return reject();
  const last = database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq, MAX(ts) AS ts FROM run_events WHERE run_id=?").get(runId);
  if (last?.seq !== proof.lastRunEventSeq || (typeof last.ts === "string" && Date.parse(last.ts) > stoppedAt)) return reject();
  if (database.prepare("SELECT 1 FROM approval_requests WHERE run_id=? AND status='pending' LIMIT 1").get(runId)) return reject();
  const active = new Set<string>();
  // Iterate, rather than truncating to the first page or materializing every output payload.
  for (const row of database.prepare(`SELECT type, data_json FROM run_events WHERE run_id=?
    AND type IN ('tool_start','tool_end','run_end','run_error','run_cancelled','result') ORDER BY seq`).iterate(runId)) {
    if (row.type !== "tool_start" && row.type !== "tool_end") return reject();
    let data: unknown;
    try { data = JSON.parse(String(row.data_json)); } catch { return reject(); }
    const id = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).toolCallId : undefined;
    if (typeof id !== "string" || !id) return reject();
    if (row.type === "tool_start") {
      if (active.has(id)) return reject();
      active.add(id);
    } else if (!active.delete(id)) return reject();
  }
  if (active.size) return reject();
}
