import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";
export type BadgeVariant = "subtle" | "outline";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly icon?: ReactNode;
  readonly tone?: BadgeTone;
  readonly variant?: BadgeVariant;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { children, className, icon, tone = "neutral", variant = "subtle", ...props },
  ref,
) {
  return (
    <span {...props} ref={ref} className={mergeClassNames("ling-ui-badge", className)} data-tone={tone} data-variant={variant}>
      {icon ? <span className="ling-ui-badge-icon" aria-hidden="true">{icon}</span> : null}
      <span className="ling-ui-badge-label">{children}</span>
    </span>
  );
});
