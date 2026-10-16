import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Copy, Search } from "lucide-react";
import type { Translate } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import {
  ChannelConversationBlockFeedback,
  type ConversationBlockFailure,
} from "./ChannelConversationBlockFeedback.js";

interface ConversationBlockActionMenuState {
  readonly blockId: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

interface ConversationBlockLongPressState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly timeoutId: number;
  readonly block: HTMLElement;
}

interface ChannelConversationBlockInteractionsInput {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly t: Translate;
}

export interface ChannelConversationBlockInteractions {
  readonly conversationBlockActionMenuNode: ReactNode | undefined;
  readonly conversationBlockFeedbackNode: ReactNode;
  readonly closeConversationBlockActionMenu: () => void;
  readonly handleMessageFeedContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly handleMessageFeedKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly handleMessageFeedPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly handleMessageFeedPointerEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly handleMessageFeedPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function useChannelConversationBlockInteractions({
  scrollRef,
  t,
}: ChannelConversationBlockInteractionsInput): ChannelConversationBlockInteractions {
  const { showToast } = useLingToast();
  const [conversationBlockFailure, setConversationBlockFailure] = useState<ConversationBlockFailure | undefined>();
  const [conversationBlockActionMenu, setConversationBlockActionMenu] = useState<ConversationBlockActionMenuState | undefined>();
  const conversationBlockCopyAttemptRef = useRef(0);
  const conversationBlockLongPressRef = useRef<ConversationBlockLongPressState | undefined>(undefined);
  const conversationBlockActionMenuRef = useRef<HTMLDivElement | null>(null);

  const closeConversationBlockActionMenu = useCallback((): void => {
    conversationBlockCopyAttemptRef.current += 1;
    setConversationBlockFailure((current) => current?.owner === "menu" ? { ...current, owner: "block" } : current);
    setConversationBlockActionMenu(undefined);
  }, []);

  const messageFeedFocusableBlocks = useCallback((): HTMLElement[] => {
    const feed = scrollRef.current;
    if (!feed) {
      return [];
    }
    return Array.from(feed.querySelectorAll<HTMLElement>("[data-conversation-focus-block='true']"))
      .filter((element) => element.offsetParent !== null);
  }, [scrollRef]);

  const focusedConversationBlock = useCallback((): HTMLElement | undefined => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return undefined;
    }
    const block = activeElement.closest<HTMLElement>("[data-conversation-focus-block='true']");
    return block && scrollRef.current?.contains(block) ? block : undefined;
  }, [scrollRef]);

  const focusConversationBlock = useCallback((block: HTMLElement): void => {
    const blockId = conversationBlockId(block);
    conversationBlockCopyAttemptRef.current += 1;
    block.focus({ preventScroll: true });
    block.scrollIntoView({ block: "nearest" });
    setConversationBlockFailure((current) => {
      if (!current || current.blockId !== blockId) {
        return undefined;
      }
      return current.owner === "menu" ? { ...current, owner: "block" } : current;
    });
    setConversationBlockActionMenu(undefined);
  }, []);

  const focusConversationBlockById = useCallback((blockId: string): void => {
    if (!blockId) {
      return;
    }
    const block = scrollRef.current?.querySelector<HTMLElement>(`[data-feed-item-id="${cssEscape(blockId)}"]`);
    if (block) {
      focusConversationBlock(block);
    }
  }, [focusConversationBlock, scrollRef]);

  useEffect(() => {
    if (!conversationBlockActionMenu) {
      return undefined;
    }
    const returnBlockId = conversationBlockActionMenu.blockId;
    globalThis.requestAnimationFrame(() => {
      conversationBlockActionMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
    });
    function closeActionMenu(): void {
      closeConversationBlockActionMenu();
      globalThis.requestAnimationFrame(() => focusConversationBlockById(returnBlockId));
    }
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Element && target.closest(".conversation-block-action-menu")) {
        return;
      }
      closeActionMenu();
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        closeActionMenu();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeConversationBlockActionMenu, conversationBlockActionMenu, focusConversationBlockById]);

  const focusAdjacentConversationBlock = useCallback((direction: "previous" | "next"): void => {
    const blocks = messageFeedFocusableBlocks();
    if (blocks.length === 0) {
      return;
    }
    const current = focusedConversationBlock();
    const currentIndex = current ? blocks.indexOf(current) : -1;
    const nextIndex = direction === "next"
      ? Math.min(blocks.length - 1, currentIndex < 0 ? 0 : currentIndex + 1)
      : Math.max(0, currentIndex < 0 ? blocks.length - 1 : currentIndex - 1);
    focusConversationBlock(blocks[nextIndex]);
  }, [focusConversationBlock, focusedConversationBlock, messageFeedFocusableBlocks]);

  const showConversationBlockActionToast = useCallback((block: HTMLElement, action: "copy" | "expand", message: string, tone: "success" | "info"): void => {
    showToast({
      durationMs: 3_000,
      message,
      scope: `message:${conversationBlockId(block)}:${action}`,
      tone,
    });
  }, [showToast]);

  const copyConversationBlock = useCallback(async (block: HTMLElement, owner: "block" | "menu"): Promise<void> => {
    const blockId = conversationBlockId(block);
    const attempt = ++conversationBlockCopyAttemptRef.current;
    const showFailure = (message: string): void => {
      if (conversationBlockCopyAttemptRef.current !== attempt) {
        return;
      }
      setConversationBlockFailure({ action: "copy", blockId, message, owner });
    };
    setConversationBlockFailure(undefined);
    const text = conversationBlockText(block);
    if (!text) {
      showFailure(t("Nothing to copy"));
      return;
    }
    if (!globalThis.navigator?.clipboard?.writeText) {
      showFailure(t("Copy unavailable"));
      return;
    }
    try {
      await globalThis.navigator.clipboard.writeText(text);
      if (conversationBlockCopyAttemptRef.current !== attempt) {
        return;
      }
      showConversationBlockActionToast(block, "copy", t("Copied focused block"), "success");
    } catch {
      showFailure(t("Copy unavailable"));
    }
  }, [showConversationBlockActionToast, t]);

  const cancelConversationBlockLongPress = useCallback((): void => {
    const pending = conversationBlockLongPressRef.current;
    if (!pending) {
      return;
    }
    globalThis.clearTimeout(pending.timeoutId);
    conversationBlockLongPressRef.current = undefined;
  }, []);

  const openConversationBlockActionMenu = useCallback((block: HTMLElement, x: number, y: number): void => {
    focusConversationBlock(block);
    setConversationBlockActionMenu({
      blockId: conversationBlockId(block),
      label: conversationBlockLabel(block, t),
      x: Math.max(12, Math.min(x, globalThis.innerWidth - 220)),
      y: Math.max(12, Math.min(y, globalThis.innerHeight - 160)),
    });
  }, [focusConversationBlock, t]);

  const handleMessageFeedKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || isEditableEventTarget(event.target)) {
      return;
    }
    if (event.key === "Escape" && conversationBlockActionMenu) {
      event.preventDefault();
      closeConversationBlockActionMenu();
      return;
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      focusAdjacentConversationBlock(event.key === "ArrowDown" ? "next" : "previous");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
      const block = focusedConversationBlock();
      if (!block) {
        return;
      }
      event.preventDefault();
      void copyConversationBlock(block, "block");
      return;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      if (isInteractiveEventTarget(event.target)) {
        return;
      }
      const feed = scrollRef.current;
      const focusedBlock = focusedConversationBlock();
      const block = focusedBlock ?? messageFeedFocusableBlocks().find((candidate) => candidate.querySelector(conversationExpandableSelector));
      const expandable = findConversationExpandable(block) ?? findConversationExpandable(feed);
      if (!expandable) {
        return;
      }
      event.preventDefault();
      expandable.click();
      showConversationBlockActionToast(
        expandable.closest<HTMLElement>("[data-conversation-focus-block='true']") ?? block ?? expandable,
        "expand",
        t("Expanded focused block"),
        "info",
      );
    }
  }, [
    closeConversationBlockActionMenu,
    conversationBlockActionMenu,
    copyConversationBlock,
    focusAdjacentConversationBlock,
    focusedConversationBlock,
    messageFeedFocusableBlocks,
    scrollRef,
    showConversationBlockActionToast,
    t,
  ]);

  const handleMessageFeedPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === "mouse") {
      return;
    }
    const block = conversationBlockFromEventTarget(event.target);
    if (!block || isInteractiveEventTarget(event.target)) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => {
      conversationBlockLongPressRef.current = undefined;
      openConversationBlockActionMenu(block, event.clientX, event.clientY);
    }, 560);
    conversationBlockLongPressRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timeoutId,
      block,
    };
  }, [openConversationBlockActionMenu]);

  const handleMessageFeedPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const pending = conversationBlockLongPressRef.current;
    if (!pending || pending.pointerId !== event.pointerId) {
      return;
    }
    if (Math.abs(event.clientX - pending.startX) > 12 || Math.abs(event.clientY - pending.startY) > 12) {
      cancelConversationBlockLongPress();
    }
  }, [cancelConversationBlockLongPress]);

  const handleMessageFeedPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (conversationBlockLongPressRef.current?.pointerId === event.pointerId) {
      cancelConversationBlockLongPress();
    }
  }, [cancelConversationBlockLongPress]);

  const handleMessageFeedContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    const block = conversationBlockFromEventTarget(event.target);
    if (!block || isInteractiveEventTarget(event.target)) {
      return;
    }
    event.preventDefault();
    openConversationBlockActionMenu(block, event.clientX, event.clientY);
  }, [openConversationBlockActionMenu]);

  useEffect(() => () => {
    if (conversationBlockLongPressRef.current) {
      globalThis.clearTimeout(conversationBlockLongPressRef.current.timeoutId);
      conversationBlockLongPressRef.current = undefined;
    }
  }, []);

  const dismissConversationBlockFailure = useCallback((): void => {
    const dismissed = conversationBlockFailure;
    conversationBlockCopyAttemptRef.current += 1;
    setConversationBlockFailure(undefined);
    if (!dismissed) {
      return;
    }
    globalThis.requestAnimationFrame(() => {
      if (dismissed.owner === "menu" && conversationBlockActionMenuRef.current) {
        conversationBlockActionMenuRef.current.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
        return;
      }
      focusConversationBlockById(dismissed.blockId);
    });
  }, [conversationBlockFailure, focusConversationBlockById]);

  const conversationBlockFeedbackNode = useMemo(() => {
    if (!conversationBlockFailure || conversationBlockFailure.owner !== "block") {
      return null;
    }
    return (
      <ChannelConversationBlockFeedback
        dismissLabel={t("Dismiss")}
        failure={conversationBlockFailure}
        onDismiss={dismissConversationBlockFailure}
      />
    );
  }, [conversationBlockFailure, dismissConversationBlockFailure, t]);

  const conversationBlockActionMenuNode = useMemo(() => {
    if (!conversationBlockActionMenu) {
      return undefined;
    }
    return (
      <div
        ref={conversationBlockActionMenuRef}
        className="conversation-block-action-menu"
        role="menu"
        aria-label={t("Conversation block actions")}
        style={{ left: conversationBlockActionMenu.x, top: conversationBlockActionMenu.y }}
      >
        <strong>{conversationBlockActionMenu.label}</strong>
        {conversationBlockFailure?.owner === "menu" && conversationBlockFailure.blockId === conversationBlockActionMenu.blockId ? (
          <ChannelConversationBlockFeedback
            dismissLabel={t("Dismiss")}
            failure={conversationBlockFailure}
            onDismiss={dismissConversationBlockFailure}
          />
        ) : null}
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            const block = scrollRef.current?.querySelector<HTMLElement>(`[data-feed-item-id="${cssEscape(conversationBlockActionMenu.blockId)}"]`);
            if (block) {
              void copyConversationBlock(block, "menu");
            }
          }}
        >
          <Copy size={13} />
          {t("Copy block")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            focusConversationBlockById(conversationBlockActionMenu.blockId);
          }}
        >
          <Search size={13} />
          {t("Focus block")}
        </button>
      </div>
    );
  }, [conversationBlockActionMenu, conversationBlockFailure, copyConversationBlock, dismissConversationBlockFailure, focusConversationBlockById, scrollRef, t]);

  return {
    conversationBlockActionMenuNode,
    conversationBlockFeedbackNode,
    closeConversationBlockActionMenu,
    handleMessageFeedContextMenu,
    handleMessageFeedKeyDown,
    handleMessageFeedPointerDown,
    handleMessageFeedPointerEnd,
    handleMessageFeedPointerMove,
  };
}

