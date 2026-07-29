import { useEffect, useRef } from "react";
import type { LingToastInput } from "../shared/ui/index.js";
import {
  createShellErrorFeedbackCoordinator,
  SHELL_ERROR_PERSISTENT_DURATION_MS,
  SHELL_ERROR_TOAST_CAPACITY,
  type ShellErrorFeedbackCommand,
  type ShellErrorFeedbackItem,
  type ShellErrorToastViewportSnapshot,
} from "./shell-error-feedback-coordinator.js";

export type { ShellErrorFeedbackItem } from "./shell-error-feedback-coordinator.js";

export function useShellErrorFeedback(input: {
  readonly items: readonly ShellErrorFeedbackItem[];
  readonly dismissToast: (idOrScope: string) => void;
  readonly showToast: (toast: LingToastInput) => string;
}): void {
  const coordinatorRef = useRef<ReturnType<typeof createShellErrorFeedbackCoordinator>>();
  const dismissToastRef = useRef(input.dismissToast);
  const itemsRef = useRef(input.items);
  const showToastRef = useRef(input.showToast);
  if (!coordinatorRef.current) coordinatorRef.current = createShellErrorFeedbackCoordinator();
  dismissToastRef.current = input.dismissToast;
  itemsRef.current = input.items;
  showToastRef.current = input.showToast;

  const executeCommands = (commands: readonly ShellErrorFeedbackCommand[]): void => {
    for (const command of commands) {
      if (command.type === "dismiss") {
        dismissToastRef.current(command.scope);
      } else {
        showToastRef.current({
          durationMs: SHELL_ERROR_PERSISTENT_DURATION_MS,
          message: command.error.message,
          scope: command.scope,
          tone: "error",
        });
      }
    }
  };

  useEffect(() => {
    executeCommands(coordinatorRef.current!.reconcile(input.items, readToastViewportSnapshot()));
  }, [input.dismissToast, input.items, input.showToast]);

  useEffect(() => {
    const markDismissed = (target: EventTarget | null): void => {
      if (!(target instanceof Element)) return;
      const toast = target.closest<HTMLElement>(".ling-ui-toast[data-scope]");
      const scope = toast?.dataset.scope;
      if (scope?.startsWith("shell-error:")) coordinatorRef.current?.markExplicitDismiss(scope);
    };
    const handleClick = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest(".ling-ui-toast-close")) {
        markDismissed(event.target);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") markDismissed(event.target);
    };
    const handleSwipeEnd = (event: Event): void => markDismissed(event.target);
    const document = globalThis.document;
    if (!document) return undefined;

    let disposed = false;
    let viewportSyncScheduled = false;
    const syncViewport = (): void => {
      if (viewportSyncScheduled) return;
      viewportSyncScheduled = true;
      globalThis.queueMicrotask(() => {
        viewportSyncScheduled = false;
        if (disposed) return;
        executeCommands(coordinatorRef.current!.observeViewport(
          itemsRef.current,
          readToastViewportSnapshot(),
        ));
      });
    };
    const toastViewport = document.querySelector(".ling-ui-toast-viewport");
    const observer = toastViewport
      ? new MutationObserver(syncViewport)
      : undefined;
    observer?.observe(toastViewport!, {
      attributeFilter: ["data-state"],
      attributes: true,
      childList: true,
      subtree: true,
    });

    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("toast.swipeEnd", handleSwipeEnd, true);
    return () => {
      disposed = true;
      observer?.disconnect();
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("toast.swipeEnd", handleSwipeEnd, true);
    };
  }, []);

  useEffect(() => () => {
    for (const scope of coordinatorRef.current?.closeAll() ?? []) dismissToastRef.current(scope);
  }, []);
}

function readToastViewportSnapshot(): ShellErrorToastViewportSnapshot {
  const openToasts = globalThis.document
    ? [...globalThis.document.querySelectorAll<HTMLElement>(".ling-ui-toast[data-state=\"open\"]")]
    : [];
  return {
    maxVisible: SHELL_ERROR_TOAST_CAPACITY,
    openScopes: new Set(openToasts.flatMap((toast) => toast.dataset.scope ? [toast.dataset.scope] : [])),
    openToastCount: openToasts.length,
  };
}
