import { useEffect, useRef, useState } from "react";
import type { LockedComputerControlDesktopState } from "../../../../desktop/shared/desktop-capabilities.js";
import {
  buildLockedComputerControlView,
  parseLockedComputerControlDesktopState,
  type LockedControlPendingCommand,
} from "./locked-computer-control-view-model.js";

export function useLockedComputerControl(computerControlReady: boolean) {
  const capability = typeof window === "undefined" ? undefined : window.lingDesktop?.computerControl;
  const bridgeAvailable = capability?.platform === "macos"
    && typeof capability.getLockedComputerControlState === "function"
    && typeof capability.authorizeLockedComputerControl === "function"
    && typeof capability.revokeLockedComputerControl === "function";
  const [state, setState] = useState<LockedComputerControlDesktopState>();
  const [readFailed, setReadFailed] = useState(false);
  const [pending, setPending] = useState<LockedControlPendingCommand>();
  const [commandError, setCommandError] = useState<string>();
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const lifetimeRef = useRef(0);
  const commandSequenceRef = useRef(0);
  const pendingRef = useRef<LockedControlPendingCommand>(undefined);

  useEffect(() => {
    const lifetime = ++lifetimeRef.current;
    let active = true;
    let readSequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(undefined);
    setReadFailed(false);
    setPending(undefined);
    setCommandError(undefined);
    pendingRef.current = undefined;
    const refresh = async (): Promise<void> => {
      if (!active || !bridgeAvailable) return;
      const sequence = ++readSequence;
      try {
        const value = parseLockedComputerControlDesktopState(await capability.getLockedComputerControlState());
        if (!active || sequence !== readSequence) return;
        if (!value) throw new Error("locked_control_state_invalid");
        setState(value);
        setReadFailed(false);
      } catch {
        if (active && sequence === readSequence) setReadFailed(true);
      }
    };
    refreshRef.current = refresh;
    const poll = async (): Promise<void> => {
      await refresh();
      if (active && bridgeAvailable) timer = setTimeout(() => void poll(), 2_000);
    };
    const onFocus = (): void => { void refresh(); };
    const onVisibility = (): void => { if (document.visibilityState === "visible") void refresh(); };
    void poll();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      if (lifetimeRef.current === lifetime) ++lifetimeRef.current;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [capability, bridgeAvailable]);

  const view = buildLockedComputerControlView({ state, computerControlReady, readFailed, pending, commandError });
  const run = async (command: LockedControlPendingCommand): Promise<void> => {
    if (!bridgeAvailable || (command === "authorize"
      ? !view.canAuthorize || pendingRef.current !== undefined
      : !view.canRevoke || pendingRef.current === "revoke")) return;
    const lifetime = lifetimeRef.current;
    const sequence = ++commandSequenceRef.current;
    pendingRef.current = command;
    setPending(command);
    setCommandError(undefined);
    const current = (): boolean => lifetimeRef.current === lifetime && commandSequenceRef.current === sequence;
    try {
      const result = command === "authorize"
        ? await capability.authorizeLockedComputerControl()
        : await capability.revokeLockedComputerControl();
      if (!current()) return;
      if (!result.accepted) setCommandError(result.reason ?? "locked_control_commit_unconfirmed");
    } catch {
      if (current()) setCommandError("locked_control_commit_unconfirmed");
    } finally {
      if (current()) {
        await refreshRef.current();
        if (current()) {
          pendingRef.current = undefined;
          setPending(undefined);
        }
      }
    }
  };
  return {
    view,
    pending,
    authorize: () => run("authorize"),
    revoke: () => run("revoke"),
  };
}
