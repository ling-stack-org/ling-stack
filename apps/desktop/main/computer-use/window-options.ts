import type { BrowserWindowConstructorOptions } from "electron";
import type { DesktopRect } from "../../shared/desktop-capabilities.js";

export function buildComputerUsePreviewWindowOptions(input: {
  readonly bounds: DesktopRect;
  readonly preloadPath: string;
  readonly partition: string;
}): BrowserWindowConstructorOptions {
  return {
    ...input.bounds,
    minWidth: 320,
    minHeight: 200,
    maxWidth: 480,
    maxHeight: 300,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      partition: input.partition,
    },
  };
}
