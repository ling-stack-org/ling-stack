import { forwardRef, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Spinner } from "../feedback/Spinner.js";
import { mergeClassNames } from "../shared/merge-class-names.js";

export interface DataRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "onClick"> {
  readonly actions?: ReactNode;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly identity: ReactNode;
  readonly loading?: boolean;
  readonly onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  readonly selected?: boolean;
  readonly status?: ReactNode;
  readonly summary?: ReactNode;
}

export const DataRow = forwardRef<HTMLDivElement, DataRowProps>(function DataRow(
  { actions, className, compact = false, disabled = false, identity, loading = false, onClick, onKeyDown, selected = false, status, summary, ...props },
  ref,
) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    onKeyDown?.(event);
    if (event.defaultPrevented || !onClick || disabled || loading) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.currentTarget.click();
    }
  }

  return (
    <div
      {...props}
      ref={ref}
      aria-busy={loading || undefined}
      aria-disabled={disabled || undefined}
      aria-selected={selected || undefined}
      className={mergeClassNames("ling-ui-data-row", className)}
      data-compact={compact || undefined}
      data-disabled={disabled || undefined}
      data-selected={selected || undefined}
      role={props.role ?? (onClick ? "option" : undefined)}
      tabIndex={onClick && !disabled ? (props.tabIndex ?? 0) : props.tabIndex}
      onClick={disabled || loading ? undefined : onClick}
      onKeyDown={handleKeyDown}
    >
      <div className="ling-ui-data-row-identity">{identity}</div>
      {summary ? <div className="ling-ui-data-row-summary">{summary}</div> : null}
      {status ? <div className="ling-ui-data-row-status">{status}</div> : null}
      {loading ? <Spinner className="ling-ui-data-row-spinner" label="Loading" size="sm" /> : null}
      {actions ? <div className="ling-ui-data-row-actions">{actions}</div> : null}
    </div>
  );
});
