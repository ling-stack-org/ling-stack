import { Hash, Plus, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { StatusBadge } from "../../shared/components/index.js";
import type { Channel, TeammateChannelMembership } from "../../types.js";

export function TeammateChannelsTab({
  channels,
  membershipByChannelId,
  membershipCount,
  savingChannels,
  channelMessage,
  isProtectedSystemTeammate,
  onToggleChannelMembership,
}: {
  readonly channels: readonly Channel[];
  readonly membershipByChannelId: ReadonlyMap<string, TeammateChannelMembership>;
  readonly membershipCount: number;
  readonly savingChannels: boolean;
  readonly channelMessage: string;
  readonly isProtectedSystemTeammate: boolean;
  readonly onToggleChannelMembership: (channelId: string) => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-list-panel teammate-channels-panel" aria-label={t("Channels")}>
      <div className="panel-title split">
        <span>
          <Hash size={16} />
          <h2>{t("Channels")}</h2>
        </span>
        <small>{savingChannels ? t("Saving...") : channelMessage || membershipCount}</small>
      </div>
      {channels.length === 0 ? (
        <div className="client-empty-state teammate-empty">
          <Hash size={18} />
          <span>{t("No channel memberships")}</span>
        </div>
      ) : (
        <div className="teammate-data-list">
          {channels.map((channel) => {
            const membership = membershipByChannelId.get(channel.id);
            const joined = Boolean(membership);
            return (
              <article key={channel.id} className="teammate-data-row teammate-channel-row">
                <span>
                  <strong>{channel.name}</strong>
                  <small>{isProtectedSystemTeammate ? t("Built-in coordinator") : joined ? t("Joined channel") : t("Not joined")}</small>
                </span>
                <div className="teammate-channel-actions">
                  <StatusBadge status={channel.status} />
                  {isProtectedSystemTeammate ? (
                    <span className="status-badge neutral">{t("Always joined")}</span>
                  ) : (
                    <button className="secondary-button compact-button" type="button" onClick={() => void onToggleChannelMembership(channel.id)} disabled={savingChannels}>
                      {joined ? <X size={14} /> : <Plus size={14} />}
                      {joined ? t("Leave") : t("Join")}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
