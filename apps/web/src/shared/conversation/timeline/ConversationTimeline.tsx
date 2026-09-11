import { Fragment, useEffect, useRef, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import {
  conversationTimelineRendererKey,
  fingerprintConversationTimeline,
  type ConversationTimelineItem,
  type ConversationProtocolAction,
  type ConversationTimelineSubAgentItem,
  type ConversationTimelineUserInputItem,
  type ConversationTimelineScopeKind,
  type TimelineSnapshot,
} from "@ling-stack/conversation-ui-core";
import { ChevronDown, CircleAlert, Loader2, UserRound } from "lucide-react";
import { renderConversationTimelineItem } from "./renderer-registry.js";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";
import {
  type ConversationTimelineDisplayLocation,
  type ConversationTimelineDisplayModel,
  type ConversationTimelineDisplayRow,
  type ConversationTimelineDisplaySegment,
} from "./conversation-timeline-display-model.js";
import { useConversationTimelineDisplayModel } from "./use-conversation-timeline-display-model.js";
import { useI18n } from "../../../i18n.js";
import { conversationDeferredContentReadyEvent } from "../blocks/deferred-rendering.js";

export interface ConversationTimelineProps {
  /** Immutable, already-scoped canonical/display projection. */
  readonly snapshot: TimelineSnapshot;
  readonly depth: 0 | 1;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
  readonly onInvokeProtocolAction?: (
    item: Extract<ConversationTimelineItem, { kind: "protocolEvent" | "approval" }>,
    action: ConversationProtocolAction,
  ) => void | Promise<void>;
  readonly onDisclosureIntent?: (intent: ConversationTimelineDisclosureIntent) => void;
  readonly renderSubAgentAvatar?: (item: ConversationTimelineSubAgentItem) => ReactNode;
  readonly renderUserInputAvatar?: (item: ConversationTimelineUserInputItem) => ReactNode;
  readonly renderMessageChrome?: (item: Extract<ConversationTimelineItem, { kind: "userMessage" | "agentMessage" }>, body: ReactNode) => ReactNode;
  readonly emptyLabel?: ReactNode;
  /**
   * Optional surface scroll owner used to window long top-level timelines.
   * The Timeline remains the only semantic root; child timelines never create
   * another vertical scroll owner.
   */
  readonly virtualScrollRef?: RefObject<HTMLDivElement | null>;
  /** Imperative item-id lookup for callers that need to reveal virtualized history. */
  readonly itemLocatorRef?: MutableRefObject<ConversationTimelineItemLocator | null>;
}

export interface ConversationTimelineDisclosureIntent {
  readonly rowKey: string;
  readonly itemId: string;
  readonly nextExpanded: boolean;
}

export type ConversationTimelineLocateResult = "revealed" | "not_found" | "mount_failed";

export interface ConversationTimelineItemLocator {
  readonly revealFirstMatchingItem: (
    itemIds: readonly string[],
    reveal: (target: HTMLElement) => void,
  ) => Promise<ConversationTimelineLocateResult>;
}

/**
 * The only production transcript renderer. It dispatches typed items and owns
 * the single visible nesting composition; it never sorts, groups, fetches, or
 * infers completion from narration.
 */
export function ConversationTimeline({
  snapshot,
  depth,
  cwd,
  onOpenSourceRef,
  onInvokeProtocolAction,
  onDisclosureIntent,
  renderSubAgentAvatar,
  renderUserInputAvatar,
  renderMessageChrome,
  emptyLabel,
  virtualScrollRef,
  itemLocatorRef,
  className: customClassName,
  ariaLabel,
}: ConversationTimelineProps): React.JSX.Element {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const timelineItems = snapshot.items;
  const { model: displayModel, setSubAgentExpanded, setBlockExpanded, revealDisclosurePath } = useConversationTimelineDisplayModel(timelineItems);
  const displayModelRef = useRef(displayModel);
  displayModelRef.current = displayModel;
  const displayRows = displayModel.rows;
  const virtualized = depth === 0 && Boolean(virtualScrollRef) &&
    displayModel.potentialRowCount >= timelineVirtualizationThreshold;
  const virtualizer = useVirtualizer({
    count: virtualized ? displayRows.length : 0,
    getScrollElement: () => virtualScrollRef?.current ?? null,
    estimateSize: (index) => estimateTimelineDisplayRowSize(displayRows[index]),
    getItemKey: (index) => displayRows[index]?.rowKey ?? index,
    gap: 10,
    overscan: 4,
    useFlushSync: false,
  });
  const virtualItemByRowKey = new Map<string, VirtualItem>();
  for (const virtualItem of virtualizer.getVirtualItems()) {
    const row = displayRows[virtualItem.index];
    if (row) virtualItemByRowKey.set(row.rowKey, virtualItem);
  }
  const fingerprint = fingerprintConversationTimeline(timelineItems);
  const effectiveDensity = countAtomicItems(timelineItems) > 10 ? "dense" : "default";
  const className = customClassName ?? `conversation-timeline conversation-timeline-depth-${depth}`;
  const timelineId = `timeline:${snapshot.scope.kind}:${snapshot.scope.threadId}:${snapshot.scope.anchorItemId ?? "root"}`;
  const attrs = {
    "data-conversation-timeline": "true",
    "data-conversation-timeline-id": timelineId,
    "data-conversation-thread-id": snapshot.scope.threadId,
    "data-conversation-timeline-scope": snapshot.scope.kind,
    "data-conversation-timeline-depth": depth,
    "data-conversation-canonical-revision": snapshot.canonicalRevision,
    "data-conversation-sse-cursor": snapshot.sseCursor ?? "none",
    "data-conversation-timeline-renderer-keys": fingerprint.rendererKeys.join(","),
    "data-conversation-timeline-disclosure-count": fingerprint.disclosureCount,
    "data-conversation-timeline-visible-row-count": displayRows.length,
    "data-conversation-timeline-potential-row-count": displayModel.potentialRowCount,
    "data-activity-density": effectiveDensity,
    "aria-label": ariaLabel,
  } as const;

  useEffect(() => {
    if (!itemLocatorRef || depth !== 0) {
      return undefined;
    }
    const locator: ConversationTimelineItemLocator = {
      revealFirstMatchingItem: async (itemIds, reveal) => {
        let location = findFirstDisplayLocation(displayModelRef.current, itemIds);
        if (!location) {
          return "not_found";
        }
        if (!location.visible) {
          revealDisclosurePath(location.disclosurePath);
          location = await waitForVisibleDisplayLocation(displayModelRef, itemIds);
          if (!location) return "mount_failed";
        }
        const itemIndex = displayModelRef.current.rows.findIndex((row) => row.rowKey === location?.rowKey);
        if (itemIndex < 0) return "mount_failed";
        if (virtualized) {
          virtualizer.scrollToIndex(itemIndex, { align: "center" });
        }
        const target = await waitForTimelineRow(timelineRootRef, location.rowKey);
        if (!target) {
          return "mount_failed";
        }
        reveal(target);
        return "revealed";
      },
    };
    itemLocatorRef.current = locator;
    return () => {
      if (itemLocatorRef.current === locator) {
        itemLocatorRef.current = null;
      }
    };
  }, [depth, itemLocatorRef, revealDisclosurePath, virtualized, virtualizer]);

  useEffect(() => {
    if (!virtualized) return undefined;
    const scrollOwner = virtualScrollRef?.current;
    if (!scrollOwner) return undefined;
    const handleDeferredContentReady = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest<HTMLDivElement>(".conversation-timeline-virtual-row");
      if (row) virtualizer.measureElement(row);
    };
    scrollOwner.addEventListener(conversationDeferredContentReadyEvent, handleDeferredContentReady);
    return () => scrollOwner.removeEventListener(conversationDeferredContentReadyEvent, handleDeferredContentReady);
  }, [virtualScrollRef, virtualized, virtualizer]);

  if (timelineItems.length === 0) {
    return <div ref={timelineRootRef} className={`${className} empty`} {...attrs}>{emptyLabel ?? ""}</div>;
  }

  if (virtualized) {
    return (
      <div ref={timelineRootRef} className={`${className} virtualized`} {...attrs}>
        <div
          className="conversation-timeline-virtualizer"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {displayModel.segments.map((segment) => renderTimelineSegment(segment, {
            scopeKind: snapshot.scope.kind,
            renderUserInputAvatar,
            cwd,
            onOpenSourceRef,
            onInvokeProtocolAction,
            onDisclosureIntent,
            renderMessageChrome,
            renderSubAgentAvatar,
            setSubAgentExpanded,
            setBlockExpanded,
            virtualized: true,
            virtualItemByRowKey,
            measureElement: virtualizer.measureElement,
          }))}
        </div>
      </div>
    );
  }

  return (
    <div ref={timelineRootRef} className={className} {...attrs}>
      {displayModel.segments.map((segment) => renderTimelineSegment(segment, {
        scopeKind: snapshot.scope.kind,
        renderUserInputAvatar,
        cwd,
        onOpenSourceRef,
        onInvokeProtocolAction,
        onDisclosureIntent,
        renderMessageChrome,
        renderSubAgentAvatar,
        setSubAgentExpanded,
        setBlockExpanded,
        virtualized: false,
        virtualItemByRowKey,
        measureElement: virtualizer.measureElement,
      }))}
    </div>
  );
}

