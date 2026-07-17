import { ListChecks, Loader2, PanelBottom, PanelBottomClose, PanelRightClose, PanelRightOpen, RefreshCw, UserPlus } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { CurrentSessionHeaderCapabilitySlot } from "../../shared/current-session/CurrentSessionHeaderCapability.js";
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
  readonly settingsLoading: boolean;
  readonly settingsPageOpen: boolean;
  readonly settingsRefreshDisabled: boolean;
  readonly settingsRefreshLabel: string;
  readonly showEmptyTeammateAction: boolean;
  readonly teammateActionNode?: ReactNode;
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
  settingsLoading,
  settingsPageOpen,
  settingsRefreshDisabled,
  settingsRefreshLabel,
  showEmptyTeammateAction,
  teammateActionNode,
}: ChannelHeaderToolbarProps): JSX.Element {
  return (
    <WorkspaceTopRightToolbar className="channel-header-actions" ariaLabel={ariaLabel}>
      <CurrentSessionHeaderCapabilitySlot />
      {settingsPageOpen ? (
        <button className="secondary-button compact-button channel-settings-refresh-button" type="button" onClick={onRefreshSettings} disabled={settingsRefreshDisabled}>
          {settingsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {settingsRefreshLabel}
        </button>
      ) : environmentPageOpen ? null : (
        <>
          {teammateActionNode}
          {governanceActionNode}
          {showEmptyTeammateAction ? (
            <WorkspaceToolbarIconButton
              ref={emptyTeammateActionRef}
              active={emptyTeammateActionActive}
              className="icon-button task-toolbar-teammates"
              disabled={emptyTeammateActionDisabled}
              aria-expanded={emptyTeammateActionActive}
              icon={<UserPlus size={15} />}
              label={emptyTeammateActionLabel}
              onClick={onToggleEmptyTeammateAction}
            />
          ) : null}
          <WorkspaceToolbarIconButton
            active={progressActive}
            className="icon-button task-toolbar-progress"
            icon={<ListChecks size={15} />}
            label={progressLabel}
            onClick={onToggleProgress}
          />
          <WorkspaceToolbarIconButton
            active={bottomPanelOpen}
            className="icon-button task-toolbar-bottom-panel"
            disabled={bottomPanelDisabled}
            aria-expanded={bottomPanelOpen}
            icon={bottomPanelOpen ? <PanelBottomClose size={15} /> : <PanelBottom size={15} />}
            label={bottomPanelLabel}
            onClick={onToggleBottomPanel}
          />
          <WorkspaceToolbarIconButton
            active={detailsOpen}
            className="icon-button task-toolbar-panel"
            aria-expanded={detailsOpen}
            icon={detailsOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            label={detailsLabel}
            onClick={onToggleDetails}
          />
        </>
      )}
    </WorkspaceTopRightToolbar>
  );
}
