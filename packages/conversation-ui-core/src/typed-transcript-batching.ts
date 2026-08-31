import type {
  ConversationTimelineCommandBatchItem,
  ConversationTimelineCommandBatchPayload,
  ConversationTimelineExplorationBatchItem,
  ConversationTimelineExplorationBatchPayload,
  ConversationTimelineExplorationItem,
  ConversationTimelineItem,
  ConversationTimelineOperationItemBase,
  ConversationTimelineCommandExecutionItem,
} from "./transcript-item.js";

const MIN_BATCH_SIZE = 3;

export interface DisplayProjectionContext {
  /** Immutable ContextSnapshot-derived segment identity for every atomic item. */
  readonly contextSegmentIdByItemId: ReadonlyMap<string, string>;
}

/**
 * Applies reversible display grouping after canonical atomic projection.
 * The input is already source-ordered; this function never sorts, fetches, or
 * uses a batch as completion evidence.
 */
export function batchCanonicalTranscriptItems(
  items: readonly ConversationTimelineItem[],
  context?: DisplayProjectionContext,
): readonly ConversationTimelineItem[] {
  // A missing snapshot is an unknown boundary.  Returning atomic items is
  // intentionally fail-closed: display grouping must never infer that two
  // neighboring facts share context merely because their run metadata matches.
  if (!context) return items;
  const output: ConversationTimelineItem[] = [];
  let pending: ConversationTimelineItem[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    if (pending.length >= MIN_BATCH_SIZE && pending.every(isBatchableCommand)) {
      output.push(createCommandBatch(pending as ConversationTimelineCommandExecutionItem[]));
    } else if (pending.length >= MIN_BATCH_SIZE && pending.every(isBatchableExploration)) {
      output.push(createExplorationBatch(pending as ConversationTimelineExplorationItem[]));
    } else {
      output.push(...pending);
    }
    pending = [];
  };

  for (const item of items) {
    if (!isBatchableCommand(item) && !isBatchableExploration(item)) {
      flush();
      output.push(item);
      continue;
    }
    const sameKind = pending.length === 0 || (isBatchableCommand(item) && pending.every(isBatchableCommand)) || (isBatchableExploration(item) && pending.every(isBatchableExploration));
    const sameScope = pending.length === 0 || pending.every((candidate) => sameOperationScope(candidate, item, context));
    const adjacent = pending.length === 0 || isCanonicalNeighbor(pending.at(-1)!, item);
    if (!sameKind || !sameScope || !adjacent) flush();
    pending.push(item);
  }
  flush();
  return output;
}

function isBatchableCommand(item: ConversationTimelineItem): item is ConversationTimelineCommandExecutionItem {
  return item.kind === "commandExecution" && item.status === "succeeded" && item.risk === "low" &&
    item.exitCode === 0 && !item.approvalId && hasOperationLineage(item);
}

function isBatchableExploration(item: ConversationTimelineItem): item is ConversationTimelineExplorationItem {
  return item.kind === "exploration" && item.status === "succeeded" && !item.approvalId && hasOperationLineage(item) && item.targets.length > 0;
}

function hasOperationLineage(item: ConversationTimelineItem): item is ConversationTimelineItem & ConversationTimelineOperationItemBase {
  return typeof item.actionId === "string" && item.actionId.length > 0 &&
    typeof item.runId === "string" && item.runId.length > 0 &&
    typeof item.attemptId === "string" && item.attemptId.length > 0 &&
    typeof item.participantId === "string" && item.participantId.length > 0 &&
    item.sourceRefs.length > 0 && item.sourceRefs.some((ref) => ref.kind === "conversation_item");
}

function sameOperationScope(
  left: ConversationTimelineItem,
  right: ConversationTimelineItem,
  context: DisplayProjectionContext,
): boolean {
  const leftSegment = segmentForItem(left, context);
  const rightSegment = segmentForItem(right, context);
  if (!leftSegment || !rightSegment || leftSegment !== rightSegment) return false;
  return left.runId === right.runId && left.attemptId === right.attemptId &&
    left.participantId === right.participantId && left.workUnitId === right.workUnitId &&
    left.workflowStepId === right.workflowStepId && left.turnRunRole === right.turnRunRole;
}

function segmentForItem(
  item: ConversationTimelineItem,
  context: DisplayProjectionContext,
): string | undefined {
  // Canonical ConversationItem id is the primary key. Batch wrappers and
  // action facts may have a display id, so accept that only as a fallback for
  // synthetic callers that construct the map at the projected layer.
  const canonicalItemId = item.itemId
    ?? item.sourceRefs.find((ref) => ref.kind === "conversation_item")?.id;
  return (canonicalItemId ? context.contextSegmentIdByItemId.get(canonicalItemId) : undefined)
    ?? context.contextSegmentIdByItemId.get(item.id);
}

