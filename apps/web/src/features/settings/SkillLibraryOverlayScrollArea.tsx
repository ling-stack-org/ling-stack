import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent,
  type PropsWithChildren,
  type UIEvent,
} from "react";
import { TableContainer } from "../../shared/ui/index.js";

const SCROLL_IDLE_DELAY_MS = 700;
const TRACK_INSET_PX = 8;
const MIN_THUMB_HEIGHT_PX = 32;

interface ScrollDragState {
  readonly pointerId: number;
  readonly startClientY: number;
  readonly startScrollTop: number;
}

export function SkillLibraryOverlayScrollArea({ children }: PropsWithChildren): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const scrollIdleTimerRef = useRef<number>();
  const dragRef = useRef<ScrollDragState>();

  const syncScrollbar = useCallback((): void => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!viewport || !track || !thumb) return;

    const overflowing = viewport.scrollHeight > viewport.clientHeight + 1;
    const viewportStyle = globalThis.getComputedStyle(viewport);
    const inlineBorders = Number.parseFloat(viewportStyle.borderLeftWidth)
      + Number.parseFloat(viewportStyle.borderRightWidth);
    const nativeScrollbarGutter = Math.max(
      0,
      viewport.offsetWidth - viewport.clientWidth - inlineBorders,
    );
    viewport.dataset.overflow = String(overflowing);
    viewport.style.setProperty(
      "--skill-library-native-scrollbar-gutter",
      `${nativeScrollbarGutter}px`,
    );
    track.dataset.overflow = String(overflowing);
    if (!overflowing) {
      thumb.style.height = "0px";
      thumb.style.transform = "translateY(0)";
      return;
    }

    const trackHeight = Math.max(0, viewport.clientHeight - TRACK_INSET_PX);
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(MIN_THUMB_HEIGHT_PX, trackHeight * (viewport.clientHeight / viewport.scrollHeight)),
    );
    const scrollRange = viewport.scrollHeight - viewport.clientHeight;
    const thumbRange = trackHeight - thumbHeight;
    const thumbOffset = scrollRange > 0 ? (viewport.scrollTop / scrollRange) * thumbRange : 0;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbOffset}px)`;
  }, []);

  const scheduleScrollbarIdle = useCallback((viewport: HTMLDivElement): void => {
    if (scrollIdleTimerRef.current !== undefined) globalThis.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = globalThis.setTimeout(() => {
      delete viewport.dataset.scrolling;
      scrollIdleTimerRef.current = undefined;
    }, SCROLL_IDLE_DELAY_MS);
  }, []);

  useLayoutEffect(syncScrollbar);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !globalThis.ResizeObserver) return undefined;
    const resizeObserver = new ResizeObserver(syncScrollbar);
    resizeObserver.observe(viewport);
    const table = viewport.querySelector("table");
    if (table) resizeObserver.observe(table);
    return () => resizeObserver.disconnect();
  }, [syncScrollbar]);

  useEffect(() => () => {
    if (scrollIdleTimerRef.current !== undefined) globalThis.clearTimeout(scrollIdleTimerRef.current);
  }, []);

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    event.currentTarget.dataset.scrolling = "true";
    syncScrollbar();
    scheduleScrollbarIdle(event.currentTarget);
  }

  function handlePointerDown(event: PointerEvent<HTMLSpanElement>): void {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track || track.dataset.overflow !== "true") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    track.dataset.dragging = "true";
    viewport.dataset.scrolling = "true";
    dragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startScrollTop: viewport.scrollTop,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLSpanElement>): void {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !viewport || !track || !thumb) return;
    const thumbRange = track.clientHeight - thumb.offsetHeight;
    const scrollRange = viewport.scrollHeight - viewport.clientHeight;
    if (thumbRange <= 0 || scrollRange <= 0) return;
    viewport.scrollTop = drag.startScrollTop + (event.clientY - drag.startClientY) * (scrollRange / thumbRange);
  }

  function finishPointerDrag(event: PointerEvent<HTMLSpanElement>): void {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = undefined;
    if (track) delete track.dataset.dragging;
    if (viewport) scheduleScrollbarIdle(viewport);
  }

  return (
    <div className="settings-skill-table-scroll-area">
      <TableContainer
        ref={viewportRef}
        className="settings-skill-table-wrap settings-skill-table-wrap--compact"
        onScroll={handleScroll}
      >
        {children}
      </TableContainer>
      <div ref={trackRef} className="settings-skill-overlay-scrollbar" data-overflow="false" aria-hidden="true">
        <span
          ref={thumbRef}
          className="settings-skill-overlay-scrollbar-thumb"
          onPointerCancel={finishPointerDrag}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerDrag}
        />
      </div>
    </div>
  );
}
