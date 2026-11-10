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

/**
 * Why a display batch candidate was flushed. This is projection/debug data;
 * it is never persisted and it never participates in completion decisions.
 */
export type BatchSplitReason =
  | "narration"
  | "kind"
  | "participant"
  | "run"
  | "attempt"
  | "workflow_step"
  | "context_scope"
  | "approval"
  | "retry"
  | "non_adjacent"
  | "non_terminal"
  | "consequential"
  | "missing_lineage";

export interface BatchSplitBoundary {
  /** The item that caused the open candidate to flush. */
  readonly beforeItemId: string;
  /** The last item in the candidate, when one existed. */
  readonly afterItemId: string | null;
  readonly reason: BatchSplitReason;
}

export interface DisplayBatchProjection {
  readonly items: readonly ConversationTimelineItem[];
  readonly boundaries: readonly BatchSplitBoundary[];
}

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
  return projectDisplayBatches(items, context).items;
}

/**
 * Projects atomic items into reversible display batches and exposes the
 * deterministic boundary diagnostics used by E2 tests and telemetry.
 */
export function projectDisplayBatches(
  items: readonly ConversationTimelineItem[],
  context?: DisplayProjectionContext,
): DisplayBatchProjection {
  // A missing snapshot is an unknown boundary.  Returning atomic items is
  // intentionally fail-closed: display grouping must never infer that two
  // neighboring facts share context merely because their run metadata matches.
  if (!context) {
    return {
      items: [...items],
      boundaries: collectMissingContextBoundaries(items),
    };
  }
  const output: ConversationTimelineItem[] = [];
  const boundaries: BatchSplitBoundary[] = [];
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
      if (pending.length > 0) {
        boundaries.push({
          beforeItemId: item.id,
          afterItemId: pending.at(-1)?.id ?? null,
          reason: splitReasonForIneligible(item),
        });
      }
      flush();
      output.push(item);
      continue;
    }
    if (pending.length > 0) {
      const reason = splitReasonForPair(pending.at(-1)!, item, context);
      if (reason) {
        boundaries.push({
          beforeItemId: item.id,
          afterItemId: pending.at(-1)?.id ?? null,
          reason,
        });
        flush();
      }
    }
    pending.push(item);
  }
  flush();
  return { items: output, boundaries };
}

/** Expands a display wrapper back to the exact atomic children it contains. */
export function expandDisplayBatch(item: ConversationTimelineItem): readonly ConversationTimelineItem[] {
  if (item.kind === "commandBatch") return item.batch.commands;
  if (item.kind === "explorationBatch") return item.batch.children;
  return [item];
}

function collectMissingContextBoundaries(items: readonly ConversationTimelineItem[]): readonly BatchSplitBoundary[] {
  const boundaries: BatchSplitBoundary[] = [];
  let previous: ConversationTimelineItem | undefined;
  for (const item of items) {
    if (previous && isBatchableCandidate(previous) && isBatchableCandidate(item)) {
      boundaries.push({ beforeItemId: item.id, afterItemId: previous.id, reason: "context_scope" });
    }
    previous = item;
  }
  return boundaries;
}

function isBatchableCandidate(item: ConversationTimelineItem): boolean {
  return isBatchableCommand(item) || isBatchableExploration(item);
}

function splitReasonForIneligible(item: ConversationTimelineItem): BatchSplitReason {
  if (item.kind === "userMessage" || item.kind === "agentMessage" || item.kind === "reasoning" || item.kind === "plan") {
    return "narration";
  }
  if (item.kind === "approval") return "approval";
  if (item.kind === "commandExecution" || item.kind === "exploration") {
    if (!hasOperationLineage(item)) return "missing_lineage";
    if (item.status !== "succeeded") return "non_terminal";
    if (item.kind === "commandExecution" && (item.risk !== "low" || item.exitCode !== 0)) {
      return "consequential";
    }
  }
  if (item.kind === "fileChange" || item.kind === "mcpToolCall" || item.kind === "dynamicToolCall" || item.kind === "collabAgentToolCall") {
    return "consequential";
  }
  return "kind";
}

function splitReasonForPair(
  left: ConversationTimelineItem,
  right: ConversationTimelineItem,
  context: DisplayProjectionContext,
): BatchSplitReason | undefined {
  const leftCommand = isBatchableCommand(left);
  const rightCommand = isBatchableCommand(right);
  const leftExploration = isBatchableExploration(left);
  const rightExploration = isBatchableExploration(right);
  if ((leftCommand && !rightCommand) || (leftExploration && !rightExploration)) return "kind";
  if ((leftCommand && rightExploration) || (leftExploration && rightCommand)) return "kind";

  const leftSegment = segmentForItem(left, context);
  const rightSegment = segmentForItem(right, context);
  if (!leftSegment || !rightSegment || leftSegment !== rightSegment) return "context_scope";
  if (left.participantId !== right.participantId) return "participant";
  if (left.runId !== right.runId) return "run";
  if (left.attemptId !== right.attemptId) {
    return isRetryRole(left.turnRunRole) || isRetryRole(right.turnRunRole) ? "retry" : "attempt";
  }
  if (left.workflowStepId !== right.workflowStepId || left.workUnitId !== right.workUnitId) return "workflow_step";
  if (left.turnRunRole !== right.turnRunRole) {
    return isRetryRole(left.turnRunRole) || isRetryRole(right.turnRunRole) ? "retry" : "workflow_step";
  }
  if (!isCanonicalNeighbor(left, right)) return "non_adjacent";
  return undefined;
}

function isRetryRole(role: ConversationTimelineItem["turnRunRole"]): boolean {
  return role === "retry" || role === "resume" || role === "repair" || role === "validation";
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