const timelineVirtualizationThreshold = 80;

function findFirstDisplayLocation(
  model: ConversationTimelineDisplayModel,
  itemIds: readonly string[],
): ConversationTimelineDisplayLocation | undefined {
  const candidateIds = new Set(itemIds);
  for (const [itemId, location] of model.locationByItemId) {
    if (candidateIds.has(itemId)) return location;
  }
  return undefined;
}

async function waitForVisibleDisplayLocation(
  modelRef: RefObject<ConversationTimelineDisplayModel>,
  itemIds: readonly string[],
): Promise<ConversationTimelineDisplayLocation | undefined> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const location = findFirstDisplayLocation(modelRef.current, itemIds);
    if (location?.visible) return location;
    await nextAnimationFrame();
  }
  return undefined;
}

async function waitForTimelineRow(
  timelineRootRef: RefObject<HTMLDivElement | null>,
  rowKey: string,
): Promise<HTMLElement | undefined> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) {
      return undefined;
    }
    const target = Array.from(timelineRoot.querySelectorAll<HTMLElement>("[data-conversation-row-key]"))
      .find((element) => element.dataset.conversationRowKey === rowKey);
    if (target) {
      return target;
    }
    await nextAnimationFrame();
  }
  return undefined;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.requestAnimationFrame(() => resolve());
  });
}

