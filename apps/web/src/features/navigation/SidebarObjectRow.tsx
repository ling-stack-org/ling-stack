import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../../shared/ui/index.js";
import { SidebarTooltip } from "./SidebarTooltip.js";

export function SidebarObjectRow({
  actions,
  actionsLabel,
  ariaLabel,
  buttonClassName,
  children,
  description,
  icon,
  onSelect,
  selected = false,
  shellClassName,
  status,
  statusId,
  tooltip = ariaLabel,
  tooltipClassName,
}: {
  readonly actions?: ReactNode;
  readonly actionsLabel?: string;
  readonly ariaLabel: string;
  readonly buttonClassName?: string;
  readonly children: ReactNode;
  readonly description?: ReactNode;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
  readonly selected?: boolean;
  readonly shellClassName?: string;
  readonly status?: ReactNode;
  readonly statusId?: string;
  readonly tooltip?: ReactNode;
  readonly tooltipClassName?: string;
}): React.JSX.Element {
  const titleViewportRef = useRef<HTMLSpanElement>(null);
  const titleTrackRef = useRef<HTMLSpanElement>(null);
  const [titleOverflow, setTitleOverflow] = useState(0);
  const shellClasses = ["sidebar-row-shell", shellClassName, selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
  const buttonClasses = ["sidebar-row-main", buttonClassName].filter(Boolean).join(" ");

  useEffect(() => {
    const viewport = titleViewportRef.current;
    const track = titleTrackRef.current;
    if (!viewport || !track) return undefined;

    const measure = (): void => {
      const nextOverflow = Math.max(0, Math.ceil(track.scrollWidth - viewport.clientWidth));
      setTitleOverflow((current) => current === nextOverflow ? current : nextOverflow);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(track);
    return () => observer.disconnect();
  }, [children, description]);

  const scrollDuration = Math.min(3200, Math.max(700, titleOverflow * 20));

  return (
    <div
      className={shellClasses}
      data-sidebar-row-actions={actions ? "true" : "false"}
      data-sidebar-row-overflow={titleOverflow > 0 ? "true" : "false"}
      data-sidebar-row-status={statusId}
      style={{
        "--sidebar-title-scroll-distance": `${titleOverflow}px`,
        "--sidebar-title-scroll-duration": `${scrollDuration}ms`,
      } as CSSProperties}
    >
      <SidebarTooltip className={tooltipClassName} label={tooltip}>
        <Button
          aria-current={selected ? "page" : undefined}
          aria-label={ariaLabel}
          className={buttonClasses}
          leadingIcon={icon}
          onClick={onSelect}
          variant="ghost"
        >
          <span className="sidebar-row-copy">
            <span ref={titleViewportRef} className="sidebar-row-title-viewport">
              <span ref={titleTrackRef} className="sidebar-row-title-track">{children}</span>
            </span>
            {description ? <small className="sidebar-row-description">{description}</small> : null}
          </span>
        </Button>
      </SidebarTooltip>
      {status ? <span className="sidebar-row-status">{status}</span> : null}
      {actions ? (
        <span className="sidebar-row-tools" aria-label={actionsLabel}>
          {actions}
        </span>
      ) : null}
    </div>
  );
}
