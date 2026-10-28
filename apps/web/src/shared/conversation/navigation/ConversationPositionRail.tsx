import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ConversationTimelineItem, ConversationTimelineMessageItem } from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import type { ConversationTimelineItemLocator } from "../timeline/ConversationTimeline.js";
import { conversationPositionMarkers } from "./conversation-position-markers.js";
import { positionMarkerHeight, useConversationPositionGeometry } from "./use-conversation-position-geometry.js";
import "./conversation-position-rail.css";

export interface ConversationPositionIdentity { readonly name: string; readonly avatar: ReactNode }
export interface ConversationPositionRailProps {
  readonly items: readonly ConversationTimelineItem[];
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly locatorRef: RefObject<ConversationTimelineItemLocator | null>;
  readonly identity: (item: ConversationTimelineMessageItem) => ConversationPositionIdentity;
  readonly onNavigate: () => void;
}

export function ConversationPositionRail({ items, scrollRef, locatorRef, identity, onNavigate }: ConversationPositionRailProps): React.JSX.Element | null {
  const { t } = useI18n();
  const markers = useMemo(() => conversationPositionMarkers(items), [items]);
  const indexById = useMemo(() => new Map(markers.map((marker, index) => [marker.id, index])), [markers]);
  const indexByIdRef = useRef(indexById);
  indexByIdRef.current = indexById;
  const geometry = useConversationPositionGeometry(scrollRef, markers);
  const marksRef = useRef<HTMLDivElement>(null);
  const markerRefs = useRef(new Map<string, HTMLButtonElement>());
  const navigationSequence = useRef(0);
  const focusFrame = useRef<number | undefined>(undefined);
  const [scrollTop, setScrollTop] = useState(0);
  const [hoveredId, setHoveredId] = useState<string>();
  const [focusedId, setFocusedId] = useState<string>();
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState("");
  const currentFocusedId = focusedId && indexById.has(focusedId) ? focusedId : undefined;
  const currentHoveredId = hoveredId && indexById.has(hoveredId) ? hoveredId : undefined;
  const previewId = dismissed ? undefined : currentHoveredId ?? currentFocusedId;
  const previewIndex = indexById.get(previewId ?? "") ?? -1;
  const previewMarker = markers[previewIndex];
  const previewIdentity = previewMarker ? identity(previewMarker.item) : undefined;
  const tabStopId = currentFocusedId ?? (indexById.has(geometry.activeId ?? "") ? geometry.activeId : undefined) ?? markers[0]?.id;
  const effectiveScrollTop = Math.min(scrollTop, Math.max(0, markers.length * positionMarkerHeight - geometry.height));
  const start = Math.max(0, Math.floor(effectiveScrollTop / positionMarkerHeight) - 4);
  const end = Math.min(markers.length, Math.ceil((effectiveScrollTop + geometry.height) / positionMarkerHeight) + 4);
  const indexes = new Set(Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index));
  for (const id of [currentFocusedId, currentHoveredId, tabStopId, geometry.activeId]) {
    const index = indexById.get(id ?? "") ?? -1;
    if (index >= 0) indexes.add(index);
  }

  useEffect(() => () => {
    navigationSequence.current += 1;
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
  }, []);
  useEffect(() => {
    if (focusedId && !indexById.has(focusedId)) setFocusedId(undefined);
    if (hoveredId && !indexById.has(hoveredId)) setHoveredId(undefined);
  }, [indexById, focusedId, hoveredId]);
  useEffect(() => {
    if (geometry.visible) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest(".conversation-position-rail")) scrollRef.current?.focus({ preventScroll: true });
    setHoveredId(undefined);
    setFocusedId(undefined);
  }, [geometry.visible, scrollRef]);
  useEffect(() => {
    const scroller = marksRef.current;
    if (!scroller) return;
    // Virtual rows can unmount the destination without dispatching a blur event.
    const focusedInside = scroller.contains(document.activeElement);
    if (!focusedInside && currentFocusedId) setFocusedId(undefined);
    const index = indexById.get((focusedInside ? currentFocusedId : undefined) ?? geometry.activeId ?? "") ?? -1;
    if (index < 0 || currentHoveredId) return;
    const top = index * positionMarkerHeight;
    if (top < scroller.scrollTop || top + positionMarkerHeight > scroller.scrollTop + geometry.height) {
      scroller.scrollTop = Math.max(0, top - geometry.height / 2);
    }
  }, [geometry.activeId, geometry.height, currentFocusedId, currentHoveredId, indexById]);

  async function navigate(index: number) {
    cancelMarkerFocus();
    const marker = markers[index];
    const feed = scrollRef.current;
    const locator = locatorRef.current;
    if (!marker || !feed || !locator) return;
    const sequence = ++navigationSequence.current;
    const isCurrent = () => sequence === navigationSequence.current && scrollRef.current === feed && indexByIdRef.current.has(marker.id);
    setError("");
    onNavigate();
    try {
      const result = await locator.revealFirstMatchingItem(marker.itemIds, target => {
        if (!isCurrent()) return;
        feed.scrollTo({ top: feed.scrollTop + target.getBoundingClientRect().top - feed.getBoundingClientRect().top - 24, behavior: "instant" });
        // Capture the destination after the locator has mounted its virtual row.
        onNavigate();
        target.focus({ preventScroll: true });
        target.animate([{ backgroundColor: "var(--ling-bg-subtle)" }, { backgroundColor: "transparent" }], {
          duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700,
        });
      }, isCurrent);
      if (isCurrent() && result !== "revealed" && result !== "cancelled") setError(t("Source unavailable"));
    } catch {
      if (isCurrent()) setError(t("Source unavailable"));
    }
  }

  function focusMarker(index: number) {
    const marker = markers[index];
    if (!marker) return;
    setFocusedId(marker.id);
    setDismissed(false);
    cancelMarkerFocus();
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = undefined;
      markerRefs.current.get(marker.id)?.focus({ preventScroll: true });
    });
  }

  function cancelMarkerFocus() {
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = undefined;
  }

  if (!geometry.frame) return null;
  const previewTop = Math.max(72, Math.min(geometry.frameHeight - 72,
    (geometry.frameHeight - geometry.height) / 2 + (previewIndex + 0.5) * positionMarkerHeight - effectiveScrollTop));
  return createPortal(
    <aside className="conversation-position-rail" aria-label={t("Conversation navigation")}
      hidden={!geometry.visible} style={{ "--conversation-position-height": `${geometry.height}px` } as CSSProperties}
      onPointerLeave={() => setHoveredId(undefined)}
      onKeyDown={event => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation();
        cancelMarkerFocus();
        setDismissed(true); setHoveredId(undefined);
        scrollRef.current?.focus({ preventScroll: true });
      }}>
      <div className="conversation-position-rail__marks" ref={marksRef}
        data-overflow-top={scrollTop > 1 || undefined}
        data-overflow-bottom={markers.length * positionMarkerHeight - scrollTop - geometry.height > 1 || undefined}
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
        <div style={{ height: markers.length * positionMarkerHeight }}>
          {[...indexes].sort((a, b) => a - b).map(index => {
            const marker = markers[index];
            const author = identity(marker.item);
            const distance = Math.abs(index - (indexById.get(currentHoveredId ?? "") ?? -1));
            return <button key={marker.id} type="button" className="conversation-position-rail__marker"
              ref={element => { if (element) markerRefs.current.set(marker.id, element); else markerRefs.current.delete(marker.id); }}
              style={{ top: index * positionMarkerHeight }} tabIndex={marker.id === tabStopId ? 0 : -1}
              aria-label={t("Message {position} of {count}: {author}", { position: index + 1, count: markers.length, author: author.name })}
              aria-current={marker.id === geometry.activeId ? "true" : undefined}
              aria-description={`${marker.preview || t("Message with attachments")}. ${t("Jump to message")}`}
              data-position-marker-id={marker.id} data-visible={geometry.visibleIds.has(marker.id) || undefined}
              data-hover-distance={currentHoveredId && distance <= 3 ? distance : undefined}
              onPointerEnter={() => { setHoveredId(marker.id); setDismissed(false); }}
              onFocus={() => { setFocusedId(marker.id); setDismissed(false); }}
              onBlur={() => setFocusedId(undefined)} onClick={() => void navigate(index)}
              onKeyDown={event => {
                const next = event.key === "Home" ? 0 : event.key === "End" ? markers.length - 1 :
                  event.key === "ArrowUp" || event.key === "ArrowLeft" ? Math.max(0, index - 1) :
                    event.key === "ArrowDown" || event.key === "ArrowRight" ? Math.min(markers.length - 1, index + 1) : undefined;
                if (next === undefined) return;
                event.preventDefault(); event.stopPropagation(); focusMarker(next);
              }}><span className="conversation-position-rail__tick" aria-hidden="true" /></button>;
          })}
        </div>
      </div>
      {previewMarker && previewIdentity ? <div className="conversation-position-rail__preview" aria-hidden="true"
        style={{ top: previewTop - (geometry.frameHeight - geometry.height) / 2 }}>
        <div className="conversation-position-rail__identity"><span className="conversation-position-rail__avatar">{previewIdentity.avatar}</span><strong>{previewIdentity.name}</strong></div>
        <div className="conversation-position-rail__copy">{previewMarker.preview || t("Message with attachments")}</div>
      </div> : null}
      {error ? <span role="status" className="conversation-position-rail__error">{error}</span> : null}
    </aside>, geometry.frame,
  );
}
