import { ChevronDown } from "lucide-react";
import type { ReactNode, Ref } from "react";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Skeleton,
  Spinner,
  StatusIndicator,
} from "../../shared/ui/index.js";
import { SidebarSectionMenu, type SidebarSectionMenuItem } from "./SidebarSectionMenu.js";

export type SidebarSectionId = "channels" | "teammates" | "recent";

export function SidebarSection({
  children,
  collapsed,
  count,
  loading = false,
  loadingLabel,
  menuItems,
  menuLabel,
  menuOpen,
  menuTriggerRef,
  onMenuOpenChange,
  onToggleCollapsed,
  railCollapsed = false,
  railCollapsedPreview,
  sectionId,
  stale = false,
  staleLabel,
  title,
}: {
  readonly children: ReactNode;
  readonly collapsed: boolean;
  readonly count: number;
  readonly loading?: boolean;
  readonly loadingLabel: string;
  readonly menuItems?: readonly SidebarSectionMenuItem[];
  readonly menuLabel?: string;
  readonly menuOpen?: boolean;
  readonly menuTriggerRef?: Ref<HTMLButtonElement>;
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly onToggleCollapsed: (sectionId: SidebarSectionId) => void;
  readonly railCollapsed?: boolean;
  readonly railCollapsedPreview?: ReactNode;
  readonly sectionId: SidebarSectionId;
  readonly stale?: boolean;
  readonly staleLabel: string;
  readonly title: string;
}): JSX.Element {
  const sectionClassName = [
    "sidebar-section",
    `sidebar-section-${sectionId}`,
    railCollapsed ? "rail-collapsed" : "",
    collapsed ? "collapsed" : "expanded",
  ].filter(Boolean).join(" ");

  return (
    <Collapsible asChild open={!collapsed} onOpenChange={() => onToggleCollapsed(sectionId)}>
      <section className={sectionClassName} data-sidebar-section={sectionId}>
        <div className="sidebar-section-title">
          <CollapsibleTrigger asChild>
            <Button
              className="sidebar-section-toggle"
              aria-label={title}
              title={title}
              trailingIcon={(
                <ChevronDown
                  className={collapsed ? "sidebar-section-chevron collapsed" : "sidebar-section-chevron"}
                  size={12}
                />
              )}
              variant="ghost"
            >
              <span className="sidebar-section-heading">{title}</span>
            </Button>
          </CollapsibleTrigger>
          {!railCollapsed ? (
            <span className="sidebar-section-status">
              {loading ? <Spinner label={loadingLabel} size="sm" /> : stale ? (
                <StatusIndicator
                  aria-label={`${title}: ${staleLabel}`}
                  compact
                  label={staleLabel}
                  role="status"
                  tone="warning"
                />
              ) : <span className="sidebar-section-count" aria-hidden="true">{count}</span>}
            </span>
          ) : null}
          {menuItems && menuItems.length > 0 && menuLabel && onMenuOpenChange ? (
            <SidebarSectionMenu
              items={menuItems}
              label={menuLabel}
              open={Boolean(menuOpen)}
              onOpenChange={onMenuOpenChange}
              triggerRef={menuTriggerRef}
            />
          ) : null}
        </div>
        <div className={railCollapsed ? "sidebar-rail-section-body" : "sidebar-section-body"}>
          {railCollapsed && railCollapsedPreview ? (
            <div className="sidebar-rail-preview" aria-hidden={!collapsed}>{railCollapsedPreview}</div>
          ) : null}
          <CollapsibleContent className="sidebar-section-list">
            {children}
          </CollapsibleContent>
        </div>
      </section>
    </Collapsible>
  );
}

export function SidebarSectionSkeleton({ label, rows }: { readonly label: string; readonly rows: number }): JSX.Element {
  return (
    <span className="sidebar-section-skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="sidebar-section-skeleton-row">
          <Skeleton height={22} shape="circle" width={22} />
          <Skeleton height={12} width={`${72 - index * 8}%`} />
        </span>
      ))}
    </span>
  );
}
