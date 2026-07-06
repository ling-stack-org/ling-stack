import type { ReactNode } from "react";
import { Archive, Bot, CircleAlert, Loader2, MessageSquare, RefreshCw, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { AiTeammate, Channel, ChannelBranch, LingThread } from "../../types.js";
import type { ArchivedSettingsControllerActions, ArchivedSettingsControllerState } from "./useArchivedSettingsController.js";

export function ArchivedSettingsPanel({
  state,
  actions,
}: {
  readonly state: ArchivedSettingsControllerState;
  readonly actions: ArchivedSettingsControllerActions;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <section className="panel settings-panel archived-items-settings-panel" aria-labelledby="archived-items-settings-title">
      <div className="panel-title split">
        <span>
          <Archive size={18} />
          <h2 id="archived-items-settings-title">{t("Archived items")}</h2>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={() => void actions.refresh()} disabled={state.isLoading}>
          {state.isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          {t("Refresh")}
        </button>
      </div>

      {state.errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {state.errorMessage}
        </div>
      ) : null}

      <ArchivedItemGroup
        title={t("Conversations")}
        countLabel={t("{count} archived", { count: state.archivedConversations.length })}
        emptyLabel={state.isLoading ? t("Loading archived conversations...") : t("No archived conversations")}
      >
        {state.archivedConversations.map((thread) => (
          <ArchivedConversationRow
            key={thread.id}
            thread={thread}
            actionId={state.actionId}
            onRestore={() => void actions.restoreConversation(thread.id)}
          />
        ))}
      </ArchivedItemGroup>

      <ArchivedItemGroup
        title={t("AI Teammates")}
        countLabel={t("{count} archived", { count: state.archivedTeammates.length })}
        emptyLabel={state.isLoading ? t("Loading archived teammates...") : t("No archived teammates")}
      >
        {state.archivedTeammates.map((teammate) => (
          <ArchivedTeammateRow
            key={teammate.id}
            teammate={teammate}
            actionId={state.actionId}
            onRestore={() => void actions.restoreTeammate(teammate.id)}
          />
        ))}
      </ArchivedItemGroup>

      <ArchivedItemGroup
        title={t("Channels")}
        countLabel={t("{count} archived", { count: state.archivedChannels.length })}
        emptyLabel={state.isLoading ? t("Loading archived channels...") : t("No archived channels")}
      >
        {state.archivedChannels.map((channel) => (
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
        ))}
      </ArchivedItemGroup>

      <ArchivedItemGroup
        title={t("Branches")}
        countLabel={t("{count} archived", { count: state.archivedBranches.length })}
        emptyLabel={state.isLoading ? t("Loading archived branches...") : t("No archived branches")}
      >
        {state.archivedBranches.map((branch) => (
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
        ))}
      </ArchivedItemGroup>

      <details className="settings-compact-details archived-items-copy archived-items-rules-footer">
        <summary>{t("Restore and delete rules")}</summary>
        {t("Restore returns archived items to the sidebar. Channel and branch delete is permanent and requires confirmation.")}
      </details>
    </section>
  );
}

function ArchivedConversationRow({
  thread,
  actionId,
  onRestore,
}: {
  readonly thread: LingThread;
  readonly actionId: string;
  readonly onRestore: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="archived-item-row">
      <div className="archived-item-main">
        <strong>
          <MessageSquare size={14} />
          {thread.title || t("Conversation")}
        </strong>
        <small>{t("Archived")} · {formatDateTime(thread.archivedAt ?? thread.updatedAt)}</small>
      </div>
      <div className="archived-item-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRestore} disabled={actionId !== ""}>
          {actionId === `conversation:${thread.id}:restore` ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {t("Restore")}
        </button>
      </div>
    </div>
  );
}

function ArchivedTeammateRow({
  teammate,
  actionId,
  onRestore,
}: {
  readonly teammate: AiTeammate;
  readonly actionId: string;
  readonly onRestore: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="archived-item-row">
      <div className="archived-item-main">
        <strong>
          <Bot size={14} />
          {teammate.displayName}
        </strong>
        <small>{t("Archived")} · {formatDateTime(teammate.updatedAt)}</small>
      </div>
      <div className="archived-item-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRestore} disabled={actionId !== ""}>
          {actionId === `teammate:${teammate.id}:restore` ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {t("Restore")}
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
  return (
    <div className="archived-item-row">
      <div className="archived-item-main">
        <strong>{channel.name}</strong>
        <small>{t("Archived")} · {formatDateTime(channel.updatedAt)}</small>
      </div>
      <div className="archived-item-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRestore} disabled={actionId !== ""}>
          {actionId === `channel:${channel.id}:restore` ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {t("Restore")}
        </button>
        <button className="ghost-button danger-ghost-button compact-button" type="button" onClick={onDelete} disabled={actionId !== ""}>
          {actionId === `channel:${channel.id}:delete` ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
          {t("Delete")}
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
  return (
    <div className="archived-item-row">
      <div className="archived-item-main">
        <strong>{parent ? `${parent.name} / ${branch.name}` : branch.name}</strong>
        <small>{parentArchived ? t("Parent channel archived") : t("Parent channel active")} · {formatDateTime(branch.archivedAt ?? branch.updatedAt)}</small>
      </div>
      <div className="archived-item-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRestore} disabled={actionId !== ""}>
          {actionId === `branch:${branch.id}:restore` ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {parentArchived ? t("Restore both") : t("Restore")}
        </button>
        <button className="ghost-button danger-ghost-button compact-button" type="button" onClick={onDelete} disabled={actionId !== ""}>
          {actionId === `branch:${branch.id}:delete` ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
          {t("Delete")}
        </button>
      </div>
    </div>
  );
}

function ArchivedItemGroup({
  title,
  countLabel,
  emptyLabel,
  children,
}: {
  readonly title: string;
  readonly countLabel: string;
  readonly emptyLabel: string;
  readonly children: ReactNode;
}): JSX.Element {
  const hasItems = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="archived-item-group">
      <div className="archived-item-group-head">
        <strong>{title}</strong>
        <small>{countLabel}</small>
      </div>
      <div className="archived-item-list">
        {hasItems ? children : (
          <div className="empty-state compact-empty archived-item-empty">
            <Archive />
            <span>{emptyLabel}</span>
          </div>
        )}
      </div>
    </section>
  );
}
