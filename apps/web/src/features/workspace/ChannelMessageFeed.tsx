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
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChannelActivityItem } from "../../lib/channel-activity.js";
import type { ConversationWorkCellViewModel } from "../../lib/conversation-work-cell.js";
import type {
  ConversationTurnViewModel,
} from "../../lib/conversation-turn-projector.js";
import type { Translate } from "../../i18n.js";
import {
  ConversationVirtualFeed,
  ConversationViewProvider,
  transcriptBlockViewKey,
  type ConversationViewRetainKeys,
} from "../../shared/conversation/index.js";
import type {
  Channel,
  ChannelMention,
  ChannelMessageFileRef,
} from "../../types.js";

export type ChannelMessageFeedItem =
  | { readonly id: "older-channel-messages"; readonly kind: "older-loader" }
  | { readonly id: string; readonly kind: "turn"; readonly turn: ConversationTurnViewModel }
  | { readonly id: string; readonly kind: "activity"; readonly item: ChannelActivityItem }
  | { readonly id: string; readonly kind: "pending-send"; readonly preview: PendingChannelSendPreview; readonly showSentMessage: boolean };

export interface PendingChannelSendPreview {
  readonly id: string;
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

export interface ChannelMessageFeedToast {
  readonly id: number;
  readonly tone: "success" | "info" | "error";
  readonly message: string;
}

interface MessageFeedAnchorSnapshot {
  readonly itemId: string;
  readonly offsetTop: number;
}

interface OlderLoadAnchorSnapshot {
  readonly anchorId: string;
  readonly anchorOffset: number;
}

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
  readonly t: Translate;
  readonly onBackgroundToast: (toast: ChannelMessageFeedToast) => void;
  readonly onLoadOlder: () => void | Promise<void>;
}

