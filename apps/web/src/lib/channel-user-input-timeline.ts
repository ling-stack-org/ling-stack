import {
  interleaveUserInputRunTimeline, projectCanonicalUserInputTimeline,
  type ConversationTimelineItem, type ConversationTimelineUserInputItem,
} from "@ling-stack/conversation-ui-core";
import type { ConversationItemV1, UserInputTranscriptItemV1 } from "../types.js";

/** Convert one scoped canonical spine to feed display positions, before batching. */
export function projectChannelUserInputTimeline(input: {
  readonly workspaceId?: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly surface: "channel_root" | "branch";
  readonly items: readonly ConversationTimelineItem[];
  readonly conversationItems: readonly ConversationItemV1[];
  readonly userInputs: readonly UserInputTranscriptItemV1[];
}): readonly ConversationTimelineItem[] {
  if (!input.workspaceId || !input.threadId) return input.items;
  const anchors = input.conversationItems.filter(item => item.workspaceId === input.workspaceId
    && item.channelId === input.channelId && item.threadId === input.threadId && item.status === "committed"
    && (item.visibility === "channel" || item.visibility === "thread_participants") && !item.visibilityOwnerId);
  const questions = projectCanonicalUserInputTimeline({
    scope: { workspaceId: input.workspaceId, threadId: input.threadId, surface: input.surface, depth: 0 },
    items: anchors, userInputs: input.userInputs,
  });
  if (questions.length === 0) return input.items;
  const seen = new Set<string>();
  const visit = (items: readonly ConversationTimelineItem[]): void => {
    for (const item of items) {
      seen.add(item.id);
      if (item.kind === "subAgentActivity") visit(item.childItems);
    }
  };
  // These diagnostics are derived, not durable facts. Recompute them on replay
  // so a newly arrived anchor can replace one without retaining a stale warning.
  const currentItems = input.items.filter(row => !(row.kind === "diagnostic"
    && (row.code === "user_input_order_unavailable" || row.code === "user_input_child_unavailable")
    && row.id.startsWith(`diagnostic:${row.code}:user-input:`)));
  visit(currentItems);
  const anchorSequence = new Map(anchors.map(item => [item.id, item.sequence]));
  let rows = orderCanonicalMessageSpans([...currentItems].sort(compareDisplay), anchorSequence);
  const diagnostics: ConversationTimelineItem[] = [];
  const grouped = new Map<string, ConversationTimelineUserInputItem[]>();
  for (const question of questions) {
    if (seen.has(question.id)) continue;
    seen.add(question.id);
    const value = question.userInput;
    if (value.availability === "available" && value.source.workflowStepId) {
      diagnostics.push(unplaced(question, "user_input_child_unavailable"));
      continue;
    }
    const key = value.availability === "available"
      ? JSON.stringify([value.source.runId, value.source.attemptId, value.source.participantId]) : question.id;
    grouped.set(key, [...(grouped.get(key) ?? []), question]);
  }
  for (const group of grouped.values()) {
    const value = group[0]!.userInput;
    // A tool's source item proves ownership, not its occurrence on the canonical spine.
    const runRows = value.availability === "available" ? rows.filter(row => row.runId === value.source.runId
      && row.kind !== "userMessage" && row.kind !== "userInputRequest" && row.kind !== "userInputAnswer") : [];
    const hasRunEvents = runRows.some(row => row.sourceEventSequence !== undefined || isOperation(row));
    if (value.availability === "available" && hasRunEvents) {
      // Missing ownership is not evidence that a row belongs to a different
      // attempt. Do not skip such a row and guess a position across it.
      if (runRows.some(row => !row.attemptId?.trim() || !row.participantId?.trim())) {
        diagnostics.push(...group.map(row => unplaced(row, "user_input_order_unavailable")));
        continue;
      }
      const result = interleaveUserInputRunTimeline({ scope: { ...value.source, workflowStepId: null }, items: rows, userInputs: group });
      rows = [...result.items];
      diagnostics.push(...result.unplaced.map(row => unplaced(row, "user_input_order_unavailable")));
      continue;
    }
    // Canonical-only history is valid when there are no Run operations to interleave.
    for (const question of group) {
      const sequenceFor = (row: ConversationTimelineItem): number | undefined =>
        (row.kind === "userMessage" || row.kind === "agentMessage" || row.kind === "terminalReport"
          || row.kind === "userInputRequest" || row.kind === "userInputAnswer") && row.itemId
          ? anchorSequence.get(row.itemId) : undefined;
      const next = rows.findIndex(row => (sequenceFor(row) ?? -Infinity) > question.threadSequence);
      let previous = -1;
      rows.forEach((row, index) => { const seq = sequenceFor(row); if (seq !== undefined && seq < question.threadSequence) previous = index; });
      if ((next >= 0 && previous >= next) || (next < 0 && previous < 0 && rows.length > 0)) {
        diagnostics.push(unplaced(question, "user_input_order_unavailable"));
        continue;
      }
      rows.splice(next >= 0 ? next : previous + 1, 0, question);
    }
  }
  // Display ranks only. Canonical identity/source refs/context remain unchanged.
  // Diagnostics are outside event chronology and contain no unavailable body.
  return [...diagnostics, ...rows].map((row, index) => ({ ...row, threadSequence: index, partIndex: 0 }));
}
function isOperation(row: ConversationTimelineItem): boolean {
  return ["commandExecution", "fileChange", "exploration", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall",
    "commandBatch", "explorationBatch", "approval", "imageView"].includes(row.kind);
}
function unplaced(row: ConversationTimelineUserInputItem, code: string): ConversationTimelineItem {
  return { id: `diagnostic:${code}:${row.id}`, kind: "diagnostic", code, revision: row.revision,
    threadSequence: 0, partIndex: 0, itemId: row.itemId, sourceRefs: row.sourceRefs,
    title: "Activity unavailable", description: "Question history has no verified position in this conversation." };
}
function compareDisplay(a: ConversationTimelineItem, b: ConversationTimelineItem): number {
  return a.threadSequence - b.threadSequence || a.partIndex - b.partIndex || a.id.localeCompare(b.id);
}

/** A timestamp/ID tie cannot override the canonical order of adjacent messages.
 * Event rows, pending messages, and protocol/child blocks are hard boundaries.
 */
function orderCanonicalMessageSpans(rows: readonly ConversationTimelineItem[], sequences: ReadonlyMap<string, number>): ConversationTimelineItem[] {
  const result: ConversationTimelineItem[] = [];
  let messages: ConversationTimelineItem[] = [];
  const flush = (): void => {
    result.push(...messages.sort((a, b) => sequences.get(a.itemId!)! - sequences.get(b.itemId!)!));
    messages = [];
  };
  for (const row of rows) {
    if ((row.kind === "userMessage" || row.kind === "agentMessage") && row.sourceEventSequence === undefined
      && row.itemId && sequences.has(row.itemId)) messages.push(row);
    else { flush(); result.push(row); }
  }
  flush();
  return result;
}
