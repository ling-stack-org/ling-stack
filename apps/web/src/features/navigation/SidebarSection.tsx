import { ChevronDown, type LucideIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  IconButton,
  Skeleton,
  StatusIndicator,
} from "../../shared/ui/index.js";
import { SidebarSectionMenu, type SidebarSectionMenuItem } from "./SidebarSectionMenu.js";

export type SidebarSectionId = "channels" | "teammates" | "recent";

export function SidebarSection({
  children,
  collapsed,
  count,
  menuItems,
  menuLabel,
  menuOpen,
  menuTriggerRef,
  onMenuOpenChange,
  onRailActivate,
  onToggleCollapsed,
  railActive = false,
  railCollapsed = false,
  railIcon,
  sectionId,
  stale = false,
  staleLabel,
  title,
}: {
  readonly children: ReactNode;
  readonly collapsed: boolean;
  readonly count: number;
  readonly menuItems?: readonly SidebarSectionMenuItem[];
  readonly menuLabel?: string;
  readonly menuOpen?: boolean;
  readonly menuTriggerRef?: Ref<HTMLButtonElement>;
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly onRailActivate: (sectionId: SidebarSectionId) => void;
  readonly onToggleCollapsed: (sectionId: SidebarSectionId) => void;
  readonly railActive?: boolean;
  readonly railCollapsed?: boolean;
  readonly railIcon: LucideIcon;
  readonly sectionId: SidebarSectionId;
  readonly stale?: boolean;
  readonly staleLabel: string;
  readonly title: string;
}): React.JSX.Element {
  const sectionClassName = [
    "sidebar-section",
    `sidebar-section-${sectionId}`,
    railCollapsed ? "rail-collapsed" : "",
    collapsed ? "collapsed" : "expanded",
  ].filter(Boolean).join(" ");

  if (railCollapsed) {
    return (
      <section className={sectionClassName} data-sidebar-section={sectionId}>
        <span className="sidebar-rail-launcher-shell">
          <IconButton
            className="sidebar-rail-launcher"
            data-sidebar-rail-launcher={sectionId}
            icon={railIcon}
            label={title}
            onClick={() => onRailActivate(sectionId)}
            pressed={railActive}
          />
          {stale ? (
            <StatusIndicator
              aria-label={`${title}: ${staleLabel}`}
              className="sidebar-rail-launcher-status"
              compact
              label={staleLabel}
              role="status"
              tone="warning"
            />
          ) : null}
        </span>
      </section>
    );
  }

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
              {stale ? (
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
        <div className="sidebar-section-body">
          <CollapsibleContent className="sidebar-section-list">
            {children}
          </CollapsibleContent>
        </div>
      </section>
    </Collapsible>
  );
}

export function SidebarSectionSkeleton({ label, rows }: { readonly label: string; readonly rows: number }): React.JSX.Element {
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
