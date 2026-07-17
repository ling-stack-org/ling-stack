export interface DesktopMainWindowAuthority {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface DesktopSingleInstanceAuthorityOptions {
  readonly requestSingleInstanceLock: () => boolean;
  readonly registerSecondInstanceHandler: (listener: () => void) => void;
  readonly quitSecondaryInstance: () => void;
  readonly startPrimaryInstance: () => void;
  readonly getMainWindow: () => DesktopMainWindowAuthority | undefined;
  readonly openMainWindow?: () => Promise<boolean>;
  readonly onSecondInstance?: (focusedExistingWindow: boolean) => void;
}

/**
 * Establish process ownership before any daemon, coordinator, or PiP startup is
 * registered. A rejected process exits without running `startPrimaryInstance`.
 */
export function establishDesktopSingleInstanceAuthority(
  options: DesktopSingleInstanceAuthorityOptions,
): "primary" | "secondary" {
  if (!options.requestSingleInstanceLock()) {
    options.quitSecondaryInstance();
    return "secondary";
  }

  options.registerSecondInstanceHandler(() => {
    const focused = focusExistingDesktopMainWindow(options.getMainWindow());
    if (focused || !options.openMainWindow) {
      options.onSecondInstance?.(focused);
      return;
    }
    void options.openMainWindow().then(
      (opened) => options.onSecondInstance?.(opened),
      () => options.onSecondInstance?.(false),
    );
  });
  options.startPrimaryInstance();
  return "primary";
}

/**
 * Focus only an already-owned main window. This deliberately never creates a
 * window or starts Desktop services when a second launch arrives.
 */
export function focusExistingDesktopMainWindow(
  window: DesktopMainWindowAuthority | undefined,
): boolean {
  if (!window) {
    return false;
  }
  try {
    if (window.isDestroyed()) {
      return false;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    return true;
  } catch {
    // The window may be destroyed between the state check and focus calls.
    // A second-instance event must not crash or restart the primary process.
    return false;
  }
}
