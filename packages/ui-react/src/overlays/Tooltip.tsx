import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";
import { useOverlayPortalContainer } from "./OverlayPortal.js";

const TooltipProviderContext = createContext(false);

export interface TooltipProviderProps {
  readonly children: ReactNode;
  readonly delayDuration?: number;
  readonly disableHoverableContent?: boolean;
  readonly skipDelayDuration?: number;
}

export function TooltipProvider({
  children,
  delayDuration = 450,
  disableHoverableContent = true,
  skipDelayDuration = 150,
}: TooltipProviderProps) {
  return (
    <TooltipProviderContext.Provider value>
      <TooltipPrimitive.Provider
        delayDuration={delayDuration}
        disableHoverableContent={disableHoverableContent}
        skipDelayDuration={skipDelayDuration}
      >
        {children}
      </TooltipPrimitive.Provider>
    </TooltipProviderContext.Provider>
  );
}

export interface TooltipProps {
  readonly children: ReactElement;
  readonly collisionPadding?: number;
  readonly content: ReactNode;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly sideOffset?: number;
  readonly className?: string;
}

export function Tooltip({ children, className, collisionPadding = 8, content, side = "top", sideOffset = 6 }: TooltipProps) {
  const hasProvider = useContext(TooltipProviderContext);
  const portalContainer = useOverlayPortalContainer();
  const tooltip = (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={portalContainer ?? undefined}>
        <TooltipPrimitive.Content
          className={mergeClassNames("ling-ui-tooltip", className)}
          collisionPadding={collisionPadding}
          data-ling-overlay="tooltip"
          side={side}
          sideOffset={sideOffset}
        >
          {content}
          <TooltipPrimitive.Arrow className="ling-ui-tooltip-arrow" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return hasProvider ? tooltip : (
    <TooltipPrimitive.Provider delayDuration={450} disableHoverableContent skipDelayDuration={150}>
      {tooltip}
    </TooltipPrimitive.Provider>
  );
}
