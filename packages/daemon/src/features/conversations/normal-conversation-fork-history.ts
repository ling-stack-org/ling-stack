import type { NormalConversationForkSeed } from "@ling-stack/core";
import type { NormalContextEntry, NormalContextRunEventWatermark } from "./normal-conversation-context-hydrator.js";

export interface NormalForkHistoryGroup {
  readonly threadId: string;
  readonly key: string;
  readonly entries: readonly NormalContextEntry[];
}
export interface NormalForkContextPayload {
  readonly schemaVersion: 1;
  readonly source: { readonly threadId: string; readonly turnId: string; readonly itemId: string;
    readonly itemRevision: number; readonly throughItemSequence: number; readonly runId?: string };
  readonly groups: readonly NormalForkHistoryGroup[];
  readonly omittedGroups: readonly string[];
  readonly runEventWatermarks: readonly NormalContextRunEventWatermark[];
}
export interface NormalConversationForkHistory {
  readonly seedId: string;
  readonly seedFingerprint: string;
  readonly groups: readonly NormalForkHistoryGroup[];
  /** Explicit full-group omissions, never truncated prose or code fences. */
  readonly omittedGroups: readonly string[];
  readonly runEventWatermarks: readonly NormalContextRunEventWatermark[];
}

/** Preserve original thread/turn grouping, separate from the child projection's source. */
export function groupNormalForkHistory(threadId: string, entries: readonly NormalContextEntry[]): NormalForkHistoryGroup[] {
  const groups = new Map<string, NormalContextEntry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([threadId, entry.origin === "context_summary" ? "summary" : "turn",
      entry.origin === "context_summary" ? entry.summaryId : entry.turnId]);
    const group = groups.get(key) ?? [];
    group.push(entry); groups.set(key, group);
  }
  return [...groups].map(([key, values]) => ({ threadId, key, entries: values }));
}

export function selectNormalForkHistory(groups: readonly NormalForkHistoryGroup[], budget: number): {
  readonly groups: readonly NormalForkHistoryGroup[]; readonly omittedGroups: readonly string[];
} {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("Invalid normal fork history budget");
  const kept: NormalForkHistoryGroup[] = [], omittedGroups: string[] = [];
  let used = 0;
  for (const group of [...groups].reverse()) {
    const size = group.entries.reduce((sum, entry) => sum + entry.text.length, 0);
    if (used + size > budget) { omittedGroups.push(group.key); continue; }
    kept.push(group); used += size;
  }
  return { groups: kept.reverse(), omittedGroups };
}

/** Read only the frozen payload; parent activity is not a hydration fallback. */
export function readNormalForkContextPayload(seed: NormalConversationForkSeed): NormalForkContextPayload {
  const value = validateNormalForkContextPayload(seed.payload);
  if (value.source.threadId !== seed.threadId || value.source.turnId !== seed.turnId || value.source.itemId !== seed.sourceItemId ||
    value.source.runId !== seed.sourceRunId || value.source.throughItemSequence !== seed.projection.throughItemSequence) {
    throw new Error("Invalid normal fork context source");
  }
  return value;
}

/** Validate before the Core transaction can publish the new child and seed. */
export function validateNormalForkContextPayload(value: unknown): NormalForkContextPayload {
  if (!record(value) || !keys(value, ["schemaVersion", "source", "groups", "omittedGroups", "runEventWatermarks"]) ||
    value.schemaVersion !== 1 || !record(value.source) ||
    !keys(value.source, ["threadId", "turnId", "itemId", "itemRevision", "throughItemSequence"], ["runId"]) ||
    ![value.source.threadId, value.source.turnId, value.source.itemId].every(nonempty) || !positive(value.source.throughItemSequence) ||
    (value.source.runId !== undefined && !nonempty(value.source.runId)) ||
    !nonnegative(value.source.itemRevision) || !validHistory(value)) throw new Error("Invalid normal fork context payload");
  return value as unknown as NormalForkContextPayload;
}

