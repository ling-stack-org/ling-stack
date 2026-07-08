import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";
import { channelRightDockTransitionMs } from "./layout/channel-workspace-layout.js";

export interface ConversationSummaryPanelController {
  readonly rendered: boolean;
  readonly expanded: boolean;
  readonly motionClass: "is-popover-expanded" | "is-popover-collapsed";
}

export function useConversationSummaryPanelController(open: boolean): ConversationSummaryPanelController {
  const [rendered, setRendered] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const openFrameRef = useRef<number | undefined>();

  useEffect(() => {
    if (open) {
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
      setRendered(false);
    }, channelRightDockTransitionMs);
    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [open, rendered]);

  return {
    rendered,
    expanded,
    motionClass: expanded ? "is-popover-expanded" : "is-popover-collapsed",
  };
}

export function useConversationSummaryPlacementMotion(active: boolean, placementKey: string): RefCallback<HTMLElement> {
  const activeRef = useRef(active);
  const previousRectRef = useRef<DOMRectReadOnly>();
  const previousPlacementRef = useRef(placementKey);
  const nodeRef = useRef<HTMLElement | null>(null);
  const animationFrameRef = useRef<number | undefined>();
  const cleanupTimeoutRef = useRef<number | undefined>();

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    return () => {
      const frameId = animationFrameRef.current;
      if (frameId !== undefined) {
        globalThis.cancelAnimationFrame(frameId);
      }
      const timeoutId = cleanupTimeoutRef.current;
      if (timeoutId !== undefined) {
        globalThis.clearTimeout(timeoutId);
      }
    };
  }, []);

  return useCallback((node: HTMLElement | null) => {
    const previousNode = nodeRef.current;
    if (previousNode && previousNode !== node && activeRef.current) {
      previousRectRef.current = previousNode.getBoundingClientRect();
      previousPlacementRef.current = placementKey;
    }

    nodeRef.current = node;
    if (!node || !activeRef.current) {
      return;
    }

    const previousRect = previousRectRef.current;
    if (!previousRect || previousPlacementRef.current === placementKey) {
      previousPlacementRef.current = placementKey;
      return;
    }

    const nextRect = node.getBoundingClientRect();
    const previousPlacement = previousPlacementRef.current;
    const deltaX = previousRect.left - nextRect.left;
    const deltaY = previousRect.top - nextRect.top;
    previousRectRef.current = undefined;
    previousPlacementRef.current = placementKey;

    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
      return;
    }

    node.dataset.summaryPlacementMotion = `${previousPlacement}->${placementKey}`;
    const frameId = animationFrameRef.current;
    if (frameId !== undefined) {
      globalThis.cancelAnimationFrame(frameId);
    }
    const timeoutId = cleanupTimeoutRef.current;
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }

    node.style.transition = "none";
    node.style.transform = `translate3d(${Math.round(deltaX)}px, ${Math.round(deltaY)}px, 0) scale(1)`;
    node.style.opacity = "1";
    node.style.visibility = "visible";
    node.getBoundingClientRect();

    animationFrameRef.current = globalThis.requestAnimationFrame(() => {
      animationFrameRef.current = undefined;
      node.style.transition = [
        "opacity var(--channel-right-dock-motion-duration) var(--channel-right-dock-motion-ease)",
        "transform var(--channel-right-dock-motion-duration) var(--channel-right-dock-motion-ease)",
        "visibility 0s linear 0s",
      ].join(", ");
      node.style.transform = "";
      cleanupTimeoutRef.current = globalThis.setTimeout(() => {
        cleanupTimeoutRef.current = undefined;
        node.style.removeProperty("transition");
        node.style.removeProperty("transform");
        node.style.removeProperty("opacity");
        node.style.removeProperty("visibility");
      }, channelRightDockTransitionMs);
    });
  }, [placementKey]);
}
