import { OverlayPortalProvider, TooltipProvider } from "@ling-stack/ui-react";
import { LingToastProvider } from "../feedback/LingToastProvider.js";
import type { ReactNode } from "react";

export function LingUiProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const overlayRoot = typeof document === "undefined"
    ? null
    : document.getElementById("ling-ui-overlay-root");
  return (
    <OverlayPortalProvider container={overlayRoot}>
      <TooltipProvider>
        <LingToastProvider portalContainer={overlayRoot}>{children}</LingToastProvider>
      </TooltipProvider>
    </OverlayPortalProvider>
  );
}
