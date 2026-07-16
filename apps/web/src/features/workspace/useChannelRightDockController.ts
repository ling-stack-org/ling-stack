import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import type { DockPageKind } from "../../shared/conversation/index.js";
import type { WorkspaceRightDockFileTarget, WorkspaceRightDockPageRequest, WorkspaceRightDockReviewTarget } from "./right-dock/index.js";
import {
  channelRightDockMinWidth,
  channelRightDockMinChatWidth,
  channelRightDockResizeHandleWidth,
  channelRightDockTransitionMs,
  channelRightDockUnmountDelayMs,
  clampChannelRightDockWidth,
  easeChannelDockMotion,
  resolveChannelWorkspaceLayoutDecision,
  resolveChannelWorkspaceLayoutTargets,
} from "./layout/channel-workspace-layout.js";

interface ChannelRightDockControllerInput {
  readonly initialOpen: boolean;
  readonly intentOpen: boolean;
  readonly resizeObserverKey: string;
}

export interface ChannelRightDockController {
  readonly windowRef: MutableRefObject<HTMLDivElement | null>;
  readonly mainRef: MutableRefObject<HTMLDivElement | null>;
  readonly pageRequest: WorkspaceRightDockPageRequest | undefined;
  readonly visible: boolean;
  readonly expanded: boolean;
  readonly resizing: boolean;
  readonly width: number;
  readonly motionUntilRef: MutableRefObject<number>;
  readonly progressPopoverCanFitMainLayout: boolean;
  readonly progressPopoverCanUseMainLayout: boolean;
  readonly windowStyle: CSSProperties;
  readonly mainStyle: CSSProperties;
  readonly requestPage: (page: DockPageKind, workspaceFile?: WorkspaceRightDockFileTarget, workspaceReview?: WorkspaceRightDockReviewTarget) => void;
  readonly consumePageRequest: (nonce: number) => void;
  readonly close: () => void;
  readonly handleResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleResizePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleResizePointerEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function useChannelRightDockController({
  initialOpen,
  intentOpen,
  resizeObserverKey,
}: ChannelRightDockControllerInput): ChannelRightDockController {
  const windowRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [pageRequest, setPageRequest] = useState<WorkspaceRightDockPageRequest>();
  const [width, setWidth] = useState(channelRightDockMinWidth);
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(() => initialOpen);
  const [expanded, setExpanded] = useState(() => initialOpen);
  const [closing, setClosing] = useState(false);
  const [mainWidth, setMainWidth] = useState(0);
  const openFrameRef = useRef<number | undefined>();
  const unmountTimeoutRef = useRef<number | undefined>();
  const layoutAnimationRef = useRef<number | undefined>();
  const layoutWidthRef = useRef(initialOpen ? channelRightDockMinWidth : 0);
  const layoutHandleWidthRef = useRef(initialOpen ? channelRightDockResizeHandleWidth : 0);
  const motionUntilRef = useRef(0);
  const resizeDragRef = useRef<{ readonly pointerId: number; readonly containerRight: number; readonly containerWidth: number; readonly viewportWidth: number } | undefined>();

  const visible = intentOpen || rendered || closing;
  const { progressPopoverCanFitMainLayout, progressPopoverCanUseMainLayout } = resolveChannelWorkspaceLayoutDecision({
    mainWidth,
    rightDockVisible: visible,
    rightDockWidth: width,
  });

  useEffect(() => {
    motionUntilRef.current = Date.now() + channelRightDockUnmountDelayMs;
    const pendingUnmountId = unmountTimeoutRef.current;
    if (pendingUnmountId !== undefined) {
      globalThis.clearTimeout(pendingUnmountId);
      unmountTimeoutRef.current = undefined;
    }

    if (intentOpen) {
      setClosing(false);
      if (!rendered) {
        setExpanded(false);
        setRendered(true);
        return undefined;
      }

      const firstFrameId = globalThis.requestAnimationFrame(() => {
        const secondFrameId = globalThis.requestAnimationFrame(() => {
          openFrameRef.current = undefined;
          setExpanded(true);
        });
        openFrameRef.current = secondFrameId;
      });
      openFrameRef.current = firstFrameId;
      return () => {
        const frameId = openFrameRef.current;
        if (frameId !== undefined) {
          globalThis.cancelAnimationFrame(frameId);
          openFrameRef.current = undefined;
        }
      };
    }

    const frameId = openFrameRef.current;
    if (frameId !== undefined) {
      globalThis.cancelAnimationFrame(frameId);
      openFrameRef.current = undefined;
    }
    setExpanded(false);
    if (!rendered) {
      return undefined;
    }
    const timeoutId = globalThis.setTimeout(() => {
      unmountTimeoutRef.current = undefined;
      setRendered(false);
      setClosing(false);
    }, channelRightDockUnmountDelayMs);
    unmountTimeoutRef.current = timeoutId;
    return () => {
      globalThis.clearTimeout(timeoutId);
      if (unmountTimeoutRef.current === timeoutId) {
        unmountTimeoutRef.current = undefined;
      }
    };
  }, [intentOpen, rendered]);

  useLayoutEffect(() => {
    const {
      dockWidth: targetDockWidth,
      handleWidth: targetHandleWidth,
    } = resolveChannelWorkspaceLayoutTargets({
      rightDockExpanded: expanded,
      rightDockWidth: width,
    });
    const layoutElements = [windowRef.current, mainRef.current];

    const runningFrameId = layoutAnimationRef.current;
    if (runningFrameId !== undefined) {
      globalThis.cancelAnimationFrame(runningFrameId);
      layoutAnimationRef.current = undefined;
    }

    if (resizing) {
      layoutWidthRef.current = targetDockWidth;
      layoutHandleWidthRef.current = targetHandleWidth;
      setChannelRightDockLayoutVariables(layoutElements, targetDockWidth, targetHandleWidth);
      return undefined;
    }

    const layoutSourceElement = mainRef.current ?? windowRef.current;
    const startDockWidth = readChannelLayoutVariable(
      layoutSourceElement,
      "--channel-right-dock-layout-width",
      layoutWidthRef.current,
    );
    const startHandleWidth = readChannelLayoutVariable(
      layoutSourceElement,
      "--channel-side-panel-layout-handle-width",
      layoutHandleWidthRef.current,
    );
    const dockDelta = targetDockWidth - startDockWidth;
    const handleDelta = targetHandleWidth - startHandleWidth;

    if (Math.abs(dockDelta) < 0.5 && Math.abs(handleDelta) < 0.5) {
      layoutWidthRef.current = targetDockWidth;
      layoutHandleWidthRef.current = targetHandleWidth;
      setChannelRightDockLayoutVariables(layoutElements, targetDockWidth, targetHandleWidth);
      return undefined;
    }

    setChannelRightDockLayoutVariables(layoutElements, startDockWidth, startHandleWidth);
    const startedAt = globalThis.performance.now();
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / channelRightDockTransitionMs);
      const eased = easeChannelDockMotion(progress);
      const nextDockWidth = startDockWidth + dockDelta * eased;
      const nextHandleWidth = startHandleWidth + handleDelta * eased;
      layoutWidthRef.current = nextDockWidth;
      layoutHandleWidthRef.current = nextHandleWidth;
      setChannelRightDockLayoutVariables(layoutElements, nextDockWidth, nextHandleWidth);

      if (progress < 1) {
        layoutAnimationRef.current = globalThis.requestAnimationFrame(tick);
      } else {
        layoutAnimationRef.current = undefined;
      }
    };

    layoutAnimationRef.current = globalThis.requestAnimationFrame(tick);
    return () => {
      const frameId = layoutAnimationRef.current;
      if (frameId !== undefined) {
        globalThis.cancelAnimationFrame(frameId);
        layoutAnimationRef.current = undefined;
      }
    };
  }, [expanded, resizing, width]);

  useEffect(() => {
    const element = mainRef.current;
    if (!element) {
      return;
    }
    const updateWidth = (): void => {
      const nextWidth = Math.round(element.getBoundingClientRect().width);
      setMainWidth((current) => current === nextWidth ? current : nextWidth);
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      globalThis.addEventListener("resize", updateWidth);
      return () => {
        globalThis.removeEventListener("resize", updateWidth);
      };
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [resizeObserverKey]);

  useEffect(() => {
    if (mainWidth <= 0) {
      return;
    }
    const viewportWidth = globalThis.innerWidth || mainWidth;
    setWidth((current) => {
      const nextWidth = clampChannelRightDockWidth(current, mainWidth, viewportWidth);
      return nextWidth === current ? current : nextWidth;
    });
  }, [mainWidth]);

  useEffect(() => {
    function handleGlobalResizeMove(event: PointerEvent): void {
      const drag = resizeDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      setWidth(clampChannelRightDockWidth(drag.containerRight - event.clientX, drag.containerWidth, drag.viewportWidth));
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

  function requestPage(page: DockPageKind, workspaceFile?: WorkspaceRightDockFileTarget, workspaceReview?: WorkspaceRightDockReviewTarget): void {
    setPageRequest((current) => ({
      page,
      nonce: (current?.nonce ?? 0) + 1,
      workspaceFile,
      workspaceReview,
    }));
  }

  function consumePageRequest(nonce: number): void {
    setPageRequest((current) => current?.nonce === nonce ? undefined : current);
  }

  function close(): void {
    const pendingUnmountId = unmountTimeoutRef.current;
    if (pendingUnmountId !== undefined) {
      globalThis.clearTimeout(pendingUnmountId);
      unmountTimeoutRef.current = undefined;
    }
    setClosing(true);
    setRendered(true);
    setExpanded(false);
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    const rect = mainRef.current?.getBoundingClientRect();
    const fallbackWidth = globalThis.innerWidth || channelRightDockMinWidth + channelRightDockMinChatWidth;
    const viewportWidth = globalThis.innerWidth || rect?.right || fallbackWidth;
    resizeDragRef.current = {
      pointerId: event.pointerId,
      containerRight: rect?.right ?? fallbackWidth,
      containerWidth: rect?.width ?? fallbackWidth,
      viewportWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    setWidth(clampChannelRightDockWidth((rect?.right ?? fallbackWidth) - event.clientX, rect?.width ?? fallbackWidth, viewportWidth));
  }

  function handleResizePointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    setWidth(clampChannelRightDockWidth(drag.containerRight - event.clientX, drag.containerWidth, drag.viewportWidth));
  }

  function handleResizePointerEnd(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeDragRef.current = undefined;
    setResizing(false);
  }

  return {
    windowRef,
    mainRef,
    pageRequest,
    visible,
    expanded,
    resizing,
    width,
    motionUntilRef,
    progressPopoverCanFitMainLayout,
    progressPopoverCanUseMainLayout,
    windowStyle: {
      "--channel-right-dock-width": `${width}px`,
      "--channel-right-dock-layout-width": `${layoutWidthRef.current}px`,
      "--channel-side-panel-layout-handle-width": `${layoutHandleWidthRef.current}px`,
    } as CSSProperties,
    mainStyle: {
      "--channel-right-dock-layout-width": `${layoutWidthRef.current}px`,
      "--channel-side-panel-layout-handle-width": `${layoutHandleWidthRef.current}px`,
    } as CSSProperties,
    requestPage,
    consumePageRequest,
    close,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerEnd,
  };
}

function setChannelRightDockLayoutVariables(
  elements: readonly (HTMLElement | null)[],
  dockWidth: number,
  handleWidth: number,
): void {
  for (const element of elements) {
    if (!element) {
      continue;
    }
    element.style.setProperty("--channel-right-dock-layout-width", `${dockWidth}px`);
    element.style.setProperty("--channel-side-panel-layout-handle-width", `${handleWidth}px`);
  }
}

function readChannelLayoutVariable(element: HTMLElement | null, name: string, fallback: number): number {
  if (!element) {
    return fallback;
  }
  const value = Number.parseFloat(globalThis.getComputedStyle(element).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}
