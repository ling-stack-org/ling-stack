import { ChevronDown } from "lucide-react";
import { forwardRef, type SelectHTMLAttributes } from "react";

export type SelectControlVariant = "field" | "compact";

export interface SelectControlProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly variant?: SelectControlVariant;
  readonly containerClassName?: string;
}

export const SelectControl = forwardRef<HTMLSelectElement, SelectControlProps>(function SelectControl({
  children,
  className,
  containerClassName,
  disabled = false,
  variant = "field",
  ...props
}, ref) {
  const rootClassName = ["select-control", `select-control--${variant}`, containerClassName].filter(Boolean).join(" ");
  const nativeClassName = ["select-control-native", className].filter(Boolean).join(" ");

  return (
    <span className={rootClassName} data-select-control={variant} data-disabled={disabled ? "true" : undefined}>
      <select ref={ref} className={nativeClassName} disabled={disabled} {...props}>
        {children}
      </select>
      <ChevronDown className="select-control-chevron" size={14} aria-hidden="true" />
    </span>
  );
});

SelectControl.displayName = "SelectControl";
