import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionConfirmation } from "../types.js";
import {
  fullAccessConfirmationScopeStorageId,
  type FullAccessConfirmationScope,
} from "./full-access-confirmation-scopes.js";
import {
  browserFullAccessConfirmationStorage,
  loadFullAccessConfirmations,
  persistFullAccessConfirmations,
  rememberFullAccessConfirmation,
  type FullAccessConfirmationStorage,
} from "./full-access-confirmation-storage.js";

interface PendingFullAccessConfirmation {
  readonly scopeKey: string;
  readonly resolve: (confirmation: PermissionConfirmation | undefined) => void;
}

export interface FullAccessConfirmationController {
  readonly open: boolean;
  readonly returnFocusTarget: HTMLElement | null;
  readonly request: (scope: FullAccessConfirmationScope) => Promise<PermissionConfirmation | undefined>;
  readonly confirmExplicitSelection: (scope: FullAccessConfirmationScope) => PermissionConfirmation;
  readonly bind: (source: FullAccessConfirmationScope, target: FullAccessConfirmationScope) => void;
  readonly isConfirmed: (scope: FullAccessConfirmationScope) => boolean;
  readonly cancel: () => void;
  readonly confirm: () => void;
}

export function useFullAccessConfirmationController(): FullAccessConfirmationController {
  const [open, setOpen] = useState(false);
  const [, setConfirmationRevision] = useState(0);
  const confirmedByScopeRef = useRef<Map<string, PermissionConfirmation> | undefined>(undefined);
  const storageRef = useRef<FullAccessConfirmationStorage | undefined>(undefined);
  const pendingRef = useRef<PendingFullAccessConfirmation | undefined>(undefined);
  const returnFocusTargetRef = useRef<HTMLElement | null>(null);
  if (!confirmedByScopeRef.current) {
    storageRef.current = browserFullAccessConfirmationStorage();
    confirmedByScopeRef.current = loadFullAccessConfirmations(storageRef.current);
  }

  const settle = useCallback((approved: boolean): void => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = undefined;
    setOpen(false);
    if (!approved) {
      pending.resolve(undefined);
      return;
    }
    const confirmation = createFullAccessConfirmation();
    rememberFullAccessConfirmation(confirmedByScopeRef.current!, pending.scopeKey, confirmation);
    persistFullAccessConfirmations(storageRef.current, confirmedByScopeRef.current!);
    setConfirmationRevision((current) => current + 1);
    pending.resolve(confirmation);
  }, []);

  const request = useCallback((scope: FullAccessConfirmationScope): Promise<PermissionConfirmation | undefined> => {
    const scopeKey = fullAccessConfirmationScopeStorageId(scope);
    const confirmed = confirmedByScopeRef.current!.get(scopeKey);
    if (confirmed) return Promise.resolve(confirmed);
    if (pendingRef.current) return Promise.resolve(undefined);
    const activeElement = document.activeElement;
    // A compact menu item unmounts as the confirmation opens. Restore focus to
    // its persistent trigger instead of remembering the disappearing item.
    const menuTriggerId = activeElement?.closest('[role="menu"]')?.getAttribute("aria-labelledby");
    const menuTrigger = menuTriggerId ? document.getElementById(menuTriggerId) : null;
    returnFocusTargetRef.current = menuTrigger instanceof HTMLElement ? menuTrigger
      : activeElement instanceof HTMLElement ? activeElement : null;
    return new Promise<PermissionConfirmation | undefined>((resolve) => {
      pendingRef.current = { resolve, scopeKey };
      setOpen(true);
    });
  }, []);

  const confirmExplicitSelection = useCallback((scope: FullAccessConfirmationScope): PermissionConfirmation => {
    const scopeKey = fullAccessConfirmationScopeStorageId(scope);
    const existing = confirmedByScopeRef.current!.get(scopeKey);
    if (existing) return existing;
    const confirmation = createFullAccessConfirmation();
    rememberFullAccessConfirmation(confirmedByScopeRef.current!, scopeKey, confirmation);
    persistFullAccessConfirmations(storageRef.current, confirmedByScopeRef.current!);
    setConfirmationRevision((current) => current + 1);
    return confirmation;
  }, []);

  const bind = useCallback((source: FullAccessConfirmationScope, target: FullAccessConfirmationScope): void => {
    const confirmation = confirmedByScopeRef.current!.get(fullAccessConfirmationScopeStorageId(source));
    const targetKey = fullAccessConfirmationScopeStorageId(target);
    if (!confirmation || confirmedByScopeRef.current!.has(targetKey)) return;
    rememberFullAccessConfirmation(confirmedByScopeRef.current!, targetKey, confirmation);
    persistFullAccessConfirmations(storageRef.current, confirmedByScopeRef.current!);
    setConfirmationRevision((current) => current + 1);
  }, []);

  const isConfirmed = useCallback((scope: FullAccessConfirmationScope): boolean => (
    confirmedByScopeRef.current!.has(fullAccessConfirmationScopeStorageId(scope))
  ), []);

  useEffect(() => () => {
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    pending?.resolve(undefined);
  }, []);

  return {
    open,
    returnFocusTarget: returnFocusTargetRef.current,
    request,
    confirmExplicitSelection,
    bind,
    isConfirmed,
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
