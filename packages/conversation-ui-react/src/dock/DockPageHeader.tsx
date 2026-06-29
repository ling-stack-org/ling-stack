import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

export interface DockPageHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly canGoBack: boolean;
  readonly backLabel?: string;
  readonly actions?: ReactNode;
  readonly filters?: ReactNode;
  readonly onBack: () => void;
}

export function DockPageHeader({
  title,
  subtitle,
  canGoBack,
  backLabel = "Back",
  actions,
  filters,
  onBack,
}: DockPageHeaderProps): JSX.Element {
  return (
    <div className="right-dock-page-header">
      <div className="right-dock-page-header-row">
        {canGoBack ? (
          <button className="right-dock-back-button" type="button" onClick={onBack} aria-label={backLabel} title={backLabel}>
            <ChevronLeft size={16} />
          </button>
        ) : null}
        <span className="right-dock-page-title">
          <strong>{title}</strong>
          {subtitle ? <small>{subtitle}</small> : null}
        </span>
        {actions ? <div className="right-dock-page-actions">{actions}</div> : null}
      </div>
      {filters ? <div className="right-dock-page-filters">{filters}</div> : null}
    </div>
  );
}
