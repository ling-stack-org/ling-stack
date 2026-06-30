import type { ReactNode } from "react";
import { Archive, CircleAlert, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { Channel, ChannelBranch } from "../../types.js";
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
          <h2 id="archived-items-settings-title">{t("Archived channels and branches")}</h2>
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

      <div className="archived-items-copy">
        {t("Restore returns an item to the channel drawer. Delete is permanent and requires confirmation.")}
      </div>

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
    </section>
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
