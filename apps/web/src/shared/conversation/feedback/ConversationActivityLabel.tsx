import { useEffect, useRef, useState, type ReactNode } from "react";
import "./conversation-activity-label.css";

/** Motion belongs to live status text, never to a tool's identifying icon. */
export function ConversationActivityLabel({ children, active = true }: {
  readonly children: ReactNode;
  readonly active?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) return;
    const element = ref.current;
    if (!element) return;
    let intersecting = typeof IntersectionObserver === "undefined";
    const update = (): void => setVisible(intersecting && !document.hidden);
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(([entry]) => {
      intersecting = Boolean(entry?.isIntersecting);
      update();
    });
    update();
    observer?.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [active]);

  return <span ref={ref} className="conversation-activity-label"
    data-activity-motion={active ? visible ? "running" : "paused" : "idle"}>{children}</span>;
}
