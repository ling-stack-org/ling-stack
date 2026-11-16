import { useLayoutEffect, type RefObject } from "react";
import type { DesktopBrowserCapabilities, DesktopBrowserWorkspace, DesktopBrowserWorkspaceState } from "../../../../desktop/shared/browser-capabilities.js";

/** Native pages are detached whenever shared UI overlays or hidden dock ancestors own the surface. */
export function useBrowserViewport(capability: DesktopBrowserCapabilities | undefined, hostRef: RefObject<HTMLDivElement | null>, workspace: DesktopBrowserWorkspace, state: DesktopBrowserWorkspaceState | undefined): void {
  const tabId = state?.activeTabId, generation = state?.generation;
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!capability || !host || generation === undefined) return;
    let disposed = false;
    const hidden = (): void => capability.reportViewport({ ...workspace, generation, tabId, visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } });
    const report = (): void => {
      if (disposed) return;
      const bounds = host.getBoundingClientRect();
      const overlays = document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="menu"],[role="tooltip"],[data-radix-popper-content-wrapper]');
      const overlayVisible = [...overlays].some(element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
      const clipped = { x: Math.max(0, bounds.x), y: Math.max(0, bounds.y), width: Math.max(0, Math.min(innerWidth, bounds.right) - Math.max(0, bounds.x)),
        height: Math.max(0, Math.min(innerHeight, bounds.bottom) - Math.max(0, bounds.y)) };
      const visible = Boolean(tabId) && !document.hidden && !overlayVisible && !host.closest('[aria-hidden="true"],[inert]')
        && bounds.width > 0 && bounds.height > 0 && clipped.width === bounds.width && clipped.height === bounds.height;
      capability.reportViewport({ ...workspace, generation, tabId, visible, bounds: clipped });
    };
    const observer = new MutationObserver(report);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden", "aria-modal", "inert", "data-state", "class", "style"] });
    const resize = new ResizeObserver(report); resize.observe(host);
    window.addEventListener("resize", report); window.addEventListener("scroll", report, true);
    document.addEventListener("visibilitychange", report);
    const heartbeat = window.setInterval(report, 500);
    report();
    return () => { disposed = true; hidden(); observer.disconnect(); resize.disconnect(); clearInterval(heartbeat);
      window.removeEventListener("resize", report); window.removeEventListener("scroll", report, true); document.removeEventListener("visibilitychange", report); };
  }, [capability, hostRef, workspace, tabId, generation]);
}
