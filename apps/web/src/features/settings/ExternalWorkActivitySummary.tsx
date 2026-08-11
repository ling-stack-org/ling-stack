import { ListChecks, Rows3, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { DataRow, StatusIndicator } from "../../shared/ui/index.js";
import type { ExternalWorkStatusResponse } from "../../types.js";
import type { ExternalWorkStatusTone } from "./external-work-settings-view-models.js";

export function ExternalWorkActivitySummary({
  status,
}: {
  readonly status: ExternalWorkStatusResponse;
}): React.JSX.Element {
  const { t } = useI18n();
  const work = status.records.externalWork;
  const triage = status.records.ciTriage;
  const actions = status.records.actions;

  return (
    <section className="settings-external-work-section" aria-labelledby="settings-external-work-activity-title">
      <h2 id="settings-external-work-activity-title">{t("Activity summary")}</h2>
      <div className="settings-external-work-summary-list">
        <SummaryRow
          icon={<Rows3 />}
          label={t("Work items")}
          summary={t("{ready} ready · {blocked} blocked", { ready: work.ready, blocked: work.blocked })}
          total={work.total}
          tone={work.blocked > 0 ? "warning" : work.ready > 0 ? "success" : "neutral"}
        />
        <SummaryRow
          icon={<ShieldCheck />}
          label={t("CI triage")}
          summary={t("{failed} failed · {blocked} blocked", { failed: triage.failed, blocked: triage.blocked })}
          total={triage.total}
          tone={triage.failed > 0 ? "danger" : triage.blocked > 0 ? "warning" : "neutral"}
        />
        <SummaryRow
          icon={<ListChecks />}
          label={t("Actions")}
          summary={t("{waiting} waiting · {failed} failed", {
            waiting: actions.waitingForApproval,
            failed: actions.failed,
          })}
          total={actions.total}
          tone={actions.failed > 0 ? "danger" : actions.waitingForApproval > 0 ? "warning" : "neutral"}
        />
      </div>
    </section>
  );
}

function SummaryRow({
  icon,
  label,
  summary,
  tone,
  total,
}: {
  readonly icon: React.JSX.Element;
  readonly label: string;
  readonly summary: string;
  readonly tone: ExternalWorkStatusTone;
  readonly total: number;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <DataRow
      compact
      className="settings-external-work-row settings-external-work-summary-row"
      identity={(
        <span className="settings-external-work-identity">
          <span aria-hidden="true">{icon}</span>
          <span>
            <strong>{label}</strong>
            <small>{summary}</small>
          </span>
        </span>
      )}
      status={<StatusIndicator compact label={t("{count} total", { count: total })} tone={tone} />}
    />
  );
}
