import type { ReactNode } from "react";

export function StatusActionRow({
  leading,
  title,
  description,
  meta,
  status,
  actions,
  selected = false,
  interactive = false,
  className = "",
}: {
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly meta?: ReactNode;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly selected?: boolean;
  readonly interactive?: boolean;
  readonly className?: string;
}): JSX.Element {
  return (
    <div
      className={[
        "status-action-row",
        selected ? "selected" : "",
        interactive ? "interactive" : "",
        className,
      ].filter(Boolean).join(" ")}
    >
      {leading ? <span className="status-action-row-leading">{leading}</span> : null}
      <span className="status-action-row-copy">
        <span className="status-action-row-title">{title}</span>
        {description ? <span className="status-action-row-description">{description}</span> : null}
        {meta ? <span className="status-action-row-meta">{meta}</span> : null}
      </span>
      {status ? <span className="status-action-row-status">{status}</span> : null}
      {actions ? <span className="status-action-row-actions">{actions}</span> : null}
    </div>
  );
}
