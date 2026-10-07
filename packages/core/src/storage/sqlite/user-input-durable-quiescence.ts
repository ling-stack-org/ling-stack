import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isHostCommandPreparedV1, isHostCommandSettledV1, type HostCommandPreparedV1 } from "@ling-stack/contracts";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { UserInputStoreError } from "../../user-input-store-types.js";
import { userInputTimestamp } from "./user-input-records.js";
import { readHostOperationBlockers } from "./host-operation-journal-store.js";
import { readSourceHostOperations } from "./host-operation-journal-evidence.js";
import { readUserInputMediaSettlements } from "./user-input-media-settlements.js";

const reject = (): never => { throw new UserInputStoreError("not_quiescent"); };
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Reads source-bound executor facts in the caller's write transaction. This is a
 * durable veto, not a substitute for the Host's admission latch and physical drain.
 * Missing/unknown executor protocols remain blocking; neither tool_end nor a
 * transport/leader exit manufactures a confirmed-stop receipt.
 */
export function assertUserInputDurableQuiescence(
  database: DatabaseSync, runId: string, fence: RuntimeAttemptFenceV1, stoppedAt: number,
): ReadonlyMap<string, string> {
  try {
    assertStoredFence(database, runId, fence);
    const operationSource = { runId, ...fence };
    if (readHostOperationBlockers(database, operationSource, new Date(stoppedAt).toISOString()).length) return reject();
    const safeFileExecutions = new Set(readSourceHostOperations(database, operationSource)
      .filter(operation => operation.phase === "safe" && operation.settlementKind === "file_completed"
        && operation.evidenceRef?.kind === "harness_tool_execution").map(operation => operation.evidenceRef!.id));
    const noStartCommands = readHostCommandSettlements(database, runId, fence, stoppedAt);
    const settledTools = new Map<string, string>([...noStartCommands].map(id => [id, "bash"]));
    for (const row of database.prepare(`SELECT execution.*, attempt.runtime_instance_id AS source_runtime_instance_id,
      attempt.fencing_token AS source_fencing_token FROM harness_tool_executions AS execution
      LEFT JOIN work_unit_attempts AS attempt ON attempt.id=execution.attempt_id
      WHERE execution.run_id=? OR execution.attempt_id=? ORDER BY execution.created_at,execution.id`).iterate(runId, fence.attemptId)) {
      if (row.run_id !== runId || row.work_unit_id !== fence.workUnitId || row.attempt_id !== fence.attemptId
        || row.source_runtime_instance_id !== fence.runtimeInstanceId || row.source_fencing_token !== fence.fencingToken
        || row.schema_version !== 1 || !text(row.tool_call_id) || !text(row.tool_name)
        || !["bash", "write", "apply_patch"].includes(String(row.executor_kind))) return reject();
      const state = String(row.state);
      if (!["succeeded", "denied", "failed", "cancelled", "superseded"].includes(state)) return reject();
      const finished = timestampBefore(row.execution_finished_at, stoppedAt);
      const created = timestampBefore(row.created_at, stoppedAt);
      const updated = timestampBefore(row.updated_at, stoppedAt);
      if (finished < created || updated < finished) return reject();
      if (row.execution_started_at === null) {
        // A terminal pre-effect fact is a durable no-start. A live approved or
        // claimed row is NOT no-start and was rejected above, even after expiry.
        if (state === "succeeded") return reject();
      } else {
        const started = timestampBefore(row.execution_started_at, stoppedAt);
        if (started < created || started > finished || !text(row.result_digest) || !/^[a-f0-9]{64}$/.test(row.result_digest)) return reject();
        if (row.executor_kind === "bash") {
          // Current command observations explicitly say descendants=unverified.
          // Only a journalled no-launch can presently establish safe bash drain.
          if (!noStartCommands.has(row.tool_call_id) || !["failed", "cancelled"].includes(state)) return reject();
        } else {
          const summary = parseRecord(row.result_summary_json);
          if (!["applied", "not_applied", "rolled_back"].includes(String(summary.outcome))
            || !safeFileExecutions.has(String(row.id))) return reject();
        }
      }
      const previous = settledTools.get(row.tool_call_id);
      if (previous && previous !== row.tool_name) return reject();
      settledTools.set(row.tool_call_id, row.tool_name);
    }
    for (const [id, name] of readUserInputMediaSettlements(database, operationSource, new Date(stoppedAt).toISOString())) {
      if (settledTools.has(id) && settledTools.get(id) !== name) return reject();
      settledTools.set(id, name);
    }
    return settledTools;
  } catch { return reject(); }
}

/** Validates immutable historical lineage, also after yield cleared the active Attempt pointer. */
function assertStoredFence(database: DatabaseSync, runId: string, fence: RuntimeAttemptFenceV1): void {
  if (!fence || ![fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken].every(text)) return reject();
  const row = database.prepare(`SELECT run.work_unit_id, attempt.work_unit_id AS attempt_work_unit_id,
    attempt.runtime_instance_id, attempt.fencing_token FROM run_sessions AS run
    JOIN work_unit_attempts AS attempt ON attempt.id=? WHERE run.id=?`).get(fence.attemptId, runId);
  if (!row || row.work_unit_id !== fence.workUnitId || row.attempt_work_unit_id !== fence.workUnitId
    || row.runtime_instance_id !== fence.runtimeInstanceId || row.fencing_token !== fence.fencingToken) return reject();
}

function readHostCommandSettlements(
  database: DatabaseSync, runId: string, fence: RuntimeAttemptFenceV1, stoppedAt: number,
): ReadonlySet<string> {
  const active = new Map<string, { readonly data: HostCommandPreparedV1; readonly seq: number; readonly at: number }>();
  const seen = new Set<string>(), noStart = new Set<string>();
  for (const row of database.prepare(`SELECT seq,ts,type,data_json FROM run_events WHERE run_id=?
    AND type IN ('host_command_prepared','host_command_settled') ORDER BY seq`).iterate(runId)) {
    const data: unknown = JSON.parse(String(row.data_json));
    const at = timestampBefore(row.ts, stoppedAt);
    if (row.type === "host_command_prepared") {
      if (!isHostCommandPreparedV1(data) || !sameFence(data.source, fence) || seen.has(data.executionId)) return reject();
      seen.add(data.executionId);
      active.set(data.executionId, { data, seq: Number(row.seq), at });
    } else {
      if (!isHostCommandSettledV1(data)) return reject();
      const prepared = active.get(data.executionId);
      if (!prepared || Number(row.seq) <= prepared.seq || at < prepared.at
        || data.outcome !== "not_started" || !data.ownerCurrent) return reject();
      // completed currently proves leader/stdio close, not containment/descendants.
      if (noStart.has(prepared.data.toolCallId)) return reject();
      noStart.add(prepared.data.toolCallId);
      active.delete(data.executionId);
    }
  }
  if (active.size) return reject();
  return noStart;
}

function sameFence(left: RuntimeAttemptFenceV1, right: RuntimeAttemptFenceV1): boolean {
  return left.workUnitId === right.workUnitId && left.attemptId === right.attemptId
    && left.runtimeInstanceId === right.runtimeInstanceId && left.fencingToken === right.fencingToken;
}
function timestampBefore(value: SQLOutputValue, stoppedAt: number): number {
  if (!text(value)) return reject();
  const timestamp = userInputTimestamp(value);
  if (timestamp > stoppedAt) return reject();
  return timestamp;
}
function parseRecord(value: SQLOutputValue): Record<string, unknown> {
  if (!text(value)) return reject();
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reject();
  return parsed as Record<string, unknown>;
}
