import type { CSSProperties, Ref } from "react";
import { useI18n } from "../../i18n.js";
import { ConversationStatusStrip } from "../../shared/conversation/index.js";
import { StatusIndicator } from "../../shared/ui/index.js";
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
  providerReady,
  memoryScopeCount,
  attachmentCount,
  refreshing,
  refreshDisabled,
  searchInputRef,
  searchOpen,
  searchQuery,
  searchTriggerRef,
  summaryOpen,
  summaryDockOffset,
  summaryDockResizing,
  summaryDockMotion,
  summaryDockState,
  summaryRows,
  terminalOpen,
  terminalDisabled,
  detailsOpen,
  onToggleSearch,
  onCloseSearch,
  onSearchQueryChange,
  onClearSearch,
  onRefresh,
  onToggleSummary,
  onCloseSummary,
  onToggleTerminal,
  onToggleDetails,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly providerReady: boolean;
  readonly memoryScopeCount: number;
  readonly attachmentCount: number;
  readonly refreshing: boolean;
  readonly refreshDisabled: boolean;
  readonly searchInputRef: Ref<HTMLInputElement>;
  readonly searchOpen: boolean;
  readonly searchQuery: string;
  readonly searchTriggerRef: Ref<HTMLButtonElement>;
  readonly summaryOpen: boolean;
  readonly summaryDockOffset: number;
  readonly summaryDockResizing: boolean;
  readonly summaryDockMotion?: string;
  readonly summaryDockState: "closed" | "opening" | "open" | "closing" | "resizing";
  readonly summaryRows: readonly ConversationSummaryRow[];
  readonly terminalOpen: boolean;
  readonly terminalDisabled?: boolean;
  readonly detailsOpen: boolean;
  readonly onToggleSearch: () => void;
  readonly onCloseSearch: () => void;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onClearSearch: () => void;
  readonly onRefresh: () => void | Promise<void>;
  readonly onToggleSummary: () => void;
  readonly onCloseSummary: () => void;
  readonly onToggleTerminal: () => void;
  readonly onToggleDetails: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const lifecycleStatus = teammate.status === "active" ? undefined : teammateStatusPresentation(teammate.status);
  return (
    <section
      className={[
        "teammate-chat-header",
        searchOpen ? "searching" : "",
        summaryOpen ? "summary-open" : "",
      ].filter(Boolean).join(" ")}
      aria-label={t("AI teammate private chat")}
      data-desktop-window-drag-region="true"
      data-ui2-teammate-chat-header="true"
    >
      <div className="teammate-workspace-identity">
        <TeammateAvatarView teammate={teammate} cwd={cwd} />
        <div>
          <span className="teammate-pack-label">{t(`role.${teammate.roleKey}`)}</span>
          <h1>{teammate.displayName}</h1>
          <p>{t("Private conversation only visible between you and {name}", { name: teammate.displayName })}</p>
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
        refreshDisabled={refreshDisabled}
        refreshLabel={t("Refresh")}
        refreshLoading={refreshing}
        summaryActive={summaryOpen}
        summaryLabel={t("Summary")}
        terminalActive={terminalOpen}
        terminalDisabled={terminalDisabled}
        terminalLabel={t("Terminal")}
        detailsActive={detailsOpen}
        detailsLabel={detailsOpen ? t("Hide details") : t("Show details")}
        onToggleSearch={onToggleSearch}
        onRefresh={() => void onRefresh()}
        onToggleSummary={onToggleSummary}
        onToggleTerminal={onToggleTerminal}
        onToggleDetails={onToggleDetails}
      />
      <ConversationStatusStrip
        className="teammate-chat-status-row"
        title={providerReady ? t("Model ready") : t("Model needs setup")}
        statusNode={lifecycleStatus ? (
          <StatusIndicator
            className="teammate-chat-lifecycle-status"
            label={t(lifecycleStatus.labelKey)}
            tone={lifecycleStatus.tone}
          />
        ) : null}
        metaItems={[
          { id: "recall", value: memoryScopeCount > 0 ? t("Memory on") : t("Memory preparing") },
          { id: "attachments", value: t("{count} attachments", { count: attachmentCount }) },
        ]}
      />
      <ConversationSummaryPopover
        open={summaryOpen}
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
