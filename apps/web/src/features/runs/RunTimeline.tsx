import {
  CircleAlert,
  Clock3,
  Database,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { ApprovalCard, type ApprovalResolution } from "../approvals/index.js";
import { useI18n } from "../../i18n.js";
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

  return (
    <section className="panel timeline" aria-labelledby="run-timeline-title">
      <div className="panel-title split">
        <span>
          <Database size={18} />
          <h2 id="run-timeline-title">{t("Event stream")}</h2>
        </span>
        <span className="event-count">{t("{count} events", { count: events.length })}</span>
      </div>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      {assistantText ? (
        <div className="assistant-output">
          <span>{t("Assistant")}</span>
          <p>{assistantText}</p>
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

      <div className="event-list">
        {events.length === 0 ? (
          <div className="empty-state">
            {isRunning ? <Loader2 className="spin" /> : <Clock3 />}
            <span>{isRunning ? t("Waiting for runner events...") : t("No run loaded yet")}</span>
          </div>
        ) : (
          events.map((event) => <EventRow key={event.id} event={event} />)
        )}
      </div>
    </section>
  );
}
