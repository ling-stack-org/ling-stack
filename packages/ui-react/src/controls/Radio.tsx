import type { InputHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  readonly label?: ReactNode;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { checked, className, disabled, label, ...props },
  ref,
) {
  return (
    <label
      className={mergeClassNames("ling-ui-radio", className)}
      data-checked={checked ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
    >
      <input
        {...props}
        ref={ref}
        className="ling-ui-radio-native"
        checked={checked}
        data-ling-control-native="true"
        disabled={disabled}
        type="radio"
      />
      <span className="ling-ui-radio-control" aria-hidden="true">
        <span className="ling-ui-radio-dot" />
      </span>
      {label ? <span className="ling-ui-radio-label">{label}</span> : null}
    </label>
  );
});
