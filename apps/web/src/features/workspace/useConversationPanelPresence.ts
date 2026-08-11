import { useEffect, useRef, useState } from "react";

export const conversationPanelEnterDurationMs = 240;
export const conversationPanelExitDurationMs = 180;
export const conversationPanelUnmountBufferMs = 40;

export type ConversationPanelMotionState = "closed" | "opening" | "open" | "closing" | "resizing";

export interface ConversationPanelPresence {
  readonly rendered: boolean;
  readonly expanded: boolean;
  readonly motionState: Exclude<ConversationPanelMotionState, "resizing">;
}

export function useConversationPanelPresence(open: boolean, initialOpen = open): ConversationPanelPresence {
  const [rendered, setRendered] = useState(initialOpen);
  const [expanded, setExpanded] = useState(initialOpen);
  const openFrameRef = useRef<number | undefined>(undefined);
  const unmountTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const pendingUnmountId = unmountTimeoutRef.current;
    if (pendingUnmountId !== undefined) {
      globalThis.clearTimeout(pendingUnmountId);
      unmountTimeoutRef.current = undefined;
    }

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
      unmountTimeoutRef.current = undefined;
      setRendered(false);
    }, conversationPanelExitDurationMs + conversationPanelUnmountBufferMs);
    unmountTimeoutRef.current = timeoutId;
    return () => {
      globalThis.clearTimeout(timeoutId);
      if (unmountTimeoutRef.current === timeoutId) {
        unmountTimeoutRef.current = undefined;
      }
    };
  }, [open, rendered]);

  return {
    rendered,
    expanded,
    motionState: !rendered && !open
      ? "closed"
      : open
        ? expanded ? "open" : "opening"
        : "closing",
  };
}
