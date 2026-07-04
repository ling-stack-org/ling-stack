import type { ReactNode } from "react";

export function PageActionHeader({
  title,
  description,
  meta,
  primaryAction,
  secondaryActions,
  className = "",
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly meta?: ReactNode;
  readonly primaryAction?: ReactNode;
  readonly secondaryActions?: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <header className={["page-action-header", className].filter(Boolean).join(" ")}>
      <div className="page-action-header-copy">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
        {meta ? <div className="page-action-header-meta">{meta}</div> : null}
      </div>
      {primaryAction || secondaryActions ? (
        <div className="page-action-header-actions">
          {secondaryActions}
          {primaryAction}
        </div>
      ) : null}
    </header>
  );
}
