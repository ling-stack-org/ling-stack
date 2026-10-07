import type { ConversationTimelineItem, ConversationTimelineMessageItem } from "./transcript-item.js";

/** Structural mirror of the Host's message_end-delimited, redacted event projection. */
export interface ConversationRunNarrationSegment {
  readonly sourceRevision?: number;
  readonly source?: {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly workUnitId: string;
    readonly participantId: string;
  };
  readonly content: string;
  readonly firstEventId: string;
  readonly lastEventId: string;
  readonly startEventSequence: number;
  readonly endEventSequence: number;
  readonly completed: boolean;
}

/**
 * Place assistant messages on their existing canonical turn anchor using the
 * same immutable run-event sequence as actions. This creates display rows only;
 * it neither fabricates ConversationItems nor infers execution from prose.
 */
export function projectConversationRunNarration(input: {
  readonly message: ConversationTimelineMessageItem;
  readonly segments: readonly ConversationRunNarrationSegment[];
  readonly runId: string;
  readonly anchor: ConversationTimelineItem;
}): readonly ConversationTimelineMessageItem[] {
  const { attemptId: _attempt, participantId: _participant, workUnitId: _unit, workflowStepId: _step, ...message } = input.message;
  return input.segments.map((segment, index) => {
    const source = segment.source;
    const owns = source && [source.workspaceId, source.threadId, source.turnId, source.runId,
      source.attemptId, source.workUnitId, source.participantId].every(value => typeof value === "string" && value.trim())
      && source.runId === input.runId && source.turnId === message.turnId
      && (!_participant || _participant === source.participantId);
    return {
      ...message,
      ...(owns ? { attemptId: source.attemptId, participantId: source.participantId, workUnitId: source.workUnitId, workflowStepId: null } : {}),
      id: `${input.message.id}:event:${encodeURIComponent(segment.firstEventId)}`,
      markdown: segment.content,
      revision: segment.endEventSequence + (segment.sourceRevision ?? 0),
      threadSequence: input.anchor.threadSequence,
      partIndex: segment.startEventSequence,
      sourceEventSequence: segment.startEventSequence,
      runId: input.runId,
      phase: index === input.segments.length - 1 ? input.message.phase : "commentary",
      sourceRefs: [
        ...input.message.sourceRefs.filter((ref) => !["conversation_item", "attempt", "participant", "work_unit"].includes(ref.kind)),
        ...input.anchor.sourceRefs.filter((ref) => ref.kind === "conversation_item"),
        ...(input.anchor.itemId && !input.anchor.sourceRefs.some((ref) => ref.kind === "conversation_item")
          ? [{ kind: "conversation_item", id: input.anchor.itemId }] : []),
        { kind: "run", id: input.runId },
        ...(owns ? [
          { kind: "attempt", id: source.attemptId }, { kind: "participant", id: source.participantId },
          { kind: "work_unit", id: source.workUnitId }, { kind: "thread", id: source.threadId },
        ] : []),
        { kind: "run_event", id: segment.firstEventId },
        ...(segment.lastEventId !== segment.firstEventId ? [{ kind: "run_event", id: segment.lastEventId }] : []),
      ],
    };
  });
}

/**
 * Merge narrative rows into the causal positions of their own run, then assign
 * dense sub-positions so normal adjacent-action batching keeps its contract.
 * Run event sequences are never compared across different runs.
 */
export function mergeConversationRunNarration(
  items: readonly ConversationTimelineItem[],
  narration: readonly ConversationTimelineItem[],
): readonly ConversationTimelineItem[] {
  if (narration.length === 0) return items;
  const ordered = [...items].sort(compareCausalItems);
  const changedSequences = new Set<number>();
  for (const row of [...narration].sort(compareItems)) {
    const next = ordered.findIndex((item) => item.runId === row.runId &&
      item.sourceEventSequence !== undefined && item.sourceEventSequence > row.sourceEventSequence!);
    let insertionIndex: number;
    let threadSequence: number;
    if (next >= 0) {
      insertionIndex = next;
      threadSequence = ordered[next]!.threadSequence;
    } else {
      let previous = -1;
      ordered.forEach((item, index) => {
        if (item.runId === row.runId && item.sourceEventSequence !== undefined) previous = index;
      });
      const owningMessage = row.itemId
        ? ordered.findIndex((item) => item.kind === "agentMessage" && item.itemId === row.itemId)
        : -1;
      const anchor = ordered.findIndex((item) => item.threadSequence === row.threadSequence &&
        item.kind === "userMessage" && item.turnId === row.turnId);
      const following = ordered.findIndex((item) => item.threadSequence > row.threadSequence);
      insertionIndex = previous >= 0 ? previous + 1
        : owningMessage >= 0 ? owningMessage
        : anchor >= 0 ? anchor + 1
        : following >= 0 ? following
        : ordered.length;
      threadSequence = previous >= 0 ? ordered[previous]!.threadSequence : row.threadSequence;
    }
    ordered.splice(insertionIndex, 0, { ...row, threadSequence });
    changedSequences.add(threadSequence);
  }
  const partIndexBySequence = new Map<number, number>();
  return ordered.map((item) => {
    if (!changedSequences.has(item.threadSequence)) return item;
    const partIndex = partIndexBySequence.get(item.threadSequence) ?? 0;
    partIndexBySequence.set(item.threadSequence, partIndex + 1);
    return { ...item, partIndex };
  });
}

function compareCausalItems(left: ConversationTimelineItem, right: ConversationTimelineItem): number {
  if (left.runId && left.runId === right.runId && left.sourceEventSequence !== undefined && right.sourceEventSequence !== undefined) {
    const eventComparison = left.sourceEventSequence - right.sourceEventSequence;
    if (eventComparison !== 0) return eventComparison;
  }
  return compareItems(left, right);
}

function compareItems(left: ConversationTimelineItem, right: ConversationTimelineItem): number {
  return left.threadSequence - right.threadSequence || left.partIndex - right.partIndex || left.id.localeCompare(right.id);
}
