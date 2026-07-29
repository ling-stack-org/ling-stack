import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

export const CollapsibleContent = forwardRef<
  ElementRef<typeof CollapsiblePrimitive.Content>,
  ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>
>(function CollapsibleContent({ className, ...props }, ref) {
  return (
    <CollapsiblePrimitive.Content
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-collapsible-content", className)}
      data-ling-collapsible-content=""
    />
  );
});
