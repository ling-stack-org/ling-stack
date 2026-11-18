import type { LingDesktopCapabilities } from "../../desktop/shared/desktop-capabilities.js";

declare global {
  interface Window {
    readonly lingDesktop?: LingDesktopCapabilities;
    readonly lingCompanionDesktop?: import("../../desktop/shared/companion-capabilities.js").CompanionDesktopCapabilities;
  }
}

export {};
