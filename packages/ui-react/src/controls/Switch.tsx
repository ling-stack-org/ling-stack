import * as SwitchPrimitive from "@radix-ui/react-switch";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export interface SwitchProps extends ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  readonly loading?: boolean;
}

export const Switch = forwardRef<ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(function Switch(
  { className, disabled, loading = false, ...props },
  ref,
) {
  const unavailable = Boolean(disabled || loading);
  return (
    <SwitchPrimitive.Root
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-switch", className)}
      data-loading={loading ? "true" : undefined}
      disabled={unavailable}
      aria-busy={loading || undefined}
    >
      <SwitchPrimitive.Thumb className="ling-ui-switch-thumb" />
    </SwitchPrimitive.Root>
  );
});
