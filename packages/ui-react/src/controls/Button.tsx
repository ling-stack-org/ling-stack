import { Slot, Slottable } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import { forwardRef } from "react";
import { Spinner } from "../feedback/Spinner.js";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ControlSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly asChild?: boolean;
  readonly leadingIcon?: ReactNode;
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  readonly size?: ControlSize;
  readonly trailingIcon?: ReactNode;
  readonly variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    asChild = false,
    children,
    className,
    disabled,
    leadingIcon,
    loading = false,
    loadingLabel = "Loading",
    onClick,
    size = "md",
    trailingIcon,
    type,
    variant = "secondary",
    ...props
  },
  ref,
) {
  const Component = asChild ? Slot : "button";
  const unavailable = Boolean(disabled || loading);
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (unavailable) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <Component
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-button", className)}
      data-loading={loading ? "true" : undefined}
      data-size={size}
      data-variant={variant}
      aria-busy={loading || undefined}
      aria-disabled={asChild && unavailable ? true : undefined}
      disabled={asChild ? undefined : unavailable}
      onClick={handleClick}
      type={asChild ? undefined : (type ?? "button")}
    >
      <span className="ling-ui-button-leading" data-ling-button-slot="leading" aria-hidden="true">
        {loading ? <Spinner size={size === "lg" ? "md" : "sm"} /> : leadingIcon}
      </span>
      <Slottable>
        {asChild ? children : (
          <span className="ling-ui-button-label" data-ling-button-slot="label">
            {children}
          </span>
        )}
      </Slottable>
      {loading ? <span className="ling-ui-sr-only">{loadingLabel}</span> : null}
      {trailingIcon ? (
        <span className="ling-ui-button-trailing" data-ling-button-slot="trailing" aria-hidden="true">
          {trailingIcon}
        </span>
      ) : null}
    </Component>
  );
});
