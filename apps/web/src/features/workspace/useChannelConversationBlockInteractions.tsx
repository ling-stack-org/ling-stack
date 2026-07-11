import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { CheckCircle2, CircleAlert, Copy, Info, Search } from "lucide-react";
import type { Translate } from "../../i18n.js";
import type { ChannelComposerInlineFeedback, ChannelComposerInlineFeedbackTone } from "./ChannelComposer.js";

interface ConversationBlockActionMenuState {
  readonly blockId: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly feedback?: string;
}

interface ConversationBlockLongPressState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly timeoutId: number;
  readonly block: HTMLElement;
}

interface ChannelConversationBlockInteractionsInput {
  readonly scrollRef: RefObject<HTMLDivElement>;
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
  const [conversationBlockFeedback, setConversationBlockFeedback] = useState<ChannelComposerInlineFeedback | undefined>();
  const [conversationBlockActionMenu, setConversationBlockActionMenu] = useState<ConversationBlockActionMenuState | undefined>();
  const conversationBlockFeedbackTimeoutRef = useRef<number | undefined>();
  const conversationBlockLongPressRef = useRef<ConversationBlockLongPressState | undefined>();
  const conversationBlockActionMenuRef = useRef<HTMLDivElement | null>(null);

  const closeConversationBlockActionMenu = useCallback((): void => {
    setConversationBlockActionMenu(undefined);
  }, []);

  const showConversationBlockFeedback = useCallback((tone: ChannelComposerInlineFeedbackTone, message: string): void => {
    if (conversationBlockFeedbackTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(conversationBlockFeedbackTimeoutRef.current);
    }
    setConversationBlockFeedback({ id: Date.now(), tone, message });
    conversationBlockFeedbackTimeoutRef.current = globalThis.setTimeout(() => {
      setConversationBlockFeedback(undefined);
      conversationBlockFeedbackTimeoutRef.current = undefined;
    }, 1_600);
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
    block.focus({ preventScroll: true });
    block.scrollIntoView({ block: "nearest" });
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
      setConversationBlockActionMenu(undefined);
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
  }, [conversationBlockActionMenu, focusConversationBlockById]);

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

  const copyConversationBlock = useCallback(async (block: HTMLElement): Promise<void> => {
    const text = conversationBlockText(block);
    if (!text) {
      showConversationBlockFeedback("error", t("Nothing to copy"));
      return;
    }
    if (!globalThis.navigator?.clipboard?.writeText) {
      showConversationBlockFeedback("error", t("Copy unavailable"));
      return;
    }
    try {
      await globalThis.navigator.clipboard.writeText(text);
      showConversationBlockFeedback("success", t("Copied focused block"));
      const blockId = block.dataset.feedItemId ?? "";
      setConversationBlockActionMenu((current) => {
        if (!current || current.blockId !== blockId) {
          return current;
        }
        return { ...current, feedback: t("Copied") };
      });
    } catch {
      showConversationBlockFeedback("error", t("Copy unavailable"));
    }
  }, [showConversationBlockFeedback, t]);

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
      blockId: block.dataset.feedItemId ?? "",
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
      setConversationBlockActionMenu(undefined);
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
      void copyConversationBlock(block);
      return;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      const feed = scrollRef.current;
      const focusedBlock = focusedConversationBlock();
      const block = focusedBlock ?? messageFeedFocusableBlocks().find((candidate) => candidate.querySelector(conversationExpandableSelector));
      const expandable = findConversationExpandable(block) ?? findConversationExpandable(feed);
      if (!expandable) {
        return;
      }
      event.preventDefault();
      expandable.click();
      showConversationBlockFeedback("info", t("Expanded focused block"));
    }
  }, [
    conversationBlockActionMenu,
    copyConversationBlock,
    focusAdjacentConversationBlock,
    focusedConversationBlock,
    messageFeedFocusableBlocks,
    scrollRef,
    showConversationBlockFeedback,
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
    if (conversationBlockFeedbackTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(conversationBlockFeedbackTimeoutRef.current);
    }
    if (conversationBlockLongPressRef.current) {
      globalThis.clearTimeout(conversationBlockLongPressRef.current.timeoutId);
      conversationBlockLongPressRef.current = undefined;
    }
  }, []);

  const conversationBlockFeedbackNode = useMemo(() => {
    if (!conversationBlockFeedback) {
      return null;
    }
    return (
      <div key={conversationBlockFeedback.id} className={`conversation-block-feedback ${conversationBlockFeedback.tone}`} role="status" aria-live="polite">
        {conversationBlockFeedback.tone === "success" ? <CheckCircle2 size={13} /> : conversationBlockFeedback.tone === "error" ? <CircleAlert size={13} /> : <Info size={13} />}
        <span>{conversationBlockFeedback.message}</span>
      </div>
    );
  }, [conversationBlockFeedback]);

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
        {conversationBlockActionMenu.feedback ? <small role="status" aria-live="polite">{conversationBlockActionMenu.feedback}</small> : null}
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            const block = scrollRef.current?.querySelector<HTMLElement>(`[data-feed-item-id="${cssEscape(conversationBlockActionMenu.blockId)}"]`);
            if (block) {
              void copyConversationBlock(block);
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
  }, [conversationBlockActionMenu, copyConversationBlock, focusConversationBlockById, scrollRef, t]);

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
  ".conversation-work-cell-row-main[aria-expanded='false']",
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
