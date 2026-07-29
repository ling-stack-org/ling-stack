import { ListChecks, Loader2, PanelBottom, PanelBottomClose, PanelRightClose, PanelRightOpen, RefreshCw, Search, UserPlus } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { CurrentSessionHeaderCapabilitySlot } from "../../shared/current-session/CurrentSessionHeaderCapability.js";
import { Icon } from "../../shared/ui/index.js";
import {
  WorkspaceToolbarIconButton,
  WorkspaceTopRightToolbar,
} from "./right-dock/index.js";

export interface ChannelHeaderToolbarProps {
  readonly ariaLabel: string;
  readonly bottomPanelDisabled: boolean;
  readonly bottomPanelLabel: string;
  readonly bottomPanelOpen: boolean;
  readonly detailsLabel: string;
  readonly detailsOpen: boolean;
  readonly emptyTeammateActionActive: boolean;
  readonly emptyTeammateActionDisabled: boolean;
  readonly emptyTeammateActionLabel: string;
  readonly emptyTeammateActionRef: Ref<HTMLButtonElement>;
  readonly environmentPageOpen: boolean;
  readonly governanceActionNode?: ReactNode;
  readonly onRefreshSettings: () => void;
  readonly onToggleBottomPanel: () => void;
  readonly onToggleDetails: () => void;
  readonly onToggleEmptyTeammateAction: () => void;
  readonly onToggleProgress: () => void;
  readonly progressActive: boolean;
  readonly progressLabel: string;
  readonly refreshDisabled: boolean;
  readonly refreshLabel: string;
  readonly refreshLoading: boolean;
  readonly searchActive: boolean;
  readonly searchDisabled: boolean;
  readonly searchLabel: string;
  readonly settingsLoading: boolean;
  readonly settingsPageOpen: boolean;
  readonly settingsRefreshDisabled: boolean;
  readonly settingsRefreshLabel: string;
  readonly showEmptyTeammateAction: boolean;
  readonly teammateActionNode?: ReactNode;
  readonly onRefresh: () => void;
  readonly onToggleSearch: () => void;
}

export function ChannelHeaderToolbar({
  ariaLabel,
  bottomPanelDisabled,
  bottomPanelLabel,
  bottomPanelOpen,
  detailsLabel,
  detailsOpen,
  emptyTeammateActionActive,
  emptyTeammateActionDisabled,
  emptyTeammateActionLabel,
  emptyTeammateActionRef,
  environmentPageOpen,
  governanceActionNode,
  onRefreshSettings,
  onToggleBottomPanel,
  onToggleDetails,
  onToggleEmptyTeammateAction,
  onToggleProgress,
  progressActive,
  progressLabel,
  refreshDisabled,
  refreshLabel,
  refreshLoading,
  searchActive,
  searchDisabled,
  searchLabel,
  settingsLoading,
  settingsPageOpen,
  settingsRefreshDisabled,
  settingsRefreshLabel,
  showEmptyTeammateAction,
  teammateActionNode,
  onRefresh,
  onToggleSearch,
}: ChannelHeaderToolbarProps): JSX.Element {
  const BottomPanelIcon = bottomPanelOpen ? PanelBottomClose : PanelBottom;
  const DetailsIcon = detailsOpen ? PanelRightClose : PanelRightOpen;

  return (
    <WorkspaceTopRightToolbar className="channel-header-actions" ariaLabel={ariaLabel}>
      <CurrentSessionHeaderCapabilitySlot />
      {settingsPageOpen ? (
        <button className="secondary-button compact-button channel-settings-refresh-button" type="button" onClick={onRefreshSettings} disabled={settingsRefreshDisabled}>
          {settingsLoading ? <Loader2 className="spin" size={14} /> : <Icon icon={RefreshCw} size="xs" />}
          {settingsRefreshLabel}
        </button>
      ) : environmentPageOpen ? null : (
        <>
          <WorkspaceToolbarIconButton
            actionId="search"
            active={searchActive}
            className="channel-toolbar-search"
            disabled={searchDisabled}
            icon={Search}
            label={searchLabel}
            onClick={onToggleSearch}
          />
          <WorkspaceToolbarIconButton
            actionId="refresh"
            className="channel-toolbar-refresh"
            disabled={refreshDisabled}
            icon={RefreshCw}
            label={refreshLabel}
            loading={refreshLoading}
            loadingLabel={refreshLabel}
            onClick={onRefresh}
          />
          {teammateActionNode}
          {governanceActionNode}
          {showEmptyTeammateAction ? (
            <WorkspaceToolbarIconButton
              actionId="teammates"
              ref={emptyTeammateActionRef}
              active={emptyTeammateActionActive}
              className="task-toolbar-teammates"
              disabled={emptyTeammateActionDisabled}
              aria-expanded={emptyTeammateActionActive}
              icon={UserPlus}
              label={emptyTeammateActionLabel}
              onClick={onToggleEmptyTeammateAction}
            />
          ) : null}
          <WorkspaceToolbarIconButton
            actionId="summary"
            active={progressActive}
            className="task-toolbar-progress"
            icon={ListChecks}
            label={progressLabel}
            onClick={onToggleProgress}
          />
          <WorkspaceToolbarIconButton
            actionId="terminal"
            active={bottomPanelOpen}
            className="task-toolbar-bottom-panel"
            disabled={bottomPanelDisabled}
            aria-expanded={bottomPanelOpen}
            icon={BottomPanelIcon}
            label={bottomPanelLabel}
            onClick={onToggleBottomPanel}
          />
          <WorkspaceToolbarIconButton
            actionId="details"
            active={detailsOpen}
            className="task-toolbar-panel"
            aria-expanded={detailsOpen}
            icon={DetailsIcon}
            label={detailsLabel}
            onClick={onToggleDetails}
          />
        </>
      )}
    </WorkspaceTopRightToolbar>
  );
}
