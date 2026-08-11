import type { ReactNode } from "react";

export function DialogSection({
  title,
  description,
  children,
  collapsible = false,
  defaultOpen = false,
  className = "",
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly collapsible?: boolean;
  readonly defaultOpen?: boolean;
  readonly className?: string;
}): React.JSX.Element {
  const classes = ["dialog-section", collapsible ? "collapsible" : "", className].filter(Boolean).join(" ");

  if (collapsible) {
    return (
      <details className={classes} open={defaultOpen}>
        <summary>
          <span>{title}</span>
          {description ? <small>{description}</small> : null}
        </summary>
        <div className="dialog-section-body">{children}</div>
      </details>
    );
  }

  return (
    <section className={classes}>
      <div className="dialog-section-title">
        <span>{title}</span>
        {description ? <small>{description}</small> : null}
      </div>
      <div className="dialog-section-body">{children}</div>
    </section>
  );
}
