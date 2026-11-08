import { useEffect, useState, type RefObject } from "react";

export function useWorkflowGraphMotion(root: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!active || !element) { setVisible(false); return; }
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let intersecting = typeof IntersectionObserver === "undefined";
    const update = (): void => setVisible(intersecting && !document.hidden && !preference.matches);
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(([entry]) => {
      intersecting = Boolean(entry?.isIntersecting);
      update();
    });
    observer?.observe(element);
    document.addEventListener("visibilitychange", update);
    preference.addEventListener("change", update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
      preference.removeEventListener("change", update);
    };
  }, [root, active]);
  return active && visible;
}
