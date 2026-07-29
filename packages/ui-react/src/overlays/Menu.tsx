import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";
import { useOverlayPortalContainer } from "./OverlayPortal.js";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuRadioGroup = DropdownMenu.RadioGroup;

export const MenuContent = forwardRef<
  ElementRef<typeof DropdownMenu.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Content>
>(function MenuContent({ className, sideOffset = 6, ...props }, ref) {
  const portalContainer = useOverlayPortalContainer();
  return (
    <DropdownMenu.Portal container={portalContainer ?? undefined}>
      <DropdownMenu.Content
        {...props}
        ref={ref}
        className={mergeClassNames("ling-ui-menu-content", className)}
        data-ling-overlay="menu"
        sideOffset={sideOffset}
      />
    </DropdownMenu.Portal>
  );
});

export interface MenuItemProps extends ComponentPropsWithoutRef<typeof DropdownMenu.Item> {
  readonly tone?: "default" | "danger";
}

export const MenuItem = forwardRef<ElementRef<typeof DropdownMenu.Item>, MenuItemProps>(
  function MenuItem({ className, tone = "default", ...props }, ref) {
    return (
      <DropdownMenu.Item
        {...props}
        ref={ref}
        className={mergeClassNames("ling-ui-menu-item", className)}
        data-tone={tone}
      />
    );
  },
);

export const MenuRadioItem = forwardRef<
  ElementRef<typeof DropdownMenu.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownMenu.RadioItem>
>(function MenuRadioItem({ className, ...props }, ref) {
  return (
    <DropdownMenu.RadioItem
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-menu-item ling-ui-menu-radio-item", className)}
    />
  );
});

export const MenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenu.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Separator>
>(function MenuSeparator({ className, ...props }, ref) {
  return (
    <DropdownMenu.Separator
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-menu-separator", className)}
    />
  );
});
