import { useEffect, type RefObject } from "react";

type DesktopComputerUseCapabilities = NonNullable<Window["lingDesktop"]>["computerUse"];

type ComputerUseObstacleKind =
  | "composer"
  | "approval"
  | "dock"
  | "terminal"
  | "modal"
  | "popover"
  | "unknown"
  | "other";

interface ComputerUseObstacleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly kind: ComputerUseObstacleKind;
}

export function useDesktopComputerUseHostLayoutReporter(
  capabilities: DesktopComputerUseCapabilities | undefined,
  hostRef: RefObject<HTMLElement>,
): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!capabilities || !host) {
      return;
    }
    let frameId: number | undefined;
    let disposed = false;
    const autoMarkedDialogs = new Set<HTMLElement>();
    const screenRect = (element: Element): ComputerUseObstacleRect | undefined => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        return undefined;
      }
      return {
        x: window.screenX + bounds.left,
        y: window.screenY + bounds.top,
        width: bounds.width,
        height: bounds.height,
        kind: readComputerUseObstacleKind(element.getAttribute("data-computer-use-obstacle-kind")),
      };
    };
    const report = (): void => {
      frameId = undefined;
      if (disposed) {
        return;
      }
      const bounds = host.getBoundingClientRect();
      const obstacles = Array.from(host.querySelectorAll<HTMLElement>("[data-computer-use-obstacle]"))
        .map(screenRect)
        .filter((rect): rect is ComputerUseObstacleRect => Boolean(rect));
      capabilities.reportHostLayout({
        windowBounds: {
          x: window.screenX + bounds.x,
          y: window.screenY + bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        obstacles,
        reportedAt: new Date().toISOString(),
      });
    };
    const scheduleReport = (): void => {
      if (frameId === undefined) {
        frameId = window.requestAnimationFrame(report);
      }
    };
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleReport) : undefined;
    const releaseAutoMarkedDialog = (element: HTMLElement): void => {
      if (
        element.dataset.computerUseObstacle === "true"
        && element.dataset.computerUseObstacleKind === "modal"
      ) {
        delete element.dataset.computerUseObstacle;
        delete element.dataset.computerUseObstacleKind;
      }
      autoMarkedDialogs.delete(element);
    };
    const syncObservedElements = (): void => {
      resizeObserver?.disconnect();
      resizeObserver?.observe(host);
      autoMarkedDialogs.forEach((element) => {
        if (!element.isConnected || !host.contains(element) || !element.matches('[role="dialog"][aria-modal="true"]')) {
          releaseAutoMarkedDialog(element);
          return;
        }
        if (
          element.dataset.computerUseObstacle !== "true"
          || element.dataset.computerUseObstacleKind !== "modal"
        ) {
          autoMarkedDialogs.delete(element);
        }
      });
      host.querySelectorAll<HTMLElement>("[data-computer-use-obstacle]")
        .forEach((element) => resizeObserver?.observe(element));
      host.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]').forEach((element) => {
        if (!element.hasAttribute("data-computer-use-obstacle")) {
          element.dataset.computerUseObstacle = "true";
          element.dataset.computerUseObstacleKind = "modal";
          autoMarkedDialogs.add(element);
        }
        resizeObserver?.observe(element);
      });
    };
    const mutationObserver = typeof MutationObserver === "function" ? new MutationObserver(() => {
      syncObservedElements();
      scheduleReport();
    }) : undefined;
    syncObservedElements();
    mutationObserver?.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-computer-use-obstacle",
        "data-computer-use-obstacle-kind",
        "role",
        "aria-modal",
        "class",
        "style",
      ],
    });
    window.addEventListener("resize", scheduleReport);
    window.addEventListener("scroll", scheduleReport, { capture: true, passive: true });
    window.visualViewport?.addEventListener("resize", scheduleReport);
    window.visualViewport?.addEventListener("scroll", scheduleReport);
    scheduleReport();
    return () => {
      disposed = true;
      if (frameId !== undefined) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      autoMarkedDialogs.forEach(releaseAutoMarkedDialog);
      window.removeEventListener("resize", scheduleReport);
      window.removeEventListener("scroll", scheduleReport, { capture: true });
      window.visualViewport?.removeEventListener("resize", scheduleReport);
      window.visualViewport?.removeEventListener("scroll", scheduleReport);
    };
  }, [capabilities, hostRef]);
}

function readComputerUseObstacleKind(value: string | null): ComputerUseObstacleKind {
  switch (value?.trim()) {
    case "composer":
    case "approval":
    case "dock":
    case "terminal":
    case "modal":
    case "popover":
    case "unknown":
    case "other":
      return value.trim() as ComputerUseObstacleKind;
    case "right-dock":
      return "dock";
    case "summary":
      return "popover";
    default:
      return "unknown";
  }
}
