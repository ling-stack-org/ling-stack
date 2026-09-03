import { Folder, GitBranch } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { formatDateTime } from "../../lib/formatting.js";
import type { SidebarObjectContext } from "../../app/sidebar-object-context.js";
import { Icon } from "../../shared/ui/index.js";

export function SidebarObjectPreview({
  context,
  title,
}: {
  readonly context: SidebarObjectContext;
  readonly title: string;
}): React.JSX.Element {
  return (
    <span className="sidebar-object-preview">
      <SidebarObjectPreviewLine emphasis>{title}</SidebarObjectPreviewLine>
      {context.git ? (
        <>
          <SidebarObjectPreviewLine leading={<Icon icon={Folder} size="xs" />}>
            {context.git.repositoryLabel}
          </SidebarObjectPreviewLine>
          <SidebarObjectPreviewLine leading={<Icon icon={GitBranch} size="xs" />}>
            {context.git.branchName}
          </SidebarObjectPreviewLine>
        </>
      ) : null}
      <SidebarObjectPreviewLine dateTime={context.activityAt}>
        {formatDateTime(context.activityAt)}
      </SidebarObjectPreviewLine>
    </span>
  );
}

function SidebarObjectPreviewLine({
  children,
  dateTime,
  emphasis = false,
  leading,
}: {
  readonly children: ReactNode;
  readonly dateTime?: string;
  readonly emphasis?: boolean;
  readonly leading?: ReactNode;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return undefined;

    const measure = (): void => {
      const nextOverflow = Math.max(0, Math.ceil(track.scrollWidth - viewport.clientWidth));
      setOverflow((current) => current === nextOverflow ? current : nextOverflow);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(track);
    return () => observer.disconnect();
  }, [children]);

  const scrollDuration = Math.min(3200, Math.max(700, overflow * 20));
  const line = (
    <>
      {leading ? <span className="sidebar-object-preview-line-leading">{leading}</span> : null}
      <span ref={viewportRef} className="sidebar-object-preview-line-viewport">
        <span ref={trackRef} className="sidebar-object-preview-line-track">{children}</span>
      </span>
    </>
  );
  const props = {
    className: `sidebar-object-preview-line${emphasis ? " is-title" : ""}`,
    "data-sidebar-preview-overflow": overflow > 0 ? "true" : "false",
    style: {
      "--sidebar-preview-scroll-distance": `${overflow}px`,
      "--sidebar-preview-scroll-duration": `${scrollDuration}ms`,
    } as CSSProperties,
  };

  if (emphasis) return <strong {...props}>{line}</strong>;
  if (dateTime) return <time {...props} dateTime={dateTime}>{line}</time>;
  return <span {...props}>{line}</span>;
}
