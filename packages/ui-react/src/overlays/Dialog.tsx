import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentPropsWithoutRef, ElementRef, HTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";
import { IconButton } from "../controls/IconButton.js";
import { mergeClassNames } from "../shared/merge-class-names.js";
import { useOverlayPortalContainer } from "./OverlayPortal.js";
import { OverlayRoot, type OverlayRootProps, useOverlayContext } from "./overlay-context.js";

export type DialogSize = "sm" | "md" | "lg";

export function Dialog(props: OverlayRootProps): React.JSX.Element {
  return <OverlayRoot {...props} kind="dialog" />;
}

export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends Omit<
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
  "onEscapeKeyDown" | "onInteractOutside" | "onPointerDownOutside"
> {
  readonly onEscapeKeyDown?: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onEscapeKeyDown"];
  readonly onInteractOutside?: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onInteractOutside"];
  readonly onPointerDownOutside?: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onPointerDownOutside"];
  readonly overlayClassName?: string;
  readonly size?: DialogSize;
}

export const DialogContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  function DialogContent(
    {
      className,
      onEscapeKeyDown,
      onInteractOutside,
      onPointerDownOutside,
      overlayClassName,
      size = "md",
      ...props
    },
    ref,
  ) {
    const { busy, canDismiss, dismissible } = useOverlayContext("DialogContent");
    const portalContainer = useOverlayPortalContainer();

    return (
      <DialogPrimitive.Portal container={portalContainer ?? undefined}>
        <DialogPrimitive.Overlay
          className={mergeClassNames("ling-ui-dialog-overlay", overlayClassName)}
          data-busy={busy ? "true" : undefined}
          data-ling-overlay-scrim="dialog"
        />
        <DialogPrimitive.Content
          {...props}
          ref={ref}
          className={mergeClassNames("ling-ui-dialog-content", className)}
          aria-busy={busy || undefined}
          aria-modal="true"
          data-busy={busy ? "true" : undefined}
          data-dismissible={dismissible ? "true" : "false"}
          data-ling-overlay="dialog"
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

export interface DialogHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly closeButtonClassName?: string;
  readonly closeLabel?: string;
  readonly description?: ReactNode;
  readonly title: ReactNode;
  readonly titleBlockClassName?: string;
}

export const DialogHeader = forwardRef<HTMLDivElement, DialogHeaderProps>(function DialogHeader(
  {
    className,
    closeButtonClassName,
    closeLabel,
    description,
    title,
    titleBlockClassName,
    ...props
  },
  ref,
) {
  const { busy, dismissible } = useOverlayContext("DialogHeader");

  return (
    <div {...props} ref={ref} className={mergeClassNames("ling-ui-dialog-header", className)}>
      <div className={mergeClassNames("ling-ui-dialog-title-block", titleBlockClassName)}>
        <DialogPrimitive.Title className="ling-ui-dialog-title">{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="ling-ui-dialog-description">
            {description}
          </DialogPrimitive.Description>
        ) : null}
      </div>
      {closeLabel && dismissible ? (
        <DialogPrimitive.Close asChild disabled={busy}>
          <IconButton
            className={closeButtonClassName}
            disabled={busy}
            icon={X}
            label={closeLabel}
            size="sm"
            tooltip=""
          />
        </DialogPrimitive.Close>
      ) : null}
    </div>
  );
});

export const DialogBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function DialogBody(
  { className, ...props },
  ref,
) {
  return <div {...props} ref={ref} className={mergeClassNames("ling-ui-dialog-body", className)} />;
});

export const DialogFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function DialogFooter(
  { className, ...props },
  ref,
) {
  return <div {...props} ref={ref} className={mergeClassNames("ling-ui-dialog-footer", className)} />;
});
