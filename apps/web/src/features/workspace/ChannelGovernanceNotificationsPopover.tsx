import { Check, CircleAlert, Info, ShieldCheck, X } from "lucide-react";
import { useRef } from "react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import {
  Button,
  DataRow,
  EmptyState,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/index.js";
import type { GovernanceNotification } from "../../types.js";
import { WorkspaceToolbarCountBadge } from "./right-dock/index.js";

export function ChannelGovernanceNotificationsPopover({
  open,
  count,
  notifications,
  loading,
  actionId,
  onOpenChange,
  onMarkSeen,
  onDismiss,
}: {
  readonly open: boolean;
  readonly count: number;
  readonly notifications: readonly GovernanceNotification[];
  readonly loading: boolean;
  readonly actionId: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMarkSeen: (notificationId: string) => void;
  readonly onDismiss: (notificationId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const triggerLabel = t("{label}: {count}", { label: t("Review queue"), count });

  return (
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <span className="ling-conversation-toolbar-button-frame" data-active={open ? "true" : undefined}>
        <PopoverTrigger asChild>
          <IconButton
            className={open
              ? "ling-conversation-toolbar-icon-button workspace-toolbar-icon-button channel-governance-button active"
              : "ling-conversation-toolbar-icon-button workspace-toolbar-icon-button channel-governance-button"}
            data-active={open ? "true" : undefined}
            data-conversation-action="governance"
            aria-expanded={open}
            icon={ShieldCheck}
            label={triggerLabel}
            loading={loading}
            loadingLabel={t("Review queue")}
            pressed={open || undefined}
            tooltip=""
            disabled={loading}
            size="sm"
            variant="ghost"
          />
        </PopoverTrigger>
        <WorkspaceToolbarCountBadge count={count} />
      </span>
      <PopoverContent
        ref={contentRef}
        className="channel-governance-popover"
        role="dialog"
        aria-label={t("Governance notifications")}
        align="end"
        sideOffset={8}
        size="content"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus({ preventScroll: true });
        }}
      >
        <div className="channel-governance-head">
          <span>
            <ShieldCheck size={15} />
            <strong>{t("Review queue")}</strong>
          </span>
        </div>
        {notifications.length === 0 ? (
          <EmptyState
            className="channel-governance-empty"
            compact
            icon={<ShieldCheck size={16} />}
            title={loading ? t("Loading review queue...") : t("No review items")}
          />
        ) : (
          <div className="channel-governance-list" role="list">
            {notifications.map((notification) => {
              const busy = actionId === notification.id;
              const metadata = [
                t(governanceNotificationKindLabel(notification.kind)),
                t(governanceNotificationRouteLabel(notification.targetRoute.page)),
                formatDateTime(notification.updatedAt),
              ].join(" · ");
              return (
                <DataRow
                  key={notification.id}
                  className={`channel-governance-item ${notification.severity} ${notification.status}`}
                  role="listitem"
                  loading={busy}
                  identity={(
                    <span className="channel-governance-item-head">
                      <span className={`channel-governance-icon ${notification.severity}`}>
                        {governanceNotificationIcon(notification)}
                      </span>
                      <span>
                        <strong>{notification.title}</strong>
                        <small>{metadata}</small>
                      </span>
                    </span>
                  )}
                  summary={<p>{notification.summary}</p>}
                  actions={(
                    <span className="channel-governance-actions">
                      {notification.status === "unread" ? (
                        <Button
                          size="sm"
                          leadingIcon={<Check size={13} />}
                          loading={busy}
                          loadingLabel={t("Seen")}
                          onClick={() => onMarkSeen(notification.id)}
                          disabled={busy}
                        >
                          {t("Seen")}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        leadingIcon={<X size={13} />}
                        loading={busy}
                        loadingLabel={t("Dismiss")}
                        onClick={() => onDismiss(notification.id)}
                        disabled={busy}
                      >
                        {t("Dismiss")}
                      </Button>
                    </span>
                  )}
                />
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function governanceNotificationIcon(notification: GovernanceNotification): React.JSX.Element {
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
