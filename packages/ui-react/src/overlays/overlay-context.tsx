import * as DialogPrimitive from "@radix-ui/react-dialog";
import { createContext, useContext, type ReactNode } from "react";

export type OverlayKind = "dialog" | "drawer";

interface OverlayContextValue {
  readonly busy: boolean;
  readonly dismissible: boolean;
  readonly kind: OverlayKind;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

export interface OverlayRootProps {
  readonly busy?: boolean;
  readonly children: ReactNode;
  readonly dismissible?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

export function OverlayRoot({
  busy = false,
  children,
  dismissible = true,
  kind,
  onOpenChange,
  open,
}: OverlayRootProps & { readonly kind: OverlayKind }): JSX.Element {
  const canDismiss = dismissible && !busy;

  return (
    <OverlayContext.Provider value={{ busy, dismissible, kind }}>
      <DialogPrimitive.Root
        modal
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !canDismiss) return;
          onOpenChange(nextOpen);
        }}
      >
        {children}
      </DialogPrimitive.Root>
    </OverlayContext.Provider>
  );
}

export function useOverlayContext(owner: string): OverlayContextValue & { readonly canDismiss: boolean } {
  const context = useContext(OverlayContext);
  if (!context) throw new Error(`${owner} must be rendered inside Dialog or Drawer`);
  return { ...context, canDismiss: context.dismissible && !context.busy };
}
