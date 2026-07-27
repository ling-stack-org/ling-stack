import type { TextareaHTMLAttributes } from "react";
import { forwardRef } from "react";
import type { ControlSize } from "./Button.js";
import { mergeClassNames } from "../shared/merge-class-names.js";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly invalid?: boolean;
  readonly loading?: boolean;
  readonly size?: Exclude<ControlSize, "lg">;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    "aria-invalid": ariaInvalid,
    className,
    disabled,
    invalid = false,
    loading = false,
    readOnly,
    size = "md",
    ...props
  },
  ref,
) {
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  return (
    <textarea
      {...props}
      ref={ref}
      aria-busy={loading || undefined}
      aria-invalid={isInvalid || undefined}
      className={mergeClassNames("ling-ui-textarea", className)}
      data-ling-control-native="true"
      data-invalid={isInvalid ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
      data-size={size}
      disabled={disabled}
      readOnly={readOnly}
    />
  );
});
