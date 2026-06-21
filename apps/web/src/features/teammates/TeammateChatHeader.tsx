import { PanelRightClose, PanelRightOpen, RefreshCw, Search, Settings, X } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n.js";
import { StatusBadge } from "../../shared/components/index.js";
import { ConversationStatusStrip } from "../../shared/conversation/index.js";
import type { AiTeammate } from "../../types.js";
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
  contextPanelOpen,
  onToggleSearch,
  onSearchQueryChange,
  onClearSearch,
  onRefresh,
  onOpenSettings,
  onToggleContextPanel,
  toolbarStart,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly providerReady: boolean;
  readonly memoryScopeCount: number;
  readonly attachmentCount: number;
  readonly loading: boolean;
  readonly searchOpen: boolean;
  readonly searchQuery: string;
  readonly contextPanelOpen: boolean;
  readonly onToggleSearch: () => void;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onClearSearch: () => void;
  readonly onRefresh: () => void | Promise<void>;
  readonly onOpenSettings: () => void;
  readonly onToggleContextPanel: () => void;
  readonly toolbarStart?: ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section
      className={[
        "teammate-chat-header",
        searchOpen ? "searching" : "",
        toolbarStart ? "has-toolbar-start" : "",
      ].filter(Boolean).join(" ")}
      aria-label={t("AI teammate private chat")}
    >
      {toolbarStart ? <div className="teammate-chat-toolbar-start">{toolbarStart}</div> : null}
      <div className="teammate-workspace-identity">
        <TeammateAvatarView teammate={teammate} cwd={cwd} />
        <div>
          <span className="teammate-pack-label">{t(`role.${teammate.roleKey}`)}</span>
          <h1>{teammate.displayName}</h1>
          <p>{t("Private conversation only visible between you and {name}", { name: teammate.displayName })}</p>
        </div>
      </div>
      <div className="teammate-chat-actions" aria-label={t("Private chat actions")}>
        <button
          className={searchOpen ? "secondary-button compact-button active" : "secondary-button compact-button"}
          type="button"
          onClick={onToggleSearch}
          title={t("Search private messages")}
          aria-label={t("Search private messages")}
        >
          <Search size={15} />
        </button>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => void onRefresh()}
          disabled={loading}
          title={t("Refresh teammate workspace")}
          aria-label={t("Refresh teammate workspace")}
        >
          <RefreshCw size={15} className={loading ? "spin" : undefined} />
        </button>
        <button
          className="secondary-button compact-button"
          type="button"
          title={t("Settings")}
          aria-label={t("Settings")}
          onClick={onOpenSettings}
        >
          <Settings size={15} />
        </button>
        <button
          className={contextPanelOpen ? "secondary-button compact-button active" : "secondary-button compact-button"}
          type="button"
          aria-expanded={contextPanelOpen}
          aria-label={contextPanelOpen ? t("Hide details") : t("Show details")}
          title={contextPanelOpen ? t("Hide details") : t("Show details")}
          onClick={onToggleContextPanel}
        >
          {contextPanelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
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
    </section>
  );
}
