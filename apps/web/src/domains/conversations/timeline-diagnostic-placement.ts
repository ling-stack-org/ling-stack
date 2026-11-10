import type { ConversationTimelineItem } from "@ling-stack/conversation-ui-core";

/**
 * An adapter-verified display relation, not a canonical anchor or sequence.
 * Endpoints name visible row IDs; the target must be the owning user message.
 */
export interface ConversationTimelineDiagnosticPlacement {
  readonly diagnosticId: string;
  readonly afterItemId: string;
}

/**
 * Shared, reversible placement before display batching. Every item retains its
 * object identity; only diagnostics move, preserving all other relative order.
 * Duplicate relations collapse; conflicting or ambiguous endpoints stay put.
 */
export function placeConversationTimelineDiagnostics(
  items: readonly ConversationTimelineItem[],
  placements: readonly ConversationTimelineDiagnosticPlacement[] = [],
): readonly ConversationTimelineItem[] {
  if (placements.length === 0) return items;
  const rowsById = new Map<string, ConversationTimelineItem[]>();
  for (const item of items) {
    const rows = rowsById.get(item.id) ?? [];
    rows.push(item);
    rowsById.set(item.id, rows);
  }
  const targetsByDiagnostic = new Map<string, Set<string>>();
  for (const placement of placements) {
    const targets = targetsByDiagnostic.get(placement.diagnosticId) ?? new Set<string>();
    targets.add(placement.afterItemId);
    targetsByDiagnostic.set(placement.diagnosticId, targets);
  }
  const afterMessage = new Map<string, ConversationTimelineItem[]>();
  const positioned = new Set<string>();
  // Source item order, never relation order, controls siblings after one user.
  for (const item of items) {
    if (item.kind !== "diagnostic" || rowsById.get(item.id)?.length !== 1) continue;
    const targets = targetsByDiagnostic.get(item.id);
    if (targets?.size !== 1) continue;
    const targetId = [...targets][0]!;
    const targetRows = rowsById.get(targetId);
    if (targetRows?.length !== 1 || targetRows[0]!.kind !== "userMessage") continue;
    const diagnostics = afterMessage.get(targetId) ?? [];
    diagnostics.push(item);
    afterMessage.set(targetId, diagnostics);
    positioned.add(item.id);
  }
  if (positioned.size === 0) return items;
  return items.flatMap((item) => positioned.has(item.id) ? [] : [item, ...(afterMessage.get(item.id) ?? [])]);
}
