import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";

const channelBottomPanelDefaultHeight = 260;
const channelBottomPanelMinHeight = 190;

interface ChannelBottomPanelResizeControllerInput {
  readonly containerRef: MutableRefObject<HTMLDivElement | null>;
  readonly resizeObserverKey: string;
}

export interface ChannelBottomPanelResizeController {
  readonly height: number;
  readonly resizing: boolean;
  readonly panelStyle: CSSProperties;
  readonly handleResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleResizePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleResizePointerEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function useChannelBottomPanelResizeController({
  containerRef,
  resizeObserverKey,
}: ChannelBottomPanelResizeControllerInput): ChannelBottomPanelResizeController {
  const [height, setHeight] = useState(channelBottomPanelDefaultHeight);
  const [containerHeight, setContainerHeight] = useState(0);
  const [resizing, setResizing] = useState(false);
  const resizeDragRef = useRef<{ readonly pointerId: number; readonly startY: number; readonly startHeight: number; readonly containerHeight: number } | undefined>();

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return undefined;
    }
    const updateHeight = (): void => {
      const nextHeight = Math.round(element.getBoundingClientRect().height);
      setContainerHeight((current) => current === nextHeight ? current : nextHeight);
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      globalThis.addEventListener("resize", updateHeight);
      return () => {
        globalThis.removeEventListener("resize", updateHeight);
      };
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [containerRef, resizeObserverKey]);

  useEffect(() => {
    if (containerHeight <= 0) {
      return;
    }
    setHeight((current) => clampChannelBottomPanelHeight(current, containerHeight));
  }, [containerHeight]);

  useEffect(() => {
    function handleGlobalResizeMove(event: PointerEvent): void {
      const drag = resizeDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      setHeight(clampChannelBottomPanelHeight(drag.startHeight + drag.startY - event.clientY, drag.containerHeight));
    }

    function handleGlobalResizeEnd(event: PointerEvent): void {
      const drag = resizeDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      resizeDragRef.current = undefined;
      setResizing(false);
    }

    globalThis.addEventListener("pointermove", handleGlobalResizeMove, { passive: false });
    globalThis.addEventListener("pointerup", handleGlobalResizeEnd);
    globalThis.addEventListener("pointercancel", handleGlobalResizeEnd);
    return () => {
      globalThis.removeEventListener("pointermove", handleGlobalResizeMove);
      globalThis.removeEventListener("pointerup", handleGlobalResizeEnd);
      globalThis.removeEventListener("pointercancel", handleGlobalResizeEnd);
    };
  }, []);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    const measuredContainerHeight = Math.round(containerRef.current?.getBoundingClientRect().height ?? globalThis.innerHeight);
    const dragContainerHeight = measuredContainerHeight > 0 ? measuredContainerHeight : channelBottomPanelDefaultHeight * 2;
    const startHeight = clampChannelBottomPanelHeight(height, dragContainerHeight);
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
      containerHeight: dragContainerHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    setHeight(startHeight);
  }, [containerRef, height]);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    setHeight(clampChannelBottomPanelHeight(drag.startHeight + drag.startY - event.clientY, drag.containerHeight));
  }, []);

  const handleResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeDragRef.current = undefined;
    setResizing(false);
  }, []);

  return {
    height,
    resizing,
    panelStyle: {
      "--channel-bottom-panel-height": `${height}px`,
    } as CSSProperties,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerEnd,
  };
}

function clampChannelBottomPanelHeight(height: number, containerHeight: number): number {
  const maxHeight = Math.max(channelBottomPanelMinHeight, Math.floor(containerHeight / 2));
  return Math.max(channelBottomPanelMinHeight, Math.min(maxHeight, Math.round(height)));
}