function isCanonicalNeighbor(left: ConversationTimelineItem, right: ConversationTimelineItem): boolean {
  // Batching is a display optimisation, so it must never bridge a missing
  // canonical position.  A same-anchor fact advances by exactly one part;
  // the next persisted ConversationItem advances the thread sequence by one
  // regardless of the previous item's part index.
  return (right.threadSequence === left.threadSequence && right.partIndex === left.partIndex + 1) ||
    (right.threadSequence === left.threadSequence + 1 && right.partIndex === 1);
}

function createCommandBatch(children: readonly ConversationTimelineCommandExecutionItem[]): ConversationTimelineCommandBatchItem {
  const first = children[0]!;
  const actionIds = children.map((child) => child.actionId);
  const childItemIds = children.map((child) => child.id);
  const revision = maxRevision(children);
  const payload: ConversationTimelineCommandBatchPayload = {
    id: `command-batch:${stablePart(first.participantId)}:${stablePart(first.runId)}:${stablePart(first.actionId)}`,
    revision,
    revisionKey: revisionKey(children),
    commandCount: children.length,
    durationMs: sumOptional(children.map((child) => child.durationMs)),
    defaultExpanded: false,
    actionIds,
    childActionIds: actionIds,
    childItemIds,
    runId: first.runId,
    attemptId: first.attemptId,
    attemptNumber: first.attemptNumber,
    turnRunRole: first.turnRunRole,
    participantId: first.participantId,
    workUnitId: first.workUnitId,
    workflowStepId: first.workflowStepId,
    sourceRefs: uniqueRefs(children.flatMap((child) => child.sourceRefs)),
    commands: children,
  };
  return {
    id: payload.id,
    kind: "commandBatch",
    revision,
    threadSequence: first.threadSequence,
    partIndex: first.partIndex,
    status: "succeeded",
    turnId: first.turnId,
    actionId: first.actionId,
    runId: first.runId,
    attemptId: first.attemptId,
    attemptNumber: first.attemptNumber,
    turnRunRole: first.turnRunRole,
    participantId: first.participantId,
    workUnitId: first.workUnitId,
    workflowStepId: first.workflowStepId,
    sourceRefs: payload.sourceRefs,
    actionIds,
    childActionIds: actionIds,
    childItemIds,
    batch: payload,
  };
}

function createExplorationBatch(children: readonly ConversationTimelineExplorationItem[]): ConversationTimelineExplorationBatchItem {
  const first = children[0]!;
  const actionIds = children.map((child) => child.actionId);
  const childItemIds = children.map((child) => child.id);
  const revision = maxRevision(children);
  const payload: ConversationTimelineExplorationBatchPayload = {
    id: `exploration-batch:${stablePart(first.participantId)}:${stablePart(first.runId)}:${stablePart(first.actionId)}`,
    revision,
    revisionKey: revisionKey(children),
    actionIds,
    childActionIds: actionIds,
    childItemIds,
    runId: first.runId,
    attemptId: first.attemptId,
    attemptNumber: first.attemptNumber,
    turnRunRole: first.turnRunRole,
    participantId: first.participantId,
    workUnitId: first.workUnitId,
    workflowStepId: first.workflowStepId,
    sourceRefs: uniqueRefs(children.flatMap((child) => child.sourceRefs)),
    operationCount: children.length,
    targetCount: children.reduce((count, child) => count + child.targets.length, 0),
    defaultExpanded: false,
    children,
  };
  return {
    id: payload.id,
    kind: "explorationBatch",
    revision,
    threadSequence: first.threadSequence,
    partIndex: first.partIndex,
    status: "succeeded",
    turnId: first.turnId,
    actionId: first.actionId,
    runId: first.runId,
    attemptId: first.attemptId,
    attemptNumber: first.attemptNumber,
    turnRunRole: first.turnRunRole,
    participantId: first.participantId,
    workUnitId: first.workUnitId,
    workflowStepId: first.workflowStepId,
    sourceRefs: payload.sourceRefs,
    actionIds,
    childActionIds: actionIds,
    childItemIds,
    batch: payload,
  };
}

function maxRevision(items: readonly ConversationTimelineItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.revision), 0);
}

function revisionKey(items: readonly ConversationTimelineItem[]): string {
  return items.map((item) => `${item.id}:${item.revision}`).join("|");
}

function sumOptional(values: readonly (number | undefined)[]): number | undefined {
  return values.every((value): value is number => value !== undefined)
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

function uniqueRefs<T extends { readonly kind: string; readonly id: string }>(refs: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stablePart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-") || "unknown";
}
