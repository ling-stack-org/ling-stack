import { useEffect, useRef } from "react";
import type { LingToastInput } from "../shared/ui/index.js";
import type { FocusedDomainError } from "./use-focused-domain-error-owner.js";

export interface ShellErrorFeedbackItem {
  readonly key: string;
  readonly error: FocusedDomainError | undefined;
  readonly surface: string;
  readonly visible: boolean;
}

export function useShellErrorFeedback(input: {
  readonly items: readonly ShellErrorFeedbackItem[];
  readonly dismissToast: (idOrScope: string) => void;
  readonly showToast: (toast: LingToastInput) => string;
}): void {
  const seenRequestsRef = useRef(new Set<string>());
  const originSurfaceByRequestRef = useRef(new Map<string, string>());
  const visibleScopesRef = useRef(new Map<string, string>());

  useEffect(() => {
    for (const item of input.items) {
      const error = item.error;
      const previousScope = visibleScopesRef.current.get(item.key);
      if (!error) {
        if (previousScope) input.dismissToast(previousScope);
        visibleScopesRef.current.delete(item.key);
        continue;
      }
      const errorKey = `${error.domain}:${error.identity}:${error.objectId}:${error.action}:${error.requestId}`;
      const alreadySeen = seenRequestsRef.current.has(errorKey);
      if (!alreadySeen) {
        seenRequestsRef.current.add(errorKey);
        originSurfaceByRequestRef.current.set(errorKey, item.surface);
      }
      const originSurface = originSurfaceByRequestRef.current.get(errorKey);
      if (!item.visible || originSurface !== item.surface) {
        if (previousScope) input.dismissToast(previousScope);
        visibleScopesRef.current.delete(item.key);
        continue;
      }
      if (alreadySeen) continue;
      if (seenRequestsRef.current.size > 128) {
        const oldest = seenRequestsRef.current.values().next().value;
        if (oldest) {
          seenRequestsRef.current.delete(oldest);
          originSurfaceByRequestRef.current.delete(oldest);
        }
      }
      const scope = `shell-error:${error.domain}:${error.objectId}:${error.action}`;
      if (previousScope && previousScope !== scope) input.dismissToast(previousScope);
      input.showToast({
        message: error.message,
        scope,
        tone: "error",
      });
      visibleScopesRef.current.set(item.key, scope);
    }
  }, [input.dismissToast, input.items, input.showToast]);
}
