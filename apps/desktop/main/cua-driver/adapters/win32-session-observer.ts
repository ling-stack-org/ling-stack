import type {
  CuaDriverWindowsSessionRecoveryHint,
  CuaDriverWindowsSessionRecoveryObserver,
} from "../readiness-controller.js";

export type Win32PowerMonitorRecoveryEvent = "unlock-screen";

export interface Win32PowerMonitorPort {
  on(event: Win32PowerMonitorRecoveryEvent, listener: () => void): unknown;
  off(event: Win32PowerMonitorRecoveryEvent, listener: () => void): unknown;
}

export class Win32CuaDriverSessionObserverError extends Error {
  readonly code = "cua_driver_win32_session_observer_failed" as const;

  constructor(readonly observerCode: "listener_invalid" | "power_monitor_invalid" | "subscribe_failed") {
    super(`win32_session_observer_${observerCode}`);
    this.name = "Win32CuaDriverSessionObserverError";
  }
}

/**
 * Electron events are recovery hints only. The fresh Rust child remains the
 * authority for WTS session, input-desktop and readiness state.
 */
export function createWin32CuaDriverSessionRecoveryObserver(
  powerMonitor: Win32PowerMonitorPort,
): CuaDriverWindowsSessionRecoveryObserver {
  if (!powerMonitor
    || typeof powerMonitor.on !== "function"
    || typeof powerMonitor.off !== "function") {
    throw new Win32CuaDriverSessionObserverError("power_monitor_invalid");
  }
  return Object.freeze({
    subscribe(listener: (hint: CuaDriverWindowsSessionRecoveryHint) => void): () => void {
      if (typeof listener !== "function") {
        throw new Win32CuaDriverSessionObserverError("listener_invalid");
      }
      let active = true;
      const emit = (hint: CuaDriverWindowsSessionRecoveryHint): void => {
        if (!active) {
          return;
        }
        try {
          listener(hint);
        } catch {
          // A recovery hint must not escape through Electron's event emitter.
        }
      };
      const onUnlock = (): void => emit({ kind: "unlock" });
      const installed: Array<readonly [Win32PowerMonitorRecoveryEvent, () => void]> = [];
      const install = (event: Win32PowerMonitorRecoveryEvent, eventListener: () => void): void => {
        // Record before calling the foreign port so a listener that registers
        // and then throws is still removed by the failure path.
        installed.push([event, eventListener]);
        powerMonitor.on(event, eventListener);
      };
      try {
        install("unlock-screen", onUnlock);
      } catch {
        active = false;
        for (const [event, eventListener] of installed.reverse()) {
          try {
            powerMonitor.off(event, eventListener);
          } catch {
            // The original subscribe failure remains authoritative.
          }
        }
        throw new Win32CuaDriverSessionObserverError("subscribe_failed");
      }

      let disposed = false;
      return () => {
        if (disposed) {
          return;
        }
        disposed = true;
        active = false;
        let failed = false;
        for (const [event, eventListener] of installed.reverse()) {
          try {
            powerMonitor.off(event, eventListener);
          } catch {
            failed = true;
          }
        }
        if (failed) {
          throw new Win32CuaDriverSessionObserverError("subscribe_failed");
        }
      };
    },
  });
}