function estimateTimelineDisplayRowSize(row: ConversationTimelineDisplayRow | undefined): number {
  if (!row) return 96;
  if (row.kind === "subAgentHeader") return 44;
  if (row.item.kind === "terminalReport") return 220;
  if (row.item.kind === "commandBatch" || row.item.kind === "explorationBatch") return 88;
  if (row.item.kind === "userMessage" || row.item.kind === "agentMessage") return 104;
  return 72;
}

function countAtomicItems(items: readonly ConversationTimelineItem[]): number {
  return items.reduce((count, item) => {
    if (item.kind === "commandBatch") return count + item.batch.commands.length;
    if (item.kind === "explorationBatch") return count + item.batch.children.length;
    if (item.kind === "subAgentActivity") return count + 1 + countAtomicItems(item.childItems);
    return count + 1;
  }, 0);
}

type TimelineRenderContext = Pick<ConversationTimelineProps, "cwd" | "onOpenSourceRef" | "onInvokeProtocolAction" | "onDisclosureIntent" | "renderMessageChrome" | "renderSubAgentAvatar" | "renderUserInputAvatar"> & {
  readonly scopeKind?: ConversationTimelineScopeKind;
  readonly depth: 0 | 1;
};

interface TimelineSegmentRenderContext extends Omit<TimelineRenderContext, "depth"> {
  readonly setSubAgentExpanded: (item: ConversationTimelineSubAgentItem, expanded: boolean) => void;
  readonly setBlockExpanded: (id: string, expanded: boolean) => void;
  readonly virtualized: boolean;
  readonly virtualItemByRowKey: ReadonlyMap<string, VirtualItem>;
  readonly measureElement: (node: HTMLDivElement | null) => void;
}

