import { FileText, ListChecks, PanelBottom, PanelBottomClose, PanelRightClose, PanelRightOpen, RefreshCw, Search } from "lucide-react";
import type { Ref } from "react";
import { CurrentSessionHeaderCapabilitySlot } from "../../../shared/current-session/CurrentSessionHeaderCapability.js";
import {
  WorkspaceToolbarIconButton,
  WorkspaceTopRightToolbar,
} from "./WorkspaceTopRightToolbar.js";

export interface ConversationTopToolbarProps {
  readonly ariaLabel: string;
  readonly searchActive: boolean;
  readonly searchButtonRef?: Ref<HTMLButtonElement>;
  readonly searchLabel: string;
  readonly refreshDisabled?: boolean;
  readonly refreshLabel: string;
  readonly refreshLoading?: boolean;
  readonly fileCount?: number;
  readonly filesLabel?: string;
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
  readonly onOpenFiles?: () => void;
  readonly onToggleSummary: () => void;
  readonly onToggleTerminal: () => void;
  readonly onToggleDetails: () => void;
}

export function ConversationTopToolbar({
  ariaLabel,
  searchActive,
  searchButtonRef,
  searchLabel,
  refreshDisabled = false,
  refreshLabel,
  refreshLoading = false,
  fileCount = 0,
  filesLabel,
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
  onOpenFiles,
  onToggleSummary,
  onToggleTerminal,
  onToggleDetails,
}: ConversationTopToolbarProps): JSX.Element {
  const TerminalIcon = terminalActive ? PanelBottomClose : PanelBottom;
  const DetailsIcon = detailsActive ? PanelRightClose : PanelRightOpen;

  return (
    <WorkspaceTopRightToolbar className="conversation-top-toolbar" ariaLabel={ariaLabel}>
      <CurrentSessionHeaderCapabilitySlot />
      <WorkspaceToolbarIconButton
        ref={searchButtonRef}
        actionId="search"
        active={searchActive}
        className="conversation-toolbar-search"
        icon={Search}
        label={searchLabel}
        onClick={onToggleSearch}
      />
      <WorkspaceToolbarIconButton
        actionId="refresh"
        className="conversation-toolbar-refresh"
        disabled={refreshDisabled}
        icon={RefreshCw}
        label={refreshLabel}
        loading={refreshLoading}
        loadingLabel={refreshLabel}
        onClick={onRefresh}
      />
      <WorkspaceToolbarIconButton
        actionId="summary"
        active={summaryActive}
        className="conversation-toolbar-summary task-toolbar-progress"
        disabled={summaryDisabled}
        icon={ListChecks}
        label={summaryLabel}
        onClick={onToggleSummary}
      />
      {fileCount > 0 && filesLabel && onOpenFiles ? (
        <WorkspaceToolbarIconButton
          actionId="files"
          className="conversation-toolbar-files"
          count={fileCount}
          icon={FileText}
          label={filesLabel}
          onClick={onOpenFiles}
        />
      ) : null}
      <WorkspaceToolbarIconButton
        actionId="terminal"
        active={terminalActive}
        className="conversation-toolbar-terminal task-toolbar-bottom-panel"
        disabled={terminalDisabled}
        icon={TerminalIcon}
        label={terminalLabel}
        onClick={onToggleTerminal}
      />
      <WorkspaceToolbarIconButton
        actionId="details"
        active={detailsActive}
        className="conversation-toolbar-details task-toolbar-panel"
        aria-expanded={detailsActive}
        icon={DetailsIcon}
        label={detailsLabel}
        onClick={onToggleDetails}
      />
    </WorkspaceTopRightToolbar>
  );
}
