import { Search, X } from "lucide-react";
import type { RefCallback } from "react";
import { useI18n } from "../../i18n.js";
import { StatusBadge } from "../../shared/components/index.js";
import { ConversationStatusStrip } from "../../shared/conversation/index.js";
import type { AiTeammate } from "../../types.js";
import {
  ConversationSummaryPopover,
  ConversationTopToolbar,
  type ConversationSummaryRow,
} from "../workspace/right-dock/index.js";
import { TeammateAvatarView } from "./TeammateAvatarView.js";

export function TeammateChatHeader({
  cwd,
  teammate,
  providerReady,
  memoryScopeCount,
  attachmentCount,
  loading,
  searchOpen,
  searchQuery,
  summaryOpen,
  summaryShouldRender,
  summaryMotionClass,
  summaryPlacementRef,
  summaryRows,
  terminalOpen,
  terminalDisabled,
  detailsOpen,
  onToggleSearch,
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
  readonly loading: boolean;
  readonly searchOpen: boolean;
  readonly searchQuery: string;
  readonly summaryOpen: boolean;
  readonly summaryShouldRender: boolean;
  readonly summaryMotionClass: "is-popover-expanded" | "is-popover-collapsed";
  readonly summaryPlacementRef: RefCallback<HTMLElement>;
  readonly summaryRows: readonly ConversationSummaryRow[];
  readonly terminalOpen: boolean;
  readonly terminalDisabled?: boolean;
  readonly detailsOpen: boolean;
  readonly onToggleSearch: () => void;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onClearSearch: () => void;
  readonly onRefresh: () => void | Promise<void>;
  readonly onToggleSummary: () => void;
  readonly onCloseSummary: () => void;
  readonly onToggleTerminal: () => void;
  readonly onToggleDetails: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const summaryShouldRenderInHeader = summaryShouldRender && !detailsOpen;
  return (
    <section
      className={[
        "teammate-chat-header",
        searchOpen ? "searching" : "",
        summaryOpen ? "summary-open" : "",
      ].filter(Boolean).join(" ")}
      aria-label={t("AI teammate private chat")}
    >
      <div className="teammate-workspace-identity">
        <TeammateAvatarView teammate={teammate} cwd={cwd} />
        <div>
          <span className="teammate-pack-label">{t(`role.${teammate.roleKey}`)}</span>
          <h1>{teammate.displayName}</h1>
          <p>{t("Private conversation only visible between you and {name}", { name: teammate.displayName })}</p>
        </div>
      </div>
      <ConversationTopToolbar
        ariaLabel={t("Private chat actions")}
        searchActive={searchOpen}
        searchLabel={t("Search")}
        refreshDisabled={loading}
        refreshLabel={t("Refresh")}
        refreshLoading={loading}
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
        statusNode={teammate.status === "active" ? null : <StatusBadge status={teammate.status} />}
        metaItems={[
          { id: "recall", label: t("Memory"), value: memoryScopeCount > 0 ? t("Memory on") : t("Memory preparing") },
          { id: "attachments", label: t("Files"), value: t("{count} attachments", { count: attachmentCount }) },
        ]}
      />
      {searchOpen ? (
        <label className="teammate-chat-search">
          <Search size={14} />
          <input value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} placeholder={t("Search private messages")} />
          {searchQuery ? (
            <button type="button" onClick={onClearSearch} aria-label={t("Clear search")}>
              <X size={14} />
          </button>
        ) : null}
      </label>
      ) : null}
      {summaryShouldRenderInHeader ? (
        <div
          ref={summaryPlacementRef}
          className={`channel-progress-popover conversation-summary-popover-wrap teammate-chat-summary-popover ${summaryMotionClass}`}
        >
          <ConversationSummaryPopover
            title={t("Environment")}
            subtitle={teammate.displayName}
            rows={summaryRows}
            onClose={onCloseSummary}
          />
        </div>
      ) : null}
    </section>
  );
}
