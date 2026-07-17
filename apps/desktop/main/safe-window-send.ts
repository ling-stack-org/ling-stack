export interface DesktopWindowMessageTarget {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

export function sendToLiveDesktopWindow(
  window: DesktopWindowMessageTarget | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return false;
  }
  try {
    window.webContents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}
