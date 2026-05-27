import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApprovalCard, type ApprovalResolution } from "../approvals/index.js";
import { useI18n } from "../../i18n.js";
import { buildRunActivities, type RunActivityItem } from "../../lib/run-activity.js";
import type {
  ApprovalRequest,
  RunEventEnvelope,
} from "../../types.js";
import { EventRow } from "./RunHistory.js";

export function RunTimeline({
  events,
  assistantText,
  errorMessage,
  isRunning,
  pendingApprovals,
  approvalsLoading,
  resolvingApprovals,
  onRefreshApprovals,
  onResolveApproval,
}: {
  readonly events: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly errorMessage: string;
  readonly isRunning: boolean;
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onRefreshApprovals: () => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const activities = useMemo(() => buildRunActivities(events), [events]);
  const activityListRef = useRef<HTMLDivElement>(null);
  const rawEventListRef = useRef<HTMLDivElement>(null);
  const [rawEventsOpen, setRawEventsOpen] = useState(false);

  useEffect(() => {
    scrollToBottom(activityListRef.current);
  }, [activities.length, events.length]);

  useEffect(() => {
    if (rawEventsOpen) {
      scrollToBottom(rawEventListRef.current);
    }
  }, [events.length, rawEventsOpen]);

  return (
    <section className="panel timeline" aria-labelledby="run-timeline-title">
      <div className="panel-title split">
        <span>
          <Database size={18} />
          <h2 id="run-timeline-title">{t("Run activity")}</h2>
        </span>
        <span className="event-count">{t("{count} activities", { count: activities.length })}</span>
      </div>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      {pendingApprovals.length > 0 ? (
        <div className="inline-approval-panel" aria-live="polite">
          <div className="inline-approval-head">
            <span>
              <ShieldCheck size={16} />
              {t("Pending approval")}
            </span>
            <button className="secondary-button compact-button" type="button" onClick={onRefreshApprovals} disabled={approvalsLoading}>
              {approvalsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {t("Refresh")}
            </button>
          </div>
          <div className="inline-approval-list">
            {pendingApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                compact
                resolvingDecision={resolvingApprovals[approval.id]}
                onResolve={onResolveApproval}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="timeline-activity-list" ref={activityListRef}>
        {activities.length === 0 ? (
          <div className="empty-state">
            {isRunning ? <Loader2 className="spin" /> : <Clock3 />}
            <span>{isRunning ? t("Waiting for runner activity...") : t("No activity yet")}</span>
          </div>
        ) : (
          activities.map((activity) => <ActivityRow key={activity.id} activity={activity} />)
        )}
      </div>

      {assistantText ? (
        <div className="assistant-output">
          <span>{t("Assistant")}</span>
          <p>{assistantText}</p>
        </div>
      ) : null}

      {events.length > 0 ? (
        <details className="raw-event-panel" open={rawEventsOpen} onToggle={(event) => setRawEventsOpen(event.currentTarget.open)}>
          <summary>
            <Database size={14} />
            <span>{t("Raw events ({count})", { count: events.length })}</span>
          </summary>
          {rawEventsOpen ? (
            <div className="raw-event-list event-list" ref={rawEventListRef}>
              {events.map((event) => <EventRow key={event.id} event={event} />)}
            </div>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

function scrollToBottom(element: HTMLDivElement | null): void {
  if (element) {
    element.scrollTop = element.scrollHeight;
  }
}

function ActivityRow({ activity }: { readonly activity: RunActivityItem }): JSX.Element {
  const { t } = useI18n();

  return (
    <article className={`timeline-activity-row ${activity.kind} ${activity.status}`}>
      <span className="timeline-activity-icon">{activityIcon(activity)}</span>
      <div className="timeline-activity-copy">
        <div className="timeline-activity-head">
          <strong>{t(activity.titleKey, activity.values)}</strong>
          <time>{new Date(activity.ts).toLocaleTimeString()}</time>
        </div>
        {activity.detail ? <small>{activity.detail}</small> : null}
      </div>
    </article>
  );
}

function activityIcon(activity: RunActivityItem): JSX.Element {
  if (activity.status === "failed") {
    return <CircleAlert size={15} />;
  }
  if (activity.status === "succeeded") {
    return <CheckCircle2 size={15} />;
  }
  if (activity.kind === "thinking") {
    return <Bot size={15} />;
  }
  if (activity.kind === "tool") {
    return <Wrench size={15} />;
  }
  if (activity.kind === "artifact") {
    return <FileText size={15} />;
  }
  if (activity.kind === "approval") {
    return <ShieldCheck size={15} />;
  }
  return <Clock3 size={15} />;
}
