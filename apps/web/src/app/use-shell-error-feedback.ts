import { useEffect, useRef } from "react";
import type { LingToastInput } from "../shared/ui/index.js";
import {
  createShellErrorFeedbackCoordinator,
  SHELL_ERROR_PERSISTENT_DURATION_MS,
  type ShellErrorFeedbackItem,
} from "./shell-error-feedback-coordinator.js";

export type { ShellErrorFeedbackItem } from "./shell-error-feedback-coordinator.js";

export function useShellErrorFeedback(input: {
  readonly items: readonly ShellErrorFeedbackItem[];
  readonly dismissToast: (idOrScope: string) => void;
  readonly showToast: (toast: LingToastInput) => string;
}): void {
  const coordinatorRef = useRef<ReturnType<typeof createShellErrorFeedbackCoordinator>>();
  const dismissToastRef = useRef(input.dismissToast);
  if (!coordinatorRef.current) coordinatorRef.current = createShellErrorFeedbackCoordinator();
  dismissToastRef.current = input.dismissToast;

  useEffect(() => {
    for (const command of coordinatorRef.current!.reconcile(input.items)) {
      if (command.type === "dismiss") {
        input.dismissToast(command.scope);
      } else {
        input.showToast({
          durationMs: SHELL_ERROR_PERSISTENT_DURATION_MS,
          message: command.error.message,
          scope: command.scope,
          tone: "error",
        });
      }
    }
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
    globalThis.document?.addEventListener("click", handleClick, true);
    globalThis.document?.addEventListener("keydown", handleKeyDown, true);
    return () => {
      globalThis.document?.removeEventListener("click", handleClick, true);
      globalThis.document?.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  useEffect(() => () => {
    for (const scope of coordinatorRef.current?.closeAll() ?? []) dismissToastRef.current(scope);
  }, []);
}
