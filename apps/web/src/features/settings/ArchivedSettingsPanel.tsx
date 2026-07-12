import { useEffect, useState, type ReactNode } from "react";
import { CircleAlert, Loader2, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { AiTeammate, Channel, ChannelBranch, LingThread } from "../../types.js";
import { SettingsSubnav, type SettingsSubnavOption } from "./SettingsSubnav.js";
import type { ArchivedSettingsControllerActions, ArchivedSettingsControllerState } from "./useArchivedSettingsController.js";

type ArchivedCategoryId = "conversations" | "teammates" | "channels" | "branches";

const archivedCategoryStorageKey = "ling-stack.settings.archived-category";
const archivedCategoryIds: readonly ArchivedCategoryId[] = ["conversations", "teammates", "channels", "branches"];

function readArchivedCategoryPreference(): ArchivedCategoryId {
  try {
    const saved = globalThis.localStorage?.getItem(archivedCategoryStorageKey);
    return archivedCategoryIds.includes(saved as ArchivedCategoryId) ? saved as ArchivedCategoryId : "conversations";
  } catch {
    return "conversations";
  }
}

function matchesArchivedSearch(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

export function ArchivedSettingsPanel({
  state,
  actions,
}: {
  readonly state: ArchivedSettingsControllerState;
  readonly actions: ArchivedSettingsControllerActions;
}): JSX.Element {
  const { t } = useI18n();
  const [activeCategory, setActiveCategory] = useState<ArchivedCategoryId>(readArchivedCategoryPreference);
  const [searchQuery, setSearchQuery] = useState("");

  const categoryOptions: readonly SettingsSubnavOption[] = [
    { id: "conversations", label: "Conversations", badge: String(state.archivedConversations.length) },
    { id: "teammates", label: "AI Teammates", badge: String(state.archivedTeammates.length) },
    { id: "channels", label: "Channels", badge: String(state.archivedChannels.length) },
    { id: "branches", label: "Branches", badge: String(state.archivedBranches.length) },
  ];
  const activeLabel = categoryOptions.find((option) => option.id === activeCategory)?.label ?? "Conversations";
  const normalizedQuery = searchQuery.trim();

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(archivedCategoryStorageKey, activeCategory);
    } catch {
      // Local preference persistence is best-effort.
    }
  }, [activeCategory]);

  const clearSearch = (): void => {
    setSearchQuery("");
  };

  const changeCategory = (categoryId: string): void => {
    if (!archivedCategoryIds.includes(categoryId as ArchivedCategoryId)) {
      return;
    }
    clearSearch();
    setActiveCategory(categoryId as ArchivedCategoryId);
  };

  const activeRows = activeCategory === "conversations"
    ? state.archivedConversations
      .filter((thread) => !normalizedQuery || matchesArchivedSearch(thread.title || t("Conversation"), normalizedQuery))
      .map((thread) => (
        <ArchivedConversationRow
          key={thread.id}
          thread={thread}
          actionId={state.actionId}
          onRestore={() => void actions.restoreConversation(thread.id)}
          onDelete={() => {
            const title = thread.title || t("Conversation");
            if (window.confirm(`${t("Delete conversation {title}?", { title })}\n${t("This permanently deletes messages, attachments, goals, and plans. Historical runs remain but will no longer be linked to this conversation.")}`)) {
              void actions.deleteConversation(thread);
            }
          }}
        />
      ))
    : activeCategory === "teammates"
      ? state.archivedTeammates
        .filter((teammate) => !normalizedQuery || matchesArchivedSearch(teammate.displayName, normalizedQuery))
        .map((teammate) => (
          <ArchivedTeammateRow
            key={teammate.id}
            teammate={teammate}
            actionId={state.actionId}
            onRestore={() => void actions.restoreTeammate(teammate.id)}
            onDelete={() => {
              if (window.confirm(`${t("Delete AI teammate {name}?", { name: teammate.displayName })}\n${t("This permanently deletes private chat, attachments, avatar, memory, and private bindings. Channel and run history keep a deleted teammate reference.")}`)) {
                void actions.deleteTeammate(teammate);
              }
            }}
          />
        ))
      : activeCategory === "channels"
        ? state.archivedChannels
          .filter((channel) => !normalizedQuery || matchesArchivedSearch(channel.name, normalizedQuery))
          .map((channel) => (
            <ArchivedChannelRow
              key={channel.id}
              channel={channel}
              actionId={state.actionId}
              onRestore={() => void actions.restoreChannel(channel.id)}
              onDelete={() => {
                if (window.confirm(`${t("Delete channel")} ${channel.name}?\n${t("This cannot be undone")}`)) {
                  void actions.deleteChannel(channel);
                }
              }}
            />
          ))
        : state.archivedBranches
          .filter((branch) => {
            if (!normalizedQuery) {
              return true;
            }
            const parent = state.archiveParentChannelById.get(branch.channelId);
            return matchesArchivedSearch(parent ? `${parent.name} ${branch.name}` : branch.name, normalizedQuery);
          })
          .map((branch) => (
            <ArchivedBranchRow
              key={branch.id}
              branch={branch}
              parent={state.archiveParentChannelById.get(branch.channelId)}
              actionId={state.actionId}
              onRestore={() => void actions.restoreBranch(branch)}
              onDelete={() => {
                if (window.confirm(`${t("Delete branch")} ${branch.name}?\n${t("This cannot be undone")}`)) {
                  void actions.deleteBranch(branch);
                }
              }}
            />
          ));

  const emptyLabel = normalizedQuery
    ? t("No matching archived items")
    : activeCategory === "conversations"
      ? state.isLoading ? t("Loading archived conversations...") : t("No archived conversations")
      : activeCategory === "teammates"
        ? state.isLoading ? t("Loading archived teammates...") : t("No archived teammates")
        : activeCategory === "channels"
          ? state.isLoading ? t("Loading archived channels...") : t("No archived channels")
          : state.isLoading ? t("Loading archived branches...") : t("No archived branches");

  return (
    <section className="panel settings-panel archived-items-settings-panel" aria-label={t("Archived items")}>

      {state.errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {state.errorMessage}
        </div>
      ) : null}

      <div className="archived-items-toolbar">
        <SettingsSubnav
          label="Archived item categories"
          options={categoryOptions}
          activeId={activeCategory}
          onChange={changeCategory}
        />
        <div className="archived-items-search">
          <Search size={15} />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                clearSearch();
              }
            }}
            aria-label={t("Search archived items")}
            placeholder={t("Search archived items")}
          />
          {searchQuery ? (
              <button
                className="ghost-icon-button compact-icon-button"
                type="button"
                onClick={clearSearch}
                aria-label={t("Clear search")}
                title={t("Clear search")}
              >
                <X size={14} />
              </button>
          ) : null}
        </div>
      </div>

      <ArchivedItemList label={t(activeLabel)} emptyLabel={emptyLabel}>
        {activeRows}
      </ArchivedItemList>

    </section>
  );
}

