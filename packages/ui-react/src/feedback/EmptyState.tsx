import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly action?: ReactNode;
  readonly compact?: boolean;
  readonly description?: ReactNode;
  readonly icon?: ReactNode;
  readonly secondaryAction?: ReactNode;
  readonly slotClassNames?: {
    readonly actions?: string;
    readonly copy?: string;
    readonly description?: string;
    readonly icon?: string;
    readonly title?: string;
  };
  readonly title: ReactNode;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { action, className, compact = false, description, icon, secondaryAction, slotClassNames, title, ...props },
  ref,
) {
  return (
    <div {...props} ref={ref} className={mergeClassNames("ling-ui-empty-state", className)} data-compact={compact || undefined} data-has-icon={Boolean(icon) || undefined}>
      {icon ? <span className={mergeClassNames("ling-ui-empty-state-icon", slotClassNames?.icon)} aria-hidden="true">{icon}</span> : null}
      <span className={mergeClassNames("ling-ui-empty-state-copy", slotClassNames?.copy)}>
        <strong className={mergeClassNames("ling-ui-empty-state-title", slotClassNames?.title)}>{title}</strong>
        {description ? <span className={mergeClassNames("ling-ui-empty-state-description", slotClassNames?.description)}>{description}</span> : null}
      </span>
      {action || secondaryAction ? <span className={mergeClassNames("ling-ui-empty-state-actions", slotClassNames?.actions)}>{secondaryAction}{action}</span> : null}
    </div>
  );
});
