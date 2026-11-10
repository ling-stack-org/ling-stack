import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import type { DockPageKind } from "../../shared/conversation/index.js";
import type { WorkspaceRightDockFileTarget, WorkspaceRightDockPageRequest, WorkspaceRightDockReviewTarget } from "./right-dock/index.js";
import {
  channelRightDockMinChatWidth,
  channelRightDockMinWidth,
  channelRightDockResizeHandleWidth,
  clampChannelRightDockWidth,
  easeChannelDockMotion,
  resolveChannelWorkspaceLayoutTargets,
} from "./layout/channel-workspace-layout.js";
import {
  conversationPanelEnterDurationMs,
  conversationPanelExitDurationMs,
  conversationPanelUnmountBufferMs,
  type ConversationPanelMotionState,
  useConversationPanelPresence,
} from "./useConversationPanelPresence.js";

interface ConversationRightDockLayoutVariables {
  readonly width: string;
  readonly layoutWidth: string;
  readonly handleWidth: string;
  readonly layoutHandleWidth: string;
}

export interface ConversationRightDockControllerInput {
  readonly initialOpen: boolean;
  readonly intentOpen: boolean;
  readonly resizeObserverKey: string;
  readonly defaultWidth?: number;
  readonly separateLayoutRoots?: boolean;
  readonly variables?: ConversationRightDockLayoutVariables;
}

