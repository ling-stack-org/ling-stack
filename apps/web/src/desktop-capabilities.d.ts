import type { LingDesktopCapabilities } from "../../desktop/shared/desktop-capabilities.js";

declare global {
  interface Window {
    readonly lingDesktop?: LingDesktopCapabilities;
  }
}

export {};
