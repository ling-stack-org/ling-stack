import { Check, CircleAlert, Info, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import type { GovernanceNotification } from "../../types.js";

export function ChannelGovernanceNotificationsPopover({
  notifications,
  loading,
  actionId,
  onRefresh,
  onMarkSeen,
  onDismiss,
}: {
  readonly notifications: readonly GovernanceNotification[];
  readonly loading: boolean;
  readonly actionId: string;
  readonly onRefresh: () => void;
  readonly onMarkSeen: (notificationId: string) => void;
  readonly onDismiss: (notificationId: string) => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <section className="channel-governance-popover" role="dialog" aria-label={t("Governance notifications")}>
      <div className="channel-governance-head">
        <span>
          <ShieldCheck size={15} />
          <strong>{t("Review queue")}</strong>
        </span>
        <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label={t("Refresh")} title={t("Refresh")}>
          {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
        </button>
      </div>
      {notifications.length === 0 ? (
        <div className="client-empty-state compact-empty channel-governance-empty">
          {loading ? <Loader2 className="spin" /> : <ShieldCheck />}
          <span>{loading ? t("Loading review queue...") : t("No review items")}</span>
        </div>
      ) : (
        <div className="channel-governance-list">
          {notifications.map((notification) => {
            const busy = actionId === notification.id;
            return (
              <article
                key={notification.id}
                className={`channel-governance-item ${notification.severity} ${notification.status}`}
              >
                <div className="channel-governance-item-head">
                  <span className={`channel-governance-icon ${notification.severity}`}>
                    {governanceNotificationIcon(notification)}
                  </span>
                  <div>
                    <strong>{notification.title}</strong>
                    <small>
                      {t(governanceNotificationKindLabel(notification.kind))}
                      {" · "}
                      {t(governanceNotificationRouteLabel(notification.targetRoute.page))}
                      {" · "}
                      {formatDateTime(notification.updatedAt)}
                    </small>
                  </div>
                </div>
                <p>{notification.summary}</p>
                <div className="channel-governance-actions">
                  {notification.status === "unread" ? (
                    <button className="secondary-button compact-button" type="button" onClick={() => onMarkSeen(notification.id)} disabled={busy}>
                      {busy ? <Loader2 className="spin" size={13} /> : <Check size={13} />}
                      {t("Seen")}
                    </button>
                  ) : null}
                  <button className="secondary-button compact-button" type="button" onClick={() => onDismiss(notification.id)} disabled={busy}>
                    {busy ? <Loader2 className="spin" size={13} /> : <X size={13} />}
                    {t("Dismiss")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function governanceNotificationIcon(notification: GovernanceNotification): JSX.Element {
  if (notification.severity === "critical" || notification.severity === "action_required") {
    return <CircleAlert size={15} />;
  }
  if (notification.severity === "warning") {
    return <Info size={15} />;
  }
  return <ShieldCheck size={15} />;
}

function governanceNotificationKindLabel(kind: GovernanceNotification["kind"]): string {
  if (kind === "memory_candidate") {
    return "Memory review";
  }
  if (kind === "memory_health_finding") {
    return "Memory health";
  }
  if (kind === "skill_candidate") {
    return "Skill review";
  }
  if (kind === "procedure_cluster") {
    return "Procedure review";
  }
  if (kind === "channel_protocol_candidate") {
    return "Protocol review";
  }
  if (kind === "channel_playbook_candidate") {
    return "Playbook review";
  }
  return "Workflow review";
}

function governanceNotificationRouteLabel(page: GovernanceNotification["targetRoute"]["page"]): string {
  if (page === "memory_promotion_inbox") {
    return "Memory inbox";
  }
  if (page === "memory_health") {
    return "Memory health";
  }
  if (page === "skill_candidate") {
    return "Skill candidate";
  }
  if (page === "procedure_cluster") {
    return "Procedure cluster";
  }
  if (page === "channel_protocol_candidate") {
    return "Channel protocol";
  }
  return "Channel playbook";
}
