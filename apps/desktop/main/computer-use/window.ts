import {
  BrowserWindow,
  shell,
} from "electron";
import { fileURLToPath } from "node:url";
import type { DesktopRect } from "../../shared/desktop-capabilities.js";
import { COMPUTER_USE_PREVIEW_SESSION_PARTITION } from "./session-partition.js";
import { buildComputerUsePreviewWindowOptions } from "./window-options.js";

export interface ComputerUsePreviewWindow {
  readonly webContents: {
    readonly id: number;
    send(channel: string, ...args: unknown[]): void;
  };
  loadFile(path: string): Promise<void>;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  setAspectRatio(aspectRatio: number): void;
  setBounds(bounds: DesktopRect, animate?: boolean): void;
  getBounds(): DesktopRect;
  on(event: "closed" | "move" | "resize", listener: () => void): this;
  off(event: "closed" | "move" | "resize", listener: () => void): this;
  /**
   * Subscribe to the renderer process dying without exposing Electron's event
   * object to the coordinator or to tests.
   *
   * The returned disposer is intentionally part of the window boundary. A
   * crashed renderer can leave a BrowserWindow shell alive for a short time;
   * keeping the disposer here makes the old window's callback impossible to
   * re-enter after the coordinator has replaced it.
   */
  onRendererProcessGone(listener: (details: ComputerUsePreviewRendererGoneDetails) => void): () => void;
}

export interface ComputerUsePreviewRendererGoneDetails {
  readonly reason?: string;
  readonly exitCode?: number;
}

export type ComputerUsePreviewWindowFactory = (bounds: DesktopRect) => ComputerUsePreviewWindow;

export function createComputerUsePreviewWindowFactory(): ComputerUsePreviewWindowFactory {
  return (bounds) => {
    const window = new BrowserWindow(buildComputerUsePreviewWindowOptions({
      bounds,
      preloadPath: fileURLToPath(new URL("../../preload/computer-use-preview.cjs", import.meta.url)),
      partition: COMPUTER_USE_PREVIEW_SESSION_PARTITION,
    }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });
    let rendererGoneForwarder: ((details: ComputerUsePreviewRendererGoneDetails) => void) | undefined;
    const rendererGoneListener = (_event: unknown, details: ComputerUsePreviewRendererGoneDetails): void => {
      rendererGoneForwarder?.(details);
    };
    // The actual subscription is attached below by the wrapper method. It is
    // declared on the object so the coordinator can explicitly remove it.
    return Object.assign(window, {
      onRendererProcessGone: (callback: (details: ComputerUsePreviewRendererGoneDetails) => void): (() => void) => {
        rendererGoneForwarder = callback;
        window.webContents.on("render-process-gone", rendererGoneListener);
        return () => {
          if (rendererGoneForwarder === callback) {
            rendererGoneForwarder = undefined;
          }
          window.webContents.off("render-process-gone", rendererGoneListener);
        };
      },
    }) as unknown as ComputerUsePreviewWindow;
  };
}
