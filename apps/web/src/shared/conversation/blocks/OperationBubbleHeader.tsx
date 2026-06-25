import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export interface OperationBubbleHeaderProps {
  readonly icon: ReactNode;
  readonly sourceLabel: string;
  readonly statusLabel: string;
  readonly actions?: ReactNode;
  readonly expandable?: boolean;
  readonly expanded?: boolean;
  readonly toggleLabel?: string;
  readonly onToggleExpanded?: () => void;
}

export function OperationBubbleHeader({
  icon,
  sourceLabel,
  statusLabel,
  actions,
  expandable = false,
  expanded = true,
  toggleLabel,
  onToggleExpanded,
}: OperationBubbleHeaderProps): JSX.Element {
  return (
    <header className="conversation-operation-bubble-header">
      {expandable ? (
        <button
          className="conversation-operation-bubble-toggle"
          type="button"
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggleExpanded}
        >
          <ChevronRight size={13} aria-hidden="true" />
        </button>
      ) : null}
      <span className="conversation-operation-bubble-kind" aria-hidden="true">
        {icon}
      </span>
      <span className="conversation-operation-bubble-copy">
        <span className="conversation-operation-bubble-source">{sourceLabel}</span>
      </span>
      <span className="conversation-operation-bubble-status">{statusLabel}</span>
      {actions}
    </header>
  );
}
