import { ListChecks, PanelBottom, PanelBottomClose, PanelRightClose, PanelRightOpen, RefreshCw, Search } from "lucide-react";
import {
  WorkspaceToolbarIconButton,
  WorkspaceTopRightToolbar,
} from "./WorkspaceTopRightToolbar.js";

export interface ConversationTopToolbarProps {
  readonly ariaLabel: string;
  readonly searchActive: boolean;
  readonly searchLabel: string;
  readonly refreshDisabled?: boolean;
  readonly refreshLabel: string;
  readonly refreshLoading?: boolean;
  readonly summaryActive: boolean;
  readonly summaryDisabled?: boolean;
  readonly summaryLabel: string;
  readonly terminalActive: boolean;
  readonly terminalDisabled?: boolean;
  readonly terminalLabel: string;
  readonly detailsActive: boolean;
  readonly detailsLabel: string;
  readonly onToggleSearch: () => void;
  readonly onRefresh: () => void;
  readonly onToggleSummary: () => void;
  readonly onToggleTerminal: () => void;
  readonly onToggleDetails: () => void;
}

export function ConversationTopToolbar({
  ariaLabel,
  searchActive,
  searchLabel,
  refreshDisabled = false,
  refreshLabel,
  refreshLoading = false,
  summaryActive,
  summaryDisabled = false,
  summaryLabel,
  terminalActive,
  terminalDisabled = false,
  terminalLabel,
  detailsActive,
  detailsLabel,
  onToggleSearch,
  onRefresh,
  onToggleSummary,
  onToggleTerminal,
  onToggleDetails,
}: ConversationTopToolbarProps): JSX.Element {
  return (
    <WorkspaceTopRightToolbar className="conversation-top-toolbar" ariaLabel={ariaLabel}>
      <WorkspaceToolbarIconButton
        active={searchActive}
        className="icon-button conversation-toolbar-search"
        icon={<Search size={15} />}
        label={searchLabel}
        onClick={onToggleSearch}
      />
      <WorkspaceToolbarIconButton
        className="icon-button conversation-toolbar-refresh"
        disabled={refreshDisabled || refreshLoading}
        icon={<RefreshCw size={15} className={refreshLoading ? "spin" : undefined} />}
        label={refreshLabel}
        onClick={onRefresh}
      />
      <WorkspaceToolbarIconButton
        active={summaryActive}
        className="icon-button conversation-toolbar-summary task-toolbar-progress"
        disabled={summaryDisabled}
        icon={<ListChecks size={15} />}
        label={summaryLabel}
        onClick={onToggleSummary}
      />
      <WorkspaceToolbarIconButton
        active={terminalActive}
        className="icon-button conversation-toolbar-terminal task-toolbar-bottom-panel"
        disabled={terminalDisabled}
        icon={terminalActive ? <PanelBottomClose size={15} /> : <PanelBottom size={15} />}
        label={terminalLabel}
        onClick={onToggleTerminal}
      />
      <WorkspaceToolbarIconButton
        active={detailsActive}
        className="icon-button conversation-toolbar-details task-toolbar-panel"
        aria-expanded={detailsActive}
        icon={detailsActive ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        label={detailsLabel}
        onClick={onToggleDetails}
      />
    </WorkspaceTopRightToolbar>
  );
}
