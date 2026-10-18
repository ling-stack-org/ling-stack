import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import type { HostAttemptEffectInventory } from "../../host-attempt-completion-types.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";

/** The closed original inventory is useful only with independently reverified executor receipts. */
export function verifiedTrackedToolCalls(database: DatabaseSync, source: HostOperationSource,
  observation: unknown, at: string): readonly string[] | HostAttemptEffectInventory | undefined {
  try {
    const record = !Array.isArray(observation) && observation && typeof observation === "object"
      ? observation as Record<string, unknown> : undefined;
    const ids = record ? record.toolCallIds : observation;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id.length)
      || new Set(ids).size !== ids.length) return undefined;
    const settled = assertUserInputDurableQuiescence(database, source.runId, source, Date.parse(at));
    const reads = new Map<string, HostAttemptEffectInventory["settledBuiltinReads"][number]>();
    if (record) {
      if (record.schemaVersion !== 1 || !Array.isArray(record.settledBuiltinReads)
        || Object.keys(record).sort().join(",") !== "schemaVersion,settledBuiltinReads,toolCallIds") return undefined;
      for (const value of record.settledBuiltinReads) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const read = value as Record<string, unknown>;
        if (typeof read.toolCallId !== "string" || !ids.includes(read.toolCallId) || reads.has(read.toolCallId)
          || settled.has(read.toolCallId) || !["read", "grep", "find", "ls"].includes(String(read.toolName))
          || Object.keys(read).sort().join(",") !== "toolCallId,toolName") return undefined;
        reads.set(read.toolCallId, { toolCallId: read.toolCallId,
          toolName: read.toolName as HostAttemptEffectInventory["settledBuiltinReads"][number]["toolName"] });
      }
    }
    if (!ids.every(id => settled.has(id) || reads.has(id))) return undefined;
    return record ? { schemaVersion: 1, toolCallIds: [...ids], settledBuiltinReads: [...reads.values()] } : [...ids];
  } catch { return undefined; }
}

export function readTrackedToolCoverage(database: DatabaseSync, source: HostOperationSource,
  json: SQLOutputValue | undefined, at: string): boolean {
  if (typeof json !== "string") return false;
  try { return verifiedTrackedToolCalls(database, source, JSON.parse(json), at) !== undefined; }
  catch { return false; }
}
