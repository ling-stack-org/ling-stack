import type { BrowserWindow } from "electron";
import type { DesktopBrowserManager } from "./manager.js";

/** Window transitions detach native pages until the trusted renderer reports fresh geometry. */
export function bindDesktopBrowserWindow(window: BrowserWindow, manager: DesktopBrowserManager): void {
  const contents = window.webContents;
  const hide = (): void => manager.hide();
  const rotate = (): void => manager.rotateGeneration();
  window.on("resize", hide);
  window.on("minimize", hide);
  window.on("hide", hide);
  window.on("close", hide);
  contents.on("render-process-gone", rotate);
  window.once("closed", () => {
    window.removeListener("resize", hide);
    window.removeListener("minimize", hide);
    window.removeListener("hide", hide);
    window.removeListener("close", hide);
    contents.removeListener("render-process-gone", rotate);
    rotate();
  });
}