const conversationExpandableSelectors = [
  ".conversation-work-cell-evidence-summary[aria-expanded='false']",
  ".conversation-timeline-activity-main[aria-expanded='false']",
  ".conversation-command-batch-header[aria-expanded='false']",
  ".conversation-exploration-batch-header[aria-expanded='false']",
  ".transcript-block-view-head[aria-expanded='false']",
] as const;
const conversationExpandableSelector = conversationExpandableSelectors.join(",");

function findConversationExpandable(container: ParentNode | null | undefined): HTMLElement | undefined {
  for (const selector of conversationExpandableSelectors) {
    const expandable = container?.querySelector<HTMLElement>(selector);
    if (expandable) {
      return expandable;
    }
  }
  return undefined;
}

function conversationBlockFromEventTarget(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }
  return target.closest<HTMLElement>("[data-conversation-focus-block='true']") ?? undefined;
}

function conversationBlockText(block: HTMLElement): string {
  return (block.innerText ?? "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function conversationBlockId(block: HTMLElement): string {
  return block.dataset.feedItemId?.trim() || block.id.trim() || "unknown";
}

function conversationBlockLabel(block: HTMLElement, t: Translate): string {
  const itemKind = block.dataset.feedItemKind;
  if (itemKind === "turn") {
    return t("Conversation turn");
  }
  if (itemKind === "activity") {
    return t("Activity block");
  }
  if (itemKind === "pending-send") {
    return t("Pending message");
  }
  return t("Conversation block");
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}

function isInteractiveEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest("button, a, input, textarea, select, summary, [role='button'], [role='menuitem'], [contenteditable='true'], [role='textbox']"));
}

function cssEscape(value: string): string {
  if (typeof globalThis.CSS?.escape === "function") {
    return globalThis.CSS.escape(value);
  }
  return value.replace(/["\\\]]/gu, "\\$&");
}
