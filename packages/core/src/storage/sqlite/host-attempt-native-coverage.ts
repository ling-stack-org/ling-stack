import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isExternalExecutionEngineId, parseExecutionBindingRequest } from "@ling-stack/contracts";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import type { NativeAttemptEffectInventory } from "../../host-attempt-completion-types.js";
import { readHostOperationBlockers } from "./host-operation-journal-store.js";

/** Use durable execution identity, never a callback's claim to use Pi coverage. */
export function isNativeCompletionSource(database: DatabaseSync, source: HostOperationSource): boolean {
  const row = database.prepare(`SELECT attempt.effective_runner_id,attempt.runner_id,
    json_extract(run.request_snapshot_json,'$.executionBinding.kind') AS binding_kind
    FROM work_unit_attempts AS attempt JOIN run_sessions AS run ON run.work_unit_id=attempt.work_unit_id
    WHERE run.id=? AND attempt.id=? AND attempt.runtime_instance_id=? AND attempt.fencing_token=?`)
    .get(source.runId, source.attemptId, source.runtimeInstanceId, source.fencingToken);
  return row?.binding_kind === "native_profile"
    || isExternalExecutionEngineId(String(row?.effective_runner_id ?? row?.runner_id));
}

export function nativeAttemptInventory(value: unknown): NativeAttemptEffectInventory | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "native_journal_v1"
    || Object.keys(record).sort().join(",") !== "kind,schemaVersion,submissionIds"
    || !Array.isArray(record.submissionIds) || record.submissionIds.some(id => typeof id !== "string" || !id.length)
    || new Set(record.submissionIds).size !== record.submissionIds.length) return undefined;
  return { schemaVersion: 1, kind: "native_journal_v1", submissionIds: [...record.submissionIds] as string[] };
}

/** Every read re-verifies the exact original journal. Neither process exit nor tool_end settles a remote effect. */
export function readNativeAttemptEffectStatus(database: DatabaseSync, source: HostOperationSource,
  json: SQLOutputValue | undefined): "settled" | "pending" | "unknown" | "unverified" {
  try {
    const inventory = typeof json === "string" ? nativeAttemptInventory(JSON.parse(json)) : undefined;
    if (!inventory || !isNativeCompletionSource(database, source)) return "unverified";
    const run = database.prepare("SELECT request_snapshot_json FROM run_sessions WHERE id=? AND work_unit_id=?")
      .get(source.runId, source.workUnitId);
    const binding = parseExecutionBindingRequest(JSON.parse(String(run?.request_snapshot_json)).executionBinding);
    if (binding.kind !== "native_profile") return "unverified";
    // The closed inventory covers the entire Run, including effects published outside the native event writer.
    const uncovered = database.prepare(`SELECT data_json FROM run_events WHERE run_id=?
      AND (type IN ('tool_start','tool_update','tool_end') OR json_type(data_json,'$.nativeOutput') IS NOT NULL)`)
      .all(source.runId).some(row => {
        const native = JSON.parse(String(row.data_json)).nativeOutput;
        return !native || !inventory.submissionIds.includes(native.submissionId);
      });
    if (uncovered) return "unverified";
    const blockers = readHostOperationBlockers(database, source, new Date().toISOString());
    if (blockers.some(blocker => blocker.phase === "unknown_outcome")) return "unknown";
    if (blockers.length) return "pending";
    const submissions = database.prepare(`SELECT submission.*,binding.selection_json FROM native_submissions AS submission
      JOIN native_execution_bindings AS binding ON binding.id=submission.binding_id
      WHERE submission.run_id=? OR submission.attempt_id=? ORDER BY submission.id`).all(source.runId, source.attemptId);
    if (submissions.length !== inventory.submissionIds.length
      || submissions.some(row => !inventory.submissionIds.includes(String(row.id)) || row.run_id !== source.runId
        || row.work_unit_id !== source.workUnitId || row.attempt_id !== source.attemptId
        || row.runtime_instance_id !== source.runtimeInstanceId || row.fencing_token !== source.fencingToken)) return "unverified";
    for (const row of submissions) {
      if (row.status === "unknown") return "unknown";
      if (["reserved", "submission_pending", "accepted"].includes(String(row.status))) return "pending";
      const selection = JSON.parse(String(row.selection_json));
      if (!selection || selection.engineId !== binding.engineId || selection.profileId !== binding.profileId
        || selection.profileRevision !== binding.profileRevision || selection.modelId !== binding.nativeModelId) return "unverified";
      if (selection.engineId === "openclaw-acp" && row.status === "cancelled") return "unknown";
      const approvals = database.prepare("SELECT reply_status FROM native_approval_requests WHERE submission_id=?").all(row.id!);
      if (approvals.some(approval => ["unknown", "claimed"].includes(String(approval.reply_status)))) return "unknown";
      if (approvals.some(approval => approval.reply_status === "pending")) return "pending";
      const operations = database.prepare("SELECT * FROM native_host_operations WHERE submission_id=?").all(row.id!);
      const actions = database.prepare("SELECT status FROM native_host_actions WHERE submission_id=?").all(row.id!);
      if (actions.some(action => action.status === "unknown")) return "unknown";
      if (actions.some(action => ["reserved", "running"].includes(String(action.status)))) return "pending";
      if (operations.some(operation => operation.status === "unknown" || operation.reply_status === "unknown")) return "unknown";
      if (operations.some(operation => operation.status === "claimed")) return "pending";
      // The current terminal journal observes a leader exit; descendant containment needs a separate original receipt.
      if (operations.some(operation => operation.terminal_started_at !== null)) return "unknown";
      if (operations.some(operation => operation.settled_at === null || operation.reply_observed_at === null)) return "unverified";
      const events = database.prepare(`SELECT type,data_json FROM run_events WHERE run_id=?
        AND json_extract(data_json,'$.nativeOutput.submissionId')=? ORDER BY seq`).all(source.runId, row.id!);
      if (["not_submitted", "rejected"].includes(String(row.status))) {
        if (events.length || operations.length) return "unverified";
        continue;
      }
      let terminal = false, sequence = 0;
      const tools = new Map<string, { readonly name: string; ended: boolean }>();
      for (const event of events) {
        const data = JSON.parse(String(event.data_json)) as Record<string, unknown>;
        const native = data.nativeOutput as Record<string, unknown> | undefined;
        if (!native || native.sequence !== ++sequence) return "unverified";
        if (native.terminal !== undefined) {
          if (native.terminal !== row.status) return "unverified";
          terminal = true;
        }
        if (event.type === "tool_start") {
          if (typeof data.toolCallId !== "string" || typeof data.toolName !== "string" || tools.has(data.toolCallId)) return "unverified";
          tools.set(data.toolCallId, { name: data.toolName, ended: false });
        } else if (event.type === "tool_end" || event.type === "tool_update") {
          const tool = tools.get(String(data.toolCallId));
          if (!tool || tool.ended || tool.name !== data.toolName) return "unverified";
          if (event.type === "tool_end") tool.ended = true;
        }
      }
      if (!terminal) return "unknown";
      for (const [id, tool] of tools) {
        if (!tool.ended) return "pending";
        const action = database.prepare("SELECT id,status FROM native_host_actions WHERE submission_id=? AND tool_call_id=?").get(row.id!, id);
        if (!action) {
          if (!["read", "grep", "find", "ls"].includes(tool.name)) return "unknown";
        } else if (!["succeeded", "failed", "cancelled"].includes(String(action.status))) return "unknown";
      }
    }
    return "settled";
  } catch { return "unverified"; }
}
