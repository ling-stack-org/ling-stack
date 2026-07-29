import { ChevronDown } from "lucide-react";
import type { HTMLAttributes, SelectHTMLAttributes } from "react";
import { forwardRef } from "react";
import type { ControlSize } from "./Button.js";
import { Spinner } from "../feedback/Spinner.js";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type SelectContainerProps = Omit<HTMLAttributes<HTMLSpanElement>, "children" | "className"> & {
  readonly [attribute: `data-${string}`]: boolean | number | string | undefined;
};

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  readonly containerClassName?: string;
  readonly containerProps?: SelectContainerProps;
  readonly invalid?: boolean;
  readonly loading?: boolean;
  readonly size?: Exclude<ControlSize, "lg">;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    "aria-invalid": ariaInvalid,
    children,
    className,
    containerClassName,
    containerProps,
    disabled,
    invalid = false,
    loading = false,
    size = "md",
    ...props
  },
  ref,
) {
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  const unavailable = Boolean(disabled || loading);
  return (
    <span
      {...containerProps}
      className={mergeClassNames("ling-ui-select", containerClassName)}
      data-disabled={unavailable ? "true" : undefined}
      data-invalid={isInvalid ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
      data-size={size}
    >
      <select
        {...props}
        ref={ref}
        aria-busy={loading || undefined}
        aria-invalid={isInvalid || undefined}
        className={mergeClassNames("ling-ui-select-native", className)}
        data-ling-control-native="true"
        disabled={unavailable}
      >
        {children}
      </select>
      <span className="ling-ui-select-indicator" aria-hidden="true">
        {loading ? <Spinner size="sm" /> : <ChevronDown />}
      </span>
    </span>
  );
});
