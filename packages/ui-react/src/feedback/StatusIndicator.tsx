import type { HTMLAttributes, ReactNode } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface StatusIndicatorProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  readonly compact?: boolean;
  readonly label: ReactNode;
  readonly tone?: StatusTone;
}

export function StatusIndicator({ className, compact = false, label, tone = "neutral", ...props }: StatusIndicatorProps) {
  return (
    <span
      {...props}
      className={mergeClassNames("ling-ui-status-indicator", className)}
      data-compact={compact || undefined}
      data-tone={tone}
    >
      <span className="ling-ui-status-indicator-dot" aria-hidden="true" />
      <span className="ling-ui-status-indicator-label">{label}</span>
    </span>
  );
}
