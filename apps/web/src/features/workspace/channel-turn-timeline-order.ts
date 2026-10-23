import { expandDisplayBatch, mergeConversationRunNarration, type ConversationTimelineItem } from "@ling-stack/conversation-ui-core";

/** Keep durable run-event order before assigning the channel's turn-local positions. */
export function orderChannelTurnTimelineItems(input: {
  readonly startNarration: readonly ConversationTimelineItem[];
  readonly facts: readonly ConversationTimelineItem[];
  readonly eventRows: readonly ConversationTimelineItem[];
  readonly terminalNarration: readonly ConversationTimelineItem[];
}): readonly ConversationTimelineItem[] {
  // Display batches have no causal position of their own. Expand them before
  // inserting lifecycle rows so a compaction can split the original children.
  const atoms = input.eventRows.length === 0 ? input.facts : input.facts.flatMap(item => item.kind === "commandBatch"
    ? item.batch.commands.flatMap(({ leadingItems, ...command }) => [...(leadingItems ?? []), command])
    : expandDisplayBatch(item));
  const merged = mergeConversationRunNarration(atoms, input.eventRows);
  const seen = new Set<string>();
  return [...input.startNarration, ...merged, ...input.terminalNarration]
    .filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    // Part zero is the source user message. The surface snapshot can now
    // regroup adjacent atoms using its committed context assignments.
    .map((item, index) => {
      const position = { threadSequence: index + 1, partIndex: 1 };
      if (item.kind === "commandBatch") return { ...item, ...position, batch: { ...item.batch,
        commands: item.batch.commands.map((command, part) => ({ ...command, ...position, partIndex: part + 1 })),
      } };
      if (item.kind === "explorationBatch") return { ...item, ...position, batch: { ...item.batch,
        children: item.batch.children.map((child, part) => ({ ...child, ...position, partIndex: part + 1 })),
      } };
      return { ...item, ...position };
    });
}