function renderTimelineSegment(
  segment: ConversationTimelineDisplaySegment,
  context: TimelineSegmentRenderContext,
): ReactNode {
  if (segment.kind === "row") {
    return renderTimelineDisplayRow(segment.row, context);
  }
  if (segment.kind === "batchGroup") {
    return (
      <Fragment key={segment.headerRow.rowKey}>
        {renderTimelineDisplayRow(segment.headerRow, context)}
        {segment.expanded ? (
          <div id={segment.groupId} role="group" aria-label="Batch operations"
            className="conversation-timeline-batch-group"
            data-conversation-batch-group={segment.headerRow.item.id}>
            {segment.childSegments.map((child) => renderTimelineSegment(child, context))}
          </div>
        ) : null}
      </Fragment>
    );
  }
  const childGroup = segment.expanded ? (
    <div
      key={`${segment.groupId}:group`}
      id={segment.groupId}
      className="conversation-timeline-sub-agent-detail conversation-timeline-sub-agent-group"
      role="group"
      aria-label={`${segment.item.label} activity`}
      aria-busy={segment.item.lifecycle === "running" || segment.item.lifecycle === "waiting"}
      data-conversation-sub-agent-group="true"
      data-conversation-parent-sub-agent-id={segment.item.id}
      data-conversation-timeline-scope="child"
      data-conversation-timeline-depth="1"
    >
      {segment.childSegments.map((child) => renderTimelineSegment(child, context))}
    </div>
  ) : null;
  return (
    <Fragment key={segment.item.id}>
      {renderTimelineDisplayRow(segment.headerRow, context)}
      {childGroup}
    </Fragment>
  );
}

function renderTimelineDisplayRow(
  row: ConversationTimelineDisplayRow,
  context: TimelineSegmentRenderContext,
): ReactNode {
  const virtualItem = context.virtualized ? context.virtualItemByRowKey.get(row.rowKey) : undefined;
  if (context.virtualized && !virtualItem) return null;
  const childRow = row.kind === "subAgentChild" ? row : undefined;
  const className = [
    "conversation-timeline-focus-block",
    context.virtualized ? "conversation-timeline-virtual-row" : "",
    childRow ? "conversation-timeline-sub-agent-child-row" : "",
    row.parentBatchId ? "conversation-timeline-batch-child-row" : "",
  ].filter(Boolean).join(" ");
  return (
    <div
      key={row.rowKey}
      ref={context.virtualized ? context.measureElement : undefined}
      className={className}
      tabIndex={-1}
      data-index={virtualItem?.index}
      data-conversation-focus-block="true"
      data-conversation-row-key={row.rowKey}
      data-feed-item-id={row.item.id}
      data-feed-item-kind={row.item.kind}
      data-conversation-timeline-depth={row.depth}
      data-conversation-parent-sub-agent-id={childRow?.parentSubAgentId}
      data-conversation-parent-batch-id={row.parentBatchId}
      data-conversation-sub-agent-child-index={childRow ? childRow.childIndex + 1 : undefined}
      data-conversation-sub-agent-child-count={childRow?.childCount}
      data-conversation-sub-agent-child-first={childRow?.childIndex === 0 ? "true" : undefined}
      data-conversation-sub-agent-child-last={childRow && childRow.childIndex === childRow.childCount - 1 ? "true" : undefined}
      style={virtualItem ? { transform: `translateY(${virtualItem.start}px)` } : undefined}
    >
      {renderTimelineItem(row, {
        scopeKind: context.scopeKind,
        renderUserInputAvatar: context.renderUserInputAvatar,
        cwd: context.cwd,
        onOpenSourceRef: context.onOpenSourceRef,
        onInvokeProtocolAction: context.onInvokeProtocolAction,
        onDisclosureIntent: context.onDisclosureIntent,
        renderMessageChrome: context.renderMessageChrome,
        renderSubAgentAvatar: context.renderSubAgentAvatar,
        depth: row.depth,
      }, context.setSubAgentExpanded, context.setBlockExpanded)}
    </div>
  );
}

