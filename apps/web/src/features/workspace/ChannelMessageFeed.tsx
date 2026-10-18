import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import type { ChannelActivityItem } from "../../lib/channel-activity.js";
import type { ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import type {
  ConversationTurnViewModel,
} from "../../lib/conversation-turn-projector.js";
import {
  ConversationTimelineFeed,
  transcriptBlockViewKey,
  type ConversationTimelineDisclosureIntent,
  type ConversationViewRetainKeys,
} from "../../shared/conversation/index.js";
import { conversationMeasurementScrollEvent } from "../../shared/conversation/blocks/conversation-reading-anchor.js";
import type {
  Channel,
  ChannelMention,
  ChannelMessageFileRef,
} from "../../types.js";

export type ChannelMessageFeedItem =
  (
    | { readonly id: "older-channel-messages"; readonly kind: "older-loader" }
    | { readonly id: string; readonly kind: "turn"; readonly turn: ConversationTurnViewModel; readonly pendingReplyPreview?: PendingChannelSendPreview }
    | { readonly id: string; readonly kind: "activity"; readonly item: ChannelActivityItem }
    | { readonly id: string; readonly kind: "pending-send"; readonly preview: PendingChannelSendPreview; readonly showSentMessage: boolean }
  ) & { readonly renderKey?: string };

export interface PendingChannelSendPreview {
  readonly id: string;
  readonly sourceMessageId?: string;
  readonly targetTeammateId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly requestAiReply: boolean;
  readonly autoReplyMode: Channel["autoReplyMode"];
  readonly createdAt: string;
}

interface MessageFeedAnchorSnapshot {
  readonly rowKey: string;
  readonly parentSubAgentId?: string;
  readonly offsetTop: number;
}

interface OlderLoadAnchorSnapshot {
  readonly anchor?: MessageFeedAnchorSnapshot;
  readonly anchorOffset: number;
  readonly previousScrollHeight: number;
}

const conversationFocusBlockSelector =
  '[data-conversation-focus-block="true"][data-conversation-row-key]';

interface UseChannelMessageFeedInput {
  readonly items: readonly ChannelMessageFeedItem[];
  readonly conversationWorkCellByWorkflowId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly conversationWorkCellByThreadId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly canLoadOlder: boolean;
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly protocolLoading: boolean;
  readonly tailDependencyKey: string;
  readonly latestVisibleItemId: string;
  readonly renderableItemCount: number;
  readonly restoreBlockedUntilRef: RefObject<number>;
  readonly onLoadOlder: () => void | Promise<void>;
}

export interface ChannelMessageFeedState {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly latestButtonVisible: boolean;
  readonly viewRetainKeys: ConversationViewRetainKeys;
  readonly reset: () => void;
  readonly scrollToLatest: () => void;
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void;
  readonly onUserScrollIntent: () => void;
  readonly onDisclosureIntent: (intent: ConversationTimelineDisclosureIntent) => void;
  readonly onLocateIntent: () => void;
}

interface ChannelMessageFeedProps {
  readonly surfaceId: string;
  readonly state: ChannelMessageFeedState;
  readonly ariaLabel: string;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly loadingLabel: string;
  readonly emptyIcon?: ReactNode;
  readonly emptyLabel: string;
  readonly title?: string;
  /** The single Timeline root owned by the channel surface. */
  readonly unifiedTimelineNode: ReactNode;
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  readonly onPointerDown?: PointerEventHandler<HTMLDivElement>;
  readonly onPointerMove?: PointerEventHandler<HTMLDivElement>;
  readonly onPointerUp?: PointerEventHandler<HTMLDivElement>;
  readonly onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  readonly onContextMenu?: MouseEventHandler<HTMLDivElement>;
  readonly statusNode?: ReactNode;
  readonly latestButtonNode?: ReactNode;
}

export function useChannelMessageFeed({
  canLoadOlder,
  conversationWorkCellByThreadId,
  conversationWorkCellByWorkflowId,
  items,
  latestVisibleItemId,
  loading,
  loadingOlder,
  onLoadOlder,
  protocolLoading,
  renderableItemCount,
  restoreBlockedUntilRef,
  tailDependencyKey,
}: UseChannelMessageFeedInput): ChannelMessageFeedState {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToLatestRef = useRef(true);
  const autoFollowUntilRef = useRef(0);
  const userScrollIntentRef = useRef(false);
  const userScrollRenderSignatureRef = useRef("");
  const visibleAnchorRef = useRef<MessageFeedAnchorSnapshot | undefined>(undefined);
  const olderLoadArmedRef = useRef(true);
  const olderLoadSnapshotRef = useRef<OlderLoadAnchorSnapshot | undefined>(undefined);
  const initialLatestPendingRef = useRef(true);
  const pinnedFollowFrameRef = useRef<number | undefined>(undefined);
  const layoutFrameRef = useRef<number | undefined>(undefined);
  const layoutSizeRef = useRef<{ height: number; viewport: number } | undefined>(undefined);
  const measurementScrollTopRef = useRef<number | undefined>(undefined);
  const [latestButtonVisible, setLatestButtonVisible] = useState(false);
  const [resetRevision, setResetRevision] = useState(0);

  const renderSignature = useMemo(
    () => items.map((item) => channelMessageFeedItemRenderSignature(item)).join("\n"),
    [items],
  );
  const viewRetainKeys = useMemo(
    () => buildChannelMessageFeedViewRetainKeys({
      items,
      conversationWorkCellByWorkflowId,
      conversationWorkCellByThreadId,
    }),
    [conversationWorkCellByThreadId, conversationWorkCellByWorkflowId, items],
  );

  const readVisibleAnchor = useCallback((): MessageFeedAnchorSnapshot | undefined => {
    const feed = scrollRef.current;
    if (!feed) {
      return undefined;
    }
    const feedRect = feed.getBoundingClientRect();
    const candidateRows = Array.from(
      feed.querySelectorAll<HTMLElement>(conversationFocusBlockSelector),
    );
    for (const row of candidateRows) {
      const rowKey = row.dataset.conversationRowKey;
      if (!rowKey) {
        continue;
      }
      const rowRect = row.getBoundingClientRect();
      if (rowRect.bottom <= feedRect.top + 12 || rowRect.top >= feedRect.bottom - 12) {
        continue;
      }
      return {
        rowKey,
        ...(row.dataset.conversationParentSubAgentId
          ? { parentSubAgentId: row.dataset.conversationParentSubAgentId }
          : {}),
        offsetTop: rowRect.top - feedRect.top,
      };
    }
    return undefined;
  }, []);

  const rememberVisibleAnchor = useCallback((): void => {
    const anchor = readVisibleAnchor();
    if (anchor) {
      visibleAnchorRef.current = anchor;
    }
  }, [readVisibleAnchor]);

  const onDisclosureIntent = useCallback((intent: ConversationTimelineDisclosureIntent): void => {
    const feed = scrollRef.current;
    if (!feed) return;
    measurementScrollTopRef.current = undefined;
    const row = Array.from(feed.querySelectorAll<HTMLElement>(conversationFocusBlockSelector))
      .find((element) => element.dataset.conversationRowKey === intent.rowKey);
    if (row) {
      visibleAnchorRef.current = {
        rowKey: intent.rowKey,
        offsetTop: row.getBoundingClientRect().top - feed.getBoundingClientRect().top,
      };
    }
    autoFollowUntilRef.current = 0;
    pinnedToLatestRef.current = false;
    userScrollIntentRef.current = true;
    userScrollRenderSignatureRef.current = renderSignature;
  }, [renderSignature]);

  const onLocateIntent = useCallback((): void => {
    measurementScrollTopRef.current = undefined;
    autoFollowUntilRef.current = 0;
    pinnedToLatestRef.current = false;
    initialLatestPendingRef.current = false;
    userScrollIntentRef.current = true;
    userScrollRenderSignatureRef.current = renderSignature;
    visibleAnchorRef.current = undefined;
    if (pinnedFollowFrameRef.current !== undefined) {
      globalThis.cancelAnimationFrame(pinnedFollowFrameRef.current);
      pinnedFollowFrameRef.current = undefined;
    }
  }, [renderSignature]);

  const restoreVisibleAnchor = useCallback((): void => {
    const feed = scrollRef.current;
    const anchor = visibleAnchorRef.current;
    if (!feed || !anchor) {
      rememberVisibleAnchor();
      return;
    }
    const rows = Array.from(feed.querySelectorAll<HTMLElement>(conversationFocusBlockSelector));
    const row = rows.find((element) => element.dataset.conversationRowKey === anchor.rowKey)
      ?? (anchor.parentSubAgentId
        ? rows.find((element) =>
            element.dataset.feedItemId === anchor.parentSubAgentId
            && element.dataset.conversationTimelineDepth === "0"
          )
        : undefined);
    if (!row) {
      rememberVisibleAnchor();
      return;
    }
    const feedTop = feed.getBoundingClientRect().top;
    const rowTop = row.getBoundingClientRect().top;
    const delta = rowTop - feedTop - anchor.offsetTop;
    if (Math.abs(delta) > 1) {
      feed.scrollTop += delta;
    }
    rememberVisibleAnchor();
  }, [rememberVisibleAnchor]);

  const reset = useCallback((): void => {
    const feed = scrollRef.current;
    if (feed) {
      feed.scrollLeft = 0;
    }
    pinnedToLatestRef.current = true;
    userScrollIntentRef.current = false;
    userScrollRenderSignatureRef.current = "";
    olderLoadArmedRef.current = true;
    olderLoadSnapshotRef.current = undefined;
    initialLatestPendingRef.current = true;
    visibleAnchorRef.current = undefined;
    layoutSizeRef.current = undefined;
    measurementScrollTopRef.current = undefined;
    setLatestButtonVisible(false);
    setResetRevision((revision) => revision + 1);
  }, []);

  const scrollToLatest = useCallback((): void => {
    const feed = scrollRef.current;
    if (!feed) {
      return;
    }
    autoFollowUntilRef.current = Date.now() + 1_000;
    measurementScrollTopRef.current = undefined;
    userScrollIntentRef.current = false;
    userScrollRenderSignatureRef.current = "";
    feed.scrollLeft = 0;
    feed.scrollTop = feed.scrollHeight;
    pinnedToLatestRef.current = true;
    visibleAnchorRef.current = undefined;
    setLatestButtonVisible(false);
  }, []);

  const schedulePinnedFollow = useCallback((): void => {
    const feed = scrollRef.current;
    const forceInitialLatest = initialLatestPendingRef.current;
    if (!feed || items.length === 0 || loading || protocolLoading || (!forceInitialLatest && !pinnedToLatestRef.current)) {
      return;
    }
    if (!forceInitialLatest && userScrollIntentRef.current && !channelMessageFeedIsPinnedToLatest(feed)) {
      return;
    }
    if (pinnedFollowFrameRef.current !== undefined) {
      return;
    }
    pinnedFollowFrameRef.current = globalThis.requestAnimationFrame(() => {
      const currentFeed = scrollRef.current;
      const forceCurrentInitialLatest = initialLatestPendingRef.current;
      if (!currentFeed || (!forceCurrentInitialLatest && !pinnedToLatestRef.current)) {
        pinnedFollowFrameRef.current = undefined;
        return;
      }
      const finishFollow = (): void => {
        pinnedFollowFrameRef.current = undefined;
        const settledFeed = scrollRef.current;
        if (!settledFeed) {
          return;
        }
        settledFeed.scrollTop = settledFeed.scrollHeight;
        if (channelMessageFeedIsPinnedToLatest(settledFeed)) {
          initialLatestPendingRef.current = false;
        }
        pinnedToLatestRef.current = true;
        autoFollowUntilRef.current = Date.now() + 1_000;
        userScrollIntentRef.current = false;
        visibleAnchorRef.current = undefined;
        setLatestButtonVisible(false);
      };
      if (forceCurrentInitialLatest) {
        pinnedFollowFrameRef.current = globalThis.requestAnimationFrame(finishFollow);
      } else {
        finishFollow();
      }
    });
  }, [items.length, loading, protocolLoading]);

  const onUserScrollIntent = useCallback((): void => {
    const feed = scrollRef.current;
    measurementScrollTopRef.current = undefined;
    autoFollowUntilRef.current = 0;
    userScrollIntentRef.current = true;
    userScrollRenderSignatureRef.current = renderSignature;
    if (!feed) {
      pinnedToLatestRef.current = false;
      return;
    }
    layoutSizeRef.current = { height: feed.scrollHeight, viewport: feed.clientHeight };
    const pinnedToLatest = channelMessageFeedIsPinnedToLatest(feed);
    pinnedToLatestRef.current = pinnedToLatest;
    if (pinnedToLatest) {
      visibleAnchorRef.current = undefined;
    } else {
      rememberVisibleAnchor();
    }
    setLatestButtonVisible(!pinnedToLatest && feed.scrollHeight > feed.clientHeight);
  }, [rememberVisibleAnchor, renderSignature]);

  const requestOlderIfNeeded = useCallback((feed: HTMLDivElement): void => {
    if (feed.scrollTop > 80) {
      olderLoadArmedRef.current = true;
      return;
    }
    if (
      !canLoadOlder ||
      loading ||
      loadingOlder ||
      protocolLoading ||
      initialLatestPendingRef.current ||
      pinnedToLatestRef.current ||
      !olderLoadArmedRef.current ||
      olderLoadSnapshotRef.current
    ) {
      return;
    }
    olderLoadSnapshotRef.current = {
      anchor: readVisibleAnchor(),
      anchorOffset: feed.scrollTop,
      previousScrollHeight: feed.scrollHeight,
    };
    olderLoadArmedRef.current = false;
    void onLoadOlder();
  }, [canLoadOlder, loading, loadingOlder, onLoadOlder, protocolLoading, readVisibleAnchor]);

  const updateScrollPositionState = useCallback((): void => {
    const feed = scrollRef.current;
    if (!feed) {
      return;
    }
    const previousSize = layoutSizeRef.current;
    const layoutChanged = previousSize && (previousSize.height !== feed.scrollHeight || previousSize.viewport !== feed.clientHeight);
    // ResizeObserver reconciles layout movement before a scroll event can replace the anchor.
    if (layoutChanged && visibleAnchorRef.current && !pinnedToLatestRef.current) return;
    layoutSizeRef.current = { height: feed.scrollHeight, viewport: feed.clientHeight };
    const maxScrollTop = feed.scrollHeight - feed.clientHeight;
    const pinnedToLatest = channelMessageFeedIsPinnedToLatest(feed);
    const latestItem = items.at(-1);
    const latestItemPending = channelMessageFeedItemIsPending(latestItem);
    const preserveUserAnchorDuringRenderChange =
      pinnedToLatest &&
      userScrollIntentRef.current &&
      !pinnedToLatestRef.current &&
      Boolean(visibleAnchorRef.current) &&
      userScrollRenderSignatureRef.current !== renderSignature;
    if (preserveUserAnchorDuringRenderChange) {
      setLatestButtonVisible(maxScrollTop > 0 || items.length > 1);
      return;
    }
    const preserveAutoFollow =
      !pinnedToLatest &&
      !userScrollIntentRef.current &&
      pinnedToLatestRef.current &&
      (loading || protocolLoading || Date.now() < autoFollowUntilRef.current || latestItemPending);
    if (preserveAutoFollow) {
      pinnedToLatestRef.current = true;
      setLatestButtonVisible(false);
      return;
    }
    pinnedToLatestRef.current = pinnedToLatest;
    if (!pinnedToLatest) {
      rememberVisibleAnchor();
    } else {
      userScrollIntentRef.current = false;
      visibleAnchorRef.current = undefined;
    }
    setLatestButtonVisible((visible) => {
      const nextVisible = !pinnedToLatest && maxScrollTop > 0;
      return visible === nextVisible ? visible : nextVisible;
    });
    requestOlderIfNeeded(feed);
  }, [items, loading, protocolLoading, rememberVisibleAnchor, renderSignature, requestOlderIfNeeded]);

  const onScroll = useCallback((): void => {
    const feed = scrollRef.current;
    if (feed && measurementScrollTopRef.current !== undefined
      && Math.abs(feed.scrollTop - measurementScrollTopRef.current) <= 1) return;
    measurementScrollTopRef.current = undefined;
    updateScrollPositionState();
  }, [updateScrollPositionState]);

  useEffect(() => {
    const feed = scrollRef.current;
    if (!feed) {
      return undefined;
    }
    const onMeasurementScroll = (event: Event) => {
      const top = (event as CustomEvent<number>).detail;
      if (Number.isFinite(top)) {
        measurementScrollTopRef.current = Math.max(0, Math.min(top, feed.scrollHeight - feed.clientHeight));
      }
    };
    feed.addEventListener(conversationMeasurementScrollEvent, onMeasurementScroll);
    feed.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      feed.removeEventListener(conversationMeasurementScrollEvent, onMeasurementScroll);
      feed.removeEventListener("scroll", onScroll);
    };
  }, [onScroll]);

  useEffect(() => {
    const feed = scrollRef.current;
    if (!feed || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      if (layoutFrameRef.current !== undefined) return;
      layoutFrameRef.current = globalThis.requestAnimationFrame(() => {
        layoutFrameRef.current = undefined;
        layoutSizeRef.current = { height: feed.scrollHeight, viewport: feed.clientHeight };
        if (pinnedToLatestRef.current) schedulePinnedFollow();
        else if (!olderLoadSnapshotRef.current && Date.now() >= (restoreBlockedUntilRef.current ?? 0)) restoreVisibleAnchor();
        updateScrollPositionState();
      });
    });
    observer.observe(feed);
    const timelineElement = feed.querySelector<HTMLElement>('[data-conversation-timeline="true"]');
    if (timelineElement) {
      observer.observe(timelineElement);
    }
    return () => {
      observer.disconnect();
      if (layoutFrameRef.current !== undefined) globalThis.cancelAnimationFrame(layoutFrameRef.current);
      layoutFrameRef.current = undefined;
    };
  }, [renderSignature, restoreBlockedUntilRef, restoreVisibleAnchor, schedulePinnedFollow, updateScrollPositionState]);

  useEffect(() => () => {
    if (pinnedFollowFrameRef.current !== undefined) {
      globalThis.cancelAnimationFrame(pinnedFollowFrameRef.current);
      pinnedFollowFrameRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    if (loadingOlder) {
      return;
    }
    const snapshot = olderLoadSnapshotRef.current;
    const feed = scrollRef.current;
    if (!snapshot || !feed) {
      return;
    }
    const frameIds: number[] = [];
    const finishRestore = (): void => {
      olderLoadSnapshotRef.current = undefined;
      pinnedToLatestRef.current = false;
      setLatestButtonVisible(feed.scrollHeight > feed.clientHeight);
    };
    const scheduleRestore = (attempt: number): void => {
      const frameId = globalThis.requestAnimationFrame(() => {
        if (attempt === 0) {
          feed.scrollTop = Math.max(0, feed.scrollHeight - snapshot.previousScrollHeight + snapshot.anchorOffset);
        }
        const anchorElement = snapshot.anchor
          ? Array.from(feed.querySelectorAll<HTMLElement>(conversationFocusBlockSelector))
              .find((element) => element.dataset.conversationRowKey === snapshot.anchor?.rowKey)
          : undefined;
        if (anchorElement) {
          const feedTop = feed.getBoundingClientRect().top;
          const anchorTop = anchorElement.getBoundingClientRect().top;
          feed.scrollTop += anchorTop - feedTop - (snapshot.anchor?.offsetTop ?? snapshot.anchorOffset);
          finishRestore();
          return;
        }
        if (snapshot.anchor && attempt < 8) {
          scheduleRestore(attempt + 1);
          return;
        }
        finishRestore();
      });
      frameIds.push(frameId);
    };
    scheduleRestore(0);
    return () => {
      frameIds.forEach((frameId) => globalThis.cancelAnimationFrame(frameId));
    };
  }, [loadingOlder, renderSignature]);

  useEffect(() => {
    if (loading || protocolLoading || !pinnedToLatestRef.current) {
      return;
    }
    schedulePinnedFollow();
  }, [
    items.length,
    latestVisibleItemId,
    loading,
    protocolLoading,
    renderableItemCount,
    renderSignature,
    resetRevision,
    schedulePinnedFollow,
    tailDependencyKey,
  ]);

  useEffect(() => {
    if (
      loading ||
      protocolLoading ||
      pinnedToLatestRef.current ||
      olderLoadSnapshotRef.current
    ) {
      return undefined;
    }
    if (Date.now() < (restoreBlockedUntilRef.current ?? 0)) {
      return undefined;
    }
    const frameId = globalThis.requestAnimationFrame(() => {
      restoreVisibleAnchor();
      userScrollRenderSignatureRef.current = renderSignature;
    });
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [
    loading,
    protocolLoading,
    renderSignature,
    restoreBlockedUntilRef,
    restoreVisibleAnchor,
  ]);

  return {
    scrollRef,
    latestButtonVisible,
    viewRetainKeys,
    reset,
    scrollToLatest,
    onScroll,
    onUserScrollIntent,
    onDisclosureIntent,
    onLocateIntent,
  };
}

function channelMessageFeedIsPinnedToLatest(feed: HTMLDivElement): boolean {
  const maxScrollTop = feed.scrollHeight - feed.clientHeight;
  return maxScrollTop <= 0 || maxScrollTop - feed.scrollTop <= 24;
}

export function ChannelMessageFeed({
  ariaLabel,
  empty,
  emptyIcon,
  emptyLabel,
  latestButtonNode,
  loading,
  loadingLabel,
  onContextMenu,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  state,
  statusNode,
  surfaceId,
  title,
  unifiedTimelineNode,
}: ChannelMessageFeedProps): React.JSX.Element {
  return (
    <ConversationTimelineFeed
      surfaceId={surfaceId}
      scrollRef={state.scrollRef}
      ariaLabel={ariaLabel}
      timelineId="channel-timeline-root"
      timelineNode={unifiedTimelineNode}
      loading={loading}
      empty={empty}
      emptyFeedClassName="message-feed-empty"
      loadingLabel={loadingLabel}
      emptyIcon={emptyIcon}
      emptyLabel={emptyLabel}
      title={title}
      onScroll={state.onScroll}
      onUserScrollIntent={state.onUserScrollIntent}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
      statusNode={statusNode}
      latestButtonNode={latestButtonNode}
    />
  );
}

export function channelMessageFeedItemRenderSignature(item: ChannelMessageFeedItem | undefined): string {
  if (!item) {
    return "";
  }
  if (item.kind === "older-loader") {
    return item.id;
  }
  if (item.kind === "pending-send") {
    return [
      item.id,
      item.showSentMessage ? "with-message" : "status-only",
      item.preview.body,
      item.preview.createdAt,
      item.preview.requestAiReply ? "reply" : "no-reply",
      item.preview.attachmentIds.join(","),
      item.preview.linkPreviewIds.join(","),
      item.preview.fileRefs.map((fileRef) => `${fileRef.path}:${fileRef.source ?? ""}:${fileRef.line ?? ""}`).join(","),
    ].join("|");
  }
  if (item.kind === "turn") {
    return `${conversationTurnRenderSignature(item.turn)}|${item.pendingReplyPreview ? "pending-reply" : ""}`;
  }
  return channelActivityItemRenderSignature(item.item);
}

export function buildChannelMessageFeedViewRetainKeys(input: {
  readonly items: readonly ChannelMessageFeedItem[];
  readonly conversationWorkCellByWorkflowId: ReadonlyMap<string, ConversationWorkCellViewModel>;
  readonly conversationWorkCellByThreadId: ReadonlyMap<string, ConversationWorkCellViewModel>;
}): ConversationViewRetainKeys {
  const blockIds = new Set<string>();
  const spanIds = new Set<string>();
  const actionIds = new Set<string>();
  const collectWorkCell = (workCell: ConversationWorkCellViewModel | undefined): void => {
    if (!workCell) {
      return;
    }
    blockIds.add(operationShellViewKey(workCell.id));
    blockIds.add(operationDetailsViewKey(workCell.id));
    actionIds.add(operationCopyActionViewKey(workCell.id));
    for (const span of workCell.agentSpans) {
      spanIds.add(span.id);
    }
  };

  for (const item of input.items) {
    if (item.kind === "turn") {
      for (const block of item.turn.blocks) {
        if (block.kind === "operation") {
          collectWorkCell(block.operationCell);
        } else if (block.kind !== "coordinator_message") {
          blockIds.add(transcriptBlockViewKey(block.id));
        }
      }
      continue;
    }
    if (item.kind !== "activity") {
      continue;
    }
    if (item.item.kind === "workflow") {
      collectWorkCell(input.conversationWorkCellByWorkflowId.get(item.item.record.id));
      continue;
    }
    if (item.item.kind === "run" && item.item.record.threadId) {
      const workCell = input.conversationWorkCellByThreadId.get(item.item.record.threadId);
      if (workCell?.anchorRunId === item.item.record.id) {
        collectWorkCell(workCell);
      }
    }
  }

  return { blockIds, spanIds, actionIds };
}

export function conversationTurnRenderSignature(turn: ConversationTurnViewModel): string {
  return [
    turn.id,
    turn.updatedAt,
    turn.sourceMessage.status,
    turn.sourceMessage.updatedAt,
    turn.sourceMessage.body,
    ...turn.coordinatorStartMessages.map((message) => `${message.id}:${message.status}:${message.updatedAt}:${message.body}`),
    turn.operationCell ? `${turn.operationCell.id}:${turn.operationCell.status}:${turn.operationCell.updatedAt}:${turn.operationCell.summary}` : "",
    ...turn.blocks.map((block) => [
      block.id,
      block.kind,
      block.status ?? "",
      block.revision ?? "",
      block.updatedAt ?? "",
      block.display.map((line) => `${line.id}:${line.text}:${line.meta ?? ""}`).join("~"),
    ].join(":")),
    ...turn.coordinatorTerminalMessages.map((message) => `${message.id}:${message.status}:${message.updatedAt}:${message.body}`),
  ].join("|");
}

function channelMessageFeedItemIsPending(item: ChannelMessageFeedItem | undefined): boolean {
  if (!item) {
    return false;
  }
  if (item.kind === "activity") {
    return item.item.kind === "message" && item.item.record.status === "pending";
  }
  if (item.kind === "turn") {
    return Boolean(item.pendingReplyPreview) || turnHasPendingMessage(item.turn) || item.turn.operationCell?.mode === "active";
  }
  if (item.kind === "pending-send") {
    return true;
  }
  return false;
}

function operationDetailsViewKey(operationId: string): string {
  return `operation-details:${operationId}`;
}

function operationShellViewKey(operationId: string): string {
  return `operation-shell:${operationId}`;
}

function operationCopyActionViewKey(operationId: string): string {
  return `operation-copy:${operationId}`;
}

function turnHasPendingMessage(turn: ConversationTurnViewModel): boolean {
  return turn.sourceMessage.status === "pending" ||
    turn.coordinatorStartMessages.some((message) => message.status === "pending") ||
    turn.coordinatorTerminalMessages.some((message) => message.status === "pending") ||
    turn.blocks.some((block) => block.status === "queued" || block.status === "running" || block.status === "waiting_for_approval");
}

function channelActivityItemRenderSignature(item: ChannelActivityItem): string {
  const base = `${item.id}|${item.kind}|${item.createdAt}|${item.attention}`;
  if (item.kind === "message") {
    return [
      base,
      item.record.status,
      item.record.updatedAt,
      item.record.body,
      item.record.attachmentIds.join(","),
      item.record.linkPreviewIds.join(","),
      (item.record.fileRefs ?? []).map((fileRef) => `${fileRef.path}:${fileRef.source ?? ""}:${fileRef.line ?? ""}`).join(","),
    ].join("|");
  }
  if (item.kind === "workflow") {
    return [base, item.record.status, item.record.updatedAt, item.record.title, item.record.objective].join("|");
  }
  if (item.kind === "workflow-step") {
    return [base, item.record.status, item.record.updatedAt, item.record.title, item.record.resultSummary ?? ""].join("|");
  }
  if (item.kind === "task") {
    return [base, item.record.status, item.record.updatedAt, item.record.title].join("|");
  }
  if (item.kind === "run") {
    return [base, item.record.status, item.record.updatedAt, item.record.endedAt ?? "", item.record.errorMessage ?? ""].join("|");
  }
  if (item.kind === "approval") {
    return [base, item.record.status, item.record.resolvedAt ?? "", item.record.decisionReason ?? ""].join("|");
  }
  if (item.kind === "summary") {
    return [base, item.record.updatedAt, item.record.summary].join("|");
  }
  if (item.kind === "state-transition") {
    return [base, item.record.fromStatus, item.record.toStatus, item.record.reason ?? ""].join("|");
  }
  if (item.kind === "decision") {
    return [base, item.record.status, item.record.updatedAt, item.record.title, item.record.decision].join("|");
  }
  return [base, item.record.status, item.record.updatedAt].join("|");
}
