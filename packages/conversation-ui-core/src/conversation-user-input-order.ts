import type { ConversationTimelineItem, ConversationTimelineUserInputItem } from "./transcript-item.js";
import { interleaveUserInputRunTimeline } from "./user-input-event-order.js";

/** Final normal/private projection, after narration and before any display batching. */
export function interleaveConversationUserInputRows(
  items: readonly ConversationTimelineItem[],
  userInputs: readonly ConversationTimelineUserInputItem[],
): readonly ConversationTimelineItem[] {
  if (!userInputs.length) return items;
  if (!items.length) return userInputs;
  let rows = [...items];
  const diagnostics: ConversationTimelineItem[] = [];
  const groups = new Map<string, ConversationTimelineUserInputItem[]>();
  for (const row of userInputs) {
    const value = row.userInput;
    const key = value.availability === "available"
      ? JSON.stringify([value.source.threadId, value.source.runId, value.source.attemptId, value.source.participantId])
      : row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const value = group[0]!.userInput;
    const runRows = value.availability === "available"
      ? rows.filter(row => row.runId === value.source.runId
        && row.kind !== "userMessage" && row.kind !== "userInputRequest" && row.kind !== "userInputAnswer"
        && isRunEventRow(row)) : [];
    const hasRunEvents = runRows.length > 0;
    if (value.availability === "available" && hasRunEvents) {
      if (value.source.workflowStepId || runRows.some(row => row.attemptId !== value.source.attemptId
        || row.participantId !== value.source.participantId || row.turnId !== value.source.turnId
        || (row.workflowStepId ?? null) !== null
        || row.sourceRefs.some(ref => ref.kind === "thread" && ref.id !== value.source.threadId))) {
        diagnostics.push(...group.map(unplaced));
        continue;
      }
      const merged = interleaveUserInputRunTimeline({
        scope: { ...value.source, workflowStepId: null }, items: rows, userInputs: group,
      });
      rows = [...merged.items];
      diagnostics.push(...merged.unplaced.map(unplaced));
    } else {
      // Canonical-only history needs no Run-event inference.
      for (const row of group) {
        const next = rows.findIndex(item => item.threadSequence > row.threadSequence);
        rows.splice(next < 0 ? rows.length : next, 0, row);
      }
    }
  }
  // Dense display positions only; canonical refs, event positions and context stay intact.
  return [...diagnostics, ...rows].map((row, index) => ({ ...row, threadSequence: index, partIndex: 0 }));
}

function isRunEventRow(row: ConversationTimelineItem): boolean {
  return row.sourceEventSequence !== undefined
    || ["commandExecution", "fileChange", "exploration", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall",
      "commandBatch", "explorationBatch", "approval", "imageView"].includes(row.kind);
}

function unplaced(row: ConversationTimelineUserInputItem): ConversationTimelineItem {
  return {
    id: `diagnostic:user_input_order_unavailable:${row.id}`, kind: "diagnostic", code: "user_input_order_unavailable",
    revision: row.revision, threadSequence: 0, partIndex: 0, itemId: row.itemId, sourceRefs: row.sourceRefs,
    title: "Activity unavailable", description: "Question history has no verified position in this conversation.",
  };
}