function ArchivedConversationRow({
  thread,
  actionId,
  onRestore,
  onDelete,
}: {
  readonly thread: LingThread;
  readonly actionId: string;
  readonly onRestore: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const archivedAt = thread.archivedAt ?? thread.updatedAt;
  return (
    <div className="archived-item-row">
      <div className="archived-item-main">
        <strong>{thread.title || t("Conversation")}</strong>
      </div>
      <time className="archived-item-time" dateTime={archivedAt}>{formatDateTime(archivedAt)}</time>
      <div className="archived-item-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRestore} disabled={actionId !== ""}>
          {actionId === `conversation:${thread.id}:restore` ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          <span className="archived-action-label">{t("Restore")}</span>
        </button>
        <button
          className="ghost-icon-button danger-ghost-button compact-icon-button archived-delete-action"
          type="button"
          onClick={onDelete}
          disabled={actionId !== ""}
          aria-label={t("Delete conversation")}
          title={t("Delete conversation")}
        >
          {actionId === `conversation:${thread.id}:delete` ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  );
}

function ArchivedTeammateRow({
  teammate,
  actionId,
  onRestore,
  onDelete,
}: {
  readonly teammate: AiTeammate;
  readonly actionId: string;
  readonly onRestore: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const archivedAt = teammate.updatedAt;
  return (
    <div className="archived-item-row">
      <div className="archived-item-main">
        <strong>{teammate.displayName}</strong>
      </div>
      <time className="archived-item-time" dateTime={archivedAt}>{formatDateTime(archivedAt)}</time>
      <div className="archived-item-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRestore} disabled={actionId !== ""}>
          {actionId === `teammate:${teammate.id}:restore` ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          <span className="archived-action-label">{t("Restore")}</span>
        </button>
        <button
          className="ghost-icon-button danger-ghost-button compact-icon-button archived-delete-action"
          type="button"
          onClick={onDelete}
          disabled={actionId !== ""}
          aria-label={t("Delete AI teammate")}
          title={t("Delete AI teammate")}
        >
          {actionId === `teammate:${teammate.id}:delete` ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  );
}

function ArchivedChannelRow({
  channel,
  actionId,
  onRestore,
  onDelete,
}: {
  readonly channel: Channel;
  readonly actionId: string;
  readonly onRestore: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const archivedAt = channel.updatedAt;
  return (
    <div className="archived-item-row">
      <div className="archived-item-main">
        <strong>{channel.name}</strong>
      </div>
      <time className="archived-item-time" dateTime={archivedAt}>{formatDateTime(archivedAt)}</time>
      <div className="archived-item-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRestore} disabled={actionId !== ""}>
          {actionId === `channel:${channel.id}:restore` ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          <span className="archived-action-label">{t("Restore")}</span>
        </button>
        <button
          className="ghost-icon-button danger-ghost-button compact-icon-button archived-delete-action"
          type="button"
          onClick={onDelete}
          disabled={actionId !== ""}
          aria-label={t("Delete channel")}
          title={t("Delete channel")}
        >
          {actionId === `channel:${channel.id}:delete` ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  );
}

function ArchivedBranchRow({
  branch,
  parent,
  actionId,
  onRestore,
  onDelete,
}: {
  readonly branch: ChannelBranch;
  readonly parent: Channel | undefined;
  readonly actionId: string;
  readonly onRestore: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const parentArchived = parent?.status === "archived";
  const archivedAt = branch.archivedAt ?? branch.updatedAt;
  return (
    <div className="archived-item-row">
      <div className="archived-item-main">
        <strong>{parent ? `${parent.name} / ${branch.name}` : branch.name}</strong>
      </div>
      <time className="archived-item-time" dateTime={archivedAt}>{formatDateTime(archivedAt)}</time>
      <div className="archived-item-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRestore} disabled={actionId !== ""}>
          {actionId === `branch:${branch.id}:restore` ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          <span className="archived-action-label">{parentArchived ? t("Restore both") : t("Restore")}</span>
        </button>
        <button
          className="ghost-icon-button danger-ghost-button compact-icon-button archived-delete-action"
          type="button"
          onClick={onDelete}
          disabled={actionId !== ""}
          aria-label={t("Delete branch")}
          title={t("Delete branch")}
        >
          {actionId === `branch:${branch.id}:delete` ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  );
}

function ArchivedItemList({
  label,
  emptyLabel,
  children,
}: {
  readonly label: string;
  readonly emptyLabel: string;
  readonly children: ReactNode;
}): JSX.Element {
  const hasItems = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="archived-item-list" role="tabpanel" aria-label={label}>
      {hasItems ? children : (
        <div className="empty-state compact-empty archived-item-empty">
          <span>{emptyLabel}</span>
        </div>
      )}
    </div>
  );
}
