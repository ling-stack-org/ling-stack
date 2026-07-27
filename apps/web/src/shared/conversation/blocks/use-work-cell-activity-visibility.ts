import { useEffect, useRef, useState, type RefObject } from "react";

export type WorkCellActivityVisibility = "running" | "paused";

export function useWorkCellActivityVisibility(active: boolean): {
  readonly rootRef: RefObject<HTMLElement>;
  readonly activityVisibility: WorkCellActivityVisibility;
} {
  const rootRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setVisible(Boolean(entry?.isIntersecting && entry.intersectionRatio > 0));
    }, { threshold: [0, 0.01] });
    observer.observe(root);
    return () => observer.disconnect();
  }, [active]);

  return {
    rootRef,
    activityVisibility: active && visible ? "running" : "paused",
  };
}
