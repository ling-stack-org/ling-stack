import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import type { HostAttemptEffectInventory } from "../../host-attempt-completion-types.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import type { HostAttemptReadScope } from "./host-attempt-read-scope.js";

/** The closed original inventory is useful only with independently reverified executor receipts. */
export function verifiedTrackedToolCalls(database: DatabaseSync, source: HostOperationSource,
  observation: unknown, at: string, scope: HostAttemptReadScope = "whole_run"): readonly string[] | HostAttemptEffectInventory | undefined {
  try {
    const record = !Array.isArray(observation) && observation && typeof observation === "object"
      ? observation as Record<string, unknown> : undefined;
    const ids = record ? record.toolCallIds : observation;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id.length)
      || new Set(ids).size !== ids.length) return undefined;
    const settled = assertUserInputDurableQuiescence(database, source.runId, source, Date.parse(at), scope);
    const reads = new Map<string, HostAttemptEffectInventory["settledBuiltinReads"][number]>();
    const delegations = new Map<string, NonNullable<HostAttemptEffectInventory["settledDelegationCalls"]>[number]>();
    if (record) {
      if (record.schemaVersion !== 1 || !Array.isArray(record.settledBuiltinReads)
        || record.settledDelegationCalls !== undefined && !Array.isArray(record.settledDelegationCalls)
        || !["schemaVersion,settledBuiltinReads,toolCallIds", "schemaVersion,settledBuiltinReads,settledDelegationCalls,toolCallIds"]
          .includes(Object.keys(record).sort().join(","))) return undefined;
      for (const value of record.settledBuiltinReads) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const read = value as Record<string, unknown>;
        if (typeof read.toolCallId !== "string" || !ids.includes(read.toolCallId) || reads.has(read.toolCallId)
          || settled.has(read.toolCallId) || !["read", "grep", "find", "ls"].includes(String(read.toolName))
          || Object.keys(read).sort().join(",") !== "toolCallId,toolName") return undefined;
        reads.set(read.toolCallId, { toolCallId: read.toolCallId,
          toolName: read.toolName as HostAttemptEffectInventory["settledBuiltinReads"][number]["toolName"] });
      }
      for (const value of record.settledDelegationCalls ?? []) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const call = value as Record<string, unknown>;
        if (typeof call.toolCallId !== "string" || !ids.includes(call.toolCallId) || delegations.has(call.toolCallId)
          || settled.has(call.toolCallId) || reads.has(call.toolCallId)
          || !["spawn_agent", "send_message", "wait_agent", "interrupt_agent", "resume_agent"].includes(String(call.toolName))
          || Object.keys(call).sort().join(",") !== "toolCallId,toolName"
          || !verifiedDelegationToolCall(database, source, call.toolCallId, String(call.toolName))) return undefined;
        delegations.set(call.toolCallId, { toolCallId: call.toolCallId,
          toolName: call.toolName as NonNullable<HostAttemptEffectInventory["settledDelegationCalls"]>[number]["toolName"] });
      }
    }
    if (!ids.every(id => settled.has(id) || reads.has(id) || delegations.has(id))) return undefined;
    return record ? { schemaVersion: 1, toolCallIds: [...ids], settledBuiltinReads: [...reads.values()],
      ...(delegations.size ? { settledDelegationCalls: [...delegations.values()] } : {}) } : [...ids];
  } catch { return undefined; }
}

function verifiedDelegationToolCall(database: DatabaseSync, source: HostOperationSource,
  toolCallId: string, toolName: string): boolean {
  if (toolName === "wait_agent") return true; // Read-only observation, sealed by the original SDK completion receipt.
  const owner = database.prepare(`SELECT 1 FROM run_sessions r
    JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
    JOIN work_unit_attempts a ON a.id=? AND a.work_unit_id=u.id
    WHERE r.id=? AND u.id=? AND a.runtime_instance_id=? AND a.fencing_token=?`).get(
      source.attemptId, source.runId, source.workUnitId, source.runtimeInstanceId, source.fencingToken);
  if (!owner) return false;
  if (toolName === "spawn_agent") {
    return Boolean(database.prepare(`SELECT 1 FROM delegation_steps
      WHERE parent_run_id=? AND parent_attempt_id=? AND spawn_call_id=?`).get(source.runId, source.attemptId, toolCallId));
  }
  const prefix = toolName === "send_message" ? "delegation-message"
    : toolName === "interrupt_agent" ? "delegation-interrupt"
    : toolName === "resume_agent" ? "delegation-resume" : undefined;
  if (!prefix) return false;
  const row = database.prepare(`SELECT m.kind,m.direction,m.digest,a.content_sha256,a.sealed_payload_json,s.parent_run_id
    FROM delegation_messages m JOIN delegation_steps s ON s.id=m.delegation_step_id
    JOIN artifacts a ON a.id=m.body_artifact_id WHERE m.idempotency_key=?`).get(`${prefix}:${source.attemptId}:${toolCallId}`);
  if (!row || row.parent_run_id !== source.runId || row.direction !== "parent_to_child"
    || row.digest !== row.content_sha256 || typeof row.sealed_payload_json !== "string") return false;
  try {
    const payload = JSON.parse(row.sealed_payload_json) as Record<string, unknown>;
    const fence = payload.parentFence as Record<string, unknown> | undefined;
    if (!fence || fence.workUnitId !== source.workUnitId || fence.attemptId !== source.attemptId
      || fence.runtimeInstanceId !== source.runtimeInstanceId || fence.fencingToken !== source.fencingToken) return false;
    return toolName === "send_message"
      ? row.kind === "instruction" && payload.kind === "delegation.instruction.v1"
      : row.kind === "control" && payload.kind === (toolName === "interrupt_agent" ? "delegation.interrupt.v1" : "delegation.resume.v1");
  } catch { return false; }
}

export function readTrackedToolCoverage(database: DatabaseSync, source: HostOperationSource,
  json: SQLOutputValue | undefined, at: string, scope: HostAttemptReadScope = "whole_run"): boolean {
  if (typeof json !== "string") return false;
  try { return verifiedTrackedToolCalls(database, source, JSON.parse(json), at, scope) !== undefined; }
  catch { return false; }
}
