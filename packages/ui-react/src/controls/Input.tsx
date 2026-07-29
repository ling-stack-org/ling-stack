import type { InputHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";
import type { ControlSize } from "./Button.js";
import { Spinner } from "../feedback/Spinner.js";
import { mergeClassNames } from "../shared/merge-class-names.js";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix" | "size"> {
  readonly containerClassName?: string;
  readonly invalid?: boolean;
  readonly loading?: boolean;
  readonly prefix?: ReactNode;
  readonly size?: Exclude<ControlSize, "lg">;
  readonly suffix?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    "aria-invalid": ariaInvalid,
    className,
    containerClassName,
    disabled,
    invalid = false,
    loading = false,
    prefix,
    readOnly,
    size = "md",
    suffix,
    ...props
  },
  ref,
) {
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  return (
    <span
      className={mergeClassNames("ling-ui-input", containerClassName)}
      data-disabled={disabled ? "true" : undefined}
      data-invalid={isInvalid ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
      data-readonly={readOnly ? "true" : undefined}
      data-size={size}
    >
      {prefix ? <span className="ling-ui-input-prefix">{prefix}</span> : null}
      <input
        {...props}
        ref={ref}
        aria-busy={loading || undefined}
        aria-invalid={isInvalid || undefined}
        className={mergeClassNames("ling-ui-input-native", className)}
        data-ling-control-native="true"
        data-ling-input-native="true"
        disabled={disabled}
        readOnly={readOnly}
      />
      {loading ? (
        <span className="ling-ui-input-suffix" aria-hidden="true"><Spinner size="sm" /></span>
      ) : suffix ? <span className="ling-ui-input-suffix">{suffix}</span> : null}
    </span>
  );
});
