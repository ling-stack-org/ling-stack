import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { IconButton } from "@ling-stack/ui-react";

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
}: DockPageHeaderProps): React.JSX.Element {
  return (
    <div className="right-dock-page-header">
      <div className="right-dock-page-header-row">
        {canGoBack ? (
          <IconButton
            className="right-dock-back-button"
            icon={ChevronLeft}
            label={backLabel}
            onClick={onBack}
            size="sm"
          />
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
