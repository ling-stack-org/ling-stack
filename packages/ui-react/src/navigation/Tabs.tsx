import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type TabsAppearance = "line" | "contained";
export type TabsSize = "sm" | "md";

export const Tabs = TabsPrimitive.Root;

export interface TabsListProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  readonly appearance?: TabsAppearance;
  readonly size?: TabsSize;
}

export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, TabsListProps>(
  function TabsList({ appearance = "line", className, size = "md", ...props }, ref) {
    return (
      <TabsPrimitive.List
        {...props}
        ref={ref}
        className={mergeClassNames("ling-ui-tabs-list", className)}
        data-appearance={appearance}
        data-size={size}
      />
    );
  },
);

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-tabs-trigger", className)}
    />
  );
});
export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-tabs-content", className)}
    />
  );
});
