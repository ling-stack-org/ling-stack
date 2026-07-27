import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@ling-stack/ui-react";
import type { ComputerUsePipRendererSnapshot } from "../../shared/desktop-capabilities.js";
import { ComputerUsePreviewApp } from "./ComputerUsePreviewApp.js";
import { createComputerUsePreviewController } from "./preview-controller.js";
import { createComputerUsePreviewMediaController } from "./preview-media-controller.js";
import { createComputerUsePreviewThemeController } from "./preview-theme-controller.js";
import "@fontsource-variable/inter";
import "@ling-stack/ui-react/styles.css";
import "./styles/index.css";

const fallbackSnapshot: ComputerUsePipRendererSnapshot = {
  sessionId: "preview_fake_session_01",
  conversationId: "preview_fake_conversation_01",
  locale: "en-US",
  targetLabel: "Browser task",
  runtimeStatus: "running",
  sourceStatus: "live",
  sourceKind: "fake",
  sourceRevision: 1,
  sourceGeneration: 1,
  visibilityIntent: "auto",
  frameReady: true,
  aspectRatio: 1.6,
  canStop: true,
  canOpenSettings: false,
};

const rootElement = document.getElementById("preview-root");
if (!rootElement) {
  throw new Error("Computer Use preview root was not found");
}

const capabilities = window.lingComputerUsePreview;
const controller = createComputerUsePreviewController({ capabilities, fallbackSnapshot });
const mediaController = createComputerUsePreviewMediaController({
  getCapabilities: () => window.lingComputerUsePreview,
});
const themeController = createComputerUsePreviewThemeController({
  getCapabilities: () => window.lingComputerUsePreview,
});
const unsubscribeRelease = capabilities?.onReleaseMedia((request) => (
  mediaController.releaseMediaForRequest(request)
));

themeController.start();
controller.start();
createRoot(rootElement).render(
  <TooltipProvider>
    <ComputerUsePreviewApp controller={controller} mediaController={mediaController} />
  </TooltipProvider>,
);

window.addEventListener("beforeunload", () => {
  unsubscribeRelease?.();
  themeController.dispose();
  controller.dispose();
  mediaController.dispose();
}, { once: true });
