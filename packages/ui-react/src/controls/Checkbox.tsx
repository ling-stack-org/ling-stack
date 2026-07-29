import type { InputHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";
import { Check } from "lucide-react";
import { Spinner } from "../feedback/Spinner.js";
import { mergeClassNames } from "../shared/merge-class-names.js";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  readonly label?: ReactNode;
  readonly loading?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, className, disabled, label, loading = false, ...props },
  ref,
) {
  const unavailable = Boolean(disabled || loading);
  return (
    <label
      className={mergeClassNames("ling-ui-checkbox", className)}
      data-checked={checked ? "true" : undefined}
      data-disabled={unavailable ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
    >
      <input
        {...props}
        ref={ref}
        className="ling-ui-checkbox-native"
        checked={checked}
        data-ling-control-native="true"
        disabled={unavailable}
        type="checkbox"
        aria-busy={loading || undefined}
      />
      <span className="ling-ui-checkbox-control" aria-hidden="true">
        {loading ? <Spinner size="sm" /> : <Check />}
      </span>
      {label ? <span className="ling-ui-checkbox-label">{label}</span> : null}
    </label>
  );
});