export interface ChannelMessageFeedState {
  readonly scrollRef: RefObject<HTMLDivElement>;
  readonly latestButtonVisible: boolean;
  readonly totalSize: number;
  readonly virtualRows: ReturnType<ReturnType<typeof useVirtualizer>["getVirtualItems"]>;
  readonly viewRetainKeys: ConversationViewRetainKeys;
  readonly measureElement: (node: HTMLDivElement | null) => void;
  readonly reset: () => void;
  readonly scrollToLatest: () => void;
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void;
  readonly onUserScrollIntent: () => void;
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
  readonly items: readonly ChannelMessageFeedItem[];
  readonly renderItem: (feedItem: ChannelMessageFeedItem, index: number) => ReactNode;
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
  onBackgroundToast,
  onLoadOlder,
  protocolLoading,
  renderableItemCount,
  restoreBlockedUntilRef,
  tailDependencyKey,
  t,
}: UseChannelMessageFeedInput): ChannelMessageFeedState {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToLatestRef = useRef(true);
  const autoFollowUntilRef = useRef(0);
  const userScrollIntentRef = useRef(false);
  const visibleAnchorRef = useRef<MessageFeedAnchorSnapshot | undefined>();
  const olderLoadArmedRef = useRef(true);
  const olderLoadSnapshotRef = useRef<OlderLoadAnchorSnapshot | undefined>();
  const backgroundToastLatestItemRef = useRef("");
  const [latestButtonVisible, setLatestButtonVisible] = useState(false);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => items[index]?.kind === "older-loader" ? 48 : 128,
    overscan: 10,
    getItemKey: (index) => items[index]?.id ?? index,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const tailRenderSignature = useMemo(
    () => channelMessageFeedItemRenderSignature(items.at(-1)),
    [items],
  );
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
    const candidateRows = Array.from(feed.querySelectorAll<HTMLElement>("[data-feed-item-id]"))
      .filter((element) => element.dataset.feedItemKind !== "older-loader");
    for (const row of candidateRows) {
      const itemId = row.dataset.feedItemId;
      if (!itemId) {
        continue;
      }
      const rowRect = row.getBoundingClientRect();
      if (rowRect.bottom <= feedRect.top + 12 || rowRect.top >= feedRect.bottom - 12) {
        continue;
      }
      return {
        itemId,
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

  const restoreVisibleAnchor = useCallback((): void => {
    const feed = scrollRef.current;
    const anchor = visibleAnchorRef.current;
    if (!feed || !anchor) {
      rememberVisibleAnchor();
      return;
    }
    const row = Array.from(feed.querySelectorAll<HTMLElement>("[data-feed-item-id]"))
      .find((element) => element.dataset.feedItemId === anchor.itemId);
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
    pinnedToLatestRef.current = true;
    userScrollIntentRef.current = false;
    backgroundToastLatestItemRef.current = "";
    olderLoadArmedRef.current = true;
    olderLoadSnapshotRef.current = undefined;
    visibleAnchorRef.current = undefined;
    setLatestButtonVisible(false);
  }, []);

  const scrollToLatest = useCallback((): void => {
    const feed = scrollRef.current;
    if (!feed) {
      return;
    }
    autoFollowUntilRef.current = Date.now() + 1_000;
    userScrollIntentRef.current = false;
    if (items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    }
    feed.scrollTop = feed.scrollHeight;
    pinnedToLatestRef.current = true;
    visibleAnchorRef.current = undefined;
    setLatestButtonVisible(false);
  }, [items.length, virtualizer]);

  const onUserScrollIntent = useCallback((): void => {
    const feed = scrollRef.current;
    autoFollowUntilRef.current = 0;
    userScrollIntentRef.current = true;
    pinnedToLatestRef.current = false;
    if (feed && feed.scrollHeight > feed.clientHeight) {
      setLatestButtonVisible(true);
    }
    rememberVisibleAnchor();
  }, [rememberVisibleAnchor]);

  const updateScrollPositionState = useCallback((): void => {
    const feed = scrollRef.current;
    if (!feed) {
      return;
    }
    const maxScrollTop = feed.scrollHeight - feed.clientHeight;
    const pinnedToLatest = maxScrollTop <= 0 || maxScrollTop - feed.scrollTop <= 24;
    const latestItem = items.at(-1);
    const latestItemPending = channelMessageFeedItemIsPending(latestItem);
    const preserveAutoFollow =
      !pinnedToLatest &&
      !userScrollIntentRef.current &&
      pinnedToLatestRef.current &&
      (Date.now() < autoFollowUntilRef.current || latestItemPending);
    if (feed.scrollTop > 80) {
      olderLoadArmedRef.current = true;
    }
    if (preserveAutoFollow) {
      pinnedToLatestRef.current = true;
      setLatestButtonVisible(false);
      return;
    }
    pinnedToLatestRef.current = pinnedToLatest;
    if (!pinnedToLatest) {
      rememberVisibleAnchor();
    } else {
      visibleAnchorRef.current = undefined;
    }
    setLatestButtonVisible((visible) => {
      const nextVisible = !pinnedToLatest && maxScrollTop > 0;
      return visible === nextVisible ? visible : nextVisible;
    });
  }, [items, rememberVisibleAnchor]);

  const onScroll = useCallback((_event: UIEvent<HTMLDivElement>): void => {
    updateScrollPositionState();
  }, [updateScrollPositionState]);

  useEffect(() => {
    const feed = scrollRef.current;
    if (!feed) {
      return undefined;
    }
    feed.addEventListener("scroll", updateScrollPositionState, { passive: true });
    return () => feed.removeEventListener("scroll", updateScrollPositionState);
  }, [updateScrollPositionState]);

  useEffect(() => {
    const latestItem = items.at(-1);
    const latestItemId = latestItem?.id ?? "";
    const previousLatestItemId = backgroundToastLatestItemRef.current;
    backgroundToastLatestItemRef.current = latestItemId;
    if (!latestItem || !previousLatestItemId || previousLatestItemId === latestItemId || (pinnedToLatestRef.current && !latestButtonVisible)) {
      return;
    }
    const toast = channelMessageFeedItemBackgroundToast(latestItem, t);
    if (toast) {
      onBackgroundToast(toast);
    }
  }, [items, latestButtonVisible, onBackgroundToast, t, tailRenderSignature]);

  const firstVirtualIndex = virtualRows[0]?.index ?? -1;
  useEffect(() => {
    if (
      firstVirtualIndex !== 0 ||
      !canLoadOlder ||
      loading ||
      loadingOlder ||
      protocolLoading ||
      pinnedToLatestRef.current ||
      !olderLoadArmedRef.current ||
      olderLoadSnapshotRef.current
    ) {
      return;
    }
    const feed = scrollRef.current;
    if (feed) {
      const anchorRow = virtualRows.find((virtualRow) => channelMessageFeedItemCanAnchor(items[virtualRow.index]));
      const anchorItem = anchorRow ? items[anchorRow.index] : undefined;
      if (anchorRow && channelMessageFeedItemCanAnchor(anchorItem)) {
        olderLoadSnapshotRef.current = {
          anchorId: anchorItem.id,
          anchorOffset: anchorRow.start - feed.scrollTop,
        };
      } else {
        const fallbackAnchor = items.find(channelMessageFeedItemCanAnchor);
        if (fallbackAnchor) {
          olderLoadSnapshotRef.current = {
            anchorId: fallbackAnchor.id,
            anchorOffset: 48,
          };
        }
      }
    }
    olderLoadArmedRef.current = false;
    void onLoadOlder();
  }, [
    canLoadOlder,
    firstVirtualIndex,
    items,
    loading,
    loadingOlder,
    onLoadOlder,
    protocolLoading,
    virtualRows,
  ]);

  useEffect(() => {
    if (loadingOlder) {
      return;
    }
    const snapshot = olderLoadSnapshotRef.current;
    const feed = scrollRef.current;
    if (!snapshot || !feed) {
      return;
    }
    const anchorIndex = items.findIndex((item) => item.id === snapshot.anchorId);
    if (anchorIndex < 0) {
      olderLoadSnapshotRef.current = undefined;
      return;
    }
    virtualizer.scrollToIndex(anchorIndex, { align: "start" });
    const frameIds: number[] = [];
    const finishRestore = (): void => {
      olderLoadSnapshotRef.current = undefined;
      pinnedToLatestRef.current = false;
      setLatestButtonVisible(feed.scrollHeight > feed.clientHeight);
    };
    const scheduleRestore = (attempt: number): void => {
      virtualizer.scrollToIndex(anchorIndex, { align: "start" });
      const frameId = globalThis.requestAnimationFrame(() => {
        const anchorElement = Array.from(feed.querySelectorAll<HTMLElement>("[data-feed-item-id]"))
          .find((element) => element.dataset.feedItemId === snapshot.anchorId);
        if (anchorElement) {
          const feedTop = feed.getBoundingClientRect().top;
          const anchorTop = anchorElement.getBoundingClientRect().top;
          feed.scrollTop += anchorTop - feedTop - snapshot.anchorOffset;
          finishRestore();
          return;
        }
        if (attempt < 8) {
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
  }, [items, loadingOlder, virtualizer]);

  useEffect(() => {
    if (loading || protocolLoading || !pinnedToLatestRef.current) {
      return undefined;
    }
    const feed = scrollRef.current;
    if (!feed) {
      return undefined;
    }
    const frameIds: number[] = [];
    const scrollToLatestAttempt = (attempt: number): void => {
      autoFollowUntilRef.current = Date.now() + 1_000;
      userScrollIntentRef.current = false;
      if (items.length > 0) {
        virtualizer.scrollToIndex(items.length - 1, { align: "end" });
      }
      feed.scrollTop = feed.scrollHeight;
      pinnedToLatestRef.current = true;
      setLatestButtonVisible(false);
      if (attempt < 4) {
        const frameId = globalThis.requestAnimationFrame(() => scrollToLatestAttempt(attempt + 1));
        frameIds.push(frameId);
      }
    };
    const frameId = globalThis.requestAnimationFrame(() => scrollToLatestAttempt(0));
    frameIds.push(frameId);
    return () => {
      frameIds.forEach((scheduledFrameId) => globalThis.cancelAnimationFrame(scheduledFrameId));
    };
  }, [
    items.length,
    latestVisibleItemId,
    loading,
    protocolLoading,
    renderableItemCount,
    tailDependencyKey,
    virtualizer,
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
    });
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [
    loading,
    protocolLoading,
    renderSignature,
    restoreBlockedUntilRef,
    restoreVisibleAnchor,
    totalSize,
  ]);

  return {
    scrollRef,
    latestButtonVisible,
    totalSize,
    virtualRows,
    viewRetainKeys,
    measureElement: virtualizer.measureElement,
    reset,
    scrollToLatest,
    onScroll,
    onUserScrollIntent,
  };
}

export function ChannelMessageFeed({
  ariaLabel,
  empty,
  emptyIcon,
  emptyLabel,
  items,
  latestButtonNode,
  loading,
  loadingLabel,
  onContextMenu,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  renderItem,
  state,
  statusNode,
  surfaceId,
  title,
}: ChannelMessageFeedProps): JSX.Element {
  return (
    <ConversationViewProvider surfaceId={surfaceId}>
      <ConversationVirtualFeed
        scrollRef={state.scrollRef}
        ariaLabel={ariaLabel}
        loading={loading}
        empty={empty}
        loadingLabel={loadingLabel}
        emptyIcon={emptyIcon}
        emptyLabel={emptyLabel}
        title={title}
        totalSize={state.totalSize}
        virtualRows={state.virtualRows}
        items={items}
        getItemId={(feedItem) => feedItem.id}
        getItemKind={(feedItem) => feedItem.kind}
        renderItem={renderItem}
        measureElement={state.measureElement}
        viewStateRetainKeys={state.viewRetainKeys}
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
    </ConversationViewProvider>
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
    return conversationTurnRenderSignature(item.turn);
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

function channelMessageFeedItemCanAnchor(item: ChannelMessageFeedItem | undefined): item is Extract<ChannelMessageFeedItem, { readonly kind: "activity" | "turn" }> {
  return item?.kind === "activity" || item?.kind === "turn";
}

function channelMessageFeedItemIsPending(item: ChannelMessageFeedItem | undefined): boolean {
  if (!item) {
    return false;
  }
  if (item.kind === "activity") {
    return item.item.kind === "message" && item.item.record.status === "pending";
  }
  if (item.kind === "turn") {
    return turnHasPendingMessage(item.turn) || item.turn.operationCell?.mode === "active";
  }
  if (item.kind === "pending-send") {
    return true;
  }
  return false;
}

function channelMessageFeedItemBackgroundToast(item: ChannelMessageFeedItem | undefined, t: Translate): ChannelMessageFeedToast | undefined {
  if (!item || item.kind === "older-loader" || item.kind === "pending-send") {
    return undefined;
  }
  const status = item.kind === "turn"
    ? item.turn.operationCell?.status ?? readRecordStatus(item.turn.blocks.at(-1))
    : readRecordStatus(item.item.record);
  if (!status) {
    return undefined;
  }
  if (["failed", "cancelled", "blocked"].includes(status)) {
    return { id: Date.now(), tone: "error", message: t("Background work needs attention") };
  }
  if (["succeeded", "done", "completed", "approved", "skipped"].includes(status)) {
    return { id: Date.now(), tone: "success", message: t("Background work completed") };
  }
  return undefined;
}

function readRecordStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("status" in value)) {
    return undefined;
  }
  const status = (value as { readonly status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
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
