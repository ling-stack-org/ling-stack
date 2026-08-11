import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";
import {
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
  type DialogSize,
} from "./Dialog.js";
import { useOverlayPortalContainer } from "./OverlayPortal.js";
import { OverlayRoot, type OverlayRootProps, useOverlayContext } from "./overlay-context.js";

export type DrawerSize = DialogSize;
export type DrawerSide = "right";

export function Drawer(props: OverlayRootProps): React.JSX.Element {
  return <OverlayRoot {...props} kind="drawer" />;
}

export const DrawerTrigger = DialogTrigger;
export const DrawerClose = DialogClose;
export const DrawerHeader = DialogHeader;
export const DrawerBody = DialogBody;
export const DrawerFooter = DialogFooter;

export interface DrawerContentProps extends Omit<
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
  "onEscapeKeyDown" | "onInteractOutside" | "onPointerDownOutside"
> {
  readonly onEscapeKeyDown?: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onEscapeKeyDown"];
  readonly onInteractOutside?: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onInteractOutside"];
  readonly onPointerDownOutside?: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onPointerDownOutside"];
  readonly overlayClassName?: string;
  readonly side?: DrawerSide;
  readonly size?: DrawerSize;
}

export const DrawerContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, DrawerContentProps>(
  function DrawerContent(
    {
      className,
      onEscapeKeyDown,
      onInteractOutside,
      onPointerDownOutside,
      overlayClassName,
      side = "right",
      size = "md",
      ...props
    },
    ref,
  ) {
    const { busy, canDismiss, dismissible } = useOverlayContext("DrawerContent");
    const portalContainer = useOverlayPortalContainer();

    return (
      <DialogPrimitive.Portal container={portalContainer ?? undefined}>
        <DialogPrimitive.Overlay
          className={mergeClassNames("ling-ui-drawer-overlay", overlayClassName)}
          data-busy={busy ? "true" : undefined}
          data-ling-overlay-scrim="drawer"
        />
        <DialogPrimitive.Content
          {...props}
          ref={ref}
          className={mergeClassNames("ling-ui-drawer-content", className)}
          aria-busy={busy || undefined}
          aria-modal="true"
          data-busy={busy ? "true" : undefined}
          data-dismissible={dismissible ? "true" : "false"}
          data-ling-overlay="drawer"
          data-side={side}
          data-size={size}
          onEscapeKeyDown={(event) => {
            if (!canDismiss) event.preventDefault();
            onEscapeKeyDown?.(event);
          }}
          onInteractOutside={(event) => {
            if (!canDismiss) event.preventDefault();
            onInteractOutside?.(event);
          }}
          onPointerDownOutside={(event) => {
            if (!canDismiss) event.preventDefault();
            onPointerDownOutside?.(event);
          }}
        />
      </DialogPrimitive.Portal>
    );
  },
);