/** Child input uses local recent history first, then complete inherited groups in the remaining budget. */
export function inheritNormalForkHistory(seed: NormalConversationForkSeed, budget: number): NormalConversationForkHistory {
  const payload = readNormalForkContextPayload(seed);
  const selected = selectNormalForkHistory(payload.groups, budget);
  return { seedId: seed.id, seedFingerprint: seed.fingerprint, groups: selected.groups,
    omittedGroups: [...new Set([...payload.omittedGroups, ...selected.omittedGroups])],
    runEventWatermarks: usedForkWatermarks(selected.groups, payload.runEventWatermarks) };
}
export function isNormalConversationForkHistory(value: unknown): value is NormalConversationForkHistory {
  return record(value) && keys(value, ["seedId", "seedFingerprint", "groups", "omittedGroups", "runEventWatermarks"]) &&
    nonempty(value.seedId) && typeof value.seedFingerprint === "string" && /^[a-f0-9]{64}$/.test(value.seedFingerprint) && validHistory(value);
}
export function usedForkWatermarks(groups: readonly NormalForkHistoryGroup[], marks: readonly NormalContextRunEventWatermark[]): NormalContextRunEventWatermark[] {
  const runs = new Set(groups.flatMap(group => group.entries.flatMap(entry => entry.sourceRefs.flatMap(ref => ref.kind === "run_event" ? [ref.runId] : []))));
  return marks.filter(mark => runs.has(mark.runId));
}
function validHistory(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.groups) || !Array.isArray(value.omittedGroups) || !value.omittedGroups.every(nonempty) ||
    !Array.isArray(value.runEventWatermarks)) return false;
  const seen = new Set<string>();
  for (const group of value.groups) {
    if (!record(group) || !keys(group, ["threadId", "key", "entries"]) || !nonempty(group.threadId) || !nonempty(group.key) ||
      seen.has(group.key) || !Array.isArray(group.entries) || !group.entries.length || !group.entries.every(validEntry)) return false;
    seen.add(group.key);
    if (group.entries.some(entry => group.key !== JSON.stringify([group.threadId, entry.origin === "context_summary" ? "summary" : "turn",
      entry.origin === "context_summary" ? entry.summaryId : entry.turnId]))) return false;
  }
  const runs = new Set<string>();
  return value.runEventWatermarks.every(mark => {
    if (!record(mark) || !keys(mark, ["runId", "throughEventSequence", "throughEventId"]) || !nonempty(mark.runId) ||
      !positive(mark.throughEventSequence) || !nonempty(mark.throughEventId) || runs.has(mark.runId)) return false;
    runs.add(mark.runId); return true;
  });
}
function validEntry(value: unknown): value is NormalContextEntry {
  if (!record(value) || typeof value.text !== "string" || !["user", "assistant", "context"].includes(String(value.role)) ||
    !Array.isArray(value.sourceRefs) || !value.sourceRefs.length || !value.sourceRefs.every(validRef)) return false;
  const base = ["origin", "role", "text", "sourceRefs"];
  if (value.origin === "context_summary") return keys(value, [...base, "summaryId"]) && value.role === "context" && nonempty(value.summaryId);
  if (!nonempty(value.turnId)) return false;
  if (value.origin === "canonical_item") return keys(value, [...base, "turnId"]);
  if (value.origin === "legacy_turn_user") return keys(value, [...base, "turnId"]) && value.role === "user";
  return value.origin === "run_narration" && keys(value, [...base, "turnId", "runId", "completed"]) &&
    value.role === "assistant" && nonempty(value.runId) && typeof value.completed === "boolean";
}
function validRef(value: unknown): boolean {
  if (!record(value) || !nonempty(value.id)) return false;
  if (value.kind === "conversation_item") return keys(value, ["kind", "id", "sequence", "revision"]) && positive(value.sequence) && nonnegative(value.revision);
  if (value.kind === "turn") return keys(value, ["kind", "id", "updatedAt"]) && nonempty(value.updatedAt);
  if (value.kind === "run") return keys(value, ["kind", "id"]);
  if (value.kind === "run_event") return keys(value, ["kind", "id", "runId", "sequence"]) && nonempty(value.runId) && positive(value.sequence);
  return value.kind === "context_summary" && keys(value, ["kind", "id", "version"]) && positive(value.version);
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => key in value) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function positive(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function nonnegative(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
