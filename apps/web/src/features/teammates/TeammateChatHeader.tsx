import type { CSSProperties, Ref } from "react";
import { MoreHorizontal, PanelRightOpen, PencilLine, SlidersHorizontal } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { AiTeammate } from "../../types.js";
import {
  ConversationSummaryPopover,
  ConversationHeaderSearch,
  ConversationTopToolbar,
  type ConversationSummaryRow,
} from "../workspace/right-dock/index.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";
import { teammateStatusPresentation } from "./teammate-status-presentation.js";

export function TeammateChatHeader({
  cwd,
  teammate,
  attachmentCount,
  searchInputRef,
  searchOpen,
  searchQuery,
  searchTriggerRef,
  summaryOpen,
  summaryVisible,
  summaryDockOffset,
  summaryDockResizing,
  summaryDockMotion,
  summaryDockState,
  summaryRows,
  terminalOpen,
  terminalDisabled,
  detailsOpen,
  detailsDisabled,
  moreButtonRef,
  onToggleSearch,
  onCloseSearch,
  onSearchQueryChange,
  onClearSearch,
  onOpenAttachments,
  onOpenSettings,
  onOpenRename,
  onOpenContext,
  onToggleSummary,
  onCloseSummary,
  onToggleTerminal,
  onToggleDetails,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly attachmentCount: number;
  readonly searchInputRef: Ref<HTMLInputElement>;
  readonly searchOpen: boolean;
  readonly searchQuery: string;
  readonly searchTriggerRef: Ref<HTMLButtonElement>;
  readonly summaryOpen: boolean;
  readonly summaryVisible: boolean;
  readonly summaryDockOffset: number;
  readonly summaryDockResizing: boolean;
  readonly summaryDockMotion?: string;
  readonly summaryDockState: "closed" | "opening" | "open" | "closing" | "resizing";
  readonly summaryRows: readonly ConversationSummaryRow[];
  readonly terminalOpen: boolean;
  readonly terminalDisabled?: boolean;
  readonly detailsOpen: boolean;
  readonly detailsDisabled?: boolean;
  readonly moreButtonRef: Ref<HTMLButtonElement>;
  readonly onToggleSearch: () => void;
  readonly onCloseSearch: () => void;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onClearSearch: () => void;
  readonly onOpenAttachments: () => void;
  readonly onOpenSettings: (section: "profile" | "model") => void;
  readonly onOpenRename: () => void;
  readonly onOpenContext: () => void;
  readonly onToggleSummary: () => void;
  readonly onCloseSummary: () => void;
  readonly onToggleTerminal: () => void;
  readonly onToggleDetails: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const lifecycleStatus = teammate.status === "active" ? undefined : teammateStatusPresentation(teammate.status);
  return (
    <section
      className={[
        "teammate-chat-header",
        searchOpen ? "searching" : "",
        summaryVisible ? "summary-open" : "",
      ].filter(Boolean).join(" ")}
      aria-label={t("AI teammate private chat")}
      data-desktop-window-drag-region="true"
      data-ui2-teammate-chat-header="true"
    >
      <div className="teammate-workspace-identity">
        <TeammateAvatarView teammate={teammate} cwd={cwd} />
        <div className="teammate-chat-identity-copy">
          <h1>{teammate.displayName}</h1>
          <Menu modal={false}>
            <MenuTrigger asChild>
              <IconButton
                ref={moreButtonRef}
                className="teammate-chat-more-button"
                icon={MoreHorizontal}
                label={t("More private chat views")}
                tooltip=""
              />
            </MenuTrigger>
            <MenuContent align="start" className="teammate-chat-more-menu">
              <MenuItem onSelect={() => onOpenSettings("profile")}>
                <span className="ling-ui-menu-item-icon" aria-hidden="true"><SlidersHorizontal /></span>
                <span>{t("Settings")}</span>
              </MenuItem>
              <MenuItem onSelect={onOpenRename}>
                <span className="ling-ui-menu-item-icon" aria-hidden="true"><PencilLine /></span>
                <span>{t("Rename teammate")}</span>
              </MenuItem>
              <MenuItem onSelect={onOpenContext}>
                <span className="ling-ui-menu-item-icon" aria-hidden="true"><PanelRightOpen /></span>
                <span>{t("Context")}</span>
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
      {searchOpen ? (
        <ConversationHeaderSearch
          ariaLabel={t("Search private messages")}
          className="teammate-chat-search"
          clearLabel={t("Clear search")}
          inputRef={searchInputRef}
          placeholder={t("Search private messages")}
          value={searchQuery}
          onChange={onSearchQueryChange}
          onClear={onClearSearch}
          onEscape={onCloseSearch}
        />
      ) : null}
      <ConversationTopToolbar
        ariaLabel={t("Private chat actions")}
        searchActive={searchOpen}
        searchButtonRef={searchTriggerRef}
        searchLabel={t("Search")}
        fileCount={attachmentCount}
        filesLabel={t("{label}: {count}", { label: t("Private attachments"), count: attachmentCount })}
        summaryActive={summaryOpen}
        summaryExpanded={summaryVisible}
        summaryLabel={t("Summary")}
        terminalActive={terminalOpen}
        terminalDisabled={terminalDisabled}
        terminalLabel={t("Terminal")}
        detailsActive={detailsOpen}
        detailsDisabled={detailsDisabled}
        detailsLabel={detailsOpen ? t("Hide details") : t("Show details")}
        onToggleSearch={onToggleSearch}
        onOpenFiles={onOpenAttachments}
        onToggleSummary={onToggleSummary}
        onToggleTerminal={onToggleTerminal}
        onToggleDetails={onToggleDetails}
      />
      {lifecycleStatus ? (
        <div className="teammate-chat-alert-row" role="status">
          <StatusIndicator
            className="teammate-chat-lifecycle-status"
            label={t(lifecycleStatus.labelKey)}
            tone={lifecycleStatus.tone}
          />
        </div>
      ) : null}
      <ConversationSummaryPopover
        open={summaryVisible}
        title={t("Environment")}
        subtitle={teammate.displayName}
        rows={summaryRows}
        className="teammate-chat-summary-popover teammate-private-summary-panel"
        dockOffset={summaryDockOffset}
        dockMotion={summaryDockMotion}
        motionState={summaryDockResizing ? "resizing" : summaryDockState}
        onClose={onCloseSummary}
      />
    </section>
  );
}
