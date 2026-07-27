import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";

export interface ConversationBottomPanelResizeControllerInput {
  readonly containerRef?: MutableRefObject<HTMLElement | null>;
  readonly resizeObserverKey: string;
  readonly cssVariableName: string;
  readonly defaultHeight?: number;
  readonly minHeight?: number;
}

export interface ConversationBottomPanelResizeController {
  readonly height: number;
  readonly resizing: boolean;
  readonly panelStyle: CSSProperties;
  readonly handleResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleResizePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleResizePointerEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function useConversationBottomPanelResizeController({
  containerRef,
  resizeObserverKey,
  cssVariableName,
  defaultHeight = 260,
  minHeight = 190,
}: ConversationBottomPanelResizeControllerInput): ConversationBottomPanelResizeController {
  const [height, setHeight] = useState(defaultHeight);
  const [containerHeight, setContainerHeight] = useState(0);
  const [resizing, setResizing] = useState(false);
  const resizeDragRef = useRef<{
    readonly pointerId: number;
    readonly startY: number;
    readonly startHeight: number;
    readonly containerHeight: number;
  }>();

  useEffect(() => {
    const element = containerRef?.current;
    if (!element) {
      setContainerHeight(globalThis.innerHeight || defaultHeight * 2);
      return undefined;
    }
    const updateHeight = (): void => {
      const nextHeight = Math.round(element.getBoundingClientRect().height);
      setContainerHeight((current) => current === nextHeight ? current : nextHeight);
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      globalThis.addEventListener("resize", updateHeight);
      return () => globalThis.removeEventListener("resize", updateHeight);
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef, defaultHeight, resizeObserverKey]);

  useEffect(() => {
    if (containerHeight <= 0) return;
    setHeight((current) => clampBottomPanelHeight(current, containerHeight, minHeight));
  }, [containerHeight, minHeight]);

  useEffect(() => {
    const handleGlobalResizeMove = (event: PointerEvent): void => {
      const drag = resizeDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      setHeight(clampBottomPanelHeight(drag.startHeight + drag.startY - event.clientY, drag.containerHeight, minHeight));
    };
    const handleGlobalResizeEnd = (event: PointerEvent): void => {
      const drag = resizeDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      resizeDragRef.current = undefined;
      setResizing(false);
    };
    globalThis.addEventListener("pointermove", handleGlobalResizeMove, { passive: false });
    globalThis.addEventListener("pointerup", handleGlobalResizeEnd);
    globalThis.addEventListener("pointercancel", handleGlobalResizeEnd);
    return () => {
      globalThis.removeEventListener("pointermove", handleGlobalResizeMove);
      globalThis.removeEventListener("pointerup", handleGlobalResizeEnd);
      globalThis.removeEventListener("pointercancel", handleGlobalResizeEnd);
    };
  }, [minHeight]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const measuredContainerHeight = Math.round(containerRef?.current?.getBoundingClientRect().height ?? globalThis.innerHeight);
    const dragContainerHeight = measuredContainerHeight > 0 ? measuredContainerHeight : defaultHeight * 2;
    const startHeight = clampBottomPanelHeight(height, dragContainerHeight, minHeight);
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
      containerHeight: dragContainerHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    setHeight(startHeight);
  }, [containerRef, defaultHeight, height, minHeight]);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setHeight(clampBottomPanelHeight(drag.startHeight + drag.startY - event.clientY, drag.containerHeight, minHeight));
  }, [minHeight]);

  const handleResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resizeDragRef.current = undefined;
    setResizing(false);
  }, []);

  return {
    height,
    resizing,
    panelStyle: { [cssVariableName]: `${height}px` } as CSSProperties,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerEnd,
  };
}

function clampBottomPanelHeight(height: number, containerHeight: number, minHeight: number): number {
  const maxHeight = Math.max(minHeight, Math.floor(containerHeight / 2));
  return Math.max(minHeight, Math.min(maxHeight, Math.round(height)));
}
