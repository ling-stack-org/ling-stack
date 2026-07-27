import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionConfirmation } from "../types.js";

interface PendingFullAccessConfirmation {
  readonly resolve: (confirmation: PermissionConfirmation | undefined) => void;
}

export interface FullAccessConfirmationController {
  readonly open: boolean;
  readonly returnFocusTarget: HTMLElement | null;
  readonly request: () => Promise<PermissionConfirmation | undefined>;
  readonly cancel: () => void;
  readonly confirm: () => void;
}

export function useFullAccessConfirmationController(): FullAccessConfirmationController {
  const [open, setOpen] = useState(false);
  const pendingRef = useRef<PendingFullAccessConfirmation>();
  const returnFocusTargetRef = useRef<HTMLElement | null>(null);

  const settle = useCallback((approved: boolean): void => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = undefined;
    setOpen(false);
    pending.resolve(approved ? createFullAccessConfirmation() : undefined);
  }, []);

  const request = useCallback((): Promise<PermissionConfirmation | undefined> => {
    if (pendingRef.current) return Promise.resolve(undefined);
    const activeElement = document.activeElement;
    returnFocusTargetRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    return new Promise<PermissionConfirmation | undefined>((resolve) => {
      pendingRef.current = { resolve };
      setOpen(true);
    });
  }, []);

  useEffect(() => () => {
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    pending?.resolve(undefined);
  }, []);

  return {
    open,
    returnFocusTarget: returnFocusTargetRef.current,
    request,
    cancel: () => settle(false),
    confirm: () => settle(true),
  };
}

function createFullAccessConfirmation(): PermissionConfirmation {
  return {
    mode: "full_access",
    confirmed: true,
    confirmedAt: new Date().toISOString(),
    reason: "user_confirmed_full_access",
  };
}