function renderTimelineItem(
  row: ConversationTimelineDisplayRow,
  context: TimelineRenderContext,
  setSubAgentExpanded: (item: ConversationTimelineSubAgentItem, expanded: boolean) => void,
  setBlockExpanded: (id: string, expanded: boolean) => void,
): ReactNode {
  return renderConversationTimelineItem(row.item, {
    scopeKind: context.scopeKind,
    renderUserInputAvatar: context.renderUserInputAvatar,
    cwd: context.cwd,
    onOpenSourceRef: context.onOpenSourceRef,
    onInvokeProtocolAction: context.onInvokeProtocolAction,
    renderMessageChrome: context.renderMessageChrome,
    depth: context.depth,
    batchDisclosure: row.batchDisclosure,
    onBatchExpandedChange: row.batchDisclosure ? (expanded) => {
      context.onDisclosureIntent?.({ rowKey: row.rowKey, itemId: row.item.id, nextExpanded: expanded });
      setBlockExpanded(row.batchDisclosure!.id, expanded);
    } : undefined,
    renderSubAgent: (subAgent) => row.kind === "subAgentHeader"
      ? (
          <RootSubAgentTimelineItem
            key={subAgent.id}
            item={subAgent}
            context={context}
            expanded={row.expanded}
            groupId={row.groupId}
            rowKey={row.rowKey}
            onExpandedChange={(expanded) => setSubAgentExpanded(subAgent, expanded)}
          />
        )
      : null,
  });
}

function RootSubAgentTimelineItem({
  item,
  context,
  expanded,
  groupId,
  rowKey,
  onExpandedChange,
}: {
  readonly item: ConversationTimelineSubAgentItem;
  readonly context: TimelineRenderContext;
  readonly expanded: boolean;
  readonly groupId: string;
  readonly rowKey: string;
  readonly onExpandedChange: (expanded: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const hasChildItems = item.childItems.length > 0;
  const statusLabel = subAgentStatusLabel(item.lifecycle);

  return (
    <section
      className={["conversation-timeline-sub-agent", `lifecycle-${item.lifecycle}`, expanded ? "expanded" : "collapsed"].join(" ")}
      data-conversation-timeline-sub-agent="true"
      data-conversation-timeline-kind="subAgentActivity"
      data-conversation-timeline-renderer-key={conversationTimelineRendererKey("subAgentActivity")}
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-status={item.status ?? item.lifecycle}
      data-conversation-timeline-depth={context.depth}
      data-conversation-participant-id={item.participantId}
      data-conversation-run-id={item.runId}
      data-conversation-attempt-id={item.attemptId}
      data-conversation-workflow-step-id={item.workflowStepId}
      data-conversation-source-refs={item.sourceRefs.map((ref) => `${ref.kind}:${ref.id}`).join(",")}
      aria-label={`${item.label} ${statusLabel}`}
    >
      <button
        className="conversation-timeline-sub-agent-head"
        type="button"
        aria-expanded={expanded}
        aria-controls={hasChildItems ? groupId : undefined}
        aria-label={`${item.label} · ${statusLabel}. ${expanded ? t("Collapse details") : t("Expand details")}`}
        disabled={!hasChildItems}
        onClick={() => {
          const nextExpanded = !expanded;
          context.onDisclosureIntent?.({ rowKey, itemId: item.id, nextExpanded });
          onExpandedChange(nextExpanded);
        }}
      >
        <span className="conversation-timeline-sub-agent-icon" aria-hidden="true">
          {context.renderSubAgentAvatar?.(item) ?? <UserRound size={14} />}
        </span>
        <strong>{item.label}</strong>
        <span className="conversation-timeline-sub-agent-status">
          {item.lifecycle === "running" ? <Loader2 size={12} className="spin" aria-hidden="true" /> : null}
          {item.lifecycle === "blocked" || item.lifecycle === "errored" ? <CircleAlert size={12} aria-hidden="true" /> : null}
          {statusLabel}
        </span>
        {hasChildItems ? <ChevronDown className="conversation-timeline-sub-agent-chevron" size={12} aria-hidden="true" /> : null}
      </button>
    </section>
  );
}

function subAgentStatusLabel(lifecycle: ConversationTimelineSubAgentItem["lifecycle"]): string {
  const labels: Record<ConversationTimelineSubAgentItem["lifecycle"], string> = {
    started: "Started",
    running: "Working",
    waiting: "Waiting",
    interrupted: "Interrupted",
    completed: "Completed",
    blocked: "Blocked",
    errored: "Failed",
  };
  return labels[lifecycle];
}
