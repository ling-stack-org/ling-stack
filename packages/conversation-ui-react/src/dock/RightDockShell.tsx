import type { ReactNode } from "react";
import type { DockPageKind, DockPageStackEntry, DockSurfaceKind } from "@ling-stack/conversation-ui-core";
import { activeDockPage, createDockPageEntry } from "@ling-stack/conversation-ui-core";
import { ChevronLeft, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { IconButton } from "@ling-stack/ui-react";
import { DockLauncher, type DockLauncherPageItem } from "./DockLauncher.js";

export interface RightDockPageManifest {
  readonly id: DockPageKind;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly launcherItem?: Omit<DockLauncherPageItem, "id" | "label" | "icon">;
  readonly hiddenFromLauncher?: boolean;
  readonly headerActions?: ReactNode;
  readonly headerFilters?: ReactNode;
  readonly render: (entry: DockPageStackEntry) => ReactNode;
}

export interface RightDockShellProps {
  readonly surface: DockSurfaceKind;
  readonly open: boolean;
  readonly collapsed?: boolean;
  readonly ariaLabel: string;
  readonly stack: readonly DockPageStackEntry[];
  readonly pages: readonly RightDockPageManifest[];
  readonly launcherTitle: string;
  readonly launcherSubtitle?: string;
  readonly closeLabel?: string;
  readonly collapseLabel?: string;
  readonly expandLabel?: string;
  readonly backLabel?: string;
  readonly actions?: ReactNode;
  readonly onClose?: () => void;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  readonly onNavigate: (entry: DockPageStackEntry) => void;
  readonly onBack: () => void;
  readonly className?: string;
}

export function RightDockShell({
  surface,
  open,
  collapsed = false,
  ariaLabel,
  stack,
  pages,
  launcherTitle,
  launcherSubtitle,
  closeLabel = "Close",
  collapseLabel = "Collapse",
  expandLabel = "Expand",
  backLabel = "Back",
  actions,
  onClose,
  onCollapsedChange,
  onNavigate,
  onBack,
  className,
}: RightDockShellProps): React.JSX.Element | null {
  if (!open) {
    return null;
  }

  const activeEntry = activeDockPage(stack);
  const activeManifest = activeEntry ? pages.find((page) => page.id === activeEntry.page) : undefined;
  const launcherPages = pages.filter((page) => page.launcherItem && !page.hiddenFromLauncher);
  const CollapseIcon = collapsed ? PanelRightOpen : PanelRightClose;
  const rootClassName = [
    "right-dock",
    `right-dock-${surface}`,
    activeEntry ? "is-page-mode" : "",
    collapsed ? "is-collapsed" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <aside className={rootClassName} aria-label={ariaLabel} data-ui2-right-dock="true">
      <div className="right-dock-head">
        {activeEntry && activeManifest ? (
          <span className="right-dock-head-page">
            {stack.length > 0 ? (
              <IconButton
                className="right-dock-back-button"
                icon={ChevronLeft}
                label={backLabel}
                onClick={onBack}
                size="sm"
              />
            ) : null}
            <span className="right-dock-page-title">
              <strong>{activeEntry.title}</strong>
              {activeEntry.subtitle ? <small>{activeEntry.subtitle}</small> : null}
            </span>
          </span>
        ) : (
          <span className="right-dock-head-title">
            <strong>{launcherTitle}</strong>
            {launcherSubtitle ? <small>{launcherSubtitle}</small> : null}
          </span>
        )}
        <span className="right-dock-head-actions">
          {activeEntry && activeManifest ? activeManifest.headerActions : null}
          {!activeEntry || activeEntry.page !== "detail" ? actions : null}
          {onCollapsedChange ? (
            <IconButton
              className="right-dock-icon-button"
              icon={CollapseIcon}
              label={collapsed ? expandLabel : collapseLabel}
              onClick={() => onCollapsedChange(!collapsed)}
              size="sm"
            />
          ) : null}
          {onClose ? (
            <IconButton
              className="right-dock-icon-button"
              icon={X}
              label={closeLabel}
              onClick={onClose}
              size="sm"
            />
          ) : null}
        </span>
      </div>
      {!collapsed ? (
        activeEntry && activeManifest ? (
          <div className="right-dock-body right-dock-page-body" data-ui2-dock-page={activeEntry.page}>
            {activeManifest.headerFilters ? <div className="right-dock-page-filters">{activeManifest.headerFilters}</div> : null}
            {activeManifest.render(activeEntry)}
          </div>
        ) : (
          <div className="right-dock-body">
            <DockLauncher
              title={launcherTitle}
              subtitle={launcherSubtitle}
              items={launcherPages.map((page) => ({
                ...page.launcherItem!,
                id: page.id,
                label: page.label,
                icon: page.icon,
              }))}
              onOpenPage={(page) => {
                const manifest = pages.find((candidate) => candidate.id === page);
                if (!manifest?.launcherItem || manifest.hiddenFromLauncher || manifest.launcherItem.disabled) {
                  return;
                }
                onNavigate(createDockPageEntry({ page, title: manifest.label, subtitle: manifest.launcherItem.statusLabel }));
              }}
            />
          </div>
        )
      ) : null}
    </aside>
  );
}
