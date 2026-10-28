import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ConversationPositionMarker } from "./conversation-position-markers.js";

export const positionMarkerHeight = 12;
interface PositionGeometry {
  readonly frame: HTMLElement | null;
  readonly visible: boolean;
  readonly height: number;
  readonly frameHeight: number;
  readonly activeId?: string;
  readonly visibleIds: ReadonlySet<string>;
}
const initialGeometry: PositionGeometry = { frame: null, visible: false, height: 0, frameHeight: 0, visibleIds: new Set() };

/** Read only mounted timeline rows. The transcript's locator owns virtual-history mounting. */
export function useConversationPositionGeometry(
  scrollRef: RefObject<HTMLDivElement | null>,
  markers: readonly ConversationPositionMarker[],
) {
  const [geometry, setGeometry] = useState<PositionGeometry>(initialGeometry);
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const refreshRef = useRef<() => void>(() => {});
  // The scroll viewport is an ancestor: its ref attaches after child layout effects.
  useEffect(() => {
    const feed = scrollRef.current;
    const frame = feed?.parentElement;
    if (!feed || !frame) return;
    let request: number | undefined;
    const measure = () => {
      request = undefined;
      const current = markersRef.current;
      const markerByItemId = new Map(current.flatMap(marker => marker.itemIds.map(id => [id, marker.id] as const)));
      const rect = feed.getBoundingClientRect();
      const visibleIds = new Set<string>();
      let activeId: string | undefined;
      for (const row of feed.querySelectorAll<HTMLElement>("[data-feed-item-id]")) {
        const markerId = markerByItemId.get(row.dataset.feedItemId ?? "");
        if (!markerId) continue;
        const rowRect = row.getBoundingClientRect();
        if (rowRect.bottom > rect.top && rowRect.top < rect.bottom) {
          visibleIds.add(markerId);
          activeId ??= markerId;
        }
      }
      const visible = current.length > 1 && frame.clientWidth >= 560 && feed.clientHeight >= 360 && feed.scrollHeight > feed.clientHeight + 1;
      frame.toggleAttribute("data-conversation-position-navigation", visible);
      const next: PositionGeometry = {
        frame, visible, visibleIds, activeId,
        height: Math.min(feed.clientHeight * 0.45, current.length * positionMarkerHeight),
        frameHeight: frame.clientHeight,
      };
      setGeometry(previous => previous.frame === frame && previous.visible === visible &&
        previous.height === next.height && previous.frameHeight === next.frameHeight &&
        previous.activeId === activeId && previous.visibleIds.size === visibleIds.size &&
        [...visibleIds].every(id => previous.visibleIds.has(id)) ? previous : next);
    };
    const schedule = () => { request ??= requestAnimationFrame(measure); };
    refreshRef.current = schedule;
    const sizes = new ResizeObserver(schedule);
    sizes.observe(feed);
    sizes.observe(frame);
    for (const child of feed.children) sizes.observe(child);
    const mounts = new MutationObserver(schedule);
    mounts.observe(feed, { childList: true, subtree: true, characterData: true });
    feed.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      if (request !== undefined) cancelAnimationFrame(request);
      sizes.disconnect();
      mounts.disconnect();
      feed.removeEventListener("scroll", schedule);
      frame.removeAttribute("data-conversation-position-navigation");
      refreshRef.current = () => {};
    };
  }, [scrollRef]);
  useLayoutEffect(() => { refreshRef.current(); }, [markers]);
  return geometry;
}
