import { MessageSquare } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { useI18n } from "../../i18n.js";
import { ConversationHeaderSearch, ConversationTopToolbar } from "./right-dock/index.js";

export interface NormalConversationHeaderProps {
  readonly title: string;
  readonly searchInputRef: Ref<HTMLInputElement>;
  readonly searchOpen: boolean;
  readonly searchQuery: string;
  readonly searchTriggerRef: Ref<HTMLButtonElement>;
  readonly summaryActive: boolean;
  readonly summaryExpanded: boolean;
  readonly terminalActive: boolean;
  readonly terminalDisabled: boolean;
  readonly detailsActive: boolean;
  readonly summaryNode?: ReactNode;
  readonly onClearSearch: () => void;
  readonly onCloseSearch: () => void;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onToggleSearch: () => void;
  readonly onToggleSummary: () => void;
  readonly onToggleTerminal: () => void;
  readonly onToggleDetails: () => void;
}

export function NormalConversationHeader({
  title,
  searchInputRef,
  searchOpen,
  searchQuery,
  searchTriggerRef,
  summaryActive,
  summaryExpanded,
  terminalActive,
  terminalDisabled,
  detailsActive,
  summaryNode,
  onClearSearch,
  onCloseSearch,
  onSearchQueryChange,
  onToggleSearch,
  onToggleSummary,
  onToggleTerminal,
  onToggleDetails,
}: NormalConversationHeaderProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <header
      className={searchOpen ? "normal-conversation-header searching" : "normal-conversation-header"}
      data-desktop-window-drag-region="true"
      data-ui2-normal-conversation-header="true"
    >
      <div className="normal-conversation-identity">
        <MessageSquare aria-hidden="true" size={17} />
        <h1 title={title}>{title}</h1>
      </div>
      {searchOpen ? (
        <ConversationHeaderSearch
          ariaLabel={t("Search conversation messages")}
          className="normal-conversation-search"
          clearLabel={t("Clear search")}
          inputRef={searchInputRef}
          placeholder={t("Search conversation messages")}
          value={searchQuery}
          onChange={onSearchQueryChange}
          onClear={onClearSearch}
          onEscape={onCloseSearch}
        />
      ) : null}
      <ConversationTopToolbar
        ariaLabel={t("Conversation workspace toolbar")}
        searchActive={searchOpen}
        searchButtonRef={searchTriggerRef}
        searchLabel={t("Search")}
        summaryActive={summaryActive}
        summaryExpanded={summaryExpanded}
        summaryLabel={t("Summary")}
        terminalActive={terminalActive}
        terminalDisabled={terminalDisabled}
        terminalLabel={t("Terminal")}
        detailsActive={detailsActive}
        detailsLabel={detailsActive ? t("Hide details") : t("Show details")}
        onToggleSearch={onToggleSearch}
        onToggleSummary={onToggleSummary}
        onToggleTerminal={onToggleTerminal}
        onToggleDetails={onToggleDetails}
      />
      {summaryNode}
    </header>
  );
}
