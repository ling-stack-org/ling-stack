import { LoaderCircle } from "lucide-react";
import type { HTMLAttributes } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  readonly label?: string;
  readonly size?: SpinnerSize;
}

export function Spinner({ className, label, size = "md", ...props }: SpinnerProps) {
  return (
    <span
      {...props}
      className={mergeClassNames("ling-ui-spinner", className)}
      data-size={size}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <LoaderCircle aria-hidden="true" />
    </span>
  );
}
