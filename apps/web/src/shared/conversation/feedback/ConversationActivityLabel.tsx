import { useEffect, useRef, useState, type ReactNode } from "react";
import "./conversation-activity-label.css";
import { useDaemonObservation } from "../observation/daemon-observation.js";

/** Motion belongs to live status text, never to a tool's identifying icon. */
export function ConversationActivityLabel({ children, active = true }: {
  readonly children: ReactNode;
  readonly active?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const observing = !useDaemonObservation().paused;
  const live = active && observing;

  useEffect(() => {
    if (!live) return;
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
  }, [live]);

  return <span ref={ref} className="conversation-activity-label"
    data-activity-motion={live ? visible ? "running" : "paused" : "idle"}>{children}</span>;
}
