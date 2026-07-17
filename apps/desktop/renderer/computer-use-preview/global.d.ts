import type { LingComputerUsePreviewCapabilities } from "../../shared/desktop-capabilities.js";

declare global {
  interface Window {
    readonly lingComputerUsePreview?: LingComputerUsePreviewCapabilities;
  }
}

export {};
