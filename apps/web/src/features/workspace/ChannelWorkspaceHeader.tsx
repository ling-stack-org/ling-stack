import type { CSSProperties, ReactNode, Ref } from "react";
import type { ChannelSessionSummary, UpdateChannelSessionRequest } from "@ling-stack/contracts";
import { ChannelSessionHeading } from "./ChannelSessionHeading.js";
import { ArrowLeft, Command, Info, MoreHorizontal, PencilLine, SlidersHorizontal } from "lucide-react";
import { DesktopTitlebarSurface } from "../../app/DesktopTitlebarSurface.js";
import { useI18n } from "../../i18n.js";
import type { ChannelSidePanelView } from "./workspace-client-view.types.js";

export interface ChannelWorkspaceHeaderProps {
  readonly channelName?: string;
  readonly sessionTitle?: string;
  readonly sessionStatusNode?: ReactNode;
  readonly session?: ChannelSessionSummary;
  readonly onUpdateSession?: (patch: UpdateChannelSessionRequest) => Promise<void>;
  readonly sessionActionsDisabled?: boolean;
  readonly sessionScope?: string;
  readonly channelSelected: boolean;
  readonly channelSettingsPageOpen: boolean;
  readonly channelEnvironmentPageOpen: boolean;
  readonly searchOpen: boolean;
  readonly channelMoreOpen: boolean;
  readonly channelMoreRef: Ref<HTMLDivElement>;
  readonly channelMoreButtonRef: Ref<HTMLButtonElement>;
  readonly sidePanelOpen: boolean;
  readonly sidePanelView: ChannelSidePanelView;
  readonly activityToolsOpen: boolean;
  readonly style: CSSProperties;
  readonly searchNode: ReactNode;
  readonly toolbarNode: ReactNode;
  readonly summaryNode: ReactNode;
  readonly onCloseSearch: () => void;
  readonly setChannelMoreOpen: (open: boolean) => void;
  readonly openChannelSettingsPage: () => void;
  readonly closeChannelSettingsPage: () => void;
  readonly openChannelEnvironmentPage: () => void;
  readonly closeChannelEnvironmentPage: () => void;
  readonly openChannelRenameDialog: () => void;
  readonly openSidePanelView: (view: ChannelSidePanelView) => void;
  readonly onOpenActivityFilters: () => void;
}

export function ChannelWorkspaceHeader({
  channelName, sessionTitle, sessionStatusNode, session, onUpdateSession, sessionActionsDisabled, sessionScope, channelSelected, channelSettingsPageOpen, channelEnvironmentPageOpen, searchOpen,
  channelMoreOpen, channelMoreRef, channelMoreButtonRef, sidePanelOpen, sidePanelView,
  activityToolsOpen, style, searchNode, toolbarNode, summaryNode, onCloseSearch, setChannelMoreOpen,
  openChannelSettingsPage, closeChannelSettingsPage, openChannelEnvironmentPage, closeChannelEnvironmentPage,
  openChannelRenameDialog, openSidePanelView, onOpenActivityFilters,
}: ChannelWorkspaceHeaderProps): React.JSX.Element {
  const { t } = useI18n();
  const channelUtilityPageOpen = channelSettingsPageOpen || channelEnvironmentPageOpen;
  return <DesktopTitlebarSurface><header className={[
    "channel-header task-workbench-header", channelUtilityPageOpen ? "settings-page-header" : "",
    searchOpen && !channelUtilityPageOpen ? "channel-header-searching" : "",
  ].filter(Boolean).join(" ")} style={style} data-desktop-window-drag-region="true">
        <div className="channel-title-area">
          {channelSettingsPageOpen ? (
            <div className="channel-settings-header-line">
              <button className="channel-settings-top-back" type="button" onClick={closeChannelSettingsPage}>
                <ArrowLeft size={16} />
                {t("Back to channel")}
              </button>
              <div className="channel-settings-header-title">
                <span>
                  <SlidersHorizontal size={17} />
                  <strong>{t("Channel settings")}</strong>
                </span>
              </div>
            </div>
          ) : channelEnvironmentPageOpen ? (
            <div className="channel-settings-header-line">
              <button className="channel-settings-top-back" type="button" onClick={closeChannelEnvironmentPage}>
                <ArrowLeft size={16} />
                {t("Back to channel")}
              </button>
              <div className="channel-settings-header-title">
                <span>
                  <Command size={17} />
                  <strong>{t("Environment")}</strong>
                </span>
              </div>
            </div>
          ) : (
            <div className="channel-title-line">
              <span className="channel-title-icon" aria-hidden="true">#</span>
              <ChannelSessionHeading key={sessionScope} channelName={channelName ?? "Engineering"} title={sessionTitle}
                session={session} onUpdate={onUpdateSession} disabled={sessionActionsDisabled} />
              {sessionStatusNode}
              <div className="channel-more-wrap" ref={channelMoreRef}>
                <button
                  ref={channelMoreButtonRef}
                  className={channelMoreOpen ? "icon-button channel-more-button active" : "icon-button channel-more-button"}
                  type="button"
                  aria-expanded={channelMoreOpen}
                  aria-label={t("More channel views")}
                  title={t("More channel views")}
                  onClick={() => {
                    const nextOpen = !channelMoreOpen;
                    if (nextOpen) {
                      onCloseSearch();
                    }
                    setChannelMoreOpen(nextOpen);
                  }}
                >
                  <MoreHorizontal size={17} />
                </button>
                {channelMoreOpen ? (
                  <div className="channel-more-menu" role="menu" aria-label={t("More channel views")}>
                    <button
                      className={channelSettingsPageOpen ? "channel-more-item active" : "channel-more-item"}
                      type="button"
                      role="menuitem"
                      onClick={openChannelSettingsPage}
                    >
                      <SlidersHorizontal size={15} />
                      <span>{t("Settings")}</span>
                    </button>
                    <button
                      className="channel-more-item"
                      type="button"
                      role="menuitem"
                      onClick={openChannelRenameDialog}
                      disabled={!channelSelected}
                    >
                      <PencilLine size={15} />
                      <span>{t("Rename channel")}</span>
                    </button>
                    <button
                      className={channelEnvironmentPageOpen ? "channel-more-item active" : "channel-more-item"}
                      type="button"
                      role="menuitem"
                      onClick={openChannelEnvironmentPage}
                    >
                      <Command size={15} />
                      <span>{t("Environment")}</span>
                    </button>
                    {["context" as const].map((view) => (
                      <button
                        key={view}
                        className={sidePanelOpen && sidePanelView === view ? "channel-more-item active" : "channel-more-item"}
                        type="button"
                        role="menuitem"
                        onClick={() => openSidePanelView(view)}
                      >
                        <Info size={15} />
                        <span>{t("Context")}</span>
                      </button>
                    ))}
                    <button
                      className={activityToolsOpen ? "channel-more-item active" : "channel-more-item"}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onOpenActivityFilters();
                      }}
                    >
                      <SlidersHorizontal size={15} />
                      <span>{t("Filter channel events")}</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
    {searchNode}{toolbarNode}{summaryNode}
  </header></DesktopTitlebarSurface>;
}
