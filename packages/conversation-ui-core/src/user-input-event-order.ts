import type { ConversationTimelineItem, ConversationTimelineUserInputItem } from "./transcript-item.js";
import { isCanonicalUserInputRunEventPosition } from "./user-input-transcript-snapshot.js";

interface RunScope {
  readonly threadId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly participantId: string;
  readonly workflowStepId: string | null;
}

/**
 * Merge Q/A at immutable event boundaries of one verified participant attempt.
 * Call before display batching. An unplaceable row is returned explicitly, never
 * appended to a plausible-looking position or compared with another Run's seq.
 */
export function interleaveUserInputRunTimeline(input: {
  readonly scope: RunScope;
  readonly items: readonly ConversationTimelineItem[];
  readonly userInputs: readonly ConversationTimelineUserInputItem[];
}): { readonly items: readonly ConversationTimelineItem[]; readonly unplaced: readonly ConversationTimelineUserInputItem[] } {
  const { scope } = input;
  const rows = [...input.items];
  const unplaced: ConversationTimelineUserInputItem[] = [];
  const owns = (row: ConversationTimelineItem): boolean => row.runId === scope.runId && row.attemptId === scope.attemptId
    && row.participantId === scope.participantId && (row.workflowStepId ?? null) === scope.workflowStepId;
  const positions = new Map<string, number>();
  for (const row of rows) if (owns(row)) {
    if ((row.kind === "userInputRequest" || row.kind === "userInputAnswer") && row.userInput.availability === "available") {
      const boundary = row.userInput.runEventPosition;
      if (isCanonicalUserInputRunEventPosition(boundary) && boundary.runId === scope.runId
        && boundary.attemptId === scope.attemptId && row.userInput.source.threadId === scope.threadId) {
        positions.set(row.id, boundary.afterEventSequence);
      }
    } else if (Number.isSafeInteger(row.sourceEventSequence) && row.sourceEventSequence! > 0) {
      positions.set(row.id, row.sourceEventSequence!);
    }
  }
  const orderedEventPositions = rows.filter(owns).map(row => positions.get(row.id));
  const ambiguousOrder = orderedEventPositions.some((value, index) => value === undefined
    || (index > 0 && orderedEventPositions[index - 1]! > value));
  const seen = new Set(rows.map(row => row.id));
  const ordered = [...input.userInputs].sort((a, b) => a.threadSequence - b.threadSequence || a.id.localeCompare(b.id));
  for (const row of ordered) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const value = row.userInput;
    const boundary = value.availability === "available" ? value.runEventPosition : undefined;
    if (![scope.threadId, scope.runId, scope.attemptId, scope.participantId].every(value => typeof value === "string" && value.trim().length > 0)
      || !(scope.workflowStepId === null || typeof scope.workflowStepId === "string" && scope.workflowStepId.trim().length > 0)
      || value.availability !== "available" || value.source.threadId !== scope.threadId
      || !owns(row) || !isCanonicalUserInputRunEventPosition(boundary)
      || boundary.runId !== scope.runId || boundary.attemptId !== scope.attemptId
      || ambiguousOrder
      || (rows.length > 0 && !rows.some(owns))) {
      unplaced.push(row);
      continue;
    }
    const next = rows.findIndex(item => owns(item) && positions.get(item.id)! > boundary.afterEventSequence);
    let after = -1;
    rows.forEach((item, index) => { if (owns(item) && positions.get(item.id)! <= boundary.afterEventSequence) after = index; });
    const index = next >= 0 ? next : after + 1;
    rows.splice(index, 0, row);
    positions.set(row.id, boundary.afterEventSequence);
  }
  return { items: rows, unplaced };
}
