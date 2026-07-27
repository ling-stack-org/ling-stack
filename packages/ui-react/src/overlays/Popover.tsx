import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";
import { useOverlayPortalContainer } from "./OverlayPortal.js";

export type PopoverSize = "sm" | "md" | "lg" | "content";

export const Popover = PopoverPrimitive.Root;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export interface PopoverContentProps extends ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  readonly size?: PopoverSize;
}

export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(function PopoverContent(
  {
    align = "start",
    className,
    collisionPadding = 8,
    sideOffset = 6,
    size = "sm",
    ...props
  },
  ref,
) {
  const portalContainer = useOverlayPortalContainer();
  return (
    <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
      <PopoverPrimitive.Content
        {...props}
        ref={ref}
        align={align}
        className={mergeClassNames("ling-ui-popover-content", className)}
        collisionPadding={collisionPadding}
        data-ling-overlay="popover"
        data-size={size}
        sideOffset={sideOffset}
      />
    </PopoverPrimitive.Portal>
  );
});