export interface ConversationRightDockController {
  readonly rootRef: MutableRefObject<HTMLElement | null>;
  readonly containerRef: MutableRefObject<HTMLElement | null>;
  readonly pageRequest: WorkspaceRightDockPageRequest | undefined;
  readonly requestedOpen: boolean;
  readonly available: boolean;
  readonly renderedOpen: boolean;
  readonly visible: boolean;
  readonly expanded: boolean;
  readonly resizable: boolean;
  readonly resizing: boolean;
  readonly width: number;
  readonly containerWidth: number;
  readonly motionState: ConversationPanelMotionState;
  readonly motionUntilRef: MutableRefObject<number>;
  readonly layoutStyle: CSSProperties;
  readonly containerStyle: CSSProperties;
  readonly requestPage: (page: DockPageKind, workspaceFile?: WorkspaceRightDockFileTarget, workspaceReview?: WorkspaceRightDockReviewTarget) => void;
  readonly consumePageRequest: (nonce: number) => void;
  readonly close: () => void;
  readonly handleResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleResizePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleResizePointerEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

const workspaceVariables: ConversationRightDockLayoutVariables = {
  width: "--workspace-right-dock-width",
  layoutWidth: "--workspace-right-dock-layout-width",
  handleWidth: "--workspace-right-dock-handle-width",
  layoutHandleWidth: "--workspace-right-dock-layout-handle-width",
};

export const channelConversationRightDockVariables: ConversationRightDockLayoutVariables = {
  width: "--channel-right-dock-width",
  layoutWidth: "--channel-right-dock-layout-width",
  handleWidth: "--channel-side-panel-handle-width",
  layoutHandleWidth: "--channel-side-panel-layout-handle-width",
};

export const conversationRightDockMaxHiddenViewportWidth = 900;

export function useConversationRightDockController({
  initialOpen,
  intentOpen,
  resizeObserverKey,
  defaultWidth = 360,
  separateLayoutRoots = false,
  variables = workspaceVariables,
}: ConversationRightDockControllerInput): ConversationRightDockController {
  const sharedRootRef = useRef<HTMLElement | null>(null);
  const separateContainerRef = useRef<HTMLElement | null>(null);
  const rootRef = sharedRootRef;
  const containerRef = separateLayoutRoots ? separateContainerRef : sharedRootRef;
  const [pageRequest, setPageRequest] = useState<WorkspaceRightDockPageRequest>();
  const [width, setWidth] = useState(defaultWidth);
  const [containerWidth, setContainerWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(readViewportWidth);
  const [resizing, setResizing] = useState(false);
  const available = viewportWidth > conversationRightDockMaxHiddenViewportWidth;
  const projectedOpen = intentOpen && available;
  const presence = useConversationPanelPresence(projectedOpen, initialOpen && available);
  const measuredContainerRef = useRef<HTMLElement | null>(null);
  const measuredContainerKeyRef = useRef<string | undefined>(undefined);
  const containerResizeObserverRef = useRef<ResizeObserver | undefined>(undefined);
  const containerWindowResizeListenerRef = useRef<(() => void) | undefined>(undefined);
  const layoutAnimationRef = useRef<number | undefined>(undefined);
  const layoutWidthRef = useRef(initialOpen && available ? defaultWidth : 0);
  const layoutHandleWidthRef = useRef(initialOpen && available ? channelRightDockResizeHandleWidth : 0);
  const motionUntilRef = useRef(0);
  const resizeDragRef = useRef<{
    readonly pointerId: number;
    readonly containerRight: number;
    readonly containerWidth: number;
    readonly viewportWidth: number;
  } | undefined>(undefined);
  const expanded = available && presence.expanded;
  const visible = available && (projectedOpen || presence.rendered);
  const resizable = visible && expanded;
  const motionState: ConversationPanelMotionState = available
    ? resizing ? "resizing" : presence.motionState
    : "closed";

  useEffect(() => {
    if (initialOpen) setWidth(defaultWidth);
  }, [defaultWidth, initialOpen, resizeObserverKey]);

  useEffect(() => {
    const duration = projectedOpen ? conversationPanelEnterDurationMs : conversationPanelExitDurationMs;
    motionUntilRef.current = Date.now() + duration + conversationPanelUnmountBufferMs;
  }, [projectedOpen]);

  useLayoutEffect(() => {
    const { dockWidth: targetDockWidth, handleWidth: targetHandleWidth } = resolveChannelWorkspaceLayoutTargets({
      rightDockExpanded: expanded,
      rightDockWidth: width,
    });
    const elements = uniqueElements(rootRef.current, containerRef.current);
    const runningFrameId = layoutAnimationRef.current;
    if (runningFrameId !== undefined) {
      globalThis.cancelAnimationFrame(runningFrameId);
      layoutAnimationRef.current = undefined;
    }

    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!available || resizing || reducedMotion) {
      layoutWidthRef.current = targetDockWidth;
      layoutHandleWidthRef.current = targetHandleWidth;
      setLayoutVariables(elements, variables, targetDockWidth, targetHandleWidth);
      return undefined;
    }

    const sourceElement = containerRef.current ?? rootRef.current;
    const startDockWidth = readLayoutVariable(sourceElement, variables.layoutWidth, layoutWidthRef.current);
    const startHandleWidth = readLayoutVariable(sourceElement, variables.layoutHandleWidth, layoutHandleWidthRef.current);
    const dockDelta = targetDockWidth - startDockWidth;
    const handleDelta = targetHandleWidth - startHandleWidth;
    if (Math.abs(dockDelta) < 0.5 && Math.abs(handleDelta) < 0.5) {
      layoutWidthRef.current = targetDockWidth;
      layoutHandleWidthRef.current = targetHandleWidth;
      setLayoutVariables(elements, variables, targetDockWidth, targetHandleWidth);
      return undefined;
    }

    setLayoutVariables(elements, variables, startDockWidth, startHandleWidth);
    const duration = expanded ? conversationPanelEnterDurationMs : conversationPanelExitDurationMs;
    const startedAt = globalThis.performance.now();
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = easeChannelDockMotion(progress);
      const nextDockWidth = startDockWidth + dockDelta * eased;
      const nextHandleWidth = startHandleWidth + handleDelta * eased;
      layoutWidthRef.current = nextDockWidth;
      layoutHandleWidthRef.current = nextHandleWidth;
      setLayoutVariables(elements, variables, nextDockWidth, nextHandleWidth);
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
  }, [available, containerRef, expanded, resizing, rootRef, variables, width]);

  useEffect(() => {
    const updateViewportWidth = (): void => {
      const nextWidth = readViewportWidth();
      setViewportWidth((current) => current === nextWidth ? current : nextWidth);
    };
    globalThis.addEventListener("resize", updateViewportWidth);
    return () => globalThis.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    if (available) return;
    resizeDragRef.current = undefined;
    setResizing(false);
  }, [available]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (measuredContainerRef.current === element && measuredContainerKeyRef.current === resizeObserverKey) return;
    containerResizeObserverRef.current?.disconnect();
    containerResizeObserverRef.current = undefined;
    if (containerWindowResizeListenerRef.current) {
      globalThis.removeEventListener("resize", containerWindowResizeListenerRef.current);
      containerWindowResizeListenerRef.current = undefined;
    }
    measuredContainerRef.current = element;
    measuredContainerKeyRef.current = resizeObserverKey;
    if (!element) return;
    const updateWidth = (): void => {
      const nextWidth = Math.round(element.getBoundingClientRect().width);
      setContainerWidth((current) => current === nextWidth ? current : nextWidth);
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      globalThis.addEventListener("resize", updateWidth);
      containerWindowResizeListenerRef.current = updateWidth;
      return;
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    containerResizeObserverRef.current = observer;
  });

  useEffect(() => () => {
    containerResizeObserverRef.current?.disconnect();
    if (containerWindowResizeListenerRef.current) {
      globalThis.removeEventListener("resize", containerWindowResizeListenerRef.current);
    }
    measuredContainerRef.current = null;
    measuredContainerKeyRef.current = undefined;
    containerResizeObserverRef.current = undefined;
    containerWindowResizeListenerRef.current = undefined;
  }, []);

  useEffect(() => {
    if (containerWidth <= 0) return;
    const viewportWidth = globalThis.innerWidth || containerWidth;
    setWidth((current) => {
      const nextWidth = clampChannelRightDockWidth(current, containerWidth, viewportWidth);
      return nextWidth === current ? current : nextWidth;
    });
  }, [containerWidth]);

  useEffect(() => {
    const handleGlobalResizeMove = (event: PointerEvent): void => {
      const drag = resizeDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      setWidth(clampChannelRightDockWidth(drag.containerRight - event.clientX, drag.containerWidth, drag.viewportWidth));
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
  }, []);

  function requestPage(page: DockPageKind, workspaceFile?: WorkspaceRightDockFileTarget, workspaceReview?: WorkspaceRightDockReviewTarget): void {
    setPageRequest((current) => ({ page, nonce: (current?.nonce ?? 0) + 1, workspaceFile, workspaceReview }));
  }

  function consumePageRequest(nonce: number): void {
    setPageRequest((current) => current?.nonce === nonce ? undefined : current);
  }

  function close(): void {
    setPageRequest(undefined);
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (!resizable) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    const fallbackWidth = globalThis.innerWidth || channelRightDockMinWidth + channelRightDockMinChatWidth;
    const viewportWidth = globalThis.innerWidth || rect?.right || fallbackWidth;
    const containerRight = rect?.right ?? viewportWidth;
    const measuredContainerWidth = rect?.width ?? fallbackWidth;
    resizeDragRef.current = {
      pointerId: event.pointerId,
      containerRight,
      containerWidth: measuredContainerWidth,
      viewportWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    setWidth(clampChannelRightDockWidth(containerRight - event.clientX, measuredContainerWidth, viewportWidth));
  }

  function handleResizePointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setWidth(clampChannelRightDockWidth(drag.containerRight - event.clientX, drag.containerWidth, drag.viewportWidth));
  }

  function handleResizePointerEnd(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resizeDragRef.current = undefined;
    setResizing(false);
  }

  const layoutStyle = {
    [variables.width]: `${width}px`,
    [variables.layoutWidth]: `${layoutWidthRef.current}px`,
    [variables.handleWidth]: `${channelRightDockResizeHandleWidth}px`,
    [variables.layoutHandleWidth]: `${layoutHandleWidthRef.current}px`,
  } as CSSProperties;

  return {
    rootRef,
    containerRef,
    pageRequest,
    requestedOpen: intentOpen,
    available,
    renderedOpen: visible,
    visible,
    expanded,
    resizable,
    resizing,
    width,
    containerWidth,
    motionState,
    motionUntilRef,
    layoutStyle,
    containerStyle: layoutStyle,
    requestPage,
    consumePageRequest,
    close,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerEnd,
  };
}

function uniqueElements(...elements: Array<HTMLElement | null>): HTMLElement[] {
  return [...new Set(elements.filter((element): element is HTMLElement => Boolean(element)))];
}

function setLayoutVariables(
  elements: readonly HTMLElement[],
  variables: ConversationRightDockLayoutVariables,
  dockWidth: number,
  handleWidth: number,
): void {
  for (const element of elements) {
    element.style.setProperty(variables.layoutWidth, `${dockWidth}px`);
    element.style.setProperty(variables.layoutHandleWidth, `${handleWidth}px`);
  }
}

function readLayoutVariable(element: HTMLElement | null, name: string, fallback: number): number {
  if (!element) return fallback;
  const value = Number.parseFloat(globalThis.getComputedStyle(element).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function readViewportWidth(): number {
  return typeof globalThis.innerWidth === "number" && globalThis.innerWidth > 0
    ? globalThis.innerWidth
    : Number.POSITIVE_INFINITY;
}
