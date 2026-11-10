import {
  batchCanonicalTranscriptItems,
  createTimelineSnapshot,
  resolveTimelineScope,
  type ActiveRunSnapshot,
  type ConversationInteractionSurfaceKind,
  type ConversationTimelineItem,
  type TimelineSnapshot,
  type TimelineRunLifecycle,
} from "@ling-stack/conversation-ui-core";
import {
  placeConversationTimelineDiagnostics,
  type ConversationTimelineDiagnosticPlacement,
} from "./timeline-diagnostic-placement.js";

/**
 * Shared display projection for surfaces with canonical typed facts. Verified
 * diagnostic placement precedes batching; neither changes fact meaning or order
 * fields. Surfaces supply relations, never their own final display sort.
 */
export function buildSurfaceTimelineSnapshot(input: {
  readonly surface: ConversationInteractionSurfaceKind;
  readonly threadId?: string;
  readonly parentThreadId?: string | null;
  readonly anchorItemId?: string | null;
  readonly items: readonly ConversationTimelineItem[];
  readonly diagnosticPlacements?: readonly ConversationTimelineDiagnosticPlacement[];
  readonly activeRun?: ActiveRunSnapshot | null;
  readonly canonicalRevision?: number;
  readonly sseCursor?: string | null;
  readonly contextSegmentIdByItemId?: ReadonlyMap<string, string>;
  readonly runLifecycles?: ReadonlyMap<string, TimelineRunLifecycle>;
}): TimelineSnapshot {
  const threadId = input.threadId?.trim() ?? "";
  const positionedItems = placeConversationTimelineDiagnostics(input.items, input.diagnosticPlacements);
  // Display grouping is an explicit, reversible projection.  Only apply it
  // when the caller supplies the immutable ContextSnapshot-derived lookup;
  // otherwise keep the canonical atomic facts untouched.
  const projectedItems = input.contextSegmentIdByItemId
    ? batchCanonicalTranscriptItems(positionedItems, {
        contextSegmentIdByItemId: input.contextSegmentIdByItemId,
      })
    : positionedItems;
  const hasUnscopedEvidence = projectedItems.some((item) => item.kind !== "userMessage" && item.kind !== "agentMessage");
  const items = threadId.length > 0 || !hasUnscopedEvidence
    ? projectedItems
    : [{
        id: `diagnostic:scope:${input.surface}:${input.anchorItemId ?? "missing"}`,
        kind: "diagnostic" as const,
        code: "scope_mismatch",
        revision: 0,
        threadSequence: 0,
        partIndex: 0,
        status: "blocked" as const,
        sourceRefs: [],
        title: "Activity unavailable",
        description: "This conversation has no verified thread scope.",
        summary: "This conversation has no verified thread scope.",
      }];
  const scope = resolveTimelineScope({
    surface: input.surface,
    threadId,
    parentThreadId: input.parentThreadId ?? null,
    anchorItemId: input.anchorItemId ?? null,
  });
  return createTimelineSnapshot({
    scope,
    items,
    activeRun: input.activeRun ?? null,
    canonicalRevision: input.canonicalRevision ?? maxRevision(items),
    sseCursor: input.sseCursor ?? null,
    contextSegmentIdByItemId: input.contextSegmentIdByItemId ?? new Map(),
    runLifecycles: input.runLifecycles,
  });
}

function maxRevision(items: readonly ConversationTimelineItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.revision), 0);
}
