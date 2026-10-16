import { useCallback, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import type { ConversationTimelineItemLocator } from "../timeline/ConversationTimeline.js";
import { conversationMeasurementScrollEvent, readConversationReadingAnchor, restoreConversationReadingAnchor, type ConversationReadingAnchor } from "./conversation-reading-anchor.js";

interface ConversationReadingViewportInput {
  readonly scopeKey: string | undefined;
  readonly revision: unknown;
  readonly contentKey: string;
  readonly searchActive?: boolean;
  readonly enabled?: boolean;
  readonly latestThresholdPx?: number;
}

/** Reading state only: the existing Timeline and send/runtime owners are unchanged. */
export function useConversationReadingViewport({
  scopeKey, revision, contentKey, searchActive = false, enabled = true, latestThresholdPx = 56,
}: ConversationReadingViewportInput) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const locatorRef = useRef<ConversationTimelineItemLocator | null>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const followingRef = useRef(true);
  const returningToLatestRef = useRef(false);
  const anchorRef = useRef<ConversationReadingAnchor | undefined>(undefined);
  const restoredTopRef = useRef<number | undefined>(undefined);
  const sizeRef = useRef<{ height: number; viewport: number } | undefined>(undefined);
  const inputIntentRef = useRef(false);
  const capturePendingRef = useRef(false);
  const restoringRef = useRef<ConversationReadingAnchor | undefined>(undefined);
  const [latestButtonVisible, setLatestButtonVisible] = useState(false);

  const reset = useCallback(() => {
    followingRef.current = true;
    returningToLatestRef.current = false;
    anchorRef.current = undefined;
    restoringRef.current = undefined;
    restoredTopRef.current = undefined;
    sizeRef.current = undefined;
    inputIntentRef.current = false;
    capturePendingRef.current = false;
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
    setLatestButtonVisible(false);
  }, []);
  useLayoutEffect(reset, [scopeKey, reset]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const feed = scrollRef.current;
    if (!feed) return;
    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    followingRef.current = true;
    returningToLatestRef.current = !reducedMotion && behavior === "smooth";
    anchorRef.current = undefined;
    restoredTopRef.current = undefined;
    inputIntentRef.current = false;
    capturePendingRef.current = false;
    setLatestButtonVisible(false);
    feed.scrollTo({ top: feed.scrollHeight, behavior: reducedMotion ? "auto" : behavior });
  }, []);

  const pauseAutoFollow = useCallback(() => {
    followingRef.current = false;
    inputIntentRef.current = true;
    restoredTopRef.current = undefined;
    const feed = scrollRef.current;
    if (returningToLatestRef.current && feed) feed.scrollTo({ top: feed.scrollTop, behavior: "instant" });
    returningToLatestRef.current = false;
    if (feed) anchorRef.current = readConversationReadingAnchor(feed);
  }, []);
  useLayoutEffect(() => {
    if (searchActive) pauseAutoFollow();
  }, [searchActive, scopeKey, pauseAutoFollow]);

  const reconcile = useCallback(() => {
    const feed = scrollRef.current;
    if (!feed) return;
    if (capturePendingRef.current) {
      const anchor = readConversationReadingAnchor(feed);
      if (!anchor) return;
      anchorRef.current = anchor;
      capturePendingRef.current = false;
    }
    sizeRef.current = { height: feed.scrollHeight, viewport: feed.clientHeight };
    if (followingRef.current) {
      feed.scrollTop = feed.scrollHeight;
      restoredTopRef.current = feed.scrollTop;
      setLatestButtonVisible(false);
      return;
    }
    if (!anchorRef.current) anchorRef.current = readConversationReadingAnchor(feed);
    if (anchorRef.current && restoreConversationReadingAnchor(feed, anchorRef.current)) {
      restoredTopRef.current = feed.scrollTop;
    } else if (anchorRef.current && !restoringRef.current && locatorRef.current) {
      const anchor = anchorRef.current;
      restoringRef.current = anchor;
      void locatorRef.current.revealReadingAnchor(anchor, () => {
        if (scrollRef.current !== feed || anchorRef.current !== anchor || followingRef.current) return;
        restoreConversationReadingAnchor(feed, anchor);
        restoredTopRef.current = feed.scrollTop;
      }).finally(() => {
        if (restoringRef.current === anchor) restoringRef.current = undefined;
      });
    }
    setLatestButtonVisible(distanceFromLatest(feed) > latestThresholdPx);
  }, [latestThresholdPx]);

  const schedule = useCallback(() => {
    if (frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      reconcile();
    });
  }, [reconcile]);

  useLayoutEffect(() => {
    if (enabled) schedule();
  }, [enabled, revision, contentKey, scopeKey, schedule]);
  useLayoutEffect(() => {
    const feed = scrollRef.current;
    if (!enabled || !feed) return;
    const onMeasurementScroll = (event: Event) => {
      const top = (event as CustomEvent<number>).detail;
      if (!Number.isFinite(top)) return;
      // A virtualizer adjustment can scroll before its new row geometry commits.
      restoredTopRef.current = Math.max(0, Math.min(top, feed.scrollHeight - feed.clientHeight));
      schedule();
    };
    feed.addEventListener(conversationMeasurementScrollEvent, onMeasurementScroll);
    return () => feed.removeEventListener(conversationMeasurementScrollEvent, onMeasurementScroll);
  }, [enabled, scopeKey, schedule]);
  useLayoutEffect(() => {
    const feed = scrollRef.current;
    if (!enabled || !feed || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(schedule);
    observer.observe(feed);
    Array.from(feed.children).forEach(child => observer.observe(child));
    // Windowed rows can mount without changing the outer timeline's total height.
    const mounts = new MutationObserver(schedule);
    mounts.observe(feed, { childList: true, subtree: true });
    return () => { observer.disconnect(); mounts.disconnect(); };
  }, [enabled, contentKey, scopeKey, schedule]);
  useLayoutEffect(() => () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
    anchorRef.current = undefined;
  }, []);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const feed = event.currentTarget;
    const size = sizeRef.current;
    const restoring = !!anchorRef.current && restoringRef.current === anchorRef.current;
    // Layout-driven clamping/anchoring is not a request to leave the tail.
    if (!inputIntentRef.current && (capturePendingRef.current || restoring ||
      size && (size.height !== feed.scrollHeight || size.viewport !== feed.clientHeight))) {
      schedule();
      return;
    }
    // Intermediate native smooth-scroll frames still belong to the explicit jump.
    if (returningToLatestRef.current && !inputIntentRef.current) {
      if (distanceFromLatest(feed) > latestThresholdPx) return;
      returningToLatestRef.current = false;
    }
    inputIntentRef.current = false;
    if (restoredTopRef.current !== undefined && Math.abs(feed.scrollTop - restoredTopRef.current) <= 1) return;
    restoredTopRef.current = undefined;
    const atLatest = distanceFromLatest(feed) <= latestThresholdPx;
    followingRef.current = atLatest;
    anchorRef.current = atLatest ? undefined : readConversationReadingAnchor(feed);
    // A virtual range may still describe the previous scroll position this frame.
    capturePendingRef.current = !atLatest && !anchorRef.current;
    if (capturePendingRef.current) schedule();
    setLatestButtonVisible(!atLatest);
  }, [latestThresholdPx, schedule]);

  return { scrollRef, locatorRef, latestButtonVisible, scrollToLatest, pauseAutoFollow, onScroll, reset };
}

function distanceFromLatest(feed: HTMLElement): number {
  return Math.max(0, feed.scrollHeight - feed.clientHeight - feed.scrollTop);
}
