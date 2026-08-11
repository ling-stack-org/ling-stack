import { Bot, CheckCircle2, CircleAlert, Clock3, Database, FileText, ShieldCheck, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApprovalCard } from "../approvals/ApprovalCard.js";
import type { ApprovalResolution } from "../approvals/types.js";
import { useI18n } from "../../i18n.js";
import { buildRunActivities, type RunActivityItem } from "../../lib/run-activity.js";
import { EmptyState, InlineFeedback, InspectorSection } from "../../shared/ui/index.js";
import type { ApprovalRequest, RunEventEnvelope } from "../../types.js";
import { EventRow } from "./EventRow.js";

export function RunTimeline({ events, assistantText, errorMessage, isRunning, pendingApprovals, resolvingApprovals, onResolveApproval }: {
  readonly events: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly errorMessage: string;
  readonly isRunning: boolean;
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const activities = useMemo(() => buildRunActivities(events), [events]);
  const activityListRef = useRef<HTMLDivElement>(null);
  const rawEventListRef = useRef<HTMLDivElement>(null);
  const followActivityRef = useRef(true);
  const followRawRef = useRef(true);
  const [rawEventsOpen, setRawEventsOpen] = useState(false);

  useEffect(() => {
    if (followActivityRef.current) scrollToBottom(activityListRef.current);
  }, [activities.length, events.length]);
  useEffect(() => {
    if (rawEventsOpen && followRawRef.current) scrollToBottom(rawEventListRef.current);
  }, [events.length, rawEventsOpen]);

  return (
    <InspectorSection className="timeline" open summary={t("{count} activities", { count: activities.length })} title={t("Run activity")}>
      {errorMessage ? <InlineFeedback tone="danger">{errorMessage}</InlineFeedback> : null}
      {pendingApprovals.length ? <section className="runs-inline-approvals">
        <header><strong><ShieldCheck size={16} />{t("Pending approval")}</strong></header>
        {pendingApprovals.map((approval) => <ApprovalCard approval={approval} compact key={approval.id} onResolve={onResolveApproval} resolvingDecision={resolvingApprovals[approval.id]} />)}
      </section> : null}
      <div
        className="timeline-activity-list"
        data-following={followActivityRef.current ? "true" : "false"}
        onScroll={(event) => { followActivityRef.current = isNearBottom(event.currentTarget); event.currentTarget.dataset.following = String(followActivityRef.current); }}
        ref={activityListRef}
      >
        {activities.length === 0 ? <EmptyState compact icon={<Clock3 />} title={isRunning ? t("Waiting for runner activity...") : t("No activity yet")} /> : activities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}
      </div>
      {assistantText ? <div className="assistant-output"><span>{t("Assistant")}</span><p>{assistantText}</p></div> : null}
      {events.length ? (
        <InspectorSection
          className="raw-event-panel"
          onToggle={(event) => setRawEventsOpen(event.currentTarget.open)}
          open={rawEventsOpen}
          summary={t("Raw events ({count})", { count: events.length })}
          title={t("Event timeline")}
        >
          {rawEventsOpen ? <div className="raw-event-list event-list runs-code-scroll" onScroll={(event) => { followRawRef.current = isNearBottom(event.currentTarget); }} ref={rawEventListRef}>{events.map((event) => <EventRow event={event} key={event.id} />)}</div> : null}
        </InspectorSection>
      ) : null}
    </InspectorSection>
  );
}

function isNearBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
}

function scrollToBottom(element: HTMLDivElement | null): void {
  if (element) element.scrollTop = element.scrollHeight;
}

function ActivityRow({ activity }: { readonly activity: RunActivityItem }): React.JSX.Element {
  const { t } = useI18n();
  return <article className={`timeline-activity-row ${activity.kind} ${activity.status}`}><span className="timeline-activity-icon">{activityIcon(activity)}</span><div className="timeline-activity-copy"><div className="timeline-activity-head"><strong>{t(activity.titleKey, activity.values)}</strong><time>{new Date(activity.ts).toLocaleTimeString()}</time></div>{activity.detail ? <small>{activity.detail}</small> : null}</div></article>;
}

function activityIcon(activity: RunActivityItem): React.JSX.Element {
  if (activity.status === "failed") return <CircleAlert size={15} />;
  if (activity.status === "succeeded") return <CheckCircle2 size={15} />;
  if (activity.kind === "thinking") return <Bot size={15} />;
  if (activity.kind === "tool") return <Wrench size={15} />;
  if (activity.kind === "artifact") return <FileText size={15} />;
  if (activity.kind === "approval") return <ShieldCheck size={15} />;
  return <Database size={15} />;
}
