import {
  Archive,
  CircleAlert,
  GitBranch,
  Loader2,
  Pin,
  PinOff,
  Search,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { LingThread } from "../../types.js";

interface ChannelWorkThreadTreeRow {
  readonly thread: LingThread;
  readonly depth: number;
  readonly parentHidden: boolean;
}

interface ChannelWorkThreadTreeProps {
  readonly selectedChannelId: string;
  readonly activeWorkThreadId: string;
  readonly visibleThreads: readonly LingThread[];
  readonly rows: readonly ChannelWorkThreadTreeRow[];
  readonly loading: boolean;
  readonly error: string;
  readonly search: string;
  readonly searchActive: boolean;
  readonly rootThread: LingThread | undefined;
  readonly forkingWorkThreadId: string;
  readonly workThreadVisibilityId: string;
  readonly archiveConfirmWorkThreadId: string;
  readonly onSearchChange: (value: string) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly onForkMainBranch: () => void;
  readonly onForkThread: (thread: LingThread) => void;
  readonly onSetArchiveConfirmWorkThreadId: (threadId: string) => void;
  readonly onMutateThreadVisibility: (thread: LingThread, action: "archive" | "pin" | "unpin") => void;
}

export function ChannelWorkThreadTree({
  selectedChannelId,
  activeWorkThreadId,
  visibleThreads,
  rows,
  loading,
  error,
  search,
  searchActive,
  rootThread,
  forkingWorkThreadId,
  workThreadVisibilityId,
  archiveConfirmWorkThreadId,
  onSearchChange,
  onSelectThread,
  onForkMainBranch,
  onForkThread,
  onSetArchiveConfirmWorkThreadId,
  onMutateThreadVisibility,
}: ChannelWorkThreadTreeProps): JSX.Element {
  const { t } = useI18n();
  const mainBranchForkId = `channel-main:${selectedChannelId}`;
  return (
    <div className="channel-work-thread-tree" aria-label={t("Channel branches")}>
      <div className="channel-work-thread-tree-head">
        <span>
          <GitBranch size={14} />
          {t("Conversation branches")}
        </span>
        {loading ? (
          <small><Loader2 className="spin" size={12} /> {t("Loading")}</small>
        ) : null}
      </div>
      {visibleThreads.length > 0 || searchActive ? (
        <label className="activity-search-field channel-work-thread-search-field">
          <Search size={14} />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("Search branches")}
            aria-label={t("Search branches")}
          />
        </label>
      ) : null}
      {error ? (
        <div className="inline-error compact">
          <CircleAlert size={14} />
          {error}
        </div>
      ) : null}
      <div className="channel-work-thread-row-list">
        {!rootThread && !searchActive ? (
          <div className={!activeWorkThreadId ? "channel-work-thread-row-shell selected" : "channel-work-thread-row-shell"}>
            <button
              className="channel-work-thread-row"
              type="button"
              onClick={() => onSelectThread("")}
            >
              <span className="sidebar-hash" aria-hidden="true">#</span>
              <span className="channel-work-thread-row-main">
                <strong>{t("Main branch")}</strong>
                <small>{t("Default channel branch")}</small>
              </span>
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={t("Fork branch")}
              title={t("Fork branch")}
              disabled={forkingWorkThreadId === mainBranchForkId}
              onClick={onForkMainBranch}
            >
              {forkingWorkThreadId === mainBranchForkId ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />}
            </button>
          </div>
        ) : null}
        {visibleThreads.length > 0 || searchActive ? (
          <button
            className={!activeWorkThreadId ? "channel-work-thread-row selected" : "channel-work-thread-row"}
            type="button"
            onClick={() => onSelectThread("")}
          >
            <span className="sidebar-hash" aria-hidden="true">#</span>
            <span className="channel-work-thread-row-main">
              <strong>{t("All branches")}</strong>
              <small>{t("{count} branches", { count: visibleThreads.length })}</small>
            </span>
          </button>
        ) : null}
        {rows.map(({ thread, depth, parentHidden }) => (
          <div
            key={thread.id}
            className={activeWorkThreadId === thread.id ? "channel-work-thread-row-shell selected" : "channel-work-thread-row-shell"}
            style={{ paddingLeft: `${8 + depth * 18}px` }}
          >
            <button
              className="channel-work-thread-row"
              type="button"
              onClick={() => onSelectThread(thread.id)}
            >
              <span className={`status-dot ${thread.status}`} />
              <span className="channel-work-thread-row-main">
                <strong>{thread.title}</strong>
                <small>
                  {thread.parentThreadId ? `${t("Fork branch")} · ` : ""}
                  {parentHidden ? `${t("Parent hidden")} · ` : ""}
                  {thread.pinnedAt ? `${t("Pinned")} · ` : ""}
                  {thread.archivedAt || thread.status === "archived" ? `${t("Archived")} · ` : ""}
                  {thread.lastRunId ?? thread.id}
                </small>
              </span>
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={thread.pinnedAt ? t("Unpin") : t("Pin")}
              title={thread.pinnedAt ? t("Unpin") : t("Pin")}
              disabled={workThreadVisibilityId === thread.id}
              onClick={() => onMutateThreadVisibility(thread, thread.pinnedAt ? "unpin" : "pin")}
            >
              {workThreadVisibilityId === thread.id ? <Loader2 className="spin" size={14} /> : thread.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={t("Fork branch")}
              title={t("Fork branch")}
              disabled={forkingWorkThreadId === thread.id || thread.status === "archived" || Boolean(thread.archivedAt)}
              onClick={() => onForkThread(thread)}
            >
              {forkingWorkThreadId === thread.id ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />}
            </button>
            {archiveConfirmWorkThreadId === thread.id ? (
              <>
                <button
                  className="secondary-button compact-button danger"
                  type="button"
                  disabled={workThreadVisibilityId === thread.id}
                  onClick={() => onMutateThreadVisibility(thread, "archive")}
                >
                  {workThreadVisibilityId === thread.id ? <Loader2 className="spin" size={14} /> : <Archive size={14} />}
                  {t("Confirm")}
                </button>
                <button
                  className="secondary-button compact-button"
                  type="button"
                  disabled={workThreadVisibilityId === thread.id}
                  onClick={() => onSetArchiveConfirmWorkThreadId("")}
                >
                  {t("Cancel")}
                </button>
              </>
            ) : (
              <button
                className="icon-button"
                type="button"
                aria-label={t("Archive")}
                title={t("Archive")}
                disabled={workThreadVisibilityId === thread.id || thread.status === "archived" || Boolean(thread.archivedAt)}
                onClick={() => onSetArchiveConfirmWorkThreadId(thread.id)}
              >
                <Archive size={14} />
              </button>
            )}
          </div>
        ))}
        {searchActive && rows.length === 0 ? (
          <div className="empty-state compact-empty">
            <Search />
            <span>{t("No active branches match")}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
